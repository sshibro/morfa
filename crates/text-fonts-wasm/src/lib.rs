//! `morfa-text-fonts-wasm`: lane L3's second module — the font store, harfrust shaping and skrifa glyph
//! outlines (`text_add_face`, `text_width`, `text_metrics`, `text_shape`, `text_glyph_path`). Apart from
//! the layout module (`morfa-text-wasm`) because harfrust and skrifa are most of the bytes: the editor loads
//! it when it first draws or measures with a loaded face (`scripts/wasm-text-build.sh` → `src/design/wasm-fonts/`).

use std::cell::RefCell;

use morfa_text::glyph::glyph_path;
use morfa_text::shape::Shaper;
use morfa_text::types::FontSpec;
use wasm_bindgen::prelude::*;

thread_local! {
    static SHAPER: RefCell<Shaper> = RefCell::new(Shaper::new());
}

/// The module's version, as the build script's smoke test reads it.
#[wasm_bindgen]
pub fn fonts_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

// ── Fonts, shaping and glyph outlines ──────────────────────────────────────────────────────────

/// Registers a face file (sfnt or woff2) under its CSS descriptors; returns its id, or -1 when the bytes
/// are not a font.
#[wasm_bindgen]
pub fn text_add_face(
    family: &str,
    weight_min: f64,
    weight_max: f64,
    italic: bool,
    unicode_range: &str,
    bytes: &[u8],
) -> i32 {
    SHAPER.with(|shaper| {
        shaper
            .borrow_mut()
            .store
            .add_face(family, weight_min, weight_max, italic, unicode_range, bytes)
            .map_or(-1, |id| id as i32)
    })
}

#[wasm_bindgen]
pub fn text_face_count() -> u32 {
    SHAPER.with(|shaper| shaper.borrow().store.len() as u32)
}

#[wasm_bindgen]
pub fn text_has_family(family: &str) -> bool {
    SHAPER.with(|shaper| shaper.borrow().store.has_family(family))
}

fn spec(family: &str, weight: f64, italic: bool, size: f64) -> FontSpec {
    FontSpec {
        family: family.to_string(),
        weight,
        italic,
        size,
    }
}

/// Shaped advance of `text` in px; NaN when the family has no face loaded.
#[wasm_bindgen]
pub fn text_width(family: &str, weight: f64, italic: bool, size: f64, text: &[u16]) -> f64 {
    SHAPER.with(|shaper| {
        shaper
            .borrow_mut()
            .shape(text, &spec(family, weight, italic, size))
            .map_or(f64::NAN, |s| s.advance)
    })
}

/// `[ascent, descent]` as Chrome's `fontBoundingBox*` give them; empty when the family has no face.
#[wasm_bindgen]
pub fn text_metrics(family: &str, weight: f64, italic: bool, size: f64) -> Vec<f64> {
    SHAPER.with(|shaper| {
        shaper
            .borrow()
            .metrics(&spec(family, weight, italic, size))
            .map_or(Vec::new(), |m| vec![m.ascent, m.descent])
    })
}

/// Shapes `text`: `[missing, advance, count, (face, glyph, x, y, cluster)…]` in px from the origin on
/// the baseline (y up); empty when the family has no face loaded.
#[wasm_bindgen]
pub fn text_shape(family: &str, weight: f64, italic: bool, size: f64, text: &[u16]) -> Vec<f64> {
    SHAPER.with(|shaper| {
        let mut shaper = shaper.borrow_mut();
        let Some(shaped) = shaper.shape(text, &spec(family, weight, italic, size)) else {
            return Vec::new();
        };
        let mut out = Vec::with_capacity(3 + shaped.glyphs.len() * 5);
        out.push(if shaped.missing { 1.0 } else { 0.0 });
        out.push(shaped.advance);
        out.push(shaped.glyphs.len() as f64);
        for g in &shaped.glyphs {
            out.extend([g.face as f64, g.id as f64, g.x, g.y, g.cluster as f64]);
        }
        out
    })
}

/// The outline of a glyph in em units, y down (`morfa_text::glyph`); empty without an outline.
#[wasm_bindgen]
pub fn text_glyph_path(face: u32, weight: f64, glyph: u32) -> Vec<f32> {
    SHAPER.with(|shaper| {
        let mut shaper = shaper.borrow_mut();
        if face as usize >= shaper.store.len() {
            return Vec::new();
        }
        glyph_path(shaper.store.face_mut(face), weight, glyph)
    })
}

/// The engine's version, as the build script's smoke test reads it.
#[wasm_bindgen]
pub fn text_version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}
