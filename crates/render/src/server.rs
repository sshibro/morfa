//! The server's raster path (lane B4's `Rasterizer`, crates/render-service/src/raster.rs): layers or a page of a
//! document rendered to straight-alpha RGBA8 at a scale through the CPU backend, with the pictures the job carries
//! and real glyphs for its text. The browser paints text as sprites (lane L3's glyphs through Canvas2D,
//! [`crate::doc::Sprite`]); here a [`TextOutliner`] hands the painter the same glyphs as paths in the text's own
//! space (crates/export's `text_outlines`: the SVG export's layout and lane L3's outlines), baked into sprites at
//! the render scale by the same CPU backend, so one painting path draws the page.

use crate::cpu::{CpuBackend, unpremultiplied};
use crate::doc::{RenderDoc, Sprite};
use crate::painter::{Counters, NORMAL, Options, PaintCtx, Painter, Target};
use crate::record::Recorder;
use crate::sink::{Picture, Sink};
use kurbo::{Affine, BezPath, Rect, Shape as _, Stroke};
use morfa_model::NodeType;
use morfa_model::store::{
    Document, GradientKind, GradientPaint, Id, ImageFilters, ImagePaint, Paint, SolidPaint,
};
use morfa_model::types as t;
use peniko::{Color, Fill};

/// One span's glyphs (and decorations) of a text as a path in the text's local space, with the paint it is drawn
/// with (None: the text's own fills).
#[derive(Clone, Debug)]
pub struct Outline {
    pub path: BezPath,
    pub paint: Option<t::Paint>,
}

/// Where the server's glyphs come from (crates/render-service wires crates/export's fonts and layout).
pub trait TextOutliner {
    /// The outlines of the text node `key`; None when it cannot be laid out (no face of its family is loaded) —
    /// the text is then left out and counted in [`Rendered::missing_text`].
    fn outlines(&mut self, key: &str) -> Option<Vec<Outline>>;
}

/// No glyphs: text is left out (the Node tests, a service without fonts).
pub struct NoText;

impl TextOutliner for NoText {
    fn outlines(&mut self, _: &str) -> Option<Vec<Outline>> {
        None
    }
}

/// A `DesignDocument` paint as the shadow document stores it (image refs through the document's atoms; a ref the
/// document never saw becomes the pending-upload checker).
pub fn store_paint(paint: &t::Paint, doc: &Document) -> Paint {
    let gradient = |kind: GradientKind, g: &t::GradientPaint| {
        Paint::Gradient(Box::new(GradientPaint {
            kind,
            opacity: g.opacity,
            visible: g.visible,
            blend_mode: g.blend_mode,
            stops: g.gradient_stops.clone().into(),
            handles: g.gradient_handle_positions,
        }))
    };
    match paint {
        t::Paint::Solid(solid) => Paint::Solid(SolidPaint {
            color: solid.color,
            opacity: solid.opacity,
            visible: solid.visible,
            blend_mode: solid.blend_mode,
            bound_color: None,
        }),
        t::Paint::GradientLinear(g) => gradient(GradientKind::Linear, g),
        t::Paint::GradientRadial(g) => gradient(GradientKind::Radial, g),
        t::Paint::GradientAngular(g) => gradient(GradientKind::Angular, g),
        t::Paint::GradientDiamond(g) => gradient(GradientKind::Diamond, g),
        t::Paint::Image(image) => Paint::Image(Box::new(ImagePaint {
            opacity: image.opacity,
            visible: image.visible,
            blend_mode: image.blend_mode,
            image_ref: doc.atoms().get(&image.image_ref),
            scale_mode: image.scale_mode,
            transform: image.image_transform,
            scaling_factor: image.scaling_factor,
            rotation: image.rotation,
            filters: image.filters.map(|f| ImageFilters {
                exposure: f.exposure,
                contrast: f.contrast,
                saturation: f.saturation,
                temperature: f.temperature,
                tint: f.tint,
                highlights: f.highlights,
                shadows: f.shadows,
            }),
        })),
    }
}

/// The path of model path commands.
pub fn path_of(commands: &[t::PathCommand]) -> BezPath {
    let mut path = BezPath::new();
    for c in commands {
        match c {
            t::PathCommand::M(p) => path.move_to((p.x, p.y)),
            t::PathCommand::L(p) => path.line_to((p.x, p.y)),
            t::PathCommand::Q(q) => path.quad_to((q.x1, q.y1), (q.x, q.y)),
            t::PathCommand::C(c) => path.curve_to((c.x1, c.y1), (c.x2, c.y2), (c.x, c.y)),
            t::PathCommand::Z => path.close_path(),
        }
    }
    path
}

/// The largest sprite baked for one text (device px): a text past it is drawn without glyphs rather than at a
/// size the CPU backend cannot hold.
const MAX_SPRITE_PIXELS: f64 = 64.0 * 1024.0 * 1024.0;

