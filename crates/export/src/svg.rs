//! `shared/design/svg-export.ts` in Rust, statement for statement: the same elements, attributes in the same order,
//! definition ids counted in the same order, numbers through the same `formatNumber`, so the bytes are equal
//! (`MORFA_ENGINE_EXPORT=both` compares them). The TypeScript is the oracle; comments here only say where Rust has to
//! spell out what JavaScript does implicitly (object key order, truthiness, paint identity).

use std::collections::{HashMap, HashSet};
use std::f64::consts::PI;
use std::rc::Rc;

use morfa_geometry::bounds::has_variable_width;
use morfa_geometry::js;
use morfa_geometry::matrix::{
    IDENTITY, Rect, apply, invert, multiply, node_matrix, scaling, transform_rect, translation,
    union_rects, world_matrix,
};
use morfa_geometry::outline::outline_stroke;
use morfa_geometry::paths::{format_number, is_closed, paths_bounds, serialize_path_data};
use morfa_geometry::shapes::{node_corner_radii, node_geometry, resolve_corner_radii};
use morfa_model::types as m;
use morfa_model::{
    BlendMode, ColorStop, DesignDocument, Effect, GradientPaint, ImagePaint, ImageScaleMode,
    Matrix, NodeType, Paint, Rgb, SceneNode, ShadowEffect, StrokeAlign, StrokeCap, StrokeJoin,
    StrokeMarker, Vec2, VectorPath, WindingRule,
};
use morfa_text::measure::{MeasureCache, Measurer};
use morfa_text::types::TextLayout;

use crate::attrs;
use crate::strings::{
    family_value, is_letter, is_safe_href, is_safe_id_prefix, is_safe_image, layer_id_base,
    link_href,
};
use crate::stroke_profile::{max_width_factor, variable_width_outline};
use crate::text::{
    FillSource, PaintRef, layout_text, run_style, slot_source, slot_style, text_path_layout,
    top_fill,
};
use crate::xml::{Attr, Attrs, Child, El, Val, el, from_units, num, s, write};

/// `SvgExportOptions` without the measurer and the picture callbacks (passed beside it).
#[derive(Clone, Debug, Default)]
pub struct SvgOptions {
    /// Decimals in coordinates (default 3).
    pub precision: Option<i32>,
    pub id_prefix: Option<String>,
    pub layer_ids: bool,
    pub print: bool,
    pub crop: Option<Rect>,
    /// Text as paths of its glyphs (lane L3's outlines; needs the fonts of the text, feature `fonts`). Not a
    /// TypeScript option: the editor has no glyph outlines, so this flavour is Rust's alone.
    pub outline_text: bool,
}

/// A marker attribute on a tspan while outline text converts it (never written).
pub(crate) const SPAN_INDEX: &str = "data-l5-span";
/// The index of a text element's spans in `Exporter::texts` (the PDF flavour; never written).
pub(crate) const TEXT_INDEX: &str = "data-l5-text";

/// Why an export could not run in Rust (the caller falls back or reports it).
#[derive(Clone, Debug, PartialEq)]
pub struct Unsupported(pub String);

/// Where pictures come from: `imageData` (a data: URL) and `imageHref` (an https: URL), by image ref.
pub trait Pictures {
    fn data(&mut self, image_ref: &str) -> Option<String>;
    fn href(&mut self, image_ref: &str) -> Option<String>;
}

/// No pictures (image fills export as grey).
pub struct NoPictures;
impl Pictures for NoPictures {
    fn data(&mut self, _: &str) -> Option<String> {
        None
    }
    fn href(&mut self, _: &str) -> Option<String> {
        None
    }
}

/// An SVG and the page-space rectangle it shows.
#[derive(Clone, Debug, PartialEq)]
pub struct SvgPage {
    pub svg: String,
    pub bounds: Rect,
}

/// `exportSvgPage(doc, ids, options)`.
pub fn export_svg_page(
    doc: &DesignDocument,
    ids: &[String],
    options: &SvgOptions,
    measurer: &mut dyn Measurer,
    pictures: &mut dyn Pictures,
) -> SvgPage {
    Exporter::new(doc, options, measurer, pictures).document(ids)
}

/// `exportSvgPage`, refusing what this build cannot draw (outline text without fonts).
pub fn export_svg_page_checked(
    doc: &DesignDocument,
    ids: &[String],
    options: &SvgOptions,
    measurer: &mut dyn Measurer,
    pictures: &mut dyn Pictures,
) -> Result<SvgPage, Unsupported> {
    Exporter::new(doc, options, measurer, pictures).document_checked(ids)
}

/// `exportSvgPage` with the fonts outline text draws with (`options.outline_text`).
#[cfg(feature = "fonts")]
pub fn export_svg_page_outlined(
    doc: &DesignDocument,
    ids: &[String],
    options: &SvgOptions,
    measurer: &mut dyn Measurer,
    pictures: &mut dyn Pictures,
    fonts: &mut crate::fonts::Fonts,
) -> Result<SvgPage, Unsupported> {
    let mut exporter = Exporter::new(doc, options, measurer, pictures);
    exporter.fonts = Some(fonts);
    let page = exporter.document_checked(ids)?;
    Ok(page)
}

/// A text's glyphs and decorations as path commands in the node's own space (lane L4's server raster draws them
/// with vello_cpu, so thumbnails and PNGs show real glyphs where the browser paints sprites): one entry per span, with
/// the span's paint (`PaintRef`: the node's fills or a run's; None where the span inherits the text's). None when the
/// node is not a text, is empty, or a span's family has no face loaded (the caller reports the missing font).
#[cfg(feature = "fonts")]
#[derive(Clone, Debug)]
pub struct TextOutline {
    pub commands: Vec<morfa_model::PathCommand>,
    pub paint: Option<PaintRef>,
}

/// The [`TextOutline`]s of the text node `key`, laid out with `measurer` as the SVG export lays it out (lines,
/// alignment, markers, text on a path) and outlined with `fonts`.
#[cfg(feature = "fonts")]
pub fn text_outlines(
    doc: &DesignDocument,
    key: &str,
    measurer: &mut dyn Measurer,
    fonts: &mut crate::fonts::Fonts,
) -> Option<Vec<TextOutline>> {
    let node = doc.nodes.get(key)?;
    node.text.as_ref()?;
    let options = SvgOptions::default();
    let mut pictures = NoPictures;
    let mut exporter = Exporter::new(doc, &options, measurer, &mut pictures);
    // The PDF flavour keeps the spans instead of writing or outlining them: exactly what is needed here.
    exporter.keep_text = true;
    exporter.text(node)?;
    let spans = exporter.texts.pop()?;
    let mut out = Vec::with_capacity(spans.len());
    for span in &spans {
        let (commands, _) = span_commands(fonts, span)?;
        if commands.is_empty() {
            continue;
        }
        out.push(TextOutline {
            commands,
            paint: span.paint,
        });
    }
    Some(out)
}

/// `exportSvg(doc, ids, options)`.
pub fn export_svg(
    doc: &DesignDocument,
    ids: &[String],
    options: &SvgOptions,
    measurer: &mut dyn Measurer,
    pictures: &mut dyn Pictures,
) -> String {
    export_svg_page(doc, ids, options, measurer, pictures).svg
}

// ── Values ─────────────────────────────────────────────────────────────────────────────────────

fn channel(v: f64) -> String {
    let c = js::round(js::max(0.0, js::min(1.0, v)) * 255.0);
    if c.is_nan() {
        return "NaN".to_owned();
    }
    format!("{:02x}", c as i64)
}

pub(crate) fn hex(c: Rgb) -> String {
    format!("#{}{}{}", channel(c.r), channel(c.g), channel(c.b))
}

pub(crate) fn blend_css(mode: BlendMode) -> Option<&'static str> {
    Some(match mode {
        BlendMode::Darken => "darken",
        BlendMode::Multiply => "multiply",
        BlendMode::ColorBurn => "color-burn",
        BlendMode::Lighten => "lighten",
        BlendMode::Screen => "screen",
        BlendMode::ColorDodge => "color-dodge",
        BlendMode::Overlay => "overlay",
        BlendMode::SoftLight => "soft-light",
        BlendMode::HardLight => "hard-light",
        BlendMode::Difference => "difference",
        BlendMode::Exclusion => "exclusion",
        BlendMode::Hue => "hue",
        BlendMode::Saturation => "saturation",
        BlendMode::Color => "color",
        BlendMode::Luminosity => "luminosity",
        BlendMode::PassThrough | BlendMode::Normal => return None,
    })
}

fn blend_style(mode: BlendMode) -> Attr {
    blend_css(mode).map(|css| Val::Str(format!("mix-blend-mode:{css}")))
}

fn cap(c: StrokeCap) -> &'static str {
    match c {
        StrokeCap::None => "butt",
        StrokeCap::Round => "round",
        StrokeCap::Square => "square",
    }
}
fn join(j: StrokeJoin) -> &'static str {
    match j {
        StrokeJoin::Miter => "miter",
        StrokeJoin::Bevel => "bevel",
        StrokeJoin::Round => "round",
    }
}

pub(crate) fn frame_like(kind: NodeType) -> bool {
    matches!(
        kind,
        NodeType::Frame
            | NodeType::Component
            | NodeType::ComponentSet
            | NodeType::Instance
            | NodeType::Section
    )
}

