//! Draws the print flavour's element tree (svg.rs with `print`: the SVG Chromium printed today) as PDF content.
//! The tree is a small SVG subset the exporter itself writes, so this is not an SVG renderer: shapes (`rect`,
//! `circle`, `ellipse`, `path`), `g`, `use`, `image`, text (from its spans, as real glyphs), solid colours, linear and
//! radial gradients (shading patterns), tiling patterns, clip paths, masks (soft masks), opacity and blend modes
//! (transparency groups), and filters (rasterised by raster.rs, the one thing a PDF cannot hold).
//!
//! Coordinates: every content stream starts at the page's base matrix (px, y down; `base`), and only short-lived
//! `q … Q` around a single drawing operation ever change the CTM. So a transparency group, a soft mask or a pattern
//! is always invoked at the base, and fills and clips are written in page px directly.

use std::collections::HashMap;
use std::fmt::Write as _;

use morfa_geometry::matrix::{Rect, apply, multiply};
use morfa_geometry::paths::parse_path_data;
use morfa_model::{Matrix, PathCommand, Vec2};

use super::font::FontSet;
use super::image;
use super::writer::{Writer, ascii_string, n};
use super::{PdfPictures, PdfStats};
use crate::fonts::Fonts;
use crate::svg::{Span, TEXT_INDEX, span_of};
use crate::xml::{Child, El, Val};

const IDENTITY: Matrix = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];

/// Resources one content stream uses, by object number.
#[derive(Default)]
pub(crate) struct Res {
    gstates: Vec<u32>,
    xobjects: Vec<u32>,
    fonts: Vec<u32>,
    patterns: Vec<u32>,
}

impl Res {
    fn add(list: &mut Vec<u32>, id: u32) {
        if !list.contains(&id) {
            list.push(id);
        }
    }
    pub(crate) fn dict(&self) -> String {
        let mut out = String::from("<<");
        for (key, prefix, list) in [
            ("ExtGState", "G", &self.gstates),
            ("XObject", "X", &self.xobjects),
            ("Font", "T", &self.fonts),
            ("Pattern", "P", &self.patterns),
        ] {
            if list.is_empty() {
                continue;
            }
            let _ = write!(out, "/{key} <<");
            for id in list {
                let _ = write!(out, "/{prefix}{id} {id} 0 R ");
            }
            out.push_str(">> ");
        }
        out.push_str(">>");
        out
    }
}

/// A content stream being written: a page's, a group's, a mask's or a pattern's.
pub(crate) struct Stream {
    pub(crate) ops: String,
    pub(crate) res: Res,
    /// The stream's default space is the page's base (a form or pattern invoked at the base); a page's own stream is
    /// in points, y up, below the base matrix.
    pub(crate) form: bool,
}

impl Stream {
    pub(crate) fn new(form: bool) -> Self {
        Stream {
            ops: String::new(),
            res: Res::default(),
            form,
        }
    }
}

/// What SVG inherits down the tree (fill and stroke properties).
#[derive(Clone, Debug)]
struct Style {
    fill: Option<String>,
    fill_opacity: f64,
    even_odd: bool,
    stroke: Option<String>,
    stroke_width: f64,
    stroke_opacity: f64,
    cap: u8,
    join: u8,
    miter: f64,
    dash: Vec<f64>,
}

impl Style {
    fn root() -> Self {
        Style {
            fill: Some("#000000".to_owned()),
            fill_opacity: 1.0,
            even_odd: false,
            stroke: None,
            stroke_width: 1.0,
            stroke_opacity: 1.0,
            cap: 0,
            join: 0,
            miter: 4.0,
            dash: Vec::new(),
        }
    }

    fn inherit(&self, e: &El) -> Style {
        let mut s = self.clone();
        let text = |name: &str| match e.attrs.get(name) {
            Some(Val::Str(v)) => Some(v.as_str()),
            _ => None,
        };
        let number = |name: &str| match e.attrs.get(name) {
            Some(Val::Num(v)) => Some(*v),
            Some(Val::Str(v)) => v.trim().parse().ok(),
            None => None,
        };
        if let Some(v) = text("fill") {
            s.fill = if v == "none" {
                None
            } else {
                Some(v.to_owned())
            };
        }
        if let Some(v) = number("fill-opacity") {
            s.fill_opacity = v.clamp(0.0, 1.0);
        }
        if let Some(v) = text("fill-rule") {
            s.even_odd = v == "evenodd";
        }
        if let Some(v) = text("stroke") {
            s.stroke = if v == "none" {
                None
            } else {
                Some(v.to_owned())
            };
        }
        if let Some(v) = number("stroke-width") {
            s.stroke_width = v;
        }
        if let Some(v) = number("stroke-opacity") {
            s.stroke_opacity = v.clamp(0.0, 1.0);
        }
        if let Some(v) = text("stroke-linecap") {
            s.cap = match v {
                "round" => 1,
                "square" => 2,
                _ => 0,
            };
        }
        if let Some(v) = text("stroke-linejoin") {
            s.join = match v {
                "round" => 1,
                "bevel" => 2,
                _ => 0,
            };
        }
        if let Some(v) = number("stroke-miterlimit") {
            s.miter = v;
        }
        if let Some(v) = text("stroke-dasharray") {
            s.dash = v.split([' ', ',']).filter_map(|p| p.parse().ok()).collect();
        }
        s
    }
}

fn attr_num(e: &El, name: &str) -> Option<f64> {
    match e.attrs.get(name) {
        Some(Val::Num(v)) => Some(*v),
        Some(Val::Str(v)) => v.trim().parse().ok(),
        None => None,
    }
}

fn attr_str<'e>(e: &'e El, name: &str) -> Option<&'e str> {
    match e.attrs.get(name) {
        Some(Val::Str(v)) => Some(v.as_str()),
        _ => None,
    }
}

/// `url(#id)` → id.
fn url_ref(value: Option<&str>) -> Option<&str> {
    value?.strip_prefix("url(#")?.strip_suffix(')')
}

/// The exporter's transform values: `translate(x y)`, `matrix(a b c d e f)`, `rotate(deg cx cy)`.
pub(crate) fn parse_transform(value: &str) -> Matrix {
    let args = |s: &str| -> Vec<f64> {
        s.split([' ', ','])
            .filter(|p| !p.is_empty())
            .filter_map(|p| p.parse().ok())
            .collect()
    };
    let inner = |name: &str| {
        value
            .trim()
            .strip_prefix(name)
            .and_then(|r| r.strip_prefix('('))
            .and_then(|r| r.strip_suffix(')'))
    };
    if let Some(r) = inner("translate") {
        let a = args(r);
        return [
            [1.0, 0.0, *a.first().unwrap_or(&0.0)],
            [0.0, 1.0, *a.get(1).unwrap_or(&0.0)],
        ];
    }
    if let Some(r) = inner("matrix") {
        let a = args(r);
        if a.len() == 6 {
            return [[a[0], a[2], a[4]], [a[1], a[3], a[5]]];
        }
    }
    if let Some(r) = inner("rotate") {
        let a = args(r);
        let (deg, cx, cy) = (
            *a.first().unwrap_or(&0.0),
            *a.get(1).unwrap_or(&0.0),
            *a.get(2).unwrap_or(&0.0),
        );
        let (sin, cos) = deg.to_radians().sin_cos();
        let rot = [[cos, -sin, 0.0], [sin, cos, 0.0]];
        return multiply(
            &multiply(&[[1.0, 0.0, cx], [0.0, 1.0, cy]], &rot),
            &[[1.0, 0.0, -cx], [0.0, 1.0, -cy]],
        );
    }
    IDENTITY
}

