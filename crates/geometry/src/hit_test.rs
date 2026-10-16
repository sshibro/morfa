//! `src/design/engine/hit-test.ts`: geometric hit testing in page space, DOM-free (the TypeScript is too:
//! it imports only shared/design). A click is tested against what the user sees: the node's outline
//! (flattened, with its winding rule), its stroke band, the box of texts and frames; hidden and locked
//! nodes let clicks through, a clipping frame or a mask hides what lies outside it.
//!
//! The TypeScript caches flattened outlines per node object; here a [`HitScene`] holds one document and
//! caches them per node for as long as it lives. With an index (`HitIndex`, the uniform grid of
//! spatial-index.ts over conservative per-node bounds) only nodes near the point are tested; without one
//! the page is walked front to back. Both give the same answer, as in the TypeScript.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};

use morfa_model::{
    BooleanOperation, DesignDocument, Matrix, NodeType, PathCommand, SceneNode, StrokeAlign,
    StrokeMarker, TextPathSide, Vec2, WindingRule,
};

use crate::bounds;
use crate::js;
use crate::matrix::{
    IDENTITY, Rect, apply, apply_linear, invert, multiply, node_matrix, rect_contains,
    transform_rect, world_matrix,
};
use crate::paths::{reverse_path, subpaths, v};
use crate::shapes::node_geometry;
use crate::spatial::{Grid, box_bounds};
use crate::text_bounds::{TextBounds, TextLayouter};

/// Screen pixels within which a thin line or an edge still counts as hit.
pub const HIT_TOLERANCE_PX: f64 = 4.0;

/// A subpath as x0, y0, x1, y1… in the node's local box.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct FlatPolyline {
    pub points: Vec<f64>,
    pub closed: bool,
}

struct OutlinePath {
    evenodd: bool,
    subpaths: Vec<FlatPolyline>,
}

struct Flat {
    outline: Vec<OutlinePath>,
    bounds: Rect,
    open: bool,
}

#[inline]
fn segments_for(length: f64) -> f64 {
    js::max(4.0, js::min(64.0, (length / 8.0).ceil()))
}

/// Curves become polylines with chords at most ~0.2 px from the curve at any size.
pub fn flatten_commands(commands: &[PathCommand]) -> Vec<FlatPolyline> {
    let mut out = Vec::new();
    let mut points: Option<Vec<f64>> = None;
    let (mut x, mut y, mut start_x, mut start_y) = (0.0, 0.0, 0.0, 0.0);
    fn finish(points: &mut Option<Vec<f64>>, out: &mut Vec<FlatPolyline>, closed: bool) {
        if let Some(p) = points.take() {
            if p.len() > 2 {
                out.push(FlatPolyline { points: p, closed });
            }
        }
    }
    for command in commands {
        match command {
            PathCommand::Z => {
                finish(&mut points, &mut out, true);
                x = start_x;
                y = start_y;
                continue;
            }
            PathCommand::M(p) => {
                finish(&mut points, &mut out, false);
                points = Some(vec![p.x, p.y]);
                x = p.x;
                start_x = p.x;
                y = p.y;
                start_y = p.y;
                continue;
            }
            _ => {}
        }
        let pts = points.get_or_insert_with(|| {
            start_x = x;
            start_y = y;
            vec![x, y]
        });
        match command {
            PathCommand::L(p) => {
                pts.push(p.x);
                pts.push(p.y);
                x = p.x;
                y = p.y;
            }
            PathCommand::C(c) => {
                let length = js::hypot(c.x1 - x, c.y1 - y)
                    + js::hypot(c.x2 - c.x1, c.y2 - c.y1)
                    + js::hypot(c.x - c.x2, c.y - c.y2);
                let n = segments_for(length);
                let mut i = 1.0;
                while i <= n {
                    let t = i / n;
                    let u = 1.0 - t;
                    let (a, b, cc, d) = (u * u * u, 3.0 * u * u * t, 3.0 * u * t * t, t * t * t);
                    pts.push(a * x + b * c.x1 + cc * c.x2 + d * c.x);
                    pts.push(a * y + b * c.y1 + cc * c.y2 + d * c.y);
                    i += 1.0;
                }
                x = c.x;
                y = c.y;
            }
            PathCommand::Q(q) => {
                let length = js::hypot(q.x1 - x, q.y1 - y) + js::hypot(q.x - q.x1, q.y - q.y1);
                let n = segments_for(length);
                let mut i = 1.0;
                while i <= n {
                    let t = i / n;
                    let u = 1.0 - t;
                    pts.push(u * u * x + 2.0 * u * t * q.x1 + t * t * q.x);
                    pts.push(u * u * y + 2.0 * u * t * q.y1 + t * t * q.y);
                    i += 1.0;
                }
                x = q.x;
                y = q.y;
            }
            _ => {}
        }
    }
    finish(&mut points, &mut out, false);
    out
}

/// `textPathCommands` of shared/design/text-path.ts: the first subpath, reversed for the RIGHT side.
pub fn text_path_commands(commands: &[PathCommand], side: TextPathSide) -> Vec<PathCommand> {
    let first = subpaths(commands)
        .first()
        .map(|p| p.to_vec())
        .unwrap_or_default();
    if side == TextPathSide::Right {
        reverse_path(&first)
    } else {
        first
    }
}

