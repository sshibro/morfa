//! The font store: decoded faces (woff2 → sfnt with `wuff`), one `harfrust::Font` and one skrifa
//! `FontRef` per face sharing the bytes, instances per weight of a variable face, and CSS-style
//! matching: a `FontSpec`'s weight and slant pick a face group, the character picks the face inside it
//! by `unicode-range` and `cmap`, as Blink does with the two subset files `src/design/engine/fonts.ts`
//! registers per family.

use std::collections::HashMap;
use std::sync::Arc;

use harfrust::Font;
use skrifa::instance::Location;
use skrifa::raw::TableProvider;
use skrifa::{FontRef, MetadataProvider};

use crate::types::FontSpec;

pub type FaceId = u32;

/// Chrome rounds a face's ascent and descent to whole px (`SimpleFontData::PlatformInit`), except for
/// tiny faces: this reproduces `fontBoundingBoxAscent/Descent` of `measureText`.
pub fn chrome_metric(units: f64, size: f64, upem: f64) -> f64 {
    let value = units * size / upem;
    (value + 0.5).floor()
}

#[derive(Clone)]
pub struct Instance {
    pub font: Font,
    pub location: Location,
}

pub struct Face {
    pub id: FaceId,
    pub family: String,
    /// CSS weight range of the face descriptor (a static face: min = max).
    pub weight: (f64, f64),
    pub italic: bool,
    /// `unicode-range` as inclusive code point ranges; empty: everything.
    pub ranges: Vec<(u32, u32)>,
    pub data: Arc<Vec<u8>>,
    pub upem: f64,
    /// Ascender and descender (positive) in font units, as Chrome reads them: OS/2 typo when
    /// USE_TYPO_METRICS is set, else hhea.
    pub ascender: f64,
    pub descender: f64,
    pub wght_axis: Option<(f32, f32)>,
    base: Font,
    instances: HashMap<u32, Instance>,
}

impl Face {
    /// The face at `weight` (clamped to the axis; the default instance for a static face).
    pub fn instance(&mut self, weight: f64) -> &Instance {
        let key = match self.wght_axis {
            Some((min, max)) => (weight as f32).clamp(min, max).to_bits(),
            None => 0,
        };
        if !self.instances.contains_key(&key) {
            let (font, location) = match self.wght_axis {
                Some(_) => {
                    let w = f32::from_bits(key);
                    let font = self
                        .base
                        .instance_builder()
                        .variations([("wght", w)])
                        .build();
                    let location = self.font_ref().axes().location([("wght", w)]);
                    (font, location)
                }
                None => (self.base.clone(), Location::default()),
            };
            self.instances.insert(key, Instance { font, location });
        }
        &self.instances[&key]
    }

    pub fn font_ref(&self) -> FontRef<'_> {
        FontRef::new(&self.data).expect("validated at registration")
    }

    pub fn glyph_index(&self, cp: u32) -> Option<u32> {
        self.font_ref().charmap().map(cp).map(|g| g.to_u32())
    }

    pub fn covers(&self, cp: u32) -> bool {
        (self.ranges.is_empty() || self.ranges.iter().any(|&(a, b)| cp >= a && cp <= b))
            && self.glyph_index(cp).is_some()
    }

    pub fn in_range(&self, cp: u32) -> bool {
        self.ranges.is_empty() || self.ranges.iter().any(|&(a, b)| cp >= a && cp <= b)
    }
}

#[derive(Default)]
pub struct FontStore {
    faces: Vec<Face>,
    families: HashMap<String, Vec<FaceId>>,
}

/// `U+0400-045F, U+2116` → inclusive ranges; unparsable pieces are skipped.
pub fn parse_unicode_range(text: &str) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    for piece in text.split(',') {
        let piece = piece.trim();
        let Some(hex) = piece
            .strip_prefix("U+")
            .or_else(|| piece.strip_prefix("u+"))
        else {
            continue;
        };
        let (a, b) = match hex.split_once('-') {
            Some((a, b)) => (a, b),
            None => (hex, hex),
        };
        if a.contains('?') {
            let lo = u32::from_str_radix(&a.replace('?', "0"), 16);
            let hi = u32::from_str_radix(&a.replace('?', "F"), 16);
            if let (Ok(lo), Ok(hi)) = (lo, hi) {
                out.push((lo, hi));
            }
            continue;
        }
        if let (Ok(lo), Ok(hi)) = (u32::from_str_radix(a, 16), u32::from_str_radix(b, 16)) {
            out.push((lo, hi));
        }
    }
    out
}

fn decode(bytes: &[u8]) -> Option<Vec<u8>> {
    if bytes.starts_with(b"wOF2") {
        #[cfg(feature = "woff2")]
        return wuff::decompress_woff2(bytes).ok();
        #[cfg(not(feature = "woff2"))]
        return None;
    }
    Some(bytes.to_vec())
}

