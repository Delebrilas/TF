mod artwork;
mod backup;
mod bpm;
mod clipboard;
mod desk;
mod diag;
mod flexport;
mod dj;
mod ext;
mod history;
mod jobs;
mod key;
mod library;
mod online;
mod settings;
mod sources;
mod spotify;
mod tags;
mod tools;
mod watch;
#[cfg(test)]
mod net_tests;

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

#[derive(Serialize)]
struct AddResult {
    added: usize,
    skipped: usize,
    skipped_titles: Vec<String>,
}

#[tauri::command]
async fn add_url(app: AppHandle, url: String, force: Option<bool>) -> CmdResult<AddResult> {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("Lien vide".into());
    }
    let resolved = if sources::detect(&url) == Source::Spotify {
        // Pas besoin de yt-dlp pour lire les métadonnées Spotify.
        let dummy = tools::Tools::none();
        sources::resolve(&dummy, &url).await
    } else {
        let t = tools::locate(&app).ok_or("yt-dlp n'est pas installé")?;
        sources::resolve(&t, &url).await
    }
    .map_err(|e| jobs::friendly(&e.to_string()))?;
    let (output_dir, skip) = {
        let st = app.state::<AppState>();
        let s = st.settings.lock().unwrap();
        (s.output_dir.clone(), s.skip_existing && !force.unwrap_or(false))
    };
    let (fresh, skipped) = if skip {
        let a = app.clone();
        let tracks = resolved.tracks;
        let in_queue = jobs::queued_identities(&app);
        tauri::async_runtime::spawn_blocking(move || history::split_new(&a, &output_dir, tracks, &in_queue))
            .await
            .map_err(err)?
    } else {
        (resolved.tracks, vec![])
    };
    let added = fresh.len();
    for r in fresh {
        let sk = history::source_key(r.source, &r.key);
        jobs::enqueue(&app, r.source, r.url, r.meta, None, sk);
    }
    jobs::pump(&app);
    Ok(AddResult { added, skipped: skipped.len(), skipped_titles: skipped.into_iter().take(5).collect() })
}

#[tauri::command]
async fn search(app: AppHandle, query: String) -> CmdResult<Vec<sources::SearchResult>> {
    let t = tools::locate(&app).ok_or("yt-dlp n'est pas installé")?;
    Ok(sources::search(&t, query.trim()).await)
}

/// Fusion d'artistes : réécrit l'artiste des fichiers donnés.
#[tauri::command]
async fn rename_artist(paths: Vec<String>, artist: String) -> CmdResult<usize> {
    let artist = artist.trim().to_string();
    if artist.is_empty() {
        return Err("Nom d'artiste vide".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut n = 0;
        for p in paths {
            if tags::set_artist(std::path::Path::new(&p), &artist).is_ok() {
                n += 1;
            }
        }
        n
    })
    .await
    .map_err(err)
}

/// Ajout depuis l'icône de la zone de notification.
pub(crate) async fn queue_url(app: &AppHandle, url: String) -> CmdResult<usize> {
    add_url(app.clone(), url, None).await.map(|r| r.added)
}

pub(crate) fn queue_files(app: &AppHandle, paths: Vec<String>) -> usize {
    add_files(app.clone(), paths)
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
        jobs::enqueue(&app, Source::Local, String::new(), Meta { title: name, ..Default::default() }, Some(p), None);
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
    jobs::enqueue(&app, Source::Local, String::new(), meta, Some(dest.display().to_string()), None);
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
fn spotify_status() -> spotify::Status {
    spotify::status()
}

#[tauri::command]
async fn spotify_login(app: AppHandle, st: State<'_, AppState>) -> CmdResult<spotify::Status> {
    let id = st.settings.lock().unwrap().spotify_client_id.clone();
    spotify::login(&id, |url| {
        use tauri_plugin_opener::OpenerExt;
        app.opener().open_url(url, None::<&str>).map_err(|e| anyhow::anyhow!(e.to_string()))
    })
    .await
    .map_err(err)
}

#[tauri::command]
fn spotify_logout() {
    spotify::logout();
}

#[tauri::command]
async fn spotify_playlists() -> CmdResult<Vec<spotify::Playlist>> {
    spotify::playlists().await.map_err(err)
}

/// Vide toute la file : annule les téléchargements en cours et retire tout.
#[tauri::command]
fn clear_all(app: AppHandle, st: State<AppState>) -> usize {
    let ids: Vec<u64> = std::mem::take(&mut *st.jobs.lock().unwrap()).into_iter().map(|j| j.id).collect();
    for &id in &ids {
        jobs::cancel(&app, id);
        let _ = app.emit("job-removed", id);
    }
    jobs::persist(&app);
    ids.len()
}

#[tauri::command]
async fn library_scan(st: State<'_, AppState>, hist: State<'_, history::History>) -> CmdResult<Vec<library::LibTrack>> {
    let roots = library_roots(&st.settings.lock().unwrap());
    let sources = hist
        .0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|(k, p)| Some((p.clone(), history::key_url(k)?)))
        .collect();
    tauri::async_runtime::spawn_blocking(move || library::scan(&roots, &sources)).await.map_err(err)
}

