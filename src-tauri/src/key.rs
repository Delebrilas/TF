//! Détection de la tonalité, rendue en notation Camelot (ex. 8A).
//!
//! Chromagramme (FFT 8192 points sur le signal ~11 kHz, 65 Hz → 2,1 kHz)
//! comparé aux 24 profils de tonalité de KeyFinder (Ibrahim Sha'ath),
//! calibrés sur de la musique électronique.

use rustfft::{num_complex::Complex, FftPlanner};
use serde::{Deserialize, Serialize};

const N: usize = 8192;
const HOP: usize = 4096;
const MAJOR: [f64; 12] = [6.6, 2.0, 3.5, 2.3, 4.6, 4.0, 2.5, 5.2, 2.4, 3.7, 2.3, 3.4];
const MINOR: [f64; 12] = [6.5, 2.7, 3.5, 5.4, 2.6, 3.5, 2.5, 5.2, 4.0, 2.7, 4.3, 3.2];
const NAMES: [&str; 12] = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
/// Numéro Camelot de chaque tonique, en majeur (B) et en mineur (A).
const CAMELOT_MAJOR: [u8; 12] = [8, 3, 10, 5, 12, 7, 2, 9, 4, 11, 6, 1];
const CAMELOT_MINOR: [u8; 12] = [5, 12, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Key {
    /// Notation Camelot, ex. « 8A ».
    pub camelot: String,
    /// Notation classique, ex. « Am ».
    pub name: String,
    /// Écart entre la meilleure et la deuxième tonalité (0..1).
    pub confidence: f64,
}

pub fn key_from(tonic: usize, minor: bool, confidence: f64) -> Key {
    let (num, letter) = if minor { (CAMELOT_MINOR[tonic], 'A') } else { (CAMELOT_MAJOR[tonic], 'B') };
    Key {
        camelot: format!("{num}{letter}"),
        name: format!("{}{}", NAMES[tonic], if minor { "m" } else { "" }),
        confidence,
    }
}

fn chroma(x: &[f32], sr: f64) -> [f64; 12] {
    let window: Vec<f32> = (0..N)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / N as f32).cos())
        .collect();
    let fft = FftPlanner::<f32>::new().plan_fft_forward(N);
    // Classe de hauteur de chaque case FFT utile.
    let bins: Vec<(usize, usize)> = (1..N / 2)
        .filter_map(|k| {
            let f = k as f64 * sr / N as f64;
            if !(65.0..=2100.0).contains(&f) {
                return None;
            }
            let midi = 69.0 + 12.0 * (f / 440.0).log2();
            Some((k, (midi.round() as i64).rem_euclid(12) as usize))
        })
        .collect();
    let mut total = [0f64; 12];
    let mut buf = vec![Complex::new(0f32, 0f32); N];
    let mut off = 0;
    while off + N <= x.len() {
        for i in 0..N {
            buf[i] = Complex::new(x[off + i] * window[i], 0.0);
        }
        fft.process(&mut buf);
        let mut frame = [0f64; 12];
        for &(k, pc) in &bins {
            frame[pc] += buf[k].norm() as f64;
        }
        // Chaque trame pèse pareil : les passages forts ne dominent pas.
        let max = frame.iter().cloned().fold(0.0, f64::max);
        if max > 1e-6 {
            for pc in 0..12 {
                total[pc] += frame[pc] / max;
            }
        }
        off += HOP;
    }
    total
}

fn correlation(a: &[f64; 12], b: &[f64]) -> f64 {
    let ma = a.iter().sum::<f64>() / 12.0;
    let mb = b.iter().sum::<f64>() / 12.0;
    let (mut num, mut da, mut db) = (0.0, 0.0, 0.0);
    for i in 0..12 {
        num += (a[i] - ma) * (b[i] - mb);
        da += (a[i] - ma).powi(2);
        db += (b[i] - mb).powi(2);
    }
    if da * db <= 0.0 {
        0.0
    } else {
        num / (da * db).sqrt()
    }
}

