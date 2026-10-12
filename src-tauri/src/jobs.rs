//! File d'attente : téléchargement → analyse → vérification → tags → rangement.
//!
//! L'ordonnanceur prend les pistes en attente par priorité puis par ordre
//! d'arrivée. La file est enregistrée sur disque : après une fermeture ou une
//! coupure, les pistes inachevées reprennent au lancement suivant.

use crate::{
    bpm,
    online::{self, BpmResult, SourceBpm, Verdict},
    settings::{self, Settings},
    sources::{self, Meta, Source},
    tags::{self, TagData},
    tools::{self, Tools},
};
use anyhow::{anyhow, Result};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    sync::Notify,
};

/// Nombre de nouvelles tentatives automatiques après une erreur réseau.
const MAX_AUTO_RETRIES: u32 = 3;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Status {
    Queued,
    Searching,
    Downloading,
    Converting,
    Analyzing,
    Verifying,
    Tagging,
    Done,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Job {
    pub id: u64,
    pub source: Source,
    pub url: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover: Option<String>,
    pub duration: Option<f64>,
    #[serde(default)]
    pub genre: Option<String>,
    pub status: Status,
    pub progress: f64,
    pub path: Option<String>,
    pub bpm: Option<BpmResult>,
    pub error: Option<String>,
    /// Message d'information (nouvelle tentative, etc.).
    #[serde(default)]
    pub note: Option<String>,
    #[serde(default)]
    pub priority: bool,
    /// Ordre d'arrivée.
    #[serde(default)]
    pub seq: u64,
    #[serde(default)]
    pub attempts: u32,
    /// BPM déjà présent dans le fichier quand l'analyse donne autre chose :
    /// le tag n'est pas modifié tant que l'utilisateur n'a pas appliqué.
    #[serde(default)]
    pub existing_bpm: Option<f64>,
    /// Identifiant de la piste source (historique des téléchargements).
    #[serde(default)]
    pub source_key: Option<String>,
    /// Tonalité détectée (Camelot).
    #[serde(default)]
    pub key: Option<crate::key::Key>,
    #[serde(skip)]
    not_before: Option<Instant>,
}

pub struct AppState {
    pub jobs: Mutex<Vec<Job>>,
    pub settings: Mutex<Settings>,
    cancels: Mutex<HashMap<u64, Arc<Notify>>>,
    running: Mutex<HashSet<u64>>,
    next_id: AtomicU64,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        Self {
            jobs: Mutex::new(Vec::new()),
            settings: Mutex::new(settings),
            cancels: Mutex::new(HashMap::new()),
            running: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
        }
    }
}

fn state<R: tauri::Runtime>(app: &AppHandle<R>) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

fn emit<R: tauri::Runtime>(app: &AppHandle<R>, job: &Job) {
    let _ = app.emit("job", job);
}

/// Modifie un job et notifie l'interface. `None` si le job a été retiré.
fn update<R: tauri::Runtime>(app: &AppHandle<R>, id: u64, f: impl FnOnce(&mut Job)) -> Option<Job> {
    let st = state(app);
    let mut jobs = st.jobs.lock().unwrap();
    let job = jobs.iter_mut().find(|j| j.id == id)?;
    f(job);
    let j = job.clone();
    drop(jobs);
    emit(app, &j);
    Some(j)
}

fn alive<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) -> Result<Job> {
    let st = state(app);
    let jobs = st.jobs.lock().unwrap();
    jobs.iter().find(|j| j.id == id).cloned().ok_or_else(|| anyhow!("annulé"))
}

// ---------- Persistance ----------

fn queue_file<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("queue.json"))
}

/// Enregistre les pistes inachevées (en attente, en cours, en erreur).
pub fn persist<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(file) = queue_file(app) else { return };
    let pending: Vec<Job> = state(app)
        .jobs
        .lock()
        .unwrap()
        .iter()
        .filter(|j| j.status != Status::Done)
        .cloned()
        .collect();
    if let Some(d) = file.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    if let Ok(json) = serde_json::to_string(&pending) {
        let tmp = file.with_extension("tmp");
        if std::fs::write(&tmp, json).is_ok() {
            let _ = std::fs::rename(tmp, file);
        }
    }
}

/// Recharge la file au démarrage : ce qui était en cours repart en attente.
pub fn restore<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Some(file) = queue_file(app) else { return };
    let Ok(text) = std::fs::read_to_string(file) else { return };
    let Ok(mut saved) = serde_json::from_str::<Vec<Job>>(&text) else { return };
    let st = state(app);
    let mut max_id = 0;
    for j in saved.iter_mut() {
        max_id = max_id.max(j.id);
        if j.status != Status::Error {
            j.status = Status::Queued;
            j.progress = 0.0;
            j.note = Some("Reprise après fermeture".into());
        }
    }
    st.next_id.store(max_id + 1, Ordering::SeqCst);
    *st.jobs.lock().unwrap() = saved;
}

