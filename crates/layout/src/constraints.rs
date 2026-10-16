//! Resizing a node and everything that follows from it (`shared/design/constraints.ts`) on store nodes: the twin of
//! `crate::constraints`. The maths on placements and numbers (`bounds_of`, `box_for_bounds`, `is_turned`, …) is that
//! module's; what reads or writes a node is here.

use std::sync::Arc;

use indexmap::IndexSet;
use morfa_model::draft::same_f64;
use morfa_model::store::draft::Working;
use morfa_model::store::{GridTrackSize, Id, Node, PathCommand, Prop, TextPath, VectorPath};
use morfa_model::types::{
    ConstraintType, Constraints, GridTrackType, LayoutPositioning, LayoutSizing, NodeType,
    TextAutoResize,
};

use crate::geom::{self, Placement, Rect};
use crate::math;
use crate::text::{TextMeasure, TextNode};
use crate::{is_auto_layout, placement, set_text_auto_resize};

pub use morfa_model::draft::LAYOUT_EPSILON;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Size {
    pub width: f64,
    pub height: f64,
}

/// Turned off its parent's axes (anything but a multiple of 180°).
pub fn is_turned(rotation: f64) -> bool {
    if rotation == 0.0 {
        return false;
    }
    let turn = ((geom::turn(rotation) % 180.0) + 180.0) % 180.0;
    turn > 0.01 && turn < 179.99
}

/// The node's box in its parent's space, as an axis-aligned rectangle (rotation and flips applied).
pub fn bounds_of(node: &Placement) -> Rect {
    if geom::turn(node.rotation) == 0.0 {
        return Rect::new(node.x, node.y, node.width, node.height);
    }
    geom::transform_rect(
        &geom::local_matrix(node),
        Rect::new(0.0, 0.0, node.width, node.height),
    )
}

#[inline]
pub fn ratio(after: f64, before: f64, fallback: f64) -> f64 {
    if before > LAYOUT_EPSILON {
        after / before
    } else {
        fallback
    }
}

/// The node's own size after its bounding box is stretched by `kx`, `ky`.
fn stretched_size(node: &Placement, kx: f64, ky: f64) -> Size {
    if kx == 1.0 && ky == 1.0 {
        return Size {
            width: node.width,
            height: node.height,
        };
    }
    let radians = math::to_radians(geom::turn(node.rotation));
    let cos = math::cos(radians).abs();
    let sin = math::sin(radians).abs();
    Size {
        width: node.width * math::hypot(kx * cos, ky * sin),
        height: node.height * math::hypot(kx * sin, ky * cos),
    }
}

/// `boxForBounds`: the box whose bounding box is `target`, for a node whose bounding box is `current`.
pub fn box_for_bounds(node: &Placement, target: Rect, current: Rect, fallback: (f64, f64)) -> Rect {
    let size = stretched_size(
        node,
        ratio(target.width, current.width, fallback.0),
        ratio(target.height, current.height, fallback.1),
    );
    if geom::turn(node.rotation) == 0.0 {
        return Rect::new(target.x, target.y, size.width, size.height);
    }
    let zero = geom::transform_rect(
        &geom::local_matrix(&node.with_box(0.0, 0.0, size.width, size.height)),
        Rect::new(0.0, 0.0, size.width, size.height),
    );
    Rect::new(
        target.x - zero.x,
        target.y - zero.y,
        size.width,
        size.height,
    )
}

pub fn follow(kind: ConstraintType, start: f64, size: f64, before: f64, after: f64) -> (f64, f64) {
    let delta = after - before;
    match kind {
        ConstraintType::Max => (start + delta, size),
        ConstraintType::Center => (start + delta / 2.0, size),
        ConstraintType::Stretch => (start, math::max(0.0, size + delta)),
        ConstraintType::Scale => {
            let k = ratio(after, before, 1.0);
            (start * k, size * k)
        }
        ConstraintType::Min => (start, size),
    }
}

/// How `resize_node` was reached.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ResizeMode {
    /// By the user: a side set by hand stops hugging or filling.
    Hand,
    /// By following a resized parent.
    Follow,
    /// By auto layout assigning the size (every sizing field stays).
    Layout,
}

