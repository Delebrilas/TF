//! Connexion au compte Spotify (OAuth « Authorization Code + PKCE ») pour lire
//! les playlists privées et les titres likés. Nécessite une app développeur
//! créée par l'utilisateur (Client ID dans les réglages, compte Premium).

use crate::sources::{Meta, Resolved, Source, TrackRequest};
use anyhow::{anyhow, bail, Context, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

/// Port fixe : l'URI de redirection doit être déclarée telle quelle chez Spotify.
pub const PORT: u16 = 47823;
pub const REDIRECT_URI: &str = "http://127.0.0.1:47823/callback";
const SCOPES: &str = "playlist-read-private playlist-read-collaborative user-library-read";
const API: &str = "https://api.spotify.com/v1";

#[derive(Clone, Serialize, Deserialize)]
struct Auth {
    client_id: String,
    access_token: String,
    refresh_token: String,
    /// Secondes Unix.
    expires_at: u64,
    name: Option<String>,
}

static AUTH: Mutex<Option<Auth>> = Mutex::new(None);
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);

#[derive(Serialize)]
pub struct Status {
    pub connected: bool,
    pub name: Option<String>,
}

#[derive(Serialize)]
pub struct Playlist {
    pub url: String,
    pub name: String,
    pub image: Option<String>,
    pub total: Option<u64>,
    pub owner: Option<String>,
    /// Les titres ne sont lisibles que pour ses propres playlists (ou collaboratives).
    pub readable: bool,
}

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// Charge la session enregistrée (à l'ouverture de l'app).
pub fn init(file: PathBuf) {
    if let Some(a) = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Auth>(&t).ok()) {
        *AUTH.lock().unwrap() = Some(a);
    }
    *FILE.lock().unwrap() = Some(file);
}

fn save(a: Option<&Auth>) {
    let Some(f) = FILE.lock().unwrap().clone() else { return };
    match a {
        Some(a) => {
            if let Some(d) = f.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(&f, serde_json::to_string(a).unwrap_or_default());
        }
        None => {
            let _ = std::fs::remove_file(&f);
        }
    }
}

pub fn status() -> Status {
    let a = AUTH.lock().unwrap();
    Status { connected: a.is_some(), name: a.as_ref().and_then(|a| a.name.clone()) }
}

pub fn connected() -> bool {
    AUTH.lock().unwrap().is_some()
}

pub fn logout() {
    *AUTH.lock().unwrap() = None;
    save(None);
}

fn pkce() -> (String, String) {
    use rand::RngCore;
    let mut bytes = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut bytes);
    let verifier = URL_SAFE_NO_PAD.encode(bytes);
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    (verifier, challenge)
}

pub fn authorize_url(client_id: &str, challenge: &str, state: &str) -> String {
    format!(
        "https://accounts.spotify.com/authorize?response_type=code&client_id={}&scope={}&redirect_uri={}&code_challenge_method=S256&code_challenge={}&state={}",
        urlencoding::encode(client_id),
        urlencoding::encode(SCOPES),
        urlencoding::encode(REDIRECT_URI),
        challenge,
        state
    )
}

/// Extrait `code`, `state` et `error` de la première ligne d'une requête HTTP.
fn parse_callback(request: &str) -> (Option<String>, Option<String>, Option<String>) {
    let path = request.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or("");
    let query = path.split_once('?').map(|(_, q)| q).unwrap_or("");
    let mut out = (None, None, None);
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        let v = urlencoding::decode(v).map(|s| s.into_owned()).ok();
        match k {
            "code" => out.0 = v,
            "state" => out.1 = v,
            "error" => out.2 = v,
            _ => {}
        }
    }
    out
}

const PAGE: &str = "<!doctype html><meta charset=utf-8><title>TrackFetcher</title><body style=\"font:16px system-ui;background:#0f0e15;color:#ecebf4;display:grid;place-items:center;height:100vh;margin:0\"><div style=\"text-align:center\"><h2>{TITLE}</h2><p style=\"color:#8d8aa3\">{TEXT}</p></div>";

