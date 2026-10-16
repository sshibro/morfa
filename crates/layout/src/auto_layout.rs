//! Auto layout (`shared/design/layout.ts`) on store nodes, statement for statement (ported from lane L2b's SceneNode stage).
//! The memo keys, the order of every float operation and the order of the writes are the TypeScript's, so the draft
//! ends with the same entries, bit for bit.

use std::rc::Rc;
use std::sync::Arc;

use indexmap::IndexSet;
use morfa_model::draft::same_f64;
use morfa_model::store::draft::{SlotSet, Working};
use morfa_model::store::fields::{Field as StoreField, changed_mask};
use morfa_model::store::{Id, Node, PropKey};
use morfa_model::types::{
    AutoLayout, CounterAxisAlignContent, CounterAxisAlignItems, LayoutMode, LayoutPositioning,
    LayoutSizing, LayoutWrap, NodeType, PrimaryAxisAlignItems, StrokeAlign, TextAutoResize,
};
use rustc_hash::{FxBuildHasher, FxHashMap};

use crate::constraints::{LAYOUT_EPSILON, ResizeMode, Size, is_turned};
use crate::constraints::{ResizeHooks, constrained_box, resize_node};
use crate::geom::{self, Rect};
use crate::math;
use crate::text::{TextMeasure, TextNode, round_up};
use crate::{is_auto_layout, parent_flow, placement, set_text_auto_resize};

/// Grid auto layout: the GRID half of `container` and its pure helpers.
pub mod grid;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SizingAxis {
    Horizontal,
    Vertical,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TextSizing {
    pub text_auto_resize: TextAutoResize,
    pub horizontal: LayoutSizing,
    pub vertical: LayoutSizing,
}

/// A frame's measured size and its children's boxes, by index in its `children`.
#[derive(Debug)]
pub struct ContainerLayout {
    pub width: f64,
    pub height: f64,
    pub boxes: Vec<Option<Rect>>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayoutStats {
    pub measured: u64,
    pub arranged: u64,
    pub text_measured: u64,
}

/// 0: x, width, horizontal; 1: y, height, vertical.
type Axis = usize;
type Pair = [f64; 2];
type Sides = [Pair; 2];

const NO_SIDES: Sides = [[0.0, 0.0], [0.0, 0.0]];

#[inline]
fn size_on(width: f64, height: f64, axis: Axis) -> f64 {
    if axis == 1 { height } else { width }
}

/// `values.reduce((total, value) => total + value, 0)`.
#[inline]
fn sum(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(0.0, |total, value| total + value)
}

// ── Sizing rules ─────────────────────────────────────────────────────────────────────────────────

/// HUG is offered for auto-layout frames and text only.
pub fn can_hug(node: &Node) -> bool {
    node.kind == NodeType::Text || is_auto_layout(Some(node))
}

/// FILL is offered for flow children of an auto-layout frame (`parent_flow`: the parent is one).
pub fn can_fill(node: &Node, parent_flow: bool, axis: Option<SizingAxis>) -> bool {
    if !parent_flow
        || node.layout_positioning == LayoutPositioning::Absolute
        || is_turned(node.rotation)
    {
        return false;
    }
    !(node.kind == NodeType::Line && axis == Some(SizingAxis::Vertical))
}

/// A text's resize mode and sizing once its FILL choice is taken into account.
pub fn text_sizing(node: &Node, parent_flow: bool) -> TextSizing {
    let mut mode = node
        .props
        .text()
        .map_or(TextAutoResize::None, |text| text.text_auto_resize);
    let fill_h = node.layout_sizing_horizontal == LayoutSizing::Fill
        && can_fill(node, parent_flow, Some(SizingAxis::Horizontal));
    let fill_v = node.layout_sizing_vertical == LayoutSizing::Fill
        && can_fill(node, parent_flow, Some(SizingAxis::Vertical));
    if fill_v
        && matches!(
            mode,
            TextAutoResize::WidthAndHeight | TextAutoResize::Height
        )
    {
        mode = TextAutoResize::None;
    }
    if fill_h && mode == TextAutoResize::WidthAndHeight {
        mode = TextAutoResize::Height;
    }
    TextSizing {
        text_auto_resize: mode,
        horizontal: if fill_h {
            LayoutSizing::Fill
        } else if mode == TextAutoResize::WidthAndHeight {
            LayoutSizing::Hug
        } else {
            LayoutSizing::Fixed
        },
        vertical: if fill_v {
            LayoutSizing::Fill
        } else if matches!(
            mode,
            TextAutoResize::WidthAndHeight | TextAutoResize::Height
        ) {
            LayoutSizing::Hug
        } else {
            LayoutSizing::Fixed
        },
    }
}

/// The sizing layout applies to the node on `axis`.
pub fn effective_sizing(node: &Node, parent_flow: bool, axis: SizingAxis) -> LayoutSizing {
    if node.kind == NodeType::Text {
        let sizing = text_sizing(node, parent_flow);
        return match axis {
            SizingAxis::Horizontal => sizing.horizontal,
            SizingAxis::Vertical => sizing.vertical,
        };
    }
    let sizing = match axis {
        SizingAxis::Horizontal => node.layout_sizing_horizontal,
        SizingAxis::Vertical => node.layout_sizing_vertical,
    };
    match sizing {
        LayoutSizing::Fill if can_fill(node, parent_flow, Some(axis)) => LayoutSizing::Fill,
        LayoutSizing::Hug if can_hug(node) => LayoutSizing::Hug,
        _ => LayoutSizing::Fixed,
    }
}

#[inline]
fn axis_name(axis: Axis) -> SizingAxis {
    if axis == 1 {
        SizingAxis::Vertical
    } else {
        SizingAxis::Horizontal
    }
}

/// `sizingFixes`: the fields that make the node's stored sizing match `effective_sizing`.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SizingFixes {
    pub text_auto_resize: Option<TextAutoResize>,
    pub horizontal: Option<LayoutSizing>,
    pub vertical: Option<LayoutSizing>,
}

impl SizingFixes {
    pub fn is_empty(&self) -> bool {
        self.text_auto_resize.is_none() && self.horizontal.is_none() && self.vertical.is_none()
    }