// ---------- Ordonnanceur ----------

pub fn enqueue<R: tauri::Runtime>(
    app: &AppHandle<R>,
    source: Source,
    url: String,
    meta: Meta,
    path: Option<String>,
    source_key: Option<String>,
) -> Job {
    let st = state(app);
    let id = st.next_id.fetch_add(1, Ordering::SeqCst);
    let job = Job {
        id,
        source,
        url,
        title: meta.title,
        artist: meta.artist,
        album: meta.album,
        cover: meta.cover,
        duration: meta.duration,
        genre: meta.genre,
        status: Status::Queued,
        progress: 0.0,
        path,
        bpm: None,
        error: None,
        note: None,
        priority: false,
        seq: id,
        attempts: 0,
        existing_bpm: None,
        source_key,
        key: None,
        not_before: None,
    };
    st.jobs.lock().unwrap().push(job.clone());
    emit(app, &job);
    job
}

/// Identifiants (source et artiste|titre) des pistes en file, hors erreurs.
pub fn queued_identities<R: tauri::Runtime>(app: &AppHandle<R>) -> HashSet<String> {
    let st = state(app);
    let jobs = st.jobs.lock().unwrap();
    jobs.iter()
        .filter(|j| j.status != Status::Error)
        .flat_map(|j| {
            [j.source_key.clone(), crate::history::identity(j.artist.as_deref(), j.title.as_deref())]
        })
        .flatten()
        .collect()
}

/// Lance autant de pistes que le permet le réglage « simultanés ».
pub fn pump<R: tauri::Runtime>(app: &AppHandle<R>) {
    let st = state(app);
    let (parallel, paused) = {
        let s = st.settings.lock().unwrap();
        (s.parallel, s.paused)
    };
    let mut to_start = Vec::new();
    {
        let jobs = st.jobs.lock().unwrap();
        let mut running = st.running.lock().unwrap();
        let now = Instant::now();
        let mut queued: Vec<&Job> = jobs
            .iter()
            .filter(|j| j.status == Status::Queued && !running.contains(&j.id))
            .filter(|j| j.not_before.is_none_or(|t| t <= now))
            .collect();
        queued.sort_by_key(|j| (!j.priority, j.seq));
        for j in queued {
            if paused || running.len() >= parallel {
                break;
            }
            running.insert(j.id);
            to_start.push(j.id);
        }
    }
    for id in to_start {
        spawn_job(app, id);
    }
    persist(app);
}

fn spawn_job<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) {
    let app = app.clone();
    let cancel = Arc::new(Notify::new());
    state(&app).cancels.lock().unwrap().insert(id, cancel.clone());
    tauri::async_runtime::spawn(async move {
        let outcome = run(&app, id, cancel).await;
        state(&app).cancels.lock().unwrap().remove(&id);
        state(&app).running.lock().unwrap().remove(&id);
        if let Err(e) = outcome {
            let msg = e.to_string();
            if msg != "annulé" {
                fail(&app, id, msg);
            }
        }
        pump(&app);
    });
}

fn is_network_error(msg: &str) -> bool {
    let m = msg.to_lowercase();
    [
        "timed out", "timeout", "connection", "network", "temporarily", "getaddrinfo", "resolve host",
        "http error 5", "remote end closed", "reset by peer", "unreachable", "eof occurred", "incomplete read",
    ]
    .iter()
    .any(|k| m.contains(k))
}

/// Erreur : nouvelle tentative différée si c'est une coupure réseau.
fn fail<R: tauri::Runtime>(app: &AppHandle<R>, id: u64, msg: String) {
    let retry = is_network_error(&msg);
    let mut delay = None;
    update(app, id, |j| {
        if retry && j.attempts < MAX_AUTO_RETRIES {
            j.attempts += 1;
            let secs = 15u64 * (1 << (j.attempts - 1));
            j.status = Status::Queued;
            j.progress = 0.0;
            j.note = Some(format!("Connexion perdue, nouvelle tentative dans {secs} s ({}/{MAX_AUTO_RETRIES})", j.attempts));
            j.not_before = Some(Instant::now() + Duration::from_secs(secs));
            delay = Some(secs);
        } else {
            j.status = Status::Error;
            j.error = Some(friendly(&msg));
            j.note = None;
        }
    });
    if let Some(secs) = delay {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(Duration::from_secs(secs)).await;
            pump(&app);
        });
    }
}

pub fn cancel<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) {
    if let Some(n) = state(app).cancels.lock().unwrap().get(&id) {
        n.notify_one();
    }
}

/// Bascule la priorité d'une piste en attente.
pub fn toggle_priority<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) {
    update(app, id, |j| j.priority = !j.priority);
    pump(app);
}

pub fn retry<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) {
    update(app, id, |j| {
        if j.status == Status::Error {
            j.status = Status::Queued;
            j.error = None;
            j.note = None;
            j.progress = 0.0;
            j.attempts = 0;
            j.not_before = None;
        }
    });
    pump(app);
}

