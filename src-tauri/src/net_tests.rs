//! Tests réseau réels (YouTube, SoundCloud, Spotify), lancés sur GitHub :
//! `cargo test --release -- --ignored net_ --nocapture` avec yt-dlp et deno dans le PATH.

use crate::sources::{self, Meta, Source};
use crate::tools::Tools;
use std::path::PathBuf;

fn tools() -> Tools {
    Tools { ytdlp: PathBuf::from("yt-dlp"), ffmpeg_dir: None, extra: vec![], cookies: vec![] }
}

fn rt() -> tokio::runtime::Runtime {
    tokio::runtime::Runtime::new().unwrap()
}

#[test]
#[ignore]
fn net_search_both_sources() {
    let r = rt().block_on(sources::search(&tools(), "Daft Punk One More Time"));
    for x in &r {
        println!("{:?} | {} | {:?} | {:?} | {}", x.source, x.title, x.artist, x.duration, x.url);
    }
    let yt = r.iter().filter(|x| x.source == Source::Youtube).count();
    let sc = r.iter().filter(|x| x.source == Source::Soundcloud).count();
    println!("YouTube: {yt}, SoundCloud: {sc}");
    assert!(yt + sc > 0, "aucun résultat");
    assert!(r.iter().all(|x| x.url.starts_with("http")));
}

#[test]
#[ignore]
fn net_find_matches_ranked() {
    let meta = Meta { title: Some("One More Time".into()), artist: Some("Daft Punk".into()), duration: Some(320.0), ..Default::default() };
    let rt = rt();
    for prefix in ["ytsearch8", "scsearch8"] {
        match rt.block_on(sources::find_matches(&tools(), &meta, prefix)) {
            Ok(m) => println!("{prefix}: {} correspondances, meilleure {:?}", m.len(), m.first()),
            Err(e) => println!("{prefix}: erreur {e}"),
        }
    }
}

#[test]
#[ignore]
fn net_spotify_public_playlist_and_track() {
    let rt = rt();
    // « Today's Top Hits » (éditoriale) et un titre public.
    for url in ["https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M", "https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV"] {
        match rt.block_on(sources::resolve(&tools(), url)) {
            Ok(r) => println!("{url}: {:?}, {} titres, 1er {:?}", r.title, r.tracks.len(), r.tracks.first().map(|t| (&t.meta.artist, &t.meta.title))),
            Err(e) => println!("{url}: erreur {e}"),
        }
    }
}

/// Télécharge l'audio de la meilleure correspondance (sans conversion) pour voir si YouTube renvoie 403.
#[test]
#[ignore]
fn net_download_audio() {
    let meta = Meta { title: Some("One More Time".into()), artist: Some("Daft Punk".into()), duration: Some(320.0), ..Default::default() };
    let rt = rt();
    let dir = std::env::temp_dir().join("tf-net");
    let _ = std::fs::create_dir_all(&dir);
    for prefix in ["ytsearch8", "scsearch8"] {
        let Ok(m) = rt.block_on(sources::find_matches(&tools(), &meta, prefix)) else { continue };
        let Some(url) = m.first() else { continue };
        let out = std::process::Command::new("yt-dlp")
            .args(["-f", "bestaudio", "--no-playlist", "-o"])
            .arg(dir.join(format!("{prefix}.%(ext)s")))
            .arg(url)
            .output()
            .unwrap();
        println!("{prefix} {url}: succès={} {}", out.status.success(), sources::last_error(&out.stderr));
    }
}