/// Grille de battements, intro/outro et points de mix (en cache).
#[tauri::command]
async fn beat_grid(dj: State<'_, dj::Dj>, path: String, bpm: Option<f64>) -> CmdResult<bpm::Grid> {
    if let Some(g) = dj.cached_grid(&path) {
        return Ok(g);
    }
    let p = path.clone();
    let g = tauri::async_runtime::spawn_blocking(move || {
        let g = bpm::grid(std::path::Path::new(&p), bpm)?;
        // Énergie écrite dans le fichier (avant la mise en cache : le fichier change).
        let _ = tags::set_energy(std::path::Path::new(&p), g.energy);
        anyhow::Ok(g)
    })
    .await
    .map_err(err)?
    .map_err(err)?;
    dj.store_grid(&path, &g);
    Ok(g)
}

/// Export FL Studio de l'itinéraire du GPS : renvoie le dossier créé.
#[tauri::command]
async fn gps_export_fl(app: AppHandle, paths: Vec<String>, bars: Option<u32>) -> CmdResult<String> {
    let tools = tools::require(&app).map_err(err)?;
    let out_dir = app.state::<AppState>().settings.lock().unwrap().output_dir.clone();
    let mut tracks = Vec::new();
    for p in paths {
        let cached = app.state::<dj::Dj>().cached_grid(&p);
        let g = match cached {
            Some(g) => g,
            None => {
                let q = p.clone();
                let g = tauri::async_runtime::spawn_blocking(move || bpm::grid(std::path::Path::new(&q), None))
                    .await
                    .map_err(err)?
                    .map_err(|e| format!("{p} : {e}"))?;
                app.state::<dj::Dj>().store_grid(&p, &g);
                g
            }
        };
        tracks.push((p, g));
    }
    let a = app.clone();
    let dir = flexport::export(&tools, std::path::Path::new(&out_dir), tracks, bars, move |i, n| {
        let _ = a.emit("fl-export", (i, n));
    })
    .await
    .map_err(err)?;
    Ok(dir.to_string_lossy().into_owned())
}

/// Grilles déjà calculées (pour afficher les intros DJ dans la bibliothèque).
#[tauri::command]
fn cached_grids(dj: State<dj::Dj>, paths: Vec<String>) -> std::collections::HashMap<String, bpm::Grid> {
    paths.into_iter().filter_map(|p| dj.cached_grid(&p).map(|g| (p, g))).collect()
}

#[tauri::command]
fn notes_get(dj: State<dj::Dj>) -> std::collections::HashMap<String, String> {
    dj.notes()
}

#[tauri::command]
fn note_set(dj: State<dj::Dj>, path: String, text: String) {
    dj.set_note(&path, &text);
}

#[tauri::command]
fn pairs_get(dj: State<dj::Dj>) -> Vec<dj::Pair> {
    dj.pairs()
}

#[tauri::command]
fn pair_add(dj: State<dj::Dj>, a: String, b: String, note: Option<String>) -> Vec<dj::Pair> {
    dj.add_pair(&a, &b, note.as_deref().unwrap_or(""))
}

#[tauri::command]
fn pair_remove(dj: State<dj::Dj>, a: String, b: String) -> Vec<dj::Pair> {
    dj.remove_pair(&a, &b)
}

#[tauri::command]
fn ext_tracks(ext: State<ext::Ext>) -> Vec<ext::ExtTrack> {
    ext.list()
}

#[derive(Serialize)]
struct Diagnosis {
    checks: Vec<diag::Check>,
    report: String,
}

/// « Tester mes sources » (Réglages).
#[tauri::command]
async fn diagnose(app: AppHandle) -> Diagnosis {
    let checks = diag::run(&app).await;
    let report = diag::report(&app, &checks);
    Diagnosis { checks, report }
}

