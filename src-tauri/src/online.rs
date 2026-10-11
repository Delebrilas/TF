//! Corroboration du BPM avec des sources en ligne, et arbitrage final.

use crate::sources::{http, normalize};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceBpm {
    pub source: String,
    pub bpm: f64,
}

#[derive(Debug, Clone, Default)]
pub struct DeezerInfo {
    pub bpm: Option<f64>,
    pub album: Option<String>,
    pub cover: Option<String>,
    pub genre: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ItunesInfo {
    pub cover: Option<String>,
    pub genre: Option<String>,
    pub album: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Verdict {
    /// Analyse locale et sources en ligne d'accord.
    Confirmed,
    /// Analyse locale corrigée d'un facteur (double / moitié) d'après les sources.
    Corrected,
    /// Pas de source en ligne : valeur locale seule.
    LocalOnly,
    /// Désaccord : à vérifier par l'utilisateur.
    Conflict,
    /// Valeur saisie à la main.
    Manual,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BpmResult {
    pub bpm: f64,
    pub local: Option<f64>,
    pub confidence: Option<f64>,
    pub sources: Vec<SourceBpm>,
    pub verdict: Verdict,
}

fn first_artist(a: &str) -> String {
    static SPLIT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\s*(,|&| feat\.? | ft\.? | x | and )\s*").unwrap());
    SPLIT.split(a).next().unwrap_or(a).trim().to_string()
}

fn base_title(t: &str) -> String {
    static PAREN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*[\(\[][^\)\]]*[\)\]]").unwrap());
    let t = PAREN.replace_all(t, "");
    t.split(" - ").next().unwrap_or(&t).trim().to_string()
}

fn similar(a: &str, b: &str) -> bool {
    let (a, b) = (normalize(a), normalize(b));
    !a.is_empty() && !b.is_empty() && (a.contains(&b) || b.contains(&a))
}

pub async fn deezer(artist: &str, title: &str, duration: Option<f64>) -> Option<DeezerInfo> {
    let client = http();
    let a = first_artist(artist);
    let t = base_title(title);
    let queries = [format!("artist:\"{a}\" track:\"{t}\""), format!("{a} {t}")];
    for q in queries {
        let url = format!("https://api.deezer.com/search?q={}", urlencoding::encode(&q));
        let Ok(resp) = client.get(&url).send().await else { continue };
        let Ok(v) = resp.json::<Value>().await else { continue };
        let Some(items) = v["data"].as_array() else { continue };
        let hit = items.iter().find(|it| {
            let title_ok = similar(it["title"].as_str().unwrap_or(""), &t);
            let artist_ok = similar(it.pointer("/artist/name").and_then(Value::as_str).unwrap_or(""), &a);
            let dur_ok = match (duration, it["duration"].as_f64()) {
                (Some(d), Some(x)) => (d - x).abs() <= 15.0,
                _ => true,
            };
            title_ok && artist_ok && dur_ok
        });
        let Some(hit) = hit else { continue };
        let id = hit["id"].as_u64()?;
        let track: Value = client
            .get(format!("https://api.deezer.com/track/{id}"))
            .send()
            .await
            .ok()?
            .json()
            .await
            .ok()?;
        let bpm = track["bpm"].as_f64().filter(|b| *b > 30.0);
        let mut genre = None;
        if let Some(album_id) = track.pointer("/album/id").and_then(Value::as_u64) {
            if let Ok(r) = client.get(format!("https://api.deezer.com/album/{album_id}")).send().await {
                if let Ok(album) = r.json::<Value>().await {
                    genre = album.pointer("/genres/data/0/name").and_then(Value::as_str).map(String::from);
                }
            }
        }
        return Some(DeezerInfo {
            bpm,
            album: track.pointer("/album/title").and_then(Value::as_str).map(String::from),
            cover: track.pointer("/album/cover_xl").and_then(Value::as_str).map(String::from),
            genre,
        });
    }
    None
}

/// iTunes Search : pochette 1400 px et genre, sans clé.
pub async fn itunes(artist: &str, title: &str, duration: Option<f64>) -> Option<ItunesInfo> {
    let a = first_artist(artist);
    let t = base_title(title);
    let url = format!(
        "https://itunes.apple.com/search?media=music&entity=song&limit=10&term={}",
        urlencoding::encode(&format!("{a} {t}"))
    );
    let v: Value = http().get(url).send().await.ok()?.json().await.ok()?;
    let hit = v["results"].as_array()?.iter().find(|r| {
        let dur_ok = match (duration, r["trackTimeMillis"].as_f64()) {
            (Some(d), Some(ms)) => (d - ms / 1000.0).abs() <= 10.0,
            _ => true,
        };
        similar(r["trackName"].as_str().unwrap_or(""), &t) && similar(r["artistName"].as_str().unwrap_or(""), &a) && dur_ok
    })?;
    Some(ItunesInfo {
        cover: hit["artworkUrl100"].as_str().map(|u| u.replace("100x100bb", "1400x1400bb")),
        genre: hit["primaryGenreName"].as_str().map(String::from),
        album: hit["collectionName"].as_str().map(String::from),
    })
}

/// GetSongBPM (clé gratuite sur getsongbpm.com/api).
pub async fn getsongbpm(key: &str, artist: &str, title: &str) -> Option<f64> {
    if key.trim().is_empty() {
        return None;
    }
    let a = first_artist(artist);
    let t = base_title(title);
    let url = format!(
        "https://api.getsong.co/search/?api_key={}&type=both&lookup={}",
        urlencoding::encode(key.trim()),
        urlencoding::encode(&format!("song:{t} artist:{a}"))
    );
    let v: Value = http().get(url).send().await.ok()?.json().await.ok()?;
    v["search"]
        .as_array()?
        .iter()
        .find(|s| {
            similar(s["title"].as_str().unwrap_or(""), &t)
                && similar(s.pointer("/artist/name").and_then(Value::as_str).unwrap_or(""), &a)
        })
        .and_then(|s| s["tempo"].as_str().and_then(|x| x.parse::<f64>().ok()).or(s["tempo"].as_f64()))
        .filter(|b| *b > 30.0)
}

/// BPM écrit par l'auteur dans le titre ou la description (« 128 BPM »).
pub fn from_text(text: &str) -> Option<f64> {
    static RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\b(\d{2,3}(?:[.,]\d)?)\s?bpm\b").unwrap());
    let c = RE.captures(text)?;
    c[1].replace(',', ".").parse::<f64>().ok().filter(|b| (50.0..=250.0).contains(b))
}

fn close(a: f64, b: f64) -> bool {
    (a - b).abs() <= (b * 0.02).max(1.5)
}

/// Arbitrage entre l'analyse locale et les sources en ligne.
pub fn reconcile(local: Option<(f64, f64)>, sources: Vec<SourceBpm>) -> Option<BpmResult> {
    let (local_bpm, confidence) = (local.map(|l| l.0), local.map(|l| l.1));

    // Groupe des sources qui s'accordent entre elles.
    let consensus = sources
        .iter()
        .map(|s| {
            let group: Vec<f64> = sources.iter().filter(|o| close(o.bpm, s.bpm)).map(|o| o.bpm).collect();
            group
        })
        .max_by_key(|g| g.len())
        .map(|mut g| {
            g.sort_by(f64::total_cmp);
            (g[g.len() / 2], g.len())
        });

    let result = |bpm: f64, verdict| BpmResult { bpm: round(bpm), local: local_bpm, confidence, sources: sources.clone(), verdict };

    match (local_bpm, consensus) {
        (None, None) => None,
        (Some(l), None) => Some(result(l, Verdict::LocalOnly)),
        (None, Some((v, _))) => Some(result(v, Verdict::Confirmed)),
        (Some(l), Some((v, n))) => {
            // Plus précis que la valeur arrondie des bases, l'analyse locale est
            // conservée quand elle tombe à moins d'un BPM du consensus.
            let pick = |x: f64| if (x - v).abs() <= 1.0 { x } else { v };
            if close(l, v) {
                Some(result(pick(l), Verdict::Confirmed))
            } else if let Some(f) = [2.0, 0.5, 1.5, 2.0 / 3.0].into_iter().find(|f| close(l * f, v)) {
                Some(result(pick(l * f), Verdict::Corrected))
            } else if n >= 2 {
                Some(result(v, Verdict::Conflict))
            } else {
                Some(result(l, Verdict::Conflict))
            }
        }
    }
}

fn round(b: f64) -> f64 {
    let r = b.round();
    if (b - r).abs() < 0.2 {
        r
    } else {
        (b * 10.0).round() / 10.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(n: &str, b: f64) -> SourceBpm {
        SourceBpm { source: n.into(), bpm: b }
    }

    #[test]
    fn verdicts() {
        let r = reconcile(Some((127.9, 0.9)), vec![s("Deezer", 128.0)]).unwrap();
        assert_eq!((r.bpm, matches!(r.verdict, Verdict::Confirmed)), (128.0, true));

        let r = reconcile(Some((86.0, 0.9)), vec![s("Deezer", 172.0), s("GetSongBPM", 172.0)]).unwrap();
        assert_eq!((r.bpm, matches!(r.verdict, Verdict::Corrected)), (172.0, true));

        let r = reconcile(Some((100.0, 0.9)), vec![s("Deezer", 128.0), s("GetSongBPM", 128.0)]).unwrap();
        assert_eq!((r.bpm, matches!(r.verdict, Verdict::Conflict)), (128.0, true));

        let r = reconcile(Some((100.0, 0.9)), vec![s("Deezer", 128.0)]).unwrap();
        assert_eq!((r.bpm, matches!(r.verdict, Verdict::Conflict)), (100.0, true));

        let r = reconcile(Some((123.5, 0.9)), vec![]).unwrap();
        assert_eq!((r.bpm, matches!(r.verdict, Verdict::LocalOnly)), (123.5, true));
    }

    #[test]
    fn text_bpm() {
        assert_eq!(from_text("Hard Techno Mix [145 BPM]"), Some(145.0));
        assert_eq!(from_text("BPM: none"), None);
    }

    #[test]
    fn names() {
        assert_eq!(first_artist("Calvin Harris feat. Rihanna"), "Calvin Harris");
        assert_eq!(base_title("Strobe (Radio Edit) - Remastered"), "Strobe");
    }
}