/// JavaScript truthiness of a number.
#[inline]
pub fn truthy(value: f64) -> bool {
    value != 0.0 && !value.is_nan()
}

/// `constrainedBox`: where a child goes when its parent's box changes from `before` to `after`.
pub fn constrained_box(child: &Node, before: Size, after: Size, constraints: Constraints) -> Rect {
    let placement = placement(child);
    let bounds = bounds_of(&placement);
    let (x, width) = follow(
        constraints.horizontal,
        bounds.x,
        bounds.width,
        before.width,
        after.width,
    );
    let (y, height) = follow(
        constraints.vertical,
        bounds.y,
        bounds.height,
        before.height,
        after.height,
    );
    box_for_bounds(
        &placement,
        Rect::new(x, y, width, height),
        bounds,
        (1.0, 1.0),
    )
}

const SCALE: Constraints = Constraints {
    horizontal: morfa_model::types::ConstraintType::Scale,
    vertical: morfa_model::types::ConstraintType::Scale,
};

fn scale_command(command: &PathCommand, sx: f64, sy: f64) -> PathCommand {
    match *command {
        PathCommand::M(mut p) => {
            p.x *= sx;
            p.y *= sy;
            PathCommand::M(p)
        }
        PathCommand::L(mut p) => {
            p.x *= sx;
            p.y *= sy;
            PathCommand::L(p)
        }
        PathCommand::Q(mut q) => {
            q.x1 *= sx;
            q.y1 *= sy;
            q.x *= sx;
            q.y *= sy;
            PathCommand::Q(q)
        }
        PathCommand::C(mut c) => {
            c.x1 *= sx;
            c.y1 *= sy;
            c.x2 *= sx;
            c.y2 *= sy;
            c.x *= sx;
            c.y *= sy;
            PathCommand::C(c)
        }
        PathCommand::Z => PathCommand::Z,
    }
}

/// `scalePaths`.
pub fn scale_paths(paths: &[VectorPath], sx: f64, sy: f64) -> Vec<VectorPath> {
    paths
        .iter()
        .map(|path| VectorPath {
            winding_rule: path.winding_rule,
            commands: path
                .commands
                .iter()
                .map(|command| scale_command(command, sx, sy))
                .collect(),
        })
        .collect()
}

/// `scaleTextPath`.
pub fn scale_text_path(path: &TextPath, sx: f64, sy: f64) -> TextPath {
    TextPath {
        commands: path
            .commands
            .iter()
            .map(|command| scale_command(command, sx, sy))
            .collect(),
        start_offset: path.start_offset,
        side: path.side,
    }
}

/// Figma's switch when a text box is resized.
pub fn text_mode_after_resize(
    mode: TextAutoResize,
    width_changed: bool,
    height_changed: bool,
) -> TextAutoResize {
    match mode {
        TextAutoResize::WidthAndHeight if height_changed => TextAutoResize::None,
        TextAutoResize::WidthAndHeight if width_changed => TextAutoResize::Height,
        TextAutoResize::Height if height_changed => TextAutoResize::None,
        _ => mode,
    }
}

/// `ResizeHooks`.
#[derive(Default)]
pub struct ResizeHooks<'h, 'm> {
    /// Given, an automatic-height text gets its new height at once.
    pub measurer: Option<&'h mut TextMeasure<'m>>,
    /// Auto-layout frames that changed size (`onFrameResized`); their flow children wait for layout.
    pub resized_frames: Option<&'h mut IndexSet<Id>>,
}

/// The fields `resize_node` writes on the node itself.
struct Patch {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    horizontal: Option<LayoutSizing>,
    vertical: Option<LayoutSizing>,
    text_mode: Option<TextAutoResize>,
    vector_paths: Option<Vec<VectorPath>>,
    text_path: Option<TextPath>,
}

