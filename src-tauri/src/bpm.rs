//! Détection locale du tempo.
//!
//! Chaîne : décodage → mono sous-échantillonné (~11 kHz) → STFT → flux
//! spectral (enveloppe d'attaques) → autocorrélation → tempo grossier avec
//! un a priori centré sur 120 BPM → affinage au centième par un peigne
//! d'autocorrélation sur 16 périodes.

use anyhow::{anyhow, Context, Result};
use rustfft::{num_complex::Complex, FftPlanner};
use std::path::Path;
use symphonia::core::{
    audio::SampleBuffer, codecs::DecoderOptions, errors::Error as SymError, formats::FormatOptions,
    io::MediaSourceStream, meta::MetadataOptions, probe::Hint,
};

const TARGET_SR: f64 = 11025.0;
const FRAME: usize = 1024;
const HOP: usize = 128;
const MIN_BPM: f64 = 50.0;
const MAX_BPM: f64 = 220.0;
/// Durée maximale analysée (secondes), prise au centre du morceau.
const MAX_SECONDS: f64 = 240.0;

#[derive(Debug, Clone, serde::Serialize)]
pub struct Analysis {
    pub bpm: f64,
    /// 0..1, netteté du pic d'autocorrélation.
    pub confidence: f64,
}

/// Tempo et tonalité en un seul décodage.
pub fn analyze_full(path: &Path) -> (Option<Analysis>, Option<crate::key::Key>) {
    let Ok((samples, sr)) = decode_mono(path) else { return (None, None) };
    let tempo = analyze_samples(&samples, sr).ok();
    let (mono, dsr) = downsample(&samples, sr as f64);
    let key = crate::key::detect(&center_window(&mono, dsr, MAX_SECONDS), dsr);
    (tempo, key)
}

pub fn analyze_samples(samples: &[f32], sr: u32) -> Result<Analysis> {
    let (mono, sr) = downsample(samples, sr as f64);
    let mono = center_window(&mono, sr, MAX_SECONDS);
    if mono.len() < (sr * 8.0) as usize {
        return Err(anyhow!("Morceau trop court pour estimer le tempo"));
    }
    let fps = sr / HOP as f64;
    let env = onset_envelope(&mono);
    let ac = autocorrelation(&env);
    estimate_tempo(&ac, fps).ok_or_else(|| anyhow!("Aucun tempo détectable"))
}

fn decode_mono(path: &Path) -> Result<(Vec<f32>, u32)> {
    let file = std::fs::File::open(path).with_context(|| format!("Ouverture de {}", path.display()))?;
    let mss = MediaSourceStream::new(Box::new(file), Default::default());
    let mut hint = Hint::new();
    if let Some(ext) = path.extension().and_then(|e| e.to_str()) {
        hint.with_extension(ext);
    }
    let probed = symphonia::default::get_probe()
        .format(&hint, mss, &FormatOptions::default(), &MetadataOptions::default())
        .context("Format audio non reconnu")?;
    let mut format = probed.format;
    let track = format
        .default_track()
        .ok_or_else(|| anyhow!("Aucune piste audio"))?
        .clone();
    let sr = track.codec_params.sample_rate.unwrap_or(44100);
    let mut decoder = symphonia::default::get_codecs()
        .make(&track.codec_params, &DecoderOptions::default())
        .context("Codec non pris en charge")?;

    let max_samples = (sr as f64 * 900.0) as usize; // garde-fou : 15 min
    let mut out: Vec<f32> = Vec::new();
    let mut buf: Option<SampleBuffer<f32>> = None;
    loop {
        let packet = match format.next_packet() {
            Ok(p) => p,
            Err(SymError::IoError(e)) if e.kind() == std::io::ErrorKind::UnexpectedEof => break,
            Err(SymError::ResetRequired) => break,
            Err(e) => return Err(e.into()),
        };
        if packet.track_id() != track.id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(d) => d,
            Err(SymError::DecodeError(_)) => continue,
            Err(e) => return Err(e.into()),
        };
        let spec = *decoded.spec();
        let channels = spec.channels.count().max(1);
        let sb = buf.get_or_insert_with(|| SampleBuffer::new(decoded.capacity() as u64, spec));
        if sb.capacity() < decoded.capacity() {
            *sb = SampleBuffer::new(decoded.capacity() as u64, spec);
        }
        sb.copy_interleaved_ref(decoded);
        for frame in sb.samples().chunks(channels) {
            out.push(frame.iter().sum::<f32>() / channels as f32);
        }
        if out.len() > max_samples {
            break;
        }
    }
    if out.is_empty() {
        return Err(anyhow!("Aucun échantillon décodé"));
    }
    Ok((out, sr))
}

