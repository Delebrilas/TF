//! Morceaux « à portée de main » pas encore téléchargés : titres likés et
//! playlists Spotify, likes SoundCloud. Le GPS de set y cherche les maillons
//! manquants. BPM et tonalité viennent de Deezer et GetSongBPM (en cache).

use crate::{online, sources, tools};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct ExtTrack {
    /// Identité de la source (URI Spotify, id SoundCloud).
    pub id: String,
    pub source: sources::Source,
    /// Lien à télécharger.
    pub url: String,
    pub artist: String,
    pub title: String,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub bpm: Option<f64>,
    #[serde(default)]
    pub key: Option<String>,
    /// BPM et tonalité déjà cherchés en ligne (trouvés ou non).
    #[serde(default)]
    pub looked: bool,
    /// D'où il vient (« Titres likés », nom de playlist…).
    #[serde(default)]
    pub from: String,
    #[serde(default)]
    pub album: Option<String>,
    #[serde(default)]
    pub cover: Option<String>,
}

pub const SPOTIFY_LIKES: &str = "Titres likés";
pub const SOUNDCLOUD_LIKES: &str = "Likes SoundCloud";

pub struct Ext {
    file: PathBuf,
    tracks: Mutex<Vec<ExtTrack>>,
    running: AtomicBool,
}

#[derive(Serialize, Clone)]
struct Progress {
    phase: &'static str,
    done: usize,
    total: usize,
    error: Option<String>,
}

impl Ext {
    pub fn load(dir: PathBuf) -> Self {
        let file = dir.join("external.json");
        let tracks = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        Ext { file, tracks: Mutex::new(tracks), running: AtomicBool::new(false) }
    }

    pub fn list(&self) -> Vec<ExtTrack> {
        self.tracks.lock().unwrap().clone()
    }

    fn save(&self) {
        let Ok(t) = serde_json::to_string(&*self.tracks.lock().unwrap()) else { return };
        if let Some(d) = self.file.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let tmp = self.file.with_extension("tmp");
        if std::fs::write(&tmp, t).is_ok() {
            let _ = std::fs::rename(tmp, &self.file);
        }
    }

    /// Remplace la liste en gardant ce qui a déjà été cherché en ligne.
    fn merge(&self, fresh: Vec<ExtTrack>) {
        let mut cur = self.tracks.lock().unwrap();
        *cur = merged(&cur, fresh);
    }
}

fn merged(old: &[ExtTrack], fresh: Vec<ExtTrack>) -> Vec<ExtTrack> {
    let known: HashMap<&str, &ExtTrack> = old.iter().map(|t| (t.id.as_str(), t)).collect();
    let mut seen = std::collections::HashSet::new();
    fresh
        .into_iter()
        .filter(|t| seen.insert(t.id.clone()))
        .map(|mut t| {
            if let Some(o) = known.get(t.id.as_str()) {
                if t.from != SPOTIFY_LIKES && (o.from == SPOTIFY_LIKES || o.from == SOUNDCLOUD_LIKES) {
                    t.from = o.from.clone();
                }
                t.bpm = o.bpm;
                t.key = o.key.clone();
                t.looked = o.looked;
            }
            t
        })
        .collect()
}

fn ext_track(r: sources::TrackRequest, from: &str) -> Option<ExtTrack> {
    // SoundCloud renvoie parfois des likes sans titre ni artiste : on les lit dans le lien.
    let slug = (r.source == sources::Source::Soundcloud).then(|| sources::sc_slug(&r.url)).flatten();
    let title = r.meta.title.clone().filter(|t| !t.trim().is_empty()).or_else(|| slug.as_ref().map(|s| s.1.clone()))?;
    let artist = r.meta.artist.clone().filter(|a| !a.trim().is_empty()).or_else(|| slug.map(|s| s.0)).unwrap_or_default();
    let url = if r.url.is_empty() {
        // Spotify : spotify:track:<id> → lien web.
        let id = r.key.strip_prefix("spotify:track:")?;
        format!("https://open.spotify.com/track/{id}")
    } else {
        r.url.clone()
    };
    Some(ExtTrack {
        id: r.key,
        source: r.source,
        url,
        artist,
        title,
        duration: r.meta.duration,
        bpm: None,
        key: None,
        looked: false,
        from: from.to_string(),
        album: r.meta.album,
        cover: r.meta.cover,
    })
}

