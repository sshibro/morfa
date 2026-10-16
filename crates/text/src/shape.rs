//! Shaping with harfrust over the font store: text split into runs by the face each character takes
//! (CSS `unicode-range` then `cmap`, as Blink does with the family's subset files), each run shaped at
//! the face's weight instance, advances scaled to px. `ShapingMeasurer` is the `Measurer` real fonts give
//! the layout; `shape` is what the renderer draws from.

use std::collections::HashMap;

use harfrust::{Buffer, ShapeOptions, ShaperFont};

use crate::font::{FaceId, FontStore, chrome_metric};
use crate::measure::{Measurer, Metrics};
use crate::types::FontSpec;

/// One positioned glyph of a shaped text, in px relative to the text's origin on the baseline.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Glyph {
    pub face: FaceId,
    pub id: u32,
    pub x: f64,
    /// Up is positive, as in the font.
    pub y: f64,
    /// UTF-16 offset of the glyph's cluster in the shaped text.
    pub cluster: u32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Shaped {
    pub glyphs: Vec<Glyph>,
    pub advance: f64,
    /// Some character had no glyph in any face of the group: Chrome would draw it from a fallback font,
    /// so the renderer keeps `fillText` for this run.
    pub missing: bool,
}

/// Distinct (face, weight, size, text) results kept before the table starts over.
const MAX_CACHED_SHAPES: usize = 50_000;

#[derive(Default)]
pub struct Shaper {
    pub store: FontStore,
    cache: HashMap<(Vec<FaceId>, u64, u64, Vec<u16>), Shaped>,
}

/// Decodes UTF-16 to code points with their unit offsets; a lone surrogate is U+FFFD and one unit wide.
fn code_points(text: &[u16]) -> Vec<(u32, u32)> {
    let mut out = Vec::with_capacity(text.len());
    let mut unit = 0u32;
    for item in char::decode_utf16(text.iter().copied()) {
        match item {
            Ok(c) => {
                out.push((c as u32, unit));
                unit += c.len_utf16() as u32;
            }
            Err(_) => {
                out.push((0xfffd, unit));
                unit += 1;
            }
        }
    }
    out
}

impl Shaper {
    pub fn new() -> Self {
        Self::default()
    }

    /// The face of `group` that draws `cp`: the first whose range holds it and that has a glyph, else the
    /// first whose range holds it (its `.notdef` stands in), else None.
    fn face_for(&self, group: &[FaceId], cp: u32) -> Option<FaceId> {
        let mut in_range = None;
        for &id in group {
            let face = self.store.face(id);
            if face.in_range(cp) {
                if face.glyph_index(cp).is_some() {
                    return Some(id);
                }
                in_range.get_or_insert(id);
            }
        }
        in_range
    }

    /// Shapes `text` as `spec` would draw it; None when the family has no face loaded.
    pub fn shape(&mut self, text: &[u16], spec: &FontSpec) -> Option<&Shaped> {
        let group = self.store.group(spec);
        if group.is_empty() {
            return None;
        }
        let key = (
            group.clone(),
            spec.weight.to_bits(),
            spec.size.to_bits(),
            text.to_vec(),
        );
        if !self.cache.contains_key(&key) {
            let shaped = self.shape_uncached(&group, text, spec);
            if self.cache.len() >= MAX_CACHED_SHAPES {
                self.cache.clear();
            }
            self.cache.insert(key.clone(), shaped);
        }
        self.cache.get(&key)
    }

    fn shape_uncached(&mut self, group: &[FaceId], text: &[u16], spec: &FontSpec) -> Shaped {
        let points = code_points(text);
        let mut shaped = Shaped::default();
        let mut i = 0;
        let mut pen = 0.0;
        while i < points.len() {
            let (cp, _) = points[i];
            let face = self.face_for(group, cp).unwrap_or(group[0]);
            let mut j = i + 1;
            while j < points.len() && self.face_for(group, points[j].0).unwrap_or(group[0]) == face
            {
                j += 1;
            }
            let run = &points[i..j];
            let any_missing = run
                .iter()
                .any(|&(cp, _)| self.store.face(face).glyph_index(cp).is_none());
            shaped.missing |= any_missing;
            pen = self.shape_run(face, run, spec, pen, &mut shaped.glyphs);
            i = j;
        }
        shaped.advance = pen;
        shaped
    }