/// Moyenne par blocs : filtre passe-bas grossier + décimation.
fn downsample(samples: &[f32], sr: f64) -> (Vec<f32>, f64) {
    let factor = (sr / TARGET_SR).round().max(1.0) as usize;
    let out = samples
        .chunks(factor)
        .map(|c| c.iter().sum::<f32>() / c.len() as f32)
        .collect();
    (out, sr / factor as f64)
}

fn center_window(x: &[f32], sr: f64, seconds: f64) -> Vec<f32> {
    let max = (sr * seconds) as usize;
    if x.len() <= max {
        return x.to_vec();
    }
    let start = (x.len() - max) / 2;
    x[start..start + max].to_vec()
}

fn onset_envelope(x: &[f32]) -> Vec<f32> {
    let window: Vec<f32> = (0..FRAME)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FRAME as f32).cos())
        .collect();
    let mut planner = FftPlanner::<f32>::new();
    let fft = planner.plan_fft_forward(FRAME);
    let bins = FRAME / 2;
    let n_frames = if x.len() > FRAME { (x.len() - FRAME) / HOP + 1 } else { 0 };

    let mut prev = vec![0f32; bins];
    let mut env = Vec::with_capacity(n_frames);
    let mut buf = vec![Complex::new(0f32, 0f32); FRAME];
    for f in 0..n_frames {
        let off = f * HOP;
        for i in 0..FRAME {
            buf[i] = Complex::new(x[off + i] * window[i], 0.0);
        }
        fft.process(&mut buf);
        let mut flux = 0f32;
        for k in 1..bins {
            let mag = (1.0 + 100.0 * buf[k].norm()).ln();
            let d = mag - prev[k];
            if d > 0.0 {
                flux += d;
            }
            prev[k] = mag;
        }
        env.push(if f == 0 { 0.0 } else { flux });
    }

    // Retire la tendance lente (moyenne glissante ~0,4 s) et ne garde que le positif.
    let w = 35usize;
    let mut prefix = vec![0f64; env.len() + 1];
    for (i, v) in env.iter().enumerate() {
        prefix[i + 1] = prefix[i] + *v as f64;
    }
    let out: Vec<f32> = (0..env.len())
        .map(|i| {
            let a = i.saturating_sub(w);
            let b = (i + w + 1).min(env.len());
            let mean = (prefix[b] - prefix[a]) / (b - a) as f64;
            (env[i] as f64 - mean).max(0.0) as f32
        })
        .collect();
    let max = out.iter().cloned().fold(0f32, f32::max);
    if max > 0.0 {
        out.iter().map(|v| v / max).collect()
    } else {
        out
    }
}