    pub fn apply(&self, node: &mut Node) {
        if let Some(mode) = self.text_auto_resize {
            set_text_auto_resize(node, mode);
        }
        if let Some(sizing) = self.horizontal {
            node.layout_sizing_horizontal = sizing;
        }
        if let Some(sizing) = self.vertical {
            node.layout_sizing_vertical = sizing;
        }
    }
}

pub fn sizing_fixes(node: &Node, parent_flow: bool) -> Option<SizingFixes> {
    let mut fixes = SizingFixes::default();
    let (horizontal, vertical);
    if node.kind == NodeType::Text
        && let Some(text) = node.props.text()
    {
        let sizing = text_sizing(node, parent_flow);
        if sizing.text_auto_resize != text.text_auto_resize {
            fixes.text_auto_resize = Some(sizing.text_auto_resize);
        }
        (horizontal, vertical) = (sizing.horizontal, sizing.vertical);
    } else {
        horizontal = effective_sizing(node, parent_flow, SizingAxis::Horizontal);
        vertical = effective_sizing(node, parent_flow, SizingAxis::Vertical);
    }
    if horizontal != node.layout_sizing_horizontal {
        fixes.horizontal = Some(horizontal);
    }
    if vertical != node.layout_sizing_vertical {
        fixes.vertical = Some(vertical);
    }
    (!fixes.is_empty()).then_some(fixes)
}

/// The frame a node was reached through (listed in its children) and whether it is an auto-layout frame: what
/// [`parent_flow`] would look up.
#[derive(Clone, Copy)]
pub struct Under {
    pub id: Id,
    pub flow: bool,
}

impl Under {
    #[inline]
    pub fn of(parent: &Node) -> Self {
        Self {
            id: parent.id,
            flow: is_auto_layout(Some(parent)),
        }
    }
}

/// [`parent_flow`], knowing the frame the node was reached through: when the node's `parentId` names it (always, in
/// a valid document), no lookup.
#[inline]
fn flow_under(draft: &Working, node: &Node, under: Option<Under>) -> bool {
    match under {
        Some(under) if node.parent == Some(under.id) => under.flow,
        _ => parent_flow(draft, node),
    }
}

/// `layoutSizingUpdates`: the panel's "Fixed / Hug / Fill" on one axis, in `draft`.
pub fn set_layout_sizing(draft: &mut Working, id: Id, axis: SizingAxis, sizing: LayoutSizing) {
    let Some(node) = draft.node(id) else {
        return;
    };
    let flow = parent_flow(draft, node);
    if (sizing == LayoutSizing::Hug && !can_hug(node))
        || (sizing == LayoutSizing::Fill && !can_fill(node, flow, Some(axis)))
    {
        return;
    }
    let mut next = node.clone();
    match axis {
        SizingAxis::Horizontal => next.layout_sizing_horizontal = sizing,
        SizingAxis::Vertical => next.layout_sizing_vertical = sizing,
    }
    if node.kind == NodeType::Text
        && let Some(text) = node.props.text()
    {
        let mut mode = text.text_auto_resize;
        if axis == SizingAxis::Horizontal {
            if sizing == LayoutSizing::Hug {
                mode = TextAutoResize::WidthAndHeight;
                if node.layout_sizing_vertical == LayoutSizing::Fill {
                    next.layout_sizing_vertical = LayoutSizing::Hug;
                }
            } else if mode == TextAutoResize::WidthAndHeight {
                mode = TextAutoResize::Height;
            }
        } else if sizing == LayoutSizing::Hug {
            if mode != TextAutoResize::WidthAndHeight {
                mode = TextAutoResize::Height;
            }
        } else {
            if mode == TextAutoResize::WidthAndHeight
                && node.layout_sizing_horizontal != LayoutSizing::Fill
            {
                next.layout_sizing_horizontal = LayoutSizing::Fixed;
            }
            if matches!(
                mode,
                TextAutoResize::WidthAndHeight | TextAutoResize::Height
            ) {
                mode = TextAutoResize::None;
            }
        }
        set_text_auto_resize(&mut next, mode);
        if let Some(fixes) = sizing_fixes(&next, flow) {
            fixes.apply(&mut next);
        }
    }
    let parent_id = node.parent;
    draft.update(id, |node| *node = next);
    if sizing != LayoutSizing::Fill {
        return;
    }
    let Some(parent) = parent_id.and_then(|id| draft.node(id)) else {
        return;
    };
    let Some(layout) = parent.props.auto_layout() else {
        return;
    };
    if layout.layout_mode == LayoutMode::Grid {
        return;
    }
    let main = if layout.layout_mode == LayoutMode::Horizontal {
        SizingAxis::Horizontal
    } else {
        SizingAxis::Vertical
    };
    if axis == main
        && effective_sizing(parent, parent_flow(draft, parent), axis) == LayoutSizing::Hug
    {
        let parent_id = parent.id;
        draft.update(parent_id, |parent| match axis {
            SizingAxis::Horizontal => parent.layout_sizing_horizontal = LayoutSizing::Fixed,
            SizingAxis::Vertical => parent.layout_sizing_vertical = LayoutSizing::Fixed,
        });
    }
}

// ── Measuring helpers ────────────────────────────────────────────────────────────────────────────

#[derive(Clone, Copy, Debug)]
struct Limits {
    min: Pair,
    max: Pair,
}

fn limits_of(node: &Node) -> Limits {
    let props = &node.props;
    let min = [
        math::max(0.0, props.min_width().copied().flatten().unwrap_or(0.0)),
        math::max(0.0, props.min_height().copied().flatten().unwrap_or(0.0)),
    ];
    // A maximum below the minimum loses, as in CSS.
    let max = [
        math::max(
            min[0],
            props
                .max_width()
                .copied()
                .flatten()
                .unwrap_or(f64::INFINITY),
        ),
        math::max(
            min[1],
            props
                .max_height()
                .copied()
                .flatten()
                .unwrap_or(f64::INFINITY),
        ),
    ];
    Limits { min, max }
}

#[inline]
fn clamp_to(value: f64, limits: &Limits, axis: Axis) -> f64 {
    math::min(limits.max[axis], math::max(limits.min[axis], value))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Part {
    Inside,
    Outside,
}

/// Stroke widths on each side of the box that lie inside it or stick out of it.
fn stroke_sides(node: &Node, part: Part) -> Sides {
    if !node.strokes.iter().any(|paint| paint.visible()) {
        return NO_SIDES;
    }
    let share = if node.stroke_align == StrokeAlign::Center {
        0.5
    } else if (node.stroke_align == StrokeAlign::Inside) == (part == Part::Inside) {
        1.0
    } else {
        0.0
    };
    if share == 0.0 {
        return NO_SIDES;
    }
    let (top, right, bottom, left) = match node
        .props
        .individual_stroke_weights()
        .and_then(|weights| weights.as_deref())
    {
        Some(w) => (w.top, w.right, w.bottom, w.left),
        None => (
            node.stroke_weight,
            node.stroke_weight,
            node.stroke_weight,
            node.stroke_weight,
        ),
    };
    [[left * share, right * share], [top * share, bottom * share]]
}

/// Padding, plus the frame's own inside stroke when strokes are included in layout.
fn padding_of(node: &Node, layout: &AutoLayout) -> Sides {
    let inset = if layout.strokes_included_in_layout {
        stroke_sides(node, Part::Inside)
    } else {
        NO_SIDES
    };
    [
        [
            layout.padding_left + inset[0][0],
            layout.padding_right + inset[0][1],
        ],
        [
            layout.padding_top + inset[1][0],
            layout.padding_bottom + inset[1][1],
        ],
    ]
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Align {
    Start,
    Center,
    End,
}

#[inline]
fn align_offset(align: Align, free: f64) -> f64 {
    match align {
        Align::Center => free / 2.0,
        Align::End => free,
        Align::Start => 0.0,
    }
}

fn primary_align(value: PrimaryAxisAlignItems) -> Align {
    match value {
        PrimaryAxisAlignItems::Center => Align::Center,
        PrimaryAxisAlignItems::Max => Align::End,
        _ => Align::Start,
    }
}

fn counter_align(value: CounterAxisAlignItems) -> Align {
    match value {
        CounterAxisAlignItems::Center => Align::Center,
        CounterAxisAlignItems::Max => Align::End,
        _ => Align::Start,
    }
}

/// FILL children on one line: each gets its basis plus an equal share of `free`, clamped by its limits; what a
/// clamped child cannot take is shared by the rest (CSS flexbox's freezing loop).
fn distribute(
    items: &[(f64, Limits)],
    axis: Axis,
    free: f64,
    sizes: &mut Vec<f64>,
    scratch: &mut Scratch,
) {
    sizes.clear();
    sizes.extend(items.iter().map(|item| item.0));
    let mut frozen = scratch.flags.pop().unwrap_or_default();
    frozen.clear();
    frozen.resize(items.len(), false);
    let mut remaining = free;
    let mut open = scratch.indexes.pop().unwrap_or_default();
    for _ in 0..=items.len() {
        open.clear();
        open.extend((0..items.len()).filter(|&i| !frozen[i]));
        if open.is_empty() {
            break;
        }
        let share = remaining / open.len() as f64;
        let mut violation = 0.0;
        for &i in &open {
            let target = items[i].0 + share;
            sizes[i] = clamp_to(target, &items[i].1, axis);
            violation += sizes[i] - target;
        }
        if violation.abs() <= LAYOUT_EPSILON {
            break;
        }
        for &i in &open {
            let target = items[i].0 + share;
            let clamped = if violation > 0.0 {
                sizes[i] > target + LAYOUT_EPSILON
            } else {
                sizes[i] < target - LAYOUT_EPSILON
            };
            if clamped {
                frozen[i] = true;
                remaining -= sizes[i] - items[i].0;
            }
        }
    }
    scratch.flags.push(frozen);
    scratch.give_indexes(open);
}

/// Lists a container's layout borrows while it works and gives back: containers nest (measuring a child lays its
/// children out), so each takes its own from the pool.
#[derive(Default)]
struct Scratch {
    numbers: Vec<Vec<f64>>,
    indexes: Vec<Vec<usize>>,
    ranges: Vec<Vec<(usize, usize)>>,
    shares: Vec<Vec<(f64, Limits)>>,
    flags: Vec<Vec<bool>>,
}

impl Scratch {
    fn give_numbers(&mut self, mut list: Vec<f64>) {
        list.clear();
        self.numbers.push(list);
    }

    fn give_indexes(&mut self, mut list: Vec<usize>) {
        list.clear();
        self.indexes.push(list);
    }
}

// ── The layout memo ──────────────────────────────────────────────────────────────────────────────

/// The fields the layout never reads (lane N1 step 9): a node that differs from the one the memo saw only in these
/// lays out the same (a compile-time mask). Everything else counts (conservatively: `effects` and `isMask` are not read either, but stay
/// in). What the layout reads: the box, rotation and flips, visibility, kind, parent and children, sizing and
/// positioning, constraints, min/max sizes, `autoLayout`, strokes (visible ones count in the flow: their weight,
/// align and individual weights), `text` and `textPath` (measuring), `vectorPaths` (scaled on a resize).
const LAYOUT_IGNORES: u128 = {
    use PropKey::*;
    let fields = [
        StoreField::Name,
        StoreField::Locked,
        StoreField::Opacity,
        StoreField::BlendMode,
        StoreField::Fills,
        StoreField::StrokeCap,
        StoreField::StrokeJoin,
        StoreField::StrokeMiterLimit,
    ];
    let props = [
        MaskType,
        ConstrainProportions,
        DashPattern,
        FillStyleId,
        StrokeStyleId,
        EffectStyleId,
        BoundVariables,
        ExportSettings,
        Reactions,
        CornerRadius,
        RectangleCornerRadii,
        CornerSmoothing,
        ClipsContent,
        LayoutGrids,
        GridStyleId,
        OverflowDirection,
        OverlayPositionType,
        OverlayBackground,
        OverlayBackgroundInteraction,
        ScrollBehavior,
        BackgroundColor,
        Guides,
        FlowStartingPoints,
        PrototypeDevice,
        PrototypeBackground,
        ArcData,
        PointCount,
        InnerRadius,
        StrokeStartMarker,
        StrokeEndMarker,
        VariableWidthStrokeProperties,
        BooleanOperation,
        TextStyleId,
        Annotations,
        Measurements,
        Description,
        ComponentPropertyDefinitions,
        ComponentPropertyReferences,
        ComponentId,
        ComponentProperties,
        IsExposedInstance,
        MainId,
        Overrides,
        PluginData,
        Remote,
        Board,
    ];
    let mut mask = 0u128;
    let mut index = 0;
    while index < fields.len() {
        mask |= 1u128 << fields[index].bit();
        index += 1;
    }
    let mut index = 0;
    while index < props.len() {
        mask |= 1u128 << StoreField::Prop(props[index]).bit();
        index += 1;
    }
    mask
};

/// One root's subtree as `layout_root` last read it and found nothing to write for: the shared nodes in depth-first
/// order, each with whether it lay on a dirty path (its stored size not trusted), and whether the root's parent is an
/// auto-layout frame. Layout is a function of exactly these (and the text measurer, whose change clears the memo):
/// the same again means the same result, nothing to write, and the root is skipped.
struct RootSnapshot {
    parent_flow: bool,
    nodes: Vec<(Arc<Node>, bool)>,
}

/// The roots a long-lived pipeline's layout stage laid out and found settled (lane N1 step 9: a component edit that
/// changes a fill rebuilds a thousand copies, each a dirty id whose frame would be laid out again for nothing). A
/// node compares as itself (the same `Arc`, the usual case as the shadow shares the nodes the pipeline wrote) or by
/// the fields that changed, ignoring [`LAYOUT_IGNORES`].
#[derive(Default)]
pub struct LayoutMemo {
    roots: FxHashMap<Id, RootSnapshot>,
}

/// The most nodes a snapshot holds: a larger subtree is laid out (checking it would cost about what a trusted layout
/// of a small change in it does).
const MEMO_MAX_NODES: usize = 256;
/// The most roots the memo holds; full, it starts over.
const MEMO_MAX_ROOTS: usize = 8192;

impl LayoutMemo {
    /// Forgets everything (the document was replaced, or the text measurer changed).
    pub fn clear(&mut self) {
        self.roots.clear();
    }

    pub fn len(&self) -> usize {
        self.roots.len()
    }

    pub fn is_empty(&self) -> bool {
        self.roots.is_empty()
    }

    /// Whether `root`'s subtree is as the memo last saw it, on the same dirty paths, under the same flow.
    fn settled(
        &self,
        draft: &Working,
        root: Id,
        parent_flow: bool,
        on_path: &dyn Fn(Id) -> bool,
    ) -> bool {
        let Some(snapshot) = self.roots.get(&root) else {
            return false;
        };
        if snapshot.parent_flow != parent_flow {
            return false;
        }
        let ignores = LAYOUT_IGNORES;
        let mut stack: Vec<Id> = vec![root];
        let mut at = 0;
        while let Some(id) = stack.pop() {
            let Some((was, was_on_path)) = snapshot.nodes.get(at) else {
                return false;
            };
            at += 1;
            let Some(now) = draft.arc(id) else {
                return false;
            };
            if was.id != id || on_path(id) != *was_on_path {
                return false;
            }
            if !Arc::ptr_eq(was, now) && changed_mask(now, was) & !ignores != 0 {
                return false;
            }
            stack.extend(now.children().iter().rev());
        }
        at == snapshot.nodes.len()
    }

    /// Records `root`'s subtree after a layout that wrote nothing (not past [`MEMO_MAX_NODES`] nodes).
    fn record(
        &mut self,
        draft: &Working,
        root: Id,
        parent_flow: bool,
        on_path: &dyn Fn(Id) -> bool,
    ) {
        let mut nodes: Vec<(Arc<Node>, bool)> = Vec::new();
        let mut stack: Vec<Id> = vec![root];
        while let Some(id) = stack.pop() {
            let Some(node) = draft.arc(id) else {
                return;
            };
            if nodes.len() >= MEMO_MAX_NODES {
                return;
            }
            nodes.push((Arc::clone(node), on_path(id)));
            stack.extend(node.children().iter().rev());
        }
        if self.roots.len() >= MEMO_MAX_ROOTS {
            self.roots.clear();
        }
        self.roots.insert(root, RootSnapshot { parent_flow, nodes });
    }
}

// ── The engine ───────────────────────────────────────────────────────────────────────────────────

struct Item<'d> {
    node: &'d Node,
    /// The child's index in the frame's `children`.
    index: usize,
    sizing: [LayoutSizing; 2],
    limits: Limits,
    /// Stroke that counts in the flow, before and after the box on each axis.
    out: Sides,
    /// Turned children are sized up front and take their rotated bounds in the flow.
    turned: bool,
    bounds: Option<Rect>,
    size: Pair,
    /// FILL on the main axis: what the free space is added to.
    basis: f64,
    /// Top-left of the footprint (box plus counted stroke) in the frame.
    pos: Pair,
    /// BASELINE: from the footprint's top to the first baseline.
    ascent: f64,
}

/// Each child's box in the frame (`boxesOf`): the node's origin sits where its rotated or flipped box puts its footprint
/// at `pos`; `len` is the frame's children count (a box per child index, absent for children not in the flow).
fn boxes_of(items: &[Item], len: usize) -> Vec<Option<Rect>> {
    let mut boxes = vec![None; len];
    for item in items {
        let [width, height] = item.size;
        let child = item.node;
        let zero = if geom::turn(child.rotation) != 0.0 {
            let placement = placement(child).with_box(0.0, 0.0, width, height);
            let rect = geom::transform_rect(
                &geom::local_matrix(&placement),
                Rect::new(0.0, 0.0, width, height),
            );
            (rect.x, rect.y)
        } else {
            (0.0, 0.0)
        };
        boxes[item.index] = Some(Rect::new(
            item.pos[0] + item.out[0][0] - zero.0,
            item.pos[1] + item.out[1][0] - zero.1,
            width,
            height,
        ));
    }
    boxes
}

fn footprint(item: &Item, axis: Axis) -> f64 {
    if let Some(bounds) = item.bounds {
        return size_on(bounds.width, bounds.height, axis) + item.out[axis][0] + item.out[axis][1];
    }
    item.size[axis] + item.out[axis][0] + item.out[axis][1]
}

/// Breaks the items into lines (`breakLines`): `lines` gets each line's (first, end) range.
fn break_lines(items: &[Item], axis: Axis, inner: f64, gap: f64, lines: &mut Vec<(usize, usize)>) {
    lines.clear();
    let mut first = 0;
    let mut used = 0.0;
    for (i, item) in items.iter().enumerate() {
        let extent = footprint(item, axis);
        if i > first && used + gap + extent > inner + LAYOUT_EPSILON {
            lines.push((first, i));
            first = i;
            used = 0.0;
        }
        used += (if i > first { gap } else { 0.0 }) + extent;
    }
    lines.push((first, items.len()));
}

/// A forced size as the TypeScript's memo key spells it (`${forced ?? ''}`): -0 is 0.
#[inline]
fn key(value: Option<f64>) -> Option<u64> {
    value.map(|v| if v == 0.0 { 0 } else { v.to_bits() })
}

/// A memoised container layout: the forced width and height it was asked at (memo keys), and the layout.
type Memo = (Option<u64>, Option<u64>, Rc<ContainerLayout>);

/// A short list whose first entry needs no allocation (a node is mostly measured at one size).
struct Few<T> {
    first: Option<T>,
    rest: Vec<T>,
}

impl<T> Default for Few<T> {
    fn default() -> Self {
        Self {
            first: None,
            rest: Vec::new(),
        }
    }
}

impl<T> Few<T> {
    fn push(&mut self, value: T) {
        if self.first.is_none() {
            self.first = Some(value);
        } else {
            self.rest.push(value);
        }
    }

    fn iter(&self) -> impl Iterator<Item = &T> {
        self.first.iter().chain(self.rest.iter())
    }
}

/// What the engine knows of one node.
#[derive(Default)]
struct Slot {
    /// Container layouts per forced size (`${id}|${width}|${height}` in the TypeScript).
    memo: Few<Memo>,
    /// Text sizes per width.
    text: Few<(Option<u64>, Size)>,
    arranged: bool,
    /// On a changed path: its stored size is not trusted.
    path: bool,
}

/// Lays out auto-layout frames in a draft (`LayoutEngine`). `run(dirty)` finds, for each changed node, the outermost
/// frame whose layout it can affect (up through hugging frames) and lays out those chains; frames resized on the way
/// follow.
pub struct LayoutEngine<'m> {
    slots: hashbrown::HashMap<Id, Slot, FxBuildHasher>,
    pending: IndexSet<Id>,
    /// Trust the stored size of nodes off the changed paths (`trusted: id => !path.has(id)`); false: trust nothing
    /// (`layoutFrame`).
    trust_off_paths: bool,
    /// The dirty ids whose paths are not marked yet.
    paths_from: Option<&'m SlotSet>,
    /// Id lists `arrange` reuses (its children, held while it writes): no allocation once warm.
    ids: Vec<Vec<Id>>,
    scratch: Scratch,
    pub stats: LayoutStats,
    text: TextMeasure<'m>,
}

impl<'m> LayoutEngine<'m> {
    /// An engine that trusts nothing (every size measured afresh).
    pub fn new(text: TextMeasure<'m>) -> Self {
        Self {
            slots: hashbrown::HashMap::default(),
            ids: Vec::new(),
            scratch: Scratch::default(),
            pending: IndexSet::new(),
            trust_off_paths: false,
            paths_from: None,
            stats: LayoutStats::default(),
            text,
        }
    }

