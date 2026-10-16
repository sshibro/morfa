//! Text for the exporters: `layoutText(node, measurer)` over lane L3's layout (`morfa_text::layout::compute_layout`,
//! the request built as text-layout.ts builds it), the full style each laid-out run draws in (the layout keeps only
//! what it measures by), which fills a run paints with (`run.fills ?? node.fills`, identity kept as a [`FillSource`]),
//! and text-path.ts `textPathLayout` (not ported elsewhere yet).

use morfa_geometry::js;
use morfa_geometry::matrix::Rect;
use morfa_geometry::paths::{flatten_path, reverse_path, subpaths};
use morfa_model::types as m;
use morfa_model::{Paint, PathCommand, SceneNode, Vec2};
use morfa_text::layout::compute_layout;
use morfa_text::measure::{MeasureCache, Measurer};
use morfa_text::segment::grapheme_boundaries;
use morfa_text::types::{self as t, GlyphRun, TextLayout, TextLine};

/// `layoutText(node, measurer)` with the default width, or None without text.
pub fn layout_text(
    node: &SceneNode,
    cache: &mut MeasureCache,
    measurer: &mut dyn Measurer,
) -> Option<TextLayout> {
    let text = node.text.as_ref()?;
    let on_path = node.text_path.is_some();
    let mode = text.text_auto_resize;
    let width = if on_path || mode == m::TextAutoResize::WidthAndHeight {
        None
    } else {
        Some(node.width)
    };
    let fixed_height =
        !on_path && matches!(mode, m::TextAutoResize::None | m::TextAutoResize::Truncate);
    let request = t::LayoutRequest {
        text: convert(text),
        width,
        height: if fixed_height { node.height } else { 0.0 },
        on_path,
    };
    let chars: Vec<u16> = text.characters.encode_utf16().collect();
    Some(compute_layout(&chars, &request, cache, measurer))
}

/// Where a run's fills come from: the node's own array, or a run's (`run.fills ?? fills`). Two paints are the same
/// object in TypeScript exactly when their source and index are equal.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum FillSource {
    Node,
    Run(usize),
}

/// A paint of a text as TypeScript sees it: which array, which index.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct PaintRef {
    pub source: FillSource,
    pub index: usize,
}

impl PaintRef {
    pub fn get<'a>(&self, node: &'a SceneNode) -> &'a Paint {
        &fills_of(node, self.source)[self.index]
    }
}

pub fn fills_of(node: &SceneNode, source: FillSource) -> &[Paint] {
    match source {
        FillSource::Node => &node.fills,
        FillSource::Run(i) => node
            .text
            .as_ref()
            .and_then(|t| t.runs.get(i))
            .and_then(|r| r.fills.as_deref())
            .unwrap_or(&node.fills),
    }
}

/// The fills of a slot: `run.fills ?? fills`.
pub fn slot_source(node: &SceneNode, layout: &TextLayout, slot: usize) -> FillSource {
    let Some(&run) = layout.slot_runs.get(slot) else {
        return FillSource::Node;
    };
    if run < 0 {
        return FillSource::Node;
    }
    let run = run as usize;
    match node.text.as_ref().and_then(|t| t.runs.get(run)) {
        Some(r) if r.fills.is_some() => FillSource::Run(run),
        _ => FillSource::Node,
    }
}

/// `topFill(fills)`: the last visible paint.
pub fn top_fill(node: &SceneNode, source: FillSource) -> Option<PaintRef> {
    let fills = fills_of(node, source);
    fills
        .iter()
        .rposition(Paint::visible)
        .map(|index| PaintRef { source, index })
}

/// The full style of a slot (`resolveStyle(text.style, run.style)`), and a run's: the slot's with the layout's own
/// font size (a SMALL_CAPS run's reduced face is `{...style, fontSize}`).
pub fn slot_style(node: &SceneNode, layout: &TextLayout, slot: usize) -> m::TextStyle {
    let text = node.text.as_ref().expect("a text node");
    let mut style = text.style.clone();
    let run = layout.slot_runs.get(slot).copied().unwrap_or(-1);
    if run >= 0 {
        if let Some(r) = text.runs.get(run as usize) {
            let o = &r.style;
            if let Some(v) = &o.font_family {
                style.font_family = v.clone();
            }
            if let Some(v) = o.font_weight {
                style.font_weight = v;
            }
            if let Some(v) = o.italic {
                style.italic = v;
            }
            if let Some(v) = o.font_size {
                style.font_size = v;
            }
            if let Some(v) = o.line_height {
                style.line_height = v;
            }
            if let Some(v) = o.letter_spacing {
                style.letter_spacing = v;
            }
            if let Some(v) = o.text_decoration {
                style.text_decoration = v;
            }
            if let Some(v) = o.text_case {
                style.text_case = v;
            }
            if let Some(v) = &o.hyperlink {
                style.hyperlink = Some(v.clone());
            }
        }
    }
    style
}