/// `sampleStops`: colour and alpha at `t`.
pub(crate) fn sample_stops(stops: &[ColorStop], t: f64) -> (Rgb, f64) {
    if stops.is_empty() {
        return (
            Rgb {
                r: 0.0,
                g: 0.0,
                b: 0.0,
            },
            0.0,
        );
    }
    let rgb = |c: m::Rgba| Rgb {
        r: c.r,
        g: c.g,
        b: c.b,
    };
    if t <= stops[0].position {
        return (rgb(stops[0].color), stops[0].color.a);
    }
    for k in 1..stops.len() {
        let (a, b) = (stops[k - 1], stops[k]);
        if t <= b.position {
            let s = if b.position > a.position {
                (t - a.position) / (b.position - a.position)
            } else {
                1.0
            };
            let mix = |x: f64, y: f64| x + (y - x) * s;
            return (
                Rgb {
                    r: mix(a.color.r, b.color.r),
                    g: mix(a.color.g, b.color.g),
                    b: mix(a.color.b, b.color.b),
                },
                mix(a.color.a, b.color.a),
            );
        }
    }
    let last = stops[stops.len() - 1];
    (rgb(last.color), last.color.a)
}

/// `applyCase(text, textCase)` on code units.
fn apply_case(text: &[u16], case: m::TextCase) -> String {
    use morfa_text::segment::js_case;
    match case {
        m::TextCase::Upper => from_units(&js_case(text, true)),
        m::TextCase::Lower => from_units(&js_case(text, false)),
        m::TextCase::Title => {
            // text.replace(/(^|\s)(\p{L})/gu, (_, space, letter) => space + letter.toLocaleUpperCase('en'))
            let source = from_units(text);
            let mut out = String::with_capacity(source.len());
            let mut after_space = true;
            for c in source.chars() {
                if after_space && is_letter(c) {
                    out.extend(c.to_uppercase());
                    after_space = false;
                    continue;
                }
                after_space = crate::strings::is_js_space(c);
                out.push(c);
            }
            out
        }
        _ => from_units(text),
    }
}

fn opacity_attr(opacity: f64) -> Attr {
    if opacity < 1.0 { num(opacity) } else { None }
}

fn url(id: &str) -> Attr {
    s(format!("url(#{id})"))
}

fn paint_blend(paint: &Paint) -> BlendMode {
    match paint {
        Paint::Solid(p) => p.blend_mode,
        Paint::GradientLinear(p)
        | Paint::GradientRadial(p)
        | Paint::GradientAngular(p)
        | Paint::GradientDiamond(p) => p.blend_mode,
        Paint::Image(p) => p.blend_mode,
    }
}

fn is_solid(paint: &Paint) -> bool {
    matches!(paint, Paint::Solid(_))
}

fn shadows_of(effects: &[Effect]) -> Vec<(&ShadowEffect, bool)> {
    effects
        .iter()
        .filter_map(|e| match e {
            Effect::DropShadow(s) if s.visible => Some((s, false)),
            Effect::InnerShadow(s) if s.visible => Some((s, true)),
            _ => None,
        })
        .collect()
}

fn effect_visible(e: &Effect) -> bool {
    match e {
        Effect::DropShadow(s) | Effect::InnerShadow(s) => s.visible,
        Effect::LayerBlur(b) | Effect::BackgroundBlur(b) => b.visible,
    }
}

// ── The exporter ───────────────────────────────────────────────────────────────────────────────

/// Geometry as drawable elements (one per path), each with a clone for every use.
struct Shape {
    elements: Vec<El>,
    closed: bool,
    bounds: Option<Rect>,
    paths: Rc<Vec<VectorPath>>,
}

pub(crate) struct Exporter<'a> {
    doc: &'a DesignDocument,
    options: &'a SvgOptions,
    measurer: &'a mut dyn Measurer,
    pictures: &'a mut dyn Pictures,
    cache: MeasureCache,
    layouts: HashMap<String, Option<Rc<TextLayout>>>,
    booleans: HashMap<String, Rc<Vec<VectorPath>>>,
    defs: Vec<El>,
    counters: HashMap<&'static str, u32>,
    taken: HashSet<String>,
    precision: i32,
    #[cfg(feature = "fonts")]
    pub(crate) fonts: Option<&'a mut crate::fonts::Fonts>,
    pub(crate) unsupported: Option<String>,
    /// PDF flavour: text elements keep their spans here (`TEXT_INDEX`) instead of being outlined or written.
    pub(crate) keep_text: bool,
    pub(crate) texts: Vec<Vec<Span>>,
}

impl<'a> Exporter<'a> {
    pub(crate) fn new(
        doc: &'a DesignDocument,
        options: &'a SvgOptions,
        measurer: &'a mut dyn Measurer,
        pictures: &'a mut dyn Pictures,
    ) -> Self {
        Exporter {
            doc,
            options,
            measurer,
            pictures,
            cache: MeasureCache::new(),
            layouts: HashMap::new(),
            booleans: HashMap::new(),
            defs: Vec::new(),
            counters: HashMap::new(),
            taken: HashSet::new(),
            precision: options.precision.unwrap_or(3),
            #[cfg(feature = "fonts")]
            fonts: None,
            unsupported: None,
            keep_text: false,
            texts: Vec::new(),
        }
    }

    fn f(&self, v: f64) -> String {
        format_number(v, self.precision)
    }

    fn id(&mut self, prefix: &'static str) -> String {
        let page = match &self.options.id_prefix {
            Some(p) if is_safe_id_prefix(p) => p.as_str(),
            _ => "",
        };
        loop {
            let n = self.counters.entry(prefix).or_insert(0);
            let id = format!("{page}{prefix}{n}");
            *n += 1;
            if !self.taken.contains(&id) {
                self.taken.insert(id.clone());
                return id;
            }
        }
    }

    fn layer_id(&mut self, node: &SceneNode) -> Attr {
        if !self.options.layer_ids {
            return None;
        }
        let base = layer_id_base(&node.name);
        let mut id = base.clone();
        let mut n = 2;
        while self.taken.contains(&id) {
            id = format!("{base}_{n}");
            n += 1;
        }
        self.taken.insert(id.clone());
        s(id)
    }

    fn def(&mut self, element: El) -> String {
        let id = match element.attrs.get("id") {
            Some(Val::Str(id)) => id.clone(),
            _ => String::new(),
        };
        self.defs.push(element);
        id
    }

    pub(crate) fn matrix_value(&self, m: &Matrix) -> Attr {
        let [[a, c, e], [b, d, f]] = *m;
        if a == 1.0 && b == 0.0 && c == 0.0 && d == 1.0 {
            let truthy = |v: f64| v != 0.0 && !v.is_nan();
            return if truthy(e) || truthy(f) {
                s(format!("translate({} {})", self.f(e), self.f(f)))
            } else {
                None
            };
        }
        let fine = |v: f64| format_number(v, self.precision + 3);
        s(format!(
            "matrix({} {} {} {} {} {})",
            fine(a),
            fine(b),
            fine(c),
            fine(d),
            self.f(e),
            self.f(f)
        ))
    }

    // Text layout ──────────────────────────────────────────────────────────────────────────────

    fn layout(&mut self, node: &SceneNode) -> Option<Rc<TextLayout>> {
        if let Some(hit) = self.layouts.get(&node.id) {
            return hit.clone();
        }
        let layout = layout_text(node, &mut self.cache, self.measurer).map(Rc::new);
        self.layouts.insert(node.id.clone(), layout.clone());
        layout
    }

    // Geometry ─────────────────────────────────────────────────────────────────────────────────

    fn boolean_paths(&mut self, node: &SceneNode) -> Rc<Vec<VectorPath>> {
        if let Some(hit) = self.booleans.get(&node.id) {
            return hit.clone();
        }
        let paths = Rc::new(morfa_geometry::boolean::boolean_geometry(
            self.doc, &node.id,
        ));
        self.booleans.insert(node.id.clone(), paths.clone());
        paths
    }

    fn shape_of(&mut self, node: &SceneNode) -> Option<Shape> {
        let (w, h) = (node.width, node.height);
        if frame_like(node.kind) || node.kind == NodeType::Rectangle {
            let radii = resolve_corner_radii(w, h, &node_corner_radii(node)).map(|c| c.radius);
            let uniform = radii.iter().all(|r| (r - radii[0]).abs() < 1e-9);
            let falsy = |v: f64| v == 0.0 || v.is_nan();
            if uniform && (falsy(radii[0]) || node.corner_smoothing.is_none_or(falsy)) {
                let rect = el(
                    "rect",
                    attrs! {"width" => num(w), "height" => num(h), "rx" => if falsy(radii[0]) { None } else { num(radii[0]) }},
                    vec![],
                );
                return Some(Shape {
                    elements: vec![rect],
                    closed: true,
                    bounds: Some(Rect::new(0.0, 0.0, w, h)),
                    paths: Rc::new(node_geometry(node)),
                });
            }
        }
        if node.kind == NodeType::Ellipse {
            let arc = node.arc_data.as_ref();
            let sweep = arc.map_or(2.0 * PI, |a| (a.ending_angle - a.starting_angle).abs());
            let full = match arc {
                None => true,
                Some(a) => {
                    (sweep >= 2.0 * PI - 1e-6 || sweep < 1e-9)
                        && (a.inner_radius == 0.0 || a.inner_radius.is_nan())
                }
            };
            if full {
                let element = if (w - h).abs() < 1e-9 {
                    el(
                        "circle",
                        attrs! {"cx" => num(w / 2.0), "cy" => num(h / 2.0), "r" => num(w / 2.0)},
                        vec![],
                    )
                } else {
                    el(
                        "ellipse",
                        attrs! {"cx" => num(w / 2.0), "cy" => num(h / 2.0), "rx" => num(w / 2.0), "ry" => num(h / 2.0)},
                        vec![],
                    )
                };
                return Some(Shape {
                    elements: vec![element],
                    closed: true,
                    bounds: Some(Rect::new(0.0, 0.0, w, h)),
                    paths: Rc::new(node_geometry(node)),
                });
            }
        }
        let paths = if node.kind == NodeType::BooleanOperation {
            self.boolean_paths(node)
        } else {
            Rc::new(node_geometry(node))
        };
        self.path_shape(&paths)
    }

