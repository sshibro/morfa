//! The PDF's fonts: each face at each weight it is used in becomes Type 3 fonts of only the glyphs the document uses
//! (a subset), each glyph its outline from lane L3's store (skrifa at the face's weight instance, as Chromium embeds
//! a variable font's instance), with a /ToUnicode map so the text stays selectable and searchable. A Type 3 font has
//! one-byte codes: a face with more than 255 glyphs in use gets a second font, and so on.

use std::collections::HashMap;
use std::fmt::Write as _;

use morfa_text::font::FaceId;

use super::writer::{Writer, n};
use crate::fonts::Fonts;

/// The weight a face's instance is keyed by (`Fonts::outline`'s rule: clamped to the axis; static faces one key).
fn weight_key(fonts: &mut Fonts, face: FaceId, weight: f64) -> u32 {
    match fonts.shaper.store.face(face).wght_axis {
        Some((min, max)) => (weight as f32).clamp(min, max).to_bits(),
        None => 0,
    }
}

struct Chunk {
    /// The font object, written at the end.
    id: u32,
    /// Glyph id per code (codes 1..=255).
    glyphs: Vec<u32>,
    /// What each code reads as.
    unicode: Vec<String>,
}

struct FaceFonts {
    face: FaceId,
    weight: f64,
    chunks: Vec<Chunk>,
    codes: HashMap<u32, (usize, u8)>,
}

/// Every font the document uses, by (face, instance).
#[derive(Default)]
pub struct FontSet {
    faces: Vec<FaceFonts>,
    index: HashMap<(FaceId, u32), usize>,
}

/// One glyph as shown: which font object (its resource is `/T<id>`), which code.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Code {
    pub font: u32,
    pub code: u8,
    /// Advance in font units (the font's /Widths entry) and units per em.
    pub width: f64,
    pub upem: f64,
}

impl FontSet {
    /// The code of `glyph` in `face` at `weight`, reading as `text` (the first glyph of a cluster carries the
    /// cluster's characters, the others none).
    pub fn code(
        &mut self,
        w: &mut Writer,
        fonts: &mut Fonts,
        face: FaceId,
        weight: f64,
        glyph: u32,
        text: &str,
    ) -> Code {
        let key = (face, weight_key(fonts, face, weight));
        let index = *self.index.entry(key).or_insert_with(|| {
            self.faces.push(FaceFonts {
                face,
                weight,
                chunks: Vec::new(),
                codes: HashMap::new(),
            });
            self.faces.len() - 1
        });
        let width = fonts.advance_units(face, weight, glyph);
        let upem = fonts.upem(face);
        let set = &mut self.faces[index];
        if let Some(&(chunk, code)) = set.codes.get(&glyph) {
            let chunk = &mut set.chunks[chunk];
            if chunk.unicode[code as usize - 1].is_empty() && !text.is_empty() {
                chunk.unicode[code as usize - 1] = text.to_owned();
            }
            return Code {
                font: chunk.id,
                code,
                width,
                upem,
            };
        }
        if set.chunks.last().is_none_or(|c| c.glyphs.len() >= 255) {
            set.chunks.push(Chunk {
                id: w.alloc(),
                glyphs: Vec::new(),
                unicode: Vec::new(),
            });
        }
        let chunk_index = set.chunks.len() - 1;
        let chunk = &mut set.chunks[chunk_index];
        chunk.glyphs.push(glyph);
        chunk.unicode.push(text.to_owned());
        let code = chunk.glyphs.len() as u8;
        set.codes.insert(glyph, (chunk_index, code));
        Code {
            font: chunk.id,
            code,
            width,
            upem,
        }
    }