impl ExtTrack {
    /// Demande de téléchargement (comme si le lien avait été collé).
    pub fn request(&self) -> sources::TrackRequest {
        sources::TrackRequest {
            source: self.source,
            // Spotify : pas de lien direct, l'audio est cherché d'après les métadonnées.
            url: if self.source == sources::Source::Spotify || self.url.contains("deezer.com") { String::new() } else { self.url.clone() },
            key: self.id.clone(),
            meta: sources::Meta {
                title: Some(self.title.clone()),
                artist: Some(self.artist.clone()).filter(|a| !a.is_empty()),
                album: self.album.clone(),
                duration: self.duration,
                cover: self.cover.clone(),
                genre: None,
            },
        }
    }
}

#[derive(Serialize)]
pub struct Likes {
    pub tracks: Vec<ExtTrack>,
    pub errors: Vec<String>,
}

/// Titres likés (Spotify) et likes SoundCloud, dans l'ordre des sources (récents d'abord).
/// Garde en cache, sans toucher aux titres venus des playlists.
pub async fn likes(app: &AppHandle) -> Result<Likes, String> {
    let sc_user = app.state::<crate::AppState>().settings.lock().unwrap().soundcloud_user.clone();
    let sc = soundcloud_likes(&sc_user);
    if !crate::spotify::connected() && sc.is_none() {
        return Err("Connecte Spotify (Réglages › Comptes) ou indique ton profil SoundCloud dans les réglages".into());
    }
    let mut tracks = Vec::new();
    let mut errors = Vec::new();
    if crate::spotify::connected() {
        match crate::spotify::resolve("https://open.spotify.com/collection/tracks").await {
            Some(Ok(r)) => tracks.extend(r.tracks.into_iter().filter_map(|t| ext_track(t, SPOTIFY_LIKES))),
            Some(Err(e)) => errors.push(format!("Spotify : {e}")),
            None => errors.push("Spotify : non connecté".into()),
        }
    }
    if let Some(url) = sc {
        match tools::locate(app) {
            Some(t) => match sources::resolve(&t, &url).await {
                Ok(r) => {
                    let before = tracks.len();
                    tracks.extend(r.tracks.into_iter().filter_map(|t| ext_track(t, SOUNDCLOUD_LIKES)));
                    if tracks.len() == before {
                        errors.push(format!("SoundCloud : aucun like trouvé sur {url} (vérifie le nom du profil et que tes likes sont publics)"));
                    }
                }
                Err(e) => errors.push(format!("SoundCloud : {}", crate::jobs::friendly(&e.to_string()))),
            },
            None => errors.push("SoundCloud : yt-dlp n'est pas installé".into()),
        }
    }
    if tracks.is_empty() && !errors.is_empty() {
        return Err(errors.join(" · "));
    }
    let ext = app.state::<Ext>();
    {
        let mut cur = ext.tracks.lock().unwrap();
        upsert(&mut cur, &mut tracks);
    }
    ext.save();
    Ok(Likes { tracks, errors })
}

#[derive(Serialize)]
pub struct MyPlaylist {
    pub url: String,
    pub name: String,
    pub source: sources::Source,
    pub total: Option<u64>,
}

/// Playlists Spotify (si connecté) et SoundCloud (profil des réglages).
pub async fn playlists(app: &AppHandle) -> Result<Listing<MyPlaylist>, String> {
    let sc_user = app.state::<crate::AppState>().settings.lock().unwrap().soundcloud_user.clone();
    let mut out = Vec::new();
    let mut errors = Vec::new();
    if crate::spotify::connected() {
        match crate::spotify::playlists().await {
            Ok(l) => out.extend(l.into_iter().filter(|p| !p.url.contains("/collection/")).map(|p| MyPlaylist {
                url: p.url,
                name: p.name,
                source: sources::Source::Spotify,
                total: p.total,
            })),
            Err(e) => errors.push(format!("Spotify : {e}")),
        }
    }
    if let Some(likes) = soundcloud_likes(&sc_user) {
        let sets = likes.trim_end_matches("/likes").to_string() + "/sets";
        match tools::locate(app) {
            Some(t) => match sources::resolve(&t, &sets).await {
                Ok(r) => out.extend(r.tracks.into_iter().map(|t| MyPlaylist {
                    name: t.meta.title.unwrap_or_else(|| "Playlist SoundCloud".into()),
                    url: t.url,
                    source: sources::Source::Soundcloud,
                    total: None,
                })),
                // Pas de playlist : yt-dlp répond « vide », ce n'est pas une erreur.
                Err(e) if e.to_string().contains("vide") => {}
                Err(e) => errors.push(format!("SoundCloud : {e}")),
            },
            None => errors.push("SoundCloud : yt-dlp n'est pas installé".into()),
        }
    }
    Ok(Listing { items: out, errors })
}