    fn path_shape(&self, paths: &[VectorPath]) -> Option<Shape> {
        let drawn: Vec<VectorPath> = paths
            .iter()
            .filter(|p| !p.commands.is_empty())
            .cloned()
            .collect();
        if drawn.is_empty() {
            return None;
        }
        Some(Shape {
            elements: drawn
                .iter()
                .map(|p| {
                    el(
                        "path",
                        attrs! {
                            "fill-rule" => if p.winding_rule == WindingRule::Evenodd { s("evenodd") } else { None },
                            "clip-rule" => None,
                            "d" => s(serialize_path_data(&p.commands, self.precision)),
                        },
                        vec![],
                    )
                })
                .collect(),
            closed: drawn.iter().all(|p| is_closed(&p.commands)),
            bounds: paths_bounds(&drawn),
            paths: Rc::new(drawn),
        })
    }

    fn clone_el(element: &El, attrs: Attrs) -> El {
        let mut out = element.clone();
        out.attrs.merge(&attrs);
        out
    }

    fn clip_of(&mut self, shape: &Shape) -> String {
        let id = self.id("clip");
        let children = shape
            .elements
            .iter()
            .map(|e| {
                Self::clone_el(
                    e,
                    attrs! {"clip-rule" => e.attrs.get("fill-rule").cloned(), "fill-rule" => None},
                )
            })
            .collect();
        self.def(el("clipPath", attrs! {"id" => s(id)}, children))
    }

    // Paints ───────────────────────────────────────────────────────────────────────────────────

    fn paint_value(&mut self, paint: &Paint, w: f64, h: f64) -> Option<String> {
        match paint {
            Paint::Solid(p) => Some(hex(p.color)),
            Paint::Image(p) => Some(
                self.image_pattern(p, w, h)
                    .unwrap_or_else(|| "#d9d9d9".to_owned()),
            ),
            Paint::GradientLinear(p) => self.gradient(p, true, w, h),
            Paint::GradientRadial(p) => self.gradient(p, false, w, h),
            _ => None,
        }
    }

    fn handle_frame(paint: &GradientPaint, w: f64, h: f64, linear: bool) -> Option<Matrix> {
        let [p0, p1, p2] = paint.gradient_handle_positions.map(|p| Vec2 {
            x: p.x * w,
            y: p.y * h,
        });
        let ax = Vec2 {
            x: p1.x - p0.x,
            y: p1.y - p0.y,
        };
        let falsy = |v: f64| v == 0.0 || v.is_nan();
        if !ax.x.is_finite() || !ax.y.is_finite() || (falsy(ax.x) && falsy(ax.y)) {
            return None;
        }
        let k = if linear { 2.0 } else { 1.0 };
        let mut bx = Vec2 {
            x: (p2.x - p0.x) * k,
            y: (p2.y - p0.y) * k,
        };
        if (ax.x * bx.y - ax.y * bx.x).abs() < 1e-12 {
            bx = Vec2 { x: -ax.y, y: ax.x };
        }
        Some([[ax.x, bx.x, p0.x], [ax.y, bx.y, p0.y]])
    }

    fn stops(paint: &GradientPaint) -> Vec<El> {
        paint
            .gradient_stops
            .iter()
            .map(|st| {
                el(
                    "stop",
                    attrs! {
                        "offset" => num(js::max(0.0, js::min(1.0, st.position))),
                        "stop-color" => s(hex(Rgb { r: st.color.r, g: st.color.g, b: st.color.b })),
                        "stop-opacity" => if st.color.a < 1.0 { num(st.color.a) } else { None },
                    },
                    vec![],
                )
            })
            .collect()
    }

    fn gradient(&mut self, paint: &GradientPaint, linear: bool, w: f64, h: f64) -> Option<String> {
        let frame = Self::handle_frame(paint, w, h, linear)?;
        if paint.gradient_stops.is_empty() {
            return None;
        }
        let id = self.id(if linear {
            "paint_linear"
        } else {
            "paint_radial"
        });
        let mut common = attrs! {"id" => s(id.clone()), "gradientUnits" => s("userSpaceOnUse"), "gradientTransform" => self.matrix_value(&frame)};
        let element = if linear {
            common.0.extend(
                attrs! {"x1" => num(0.0), "y1" => num(0.0), "x2" => num(1.0), "y2" => num(0.0)}.0,
            );
            el("linearGradient", common, Self::stops(paint))
        } else {
            common
                .0
                .extend(attrs! {"cx" => num(0.0), "cy" => num(0.0), "r" => num(1.0)}.0);
            el("radialGradient", common, Self::stops(paint))
        };
        let id = self.def(element);
        Some(format!("url(#{id})"))
    }

    fn image_source(&mut self, image_ref: &str) -> Option<String> {
        if let Some(data) = self.pictures.data(image_ref).filter(|d| !d.is_empty()) {
            return if is_safe_image(&data) {
                Some(data)
            } else {
                None
            };
        }
        let href = self.pictures.href(image_ref)?;
        if !href.is_empty() && is_safe_href(&href) {
            Some(href)
        } else {
            None
        }
    }

    fn image_pattern(&mut self, paint: &ImagePaint, w: f64, h: f64) -> Option<String> {
        let (image, tile) = self.image_content(paint, w, h)?;
        let id = self.id("pattern");
        let id = self.def(el(
            "pattern",
            attrs! {"id" => s(id), "patternUnits" => s("userSpaceOnUse"), "width" => num(tile.0), "height" => num(tile.1)},
            vec![image],
        ));
        Some(format!("url(#{id})"))
    }

    fn image_content(&mut self, paint: &ImagePaint, w: f64, h: f64) -> Option<(El, (f64, f64))> {
        // `imageSource(paint.imageRef)`: an empty ref is falsy.
        if paint.image_ref.is_empty() {
            return None;
        }
        let data = self.image_source(&paint.image_ref)?;
        if !(w > 0.0 && h > 0.0) {
            return None;
        }
        let natural = self.doc.images.get(&paint.image_ref);
        let turn = ((paint.rotation.unwrap_or(0.0) % 360.0) + 360.0) % 360.0;
        let sideways = turn == 90.0 || turn == 270.0;
        let mut tile = (w, h);
        let mut image = match paint.scale_mode {
            ImageScaleMode::Crop => {
                let inverse = invert(&paint.image_transform.unwrap_or(IDENTITY));
                el(
                    "image",
                    attrs! {
                        "width" => num(1.0), "height" => num(1.0), "preserveAspectRatio" => s("none"),
                        "transform" => self.matrix_value(&multiply(&scaling(w, h), &inverse)),
                        "xlink:href" => s(data),
                    },
                    vec![],
                )
            }
            ImageScaleMode::Tile => {
                let factor = paint.scaling_factor.unwrap_or(1.0);
                tile = (
                    js::max(1.0, natural.map_or(w, |n| n.width) * factor),
                    js::max(1.0, natural.map_or(h, |n| n.height) * factor),
                );
                el(
                    "image",
                    attrs! {"width" => num(tile.0), "height" => num(tile.1), "preserveAspectRatio" => s("none"), "xlink:href" => s(data)},
                    vec![],
                )
            }
            _ => {
                let (bw, bh) = if sideways { (h, w) } else { (w, h) };
                el(
                    "image",
                    attrs! {
                        "x" => num((w - bw) / 2.0), "y" => num((h - bh) / 2.0), "width" => num(bw), "height" => num(bh),
                        "preserveAspectRatio" => s(if paint.scale_mode == ImageScaleMode::Fit { "xMidYMid meet" } else { "xMidYMid slice" }),
                        "xlink:href" => s(data),
                    },
                    vec![],
                )
            }
        };
        if turn != 0.0 && !turn.is_nan() && paint.scale_mode != ImageScaleMode::Crop {
            image = el(
                "g",
                attrs! {"transform" => s(format!("rotate({} {} {})", js::number_to_string(turn), self.f(tile.0 / 2.0), self.f(tile.1 / 2.0)))},
                vec![image],
            );
        }
        Some((image, tile))
    }