    /// Shapes one run in one face from `pen`; returns the pen after it.
    fn shape_run(
        &mut self,
        face_id: FaceId,
        run: &[(u32, u32)],
        spec: &FontSpec,
        pen: f64,
        out: &mut Vec<Glyph>,
    ) -> f64 {
        let face = self.store.face_mut(face_id);
        let upem = face.upem;
        let scale = spec.size / upem;
        let instance = face.instance(spec.weight);
        let shaper = ShaperFont::new(&instance.font);
        let mut buffer = Buffer::new();
        for &(cp, unit) in run {
            buffer.push(cp, unit);
        }
        buffer.guess_segment_properties();
        if harfrust::shape(&shaper, &mut buffer, ShapeOptions::new()).is_err() {
            return pen;
        }
        let mut x = pen;
        for (info, pos) in buffer.glyph_infos().iter().zip(buffer.glyph_positions()) {
            out.push(Glyph {
                face: face_id,
                id: info.glyph_id,
                x: x + pos.x_offset as f64 * scale,
                y: pos.y_offset as f64 * scale,
                cluster: info.cluster,
            });
            x += pos.x_advance as f64 * scale;
        }
        x
    }

    /// Chrome's `fontBoundingBoxAscent/Descent` for `spec`: the group's first face, rounded to whole px.
    pub fn metrics(&self, spec: &FontSpec) -> Option<Metrics> {
        let group = self.store.group(spec);
        let face = self.store.face(*group.first()?);
        Some(Metrics {
            ascent: chrome_metric(face.ascender, spec.size, face.upem),
            descent: chrome_metric(face.descender, spec.size, face.upem),
        })
    }
}

/// `Measurer` over the store: widths are shaped advances; a family without faces measures NaN (the
/// caller falls back to the browser).
pub struct ShapingMeasurer<'a>(pub &'a mut Shaper);

impl Measurer for ShapingMeasurer<'_> {
    fn width(&mut self, text: &[u16], font: &FontSpec) -> f64 {
        self.0.shape(text, font).map_or(f64::NAN, |s| s.advance)
    }

    fn metrics(&mut self, font: &FontSpec) -> Metrics {
        self.0.metrics(font).unwrap_or(Metrics {
            ascent: f64::NAN,
            descent: f64::NAN,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inter() -> Option<Shaper> {
        let root =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../public/fonts/inter");
        let cyr = std::fs::read(root.join("inter-cyrillic-wght-normal.woff2")).ok()?;
        let lat = std::fs::read(root.join("inter-latin-wght-normal.woff2")).ok()?;
        let mut shaper = Shaper::new();
        shaper.store.add_face(
            "Inter",
            100.0,
            900.0,
            false,
            "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
            &cyr,
        )?;
        shaper.store.add_face("Inter", 100.0, 900.0, false, "U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD", &lat)?;
        Some(shaper)
    }

    #[test]
    #[cfg(feature = "woff2")]
    fn shapes_across_subset_files_with_variable_kerning() {
        // Needs the fonts copied by scripts/copy-fonts.ts; skipped silently in a bare checkout.
        let Some(mut shaper) = inter() else { return };
        let spec = FontSpec {
            family: "Inter".into(),
            weight: 700.0,
            italic: false,
            size: 1000.0,
        };
        // Chrome: "Sphinx of black quartz, judge my vow." = 37 902.8 units at 2048 upem (docs/decisions/text-shaper.md).
        let text: Vec<u16> = "Sphinx of black quartz, judge my vow."
            .encode_utf16()
            .collect();
        let shaped = shaper.shape(&text, &spec).unwrap().clone();
        assert!(
            (shaped.advance / 1000.0 * 2048.0 - 37902.0).abs() < 2.0,
            "{}",
            shaped.advance
        );
        assert!(!shaped.missing);
        // Cyrillic letters and the space come from two files; the space's advance is the latin file's.
        let mixed: Vec<u16> = "Съешь же".encode_utf16().collect();
        let shaped = shaper.shape(&mixed, &spec).unwrap().clone();
        assert!(!shaped.missing);
        let faces: std::collections::HashSet<u32> = shaped.glyphs.iter().map(|g| g.face).collect();
        assert_eq!(faces.len(), 2);
        let metrics = shaper.metrics(&spec).unwrap();
        assert_eq!((metrics.ascent, metrics.descent), (969.0, 241.0));
        let emoji: Vec<u16> = "a😀".encode_utf16().collect();
        assert!(shaper.shape(&emoji, &spec).unwrap().missing);
    }
}