/// Autocorrélation normalisée par le nombre de termes, via FFT.
fn autocorrelation(x: &[f32]) -> Vec<f64> {
    let n = x.len();
    let size = (2 * n).next_power_of_two();
    let mut planner = FftPlanner::<f64>::new();
    let mean = x.iter().map(|v| *v as f64).sum::<f64>() / n.max(1) as f64;
    let mut buf: Vec<Complex<f64>> = (0..size)
        .map(|i| Complex::new(if i < n { x[i] as f64 - mean } else { 0.0 }, 0.0))
        .collect();
    planner.plan_fft_forward(size).process(&mut buf);
    for c in buf.iter_mut() {
        *c = Complex::new(c.norm_sqr(), 0.0);
    }
    planner.plan_fft_inverse(size).process(&mut buf);
    let zero = buf[0].re.max(1e-12);
    (0..n).map(|lag| buf[lag].re / zero * n as f64 / (n - lag) as f64).collect()
}

fn ac_at(ac: &[f64], lag: f64) -> f64 {
    let i = lag.floor() as usize;
    if i + 1 >= ac.len() {
        return 0.0;
    }
    let t = lag - i as f64;
    ac[i] * (1.0 - t) + ac[i + 1] * t
}

/// Score d'un tempo : somme pondérée de l'autocorrélation sur plusieurs
/// multiples de la période (les multiples éloignés donnent la précision).
fn comb_score(ac: &[f64], fps: f64, bpm: f64, periods: usize) -> f64 {
    let lag = 60.0 * fps / bpm;
    let mut s = 0.0;
    let mut wsum = 0.0;
    for k in 1..=periods {
        let l = lag * k as f64;
        if l + 1.0 >= ac.len() as f64 {
            break;
        }
        s += ac_at(ac, l);
        wsum += 1.0;
    }
    if wsum > 0.0 {
        s / wsum
    } else {
        0.0
    }
}

fn estimate_tempo(ac: &[f64], fps: f64) -> Option<Analysis> {
    // 1. Tempo grossier par pas de 0,5 BPM, avec a priori log-normal (120 BPM, 1 octave).
    let mut scores: Vec<(f64, f64)> = Vec::new();
    let mut bpm = MIN_BPM;
    while bpm <= MAX_BPM {
        let raw = comb_score(ac, fps, bpm, 4);
        let prior = (-0.5 * ((bpm / 120.0).log2() / 1.0).powi(2)).exp();
        scores.push((bpm, raw.max(0.0) * prior));
        bpm += 0.5;
    }
    let (coarse, best) = scores
        .iter()
        .cloned()
        .fold((0.0, f64::MIN), |a, b| if b.1 > a.1 { b } else { a });
    if best <= 0.0 {
        return None;
    }

    // 2. Affinage au centième sur ±2 BPM avec 16 périodes.
    let mut fine: f64 = coarse;
    let mut fine_score = f64::MIN;
    let mut b = coarse - 2.0;
    while b <= coarse + 2.0 {
        let s = comb_score(ac, fps, b, 16);
        if s > fine_score {
            fine_score = s;
            fine = b;
        }
        b += 0.01;
    }

    // Sous 78 BPM, un double tempo crédible est préféré (convention DJ :
    // un morceau à 172 se compte 172, pas 86).
    if fine < 78.0 {
        let here = comb_score(ac, fps, fine, 8);
        let double = comb_score(ac, fps, fine * 2.0, 8);
        if here > 0.0 && double / here > 0.5 {
            fine *= 2.0;
        }
    }

    // Confiance : pic retenu vs score moyen.
    let mean = scores.iter().map(|s| s.1).sum::<f64>() / scores.len() as f64;
    let confidence = ((best - mean) / best).clamp(0.0, 1.0);

    // La plupart des productions sont calées sur un tempo entier.
    let rounded = fine.round();
    let bpm = if (fine - rounded).abs() < 0.2 { rounded } else { (fine * 10.0).round() / 10.0 };
    Some(Analysis { bpm, confidence })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Boucle synthétique kick / snare / charleston + bruit léger.
    fn drum_loop(bpm: f64, seconds: f64, sr: u32) -> Vec<f32> {
        let n = (seconds * sr as f64) as usize;
        let mut out = vec![0f32; n];
        let beat = 60.0 / bpm;
        let mut seed = 12345u32;
        let mut rnd = || {
            seed = seed.wrapping_mul(1664525).wrapping_add(1013904223);
            (seed >> 8) as f32 / (1u32 << 24) as f32 - 0.5
        };
        let mut t = 0.0;
        let mut i = 0;
        while t < seconds {
            let start = (t * sr as f64) as usize;
            for j in 0..(sr as usize / 5) {
                let idx = start + j;
                if idx >= n {
                    break;
                }
                let tt = j as f32 / sr as f32;
                if i % 2 == 0 {
                    // kick
                    out[idx] += 0.9 * (2.0 * std::f32::consts::PI * (55.0 + 90.0 * (-tt * 30.0).exp()) * tt).sin() * (-tt * 12.0).exp();
                } else {
                    // snare
                    out[idx] += 0.5 * rnd() * (-tt * 20.0).exp();
                }
            }
            // charleston sur la croche
            let hh = ((t + beat / 2.0) * sr as f64) as usize;
            for j in 0..(sr as usize / 30) {
                if hh + j < n {
                    out[hh + j] += 0.15 * rnd() * (-(j as f32) / sr as f32 * 80.0).exp();
                }
            }
            t += beat;
            i += 1;
        }
        for v in out.iter_mut() {
            *v += 0.02 * rnd();
        }
        out
    }

    #[test]
    fn detects_synthetic_tempos() {
        for &bpm in &[70.0, 85.0, 98.0, 110.0, 120.0, 124.0, 128.0, 135.0, 140.0, 150.0, 172.0] {
            let x = drum_loop(bpm, 60.0, 44100);
            let a = analyze_samples(&x, 44100).unwrap();
            let ok = (a.bpm - bpm).abs() <= 0.5
                || (a.bpm * 2.0 - bpm).abs() <= 1.0
                || (a.bpm / 2.0 - bpm).abs() <= 0.5;
            assert!(ok, "attendu {bpm}, obtenu {} (confiance {:.2})", a.bpm, a.confidence);
            println!("{bpm} → {} ({:.2})", a.bpm, a.confidence);
        }
    }
}