/// `resizeNode`: sets the node's box (in its parent's space, before rotation) and applies what follows from it to
/// the node's sizing fields and its descendants.
pub fn resize_node(
    draft: &mut Working,
    id: Id,
    target: Rect,
    mode: ResizeMode,
    hooks: &mut ResizeHooks,
) {
    let Some(node) = draft.node(id) else {
        return;
    };
    if node.kind == NodeType::Page {
        return;
    }
    let width = math::max(0.0, target.width);
    let height = if node.kind == NodeType::Line {
        0.0
    } else {
        math::max(0.0, target.height)
    };
    let width_changed = !same_f64(width, node.width);
    let height_changed = !same_f64(height, node.height);
    let mut patch = Patch {
        x: target.x,
        y: target.y,
        width,
        height,
        horizontal: None,
        vertical: None,
        text_mode: None,
        vector_paths: None,
        text_path: None,
    };
    if mode == ResizeMode::Hand {
        if width_changed && node.layout_sizing_horizontal != LayoutSizing::Fixed {
            patch.horizontal = Some(LayoutSizing::Fixed);
        }
        if height_changed && node.layout_sizing_vertical != LayoutSizing::Fixed {
            patch.vertical = Some(LayoutSizing::Fixed);
        }
    }
    if node.kind == NodeType::Text
        && let Some(text) = node.props.text()
        && mode != ResizeMode::Layout
    {
        let next = text_mode_after_resize(text.text_auto_resize, width_changed, height_changed);
        let fill_h =
            patch.horizontal.unwrap_or(node.layout_sizing_horizontal) == LayoutSizing::Fill;
        let fill_v = patch.vertical.unwrap_or(node.layout_sizing_vertical) == LayoutSizing::Fill;
        patch.horizontal = Some(if fill_h {
            LayoutSizing::Fill
        } else if next == TextAutoResize::WidthAndHeight {
            LayoutSizing::Hug
        } else {
            LayoutSizing::Fixed
        });
        patch.vertical = Some(if fill_v {
            LayoutSizing::Fill
        } else if matches!(
            next,
            TextAutoResize::WidthAndHeight | TextAutoResize::Height
        ) {
            LayoutSizing::Hug
        } else {
            LayoutSizing::Fixed
        });
        if next != text.text_auto_resize {
            patch.text_mode = Some(next);
        }
        if let Some(measurer) = hooks.measurer.as_deref_mut()
            && next == TextAutoResize::Height
            && width_changed
        {
            let measured = TextNode {
                text,
                mode: next,
                width,
                height: node.height,
                on_path: node.props.text_path().is_some(),
            };
            patch.height = measurer.box_size(draft, measured).1;
        }
    }
    if (width_changed || height_changed)
        && let Some(paths) = node.props.vector_paths()
        && !paths.is_empty()
    {
        patch.vector_paths = Some(scale_paths(
            paths,
            ratio(width, node.width, 1.0),
            ratio(height, node.height, 1.0),
        ));
    }
    if (width_changed || height_changed)
        && let Some(path) = node.props.text_path()
    {
        patch.text_path = Some(scale_text_path(
            path,
            ratio(width, node.width, 1.0),
            ratio(height, node.height, 1.0),
        ));
    }
    let kind = node.kind;
    let before = Size {
        width: node.width,
        height: node.height,
    };
    let (old_x, old_y) = (node.x, node.y);
    let flow = is_auto_layout(Some(node));
    // `update` keeps every field within epsilon of the stored one and writes nothing when no field really changes;
    // deciding that here first spares the copy of the node in the common case.
    let writes = !same_f64(patch.x, node.x)
        || !same_f64(patch.y, node.y)
        || width_changed
        || height_changed
        || patch
            .horizontal
            .is_some_and(|sizing| sizing != node.layout_sizing_horizontal)
        || patch
            .vertical
            .is_some_and(|sizing| sizing != node.layout_sizing_vertical)
        || patch.text_mode.is_some()
        || patch.vector_paths.is_some()
        || patch.text_path.is_some();
    let box_only = patch.horizontal.is_none()
        && patch.vertical.is_none()
        && patch.text_mode.is_none()
        && patch.vector_paths.is_none()
        && patch.text_path.is_none();
    if writes && box_only {
        draft.update_box(
            id,
            Some(patch.x),
            Some(patch.y),
            Some(patch.width),
            Some(patch.height),
        );
    } else if writes {
        draft.update(id, |node| {
            node.x = patch.x;
            node.y = patch.y;
            node.width = patch.width;
            node.height = patch.height;
            if let Some(sizing) = patch.horizontal {
                node.layout_sizing_horizontal = sizing;
            }
            if let Some(sizing) = patch.vertical {
                node.layout_sizing_vertical = sizing;
            }
            if let Some(mode) = patch.text_mode {
                set_text_auto_resize(node, mode);
            }
            if let Some(paths) = patch.vector_paths {
                node.props.set(Prop::VectorPaths(paths.into()));
            }
            if let Some(path) = patch.text_path {
                node.props.set(Prop::TextPath(Arc::new(path)));
            }
        });
    }
    if !width_changed && !height_changed {
        return;
    }

    let after = Size { width, height };
    let children: Vec<Id> = draft
        .node(id)
        .map(|node| node.children().to_vec())
        .unwrap_or_default();
    match kind {
        NodeType::Group | NodeType::BooleanOperation => {
            for &child_id in &children {
                if let Some(child) = draft.node(child_id) {
                    let target = constrained_box(child, before, after, SCALE);
                    resize_node(draft, child_id, target, ResizeMode::Follow, hooks);
                }
            }
        }
        NodeType::Section => {
            let (dx, dy) = (target.x - old_x, target.y - old_y);
            if truthy(dx) || truthy(dy) {
                for &child_id in &children {
                    draft.update(child_id, |child| {
                        child.x -= dx;
                        child.y -= dy;
                    });
                }
            }
        }
        _ => {
            for &child_id in &children {
                let Some(child) = draft.node(child_id) else {
                    continue;
                };
                if flow && child.layout_positioning != LayoutPositioning::Absolute {
                    continue;
                }
                let target = constrained_box(child, before, after, child.constraints);
                resize_node(draft, child_id, target, ResizeMode::Follow, hooks);
            }
        }
    }
    if flow
        && mode != ResizeMode::Layout
        && let Some(frames) = hooks.resized_frames.as_deref_mut()
    {
        frames.insert(id);
    }
}

