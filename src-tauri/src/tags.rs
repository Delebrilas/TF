//! Lecture / écriture des tags ID3 (v2.3, la plus compatible).

use anyhow::Result;
use id3::{frame::Picture, frame::PictureType, Tag, TagLike, Version};
use std::path::Path;

pub struct TagData {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub genre: Option<String>,
    pub bpm: Option<f64>,
    pub bpm_detail: Option<String>,
    pub key: Option<crate::key::Key>,
    pub cover: Option<Vec<u8>>,
    /// Page d'origine (YouTube, SoundCloud, Spotify), écrite en WOAS.
    pub source_url: Option<String>,
}

/// Lien vers la page d'origine (WOAS).
pub fn source_of(tag: &Tag) -> Option<String> {
    tag.get("WOAS").and_then(|f| f.content().link()).map(String::from).filter(|u| u.starts_with("http"))
}

pub fn read_basic(path: &Path) -> (Option<String>, Option<String>, Option<String>) {
    match Tag::read_from_path(path) {
        Ok(t) => (
            t.title().map(String::from),
            t.artist().map(String::from),
            t.album().map(String::from),
        ),
        Err(_) => (None, None, None),
    }
}

/// BPM déjà présent dans le fichier (TBPM).
pub fn read_bpm(path: &Path) -> Option<f64> {
    let tag = Tag::read_from_path(path).ok()?;
    let text = tag.get("TBPM")?.content().text()?.trim().replace(',', ".");
    text.parse::<f64>().ok().filter(|b| *b > 0.0)
}

pub fn has_picture(path: &Path) -> bool {
    Tag::read_from_path(path).is_ok_and(|t| t.pictures().next().is_some())
}

pub fn set_artist(path: &Path, artist: &str) -> Result<()> {
    let mut tag = Tag::read_from_path(path).unwrap_or_else(|_| Tag::new());
    tag.set_artist(artist);
    tag.write_to_path(path, Version::Id3v23)?;
    Ok(())
}

/// Énergie 1–10 dans un TXXX « ENERGY » (lu par la bibliothèque).
pub fn set_energy(path: &Path, energy: u8) -> Result<()> {
    let mut tag = Tag::read_from_path(path).unwrap_or_else(|_| Tag::new());
    if energy_of(&tag) == Some(energy) {
        return Ok(());
    }
    tag.remove_extended_text(Some("ENERGY"), None);
    tag.add_frame(id3::frame::ExtendedText { description: "ENERGY".into(), value: energy.to_string() });
    tag.write_to_path(path, Version::Id3v23)?;
    Ok(())
}

pub fn energy_of(tag: &Tag) -> Option<u8> {
    tag.extended_texts()
        .find(|t| t.description.eq_ignore_ascii_case("ENERGY"))
        .and_then(|t| t.value.trim().parse::<u8>().ok())
        .filter(|e| (1..=10).contains(e))
}

pub fn read_key(path: &Path) -> Option<String> {
    let tag = Tag::read_from_path(path).ok()?;
    tag.get("TKEY")?.content().text().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

pub fn write(path: &Path, d: &TagData) -> Result<()> {
    let mut tag = Tag::read_from_path(path).unwrap_or_else(|_| Tag::new());
    if let Some(t) = &d.title {
        tag.set_title(t);
    }
    if let Some(a) = &d.artist {
        tag.set_artist(a);
    }
    if let Some(a) = &d.album {
        tag.set_album(a);
    }
    if let Some(g) = &d.genre {
        tag.set_genre(g);
    }
    if let Some(b) = d.bpm {
        // TBPM est un entier selon la norme ID3 : c'est ce que lisent
        // Rekordbox, Serato, iTunes et Windows.
        tag.set_text("TBPM", format!("{}", b.round() as i64));
    }
    if let Some(detail) = &d.bpm_detail {
        tag.remove_extended_text(Some("BPM_DETAIL"), None);
        tag.add_frame(id3::frame::ExtendedText { description: "BPM_DETAIL".into(), value: detail.clone() });
    }
    if let Some(k) = &d.key {
        // TKEY en Camelot (comme Mixed In Key), notation classique en TXXX.
        tag.set_text("TKEY", k.camelot.clone());
        tag.remove_extended_text(Some("KEY_NAME"), None);
        tag.add_frame(id3::frame::ExtendedText { description: "KEY_NAME".into(), value: k.name.clone() });
    }
    if let Some(data) = &d.cover {
        tag.remove_all_pictures();
        let mime = if data.starts_with(&[0x89, b'P', b'N', b'G']) { "image/png" } else { "image/jpeg" };
        tag.add_frame(Picture {
            mime_type: mime.into(),
            picture_type: PictureType::CoverFront,
            description: String::new(),
            data: data.clone(),
        });
    }
    if let Some(u) = &d.source_url {
        tag.add_frame(id3::Frame::with_content("WOAS", id3::Content::Link(u.clone())));
    }
    tag.write_to_path(path, Version::Id3v23)?;
    Ok(())
}
