//! Localisation et installation automatique de yt-dlp et ffmpeg.

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

#[derive(Debug, Clone, serde::Serialize)]
pub struct ToolsStatus {
    pub ytdlp: Option<String>,
    pub ffmpeg: Option<String>,
    /// Vrai si l'installation automatique de ffmpeg est possible sur cet OS.
    pub ffmpeg_auto: bool,
}

#[derive(Debug, Clone)]
pub struct Tools {
    pub ytdlp: PathBuf,
    /// Dossier contenant ffmpeg (et ffprobe), passé à --ffmpeg-location.
    pub ffmpeg_dir: Option<PathBuf>,
}

#[derive(Clone, serde::Serialize)]
struct InstallProgress {
    tool: String,
    progress: f64,
    message: String,
}

fn exe(name: &str) -> String {
    if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    }
}

pub fn bin_dir<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<PathBuf> {
    Ok(app.path().app_data_dir()?.join("bin"))
}

fn which(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&path).collect();
    // Les apps lancées depuis le Finder n'héritent pas du PATH de Homebrew.
    if cfg!(target_os = "macos") {
        dirs.push("/opt/homebrew/bin".into());
        dirs.push("/usr/local/bin".into());
    }
    dirs.into_iter().map(|d| d.join(exe(name))).find(|p| p.is_file())
}

pub fn status<R: tauri::Runtime>(app: &AppHandle<R>) -> ToolsStatus {
    let t = locate(app);
    ToolsStatus {
        ytdlp: t.as_ref().map(|t| t.ytdlp.display().to_string()),
        ffmpeg: find_ffmpeg(app).map(|p| p.display().to_string()),
        ffmpeg_auto: cfg!(any(windows, target_os = "macos")),
    }
}

fn find_ffmpeg<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    let local = bin_dir(app).ok()?.join(exe("ffmpeg"));
    if local.is_file() {
        return Some(local);
    }
    which("ffmpeg")
}

pub fn locate<R: tauri::Runtime>(app: &AppHandle<R>) -> Option<Tools> {
    let dir = bin_dir(app).ok()?;
    let local = dir.join(exe("yt-dlp"));
    let ytdlp = if local.is_file() { Some(local) } else { which("yt-dlp") }?;
    let ffmpeg_dir = find_ffmpeg(app).and_then(|p| p.parent().map(Path::to_path_buf));
    Some(Tools { ytdlp, ffmpeg_dir })
}

pub fn require<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<Tools> {
    let t = locate(app).ok_or_else(|| anyhow!("yt-dlp n'est pas installé"))?;
    if t.ffmpeg_dir.is_none() {
        return Err(anyhow!("ffmpeg n'est pas installé"));
    }
    Ok(t)
}

fn ytdlp_url() -> &'static str {
    if cfg!(windows) {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
    } else if cfg!(target_os = "macos") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos"
    } else if cfg!(target_arch = "aarch64") {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64"
    } else {
        "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"
    }
}

/// (URL, fichiers à extraire de l'archive)
fn ffmpeg_archives() -> Vec<(&'static str, Vec<&'static str>)> {
    if cfg!(windows) {
        vec![(
            "https://github.com/yt-dlp/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip",
            vec!["ffmpeg.exe", "ffprobe.exe"],
        )]
    } else if cfg!(target_os = "macos") {
        vec![
            ("https://evermeet.cx/ffmpeg/getrelease/zip", vec!["ffmpeg"]),
            ("https://evermeet.cx/ffmpeg/getrelease/ffprobe/zip", vec!["ffprobe"]),
        ]
    } else {
        vec![]
    }
}

async fn download<R: tauri::Runtime>(app: &AppHandle<R>, tool: &str, url: &str, dest: &Path) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent(concat!("TrackFetcher/", env!("CARGO_PKG_VERSION")))
        .build()?;
    let resp = client.get(url).send().await?.error_for_status()?;
    let total = resp.content_length().unwrap_or(0) as f64;
    let tmp = dest.with_extension("part");
    let mut file = tokio::fs::File::create(&tmp).await?;
    let mut stream = resp.bytes_stream();
    let mut done = 0f64;
    let mut last = 0f64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        done += chunk.len() as f64;
        let p = if total > 0.0 { done / total } else { 0.0 };
        if p - last > 0.01 {
            last = p;
            let _ = app.emit(
                "tools-progress",
                InstallProgress { tool: tool.into(), progress: p, message: format!("Téléchargement de {tool}…") },
            );
        }
    }
    file.flush().await?;
    drop(file);
    tokio::fs::rename(&tmp, dest).await?;
    Ok(())
}

#[cfg(unix)]
fn make_executable(p: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(p, std::fs::Permissions::from_mode(0o755))?;
    Ok(())
}
#[cfg(not(unix))]
fn make_executable(_: &Path) -> Result<()> {
    Ok(())
}

fn extract(archive: &Path, wanted: &[&str], dir: &Path) -> Result<()> {
    let mut zip = zip::ZipArchive::new(std::fs::File::open(archive)?)?;
    let mut found = 0;
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        let name = entry.name().rsplit('/').next().unwrap_or("").to_string();
        if wanted.contains(&name.as_str()) {
            let out = dir.join(&name);
            let mut f = std::fs::File::create(&out)?;
            std::io::copy(&mut entry, &mut f)?;
            make_executable(&out)?;
            found += 1;
        }
    }
    if found < wanted.len() {
        return Err(anyhow!("Archive ffmpeg incomplète"));
    }
    Ok(())
}

pub async fn install<R: tauri::Runtime>(app: &AppHandle<R>) -> Result<ToolsStatus> {
    let dir = bin_dir(app)?;
    tokio::fs::create_dir_all(&dir).await?;

    if locate(app).is_none() {
        let dest = dir.join(exe("yt-dlp"));
        download(app, "yt-dlp", ytdlp_url(), &dest).await.context("Téléchargement de yt-dlp")?;
        make_executable(&dest)?;
    }

    if find_ffmpeg(app).is_none() {
        let archives = ffmpeg_archives();
        if archives.is_empty() {
            return Err(anyhow!(
                "Installe ffmpeg avec ton gestionnaire de paquets (ex. sudo apt install ffmpeg), puis relance l'app."
            ));
        }
        for (i, (url, files)) in archives.iter().enumerate() {
            let zip = dir.join(format!("ffmpeg-{i}.zip"));
            download(app, "ffmpeg", url, &zip).await.context("Téléchargement de ffmpeg")?;
            let _ = app.emit(
                "tools-progress",
                InstallProgress { tool: "ffmpeg".into(), progress: 1.0, message: "Extraction de ffmpeg…".into() },
            );
            let (z, f, d) = (zip.clone(), files.clone(), dir.clone());
            tokio::task::spawn_blocking(move || extract(&z, &f, &d)).await??;
            let _ = tokio::fs::remove_file(&zip).await;
        }
    }
    Ok(status(app))
}

/// Met à jour en tâche de fond la copie de yt-dlp gérée par l'app
/// (YouTube change souvent, une version ancienne finit par échouer).
pub async fn self_update<R: tauri::Runtime>(app: &AppHandle<R>) {
    let Ok(dir) = bin_dir(app) else { return };
    let local = dir.join(exe("yt-dlp"));
    if local.is_file() {
        let _ = command(&local).arg("-U").output().await;
    }
}

/// Commande sans fenêtre console sous Windows.
pub fn command(program: &Path) -> tokio::process::Command {
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd.kill_on_drop(true);
    cmd
}
