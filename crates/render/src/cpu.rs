//! The CPU path: recordings replayed into `vello_cpu` (sparse strips; the server's exports and thumbnails, the Node
//! tests against the goldens). Bitmaps are `Pixmap`s registered in the context's image registry; the blur is
//! [`crate::blur`] on the CPU.

use crate::blur::blur_premultiplied;
use crate::record::{Backend, Brush, Op, Recording};
use crate::sink::{Handle, Picture};
use kurbo::{Affine, Rect};
use peniko::{BlendMode, Color, Compose, Extend, ImageSampler, Mix};
use std::collections::HashMap;
use std::sync::Arc;
use vello_common::mask::Mask;
use vello_common::paint::{Image, ImageId, ImageSource, PaintType};
use vello_common::pixmap::{PixelMetadata, Pixmap};
use vello_cpu::{RenderContext, RenderSettings, Resources};

/// The CPU backend: one image registry shared by every render, bitmaps by handle.
pub struct CpuBackend {
    resources: Resources,
    bitmaps: HashMap<Handle, Arc<Pixmap>>,
    /// Picture levels registered once, by (picture id, level).
    pictures: HashMap<(u64, usize), ImageId>,
    /// A blurred bitmap is re-registered under a new id; its handle keeps pointing at it.
    aliases: HashMap<Handle, ImageId>,
    threads: u16,
}

impl Default for CpuBackend {
    fn default() -> Self {
        CpuBackend::new(0)
    }
}

impl CpuBackend {
    /// `threads` 0 renders on the calling thread (and is what the wasm build does).
    pub fn new(threads: u16) -> CpuBackend {
        CpuBackend {
            resources: Resources::new(),
            bitmaps: HashMap::new(),
            pictures: HashMap::new(),
            aliases: HashMap::new(),
            threads,
        }
    }

    fn register(&mut self, pixmap: Pixmap) -> Handle {
        let pixmap = Arc::new(pixmap);
        let id = self.resources.register_image(Arc::clone(&pixmap));
        self.bitmaps.insert(id.as_u32(), pixmap);
        id.as_u32()
    }

    fn picture_id(&mut self, picture: &Arc<Picture>, level: usize) -> ImageId {
        let key = (picture.id, level);
        if let Some(id) = self.pictures.get(&key) {
            return *id;
        }
        let l = &picture.levels[level.min(picture.levels.len() - 1)];
        let pixmap = Pixmap::from_parts(
            l.rgba.as_ref().clone(),
            l.width.min(u16::MAX as u32) as u16,
            l.height.min(u16::MAX as u32) as u16,
            PixelMetadata {
                may_have_transparency: true,
                alpha_type: peniko::ImageAlphaType::Alpha,
            },
        );
        let id = self.resources.register_image(Arc::new(pixmap));
        self.pictures.insert(key, id);
        id
    }

    /// Renders a recording and returns its premultiplied RGBA8 pixels.
    pub fn render_pixels(&mut self, recording: &Recording) -> Vec<u8> {
        let mut ctx = self.context(recording.width, recording.height);
        self.replay(&mut ctx, recording);
        let mut target = Pixmap::new(recording.width as u16, recording.height as u16);
        ctx.flush();
        ctx.render(&mut target, &mut self.resources);
        self.finish(recording);
        target.data_as_u8_slice().to_vec()
    }

    fn context(&self, width: u32, height: u32) -> RenderContext {
        let settings = RenderSettings {
            num_threads: self.threads,
            ..RenderSettings::default()
        };
        RenderContext::new_with(width as u16, height as u16, settings)
    }

    fn paint_of(
        &mut self,
        brush: &Brush,
        transform: Affine,
    ) -> (PaintType, Option<Affine>, Option<f32>) {
        match brush {
            Brush::Solid(c) => (PaintType::Solid(*c), None, None),
            Brush::Gradient(g, t) => (
                PaintType::Gradient(g.clone()),
                Some(transform.inverse() * *t),
                None,
            ),
            Brush::Picture {
                picture,
                level,
                transform: t,
                repeat,
                alpha,
            } => {
                let id = self.picture_id(picture, *level);
                let sampler = ImageSampler::default().with_extend(if *repeat {
                    Extend::Repeat
                } else {
                    Extend::Pad
                });
                let image = Image {
                    image: ImageSource::OpaqueId {
                        id,
                        may_have_transparency: true,
                    },
                    sampler,
                };
                (
                    PaintType::Image(image),
                    Some(transform.inverse() * *t),
                    (*alpha < 1.0).then_some(*alpha),
                )
            }
            Brush::Bitmap {
                handle,
                transform: t,
                alpha,
            } => {
                let id = self
                    .aliases
                    .get(handle)
                    .copied()
                    .unwrap_or(ImageId::new(*handle));
                let image = Image {
                    image: ImageSource::OpaqueId {
                        id,
                        may_have_transparency: true,
                    },
                    sampler: ImageSampler::default().with_extend(Extend::Pad),
                };
                (
                    PaintType::Image(image),
                    Some(transform.inverse() * *t),
                    (*alpha < 1.0).then_some(*alpha),
                )
            }
        }
    }