    /// Writes every font: glyph procedures, widths, encoding and Unicode map.
    pub fn finish(self, w: &mut Writer, fonts: &mut Fonts) {
        for set in self.faces {
            let upem = fonts.upem(set.face);
            for chunk in set.chunks {
                let mut procs = String::new();
                let mut widths = String::new();
                let mut differences = String::from("1");
                let (mut lo_x, mut lo_y, mut hi_x, mut hi_y) = (
                    f64::INFINITY,
                    f64::INFINITY,
                    f64::NEG_INFINITY,
                    f64::NEG_INFINITY,
                );
                for (i, &glyph) in chunk.glyphs.iter().enumerate() {
                    let advance = fonts.advance_units(set.face, set.weight, glyph);
                    // .notdef (a character no face has) draws nothing: Chromium takes a system font for it.
                    let outline = if glyph == 0 {
                        Vec::new()
                    } else {
                        fonts.outline(set.face, set.weight, glyph).to_vec()
                    };
                    let (body, bbox) = glyph_procedure(&outline, upem);
                    if let Some([a, b, c, d]) = bbox {
                        lo_x = lo_x.min(a);
                        lo_y = lo_y.min(b);
                        hi_x = hi_x.max(c);
                        hi_y = hi_y.max(d);
                    }
                    let [a, b, c, d] = bbox.unwrap_or([0.0; 4]);
                    let stream = format!(
                        "{} 0 {} {} {} {} d1\n{body}",
                        n(advance),
                        n(a),
                        n(b),
                        n(c),
                        n(d)
                    );
                    let id = w.alloc();
                    w.stream(id, "", stream.as_bytes(), true);
                    let _ = write!(procs, "/g{} {id} 0 R ", i + 1);
                    let _ = write!(widths, "{} ", n(advance));
                    let _ = write!(differences, " /g{}", i + 1);
                }
                let to_unicode = w.alloc();
                w.stream(to_unicode, "", cmap(&chunk.unicode).as_bytes(), true);
                let bbox = if lo_x.is_finite() {
                    format!("[{} {} {} {}]", n(lo_x), n(lo_y), n(hi_x), n(hi_y))
                } else {
                    "[0 0 0 0]".to_owned()
                };
                let scale = super::writer::real(1.0 / upem, 12);
                w.object(
                    chunk.id,
                    &format!(
                        "<</Type /Font /Subtype /Type3 /FontBBox {bbox} /FontMatrix [{scale} 0 0 {scale} 0 0] /CharProcs <<{procs}>> /Encoding <</Type /Encoding /Differences [{differences}]>> /FirstChar 1 /LastChar {} /Widths [{widths}] /ToUnicode {to_unicode} 0 R /Resources <<>>>>",
                        chunk.glyphs.len()
                    ),
                );
            }
        }
    }
}

/// A glyph outline (`glyph_path`'s em units, y down) as a Type 3 glyph procedure in font units (y up), and its box.
fn glyph_procedure(stream: &[f32], upem: f64) -> (String, Option<[f64; 4]>) {
    let mut out = String::new();
    let (mut lo_x, mut lo_y, mut hi_x, mut hi_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    let mut point = |x: f32, y: f32, out: &mut String| {
        let (x, y) = (x as f64 * upem, -(y as f64) * upem);
        lo_x = lo_x.min(x);
        hi_x = hi_x.max(x);
        lo_y = lo_y.min(y);
        hi_y = hi_y.max(y);
        let _ = write!(out, "{} {} ", n(x), n(y));
        (x, y)
    };
    let mut current = (0.0, 0.0);
    let mut i = 0;
    while i < stream.len() {
        match stream[i] as u8 {
            0 => {
                current = point(stream[i + 1], stream[i + 2], &mut out);
                out.push_str("m\n");
                i += 3;
            }
            1 => {
                current = point(stream[i + 1], stream[i + 2], &mut out);
                out.push_str("l\n");
                i += 3;
            }
            2 => {
                // A quadratic as the cubic PDF draws: control points two thirds of the way to the quadratic's.
                let (qx, qy) = (stream[i + 1] as f64 * upem, -(stream[i + 2] as f64) * upem);
                let (x, y) = (stream[i + 3] as f64 * upem, -(stream[i + 4] as f64) * upem);
                let c1 = (
                    current.0 + 2.0 / 3.0 * (qx - current.0),
                    current.1 + 2.0 / 3.0 * (qy - current.1),
                );
                let c2 = (x + 2.0 / 3.0 * (qx - x), y + 2.0 / 3.0 * (qy - y));
                for (px, py) in [c1, c2] {
                    let _ = write!(out, "{} {} ", n(px), n(py));
                }
                current = point(stream[i + 3], stream[i + 4], &mut out);
                out.push_str("c\n");
                i += 5;
            }
            3 => {
                point(stream[i + 1], stream[i + 2], &mut out);
                point(stream[i + 3], stream[i + 4], &mut out);
                current = point(stream[i + 5], stream[i + 6], &mut out);
                out.push_str("c\n");
                i += 7;
            }
            _ => {
                out.push_str("h\n");
                i += 1;
            }
        }
    }
    if out.is_empty() {
        return (out, None);
    }
    out.push_str("f\n");
    (
        out,
        Some([lo_x.floor(), lo_y.floor(), hi_x.ceil(), hi_y.ceil()]),
    )
}

/// The /ToUnicode CMap of a chunk: code → the characters it reads as.
fn cmap(unicode: &[String]) -> String {
    let mut out = String::from(
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def\n/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n1 begincodespacerange\n<00> <FF>\nendcodespacerange\n",
    );
    let entries: Vec<(usize, &String)> = unicode
        .iter()
        .enumerate()
        .filter(|(_, t)| !t.is_empty())
        .collect();
    for block in entries.chunks(100) {
        let _ = writeln!(out, "{} beginbfchar", block.len());
        for (i, text) in block {
            let mut hex = String::new();
            for unit in text.encode_utf16() {
                let _ = write!(hex, "{unit:04X}");
            }
            let _ = writeln!(out, "<{:02X}> <{hex}>", i + 1);
        }
        out.push_str("endbfchar\n");
    }
    out.push_str("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n");
    out
}
