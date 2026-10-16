//! The one painting path (`src/design/engine/render/painter.ts`, ported): walks the stored document in paint order
//! and draws every node into a [`Sink`] — drop shadows → background blur → fills → inner shadows → children
//! (clipped) → strokes → layout grids; opacity, blend modes and layer blur through layers; masks and boolean
//! fallbacks through compose layers. Shadows and blurs that the engines have no primitive for are bitmaps:
//! the caster rendered into a transparent bitmap, blurred, drawn back ([`Sink::effect_bitmap`]).

use crate::bounds::{blur_reach, clips_children, is_container, local_matrix, stroke_outsets};
use crate::doc::RenderDoc;
use crate::paint::{color, color_rgba, drawn_scale, gradients_of, image_placement, paint_visible};
use crate::shape::{
    NodeShape, individual_stroke_band, marker_shape, path_ends, rounded_rect_path, shape_of,
    shorten_path, spread_path, variable_width_outline,
};
use crate::sink::{BrushSpec, Clip, Handle, Sink};
use kurbo::{Affine, BezPath, Point, Rect, Shape, Stroke};
use morfa_model::store::Id;
use morfa_model::store::{Effect, Node, Paint, ShadowEffect, ShadowKind};
use morfa_model::{
    BlendMode as ModelBlend, LayoutGridAlignment, NodeType, StrokeAlign, StrokeCap, StrokeJoin,
    StrokeMarker,
};
use peniko::{BlendMode, Color, Compose, Fill, Mix};
use std::cell::Cell;
use std::collections::HashSet;

/// Largest effect bitmap kept whole (px); larger ones are drawn only where visible.
pub const EFFECT_MAX_PIXELS: f64 = 4.0 * 1024.0 * 1024.0;

/// What `paintNodeTree` takes besides the target.
#[derive(Clone, Default)]
pub struct Options {
    /// Not painted, with their subtrees.
    pub hidden: HashSet<Id>,
    /// "Outline mode": 1 device-px outlines, text as boxes, no fills or effects.
    pub outlines: bool,
    pub layout_grids: bool,
    /// Paint the roots even when hidden (exporting a hidden layer).
    pub paint_hidden_roots: bool,
    /// Skip nodes whose painted box is smaller than this many device px on both axes.
    pub min_size: f64,
    /// Multiplies the roots' opacity (a live node drawn outside its translucent group).
    pub root_opacity: f64,
    /// Scale at which text sprites were painted (the tile's level scale): sprites at other scales are resampled.
    pub sprite_scale: f64,
    /// Live roots keep their ancestors' clips (false for lifted nodes).
    pub clip_to_ancestors: bool,
    /// A board's dot grid (the editor's tiles only): painted right after the background, under everything.
    pub dots: Option<Dots>,
}

/// A board's dot grid as the editor's Canvas2D tile paints it (src/design/engine/render/dot-grid.ts): `side` × `side` device-px
/// squares at every (left, top) pair, in the raster target's device px, one solid colour.
#[derive(Clone, Debug)]
pub struct Dots {
    pub lefts: Vec<f64>,
    pub tops: Vec<f64>,
    pub side: f64,
    pub color: Color,
}

impl Dots {
    /// The squares as one path (one fill, as the Canvas2D tile does).
    pub fn paint(&self, sink: &mut dyn Sink) {
        if self.lefts.is_empty() || self.tops.is_empty() || !(self.side > 0.0) {
            return;
        }
        let mut path = BezPath::new();
        for &top in &self.tops {
            for &left in &self.lefts {
                path.move_to((left, top));
                path.line_to((left + self.side, top));
                path.line_to((left + self.side, top + self.side));
                path.line_to((left, top + self.side));
                path.close_path();
            }
        }
        sink.fill(
            Affine::IDENTITY,
            Fill::NonZero,
            &BrushSpec::Solid(self.color),
            &path,
        );
    }
}

/// One drawing target: page → device transform, device px per page px, and the device rectangle worth painting.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub base: Affine,
    pub scale: f64,
    pub clip: Rect,
}

/// Counters of what the painter did (tests assert them; stats show them).
#[derive(Default, Debug, Clone, Copy)]
pub struct Counters {
    pub nodes: u32,
    pub fills: u32,
    pub strokes: u32,
    pub layers: u32,
    pub effect_bitmaps: u32,
    pub backdrops: u32,
    pub sprites: u32,
    pub missing_sprites: u32,
    pub missing_pictures: u32,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Caster {
    None,
    Geometry,
    Silhouette,
    Content,
}

struct Plan<'a> {
    fills: Vec<&'a Paint>,
    strokes: Vec<&'a Paint>,
    drops: Vec<&'a ShadowEffect>,
    inners: Vec<&'a ShadowEffect>,
    layer_blur: f64,
    background_blur: f64,
    container: bool,
    clips: bool,
    caster: Caster,
    opaque_cover: bool,
    normal_blend: bool,
    single_op: bool,
    markers: bool,
}

pub fn is_normal_blend(mode: ModelBlend) -> bool {
    matches!(mode, ModelBlend::Normal | ModelBlend::PassThrough)
}

pub fn mix_of(mode: ModelBlend) -> Mix {
    match mode {
        ModelBlend::Normal | ModelBlend::PassThrough => Mix::Normal,
        ModelBlend::Darken => Mix::Darken,
        ModelBlend::Multiply => Mix::Multiply,
        ModelBlend::ColorBurn => Mix::ColorBurn,
        ModelBlend::Lighten => Mix::Lighten,
        ModelBlend::Screen => Mix::Screen,
        ModelBlend::ColorDodge => Mix::ColorDodge,
        ModelBlend::Overlay => Mix::Overlay,
        ModelBlend::SoftLight => Mix::SoftLight,
        ModelBlend::HardLight => Mix::HardLight,
        ModelBlend::Difference => Mix::Difference,
        ModelBlend::Exclusion => Mix::Exclusion,
        ModelBlend::Hue => Mix::Hue,
        ModelBlend::Saturation => Mix::Saturation,
        ModelBlend::Color => Mix::Color,
        ModelBlend::Luminosity => Mix::Luminosity,
    }
}

pub fn blend_of(mode: ModelBlend) -> BlendMode {
    BlendMode::new(mix_of(mode), Compose::SrcOver)
}

pub(crate) const NORMAL: BlendMode = BlendMode {
    mix: Mix::Normal,
    compose: Compose::SrcOver,
};
const DEST_IN: BlendMode = BlendMode {
    mix: Mix::Normal,
    compose: Compose::DestIn,
};
const DEST_OUT: BlendMode = BlendMode {
    mix: Mix::Normal,
    compose: Compose::DestOut,
};

fn intersect(a: Rect, b: Rect) -> Option<Rect> {
    let r = a.intersect(b);
    if r.width() > 0.0 && r.height() > 0.0 {
        Some(r)
    } else {
        None
    }
}

/// Snaps outwards to whole pixels, so layers composite without resampling.
fn pixel_rect(r: Rect) -> Rect {
    Rect::new(r.x0.floor(), r.y0.floor(), r.x1.ceil(), r.y1.ceil())
}

fn map_rect(t: Affine, r: Rect) -> Rect {
    t.transform_rect_bbox(r)
}

fn stroke_style(node: &Node, width: f64, dashed: bool) -> Stroke {
    let mut stroke = Stroke::new(width)
        .with_caps(match node.stroke_cap {
            StrokeCap::None => kurbo::Cap::Butt,
            StrokeCap::Round => kurbo::Cap::Round,
            StrokeCap::Square => kurbo::Cap::Square,
        })
        .with_join(match node.stroke_join {
            StrokeJoin::Miter => kurbo::Join::Miter,
            StrokeJoin::Bevel => kurbo::Join::Bevel,
            StrokeJoin::Round => kurbo::Join::Round,
        })
        .with_miter_limit(if node.stroke_miter_limit > 0.0 {
            node.stroke_miter_limit
        } else {
            4.0
        });
    if dashed {
        if let Some(dashes) = node.props.dash_pattern() {
            let dashes = dashes.as_slice();
            if !dashes.is_empty() && dashes.iter().any(|d| *d > 0.0) {
                stroke = stroke.with_dashes(0.0, dashes.iter().copied());
            }
        }
    }
    stroke
}