fn transform_of(e: &El) -> Option<Matrix> {
    attr_str(e, "transform").map(parse_transform)
}

fn blend_of(e: &El) -> Option<&'static str> {
    let style = attr_str(e, "style")?;
    let mode = style.strip_prefix("mix-blend-mode:")?;
    Some(match mode {
        "multiply" => "Multiply",
        "screen" => "Screen",
        "overlay" => "Overlay",
        "darken" => "Darken",
        "lighten" => "Lighten",
        "color-dodge" => "ColorDodge",
        "color-burn" => "ColorBurn",
        "hard-light" => "HardLight",
        "soft-light" => "SoftLight",
        "difference" => "Difference",
        "exclusion" => "Exclusion",
        "hue" => "Hue",
        "saturation" => "Saturation",
        "color" => "Color",
        "luminosity" => "Luminosity",
        _ => return None,
    })
}

fn hex_color(value: &str) -> Option<[f64; 3]> {
    let h = value.strip_prefix('#')?;
    if h.len() != 6 {
        return None;
    }
    let c = |i: usize| {
        u8::from_str_radix(&h[i..i + 2], 16)
            .ok()
            .map(|v| v as f64 / 255.0)
    };
    Some([c(0)?, c(2)?, c(4)?])
}

fn rgb(c: [f64; 3]) -> String {
    format!(
        "{} {} {}",
        super::writer::real(c[0], 4),
        super::writer::real(c[1], 4),
        super::writer::real(c[2], 4)
    )
}

fn matrix_str(m: &Matrix) -> String {
    format!(
        "{} {} {} {} {} {}",
        n(m[0][0]),
        n(m[1][0]),
        n(m[0][1]),
        n(m[1][1]),
        n(m[0][2]),
        n(m[1][2])
    )
}

/// The geometry of a shape element in its own user space.
fn shape_commands(e: &El) -> Vec<PathCommand> {
    let v = |x, y| Vec2 { x, y };
    let k = 0.552_284_749_830_793_6;
    let ellipse = |cx: f64, cy: f64, rx: f64, ry: f64| {
        use morfa_model::CubicTo;
        let c = |x1, y1, x2, y2, x, y| {
            PathCommand::C(CubicTo {
                x1,
                y1,
                x2,
                y2,
                x,
                y,
            })
        };
        vec![
            PathCommand::M(v(cx + rx, cy)),
            c(cx + rx, cy + ry * k, cx + rx * k, cy + ry, cx, cy + ry),
            c(cx - rx * k, cy + ry, cx - rx, cy + ry * k, cx - rx, cy),
            c(cx - rx, cy - ry * k, cx - rx * k, cy - ry, cx, cy - ry),
            c(cx + rx * k, cy - ry, cx + rx, cy - ry * k, cx + rx, cy),
            PathCommand::Z,
        ]
    };
    match e.tag {
        "path" => attr_str(e, "d")
            .map(|d| parse_path_data(d, None))
            .unwrap_or_default(),
        "rect" => {
            let (x, y) = (
                attr_num(e, "x").unwrap_or(0.0),
                attr_num(e, "y").unwrap_or(0.0),
            );
            let (w, h) = (
                attr_num(e, "width").unwrap_or(0.0),
                attr_num(e, "height").unwrap_or(0.0),
            );
            if !(w > 0.0 && h > 0.0) {
                return Vec::new();
            }
            let r = attr_num(e, "rx").unwrap_or(0.0).min(w / 2.0).min(h / 2.0);
            if !(r > 0.0) {
                return vec![
                    PathCommand::M(v(x, y)),
                    PathCommand::L(v(x + w, y)),
                    PathCommand::L(v(x + w, y + h)),
                    PathCommand::L(v(x, y + h)),
                    PathCommand::Z,
                ];
            }
            use morfa_model::CubicTo;
            let c = |x1, y1, x2, y2, x, y| {
                PathCommand::C(CubicTo {
                    x1,
                    y1,
                    x2,
                    y2,
                    x,
                    y,
                })
            };
            let q = r * (1.0 - k);
            vec![
                PathCommand::M(v(x + r, y)),
                PathCommand::L(v(x + w - r, y)),
                c(x + w - q, y, x + w, y + q, x + w, y + r),
                PathCommand::L(v(x + w, y + h - r)),
                c(x + w, y + h - q, x + w - q, y + h, x + w - r, y + h),
                PathCommand::L(v(x + r, y + h)),
                c(x + q, y + h, x, y + h - q, x, y + h - r),
                PathCommand::L(v(x, y + r)),
                c(x, y + q, x + q, y, x + r, y),
                PathCommand::Z,
            ]
        }
        "circle" => {
            let r = attr_num(e, "r").unwrap_or(0.0);
            if !(r > 0.0) {
                return Vec::new();
            }
            ellipse(
                attr_num(e, "cx").unwrap_or(0.0),
                attr_num(e, "cy").unwrap_or(0.0),
                r,
                r,
            )
        }
        "ellipse" => {
            let (rx, ry) = (
                attr_num(e, "rx").unwrap_or(0.0),
                attr_num(e, "ry").unwrap_or(0.0),
            );
            if !(rx > 0.0 && ry > 0.0) {
                return Vec::new();
            }
            ellipse(
                attr_num(e, "cx").unwrap_or(0.0),
                attr_num(e, "cy").unwrap_or(0.0),
                rx,
                ry,
            )
        }
        _ => Vec::new(),
    }
}

/// Path operators for `commands`, mapped by `m` (None: as they are).
fn write_path(out: &mut String, commands: &[PathCommand], m: Option<&Matrix>) {
    let map = |p: Vec2| match m {
        Some(m) => apply(m, p),
        None => p,
    };
    let mut current = Vec2 { x: 0.0, y: 0.0 };
    let mut start = current;
    for c in commands {
        match c {
            PathCommand::M(p) => {
                let q = map(*p);
                let _ = writeln!(out, "{} {} m", n(q.x), n(q.y));
                current = *p;
                start = *p;
            }
            PathCommand::L(p) => {
                let q = map(*p);
                let _ = writeln!(out, "{} {} l", n(q.x), n(q.y));
                current = *p;
            }
            PathCommand::C(c) => {
                let (a, b, p) = (
                    map(Vec2 { x: c.x1, y: c.y1 }),
                    map(Vec2 { x: c.x2, y: c.y2 }),
                    map(Vec2 { x: c.x, y: c.y }),
                );
                let _ = writeln!(
                    out,
                    "{} {} {} {} {} {} c",
                    n(a.x),
                    n(a.y),
                    n(b.x),
                    n(b.y),
                    n(p.x),
                    n(p.y)
                );
                current = Vec2 { x: c.x, y: c.y };
            }
            PathCommand::Q(q) => {
                let c1 = Vec2 {
                    x: current.x + 2.0 / 3.0 * (q.x1 - current.x),
                    y: current.y + 2.0 / 3.0 * (q.y1 - current.y),
                };
                let c2 = Vec2 {
                    x: q.x + 2.0 / 3.0 * (q.x1 - q.x),
                    y: q.y + 2.0 / 3.0 * (q.y1 - q.y),
                };
                let (a, b, p) = (map(c1), map(c2), map(Vec2 { x: q.x, y: q.y }));
                let _ = writeln!(
                    out,
                    "{} {} {} {} {} {} c",
                    n(a.x),
                    n(a.y),
                    n(b.x),
                    n(b.y),
                    n(p.x),
                    n(p.y)
                );
                current = Vec2 { x: q.x, y: q.y };
            }
            PathCommand::Z => {
                out.push_str("h\n");
                current = start;
            }
        }
    }
}