pub fn run_style(node: &SceneNode, layout: &TextLayout, run: &GlyphRun) -> m::TextStyle {
    let mut style = slot_style(node, layout, run.slot);
    style.font_size = run.style.font_size;
    style
}

fn convert(text: &m::TextProps) -> t::TextProps {
    let style = &text.style;
    t::TextProps {
        style: t::TextStyle {
            font_family: style.font_family.clone(),
            font_weight: style.font_weight,
            italic: style.italic,
            font_size: style.font_size,
            line_height: line_height(style.line_height),
            letter_spacing: Some(letter_spacing(style.letter_spacing)),
            text_case: Some(text_case(style.text_case)),
        },
        runs: text
            .runs
            .iter()
            .map(|run| t::TextRun {
                start: run.start,
                end: run.end,
                style: Some(t::PartialStyle {
                    font_family: run.style.font_family.clone(),
                    font_weight: run.style.font_weight,
                    italic: run.style.italic,
                    font_size: run.style.font_size,
                    line_height: run.style.line_height.map(line_height),
                    letter_spacing: run.style.letter_spacing.map(letter_spacing),
                    text_case: run.style.text_case.map(text_case),
                }),
                has_fills: run.fills.is_some(),
            })
            .collect(),
        text_align_horizontal: match text.text_align_horizontal {
            m::TextAlignHorizontal::Left => t::HorizontalAlign::Left,
            m::TextAlignHorizontal::Center => t::HorizontalAlign::Center,
            m::TextAlignHorizontal::Right => t::HorizontalAlign::Right,
            m::TextAlignHorizontal::Justified => t::HorizontalAlign::Justified,
        },
        text_align_vertical: match text.text_align_vertical {
            m::TextAlignVertical::Top => t::VerticalAlign::Top,
            m::TextAlignVertical::Center => t::VerticalAlign::Center,
            m::TextAlignVertical::Bottom => t::VerticalAlign::Bottom,
        },
        text_auto_resize: match text.text_auto_resize {
            m::TextAutoResize::None => t::AutoResize::None,
            m::TextAutoResize::WidthAndHeight => t::AutoResize::WidthAndHeight,
            m::TextAutoResize::Height => t::AutoResize::Height,
            m::TextAutoResize::Truncate => t::AutoResize::Truncate,
        },
        paragraph_spacing: Some(text.paragraph_spacing),
        paragraph_indent: Some(text.paragraph_indent),
        list_types: text.list_types.as_ref().map(|types| {
            types
                .iter()
                .map(|kind| match kind {
                    m::ListType::None => t::ListType::None,
                    m::ListType::Ordered => t::ListType::Ordered,
                    m::ListType::Unordered => t::ListType::Unordered,
                })
                .collect()
        }),
        max_lines: text.max_lines.flatten(),
    }
}

fn line_height(value: m::LineHeight) -> t::LineHeight {
    match value {
        m::LineHeight::Auto => t::LineHeight::Auto,
        m::LineHeight::Pixels(v) => t::LineHeight::Pixels { value: v.value },
        m::LineHeight::Percent(v) => t::LineHeight::Percent { value: v.value },
    }
}

fn letter_spacing(value: m::LetterSpacing) -> t::LetterSpacing {
    match value.unit {
        m::LetterSpacingUnit::Pixels => t::LetterSpacing::Pixels { value: value.value },
        m::LetterSpacingUnit::Percent => t::LetterSpacing::Percent { value: value.value },
    }
}

fn text_case(value: m::TextCase) -> t::TextCase {
    match value {
        m::TextCase::Original => t::TextCase::Original,
        m::TextCase::Upper => t::TextCase::Upper,
        m::TextCase::Lower => t::TextCase::Lower,
        m::TextCase::Title => t::TextCase::Title,
        m::TextCase::SmallCaps => t::TextCase::SmallCaps,
    }
}