#[derive(Serialize)]
pub struct Listing<T> {
    pub items: Vec<T>,
    pub errors: Vec<String>,
}

/// Titres d'une playlist, prêts à télécharger un par un.
pub async fn playlist_tracks(app: &AppHandle, url: &str, name: &str) -> Result<Vec<ExtTrack>, String> {
    let tools = if sources::detect(url) == sources::Source::Spotify { tools::Tools::none() } else { tools::locate(app).ok_or("yt-dlp n'est pas installé")? };
    let r = sources::resolve(&tools, url).await.map_err(|e| crate::jobs::friendly(&e.to_string()))?;
    let mut tracks: Vec<ExtTrack> = r.tracks.into_iter().filter_map(|t| ext_track(t, name)).collect();
    // BPM et clé déjà connus (sans ajouter ces titres au cache).
    let cur = app.state::<Ext>().list();
    for t in tracks.iter_mut() {
        if let Some(c) = cur.iter().find(|c| c.id == t.id) {
            t.bpm = c.bpm;
            t.key = c.key.clone();
        }
    }
    Ok(tracks)
}

/// Aperçu audio (MP3) : extrait Deezer si le titre y est, sinon 30 s prises
/// vers le milieu du morceau sur SoundCloud (titre SoundCloud) ou YouTube.
pub async fn preview(app: &AppHandle, t: &ExtTrack) -> Result<Vec<u8>, String> {
    if let Some(hit) = PREVIEWS.lock().unwrap().iter().find(|(id, _)| id == &t.id) {
        return Ok(hit.1.clone());
    }
    let mut data = None;
    if t.source != sources::Source::Soundcloud {
        if let Some(url) = online::deezer_preview(&t.artist, &t.title, t.duration).await {
            if let Ok(r) = sources::http().get(&url).send().await {
                data = r.bytes().await.ok().filter(|b| b.len() > 10_000).map(|b| b.to_vec());
            }
        }
    }
    let data = match data {
        Some(d) => d,
        None => {
            let tools = tools::locate(app).ok_or("yt-dlp n'est pas installé")?;
            let search = format!("ytsearch1:{} {} audio", online::first_artist(&t.artist), t.title);
            if t.source != sources::Source::Soundcloud {
                excerpt(&tools, &search).await?
            } else {
                match excerpt(&tools, &t.url).await {
                    Ok(d) => d,
                    // Titre protégé (DRM) ou retiré sur SoundCloud : Deezer, puis YouTube.
                    Err(e) => {
                        let mut alt = None;
                        if let Some(url) = online::deezer_preview(&t.artist, &t.title, t.duration).await {
                            if let Ok(r) = sources::http().get(&url).send().await {
                                alt = r.bytes().await.ok().filter(|b| b.len() > 10_000).map(|b| b.to_vec());
                            }
                        }
                        match alt {
                            Some(d) => d,
                            None => excerpt(&tools, &search).await.map_err(|_| e)?,
                        }
                    }
                }
            }
        }
    };
    let mut c = PREVIEWS.lock().unwrap();
    c.retain(|(id, _)| id != &t.id);
    c.push((t.id.clone(), data.clone()));
    if c.len() > 12 {
        c.remove(0);
    }
    Ok(data)
}

static PREVIEWS: Mutex<Vec<(String, Vec<u8>)>> = Mutex::new(Vec::new());

/// 30 s en MP3 depuis le milieu du morceau (yt-dlp donne le flux, ffmpeg découpe).
async fn excerpt(tools: &tools::Tools, target: &str) -> Result<Vec<u8>, String> {
    let out = tools
        .ytdlp()
        .args(["-f", "bestaudio/best", "--no-playlist", "--no-warnings", "--print", "duration", "--print", "urls", target])
        .output()
        .await
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    let mut lines = text.lines().map(str::trim).filter(|l| !l.is_empty());
    let duration: f64 = lines.next().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let url = lines.next().filter(|u| u.starts_with("http")).ok_or_else(|| format!("Aperçu indisponible : {}", sources::last_error(&out.stderr)))?;
    let start = (duration * 0.4).min((duration - 32.0).max(0.0));
    let out = tools
        .ffmpeg()
        .args(["-v", "error", "-ss", &format!("{start:.1}"), "-i", url, "-t", "30", "-vn", "-ac", "2", "-b:a", "128k", "-f", "mp3", "pipe:1"])
        .output()
        .await
        .map_err(|e| format!("ffmpeg : {e}"))?;
    if out.stdout.len() < 10_000 {
        return Err(format!("Aperçu indisponible : {}", String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("flux illisible")));
    }
    Ok(out.stdout)
}