fn compute_flat(node: &SceneNode) -> Flat {
    // A text on a path is outlined by its path.
    let geometry = match &node.text_path {
        Some(tp) => vec![morfa_model::VectorPath {
            winding_rule: WindingRule::Nonzero,
            commands: text_path_commands(&tp.commands, tp.side),
        }],
        None => node_geometry(node),
    };
    let outline: Vec<OutlinePath> = geometry
        .iter()
        .map(|p| OutlinePath {
            evenodd: p.winding_rule == WindingRule::Evenodd,
            subpaths: flatten_commands(&p.commands),
        })
        .collect();
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    let mut open = false;
    for path in &outline {
        for sub in &path.subpaths {
            if !sub.closed {
                open = true;
            }
            for xy in sub.points.as_chunks::<2>().0.iter() {
                let (px, py) = (xy[0], xy[1]);
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
        }
    }
    let bounds = if min_x.is_finite() {
        Rect::new(min_x, min_y, max_x - min_x, max_y - min_y)
    } else {
        Rect::new(0.0, 0.0, node.width, node.height)
    };
    Flat {
        outline,
        bounds,
        open: open || node.kind == NodeType::Line,
    }
}

/// The node's outline in its local box, flattened. Boxes for nodes without geometry of their own.
pub fn node_outline(node: &SceneNode) -> Vec<FlatPolyline> {
    let own: Vec<FlatPolyline> = compute_flat(node)
        .outline
        .into_iter()
        .flat_map(|p| p.subpaths)
        .collect();
    if !own.is_empty() {
        return own;
    }
    vec![FlatPolyline {
        points: vec![
            0.0,
            0.0,
            node.width,
            0.0,
            node.width,
            node.height,
            0.0,
            node.height,
        ],
        closed: true,
    }]
}

fn inside_fill(outline: &[OutlinePath], p: Vec2) -> bool {
    for path in outline {
        let mut winding: i64 = 0;
        for sub in &path.subpaths {
            let points = &sub.points;
            let n = points.len() / 2;
            if n < 3 {
                continue;
            }
            for i in 0..n {
                let j = if i + 1 == n { 0 } else { i + 1 };
                let (x0, y0, x1, y1) = (
                    points[2 * i],
                    points[2 * i + 1],
                    points[2 * j],
                    points[2 * j + 1],
                );
                let cross = (x1 - x0) * (p.y - y0) - (p.x - x0) * (y1 - y0);
                if y0 <= p.y {
                    if y1 > p.y && cross > 0.0 {
                        winding += 1;
                    }
                } else if y1 <= p.y && cross < 0.0 {
                    winding -= 1;
                }
            }
        }
        if if path.evenodd {
            winding % 2 != 0
        } else {
            winding != 0
        } {
            return true;
        }
    }
    false
}

#[inline]
fn segment_distance(px: f64, py: f64, x0: f64, y0: f64, x1: f64, y1: f64) -> f64 {
    let dx = x1 - x0;
    let dy = y1 - y0;
    let length = dx * dx + dy * dy;
    let t = if length != 0.0 && !length.is_nan() {
        js::max(
            0.0,
            js::min(1.0, ((px - x0) * dx + (py - y0) * dy) / length),
        )
    } else {
        0.0
    };
    js::hypot(px - (x0 + t * dx), py - (y0 + t * dy))
}

fn outline_distance(outline: &[OutlinePath], p: Vec2) -> f64 {
    let mut best = f64::INFINITY;
    for path in outline {
        for sub in &path.subpaths {
            let points = &sub.points;
            let n = points.len() / 2;
            let last = if sub.closed { n } else { n.saturating_sub(1) };
            for i in 0..last {
                let j = if i + 1 == n { 0 } else { i + 1 };
                let d = segment_distance(
                    p.x,
                    p.y,
                    points[2 * i],
                    points[2 * i + 1],
                    points[2 * j],
                    points[2 * j + 1],
                );
                if d < best {
                    best = d;
                }
            }
        }
    }
    best
}

// ── One node ───────────────────────────────────────────────────────────────────────────────────

fn visible_paint(p: &morfa_model::Paint) -> bool {
    p.visible() && p.opacity() > 0.0
}
fn has_fill(node: &SceneNode) -> bool {
    node.fills.iter().any(visible_paint)
}
fn stroke_weight_of(node: &SceneNode) -> f64 {
    match node.individual_stroke_weights.flatten() {
        Some(s) => js::max(js::max(js::max(s.top, s.right), s.bottom), s.left),
        None => node.stroke_weight,
    }
}
fn has_stroke(node: &SceneNode) -> bool {
    stroke_weight_of(node) > 0.0 && node.strokes.iter().any(visible_paint)
}
#[inline]
fn in_box(node: &SceneNode, p: Vec2, margin: f64) -> bool {
    p.x >= -margin && p.y >= -margin && p.x <= node.width + margin && p.y <= node.height + margin
}
#[inline]
fn is_frame_like(node: &SceneNode) -> bool {
    node.kind.is_frame_like()
}
#[inline]
fn is_box_like(node: &SceneNode) -> bool {
    is_frame_like(node) || node.kind == NodeType::Section || node.kind == NodeType::Text
}
#[inline]
fn box_margin(node: &SceneNode, tolerance: f64) -> f64 {
    if node.width > 0.0 && node.height > 0.0 {
        0.0
    } else {
        tolerance
    }
}
#[inline]
fn has_markers(node: &SceneNode) -> bool {
    node.stroke_start_marker
        .is_some_and(|m| m != StrokeMarker::None)
        || node
            .stroke_end_marker
            .is_some_and(|m| m != StrokeMarker::None)
}
#[inline]
fn clips(node: &SceneNode) -> bool {
    node.clips_content != Some(false)
}
fn is_board_object(node: &SceneNode) -> bool {
    node.board
        .as_ref()
        .is_some_and(|b| !matches!(b, morfa_model::BoardMeta::Part(_)))
}

/// `paintChildren`: an auto-layout frame whose first child is drawn on top paints them reversed.
fn paints_reversed(node: &SceneNode) -> bool {
    node.auto_layout
        .as_ref()
        .is_some_and(|a| a.item_reverse_z_index && a.layout_mode != morfa_model::LayoutMode::None)
        && node.children.as_ref().is_some_and(|c| c.len() > 1)
}

fn paint_children(node: Option<&SceneNode>) -> Vec<&str> {
    let Some(node) = node else { return Vec::new() };
    let children = node.children.as_deref().unwrap_or_default();
    if paints_reversed(node) {
        children.iter().rev().map(String::as_str).collect()
    } else {
        children.iter().map(String::as_str).collect()
    }
}

/// The caches of one document's hit testing: flattened outlines per node and the index of one page. Kept
/// beside the document for as long as it does not change (the TS caches per node object).
#[derive(Default)]
pub struct HitCaches {
    flats: RefCell<hashbrown::HashMap<usize, std::rc::Rc<Flat>>>,
    index: RefCell<Option<std::rc::Rc<HitIndex>>>,
    tables: std::cell::OnceCell<Tables>,
    /// The index's text measurer (`SpatialIndex.sync(doc, page, measurer)`): `None` measures no text (a text node
    /// is its box), as the TypeScript index without one.
    text: Option<RefCell<TextLayouter>>,
    /// Set when the index met a node it cannot bound as the TypeScript does (a text on a path, with a measurer).
    unsupported: std::cell::Cell<bool>,
}

impl HitCaches {
    /// Caches whose index measures text with `testMeasurer` (lane L3's `FixedMeasurer`).
    pub fn with_test_measurer() -> HitCaches {
        HitCaches {
            text: Some(RefCell::new(TextLayouter::default())),
            ..HitCaches::default()
        }
    }

    /// Whether an index built so far met a node it could not bound (the answer would not be the TypeScript's).
    pub fn unsupported(&self) -> bool {
        self.unsupported.get()
    }
}

const NONE: u32 = u32::MAX;

/// The document's tree by node index (its position in `doc.nodes`), worked out once: what the index path
/// of hit testing reads per candidate instead of looking ids up by string.
struct Tables {
    /// The node of `parentId`, NONE without one or when it is missing.
    parent: Vec<u32>,
    /// `paintIndex(parent, id)`: the position in the parent's paint order, −1 when not listed.
    paint_index: Vec<i64>,
    /// The mask that clips the node among its siblings (`maskRuns`), NONE for none.
    clip_mask: Vec<u32>,
}

impl Tables {
    fn build(doc: &DesignDocument) -> Tables {
        let n = doc.nodes.len();
        let mut parent = vec![NONE; n];
        let mut paint_index = vec![-1i64; n];
        let mut clip_mask = vec![NONE; n];
        let mut listed = vec![false; n];
        for (i, node) in doc.nodes.values().enumerate() {
            if let Some(p) = node
                .parent_id
                .as_deref()
                .and_then(|p| doc.nodes.get_index_of(p))
            {
                parent[i] = p as u32;
            }
        }
        for (pi, node) in doc.nodes.values().enumerate() {
            let Some(children) = &node.children else {
                continue;
            };
            let reversed = paints_reversed(node);
            // Masks in paint order (`maskRuns` over `paintChildren`).
            let order: Vec<Option<usize>> = if reversed {
                children
                    .iter()
                    .rev()
                    .map(|c| doc.nodes.get_index_of(c.as_str()))
                    .collect()
            } else {
                children
                    .iter()
                    .map(|c| doc.nodes.get_index_of(c.as_str()))
                    .collect()
            };
            let mut current: Option<usize> = None;
            let mut runs: Vec<Option<usize>> = vec![None; order.len()];
            let mut any_mask = false;
            for (k, child) in order.iter().enumerate() {
                if let Some(c) = child {
                    let cn = &doc.nodes[*c];
                    if cn.is_mask {
                        current = cn.visible.then_some(k);
                        any_mask = true;
                        continue;
                    }
                }
                if any_mask {
                    runs[k] = current;
                }
            }
            for (index, id) in children.iter().enumerate() {
                let Some(c) = doc.nodes.get_index_of(id.as_str()) else {
                    continue;
                };
                // Only for the node whose parentId names this node, at its first position (`indexOf`).
                if parent[c] != pi as u32 || listed[c] {
                    continue;
                }
                listed[c] = true;
                // `paintIndex`: the position in paint order (counted from the end for a reversed frame).
                let k = if reversed {
                    children.len() - 1 - index
                } else {
                    index
                };
                paint_index[c] = k as i64;
                if let Some(m) = runs[k].and_then(|m| order[m]) {
                    clip_mask[c] = m as u32;
                }
            }
        }
        Tables {
            parent,
            paint_index,
            clip_mask,
        }
    }
}

/// One document and its caches.
pub struct HitScene<'a> {
    pub doc: &'a DesignDocument,
    caches: &'a HitCaches,
}