/// `resizeUpdates`: resizes `id` to `target` by hand, in `draft`.
pub fn resize_by_hand(draft: &mut Working, id: Id, target: Rect) {
    resize_node(
        draft,
        id,
        target,
        ResizeMode::Hand,
        &mut ResizeHooks::default(),
    );
}

// ── The Scale tool (K) ───────────────────────────────────────────────────────────────────────────

fn scale_line_height(value: &mut morfa_model::store::LineHeight, k: f64) {
    if let morfa_model::store::LineHeight::Pixels(pixels) = value {
        *pixels *= k;
    }
}

fn scale_letter_spacing(value: &mut morfa_model::types::LetterSpacing, k: f64) {
    if value.unit == morfa_model::types::LetterSpacingUnit::Pixels {
        value.value *= k;
    }
}

/// `scaleText`: type sizes and spacing scaled; a scaled range no longer matches its text style, so it is detached
/// (the values stay).
fn scale_text(text: &mut morfa_model::store::TextProps, k: f64) {
    let style = &mut text.style;
    style.font_size *= k;
    scale_line_height(&mut style.line_height, k);
    scale_letter_spacing(&mut style.letter_spacing, k);
    if !text.runs.is_empty() {
        let mut runs = text.runs.as_slice().to_vec();
        for run in &mut runs {
            if let Some(size) = &mut run.style.font_size {
                *size *= k;
            }
            if let Some(height) = &mut run.style.line_height {
                scale_line_height(height, k);
            }
            if let Some(spacing) = &mut run.style.letter_spacing {
                scale_letter_spacing(spacing, k);
            }
            run.text_style_id = None;
        }
        text.runs = runs.into();
    }
    text.paragraph_spacing *= k;
    text.paragraph_indent *= k;
}