fn set_status<R: tauri::Runtime>(app: &AppHandle<R>, id: u64, s: Status) -> Result<Job> {
    update(app, id, |j| {
        j.status = s;
        j.progress = 0.0;
        j.note = None;
    })
    .ok_or_else(|| anyhow!("annulé"))
}

// ---------- Traitement d'une piste ----------

async fn run<R: tauri::Runtime>(app: &AppHandle<R>, id: u64, cancel: Arc<Notify>) -> Result<()> {
    let job = alive(app, id)?;
    let settings = state(app).settings.lock().unwrap().clone();

    // 1. Fichier audio (téléchargé, ou fichier local existant)
    let (file, info) = if job.source == Source::Local {
        (PathBuf::from(job.path.clone().unwrap_or_default()), None)
    } else {
        let mut tools = tools::require(app)?;
        let meta = Meta {
            title: job.title.clone(),
            artist: job.artist.clone(),
            duration: job.duration,
            ..Default::default()
        };
        // Candidats essayés dans l'ordre : le lien donné (ou la meilleure
        // correspondance YouTube pour Spotify), puis d'autres mises en ligne
        // du même morceau sur YouTube, puis SoundCloud.
        let mut tried: Vec<String> = Vec::new();
        let mut queue: Vec<String> = Vec::new();
        if job.source == Source::Spotify && job.url.is_empty() {
            set_status(app, id, Status::Searching)?;
            queue = sources::find_matches(&tools, &meta, "ytsearch8").await.unwrap_or_default();
        } else {
            queue.push(job.url.clone());
        }
        let mut searched_yt = job.source == Source::Spotify;
        let mut searched_sc = false;
        let mut last_err: Option<anyhow::Error> = None;
        let mut result = None;
        loop {
            if queue.is_empty() && meta.title.is_some() {
                // Plus de candidat : on élargit la recherche.
                if !searched_yt {
                    searched_yt = true;
                    set_status(app, id, Status::Searching)?;
                    queue = sources::find_matches(&tools, &meta, "ytsearch8").await.unwrap_or_default();
                } else if !searched_sc {
                    searched_sc = true;
                    set_status(app, id, Status::Searching)?;
                    queue = sources::find_matches(&tools, &meta, "scsearch8").await.unwrap_or_default();
                }
                queue.retain(|u| !tried.contains(u));
            }
            if queue.is_empty() || tried.len() >= 6 {
                break;
            }
            let url = queue.remove(0);
            tried.push(url.clone());
            if tried.len() > 1 {
                let why = last_err.as_ref().map(|e| short_reason(&e.to_string())).unwrap_or_default();
                let target = if sources::detect(&url) == Source::Soundcloud { "SoundCloud" } else { "une autre version YouTube" };
                update(app, id, |j| j.note = Some(format!("{why} : essai sur {target}")));
            }
            set_status(app, id, Status::Downloading)?;
            let mut r = download(app, id, &tools, &url, &settings, cancel.clone()).await;
            // Cookies illisibles ou session YouTube refusée : même lien sans cookies.
            if matches!(&r, Err(e) if tools::retry_without_cookies(&e.to_string())) && !tools.cookies.is_empty() {
                tools = tools.without_cookies();
                r = download(app, id, &tools, &url, &settings, cancel.clone()).await;
            }
            match r {
                Ok(ok) => {
                    if tried.len() > 1 {
                        let note = if sources::detect(&url) == Source::Soundcloud { "Récupéré sur SoundCloud" } else { "Récupéré sur une autre version YouTube" };
                        update(app, id, |j| j.note = Some(note.into()));
                    }
                    result = Some(ok);
                    break;
                }
                Err(e) if try_elsewhere(&e.to_string()) => last_err = Some(e),
                Err(e) => return Err(e),
            }
        }
        let Some((file, info)) = result else {
            return Err(last_err.unwrap_or_else(|| anyhow!("Aucune correspondance trouvée")));
        };
        (file, Some(info))
    };

    // 2. Métadonnées : celles de Spotify font foi, sinon celles de yt-dlp.
    let job = alive(app, id)?;
    let mut meta = Meta {
        title: job.title.clone(),
        artist: job.artist.clone(),
        album: job.album.clone(),
        duration: job.duration,
        cover: job.cover.clone(),
        genre: job.genre.clone(),
    };
    if let Some(info) = &info {
        let m = sources::meta_from_info(info);
        if job.source != Source::Spotify {
            meta.title = m.title.or(meta.title);
            meta.artist = m.artist.or(meta.artist);
        }
        meta.album = meta.album.or(m.album);
        meta.duration = meta.duration.or(m.duration);
        meta.genre = meta.genre.or(m.genre);
    }
    if job.source == Source::Local {
        let (t, a, al) = tags::read_basic(&file);
        let stem = file.file_stem().and_then(|s| s.to_str()).unwrap_or("").to_string();
        let split = sources::split_artist_title(&stem);
        meta.title = t.or(split.as_ref().map(|s| s.1.clone())).or(Some(stem));
        meta.artist = a.or(split.map(|s| s.0));
        meta.album = al;
    }
    update(app, id, |j| {
        j.title = meta.title.clone();
        j.artist = meta.artist.clone();
        j.album = meta.album.clone();
    });

    // 3. Analyse locale
    set_status(app, id, Status::Analyzing)?;
    let f = file.clone();
    let (tempo, key) = tokio::task::spawn_blocking(move || bpm::analyze_full(&f)).await?;
    let local = tempo.map(|a| (a.bpm, a.confidence));

    // 4. Vérification en ligne, pochette HD et genre
    let is_local = job.source == Source::Local;
    let mut found: Vec<SourceBpm> = Vec::new();
    let mut hd_cover: Option<String> = None;
    let want_extras = !is_local && (settings.hd_cover || settings.sort_by != "none" || meta.genre.is_none());
    if settings.verify_online || want_extras {
        set_status(app, id, Status::Verifying)?;
        let artist = meta.artist.clone().unwrap_or_default();
        let title = meta.title.clone().unwrap_or_default();
        if !title.is_empty() {
            let verify = settings.verify_online;
            let (dz, gs, it) = tokio::join!(
                online::deezer(&artist, &title, meta.duration),
                async {
                    if verify {
                        online::getsongbpm(&settings.getsongbpm_key, &artist, &title).await
                    } else {
                        None
                    }
                },
                async {
                    if want_extras {
                        online::itunes(&artist, &title, meta.duration).await
                    } else {
                        None
                    }
                }
            );
            if let Some(it) = it {
                hd_cover = it.cover;
                meta.genre = meta.genre.or(it.genre);
                meta.album = meta.album.or(it.album);
            }
            if let Some(dz) = dz {
                if verify {
                    if let Some(b) = dz.bpm {
                        found.push(SourceBpm { source: "Deezer".into(), bpm: b });
                    }
                }
                meta.album = meta.album.or(dz.album);
                meta.genre = meta.genre.or(dz.genre);
                hd_cover = hd_cover.or(dz.cover);
            }
            if let Some(b) = gs {
                found.push(SourceBpm { source: "GetSongBPM".into(), bpm: b });
            }
        }
        if let (true, Some(info)) = (settings.verify_online, &info) {
            let text = format!(
                "{} {}",
                info["title"].as_str().unwrap_or(""),
                info["description"].as_str().unwrap_or("")
            );
            if let Some(b) = online::from_text(&text) {
                found.push(SourceBpm { source: "Description".into(), bpm: b });
            }
        }
    }
    let result = online::reconcile(local, found);

    // 5. Tags
    set_status(app, id, Status::Tagging)?;
    let cover_url = if is_local {
        None
    } else if settings.hd_cover && hd_cover.is_some() {
        hd_cover.clone()
    } else if job.source == Source::Spotify {
        meta.cover.clone().or(hd_cover.clone())
    } else {
        None // garde la miniature intégrée par yt-dlp
    };
    let mut cover = match &cover_url {
        Some(u) => fetch_bytes(u).await,
        None => None,
    };
    // Aucune pochette du tout : on en génère une.
    if cover.is_none() && !is_local && !tags::has_picture(&file) {
        cover = crate::artwork::generate(
            meta.title.as_deref().unwrap_or(""),
            meta.artist.as_deref().unwrap_or(""),
            result.as_ref().map(|r| r.bpm),
        );
    }
    let detail = result.as_ref().map(describe);
    // Fichier local déjà tagué avec un autre BPM : on ne l'écrase pas.
    let existing = if is_local { tags::read_bpm(&file) } else { None };
    let differs = matches!((existing, &result), (Some(old), Some(r)) if old.round() != r.bpm.round());
    let existing_bpm = if differs { existing } else { None };
    // Une clé déjà présente dans un fichier local est conservée.
    let write_key = key.is_some() && !(is_local && tags::read_key(&file).is_some());
    let data = TagData {
        title: if is_local { None } else { meta.title.clone() },
        artist: if is_local { None } else { meta.artist.clone() },
        album: if is_local { None } else { meta.album.clone() },
        genre: if is_local { None } else { meta.genre.clone() },
        bpm: if differs { None } else { result.as_ref().map(|r| r.bpm) },
        bpm_detail: detail,
        key: if write_key { key.clone() } else { None },
        cover,
        source_url: if is_local {
            None
        } else {
            job.source_key.as_deref().and_then(crate::history::key_url).or_else(|| Some(job.url.clone()).filter(|u| u.starts_with("http")))
        },
    };
    let f = file.clone();
    tokio::task::spawn_blocking(move || tags::write(&f, &data)).await??;

    // 6. Rangement
    let bpm_value = result.as_ref().map(|r| r.bpm);
    let final_path = if is_local {
        file
    } else {
        let camelot = key.as_ref().map(|k| k.camelot.as_str());
        let name = file_name(&settings.filename_template, &meta, bpm_value, camelot);
        let dir = PathBuf::from(&settings.output_dir).join(sort_folder(&settings.sort_by, &meta, bpm_value, camelot));
        let dest = unique(&dir.join(name));
        move_file(&file, &dest).await?;
        if let Some(tmp) = file.parent() {
            let _ = tokio::fs::remove_dir(tmp).await; // seulement s'il est vide
        }
        dest
    };

    if let Some(k) = &job.source_key {
        crate::history::record(app, k, &final_path.display().to_string());
    }
    let display_cover = if settings.hd_cover { hd_cover.or(meta.cover.clone()) } else { meta.cover.clone() };
    let done = update(app, id, |j| {
        j.status = Status::Done;
        j.progress = 1.0;
        j.path = Some(final_path.display().to_string());
        j.album = meta.album.clone();
        j.genre = meta.genre.clone();
        j.bpm = result;
        j.existing_bpm = existing_bpm;
        j.key = key;
        if !is_local {
            j.cover = display_cover.or(j.cover.take());
        }
    });
    if let Some(j) = done {
        crate::desk::job_done(app, &j);
    }
    // Grille, intro et outro pour l'onglet DJ (en tâche de fond).
    if let Some(dj) = app.try_state::<crate::dj::Dj>() {
        let path = final_path.display().to_string();
        if dj.cached_grid(&path).is_none() {
            let hint = bpm_value;
            let p = final_path.clone();
            if let Ok(Ok(g)) = tokio::task::spawn_blocking(move || bpm::grid(&p, hint)).await {
                dj.store_grid(&path, &g);
            }
        }
    }
    Ok(())
}

