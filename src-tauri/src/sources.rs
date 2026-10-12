//! Résolution d'un lien en liste de pistes.
//!
//! Spotify ne fournit pas l'audio : on lit les métadonnées publiques de la
//! page « embed » (sans clé d'API), puis on cherche la meilleure
//! correspondance sur YouTube. YouTube et SoundCloud passent par yt-dlp.

use crate::tools::Tools;
use anyhow::{anyhow, bail, Context, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Spotify,
    Youtube,
    Soundcloud,
    Local,
    Other,
}

#[derive(Debug, Clone, Default)]
pub struct Meta {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub duration: Option<f64>,
    pub cover: Option<String>,
    pub genre: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TrackRequest {
    pub source: Source,
    /// URL passée à yt-dlp. Vide pour Spotify : la recherche YouTube se fait au moment du traitement.
    pub url: String,
    pub meta: Meta,
    /// Identifiant stable de la piste dans sa playlist (synchro).
    pub key: String,
}

pub struct Resolved {
    /// Nom de la playlist ou de l'album, s'il y en a un.
    pub title: Option<String>,
    pub tracks: Vec<TrackRequest>,
}

pub fn detect(url: &str) -> Source {
    let u = url.to_lowercase();
    if u.contains("spotify.com") || u.starts_with("spotify:") {
        Source::Spotify
    } else if u.contains("youtube.com") || u.contains("youtu.be") {
        Source::Youtube
    } else if u.contains("soundcloud.com") {
        Source::Soundcloud
    } else {
        Source::Other
    }
}

/// Vrai si le lien désigne une collection (playlist, album, set).
pub fn is_collection(url: &str) -> bool {
    let u = url.to_lowercase();
    u.contains("/playlist") || u.contains("/album/") || u.contains("spotify:album:") || u.contains("/sets/") || u.contains("list=")
}

pub fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36")
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .expect("client HTTP")
}

pub async fn resolve(tools: &Tools, url: &str) -> Result<Resolved> {
    match detect(url) {
        Source::Spotify => match crate::spotify::resolve(url).await {
            Some(r) => r,
            None if url.contains("/collection/") => bail!("Connecte-toi à Spotify (Réglages › Comptes) pour récupérer tes titres likés"),
            None => resolve_spotify(url).await,
        },
        src => match resolve_ytdlp(tools, url, src).await {
            Err(e) if crate::tools::retry_without_cookies(&e.to_string()) && !tools.cookies.is_empty() => {
                resolve_ytdlp(&tools.without_cookies(), url, src).await
            }
            r => r,
        },
    }
}

// ---------- Spotify ----------

static SPOTIFY_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?:open\.spotify\.com/(?:intl-[a-z-]+/)?(?:embed/)?|spotify:)(track|album|playlist)[/:]([A-Za-z0-9]{22})").unwrap()
});

pub fn parse_spotify(url: &str) -> Option<(String, String)> {
    let c = SPOTIFY_RE.captures(url)?;
    Some((c[1].to_string(), c[2].to_string()))
}

async fn resolve_spotify(url: &str) -> Result<Resolved> {
    let (kind, id) = parse_spotify(url).ok_or_else(|| anyhow!("Lien Spotify non reconnu (piste, album ou playlist)"))?;
    let html = http()
        .get(format!("https://open.spotify.com/embed/{kind}/{id}"))
        .send()
        .await?
        .error_for_status()
        .context("Spotify ne répond pas")?
        .text()
        .await?;
    parse_spotify_embed(&html, &kind)
}

fn largest_cover(entity: &Value) -> Option<String> {
    let sources = entity.pointer("/coverArt/sources").or_else(|| entity.pointer("/visualIdentity/image"))?;
    sources
        .as_array()?
        .iter()
        .max_by_key(|s| s.get("width").or(s.get("maxWidth")).and_then(Value::as_u64).unwrap_or(0))
        .and_then(|s| s["url"].as_str())
        .map(String::from)
}