    fn replay(&mut self, ctx: &mut RenderContext, recording: &Recording) {
        if recording.base.components[3] > 0.0 {
            ctx.set_transform(Affine::IDENTITY);
            ctx.reset_paint_transform();
            ctx.set_paint(PaintType::Solid(recording.base));
            ctx.fill_rect(&Rect::new(
                0.0,
                0.0,
                recording.width as f64,
                recording.height as f64,
            ));
        }
        self.replay_ops(ctx, &recording.ops, recording.width, recording.height);
    }

    fn replay_ops(&mut self, ctx: &mut RenderContext, ops: &[Op], width: u32, height: u32) {
        for op in ops {
            match op {
                Op::Fill {
                    transform,
                    rule,
                    brush,
                    path,
                } => {
                    let (paint, paint_t, alpha) = self.paint_of(brush, *transform);
                    if let Some(alpha) = alpha {
                        ctx.push_layer(None, None, Some(alpha), None, None);
                    }
                    ctx.set_transform(*transform);
                    match paint_t {
                        Some(t) => ctx.set_paint_transform(t),
                        None => ctx.reset_paint_transform(),
                    }
                    ctx.set_paint(paint);
                    ctx.set_fill_rule(*rule);
                    ctx.fill_path(path);
                    if alpha.is_some() {
                        ctx.pop_layer();
                    }
                }
                Op::Stroke {
                    transform,
                    stroke,
                    brush,
                    path,
                } => {
                    let (paint, paint_t, alpha) = self.paint_of(brush, *transform);
                    if let Some(alpha) = alpha {
                        ctx.push_layer(None, None, Some(alpha), None, None);
                    }
                    ctx.set_transform(*transform);
                    match paint_t {
                        Some(t) => ctx.set_paint_transform(t),
                        None => ctx.reset_paint_transform(),
                    }
                    ctx.set_paint(paint);
                    ctx.set_stroke(stroke.clone());
                    ctx.stroke_path(path);
                    if alpha.is_some() {
                        ctx.pop_layer();
                    }
                }
                Op::PushLayer { blend, alpha, clip } => {
                    let blend_mode = (*blend
                        != BlendMode {
                            mix: Mix::Normal,
                            compose: Compose::SrcOver,
                        })
                    .then_some(*blend);
                    let opacity = (*alpha < 1.0).then_some(*alpha);
                    match clip {
                        Some((t, rule, path)) => {
                            ctx.set_transform(*t);
                            ctx.set_fill_rule(*rule);
                            ctx.push_layer(Some(path), blend_mode, opacity, None, None);
                        }
                        None => ctx.push_layer(None, blend_mode, opacity, None, None),
                    }
                }
                Op::PopLayer => ctx.pop_layer(),
                Op::MaskGroup {
                    luminance,
                    content,
                    mask,
                } => {
                    // The mask drawn alone into a full-size pixmap, then the content through it.
                    let mut mask_ctx = self.context(width, height);
                    self.replay_ops(&mut mask_ctx, mask, width, height);
                    let mut pixmap = Pixmap::new(width as u16, height as u16);
                    mask_ctx.flush();
                    mask_ctx.render(&mut pixmap, &mut self.resources);
                    let mask = if *luminance {
                        Mask::new_luminance(&pixmap)
                    } else {
                        Mask::new_alpha(&pixmap)
                    };
                    ctx.push_layer(None, None, None, Some(mask), None);
                    self.replay_ops(ctx, content, width, height);
                    ctx.pop_layer();
                }
                Op::BlurredRect {
                    transform,
                    rect,
                    radius,
                    sigma,
                    color,
                } => {
                    ctx.set_transform(*transform);
                    ctx.reset_paint_transform();
                    ctx.set_paint(PaintType::Solid(*color));
                    ctx.fill_blurred_rounded_rect(
                        rect,
                        *radius as f32,
                        (*sigma).max(0.01) as f32,
                        false,
                    );
                }
            }
        }
    }
}

impl Backend for CpuBackend {
    fn render(&mut self, recording: &Recording) -> Option<Handle> {
        if recording.width == 0
            || recording.height == 0
            || recording.width > u16::MAX as u32
            || recording.height > u16::MAX as u32
        {
            return None;
        }
        let mut ctx = self.context(recording.width, recording.height);
        self.replay(&mut ctx, recording);
        let mut target = Pixmap::new(recording.width as u16, recording.height as u16);
        ctx.flush();
        ctx.render(&mut target, &mut self.resources);
        Some(self.register(target))
    }