#[tauri::command]
async fn backup_export(app: AppHandle, path: String, ui: serde_json::Value) -> CmdResult<usize> {
    backup::export(&app, std::path::Path::new(&path), ui).map_err(err)
}

/// Remet la sauvegarde en place ; l'interface enregistre ses options puis appelle `app_restart`.
#[tauri::command]
async fn backup_import(app: AppHandle, path: String) -> CmdResult<serde_json::Value> {
    backup::import(&app, std::path::Path::new(&path)).map_err(err)
}

#[tauri::command]
fn app_restart(app: AppHandle) {
    app.restart();
}

#[derive(Serialize)]
struct UpdateInfo {
    current: String,
    version: Option<String>,
    notes: Option<String>,
}

/// Nouvelle version publiée sur GitHub ?
#[tauri::command]
async fn update_check(app: AppHandle) -> CmdResult<UpdateInfo> {
    use tauri_plugin_updater::UpdaterExt;
    let current = app.package_info().version.to_string();
    let up = app.updater().map_err(err)?.check().await.map_err(|e| format!("Vérification impossible : {e}"))?;
    Ok(UpdateInfo { current, version: up.as_ref().map(|u| u.version.clone()), notes: up.and_then(|u| u.body) })
}

/// Télécharge la nouvelle version (signée), l'installe puis relance l'app.
#[tauri::command]
async fn update_install(app: AppHandle) -> CmdResult<()> {
    use tauri_plugin_updater::UpdaterExt;
    let up = app.updater().map_err(err)?.check().await.map_err(err)?.ok_or("Déjà à jour")?;
    let a = app.clone();
    let mut got = 0usize;
    up.download_and_install(
        move |chunk, total| {
            got += chunk;
            if let Some(t) = total {
                let _ = a.emit("update-progress", (got as f64 / t as f64 * 100.0).round());
            }
        },
        || {},
    )
    .await
    .map_err(|e| format!("Mise à jour impossible : {e}"))?;
    app.restart();
}

/// Titres likés Spotify et likes SoundCloud (fenêtre « Mes likes »).
#[tauri::command]
async fn likes_fetch(app: AppHandle) -> CmdResult<ext::Likes> {
    ext::likes(&app).await
}

#[tauri::command]
async fn my_playlists(app: AppHandle) -> CmdResult<ext::Listing<ext::MyPlaylist>> {
    ext::playlists(&app).await
}

#[tauri::command]
async fn playlist_tracks(app: AppHandle, url: String, name: String) -> CmdResult<Vec<ext::ExtTrack>> {
    ext::playlist_tracks(&app, &url, &name).await
}

/// Aperçu audio d'un titre pas encore téléchargé (MP3 de ~30 s).
#[tauri::command]
async fn like_preview(app: AppHandle, track: ext::ExtTrack) -> CmdResult<tauri::ipc::Response> {
    ext::preview(&app, &track).await.map(tauri::ipc::Response::new)
}

/// Télécharge les likes choisis, un par un (les déjà présents sont ignorés, sauf `force`).
#[tauri::command]
async fn likes_download(app: AppHandle, tracks: Vec<ext::ExtTrack>, force: Option<bool>) -> CmdResult<AddResult> {
    let reqs: Vec<_> = tracks.iter().map(|t| t.request()).collect();
    let (output_dir, skip) = {
        let st = app.state::<AppState>();
        let s = st.settings.lock().unwrap();
        (s.output_dir.clone(), s.skip_existing && !force.unwrap_or(false))
    };
    let (fresh, skipped) = if skip {
        let a = app.clone();
        let in_queue = jobs::queued_identities(&app);
        tauri::async_runtime::spawn_blocking(move || history::split_new(&a, &output_dir, reqs, &in_queue)).await.map_err(err)?
    } else {
        (reqs, vec![])
    };
    let added = fresh.len();
    for r in fresh {
        let sk = history::source_key(r.source, &r.key);
        jobs::enqueue(&app, r.source, r.url, r.meta, None, sk);
    }
    jobs::pump(&app);
    Ok(AddResult { added, skipped: skipped.len(), skipped_titles: skipped.into_iter().take(5).collect() })
}

/// Relit likes et playlists, puis cherche BPM et tonalité (en arrière-plan).
#[tauri::command]
fn ext_refresh(app: AppHandle) -> bool {
    ext::refresh(app)
}