fn scale_of(m: &Matrix) -> f64 {
    (m[0][0] * m[1][1] - m[0][1] * m[1][0]).abs().sqrt()
}

/// A link annotation of the page: its rectangle in points and URI.
pub(crate) struct Link {
    pub(crate) rect: [f64; 4],
    pub(crate) uri: String,
}

pub(crate) struct Painter<'a, 'w> {
    pub(crate) w: &'w mut Writer,
    pub(crate) fonts: &'w mut Fonts,
    pub(crate) font_set: &'w mut FontSet,
    pub(crate) pictures: &'w mut dyn PdfPictures,
    pub(crate) images: &'w mut HashMap<String, Option<image::Placed>>,
    pub(crate) gstates: &'w mut HashMap<String, u32>,
    pub(crate) stats: &'w mut PdfStats,
    /// Every element with an id (definitions and the shadows' content groups).
    pub(crate) ids: HashMap<&'a str, &'a El>,
    pub(crate) texts: &'a [Vec<Span>],
    /// Page px (y down) → page points (y up).
    pub(crate) base: Matrix,
    /// The page in px.
    pub(crate) page: Rect,
    /// Raster pixels per page px (300 dpi on the scaled page).
    pub(crate) raster_ppu: f64,
    pub(crate) links: Vec<Link>,
    pub(crate) fallback_family: String,
    blends: HashMap<*const El, bool>,
    /// Pictures as data: URLs for rasters, by URL.
    pub(crate) inline: HashMap<String, Option<super::raster::Picture>>,
    /// The pictures the raster being prepared names.
    pub(crate) raster_pictures: Vec<super::raster::Picture>,
    /// Rasters are not drawn here but queued with the image object their content names (the writer's raster pool
    /// draws them, on other threads in the render service).
    pub(crate) jobs: Vec<(u32, super::raster::RasterJob)>,
    /// Pixels the page's rasters draw (at the resolution each one's blur needs), and the largest one: what
    /// PDF_EXPORT_LIMITS' raster megapixels bound in this engine.
    pub(crate) raster_pixels: f64,
    pub(crate) largest_pixels: f64,
}

