//! Bibliothèque : les MP3 du dossier de sortie, pour le lecteur intégré.

use id3::{Tag, TagLike};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct LibTrack {
    pub path: String,
    pub title: String,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub bpm: Option<f64>,
    /// Clé Camelot (TKEY), si elle est dans ce format ou convertible.
    pub key: Option<String>,
    pub has_cover: bool,
    /// Dossier « playlist » : nom de la racine puis sous-dossiers, séparés par « / ».
    pub folder: String,
    /// Date de modification (secondes Unix), pour « Ajouts récents ».
    pub added: u64,
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>, depth: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() && depth < 6 {
            walk(&p, out, depth + 1);
        } else if p.extension().and_then(|x| x.to_str()).is_some_and(|x| x.eq_ignore_ascii_case("mp3")) {
            out.push(p);
        }
    }
}

/// Parcourt chaque racine. Le dossier de sortie s'appelle « TrackFetcher »,
/// les autres prennent leur propre nom.
pub fn scan(roots: &[(String, PathBuf)]) -> Vec<LibTrack> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (label, root) in roots {
        let mut files = Vec::new();
        walk(root, &mut files, 0);
        for p in files {
            if !seen.insert(p.clone()) {
                continue;
            }
            let rel = p
                .parent()
                .and_then(|d| d.strip_prefix(root).ok())
                .map(|r| r.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>())
                .unwrap_or_default();
            let folder = std::iter::once(label.clone()).chain(rel).collect::<Vec<_>>().join("/");
            out.push(read_track(&p, folder));
        }
    }
    out
}

fn read_track(p: &Path, folder: String) -> LibTrack {
    let tag = Tag::read_from_path(p).ok();
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
    let added = std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = tag.as_ref();
    LibTrack {
        folder,
        title: t.and_then(|t| t.title()).map(String::from).unwrap_or(stem),
        artist: t.and_then(|t| t.artist()).map(String::from),
        album: t.and_then(|t| t.album()).map(String::from),
        genre: t.and_then(|t| t.genre_parsed()).map(|g| g.to_string()),
        bpm: t
            .and_then(|t| t.get("TBPM"))
            .and_then(|f| f.content().text())
            .and_then(|s| s.trim().replace(',', ".").parse().ok()),
        key: t.and_then(|t| t.get("TKEY")).and_then(|f| f.content().text()).and_then(crate::key::to_camelot),
        has_cover: t.is_some_and(|t| t.pictures().next().is_some()),
        path: p.display().to_string(),
        added,
    }
}

pub fn cover(path: &Path) -> Option<Vec<u8>> {
    let tag = Tag::read_from_path(path).ok()?;
    let pic = tag
        .pictures()
        .find(|p| p.picture_type == id3::frame::PictureType::CoverFront)
        .or_else(|| tag.pictures().next())?;
    Some(pic.data.clone())
}
