//! Sauvegarde et restauration : réglages, grilles, notes, paires, likes en
//! cache, historique des téléchargements et playlists suivies, dans un seul
//! fichier JSON. La session Spotify n'y est pas (jeton personnel).

use anyhow::{bail, Context, Result};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

const FORMAT: &str = "trackfetcher-sauvegarde";

/// Fichiers sauvegardés : (nom dans la sauvegarde, dossier, chemin relatif).
fn files(app: &AppHandle) -> Result<Vec<(&'static str, PathBuf)>> {
    let data = app.path().app_data_dir()?;
    let config = app.path().app_config_dir()?;
    Ok(vec![
        ("settings", config.join("settings.json")),
        ("grids", data.join("dj").join("grids.json")),
        ("notes", data.join("dj").join("notes.json")),
        ("pairs", data.join("dj").join("pairs.json")),
        ("external", data.join("dj").join("external.json")),
        ("downloaded", data.join("downloaded.json")),
        ("watched", data.join("watched.json")),
    ])
}

/// Écrit la sauvegarde. `ui` : réglages de l'interface (options DJ, GPS…).
pub fn export(app: &AppHandle, dest: &Path, ui: Value) -> Result<usize> {
    if !dest.extension().is_some_and(|e| e.eq_ignore_ascii_case("json")) {
        bail!("Le fichier doit finir par .json");
    }
    let mut parts = Map::new();
    for (name, path) in files(app)? {
        if let Some(v) = std::fs::read_to_string(&path).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
            parts.insert(name.into(), v);
        }
    }
    let n = parts.len();
    let doc = json!({
        "format": FORMAT,
        "version": 1,
        "app": app.package_info().version.to_string(),
        "created": chrono_now(),
        "files": parts,
        "ui": ui,
    });
    write_atomic(dest, &serde_json::to_string_pretty(&doc)?)?;
    Ok(n)
}

/// Remet les fichiers en place (l'app redémarre ensuite). Renvoie les réglages d'interface.
pub fn import(app: &AppHandle, src: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(src).context("Fichier illisible")?;
    let doc: Value = serde_json::from_str(&text).context("Ce n'est pas une sauvegarde TrackFetcher")?;
    let parts = check(&doc)?;
    for (name, path) in files(app)? {
        if let Some(v) = parts.get(name) {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir)?;
            }
            write_atomic(&path, &serde_json::to_string(v)?)?;
        }
    }
    Ok(doc.get("ui").cloned().unwrap_or(Value::Null))
}

fn check(doc: &Value) -> Result<&Map<String, Value>> {
    if doc["format"].as_str() != Some(FORMAT) {
        bail!("Ce n'est pas une sauvegarde TrackFetcher");
    }
    if doc["version"].as_u64().unwrap_or(0) > 1 {
        bail!("Sauvegarde faite par une version plus récente de TrackFetcher : mets l'app à jour d'abord");
    }
    doc["files"].as_object().context("Sauvegarde vide")
}

fn write_atomic(path: &Path, text: &str) -> Result<()> {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn chrono_now() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_foreign_or_newer_files() {
        assert!(check(&json!({"format": "autre", "files": {}})).is_err());
        assert!(check(&json!({"format": FORMAT, "version": 2, "files": {}})).is_err());
        let ok = json!({"format": FORMAT, "version": 1, "files": {"notes": {"/a.mp3": "x"}}});
        assert_eq!(check(&ok).unwrap()["notes"]["/a.mp3"], "x");
    }
}