/// What baking did: sprites set, and the keys of the texts no glyphs could be made for.
#[derive(Default, Debug)]
pub struct Baked {
    pub sprites: usize,
    pub missing_text: Vec<String>,
}

/// Bakes a sprite at `scale` for every visible text of `page` under `area` that has none, from the outliner's
/// glyphs drawn with the text's paints (and its stroke, as the browser's sprites carry it).
pub fn bake_sprites(
    doc: &mut RenderDoc,
    page: Id,
    area: Rect,
    scale: f64,
    outliner: &mut dyn TextOutliner,
    threads: u16,
) -> Baked {
    let mut baked = Baked::default();
    let needed = doc.sprites_needed(page, area, scale, 0);
    if needed.is_empty() {
        return baked;
    }
    let mut sprites: Vec<(Id, Sprite)> = Vec::new();
    {
        let options = Options {
            root_opacity: 1.0,
            sprite_scale: scale,
            ..Options::default()
        };
        let painter = Painter::new(doc, &options);
        let document = doc.document();
        for id in needed {
            let key = document.key(id).to_owned();
            let Some(node) = document.node(id) else {
                continue;
            };
            let Some(outlines) = outliner.outlines(&key) else {
                baked.missing_text.push(key);
                continue;
            };
            // The glyphs with their paints (a span's own, else the text's visible fills).
            let node_fills: Vec<Paint> = node
                .fills
                .as_slice()
                .iter()
                .filter(|p| p.visible())
                .cloned()
                .collect();
            let strokes: Vec<Paint> = if node.stroke_weight > 0.0 {
                node.strokes
                    .as_slice()
                    .iter()
                    .filter(|p| p.visible())
                    .cloned()
                    .collect()
            } else {
                Vec::new()
            };
            let mut drawn: Vec<(BezPath, Vec<Paint>)> = Vec::new();
            let mut bounds: Option<Rect> = None;
            for outline in outlines {
                if outline.path.elements().is_empty() {
                    continue;
                }
                let b = outline.path.bounding_box();
                bounds = Some(bounds.map_or(b, |a| a.union(b)));
                let paints = match &outline.paint {
                    Some(p) => vec![store_paint(p, document)],
                    None => node_fills.clone(),
                };
                drawn.push((outline.path, paints));
            }
            let Some(glyphs) = bounds else {
                // An empty text (spaces only): a sprite of nothing, so the painter stops asking.
                sprites.push((
                    id,
                    Sprite {
                        scale,
                        rect: Rect::new(0.0, 0.0, node.width.max(1.0), node.height.max(1.0)),
                        picture: std::sync::Arc::new(Picture::flat(1, 1, vec![0; 4])),
                        revision: 0,
                    },
                ));
                baked.sprites += 1;
                continue;
            };
            let outset = if strokes.is_empty() {
                1.0
            } else {
                node.stroke_weight + 1.0
            };
            let rect = glyphs
                .union(Rect::new(
                    0.0,
                    0.0,
                    node.width.max(0.0),
                    node.height.max(0.0),
                ))
                .inflate(outset, outset);
            let width = (rect.width() * scale).ceil().max(1.0);
            let height = (rect.height() * scale).ceil().max(1.0);
            if width * height > MAX_SPRITE_PIXELS || width > 16384.0 || height > 16384.0 {
                baked.missing_text.push(key);
                continue;
            }
            let (width, height) = (width as u32, height as u32);
            let target = Target {
                base: Affine::scale(scale) * Affine::translate((-rect.x0, -rect.y0)),
                scale,
                clip: Rect::new(0.0, 0.0, width as f64, height as f64),
            };
            let t = target.base;
            let pc = PaintCtx {
                width: node.width,
                height: node.height,
                region: rect,
            };
            let mut backend = CpuBackend::new(threads);
            let mut recorder = Recorder::new(&mut backend, width, height, Color::TRANSPARENT);
            for (path, paints) in &drawn {
                let refs: Vec<&Paint> = paints.iter().collect();
                painter.with_paints(
                    &mut recorder,
                    &target,
                    &refs,
                    &pc,
                    t,
                    1.0,
                    NORMAL,
                    &mut |sink: &mut dyn Sink, brush| sink.fill(t, Fill::NonZero, brush, path),
                );
                if !strokes.is_empty() {
                    let stroke = Stroke::new(node.stroke_weight);
                    let refs: Vec<&Paint> = strokes.iter().collect();
                    painter.with_paints(
                        &mut recorder,
                        &target,
                        &refs,
                        &pc,
                        t,
                        1.0,
                        NORMAL,
                        &mut |sink: &mut dyn Sink, brush| sink.stroke(t, &stroke, brush, path),
                    );
                }
            }
            let recording = recorder.into_recording();
            let rgba = unpremultiplied(backend.render_pixels(&recording));
            sprites.push((
                id,
                Sprite {
                    scale,
                    rect,
                    picture: std::sync::Arc::new(Picture::flat(width, height, rgba)),
                    revision: 0,
                },
            ));
            baked.sprites += 1;
        }
    }
    for (id, sprite) in sprites {
        doc.set_sprite(id, sprite);
    }
    baked
}

