//! Glyph outlines from skrifa at a face's weight instance, as a flat command stream in em units with the
//! canvas's y axis (down), ready for a `Path2D`: `0 x y` move, `1 x y` line, `2 cx cy x y` quadratic,
//! `3 c1x c1y c2x c2y x y` cubic, `4` close.

use skrifa::MetadataProvider;
use skrifa::instance::Size;
use skrifa::outline::{DrawSettings, OutlinePen};

use crate::font::Face;

struct Pen {
    scale: f32,
    out: Vec<f32>,
}

impl OutlinePen for Pen {
    fn move_to(&mut self, x: f32, y: f32) {
        self.out.extend([0.0, x * self.scale, -y * self.scale]);
    }
    fn line_to(&mut self, x: f32, y: f32) {
        self.out.extend([1.0, x * self.scale, -y * self.scale]);
    }
    fn quad_to(&mut self, cx: f32, cy: f32, x: f32, y: f32) {
        self.out.extend([
            2.0,
            cx * self.scale,
            -cy * self.scale,
            x * self.scale,
            -y * self.scale,
        ]);
    }
    fn curve_to(&mut self, c1x: f32, c1y: f32, c2x: f32, c2y: f32, x: f32, y: f32) {
        self.out.extend([
            3.0,
            c1x * self.scale,
            -c1y * self.scale,
            c2x * self.scale,
            -c2y * self.scale,
            x * self.scale,
            -y * self.scale,
        ]);
    }
    fn close(&mut self) {
        self.out.push(4.0);
    }
}

/// The outline of `glyph` in `face` at `weight`; empty for a glyph without an outline (a space, a
/// missing glyph).
pub fn glyph_path(face: &mut Face, weight: f64, glyph: u32) -> Vec<f32> {
    let upem = face.upem as f32;
    let location = face.instance(weight).location.clone();
    let font = face.font_ref();
    let Some(outline) = font.outline_glyphs().get(skrifa::GlyphId::new(glyph)) else {
        return Vec::new();
    };
    let mut pen = Pen {
        scale: 1.0 / upem,
        out: Vec::with_capacity(64),
    };
    let settings = DrawSettings::unhinted(Size::unscaled(), &location);
    if outline.draw(settings, &mut pen).is_err() {
        return Vec::new();
    }
    pen.out
}
