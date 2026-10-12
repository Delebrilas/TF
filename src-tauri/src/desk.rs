//! Intégration Windows : icône de la zone de notification et notifications.

use crate::{jobs::{AppState, Job}, settings};
use tauri::{
    Listener,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime,
};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_notification::NotificationExt;

pub fn show_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn window_active<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.get_webview_window("main")
        .map(|w| w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false))
        .unwrap_or(false)
}

pub fn notify<R: Runtime>(app: &AppHandle<R>, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Morceau terminé : notification avec le BPM, si la fenêtre n'est pas au premier plan.
pub fn job_done<R: Runtime>(app: &AppHandle<R>, job: &Job) {
    if !app.state::<AppState>().settings.lock().unwrap().notify || window_active(app) {
        return;
    }
    let name = match (&job.artist, &job.title) {
        (Some(a), Some(t)) if !a.is_empty() => format!("{a} - {t}"),
        (_, Some(t)) => t.clone(),
        _ => "Morceau prêt".into(),
    };
    let mut body = match &job.bpm {
        Some(b) => format!("{} BPM", fmt_bpm(b.bpm)),
        None => "BPM non trouvé".into(),
    };
    if let Some(k) = &job.key {
        body.push_str(&format!(" · {}", k.camelot));
    }
    notify(app, &name, &body);
}

fn fmt_bpm(b: f64) -> String {
    if (b - b.round()).abs() < 0.05 {
        format!("{}", b.round())
    } else {
        format!("{b:.1}")
    }
}

fn toggle_pause(app: &AppHandle) -> bool {
    let mut s = app.state::<AppState>().settings.lock().unwrap().clone();
    s.paused = !s.paused;
    let _ = settings::save(app, &s);
    let s = crate::jobs::reload_settings(app);
    crate::jobs::pump(app);
    let _ = app.emit("settings-changed", &s);
    s.paused
}

pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let paused = app.state::<AppState>().settings.lock().unwrap().paused;
    let open = MenuItem::with_id(app, "open", "Ouvrir TrackFetcher", true, None::<&str>)?;
    let clip = MenuItem::with_id(app, "clip", "Télécharger le lien copié", true, None::<&str>)?;
    let files = MenuItem::with_id(app, "files", "Analyser des MP3…", true, None::<&str>)?;
    let pause = MenuItem::with_id(app, "pause", pause_label(paused), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?;
    let sep = || PredefinedMenuItem::separator(app);
    let menu = Menu::with_items(app, &[&open, &sep()?, &clip, &files, &pause, &sep()?, &quit])?;
    let pause_item = pause.clone();
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("TrackFetcher")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, ev| match ev.id.as_ref() {
            "open" => show_window(app),
            "clip" => download_clipboard(app),
            "files" => pick_files(app),
            "pause" => {
                let p = toggle_pause(app);
                let _ = pause_item.set_text(pause_label(p));
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                show_window(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    // Garde le libellé « pause » à jour quand on change depuis la fenêtre.
    let item = pause.clone();
    app.listen_any("pause-changed", move |e| {
        let _ = item.set_text(pause_label(e.payload() == "true"));
    });
    Ok(())
}

fn pause_label(paused: bool) -> &'static str {
    if paused {
        "Reprendre les téléchargements"
    } else {
        "Mettre en pause"
    }
}

fn download_clipboard(app: &AppHandle) {
    let text = app.clipboard().read_text().unwrap_or_default();
    let Some(url) = crate::clipboard::supported(&text) else {
        notify(app, "Rien à télécharger", "Copie d'abord un lien Spotify, YouTube ou SoundCloud.");
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match crate::queue_url(&app, url).await {
            Ok(n) => notify(&app, "Ajouté à la file", &format!("{n} morceau{}", if n > 1 { "x" } else { "" })),
            Err(e) => notify(&app, "Lien refusé", &e),
        }
    });
}

fn pick_files(app: &AppHandle) {
    use tauri_plugin_dialog::DialogExt;
    let handle = app.clone();
    app.dialog()
        .file()
        .set_title("Analyser des MP3")
        .add_filter("MP3", &["mp3"])
        .pick_files(move |files| {
            let paths: Vec<String> = files
                .unwrap_or_default()
                .into_iter()
                .filter_map(|f| f.into_path().ok())
                .map(|p| p.display().to_string())
                .collect();
            if !paths.is_empty() {
                let n = crate::queue_files(&handle, paths);
                notify(&handle, "Analyse lancée", &format!("{n} fichier{}", if n > 1 { "s" } else { "" }));
            }
        });
}

/// Première fermeture : on prévient que l'app continue dans la zone de notification.
pub fn hint_tray_once(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else { return };
    let flag = dir.join("tray-hint");
    if flag.exists() {
        return;
    }
    let _ = std::fs::create_dir_all(&dir);
    let _ = std::fs::write(&flag, "1");
    notify(
        app,
        "TrackFetcher reste ouvert",
        "Il continue dans la zone de notification. Clic droit sur l'icône pour quitter (désactivable dans les réglages).",
    );
}