pub fn parse_spotify_embed(html: &str, kind: &str) -> Result<Resolved> {
    static NEXT: LazyLock<Regex> =
        LazyLock::new(|| Regex::new(r#"(?s)<script id="__NEXT_DATA__" type="application/json">(.*?)</script>"#).unwrap());
    let json = NEXT
        .captures(html)
        .ok_or_else(|| anyhow!("Page Spotify illisible (format changé ?)"))?[1]
        .to_string();
    let v: Value = serde_json::from_str(&json)?;
    let entity = v
        .pointer("/props/pageProps/state/data/entity")
        .ok_or_else(|| anyhow!("Contenu Spotify introuvable"))?;
    let cover = largest_cover(entity);

    if kind == "track" {
        let artists = entity["artists"]
            .as_array()
            .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
            .filter(|s| !s.is_empty())
            .or_else(|| entity["subtitle"].as_str().map(String::from));
        let key = entity["uri"].as_str().or(entity["id"].as_str()).unwrap_or_default().to_string();
        return Ok(Resolved { title: None, tracks: vec![TrackRequest {
            source: Source::Spotify,
            url: String::new(),
            key,
            meta: Meta {
                title: entity["name"].as_str().or(entity["title"].as_str()).map(String::from),
                artist: artists,
                album: None,
                duration: entity["duration"].as_f64().map(|ms| ms / 1000.0),
                cover,
                genre: None,
            },
        }] });
    }

    let album = (kind == "album").then(|| entity["name"].as_str().map(String::from)).flatten();
    let list = entity["trackList"].as_array().ok_or_else(|| anyhow!("Liste de pistes Spotify vide"))?;
    let tracks = list
        .iter()
        .filter(|t| t["isPlayable"].as_bool() != Some(false) || t["title"].is_string())
        .map(|t| TrackRequest {
            source: Source::Spotify,
            url: String::new(),
            key: t["uri"].as_str().map(String::from).unwrap_or_else(|| {
                format!("{}|{}", t["subtitle"].as_str().unwrap_or(""), t["title"].as_str().unwrap_or(""))
            }),
            meta: Meta {
                title: t["title"].as_str().map(String::from),
                artist: t["subtitle"].as_str().map(|s| s.replace('\u{a0}', " ")),
                album: album.clone(),
                duration: t["duration"].as_f64().map(|ms| ms / 1000.0),
                // Les playlists n'exposent qu'une pochette globale : Deezer complétera.
                cover: if kind == "album" { cover.clone() } else { None },
                genre: None,
            },
        })
        .collect();
    Ok(Resolved { title: entity["name"].as_str().or(entity["title"].as_str()).map(String::from), tracks })
}


/// Toutes les correspondances plausibles, de la meilleure à la moins bonne.
pub async fn find_matches(tools: &Tools, meta: &Meta, prefix: &str) -> Result<Vec<String>> {
    let title = meta.title.clone().unwrap_or_default();
    let artist = meta.artist.clone().unwrap_or_default();
    let query = format!("{prefix}:{artist} - {title}");
    let out = tools.ytdlp()
        .args(["--flat-playlist", "-J", "--no-warnings", &query])
        .output()
        .await?;
    if !out.status.success() {
        return Err(anyhow!("Recherche impossible : {}", last_error(&out.stderr)));
    }
    let v: Value = serde_json::from_slice(&out.stdout)?;
    let entries = v["entries"].as_array().cloned().unwrap_or_default();
    let mut scored: Vec<(f64, &Value)> = entries
        .iter()
        .map(|e| (score_candidate(e, &title, &artist, meta.duration), e))
        .filter(|(s, _)| *s > -50.0)
        .collect();
    scored.sort_by(|a, b| b.0.total_cmp(&a.0));
    Ok(scored
        .into_iter()
        .filter_map(|(_, e)| {
            if prefix.starts_with("yt") {
                e["id"].as_str().map(|id| format!("https://www.youtube.com/watch?v={id}"))
            } else {
                e["url"].as_str().or(e["webpage_url"].as_str()).map(String::from)
            }
        })
        .collect())
}

pub fn normalize(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn score_candidate(e: &Value, title: &str, artist: &str, duration: Option<f64>) -> f64 {
    let cand = normalize(e["title"].as_str().unwrap_or(""));
    let channel = e["channel"].as_str().or(e["uploader"].as_str()).unwrap_or("");
    let t = normalize(title);
    let a = normalize(artist.split(',').next().unwrap_or(artist));
    let mut s = 0.0;

    if let (Some(want), Some(got)) = (duration, e["duration"].as_f64()) {
        let d = (want - got).abs();
        s += if d <= 3.0 { 30.0 } else if d <= 8.0 { 15.0 } else if d <= 20.0 { 0.0 } else { -40.0 };
    }
    let words: Vec<&str> = t.split(' ').filter(|w| w.len() > 1).collect();
    if !words.is_empty() {
        let hit = words.iter().filter(|w| cand.contains(**w)).count() as f64 / words.len() as f64;
        s += 30.0 * hit;
    }
    if !a.is_empty() && (cand.contains(&a) || normalize(channel).contains(&a)) {
        s += 15.0;
    }
    if channel.ends_with(" - Topic") {
        s += 20.0; // audio officiel de YouTube Music
    }
    if cand.contains("official audio") || cand.contains("audio") {
        s += 5.0;
    }
    for bad in ["live", "cover", "karaoke", "instrumental", "remix", "sped up", "slowed", "nightcore", "8d", "reverb", "lyrics video", "1 hour", "extended"] {
        if cand.contains(bad) && !t.contains(bad) {
            s -= 25.0;
        }
    }
    s
}

// ---------- Recherche universelle ----------

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub source: Source,
    pub url: String,
    pub title: String,
    pub artist: Option<String>,
    pub duration: Option<f64>,
    pub thumbnail: Option<String>,
}

async fn search_one(tools: &Tools, prefix: &str, source: Source, query: &str) -> Vec<SearchResult> {
    let q = format!("{prefix}6:{query}");
    let Ok(out) = tools.ytdlp()
        .args(["--flat-playlist", "-J", "--no-warnings", &q])
        .output()
        .await
    else {
        return vec![];
    };
    let Ok(v) = serde_json::from_slice::<Value>(&out.stdout) else { return vec![] };
    v["entries"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let url = e["url"].as_str().or(e["webpage_url"].as_str())?;
                    let url = if source == Source::Youtube && !url.starts_with("http") {
                        format!("https://www.youtube.com/watch?v={url}")
                    } else {
                        url.to_string()
                    };
                    let m = meta_from_info(e);
                    Some(SearchResult {
                        source,
                        url,
                        title: e["title"].as_str().unwrap_or("").to_string(),
                        artist: e["channel"].as_str().or(e["uploader"].as_str()).map(String::from).or(m.artist),
                        duration: e["duration"].as_f64(),
                        thumbnail: thumbnail(e),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Cherche « artiste titre » sur YouTube et SoundCloud en parallèle.
pub async fn search(tools: &Tools, query: &str) -> Vec<SearchResult> {
    let (yt, sc) = tokio::join!(
        search_one(tools, "ytsearch", Source::Youtube, query),
        search_one(tools, "scsearch", Source::Soundcloud, query)
    );
    yt.into_iter().chain(sc).collect()
}

// ---------- YouTube / SoundCloud ----------

async fn resolve_ytdlp(tools: &Tools, url: &str, src: Source) -> Result<Resolved> {
    let out = tools.ytdlp()
        .args(["--flat-playlist", "-J", "--no-playlist", "--no-warnings", url])
        .output()
        .await?;
    if !out.status.success() {
        return Err(anyhow!("Lien illisible : {}", last_error(&out.stderr)));
    }
    let v: Value = serde_json::from_slice(&out.stdout).context("Réponse yt-dlp invalide")?;
    if v["_type"].as_str() == Some("playlist") {
        let entries = v["entries"].as_array().cloned().unwrap_or_default();
        if entries.is_empty() {
            return Err(anyhow!("Playlist vide ou privée"));
        }
        let tracks = entries
            .iter()
            .filter_map(|e| {
                let u = e["url"].as_str().or(e["webpage_url"].as_str())?;
                let u = if src == Source::Youtube && !u.starts_with("http") {
                    format!("https://www.youtube.com/watch?v={u}")
                } else {
                    u.to_string()
                };
                let key = e["id"].as_str().map(String::from).unwrap_or_else(|| u.clone());
                Some(TrackRequest { source: src, url: u, meta: meta_from_info(e), key })
            })
            .collect();
        Ok(Resolved { title: v["title"].as_str().map(String::from), tracks })
    } else {
        let u = v["webpage_url"].as_str().unwrap_or(url).to_string();
        let key = v["id"].as_str().map(String::from).unwrap_or_else(|| u.clone());
        Ok(Resolved { title: None, tracks: vec![TrackRequest { source: src, url: u, meta: meta_from_info(&v), key }] })
    }
}

fn thumbnail(v: &Value) -> Option<String> {
    v["thumbnail"].as_str().map(String::from).or_else(|| {
        v["thumbnails"]
            .as_array()?
            .iter()
            .filter_map(|t| t["url"].as_str())
            .last()
            .map(String::from)
    })
}

/// Métadonnées « propres » à partir d'un dictionnaire yt-dlp.
pub fn meta_from_info(v: &Value) -> Meta {
    let raw_title = v["title"].as_str().unwrap_or("").to_string();
    let uploader = v["artist"]
        .as_str()
        .or(v["creator"].as_str())
        .or(v["uploader"].as_str())
        .or(v["channel"].as_str())
        .map(|s| s.trim_end_matches(" - Topic").to_string());
    let (artist, title) = match (v["artist"].as_str().or(v["creator"].as_str()), v["track"].as_str()) {
        (Some(a), Some(t)) => (Some(a.to_string()), Some(t.to_string())),
        _ => match split_artist_title(&raw_title) {
            Some((a, t)) => (Some(a), Some(t)),
            None => (uploader, (!raw_title.is_empty()).then(|| clean_title(&raw_title))),
        },
    };
    Meta {
        title,
        artist,
        album: v["album"].as_str().map(String::from),
        duration: v["duration"].as_f64(),
        cover: thumbnail(v),
        genre: v["genre"].as_str().filter(|g| !g.trim().is_empty()).map(|g| g.trim().to_string()),
    }
}

static NOISE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)\s*[\(\[\{][^\)\]\}]*(official|video|audio|lyric|clip|visuali[sz]er|hd|hq|4k|free download|out now|premiere)[^\)\]\}]*[\)\]\}]").unwrap()
});

