//! File d'attente : téléchargement → analyse → vérification → tags → rangement.

use crate::{
    bpm,
    online::{self, BpmResult, SourceBpm, Verdict},
    settings::{self, Settings},
    sources::{self, Meta, Source},
    tags::{self, TagData},
    tools::{self, Tools},
};
use anyhow::{anyhow, Result};
use serde::Serialize;
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    sync::{Notify, Semaphore},
};

#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
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

#[derive(Debug, Clone, Serialize)]
pub struct Job {
    pub id: u64,
    pub source: Source,
    pub url: String,
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub cover: Option<String>,
    pub duration: Option<f64>,
    pub status: Status,
    pub progress: f64,
    pub path: Option<String>,
    pub bpm: Option<BpmResult>,
    pub error: Option<String>,
}

pub struct AppState {
    pub jobs: Mutex<Vec<Job>>,
    pub settings: Mutex<Settings>,
    cancels: Mutex<HashMap<u64, Arc<Notify>>>,
    semaphore: Arc<Semaphore>,
    permits: Mutex<usize>,
    next_id: AtomicU64,
}

impl AppState {
    pub fn new(settings: Settings) -> Self {
        let n = settings.parallel;
        Self {
            jobs: Mutex::new(Vec::new()),
            settings: Mutex::new(settings),
            cancels: Mutex::new(HashMap::new()),
            semaphore: Arc::new(Semaphore::new(n)),
            permits: Mutex::new(n),
            next_id: AtomicU64::new(1),
        }
    }

    /// Ajuste le nombre de traitements simultanés.
    pub fn set_parallel(&self, n: usize) {
        let mut cur = self.permits.lock().unwrap();
        if n > *cur {
            self.semaphore.add_permits(n - *cur);
        } else if n < *cur {
            let sem = self.semaphore.clone();
            let diff = (*cur - n) as u32;
            tauri::async_runtime::spawn(async move {
                if let Ok(p) = sem.acquire_many(diff).await {
                    p.forget();
                }
            });
        }
        *cur = n;
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

pub fn enqueue<R: tauri::Runtime>(app: &AppHandle<R>, source: Source, url: String, meta: Meta, path: Option<String>) -> Job {
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
        status: Status::Queued,
        progress: 0.0,
        path,
        bpm: None,
        error: None,
    };
    st.jobs.lock().unwrap().push(job.clone());
    emit(app, &job);
    start(app, id);
    job
}

pub fn start<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) {
    let app = app.clone();
    let cancel = Arc::new(Notify::new());
    state(&app).cancels.lock().unwrap().insert(id, cancel.clone());
    tauri::async_runtime::spawn(async move {
        let sem = state(&app).semaphore.clone();
        let Ok(_permit) = sem.acquire_owned().await else { return };
        if alive(&app, id).is_err() {
            return;
        }
        if let Err(e) = run(&app, id, cancel).await {
            let msg = e.to_string();
            if msg != "annulé" {
                update(&app, id, |j| {
                    j.status = Status::Error;
                    j.error = Some(msg);
                });
            }
        }
        state(&app).cancels.lock().unwrap().remove(&id);
    });
}

pub fn cancel<R: tauri::Runtime>(app: &AppHandle<R>, id: u64) {
    if let Some(n) = state(app).cancels.lock().unwrap().get(&id) {
        n.notify_one();
    }
}

fn set_status<R: tauri::Runtime>(app: &AppHandle<R>, id: u64, s: Status) -> Result<Job> {
    update(app, id, |j| {
        j.status = s;
        j.progress = 0.0;
    })
    .ok_or_else(|| anyhow!("annulé"))
}