async fn download<R: tauri::Runtime>(
    app: &AppHandle<R>,
    id: u64,
    tools: &Tools,
    url: &str,
    settings: &Settings,
    cancel: Arc<Notify>,
) -> Result<(PathBuf, serde_json::Value)> {
    let tmp = PathBuf::from(&settings.output_dir).join(".trackfetcher-tmp");
    tokio::fs::create_dir_all(&tmp).await?;
    // Nom stable : un téléchargement interrompu reprend là où il s'était arrêté.
    let template = tmp.join("%(extractor_key)s-%(id)s.%(ext)s");
    let quality = match settings.quality.as_str() {
        "v0" => "0",
        "192" => "192K",
        _ => "320K",
    };
    let mut cmd = tools.ytdlp();
    cmd.arg(url)
        .args(["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", quality])
        .args(["--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg"])
        // Pochette recadrée au carré.
        .args([
            "--ppa",
            r#"ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -vf crop="'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'""#,
        ])
        .args(["--no-playlist", "--newline", "--progress", "--no-mtime", "--encoding", "utf-8", "--continue"])
        .args(["--retries", "10", "--fragment-retries", "10", "--retry-sleep", "exp=1:20"])
        .args(["--progress-template", "download:TFPROG %(progress._percent_str)s"])
        .args(["-O", "after_move:%(.{filepath,title,track,artist,creator,uploader,channel,album,genre,description,duration})j"])
        .arg("-o")
        .arg(&template)
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    if let Some(dir) = &tools.ffmpeg_dir {
        cmd.arg("--ffmpeg-location").arg(dir);
    }
    let mut child = cmd.spawn()?;
    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    let app2 = app.clone();
    let reader = tauri::async_runtime::spawn(async move {
        let mut info = None;
        let mut lines = BufReader::new(stdout).lines();
        let mut last = 0.0;
        while let Ok(Some(line)) = lines.next_line().await {
            if let Some(p) = line.strip_prefix("TFPROG") {
                let num: String = p.chars().filter(|c| c.is_ascii_digit() || *c == '.').collect();
                if let Ok(v) = num.parse::<f64>() {
                    let v = (v / 100.0).clamp(0.0, 1.0);
                    if v - last >= 0.01 || v >= 1.0 {
                        last = v;
                        update(&app2, id, |j| {
                            if v >= 1.0 {
                                j.status = Status::Converting;
                                j.progress = 0.0;
                            } else {
                                j.progress = v;
                            }
                        });
                    }
                }
            } else if line.starts_with('{') {
                info = serde_json::from_str::<serde_json::Value>(&line).ok();
            }
        }
        info
    });
    let err_reader = tauri::async_runtime::spawn(async move {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf).await;
        buf
    });

    let status = tokio::select! {
        s = child.wait() => s?,
        _ = cancel.notified() => {
            let _ = child.kill().await;
            return Err(anyhow!("annulé"));
        }
    };
    let info = reader.await.ok().flatten();
    let err = err_reader.await.unwrap_or_default();
    if !status.success() {
        // Message brut de yt-dlp : il sert à choisir un repli ; traduit dans `fail`.
        return Err(anyhow!(sources::last_error(&err)));
    }
    let info = info.ok_or_else(|| anyhow!("Fichier téléchargé introuvable"))?;
    let path = PathBuf::from(info["filepath"].as_str().unwrap_or_default());
    if !path.is_file() {
        return Err(anyhow!("Fichier téléchargé introuvable"));
    }
    Ok((path, info))
}