impl FontStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a face file (sfnt or woff2) of `family` under its CSS descriptors; returns its id, or
    /// None when the bytes are not a font.
    pub fn add_face(
        &mut self,
        family: &str,
        weight_min: f64,
        weight_max: f64,
        italic: bool,
        unicode_range: &str,
        bytes: &[u8],
    ) -> Option<FaceId> {
        let data = Arc::new(decode(bytes)?);
        let font_ref = FontRef::new(&data).ok()?;
        let upem = font_ref.head().ok()?.units_per_em() as f64;
        let (ascender, descender) = {
            let hhea = font_ref.hhea().ok();
            let os2 = font_ref.os2().ok();
            let use_typo = os2.as_ref().is_some_and(|t| {
                t.fs_selection()
                    .contains(skrifa::raw::tables::os2::SelectionFlags::USE_TYPO_METRICS)
            });
            match (use_typo, os2, hhea) {
                (true, Some(os2), _) => (
                    os2.s_typo_ascender() as f64,
                    -(os2.s_typo_descender() as f64),
                ),
                (_, _, Some(hhea)) => (
                    hhea.ascender().to_i16() as f64,
                    -(hhea.descender().to_i16() as f64),
                ),
                (_, Some(os2), None) => (
                    os2.s_typo_ascender() as f64,
                    -(os2.s_typo_descender() as f64),
                ),
                _ => (upem * 0.8, upem * 0.2),
            }
        };
        let wght_axis = font_ref
            .axes()
            .iter()
            .find(|a| a.tag() == skrifa::Tag::new(b"wght"))
            .map(|a| (a.min_value(), a.max_value()));
        let shared: Arc<dyn AsRef<[u8]> + Send + Sync> = data.clone();
        let base = Font::new(shared, 0)?;
        let id = self.faces.len() as FaceId;
        self.faces.push(Face {
            id,
            family: family.to_string(),
            weight: (weight_min.min(weight_max), weight_min.max(weight_max)),
            italic,
            ranges: parse_unicode_range(unicode_range),
            data,
            upem,
            ascender,
            descender,
            wght_axis,
            base,
            instances: HashMap::new(),
        });
        self.families
            .entry(family.to_string())
            .or_default()
            .push(id);
        Some(id)
    }

    pub fn face(&self, id: FaceId) -> &Face {
        &self.faces[id as usize]
    }

    pub fn face_mut(&mut self, id: FaceId) -> &mut Face {
        &mut self.faces[id as usize]
    }

    pub fn has_family(&self, family: &str) -> bool {
        self.families.contains_key(family)
    }

    pub fn len(&self) -> usize {
        self.faces.len()
    }

    pub fn is_empty(&self) -> bool {
        self.faces.is_empty()
    }

    /// The faces a spec draws with, in registration order: the slant's faces (upright when the family
    /// has no italic), then the weight descriptor CSS matching picks (`nearestWeight` in fonts.ts).
    pub fn group(&self, spec: &FontSpec) -> Vec<FaceId> {
        let Some(ids) = self.families.get(&spec.family) else {
            return Vec::new();
        };
        let styled: Vec<FaceId> = ids
            .iter()
            .copied()
            .filter(|&id| self.faces[id as usize].italic == spec.italic)
            .collect();
        let pool: Vec<FaceId> = if styled.is_empty() {
            ids.clone()
        } else {
            styled
        };
        // A face whose range covers the weight matches exactly.
        let covering: Vec<FaceId> = pool
            .iter()
            .copied()
            .filter(|&id| {
                let (a, b) = self.faces[id as usize].weight;
                spec.weight >= a && spec.weight <= b
            })
            .collect();
        if !covering.is_empty() {
            return covering;
        }
        let weights: Vec<f64> = pool
            .iter()
            .map(|&id| self.faces[id as usize].weight.0)
            .collect();
        let best = nearest_weight(&weights, spec.weight);
        pool.into_iter()
            .filter(|&id| self.faces[id as usize].weight.0 == best)
            .collect()
    }
}

/// The face CSS font matching picks for `desired` among `available` weights (CSS Fonts 4 §5.2), as
/// `nearestWeight` in src/design/engine/fonts.ts.
pub fn nearest_weight(available: &[f64], desired: f64) -> f64 {
    if available.is_empty() {
        return desired;
    }
    let mut sorted: Vec<f64> = available.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    sorted.dedup();
    if sorted.contains(&desired) {
        return desired;
    }
    let below: Vec<f64> = sorted
        .iter()
        .copied()
        .filter(|&w| w < desired)
        .rev()
        .collect();
    let above: Vec<f64> = sorted.iter().copied().filter(|&w| w > desired).collect();
    if (400.0..=500.0).contains(&desired) {
        if let Some(&w) = above.iter().find(|&&w| w <= 500.0) {
            return w;
        }
        if let Some(&w) = below.first() {
            return w;
        }
        return above[0];
    }
    if desired < 400.0 {
        return below.first().copied().unwrap_or(above[0]);
    }
    above.first().copied().unwrap_or(below[0])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn weight_matching_follows_css() {
        assert_eq!(nearest_weight(&[300.0, 400.0, 700.0], 400.0), 400.0);
        assert_eq!(nearest_weight(&[400.0, 700.0], 450.0), 400.0);
        assert_eq!(nearest_weight(&[300.0, 500.0, 700.0], 450.0), 500.0);
        assert_eq!(nearest_weight(&[300.0, 600.0], 500.0), 300.0);
        assert_eq!(nearest_weight(&[400.0, 700.0], 300.0), 400.0);
        assert_eq!(nearest_weight(&[200.0, 400.0], 300.0), 200.0);
        assert_eq!(nearest_weight(&[300.0, 400.0], 700.0), 400.0);
        assert_eq!(nearest_weight(&[400.0, 600.0, 800.0], 700.0), 800.0);
        assert_eq!(nearest_weight(&[], 500.0), 500.0);
    }

    #[test]
    fn unicode_ranges_parse() {
        assert_eq!(
            parse_unicode_range("U+0301, U+0400-045F, U+2116"),
            vec![(0x301, 0x301), (0x400, 0x45f), (0x2116, 0x2116)]
        );
        assert_eq!(parse_unicode_range("U+4??"), vec![(0x400, 0x4ff)]);
        assert!(parse_unicode_range("").is_empty());
    }

    #[test]
    fn chrome_rounds_metrics_to_whole_px() {
        assert_eq!(chrome_metric(1984.0, 1000.0, 2048.0), 969.0);
        assert_eq!(chrome_metric(494.0, 1000.0, 2048.0), 241.0);
    }
}
