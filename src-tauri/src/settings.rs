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
    pub bpm_in_filename: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            output_dir: String::new(),
            quality: "320".into(),
            parallel: 2,
            verify_online: true,
            getsongbpm_key: String::new(),
            bpm_in_filename: false,
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