    fn paint_layer(&mut self, shape: &Shape, paint: &Paint, w: f64, h: f64) -> Vec<El> {
        let style = blend_style(paint_blend(paint));
        let opacity = opacity_attr(paint.opacity());
        if self.options.print {
            if let Paint::Image(image) = paint {
                if image.scale_mode != ImageScaleMode::Tile {
                    if let Some((content, _)) = self.image_content(image, w, h) {
                        let clip = self.clip_of(shape);
                        return vec![el(
                            "g",
                            attrs! {"clip-path" => url(&clip), "opacity" => opacity, "style" => style},
                            vec![content],
                        )];
                    }
                }
            }
        }
        if let Some(value) = self.paint_value(paint, w, h) {
            return shape
                .elements
                .iter()
                .map(|e| {
                    Self::clone_el(
                        e,
                        attrs! {"fill" => s(value.clone()), "fill-opacity" => opacity.clone(), "style" => style.clone()},
                    )
                })
                .collect();
        }
        let gradient = match paint {
            Paint::GradientAngular(g) | Paint::GradientDiamond(g) => g,
            _ => return Vec::new(),
        };
        let diamond = matches!(paint, Paint::GradientDiamond(_));
        let Some(frame) = Self::handle_frame(gradient, w, h, false) else {
            return Vec::new();
        };
        let back = invert(&frame);
        let mut corners = vec![
            Vec2 { x: 0.0, y: 0.0 },
            Vec2 { x: w, y: 0.0 },
            Vec2 { x: w, y: h },
            Vec2 { x: 0.0, y: h },
        ];
        if let Some(b) = shape.bounds {
            corners.push(Vec2 { x: b.x, y: b.y });
            corners.push(Vec2 {
                x: b.x + b.width,
                y: b.y + b.height,
            });
        }
        let reach = corners.iter().fold(f64::NEG_INFINITY, |m, p| {
            let q = apply(&back, *p);
            js::max(m, js::hypot(q.x, q.y))
        }) * 1.5
            + 1.0;
        let point = |x: f64, y: f64| apply(&frame, Vec2 { x, y });
        let d = |this: &Self, pts: &[Vec2]| {
            let mut out = String::from("M");
            for (i, p) in pts.iter().enumerate() {
                if i > 0 {
                    out.push('L');
                }
                out += &this.f(p.x);
                out.push(' ');
                out += &this.f(p.y);
            }
            out.push('Z');
            out
        };
        let mut pieces = Vec::new();
        if diamond {
            for (sx, sy) in [(1.0, 1.0), (-1.0, 1.0), (-1.0, -1.0), (1.0, -1.0)] {
                let id = self.id("paint_diamond");
                let transform = self.matrix_value(&frame);
                self.def(el(
                    "linearGradient",
                    attrs! {
                        "id" => s(id.clone()), "gradientUnits" => s("userSpaceOnUse"), "gradientTransform" => transform,
                        "x1" => num(0.0), "y1" => num(0.0), "x2" => num(sx / 2.0), "y2" => num(sy / 2.0),
                    },
                    Self::stops(gradient),
                ));
                let path = d(
                    self,
                    &[
                        point(0.0, 0.0),
                        point(sx * reach, 0.0),
                        point(sx * reach, sy * reach),
                        point(0.0, sy * reach),
                    ],
                );
                pieces.push(el(
                    "path",
                    attrs! {"d" => s(path), "fill" => url(&id)},
                    vec![],
                ));
            }
        } else {
            let count = 120usize;
            let overlap = if self.options.print
                && gradient.gradient_stops.iter().all(|st| st.color.a >= 1.0)
            {
                1.5
            } else {
                1.05
            };
            for k in 0..count {
                let kf = k as f64;
                let n = count as f64;
                let a0 = (kf / n) * 2.0 * PI;
                let a1 =
                    ((kf + if k == count - 1 {
                        js::min(overlap, 1.05)
                    } else {
                        overlap
                    }) / n)
                        * 2.0
                        * PI;
                let (color, a) = sample_stops(&gradient.gradient_stops, (kf + 0.5) / n);
                let path = d(
                    self,
                    &[
                        point(0.0, 0.0),
                        point(js::cos(a0) * reach, js::sin(a0) * reach),
                        point(js::cos(a1) * reach, js::sin(a1) * reach),
                    ],
                );
                pieces.push(el(
                    "path",
                    attrs! {"d" => s(path), "fill" => s(hex(color)), "fill-opacity" => if a < 1.0 { num(a) } else { None }},
                    vec![],
                ));
            }
        }
        let clip = self.clip_of(shape);
        vec![el(
            "g",
            attrs! {"clip-path" => url(&clip), "opacity" => opacity, "style" => style},
            pieces,
        )]
    }

    // Strokes ──────────────────────────────────────────────────────────────────────────────────

    fn outlined(&mut self, node: &SceneNode, shape: &Shape) -> Option<Shape> {
        let paths = outline_stroke(node, Some(&shape.paths), None);
        self.path_shape(&paths)
    }

    fn stroke_layers(&mut self, node: &SceneNode, shape: Option<&Shape>) -> Vec<El> {
        let paints: Vec<&Paint> = node.strokes.iter().filter(|p| p.visible()).collect();
        let Some(shape) = shape else {
            return Vec::new();
        };
        if paints.is_empty() {
            return Vec::new();
        }
        let (w, h) = (node.width, node.height);
        if has_variable_width(node) {
            let outlined = self.path_shape(&variable_width_outline(node));
            return match outlined {
                Some(o) => paints
                    .iter()
                    .flat_map(|p| self.paint_layer(&o, p, w, h))
                    .collect(),
                None => Vec::new(),
            };
        }
        let markers = matches!(node.kind, NodeType::Line | NodeType::Vector)
            && (node.stroke_start_marker.unwrap_or(StrokeMarker::None) != StrokeMarker::None
                || node.stroke_end_marker.unwrap_or(StrokeMarker::None) != StrokeMarker::None);
        if node.individual_stroke_weights.flatten().is_some() || markers {
            let outlined = self.outlined(node, shape);
            return match outlined {
                Some(o) => paints
                    .iter()
                    .flat_map(|p| self.paint_layer(&o, p, w, h))
                    .collect(),
                None => Vec::new(),
            };
        }
        if !(node.stroke_weight > 0.0) {
            return Vec::new();
        }
        let align = if shape.closed {
            node.stroke_align
        } else {
            StrokeAlign::Center
        };
        let width = if align == StrokeAlign::Center {
            node.stroke_weight
        } else {
            node.stroke_weight * 2.0
        };
        let common = attrs! {
            "fill" => s("none"),
            "stroke-width" => num(width),
            "stroke-linecap" => if node.stroke_cap != StrokeCap::None { s(cap(node.stroke_cap)) } else { None },
            "stroke-linejoin" => if node.stroke_join != StrokeJoin::Miter { s(join(node.stroke_join)) } else { None },
            "stroke-miterlimit" => if node.stroke_join == StrokeJoin::Miter && node.stroke_miter_limit != 4.0 { num(node.stroke_miter_limit) } else { None },
            "stroke-dasharray" => if node.dash_pattern.is_empty() { None } else {
                s(node.dash_pattern.iter().map(|v| self.f(*v)).collect::<Vec<_>>().join(" "))
            },
        };
        let mut layers = Vec::new();
        for paint in paints {
            let Some(value) = self.paint_value(paint, w, h) else {
                if let Some(o) = self.outlined(node, shape) {
                    let more = self.paint_layer(&o, paint, w, h);
                    layers.extend(more);
                }
                continue;
            };
            for e in &shape.elements {
                let mut a = common.clone();
                a.0.extend(
                    attrs! {
                        "fill-rule" => None,
                        "stroke" => s(value.clone()),
                        "stroke-opacity" => opacity_attr(paint.opacity()),
                        "style" => blend_style(paint_blend(paint)),
                    }
                    .0,
                );
                layers.push(Self::clone_el(e, a));
            }
        }
        match align {
            StrokeAlign::Inside => {
                let clip = self.clip_of(shape);
                vec![el("g", attrs! {"clip-path" => url(&clip)}, layers)]
            }
            StrokeAlign::Outside => {
                let b = shape.bounds.unwrap_or(Rect::new(0.0, 0.0, w, h));
                let pad = node.stroke_weight * 2.0 + 1.0;
                let region = Rect::new(
                    b.x - pad,
                    b.y - pad,
                    b.width + pad * 2.0,
                    b.height + pad * 2.0,
                );
                let id = self.id("mask");
                let mut children = vec![el(
                    "rect",
                    rect_attrs(region).with("fill", s("white")),
                    vec![],
                )];
                children.extend(
                    shape
                        .elements
                        .iter()
                        .map(|e| Self::clone_el(e, attrs! {"fill" => s("black")})),
                );
                let mut mask_attrs =
                    attrs! {"id" => s(id.clone()), "maskUnits" => s("userSpaceOnUse")};
                mask_attrs.0.extend(rect_attrs(region).0);
                self.def(el("mask", mask_attrs, children));
                vec![el("g", attrs! {"mask" => url(&id)}, layers)]
            }
            StrokeAlign::Center => layers,
        }
    }

    // Effects ──────────────────────────────────────────────────────────────────────────────────

    fn hard_alpha() -> El {
        el(
            "feColorMatrix",
            attrs! {"in" => s("SourceAlpha"), "type" => s("matrix"), "values" => s("0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0"), "result" => s("hardAlpha")},
            vec![],
        )
    }

    fn tint(&self, e: &ShadowEffect) -> El {
        el(
            "feColorMatrix",
            attrs! {"type" => s("matrix"), "values" => s(format!(
                "0 0 0 0 {} 0 0 0 0 {} 0 0 0 0 {} 0 0 0 {} 0",
                self.f(e.color.r), self.f(e.color.g), self.f(e.color.b), self.f(e.color.a)
            ))},
            vec![],
        )
    }

    fn offset(e: &ShadowEffect) -> El {
        let truthy = |v: f64| {
            if v != 0.0 && !v.is_nan() {
                num(v)
            } else {
                None
            }
        };
        el(
            "feOffset",
            attrs! {"dx" => truthy(e.offset.x), "dy" => truthy(e.offset.y)},
            vec![],
        )
    }

    fn filter_def(&mut self, id: String, region: Rect, primitives: Vec<El>) {
        let mut a = attrs! {"id" => s(id), "filterUnits" => s("userSpaceOnUse"), "color-interpolation-filters" => s("sRGB")};
        a.0.extend(rect_attrs(region).0);
        self.def(el("filter", a, primitives));
    }

