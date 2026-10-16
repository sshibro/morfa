//! Real glyphs for the exporters (feature `fonts`): lane L3's font store and harfrust shaping
//! (`morfa_text::shape::Shaper`), skrifa outlines at the face's weight instance (`morfa_text::glyph::glyph_path`),
//! and the decoration metrics a browser draws underlines and strike-throughs with. Outline text (SVG) and the PDF's
//! embedded fonts both place glyphs through [`Fonts::place`], the way Chromium lays a `<tspan>` out: shaped advances,
//! `letter-spacing` after every character.

use std::collections::HashMap;

use harfrust::{Buffer, Feature, ShapeOptions, ShaperFont, Tag};
use morfa_model::{CubicTo, PathCommand, QuadTo, Vec2};
use morfa_text::font::FaceId;
use morfa_text::glyph::glyph_path;
use morfa_text::shape::{Glyph, Shaped, Shaper};
use morfa_text::types::FontSpec;
use skrifa::MetadataProvider;
use skrifa::instance::Size;

/// One glyph placed in user space: its origin on the baseline (y down) and the em → px scale.
#[derive(Clone, Copy, Debug)]
pub struct Placed {
    pub face: FaceId,
    pub id: u32,
    pub x: f64,
    pub y: f64,
    /// UTF-16 offset of the glyph's cluster in the text.
    pub cluster: u32,
}

/// A text set in one font from a pen position.
#[derive(Clone, Debug, Default)]
pub struct PlacedText {
    pub glyphs: Vec<Placed>,
    /// From the start to the end of the last character's advance, letter spacing included.
    pub advance: f64,
    /// Some character had no glyph in the family (a browser would take a fallback font).
    pub missing: bool,
}

/// Underline or strike-through: offset below the baseline (y down, positive is below) and thickness, in px.
#[derive(Clone, Copy, Debug)]
pub struct Decoration {
    pub offset: f64,
    pub thickness: f64,
}

#[derive(Default)]
pub struct Fonts {
    pub shaper: Shaper,
    outlines: HashMap<(FaceId, u32, u32), Vec<f32>>,
}

impl Fonts {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers a face file (sfnt or woff2) under its CSS descriptors (`@font-face`); None when not a font.
    pub fn add_face(
        &mut self,
        family: &str,
        weight_min: f64,
        weight_max: f64,
        italic: bool,
        unicode_range: &str,
        bytes: &[u8],
    ) -> Option<FaceId> {
        self.shaper
            .store
            .add_face(family, weight_min, weight_max, italic, unicode_range, bytes)
    }

    pub fn has_family(&self, family: &str) -> bool {
        self.shaper.store.has_family(family)
    }

    /// `text` shaped in `spec` from (`x`, `y`), `letter_spacing` added after every character (cluster). None when the
    /// family has no face.
    pub fn place(
        &mut self,
        text: &[u16],
        spec: &FontSpec,
        x: f64,
        y: f64,
        letter_spacing: f64,
    ) -> Option<PlacedText> {
        // With letter spacing, ligatures and contextual alternates are off, as Blink shapes it (CSS Text 3: no
        // optional ligatures where the spacing between characters is not zero).
        let shaped = if letter_spacing != 0.0 && !letter_spacing.is_nan() {
            self.shape_spaced(text, spec)?
        } else {
            self.shaper.shape(text, spec)?.clone()
        };
        let mut out = PlacedText {
            glyphs: Vec::with_capacity(shaped.glyphs.len()),
            advance: shaped.advance,
            missing: shaped.missing,
        };
        // Clusters in text order: a glyph moves by the spacing of the clusters before its own.
        let mut clusters: Vec<u32> = shaped.glyphs.iter().map(|g| g.cluster).collect();
        clusters.sort_unstable();
        clusters.dedup();
        for g in &shaped.glyphs {
            let before = clusters.partition_point(|&c| c < g.cluster) as f64;
            out.glyphs.push(Placed {
                face: g.face,
                id: g.id,
                x: x + g.x + letter_spacing * before,
                y: y - g.y,
                cluster: g.cluster,
            });
        }
        out.advance += letter_spacing * clusters.len() as f64;
        Some(out)
    }