// ---------- Grille de battements et intro DJ ----------

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Grid {
    pub bpm: f64,
    /// Position du premier battement (secondes).
    pub offset: f64,
    pub duration: f64,
    /// Fin de l'intro « beat seul » (secondes), calée sur une mesure.
    pub intro_end: Option<f64>,
    /// Nombre de temps de l'intro.
    pub intro_beats: u32,
    /// Intro exploitable pour mixer : au moins 16 temps de rythmique sans mélodie.
    pub dj_intro: bool,
}

const GRID_HOP: usize = 256;
const ATTACK_WIN: usize = 64;
const ATTACK_HOP: usize = 16;
/// Correction mesurée sur des kicks synthétiques (secondes).
const ATTACK_LAG: f64 = 0.0;

/// Hausse d'énergie à court terme (attaques), lissée sur ~20 ms.
fn attack_envelope(x: &[f32]) -> Vec<f32> {
    let n = if x.len() > ATTACK_WIN { (x.len() - ATTACK_WIN) / ATTACK_HOP + 1 } else { 0 };
    let e: Vec<f32> = (0..n)
        .map(|f| {
            let s = &x[f * ATTACK_HOP..f * ATTACK_HOP + ATTACK_WIN];
            (1e-6 + s.iter().map(|v| v * v).sum::<f32>()).ln()
        })
        .collect();
    // Comparer à la moyenne des ~23 ms précédentes : robuste aux oscillations du kick.
    let back = 16usize;
    (0..n)
        .map(|i| {
            if i < back {
                return 0.0;
            }
            let prev = e[i - back..i].iter().sum::<f32>() / back as f32;
            let cur = e[i..(i + 4).min(n)].iter().cloned().fold(f32::MIN, f32::max);
            (cur - prev).max(0.0)
        })
        .collect()
}