fn node_blend(node: &Node) -> BlendMode {
    blend_of(node.blend_mode)
}

/// The paint context of one node: its local box and the region a paint must cover.
pub(crate) struct PaintCtx {
    pub(crate) width: f64,
    pub(crate) height: f64,
    pub(crate) region: Rect,
}

fn paint_ctx(node: &Node, region: Option<Rect>) -> PaintCtx {
    let out = stroke_outsets(node);
    PaintCtx {
        width: node.width,
        height: node.height,
        region: region.unwrap_or(Rect::new(
            -out.left,
            -out.top,
            node.width + out.right,
            node.height + out.bottom,
        )),
    }
}

pub struct Painter<'a> {
    doc: &'a RenderDoc,
    options: &'a Options,
    counters: Cell<Counters>,
}

impl<'a> Painter<'a> {
    pub fn new(doc: &'a RenderDoc, options: &'a Options) -> Painter<'a> {
        Painter {
            doc,
            options,
            counters: Cell::new(Counters::default()),
        }
    }

    pub fn counters(&self) -> Counters {
        self.counters.get()
    }

    fn count(&self, f: impl FnOnce(&mut Counters)) {
        let mut c = self.counters.get();
        f(&mut c);
        self.counters.set(c);
    }

    /// Paints `roots` (with their subtrees, in the given order) into `sink` under `target`. Roots keep their world
    /// transform but none of their ancestors' opacity, clips or masks; a page id paints the page.
    pub fn paint_roots(&self, sink: &mut dyn Sink, target: &Target, roots: &[Id]) {
        let doc = self.doc.document();
        for &id in roots {
            let Some(node) = doc.node(id) else { continue };
            if node.kind == NodeType::Page {
                self.children(sink, target, node, Affine::IDENTITY);
                continue;
            }
            let parent_world = node
                .parent
                .map(|p| self.doc.world_matrix(p))
                .unwrap_or(Affine::IDENTITY);
            self.node(
                sink,
                target,
                node,
                parent_world,
                Some(self.options.root_opacity),
            );
        }
    }

    /// Paints one root with `opacity` multiplied into its own (the live layer's `paintDetached`).
    pub fn paint_root(&self, sink: &mut dyn Sink, target: &Target, id: Id, opacity: f64) {
        let doc = self.doc.document();
        let Some(node) = doc.node(id) else { return };
        if node.kind == NodeType::Page {
            return self.children(sink, target, node, Affine::IDENTITY);
        }
        let parent_world = node
            .parent
            .map(|p| self.doc.world_matrix(p))
            .unwrap_or(Affine::IDENTITY);
        self.node(sink, target, node, parent_world, Some(opacity));
    }

    // ── Bounds ──

    fn device_bounds(&self, s: &Target, node: &Node) -> Option<Rect> {
        let page = self.doc.bounds_of(node.id)?;
        Some(map_rect(s.base, page))
    }

    // ── Plans ──

    fn plan<'n>(&self, node: &'n Node, shape: Option<&NodeShape>) -> Plan<'n> {
        let fills: Vec<&Paint> = node
            .fills
            .as_slice()
            .iter()
            .filter(|p| paint_visible(p))
            .collect();
        let strokes: Vec<&Paint> = if node.stroke_weight > 0.0 {
            node.strokes
                .as_slice()
                .iter()
                .filter(|p| paint_visible(p))
                .collect()
        } else {
            Vec::new()
        };
        let mut drops = Vec::new();
        let mut inners = Vec::new();
        let mut layer_blur = 0.0f64;
        let mut background_blur = 0.0f64;
        for effect in node.effects.as_slice() {
            match effect {
                Effect::Shadow(s) if s.visible => {
                    if s.kind == ShadowKind::Drop {
                        drops.push(s)
                    } else {
                        inners.push(s)
                    }
                }
                Effect::Blur(b) if b.visible => match b.kind {
                    morfa_model::store::BlurKind::Layer => layer_blur = layer_blur.max(b.radius),
                    morfa_model::store::BlurKind::Background => {
                        background_blur = background_blur.max(b.radius)
                    }
                },
                _ => {}
            }
        }
        let container = is_container(node) && node.kind != NodeType::BooleanOperation;
        let markers = shape.is_some_and(|s| s.open)
            && [
                node.props.stroke_start_marker(),
                node.props.stroke_end_marker(),
            ]
            .iter()
            .any(|m| m.is_some_and(|m| *m != StrokeMarker::None));
        let mut caster = Caster::None;
        if !drops.is_empty() || !inners.is_empty() {
            let image_fill = fills.iter().any(|p| matches!(p, Paint::Image(_)));
            caster = if node.kind == NodeType::Text
                || shape.is_none()
                || shape.is_some_and(|s| s.open)
                || image_fill
                || (container && fills.is_empty())
            {
                Caster::Content
            } else if fills.is_empty()
                || (!strokes.is_empty() && node.stroke_align != StrokeAlign::Inside)
            {
                Caster::Silhouette
            } else {
                Caster::Geometry
            };
        }
        let ops = fills.len()
            + strokes.len() * if markers { 2 } else { 1 }
            + drops.len()
            + inners.len()
            + if background_blur > 0.0 { 1 } else { 0 };
        let normal_blend = is_normal_blend(node.blend_mode);
        let opaque_cover = fills.iter().any(
            |p| matches!(p, Paint::Solid(s) if s.opacity >= 1.0 && is_normal_blend(s.blend_mode)),
        );
        let single_op = !container
            && ops <= 1
            && (normal_blend
                || fills
                    .iter()
                    .chain(strokes.iter())
                    .all(|p| is_normal_blend(paint_blend(p))));
        Plan {
            fills,
            strokes,
            drops,
            inners,
            layer_blur,
            background_blur,
            container,
            clips: clips_children(node),
            caster,
            opaque_cover,
            normal_blend,
            single_op,
            markers,
        }
    }

    // ── Traversal ──

    fn node(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        parent_world: Affine,
        root: Option<f64>,
    ) {
        if !node.visible && !(root.is_some() && self.options.paint_hidden_roots) {
            return;
        }
        if self.options.hidden.contains(&node.id) || node.kind == NodeType::Slice {
            return;
        }
        let world = parent_world * local_matrix(node);
        let Some(device) = self.device_bounds(s, node) else {
            return;
        };
        if intersect(device, s.clip).is_none() {
            return;
        }
        let min = self.options.min_size;
        if min > 0.0 && device.width() < min && device.height() < min {
            return;
        }
        self.count(|c| c.nodes += 1);
        if self.options.outlines {
            return self.outline(sink, s, node, world);
        }
        let shape = shape_of(node);
        let plan = self.plan(node, shape.as_ref());
        let opacity = node.opacity.clamp(0.0, 1.0) * root.unwrap_or(1.0);
        if opacity <= 0.0 {
            return;
        }
        let layered =
            plan.layer_blur > 0.0 || ((opacity < 1.0 || !plan.normal_blend) && !plan.single_op);
        if !layered {
            let direct = !plan.container;
            let alpha = if direct { opacity } else { 1.0 };
            let blend = if direct { node_blend(node) } else { NORMAL };
            self.content(
                sink,
                s,
                node,
                world,
                shape.as_ref(),
                &plan,
                alpha as f32,
                blend,
            );
            return;
        }
        let margin = if plan.layer_blur > 0.0 {
            blur_reach(plan.layer_blur) * s.scale
        } else {
            0.0
        };
        let Some(area) = intersect(device, s.clip.inflate(margin, margin)) else {
            return;
        };
        let area = pixel_rect(area);
        if plan.layer_blur > 0.0 {
            let sigma = (plan.layer_blur / 2.0) * s.scale;
            let w = area.width() as u32;
            let h = area.height() as u32;
            let nested = Target {
                base: Affine::translate((-area.x0, -area.y0)) * s.base,
                scale: s.scale,
                clip: Rect::new(0.0, 0.0, w as f64, h as f64),
            };
            self.count(|c| c.effect_bitmaps += 1);
            let handle = sink.effect_bitmap(w, h, sigma, &mut |inner: &mut dyn Sink| {
                self.content(
                    inner,
                    &nested,
                    node,
                    world,
                    shape.as_ref(),
                    &plan,
                    1.0,
                    NORMAL,
                );
            });
            if let Some(handle) = handle {
                self.draw_bitmap(
                    sink,
                    handle,
                    area.origin(),
                    opacity as f32,
                    node_blend(node),
                );
                sink.release(handle);
            }
            return;
        }
        self.count(|c| c.layers += 1);
        push_rect_layer(sink, node_blend(node), opacity as f32, area);
        self.content(sink, s, node, world, shape.as_ref(), &plan, 1.0, NORMAL);
        sink.pop_layer();
    }

    fn draw_bitmap(
        &self,
        sink: &mut dyn Sink,
        handle: Handle,
        origin: Point,
        alpha: f32,
        blend: BlendMode,
    ) {
        let brush = BrushSpec::Bitmap {
            handle,
            transform: Affine::translate(origin.to_vec2()),
            alpha,
        };
        let layered = blend != NORMAL;
        if layered {
            let (w, h) = sink.bitmap_size(handle);
            let area = Rect::new(origin.x, origin.y, origin.x + w as f64, origin.y + h as f64);
            push_rect_layer(sink, blend, 1.0, area.inflate(1.0, 1.0));
        }
        sink.fill_bitmap(handle, Affine::translate(origin.to_vec2()), &brush);
        if layered {
            sink.pop_layer();
        }
    }

    fn child_order(&self, container: &Node) -> Vec<Id> {
        let ids: Vec<Id> = container.children.as_deref().unwrap_or(&[]).to_vec();
        let reverse = container.props.auto_layout().is_some_and(|auto| {
            auto.layout_mode != morfa_model::LayoutMode::None && auto.item_reverse_z_index
        });
        if reverse {
            ids.into_iter().rev().collect()
        } else {
            ids
        }
    }

    fn children(&self, sink: &mut dyn Sink, s: &Target, container: &Node, world: Affine) {
        if crate::bounds::hides_contents(container) {
            return;
        }
        let doc = self.doc.document();
        let ids = self.child_order(container);
        let mut i = 0;
        while i < ids.len() {
            let Some(child) = doc.node(ids[i]) else {
                i += 1;
                continue;
            };
            if !child.is_mask || self.options.outlines {
                self.node(sink, s, child, world, None);
                i += 1;
                continue;
            }
            let mut end = i + 1;
            while end < ids.len() && !doc.node(ids[end]).is_some_and(|n| n.is_mask) {
                end += 1;
            }
            let masked = &ids[i + 1..end];
            if !child.visible || self.options.hidden.contains(&child.id) {
                // A hidden mask masks nothing: its siblings show in full.
                for &id in masked {
                    if let Some(n) = doc.node(id) {
                        self.node(sink, s, n, world, None);
                    }
                }
            } else {
                self.mask_group(sink, s, child, masked, world);
            }
            i = end;
        }
    }

    fn mask_group(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        mask: &Node,
        ids: &[Id],
        parent_world: Affine,
    ) {
        if ids.is_empty() {
            return;
        }
        let doc = self.doc.document();
        let mask_world = parent_world * local_matrix(mask);
        let Some(device) = self.device_bounds(s, mask) else {
            return;
        };
        let Some(area) = intersect(device, s.clip) else {
            return;
        };
        let region = pixel_rect(area);
        let kind = mask
            .props
            .mask_type()
            .copied()
            .unwrap_or(morfa_model::MaskType::Alpha);
        if kind == morfa_model::MaskType::Vector {
            if let Some(shape) = shape_of(mask) {
                if shape.parts.len() == 1 {
                    let (path, rule) = &shape.parts[0];
                    sink.push_layer(
                        NORMAL,
                        1.0,
                        Some(Clip {
                            transform: s.base * mask_world,
                            rule: *rule,
                            path,
                        }),
                    );
                    let clipped = Target { clip: region, ..*s };
                    for &id in ids {
                        if let Some(n) = doc.node(id) {
                            self.node(sink, &clipped, n, parent_world, None);
                        }
                    }
                    sink.pop_layer();
                    return;
                }
            }
        }
        let clipped = Target { clip: region, ..*s };
        self.count(|c| c.layers += 1);
        sink.mask_group(
            kind == morfa_model::MaskType::Luminance,
            &mut |inner: &mut dyn Sink| {
                for &id in ids {
                    if let Some(n) = doc.node(id) {
                        self.node(inner, &clipped, n, parent_world, None);
                    }
                }
            },
            &mut |inner: &mut dyn Sink| {
                self.node(inner, &clipped, mask, parent_world, None);
            },
        );
    }

    // ── A node's own drawing ──

    fn content(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        world: Affine,
        shape: Option<&NodeShape>,
        plan: &Plan,
        alpha: f32,
        blend: BlendMode,
    ) {
        if !plan.drops.is_empty() {
            self.drop_shadows(sink, s, node, world, shape, plan, alpha);
        }
        if plan.background_blur > 0.0 {
            if let Some(shape) = shape {
                self.background_blur(sink, s, node, world, shape, plan.background_blur);
            }
        }
        if !plan.inners.is_empty() && plan.caster == Caster::Content {
            let Some((body, origin)) = self.body_bitmap(sink, s, node, world, shape, plan, 0.0)
            else {
                return;
            };
            self.draw_bitmap(sink, body, origin, alpha, blend);
            let t = s.base * world;
            for effect in &plan.inners {
                self.inner_from_bitmap(sink, s, body, origin, body, origin, effect, t, alpha);
            }
            sink.release(body);
            return;
        }
        self.body(sink, s, node, world, shape, plan, alpha, blend, true);
    }

    /// Fills, inner shadows, children, strokes and grids: everything but drop shadows and blur.
    fn body(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        world: Affine,
        shape: Option<&NodeShape>,
        plan: &Plan,
        alpha: f32,
        blend: BlendMode,
        inners: bool,
    ) {
        let t = s.base * world;
        if node.kind == NodeType::Text {
            return self.text(sink, s, node, t, alpha, blend);
        }
        if node.kind == NodeType::BooleanOperation && shape.is_none() {
            return self.boolean_fallback(sink, s, node, world, plan, t, alpha, blend);
        }
        let pc = paint_ctx(node, None);
        if let Some(shape) = shape {
            if !plan.fills.is_empty() {
                self.fill_shape(sink, s, shape, &plan.fills, &pc, t, alpha, blend);
            }
            if inners && !plan.inners.is_empty() {
                for effect in &plan.inners {
                    self.inner_shadow(sink, s, node, shape, plan, effect, t, alpha);
                }
            }
        }
        if plan.container {
            match (plan.clips, shape) {
                (true, Some(shape)) => {
                    let (path, rule) = &shape.parts[0];
                    let bx = map_rect(t, Rect::new(0.0, 0.0, node.width, node.height));
                    if let Some(bx) = intersect(bx, s.clip) {
                        sink.push_layer(
                            NORMAL,
                            1.0,
                            Some(Clip {
                                transform: t,
                                rule: *rule,
                                path,
                            }),
                        );
                        self.children(sink, &Target { clip: bx, ..*s }, node, world);
                        sink.pop_layer();
                    }
                }
                _ => self.children(sink, s, node, world),
            }
        }
        if let Some(shape) = shape {
            if !plan.strokes.is_empty() && node.kind != NodeType::Text {
                self.stroke_shape(sink, s, node, shape, plan, &pc, t, alpha, blend);
            }
        }
        if self.options.layout_grids && plan.container {
            if let Some(grids) = node.props.layout_grids() {
                self.grids(sink, node, grids.as_slice(), t, s.scale);
            }
        }
    }

    /// Draws with every paint of `paints`: `draw(sink, brush, blend)` once per paint (per quadrant of a diamond).
    pub(crate) fn with_paints(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        paints: &[&Paint],
        pc: &PaintCtx,
        t: Affine,
        alpha: f32,
        blend: BlendMode,
        draw: &mut dyn FnMut(&mut dyn Sink, &BrushSpec<'_>),
    ) {
        for paint in paints {
            let paint_blend = if is_normal_blend(paint_blend(paint)) {
                blend
            } else {
                blend_of(paint_blend(paint))
            };
            let a = alpha * paint.opacity() as f32;
            // A blend layer over the paint's own device bounds, not the whole target: the blend composites only
            // where the paint can reach (cheaper; a whole-target non-separable blend also goes black under
            // SwiftShader's Vulkan).
            let layered = paint_blend != NORMAL;
            if layered {
                let bounds = map_rect(t, pc.region).inflate(1.0, 1.0);
                let Some(area) = intersect(bounds, s.clip) else {
                    continue;
                };
                push_rect_layer(sink, paint_blend, 1.0, pixel_rect(area));
            }
            match paint {
                Paint::Solid(solid) => {
                    // The paint's own opacity is in `a` already.
                    let brush = BrushSpec::Solid(color(&solid.color, a as f64));
                    draw(sink, &brush);
                }
                Paint::Gradient(gradient) => {
                    for (g, frame, quadrant) in gradients_of(gradient, pc.width, pc.height) {
                        let brush_t = t * frame;
                        let g = g.multiply_alpha(alpha);
                        let brush = BrushSpec::Gradient(&g, brush_t);
                        if let Some((sx, sy)) = quadrant {
                            // The quadrant, bounded by the paint region in gradient space (huge clips upset the engines).
                            let region = brush_t
                                .inverse()
                                .transform_rect_bbox(map_rect(t, pc.region))
                                .inflate(1.0, 1.0);
                            let reach = region
                                .x0
                                .abs()
                                .max(region.x1.abs())
                                .max(region.y0.abs())
                                .max(region.y1.abs())
                                .max(1.0);
                            let quad = Rect::new(
                                if sx > 0.0 { 0.0 } else { -reach },
                                if sy > 0.0 { 0.0 } else { -reach },
                                if sx > 0.0 { reach } else { 0.0 },
                                if sy > 0.0 { reach } else { 0.0 },
                            );
                            let path = quad.to_path(0.1);
                            sink.push_layer(
                                NORMAL,
                                1.0,
                                Some(Clip {
                                    transform: brush_t,
                                    rule: Fill::NonZero,
                                    path: &path,
                                }),
                            );
                            draw(sink, &brush);
                            sink.pop_layer();
                        } else {
                            draw(sink, &brush);
                        }
                    }
                }
                Paint::Image(image) => {
                    let picture = image
                        .image_ref
                        .map(|r| self.doc.document().atom(r))
                        .and_then(|r| self.doc.picture(r, image.filters.as_ref()));
                    match picture {
                        Some(picture) => {
                            let (placement, repeat) = image_placement(
                                image,
                                pc.width,
                                pc.height,
                                picture.width as f64,
                                picture.height as f64,
                            );
                            let level = picture.level_for(drawn_scale(placement, s.scale));
                            let level_scale = (1u32 << level) as f64;
                            let transform = t * placement * Affine::scale(level_scale);
                            let brush = BrushSpec::Picture {
                                picture: &picture,
                                level,
                                transform,
                                repeat,
                                alpha: a,
                            };
                            draw(sink, &brush);
                        }
                        None => {
                            if image.image_ref.is_some() {
                                self.count(|c| c.missing_pictures += 1);
                                let checker = self.doc.checker();
                                let cell = 1.0 / s.scale.max(1e-6);
                                let brush = BrushSpec::Picture {
                                    picture: checker,
                                    level: 0,
                                    transform: t * Affine::scale(cell),
                                    repeat: true,
                                    alpha: a,
                                };
                                draw(sink, &brush);
                            }
                        }
                    }
                }
            }
            if layered {
                sink.pop_layer();
            }
        }
    }

    fn fill_shape(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        shape: &NodeShape,
        fills: &[&Paint],
        pc: &PaintCtx,
        t: Affine,
        alpha: f32,
        blend: BlendMode,
    ) {
        self.count(|c| c.fills += fills.len() as u32);
        self.with_paints(sink, s, fills, pc, t, alpha, blend, &mut |sink, brush| {
            for (path, rule) in &shape.parts {
                sink.fill(t, *rule, brush, path);
            }
        });
    }

    fn stroke_shape(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        shape: &NodeShape,
        plan: &Plan,
        pc: &PaintCtx,
        t: Affine,
        alpha: f32,
        blend: BlendMode,
    ) {
        self.count(|c| c.strokes += plan.strokes.len() as u32);
        // "Width profile": the stroke is a filled outline (no dashes, no markers).
        if let Some(variable) = variable_width_outline(node) {
            self.with_paints(
                sink,
                s,
                &plan.strokes,
                pc,
                t,
                alpha,
                blend,
                &mut |sink, brush| sink.fill(t, Fill::NonZero, brush, &variable),
            );
            return;
        }
        let weight = node.stroke_weight;
        if let (Some(Some(individual)), Some(radii)) =
            (node.props.individual_stroke_weights(), shape.rect)
        {
            let same = individual.top == individual.left
                && individual.top == individual.right
                && individual.top == individual.bottom
                && individual.top == weight;
            if !same {
                let (outer, inner) = individual_stroke_band(
                    node.width,
                    node.height,
                    individual,
                    node.stroke_align,
                    radii,
                );
                let mut path = rounded_rect_path(outer.rect, outer.radii);
                if let Some(inner) = inner {
                    path.extend(rounded_rect_path(inner.rect, inner.radii));
                }
                self.with_paints(
                    sink,
                    s,
                    &plan.strokes,
                    pc,
                    t,
                    alpha,
                    blend,
                    &mut |sink, brush| sink.fill(t, Fill::EvenOdd, brush, &path),
                );
                return;
            }
        }
        let (clip_kind, line_width) = if shape.open || node.stroke_align == StrokeAlign::Center {
            (None, weight)
        } else {
            (Some(node.stroke_align), weight * 2.0)
        };
        let markers = if plan.markers {
            self.markers_of(node, shape)
        } else {
            None
        };
        let line = markers.as_ref().and_then(|m| m.line.as_ref());
        let style = stroke_style(node, line_width, true);
        let stroke_all = |sink: &mut dyn Sink, painter: &Painter, a: f32, b: BlendMode| {
            painter.with_paints(sink, s, &plan.strokes, pc, t, a, b, &mut |sink, brush| {
                if let Some(line) = line {
                    sink.stroke(t, &style, brush, line);
                } else {
                    for (path, _) in &shape.parts {
                        sink.stroke(t, &style, brush, path);
                    }
                }
            });
        };
        match clip_kind {
            None => stroke_all(sink, self, alpha, blend),
            Some(StrokeAlign::Inside) if shape.parts.len() == 1 => {
                let (path, rule) = &shape.parts[0];
                sink.push_layer(
                    NORMAL,
                    1.0,
                    Some(Clip {
                        transform: t,
                        rule: *rule,
                        path,
                    }),
                );
                stroke_all(sink, self, alpha, blend);
                sink.pop_layer();
            }
            Some(StrokeAlign::Outside) if shape.invertible && shape.parts.len() == 1 => {
                let inverse = self.inverse(shape, t, s.clip, weight * 2.0);
                sink.push_layer(
                    NORMAL,
                    1.0,
                    Some(Clip {
                        transform: t,
                        rule: Fill::EvenOdd,
                        path: &inverse,
                    }),
                );
                stroke_all(sink, self, alpha, blend);
                sink.pop_layer();
            }
            Some(align) => {
                // A path that cannot be inverted exactly: stroke into a layer, keep the half we want.
                let device = map_rect(
                    t,
                    Rect::new(
                        -weight * 2.0,
                        -weight * 2.0,
                        node.width + weight * 2.0,
                        node.height + weight * 2.0,
                    ),
                );
                if let Some(device) = intersect(device, s.clip) {
                    push_rect_layer(sink, blend, alpha, pixel_rect(device));
                    stroke_all(sink, self, 1.0, NORMAL);
                    sink.push_layer(
                        if align == StrokeAlign::Inside {
                            DEST_IN
                        } else {
                            DEST_OUT
                        },
                        1.0,
                        None,
                    );
                    for (path, rule) in &shape.parts {
                        sink.fill(t, *rule, &BrushSpec::Solid(Color::BLACK), path);
                    }
                    sink.pop_layer();
                    sink.pop_layer();
                }
            }
        }
        if let Some(markers) = &markers {
            let marker_style = stroke_style(node, weight, false);
            self.with_paints(
                sink,
                s,
                &plan.strokes,
                pc,
                t,
                alpha,
                blend,
                &mut |sink, brush| {
                    if let Some(fills) = &markers.fills {
                        sink.fill(t, Fill::NonZero, brush, fills);
                    }
                    if let Some(strokes) = &markers.strokes {
                        sink.stroke(t, &marker_style, brush, strokes);
                    }
                },
            );
        }
    }

    fn markers_of(&self, node: &Node, shape: &NodeShape) -> Option<Markers> {
        let mut all = BezPath::new();
        for (path, _) in &shape.parts {
            all.extend(path.elements().iter().copied());
        }
        let (start, end) = path_ends(&all)?;
        let start_marker = node
            .props
            .stroke_start_marker()
            .copied()
            .unwrap_or(StrokeMarker::None);
        let end_marker = node
            .props
            .stroke_end_marker()
            .copied()
            .unwrap_or(StrokeMarker::None);
        let start = marker_shape(start_marker, &start, node.stroke_weight);
        let end = marker_shape(end_marker, &end, node.stroke_weight);
        let mut fills = BezPath::new();
        let mut strokes = BezPath::new();
        let mut inset_start = 0.0;
        let mut inset_end = 0.0;
        if let Some(m) = &start {
            if let Some(f) = &m.fill {
                fills.extend(f.elements().iter().copied());
            }
            if let Some(st) = &m.stroke {
                strokes.extend(st.elements().iter().copied());
            }
            inset_start = m.inset;
        }
        if let Some(m) = &end {
            if let Some(f) = &m.fill {
                fills.extend(f.elements().iter().copied());
            }
            if let Some(st) = &m.stroke {
                strokes.extend(st.elements().iter().copied());
            }
            inset_end = m.inset;
        }
        Some(Markers {
            line: if inset_start > 0.0 || inset_end > 0.0 {
                Some(shorten_path(&all, inset_start, inset_end))
            } else {
                None
            },
            fills: if fills.elements().is_empty() {
                None
            } else {
                Some(fills)
            },
            strokes: if strokes.elements().is_empty() {
                None
            } else {
                Some(strokes)
            },
        })
    }

    /// Everything except the shape: a frame around the visible area (in local space) plus the shape, for even-odd
    /// clipping.
    fn inverse(&self, shape: &NodeShape, t: Affine, clip: Rect, extra: f64) -> BezPath {
        let area = map_rect(t.inverse(), clip).inflate(extra + 1.0, extra + 1.0);
        let mut path = area.to_path(0.1);
        path.extend(shape.parts[0].0.elements().iter().copied());
        path
    }

    fn text(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        t: Affine,
        alpha: f32,
        blend: BlendMode,
    ) {
        let Some(sprite) = self.doc.sprite(node.id, self.options.sprite_scale) else {
            self.count(|c| c.missing_sprites += 1);
            return;
        };
        self.count(|c| c.sprites += 1);
        let layered = blend != NORMAL;
        if layered {
            let Some(area) = intersect(map_rect(t, sprite.rect).inflate(1.0, 1.0), s.clip) else {
                return;
            };
            push_rect_layer(sink, blend, 1.0, pixel_rect(area));
        }
        let transform = t
            * Affine::translate((sprite.rect.x0, sprite.rect.y0))
            * Affine::scale_non_uniform(
                sprite.rect.width() / sprite.picture.width as f64,
                sprite.rect.height() / sprite.picture.height as f64,
            );
        let brush = BrushSpec::Picture {
            picture: &sprite.picture,
            level: 0,
            transform,
            repeat: false,
            alpha,
        };
        sink.fill(t, Fill::NonZero, &brush, &sprite.rect.to_path(0.1));
        if layered {
            sink.pop_layer();
        }
    }

    /// A boolean operation without result paths: its children's silhouettes combined with the operation's compose
    /// mode, then the boolean's fills through that mask.
    fn boolean_fallback(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        world: Affine,
        plan: &Plan,
        t: Affine,
        alpha: f32,
        blend: BlendMode,
    ) {
        if plan.fills.is_empty() {
            return;
        }
        let doc = self.doc.document();
        let Some(device) = self.device_bounds(s, node) else {
            return;
        };
        let Some(area) = intersect(device, s.clip) else {
            return;
        };
        let region = pixel_rect(area);
        let pc = paint_ctx(node, None);
        push_rect_layer(sink, blend, alpha, region);
        self.with_paints(
            sink,
            s,
            &plan.fills,
            &pc,
            t,
            1.0,
            NORMAL,
            &mut |sink, brush| sink.fill_rect(t, brush, pc.region),
        );
        sink.push_layer(DEST_IN, 1.0, None);
        let op = node
            .props
            .boolean_operation()
            .copied()
            .unwrap_or(morfa_model::BooleanOperation::Union);
        let compose = match op {
            morfa_model::BooleanOperation::Union => Compose::SrcOver,
            morfa_model::BooleanOperation::Subtract => Compose::DestOut,
            morfa_model::BooleanOperation::Intersect => Compose::DestIn,
            morfa_model::BooleanOperation::Exclude => Compose::Xor,
        };
        let mut first = true;
        for &child_id in node.children.as_deref().unwrap_or(&[]) {
            let Some(child) = doc.node(child_id) else {
                continue;
            };
            if !child.visible {
                continue;
            }
            let child_shape = shape_of(child);
            let layered = !first;
            first = false;
            if layered {
                sink.push_layer(BlendMode::new(Mix::Normal, compose), 1.0, None);
            }
            match child_shape {
                Some(shape) if !is_container(child) => {
                    let ct = s.base * world * local_matrix(child);
                    for (path, rule) in &shape.parts {
                        sink.fill(ct, *rule, &BrushSpec::Solid(Color::BLACK), path);
                    }
                }
                _ => self.node(sink, s, child, world, None),
            }
            if layered {
                sink.pop_layer();
            }
        }
        sink.pop_layer();
        sink.pop_layer();
    }

    // ── Effects ──

    fn drop_shadows(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        world: Affine,
        shape: Option<&NodeShape>,
        plan: &Plan,
        alpha: f32,
    ) {
        let t = s.base * world;
        let device = map_rect(t, Rect::new(0.0, 0.0, node.width, node.height));
        let (Some(shape), true) = (shape, plan.caster != Caster::Content) else {
            let reach = plan
                .drops
                .iter()
                .map(|e| (e.offset.x.abs() + e.offset.y.abs() + blur_reach(e.radius)) * s.scale)
                .fold(0.0, f64::max);
            let Some((body, origin)) = self.body_bitmap(sink, s, node, world, shape, plan, reach)
            else {
                return;
            };
            for effect in &plan.drops {
                let knockout = if effect.show_shadow_behind_node.unwrap_or(false) {
                    None
                } else {
                    Some((body, origin))
                };
                self.drop_from_bitmap(sink, s, body, origin, effect, t, alpha, knockout);
            }
            sink.release(body);
            return;
        };
        for effect in &plan.drops {
            let knock = !effect.show_shadow_behind_node.unwrap_or(false) && !plan.opaque_cover;
            let path = if plan.caster == Caster::Geometry {
                spread_path(node, shape, effect.spread)
            } else {
                None
            };
            if let Some(path) = path {
                if !knock || (shape.invertible && shape.parts.len() == 1) {
                    if knock {
                        let inverse = self.inverse(shape, t, s.clip, 0.0);
                        sink.push_layer(
                            NORMAL,
                            1.0,
                            Some(Clip {
                                transform: t,
                                rule: Fill::EvenOdd,
                                path: &inverse,
                            }),
                        );
                    }
                    let rule = shape.parts[0].1;
                    self.cast_path(sink, s, node, shape, effect, &path, rule, t, alpha, device);
                    if knock {
                        sink.pop_layer();
                    }
                    continue;
                }
            }
            // A silhouette bitmap: the outline with its stroke band, grown or shrunk by the spread.
            let reach = (effect.offset.x.abs() + effect.offset.y.abs() + blur_reach(effect.radius))
                * s.scale;
            let out = stroke_outsets(node);
            let extra = out.max() + effect.spread.max(0.0);
            let local = Rect::new(
                -extra - 1.0,
                -extra - 1.0,
                node.width + extra + 1.0,
                node.height + extra + 1.0,
            );
            let Some(area) = intersect(map_rect(t, local), s.clip.inflate(reach, reach)) else {
                continue;
            };
            let area = pixel_rect(area);
            let Some(caster) =
                self.silhouette_bitmap(sink, area, node, shape, plan, t, effect.spread)
            else {
                continue;
            };
            let knockout = if knock {
                if effect.spread != 0.0 {
                    self.silhouette_bitmap(sink, area, node, shape, plan, t, 0.0)
                        .map(|h| (h, area.origin()))
                } else {
                    Some((caster, area.origin()))
                }
            } else {
                None
            };
            self.drop_from_bitmap(sink, s, caster, area.origin(), effect, t, alpha, knockout);
            if let Some((k, _)) = knockout {
                if k != caster {
                    sink.release(k);
                }
            }
            sink.release(caster);
        }
    }

    /// The shadow of a path (a rectangle, an ellipse, a spread outline): analytic for a rounded rectangle with one
    /// radius, a blurred bitmap of the filled path otherwise.
    fn cast_path(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        shape: &NodeShape,
        effect: &ShadowEffect,
        path: &BezPath,
        rule: Fill,
        t: Affine,
        alpha: f32,
        _device: Rect,
    ) {
        let c = t.as_coeffs();
        let dx = c[0] * effect.offset.x + c[2] * effect.offset.y;
        let dy = c[1] * effect.offset.x + c[3] * effect.offset.y;
        let sigma = (effect.radius.max(0.0) / 2.0) * s.scale;
        let blend = blend_of(effect.blend_mode);
        let shadow_color = color_rgba(&effect.color, alpha as f64);
        let shifted = Affine::translate((dx, dy)) * t;
        if let Some(radius) = uniform_radius(node, shape, effect.spread) {
            let rect = Rect::new(
                -effect.spread,
                -effect.spread,
                node.width + effect.spread,
                node.height + effect.spread,
            );
            if rect.width() > 0.0 && rect.height() > 0.0 {
                let layered = blend != NORMAL;
                if layered {
                    let reach = sigma * 3.0 + 1.0;
                    let Some(area) =
                        intersect(map_rect(shifted, rect).inflate(reach, reach), s.clip)
                    else {
                        return;
                    };
                    push_rect_layer(sink, blend, 1.0, pixel_rect(area));
                }
                sink.blurred_rect(shifted, rect, radius, sigma, shadow_color);
                if layered {
                    sink.pop_layer();
                }
            }
            return;
        }
        let bounds = map_rect(t, path.bounding_box());
        let reach = blur_reach(effect.radius) * s.scale;
        let Some(area) = intersect(
            bounds.inflate(reach, reach),
            s.clip
                .inflate(reach + dx.abs() + dy.abs(), reach + dy.abs() + dx.abs()),
        ) else {
            return;
        };
        let area = pixel_rect(area);
        let w = area.width() as u32;
        let h = area.height() as u32;
        if (w as f64 * h as f64) > sink.max_bitmap_pixels() as f64 {
            return;
        }
        let nested_t = Affine::translate((-area.x0, -area.y0)) * t;
        self.count(|c| c.effect_bitmaps += 1);
        let handle = sink.effect_bitmap(w, h, sigma, &mut |inner: &mut dyn Sink| {
            inner.fill(nested_t, rule, &BrushSpec::Solid(shadow_color), path);
        });
        if let Some(handle) = handle {
            self.draw_bitmap(
                sink,
                handle,
                Point::new(area.x0 + dx, area.y0 + dy),
                1.0,
                blend,
            );
            sink.release(handle);
        }
    }

    /// The opaque outline of a shape with its stroke band, grown (> 0) or shrunk by `spread`, as a bitmap covering
    /// `area` (device px).
    fn silhouette_bitmap(
        &self,
        sink: &mut dyn Sink,
        area: Rect,
        node: &Node,
        shape: &NodeShape,
        plan: &Plan,
        t: Affine,
        spread: f64,
    ) -> Option<Handle> {
        let w = area.width() as u32;
        let h = area.height() as u32;
        if w == 0 || h == 0 || (w as f64 * h as f64) > sink.max_bitmap_pixels() as f64 {
            return None;
        }
        let lt = Affine::translate((-area.x0, -area.y0)) * t;
        self.count(|c| c.effect_bitmaps += 1);
        sink.effect_bitmap(w, h, 0.0, &mut |inner: &mut dyn Sink| {
            let black = BrushSpec::Solid(Color::BLACK);
            if !plan.fills.is_empty() {
                for (path, rule) in &shape.parts {
                    inner.fill(lt, *rule, &black, path);
                }
            }
            let mut band = 0.0;
            if !plan.strokes.is_empty() {
                band = if shape.open || node.stroke_align == StrokeAlign::Center {
                    node.stroke_weight
                } else if node.stroke_align == StrokeAlign::Outside {
                    node.stroke_weight * 2.0
                } else {
                    0.0
                };
                if node.stroke_align == StrokeAlign::Inside && plan.fills.is_empty() && !shape.open
                {
                    let (clip_path, rule) = &shape.parts[0];
                    inner.push_layer(
                        NORMAL,
                        1.0,
                        Some(Clip {
                            transform: lt,
                            rule: *rule,
                            path: clip_path,
                        }),
                    );
                    let style = stroke_style(node, node.stroke_weight * 2.0, false);
                    for (path, _) in &shape.parts {
                        inner.stroke(lt, &style, &black, path);
                    }
                    inner.pop_layer();
                }
            }
            if band > 0.0 || spread > 0.0 {
                let mut style = stroke_style(node, band + spread.max(0.0) * 2.0, false);
                if spread > 0.0 {
                    style = style.with_join(kurbo::Join::Round);
                }
                for (path, _) in &shape.parts {
                    inner.stroke(lt, &style, &black, path);
                }
            }
            if spread < 0.0 {
                inner.push_layer(DEST_OUT, 1.0, None);
                let style = Stroke::new(-spread * 2.0).with_join(kurbo::Join::Round);
                for (path, _) in &shape.parts {
                    inner.stroke(lt, &style, &black, path);
                }
                inner.pop_layer();
            }
        })
    }

    /// The shadow of a bitmap's alpha, offset and blurred, optionally knocked out where `knockout` is opaque.
    fn drop_from_bitmap(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        image: Handle,
        origin: Point,
        effect: &ShadowEffect,
        t: Affine,
        alpha: f32,
        knockout: Option<(Handle, Point)>,
    ) {
        let (w, h) = sink.bitmap_size(image);
        let c = t.as_coeffs();
        let dx = c[0] * effect.offset.x + c[2] * effect.offset.y;
        let dy = c[1] * effect.offset.x + c[3] * effect.offset.y;
        let sigma = (effect.radius.max(0.0) / 2.0) * s.scale;
        let reach = (blur_reach(effect.radius) * s.scale).ceil();
        let sw = w + 2 * reach as u32;
        let sh = h + 2 * reach as u32;
        if (sw as f64 * sh as f64) > sink.max_bitmap_pixels() as f64 {
            return;
        }
        let shadow_color = color_rgba(&effect.color, 1.0);
        self.count(|c| c.effect_bitmaps += 1);
        let Some(shadow) = sink.effect_bitmap(sw, sh, sigma, &mut |inner: &mut dyn Sink| {
            inner.push_layer(NORMAL, 1.0, None);
            inner.fill_rect(
                Affine::IDENTITY,
                &BrushSpec::Solid(shadow_color),
                Rect::new(0.0, 0.0, sw as f64, sh as f64),
            );
            inner.push_layer(DEST_IN, 1.0, None);
            inner.fill_bitmap(
                image,
                Affine::translate((reach, reach)),
                &BrushSpec::Bitmap {
                    handle: image,
                    transform: Affine::translate((reach, reach)),
                    alpha: 1.0,
                },
            );
            inner.pop_layer();
            inner.pop_layer();
        }) else {
            return;
        };
        let at = Point::new(origin.x - reach + dx, origin.y - reach + dy);
        let blend = blend_of(effect.blend_mode);
        match knockout {
            None => self.draw_bitmap(sink, shadow, at, alpha, blend),
            Some((k, k_origin)) => {
                let (w, h) = sink.bitmap_size(shadow);
                let area = Rect::new(at.x, at.y, at.x + w as f64, at.y + h as f64);
                push_rect_layer(sink, blend, alpha, area.inflate(1.0, 1.0));
                self.draw_bitmap(sink, shadow, at, 1.0, NORMAL);
                sink.push_layer(DEST_OUT, 1.0, None);
                self.draw_bitmap(sink, k, k_origin, 1.0, NORMAL);
                sink.pop_layer();
                sink.pop_layer();
            }
        }
        sink.release(shadow);
    }

    fn inner_shadow(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        shape: &NodeShape,
        plan: &Plan,
        effect: &ShadowEffect,
        t: Affine,
        alpha: f32,
    ) {
        let hole = spread_path(node, shape, -effect.spread);
        if let Some(hole) = hole {
            if shape.parts.len() == 1 && (effect.spread != 0.0 || shape.invertible) {
                let reach = effect.offset.x.abs()
                    + effect.offset.y.abs()
                    + blur_reach(effect.radius)
                    + effect.spread.abs()
                    + 2.0;
                let (clip_path, rule) = &shape.parts[0];
                sink.push_layer(
                    NORMAL,
                    1.0,
                    Some(Clip {
                        transform: t,
                        rule: *rule,
                        path: clip_path,
                    }),
                );
                let c = t.as_coeffs();
                let dx = c[0] * effect.offset.x + c[2] * effect.offset.y;
                let dy = c[1] * effect.offset.x + c[3] * effect.offset.y;
                let sigma = (effect.radius.max(0.0) / 2.0) * s.scale;
                let blend = blend_of(effect.blend_mode);
                let shadow_color = color_rgba(&effect.color, alpha as f64);
                let shifted = Affine::translate((dx, dy)) * t;
                if let Some(radius) = uniform_radius(node, shape, -effect.spread) {
                    // colour × (1 − blurred hole): the shadow colour everywhere, the blurred hole cut out of it.
                    let hole_rect = Rect::new(
                        effect.spread,
                        effect.spread,
                        node.width - effect.spread,
                        node.height - effect.spread,
                    );
                    let cover = Rect::new(-reach, -reach, node.width + reach, node.height + reach);
                    let Some(area) = intersect(map_rect(t, cover).inflate(1.0, 1.0), s.clip) else {
                        return;
                    };
                    push_rect_layer(sink, blend, 1.0, pixel_rect(area));
                    sink.fill_rect(t, &BrushSpec::Solid(shadow_color), cover);
                    if hole_rect.width() > 0.0 && hole_rect.height() > 0.0 {
                        sink.push_layer(DEST_OUT, 1.0, None);
                        sink.blurred_rect(shifted, hole_rect, radius, sigma, Color::BLACK);
                        sink.pop_layer();
                    }
                    sink.pop_layer();
                } else {
                    let mut caster =
                        Rect::new(-reach, -reach, node.width + reach, node.height + reach)
                            .to_path(0.1);
                    caster.extend(hole.elements().iter().copied());
                    let device = map_rect(t, Rect::new(0.0, 0.0, node.width, node.height));
                    self.cast_path(
                        sink,
                        s,
                        node,
                        shape,
                        effect,
                        &caster,
                        Fill::EvenOdd,
                        t,
                        alpha,
                        device,
                    );
                }
                sink.pop_layer();
                return;
            }
        }
        let Some(device) = intersect(
            map_rect(t, Rect::new(0.0, 0.0, node.width, node.height)),
            s.clip,
        ) else {
            return;
        };
        let region = pixel_rect(device);
        let no_strokes = Plan {
            strokes: Vec::new(),
            fills: plan.fills.clone(),
            drops: Vec::new(),
            inners: Vec::new(),
            ..*plan
        };
        let Some(inside) =
            self.silhouette_bitmap(sink, region, node, shape, &no_strokes, t, -effect.spread)
        else {
            return;
        };
        let outline = if effect.spread != 0.0 {
            self.silhouette_bitmap(sink, region, node, shape, &no_strokes, t, 0.0)
        } else {
            Some(inside)
        };
        if let Some(outline) = outline {
            self.inner_from_bitmap(
                sink,
                s,
                inside,
                region.origin(),
                outline,
                region.origin(),
                effect,
                t,
                alpha,
            );
            if outline != inside {
                sink.release(outline);
            }
        }
        sink.release(inside);
    }

    /// Inner shadow of a bitmap's alpha: the shadow of everything outside `caster`, kept inside `clip`.
    fn inner_from_bitmap(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        caster: Handle,
        caster_origin: Point,
        clip: Handle,
        clip_origin: Point,
        effect: &ShadowEffect,
        t: Affine,
        alpha: f32,
    ) {
        let c = t.as_coeffs();
        let dx = c[0] * effect.offset.x + c[2] * effect.offset.y;
        let dy = c[1] * effect.offset.x + c[3] * effect.offset.y;
        let sigma = (effect.radius.max(0.0) / 2.0) * s.scale;
        let reach = (dx.abs() + dy.abs() + blur_reach(effect.radius) * s.scale + 2.0).ceil();
        let (cw, ch) = sink.bitmap_size(caster);
        let (kw, kh) = sink.bitmap_size(clip);
        let ow = cw + 2 * reach as u32;
        let oh = ch + 2 * reach as u32;
        if (ow as f64 * oh as f64) > sink.max_bitmap_pixels() as f64 {
            return;
        }
        let shadow_color = color_rgba(&effect.color, 1.0);
        // The complement of the caster, blurred and offset, in the shadow colour.
        self.count(|c| c.effect_bitmaps += 1);
        let Some(outside) = sink.effect_bitmap(ow, oh, sigma, &mut |inner: &mut dyn Sink| {
            inner.fill_rect(
                Affine::IDENTITY,
                &BrushSpec::Solid(shadow_color),
                Rect::new(0.0, 0.0, ow as f64, oh as f64),
            );
            inner.push_layer(DEST_OUT, 1.0, None);
            inner.fill_bitmap(
                caster,
                Affine::translate((reach, reach)),
                &BrushSpec::Bitmap {
                    handle: caster,
                    transform: Affine::translate((reach, reach)),
                    alpha: 1.0,
                },
            );
            inner.pop_layer();
        }) else {
            return;
        };
        let blend = blend_of(effect.blend_mode);
        push_rect_layer(
            sink,
            blend,
            alpha,
            Rect::new(
                clip_origin.x,
                clip_origin.y,
                clip_origin.x + kw as f64,
                clip_origin.y + kh as f64,
            ),
        );
        self.draw_bitmap(
            sink,
            outside,
            Point::new(caster_origin.x - reach + dx, caster_origin.y - reach + dy),
            1.0,
            NORMAL,
        );
        sink.push_layer(DEST_IN, 1.0, None);
        self.draw_bitmap(sink, clip, clip_origin, 1.0, NORMAL);
        sink.pop_layer();
        sink.pop_layer();
        sink.release(outside);
    }

    /// The node's body (fills, children, strokes) as a bitmap, for shadows cast by what it shows.
    fn body_bitmap(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        world: Affine,
        shape: Option<&NodeShape>,
        plan: &Plan,
        margin: f64,
    ) -> Option<(Handle, Point)> {
        let device = self.device_bounds(s, node)?;
        let area = pixel_rect(intersect(device, s.clip.inflate(margin, margin))?);
        let w = area.width() as u32;
        let h = area.height() as u32;
        if w == 0 || h == 0 || (w as f64 * h as f64) > sink.max_bitmap_pixels() as f64 {
            return None;
        }
        let nested = Target {
            base: Affine::translate((-area.x0, -area.y0)) * s.base,
            scale: s.scale,
            clip: Rect::new(0.0, 0.0, w as f64, h as f64),
        };
        self.count(|c| c.effect_bitmaps += 1);
        let handle = sink.effect_bitmap(w, h, 0.0, &mut |inner: &mut dyn Sink| {
            self.body(inner, &nested, node, world, shape, plan, 1.0, NORMAL, false);
        })?;
        Some((handle, area.origin()))
    }

    /// Blurs what is already painted under the shape (background blur), before the fills.
    fn background_blur(
        &self,
        sink: &mut dyn Sink,
        s: &Target,
        node: &Node,
        world: Affine,
        shape: &NodeShape,
        radius: f64,
    ) {
        let t = s.base * world;
        let Some(area) = intersect(
            map_rect(t, Rect::new(0.0, 0.0, node.width, node.height)),
            s.clip,
        ) else {
            return;
        };
        let sigma = (radius / 2.0) * s.scale;
        let region = pixel_rect(area);
        let (tw, th) = sink.size();
        let Some(sample) = intersect(
            region.inflate((3.0 * sigma).ceil(), (3.0 * sigma).ceil()),
            Rect::new(0.0, 0.0, tw as f64, th as f64),
        ) else {
            return;
        };
        let sample = pixel_rect(sample);
        self.count(|c| c.backdrops += 1);
        let Some(copy) = sink.backdrop(sample, sigma) else {
            return;
        };
        let (path, rule) = &shape.parts[0];
        sink.push_layer(
            NORMAL,
            1.0,
            Some(Clip {
                transform: t,
                rule: *rule,
                path,
            }),
        );
        push_rect_layer(sink, NORMAL, 1.0, region);
        self.draw_bitmap(sink, copy, sample.origin(), 1.0, NORMAL);
        sink.pop_layer();
        sink.pop_layer();
        sink.release(copy);
    }

    // ── Outlines and grids ──

    fn outline(&self, sink: &mut dyn Sink, s: &Target, node: &Node, world: Affine) {
        let t = s.base * world;
        let ink = BrushSpec::Solid(Color::from_rgb8(0x1E, 0x1E, 0x1E));
        let style = Stroke::new(1.0 / s.scale.max(1e-6)).with_join(kurbo::Join::Miter);
        if node.kind == NodeType::Text {
            sink.stroke(
                t,
                &style,
                &ink,
                &Rect::new(0.0, 0.0, node.width, node.height).to_path(0.1),
            );
        } else if !matches!(node.kind, NodeType::Group | NodeType::BooleanOperation) {
            if let Some(shape) = shape_of(node) {
                for (path, _) in &shape.parts {
                    sink.stroke(t, &style, &ink, path);
                }
            }
        }
        if is_container(node) {
            self.children(sink, s, node, world);
        }
    }

    fn grids(
        &self,
        sink: &mut dyn Sink,
        node: &Node,
        grids: &[morfa_model::store::LayoutGrid],
        t: Affine,
        scale: f64,
    ) {
        let bx = Rect::new(0.0, 0.0, node.width, node.height);
        let clip_path = bx.to_path(0.1);
        sink.push_layer(
            NORMAL,
            1.0,
            Some(Clip {
                transform: t,
                rule: Fill::NonZero,
                path: &clip_path,
            }),
        );
        for grid in grids {
            match grid {
                morfa_model::store::LayoutGrid::Grid(g) => {
                    if !g.visible {
                        continue;
                    }
                    let brush = BrushSpec::Solid(color_rgba(&g.color, 1.0));
                    let style = Stroke::new(1.0 / scale.max(1e-6));
                    let mut path = BezPath::new();
                    if g.section_size > 0.0 {
                        let mut x = g.section_size;
                        let mut n = 0;
                        while x < node.width && n < 2000 {
                            path.move_to(Point::new(x, 0.0));
                            path.line_to(Point::new(x, node.height));
                            x += g.section_size;
                            n += 1;
                        }
                        let mut y = g.section_size;
                        n = 0;
                        while y < node.height && n < 2000 {
                            path.move_to(Point::new(0.0, y));
                            path.line_to(Point::new(node.width, y));
                            y += g.section_size;
                            n += 1;
                        }
                    }
                    sink.stroke(t, &style, &brush, &path);
                }
                morfa_model::store::LayoutGrid::Columns(band)
                | morfa_model::store::LayoutGrid::Rows(band) => {
                    if !band.visible {
                        continue;
                    }
                    let vertical = matches!(grid, morfa_model::store::LayoutGrid::Columns(_));
                    let brush = BrushSpec::Solid(color_rgba(&band.color, 1.0));
                    for rect in grid_bands(band, vertical, node.width, node.height) {
                        sink.fill_rect(t, &brush, rect);
                    }
                }
            }
        }
        sink.pop_layer();
    }
}