impl<'a> HitScene<'a> {
    pub fn new(doc: &'a DesignDocument, caches: &'a HitCaches) -> Self {
        HitScene { doc, caches }
    }

    #[inline]
    fn node(&self, id: &str) -> Option<&'a SceneNode> {
        self.doc.nodes.get(id)
    }

    fn flat(&self, node: &'a SceneNode) -> std::rc::Rc<Flat> {
        // The node's address names it while the document is unchanged.
        let key = node as *const SceneNode as usize;
        if let Some(f) = self.caches.flats.borrow().get(&key) {
            return f.clone();
        }
        let f = std::rc::Rc::new(compute_flat(node));
        self.caches.flats.borrow_mut().insert(key, f.clone());
        f
    }

    /// Fill and stroke of a shape at a local point.
    fn shape_hit(&self, node: &'a SceneNode, local: Vec2, tolerance: f64) -> bool {
        let flat = self.flat(node);
        let stroke = has_stroke(node);
        let weight = if stroke { stroke_weight_of(node) } else { 0.0 };
        let markers = has_markers(node);
        let reach = js::max(tolerance, weight * if markers { 3.0 } else { 1.0 });
        let b = flat.bounds;
        if local.x < b.x - reach
            || local.y < b.y - reach
            || local.x > b.x + b.width + reach
            || local.y > b.y + b.height + reach
        {
            return false;
        }
        let inside = node.kind != NodeType::Line && inside_fill(&flat.outline, local);
        if inside && (has_fill(node) || !stroke) {
            return true;
        }
        let distance = outline_distance(&flat.outline, local);
        if distance <= tolerance {
            return true;
        }
        if !stroke {
            return false;
        }
        if flat.open || node.stroke_align == StrokeAlign::Center {
            return distance <= if markers { weight * 1.5 } else { weight / 2.0 };
        }
        if node.stroke_align == StrokeAlign::Inside {
            inside && distance <= weight
        } else {
            !inside && distance <= weight
        }
    }

    /// Whether the point is inside the node's area, paints aside.
    fn shape_contains(&self, node: &'a SceneNode, m: &Matrix, point: Vec2) -> bool {
        if node.kind == NodeType::BooleanOperation || node.kind == NodeType::Group {
            let mut results: Vec<bool> = Vec::new();
            for id in node.children.as_deref().unwrap_or_default() {
                if let Some(child) = self.node(id) {
                    if child.visible {
                        results.push(self.shape_contains(
                            child,
                            &multiply(m, &node_matrix(child)),
                            point,
                        ));
                    }
                }
            }
            if results.is_empty() {
                return false;
            }
            if node.kind == NodeType::Group {
                return results.iter().any(|&r| r);
            }
            return match node.boolean_operation.unwrap_or(BooleanOperation::Union) {
                BooleanOperation::Intersect => results.iter().all(|&r| r),
                BooleanOperation::Subtract => results[0] && !results[1..].iter().any(|&r| r),
                BooleanOperation::Exclude => results.iter().filter(|&&r| r).count() % 2 == 1,
                BooleanOperation::Union => results.iter().any(|&r| r),
            };
        }
        let local = apply(&invert(m), point);
        if is_box_like(node) {
            return in_box(node, local, 0.0);
        }
        if matches!(node.kind, NodeType::Line | NodeType::Slice | NodeType::Page) {
            return false;
        }
        inside_fill(&self.flat(node).outline, local)
    }

    fn outline_distance_deep(&self, node: &'a SceneNode, m: &Matrix, point: Vec2) -> f64 {
        if let Some(children) = &node.children {
            let mut best = f64::INFINITY;
            for id in children {
                if let Some(child) = self.node(id) {
                    if child.visible {
                        best = js::min(
                            best,
                            self.outline_distance_deep(
                                child,
                                &multiply(m, &node_matrix(child)),
                                point,
                            ),
                        );
                    }
                }
            }
            return best;
        }
        outline_distance(&self.flat(node).outline, apply(&invert(m), point))
    }

    fn boolean_hit(&self, node: &'a SceneNode, m: &Matrix, point: Vec2, tolerance: f64) -> bool {
        let stroke = has_stroke(node);
        if self.shape_contains(node, m, point) && (has_fill(node) || !stroke) {
            return true;
        }
        self.outline_distance_deep(node, m, point)
            <= js::max(
                tolerance,
                if stroke {
                    stroke_weight_of(node) / 2.0
                } else {
                    0.0
                },
            )
    }

    /// The front-most operand under the point, or the operation itself.
    fn boolean_leaf(&self, node: &'a SceneNode, m: &Matrix, point: Vec2) -> &'a str {
        let children = node.children.as_deref().unwrap_or_default();
        for id in children.iter().rev() {
            let Some(child) = self.node(id) else { continue };
            if !child.visible || child.locked {
                continue;
            }
            let cm = multiply(m, &node_matrix(child));
            if !self.shape_contains(child, &cm, point) {
                continue;
            }
            return if child.kind == NodeType::BooleanOperation || child.kind == NodeType::Group {
                self.boolean_leaf(child, &cm, point)
            } else {
                child.id.as_str()
            };
        }
        node.id.as_str()
    }

    /// A text on a path takes clicks in a band along its path.
    fn text_on_path_hit(&self, node: &'a SceneNode, local: Vec2, tolerance: f64) -> bool {
        let Some(text) = &node.text else { return false };
        let mut size = text.style.font_size;
        for run in &text.runs {
            if let Some(s) = run.style.font_size {
                if s > size {
                    size = s;
                }
            }
        }
        let mut lines = 1;
        let mut from = 0;
        while lines < 1000 {
            match text.characters[from..].find('\n') {
                Some(i) => {
                    lines += 1;
                    from += i + 1;
                }
                None => break,
            }
        }
        outline_distance(&self.flat(node).outline, local)
            <= tolerance + size * 1.25 * f64::from(lines)
    }

    /// Whether the node's own geometry (not its children) is hit; `m` is its local → page matrix.
    fn own_hit(&self, node: &'a SceneNode, m: &Matrix, point: Vec2, tolerance: f64) -> bool {
        if node.kind == NodeType::BooleanOperation {
            return self.boolean_hit(node, m, point, tolerance);
        }
        if node.kind == NodeType::Page || node.kind == NodeType::Group {
            return false;
        }
        let local = apply(&invert(m), point);
        if node.text_path.is_some() {
            return self.text_on_path_hit(node, local, tolerance);
        }
        if is_box_like(node) {
            return in_box(node, local, box_margin(node, tolerance));
        }
        if node.kind == NodeType::Slice {
            if !in_box(node, local, tolerance) {
                return false;
            }
            let edge = js::min(
                js::min(local.x.abs(), local.y.abs()),
                js::min((node.width - local.x).abs(), (node.height - local.y).abs()),
            );
            return edge <= js::max(tolerance, 1.0);
        }
        self.shape_hit(node, local, tolerance)
    }

    /// Whether `point` (page space) hits the node itself at its place on the page, ignoring ancestors.
    pub fn hits_node(&self, id: &str, point: Vec2, tolerance: f64) -> bool {
        let Some(node) = self.node(id) else {
            return false;
        };
        let m = world_matrix(self.doc, id);
        if node.kind == NodeType::Group {
            return self.shape_contains(node, &m, point)
                || self.outline_distance_deep(node, &m, point) <= tolerance;
        }
        self.own_hit(node, &m, point, tolerance)
    }

    /// For each child (paint order), the index of the mask that clips it, or −1.
    fn mask_runs(&self, children: &[&str]) -> Option<Vec<i64>> {
        let mut runs: Option<Vec<i64>> = None;
        let mut current: i64 = -1;
        for (i, id) in children.iter().enumerate() {
            if let Some(child) = self.node(id) {
                if child.is_mask {
                    current = if child.visible { i as i64 } else { -1 };
                    if runs.is_none() {
                        runs = Some(vec![-1; children.len()]);
                    }
                    continue;
                }
            }
            if let Some(r) = runs.as_mut() {
                r[i] = current;
            }
        }
        runs
    }

    fn scan_children(
        &self,
        parent_id: &str,
        world: &Matrix,
        point: Vec2,
        tolerance: f64,
    ) -> Option<&'a str> {
        let children = paint_children(self.node(parent_id));
        let masks = self.mask_runs(&children);
        for i in (0..children.len()).rev() {
            let Some(child) = self.node(children[i]) else {
                continue;
            };
            if !child.visible || child.locked || child.is_mask {
                continue;
            }
            if let Some(masks) = &masks {
                if masks[i] >= 0 {
                    if let Some(mask) = self.node(children[masks[i] as usize]) {
                        if !self.shape_contains(mask, &multiply(world, &node_matrix(mask)), point) {
                            continue;
                        }
                    }
                }
            }
            if let Some(hit) = self.scan_node(
                child,
                &multiply(world, &node_matrix(child)),
                point,
                tolerance,
            ) {
                return Some(hit);
            }
        }
        None
    }

    fn scan_node(
        &self,
        node: &'a SceneNode,
        m: &Matrix,
        point: Vec2,
        tolerance: f64,
    ) -> Option<&'a str> {
        if node.kind == NodeType::Group {
            return self.scan_children(&node.id, m, point, tolerance);
        }
        if node.kind == NodeType::BooleanOperation {
            return self
                .boolean_hit(node, m, point, tolerance)
                .then(|| self.boolean_leaf(node, m, point));
        }
        if is_frame_like(node) || node.kind == NodeType::Section {
            let local = apply(&invert(m), point);
            let clipping = is_frame_like(node) && clips(node);
            if !clipping || in_box(node, local, 0.0) {
                if let Some(inner) = self.scan_children(&node.id, m, point, tolerance) {
                    return Some(inner);
                }
            }
            return in_box(node, local, box_margin(node, tolerance)).then_some(node.id.as_str());
        }
        self.own_hit(node, m, point, tolerance)
            .then_some(node.id.as_str())
    }

    /// Position of a node in paint order as a path of child indices from its page (`paintPath`).
    fn paint_path(&self, id: &str) -> Vec<i64> {
        let mut path = Vec::new();
        let mut node = self.node(id);
        while let Some(n) = node {
            let Some(parent_id) = n.parent_id.as_deref() else {
                break;
            };
            let parent = self.node(parent_id);
            path.push(paint_index(parent, &n.id));
            node = parent;
        }
        path.push(node.map_or(-1, |n| {
            self.doc
                .pages
                .iter()
                .position(|p| *p == n.id)
                .map_or(-1, |i| i as i64)
        }));
        path.reverse();
        path
    }

    fn tables(&self) -> &'a Tables {
        self.caches.tables.get_or_init(|| Tables::build(self.doc))
    }

    /// `paintPath` by node index.
    fn paint_path_of(&self, tables: &Tables, i: u32) -> Vec<i64> {
        let mut path = Vec::with_capacity(8);
        let mut node = Some(i);
        while let Some(k) = node {
            if self.doc.nodes[k as usize].parent_id.is_none() {
                break;
            }
            path.push(tables.paint_index[k as usize]);
            let p = tables.parent[k as usize];
            node = (p != NONE).then_some(p);
        }
        path.push(node.map_or(-1, |k| {
            let id = &self.doc.nodes[k as usize].id;
            self.doc
                .pages
                .iter()
                .position(|p| p == id)
                .map_or(-1, |x| x as i64)
        }));
        path.reverse();
        path
    }

    fn indexed_hit(
        &self,
        index: &HitIndex,
        page_id: &str,
        point: Vec2,
        tolerance: f64,
    ) -> Option<&'a str> {
        let tables = self.tables();
        let page = self
            .doc
            .nodes
            .get_index_of(page_id)
            .map_or(NONE, |p| p as u32);
        let mut cache = ChainCache {
            scene: self,
            tables,
            page,
            point,
            worlds: Default::default(),
            open: Default::default(),
        };
        let mut seen: hashbrown::HashSet<u32> = hashbrown::HashSet::new();
        let mut best: Option<(&'a str, Vec<i64>)> = None;
        let reach = js::max(tolerance, 0.0);
        for candidate in index.grid.query(&Rect::new(
            point.x - reach,
            point.y - reach,
            reach * 2.0,
            reach * 2.0,
        )) {
            // The outermost boolean above the candidate is the unit hit (`outermostBoolean`).
            let mut unit = candidate;
            let mut at = candidate;
            while at != NONE {
                let n = &self.doc.nodes[at as usize];
                if n.kind == NodeType::Page {
                    break;
                }
                if n.kind == NodeType::BooleanOperation {
                    unit = at;
                }
                at = if n.parent_id.is_some() {
                    tables.parent[at as usize]
                } else {
                    NONE
                };
            }
            if !seen.insert(unit) {
                continue;
            }
            let node = &self.doc.nodes[unit as usize];
            if node.kind == NodeType::Page
                || node.kind == NodeType::Group
                || node.is_mask
                || !cache.allows(unit)
            {
                continue;
            }
            let m = cache.world(unit);
            if !self.own_hit(node, &m, point, tolerance) {
                continue;
            }
            let path = self.paint_path_of(tables, unit);
            if let Some((_, best_path)) = &best {
                if compare_paint_paths(&path, best_path) <= 0 {
                    continue;
                }
            }
            let leaf = if node.kind == NodeType::BooleanOperation {
                self.boolean_leaf(node, &m, point)
            } else {
                node.id.as_str()
            };
            best = Some((leaf, path));
        }
        best.map(|(leaf, _)| leaf)
    }

    /// Builds the index of `page_id` unless it is the one already built, so `hit_test`/`nodes_in_rect` with
    /// `indexed` use it.
    pub fn build_index(&self, page_id: &str) {
        if self
            .caches
            .index
            .borrow()
            .as_ref()
            .is_some_and(|i| i.page == page_id)
        {
            return;
        }
        let index = HitIndex::build(self, page_id);
        *self.caches.index.borrow_mut() = Some(std::rc::Rc::new(index));
    }

    fn page_index(&self, page_id: &str) -> Option<std::rc::Rc<HitIndex>> {
        self.caches
            .index
            .borrow()
            .as_ref()
            .filter(|i| i.page == page_id)
            .cloned()
    }

    /// The front-most node under `point` on the page, as deep as it goes.
    pub fn hit_test(
        &self,
        page_id: &str,
        point: Vec2,
        tolerance: f64,
        indexed: bool,
    ) -> Option<&'a str> {
        if indexed {
            if let Some(index) = self.page_index(page_id) {
                return self.indexed_hit(&index, page_id, point, tolerance);
            }
        }
        self.scan_children(page_id, &IDENTITY, point, tolerance)
    }

    /// Lifts the hit layer to what a click selects, like Figma.
    pub fn lift_to_selectable(&self, leaf: &'a str, context: Option<&str>) -> &'a str {
        let mut chain: Vec<&'a str> = Vec::new();
        let mut reached_context = false;
        let mut node = self.node(leaf);
        while let Some(n) = node {
            if n.kind == NodeType::Page {
                break;
            }
            if Some(n.id.as_str()) == context {
                reached_context = true;
                break;
            }
            chain.push(n.id.as_str());
            node = n.parent_id.as_deref().and_then(|p| self.node(p));
        }
        if let Some(c) = context {
            if !reached_context && self.node(c).is_some() {
                return self.lift_to_selectable(leaf, None);
            }
        }
        chain.reverse();
        for i in 0..chain.len().saturating_sub(1) {
            let Some(node) = self.node(chain[i]) else {
                continue;
            };
            if node.kind == NodeType::Section {
                continue;
            }
            if is_board_object(node) {
                return chain[i];
            }
            if is_frame_like(node) && node.kind != NodeType::Instance {
                return chain[i + 1];
            }
            return chain[i];
        }
        chain.last().copied().unwrap_or(leaf)
    }

    /// What a click at `point` selects (None: empty canvas).
    pub fn pick_at(
        &self,
        page_id: &str,
        point: Vec2,
        tolerance: f64,
        indexed: bool,
        context: Option<&str>,
        deep: bool,
    ) -> Option<&'a str> {
        let leaf = self.hit_test(page_id, point, tolerance, indexed)?;
        Some(if deep {
            leaf
        } else {
            self.lift_to_selectable(leaf, context)
        })
    }

    /// What a marquee selects, in paint order.
    pub fn nodes_in_rect(
        &self,
        page_id: &str,
        rect: &Rect,
        context: Option<&str>,
        scope: Option<&str>,
        indexed: bool,
    ) -> Vec<&'a str> {
        let scope = scope.or(context).unwrap_or(page_id);
        let Some(scope_node) = self.node(scope) else {
            return Vec::new();
        };
        let canvas = scope == page_id || scope_node.kind == NodeType::Section;
        if indexed {
            if let Some(index) = self.page_index(page_id) {
                return self.indexed_marquee(&index, scope, canvas, rect);
            }
        }
        let mut out = Vec::new();
        let scope_world = world_matrix(self.doc, scope);
        let scope_clip =
            (scope != page_id && is_frame_like(scope_node) && clips(scope_node)).then(|| {
                transform_rect(
                    &scope_world,
                    &Rect::new(0.0, 0.0, scope_node.width, scope_node.height),
                )
            });
        self.collect(scope, &scope_world, canvas, scope_clip, rect, &mut out);
        out
    }

    fn collect(
        &self,
        parent_id: &str,
        world: &Matrix,
        on_canvas: bool,
        clip: Option<Rect>,
        rect: &Rect,
        out: &mut Vec<&'a str>,
    ) {
        let area = match clip {
            Some(c) => intersection(rect, &c),
            None => Some(*rect),
        };
        let Some(area) = area else { return };
        for id in paint_children(self.node(parent_id)) {
            let Some(child) = self.node(id) else { continue };
            if !child.visible || child.locked {
                continue;
            }
            let m = multiply(world, &node_matrix(child));
            if !box_intersects_rect(&m, child.width, child.height, &area) {
                continue;
            }
            if on_canvas && opens_on_canvas(child) {
                let b = transform_rect(&m, &Rect::new(0.0, 0.0, child.width, child.height));
                if rect_contains(rect, &b) {
                    out.push(child.id.as_str());
                } else {
                    let child_clip = if is_frame_like(child) && clips(child) {
                        match clip {
                            Some(c) => intersection(&c, &b),
                            None => Some(b),
                        }
                    } else {
                        clip
                    };
                    // `intersection(clip, box)` may be null: the TS then passes null on, which means "no clip".
                    self.collect(
                        &child.id,
                        &m,
                        child.kind == NodeType::Section,
                        child_clip,
                        rect,
                        out,
                    );
                }
                continue;
            }
            out.push(child.id.as_str());
        }
    }

    fn indexed_marquee(
        &self,
        index: &HitIndex,
        scope: &str,
        canvas: bool,
        rect: &Rect,
    ) -> Vec<&'a str> {
        let mut worlds: HashMap<&str, Matrix> = HashMap::new();
        let mut world = |id: &str| -> Matrix {
            if let Some(m) = worlds.get(id) {
                return *m;
            }
            let m = world_matrix(self.doc, id);
            // Keyed by the document's own id string so the borrow lives as long as the scene.
            if let Some((key, _)) = self.doc.nodes.get_key_value(id) {
                worlds.insert(key.as_str(), m);
            }
            m
        };
        let mut covered: HashMap<&str, bool> = HashMap::new();
        let mut units: Vec<&'a str> = Vec::new();
        let mut unit_set: HashSet<&'a str> = HashSet::new();
        for candidate in index.query(rect) {
            let Some((cid, _)) = self.doc.nodes.get_index(candidate) else {
                continue;
            };
            let mut chain: Vec<&'a str> = Vec::new();
            let mut node = self.node(cid);
            while let Some(n) = node {
                if n.id == scope || n.kind == NodeType::Page {
                    break;
                }
                chain.push(n.id.as_str());
                node = n.parent_id.as_deref().and_then(|p| self.node(p));
            }
            if node.is_none_or(|n| n.id != scope) || chain.is_empty() {
                continue;
            }
            chain.reverse();
            let mut unit: Option<&'a str> = None;
            let mut on_canvas = canvas;
            for &id in &chain {
                let Some(each) = self.node(id) else { break };
                let is_covered = match covered.get(id) {
                    Some(&c) => c,
                    None => {
                        let b = transform_rect(
                            &world(id),
                            &Rect::new(0.0, 0.0, each.width, each.height),
                        );
                        let c = rect_contains(rect, &b);
                        covered.insert(each.id.as_str(), c);
                        c
                    }
                };
                if !on_canvas || !opens_on_canvas(each) || is_covered {
                    unit = Some(each.id.as_str());
                    break;
                }
                // A frame the marquee does not touch hides its children from it, even ones sticking out.
                if !box_intersects_rect(&world(id), each.width, each.height, rect) {
                    break;
                }
                on_canvas = each.kind == NodeType::Section;
            }
            if let Some(u) = unit {
                if unit_set.insert(u) {
                    units.push(u);
                }
            }
        }
        let mut out: Vec<&'a str> = Vec::new();
        for id in units {
            let mut usable = true;
            let mut area: Option<Rect> = Some(*rect);
            let mut node = self.node(id);
            while let Some(n) = node {
                if n.id == scope {
                    break;
                }
                if !n.visible || n.locked {
                    usable = false;
                    break;
                }
                let parent = n.parent_id.as_deref().and_then(|p| self.node(p));
                if let Some(p) = parent {
                    if is_frame_like(p) && clips(p) {
                        let b =
                            transform_rect(&world(&p.id), &Rect::new(0.0, 0.0, p.width, p.height));
                        area = area.and_then(|a| intersection(&a, &b));
                    }
                }
                node = parent;
            }
            let Some(area) = area.filter(|_| usable) else {
                continue;
            };
            let Some(node) = self.node(id) else { continue };
            if box_intersects_rect(&world(id), node.width, node.height, &area) {
                out.push(id);
            }
        }
        // sortByPaintOrder: back to front.
        let mut keyed: Vec<(&'a str, Vec<i64>)> = out
            .into_iter()
            .map(|id| (id, self.paint_path(id)))
            .collect();
        keyed.sort_by(|a, b| compare_paint_paths(&a.1, &b.1).cmp(&0));
        keyed.into_iter().map(|(id, _)| id).collect()
    }
}