impl<'a, 'w> Painter<'a, 'w> {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        w: &'w mut Writer,
        fonts: &'w mut Fonts,
        font_set: &'w mut FontSet,
        pictures: &'w mut dyn PdfPictures,
        images: &'w mut HashMap<String, Option<image::Placed>>,
        gstates: &'w mut HashMap<String, u32>,
        stats: &'w mut PdfStats,
        root: &'a El,
        texts: &'a [Vec<Span>],
        base: Matrix,
        page: Rect,
        raster_ppu: f64,
    ) -> Self {
        let mut ids = HashMap::new();
        index_ids(root, &mut ids);
        Painter {
            w,
            fonts,
            font_set,
            pictures,
            images,
            gstates,
            stats,
            ids,
            texts,
            base,
            page,
            raster_ppu,
            links: Vec::new(),
            fallback_family: "Inter".to_owned(),
            blends: HashMap::new(),
            inline: HashMap::new(),
            raster_pictures: Vec::new(),
            jobs: Vec::new(),
            raster_pixels: 0.0,
            largest_pixels: 0.0,
        }
    }

    /// Draws the svg root into the page stream.
    pub(crate) fn page(&mut self, root: &'a El, out: &mut Stream) {
        let style = Style::root().inherit(root);
        for child in elements(root) {
            self.paint(child, &IDENTITY, &style, out);
        }
    }

    fn gstate(
        &mut self,
        fill_alpha: f64,
        stroke_alpha: f64,
        blend: Option<&str>,
        smask: Option<u32>,
    ) -> u32 {
        let mut dict = String::from("<</Type /ExtGState");
        if fill_alpha < 1.0 {
            let _ = write!(dict, " /ca {}", super::writer::real(fill_alpha, 4));
        }
        if stroke_alpha < 1.0 {
            let _ = write!(dict, " /CA {}", super::writer::real(stroke_alpha, 4));
        }
        if let Some(mode) = blend {
            let _ = write!(dict, " /BM /{mode}");
        }
        if let Some(mask) = smask {
            let _ = write!(dict, " /SMask {mask} 0 R");
        }
        dict.push_str(">>");
        if let Some(&id) = self.gstates.get(&dict) {
            return id;
        }
        let id = self.w.alloc();
        self.w.object(id, &dict);
        self.gstates.insert(dict, id);
        id
    }

    fn use_gstate(
        &mut self,
        out: &mut Stream,
        fill_alpha: f64,
        stroke_alpha: f64,
        blend: Option<&str>,
        smask: Option<u32>,
    ) {
        if fill_alpha >= 1.0 && stroke_alpha >= 1.0 && blend.is_none() && smask.is_none() {
            return;
        }
        let id = self.gstate(fill_alpha, stroke_alpha, blend, smask);
        Res::add(&mut out.res.gstates, id);
        let _ = writeln!(out.ops, "/G{id} gs");
    }

    /// A form XObject of `content` (a transparency group, isolated when asked), over the page.
    fn form(&mut self, content: Stream, group: Option<(bool, bool)>) -> u32 {
        let id = self.w.alloc();
        let group = match group {
            Some((isolated, _)) => format!(
                " /Group <</S /Transparency /CS /DeviceRGB{}>>",
                if isolated { " /I true" } else { "" }
            ),
            None => String::new(),
        };
        let p = self.page;
        let dict = format!(
            "/Type /XObject /Subtype /Form /BBox [{} {} {} {}]{group} /Resources {}",
            n(p.x - 1.0),
            n(p.y - 1.0),
            n(p.x + p.width + 1.0),
            n(p.y + p.height + 1.0),
            content.res.dict()
        );
        self.w.stream(id, &dict, content.ops.as_bytes(), true);
        id
    }

    fn do_form(&mut self, out: &mut Stream, form: u32) {
        Res::add(&mut out.res.xobjects, form);
        let _ = writeln!(out.ops, "/X{form} Do");
    }

    fn has_blend(&mut self, e: &El) -> bool {
        let key = e as *const El;
        if let Some(&hit) = self.blends.get(&key) {
            return hit;
        }
        let found = elements(e).any(|c| blend_of(c).is_some() || self.has_blend(c));
        self.blends.insert(key, found);
        found
    }

    /// One element and its subtree, in `ctm` (its parent's user space → page px).
    fn paint(&mut self, e: &'a El, ctm: &Matrix, style: &Style, out: &mut Stream) {
        if matches!(
            e.tag,
            "defs"
                | "clipPath"
                | "mask"
                | "filter"
                | "linearGradient"
                | "radialGradient"
                | "pattern"
                | "stop"
        ) {
            return;
        }
        let ctm = match transform_of(e) {
            Some(t) => multiply(ctm, &t),
            None => *ctm,
        };
        let style = style.inherit(e);
        let opacity = attr_num(e, "opacity").unwrap_or(1.0).clamp(0.0, 1.0);
        let blend = blend_of(e);
        if let Some(filter) = url_ref(attr_str(e, "filter")) {
            self.raster(e, &ctm, filter, opacity, blend, out);
            return;
        }
        let mask = url_ref(attr_str(e, "mask"));
        let clip = url_ref(attr_str(e, "clip-path"));
        let isolate = clip.is_some() && self.has_blend(e);
        let group = opacity < 1.0
            || mask.is_some()
            || (blend.is_some()
                && e.tag != "path"
                && e.tag != "rect"
                && e.tag != "circle"
                && e.tag != "ellipse")
            || isolate;
        if group {
            let mut inner = Stream::new(true);
            self.clipped(e, &ctm, &style, clip, &mut inner);
            let form = self.form(inner, Some((true, false)));
            let smask = mask.and_then(|m| self.mask(m, &ctm));
            out.ops.push_str("q\n");
            self.use_gstate(out, opacity, opacity, blend, smask);
            self.do_form(out, form);
            out.ops.push_str("Q\n");
            return;
        }
        if blend.is_some() {
            out.ops.push_str("q\n");
            self.use_gstate(out, 1.0, 1.0, blend, None);
            self.clipped(e, &ctm, &style, clip, out);
            out.ops.push_str("Q\n");
            return;
        }
        self.clipped(e, &ctm, &style, clip, out);
    }

    fn clipped(
        &mut self,
        e: &'a El,
        ctm: &Matrix,
        style: &Style,
        clip: Option<&str>,
        out: &mut Stream,
    ) {
        match clip {
            Some(id) => {
                out.ops.push_str("q\n");
                self.clip(id, ctm, out);
                self.content(e, ctm, style, out);
                out.ops.push_str("Q\n");
            }
            None => self.content(e, ctm, style, out),
        }
    }

    fn content(&mut self, e: &'a El, ctm: &Matrix, style: &Style, out: &mut Stream) {
        match e.tag {
            "g" | "svg" | "a" => {
                for child in elements(e) {
                    self.paint(child, ctm, style, out);
                }
            }
            "use" => {
                let target = attr_str(e, "href")
                    .or_else(|| attr_str(e, "xlink:href"))
                    .and_then(|h| h.strip_prefix('#'))
                    .and_then(|id| self.ids.get(id).copied());
                if let Some(target) = target {
                    self.paint(target, ctm, style, out);
                }
            }
            "path" | "rect" | "circle" | "ellipse" => {
                let commands = shape_commands(e);
                if commands.is_empty() {
                    return;
                }
                self.stats.shapes += 1;
                if let Some(fill) = &style.fill {
                    self.fill(
                        &commands,
                        ctm,
                        fill,
                        style.fill_opacity,
                        style.even_odd,
                        out,
                    );
                }
                if let Some(stroke) = &style.stroke {
                    self.stroke(&commands, ctm, stroke, style, out);
                }
            }
            "image" => self.image(e, ctm, out),
            "text" => self.text(e, ctm, style, out),
            _ => {}
        }
    }

    // Fills and strokes ──────────────────────────────────────────────────────────────────────────

    fn fill(
        &mut self,
        commands: &[PathCommand],
        ctm: &Matrix,
        paint: &str,
        alpha: f64,
        even_odd: bool,
        out: &mut Stream,
    ) {
        let op = if even_odd { "f*" } else { "f" };
        if let Some(c) = hex_color(paint) {
            out.ops.push_str("q\n");
            self.use_gstate(out, alpha, 1.0, None, None);
            let _ = writeln!(out.ops, "{} rg", rgb(c));
            write_path(&mut out.ops, commands, Some(ctm));
            let _ = writeln!(out.ops, "{op}\nQ");
            return;
        }
        let Some(target) = url_ref(Some(paint)).and_then(|id| self.ids.get(id).copied()) else {
            return;
        };
        match target.tag {
            "linearGradient" | "radialGradient" => {
                let Some(gradient) = Gradient::read(target) else {
                    return;
                };
                if let Some(single) = gradient.single() {
                    self.fill(commands, ctm, &single.0, alpha * single.1, even_odd, out);
                    return;
                }
                let pattern = self.shading_pattern(&gradient, ctm, out.form, false);
                let smask = if gradient.has_alpha() {
                    let mut mask = Stream::new(true);
                    let gray = self.shading_pattern(&gradient, ctm, true, true);
                    Res::add(&mut mask.res.patterns, gray);
                    let _ = writeln!(mask.ops, "/Pattern cs /P{gray} scn");
                    write_path(&mut mask.ops, commands, Some(ctm));
                    let _ = writeln!(mask.ops, "{op}");
                    let form = self.form(mask, Some((false, false)));
                    let id = self.w.alloc();
                    self.w.object(
                        id,
                        &format!("<</Type /Mask /S /Luminosity /G {form} 0 R /BC [0 0 0]>>"),
                    );
                    Some(id)
                } else {
                    None
                };
                out.ops.push_str("q\n");
                self.use_gstate(out, alpha, 1.0, None, smask);
                Res::add(&mut out.res.patterns, pattern);
                let _ = writeln!(out.ops, "/Pattern cs /P{pattern} scn");
                write_path(&mut out.ops, commands, Some(ctm));
                let _ = writeln!(out.ops, "{op}\nQ");
            }
            "pattern" => {
                let Some(pattern) = self.tiling_pattern(target, ctm, out.form) else {
                    return;
                };
                out.ops.push_str("q\n");
                self.use_gstate(out, alpha, 1.0, None, None);
                Res::add(&mut out.res.patterns, pattern);
                let _ = writeln!(out.ops, "/Pattern cs /P{pattern} scn");
                write_path(&mut out.ops, commands, Some(ctm));
                let _ = writeln!(out.ops, "{op}\nQ");
            }
            _ => {}
        }
    }

    fn stroke(
        &mut self,
        commands: &[PathCommand],
        ctm: &Matrix,
        paint: &str,
        style: &Style,
        out: &mut Stream,
    ) {
        if !(style.stroke_width > 0.0) {
            return;
        }
        out.ops.push_str("q\n");
        self.use_gstate(out, 1.0, style.stroke_opacity, None, None);
        if let Some(c) = hex_color(paint) {
            let _ = writeln!(out.ops, "{} RG", rgb(c));
        } else if let Some(target) = url_ref(Some(paint)).and_then(|id| self.ids.get(id).copied()) {
            match Gradient::read(target) {
                Some(gradient) => match gradient.single() {
                    Some((color, _)) => {
                        let _ =
                            writeln!(out.ops, "{} RG", rgb(hex_color(&color).unwrap_or([0.0; 3])));
                    }
                    None => {
                        let pattern = self.shading_pattern(&gradient, ctm, out.form, false);
                        Res::add(&mut out.res.patterns, pattern);
                        let _ = writeln!(out.ops, "/Pattern CS /P{pattern} SCN");
                    }
                },
                None => {
                    if let Some(pattern) = self.tiling_pattern(target, ctm, out.form) {
                        Res::add(&mut out.res.patterns, pattern);
                        let _ = writeln!(out.ops, "/Pattern CS /P{pattern} SCN");
                    }
                }
            }
        }
        let _ = writeln!(out.ops, "{} cm", matrix_str(ctm));
        let _ = writeln!(
            out.ops,
            "{} w {} J {} j {} M",
            n(style.stroke_width),
            style.cap,
            style.join,
            n(style.miter.max(1.0))
        );
        if !style.dash.is_empty() && style.dash.iter().any(|d| *d > 0.0) {
            let mut dash = style.dash.clone();
            if dash.len() % 2 == 1 {
                dash.extend(style.dash.clone());
            }
            let list: Vec<String> = dash.iter().map(|d| n(*d)).collect();
            let _ = writeln!(out.ops, "[{}] 0 d", list.join(" "));
        }
        write_path(&mut out.ops, commands, None);
        out.ops.push_str("S\nQ\n");
    }

    /// The pattern matrix maps pattern space to the stream's default space: the page's points for a page stream,
    /// the base px for a form.
    fn pattern_matrix(&self, ctm: &Matrix, form: bool) -> Matrix {
        if form {
            *ctm
        } else {
            multiply(&self.base, ctm)
        }
    }

    fn shading_pattern(&mut self, g: &Gradient, ctm: &Matrix, form: bool, alpha: bool) -> u32 {
        let function = g.function(alpha);
        let (kind, coords) = match g.kind {
            GradientKind::Linear { x1, y1, x2, y2 } => {
                (2, format!("[{} {} {} {}]", n(x1), n(y1), n(x2), n(y2)))
            }
            GradientKind::Radial { cx, cy, r } => (
                3,
                format!("[{} {} 0 {} {} {}]", n(cx), n(cy), n(cx), n(cy), n(r)),
            ),
        };
        let space = if alpha { "/DeviceGray" } else { "/DeviceRGB" };
        let shading = self.w.alloc();
        self.w.object(shading, &format!("<</ShadingType {kind} /ColorSpace {space} /Coords {coords} /Function {function} /Extend [true true]>>"));
        let matrix = multiply(&self.pattern_matrix(ctm, form), &g.transform);
        let id = self.w.alloc();
        self.w.object(
            id,
            &format!(
                "<</Type /Pattern /PatternType 2 /Shading {shading} 0 R /Matrix [{}]>>",
                matrix_str(&matrix)
            ),
        );
        id
    }

    fn tiling_pattern(&mut self, pattern: &'a El, ctm: &Matrix, form: bool) -> Option<u32> {
        let (w, h) = (attr_num(pattern, "width")?, attr_num(pattern, "height")?);
        if !(w > 0.0 && h > 0.0) {
            return None;
        }
        let mut content = Stream::new(true);
        let style = Style::root();
        for child in elements(pattern) {
            self.paint(child, &IDENTITY, &style, &mut content);
        }
        let matrix = self.pattern_matrix(ctm, form);
        let id = self.w.alloc();
        let dict = format!(
            "/Type /Pattern /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 {} {}] /XStep {} /YStep {} /Matrix [{}] /Resources {}",
            n(w),
            n(h),
            n(w),
            n(h),
            matrix_str(&matrix),
            content.res.dict()
        );
        self.w.stream(id, &dict, content.ops.as_bytes(), true);
        Some(id)
    }

    // Clips and masks ────────────────────────────────────────────────────────────────────────────

    /// Sets the clip of `clipPath#id` (in `ctm`): one shape as a clipping path, several as an alpha soft mask of
    /// their union. A text clip's text is also written invisibly, so it stays selectable.
    fn clip(&mut self, id: &str, ctm: &Matrix, out: &mut Stream) {
        let Some(clip) = self.ids.get(id).copied() else {
            return;
        };
        let children: Vec<&'a El> = elements(clip).collect();
        let mut paths: Vec<(Vec<PathCommand>, bool)> = Vec::new();
        for child in &children {
            let m = match transform_of(child) {
                Some(t) => multiply(ctm, &t),
                None => *ctm,
            };
            if child.tag == "text" {
                let commands = self.text_outline(child, &m, out);
                paths.push((commands, false));
                continue;
            }
            let commands: Vec<PathCommand> = shape_commands(child)
                .into_iter()
                .map(|c| map_command(&c, &m))
                .collect();
            paths.push((commands, attr_str(child, "clip-rule") == Some("evenodd")));
        }
        if paths.len() == 1 {
            let (commands, even_odd) = &paths[0];
            if commands.is_empty() {
                // An empty clip hides everything.
                out.ops.push_str("0 0 m h W n\n");
                return;
            }
            write_path(&mut out.ops, commands, None);
            out.ops.push_str(if *even_odd { "W* n\n" } else { "W n\n" });
            return;
        }
        let mut mask = Stream::new(true);
        mask.ops.push_str("0 g\n");
        for (commands, even_odd) in &paths {
            write_path(&mut mask.ops, commands, None);
            mask.ops.push_str(if *even_odd { "f*\n" } else { "f\n" });
        }
        let form = self.form(mask, Some((false, false)));
        let smask = self.w.alloc();
        self.w
            .object(smask, &format!("<</Type /Mask /S /Alpha /G {form} 0 R>>"));
        self.use_gstate(out, 1.0, 1.0, None, Some(smask));
    }

    /// The soft mask of `mask#id` for content in `ctm`.
    fn mask(&mut self, id: &str, ctm: &Matrix) -> Option<u32> {
        let mask = self.ids.get(id).copied()?;
        let luminance = attr_str(mask, "style") != Some("mask-type:alpha");
        let mut content = Stream::new(true);
        if let (Some(x), Some(y), Some(w), Some(h)) = (
            attr_num(mask, "x"),
            attr_num(mask, "y"),
            attr_num(mask, "width"),
            attr_num(mask, "height"),
        ) {
            let rect = [
                PathCommand::M(Vec2 { x, y }),
                PathCommand::L(Vec2 { x: x + w, y }),
                PathCommand::L(Vec2 { x: x + w, y: y + h }),
                PathCommand::L(Vec2 { x, y: y + h }),
                PathCommand::Z,
            ];
            write_path(&mut content.ops, &rect, Some(ctm));
            content.ops.push_str("W n\n");
        }
        let style = Style::root();
        for child in elements(mask) {
            self.paint(child, ctm, &style, &mut content);
        }
        let form = self.form(content, Some((false, false)));
        let smask = self.w.alloc();
        if luminance {
            self.w.object(
                smask,
                &format!("<</Type /Mask /S /Luminosity /G {form} 0 R /BC [0 0 0]>>"),
            );
        } else {
            self.w
                .object(smask, &format!("<</Type /Mask /S /Alpha /G {form} 0 R>>"));
        }
        Some(smask)
    }

    // Pictures ───────────────────────────────────────────────────────────────────────────────────

    pub(crate) fn picture(&mut self, href: &str) -> Option<image::Placed> {
        if let Some(hit) = self.images.get(href) {
            return *hit;
        }
        let bytes = if href.starts_with("data:") {
            image::data_url_bytes(href)
        } else {
            self.pictures.bytes(href)
        };
        let placed = bytes.and_then(|b| image::write_encoded(self.w, &b));
        if placed.is_some() {
            self.stats.images += 1;
        }
        self.images.insert(href.to_owned(), placed);
        placed
    }

    fn image(&mut self, e: &El, ctm: &Matrix, out: &mut Stream) {
        let Some(href) = attr_str(e, "xlink:href").or_else(|| attr_str(e, "href")) else {
            return;
        };
        let Some(img) = self.picture(href) else {
            return;
        };
        let (x, y) = (
            attr_num(e, "x").unwrap_or(0.0),
            attr_num(e, "y").unwrap_or(0.0),
        );
        let (w, h) = (
            attr_num(e, "width").unwrap_or(0.0),
            attr_num(e, "height").unwrap_or(0.0),
        );
        if !(w > 0.0 && h > 0.0) {
            return;
        }
        let aspect = attr_str(e, "preserveAspectRatio").unwrap_or("xMidYMid meet");
        let (iw, ih) = (img.width as f64, img.height as f64);
        let (dx, dy, dw, dh, clip) = if aspect == "none" {
            (x, y, w, h, false)
        } else {
            let slice = aspect.ends_with("slice");
            let s = if slice {
                (w / iw).max(h / ih)
            } else {
                (w / iw).min(h / ih)
            };
            let (dw, dh) = (iw * s, ih * s);
            (x + (w - dw) / 2.0, y + (h - dh) / 2.0, dw, dh, slice)
        };
        out.ops.push_str("q\n");
        if clip {
            let rect = [
                PathCommand::M(Vec2 { x, y }),
                PathCommand::L(Vec2 { x: x + w, y }),
                PathCommand::L(Vec2 { x: x + w, y: y + h }),
                PathCommand::L(Vec2 { x, y: y + h }),
                PathCommand::Z,
            ];
            write_path(&mut out.ops, &rect, Some(ctm));
            out.ops.push_str("W n\n");
        }
        let placement = multiply(ctm, &[[dw, 0.0, dx], [0.0, -dh, dy + dh]]);
        Res::add(&mut out.res.xobjects, img.id);
        let _ = writeln!(out.ops, "{} cm\n/X{} Do\nQ", matrix_str(&placement), img.id);
    }

    // Text ───────────────────────────────────────────────────────────────────────────────────────

    fn spans_of(&self, text: &El) -> &'a [Span] {
        match text.attrs.get(TEXT_INDEX) {
            Some(Val::Num(i)) => self.texts.get(*i as usize).map_or(&[], |v| v.as_slice()),
            _ => &[],
        }
    }

    /// The tspans of a text element with the link each sits in.
    fn tspans(text: &El) -> Vec<(&El, Option<&str>)> {
        let mut out = Vec::new();
        for child in elements(text) {
            if child.tag == "a" {
                let href = attr_str(child, "href");
                for inner in elements(child) {
                    out.push((inner, href));
                }
            } else {
                out.push((child, None));
            }
        }
        out
    }

    /// A span shaped as Chromium prints it (`Fonts::place_printed`), with the family and size the PDF draws it in (a
    /// family without faces falls back, counted).
    fn place(
        &mut self,
        span: &Span,
        ctm: &Matrix,
    ) -> Option<(crate::fonts::PlacedText, morfa_text::types::FontSpec)> {
        let units: Vec<u16> = span.text.encode_utf16().collect();
        let mut font = span.font.clone();
        if !self.fonts.has_family(&font.family) {
            self.stats.missing_families.insert(font.family.clone());
            font.family = self.fallback_family.clone();
        }
        // CSS px per user unit on Chromium's printed page: 1 px = 1 pt (4/3 CSS px), the page's scale, the element's.
        let page_scale = self.raster_ppu * 72.0 / super::RASTER_DPI;
        let css = 4.0 / 3.0 * page_scale * scale_of(ctm);
        let (placed, size) =
            self.fonts
                .place_printed(&units, &font, span.x, span.y, span.spacing, css)?;
        font.size = size;
        Some((placed, font))
    }

    fn text(&mut self, e: &'a El, ctm: &Matrix, style: &Style, out: &mut Stream) {
        let spans = self.spans_of(e);
        for (tspan, link) in Self::tspans(e) {
            let Some(span) = span_of(tspan, spans) else {
                continue;
            };
            let span_style = style.inherit(tspan);
            let Some((placed, font)) = self.place(span, ctm) else {
                continue;
            };
            self.stats.text_spans += 1;
            let fill = span_style.fill.as_deref().and_then(hex_color);
            self.glyph_text(
                span,
                &placed,
                &font,
                ctm,
                fill,
                span_style.fill_opacity,
                out,
            );
            if let Some(color) = fill {
                let decorations = crate::svg::decoration_commands(
                    self.fonts,
                    &Span {
                        font: font.clone(),
                        ..span.clone()
                    },
                    placed.advance,
                );
                if !decorations.is_empty() {
                    out.ops.push_str("q\n");
                    self.use_gstate(out, span_style.fill_opacity, 1.0, None, None);
                    let _ = writeln!(out.ops, "{} rg", rgb(color));
                    write_path(&mut out.ops, &decorations, Some(ctm));
                    out.ops.push_str("f\nQ\n");
                }
            }
            if let Some(stroke) = span_style.stroke.clone() {
                let mut commands = Vec::new();
                for glyph in &placed.glyphs {
                    if glyph.id != 0 {
                        self.fonts.glyph_commands(
                            glyph,
                            font.weight,
                            font.size,
                            span.angle,
                            &mut commands,
                        );
                    }
                }
                commands.extend(crate::svg::decoration_commands(
                    self.fonts,
                    &Span {
                        font: font.clone(),
                        ..span.clone()
                    },
                    placed.advance,
                ));
                if !commands.is_empty() {
                    self.stroke(&commands, ctm, &stroke, &span_style, out);
                }
            }
            if let Some(uri) = link {
                self.link(span, &placed, &font, ctm, uri);
            }
        }
    }

    /// The span's glyphs as PDF text in the Type 3 fonts: one text object, the positions of the shaping kept with
    /// TJ adjustments; `fill` None writes it invisibly (render mode 3), for selection and search only.
    #[allow(clippy::too_many_arguments)]
    fn glyph_text(
        &mut self,
        span: &Span,
        placed: &crate::fonts::PlacedText,
        font: &morfa_text::types::FontSpec,
        ctm: &Matrix,
        fill: Option<[f64; 3]>,
        alpha: f64,
        out: &mut Stream,
    ) {
        if placed.glyphs.is_empty() {
            return;
        }
        let size = font.size;
        if !(size > 0.0) {
            return;
        }
        // Cluster texts: each glyph reads as its cluster's characters, the first glyph of the cluster only.
        let units: Vec<u16> = span.text.encode_utf16().collect();
        let mut starts: Vec<u32> = placed.glyphs.iter().map(|g| g.cluster).collect();
        starts.sort_unstable();
        starts.dedup();
        let cluster_text = |cluster: u32| {
            let at = starts.partition_point(|&c| c < cluster);
            let end = starts.get(at + 1).map_or(units.len(), |&c| c as usize);
            String::from_utf16_lossy(
                &units[(cluster as usize).min(units.len())..end.min(units.len())],
            )
        };
        out.ops.push_str("q\n");
        if fill.is_some() {
            self.use_gstate(out, alpha, 1.0, None, None);
        }
        out.ops.push_str("BT\n");
        match fill {
            Some(c) => {
                let _ = writeln!(out.ops, "{} rg", rgb(c));
            }
            None => out.ops.push_str("3 Tr\n"),
        }
        let (cos, sin) = (span.angle.cos(), span.angle.sin());
        let mut seen = std::collections::HashSet::new();
        let mut current_font = None;
        let mut run: Option<(f64, f64)> = None; // pen x along the line, the line's y
        let mut tj = String::new();
        let flush = |tj: &mut String, ops: &mut String| {
            if !tj.is_empty() {
                let _ = writeln!(ops, "[{tj}] TJ");
                tj.clear();
            }
        };
        for glyph in &placed.glyphs {
            let text = if seen.insert(glyph.cluster) {
                cluster_text(glyph.cluster)
            } else {
                String::new()
            };
            let code =
                self.font_set
                    .code(self.w, self.fonts, glyph.face, font.weight, glyph.id, &text);
            if current_font != Some(code.font) {
                flush(&mut tj, &mut out.ops);
                Res::add(&mut out.res.fonts, code.font);
                let _ = writeln!(out.ops, "/T{} {} Tf", code.font, n(size));
                current_font = Some(code.font);
            }
            let rotated = span.angle.abs() > 1e-9;
            let continues = matches!(run, Some((_, y)) if (y - glyph.y).abs() < 1e-9) && !rotated;
            if !continues {
                flush(&mut tj, &mut out.ops);
                // Text space: the glyph's origin, turned with it, y up.
                let local = [[cos, sin, glyph.x], [sin, -cos, glyph.y]];
                let m = multiply(ctm, &local);
                let _ = writeln!(out.ops, "{} Tm", matrix_str(&m));
                run = Some((glyph.x, glyph.y));
            }
            let (pen, y) = run.expect("set above");
            let gap = glyph.x - pen;
            if gap.abs() > 1e-6 {
                let _ = write!(tj, "{} ", n(-gap * 1000.0 / size));
            }
            let _ = write!(tj, "<{:02X}>", code.code);
            run = Some((glyph.x + code.width / code.upem * size, y));
        }
        flush(&mut tj, &mut out.ops);
        out.ops.push_str("ET\nQ\n");
    }

    fn link(
        &mut self,
        span: &Span,
        placed: &crate::fonts::PlacedText,
        font: &morfa_text::types::FontSpec,
        ctm: &Matrix,
        uri: &str,
    ) {
        let (top, bottom) = (span.y - font.size * 0.9, span.y + font.size * 0.25);
        let corners = [
            Vec2 { x: span.x, y: top },
            Vec2 {
                x: span.x + placed.advance,
                y: top,
            },
            Vec2 {
                x: span.x + placed.advance,
                y: bottom,
            },
            Vec2 {
                x: span.x,
                y: bottom,
            },
        ];
        let m = multiply(&self.base, ctm);
        let points: Vec<Vec2> = corners.iter().map(|p| apply(&m, *p)).collect();
        let (mut lx, mut ly, mut hx, mut hy) = (
            f64::INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::NEG_INFINITY,
        );
        for p in points {
            lx = lx.min(p.x);
            ly = ly.min(p.y);
            hx = hx.max(p.x);
            hy = hy.max(p.y);
        }
        self.links.push(Link {
            rect: [lx, ly, hx, hy],
            uri: uri.to_owned(),
        });
    }

    /// A text element's glyphs as one path in page px (a text clip), its text also written invisibly.
    fn text_outline(&mut self, e: &'a El, ctm: &Matrix, out: &mut Stream) -> Vec<PathCommand> {
        let spans = self.spans_of(e);
        let mut commands = Vec::new();
        for (tspan, _) in Self::tspans(e) {
            let Some(span) = span_of(tspan, spans) else {
                continue;
            };
            let Some((placed, font)) = self.place(span, ctm) else {
                continue;
            };
            self.glyph_text(span, &placed, &font, ctm, None, 1.0, out);
            let mut local = Vec::new();
            for glyph in &placed.glyphs {
                if glyph.id != 0 {
                    self.fonts.glyph_commands(
                        glyph,
                        font.weight,
                        font.size,
                        span.angle,
                        &mut local,
                    );
                }
            }
            local.extend(crate::svg::decoration_commands(
                self.fonts,
                &Span {
                    font: font.clone(),
                    ..span.clone()
                },
                placed.advance,
            ));
            commands.extend(local.iter().map(|c| map_command(c, ctm)));
        }
        commands
    }

    // Rasters ────────────────────────────────────────────────────────────────────────────────────

    fn raster(
        &mut self,
        e: &'a El,
        ctm: &Matrix,
        filter_id: &str,
        opacity: f64,
        blend: Option<&str>,
        out: &mut Stream,
    ) {
        let Some(filter) = self.ids.get(filter_id).copied() else {
            return;
        };
        let (Some(x), Some(y), Some(w), Some(h)) = (
            attr_num(filter, "x"),
            attr_num(filter, "y"),
            attr_num(filter, "width"),
            attr_num(filter, "height"),
        ) else {
            return;
        };
        if !(w > 0.0 && h > 0.0) {
            return;
        }
        // The filtered content: what `use` points at, or the element's own children.
        let bare;
        let content: Vec<&El> = if e.tag == "use" {
            let target = attr_str(e, "href")
                .or_else(|| attr_str(e, "xlink:href"))
                .and_then(|h| h.strip_prefix('#'))
                .and_then(|id| self.ids.get(id).copied());
            target.into_iter().collect()
        } else if e.tag == "g" {
            elements(e).collect()
        } else {
            // A leaf with a filter (the single-child merge): drawn through a copy without its own effects.
            let mut copy = e.clone();
            for name in ["transform", "opacity", "style", "filter", "id"] {
                copy.attrs.set(name, None);
            }
            bare = copy;
            vec![&bare]
        };
        let region = Rect::new(x, y, w, h);
        let ppu = self.raster_ppu * scale_of(ctm);
        let Some(job) = super::raster::prepare(self, &content, filter, region, ppu) else {
            return;
        };
        let pixels = job.pixels();
        self.raster_pixels += pixels;
        self.largest_pixels = self.largest_pixels.max(pixels);
        // Drawn by the writer's raster pool (other threads in the render service), into the object named here.
        let id = self.w.alloc();
        self.jobs.push((id, job));
        let placement = multiply(ctm, &[[w, 0.0, x], [0.0, -h, y + h]]);
        out.ops.push_str("q\n");
        self.use_gstate(out, opacity, opacity, blend, None);
        Res::add(&mut out.res.xobjects, id);
        let _ = writeln!(out.ops, "{} cm\n/X{} Do\nQ", matrix_str(&placement), id);
    }
}

