//! T1 shaper bake-off (docs/decisions/text-shaper.md). Each candidate shapes a string into clusters
//! with advances in font units and counts the path segments of a glyph's outline. The same code is
//! built for wasm32 with one feature at a time to measure what each candidate adds to the bundle.

#![allow(clippy::missing_safety_doc)]

/// One shaped cluster: the byte offset where it starts and its total advance in font units.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Cluster {
    pub start: u32,
    pub advance: f32,
}

/// What every candidate must do.
pub trait Candidate {
    fn name(&self) -> &'static str;
    fn upem(&self) -> u16;
    /// Clusters in text order with their advances (font units).
    fn shape(&mut self, text: &str) -> Vec<Cluster>;
    /// Bounding box of every point (on- and off-curve) of the first glyph's outline of `text`, font units:
    /// [min x, min y, max x, max y]; zeros for an empty outline.
    fn outline_bbox(&mut self, text: &str) -> [f32; 4];
}

/// A pen that remembers the extremes of every point it is given.
#[derive(Default)]
pub struct BBox {
    pub seen: bool,
    pub b: [f32; 4],
}

impl BBox {
    pub fn point(&mut self, x: f32, y: f32) {
        if !self.seen {
            self.seen = true;
            self.b = [x, y, x, y];
        } else {
            self.b[0] = self.b[0].min(x);
            self.b[1] = self.b[1].min(y);
            self.b[2] = self.b[2].max(x);
            self.b[3] = self.b[3].max(y);
        }
    }
}

/// Cumulative pen position at every cluster start of `reference` plus the end, per candidate, so a
/// ligature that merges clusters still compares at the reference's boundaries.
pub fn pen_positions(clusters: &[Cluster], at: &[u32], total_end: u32) -> Vec<f32> {
    let mut out = Vec::with_capacity(at.len() + 1);
    for &start in at {
        let mut sum = 0.0;
        for c in clusters {
            if c.start < start {
                sum += c.advance;
            }
        }
        out.push(sum);
    }
    let _ = total_end;
    out.push(clusters.iter().map(|c| c.advance).sum());
    out
}

pub fn cluster_starts(clusters: &[Cluster]) -> Vec<u32> {
    let mut starts: Vec<u32> = clusters.iter().map(|c| c.start).collect();
    starts.sort_unstable();
    starts.dedup();
    starts
}

/// Merges glyph-level (cluster, advance) pairs into clusters, sorted by start.
fn merge(pairs: impl Iterator<Item = (u32, f32)>) -> Vec<Cluster> {
    let mut out: Vec<Cluster> = Vec::new();
    for (start, advance) in pairs {
        if let Some(c) = out.iter_mut().find(|c| c.start == start) {
            c.advance += advance;
        } else {
            out.push(Cluster { start, advance });
        }
    }
    out.sort_by_key(|c| c.start);
    out
}

// ── rustybuzz + ttf-parser ─────────────────────────────────────────────────────────────────────

#[cfg(feature = "rb")]
pub mod rb {
    use super::{BBox, Candidate, Cluster, merge};
    use rustybuzz::ttf_parser::{GlyphId, OutlineBuilder};
    use rustybuzz::{Face, UnicodeBuffer};

    pub struct Rb<'a> {
        face: Face<'a>,
    }

    impl<'a> Rb<'a> {
        pub fn new(data: &'a [u8], wght: Option<f32>) -> Option<Self> {
            let mut face = Face::from_slice(data, 0)?;
            if let Some(w) = wght {
                face.set_variations(&[rustybuzz::Variation {
                    tag: rustybuzz::ttf_parser::Tag::from_bytes(b"wght"),
                    value: w,
                }]);
            }
            Some(Self { face })
        }
    }

    struct Pen(BBox);
    impl OutlineBuilder for Pen {
        fn move_to(&mut self, x: f32, y: f32) {
            self.0.point(x, y);
        }
        fn line_to(&mut self, x: f32, y: f32) {
            self.0.point(x, y);
        }
        fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
            self.0.point(x1, y1);
            self.0.point(x, y);
        }
        fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
            self.0.point(x1, y1);
            self.0.point(x2, y2);
            self.0.point(x, y);
        }
        fn close(&mut self) {}
    }

    impl Candidate for Rb<'_> {
        fn name(&self) -> &'static str {
            "rustybuzz+ttf-parser"
        }
        fn upem(&self) -> u16 {
            self.face.units_per_em() as u16
        }
        fn shape(&mut self, text: &str) -> Vec<Cluster> {
            let mut buffer = UnicodeBuffer::new();
            buffer.push_str(text);
            buffer.guess_segment_properties();
            let out = rustybuzz::shape(&self.face, &[], buffer);
            merge(
                out.glyph_infos()
                    .iter()
                    .zip(out.glyph_positions())
                    .map(|(i, p)| (i.cluster, p.x_advance as f32)),
            )
        }
        fn outline_bbox(&mut self, text: &str) -> [f32; 4] {
            let mut buffer = UnicodeBuffer::new();
            buffer.push_str(text);
            buffer.guess_segment_properties();
            let out = rustybuzz::shape(&self.face, &[], buffer);
            let Some(info) = out.glyph_infos().first() else {
                return [0.0; 4];
            };
            let mut pen = Pen(BBox::default());
            self.face
                .outline_glyph(GlyphId(info.glyph_id as u16), &mut pen);
            pen.0.b
        }
    }
}