fn paint_index(parent: Option<&SceneNode>, id: &str) -> i64 {
    let Some(parent) = parent else { return -1 };
    let Some(children) = &parent.children else {
        return -1;
    };
    let Some(index) = children.iter().position(|c| c == id) else {
        return -1;
    };
    if paints_reversed(parent) {
        (children.len() - 1 - index) as i64
    } else {
        index as i64
    }
}

/// Negative when `a` is painted before (below) `b`. An ancestor is painted before its descendants.
fn compare_paint_paths(a: &[i64], b: &[i64]) -> i64 {
    for (x, y) in a.iter().zip(b) {
        if x != y {
            return x - y;
        }
    }
    a.len() as i64 - b.len() as i64
}

fn opens_on_canvas(node: &SceneNode) -> bool {
    node.kind == NodeType::Section || (is_frame_like(node) && node.kind != NodeType::Instance)
}

fn intersection(a: &Rect, b: &Rect) -> Option<Rect> {
    let x = js::max(a.x, b.x);
    let y = js::max(a.y, b.y);
    let right = js::min(a.x + a.width, b.x + b.width);
    let bottom = js::min(a.y + a.height, b.y + b.height);
    if right < x || bottom < y {
        None
    } else {
        Some(Rect::new(x, y, right - x, bottom - y))
    }
}