pub(crate) fn elements(e: &El) -> impl Iterator<Item = &El> {
    e.children.iter().filter_map(|c| match c {
        Child::El(e) => Some(e),
        Child::Text(_) => None,
    })
}

fn index_ids<'a>(e: &'a El, ids: &mut HashMap<&'a str, &'a El>) {
    if let Some(Val::Str(id)) = e.attrs.get("id") {
        ids.entry(id.as_str()).or_insert(e);
    }
    for child in elements(e) {
        index_ids(child, ids);
    }
}

fn map_command(c: &PathCommand, m: &Matrix) -> PathCommand {
    use morfa_model::{CubicTo, QuadTo};
    let p = |x: f64, y: f64| apply(m, Vec2 { x, y });
    match c {
        PathCommand::M(v) => PathCommand::M(apply(m, *v)),
        PathCommand::L(v) => PathCommand::L(apply(m, *v)),
        PathCommand::C(c) => {
            let (a, b, q) = (p(c.x1, c.y1), p(c.x2, c.y2), p(c.x, c.y));
            PathCommand::C(CubicTo {
                x1: a.x,
                y1: a.y,
                x2: b.x,
                y2: b.y,
                x: q.x,
                y: q.y,
            })
        }
        PathCommand::Q(q) => {
            let (a, b) = (p(q.x1, q.y1), p(q.x, q.y));
            PathCommand::Q(QuadTo {
                x1: a.x,
                y1: a.y,
                x: b.x,
                y: b.y,
            })
        }
        PathCommand::Z => PathCommand::Z,
    }
}