// ── harfrust + skrifa (one parser: read-fonts) ─────────────────────────────────────────────────

#[cfg(feature = "hr")]
pub mod hr {
    use super::{BBox, Candidate, Cluster, merge};
    use harfrust::{Buffer, Font, ShapeOptions, ShaperFont};
    use skrifa::instance::{Location, Size};
    use skrifa::outline::{DrawSettings, OutlinePen};
    use skrifa::{FontRef, GlyphId, MetadataProvider};

    pub struct Hr<'a> {
        font: Font,
        skrifa: FontRef<'a>,
        location: Location,
        upem: u16,
    }

    impl<'a> Hr<'a> {
        pub fn new(data: &'a [u8], wght: Option<f32>) -> Option<Self> {
            let base = Font::new(data.to_vec(), 0)?;
            let skrifa = FontRef::new(data).ok()?;
            let (font, location) = match wght {
                Some(w) => (
                    base.instance_builder().variations([("wght", w)]).build(),
                    skrifa.axes().location([("wght", w)]),
                ),
                None => (base, Location::default()),
            };
            let upem = font.units_per_em();
            Some(Self {
                font,
                skrifa,
                location,
                upem,
            })
        }
    }

    struct Pen(BBox);
    impl OutlinePen for Pen {
        fn move_to(&mut self, x: f32, y: f32) {
            self.0.point(x, y);
        }
        fn line_to(&mut self, x: f32, y: f32) {
            self.0.point(x, y);
        }
        fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
            self.0.point(x1, y1);
            self.0.point(x, y);
        }
        fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
            self.0.point(x1, y1);
            self.0.point(x2, y2);
            self.0.point(x, y);
        }
        fn close(&mut self) {}
    }

    impl Candidate for Hr<'_> {
        fn name(&self) -> &'static str {
            "harfrust+skrifa"
        }
        fn upem(&self) -> u16 {
            self.upem
        }
        fn shape(&mut self, text: &str) -> Vec<Cluster> {
            let shaper = ShaperFont::new(&self.font);
            let mut buffer = Buffer::new();
            buffer.push_str(text);
            buffer.guess_segment_properties();
            if harfrust::shape(&shaper, &mut buffer, ShapeOptions::new()).is_err() {
                return Vec::new();
            }
            merge(
                buffer
                    .glyph_infos()
                    .iter()
                    .zip(buffer.glyph_positions())
                    .map(|(i, p)| (i.cluster, p.x_advance as f32)),
            )
        }
        fn outline_bbox(&mut self, text: &str) -> [f32; 4] {
            let shaper = ShaperFont::new(&self.font);
            let mut buffer = Buffer::new();
            buffer.push_str(text);
            buffer.guess_segment_properties();
            if harfrust::shape(&shaper, &mut buffer, ShapeOptions::new()).is_err() {
                return [0.0; 4];
            }
            let Some(info) = buffer.glyph_infos().first() else {
                return [0.0; 4];
            };
            let Some(glyph) = self
                .skrifa
                .outline_glyphs()
                .get(GlyphId::new(info.glyph_id))
            else {
                return [0.0; 4];
            };
            let mut pen = Pen(BBox::default());
            let settings = DrawSettings::unhinted(Size::unscaled(), &self.location);
            let _ = glyph.draw(settings, &mut pen);
            pen.0.b
        }
    }
}

// ── swash (shaping and outlines in one crate; parley's engine) ─────────────────────────────────