    /// An engine that trusts every node off the paths from `dirty` up to their roots (normalize.ts's `ancestry`: the
    /// dirty ids, removed ones included, and all their ancestors). The paths are marked when a size is first asked
    /// whether it can be trusted.
    pub fn trusting_off_paths(text: TextMeasure<'m>, dirty: &'m SlotSet) -> Self {
        let mut engine = Self::new(text);
        engine.trust_off_paths = true;
        engine.paths_from = Some(dirty);
        engine
    }

    fn mark_paths(&mut self, draft: &Working, dirty: &SlotSet) {
        for id in dirty {
            if !draft.contains(id) {
                self.slot(id).path = true;
            }
            let mut node = draft.node(id);
            while let Some(current) = node {
                let slot = self.slot(current.id);
                if slot.path {
                    break;
                }
                slot.path = true;
                node = current.parent.and_then(|id| draft.node(id));
            }
        }
    }

    #[inline]
    fn slot(&mut self, id: Id) -> &mut Slot {
        self.slots.entry(id).or_default()
    }

    #[inline]
    fn trusted(&mut self, draft: &Working, id: Id) -> bool {
        if !self.trust_off_paths {
            return false;
        }
        if let Some(dirty) = self.paths_from.take() {
            self.mark_paths(draft, dirty);
        }
        self.slots.get(&id).is_none_or(|slot| !slot.path)
    }

