//! Surveillance du presse-papiers : un lien Spotify, YouTube ou SoundCloud
//! copié est proposé au téléchargement.

use crate::{jobs::AppState, sources::{self, Source}};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_clipboard_manager::ClipboardExt;

fn supported(text: &str) -> Option<String> {
    let t = text.trim();
    if t.contains(char::is_whitespace) || t.len() > 500 {
        return None;
    }
    let ok = t.starts_with("http") || t.starts_with("spotify:");
    (ok && matches!(sources::detect(t), Source::Spotify | Source::Youtube | Source::Soundcloud)).then(|| t.to_string())
}

pub fn start<R: tauri::Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        // Ce qui est déjà copié au lancement n'est pas proposé.
        let mut last = app.clipboard().read_text().unwrap_or_default();
        loop {
            tokio::time::sleep(Duration::from_millis(1200)).await;
            if !app.state::<AppState>().settings.lock().unwrap().watch_clipboard {
                continue;
            }
            let Ok(text) = app.clipboard().read_text() else { continue };
            if text == last {
                continue;
            }
            last = text.clone();
            if let Some(url) = supported(&text) {
                let _ = app.emit("clipboard-link", url);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    #[test]
    fn links() {
        assert!(super::supported("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC").is_some());
        assert!(super::supported(" https://youtu.be/abc ").is_some());
        assert!(super::supported("https://example.com").is_none());
        assert!(super::supported("regarde https://youtu.be/abc").is_none());
    }
}
