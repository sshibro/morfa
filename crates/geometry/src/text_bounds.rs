//! The text part of `localRenderBounds` (shared/design/bounds.ts): `textLayoutBounds(layoutText(node, measurer))`, the
//! box a text's laid-out lines draw into, which can overflow the node's own box. The layout is lane L3's port
//! (`morfa_text::layout::compute_layout`, the twin of shared/design/text-layout.ts), with the request built as
//! `layoutText` builds it (the conversion is in crates/layout/src/text.rs `convert`).
//!
//! Only the measurer the TypeScript tests and the differential harness use is here: `testMeasurer`
//! (tests/helpers/design-big-files.ts), the text crate's `FixedMeasurer`. The editor's own measurer (canvas fonts) is the text crate's shaper,
//! which the shadow document will hand in when the switch wires it.

use morfa_model::SceneNode;
use morfa_model::types as m;
use morfa_text::layout::compute_layout;
use morfa_text::measure::{FixedMeasurer, MeasureCache};
use morfa_text::types::{self as t, TextLayout};

use crate::js;
use crate::matrix::Rect;

/// What the text of a node adds to its painted bounds.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TextBounds {
    /// No text to lay out (not a text node, or no lines): the node paints its box.
    None,
    /// The laid-out lines' box, in the node's local space.
    Lines(Rect),
    /// A text on a path: its glyphs follow the path (text-path.ts `textPathLayout`), not ported.
    Unsupported,
}

/// `layoutText` with `testMeasurer` and a measure cache kept across calls (text-layout.ts `measureCache`).
#[derive(Default)]
pub struct TextLayouter {
    cache: MeasureCache,
}

impl TextLayouter {
    /// `layoutText(node, measurer)` with the default width (`null` for WIDTH_AND_HEIGHT, else the node's width).
    pub fn layout(&mut self, node: &SceneNode) -> Option<TextLayout> {
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
        Some(compute_layout(
            &chars,
            &request,
            &mut self.cache,
            &mut FixedMeasurer,
        ))
    }

    /// The text part of `localRenderBounds(node, measurer)`.
    pub fn bounds(&mut self, node: &SceneNode) -> TextBounds {
        if node.kind != morfa_model::NodeType::Text || node.text.is_none() {
            return TextBounds::None;
        }
        if node.text_path.is_some() {
            return TextBounds::Unsupported;
        }
        match self.layout(node).as_ref().and_then(text_layout_bounds) {
            Some(rect) => TextBounds::Lines(rect),
            None => TextBounds::None,
        }
    }
}

/// `textLayoutBounds(layout)`: the lines' box, list markers and runs past the line included, and each line's font
/// ascent and descent around its baseline.
pub fn text_layout_bounds(layout: &TextLayout) -> Option<Rect> {
    if layout.lines.is_empty() {
        return None;
    }
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    let or_zero = |v: f64| if v.is_nan() || v == 0.0 { 0.0 } else { v };
    for line in &layout.lines {
        let left = match &line.marker {
            Some(marker) => js::min(line.x, marker.x),
            None => line.x,
        };
        let mut right = line.x + line.width;
        for run in &line.runs {
            right = js::max(right, run.x + run.width);
        }
        min_x = js::min(min_x, left);
        max_x = js::max(max_x, right);
        min_y = js::min(
            js::min(min_y, line.top),
            line.baseline - or_zero(line.ascent),
        );
        max_y = js::max(
            js::max(max_y, line.top + line.height),
            line.baseline + or_zero(line.descent),
        );
    }
    Some(Rect::new(min_x, min_y, max_x - min_x, max_y - min_y))
}

/// The request's text, as text-layout.ts serializes it (crates/layout/src/text.rs `convert`, with the node's own
/// auto-resize mode).
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
