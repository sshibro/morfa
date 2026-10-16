//! The display list: the painter's device-space drawing recorded as [`Op`]s, replayed by a [`Backend`]. Recording
//! first (instead of encoding straight into an engine scene) is what makes the two passes the engines lack
//! possible on both: an effect bitmap is a nested recording rendered at once, and a backdrop (background blur)
//! is the recording so far rendered into a scratch target, with the layers still open closed for that render.

use crate::sink::{BrushSpec, Clip, Handle, Picture, Sink};
use kurbo::{Affine, BezPath, Rect, Shape, Stroke};
use peniko::{BlendMode, Color, Compose, Fill, Gradient, Mix};
use std::sync::Arc;

/// What fills a path, owned.
#[derive(Clone, Debug)]
pub enum Brush {
    Solid(Color),
    /// The gradient in its unit frame and the transform taking that frame to device space.
    Gradient(Gradient, Affine),
    /// A picture level; `transform` takes level px to device space.
    Picture {
        picture: Arc<Picture>,
        level: usize,
        transform: Affine,
        repeat: bool,
        alpha: f32,
    },
    /// A backend bitmap; `transform` takes bitmap px to device space.
    Bitmap {
        handle: Handle,
        transform: Affine,
        alpha: f32,
    },
}

#[derive(Clone, Debug)]
pub enum Op {
    Fill {
        transform: Affine,
        rule: Fill,
        brush: Brush,
        path: BezPath,
    },
    Stroke {
        transform: Affine,
        stroke: Stroke,
        brush: Brush,
        path: BezPath,
    },
    PushLayer {
        blend: BlendMode,
        alpha: f32,
        clip: Option<(Affine, Fill, BezPath)>,
    },
    PopLayer,
    /// `content` masked by what `mask` draws (its alpha, or its luminance).
    MaskGroup {
        luminance: bool,
        content: Vec<Op>,
        mask: Vec<Op>,
    },
    BlurredRect {
        transform: Affine,
        rect: Rect,
        radius: f64,
        sigma: f64,
        color: Color,
    },
}

/// A recording with its target size and base colour.
#[derive(Clone, Debug)]
pub struct Recording {
    pub width: u32,
    pub height: u32,
    pub base: Color,
    pub ops: Vec<Op>,
    /// Bitmaps the painter is done with, freed once the recording has been rendered (its ops reference them).
    pub pending_release: Vec<Handle>,
}

impl Recording {
    pub fn new(width: u32, height: u32, base: Color) -> Recording {
        Recording {
            width,
            height,
            base,
            ops: Vec::new(),
            pending_release: Vec::new(),
        }
    }

    /// The ops with every layer still open closed: what a mid-way render (a backdrop) draws.
    pub fn balanced(&self) -> Recording {
        let mut depth = 0i32;
        for op in &self.ops {
            match op {
                Op::PushLayer { .. } => depth += 1,
                Op::PopLayer => depth -= 1,
                _ => {}
            }
        }
        let mut ops = self.ops.clone();
        for _ in 0..depth.max(0) {
            ops.push(Op::PopLayer);
        }
        Recording {
            width: self.width,
            height: self.height,
            base: self.base,
            ops,
            pending_release: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.ops.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ops.is_empty()
    }
}

/// What renders recordings and keeps bitmaps: vello_cpu or vello on wgpu.
pub trait Backend {
    /// Renders a recording into a new bitmap of its size over its base colour (transparent for effects).
    fn render(&mut self, recording: &Recording) -> Option<Handle>;
    /// Blurs a bitmap in place by σ px (premultiplied).
    fn blur(&mut self, handle: Handle, sigma: f64);
    /// A copy of a bitmap's rectangle as a new bitmap.
    fn crop(&mut self, handle: Handle, rect: Rect) -> Option<Handle>;
    fn upload(&mut self, width: u32, height: u32, rgba: &[u8]) -> Handle;
    fn release(&mut self, handle: Handle);
    fn bitmap_size(&self, handle: Handle) -> (u32, u32);
    fn max_bitmap_pixels(&self) -> u64 {
        16 * 1024 * 1024
    }
    /// Frees the bitmaps a rendered recording no longer needs.
    fn finish(&mut self, recording: &Recording) {
        for &handle in &recording.pending_release {
            self.release(handle);
        }
    }
}

/// The painter's sink: records ops, and asks the backend for the passes the engines lack.
pub struct Recorder<'a, B: Backend> {
    pub recording: Recording,
    backend: &'a mut B,
}

