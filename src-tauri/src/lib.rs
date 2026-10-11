mod bpm;
mod jobs;
mod library;
mod online;
mod settings;
mod sources;
mod tags;
mod tools;
mod watch;

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
    watched: Vec<watch::WatchedView>,
}

#[tauri::command]
fn get_state(app: AppHandle, st: State<AppState>) -> Snapshot {
    Snapshot {
        jobs: st.jobs.lock().unwrap().clone(),
        settings: st.settings.lock().unwrap().clone(),
        tools: tools::status(&app),
        watched: watch::views(&app),
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
    let resolved = if sources::detect(&url) == Source::Spotify {
        // Pas besoin de yt-dlp pour lire les métadonnées Spotify.
        let dummy = tools::Tools { ytdlp: Default::default(), ffmpeg_dir: None };
        sources::resolve(&dummy, &url).await
    } else {
        let t = tools::locate(&app).ok_or("yt-dlp n'est pas installé")?;
        sources::resolve(&t, &url).await
    }
    .map_err(err)?;
    let n = resolved.tracks.len();
    for r in resolved.tracks {
        jobs::enqueue(&app, r.source, r.url, r.meta, None);
    }
    jobs::pump(&app);
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
    jobs::pump(&app);
    n
}

/// MP3 glissé dans la fenêtre : le navigateur n'en donne que le contenu,
/// on l'enregistre dans le dossier de sortie avant de l'analyser.
#[tauri::command]
fn import_file(app: AppHandle, st: State<AppState>, request: tauri::ipc::Request) -> CmdResult<()> {
    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("Contenu de fichier attendu".into());
    };
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .map(|v| urlencoding::decode(v).map(|c| c.into_owned()).unwrap_or_default())
        .unwrap_or_default();
    let name = jobs::sanitize(name.trim_end_matches(".mp3").trim_end_matches(".MP3"));
    let name = if name.is_empty() { "Import".to_string() } else { name };
    let dir = std::path::PathBuf::from(&st.settings.lock().unwrap().output_dir);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let mut dest = dir.join(format!("{name}.mp3"));
    let mut i = 2;
    while dest.exists() {
        dest = dir.join(format!("{name} ({i}).mp3"));
        i += 1;
    }
    std::fs::write(&dest, bytes).map_err(err)?;
    let meta = Meta { title: Some(name), ..Default::default() };
    jobs::enqueue(&app, Source::Local, String::new(), meta, Some(dest.display().to_string()));
    jobs::pump(&app);
    Ok(())
}

#[tauri::command]
fn remove_job(app: AppHandle, st: State<AppState>, id: u64) {
    st.jobs.lock().unwrap().retain(|j| j.id != id);
    jobs::cancel(&app, id);
    let _ = app.emit("job-removed", id);
    jobs::pump(&app);
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
    jobs::persist(&app);
}

#[tauri::command]
async fn library_scan(st: State<'_, AppState>) -> CmdResult<Vec<library::LibTrack>> {
    let roots = library_roots(&st.settings.lock().unwrap());
    tauri::async_runtime::spawn_blocking(move || library::scan(&roots)).await.map_err(err)
}

fn library_roots(s: &settings::Settings) -> Vec<(String, std::path::PathBuf)> {
    let mut roots = vec![("TrackFetcher".to_string(), std::path::PathBuf::from(&s.output_dir))];
    for f in &s.library_folders {
        let p = std::path::PathBuf::from(f);
        let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| f.clone());
        roots.push((name, p));
    }
    roots
}

#[tauri::command]
async fn cover_art(path: String) -> CmdResult<tauri::ipc::Response> {
    let data = tauri::async_runtime::spawn_blocking(move || library::cover(std::path::Path::new(&path)))
        .await
        .map_err(err)?
        .ok_or("Pas de pochette")?;
    Ok(tauri::ipc::Response::new(data))
}

/// Contenu d'un MP3 pour le lecteur (lu en blob : lecture, avance rapide et
/// visualiseur fonctionnent pareil sur tous les moteurs web).
#[tauri::command]
async fn audio_bytes(path: String) -> CmdResult<tauri::ipc::Response> {
    let p = std::path::PathBuf::from(&path);
    if !p.extension().is_some_and(|e| e.eq_ignore_ascii_case("mp3")) {
        return Err("Seuls les MP3 sont lisibles".into());
    }
    let data = tokio::fs::read(&p).await.map_err(err)?;
    Ok(tauri::ipc::Response::new(data))
}

/// Autorise la lecture des fichiers du dossier de sortie par le lecteur.
fn allow_dir(app: &AppHandle, dir: &str) {
    let _ = app.asset_protocol_scope().allow_directory(dir, true);
}

#[tauri::command]
fn retry_job(app: AppHandle, id: u64) {
    jobs::retry(&app, id);
}

#[tauri::command]
fn toggle_priority(app: AppHandle, id: u64) {
    jobs::toggle_priority(&app, id);
}

#[tauri::command]
async fn watch_add(app: AppHandle, url: String, download_existing: bool) -> CmdResult<usize> {
    watch::add(&app, url, download_existing).await.map_err(err)
}

#[tauri::command]
fn watch_remove(app: AppHandle, id: u64) {
    watch::remove(&app, id);
}

#[tauri::command]
async fn watch_check(app: AppHandle, id: Option<u64>) -> CmdResult<usize> {
    match id {
        Some(id) => watch::check(&app, id).await.map_err(err),
        None => Ok(watch::check_all(&app).await),
    }
}

#[tauri::command]
fn set_bpm(app: AppHandle, id: u64, bpm: f64) -> CmdResult<Job> {
    if !(30.0..=300.0).contains(&bpm) {
        return Err("BPM hors limites".into());
    }
    jobs::set_bpm(&app, id, bpm).map_err(err)
}

#[tauri::command]
fn apply_bpm(app: AppHandle, id: u64) -> CmdResult<Job> {
    jobs::apply_bpm(&app, id).map_err(err)
}

#[tauri::command]
fn save_settings(app: AppHandle, st: State<AppState>, settings: settings::Settings) -> CmdResult<settings::Settings> {
    settings::save(&app, &settings).map_err(err)?;
    let _ = st;
    let s = jobs::reload_settings(&app);
    let _ = std::fs::create_dir_all(&s.output_dir);
    allow_dir(&app, &s.output_dir);
    for f in &s.library_folders {
        allow_dir(&app, f);
    }
    jobs::pump(&app);
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
            allow_dir(&handle, &s.output_dir);
            for f in &s.library_folders {
                allow_dir(&handle, f);
            }
            app.manage(AppState::new(s));
            app.manage(watch::WatchState(std::sync::Mutex::new(watch::load(&handle))));
            jobs::restore(&handle);
            jobs::pump(&handle);
            watch::start_timer(handle.clone());
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
            library_scan,
            cover_art,
            audio_bytes,
            toggle_priority,
            import_file,
            watch_add,
            watch_remove,
            watch_check,
            set_bpm,
            apply_bpm,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de TrackFetcher");
}