    pub fn run(&mut self, draft: &mut Working, dirty: impl IntoIterator<Item = Id>) {
        self.run_with(draft, dirty, None);
    }

    /// `run`, skipping the roots `memo` knows as settled and recording the ones found so (the layout stage of a
    /// long-lived pipeline).
    pub fn run_with(
        &mut self,
        draft: &mut Working,
        dirty: impl IntoIterator<Item = Id>,
        memo: Option<&mut LayoutMemo>,
    ) {
        // One body for every kind of id list (the sort alone is a few hundred bytes of wasm per instantiation).
        let dirty: Vec<Id> = dirty.into_iter().collect();
        self.run_ids(draft, &dirty, memo);
    }

    fn run_ids(&mut self, draft: &mut Working, dirty: &[Id], mut memo: Option<&mut LayoutMemo>) {
        let mut ordered: Vec<(usize, Id)> = {
            // Nothing is written while the roots are found: nodes are borrowed from the draft, and a climb through
            // hugging frames is walked once for every node that shares it.
            let draft: &Working = draft;
            let mut climbs = Climbs::default();
            let mut roots: IndexSet<Id> = IndexSet::new();
            for &id in dirty {
                if let Some(root) = root_for_in(draft, id, &mut climbs) {
                    roots.insert(root);
                }
            }
            roots
                .into_iter()
                .map(|id| (super::depth_of(draft, id), id))
                .collect()
        };
        ordered.sort_by_key(|(depth, _)| *depth);
        // The memo compares the dirty paths too: marked now, as the first `trusted` would (nothing is written before).
        if memo.is_some()
            && self.trust_off_paths
            && let Some(dirty) = self.paths_from.take()
        {
            self.mark_paths(draft, dirty);
        }
        for (_, id) in ordered {
            if self.slots.get(&id).is_some_and(|slot| slot.arranged) {
                continue;
            }
            let Some(memo) = memo.as_deref_mut() else {
                self.layout_root(draft, id);
                continue;
            };
            let parent_flow = draft.node(id).is_some_and(|node| parent_flow(draft, node));
            let on_path = |id: Id| self.slots.get(&id).is_some_and(|slot| slot.path);
            if memo.settled(draft, id, parent_flow, &on_path) {
                continue;
            }
            let written = draft.written().len();
            self.layout_root(draft, id);
            if draft.written().len() == written && self.pending.is_empty() {
                let on_path = |id: Id| self.slots.get(&id).is_some_and(|slot| slot.path);
                memo.record(draft, id, parent_flow, &on_path);
            }
        }
        self.flush(draft);
    }