/// Énergies par trame : graves (≈ 30–200 Hz) et médiums (≈ 300–3000 Hz).
fn band_energies(x: &[f32], sr: f64) -> (Vec<f32>, Vec<f32>) {
    let window: Vec<f32> = (0..FRAME)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / FRAME as f32).cos())
        .collect();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(FRAME);
    let hz = sr as f32 / FRAME as f32;
    let bin = |f: f32| ((f / hz).round() as usize).clamp(1, FRAME / 2 - 1);
    let (l0, l1, m0, m1) = (bin(30.0), bin(200.0), bin(300.0), bin(3000.0));
    let n = if x.len() > FRAME { (x.len() - FRAME) / GRID_HOP + 1 } else { 0 };
    let mut low = Vec::with_capacity(n);
    let mut mid = Vec::with_capacity(n);
    let mut buf = vec![Complex::new(0f32, 0f32); FRAME];
    for f in 0..n {
        let off = f * GRID_HOP;
        for i in 0..FRAME {
            buf[i] = Complex::new(x[off + i] * window[i], 0.0);
        }
        fft.process(&mut buf);
        low.push(buf[l0..=l1].iter().map(|c| c.norm_sqr()).sum());
        mid.push(buf[m0..=m1].iter().map(|c| c.norm_sqr()).sum());
    }
    (low, mid)
}

fn median(v: &[f32]) -> f32 {
    if v.is_empty() {
        return 0.0;
    }
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.total_cmp(b));
    s[s.len() / 2]
}

/// Phase des battements : décalage qui aligne le mieux une grille de période
/// donnée sur les attaques.
fn beat_phase(env: &[f32], period: f64) -> f64 {
    let at = |t: f64| -> f32 {
        let i = t.floor() as usize;
        if i + 1 >= env.len() {
            return 0.0;
        }
        let fr = (t - i as f64) as f32;
        env[i] * (1.0 - fr) + env[i + 1] * fr
    };
    let steps = (period * 4.0) as usize;
    let mut best = (0.0, f32::MIN);
    for s in 0..steps.max(1) {
        let phi = s as f64 / 4.0;
        let mut sum = 0f32;
        let mut t = phi;
        while t < env.len() as f64 {
            sum += at(t);
            t += period;
        }
        if sum > best.1 {
            best = (phi, sum);
        }
    }
    best.0
}

pub fn grid_samples(samples: &[f32], sr: u32, bpm_hint: Option<f64>) -> Result<Grid> {
    let (mono, dsr) = downsample(samples, sr as f64);
    let duration = mono.len() as f64 / dsr;
    let bpm = match bpm_hint.filter(|b| *b > 40.0) {
        Some(b) => b,
        None => analyze_samples(samples, sr)?.bpm,
    };
    // Phase : enveloppe d'attaque fine (fenêtres de 5,8 ms) pour une grille précise.
    let env = attack_envelope(&mono);
    let fps = dsr / ATTACK_HOP as f64;
    let period = 60.0 * fps / bpm;
    let phi = beat_phase(&env, period);
    let beat = 60.0 / bpm;
    let mut offset = (phi * ATTACK_HOP as f64 + ATTACK_WIN as f64) / dsr + ATTACK_LAG;
    offset = offset.rem_euclid(beat);

    // Intro : graves présents, médiums (mélodie, voix) encore discrets.
    let (low, mid) = band_energies(&mono, dsr);
    let gfps = dsr / GRID_HOP as f64;
    let mid_ref = median(&mid);
    let low_ref = median(&low);
    let per_beat = (beat * gfps).max(1.0) as usize;
    let beats_total = ((duration - offset) / beat) as usize;
    let mut intro_beats = 0u32;
    let mut low_ok = 0u32;
    for b in 0..beats_total.min(128) {
        let start = ((offset + b as f64 * beat) * gfps) as usize;
        let end = (start + per_beat).min(mid.len());
        if start >= end {
            break;
        }
        let m = mid[start..end].iter().sum::<f32>() / (end - start) as f32;
        let l = low[start..end].iter().sum::<f32>() / (end - start) as f32;
        if m > 0.55 * mid_ref {
            break;
        }
        if l > 0.35 * low_ref {
            low_ok += 1;
        }
        intro_beats += 1;
    }
    // Calé sur la mesure (4 temps).
    intro_beats -= intro_beats % 4;
    let beat_present = intro_beats > 0 && low_ok as f64 >= intro_beats as f64 * 0.75;
    Ok(Grid {
        bpm,
        offset,
        duration,
        intro_end: (intro_beats > 0).then(|| offset + intro_beats as f64 * beat),
        intro_beats,
        dj_intro: beat_present && intro_beats >= 16,
    })
}