    fn filter(&mut self, effects: &[Effect], region: Rect, transparent: bool) -> Attr {
        let visible: Vec<&Effect> = effects
            .iter()
            .filter(|e| effect_visible(e) && !matches!(e, Effect::BackgroundBlur(_)))
            .collect();
        if visible.is_empty() {
            return None;
        }
        let id = self.id("filter");
        let mut primitives = vec![el(
            "feFlood",
            attrs! {"flood-opacity" => num(0.0), "result" => s("BackgroundImageFix")},
            vec![],
        )];
        let mode = |e: &ShadowEffect| blend_css(e.blend_mode).unwrap_or("normal");
        let mut below = "BackgroundImageFix".to_owned();
        let mut n = 0;
        for e in &visible {
            let Effect::DropShadow(e) = e else { continue };
            n += 1;
            primitives.push(Self::hard_alpha());
            if e.spread != 0.0 && !e.spread.is_nan() {
                primitives.push(el(
                    "feMorphology",
                    attrs! {"radius" => num(e.spread.abs()), "operator" => s(if e.spread > 0.0 { "dilate" } else { "erode" }), "in" => s("SourceAlpha"), "result" => s(format!("effect{n}_spread"))},
                    vec![],
                ));
            }
            primitives.push(Self::offset(e));
            if e.radius > 0.0 {
                primitives.push(el(
                    "feGaussianBlur",
                    attrs! {"stdDeviation" => num(e.radius / 2.0)},
                    vec![],
                ));
            }
            if !e.show_shadow_behind_node.unwrap_or(false) && transparent {
                primitives.push(el(
                    "feComposite",
                    attrs! {"in2" => s("hardAlpha"), "operator" => s("out")},
                    vec![],
                ));
            }
            primitives.push(self.tint(e));
            let result = format!("effect{n}_dropShadow");
            primitives.push(el("feBlend", attrs! {"mode" => s(mode(e)), "in2" => s(below.clone()), "result" => s(result.clone())}, vec![]));
            below = result;
        }
        primitives.push(el("feBlend", attrs! {"mode" => s("normal"), "in" => s("SourceGraphic"), "in2" => s(below), "result" => s("shape")}, vec![]));
        let mut current = "shape".to_owned();
        for e in &visible {
            let Effect::InnerShadow(e) = e else { continue };
            n += 1;
            primitives.push(Self::hard_alpha());
            if e.spread != 0.0 && !e.spread.is_nan() {
                primitives.push(el(
                    "feMorphology",
                    attrs! {"radius" => num(e.spread.abs()), "operator" => s(if e.spread > 0.0 { "erode" } else { "dilate" }), "in" => s("SourceAlpha"), "result" => s(format!("effect{n}_spread"))},
                    vec![],
                ));
            }
            primitives.push(Self::offset(e));
            if e.radius > 0.0 {
                primitives.push(el(
                    "feGaussianBlur",
                    attrs! {"stdDeviation" => num(e.radius / 2.0)},
                    vec![],
                ));
            }
            primitives.push(el(
                "feComposite",
                attrs! {"in2" => s("hardAlpha"), "operator" => s("arithmetic"), "k2" => num(-1.0), "k3" => num(1.0)},
                vec![],
            ));
            primitives.push(self.tint(e));
            let result = format!("effect{n}_innerShadow");
            primitives.push(el("feBlend", attrs! {"mode" => s(mode(e)), "in2" => s(current.clone()), "result" => s(result.clone())}, vec![]));
            current = result;
        }
        for e in &visible {
            let Effect::LayerBlur(b) = e else { continue };
            if !(b.radius > 0.0) {
                continue;
            }
            n += 1;
            let result = format!("effect{n}_foregroundBlur");
            primitives.push(el(
                "feGaussianBlur",
                attrs! {"in" => s(current.clone()), "stdDeviation" => num(b.radius / 2.0), "result" => s(result.clone())},
                vec![],
            ));
            current = result;
        }
        self.filter_def(id.clone(), region, primitives);
        url(&id)
    }

    fn shadow_only(
        &mut self,
        e: &ShadowEffect,
        inner: bool,
        region: Rect,
        transparent: bool,
    ) -> String {
        let id = self.id("filter");
        let mut primitives = vec![Self::hard_alpha()];
        if e.spread != 0.0 && !e.spread.is_nan() {
            primitives.push(el(
                "feMorphology",
                attrs! {"radius" => num(e.spread.abs()), "operator" => s(if (e.spread > 0.0) != inner { "dilate" } else { "erode" }), "in" => s("SourceAlpha")},
                vec![],
            ));
        }
        primitives.push(Self::offset(e));
        if e.radius > 0.0 {
            primitives.push(el(
                "feGaussianBlur",
                attrs! {"stdDeviation" => num(e.radius / 2.0)},
                vec![],
            ));
        }
        if inner {
            primitives.push(el(
                "feComposite",
                attrs! {"in2" => s("hardAlpha"), "operator" => s("arithmetic"), "k2" => num(-1.0), "k3" => num(1.0)},
                vec![],
            ));
        } else if !e.show_shadow_behind_node.unwrap_or(false) && transparent {
            primitives.push(el(
                "feComposite",
                attrs! {"in2" => s("hardAlpha"), "operator" => s("out")},
                vec![],
            ));
        }
        primitives.push(self.tint(e));
        self.filter_def(id.clone(), region, primitives);
        format!("url(#{id})")
    }

    // Bounds ───────────────────────────────────────────────────────────────────────────────────

    /// What a node paints, in its local space (strokes and effects included).
    pub(crate) fn local_bounds(&mut self, node: &SceneNode, depth: usize) -> Option<Rect> {
        if !node.visible || node.kind == NodeType::Slice || depth > 256 {
            return None;
        }
        let own = Rect::new(0.0, 0.0, node.width, node.height);
        let mut b = if matches!(node.kind, NodeType::Group | NodeType::Page) {
            self.children_bounds(node, depth)
        } else if frame_like(node.kind) {
            let children = self.children_bounds(node, depth);
            let mut boxes = vec![own];
            if let Some(c) = children {
                if !node.clips_content.unwrap_or(false) {
                    boxes.push(c);
                }
            }
            union_rects(&boxes)
        } else if node.kind == NodeType::Text {
            let placed = if node.text_path.is_some() && node.text.is_some() {
                self.layout(node)
                    .and_then(|layout| text_path_layout(node, &layout).bounds)
            } else {
                None
            };
            match placed {
                Some(p) => union_rects(&[own, p]),
                None => Some(own),
            }
        } else {
            self.shape_of(node).and_then(|shape| shape.bounds)
        }?;
        if node.strokes.iter().any(Paint::visible) && node.kind != NodeType::Group {
            let markers = node.stroke_start_marker.unwrap_or(StrokeMarker::None)
                != StrokeMarker::None
                || node.stroke_end_marker.unwrap_or(StrokeMarker::None) != StrokeMarker::None;
            let weight = match node.individual_stroke_weights.flatten() {
                Some(w) => [w.top, w.right, w.bottom, w.left]
                    .into_iter()
                    .fold(f64::NEG_INFINITY, js::max),
                None => node.stroke_weight,
            };
            let open = node.kind == NodeType::Line
                || (node.kind == NodeType::Vector
                    && !node
                        .vector_paths
                        .as_deref()
                        .unwrap_or_default()
                        .iter()
                        .all(|p| is_closed(&p.commands)));
            let mut pad = if open {
                weight / 2.0
            } else {
                match node.stroke_align {
                    StrokeAlign::Center => weight / 2.0,
                    StrokeAlign::Outside => weight,
                    StrokeAlign::Inside => 0.0,
                }
            };
            if node.stroke_cap == StrokeCap::Square && open {
                pad = weight * std::f64::consts::FRAC_1_SQRT_2;
            }
            if markers {
                pad = js::max(pad, weight * 3.0 + 4.0);
            }
            if has_variable_width(node) {
                pad = (node.stroke_weight
                    * max_width_factor(node.variable_width_stroke_properties.as_ref()))
                    / 2.0;
            }
            b = Rect::new(
                b.x - pad,
                b.y - pad,
                b.width + pad * 2.0,
                b.height + pad * 2.0,
            );
        }
        Some(with_effects(b, &node.effects))
    }

    fn children_bounds(&mut self, node: &SceneNode, depth: usize) -> Option<Rect> {
        let doc = self.doc;
        let mut boxes = Vec::new();
        for id in node.children.as_deref().unwrap_or_default() {
            let Some(child) = doc.nodes.get(id) else {
                continue;
            };
            if child.is_mask {
                continue;
            }
            if let Some(b) = self.local_bounds(child, depth + 1) {
                boxes.push(transform_rect(&node_matrix(child), &b));
            }
        }
        union_rects(&boxes)
    }

    // Nodes ────────────────────────────────────────────────────────────────────────────────────