    /// The outermost auto-layout frame whose layout a change to `id` can affect.
    pub fn root_for(&self, draft: &Working, id: Id) -> Option<Id> {
        root_for_in(draft, id, &mut Climbs::default())
    }

    /// Lays out a frame whose own size is not given by a parent's layout.
    pub fn layout_root(&mut self, draft: &mut Working, id: Id) {
        let Some(node) = draft.node(id) else {
            return;
        };
        if !is_auto_layout(Some(node)) {
            return;
        }
        let layout = self.container(draft, node, None, None, None);
        self.arrange(
            draft,
            id,
            None,
            Size {
                width: layout.width,
                height: layout.height,
            },
        );
    }

    fn flush(&mut self, draft: &mut Working) {
        while let Some(id) = self.pending.shift_remove_index(0) {
            self.layout_root(draft, id);
        }
    }

    // ── Measuring ──

    /// The node's size, with the given sides forced. `under`: the frame it was reached through, if any.
    pub fn measure(
        &mut self,
        draft: &Working,
        node: &Node,
        under: Option<Under>,
        forced_width: Option<f64>,
        forced_height: Option<f64>,
    ) -> Size {
        if self.trusted(draft, node.id)
            && forced_width.is_none_or(|w| same_f64(w, node.width))
            && forced_height.is_none_or(|h| same_f64(h, node.height))
        {
            return Size {
                width: node.width,
                height: node.height,
            };
        }
        if is_auto_layout(Some(node)) {
            let layout = self.container(draft, node, under, forced_width, forced_height);
            return Size {
                width: layout.width,
                height: layout.height,
            };
        }
        if node.kind == NodeType::Text && node.props.text().is_some() {
            return self.measure_text(draft, node, under, forced_width, forced_height, false);
        }
        let limits = limits_of(node);
        Size {
            width: forced_width.unwrap_or_else(|| clamp_to(node.width, &limits, 0)),
            height: forced_height.unwrap_or_else(|| clamp_to(node.height, &limits, 1)),
        }
    }

    /// The text's unwrapped size (`width` None) or its height at `width`, rounded up.
    fn text_size(&mut self, draft: &Working, node: &Node, width: Option<f64>) -> Size {
        let width_key = key(width);
        if let Some(size) = self
            .slots
            .get(&node.id)
            .and_then(|slot| slot.text.iter().find(|(at, _)| *at == width_key))
        {
            return size.1;
        }
        self.stats.text_measured += 1;
        let text = TextNode::of(node).expect("text_size is asked for text nodes only");
        let layout = self.text.layout(draft, text, width);
        let size = Size {
            width: width.unwrap_or_else(|| round_up(layout.natural_width)),
            height: round_up(layout.height),
        };
        self.slot(node.id).text.push((width_key, size));
        size
    }

    /// A text's size: hugging the width takes the unwrapped width up to the maximum.
    fn measure_text(
        &mut self,
        draft: &Working,
        node: &Node,
        under: Option<Under>,
        forced_width: Option<f64>,
        forced_height: Option<f64>,
        hug_width: bool,
    ) -> Size {
        let sizing = text_sizing(node, flow_under(draft, node, under));
        let limits = limits_of(node);
        let mut height: Option<f64> = None;
        let width = if let Some(width) = forced_width {
            width
        } else if hug_width || sizing.horizontal == LayoutSizing::Hug {
            let natural = self.text_size(draft, node, None);
            let width = clamp_to(natural.width, &limits, 0);
            if same_f64(width, natural.width) && sizing.vertical == LayoutSizing::Hug {
                height = Some(natural.height);
            }
            width
        } else {
            clamp_to(node.width, &limits, 0)
        };
        let height = if let Some(height) = forced_height {
            height
        } else if sizing.vertical == LayoutSizing::Hug {
            let measured = match height {
                Some(height) => height,
                None => self.text_size(draft, node, Some(width)).height,
            };
            clamp_to(measured, &limits, 1)
        } else {
            clamp_to(node.height, &limits, 1)
        };
        Size { width, height }
    }