/// Ouvre la page de connexion Spotify et attend le retour sur 127.0.0.1.
pub async fn login(client_id: &str, open: impl FnOnce(&str) -> Result<()>) -> Result<Status> {
    let client_id = client_id.trim();
    if client_id.len() < 16 {
        bail!("Colle d'abord le Client ID de ton app Spotify dans Réglages › Comptes");
    }
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", PORT))
        .await
        .with_context(|| format!("Le port {PORT} est occupé : ferme l'autre fenêtre de connexion et réessaie"))?;
    let (verifier, challenge) = pkce();
    let state = pkce().0[..16].to_string();
    open(&authorize_url(client_id, &challenge, &state))?;

    let code = tokio::time::timeout(std::time::Duration::from_secs(300), async {
        loop {
            let (mut sock, _) = listener.accept().await?;
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).to_string();
            if !req.starts_with("GET /callback") {
                let _ = sock.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n").await;
                continue;
            }
            let (code, st, err) = parse_callback(&req);
            let ok = code.is_some() && st.as_deref() == Some(state.as_str());
            let (title, text) = if ok {
                ("Connecté à Spotify", "Tu peux fermer cet onglet et revenir dans TrackFetcher.")
            } else {
                ("Connexion annulée", "Retourne dans TrackFetcher pour réessayer.")
            };
            let body = PAGE.replace("{TITLE}", title).replace("{TEXT}", text);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            if ok {
                return Ok::<String, anyhow::Error>(code.unwrap());
            }
            bail!(match err.as_deref() {
                Some("access_denied") => "Connexion refusée sur la page Spotify".to_string(),
                Some(e) => format!("Spotify a refusé la connexion ({e})"),
                None => "Réponse de Spotify invalide".to_string(),
            });
        }
    })
    .await
    .map_err(|_| anyhow!("Délai dépassé : la connexion Spotify n'a pas été terminée"))??;

    let tok: Value = crate::sources::http()
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "authorization_code"),
            ("code", code.as_str()),
            ("redirect_uri", REDIRECT_URI),
            ("client_id", client_id),
            ("code_verifier", verifier.as_str()),
        ])
        .send()
        .await?
        .json()
        .await?;
    let mut auth = auth_from(client_id, &tok, None)?;
    // Nom affiché dans les réglages.
    let me: Value = crate::sources::http()
        .get(format!("{API}/me"))
        .bearer_auth(&auth.access_token)
        .send()
        .await?
        .json()
        .await
        .unwrap_or_default();
    auth.name = me["display_name"].as_str().or(me["id"].as_str()).map(String::from);
    save(Some(&auth));
    *AUTH.lock().unwrap() = Some(auth);
    Ok(status())
}

fn auth_from(client_id: &str, tok: &Value, previous: Option<&Auth>) -> Result<Auth> {
    let access = tok["access_token"].as_str().ok_or_else(|| {
        let e = tok["error_description"].as_str().or(tok["error"].as_str()).unwrap_or("réponse inattendue");
        anyhow!("Spotify a refusé le jeton : {e}")
    })?;
    Ok(Auth {
        client_id: client_id.to_string(),
        access_token: access.to_string(),
        refresh_token: tok["refresh_token"]
            .as_str()
            .map(String::from)
            .or_else(|| previous.map(|p| p.refresh_token.clone()))
            .unwrap_or_default(),
        expires_at: now() + tok["expires_in"].as_u64().unwrap_or(3600).saturating_sub(60),
        name: previous.and_then(|p| p.name.clone()),
    })
}

/// Jeton valide, renouvelé si besoin.
async fn token() -> Result<String> {
    let a = AUTH.lock().unwrap().clone().ok_or_else(|| anyhow!("Pas connecté à Spotify"))?;
    if a.expires_at > now() {
        return Ok(a.access_token);
    }
    let tok: Value = crate::sources::http()
        .post("https://accounts.spotify.com/api/token")
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", a.refresh_token.as_str()),
            ("client_id", a.client_id.as_str()),
        ])
        .send()
        .await?
        .json()
        .await?;
    if tok["error"].as_str() == Some("invalid_grant") {
        logout();
        bail!("Session Spotify expirée : reconnecte-toi dans Réglages › Comptes");
    }
    let fresh = auth_from(&a.client_id, &tok, Some(&a))?;
    save(Some(&fresh));
    let t = fresh.access_token.clone();
    *AUTH.lock().unwrap() = Some(fresh);
    Ok(t)
}

