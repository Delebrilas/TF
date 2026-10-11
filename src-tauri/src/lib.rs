mod bpm;
mod jobs;
mod online;
mod settings;
mod sources;
mod tags;
mod tools;

use jobs::{AppState, Job, Status};
use serde::Serialize;
use sources::{Meta, Source};
use tauri::{AppHandle, Emitter, Manager, State};

type CmdResult<T> = Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

#[derive(Serialize)]
struct Snapshot {
    jobs: Vec<Job>,
    settings: settings::Settings,
    tools: tools::ToolsStatus,
}

#[tauri::command]
fn get_state(app: AppHandle, st: State<AppState>) -> Snapshot {
    Snapshot {
        jobs: st.jobs.lock().unwrap().clone(),
        settings: st.settings.lock().unwrap().clone(),
        tools: tools::status(&app),
    }
}

#[tauri::command]
async fn install_tools(app: AppHandle) -> CmdResult<tools::ToolsStatus> {
    tools::install(&app).await.map_err(|e| format!("{e:#}"))
}

#[tauri::command]
async fn add_url(app: AppHandle, url: String) -> CmdResult<usize> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Lien vide".into());
    }
    let requests = if sources::detect(&url) == Source::Spotify {
        // Pas besoin de yt-dlp pour lire les métadonnées Spotify.
        let dummy = tools::Tools { ytdlp: Default::default(), ffmpeg_dir: None };
        sources::resolve(&dummy, &url).await
    } else {
        let t = tools::locate(&app).ok_or("yt-dlp n'est pas installé")?;
        sources::resolve(&t, &url).await
    }
    .map_err(err)?;
    let n = requests.len();
    for r in requests {
        jobs::enqueue(&app, r.source, r.url, r.meta, None);
    }
    Ok(n)
}

#[tauri::command]
fn add_files(app: AppHandle, paths: Vec<String>) -> usize {
    let mut n = 0;
    for p in paths {
        let path = std::path::Path::new(&p);
        if path.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("mp3")) != Some(true) {
            continue;
        }
        let name = path.file_stem().and_then(|s| s.to_str()).map(String::from);
        jobs::enqueue(&app, Source::Local, String::new(), Meta { title: name, ..Default::default() }, Some(p));
        n += 1;
    }
    n
}

#[tauri::command]
fn remove_job(app: AppHandle, st: State<AppState>, id: u64) {
    st.jobs.lock().unwrap().retain(|j| j.id != id);
    jobs::cancel(&app, id);
    let _ = app.emit("job-removed", id);
}

#[tauri::command]
fn clear_finished(app: AppHandle, st: State<AppState>) {
    let removed: Vec<u64> = {
        let mut list = st.jobs.lock().unwrap();
        let ids = list.iter().filter(|j| j.status == Status::Done).map(|j| j.id).collect();
        list.retain(|j| j.status != Status::Done);
        ids
    };
    for id in removed {
        let _ = app.emit("job-removed", id);
    }
}

#[tauri::command]
fn retry_job(app: AppHandle, st: State<AppState>, id: u64) {
    let job = {
        let mut list = st.jobs.lock().unwrap();
        let Some(j) = list.iter_mut().find(|j| j.id == id && j.status == Status::Error) else { return };
        j.status = Status::Queued;
        j.error = None;
        j.progress = 0.0;
        j.clone()
    };
    let _ = app.emit("job", &job);
    jobs::start(&app, id);
}

#[tauri::command]
fn set_bpm(app: AppHandle, id: u64, bpm: f64) -> CmdResult<Job> {
    if !(30.0..=300.0).contains(&bpm) {
        return Err("BPM hors limites".into());
    }
    jobs::set_bpm(&app, id, bpm).map_err(err)
}

#[tauri::command]
fn save_settings(app: AppHandle, st: State<AppState>, settings: settings::Settings) -> CmdResult<settings::Settings> {
    settings::save(&app, &settings).map_err(err)?;
    let s = jobs::reload_settings(&app);
    st.set_parallel(s.parallel);
    let _ = std::fs::create_dir_all(&s.output_dir);
    Ok(s)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let handle = app.handle().clone();
            let s = settings::load(&handle);
            let _ = std::fs::create_dir_all(&s.output_dir);
            app.manage(AppState::new(s));
            tauri::async_runtime::spawn(async move { tools::self_update(&handle).await });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            install_tools,
            add_url,
            add_files,
            remove_job,
            clear_finished,
            retry_job,
            set_bpm,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de TrackFetcher");
}