    /// First baseline from the node's top, for BASELINE alignment; `None` when it has no text.
    fn baseline_of(
        &mut self,
        draft: &Working,
        node: &Node,
        under: Option<Under>,
        width: f64,
        height: f64,
    ) -> Option<f64> {
        if is_turned(node.rotation) {
            return None;
        }
        if node.kind == NodeType::Text
            && let Some(text) = node.props.text()
        {
            let mode = text_sizing(node, flow_under(draft, node, under)).text_auto_resize;
            let measured = TextNode {
                text,
                mode,
                width,
                height,
                on_path: node.props.text_path().is_some(),
            };
            let layout = self.text.layout(
                draft,
                measured,
                if mode == TextAutoResize::WidthAndHeight {
                    None
                } else {
                    Some(width)
                },
            );
            return layout.baseline;
        }
        if !is_auto_layout(Some(node)) {
            return None;
        }
        // A frame's baseline is its first flow child's that has one, as in CSS.
        let layout = self.container(draft, node, under, Some(width), Some(height));
        for (index, id) in node.children().iter().enumerate() {
            let rect = layout.boxes.get(index).copied().flatten();
            let child = draft.node(*id);
            let own = match (rect, child) {
                (Some(rect), Some(child)) => {
                    self.baseline_of(draft, child, Some(Under::of(node)), rect.width, rect.height)
                }
                _ => None,
            };
            if let (Some(rect), Some(own)) = (rect, own) {
                return Some(rect.y + own);
            }
        }
        None
    }