/// `scaledFields`: everything that has a length on the node, scaled; styles whose values no longer match are
/// detached. Applied to `next`, a copy of the node.
fn scale_fields(next: &mut Node, fx: f64, fy: f64) {
    use morfa_model::store::{Effect, LayoutGrid, PropKey};
    use morfa_model::types::LayoutMode;
    let k = (fx * fy).sqrt();
    next.stroke_weight *= k;
    if !next.effects.is_empty() {
        let mut effects = next.effects.as_slice().to_vec();
        for effect in &mut effects {
            match effect {
                Effect::Shadow(shadow) => {
                    shadow.offset.x *= fx;
                    shadow.offset.y *= fy;
                    shadow.radius *= k;
                    shadow.spread *= k;
                }
                Effect::Blur(blur) => blur.radius *= k,
            }
        }
        next.effects = effects.into();
    }
    let detach_effect_style = !next.effects.is_empty();
    let mut props: Vec<Prop> = Vec::with_capacity(next.props.len());
    let mut has_text = false;
    let mut has_grids = false;
    for prop in next.props.iter() {
        let scaled = match prop {
            Prop::IndividualStrokeWeights(Some(sides)) => {
                let mut sides = **sides;
                sides.top *= fy;
                sides.right *= fx;
                sides.bottom *= fy;
                sides.left *= fx;
                Prop::IndividualStrokeWeights(Some(Arc::new(sides)))
            }
            Prop::CornerRadius(radius) => Prop::CornerRadius(radius * k),
            Prop::RectangleCornerRadii(Some(radii)) => {
                Prop::RectangleCornerRadii(Some(Arc::new(radii.map(|radius| radius * k))))
            }
            Prop::DashPattern(dashes) => {
                Prop::DashPattern(dashes.iter().map(|dash| dash * k).collect())
            }
            Prop::EffectStyleId(_) if detach_effect_style => continue,
            Prop::Text(text) => {
                has_text = true;
                let mut text = Arc::clone(text);
                scale_text(Arc::make_mut(&mut text), k);
                Prop::Text(text)
            }
            Prop::AutoLayout(layout) => {
                let mut layout = (**layout).clone();
                let horizontal = layout.layout_mode != LayoutMode::Vertical;
                layout.padding_left *= fx;
                layout.padding_right *= fx;
                layout.padding_top *= fy;
                layout.padding_bottom *= fy;
                layout.item_spacing *= if horizontal { fx } else { fy };
                layout.counter_axis_spacing *= if horizontal { fy } else { fx };
                Prop::AutoLayout(Arc::new(layout))
            }
            Prop::Grid(grid) => {
                let scaled = |track: &GridTrackSize, f: f64| GridTrackSize {
                    kind: track.kind,
                    value: if track.kind == GridTrackType::Fixed {
                        track.value.map(|value| value * f)
                    } else {
                        track.value
                    },
                };
                let mut grid = (**grid).clone();
                grid.row_gap *= fy;
                grid.column_gap *= fx;
                grid.row_sizes = grid
                    .row_sizes
                    .iter()
                    .map(|track| scaled(track, fy))
                    .collect();
                grid.column_sizes = grid
                    .column_sizes
                    .iter()
                    .map(|track| scaled(track, fx))
                    .collect();
                Prop::Grid(Arc::new(grid))
            }
            Prop::LayoutGrids(grids) if !grids.is_empty() => {
                has_grids = true;
                let mut grids = grids.as_slice().to_vec();
                for grid in &mut grids {
                    match grid {
                        LayoutGrid::Grid(grid) => grid.section_size *= k,
                        LayoutGrid::Columns(band) => {
                            band.section_size *= fx;
                            band.gutter_size *= fx;
                            band.offset *= fx;
                        }
                        LayoutGrid::Rows(band) => {
                            band.section_size *= fy;
                            band.gutter_size *= fy;
                            band.offset *= fy;
                        }
                    }
                }
                Prop::LayoutGrids(grids.into())
            }
            Prop::MinWidth(Some(value)) => Prop::MinWidth(Some(value * fx)),
            Prop::MaxWidth(Some(value)) => Prop::MaxWidth(Some(value * fx)),
            Prop::MinHeight(Some(value)) => Prop::MinHeight(Some(value * fy)),
            Prop::MaxHeight(Some(value)) => Prop::MaxHeight(Some(value * fy)),
            Prop::VectorPaths(paths) if !paths.is_empty() => {
                Prop::VectorPaths(scale_paths(paths, fx, fy).into())
            }
            Prop::TextPath(path) => Prop::TextPath(Arc::new(scale_text_path(path, fx, fy))),
            other => other.clone(),
        };
        props.push(scaled);
    }
    // The styles detached: `textStyleId` with a text, `gridStyleId` with grids (effects above).
    if has_text {
        props.retain(|prop| prop.key() != PropKey::TextStyleId);
    }
    if has_grids {
        props.retain(|prop| prop.key() != PropKey::GridStyleId);
    }
    next.props = morfa_model::store::Props::from_sorted(props);
}