    /// [`Fonts::place`] as Chromium prints SVG text (lane B4, read from today's PDFs: every advance there is
    /// HarfBuzz's at this size): Blink shapes at the device size — `spec.size × css_per_unit` truncated to 26.6
    /// fixed point (1/64 CSS px, FreeType's size) — and scales back. `css_per_unit` is the CSS px a user unit becomes
    /// on the printed page (4/3 at 1 px = 1 pt, times the page's and the element's scale). Returns the placed text and
    /// the size it was shaped at (the glyphs' size too).
    pub fn place_printed(
        &mut self,
        text: &[u16],
        spec: &FontSpec,
        x: f64,
        y: f64,
        letter_spacing: f64,
        css_per_unit: f64,
    ) -> Option<(PlacedText, f64)> {
        let mut size = spec.size;
        if css_per_unit > 0.0 && css_per_unit.is_finite() {
            let truncated = (spec.size * css_per_unit * 64.0).floor() / 64.0;
            if truncated > 0.0 {
                size = truncated / css_per_unit;
            }
        }
        let sized = FontSpec {
            size,
            ..spec.clone()
        };
        Some((self.place(text, &sized, x, y, letter_spacing)?, size))
    }

    /// `Shaper::shape` with ligatures and contextual alternates off (lane L3's shaper takes no features).
    fn shape_spaced(&mut self, text: &[u16], spec: &FontSpec) -> Option<Shaped> {
        let group = self.shaper.store.group(spec);
        if group.is_empty() {
            return None;
        }
        let mut points = Vec::with_capacity(text.len());
        let mut unit = 0u32;
        for item in char::decode_utf16(text.iter().copied()) {
            let (cp, width) = match item {
                Ok(c) => (c as u32, c.len_utf16() as u32),
                Err(_) => (0xfffd, 1),
            };
            points.push((cp, unit));
            unit += width;
        }
        let store = &self.shaper.store;
        let face_for = |cp: u32| {
            let mut in_range = None;
            for &id in &group {
                let face = store.face(id);
                if face.in_range(cp) {
                    if face.glyph_index(cp).is_some() {
                        return id;
                    }
                    in_range.get_or_insert(id);
                }
            }
            in_range.unwrap_or(group[0])
        };
        let faces: Vec<FaceId> = points.iter().map(|&(cp, _)| face_for(cp)).collect();
        let features = [b"liga", b"clig", b"dlig", b"hlig", b"calt"]
            .map(|tag| Feature::new(Tag::new(tag), 0, ..));
        let mut shaped = Shaped::default();
        let mut pen = 0.0;
        let mut i = 0;
        while i < points.len() {
            let face_id = faces[i];
            let mut j = i + 1;
            while j < points.len() && faces[j] == face_id {
                j += 1;
            }
            let face = self.shaper.store.face_mut(face_id);
            shaped.missing |= points[i..j]
                .iter()
                .any(|&(cp, _)| face.glyph_index(cp).is_none());
            let scale = spec.size / face.upem;
            let instance = face.instance(spec.weight);
            let shaper = ShaperFont::new(&instance.font);
            let mut buffer = Buffer::new();
            for &(cp, unit) in &points[i..j] {
                buffer.push(cp, unit);
            }
            buffer.guess_segment_properties();
            if harfrust::shape(
                &shaper,
                &mut buffer,
                ShapeOptions::new().features(&features),
            )
            .is_ok()
            {
                for (info, pos) in buffer.glyph_infos().iter().zip(buffer.glyph_positions()) {
                    shaped.glyphs.push(Glyph {
                        face: face_id,
                        id: info.glyph_id,
                        x: pen + pos.x_offset as f64 * scale,
                        y: pos.y_offset as f64 * scale,
                        cluster: info.cluster,
                    });
                    pen += pos.x_advance as f64 * scale;
                }
            }
            i = j;
        }
        shaped.advance = pen;
        Some(shaped)
    }

