use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub output_dir: String,
    /// "320", "v0" ou "192"
    pub quality: String,
    pub parallel: usize,
    pub verify_online: bool,
    pub getsongbpm_key: String,
    /// Ancien réglage (v0.1), converti en modèle de nom au chargement.
    #[serde(skip_serializing)]
    pub bpm_in_filename: bool,
    /// Modèle de nom : {artist} {title} {album} {bpm} {genre} {key}
    pub filename_template: String,
    /// "none", "bpm", "genre", "genre_bpm", "key" ou "key_bpm"
    pub sort_by: String,
    /// Pochette HD (iTunes, Deezer) quand une correspondance fiable existe.
    pub hd_cover: bool,
    /// Intervalle de vérification des playlists suivies, en minutes.
    pub watch_interval: u64,
    /// File d'attente en pause (persistant).
    pub paused: bool,
    /// Dossiers de musique supplémentaires affichés dans la bibliothèque.
    pub library_folders: Vec<String>,
    /// Ne pas retélécharger ce qui est déjà dans le dossier.
    pub skip_existing: bool,
    /// Proposer les liens copiés dans le presse-papiers.
    pub watch_clipboard: bool,
    /// Fond animé aux couleurs de la pochette.
    pub ambient: bool,
    /// La fenêtre pulse au rythme du morceau.
    pub pulse: bool,
    /// Navigateur dont yt-dlp lit les cookies (session YouTube), "" = aucun.
    pub cookies_browser: String,
    /// Client ID de l'app développeur Spotify de l'utilisateur.
    pub spotify_client_id: String,
    /// Notification Windows quand un morceau est prêt (fenêtre en arrière-plan).
    pub notify: bool,
    /// Fermer la fenêtre la range dans la zone de notification.
    pub close_to_tray: bool,
}

pub const DEFAULT_TEMPLATE: &str = "{artist} - {title}";

impl Default for Settings {
    fn default() -> Self {
        Self {
            output_dir: String::new(),
            quality: "320".into(),
            parallel: 2,
            verify_online: true,
            getsongbpm_key: String::new(),
            bpm_in_filename: false,
            filename_template: String::new(),
            sort_by: "none".into(),
            hd_cover: true,
            watch_interval: 60,
            paused: false,
            library_folders: vec![],
            skip_existing: true,
            watch_clipboard: true,
            ambient: true,
            pulse: true,
            cookies_browser: String::new(),
            spotify_client_id: String::new(),
            notify: true,
            close_to_tray: true,
        }
    }
}

fn file<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_config_dir()?.join("settings.json"))
}

pub fn load<R: tauri::Runtime>(app: &AppHandle<R>) -> Settings {
    let mut s: Settings = file(app)
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default();
    if s.output_dir.is_empty() {
        let base = app.path().audio_dir().or_else(|_| app.path().download_dir()).or_else(|_| app.path().home_dir());
        if let Ok(b) = base {
            s.output_dir = b.join("TrackFetcher").display().to_string();
        }
    }
    s.parallel = s.parallel.clamp(1, 4);
    if s.filename_template.trim().is_empty() {
        s.filename_template = if s.bpm_in_filename {
            format!("{DEFAULT_TEMPLATE} ({{bpm}} BPM)")
        } else {
            DEFAULT_TEMPLATE.into()
        };
    }
    s.bpm_in_filename = false;
    if !["none", "bpm", "genre", "genre_bpm", "key", "key_bpm"].contains(&s.sort_by.as_str()) {
        s.sort_by = "none".into();
    }
    s.watch_interval = s.watch_interval.clamp(15, 1440);
    if !["", "firefox", "edge", "chrome", "brave", "opera", "vivaldi"].contains(&s.cookies_browser.as_str()) {
        s.cookies_browser.clear();
    }
    s
}

pub fn save<R: tauri::Runtime>(app: &AppHandle<R>, s: &Settings) -> Result<()> {
    let p = file(app)?;
    if let Some(d) = p.parent() {
        std::fs::create_dir_all(d)?;
    }
    std::fs::write(p, serde_json::to_string_pretty(s)?)?;
    Ok(())
}