/// `x` : signal mono ; `sr` : sa fréquence d'échantillonnage.
pub fn detect(x: &[f32], sr: f64) -> Option<Key> {
    let c = chroma(x, sr);
    if c.iter().sum::<f64>() <= 0.0 {
        return None;
    }
    let mut scores: Vec<(f64, usize, bool)> = Vec::with_capacity(24);
    for tonic in 0..12 {
        for (minor, profile) in [(false, &MAJOR), (true, &MINOR)] {
            // Profil tourné sur la tonique.
            let rotated: Vec<f64> = (0..12).map(|i| profile[(i + 12 - tonic) % 12]).collect();
            scores.push((correlation(&c, &rotated), tonic, minor));
        }
    }
    scores.sort_by(|a, b| b.0.total_cmp(&a.0));
    let (best, tonic, minor) = scores[0];
    if best <= 0.1 {
        return None;
    }
    Some(key_from(tonic, minor, (best - scores[1].0).clamp(0.0, 1.0)))
}

/// Parse « 8A », « 12b »…
pub fn parse_camelot(s: &str) -> Option<(u8, bool)> {
    let s = s.trim().to_uppercase();
    let (num, letter) = s.split_at(s.len().checked_sub(1)?);
    let n: u8 = num.parse().ok()?;
    let minor = match letter {
        "A" => true,
        "B" => false,
        _ => return None,
    };
    (1..=12).contains(&n).then_some((n, minor))
}

/// Convertit un TKEY (« 8A », « Am », « F#m », « Dbmaj »…) en Camelot.
pub fn to_camelot(s: &str) -> Option<String> {
    let t = s.trim();
    if let Some((n, minor)) = parse_camelot(t) {
        return Some(format!("{n}{}", if minor { 'A' } else { 'B' }));
    }
    let lower = t.to_lowercase();
    let minor = lower.ends_with('m') && !lower.ends_with("maj") || lower.contains("min");
    let root: String = t.chars().take_while(|c| !c.is_whitespace()).collect();
    let mut chars = root.chars();
    let letter = chars.next()?.to_ascii_uppercase();
    let base = match letter {
        'C' => 0, 'D' => 2, 'E' => 4, 'F' => 5, 'G' => 7, 'A' => 9, 'B' => 11,
        _ => return None,
    };
    let acc = match chars.next() {
        Some('#') | Some('♯') => 1,
        Some('b') | Some('♭') => -1,
        _ => 0,
    };
    let tonic = ((base + acc) as i32).rem_euclid(12) as usize;
    Some(key_from(tonic, minor, 0.0).camelot)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Progression I–IV–V–I (ou i–iv–v–i) en notes tenues avec harmoniques.
    fn progression(tonic_midi: f64, minor: bool, sr: f64) -> Vec<f32> {
        let third = if minor { 3.0 } else { 4.0 };
        let chords = [[0.0, third, 7.0], [5.0, 5.0 + third, 12.0], [7.0, 11.0, 14.0], [0.0, third, 7.0]];
        let mut out = Vec::new();
        for _ in 0..4 {
            for ch in &chords {
                for i in 0..(sr * 2.0) as usize {
                    let t = i as f64 / sr;
                    let mut v = 0.0;
                    for &st in ch.iter().chain(std::iter::once(&-12.0)) {
                        let f = 440.0 * 2f64.powf((tonic_midi + st - 69.0) / 12.0);
                        for h in 1..4 {
                            v += (2.0 * std::f64::consts::PI * f * h as f64 * t).sin() / (h * h) as f64;
                        }
                    }
                    out.push((v * 0.1) as f32);
                }
            }
        }
        out
    }

    #[test]
    fn detects_keys() {
        let sr = 11025.0;
        for (midi, minor, want) in [(57.0, true, "8A"), (60.0, false, "8B"), (55.0, false, "9B"), (62.0, true, "7A"), (66.0, true, "11A")] {
            let k = detect(&progression(midi, minor, sr), sr).unwrap();
            assert_eq!(k.camelot, want, "{} détecté pour {want}", k.name);
        }
    }

    #[test]
    fn conversions() {
        assert_eq!(to_camelot("Am").as_deref(), Some("8A"));
        assert_eq!(to_camelot("8a").as_deref(), Some("8A"));
        assert_eq!(to_camelot("F#m").as_deref(), Some("11A"));
        assert_eq!(to_camelot("Db").as_deref(), Some("3B"));
        assert_eq!(to_camelot("C minor").as_deref(), Some("5A"));
        assert_eq!(to_camelot("xyz"), None);
    }
}