// ── Gradients ──────────────────────────────────────────────────────────────────────────────────

enum GradientKind {
    Linear { x1: f64, y1: f64, x2: f64, y2: f64 },
    Radial { cx: f64, cy: f64, r: f64 },
}

struct Gradient {
    kind: GradientKind,
    transform: Matrix,
    /// (offset, colour, alpha), offsets clamped and non-decreasing.
    stops: Vec<(f64, [f64; 3], f64)>,
}

impl Gradient {
    fn read(e: &El) -> Option<Gradient> {
        let kind = match e.tag {
            "linearGradient" => GradientKind::Linear {
                x1: attr_num(e, "x1").unwrap_or(0.0),
                y1: attr_num(e, "y1").unwrap_or(0.0),
                x2: attr_num(e, "x2").unwrap_or(1.0),
                y2: attr_num(e, "y2").unwrap_or(0.0),
            },
            "radialGradient" => GradientKind::Radial {
                cx: attr_num(e, "cx").unwrap_or(0.5),
                cy: attr_num(e, "cy").unwrap_or(0.5),
                r: attr_num(e, "r").unwrap_or(0.5),
            },
            _ => return None,
        };
        let mut stops = Vec::new();
        let mut last = 0.0f64;
        for stop in elements(e).filter(|s| s.tag == "stop") {
            let offset = attr_num(stop, "offset")
                .unwrap_or(0.0)
                .clamp(0.0, 1.0)
                .max(last);
            last = offset;
            let color = attr_str(stop, "stop-color")
                .and_then(hex_color)
                .unwrap_or([0.0; 3]);
            let alpha = attr_num(stop, "stop-opacity")
                .unwrap_or(1.0)
                .clamp(0.0, 1.0);
            stops.push((offset, color, alpha));
        }
        if stops.is_empty() {
            return None;
        }
        Some(Gradient {
            kind,
            transform: transform_of_attr(e, "gradientTransform"),
            stops,
        })
    }