#[cfg(feature = "sw")]
pub mod sw {
    use super::{BBox, Candidate, Cluster, merge};
    use swash::scale::ScaleContext;
    use swash::shape::ShapeContext;
    use swash::{FontRef, Setting};

    pub struct Sw<'a> {
        font: FontRef<'a>,
        wght: Option<f32>,
        shape: ShapeContext,
        scale: ScaleContext,
    }

    impl<'a> Sw<'a> {
        pub fn new(data: &'a [u8], wght: Option<f32>) -> Option<Self> {
            let font = FontRef::from_index(data, 0)?;
            Some(Self {
                font,
                wght,
                shape: ShapeContext::new(),
                scale: ScaleContext::new(),
            })
        }
        fn variations(&self) -> Vec<Setting<f32>> {
            self.wght
                .map(|w| {
                    vec![Setting {
                        tag: swash::tag_from_bytes(b"wght"),
                        value: w,
                    }]
                })
                .unwrap_or_default()
        }
    }

    impl Candidate for Sw<'_> {
        fn name(&self) -> &'static str {
            "swash"
        }
        fn upem(&self) -> u16 {
            self.font.metrics(&[]).units_per_em
        }
        fn shape(&mut self, text: &str) -> Vec<Cluster> {
            let variations = self.variations();
            let mut shaper = self
                .shape
                .builder(self.font)
                .variations(variations.iter().copied())
                .build();
            shaper.add_str(text);
            let mut pairs: Vec<(u32, f32)> = Vec::new();
            shaper.shape_with(|cluster| {
                let advance: f32 = cluster.glyphs.iter().map(|g| g.advance).sum();
                pairs.push((cluster.source.start, advance));
            });
            merge(pairs.into_iter())
        }
        fn outline_bbox(&mut self, text: &str) -> [f32; 4] {
            let variations = self.variations();
            let mut shaper = self
                .shape
                .builder(self.font)
                .variations(variations.iter().copied())
                .build();
            shaper.add_str(text);
            let mut first: Option<u16> = None;
            shaper.shape_with(|cluster| {
                if first.is_none() {
                    first = cluster.glyphs.first().map(|g| g.id);
                }
            });
            let Some(id) = first else { return [0.0; 4] };
            let mut scaler = self
                .scale
                .builder(self.font)
                .variations(variations.iter().copied())
                .build();
            let Some(outline) = scaler.scale_outline(id) else {
                return [0.0; 4];
            };
            let mut bbox = BBox::default();
            for p in outline.points() {
                bbox.point(p.x, p.y);
            }
            bbox.b
        }
    }
}

// ── wasm size probes: one exported function per candidate so nothing is stripped ───────────────

#[cfg(target_arch = "wasm32")]
mod probes {
    #![allow(dead_code)]
    use super::Candidate;