static BPM_NOISE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"(?i)\s*[\(\[]?\b\d{2,3}(?:[.,]\d)?\s?bpm\b[\)\]]?").unwrap());

pub fn clean_title(t: &str) -> String {
    let t = NOISE.replace_all(t, "");
    let t = BPM_NOISE.replace_all(&t, "");
    let t = t.trim().trim_end_matches(['|', '-', '•']).trim();
    t.to_string()
}

pub fn split_artist_title(raw: &str) -> Option<(String, String)> {
    for sep in [" - ", " – ", " — ", " | "] {
        if let Some((a, t)) = raw.split_once(sep) {
            let (a, t) = (a.trim(), clean_title(t));
            if !a.is_empty() && !t.is_empty() {
                return Some((a.to_string(), t));
            }
        }
    }
    None
}

pub fn last_error(stderr: &[u8]) -> String {
    let s = String::from_utf8_lossy(stderr);
    s.lines()
        .rev()
        .find(|l| l.contains("ERROR"))
        .or_else(|| s.lines().rev().find(|l| !l.trim().is_empty()))
        .unwrap_or("erreur inconnue")
        .replace("ERROR: ", "")
        .trim()
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spotify_links() {
        assert_eq!(
            parse_spotify("https://open.spotify.com/intl-fr/track/4uLU6hMCjMI75M1A2tKUQC?si=abc"),
            Some(("track".into(), "4uLU6hMCjMI75M1A2tKUQC".into()))
        );
        assert_eq!(
            parse_spotify("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M"),
            Some(("playlist".into(), "37i9dQZF1DXcBWIGoYBM5M".into()))
        );
        assert!(parse_spotify("https://open.spotify.com/artist/xyz").is_none());
    }

    #[test]
    fn spotify_embed_playlist() {
        let html = r#"<html><script id="__NEXT_DATA__" type="application/json">{"props":{"pageProps":{"state":{"data":{"entity":{"name":"Mix","trackList":[{"title":"One More Time","subtitle":"Daft Punk","duration":320000,"uri":"spotify:track:x"}]}}}}}}</script></html>"#;
        let r = parse_spotify_embed(html, "playlist").unwrap();
        assert_eq!(r.title.as_deref(), Some("Mix"));
        assert_eq!(r.tracks[0].key, "spotify:track:x");
        let t = r.tracks;
        assert_eq!(t[0].meta.title.as_deref(), Some("One More Time"));
        assert_eq!(t[0].meta.artist.as_deref(), Some("Daft Punk"));
        assert_eq!(t[0].meta.duration, Some(320.0));
    }

    #[test]
    fn titles() {
        assert_eq!(
            split_artist_title("Daft Punk - One More Time (Official Video)"),
            Some(("Daft Punk".into(), "One More Time".into()))
        );
        assert_eq!(clean_title("Strobe [HD] (Radio Edit)"), "Strobe (Radio Edit)");
        assert_eq!(clean_title("Groove (Official Video) 126 BPM"), "Groove");
        assert_eq!(clean_title("Acid Loop [140 BPM]"), "Acid Loop");
    }
}