async fn get(url: &str) -> Result<Value> {
    let t = token().await?;
    let r = crate::sources::http().get(url).bearer_auth(t).send().await?;
    let code = r.status();
    if code.as_u16() == 401 {
        logout();
        bail!("Session Spotify expirée : reconnecte-toi dans Réglages › Comptes");
    }
    if !code.is_success() {
        bail!("Spotify API : erreur {}", code.as_u16());
    }
    Ok(r.json().await?)
}

/// Parcourt toutes les pages d'une liste (`next`).
async fn all_pages(first: String, max: usize) -> Result<Vec<Value>> {
    let mut out = Vec::new();
    let mut next = Some(first);
    while let Some(url) = next {
        let v = get(&url).await?;
        // Les réponses de playlist imbriquent parfois la page dans `items` / `tracks`.
        let page = if v["items"].is_array() { &v } else if v["items"]["items"].is_array() { &v["items"] } else { &v["tracks"] };
        out.extend(page["items"].as_array().cloned().unwrap_or_default());
        next = page["next"].as_str().map(String::from);
        if out.len() >= max {
            break;
        }
    }
    Ok(out)
}

/// Playlists de l'utilisateur, avec « Titres likés » en tête.
pub async fn playlists() -> Result<Vec<Playlist>> {
    let me = get(&format!("{API}/me")).await?;
    let me_id = me["id"].as_str().unwrap_or("").to_string();
    let liked = get(&format!("{API}/me/tracks?limit=1")).await.ok();
    let mut out = vec![Playlist {
        url: "https://open.spotify.com/collection/tracks".into(),
        name: "Titres likés".into(),
        image: None,
        total: liked.and_then(|l| l["total"].as_u64()),
        owner: None,
        readable: true,
    }];
    for p in all_pages(format!("{API}/me/playlists?limit=50"), 2000).await? {
        let Some(id) = p["id"].as_str() else { continue };
        let owner_id = p["owner"]["id"].as_str().unwrap_or("");
        out.push(Playlist {
            url: format!("https://open.spotify.com/playlist/{id}"),
            name: p["name"].as_str().unwrap_or("Sans titre").to_string(),
            image: p["images"].as_array().and_then(|i| i.first()).and_then(|i| i["url"].as_str()).map(String::from),
            total: p["items"]["total"].as_u64().or(p["tracks"]["total"].as_u64()),
            owner: p["owner"]["display_name"].as_str().map(String::from),
            readable: owner_id == me_id || p["collaborative"].as_bool() == Some(true),
        });
    }
    Ok(out)
}

fn track_request(t: &Value) -> Option<TrackRequest> {
    if t["type"].as_str().is_some_and(|k| k != "track") || t["is_local"].as_bool() == Some(true) {
        return None;
    }
    let title = t["name"].as_str()?.to_string();
    let artists: Vec<&str> = t["artists"].as_array()?.iter().filter_map(|a| a["name"].as_str()).collect();
    Some(TrackRequest {
        source: Source::Spotify,
        url: String::new(),
        key: t["uri"].as_str().map(String::from).unwrap_or_else(|| format!("{}|{title}", artists.join(", "))),
        meta: Meta {
            title: Some(title),
            artist: Some(artists.join(", ")).filter(|a| !a.is_empty()),
            album: t["album"]["name"].as_str().map(String::from),
            duration: t["duration_ms"].as_f64().map(|ms| ms / 1000.0),
            cover: t["album"]["images"].as_array().and_then(|i| i.first()).and_then(|i| i["url"].as_str()).map(String::from),
            genre: None,
        },
    })
}