struct Markers {
    line: Option<BezPath>,
    fills: Option<BezPath>,
    strokes: Option<BezPath>,
}

fn paint_blend(paint: &Paint) -> ModelBlend {
    match paint {
        Paint::Solid(p) => p.blend_mode,
        Paint::Gradient(p) => p.blend_mode,
        Paint::Image(p) => p.blend_mode,
    }
}

/// The one radius of a rectangle (after `spread`) when all four corners share it, or a full ellipse that is a
/// circle: the shapes the engines blur analytically.
fn uniform_radius(node: &Node, shape: &NodeShape, spread: f64) -> Option<f64> {
    if let Some(radii) = shape.rect {
        let grown = radii.map(|r| if r > 0.0 { (r + spread).max(0.0) } else { 0.0 });
        let r = grown[0];
        if grown.iter().all(|v| (v - r).abs() < 1e-9) {
            let w = node.width + 2.0 * spread;
            let h = node.height + 2.0 * spread;
            // The rounded rectangle's corners never overlap: the primitive clamps to the half side.
            return Some(r.min(w / 2.0).min(h / 2.0).max(0.0));
        }
        return None;
    }
    if shape.ellipse && (node.width - node.height).abs() < 1e-6 {
        return Some(node.width / 2.0 + spread);
    }
    None
}