pub const BOT_MESSAGE: &str = "YouTube demande une vérification anti-robot. Dans Réglages › Session YouTube, choisis ton navigateur (Firefox conseillé) puis réessaie.";

fn is_bot_check(msg: &str) -> bool {
    let m = msg.to_lowercase();
    msg == BOT_MESSAGE || m.contains("sign in to confirm") || m.contains("not a bot") || m.contains("confirm you")
}

/// Erreur propre à cette mise en ligne : une autre version peut passer.
fn try_elsewhere(msg: &str) -> bool {
    let m = msg.to_lowercase();
    is_bot_check(msg)
        || tools::is_stale_session(msg)
        || m.contains("age-restricted")
        || m.contains("age restricted")
        || m.contains("confirm your age")
        || m.contains("inappropriate for some users")
        || m.contains("403")
        || m.contains("forbidden")
        || m.contains("drm")
        || m.contains("unavailable")
        || m.contains("not available")
        || m.contains("private video")
        || m.contains("copyright")
        || m.contains("blocked it")
        || m.contains("requested format is not available")
}

/// Raison courte affichée pendant le changement de source.
fn short_reason(msg: &str) -> String {
    let m = msg.to_lowercase();
    if m.contains("age") && m.contains("restrict") || m.contains("confirm your age") {
        "Vidéo soumise à l'âge"
    } else if m.contains("403") || m.contains("forbidden") {
        "YouTube a refusé le téléchargement"
    } else if m.contains("drm") {
        "Morceau protégé (DRM)"
    } else if is_bot_check(msg) || tools::is_stale_session(msg) {
        "YouTube bloque"
    } else {
        "Indisponible"
    }
    .into()
}