    fn items_of<'d>(
        &mut self,
        draft: &'d Working,
        node: &'d Node,
        layout: &AutoLayout,
    ) -> Vec<Item<'d>> {
        let mut items = Vec::with_capacity(node.children().len());
        for (index, id) in node.children().iter().enumerate() {
            let Some(child) = draft.node(*id) else {
                continue;
            };
            if !child.visible || child.layout_positioning == LayoutPositioning::Absolute {
                continue;
            }
            let mut item = Item {
                node: child,
                index,
                sizing: [
                    effective_sizing(child, true, SizingAxis::Horizontal),
                    effective_sizing(child, true, SizingAxis::Vertical),
                ],
                limits: limits_of(child),
                out: if layout.strokes_included_in_layout {
                    stroke_sides(child, Part::Outside)
                } else {
                    NO_SIDES
                },
                turned: is_turned(child.rotation),
                bounds: None,
                size: [child.width, child.height],
                basis: 0.0,
                pos: [0.0, 0.0],
                ascent: 0.0,
            };
            if item.turned {
                // Sized up front from its own content; the flow only sees its rotated bounds.
                let Size { width, height } =
                    self.measure(draft, child, Some(Under::of(node)), None, None);
                item.size = [width, height];
                let placement = placement(child).with_box(0.0, 0.0, width, height);
                item.bounds = Some(geom::transform_rect(
                    &geom::local_matrix(&placement),
                    Rect::new(0.0, 0.0, width, height),
                ));
                let o = math::max(
                    math::max(math::max(item.out[0][0], item.out[0][1]), item.out[1][0]),
                    item.out[1][1],
                );
                item.out = [[o, o], [o, o]];
            }
            items.push(item);
        }
        items
    }

    /// FIXED or HUG size of a child on one axis. Heights are asked after widths, at the width found.
    fn item_size(&mut self, draft: &Working, under: Under, item: &Item, axis: Axis) -> f64 {
        if item.sizing[axis] == LayoutSizing::Fixed {
            return clamp_to(
                size_on(item.node.width, item.node.height, axis),
                &item.limits,
                axis,
            );
        }
        let size = if axis == 1 {
            self.measure(draft, item.node, Some(under), Some(item.size[0]), None)
        } else {
            self.measure(draft, item.node, Some(under), None, None)
        };
        size_on(size.width, size.height, axis)
    }

    /// In a frame that hugs its main axis a filling child starts from its content or stored size.
    fn fill_basis(&mut self, draft: &Working, under: Under, item: &Item, axis: Axis) -> f64 {
        let node = item.node;
        if node.kind == NodeType::Text && node.props.text().is_some() {
            return if axis == 1 {
                clamp_to(
                    self.text_size(draft, node, Some(item.size[0])).height,
                    &item.limits,
                    1,
                )
            } else {
                self.measure_text(draft, node, Some(under), None, None, true)
                    .width
            };
        }
        clamp_to(size_on(node.width, node.height, axis), &item.limits, axis)
    }

    /// Sizes and places the children of an auto-layout frame; memoised per forced size.
    // Index loops over a line's range mirror the TypeScript's loops over its items (which read and write the items
    // they index).
    #[allow(clippy::needless_range_loop)]
    fn container(
        &mut self,
        draft: &Working,
        node: &Node,
        under: Option<Under>,
        forced_width: Option<f64>,
        forced_height: Option<f64>,
    ) -> Rc<ContainerLayout> {
        let memo_key = (key(forced_width), key(forced_height));
        if let Some(cached) = self.slots.get(&node.id).and_then(|slot| {
            slot.memo
                .iter()
                .find(|(w, h, _)| (*w, *h) == memo_key)
                .map(|(_, _, layout)| layout.clone())
        }) {
            return cached;
        }
        self.stats.measured += 1;

        let layout: &AutoLayout = node
            .props
            .auto_layout()
            .expect("container is asked for auto-layout frames only");
        let main: Axis = if layout.layout_mode == LayoutMode::Horizontal {
            0
        } else {
            1
        };
        let cross: Axis = 1 - main;
        let flow = flow_under(draft, node, under);
        let limits = limits_of(node);
        let forced = [forced_width, forced_height];
        let fixed: [Option<f64>; 2] = [0, 1].map(|axis| {
            forced[axis].or_else(|| {
                if effective_sizing(node, flow, axis_name(axis)) == LayoutSizing::Hug {
                    None
                } else {
                    Some(clamp_to(
                        size_on(node.width, node.height, axis),
                        &limits,
                        axis,
                    ))
                }
            })
        });
        let pad = padding_of(node, layout);
        let mut items = self.items_of(draft, node, layout);
        if layout.layout_mode == LayoutMode::Grid {
            // Whether the frame hugs an axis decides how its FLEX tracks size, forced or not (`arrange` lays a hugging
            // frame out again at the size the free pass found, and the tracks must not change under it).
            let hugs = [0, 1]
                .map(|axis| effective_sizing(node, flow, axis_name(axis)) == LayoutSizing::Hug);
            let result =
                Rc::new(self.grid_container(draft, node, &fixed, &hugs, &limits, &pad, &mut items));
            self.slot(node.id)
                .memo
                .push((memo_key.0, memo_key.1, result.clone()));
            return result;
        }
        let wrap = main == 0 && layout.layout_wrap == LayoutWrap::Wrap && fixed[0].is_some();
        let space_between = layout.primary_axis_align_items == PrimaryAxisAlignItems::SpaceBetween;
        let baseline =
            main == 0 && layout.counter_axis_align_items == CounterAxisAlignItems::Baseline;
        let mut size: Pair = [0.0, 0.0];
        let hug_main = fixed[main].is_none();
        let hug_cross = fixed[cross].is_none();
        let pad_main = pad[main][0] + pad[main][1];
        let pad_cross = pad[cross][0] + pad[cross][1];
        let cross_gap = if wrap {
            layout.counter_axis_spacing
        } else {
            0.0
        };
        // Lines are runs of consecutive items: (first, end) ranges. The lists below come from the engine's pools and
        // go back at the end (no allocation once warm, containers nest).
        let mut lines = self.scratch.ranges.pop().unwrap_or_default();
        lines.push((0, items.len()));
        let mut line_sizes = self.scratch.numbers.pop().unwrap_or_default();
        let mut line_ascents = self.scratch.numbers.pop().unwrap_or_default();

        let resolve_main =
            |engine: &mut Self,
             items: &mut Vec<Item>,
             lines: &mut Vec<(usize, usize)>,
             size: &mut Pair| {
                for item in items.iter_mut() {
                    if item.turned {
                        continue;
                    }
                    if item.sizing[main] != LayoutSizing::Fill {
                        item.size[main] = engine.item_size(draft, Under::of(node), item, main);
                    } else if hug_main {
                        let basis = engine.fill_basis(draft, Under::of(node), item, main);
                        item.basis = basis;
                        item.size[main] = basis;
                    } else if wrap {
                        item.size[main] = item.limits.min[main];
                    } else {
                        item.basis = 0.0;
                        item.size[main] = 0.0;
                    }
                }
                if wrap {
                    break_lines(
                        items,
                        main,
                        fixed[main].unwrap() - pad_main,
                        layout.item_spacing,
                        lines,
                    );
                }
                size[main] = if hug_main {
                    let extent = if items.is_empty() {
                        0.0
                    } else {
                        sum(items.iter().map(|item| footprint(item, main)))
                            + layout.item_spacing * (items.len() - 1) as f64
                    };
                    clamp_to(math::max(0.0, pad_main + extent), &limits, main)
                } else {
                    fixed[main].unwrap()
                };
                let inner = size[main] - pad_main;
                let mut fills = engine.scratch.indexes.pop().unwrap_or_default();
                let mut sized = engine.scratch.numbers.pop().unwrap_or_default();
                let mut shares = engine.scratch.shares.pop().unwrap_or_default();
                for &(first, end) in lines.iter() {
                    fills.clear();
                    fills.extend((first..end).filter(|&i| {
                        !items[i].turned && items[i].sizing[main] == LayoutSizing::Fill
                    }));
                    if fills.is_empty() {
                        continue;
                    }
                    if !hug_main {
                        for &i in &fills {
                            items[i].basis = 0.0;
                        }
                    }
                    let gap = if space_between && !hug_main {
                        0.0
                    } else {
                        layout.item_spacing
                    };
                    let mut used = gap * ((end - first) as f64 - 1.0);
                    for i in first..end {
                        used += if fills.contains(&i) {
                            items[i].basis + items[i].out[main][0] + items[i].out[main][1]
                        } else {
                            footprint(&items[i], main)
                        };
                    }
                    shares.clear();
                    shares.extend(fills.iter().map(|&i| (items[i].basis, items[i].limits)));
                    distribute(&shares, main, inner - used, &mut sized, &mut engine.scratch);
                    for (k, &i) in fills.iter().enumerate() {
                        items[i].size[main] = sized[k];
                    }
                }
                engine.scratch.give_indexes(fills);
                engine.scratch.give_numbers(sized);
                shares.clear();
                engine.scratch.shares.push(shares);
            };

        let resolve_cross = |engine: &mut Self,
                             items: &mut Vec<Item>,
                             lines: &Vec<(usize, usize)>,
                             size: &mut Pair,
                             line_sizes: &mut Vec<f64>,
                             line_ascents: &mut Vec<f64>| {
            for item in items.iter_mut() {
                if !item.turned && item.sizing[cross] != LayoutSizing::Fill {
                    item.size[cross] = engine.item_size(draft, Under::of(node), item, cross);
                }
            }
            for &(first, end) in lines {
                let (mut extent, mut ascent, mut descent, mut sized) = (0.0, 0.0, 0.0, false);
                for i in first..end {
                    let item = &items[i];
                    if !item.turned && item.sizing[cross] == LayoutSizing::Fill {
                        continue;
                    }
                    sized = true;
                    let foot = footprint(item, cross);
                    if baseline {
                        let own = if item.turned {
                            None
                        } else {
                            engine.baseline_of(
                                draft,
                                item.node,
                                Some(Under::of(node)),
                                item.size[0],
                                item.size[1],
                            )
                        };
                        let item_ascent = item.out[1][0]
                            + own.unwrap_or_else(|| match item.bounds {
                                Some(bounds) if item.turned => bounds.height,
                                _ => item.size[1],
                            });
                        items[i].ascent = item_ascent;
                        ascent = math::max(ascent, item_ascent);
                        descent = math::max(descent, foot - item_ascent);
                    } else {
                        extent = math::max(extent, foot);
                    }
                }
                if baseline && sized {
                    extent = ascent + descent;
                }
                // Only filling children: a hugging frame has nothing else to size by.
                if !sized {
                    for i in first..end {
                        let item = &items[i];
                        extent = math::max(
                            extent,
                            clamp_to(
                                size_on(item.node.width, item.node.height, cross),
                                &item.limits,
                                cross,
                            ) + item.out[cross][0]
                                + item.out[cross][1],
                        );
                    }
                }
                line_sizes.push(extent);
                line_ascents.push(ascent);
            }
            let block = sum(line_sizes.iter().copied()) + cross_gap * (lines.len() as f64 - 1.0);
            size[cross] = if hug_cross {
                clamp_to(pad_cross + block, &limits, cross)
            } else {
                fixed[cross].unwrap()
            };
            if !wrap {
                line_sizes[0] = size[cross] - pad_cross;
            }
            for (l, &(first, end)) in lines.iter().enumerate() {
                for item in &mut items[first..end] {
                    if item.turned || item.sizing[cross] != LayoutSizing::Fill {
                        continue;
                    }
                    item.size[cross] = clamp_to(
                        line_sizes[l] - item.out[cross][0] - item.out[cross][1],
                        &item.limits,
                        cross,
                    );
                }
            }
        };

        // Widths first: a height may depend on a width, never the reverse.
        if main == 0 {
            resolve_main(self, &mut items, &mut lines, &mut size);
            resolve_cross(
                self,
                &mut items,
                &lines,
                &mut size,
                &mut line_sizes,
                &mut line_ascents,
            );
        } else {
            resolve_cross(
                self,
                &mut items,
                &lines,
                &mut size,
                &mut line_sizes,
                &mut line_ascents,
            );
            resolve_main(self, &mut items, &mut lines, &mut size);
        }

        // Positions.
        let inner_main = size[main] - pad_main;
        let inner_cross = size[cross] - pad_cross;
        let mut line_start = pad[cross][0];
        let mut line_gap = cross_gap;
        let counter = counter_align(layout.counter_axis_align_items);
        if wrap {
            let total = sum(line_sizes.iter().copied());
            let free = inner_cross - total - cross_gap * (lines.len() as f64 - 1.0);
            if layout.counter_axis_align_content == CounterAxisAlignContent::SpaceBetween
                && !hug_cross
            {
                line_gap = if lines.len() > 1 {
                    (inner_cross - total) / (lines.len() - 1) as f64
                } else {
                    0.0
                };
            } else {
                line_start += align_offset(counter, free);
            }
        }
        let primary = primary_align(layout.primary_axis_align_items);
        let mut extents = self.scratch.numbers.pop().unwrap_or_default();
        for (l, &(first, end)) in lines.iter().enumerate() {
            let count = end - first;
            extents.clear();
            extents.extend(items[first..end].iter().map(|item| footprint(item, main)));
            let mut gap = layout.item_spacing;
            let mut start = 0.0;
            if space_between && !hug_main {
                gap = if count > 1 {
                    (inner_main - sum(extents.iter().copied())) / (count - 1) as f64
                } else {
                    0.0
                };
            } else {
                start = align_offset(
                    primary,
                    inner_main - sum(extents.iter().copied()) - gap * (count as f64 - 1.0),
                );
            }
            let mut cursor = pad[main][0] + start;
            for (k, i) in (first..end).enumerate() {
                items[i].pos[main] = cursor;
                cursor += extents[k] + gap;
                let item = &items[i];
                let filling = !item.turned && item.sizing[cross] == LayoutSizing::Fill;
                let offset = if filling {
                    0.0
                } else if baseline {
                    line_ascents[l] - item.ascent
                } else {
                    align_offset(counter, line_sizes[l] - footprint(item, cross))
                };
                items[i].pos[cross] = line_start + offset;
            }
            line_start += line_sizes[l] + line_gap;
        }

        self.scratch.give_numbers(extents);
        self.scratch.give_numbers(line_sizes);
        self.scratch.give_numbers(line_ascents);
        lines.clear();
        self.scratch.ranges.push(lines);

        let result = Rc::new(ContainerLayout {
            width: size[0],
            height: size[1],
            boxes: boxes_of(&items, node.children().len()),
        });
        self.slot(node.id)
            .memo
            .push((memo_key.0, memo_key.1, result.clone()));
        result
    }

    // ── Writing ──

    /// Gives the frame `size`, places its children, and lays out the children whose size or content changed.
    /// Absolute children follow their constraints when the frame resizes.
    fn arrange(&mut self, draft: &mut Working, id: Id, under: Option<Under>, size: Size) {
        let Some(node) = draft.node(id) else {
            return;
        };
        self.slot(id).arranged = true;
        self.stats.arranged += 1;
        let before = Size {
            width: node.width,
            height: node.height,
        };
        let layout = self.container(draft, node, under, Some(size.width), Some(size.height));
        let flow = is_auto_layout(Some(node));
        let mut children = self.ids.pop().unwrap_or_default();
        children.clear();
        children.extend_from_slice(node.children());
        let resized =
            !same_f64(before.width, layout.width) || !same_f64(before.height, layout.height);
        // `update` would keep both values when neither differs: no write, and no copy of the node.
        if resized {
            draft.update_box(id, None, None, Some(layout.width), Some(layout.height));
        }
        let after = Size {
            width: layout.width,
            height: layout.height,
        };
        for (index, &child_id) in children.iter().enumerate() {
            let Some(child) = draft.node(child_id) else {
                continue;
            };
            if let Some(fixes) = sizing_fixes(child, flow) {
                draft.update(child_id, |child| fixes.apply(child));
            }
            if let Some(rect) = layout.boxes.get(index).copied().flatten() {
                self.place(draft, child_id, Under { id, flow }, rect);
            } else if resized
                && let Some(child) = draft.node(child_id)
                && child.layout_positioning == LayoutPositioning::Absolute
            {
                let target = constrained_box(child, before, after, child.constraints);
                let mut hooks = ResizeHooks {
                    measurer: Some(&mut self.text),
                    resized_frames: Some(&mut self.pending),
                };
                resize_node(draft, child_id, target, ResizeMode::Follow, &mut hooks);
            }
        }
        self.ids.push(children);
    }

    fn place(&mut self, draft: &mut Working, id: Id, under: Under, rect: Rect) {
        let Some(child) = draft.node(id) else {
            return;
        };
        let resized = !same_f64(child.width, rect.width) || !same_f64(child.height, rect.height);
        if !is_auto_layout(Some(child)) {
            let mut hooks = ResizeHooks {
                measurer: Some(&mut self.text),
                resized_frames: Some(&mut self.pending),
            };
            resize_node(draft, id, rect, ResizeMode::Layout, &mut hooks);
            return;
        }
        if !same_f64(child.x, rect.x) || !same_f64(child.y, rect.y) {
            draft.update_box(id, Some(rect.x), Some(rect.y), None, None);
        }
        if resized || !self.trusted(draft, id) {
            self.arrange(
                draft,
                id,
                Some(under),
                Size {
                    width: rect.width,
                    height: rect.height,
                },
            );
        }
    }
}

