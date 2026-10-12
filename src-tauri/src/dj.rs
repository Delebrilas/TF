//! Onglet DJ : grilles de battements (en cache), notes par morceau,
//! paires favorites et export CSV.

use crate::bpm;
use anyhow::{bail, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

#[derive(Serialize, Deserialize, Clone)]
struct CachedGrid {
    mtime: u64,
    grid: bpm::Grid,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Pair {
    pub a: String,
    pub b: String,
    #[serde(default)]
    pub note: String,
    #[serde(default)]
    pub added: u64,
}

#[derive(Default, Serialize, Deserialize)]
struct Data {
    #[serde(default)]
    grids: HashMap<String, CachedGrid>,
    #[serde(default)]
    notes: HashMap<String, String>,
    #[serde(default)]
    pairs: Vec<Pair>,
}

pub struct Dj {
    dir: PathBuf,
    data: Mutex<Data>,
}

fn mtime(p: &Path) -> u64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn read<T: for<'de> Deserialize<'de> + Default>(p: &Path) -> T {
    std::fs::read_to_string(p).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default()
}

impl Dj {
    pub fn load(dir: PathBuf) -> Self {
        let data = Data {
            grids: read(&dir.join("grids.json")),
            notes: read(&dir.join("notes.json")),
            pairs: read(&dir.join("pairs.json")),
        };
        Dj { dir, data: Mutex::new(data) }
    }

    fn save(&self, which: &str) {
        let d = self.data.lock().unwrap();
        let text = match which {
            "grids" => serde_json::to_string(&d.grids),
            "notes" => serde_json::to_string_pretty(&d.notes),
            _ => serde_json::to_string_pretty(&d.pairs),
        };
        if let Ok(t) = text {
            let _ = std::fs::create_dir_all(&self.dir);
            let f = self.dir.join(format!("{which}.json"));
            let tmp = f.with_extension("tmp");
            if std::fs::write(&tmp, t).is_ok() {
                let _ = std::fs::rename(tmp, f);
            }
        }
    }

    pub fn cached_grid(&self, path: &str) -> Option<bpm::Grid> {
        let m = mtime(Path::new(path));
        let d = self.data.lock().unwrap();
        d.grids.get(path).filter(|c| c.mtime == m).map(|c| c.grid.clone())
    }

    pub fn store_grid(&self, path: &str, grid: &bpm::Grid) {
        let m = mtime(Path::new(path));
        self.data
            .lock()
            .unwrap()
            .grids
            .insert(path.to_string(), CachedGrid { mtime: m, grid: grid.clone() });
        self.save("grids");
    }

    pub fn notes(&self) -> HashMap<String, String> {
        self.data.lock().unwrap().notes.clone()
    }

    pub fn set_note(&self, path: &str, text: &str) {
        {
            let mut d = self.data.lock().unwrap();
            let t = text.trim();
            if t.is_empty() {
                d.notes.remove(path);
            } else {
                d.notes.insert(path.to_string(), t.to_string());
            }
        }
        self.save("notes");
    }

    pub fn pairs(&self) -> Vec<Pair> {
        self.data.lock().unwrap().pairs.clone()
    }

    /// Ajoute (ou met à jour la note d') une paire A → B.
    pub fn add_pair(&self, a: &str, b: &str, note: &str) -> Vec<Pair> {
        {
            let mut d = self.data.lock().unwrap();
            if let Some(p) = d.pairs.iter_mut().find(|p| p.a == a && p.b == b) {
                p.note = note.trim().to_string();
            } else {
                d.pairs.push(Pair { a: a.into(), b: b.into(), note: note.trim().into(), added: now() });
            }
        }
        self.save("pairs");
        self.pairs()
    }

    pub fn remove_pair(&self, a: &str, b: &str) -> Vec<Pair> {
        self.data.lock().unwrap().pairs.retain(|p| !(p.a == a && p.b == b));
        self.save("pairs");
        self.pairs()
    }

    pub fn forget_paths(&self, paths: &[String]) {
        {
            let mut d = self.data.lock().unwrap();
            for p in paths {
                d.notes.remove(p);
                d.grids.remove(p);
            }
            d.pairs.retain(|x| !paths.contains(&x.a) && !paths.contains(&x.b));
        }
        for w in ["notes", "grids", "pairs"] {
            self.save(w);
        }
    }
}

fn csv_field(s: &str) -> String {
    // Excel (Windows, réglages FR) : séparateur « ; ». On protège aussi les
    // cellules qui commencent par = + - @ (injection de formules).
    let s = if s.starts_with(['=', '+', '-', '@']) { format!("'{s}") } else { s.to_string() };
    if s.contains([';', '"', '\n', '\r', ',']) {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s
    }
}

/// Écrit un CSV (UTF-8 avec BOM pour Excel). `rows[0]` est l'en-tête.
pub fn write_csv(path: &Path, rows: &[Vec<String>]) -> Result<usize> {
    let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "csv" {
        bail!("Le fichier doit finir par .csv");
    }
    let mut out = String::from("\u{feff}");
    for r in rows {
        out.push_str(&r.iter().map(|c| csv_field(c)).collect::<Vec<_>>().join(";"));
        out.push_str("\r\n");
    }
    std::fs::write(path, out)?;
    Ok(rows.len().saturating_sub(1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn csv_quotes_and_formulas() {
        assert_eq!(csv_field("Daft Punk"), "Daft Punk");
        assert_eq!(csv_field("a;b"), "\"a;b\"");
        assert_eq!(csv_field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(csv_field("=cmd()"), "'=cmd()");
        let dir = std::env::temp_dir().join(format!("tf-csv-{}", now()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(write_csv(&dir.join("x.txt"), &[]).is_err());
        let n = write_csv(&dir.join("x.csv"), &[vec!["T".into()], vec!["a".into()]]).unwrap();
        assert_eq!(n, 1);
    }

    #[test]
    fn notes_and_pairs_persist() {
        let dir = std::env::temp_dir().join(format!("tf-dj-{}-{}", now(), std::process::id()));
        let dj = Dj::load(dir.clone());
        dj.set_note("/a.mp3", "  monte bien  ");
        dj.add_pair("/a.mp3", "/b.mp3", "");
        dj.add_pair("/a.mp3", "/b.mp3", "drop sur drop");
        let again = Dj::load(dir);
        assert_eq!(again.notes().get("/a.mp3").map(String::as_str), Some("monte bien"));
        let p = again.pairs();
        assert_eq!(p.len(), 1);
        assert_eq!((p[0].a.as_str(), p[0].note.as_str()), ("/a.mp3", "drop sur drop"));
        again.forget_paths(&["/b.mp3".into()]);
        assert!(again.pairs().is_empty());
    }
}