// ── text-path.ts ───────────────────────────────────────────────────────────────────────────────

const FLATTEN_TOLERANCE: f64 = 0.05;
const FLATTEN_ANGLE: f64 = std::f64::consts::PI / 90.0;

/// `PathSampler`.
pub struct PathSampler {
    pub points: Vec<Vec2>,
    pub lengths: Vec<f64>,
    pub length: f64,
    pub closed: bool,
}

/// `PathLine`.
#[derive(Clone, Copy)]
pub struct PathLine {
    pub start: f64,
    pub shift: f64,
}

/// `PathGlyph` (the run by its line and index).
pub struct PathGlyph {
    pub text: Vec<u16>,
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub run: usize,
    pub x: f64,
    pub advance: f64,
    pub origin: Vec2,
    pub angle: f64,
}

pub struct TextPathLayout {
    pub glyphs: Vec<PathGlyph>,
    pub bounds: Option<Rect>,
}

fn text_path_commands(path: &m::TextPathData) -> Vec<PathCommand> {
    let first: Vec<PathCommand> = subpaths(&path.commands)
        .first()
        .map(|s| s.to_vec())
        .unwrap_or_default();
    if path.side == m::TextPathSide::Right {
        reverse_path(&first)
    } else {
        first
    }
}

pub fn text_path_sampler(path: &m::TextPathData) -> Option<PathSampler> {
    let lines = flatten_path(
        &text_path_commands(path),
        FLATTEN_TOLERANCE,
        FLATTEN_ANGLE,
        None,
    );
    let line = lines.into_iter().next()?;
    if line.points.len() <= 1 {
        return None;
    }
    let points = line.points;
    let mut lengths = vec![0.0];
    for i in 1..points.len() {
        lengths.push(
            lengths[i - 1]
                + js::hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y),
        );
    }
    let last = points[points.len() - 1];
    if line.closed {
        lengths.push(
            lengths[points.len() - 1] + js::hypot(points[0].x - last.x, points[0].y - last.y),
        );
    }
    let length = lengths[lengths.len() - 1];
    if length > 1e-9 {
        Some(PathSampler {
            points,
            lengths,
            length,
            closed: line.closed,
        })
    } else {
        None
    }
}

fn point_along(sampler: &PathSampler, mut s: f64, clamp: bool) -> Option<(Vec2, Vec2)> {
    let PathSampler {
        points,
        lengths,
        length,
        closed,
    } = sampler;
    let length = *length;
    if *closed {
        s = ((s % length) + length) % length;
    } else if s < -1e-9 || s > length + 1e-9 {
        if !clamp {
            return None;
        }
        s = js::max(0.0, js::min(length, s));
    }
    let segments = if *closed {
        points.len()
    } else {
        points.len() - 1
    };
    let (mut lo, mut hi) = (0usize, segments as isize - 1);
    while (lo as isize) < hi {
        let mid = ((lo as isize + hi + 1) >> 1) as usize;
        if lengths[mid] <= s {
            lo = mid;
        } else {
            hi = mid as isize - 1;
        }
    }
    let a = points[lo];
    let b = points[if lo + 1 == points.len() { 0 } else { lo + 1 }];
    let span = lengths[lo + 1] - lengths[lo];
    let t = if span > 0.0 {
        js::max(0.0, js::min(1.0, (s - lengths[lo]) / span))
    } else {
        0.0
    };
    let (dx, dy) = (b.x - a.x, b.y - a.y);
    let d = js::hypot(dx, dy);
    let d = if d == 0.0 || d.is_nan() { 1.0 } else { d };
    Some((
        Vec2 {
            x: a.x + dx * t,
            y: a.y + dy * t,
        },
        Vec2 {
            x: dx / d,
            y: dy / d,
        },
    ))
}

fn or_else(a: f64, b: f64) -> f64 {
    if a == 0.0 || a.is_nan() { b } else { a }
}
fn line_ascent(line: &TextLine) -> f64 {
    or_else(line.ascent, line.height * 0.8)
}
fn line_descent(line: &TextLine) -> f64 {
    or_else(line.descent, line.height * 0.2)
}

