//! Playlists suivies : vérification périodique et téléchargement des nouveautés.

use crate::{
    jobs::{self, AppState},
    sources::{self, Source},
    tools,
};
use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::Mutex,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Watched {
    pub id: u64,
    pub url: String,
    pub title: String,
    pub source: Source,
    /// Clés des pistes déjà vues.
    #[serde(default)]
    pub known: Vec<String>,
    pub last_check: Option<u64>,
    pub last_new: usize,
    pub error: Option<String>,
    #[serde(default)]
    pub checking: bool,
}

/// Vue envoyée à l'interface (sans la liste des clés).
#[derive(Serialize, Clone)]
pub struct WatchedView {
    id: u64,
    url: String,
    title: String,
    source: Source,
    tracks: usize,
    last_check: Option<u64>,
    last_new: usize,
    error: Option<String>,
    checking: bool,
}

impl From<&Watched> for WatchedView {
    fn from(w: &Watched) -> Self {
        Self {
            id: w.id,
            url: w.url.clone(),
            title: w.title.clone(),
            source: w.source,
            tracks: w.known.len(),
            last_check: w.last_check,
            last_new: w.last_new,
            error: w.error.clone(),
            checking: w.checking,
        }
    }
}

#[derive(Default)]
pub struct WatchState(pub Mutex<Vec<Watched>>);

fn now() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

fn file<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("watched.json"))
}

pub fn load<R: tauri::Runtime>(app: &AppHandle<R>) -> Vec<Watched> {
    file(app)
        .and_then(|f| std::fs::read_to_string(f).ok())
        .and_then(|t| serde_json::from_str::<Vec<Watched>>(&t).ok())
        .map(|mut v| {
            v.iter_mut().for_each(|w| w.checking = false);
            v
        })
        .unwrap_or_default()
}

fn save_and_emit<R: tauri::Runtime>(app: &AppHandle<R>) {
    let list = app.state::<WatchState>().0.lock().unwrap().clone();
    if let Some(f) = file(app) {
        if let Some(d) = f.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        if let Ok(json) = serde_json::to_string_pretty(&list) {
            let _ = std::fs::write(f, json);
        }
    }
    let _ = app.emit("watched", list.iter().map(WatchedView::from).collect::<Vec<_>>());
}

pub fn views<R: tauri::Runtime>(app: &AppHandle<R>) -> Vec<WatchedView> {
    app.state::<WatchState>().0.lock().unwrap().iter().map(WatchedView::from).collect()
}

/// Ajoute une playlist. `download_existing` : télécharger aussi les pistes déjà présentes.
pub async fn add<R: tauri::Runtime>(app: &AppHandle<R>, url: String, download_existing: bool) -> Result<usize> {
    let url = url.trim().to_string();
    if !sources::is_collection(&url) {
        return Err(anyhow!("Ce lien n'est pas une playlist, un album ou un set"));
    }
    if app.state::<WatchState>().0.lock().unwrap().iter().any(|w| w.url == url) {
        return Err(anyhow!("Cette playlist est déjà suivie"));
    }
    let resolved = resolve(app, &url).await?;
    let id = {
        let ws = app.state::<WatchState>();
        let list = ws.0.lock().unwrap();
        list.iter().map(|w| w.id).max().unwrap_or(0) + 1
    };
    let mut w = Watched {
        id,
        url: url.clone(),
        title: resolved.title.clone().unwrap_or_else(|| "Playlist".into()),
        source: sources::detect(&url),
        known: vec![],
        last_check: Some(now()),
        last_new: 0,
        error: None,
        checking: false,
    };
    let mut queued = 0;
    for t in resolved.tracks {
        if download_existing {
            jobs::enqueue(app, t.source, t.url, t.meta, None);
            queued += 1;
        }
        w.known.push(t.key);
    }
    w.last_new = queued;
    app.state::<WatchState>().0.lock().unwrap().push(w);
    save_and_emit(app);
    jobs::pump(app);
    Ok(queued)
}

pub fn remove<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) {
    app.state::<WatchState>().0.lock().unwrap().retain(|w| w.id != id);
    save_and_emit(app);
}

async fn resolve<R: tauri::Runtime>(app: &AppHandle<R>, url: &str) -> Result<sources::Resolved> {
    let t = if sources::detect(url) == Source::Spotify {
        tools::Tools { ytdlp: Default::default(), ffmpeg_dir: None }
    } else {
        tools::locate(app).ok_or_else(|| anyhow!("yt-dlp n'est pas installé"))?
    };
    sources::resolve(&t, url).await
}

/// Vérifie une playlist et met en file les nouvelles pistes.
pub async fn check<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) -> Result<usize> {
    let url = {
        let ws = app.state::<WatchState>();
        let mut list = ws.0.lock().unwrap();
        let w = list.iter_mut().find(|w| w.id == id).ok_or_else(|| anyhow!("Playlist introuvable"))?;
        if w.checking {
            return Ok(0);
        }
        w.checking = true;
        w.url.clone()
    };
    save_and_emit(app);
    let res = resolve(app, &url).await;

    let mut new_tracks = Vec::new();
    {
        let ws = app.state::<WatchState>();
        let mut list = ws.0.lock().unwrap();
        let Some(w) = list.iter_mut().find(|w| w.id == id) else { return Ok(0) };
        w.checking = false;
        w.last_check = Some(now());
        match &res {
            Ok(r) => {
                w.error = None;
                if let Some(t) = &r.title {
                    w.title = t.clone();
                }
                let known: HashSet<&String> = w.known.iter().collect();
                new_tracks = r.tracks.iter().filter(|t| !known.contains(&t.key)).cloned().collect();
                w.known.extend(new_tracks.iter().map(|t| t.key.clone()));
                w.last_new = new_tracks.len();
            }
            Err(e) => w.error = Some(e.to_string()),
        }
    }
    save_and_emit(app);
    let n = new_tracks.len();
    for t in new_tracks {
        jobs::enqueue(app, t.source, t.url, t.meta, None);
    }
    if n > 0 {
        jobs::pump(app);
    }
    res.map(|_| n)
}

pub async fn check_all<R: tauri::Runtime>(app: &AppHandle<R>) -> usize {
    let ids: Vec<u64> = app.state::<WatchState>().0.lock().unwrap().iter().map(|w| w.id).collect();
    let mut total = 0;
    for id in ids {
        total += check(app, id).await.unwrap_or(0);
    }
    total
}

/// Boucle de fond : vérifie chaque playlist selon l'intervalle réglé.
pub fn start_timer<R: tauri::Runtime>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            let interval = app.state::<AppState>().settings.lock().unwrap().watch_interval * 60;
            let due: Vec<u64> = app
                .state::<WatchState>()
                .0
                .lock()
                .unwrap()
                .iter()
                .filter(|w| w.last_check.is_none_or(|t| now().saturating_sub(t) >= interval))
                .map(|w| w.id)
                .collect();
            for id in due {
                let _ = check(&app, id).await;
            }
            tokio::time::sleep(Duration::from_secs(60)).await;
        }
    });
}
