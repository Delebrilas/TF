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
}

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
                t.bpm = o.bpm;
                t.key = o.key.clone();
                t.looked = o.looked;
            }
            t
        })
        .collect()
}

fn ext_track(r: sources::TrackRequest, from: &str) -> Option<ExtTrack> {
    let title = r.meta.title.clone()?;
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
        artist: r.meta.artist.unwrap_or_default(),
        title,
        duration: r.meta.duration,
        bpm: None,
        key: None,
        looked: false,
        from: from.to_string(),
    })
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
    fn soundcloud_profile_forms() {
        let want = Some("https://soundcloud.com/louis-dj/likes".to_string());
        assert_eq!(soundcloud_likes("louis-dj"), want);
        assert_eq!(soundcloud_likes("https://soundcloud.com/louis-dj"), want);
        assert_eq!(soundcloud_likes("soundcloud.com/louis-dj/likes/"), want);
        assert_eq!(soundcloud_likes(""), None);
        assert_eq!(soundcloud_likes("a b"), None);
    }
}