pub fn grid(path: &Path, bpm_hint: Option<f64>) -> Result<Grid> {
    let (samples, sr) = decode_mono(path)?;
    grid_samples(&samples, sr, bpm_hint)
}

#[cfg(test)]
mod grid_tests {
    use super::*;

    /// 32 temps de kick seul, puis kick + nappe médium : intro DJ de 32 temps.
    #[test]
    fn finds_offset_and_dj_intro() {
        let sr = 22050u32;
        let bpm = 125.0;
        let beat = 60.0 / bpm;
        let first = 0.21;
        let secs = 60.0;
        let n = (secs * sr as f64) as usize;
        let mut x = vec![0f32; n];
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f64 / sr as f64;
            if t >= first {
                let since = (t - first) % beat;
                if since < 0.12 {
                    *v += (0.9 * (-since * 30.0).exp() * (2.0 * std::f64::consts::PI * 55.0 * since).sin()) as f32;
                }
            }
            if t >= first + 32.0 * beat {
                *v += (0.3 * (2.0 * std::f64::consts::PI * 880.0 * t).sin() + 0.2 * (2.0 * std::f64::consts::PI * 1320.0 * t).sin()) as f32;
            }
        }
        let g = grid_samples(&x, sr, Some(bpm)).unwrap();
        let err = ((g.offset - first).abs()).min(beat - (g.offset - first).abs());
        assert!(err < 0.03, "offset {} au lieu de {first}", g.offset);
        assert!(g.dj_intro, "{g:?}");
        assert!((28..=32).contains(&g.intro_beats), "{g:?}");
    }

    /// Kick + charley sur les contretemps, plusieurs décalages : erreur < 10 ms.
    #[test]
    fn offset_is_precise() {
        let sr = 44100u32;
        for (bpm, first) in [(124.0, 0.0), (128.0, 0.137), (174.0, 0.301), (95.0, 0.55)] {
            let beat = 60.0 / bpm;
            let n = (40.0 * sr as f64) as usize;
            let mut rng = 12345u32;
            let x: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f64 / sr as f64;
                    let mut v = 0.0;
                    if t >= first {
                        let k = (t - first) % beat;
                        let f = 50.0 + 100.0 * (-k * 40.0).exp();
                        v += 0.9 * (-k * 25.0).exp() * (2.0 * std::f64::consts::PI * f * k).sin();
                        let h = (t - first + beat / 2.0) % beat;
                        rng = rng.wrapping_mul(1664525).wrapping_add(1013904223);
                        let noise = (rng >> 8) as f64 / (1u32 << 24) as f64 - 0.5;
                        v += 0.3 * (-h * 120.0).exp() * noise;
                    }
                    v as f32
                })
                .collect();
            let g = grid_samples(&x, sr, Some(bpm)).unwrap();
            let d = (g.offset - first).rem_euclid(beat);
            let err = d.min(beat - d);
            eprintln!("bpm {bpm} first {first} -> {:.4} (err {:.1} ms)", g.offset, err * 1000.0);
            assert!(err < 0.010, "bpm {bpm}: offset {} au lieu de {first}", g.offset);
        }
    }
}