pub fn friendly(err: &str) -> String {
    let e = err.to_lowercase();
    if is_bot_check(err) {
        BOT_MESSAGE.into()
    } else if e.contains("age-restricted") || e.contains("confirm your age") {
        "Vidéo soumise à une limite d'âge, et aucune autre version n'a fonctionné. Choisis ton navigateur (connecté à YouTube) dans Réglages › Session YouTube puis réessaie.".into()
    } else if e.contains("drm") {
        "Morceau protégé (DRM) sur SoundCloud, et aucune autre version trouvée.".into()
    } else if e.contains("403") || e.contains("forbidden") {
        "YouTube a refusé le téléchargement (erreur 403), sur toutes les versions essayées. Réessaie plus tard : yt-dlp se met à jour tout seul.".into()
    } else if tools::is_stale_session(err) {
        "YouTube a refusé la vidéo (« The page needs to be reloaded »). Réessaie dans quelques minutes ; si ça continue, ouvre YouTube dans ton navigateur pour rafraîchir la session, ou choisis « Aucune » dans Réglages › Session YouTube.".into()
    } else if e.contains("could not copy") && e.contains("cookie") || e.contains("failed to decrypt") || e.contains("dpapi") {
        "Impossible de lire les cookies du navigateur. Ferme-le complètement, ou choisis Firefox dans Réglages › Session YouTube.".into()
    } else if e.contains("private") {
        "Contenu privé.".into()
    } else if e.contains("unavailable") || e.contains("not available") {
        "Contenu indisponible.".into()
    } else if e.contains("ffmpeg") || e.contains("ffprobe") {
        "ffmpeg introuvable ou en échec.".into()
    } else {
        err.to_string()
    }
}

fn describe(r: &BpmResult) -> String {
    let mut parts = Vec::new();
    if let Some(l) = r.local {
        parts.push(format!("Analyse {l}"));
    }
    for s in &r.sources {
        parts.push(format!("{} {}", s.source, s.bpm));
    }
    parts.join(" · ")
}

async fn fetch_bytes(url: &str) -> Option<Vec<u8>> {
    let r = sources::http().get(url).send().await.ok()?.error_for_status().ok()?;
    r.bytes().await.ok().map(|b| b.to_vec())
}

// ---------- Nommage et tri ----------

pub fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c == ' ');
    cleaned.chars().take(150).collect()
}

/// Entier, comme dans le tag TBPM.
fn fmt_bpm(b: f64) -> String {
    format!("{}", b.round())
}

