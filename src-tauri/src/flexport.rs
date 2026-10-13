//! Export FL Studio (idée 348) : chaque morceau de l'itinéraire devient un
//! fichier FLAC précédé du silence qu'il faut. Glissés ensemble dans la
//! Playlist de FL à la mesure 1, ils tombent tous pile au point de transition.
//! (Le format .flp est fermé et change selon les versions : un projet généré
//! risquerait de ne pas s'ouvrir, alors que ces fichiers marchent partout.)

use crate::{bpm::Grid, tools::Tools};
use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// Place d'un morceau dans le set.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Slot {
    pub path: String,
    /// Extrait du fichier (secondes).
    pub from: f64,
    pub to: f64,
    /// Position dans le set (secondes).
    pub at: f64,
    pub bars: u32,
}

/// Mesures de transition, comme la platine en mode auto : la plus courte entre
/// l'outro de A et l'intro de B, entre 4 et 32 mesures.
fn auto_bars(a: &Grid, b: &Grid) -> u32 {
    let beats = |n: u32| if n == 0 { 64 } else { n };
    let avail = beats(a.outro_beats).min(beats(b.intro_beats)) / 4;
    [8, 16, 32].into_iter().filter(|n| *n <= avail).last().unwrap_or(4)
}

/// B démarre à son point d'entrée quand A atteint son point de sortie ; A
/// continue pendant la transition puis s'arrête.
pub fn plan(tracks: &[(String, Grid)], bars: Option<u32>) -> Vec<Slot> {
    let mut out: Vec<Slot> = Vec::new();
    for (i, (path, g)) in tracks.iter().enumerate() {
        let from = if i == 0 { 0.0 } else { g.mix_in.max(0.0) };
        let at = match out.last() {
            Some(p) => p.at + (tracks[i - 1].1.mix_out - p.from).max(0.0),
            None => 0.0,
        };
        out.push(Slot { path: path.clone(), from, to: g.duration, at, bars: 0 });
        if i > 0 {
            let (a, b) = (&tracks[i - 1].1, g);
            let n = bars.unwrap_or_else(|| auto_bars(a, b));
            let beat = 60.0 / a.bpm.max(40.0);
            let prev = &mut out[i - 1];
            // Une mesure de plus pour laisser retomber la dernière note.
            prev.to = (a.mix_out + (n as f64 + 1.0) * 4.0 * beat).min(a.duration);
            prev.bars = n;
        }
    }
    out
}