/// Separating-axis test between a node's rotated box and an axis-aligned rectangle (page space).
pub fn box_intersects_rect(m: &Matrix, width: f64, height: f64, rect: &Rect) -> bool {
    let points = [
        apply(m, v(0.0, 0.0)),
        apply(m, v(width, 0.0)),
        apply(m, v(width, height)),
        apply(m, v(0.0, height)),
    ];
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (
        f64::INFINITY,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NEG_INFINITY,
    );
    for p in &points {
        min_x = js::min(min_x, p.x);
        max_x = js::max(max_x, p.x);
        min_y = js::min(min_y, p.y);
        max_y = js::max(max_y, p.y);
    }
    if max_x < rect.x
        || min_x > rect.x + rect.width
        || max_y < rect.y
        || min_y > rect.y + rect.height
    {
        return false;
    }
    let corners = [
        v(rect.x, rect.y),
        v(rect.x + rect.width, rect.y),
        v(rect.x + rect.width, rect.y + rect.height),
        v(rect.x, rect.y + rect.height),
    ];
    for axis in [apply_linear(m, v(1.0, 0.0)), apply_linear(m, v(0.0, 1.0))] {
        if axis.x == 0.0 && axis.y == 0.0 {
            continue;
        }
        let (mut a0, mut a1, mut b0, mut b1) = (
            f64::INFINITY,
            f64::NEG_INFINITY,
            f64::INFINITY,
            f64::NEG_INFINITY,
        );
        for p in &points {
            let d = p.x * axis.x + p.y * axis.y;
            a0 = js::min(a0, d);
            a1 = js::max(a1, d);
        }
        for p in &corners {
            let d = p.x * axis.x + p.y * axis.y;
            b0 = js::min(b0, d);
            b1 = js::max(b1, d);
        }
        if a1 < b0 || b1 < a0 {
            return false;
        }
    }
    true
}