    /// A node drawn in its parent's coordinates (`matrix`: local → parent).
    pub(crate) fn node(
        &mut self,
        node: &SceneNode,
        matrix: &Matrix,
        depth: usize,
        as_mask: bool,
    ) -> Option<El> {
        if !node.visible
            || node.kind == NodeType::Slice
            || depth > 256
            || (node.is_mask && !as_mask)
        {
            return None;
        }
        let layer_id = self.layer_id(node);
        let mut content: Vec<El> = Vec::new();
        let (w, h) = (node.width, node.height);
        if matches!(node.kind, NodeType::Group | NodeType::Page) {
            content.extend(self.children(node, depth));
        } else if node.kind == NodeType::Text {
            if let Some(text) = self.text(node) {
                content.push(text);
            }
        } else {
            let shape = self.shape_of(node);
            let mut fills: Vec<El> = Vec::new();
            if let Some(shape) = &shape {
                if node.kind != NodeType::Line {
                    for paint in &node.fills {
                        if paint.visible() {
                            fills.extend(self.paint_layer(shape, paint, w, h));
                        }
                    }
                }
            }
            let children = if frame_like(node.kind) {
                self.children(node, depth)
            } else {
                Vec::new()
            };
            match &shape {
                Some(shape)
                    if !children.is_empty()
                        && node.clips_content.unwrap_or(false)
                        && node.kind != NodeType::Section =>
                {
                    let inside = node.fills.iter().all(|p| {
                        !p.visible()
                            || matches!(paint_blend(p), BlendMode::Normal | BlendMode::PassThrough)
                    });
                    let clip = self.clip_of(shape);
                    if inside {
                        let mut all = fills;
                        all.extend(children);
                        content.push(el("g", attrs! {"clip-path" => url(&clip)}, all));
                    } else {
                        content.extend(fills);
                        content.push(el("g", attrs! {"clip-path" => url(&clip)}, children));
                    }
                }
                _ => {
                    content.extend(fills);
                    if !children.is_empty() {
                        content.push(el("g", Attrs::new(), children));
                    }
                }
            }
            content.extend(self.stroke_layers(node, shape.as_ref()));
        }
        let mut flat: Vec<El> = Vec::new();
        for c in content {
            if c.tag == "g" && !c.attrs.any_written() {
                flat.extend(c.into_elements());
            } else {
                flat.push(c);
            }
        }
        if flat.is_empty() {
            return None;
        }
        let transparent = node
            .fills
            .iter()
            .any(|p| p.visible() && (p.opacity() < 1.0 || !is_solid(p)));
        let region = if node.effects.iter().any(effect_visible) {
            self.local_bounds(node, 0)
        } else {
            None
        };
        let shadows = shadows_of(&node.effects);
        let layer_blur = node
            .effects
            .iter()
            .any(|e| matches!(e, Effect::LayerBlur(b) if b.visible && b.radius > 0.0));
        let node_style = if matches!(node.blend_mode, BlendMode::PassThrough | BlendMode::Normal) {
            None
        } else {
            blend_style(node.blend_mode)
        };
        if self.options.print && !shadows.is_empty() && !layer_blur {
            if let Some(region) = region {
                let content_id = self.id("content");
                let padded = pad(region);
                let mut children = Vec::new();
                for (e, inner) in shadows.iter().filter(|(_, inner)| !inner) {
                    let filter = self.shadow_only(e, *inner, padded, transparent);
                    children.push(el(
                        "use",
                        attrs! {"href" => s(format!("#{content_id}")), "filter" => s(filter), "style" => blend_style(e.blend_mode)},
                        vec![],
                    ));
                }
                children.push(el("g", attrs! {"id" => s(content_id.clone())}, flat));
                for (e, inner) in shadows.iter().filter(|(_, inner)| *inner) {
                    let filter = self.shadow_only(e, *inner, padded, transparent);
                    children.push(el(
                        "use",
                        attrs! {"href" => s(format!("#{content_id}")), "filter" => s(filter), "style" => blend_style(e.blend_mode)},
                        vec![],
                    ));
                }
                return Some(el(
                    "g",
                    attrs! {"transform" => self.matrix_value(matrix), "opacity" => opacity_attr(node.opacity), "style" => node_style},
                    children,
                ));
            }
        }
        let filter = match region {
            Some(r) => self.filter(&node.effects, pad(r), transparent),
            None => None,
        };
        let attrs = attrs! {
            "id" => layer_id,
            "transform" => self.matrix_value(matrix),
            "opacity" => opacity_attr(node.opacity),
            "style" => node_style,
            "filter" => filter.clone(),
        };
        if flat.len() == 1 {
            let only = &flat[0].attrs;
            if filter.is_none()
                && !only.truthy("transform")
                && !only.truthy("opacity")
                && !only.truthy("style")
                && !only.truthy("filter")
                && !(attrs.truthy("id") && only.truthy("id"))
            {
                let mut only = flat.pop().expect("one element");
                only.attrs.merge(&attrs.defined());
                return Some(only);
            }
        }
        Some(el("g", attrs, flat))
    }

    /// Children bottom to top; a mask masks the siblings above it up to the next mask.
    fn children(&mut self, parent: &SceneNode, depth: usize) -> Vec<El> {
        let doc = self.doc;
        let mut out: Vec<El> = Vec::new();
        let mut target: Option<usize> = None;
        for id in parent.children.as_deref().unwrap_or_default() {
            let Some(child) = doc.nodes.get(id) else {
                continue;
            };
            if child.is_mask {
                if !child.visible {
                    target = None;
                    continue;
                }
                let group = el("g", self.mask_attrs(child, parent, depth), vec![]);
                out.push(group);
                target = Some(out.len() - 1);
                continue;
            }
            if let Some(drawn) = self.node(child, &node_matrix(child), depth + 1, false) {
                match target {
                    Some(i) => out[i].children.push(Child::El(drawn)),
                    None => out.push(drawn),
                }
            }
        }
        out.retain(|e| e.tag != "g" || !e.children.is_empty() || e.attrs.truthy("transform"));
        out
    }

    fn mask_attrs(&mut self, mask: &SceneNode, parent: &SceneNode, depth: usize) -> Attrs {
        if mask.mask_type == Some(m::MaskType::Vector) {
            let mut elements = Vec::new();
            self.collect_vector_mask(mask, &node_matrix(mask), 0, &mut elements);
            let id = self.id("clip");
            self.def(el("clipPath", attrs! {"id" => s(id.clone())}, elements));
            return attrs! {"clip-path" => url(&id)};
        }
        let content = self.node(mask, &node_matrix(mask), depth + 1, true);
        let region = self.children_bounds(parent, depth).unwrap_or(Rect::new(
            0.0,
            0.0,
            parent.width,
            parent.height,
        ));
        let id = self.id("mask");
        let mut a = attrs! {
            "id" => s(id.clone()),
            "maskUnits" => s("userSpaceOnUse"),
            "style" => if mask.mask_type == Some(m::MaskType::Luminance) { None } else { s("mask-type:alpha") },
        };
        a.0.extend(rect_attrs(pad(region)).0);
        self.def(el("mask", a, content.into_iter().collect()));
        attrs! {"mask" => url(&id)}
    }

    fn collect_vector_mask(
        &mut self,
        node: &SceneNode,
        matrix: &Matrix,
        level: usize,
        out: &mut Vec<El>,
    ) {
        if !node.visible || level > 64 {
            return;
        }
        let doc = self.doc;
        if node.kind == NodeType::Group {
            for id in node.children.as_deref().unwrap_or_default() {
                if let Some(child) = doc.nodes.get(id) {
                    self.collect_vector_mask(
                        child,
                        &multiply(matrix, &node_matrix(child)),
                        level + 1,
                        out,
                    );
                }
            }
            return;
        }
        let shape = if node.kind == NodeType::Text {
            None
        } else {
            self.shape_of(node)
        };
        for e in shape.map(|s| s.elements).unwrap_or_default() {
            let transform = self.matrix_value(matrix);
            let rule = e.attrs.get("fill-rule").cloned();
            out.push(Self::clone_el(
                &e,
                attrs! {"transform" => transform, "clip-rule" => rule, "fill-rule" => None},
            ));
        }
    }

    // Text ─────────────────────────────────────────────────────────────────────────────────────

