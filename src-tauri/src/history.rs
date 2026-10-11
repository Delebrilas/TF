//! Détection des morceaux déjà téléchargés : historique des sources
//! (identifiant YouTube, SoundCloud ou Spotify → fichier) et index
//! artiste + titre des MP3 du dossier de sortie.

use crate::{
    library,
    online,
    sources::{self, Source, TrackRequest},
};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::Mutex,
};
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct History(pub Mutex<HashMap<String, String>>);

fn file<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("downloaded.json"))
}

pub fn load<R: tauri::Runtime>(app: &AppHandle<R>) -> HashMap<String, String> {
    file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

/// Identifiant stable d'une piste source, ex. « youtube:dQw4w9WgXcQ ».
pub fn source_key(source: Source, key: &str) -> Option<String> {
    if key.is_empty() {
        return None;
    }
    let src = serde_json::to_value(source).ok()?.as_str()?.to_string();
    Some(format!("{src}:{key}"))
}

pub fn record<R: tauri::Runtime>(app: &AppHandle<R>, key: &str, path: &str) {
    let h = app.state::<History>();
    let mut map = h.0.lock().unwrap();
    map.insert(key.to_string(), path.to_string());
    if let (Some(f), Ok(json)) = (file(app), serde_json::to_string(&*map)) {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(f, json);
    }
}

/// Clé de comparaison « artiste|titre » tolérante (casse, accents, featuring, mentions entre parenthèses).
pub fn identity(artist: Option<&str>, title: Option<&str>) -> Option<String> {
    let t = sources::normalize(&online::base_title(title?));
    if t.is_empty() {
        return None;
    }
    let a = sources::normalize(&online::first_artist(artist.unwrap_or("")));
    Some(format!("{a}|{t}"))
}

/// Sépare les pistes nouvelles de celles déjà présentes.
/// `in_queue` : identifiants déjà en file d'attente.
pub fn split_new<R: tauri::Runtime>(
    app: &AppHandle<R>,
    output_dir: &str,
    tracks: Vec<TrackRequest>,
    in_queue: &HashSet<String>,
) -> (Vec<TrackRequest>, Vec<String>) {
    let downloaded: HashSet<String> = {
        let h = app.state::<History>();
        let map = h.0.lock().unwrap();
        map.iter()
            .filter(|(_, p)| std::path::Path::new(p).exists())
            .map(|(k, _)| k.clone())
            .collect()
    };
    let roots = vec![("TrackFetcher".to_string(), PathBuf::from(output_dir))];
    let on_disk: HashSet<String> = library::scan(&roots)
        .iter()
        .filter_map(|t| identity(t.artist.as_deref(), Some(&t.title)))
        .collect();

    let mut fresh = Vec::new();
    let mut skipped = Vec::new();
    for t in tracks {
        let sk = source_key(t.source, &t.key);
        let ident = identity(t.meta.artist.as_deref(), t.meta.title.as_deref());
        let dup = sk.as_ref().is_some_and(|k| downloaded.contains(k) || in_queue.contains(k))
            || ident.as_ref().is_some_and(|i| on_disk.contains(i) || in_queue.contains(i));
        if dup {
            skipped.push(t.meta.title.clone().unwrap_or_default());
        } else {
            fresh.push(t);
        }
    }
    (fresh, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities() {
        assert_eq!(
            identity(Some("Daft Punk feat. Romanthony"), Some("One More Time (Radio Edit)")),
            identity(Some("daft punk"), Some("One More Time"))
        );
        assert_eq!(source_key(Source::Youtube, "abc").as_deref(), Some("youtube:abc"));
    }
}