/// Ajoute les nouveaux, met à jour les connus ; `fresh` récupère BPM et clé déjà trouvés.
fn upsert(cur: &mut Vec<ExtTrack>, fresh: &mut [ExtTrack]) {
    for f in fresh.iter_mut() {
        if let Some(c) = cur.iter_mut().find(|c| c.id == f.id) {
            f.bpm = c.bpm;
            f.key = c.key.clone();
            f.looked = c.looked;
            *c = f.clone();
        } else {
            cur.push(f.clone());
        }
    }
}

/// Lien des likes SoundCloud à partir d'un nom de profil ou d'un lien.
pub fn soundcloud_likes(user: &str) -> Option<String> {
    let u = user.trim().trim_end_matches('/');
    if u.is_empty() {
        return None;
    }
    let name = u.rsplit_once("soundcloud.com/").map(|(_, r)| r).unwrap_or(u);
    let name = name.split('/').next().unwrap_or("").trim_start_matches('@');
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'))
        .then(|| format!("https://soundcloud.com/{name}/likes"))
}

async fn collect(app: &AppHandle, sc_user: &str) -> (Vec<ExtTrack>, Vec<String>) {
    let mut out = Vec::new();
    let mut errors = Vec::new();
    if !crate::spotify::connected() && soundcloud_likes(sc_user).is_none() {
        errors.push("Aucune source : connecte Spotify ou indique ton profil SoundCloud (Réglages)".into());
    }
    if crate::spotify::connected() {
        match crate::spotify::playlists().await {
            Ok(lists) => {
                for p in lists.into_iter().filter(|p| p.readable).take(60) {
                    match crate::spotify::resolve(&p.url).await {
                        Some(Ok(r)) => out.extend(r.tracks.into_iter().filter_map(|t| ext_track(t, &p.name))),
                        Some(Err(e)) if p.url.contains("/collection/") => errors.push(format!("Spotify : {e}")),
                        _ => {}
                    }
                }
            }
            Err(e) => errors.push(format!("Spotify : {e}")),
        }
    }
    if let Some(url) = soundcloud_likes(sc_user) {
        match tools::locate(app) {
            Some(t) => match sources::resolve(&t, &url).await {
                Ok(r) => out.extend(r.tracks.into_iter().filter_map(|t| ext_track(t, "Likes SoundCloud"))),
                Err(e) => errors.push(format!("SoundCloud : {e}")),
            },
            None => errors.push("SoundCloud : yt-dlp n'est pas installé".into()),
        }
    }
    (out, errors)
}

async fn lookup(t: &ExtTrack, gsb_key: &str) -> (Option<f64>, Option<String>) {
    let (deezer, gsb) = tokio::join!(online::deezer(&t.artist, &t.title, t.duration), online::getsongbpm_info(gsb_key, &t.artist, &t.title));
    let (gb, key) = gsb.unwrap_or((None, None));
    (gb.or(deezer.and_then(|d| d.bpm)), key)
}