fn clean(s: &str) -> String {
    s.chars().map(|c| if r#"<>:"/\|?*"#.contains(c) || c.is_control() { '_' } else { c }).collect::<String>().trim().to_string()
}

fn clock(t: f64) -> String {
    let s = t.max(0.0).round() as u64;
    format!("{}:{:02}:{:02}", s / 3600, s / 60 % 60, s % 60)
}

/// Écrit le dossier d'export et renvoie son chemin.
pub async fn export(tools: &Tools, out_dir: &Path, tracks: Vec<(String, Grid)>, bars: Option<u32>, on_step: impl Fn(usize, usize)) -> Result<PathBuf> {
    if tracks.len() < 2 {
        bail!("Il faut au moins deux morceaux dans l'itinéraire");
    }
    let slots = plan(&tracks, bars);
    let stamp = chrono_stamp();
    let dir = out_dir.join("Export FL Studio").join(format!("Set {stamp}"));
    std::fs::create_dir_all(&dir).with_context(|| format!("{} : création impossible", dir.display()))?;
    let tempo = tracks[0].1.bpm;
    let mut notes = format!(
        "Set préparé par TrackFetcher ({} morceaux, {}).\n\n\
         Dans FL Studio :\n\
         1. Règle le tempo du projet sur {:.0} BPM (celui du premier morceau).\n\
         2. Sélectionne tous les fichiers .flac de ce dossier et glisse-les ensemble dans la Playlist, au tout début (mesure 1).\n\
         3. FL les place chacun sur sa piste : chaque morceau commence déjà au bon point de transition.\n\n\
         Les fichiers commencent par du silence, c'est normal : c'est ce qui les cale.\n\
         Les tempos d'origine sont gardés : à toi d'étirer ou d'automatiser les transitions.\n\n\
         Repères :\n",
        slots.len(),
        clock(slots.last().map(|s| s.at + s.to - s.from).unwrap_or(0.0)),
        tempo
    );
    for (i, s) in slots.iter().enumerate() {
        on_step(i, slots.len());
        let stem = Path::new(&s.path).file_stem().and_then(|x| x.to_str()).unwrap_or("piste");
        let name = format!("{:02} - {}.flac", i + 1, clean(stem));
        let dest = dir.join(&name);
        let delay = (s.at * 1000.0).round() as u64;
        let fade = (s.to - s.from - 0.03).max(0.0);
        let filter = format!("aresample=44100,afade=t=out:st={fade:.3}:d=0.03,adelay={delay}:all=1");
        let out = tools
            .ffmpeg()
            .args(["-hide_banner", "-loglevel", "error", "-y", "-ss", &format!("{:.3}", s.from), "-to", &format!("{:.3}", s.to), "-i", &s.path])
            .args(["-vn", "-af", &filter, "-ac", "2", "-sample_fmt", "s16", "-c:a", "flac", "-compression_level", "8"])
            .arg(&dest)
            .output()
            .await
            .context("ffmpeg introuvable")?;
        if !out.status.success() {
            bail!("{} : {}", name, String::from_utf8_lossy(&out.stderr).lines().last().unwrap_or("échec de ffmpeg"));
        }
        let bar = s.at / (4.0 * 60.0 / tempo) + 1.0;
        let trans = if s.bars > 0 { format!(", transition de {} mesures vers le suivant", s.bars) } else { String::new() };
        notes.push_str(&format!("{:02}. {} : entre à {} (mesure {:.1} à {:.0} BPM){}\n", i + 1, stem, clock(s.at), bar, tempo, trans));
    }
    std::fs::write(dir.join("LISEZ-MOI.txt"), notes.replace('\n', "\r\n"))?;
    Ok(dir)
}

fn chrono_stamp() -> String {
    // Horodatage local sans dépendance : AAAA-MM-JJ HHhMM (UTC).
    let s = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    let (days, rem) = (s / 86400, s % 86400);
    let (y, m, d) = civil(days as i64);
    format!("{y:04}-{m:02}-{d:02} {:02}h{:02}", rem / 3600, rem / 60 % 60)
}

/// Jours depuis 1970 → (année, mois, jour).
fn civil(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn grid(bpm: f64, duration: f64, mix_in: f64, mix_out: f64, intro: u32, outro: u32) -> Grid {
        Grid {
            bpm,
            offset: 0.0,
            duration,
            intro_end: None,
            intro_beats: intro,
            dj_intro: intro >= 16,
            first_beat: mix_in,
            outro_start: None,
            outro_beats: outro,
            mix_in,
            mix_out,
            energy: 5,
        }
    }

    #[test]
    fn next_track_lands_on_previous_mix_out() {
        let t = vec![
            ("a.mp3".to_string(), grid(120.0, 300.0, 2.0, 250.0, 32, 64)),
            ("b.mp3".to_string(), grid(124.0, 280.0, 4.0, 240.0, 64, 32)),
            ("c.mp3".to_string(), grid(126.0, 200.0, 0.5, 180.0, 16, 16)),
        ];
        let s = plan(&t, None);
        // A joue depuis 0 ; B entre quand A atteint 250 s.
        assert_eq!((s[0].from, s[0].at), (0.0, 0.0));
        assert_eq!((s[1].from, s[1].at), (4.0, 250.0));
        // C entre quand B atteint 240 s : 250 + (240 - 4).
        assert!((s[2].at - 486.0).abs() < 1e-9);
        // Transition A→B : min(outro A 64, intro B 64)/4 = 16 mesures, + 1 mesure.
        assert_eq!(s[0].bars, 16);
        assert!((s[0].to - (250.0 + 17.0 * 2.0)).abs() < 1e-9);
        // Imposé : 8 mesures partout.
        assert_eq!(plan(&t, Some(8))[1].bars, 8);
        // Le dernier morceau va jusqu'au bout.
        assert_eq!(s[2].to, 200.0);
    }

    #[test]
    fn dates() {
        assert_eq!(civil(0), (1970, 1, 1));
        assert_eq!(civil(20_374), (2025, 10, 13));
        assert_eq!(clean("AC/DC: Live?"), "AC_DC_ Live_");
    }
}