    /// A gradient of one stop paints that stop's colour (`#rrggbb`, alpha).
    fn single(&self) -> Option<(String, f64)> {
        if self.stops.len() != 1 {
            return None;
        }
        let (_, c, a) = self.stops[0];
        Some((
            format!(
                "#{:02x}{:02x}{:02x}",
                (c[0] * 255.0).round() as u8,
                (c[1] * 255.0).round() as u8,
                (c[2] * 255.0).round() as u8
            ),
            a,
        ))
    }

    fn has_alpha(&self) -> bool {
        self.stops.iter().any(|s| s.2 < 1.0)
    }

    /// A stitching function over the stops (colours, or alphas as grey).
    fn function(&self, alpha: bool) -> String {
        let mut stops = self.stops.clone();
        if stops[0].0 > 0.0 {
            stops.insert(0, (0.0, stops[0].1, stops[0].2));
        }
        let last = *stops.last().expect("one stop at least");
        if last.0 < 1.0 {
            stops.push((1.0, last.1, last.2));
        }
        let value = |s: &(f64, [f64; 3], f64)| {
            if alpha {
                format!("[{}]", super::writer::real(s.2, 4))
            } else {
                format!("[{}]", rgb(s.1))
            }
        };
        let mut functions = String::new();
        let mut bounds = String::new();
        let mut encode = String::new();
        for i in 0..stops.len() - 1 {
            let _ = write!(
                functions,
                "<</FunctionType 2 /Domain [0 1] /C0 {} /C1 {} /N 1>> ",
                value(&stops[i]),
                value(&stops[i + 1])
            );
            encode.push_str("0 1 ");
            if i + 1 < stops.len() - 1 {
                // Bounds must rise: equal offsets (a hard stop) are nudged apart by a millionth.
                let at = stops[i + 1]
                    .0
                    .clamp(1e-6 * (i + 1) as f64, 1.0 - 1e-6 * (stops.len() - i) as f64);
                let _ = write!(bounds, "{} ", super::writer::real(at, 6));
            }
        }
        format!(
            "<</FunctionType 3 /Domain [0 1] /Functions [{functions}] /Bounds [{bounds}] /Encode [{encode}]>>"
        )
    }
}

fn transform_of_attr(e: &El, name: &str) -> Matrix {
    attr_str(e, name).map(parse_transform).unwrap_or(IDENTITY)
}

/// Writes a page's link annotations; their ids.
pub(crate) fn write_links(w: &mut Writer, links: &[Link]) -> Vec<u32> {
    links
        .iter()
        .map(|link| {
            let id = w.alloc();
            let [a, b, c, d] = link.rect;
            w.object(id, &format!("<</Type /Annot /Subtype /Link /Rect [{} {} {} {}] /Border [0 0 0] /A <</S /URI /URI {}>>>>", n(a), n(b), n(c), n(d), ascii_string(&link.uri)));
            id
        })
        .collect()
}
