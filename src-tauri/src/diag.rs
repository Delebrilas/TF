//! « Tester mes sources » : vérifie depuis le PC de l'utilisateur que chaque
//! source répond, et produit un rapport à copier-coller.

use crate::{ext, online, sources, tools};
use serde::Serialize;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone)]
pub struct Check {
    pub name: String,
    /// None : test sauté (non configuré).
    pub ok: Option<bool>,
    pub detail: String,
    pub ms: u64,
}

async fn timed<F>(name: &str, f: F) -> Check
where
    F: std::future::Future<Output = Result<String, Option<String>>>,
{
    let t = Instant::now();
    let r = tokio::time::timeout(Duration::from_secs(60), f).await;
    let ms = t.elapsed().as_millis() as u64;
    let (ok, detail) = match r {
        Ok(Ok(d)) => (Some(true), d),
        Ok(Err(Some(e))) => (Some(false), e),
        Ok(Err(None)) => (None, "non configuré".into()),
        Err(_) => (Some(false), "pas de réponse en 60 s".into()),
    };
    Check { name: name.into(), ok, detail, ms }
}

async fn ytdlp_probe(t: &tools::Tools, target: &str) -> Result<String, Option<String>> {
    let run = |t: tools::Tools| async move {
        t.ytdlp()
            .args(["--simulate", "--no-playlist", "--no-warnings", "-f", "bestaudio/best", "--print", "%(title)s", target])
            .output()
            .await
    };
    let mut out = run(t.clone()).await.map_err(|e| Some(e.to_string()))?;
    if !out.status.success() && !t.cookies.is_empty() && tools::retry_without_cookies(&sources::last_error(&out.stderr)) {
        out = run(t.without_cookies()).await.map_err(|e| Some(e.to_string()))?;
    }
    if out.status.success() {
        Ok(format!("« {} »", String::from_utf8_lossy(&out.stdout).trim()))
    } else {
        Err(Some(crate::jobs::friendly(&sources::last_error(&out.stderr))))
    }
}

pub async fn run(app: &AppHandle) -> Vec<Check> {
    let (sc_user, gsb, out_dir, cookies) = {
        let st = app.state::<crate::AppState>();
        let s = st.settings.lock().unwrap();
        (s.soundcloud_user.clone(), s.getsongbpm_key.clone(), s.output_dir.clone(), s.cookies_browser.clone())
    };
    let status = tools::status(app);
    let t = tools::locate(app);
    let mut v = Vec::new();

    v.push(timed("Outils", async {
        let ytdlp = t.as_ref().ok_or(Some("yt-dlp introuvable : Réglages › Outils".to_string()))?;
        let ver = ytdlp.ytdlp().arg("--version").output().await.map_err(|e| Some(e.to_string()))?;
        let missing: Vec<&str> = [("ffmpeg", status.ffmpeg.is_some()), ("Deno", status.deno.is_some())].iter().filter(|x| !x.1).map(|x| x.0).collect();
        let base = format!("yt-dlp {}", String::from_utf8_lossy(&ver.stdout).trim());
        if missing.is_empty() { Ok(format!("{base}, ffmpeg et Deno présents")) } else { Err(Some(format!("{base}, manquant : {}", missing.join(", ")))) }
    }).await);

    v.push(timed("Dossier de sortie", async {
        let d = std::path::Path::new(&out_dir);
        std::fs::create_dir_all(d).map_err(|e| Some(format!("{out_dir} : {e}")))?;
        let probe = d.join(".trackfetcher-test");
        std::fs::write(&probe, b"ok").map_err(|e| Some(format!("{out_dir} : écriture impossible ({e})")))?;
        let _ = std::fs::remove_file(probe);
        Ok(out_dir.clone())
    }).await);

    if let Some(t) = &t {
        let note = if cookies.is_empty() { "" } else { " (avec la session du navigateur)" };
        let mut c = timed("YouTube", ytdlp_probe(t, "ytsearch1:Daft Punk One More Time audio")).await;
        c.detail.push_str(note);
        v.push(c);
        v.push(timed("SoundCloud", ytdlp_probe(t, "scsearch1:Daft Punk One More Time")).await);
    }

    v.push(timed("Spotify", async {
        if !crate::spotify::connected() {
            return Err(None);
        }
        let l = crate::spotify::playlists().await.map_err(|e| Some(e.to_string()))?;
        Ok(format!("connecté, {} playlists lisibles", l.iter().filter(|p| p.readable).count()))
    }).await);

    v.push(timed("Likes SoundCloud", async {
        let url = ext::soundcloud_likes(&sc_user).ok_or(None)?;
        let t = t.as_ref().ok_or(Some("yt-dlp introuvable".to_string()))?;
        let r = sources::resolve(t, &url).await.map_err(|e| Some(crate::jobs::friendly(&e.to_string())))?;
        Ok(format!("{} titres", r.tracks.len()))
    }).await);

    v.push(timed("Deezer", async {
        online::deezer_preview("Daft Punk", "One More Time", None)
            .await
            .map(|_| "BPM et extraits disponibles".to_string())
            .ok_or(Some("pas de réponse (réseau ou pare-feu ?)".to_string()))
    }).await);

    v.push(timed("GetSongBPM", async {
        if gsb.trim().is_empty() {
            return Err(None);
        }
        match online::getsongbpm_query(&gsb, "Daft Punk", "One More Time").await {
            Ok((Some(b), k)) => Ok(format!("{b} BPM{}", k.map(|k| format!(", {k}")).unwrap_or_default())),
            Ok((None, _)) => Err(Some("titre trouvé, mais sans BPM".into())),
            Err(e) => Err(Some(e)),
        }
    }).await);
    v
}

/// Rapport texte (à coller dans la conversation).
pub fn report(app: &AppHandle, checks: &[Check]) -> String {
    let mut s = format!(
        "TrackFetcher {} · {} {}\n",
        app.package_info().version,
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    for c in checks {
        let mark = match c.ok {
            Some(true) => "OK ",
            Some(false) => "ÉCHEC",
            None => "—  ",
        };
        s.push_str(&format!("{mark} {} : {} ({} ms)\n", c.name, c.detail, c.ms));
    }
    s
}
