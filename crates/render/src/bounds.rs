//! Render bounds: `shared/design/bounds.ts` on the stored document (what the painter culls with and what the
//! effect passes size their bitmaps by). Generous on purpose, like the TypeScript.

use crate::shape::{has_open_path, has_variable_width, marker_size, max_width_factor};
use kurbo::{Affine, Rect};
use morfa_model::store::{Document, Effect, Node, ShadowKind};
use morfa_model::store::{Id, Symbol};
use morfa_model::{NodeType, StrokeAlign, StrokeCap, StrokeJoin};

/// How far a blur of radius `radius` visibly reaches beyond the shape it blurs (3σ, σ = r / 2).
pub fn blur_reach(radius: f64) -> f64 {
    radius.max(0.0) * 1.5
}

pub const FRAME_LIKE: [NodeType; 4] = [
    NodeType::Frame,
    NodeType::Component,
    NodeType::ComponentSet,
    NodeType::Instance,
];

pub fn is_frame_like(node: &Node) -> bool {
    FRAME_LIKE.contains(&node.kind)
}

pub fn is_container(node: &Node) -> bool {
    morfa_model::CONTAINER_TYPES.contains(&node.kind)
}

/// A board section with "hide contents" on (lane G's `BoardMeta::Section { hidden: Some(true), .. }`): it paints its own
/// fill, stroke and name chip, never what it holds, and what it holds does not count toward its bounds.
pub fn hides_contents(node: &Node) -> bool {
    node.kind == NodeType::Section
        && matches!(
            node.props.board().map(|meta| &**meta),
            Some(morfa_model::store::BoardMeta::Section {
                hidden: Some(true),
                ..
            })
        )
}

/// Frames that clip their children to their own box.
pub fn clips_children(node: &Node) -> bool {
    is_frame_like(node) && node.props.clips_content().copied().unwrap_or(true)
}