async fn run<R: tauri::Runtime>(app: &AppHandle<R>, id: u64, cancel: Arc<Notify>) -> Result<()> {
    let job = alive(app, id)?;
    let settings = state(app).settings.lock().unwrap().clone();

    // 1. Fichier audio (téléchargé, ou fichier local existant)
    let (file, info) = if job.source == Source::Local {
        (PathBuf::from(job.path.clone().unwrap_or_default()), None)
    } else {
        let tools = tools::require(app)?;
        let mut url = job.url.clone();
        if job.source == Source::Spotify {
            set_status(app, id, Status::Searching)?;
            let meta = Meta {
                title: job.title.clone(),
                artist: job.artist.clone(),
                duration: job.duration,
                ..Default::default()
            };
            url = sources::find_on_youtube(&tools, &meta).await?;
        }
        set_status(app, id, Status::Downloading)?;
        let (file, info) = download(app, id, &tools, &url, &settings, cancel).await?;
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
    };
    if let Some(info) = &info {
        let m = sources::meta_from_info(info);
        if job.source != Source::Spotify {
            meta.title = m.title.or(meta.title);
            meta.artist = m.artist.or(meta.artist);
        }
        meta.album = meta.album.or(m.album);
        meta.duration = meta.duration.or(m.duration);
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
    let local = tokio::task::spawn_blocking(move || bpm::analyze_file(&f)).await?;
    let local = local.ok().map(|a| (a.bpm, a.confidence));

    // 4. Vérification en ligne
    let mut found: Vec<SourceBpm> = Vec::new();
    let mut deezer_cover = None;
    if settings.verify_online {
        set_status(app, id, Status::Verifying)?;
        let artist = meta.artist.clone().unwrap_or_default();
        let title = meta.title.clone().unwrap_or_default();
        if !title.is_empty() {
            let (dz, gs) = tokio::join!(
                online::deezer(&artist, &title, meta.duration),
                online::getsongbpm(&settings.getsongbpm_key, &artist, &title)
            );
            if let Some(dz) = dz {
                if let Some(b) = dz.bpm {
                    found.push(SourceBpm { source: "Deezer".into(), bpm: b });
                }
                meta.album = meta.album.or(dz.album);
                deezer_cover = dz.cover;
            }
            if let Some(b) = gs {
                found.push(SourceBpm { source: "GetSongBPM".into(), bpm: b });
            }
        }
        if let Some(info) = &info {
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
    let cover_url = match job.source {
        Source::Spotify => meta.cover.clone().or(deezer_cover),
        Source::Youtube => deezer_cover,
        _ => None,
    };
    let cover = match cover_url {
        Some(u) => fetch_bytes(&u).await,
        None => None,
    };
    let is_local = job.source == Source::Local;
    let detail = result.as_ref().map(describe);
    let data = TagData {
        title: if is_local { None } else { meta.title.clone() },
        artist: if is_local { None } else { meta.artist.clone() },
        album: if is_local { None } else { meta.album.clone() },
        bpm: result.as_ref().map(|r| r.bpm),
        bpm_detail: detail,
        cover,
    };
    let f = file.clone();
    tokio::task::spawn_blocking(move || tags::write(&f, &data)).await??;

    // 6. Rangement
    let final_path = if is_local {
        file
    } else {
        let name = file_name(&meta, result.as_ref().map(|r| r.bpm).filter(|_| settings.bpm_in_filename));
        let dest = unique(&PathBuf::from(&settings.output_dir).join(name));
        move_file(&file, &dest).await?;
        if let Some(tmp) = file.parent() {
            let _ = tokio::fs::remove_dir(tmp).await; // seulement s'il est vide
        }
        dest
    };

    update(app, id, |j| {
        j.status = Status::Done;
        j.progress = 1.0;
        j.path = Some(final_path.display().to_string());
        j.album = meta.album.clone();
        j.bpm = result;
    });
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
    let template = tmp.join(format!("{id}-%(id)s.%(ext)s"));
    let quality = match settings.quality.as_str() {
        "v0" => "0",
        "192" => "192K",
        _ => "320K",
    };
    let mut cmd = tools::command(&tools.ytdlp);
    cmd.arg(url)
        .args(["-f", "bestaudio/best", "-x", "--audio-format", "mp3", "--audio-quality", quality])
        .args(["--embed-metadata", "--embed-thumbnail", "--convert-thumbnails", "jpg"])
        // Pochette recadrée au carré.
        .args([
            "--ppa",
            r#"ThumbnailsConvertor+FFmpeg_o:-c:v mjpeg -vf crop="'if(gt(ih,iw),iw,ih)':'if(gt(iw,ih),ih,iw)'""#,
        ])
        .args(["--no-playlist", "--newline", "--progress", "--no-mtime", "--encoding", "utf-8"])
        .args(["--progress-template", "download:TFPROG %(progress._percent_str)s"])
        .args(["-O", "after_move:%(.{filepath,title,track,artist,creator,uploader,channel,album,description,duration})j"])
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
        return Err(anyhow!(friendly(&sources::last_error(&err))));
    }
    let info = info.ok_or_else(|| anyhow!("Fichier téléchargé introuvable"))?;
    let path = PathBuf::from(info["filepath"].as_str().unwrap_or_default());
    if !path.is_file() {
        return Err(anyhow!("Fichier téléchargé introuvable"));
    }
    Ok((path, info))
}

fn friendly(err: &str) -> String {
    let e = err.to_lowercase();
    if e.contains("sign in to confirm") || e.contains("not a bot") {
        "YouTube demande une vérification anti-robot. Réessaie plus tard.".into()
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

pub fn sanitize(s: &str) -> String {
    let cleaned: String = s
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { ' ' } else { c })
        .collect();
    let cleaned = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let cleaned = cleaned.trim_matches(|c: char| c == '.' || c == ' ');
    cleaned.chars().take(150).collect()
}

fn file_name(meta: &Meta, bpm: Option<f64>) -> String {
    let title = meta.title.clone().unwrap_or_else(|| "Sans titre".into());
    let base = match &meta.artist {
        Some(a) if !a.is_empty() => format!("{a} - {title}"),
        _ => title,
    };
    let base = sanitize(&base);
    match bpm {
        Some(b) => format!("{base} ({} BPM).mp3", b.round()),
        None => format!("{base}.mp3"),
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
        &TagData { title: None, artist: None, album: None, bpm: Some(bpm), bpm_detail: None, cover: None },
    )?;
    update(app, id, |j| j.bpm = Some(result)).ok_or_else(|| anyhow!("annulé"))
}

pub fn reload_settings<R: tauri::Runtime>(app: &AppHandle<R>) -> Settings {
    let s = settings::load(app);
    *state(app).settings.lock().unwrap() = s.clone();
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names() {
        assert_eq!(sanitize("AC/DC: Back in Black?"), "AC DC Back in Black");
        let m = Meta { title: Some("Strobe".into()), artist: Some("deadmau5".into()), ..Default::default() };
        assert_eq!(file_name(&m, Some(127.9)), "deadmau5 - Strobe (128 BPM).mp3");
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
        let s = Settings { output_dir: out.display().to_string(), bpm_in_filename: true, ..Default::default() };
        app.manage(AppState::new(s));
        let h = app.handle().clone();
        let src = sources::detect(&url);
        let meta = Meta::default();
        let id = enqueue(&h, src, url, meta, None).id;
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
        println!("TBPM={:?} title={:?} artist={:?}", tag.get("TBPM").and_then(|f| f.content().text()), tag.title(), tag.artist());
        assert!(tag.get("TBPM").is_some());
    }
}