#[tauri::command]
async fn export_csv(path: String, rows: Vec<Vec<String>>) -> CmdResult<usize> {
    tauri::async_runtime::spawn_blocking(move || dj::write_csv(std::path::Path::new(&path), &rows))
        .await
        .map_err(err)?
        .map_err(err)
}

/// Envoie des MP3 à la corbeille (récupérables depuis Windows).
#[tauri::command]
async fn trash_files(app: AppHandle, paths: Vec<String>) -> CmdResult<Vec<String>> {
    let mp3: Vec<String> = paths
        .into_iter()
        .filter(|p| std::path::Path::new(p).extension().is_some_and(|e| e.eq_ignore_ascii_case("mp3")))
        .collect();
    let list = mp3.clone();
    let done = tauri::async_runtime::spawn_blocking(move || {
        list.iter()
            .filter(|p| trash::delete(p).is_ok() && !std::path::Path::new(p).exists())
            .cloned()
            .collect::<Vec<_>>()
    })
    .await
    .map_err(err)?;
    history::forget_paths(&app, &done);
    app.state::<dj::Dj>().forget_paths(&done);
    if done.is_empty() && !mp3.is_empty() {
        return Err("Impossible de mettre ces fichiers à la corbeille".into());
    }
    Ok(done)
}

/// Relance toutes les pistes en échec.
#[tauri::command]
fn retry_failed(app: AppHandle, st: State<AppState>) -> usize {
    let ids: Vec<u64> = st.jobs.lock().unwrap().iter().filter(|j| j.status == Status::Error).map(|j| j.id).collect();
    for &id in &ids {
        jobs::retry(&app, id);
    }
    ids.len()
}

/// Retire plusieurs pistes de la file (annule celles en cours).
#[tauri::command]
fn remove_jobs(app: AppHandle, st: State<AppState>, ids: Vec<u64>) {
    st.jobs.lock().unwrap().retain(|j| !ids.contains(&j.id));
    for &id in &ids {
        jobs::cancel(&app, id);
        let _ = app.emit("job-removed", id);
    }
    jobs::persist(&app);
    jobs::pump(&app);
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_drag::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| desk::show_window(app)))
        .setup(|app| {
            let handle = app.handle().clone();
            let s = settings::load(&handle);
            let _ = std::fs::create_dir_all(&s.output_dir);
            allow_dir(&handle, &s.output_dir);
            for f in &s.library_folders {
                allow_dir(&handle, f);
            }
            app.manage(AppState::new(s));
            if let Ok(d) = handle.path().app_data_dir() {
                spotify::init(d.join("spotify.json"));
            }
            let data_dir = handle.path().app_data_dir().unwrap_or_else(|_| std::env::temp_dir().join("TrackFetcher"));
            app.manage(dj::Dj::load(data_dir.join("dj")));
            app.manage(ext::Ext::load(data_dir.join("dj")));
            app.manage(history::History(std::sync::Mutex::new(history::load(&handle))));
            app.manage(watch::WatchState(std::sync::Mutex::new(watch::load(&handle))));
            jobs::restore(&handle);
            jobs::pump(&handle);
            watch::start_timer(handle.clone());
            clipboard::start(handle.clone());
            tools::start_maintenance(handle.clone());
            if let Err(e) = desk::setup(&handle) {
                eprintln!("zone de notification indisponible : {e}");
            }
            Ok(())
        })
        .on_window_event(|w, ev| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                let app = w.app_handle();
                let to_tray = app.state::<AppState>().settings.lock().unwrap().close_to_tray;
                if to_tray && app.tray_by_id("main").is_some() {
                    api.prevent_close();
                    let _ = w.hide();
                    desk::hint_tray_once(app);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            install_tools,
            add_url,
            add_files,
            search,
            rename_artist,
            remove_job,
            clear_finished,
            clear_all,
            spotify_status,
            spotify_login,
            spotify_logout,
            spotify_playlists,
            trash_files,
            retry_failed,
            remove_jobs,
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
            save_settings,
            beat_grid,
            gps_export_fl,
            cached_grids,
            notes_get,
            note_set,
            pairs_get,
            pair_add,
            pair_remove,
            export_csv,
            ext_tracks,
            likes_fetch,
            likes_download,
            my_playlists,
            playlist_tracks,
            like_preview,
            update_check,
            update_install,
            backup_export,
            backup_import,
            app_restart,
            diagnose,
            ext_refresh
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de TrackFetcher");
}