    fn text(&mut self, node: &SceneNode) -> Option<El> {
        let text = node.text.as_ref()?;
        if text.characters.is_empty() {
            return None;
        }
        let layout = self.layout(node)?;
        let base = &text.style;
        let (w, h) = (node.width, node.height);
        let node_fill = top_fill(node, FillSource::Node);
        let mut spans: Vec<Span> = Vec::new();
        let placed = if node.text_path.is_some() {
            Some(text_path_layout(node, &layout))
        } else {
            None
        };
        if let Some(placed) = &placed {
            for glyph in &placed.glyphs {
                let run = &layout.lines[glyph.line].runs[glyph.run];
                let st = run_style(node, &layout, run);
                let mut a = attrs! {
                    "x" => num(glyph.origin.x),
                    "y" => num(glyph.origin.y),
                    "rotate" => if glyph.angle.abs() > 1e-9 { num((glyph.angle * 180.0) / PI) } else { None },
                };
                a.0.extend(font_attrs(&st, base).0);
                if st.text_decoration != base.text_decoration {
                    a.set("text-decoration", s(decoration(&st).unwrap_or("none")));
                }
                if st.text_case == m::TextCase::SmallCaps
                    && base.text_case != m::TextCase::SmallCaps
                {
                    a.set("font-variant", s("small-caps"));
                }
                let link = self.link_of(&st);
                let paint = top_fill(node, slot_source(node, &layout, run.slot));
                spans.push(Span {
                    attrs: a,
                    text: from_units(&glyph.text),
                    paint,
                    link,
                    font: span_font(&st),
                    x: glyph.origin.x,
                    y: glyph.origin.y,
                    spacing: 0.0,
                    underline: underlined(base) || underlined(&st),
                    strike: struck(base) || struck(&st),
                    angle: glyph.angle,
                });
            }
        } else {
            for line in &layout.lines {
                if let Some(marker) = &line.marker {
                    let st = slot_style(node, &layout, marker.slot);
                    let mut a = attrs! {"x" => num(marker.x), "y" => num(line.baseline)};
                    a.0.extend(font_attrs(&st, base).0);
                    let source = slot_source(node, &layout, marker.slot);
                    let paint = if crate::text::fills_of(node, source).is_empty() {
                        node_fill
                    } else {
                        top_fill(node, source)
                    };
                    spans.push(Span {
                        attrs: a,
                        text: marker.text.clone(),
                        paint,
                        link: None,
                        font: span_font(&st),
                        x: marker.x,
                        y: line.baseline,
                        spacing: spacing(base),
                        underline: underlined(base),
                        strike: struck(base),
                        angle: 0.0,
                    });
                }
                for run in &line.runs {
                    if run.text.is_empty() {
                        continue;
                    }
                    let st = run_style(node, &layout, run);
                    let mut a = attrs! {"x" => num(run.x), "y" => num(line.baseline)};
                    a.0.extend(font_attrs(&st, base).0);
                    if spacing(&st) != spacing(base) {
                        a.set("letter-spacing", num(spacing(&st)));
                    }
                    if st.text_decoration != base.text_decoration {
                        a.set("text-decoration", s(decoration(&st).unwrap_or("none")));
                    }
                    if st.text_case == m::TextCase::SmallCaps
                        && base.text_case != m::TextCase::SmallCaps
                    {
                        a.set("font-variant", s("small-caps"));
                    }
                    let link = self.link_of(&st);
                    let paint = top_fill(node, slot_source(node, &layout, run.slot));
                    spans.push(Span {
                        attrs: a,
                        text: apply_case(&run.text, st.text_case),
                        paint,
                        link,
                        font: span_font(&st),
                        x: run.x,
                        y: line.baseline,
                        spacing: spacing(&st),
                        underline: underlined(base) || underlined(&st),
                        strike: struck(base) || struck(&st),
                        angle: 0.0,
                    });
                }
            }
        }
        if spans.is_empty() {
            return None;
        }
        let strokes: Vec<&Paint> = node.strokes.iter().filter(|p| p.visible()).collect();
        let stroke = if !strokes.is_empty() && node.stroke_weight > 0.0 {
            self.paint_value(strokes[strokes.len() - 1], w, h)
        } else {
            None
        };
        let on_path = placed.is_some();
        let text_attrs = |this: &Self, fill: Attrs, with_stroke: bool| -> Attrs {
            let mut a = attrs! {"xml:space" => s("preserve")};
            a.0.extend(fill.0);
            let ls = spacing(base);
            a.0.extend(
                attrs! {
                    "font-family" => s(family_value(&base.font_family)),
                    "font-size" => num(base.font_size),
                    "font-weight" => if base.font_weight != 400.0 { num(base.font_weight) } else { None },
                    "font-style" => if base.italic { s("italic") } else { None },
                    "letter-spacing" => if on_path || ls == 0.0 || ls.is_nan() { None } else { num(ls) },
                    "text-decoration" => decoration(base).map(Val::from),
                    "font-variant" => if base.text_case == m::TextCase::SmallCaps { s("small-caps") } else { None },
                    "stroke" => if with_stroke { stroke.clone().map(Val::Str) } else { None },
                    "stroke-width" => if with_stroke && stroke.is_some() { num(node.stroke_weight) } else { None },
                }
                .0,
            );
            let _ = this;
            a
        };
        let outline = self.outline_text() || self.keep_text;
        let tspan = |span: &Span, fill: Attrs| -> El {
            let mut a = span.attrs.clone();
            a.merge(&fill);
            if outline {
                let index = spans
                    .iter()
                    .position(|other| std::ptr::eq(other, span))
                    .expect("a span of this text");
                a.set(SPAN_INDEX, num(index as f64));
            }
            El {
                tag: "tspan",
                attrs: a,
                children: vec![Child::Text(span.text.clone())],
            }
        };
        let linked = |span: &Span, fill: Attrs| -> El {
            match &span.link {
                Some(href) => el(
                    "a",
                    attrs! {"href" => s(href.clone())},
                    vec![tspan(span, fill)],
                ),
                None => tspan(span, fill),
            }
        };
        let plain = |paint: Option<PaintRef>| paint.is_none_or(|p| is_solid(p.get(node)));
        if !self.options.print || spans.iter().all(|span| plain(span.paint)) {
            let fill = self.fill_attrs(node, node_fill);
            let head = text_attrs(self, fill, true);
            let mut children = Vec::new();
            for span in &spans {
                let fill = if span.paint != node_fill {
                    self.fill_attrs(node, span.paint)
                } else {
                    Attrs::new()
                };
                children.push(linked(span, fill));
            }
            return Some(self.finish_text(el("text", head, children), &spans));
        }
        let mut out = Vec::new();
        let own = if plain(node_fill) { node_fill } else { None };
        let solid: Vec<&Span> = spans.iter().filter(|span| plain(span.paint)).collect();
        if !solid.is_empty() {
            let fill = self.fill_attrs(node, own);
            let head = text_attrs(self, fill, true);
            let mut children = Vec::new();
            for span in solid {
                let fill = if span.paint != own {
                    self.fill_attrs(node, span.paint)
                } else {
                    Attrs::new()
                };
                children.push(linked(span, fill));
            }
            let text_el = self.finish_text(el("text", head, children), &spans);
            out.push(text_el);
        }
        let pad = base.font_size * 2.0;
        let reach: Vec<Rect> = match placed.as_ref().and_then(|p| p.bounds) {
            Some(b) => vec![b],
            None => layout
                .lines
                .iter()
                .map(|l| Rect::new(l.x, l.top, l.width, l.height))
                .collect(),
        };
        let top = reach.iter().fold(0.0, |m, r| js::min(m, r.y)) - pad;
        let bottom = reach
            .iter()
            .fold(node.height, |m, r| js::max(m, r.y + r.height))
            + pad;
        let left = reach.iter().fold(0.0, |m, r| js::min(m, r.x)) - pad;
        let right = reach
            .iter()
            .fold(node.width, |m, r| js::max(m, r.x + r.width))
            + pad;
        let area_rect = Rect::new(left, top, right - left, bottom - top);
        let area = Shape {
            elements: vec![el("rect", rect_attrs(area_rect), vec![])],
            closed: true,
            bounds: Some(area_rect),
            paths: Rc::new(Vec::new()),
        };
        let mut seen: Vec<PaintRef> = Vec::new();
        for span in &spans {
            if let Some(p) = span.paint {
                if !plain(Some(p)) && !seen.contains(&p) {
                    seen.push(p);
                }
            }
        }
        for paint in seen {
            let pieces: Vec<&Span> = spans
                .iter()
                .filter(|span| span.paint == Some(paint))
                .collect();
            let id = self.id("clip");
            let clip_text = el(
                "text",
                text_attrs(self, Attrs::new(), false),
                pieces
                    .iter()
                    .map(|span| tspan(span, Attrs::new()))
                    .collect(),
            );
            let clip_text = self.finish_text(clip_text, &spans);
            self.def(el(
                "clipPath",
                attrs! {"id" => s(id.clone())},
                vec![clip_text],
            ));
            let layer = self.paint_layer(&area, paint.get(node), w, h);
            out.push(el("g", attrs! {"clip-path" => url(&id)}, layer));
            if stroke.is_some() {
                let stroked = el(
                    "text",
                    text_attrs(self, attrs! {"fill" => s("none")}, true),
                    pieces
                        .iter()
                        .map(|span| tspan(span, Attrs::new()))
                        .collect(),
                );
                let stroked = self.finish_text(stroked, &spans);
                out.push(stroked);
            }
        }
        if out.len() == 1 {
            out.pop()
        } else {
            Some(el("g", Attrs::new(), out))
        }
    }

    fn outline_text(&self) -> bool {
        self.options.outline_text
    }

    /// A `text` element as built, or with outline text its glyphs as paths: the text becomes a `g` keeping its paint
    /// (fill, fill-opacity, stroke, stroke-width), each tspan a `path` of its glyphs and decorations keeping its own.
    fn finish_text(&mut self, text: El, spans: &[Span]) -> El {
        if self.keep_text {
            // The PDF painter draws this text itself from its spans (real glyphs, links, decorations).
            let mut text = text;
            text.attrs.set(TEXT_INDEX, num(self.texts.len() as f64));
            self.texts.push(spans.to_vec());
            return text;
        }
        if !self.outline_text() {
            return text;
        }
        #[cfg(feature = "fonts")]
        if let Some(fonts) = self.fonts.as_deref_mut() {
            return outline_text_el(fonts, &text, spans, self.precision, &mut self.unsupported);
        }
        let _ = spans;
        self.unsupported
            .get_or_insert_with(|| "outline text needs the module's fonts".to_owned());
        text
    }

    /// `document`, failing when part of it could not be drawn in this flavour.
    pub(crate) fn document_checked(self, ids: &[String]) -> Result<SvgPage, Unsupported> {
        let mut this = self;
        let page = this.document_mut(ids);
        match this.unsupported.take() {
            Some(why) => Err(Unsupported(why)),
            None => Ok(page),
        }
    }

    fn link_of(&self, st: &m::TextStyle) -> Option<String> {
        if !self.options.print {
            return None;
        }
        match &st.hyperlink {
            Some(Some(m::Hyperlink::Url(u))) => link_href(&u.url),
            _ => None,
        }
    }

    fn fill_attrs(&mut self, node: &SceneNode, paint: Option<PaintRef>) -> Attrs {
        let Some(paint) = paint else {
            return attrs! {"fill" => s("none")};
        };
        let paint = paint.get(node);
        let value = self
            .paint_value(paint, node.width, node.height)
            .or_else(|| match paint {
                Paint::GradientAngular(g) | Paint::GradientDiamond(g) => {
                    Some(hex(sample_stops(&g.gradient_stops, 0.5).0))
                }
                _ => None,
            });
        match value {
            Some(v) => attrs! {"fill" => s(v), "fill-opacity" => opacity_attr(paint.opacity())},
            None => attrs! {"fill" => s("none")},
        }
    }

    // Document ─────────────────────────────────────────────────────────────────────────────────

    pub(crate) fn document(mut self, ids: &[String]) -> SvgPage {
        self.document_mut(ids)
    }

    fn document_mut(&mut self, ids: &[String]) -> SvgPage {
        let (root, bounds) = self.document_tree(ids);
        let mut out = String::new();
        write(&root, self.precision, &mut out);
        SvgPage { svg: out, bounds }
    }