fn scale_node(draft: &mut Working, id: Id, target: Rect, fallback_x: f64, fallback_y: f64) {
    let Some(node) = draft.node(id) else {
        return;
    };
    if node.kind == NodeType::Page {
        return;
    }
    let fx = ratio(target.width, node.width, fallback_x);
    let fy = ratio(target.height, node.height, fallback_y);
    let mut next = node.clone();
    for child_id in node.children().to_vec() {
        let Some(child) = draft.node(child_id) else {
            continue;
        };
        let placement = placement(child);
        let bounds = bounds_of(&placement);
        let to = Rect::new(
            bounds.x * fx,
            bounds.y * fy,
            bounds.width * fx,
            bounds.height * fy,
        );
        let child_box = box_for_bounds(&placement, to, bounds, (fx, fy));
        scale_node(draft, child_id, child_box, fx, fy);
    }
    next.x = target.x;
    next.y = target.y;
    next.width = target.width;
    next.height = if next.kind == NodeType::Line {
        0.0
    } else {
        target.height
    };
    scale_fields(&mut next, fx, fy);
    draft.update(id, |node| *node = next);
}

/// [`crate::constraints::world_matrix_by`] with the nodes read through `get`.
pub fn world_matrix_by<'a>(get: impl Fn(Id) -> Option<&'a Node>, id: Id) -> geom::Matrix {
    let mut chain = Vec::new();
    let mut node = get(id);
    while let Some(current) = node {
        if current.kind == NodeType::Page {
            break;
        }
        chain.push(placement(current));
        node = current.parent.and_then(&get);
    }
    let mut m = geom::IDENTITY;
    for placement in chain.iter().rev() {
        m = geom::multiply(&m, &geom::local_matrix(placement));
    }
    m
}

/// `scaleUpdates`: the Scale tool (K) scales the nodes about `origin` (page space) by `sx`, `sy`, with everything
/// inside them. Nodes whose ancestor is also listed are scaled with that ancestor. The nodes are read as they were
/// before this call's writes.
pub fn scale_by_tool(draft: &mut Working, ids: &[Id], origin: geom::Vec2, sx: f64, sy: f64) {
    let kx = if truthy(sx.abs()) { sx.abs() } else { 1.0 };
    let ky = if truthy(sy.abs()) { sy.abs() } else { 1.0 };
    for &id in ids {
        let base = |id: Id| draft.base_node(id);
        let Some(node) = base(id) else {
            continue;
        };
        if node.kind == NodeType::Page {
            continue;
        }
        let mut nested = false;
        let mut up = node.parent.and_then(base);
        while let Some(current) = up {
            if nested {
                break;
            }
            nested = ids.contains(&current.id);
            up = current.parent.and_then(base);
        }
        if nested {
            continue;
        }
        let to_parent = match node.parent {
            Some(parent) => geom::invert(&world_matrix_by(base, parent)),
            None => geom::IDENTITY,
        };
        let o = geom::apply(&to_parent, origin);
        let placement = placement(node);
        let bounds = bounds_of(&placement);
        let to = Rect::new(
            o.x + (bounds.x - o.x) * kx,
            o.y + (bounds.y - o.y) * ky,
            bounds.width * kx,
            bounds.height * ky,
        );
        let target = box_for_bounds(&placement, to, bounds, (kx, ky));
        scale_node(draft, id, target, kx, ky);
    }
}

#[allow(dead_code)]
const _: f64 = LAYOUT_EPSILON;