impl<'a, B: Backend> Recorder<'a, B> {
    pub fn new(backend: &'a mut B, width: u32, height: u32, base: Color) -> Recorder<'a, B> {
        Recorder {
            recording: Recording::new(width, height, base),
            backend,
        }
    }

    pub fn backend(&mut self) -> &mut B {
        self.backend
    }

    pub fn into_recording(self) -> Recording {
        self.recording
    }

    fn brush_of(brush: &BrushSpec<'_>) -> Brush {
        match brush {
            BrushSpec::Solid(c) => Brush::Solid(*c),
            BrushSpec::Gradient(g, t) => Brush::Gradient((*g).clone(), *t),
            BrushSpec::Picture {
                picture,
                level,
                transform,
                repeat,
                alpha,
            } => Brush::Picture {
                picture: Arc::clone(picture),
                level: *level,
                transform: *transform,
                repeat: *repeat,
                alpha: *alpha,
            },
            BrushSpec::Bitmap {
                handle,
                transform,
                alpha,
            } => Brush::Bitmap {
                handle: *handle,
                transform: *transform,
                alpha: *alpha,
            },
        }
    }

    /// A non-repeating picture draws nothing outside its pixels: the fill is clipped to the level's footprint.
    fn footprint_clip(brush: &BrushSpec<'_>) -> Option<(Affine, Fill, BezPath)> {
        if std::env::var("MORFA_RENDER_NO_FOOTPRINT_CLIP").is_ok() {
            return None;
        }
        match brush {
            BrushSpec::Picture {
                picture,
                level,
                transform,
                repeat: false,
                ..
            } => {
                let l = &picture.levels[*level];
                Some((
                    *transform,
                    Fill::NonZero,
                    Rect::new(0.0, 0.0, l.width as f64, l.height as f64).to_path(0.1),
                ))
            }
            _ => None,
        }
    }

    fn with_clip(&mut self, clip: Option<(Affine, Fill, BezPath)>, op: Op) {
        match clip {
            Some(clip) => {
                self.recording.ops.push(Op::PushLayer {
                    blend: SRC_OVER,
                    alpha: 1.0,
                    clip: Some(clip),
                });
                self.recording.ops.push(op);
                self.recording.ops.push(Op::PopLayer);
            }
            None => self.recording.ops.push(op),
        }
    }
}

const SRC_OVER: BlendMode = BlendMode {
    mix: Mix::Normal,
    compose: Compose::SrcOver,
};

impl<B: Backend> Sink for Recorder<'_, B> {
    fn size(&self) -> (u32, u32) {
        (self.recording.width, self.recording.height)
    }

    fn fill(&mut self, transform: Affine, rule: Fill, brush: &BrushSpec<'_>, path: &BezPath) {
        let clip = Self::footprint_clip(brush);
        self.with_clip(
            clip,
            Op::Fill {
                transform,
                rule,
                brush: Self::brush_of(brush),
                path: path.clone(),
            },
        );
    }

    fn stroke(
        &mut self,
        transform: Affine,
        stroke: &Stroke,
        brush: &BrushSpec<'_>,
        path: &BezPath,
    ) {
        let clip = Self::footprint_clip(brush);
        self.with_clip(
            clip,
            Op::Stroke {
                transform,
                stroke: stroke.clone(),
                brush: Self::brush_of(brush),
                path: path.clone(),
            },
        );
    }

    fn push_layer(&mut self, blend: BlendMode, alpha: f32, clip: Option<Clip<'_>>) {
        self.recording.ops.push(Op::PushLayer {
            blend,
            alpha,
            clip: clip.map(|c| (c.transform, c.rule, c.path.clone())),
        });
    }

    fn pop_layer(&mut self) {
        self.recording.ops.push(Op::PopLayer);
    }

    fn mask_group(
        &mut self,
        luminance: bool,
        content: &mut dyn FnMut(&mut dyn Sink),
        mask: &mut dyn FnMut(&mut dyn Sink),
    ) {
        let (w, h, base) = (
            self.recording.width,
            self.recording.height,
            self.recording.base,
        );
        let mut inner = Recorder {
            recording: Recording::new(w, h, base),
            backend: self.backend,
        };
        content(&mut inner);
        let content_ops = inner.recording.ops;
        let mut inner = Recorder {
            recording: Recording::new(w, h, base),
            backend: self.backend,
        };
        mask(&mut inner);
        let mask_ops = inner.recording.ops;
        self.recording.ops.push(Op::MaskGroup {
            luminance,
            content: content_ops,
            mask: mask_ops,
        });
    }

    fn blurred_rect(
        &mut self,
        transform: Affine,
        rect: Rect,
        radius: f64,
        sigma: f64,
        color: Color,
    ) {
        self.recording.ops.push(Op::BlurredRect {
            transform,
            rect,
            radius,
            sigma,
            color,
        });
    }

    fn effect_bitmap(
        &mut self,
        width: u32,
        height: u32,
        sigma: f64,
        draw: &mut dyn FnMut(&mut dyn Sink),
    ) -> Option<Handle> {
        if width == 0
            || height == 0
            || (width as u64 * height as u64) > self.backend.max_bitmap_pixels()
        {
            return None;
        }
        let mut inner = Recorder {
            recording: Recording::new(width, height, Color::TRANSPARENT),
            backend: self.backend,
        };
        draw(&mut inner);
        let recording = inner.recording;
        let handle = self.backend.render(&recording);
        self.backend.finish(&recording);
        let handle = handle?;
        if sigma > 0.05 {
            self.backend.blur(handle, sigma);
        }
        Some(handle)
    }

    fn backdrop(&mut self, rect: Rect, sigma: f64) -> Option<Handle> {
        let whole = self.backend.render(&self.recording.balanced())?;
        let cropped = self.backend.crop(whole, rect);
        self.backend.release(whole);
        let cropped = cropped?;
        if sigma > 0.05 {
            self.backend.blur(cropped, sigma);
        }
        Some(cropped)
    }

    fn upload(&mut self, width: u32, height: u32, rgba: &[u8]) -> Handle {
        self.backend.upload(width, height, rgba)
    }

    fn release(&mut self, handle: Handle) {
        self.recording.pending_release.push(handle);
    }

    fn bitmap_size(&self, handle: Handle) -> (u32, u32) {
        self.backend.bitmap_size(handle)
    }

    fn max_bitmap_pixels(&self) -> u64 {
        self.backend.max_bitmap_pixels()
    }
}
