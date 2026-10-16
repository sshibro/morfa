//! Measuring: the `Measurer` trait (the Rust twin of `TextMeasurer`) and the width cache of
//! `shared/design/text-layout.ts` (`FontEntry`, `measure`, `measureCode`), kept call for call so a layout
//! asks the measurer exactly as often as the TypeScript one does.

use rustc_hash::FxHashMap as HashMap;

use crate::types::{FontSpec, TextStyle};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Metrics {
    pub ascent: f64,
    pub descent: f64,
}

/// Measures text in a face: the browser's canvas, a shaper, or a test fake.
pub trait Measurer {
    /// Advance width in px of `text` set in `font`, without letter spacing.
    fn width(&mut self, text: &[u16], font: &FontSpec) -> f64;
    /// Ascent above and descent below the baseline in px, both positive.
    fn metrics(&mut self, font: &FontSpec) -> Metrics;
}

/// A face with what was measured in it.
#[derive(Clone, Debug)]
pub struct FontEntry {
    pub spec: FontSpec,
    pub widths: HashMap<Vec<u16>, f64>,
    pub codes: HashMap<u16, f64>,
    pub ascent: f64,
    pub descent: f64,
}

/// Distinct strings remembered per face before the face's table starts over.
pub const MAX_CACHED_WIDTHS: usize = 50_000;

/// The faces measured so far: one entry per (family, size, weight, italic), as the TypeScript `FontTable`,
/// addressed by index so the layout carries a `Copy` id.
#[derive(Default, Debug)]
pub struct MeasureCache {
    entries: Vec<FontEntry>,
    index: HashMap<(String, u64, u64), u32>,
}

pub type FontId = u32;

pub fn finite(value: f64) -> f64 {
    if value.is_finite() { value } else { 0.0 }
}

impl MeasureCache {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.index.clear();
    }

    /// The entry for `style`'s face, measuring its metrics once.
    pub fn font_entry(&mut self, measurer: &mut dyn Measurer, style: &TextStyle) -> FontId {
        let size = style.font_size;
        let face = (style.font_weight * 2.0 + if style.italic { 1.0 } else { 0.0 }).to_bits();
        let key = (style.font_family.clone(), size.to_bits(), face);
        if let Some(&id) = self.index.get(&key) {
            return id;
        }
        let spec = FontSpec {
            family: style.font_family.clone(),
            weight: style.font_weight,
            italic: style.italic,
            size,
        };
        let metrics = measurer.metrics(&spec);
        let id = self.entries.len() as FontId;
        self.entries.push(FontEntry {
            spec,
            widths: HashMap::default(),
            codes: HashMap::default(),
            ascent: finite(metrics.ascent),
            descent: finite(metrics.descent),
        });
        self.index.insert(key, id);
        id
    }

    pub fn entry(&self, id: FontId) -> &FontEntry {
        &self.entries[id as usize]
    }

    /// Width of `text` in the face, from the cache or the measurer.
    pub fn measure(&mut self, measurer: &mut dyn Measurer, id: FontId, text: &[u16]) -> f64 {
        if text.is_empty() {
            return 0.0;
        }
        let entry = &self.entries[id as usize];
        if let Some(&width) = entry.widths.get(text) {
            return width;
        }
        let width = finite(measurer.width(text, &entry.spec));
        let entry = &mut self.entries[id as usize];
        if entry.widths.len() >= MAX_CACHED_WIDTHS {
            entry.widths.clear();
        }
        entry.widths.insert(text.to_vec(), width);
        width
    }

    /// Width of one UTF-16 code unit in the face.
    pub fn measure_code(&mut self, measurer: &mut dyn Measurer, id: FontId, code: u16) -> f64 {
        let entry = &self.entries[id as usize];
        if let Some(&width) = entry.codes.get(&code) {
            return width;
        }
        let width = finite(measurer.width(&[code], &entry.spec));
        self.entries[id as usize].codes.insert(code, width);
        width
    }
}

/// The deterministic measurer of the TypeScript tests (`tests/helpers/design-big-files.ts`): every code
/// unit half an em, ascent 0.8 em, descent 0.2 em.
pub struct FixedMeasurer;

impl Measurer for FixedMeasurer {
    fn width(&mut self, text: &[u16], font: &FontSpec) -> f64 {
        text.len() as f64 * font.size * 0.5
    }
    fn metrics(&mut self, font: &FontSpec) -> Metrics {
        Metrics {
            ascent: font.size * 0.8,
            descent: font.size * 0.2,
        }
    }
}