    /// The `svg` element `document` writes, and the page-space rectangle it shows (zero when nothing paints).
    pub(crate) fn document_tree(&mut self, ids: &[String]) -> (El, Rect) {
        let doc = self.doc;
        let mut placed: Vec<(&SceneNode, Matrix)> = Vec::new();
        let mut boxes = Vec::new();
        for id in ids {
            let Some(node) = doc.nodes.get(id) else {
                continue;
            };
            let world = if node.kind == NodeType::Page {
                IDENTITY
            } else {
                world_matrix(doc, id)
            };
            if let Some(local) = self.local_bounds(node, 0) {
                placed.push((node, world));
                boxes.push(transform_rect(&world, &local));
            }
        }
        let bounds = match self.options.crop {
            Some(c) if c.width > 0.0 && c.height > 0.0 => Some(c),
            _ => union_rects(&boxes),
        };
        let svg_attrs = |this: &Self, b: Rect| {
            attrs! {
                "width" => num(b.width), "height" => num(b.height),
                "viewBox" => s(format!("0 0 {} {}", this.f(b.width), this.f(b.height))),
                "fill" => s("none"), "xmlns" => s("http://www.w3.org/2000/svg"), "xmlns:xlink" => s("http://www.w3.org/1999/xlink"),
            }
        };
        let Some(bounds) = bounds else {
            return (el("svg", svg_attrs(self, Rect::ZERO), vec![]), Rect::ZERO);
        };
        let origin = translation(-bounds.x, -bounds.y);
        let mut body = Vec::new();
        for (node, world) in placed {
            if let Some(drawn) = self.node(node, &multiply(&origin, &world), 0, true) {
                body.push(drawn);
            }
        }
        let mut children = Vec::new();
        if !self.defs.is_empty() {
            children.push(el("defs", Attrs::new(), std::mem::take(&mut self.defs)));
        }
        children.extend(body);
        (el("svg", svg_attrs(self, bounds), children), bounds)
    }
}

/// A `text` element with its glyphs as paths: the text becomes a `g` keeping its paint (fill, fill-opacity, stroke,
/// stroke-width), each tspan a `path` of its glyphs and decorations keeping its own fill. `missing` names a family no
/// face of which is loaded (the first one met).
#[cfg(feature = "fonts")]
pub(crate) fn outline_text_el(
    fonts: &mut crate::fonts::Fonts,
    text: &El,
    spans: &[Span],
    precision: i32,
    missing: &mut Option<String>,
) -> El {
    const KEPT: [&str; 4] = ["fill", "fill-opacity", "stroke", "stroke-width"];
    let mut attrs = Attrs::new();
    for (name, value) in &text.attrs.0 {
        if KEPT.contains(name) {
            attrs.0.push((name, value.clone()));
        }
    }
    let mut children = Vec::new();
    for child in &text.children {
        let Child::El(child) = child else { continue };
        if child.tag == "a" {
            let inner: Vec<El> = child
                .children
                .iter()
                .filter_map(|c| match c {
                    Child::El(e) => outline_tspan(fonts, e, spans, precision, missing),
                    Child::Text(_) => None,
                })
                .collect();
            if !inner.is_empty() {
                children.push(el("a", child.attrs.clone(), inner));
            }
        } else if let Some(path) = outline_tspan(fonts, child, spans, precision, missing) {
            children.push(path);
        }
    }
    el("g", attrs, children)
}

/// The span a tspan carries the index of (outline text and the PDF mark them).
#[cfg_attr(not(feature = "fonts"), allow(dead_code))]
pub(crate) fn span_of<'s>(tspan: &El, spans: &'s [Span]) -> Option<&'s Span> {
    match tspan.attrs.get(SPAN_INDEX) {
        Some(Val::Num(i)) => spans.get(*i as usize),
        _ => None,
    }
}

/// A span's glyphs and decorations as path commands in its user space, and where its glyphs went. None when the
/// family has no face.
#[cfg(feature = "fonts")]
pub(crate) fn span_commands(
    fonts: &mut crate::fonts::Fonts,
    span: &Span,
) -> Option<(Vec<morfa_model::PathCommand>, crate::fonts::PlacedText)> {
    let units: Vec<u16> = span.text.encode_utf16().collect();
    let placed = fonts.place(&units, &span.font, span.x, span.y, span.spacing)?;
    let mut commands = Vec::new();
    for glyph in &placed.glyphs {
        // A character no face has (Chromium takes a system font for it): nothing, not the .notdef box.
        if glyph.id == 0 {
            continue;
        }
        fonts.glyph_commands(
            glyph,
            span.font.weight,
            span.font.size,
            span.angle,
            &mut commands,
        );
    }
    commands.extend(decoration_commands(fonts, span, placed.advance));
    Some((commands, placed))
}

/// Underline and strike-through rectangles of a span.
#[cfg(feature = "fonts")]
pub(crate) fn decoration_commands(
    fonts: &mut crate::fonts::Fonts,
    span: &Span,
    advance: f64,
) -> Vec<morfa_model::PathCommand> {
    use morfa_model::PathCommand;
    let mut commands = Vec::new();
    if !(span.underline || span.strike) {
        return commands;
    }
    let Some((underline, strike)) = fonts.decorations(&span.font) else {
        return commands;
    };
    let (cos, sin) = (span.angle.cos(), span.angle.sin());
    for (on, d) in [(span.underline, underline), (span.strike, strike)] {
        if !on {
            continue;
        }
        let corner = |dx: f64, dy: f64| Vec2 {
            x: span.x + dx * cos - dy * sin,
            y: span.y + dx * sin + dy * cos,
        };
        let (top, bottom) = (d.offset - d.thickness / 2.0, d.offset + d.thickness / 2.0);
        commands.push(PathCommand::M(corner(0.0, top)));
        commands.push(PathCommand::L(corner(advance, top)));
        commands.push(PathCommand::L(corner(advance, bottom)));
        commands.push(PathCommand::L(corner(0.0, bottom)));
        commands.push(PathCommand::Z);
    }
    commands
}

#[cfg(feature = "fonts")]
fn outline_tspan(
    fonts: &mut crate::fonts::Fonts,
    tspan: &El,
    spans: &[Span],
    precision: i32,
    missing: &mut Option<String>,
) -> Option<El> {
    let span = span_of(tspan, spans)?;
    let Some((commands, _)) = span_commands(fonts, span) else {
        missing.get_or_insert_with(|| {
            format!(
                "outline text: no font of the family '{}' is loaded",
                span.font.family
            )
        });
        return None;
    };
    if commands.is_empty() {
        return None;
    }
    let mut attrs = attrs! {"d" => s(serialize_path_data(&commands, precision))};
    for name in ["fill", "fill-opacity"] {
        if let Some(value) = tspan.attrs.get(name) {
            attrs.set(name, Some(value.clone()));
        }
    }
    Some(el("path", attrs, vec![]))
}

#[cfg_attr(not(feature = "fonts"), allow(dead_code))]
#[derive(Clone, Debug)]
pub(crate) struct Span {
    pub(crate) attrs: Attrs,
    pub(crate) text: String,
    pub(crate) paint: Option<PaintRef>,
    pub(crate) link: Option<String>,
    /// What outline text and the PDF draw it with (the tspan's computed font, spacing, decorations, turn).
    pub(crate) font: morfa_text::types::FontSpec,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) spacing: f64,
    pub(crate) underline: bool,
    pub(crate) strike: bool,
    pub(crate) angle: f64,
}

fn span_font(st: &m::TextStyle) -> morfa_text::types::FontSpec {
    morfa_text::types::FontSpec {
        family: st.font_family.clone(),
        weight: st.font_weight,
        italic: st.italic,
        size: st.font_size,
    }
}

fn spacing(st: &m::TextStyle) -> f64 {
    match st.letter_spacing.unit {
        m::LetterSpacingUnit::Percent => (st.letter_spacing.value / 100.0) * st.font_size,
        m::LetterSpacingUnit::Pixels => st.letter_spacing.value,
    }
}

fn underlined(st: &m::TextStyle) -> bool {
    st.text_decoration == m::TextDecoration::Underline
}
fn struck(st: &m::TextStyle) -> bool {
    st.text_decoration == m::TextDecoration::Strikethrough
}

fn decoration(st: &m::TextStyle) -> Option<&'static str> {
    match st.text_decoration {
        m::TextDecoration::Underline => Some("underline"),
        m::TextDecoration::Strikethrough => Some("line-through"),
        m::TextDecoration::None => None,
    }
}

fn font_attrs(st: &m::TextStyle, base: &m::TextStyle) -> Attrs {
    let mut a = Attrs::new();
    if st.font_family != base.font_family {
        a.set("font-family", s(family_value(&st.font_family)));
    }
    if st.font_size != base.font_size {
        a.set("font-size", num(st.font_size));
    }
    if st.font_weight != base.font_weight {
        a.set("font-weight", num(st.font_weight));
    }
    if st.italic != base.italic {
        a.set("font-style", s(if st.italic { "italic" } else { "normal" }));
    }
    a
}

pub(crate) fn rect_attrs(r: Rect) -> Attrs {
    attrs! {"x" => num(r.x), "y" => num(r.y), "width" => num(r.width), "height" => num(r.height)}
}

pub(crate) fn pad(r: Rect) -> Rect {
    Rect::new(r.x - 1.0, r.y - 1.0, r.width + 2.0, r.height + 2.0)
}

pub(crate) fn with_effects(b: Rect, effects: &[Effect]) -> Rect {
    let mut boxes = vec![b];
    for e in effects {
        match e {
            Effect::DropShadow(e) if e.visible => {
                let grow = e.radius + js::max(0.0, e.spread);
                boxes.push(Rect::new(
                    b.x + e.offset.x - grow,
                    b.y + e.offset.y - grow,
                    b.width + grow * 2.0,
                    b.height + grow * 2.0,
                ));
            }
            Effect::LayerBlur(e) if e.visible => {
                boxes.push(Rect::new(
                    b.x - e.radius,
                    b.y - e.radius,
                    b.width + e.radius * 2.0,
                    b.height + e.radius * 2.0,
                ));
            }
            _ => {}
        }
    }
    union_rects(&boxes).expect("one box at least")
}