/// Relit les sources puis cherche BPM et tonalité des nouveaux titres.
/// Tourne en arrière-plan ; progression via l'évènement `ext-progress`.
pub fn refresh(app: AppHandle) -> bool {
    let ext = app.state::<Ext>();
    if ext.running.swap(true, Ordering::SeqCst) {
        return false;
    }
    tauri::async_runtime::spawn(async move {
        let (sc_user, gsb_key) = {
            let st = app.state::<crate::AppState>();
            let s = st.settings.lock().unwrap();
            (s.soundcloud_user.clone(), s.getsongbpm_key.clone())
        };
        let emit = |phase, done, total, error: Option<String>| {
            let _ = app.emit("ext-progress", Progress { phase, done, total, error });
        };
        emit("collect", 0, 0, None);
        let (fresh, errors) = collect(&app, &sc_user).await;
        let ext = app.state::<Ext>();
        if !fresh.is_empty() {
            ext.merge(fresh);
            ext.save();
        }
        let todo: Vec<ExtTrack> = ext.list().into_iter().filter(|t| !t.looked).collect();
        let total = todo.len();
        let mut done = 0;
        for chunk in todo.chunks(3) {
            let found = futures_util::future::join_all(chunk.iter().map(|t| lookup(t, &gsb_key))).await;
            {
                let mut cur = ext.tracks.lock().unwrap();
                for (t, (bpm, key)) in chunk.iter().zip(found) {
                    if let Some(x) = cur.iter_mut().find(|x| x.id == t.id) {
                        x.bpm = bpm;
                        x.key = key;
                        x.looked = true;
                    }
                }
            }
            done += chunk.len();
            if done % 30 < 3 || done == total {
                ext.save();
            }
            emit("lookup", done, total, None);
        }
        ext.save();
        ext.running.store(false, Ordering::SeqCst);
        let error = (!errors.is_empty()).then(|| errors.join(" · "));
        emit("done", done, total, error);
    });
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sources::{Meta, Source, TrackRequest};

    fn req(key: &str, url: &str, title: &str) -> TrackRequest {
        TrackRequest {
            source: Source::Spotify,
            url: url.into(),
            key: key.into(),
            meta: Meta { title: Some(title.into()), artist: Some("Artiste".into()), ..Default::default() },
        }
    }

    #[test]
    fn spotify_uri_becomes_link() {
        let t = ext_track(req("spotify:track:4uLU6hMCjMI75M1A2tKUQC", "", "Titre"), "Titres likés").unwrap();
        assert_eq!(t.url, "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC");
        assert!(ext_track(req("Artiste|Titre", "", "Titre"), "x").is_none());
    }

    #[test]
    fn merge_keeps_lookups_and_dedups() {
        let mut a = ext_track(req("spotify:track:a", "", "A"), "x").unwrap();
        a.bpm = Some(126.0);
        a.key = Some("8A".into());
        a.looked = true;
        let fresh = vec![
            ext_track(req("spotify:track:a", "", "A"), "y").unwrap(),
            ext_track(req("spotify:track:b", "", "B"), "y").unwrap(),
            ext_track(req("spotify:track:b", "", "B"), "z").unwrap(),
        ];
        let m = merged(&[a], fresh);
        assert_eq!(m.len(), 2);
        assert_eq!((m[0].bpm, m[0].looked, m[0].from.as_str()), (Some(126.0), true, "y"));
        assert!(!m[1].looked);
    }

    #[test]
    fn upsert_keeps_playlists_and_lookups() {
        let mut a = ext_track(req("spotify:track:a", "", "A"), "Ma playlist").unwrap();
        a.bpm = Some(124.0);
        let mut cur = vec![a, ext_track(req("spotify:track:p", "", "P"), "Ma playlist").unwrap()];
        let mut fresh = vec![ext_track(req("spotify:track:a", "", "A"), SPOTIFY_LIKES).unwrap(), ext_track(req("spotify:track:n", "", "N"), SPOTIFY_LIKES).unwrap()];
        upsert(&mut cur, &mut fresh);
        assert_eq!(cur.len(), 3);
        assert_eq!(fresh[0].bpm, Some(124.0));
        assert_eq!(cur[0].from, SPOTIFY_LIKES);
        let r = fresh[0].request();
        assert_eq!((r.url.as_str(), r.key.as_str(), r.meta.title.as_deref()), ("", "spotify:track:a", Some("A")));
    }

    /// TF_PREVIEW_URL=http://127.0.0.1:8766/x.mp3 cargo test excerpt -- --ignored
    #[test]
    #[ignore]
    fn excerpt_cuts_thirty_seconds() {
        let url = std::env::var("TF_PREVIEW_URL").unwrap();
        let t = tools::Tools { ytdlp: "yt-dlp".into(), ffmpeg_dir: None, extra: vec![], cookies: vec![] };
        let mp3 = tokio::runtime::Runtime::new().unwrap().block_on(excerpt(&t, &url)).unwrap();
        // 30 s à 128 kb/s ≈ 480 Ko.
        assert!((400_000..560_000).contains(&mp3.len()), "{}", mp3.len());
    }

    #[test]
    fn soundcloud_slug_fallback() {
        let r = sources::TrackRequest {
            source: sources::Source::Soundcloud,
            url: "https://soundcloud.com/dj-louis/acid_loop-2?in=x".into(),
            key: "1".into(),
            meta: Default::default(),
        };
        let t = ext_track(r, SOUNDCLOUD_LIKES).unwrap();
        assert_eq!((t.artist.as_str(), t.title.as_str()), ("dj louis", "acid loop 2"));
    }

    #[test]
    fn soundcloud_profile_forms() {
        let want = Some("https://soundcloud.com/louis-dj/likes".to_string());
        assert_eq!(soundcloud_likes("louis-dj"), want);
        assert_eq!(soundcloud_likes("https://soundcloud.com/louis-dj"), want);
        assert_eq!(soundcloud_likes("soundcloud.com/louis-dj/likes/"), want);
        assert_eq!(soundcloud_likes(""), None);
        assert_eq!(soundcloud_likes("a b"), None);
    }
}
