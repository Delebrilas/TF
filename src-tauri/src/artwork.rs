//! Pochette générée quand un morceau n'en a pas : dégradé aux couleurs
//! dérivées du titre, et anneaux dont l'espacement suit le BPM.

const SIZE: u32 = 600;

fn hash(s: &str) -> u64 {
    // FNV-1a : stable d'une version à l'autre.
    s.bytes().fold(0xcbf29ce484222325u64, |h, b| (h ^ b as u64).wrapping_mul(0x100000001b3))
}

fn hsl(h: f64, s: f64, l: f64) -> [f64; 3] {
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hp = (h.rem_euclid(360.0)) / 60.0;
    let x = c * (1.0 - (hp % 2.0 - 1.0).abs());
    let (r, g, b) = match hp as u32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    [r + m, g + m, b + m]
}

/// PNG 600×600.
pub fn generate(title: &str, artist: &str, bpm: Option<f64>) -> Option<Vec<u8>> {
    let h = hash(&format!("{artist}|{title}"));
    let hue1 = (h % 360) as f64;
    let hue2 = hue1 + 40.0 + ((h >> 16) % 80) as f64;
    let c1 = hsl(hue1, 0.75, 0.55);
    let c2 = hsl(hue2, 0.80, 0.35);
    let accent = hsl(hue1 + 180.0, 0.9, 0.7);
    // Plus le tempo est rapide, plus les anneaux sont serrés.
    let spacing = 3600.0 / bpm.unwrap_or(120.0).clamp(60.0, 200.0);
    let (cx, cy) = (
        SIZE as f64 * (0.25 + ((h >> 24) % 50) as f64 / 100.0),
        SIZE as f64 * (0.25 + ((h >> 32) % 50) as f64 / 100.0),
    );

    let mut data = Vec::with_capacity((SIZE * SIZE * 3) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let t = (x + y) as f64 / (2.0 * SIZE as f64);
            let mut px = [0.0; 3];
            for i in 0..3 {
                px[i] = c1[i] * (1.0 - t) + c2[i] * t;
            }
            let d = ((x as f64 - cx).powi(2) + (y as f64 - cy).powi(2)).sqrt();
            let ring = (d / spacing * std::f64::consts::TAU).cos();
            let fade = (1.0 - d / (SIZE as f64 * 0.9)).clamp(0.0, 1.0);
            let a = (ring.max(0.0).powf(12.0) * 0.55 * fade).clamp(0.0, 1.0);
            for i in 0..3 {
                px[i] = px[i] * (1.0 - a) + accent[i] * a;
            }
            data.extend(px.iter().map(|v| (v.clamp(0.0, 1.0) * 255.0) as u8));
        }
    }
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, SIZE, SIZE);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut w = enc.write_header().ok()?;
        w.write_image_data(&data).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    #[test]
    fn makes_png() {
        let png = super::generate("One More Time", "Daft Punk", Some(123.0)).unwrap();
        assert!(png.starts_with(&[0x89, b'P', b'N', b'G']));
        assert_eq!(png, super::generate("One More Time", "Daft Punk", Some(123.0)).unwrap());
    }
}