    /// A glyph's outline in em units (y down), as flat commands (`glyph_path`'s stream), cached.
    pub fn outline(&mut self, face: FaceId, weight: f64, id: u32) -> &[f32] {
        let face_ref = self.shaper.store.face_mut(face);
        let key_weight = match face_ref.wght_axis {
            Some((min, max)) => (weight as f32).clamp(min, max).to_bits(),
            None => 0,
        };
        self.outlines
            .entry((face, key_weight, id))
            .or_insert_with(|| glyph_path(face_ref, weight, id))
    }

    /// The outline of a placed glyph in user space: `size` px per em, turned by `angle` (radians) about its origin.
    pub fn glyph_commands(
        &mut self,
        glyph: &Placed,
        weight: f64,
        size: f64,
        angle: f64,
        out: &mut Vec<PathCommand>,
    ) {
        let (cos, sin) = (angle.cos(), angle.sin());
        let (ox, oy) = (glyph.x, glyph.y);
        let at = |x: f32, y: f32| {
            let (x, y) = (x as f64 * size, y as f64 * size);
            Vec2 {
                x: ox + x * cos - y * sin,
                y: oy + x * sin + y * cos,
            }
        };
        let stream = self.outline(glyph.face, weight, glyph.id);
        let mut i = 0;
        while i < stream.len() {
            match stream[i] as u8 {
                0 => {
                    out.push(PathCommand::M(at(stream[i + 1], stream[i + 2])));
                    i += 3;
                }
                1 => {
                    out.push(PathCommand::L(at(stream[i + 1], stream[i + 2])));
                    i += 3;
                }
                2 => {
                    let (c, p) = (
                        at(stream[i + 1], stream[i + 2]),
                        at(stream[i + 3], stream[i + 4]),
                    );
                    out.push(PathCommand::Q(QuadTo {
                        x1: c.x,
                        y1: c.y,
                        x: p.x,
                        y: p.y,
                    }));
                    i += 5;
                }
                3 => {
                    let (c1, c2, p) = (
                        at(stream[i + 1], stream[i + 2]),
                        at(stream[i + 3], stream[i + 4]),
                        at(stream[i + 5], stream[i + 6]),
                    );
                    out.push(PathCommand::C(CubicTo {
                        x1: c1.x,
                        y1: c1.y,
                        x2: c2.x,
                        y2: c2.y,
                        x: p.x,
                        y: p.y,
                    }));
                    i += 7;
                }
                _ => {
                    out.push(PathCommand::Z);
                    i += 1;
                }
            }
        }
    }

    /// The face a spec draws its first character with (the group's first face).
    pub fn first_face(&self, spec: &FontSpec) -> Option<FaceId> {
        self.shaper.store.group(spec).first().copied()
    }

    /// Units per em of a face.
    pub fn upem(&self, face: FaceId) -> f64 {
        self.shaper.store.face(face).upem
    }

    /// Underline and strike-through as Chromium draws them on SVG text (measured): thickness
    /// max(1, size / 10); the underline's top a whole-pixel gap of max(1, ⌈thickness / 2⌉) below the baseline; the
    /// strike-through centred a third of the font's ascent (rounded to whole px, as Chrome reads it) above it.
    /// Offsets are of the line's centre, below the baseline positive.
    pub fn decorations(&mut self, spec: &FontSpec) -> Option<(Decoration, Decoration)> {
        let face = self.first_face(spec)?;
        let face_ref = self.shaper.store.face(face);
        let ascent = morfa_text::font::chrome_metric(face_ref.ascender, spec.size, face_ref.upem);
        let thickness = (spec.size / 10.0).max(1.0);
        let gap = (thickness / 2.0).ceil().max(1.0);
        Some((
            Decoration {
                offset: gap + thickness / 2.0,
                thickness,
            },
            Decoration {
                offset: -ascent / 3.0,
                thickness,
            },
        ))
    }

    /// Advance width in font units of a glyph at a weight (the PDF font's /Widths).
    pub fn advance_units(&mut self, face: FaceId, weight: f64, id: u32) -> f64 {
        let face_ref = self.shaper.store.face_mut(face);
        let location = face_ref.instance(weight).location.clone();
        let font = face_ref.font_ref();
        let upem = face_ref.upem;
        font.glyph_metrics(Size::unscaled(), &location)
            .advance_width(skrifa::GlyphId::new(id))
            .map_or(upem * 0.5, |w| w as f64)
    }
}
