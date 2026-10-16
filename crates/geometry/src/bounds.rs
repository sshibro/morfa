//! `shared/design/bounds.ts`: what a node paints by itself (strokes, markers, its own effects) in its local space,
//! the per-side stroke reach, effects in page space. The spatial index of the hit tester reads it so its candidates
//! are exactly the TypeScript index's. Text that overflows its box comes from `text_bounds` (lane L3's layout).

use morfa_model::{
    Effect, Matrix, NodeType, PathCommand, SceneNode, StrokeAlign, StrokeCap, StrokeJoin,
    StrokeMarker, StrokeWidthProfile,
};

use crate::js;
use crate::matrix::Rect;
use crate::paths::subpaths;

/// How far a blur of radius `radius` visibly reaches beyond the shape it blurs.
pub fn blur_reach(radius: f64) -> f64 {
    js::max(0.0, radius) * 1.5
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Outsets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

const NONE: Outsets = Outsets {
    left: 0.0,
    top: 0.0,
    right: 0.0,
    bottom: 0.0,
};

pub fn clips_children(node: &SceneNode) -> bool {
    node.kind.is_frame_like() && node.clips_content != Some(false)
}

fn has_visible_stroke(node: &SceneNode) -> bool {
    node.stroke_weight > 0.0
        && node
            .strokes
            .iter()
            .any(|p| p.visible() && p.opacity() > 0.0)
}

/// True when a LINE or VECTOR draws at least one subpath that does not close.
pub fn has_open_path(node: &SceneNode) -> bool {
    if node.kind == NodeType::Line {
        return true;
    }
    if node.kind != NodeType::Vector {
        return false;
    }
    for path in node.vector_paths.as_deref().unwrap_or_default() {
        let mut open = false;
        for command in &path.commands {
            match command {
                PathCommand::M(_) => {
                    if open {
                        return true;
                    }
                    open = true;
                }
                PathCommand::Z => open = false,
                _ => {}
            }
        }
        if open {
            return true;
        }
    }
    false
}

pub fn marker_size(stroke_weight: f64) -> f64 {
    3.0 * js::max(stroke_weight, 0.0) + 2.0
}

/// `widthPointsOf` of stroke-profile.ts: the profile's width factors, or None for a flat profile.
fn width_factors(node: &SceneNode) -> Option<Vec<f64>> {
    let properties = node.variable_width_stroke_properties.as_ref()?;
    let raw: Vec<(f64, f64)> = match properties.width_profile {
        StrokeWidthProfile::Uniform => return None,
        StrokeWidthProfile::Custom => properties
            .variable_width_points
            .as_deref()
            .unwrap_or_default()
            .iter()
            .map(|p| (p.position, p.width))
            .collect(),
        StrokeWidthProfile::Wedge => vec![(0.0, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::Taper => vec![(0.0, 1.0), (1.0, 0.25)],
        StrokeWidthProfile::QuarterTaper => vec![(0.0, 1.0), (0.75, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::Eye => vec![(0.0, 0.0), (0.5, 1.0), (1.0, 0.0)],
        StrokeWidthProfile::MirroredTaper => vec![(0.0, 0.0), (0.25, 1.0), (0.75, 1.0), (1.0, 0.0)],
    };
    let widths: Vec<f64> = raw
        .into_iter()
        .filter(|(p, w)| p.is_finite() && w.is_finite())
        .map(|(_, w)| js::max(0.0, w))
        .collect();
    if widths.is_empty() || widths.iter().all(|w| (w - 1.0).abs() < 1e-9) {
        return None;
    }
    Some(widths)
}

/// `takesWidthProfile`: a LINE, or a VECTOR whose every subpath is open.
fn takes_width_profile(node: &SceneNode) -> bool {
    match node.kind {
        NodeType::Line => true,
        NodeType::Vector => {
            let paths = node.vector_paths.as_deref().unwrap_or_default();
            !paths.is_empty()
                && paths.iter().all(|p| {
                    subpaths(&p.commands)
                        .iter()
                        .all(|part| !matches!(part.last(), Some(PathCommand::Z)))
                })
        }
        _ => false,
    }
}

/// `hasVariableWidth` of stroke-profile.ts.
pub fn has_variable_width(node: &SceneNode) -> bool {
    node.stroke_weight > 0.0 && width_factors(node).is_some() && takes_width_profile(node)
}

/// How far the stroke reaches beyond the box on each side, in local px.
pub fn stroke_outsets(node: &SceneNode) -> Outsets {
    if !has_visible_stroke(node) {
        return NONE;
    }
    if has_variable_width(node) {
        let factor = width_factors(node).map_or(1.0, |w| w.into_iter().fold(0.0, js::max));
        let reach = (node.stroke_weight * factor) / 2.0;
        return Outsets {
            left: reach,
            top: reach,
            right: reach,
            bottom: reach,
        };
    }
    let open = has_open_path(node);
    let align = if open {
        StrokeAlign::Center
    } else {
        node.stroke_align
    };
    let factor = match align {
        StrokeAlign::Center => 0.5,
        StrokeAlign::Outside => 1.0,
        StrokeAlign::Inside => 0.0,
    };
    if let Some(individual) = node.individual_stroke_weights.flatten() {
        if node.kind == NodeType::Rectangle || node.kind.is_frame_like() {
            return Outsets {
                left: individual.left * factor,
                top: individual.top * factor,
                right: individual.right * factor,
                bottom: individual.bottom * factor,
            };
        }
    }
    let mut reach = node.stroke_weight * factor;
    let sharp = matches!(
        node.kind,
        NodeType::Polygon | NodeType::Star | NodeType::Vector | NodeType::BooleanOperation
    );
    if sharp && node.stroke_join == StrokeJoin::Miter {
        let limit = if node.stroke_miter_limit == 0.0 || node.stroke_miter_limit.is_nan() {
            4.0
        } else {
            node.stroke_miter_limit
        };
        reach *= js::max(1.0, limit);
    }
    if open {
        if node.stroke_cap == StrokeCap::Square {
            reach = js::max(reach, node.stroke_weight * std::f64::consts::FRAC_1_SQRT_2);
        }
        let markers = [node.stroke_start_marker, node.stroke_end_marker]
            .iter()
            .any(|m| m.is_some_and(|m| m != StrokeMarker::None));
        if markers {
            reach = js::max(reach, marker_size(node.stroke_weight));
        }
    }
    Outsets {
        left: reach,
        top: reach,
        right: reach,
        bottom: reach,
    }
}

fn visible_effects(node: &SceneNode) -> impl Iterator<Item = &Effect> {
    node.effects.iter().filter(|e| match e {
        Effect::DropShadow(s) | Effect::InnerShadow(s) => s.visible,
        Effect::LayerBlur(b) | Effect::BackgroundBlur(b) => b.visible,
    })
}

/// Grows `rect` (local space) by what the node's effects paint outside it.
pub fn expand_by_effects(rect: Rect, node: &SceneNode) -> Rect {
    let (mut min_x, mut min_y) = (rect.x, rect.y);
    let (mut max_x, mut max_y) = (rect.x + rect.width, rect.y + rect.height);
    let (bx0, by0, bx1, by1) = (min_x, min_y, max_x, max_y);
    for effect in visible_effects(node) {
        let Effect::DropShadow(shadow) = effect else {
            continue;
        };
        let grow = js::max(0.0, shadow.spread) + blur_reach(shadow.radius);
        min_x = js::min(min_x, bx0 + shadow.offset.x - grow);
        min_y = js::min(min_y, by0 + shadow.offset.y - grow);
        max_x = js::max(max_x, bx1 + shadow.offset.x + grow);
        max_y = js::max(max_y, by1 + shadow.offset.y + grow);
    }
    if let Some(Effect::LayerBlur(blur)) =
        visible_effects(node).find(|e| matches!(e, Effect::LayerBlur(_)))
    {
        let grow = blur_reach(blur.radius);
        min_x -= grow;
        min_y -= grow;
        max_x += grow;
        max_y += grow;
    }
    Rect::new(min_x, min_y, max_x - min_x, max_y - min_y)
}

pub fn union_rect(a: &Rect, b: &Rect) -> Rect {
    let x = js::min(a.x, b.x);
    let y = js::min(a.y, b.y);
    Rect::new(
        x,
        y,
        js::max(a.x + a.width, b.x + b.width) - x,
        js::max(a.y + a.height, b.y + b.height) - y,
    )
}

/// What the node paints by itself, without children, in its local space. A text includes its laid-out lines when
/// `text` is given (bounds.ts with a measurer); without it a text paints its box.
pub fn local_render_bounds(node: &SceneNode) -> Rect {
    local_render_bounds_with(node, None)
}

/// `localRenderBounds(node, text)` with the text's lines already laid out (`TextBounds::Lines`).
pub fn local_render_bounds_with(node: &SceneNode, text: Option<Rect>) -> Rect {
    let mut rect = Rect::new(
        0.0,
        0.0,
        js::max(0.0, node.width),
        js::max(0.0, node.height),
    );
    if let Some(lines) = text {
        rect = union_rect(&rect, &lines);
    }
    let out = stroke_outsets(node);
    let rect = Rect::new(
        rect.x - out.left,
        rect.y - out.top,
        rect.width + out.left + out.right,
        rect.height + out.top + out.bottom,
    );
    expand_by_effects(rect, node)
}

/// Grows a page-space rectangle by a container's effects, whose offsets turn with the container.
pub fn expand_world_by_effects(rect: Rect, node: &SceneNode, world: &Matrix) -> Rect {
    let mut out = rect;
    for effect in visible_effects(node) {
        match effect {
            Effect::DropShadow(shadow) => {
                let grow = js::max(0.0, shadow.spread) + blur_reach(shadow.radius);
                let dx = world[0][0] * shadow.offset.x + world[0][1] * shadow.offset.y;
                let dy = world[1][0] * shadow.offset.x + world[1][1] * shadow.offset.y;
                out = union_rect(
                    &out,
                    &Rect::new(
                        rect.x + dx - grow,
                        rect.y + dy - grow,
                        rect.width + 2.0 * grow,
                        rect.height + 2.0 * grow,
                    ),
                );
            }
            Effect::LayerBlur(blur) => {
                let grow = blur_reach(blur.radius);
                out = union_rect(
                    &out,
                    &Rect::new(
                        rect.x - grow,
                        rect.y - grow,
                        rect.width + 2.0 * grow,
                        rect.height + 2.0 * grow,
                    ),
                );
            }
            _ => {}
        }
    }
    out
}