/// Remplace les balises du modèle. Un groupe entre parenthèses ou crochets
/// dont toutes les balises sont vides disparaît (« [{bpm} BPM] » sans BPM).
pub fn render_template(template: &str, meta: &Meta, bpm: Option<f64>, key: Option<&str>) -> String {
    static GROUP: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*[\(\[][^\(\)\[\]]*[\)\]]").unwrap());
    static TOKEN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\{(\w+)\}").unwrap());
    let value = |name: &str| -> String {
        match name {
            "artist" => meta.artist.clone().unwrap_or_default(),
            "title" => meta.title.clone().unwrap_or_default(),
            "album" => meta.album.clone().unwrap_or_default(),
            "genre" => meta.genre.clone().unwrap_or_default(),
            "bpm" => bpm.map(fmt_bpm).unwrap_or_default(),
            "key" => key.unwrap_or_default().to_string(),
            _ => String::new(),
        }
    };
    let without_empty_groups = GROUP.replace_all(template, |c: &regex::Captures| {
        let g = &c[0];
        let tokens: Vec<_> = TOKEN.captures_iter(g).collect();
        if !tokens.is_empty() && tokens.iter().all(|t| value(&t[1]).trim().is_empty()) {
            String::new()
        } else {
            g.to_string()
        }
    });
    let out = TOKEN.replace_all(&without_empty_groups, |c: &regex::Captures| value(&c[1]));
    // Séparateurs orphelins quand une balise est vide (« - Titre », « Artiste -  »).
    static INNER_LEFT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"([\(\[])\s*[-·]\s*").unwrap());
    static INNER_RIGHT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*[-·]\s*([\)\]])").unwrap());
    static EMPTY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\s*(\(\s*\)|\[\s*\])").unwrap());
    let out = INNER_LEFT.replace_all(&out, "$1");
    let out = INNER_RIGHT.replace_all(&out, "$1");
    let out = EMPTY.replace_all(&out, "");
    let mut s = out.to_string();
    while s.contains(" -  - ") {
        s = s.replace(" -  - ", " - ");
    }
    s.trim().trim_start_matches(['-', '_', '·']).trim_end_matches(['-', '_', '·']).trim().to_string()
}

fn file_name(template: &str, meta: &Meta, bpm: Option<f64>, key: Option<&str>) -> String {
    let mut base = sanitize(&render_template(template, meta, bpm, key));
    if base.is_empty() {
        base = sanitize(&render_template(settings::DEFAULT_TEMPLATE, meta, bpm, key));
    }
    if base.is_empty() {
        base = "Sans titre".into();
    }
    format!("{base}.mp3")
}

fn bpm_range(bpm: Option<f64>) -> String {
    match bpm {
        Some(b) => {
            let lo = (b.round() as i64 / 5) * 5;
            format!("{lo}-{} BPM", lo + 4)
        }
        None => "BPM inconnu".into(),
    }
}

/// Sous-dossier de rangement.
pub fn sort_folder(mode: &str, meta: &Meta, bpm: Option<f64>, key: Option<&str>) -> PathBuf {
    let genre = || {
        meta.genre
            .as_deref()
            .map(sanitize)
            .filter(|g| !g.is_empty())
            .unwrap_or_else(|| "Genre inconnu".into())
    };
    match mode {
        "bpm" => PathBuf::from(bpm_range(bpm)),
        "genre" => PathBuf::from(genre()),
        "genre_bpm" => PathBuf::from(genre()).join(bpm_range(bpm)),
        "key" => PathBuf::from(key.unwrap_or("Clé inconnue")),
        "key_bpm" => PathBuf::from(key.unwrap_or("Clé inconnue")).join(bpm_range(bpm)),
        _ => PathBuf::new(),
    }
}

fn unique(p: &Path) -> PathBuf {
    if !p.exists() {
        return p.to_path_buf();
    }
    let stem = p.file_stem().and_then(|s| s.to_str()).unwrap_or("piste");
    let dir = p.parent().unwrap_or(Path::new("."));
    (2..)
        .map(|i| dir.join(format!("{stem} ({i}).mp3")))
        .find(|c| !c.exists())
        .unwrap()
}

async fn move_file(from: &Path, to: &Path) -> Result<()> {
    if let Some(d) = to.parent() {
        tokio::fs::create_dir_all(d).await?;
    }
    if tokio::fs::rename(from, to).await.is_err() {
        tokio::fs::copy(from, to).await?;
        tokio::fs::remove_file(from).await?;
    }
    Ok(())
}

/// Correction manuelle du BPM.
pub fn set_bpm<R: tauri::Runtime>(app: &AppHandle<R>, id: u64, bpm: f64) -> Result<Job> {
    let job = alive(app, id)?;
    let path = PathBuf::from(job.path.clone().ok_or_else(|| anyhow!("Fichier pas encore prêt"))?);
    let mut result = job.bpm.clone().unwrap_or(BpmResult {
        bpm,
        local: None,
        confidence: None,
        sources: vec![],
        verdict: Verdict::Manual,
    });
    result.bpm = bpm;
    result.verdict = Verdict::Manual;
    tags::write(
        &path,
        &TagData { title: None, artist: None, album: None, genre: None, bpm: Some(bpm), bpm_detail: None, key: None, cover: None, source_url: None },
    )?;
    update(app, id, |j| {
        j.bpm = Some(result);
        j.existing_bpm = None;
    })
    .ok_or_else(|| anyhow!("annulé"))
}

