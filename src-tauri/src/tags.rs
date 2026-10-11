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
    pub cover: Option<Vec<u8>>,
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
    tag.write_to_path(path, Version::Id3v23)?;
    Ok(())
}