pub fn has_visible_stroke(node: &Node) -> bool {
    node.stroke_weight > 0.0
        && node
            .strokes
            .as_slice()
            .iter()
            .any(|p| p.visible() && p.opacity() > 0.0)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Outsets {
    pub left: f64,
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
}

impl Outsets {
    pub const NONE: Outsets = Outsets {
        left: 0.0,
        top: 0.0,
        right: 0.0,
        bottom: 0.0,
    };
    pub fn uniform(reach: f64) -> Outsets {
        Outsets {
            left: reach,
            top: reach,
            right: reach,
            bottom: reach,
        }
    }
    pub fn max(&self) -> f64 {
        self.left.max(self.top).max(self.right).max(self.bottom)
    }
}

/// How far the stroke reaches beyond the box on each side (`strokeOutsets`).
pub fn stroke_outsets(node: &Node) -> Outsets {
    if !has_visible_stroke(node) {
        return Outsets::NONE;
    }
    if has_variable_width(node) {
        return Outsets::uniform((node.stroke_weight * max_width_factor(node)) / 2.0);
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
    if let Some(Some(individual)) = node.props.individual_stroke_weights() {
        if node.kind == NodeType::Rectangle || is_frame_like(node) {
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
        let limit = if node.stroke_miter_limit > 0.0 {
            node.stroke_miter_limit
        } else {
            4.0
        };
        reach *= limit.max(1.0);
    }
    if open {
        if node.stroke_cap == StrokeCap::Square {
            reach = reach.max(node.stroke_weight * std::f64::consts::FRAC_1_SQRT_2);
        }
        let markers = node
            .props
            .stroke_start_marker()
            .is_some_and(|m| *m != morfa_model::StrokeMarker::None)
            || node
                .props
                .stroke_end_marker()
                .is_some_and(|m| *m != morfa_model::StrokeMarker::None);
        if markers {
            reach = reach.max(marker_size(node.stroke_weight));
        }
    }
    Outsets::uniform(reach)
}

pub fn visible_effects(node: &Node) -> impl Iterator<Item = &Effect> {
    node.effects
        .as_slice()
        .iter()
        .filter(|effect| match effect {
            Effect::Shadow(s) => s.visible,
            Effect::Blur(b) => b.visible,
        })
}

/// Grows a local rectangle by what the node's effects paint outside it (`expandByEffects`).
pub fn expand_by_effects(rect: Rect, node: &Node) -> Rect {
    let base = rect;
    let mut out = rect;
    for effect in visible_effects(node) {
        match effect {
            Effect::Shadow(shadow) if shadow.kind == ShadowKind::Drop => {
                let grow = shadow.spread.max(0.0) + blur_reach(shadow.radius);
                out.x0 = out.x0.min(base.x0 + shadow.offset.x - grow);
                out.y0 = out.y0.min(base.y0 + shadow.offset.y - grow);
                out.x1 = out.x1.max(base.x1 + shadow.offset.x + grow);
                out.y1 = out.y1.max(base.y1 + shadow.offset.y + grow);
            }
            _ => {}
        }
    }
    if let Some(Effect::Blur(blur)) = visible_effects(node)
        .find(|e| matches!(e, Effect::Blur(b) if b.kind == morfa_model::store::BlurKind::Layer))
    {
        let grow = blur_reach(blur.radius);
        out = out.inflate(grow, grow);
    }
    out
}

/// Grows a page-space rectangle by a container's effects, whose offsets turn with the container.
pub fn expand_world_by_effects(rect: Rect, node: &Node, world: Affine) -> Rect {
    let mut out = rect;
    let c = world.as_coeffs();
    for effect in visible_effects(node) {
        match effect {
            Effect::Shadow(shadow) if shadow.kind == ShadowKind::Drop => {
                let grow = shadow.spread.max(0.0) + blur_reach(shadow.radius);
                let dx = c[0] * shadow.offset.x + c[2] * shadow.offset.y;
                let dy = c[1] * shadow.offset.x + c[3] * shadow.offset.y;
                let shifted = Rect::new(
                    rect.x0 + dx - grow,
                    rect.y0 + dy - grow,
                    rect.x1 + dx + grow,
                    rect.y1 + dy + grow,
                );
                out = out.union(shifted);
            }
            Effect::Blur(blur) if blur.kind == morfa_model::store::BlurKind::Layer => {
                let grow = blur_reach(blur.radius);
                out = out.union(rect.inflate(grow, grow));
            }
            _ => {}
        }
    }
    out
}

/// The node's own box with its stroke, before effects (`ownBox`).
pub fn own_box(node: &Node) -> Rect {
    let out = stroke_outsets(node);
    Rect::new(
        -out.left,
        -out.top,
        node.width.max(0.0) + out.right,
        node.height.max(0.0) + out.bottom,
    )
}

/// What the node paints by itself in its local space (`localRenderBounds`); `text` is a text node's laid-out
/// lines (from its sprite) when known.
pub fn local_render_bounds(node: &Node, text: Option<Rect>) -> Rect {
    let mut rect = Rect::new(0.0, 0.0, node.width.max(0.0), node.height.max(0.0));
    if node.kind == NodeType::Text {
        if let Some(lines) = text {
            rect = rect.union(lines);
        }
    }
    let out = stroke_outsets(node);
    rect = Rect::new(
        rect.x0 - out.left,
        rect.y0 - out.top,
        rect.x1 + out.right,
        rect.y1 + out.bottom,
    );
    expand_by_effects(rect, node)
}

/// Axis-aligned image of a rectangle under an affine map (`transformRect` / `mapRect`).
pub fn transform_rect(t: Affine, r: Rect) -> Rect {
    t.transform_rect_bbox(r)
}

/// `localMatrix(node)`: translate(x, y) · rotate(−rotation°) · flip about the box centre.
pub fn local_matrix(node: &Node) -> Affine {
    let radians = -(node.rotation * std::f64::consts::PI / 180.0);
    let mut m = Affine::translate((node.x, node.y)) * Affine::rotate(radians);
    let flip_x = node.props.flip_x().copied().unwrap_or(false);
    let flip_y = node.props.flip_y().copied().unwrap_or(false);
    if flip_x || flip_y {
        let flip = Affine::translate((node.width / 2.0, node.height / 2.0))
            * Affine::scale_non_uniform(
                if flip_x { -1.0 } else { 1.0 },
                if flip_y { -1.0 } else { 1.0 },
            )
            * Affine::translate((-node.width / 2.0, -node.height / 2.0));
        m *= flip;
    }
    m
}

/// `worldMatrix(doc, id)` through the parent chain; pages are the identity.
pub fn world_matrix(doc: &Document, id: Id) -> Affine {
    let mut chain = Vec::new();
    let mut current = doc.node(id);
    while let Some(node) = current {
        if node.kind == NodeType::Page {
            break;
        }
        chain.push(node);
        current = node.parent.and_then(|p| doc.node(p));
    }
    let mut m = Affine::IDENTITY;
    for node in chain.iter().rev() {
        m *= local_matrix(node);
    }
    m
}

/// Lookup of a text node's local line bounds (from its sprite), for bounds that count overflowing lines.
pub trait TextBounds {
    fn text_bounds(&self, id: Id) -> Option<Rect>;
}

impl TextBounds for () {
    fn text_bounds(&self, _id: Id) -> Option<Rect> {
        None
    }
}

/// Page-space bounds of everything the node and its visible descendants paint (`subtreeRenderBounds`), written
/// into `out` for every node of the subtree. None when nothing is painted.
pub fn subtree_render_bounds(
    doc: &Document,
    node: &Node,
    world: Affine,
    text: &dyn TextBounds,
    out: &mut Vec<Option<Rect>>,
) -> Option<Rect> {
    let slot = node.id.index();
    if slot >= out.len() {
        out.resize(slot + 1, None);
    }
    if !node.visible || node.kind == NodeType::Slice {
        // Nothing under it paints either: its descendants' slots are cleared too (an incremental sync may hold their
        // rects from when the subtree was visible).
        clear_subtree(doc, node, out);
        return None;
    }
    // The children first (their rects are wanted even under a clip: the painter culls them one by one inside it).
    if let Some(children) = &node.children {
        for &child_id in children.iter() {
            if let Some(child) = doc.node(child_id) {
                subtree_render_bounds(doc, child, world * local_matrix(child), text, out);
            }
        }
    }
    let rect = node_bounds(node, world, text, |child| {
        out.get(child.index()).copied().flatten()
    });
    out[node.id.index()] = rect;
    rect
}

fn clear_subtree(doc: &Document, node: &Node, out: &mut Vec<Option<Rect>>) {
    let slot = node.id.index();
    if slot >= out.len() {
        out.resize(slot + 1, None);
    }
    out[slot] = None;
    if let Some(children) = &node.children {
        for &child_id in children.iter() {
            if let Some(child) = doc.node(child_id) {
                clear_subtree(doc, child, out);
            }
        }
    }
}

/// A node's page-space bounds from its own box and its children's bounds (`children_rect`, as `subtree_render_bounds`
/// wrote them): the one step of the recursion, so a changed subtree's ancestors can be recombined without walking
/// their other children ([`recombine_ancestors`]).
pub fn node_bounds(
    node: &Node,
    world: Affine,
    text: &dyn TextBounds,
    children_rect: impl Fn(Id) -> Option<Rect>,
) -> Option<Rect> {
    if !node.visible || node.kind == NodeType::Slice {
        return None;
    }
    if !is_container(node) || node.kind == NodeType::BooleanOperation || clips_children(node) {
        return Some(transform_rect(
            world,
            local_render_bounds(node, text.text_bounds(node.id)),
        ));
    }
    let mut rect: Option<Rect> = if matches!(node.kind, NodeType::Group | NodeType::Page) {
        None
    } else {
        Some(transform_rect(world, own_box_without_effects(node)))
    };
    if let Some(children) = node.children.as_ref().filter(|_| !hides_contents(node)) {
        for &child_id in children.iter() {
            if let Some(child_rect) = children_rect(child_id) {
                rect = Some(match rect {
                    Some(r) => r.union(child_rect),
                    None => child_rect,
                });
            }
        }
    }
    rect.map(|r| expand_world_by_effects(r, node, world))
}

/// After the subtree of `id` was recomputed into `out`: every ancestor below the page takes its bounds again from
/// its children's rects, up to the first one whose bounds did not change (the ones above it cannot have).
pub fn recombine_ancestors(
    doc: &Document,
    id: Id,
    text: &dyn TextBounds,
    out: &mut Vec<Option<Rect>>,
) {
    let mut at = doc.node(id).and_then(|n| n.parent);
    while let Some(parent_id) = at {
        let Some(parent) = doc.node(parent_id) else {
            break;
        };
        if parent.kind == NodeType::Page {
            break;
        }
        let slot = parent_id.index();
        if slot >= out.len() {
            out.resize(slot + 1, None);
        }
        let world = world_matrix(doc, parent_id);
        let rect = node_bounds(parent, world, text, |child| {
            out.get(child.index()).copied().flatten()
        });
        let same = match (out[slot], rect) {
            (None, None) => true,
            (Some(a), Some(b)) => a == b,
            _ => false,
        };
        out[slot] = rect;
        if same {
            break;
        }
        at = parent.parent;
    }
}

fn own_box_without_effects(node: &Node) -> Rect {
    let out = stroke_outsets(node);
    Rect::new(
        -out.left,
        -out.top,
        node.width.max(0.0) + out.right,
        node.height.max(0.0) + out.bottom,
    )
}

/// `renderBounds(doc, id)` for one node (a slice answers with its box).
pub fn render_bounds(doc: &Document, id: Id, text: &dyn TextBounds) -> Option<Rect> {
    let node = doc.node(id)?;
    let world = world_matrix(doc, id);
    if node.kind == NodeType::Slice {
        return Some(transform_rect(
            world,
            Rect::new(0.0, 0.0, node.width, node.height),
        ));
    }
    let mut scratch = Vec::new();
    subtree_render_bounds(doc, node, world, text, &mut scratch)
}