    unsafe fn slices<'a>(
        font: *const u8,
        font_len: usize,
        text: *const u8,
        text_len: usize,
    ) -> (&'a [u8], &'a str) {
        unsafe {
            let font = core::slice::from_raw_parts(font, font_len);
            let text = core::str::from_utf8_unchecked(core::slice::from_raw_parts(text, text_len));
            (font, text)
        }
    }

    fn run(mut candidate: impl Candidate, text: &str) -> f32 {
        let clusters = candidate.shape(text);
        clusters.iter().map(|c| c.advance).sum::<f32>()
            + candidate.outline_bbox(text).iter().sum::<f32>()
    }

    #[cfg(feature = "rb")]
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn probe_rb(
        font: *const u8,
        font_len: usize,
        text: *const u8,
        text_len: usize,
        wght: f32,
    ) -> f32 {
        let (font, text) = unsafe { slices(font, font_len, text, text_len) };
        super::rb::Rb::new(font, (wght > 0.0).then_some(wght))
            .map(|c| run(c, text))
            .unwrap_or(-1.0)
    }

    #[cfg(feature = "hr")]
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn probe_hr(
        font: *const u8,
        font_len: usize,
        text: *const u8,
        text_len: usize,
        wght: f32,
    ) -> f32 {
        let (font, text) = unsafe { slices(font, font_len, text, text_len) };
        super::hr::Hr::new(font, (wght > 0.0).then_some(wght))
            .map(|c| run(c, text))
            .unwrap_or(-1.0)
    }

    #[cfg(feature = "sw")]
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn probe_sw(
        font: *const u8,
        font_len: usize,
        text: *const u8,
        text_len: usize,
        wght: f32,
    ) -> f32 {
        let (font, text) = unsafe { slices(font, font_len, text, text_len) };
        super::sw::Sw::new(font, (wght > 0.0).then_some(wght))
            .map(|c| run(c, text))
            .unwrap_or(-1.0)
    }

    /// skrifa alone: parse, charmap and outlines at a variation, to attribute the size of `hr`.
    #[cfg(feature = "sk")]
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn probe_sk(
        font: *const u8,
        font_len: usize,
        text: *const u8,
        text_len: usize,
        wght: f32,
    ) -> f32 {
        use skrifa::instance::Size;
        use skrifa::outline::{DrawSettings, OutlinePen};
        use skrifa::{FontRef, MetadataProvider};
        struct Sum(f32);
        impl OutlinePen for Sum {
            fn move_to(&mut self, x: f32, y: f32) {
                self.0 += x + y;
            }
            fn line_to(&mut self, x: f32, y: f32) {
                self.0 += x + y;
            }
            fn quad_to(&mut self, x1: f32, y1: f32, x: f32, y: f32) {
                self.0 += x1 + y1 + x + y;
            }
            fn curve_to(&mut self, x1: f32, y1: f32, x2: f32, y2: f32, x: f32, y: f32) {
                self.0 += x1 + y1 + x2 + y2 + x + y;
            }
            fn close(&mut self) {}
        }
        let (font, text) = unsafe { slices(font, font_len, text, text_len) };
        let Ok(font) = FontRef::new(font) else {
            return -1.0;
        };
        let location = font.axes().location([("wght", wght)]);
        let charmap = font.charmap();
        let outlines = font.outline_glyphs();
        let mut sum = Sum(0.0);
        for ch in text.chars() {
            if let Some(gid) = charmap.map(ch) {
                if let Some(glyph) = outlines.get(gid) {
                    let _ = glyph.draw(
                        DrawSettings::unhinted(Size::unscaled(), &location),
                        &mut sum,
                    );
                }
            }
        }
        sum.0
    }

    #[cfg(feature = "woff2")]
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn probe_woff2(font: *const u8, font_len: usize) -> usize {
        let data = unsafe { core::slice::from_raw_parts(font, font_len) };
        let mut buf: &[u8] = data;
        woff2_patched::decode::convert_woff2_to_ttf(&mut buf)
            .map(|ttf| ttf.len())
            .unwrap_or(0)
    }

    #[cfg(feature = "wuff")]
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn probe_wuff(font: *const u8, font_len: usize) -> usize {
        let data = unsafe { core::slice::from_raw_parts(font, font_len) };
        wuff::decompress_woff2(data)
            .map(|ttf| ttf.len())
            .unwrap_or(0)
    }

    #[cfg(feature = "ct")]
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn probe_ct(
        font: *const u8,
        font_len: usize,
        text: *const u8,
        text_len: usize,
    ) -> f32 {
        use cosmic_text::{Attrs, Buffer, Metrics, Shaping};
        let (font, text) = unsafe { slices(font, font_len, text, text_len) };
        let mut system =
            cosmic_text::FontSystem::new_with_fonts([cosmic_text::fontdb::Source::Binary(
                std::sync::Arc::new(font.to_vec()),
            )]);
        let mut buffer = Buffer::new(&mut system, Metrics::new(16.0, 20.0));
        buffer.set_text(text, &Attrs::new(), Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut system, false);
        buffer.layout_runs().map(|run| run.line_w).sum()
    }

    #[cfg(feature = "pl")]
    #[unsafe(no_mangle)]
    pub unsafe extern "C" fn probe_pl(
        font: *const u8,
        font_len: usize,
        text: *const u8,
        text_len: usize,
    ) -> f32 {
        use parley::{FontContext, LayoutContext, StyleProperty};
        let (font, text) = unsafe { slices(font, font_len, text, text_len) };
        let mut fonts = FontContext::new();
        fonts.collection.register_fonts(
            parley::fontique::Blob::new(std::sync::Arc::new(font.to_vec())),
            None,
        );
        let mut layouts: LayoutContext<()> = LayoutContext::new();
        let mut builder = layouts.ranged_builder(&mut fonts, text, 1.0, true);
        builder.push_default(StyleProperty::FontSize(16.0));
        let mut layout = builder.build(text);
        layout.break_all_lines(None);
        layout.width()
    }
}