/// Per call: world matrices and whether a node's ancestors let a click at this point through, by node index.
struct ChainCache<'s, 'a> {
    scene: &'s HitScene<'a>,
    tables: &'s Tables,
    page: u32,
    point: Vec2,
    worlds: hashbrown::HashMap<u32, Matrix>,
    open: hashbrown::HashMap<u32, bool>,
}

impl<'s, 'a> ChainCache<'s, 'a> {
    fn node(&self, i: u32) -> &'a SceneNode {
        &self.scene.doc.nodes[i as usize]
    }

    fn world(&mut self, i: u32) -> Matrix {
        if let Some(m) = self.worlds.get(&i) {
            return *m;
        }
        let n = self.node(i);
        let m = if n.kind == NodeType::Page || n.parent_id.is_none() {
            IDENTITY
        } else {
            // A missing parent maps to the identity, as `world(missing)` does in the TS.
            let p = self.tables.parent[i as usize];
            let pw = if p == NONE { IDENTITY } else { self.world(p) };
            multiply(&pw, &node_matrix(n))
        };
        self.worlds.insert(i, m);
        m
    }

    /// The node itself is visible, unlocked and not clipped away at the point, and so is every ancestor.
    fn allows(&mut self, i: u32) -> bool {
        if let Some(&ok) = self.open.get(&i) {
            return ok;
        }
        let n = self.node(i);
        let p = self.tables.parent[i as usize];
        let ok = if n.kind == NodeType::Page {
            i == self.page
        } else if !n.visible || n.locked || n.is_mask || n.parent_id.is_none() || p == NONE {
            false
        } else {
            self.allows(p) && self.parent_lets(i, p)
        };
        self.open.insert(i, ok);
        ok
    }

    fn parent_lets(&mut self, i: u32, p: u32) -> bool {
        let parent = self.node(p);
        if is_frame_like(parent) && clips(parent) {
            let local = apply(&invert(&self.world(p)), self.point);
            if !in_box(parent, local, 0.0) {
                return false;
            }
        }
        let mask = self.tables.clip_mask[i as usize];
        if mask == NONE {
            return true;
        }
        let m = self.world(mask);
        self.scene.shape_contains(self.node(mask), &m, self.point)
    }
}