/// A finished raster.
#[derive(Debug)]
pub struct Rendered {
    pub width: u32,
    pub height: u32,
    /// Straight-alpha RGBA8, row-major.
    pub rgba: Vec<u8>,
    /// Device px per page px actually used (lowered to fit `max_side`).
    pub scale: f64,
    /// The page rectangle drawn.
    pub area: Rect,
    pub counters: Counters,
    pub sprites: usize,
    /// Texts drawn without glyphs (no face loaded for their family).
    pub missing_text: Vec<String>,
}

/// The page a node belongs to.
pub fn page_of(doc: &Document, id: Id) -> Option<Id> {
    let mut at = id;
    for _ in 0..10_000 {
        let node = doc.node(at)?;
        if node.kind == NodeType::Page {
            return Some(at);
        }
        at = node.parent?;
    }
    None
}

/// A root that exports exactly its box, as the browser's export does (export-raster.ts `exportBounds`: "Frames export
/// exactly their box (clipped, like an artboard); other layers export everything they paint").
fn exports_its_box(kind: NodeType) -> bool {
    matches!(
        kind,
        NodeType::Frame
            | NodeType::Component
            | NodeType::ComponentSet
            | NodeType::Instance
            | NodeType::Slice
    )
}

/// The page-space area an export of `ids` covers, the browser export's rule: a page's whole painted area, a
/// frame-like root's own box, another root's subtree bounds (a hidden one's box).
pub fn layers_area(doc: &mut RenderDoc, page: Id, ids: &[Id]) -> Option<Rect> {
    doc.sync_bounds(page);
    let mut area: Option<Rect> = None;
    for &id in ids {
        let own_box = || {
            let node = doc.document().node(id)?;
            let world = doc.world_matrix(id);
            Some(world.transform_rect_bbox(Rect::new(0.0, 0.0, node.width, node.height)))
        };
        let rect = if id == page {
            doc.page_area(page)
        } else if doc
            .document()
            .node(id)
            .is_some_and(|n| exports_its_box(n.kind))
        {
            own_box()
        } else {
            doc.bounds_of(id).or_else(own_box)
        };
        if let Some(r) = rect {
            if r.width().is_finite() && r.height().is_finite() {
                area = Some(area.map_or(r, |a| a.union(r)));
            }
        }
    }
    area.filter(|a| a.width() > 0.0 && a.height() > 0.0)
}

/// Renders `ids` (layers drawn together, or a page) at `scale` device px per page px, the longest side capped at
/// `max_side` (the scale is lowered to fit), over `background` (None: transparent). None when nothing is drawable:
/// no ids, unknown ids, or an empty area.
pub fn render_layers(
    doc: &mut RenderDoc,
    ids: &[Id],
    scale: f64,
    max_side: Option<u32>,
    background: Option<Color>,
    outliner: Option<&mut dyn TextOutliner>,
    threads: u16,
) -> Option<Rendered> {
    let &first = ids.first()?;
    let page = page_of(doc.document(), first)?;
    let area = layers_area(doc, page, ids)?;
    let mut scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };
    if let Some(max) = max_side.filter(|m| *m > 0) {
        let longest = area.width().max(area.height());
        scale = scale.min(max as f64 / longest);
    }
    // Rounded, as the browser's export sizes its canvas (`exportPixelSize`): the two pictures line up pixel for pixel.
    let width = (area.width() * scale).round().max(1.0);
    let height = (area.height() * scale).round().max(1.0);
    if width > u16::MAX as f64 || height > u16::MAX as f64 {
        return None;
    }
    let (width, height) = (width as u32, height as u32);
    let mut text = NoText;
    let outliner: &mut dyn TextOutliner = match outliner {
        Some(o) => o,
        None => &mut text,
    };
    let baked = bake_sprites(doc, page, area, scale, outliner, threads);
    let options = Options {
        paint_hidden_roots: true,
        root_opacity: 1.0,
        sprite_scale: scale,
        clip_to_ancestors: false,
        ..Options::default()
    };
    let mut backend = CpuBackend::new(threads);
    let painter = Painter::new(doc, &options);
    let target = Target {
        base: Affine::scale(scale) * Affine::translate((-area.x0, -area.y0)),
        scale,
        clip: Rect::new(0.0, 0.0, width as f64, height as f64),
    };
    let mut recorder = Recorder::new(
        &mut backend,
        width,
        height,
        background.unwrap_or(Color::TRANSPARENT),
    );
    painter.paint_roots(&mut recorder, &target, ids);
    let counters = painter.counters();
    let recording = recorder.into_recording();
    let rgba = unpremultiplied(backend.render_pixels(&recording));
    Some(Rendered {
        width,
        height,
        rgba,
        scale,
        area,
        counters,
        sprites: baked.sprites,
        missing_text: baked.missing_text,
    })
}