/// What finding roots remembers while nothing is written: each frame a climb passed and where it ended, and the
/// nodes already looked up as someone's parent (siblings share one).
#[derive(Default)]
struct Climbs<'d> {
    ends: FxHashMap<Id, Id>,
    parents: FxHashMap<Id, Option<&'d Node>>,
}

impl<'d> Climbs<'d> {
    fn parent(&mut self, draft: &'d Working, node: &'d Node) -> Option<&'d Node> {
        let id = node.parent?;
        *self.parents.entry(id).or_insert_with(|| draft.node(id))
    }
}

/// `rootFor`: the outermost auto-layout frame whose layout a change to `id` can affect.
fn root_for_in<'d>(draft: &'d Working, id: Id, climbs: &mut Climbs<'d>) -> Option<Id> {
    let node = draft.node(id)?;
    let parent = climbs.parent(draft, node);
    let mut top = if is_auto_layout(parent) {
        parent?
    } else if is_auto_layout(Some(node)) {
        node
    } else {
        return None;
    };
    let mut passed: Vec<Id> = Vec::new();
    let root = loop {
        if let Some(&root) = climbs.ends.get(&top.id) {
            break root;
        }
        passed.push(top.id);
        let up = climbs.parent(draft, top);
        let Some(up) = up.filter(|up| is_auto_layout(Some(up))) else {
            break top.id;
        };
        if top.layout_positioning == LayoutPositioning::Absolute || !top.visible {
            break top.id;
        }
        if effective_sizing(top, true, SizingAxis::Horizontal) != LayoutSizing::Hug
            && effective_sizing(top, true, SizingAxis::Vertical) != LayoutSizing::Hug
        {
            break top.id;
        }
        top = up;
    };
    for frame in passed {
        climbs.ends.insert(frame, root);
    }
    Some(root)
}

/// `layoutFrame`: lays out the auto-layout chain `id` belongs to, measuring everything afresh (text layouts come
/// from `text`'s cache when it has them, as text-layout.ts's do).
pub fn layout_frame(draft: &mut Working, id: Id, text: TextMeasure<'_>) -> LayoutStats {
    let mut engine = LayoutEngine::new(text);
    engine.run(draft, [id]);
    engine.stats
}