/// The uniform grid of spatial-index.ts over the bounds it stores (`SpatialIndex.compute`): what each node
/// paints, a container's subtree, at every depth. The candidates of a query are then exactly the TS
/// index's (text overflowing its box aside: text layout is L3's, here a text paints its box).
pub struct HitIndex {
    page: String,
    grid: Grid,
}

impl HitIndex {
    fn build(scene: &HitScene<'_>, page_id: &str) -> HitIndex {
        let mut grid = Grid::default();
        if let Some(page) = scene.doc.nodes.get(page_id) {
            for id in page.children.as_deref().unwrap_or_default() {
                if let Some(child) = scene.doc.nodes.get(id) {
                    Self::visit(scene, child, &IDENTITY, &mut grid);
                }
            }
        }
        HitIndex {
            page: page_id.to_owned(),
            grid,
        }
    }

    /// Children first, then the node from their entries (`rebuild`'s `visit` and `compute`).
    fn visit(
        scene: &HitScene<'_>,
        node: &SceneNode,
        parent_world: &Matrix,
        grid: &mut Grid,
    ) -> Option<Rect> {
        let doc = scene.doc;
        let world = multiply(parent_world, &node_matrix(node));
        let mut child_rects: Vec<Option<Rect>> = Vec::new();
        for id in node.children.as_deref().unwrap_or_default() {
            if let Some(child) = doc.nodes.get(id) {
                let r = Self::visit(scene, child, &world, grid);
                if child.visible {
                    child_rects.push(r);
                }
            }
        }
        let container = node.kind.is_container() && node.kind != NodeType::BooleanOperation;
        let rect = if node.kind == NodeType::Slice {
            None
        } else if !container || bounds::clips_children(node) {
            let plain = node.kind != NodeType::Text
                && node.effects.is_empty()
                && !(node.stroke_weight > 0.0 && !node.strokes.is_empty());
            Some(if plain {
                box_bounds(&world, node.width, node.height)
            } else {
                let text = match &scene.caches.text {
                    Some(layouter) => match layouter.borrow_mut().bounds(node) {
                        TextBounds::Lines(rect) => Some(rect),
                        TextBounds::None => None,
                        TextBounds::Unsupported => {
                            scene.caches.unsupported.set(true);
                            None
                        }
                    },
                    None => None,
                };
                transform_rect(&world, &bounds::local_render_bounds_with(node, text))
            })
        } else {
            let own = (node.kind != NodeType::Group).then(|| {
                let out = bounds::stroke_outsets(node);
                transform_rect(
                    &world,
                    &Rect::new(
                        -out.left,
                        -out.top,
                        js::max(0.0, node.width) + out.left + out.right,
                        js::max(0.0, node.height) + out.top + out.bottom,
                    ),
                )
            });
            let (mut min_x, mut min_y) = own.map_or((f64::INFINITY, f64::INFINITY), |r| (r.x, r.y));
            let (mut max_x, mut max_y) = own.map_or((f64::NEG_INFINITY, f64::NEG_INFINITY), |r| {
                (r.x + r.width, r.y + r.height)
            });
            for r in child_rects.into_iter().flatten() {
                if r.x < min_x {
                    min_x = r.x;
                }
                if r.y < min_y {
                    min_y = r.y;
                }
                if r.x + r.width > max_x {
                    max_x = r.x + r.width;
                }
                if r.y + r.height > max_y {
                    max_y = r.y + r.height;
                }
            }
            let rect =
                (min_x <= max_x).then(|| Rect::new(min_x, min_y, max_x - min_x, max_y - min_y));
            match rect {
                Some(r) if !node.effects.is_empty() => {
                    Some(bounds::expand_world_by_effects(r, node, &world))
                }
                other => other,
            }
        };
        if let Some((index, _, _)) = doc.nodes.get_full(&node.id) {
            grid.store(index as u32, rect);
        }
        rect
    }

    fn query(&self, rect: &Rect) -> Vec<usize> {
        self.grid
            .query(rect)
            .into_iter()
            .map(|i| i as usize)
            .collect()
    }
}