fn path_lines(
    text: &m::TextProps,
    path: &m::TextPathData,
    layout: &TextLayout,
    sampler: &PathSampler,
) -> Vec<PathLine> {
    let lines = &layout.lines;
    if lines.is_empty() {
        return Vec::new();
    }
    let (first, last) = (&lines[0], &lines[lines.len() - 1]);
    let top = first.top;
    let height = last.top + last.height - top;
    let anchor = js::max(0.0, js::min(1.0, path.start_offset)) * sampler.length;
    lines
        .iter()
        .map(|line| {
            let start = anchor
                - match text.text_align_horizontal {
                    m::TextAlignHorizontal::Center => line.width / 2.0,
                    m::TextAlignHorizontal::Right => line.width,
                    _ => 0.0,
                }
                - line.x;
            let shift = match text.text_align_vertical {
                m::TextAlignVertical::Top => line.baseline - top,
                m::TextAlignVertical::Center => line.baseline - top - height / 2.0,
                m::TextAlignVertical::Bottom => line.baseline - last.baseline,
            };
            PathLine { start, shift }
        })
        .collect()
}

fn place_on_path(sampler: &PathSampler, line: PathLine, x: f64) -> Option<(Vec2, f64)> {
    let (point, tangent) = point_along(sampler, line.start + x, false)?;
    Some((
        Vec2 {
            x: point.x - tangent.y * line.shift,
            y: point.y + tangent.x * line.shift,
        },
        js::atan2(tangent.y, tangent.x),
    ))
}

struct Piece {
    text: Vec<u16>,
    start: usize,
    end: usize,
    x: f64,
    advance: f64,
}

fn pieces_of(run: &GlyphRun) -> Vec<Piece> {
    let stops = run.xs.len() as isize - 1;
    let bounds = grapheme_boundaries(&run.text, 0, run.text.len());
    if bounds.len() as isize - 1 != stops || stops < 1 {
        return vec![Piece {
            text: run.text.clone(),
            start: run.start,
            end: run.end,
            x: run.x,
            advance: js::max(0.0, run.width - run.letter_spacing),
        }];
    }
    (0..stops as usize)
        .map(|i| Piece {
            text: run.text[bounds[i]..bounds[i + 1]].to_vec(),
            start: run.offsets[i],
            end: run.offsets[i + 1],
            x: run.xs[i],
            advance: js::max(0.0, run.xs[i + 1] - run.xs[i] - run.letter_spacing),
        })
        .collect()
}

/// `textPathLayout(node, layout)`.
pub fn text_path_layout(node: &SceneNode, layout: &TextLayout) -> TextPathLayout {
    let mut out = TextPathLayout {
        glyphs: Vec::new(),
        bounds: None,
    };
    let (Some(path), Some(text)) = (node.text_path.as_ref(), node.text.as_ref()) else {
        return out;
    };
    let Some(sampler) = text_path_sampler(path) else {
        return out;
    };
    let lines = path_lines(text, path, layout, &sampler);
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for (line_index, line) in layout.lines.iter().enumerate() {
        let (ascent, descent) = (line_ascent(line), line_descent(line));
        for (run_index, run) in line.runs.iter().enumerate() {
            if run.text.is_empty() || run.ellipsis {
                continue;
            }
            for piece in pieces_of(run) {
                let Some((point, angle)) =
                    place_on_path(&sampler, lines[line_index], piece.x + piece.advance / 2.0)
                else {
                    continue;
                };
                let (cos, sin) = (js::cos(angle), js::sin(angle));
                let origin = Vec2 {
                    x: point.x - cos * piece.advance / 2.0,
                    y: point.y - sin * piece.advance / 2.0,
                };
                for (gx, gy) in [
                    (0.0, -ascent),
                    (piece.advance, -ascent),
                    (piece.advance, descent),
                    (0.0, descent),
                ] {
                    let px = origin.x + cos * gx - sin * gy;
                    let py = origin.y + sin * gx + cos * gy;
                    if px < min_x {
                        min_x = px;
                    }
                    if px > max_x {
                        max_x = px;
                    }
                    if py < min_y {
                        min_y = py;
                    }
                    if py > max_y {
                        max_y = py;
                    }
                }
                out.glyphs.push(PathGlyph {
                    text: piece.text,
                    start: piece.start,
                    end: piece.end,
                    line: line_index,
                    run: run_index,
                    x: piece.x,
                    advance: piece.advance,
                    origin,
                    angle,
                });
            }
        }
    }
    if min_x.is_finite() {
        out.bounds = Some(Rect::new(min_x, min_y, max_x - min_x, max_y - min_y));
    }
    out
}