    fn blur(&mut self, handle: Handle, sigma: f64) {
        let Some(pixmap) = self.bitmaps.get(&handle) else {
            return;
        };
        let (w, h) = (pixmap.width() as usize, pixmap.height() as usize);
        let mut data = pixmap.data_as_u8_slice().to_vec();
        blur_premultiplied(&mut data, w, h, sigma);
        let blurred = Pixmap::from_parts(
            data,
            w as u16,
            h as u16,
            PixelMetadata {
                may_have_transparency: true,
                alpha_type: peniko::ImageAlphaType::AlphaPremultiplied,
            },
        );
        let arc = Arc::new(blurred);
        let old = self.aliases.remove(&handle).unwrap_or(ImageId::new(handle));
        self.resources.destroy_image(old);
        // Re-register under a fresh id and alias the old handle to it.
        let id = self.resources.register_image(Arc::clone(&arc));
        self.bitmaps.remove(&handle);
        self.bitmaps.insert(handle, Arc::clone(&arc));
        self.aliases.insert(handle, id);
    }

    fn crop(&mut self, handle: Handle, rect: Rect) -> Option<Handle> {
        let pixmap = self.bitmaps.get(&handle)?;
        let (w, h) = (pixmap.width() as i64, pixmap.height() as i64);
        let x0 = (rect.x0.floor() as i64).clamp(0, w);
        let y0 = (rect.y0.floor() as i64).clamp(0, h);
        let x1 = (rect.x1.ceil() as i64).clamp(0, w);
        let y1 = (rect.y1.ceil() as i64).clamp(0, h);
        let cw = (x1 - x0).max(0) as usize;
        let ch = (y1 - y0).max(0) as usize;
        if cw == 0 || ch == 0 {
            return None;
        }
        let src = pixmap.data_as_u8_slice();
        let mut data = vec![0u8; cw * ch * 4];
        for y in 0..ch {
            let s = ((y0 as usize + y) * w as usize + x0 as usize) * 4;
            data[y * cw * 4..(y + 1) * cw * 4].copy_from_slice(&src[s..s + cw * 4]);
        }
        let out = Pixmap::from_parts(
            data,
            cw as u16,
            ch as u16,
            PixelMetadata {
                may_have_transparency: true,
                alpha_type: peniko::ImageAlphaType::AlphaPremultiplied,
            },
        );
        Some(self.register(out))
    }

    fn upload(&mut self, width: u32, height: u32, rgba: &[u8]) -> Handle {
        let pixmap = Pixmap::from_parts(
            rgba.to_vec(),
            width as u16,
            height as u16,
            PixelMetadata {
                may_have_transparency: true,
                alpha_type: peniko::ImageAlphaType::Alpha,
            },
        );
        self.register(pixmap)
    }

    fn release(&mut self, handle: Handle) {
        if let Some(id) = self.aliases.remove(&handle) {
            self.resources.destroy_image(id);
        } else {
            self.resources.destroy_image(ImageId::new(handle));
        }
        self.bitmaps.remove(&handle);
    }

    fn bitmap_size(&self, handle: Handle) -> (u32, u32) {
        self.bitmaps
            .get(&handle)
            .map(|p| (p.width() as u32, p.height() as u32))
            .unwrap_or((0, 0))
    }
}

/// Straight-alpha RGBA8 of a premultiplied render (PNGs, the goldens comparison).
pub fn unpremultiplied(mut premul: Vec<u8>) -> Vec<u8> {
    crate::blur::unpremultiply(&mut premul);
    premul
}

/// A page region rendered through the CPU path: `area` in page px at `scale` device px per page px.
pub fn render_region(
    doc: &crate::doc::RenderDoc,
    options: &crate::painter::Options,
    page: morfa_model::store::Id,
    area: Rect,
    scale: f64,
    background: Color,
    threads: u16,
) -> (u32, u32, Vec<u8>, crate::painter::Counters) {
    let width = (area.width() * scale).ceil().max(1.0) as u32;
    let height = (area.height() * scale).ceil().max(1.0) as u32;
    let mut backend = CpuBackend::new(threads);
    let painter = crate::painter::Painter::new(doc, options);
    let target = crate::painter::Target {
        base: Affine::scale(scale) * Affine::translate((-area.x0, -area.y0)),
        scale,
        clip: Rect::new(0.0, 0.0, width as f64, height as f64),
    };
    let mut recorder = crate::record::Recorder::new(&mut backend, width, height, background);
    painter.paint_roots(&mut recorder, &target, &[page]);
    let counters = painter.counters();
    let recording = recorder.into_recording();
    let pixels = backend.render_pixels(&recording);
    (width, height, pixels, counters)
}