/// Écrit dans le fichier le BPM de l'analyse à la place de l'ancien tag.
pub fn apply_bpm<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) -> Result<Job> {
    let job = alive(app, id)?;
    let path = PathBuf::from(job.path.clone().ok_or_else(|| anyhow!("Fichier introuvable"))?);
    let bpm = job.bpm.as_ref().map(|r| r.bpm).ok_or_else(|| anyhow!("Pas de BPM analysé"))?;
    tags::write(
        &path,
        &TagData { title: None, artist: None, album: None, genre: None, bpm: Some(bpm), bpm_detail: None, key: None, cover: None, source_url: None },
    )?;
    update(app, id, |j| j.existing_bpm = None).ok_or_else(|| anyhow!("annulé"))
}

pub fn reload_settings<R: tauri::Runtime>(app: &AppHandle<R>) -> Settings {
    let s = settings::load(app);
    *state(app).settings.lock().unwrap() = s.clone();
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta() -> Meta {
        Meta { title: Some("Strobe".into()), artist: Some("deadmau5".into()), genre: Some("Dance".into()), ..Default::default() }
    }

    #[test]
    fn names() {
        assert_eq!(sanitize("AC/DC: Back in Black?"), "AC DC Back in Black");
        assert_eq!(file_name("{artist} - {title} ({bpm} BPM)", &meta(), Some(127.9), None), "deadmau5 - Strobe (128 BPM).mp3");
        assert_eq!(file_name("{artist} - {title} [{bpm} - {key}]", &meta(), Some(128.0), None), "deadmau5 - Strobe [128].mp3");
        assert_eq!(file_name("{artist} - {title} [{bpm} - {key}]", &meta(), Some(128.0), Some("8A")), "deadmau5 - Strobe [128 - 8A].mp3");
        assert_eq!(file_name("{artist} - {title} [{bpm} BPM]", &meta(), None, None), "deadmau5 - Strobe.mp3");
        assert_eq!(file_name("{bpm} - {artist} - {title}", &meta(), None, None), "deadmau5 - Strobe.mp3");
        assert_eq!(file_name("{album}", &meta(), None, None), "deadmau5 - Strobe.mp3");
    }

    #[test]
    fn folders() {
        assert_eq!(sort_folder("bpm", &meta(), Some(127.6), None), PathBuf::from("125-129 BPM"));
        assert_eq!(sort_folder("genre_bpm", &meta(), None, None), PathBuf::from("Dance").join("BPM inconnu"));
        assert_eq!(sort_folder("genre", &Meta::default(), None, None), PathBuf::from("Genre inconnu"));
        assert_eq!(sort_folder("none", &meta(), Some(120.0), None), PathBuf::new());
        assert_eq!(sort_folder("key_bpm", &meta(), Some(124.0), Some("8A")), PathBuf::from("8A").join("120-124 BPM"));
    }

    #[test]
    fn network_errors() {
        assert!(is_network_error("Unable to download webpage: <urlopen error [Errno 11001] getaddrinfo failed>"));
        assert!(is_network_error("Read timed out"));
        assert!(!is_network_error("Contenu privé."));
    }
}

#[cfg(all(test, feature = "e2e"))]
mod e2e {
    use super::*;

    #[test]
    fn pipeline() {
        let url = std::env::var("TF_E2E_URL").expect("TF_E2E_URL");
        let out = std::env::temp_dir().join("tf-e2e");
        let _ = std::fs::remove_dir_all(&out);
        let app = tauri::test::mock_builder()
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .unwrap();
        let s = Settings {
            output_dir: out.display().to_string(),
            filename_template: "{artist} - {title} [{bpm} BPM]".into(),
            sort_by: "bpm".into(),
            ..Default::default()
        };
        app.manage(AppState::new(s));
        let h = app.handle().clone();
        let src = sources::detect(&url);
        app.manage(crate::history::History::default());
        let id = enqueue(&h, src, url, Meta::default(), None, None).id;
        pump(&h);
        let job = loop {
            std::thread::sleep(std::time::Duration::from_millis(300));
            let j = alive(&h, id).unwrap();
            if matches!(j.status, Status::Done | Status::Error) {
                break j;
            }
        };
        println!("{job:#?}");
        assert_eq!(job.status, Status::Done);
        let path = PathBuf::from(job.path.unwrap());
        let tag = id3::Tag::read_from_path(&path).unwrap();
        use id3::TagLike;
        println!("{} TBPM={:?} title={:?} artist={:?}", path.display(), tag.get("TBPM").and_then(|f| f.content().text()), tag.title(), tag.artist());
        assert!(tag.get("TBPM").is_some());
    }
}