/// Liste les titres via l'API. `None` si ce lien n'est pas géré (on retombe sur la page publique).
pub async fn resolve(url: &str) -> Option<Result<Resolved>> {
    if !connected() {
        return None;
    }
    if url.contains("/collection/tracks") || url.starts_with("spotify:collection") {
        return Some(async {
            let items = all_pages(format!("{API}/me/tracks?limit=50"), 10_000).await?;
            let tracks: Vec<_> = items.iter().filter_map(|i| track_request(&i["track"])).collect();
            Ok(Resolved { title: Some("Titres likés".into()), tracks })
        }
        .await);
    }
    let (kind, id) = crate::sources::parse_spotify(url)?;
    if kind != "playlist" {
        return None;
    }
    let r = async {
        let meta = get(&format!("{API}/playlists/{id}?fields=name")).await?;
        let items = all_pages(format!("{API}/playlists/{id}/items?limit=50"), 10_000).await?;
        // Nouveau format : `item` ; ancien : `track`.
        let tracks: Vec<_> = items.iter().filter_map(|i| track_request(if i["item"].is_object() { &i["item"] } else { &i["track"] })).collect();
        if tracks.is_empty() {
            bail!("vide");
        }
        Ok(Resolved { title: meta["name"].as_str().map(String::from), tracks })
    }
    .await;
    // Playlist d'un autre utilisateur (non lisible via l'API) : page publique.
    match r {
        Ok(r) => Some(Ok(r)),
        Err(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_is_s256_of_verifier() {
        let (v, c) = pkce();
        assert!(v.len() >= 43 && v.len() <= 128);
        assert_eq!(c, URL_SAFE_NO_PAD.encode(Sha256::digest(v.as_bytes())));
    }

    #[test]
    fn parses_callback() {
        let req = "GET /callback?code=AQB%2Fx&state=abc HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n";
        assert_eq!(parse_callback(req), (Some("AQB/x".into()), Some("abc".into()), None));
        let denied = "GET /callback?error=access_denied&state=abc HTTP/1.1\r\n";
        assert_eq!(parse_callback(denied).2.as_deref(), Some("access_denied"));
    }

    /// Boucle complète jusqu'à l'échange du code : le navigateur simulé
    /// revient sur 127.0.0.1 avec le bon `state`.
    #[test]
    fn callback_flow_reaches_token_exchange() {
        let rt = tokio::runtime::Runtime::new().unwrap();
        let r = rt.block_on(login("0123456789abcdef0123456789abcdef", |url| {
            assert!(url.contains("code_challenge_method=S256"));
            assert!(url.contains(&urlencoding::encode(REDIRECT_URI).to_string()));
            let state = url.split("state=").nth(1).unwrap().to_string();
            tokio::spawn(async move {
                let mut s = tokio::net::TcpStream::connect(("127.0.0.1", PORT)).await.unwrap();
                s.write_all(format!("GET /callback?code=abc&state={state} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes()).await.unwrap();
                let mut page = String::new();
                let _ = s.read_to_string(&mut page).await;
                assert!(page.contains("Connecté à Spotify"));
            });
            Ok(())
        }));
        // Hors ligne, l'échange échoue ; en ligne, Spotify refuse le faux code.
        let e = r.err().expect("le faux code ne peut pas aboutir").to_string();
        assert!(!e.contains("Délai") && !e.contains("port"), "{e}");
    }

    #[test]
    fn reads_new_and_old_item_shapes() {
        let t = serde_json::json!({"type":"track","name":"One More Time","uri":"spotify:track:1","duration_ms":320000,
            "artists":[{"name":"Daft Punk"}],"album":{"name":"Discovery","images":[{"url":"https://i/1.jpg"}]}});
        let r = track_request(&t).unwrap();
        assert_eq!(r.meta.artist.as_deref(), Some("Daft Punk"));
        assert_eq!(r.key, "spotify:track:1");
        assert_eq!(r.meta.duration, Some(320.0));
        assert!(track_request(&serde_json::json!({"type":"episode","name":"x","artists":[]})).is_none());
    }
}