/// A layer clipped to a device rectangle.
fn push_rect_layer(sink: &mut dyn Sink, blend: BlendMode, alpha: f32, rect: Rect) {
    let path = rect.to_path(0.1);
    sink.push_layer(
        blend,
        alpha,
        Some(Clip {
            transform: Affine::IDENTITY,
            rule: Fill::NonZero,
            path: &path,
        }),
    );
}

/// COLUMNS and ROWS bands (`gridBands`).
fn grid_bands(
    grid: &morfa_model::BandLayoutGrid,
    vertical: bool,
    width: f64,
    height: f64,
) -> Vec<Rect> {
    let length = if vertical { width } else { height };
    let across = if vertical { height } else { width };
    let gutter = grid.gutter_size.max(0.0);
    let offset = grid.offset;
    let mut count = if grid.count.is_finite() && grid.count > 0.0 {
        grid.count.floor() as usize
    } else {
        0
    };
    let mut size = grid.section_size;
    if grid.alignment == LayoutGridAlignment::Stretch {
        if count == 0 {
            count = 1;
        }
        size = (length - 2.0 * offset - gutter * (count as f64 - 1.0)) / count as f64;
    } else if count == 0 {
        count = if size > 0.0 {
            ((length - offset + gutter) / (size + gutter))
                .floor()
                .max(0.0) as usize
        } else {
            0
        };
    }
    count = count.min(2000);
    if !(size > 0.0) || count == 0 {
        return Vec::new();
    }
    let total = count as f64 * size + (count as f64 - 1.0) * gutter;
    let start = match grid.alignment {
        LayoutGridAlignment::Max => length - offset - total,
        LayoutGridAlignment::Center => (length - total) / 2.0 + offset,
        _ => offset,
    };
    (0..count)
        .map(|i| {
            let position = start + i as f64 * (size + gutter);
            if vertical {
                Rect::new(position, 0.0, position + size, across)
            } else {
                Rect::new(0.0, position, across, position + size)
            }
        })
        .collect()
}
