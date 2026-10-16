//! What the painter draws into. Every call is in device space (the painter folds the page → device transform in);
//! a backend (vello_cpu, vello on wgpu) turns it into its own scene. The effect passes (shadows of non-rectangles,
//! inner shadows, layer blur, background blur) go through [`Sink::effect_bitmap`] and [`Sink::backdrop`]: a nested
//! drawing rendered to a transparent bitmap, blurred, handed back as an image the painter then draws.

use kurbo::{Affine, BezPath, Rect, Stroke};
use peniko::{BlendMode, Color, Fill, Gradient};
use std::sync::Arc;

/// A decoded picture (straight alpha RGBA8) with its half-size levels (`blur::downsample_half`), shared between the
/// document and the backends.
#[derive(Debug)]
pub struct Picture {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<Vec<u8>>,
    /// Level k is 1/2^k of the natural size (level 0 is the picture itself).
    pub levels: Vec<Level>,
    /// A stable id for the backends' caches.
    pub id: u64,
}

#[derive(Debug, Clone)]
pub struct Level {
    pub width: u32,
    pub height: u32,
    pub rgba: Arc<Vec<u8>>,
}

static PICTURE_IDS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

impl Picture {
    /// A picture with its mips (built once, when the picture is registered).
    pub fn new(width: u32, height: u32, rgba: Vec<u8>) -> Picture {
        let rgba = Arc::new(rgba);
        let mut levels = vec![Level {
            width,
            height,
            rgba: Arc::clone(&rgba),
        }];
        let (mut w, mut h) = (width as usize, height as usize);
        let mut data: Arc<Vec<u8>> = Arc::clone(&rgba);
        while w >= 4 && h >= 4 && levels.len() < 12 {
            let (next, nw, nh) = crate::blur::downsample_half(&data, w, h);
            data = Arc::new(next);
            w = nw;
            h = nh;
            levels.push(Level {
                width: w as u32,
                height: h as u32,
                rgba: Arc::clone(&data),
            });
        }
        Picture {
            width,
            height,
            rgba,
            levels,
            id: PICTURE_IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// A picture without mips (a text sprite: drawn at the scale it was painted at).
    pub fn flat(width: u32, height: u32, rgba: Vec<u8>) -> Picture {
        let rgba = Arc::new(rgba);
        Picture {
            width,
            height,
            rgba: Arc::clone(&rgba),
            levels: vec![Level {
                width,
                height,
                rgba,
            }],
            id: PICTURE_IDS.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// The level to draw at `scale` device px per picture px (`mipLevel` of image-math.ts).
    pub fn level_for(&self, scale: f64) -> usize {
        if !(scale > 0.0) || scale >= 0.5 {
            return 0;
        }
        let mut level = (1.0 / scale).log2().floor() as usize;
        while level > 0 && ((self.width >> level) < 2 || (self.height >> level) < 2) {
            level -= 1;
        }
        level.min(self.levels.len() - 1)
    }

    pub fn bytes(&self) -> usize {
        self.levels.iter().map(|l| l.rgba.len()).sum()
    }
}

/// A bitmap the backend holds (an effect pass result, a text sprite, a picture level): drawn by handle.
pub type Handle = u32;

/// What fills a path.
pub enum BrushSpec<'a> {
    Solid(Color),
    /// A peniko gradient in its unit frame and the transform taking that frame to device space.
    Gradient(&'a Gradient, Affine),
    /// A picture level by `Picture::id` and level, `transform` taking picture px to device space.
    Picture {
        picture: &'a Arc<Picture>,
        level: usize,
        transform: Affine,
        repeat: bool,
        alpha: f32,
    },
    /// A backend bitmap (`Handle`), `transform` taking bitmap px to device space.
    Bitmap {
        handle: Handle,
        transform: Affine,
        alpha: f32,
    },
}

/// A clip for a layer: the shape in device space through `transform`.
pub struct Clip<'a> {
    pub transform: Affine,
    pub rule: Fill,
    pub path: &'a BezPath,
}

/// The drawing target of the painter. Coordinates are device px of the current target (a tile, an effect bitmap).
pub trait Sink {
    /// The target's pixel size.
    fn size(&self) -> (u32, u32);

    fn fill(&mut self, transform: Affine, rule: Fill, brush: &BrushSpec<'_>, path: &BezPath);
    fn stroke(&mut self, transform: Affine, stroke: &Stroke, brush: &BrushSpec<'_>, path: &BezPath);
    fn fill_rect(&mut self, transform: Affine, brush: &BrushSpec<'_>, rect: Rect) {
        self.fill(
            transform,
            Fill::NonZero,
            brush,
            &kurbo::Shape::to_path(&rect, 0.1),
        );
    }

    /// A layer composited with `blend` and `alpha` when popped, clipped to `clip` (or the whole target).
    fn push_layer(&mut self, blend: BlendMode, alpha: f32, clip: Option<Clip<'_>>);
    fn pop_layer(&mut self);

    /// Content drawn in `content` masked by what `mask` draws: by its alpha, or its luminance.
    fn mask_group(
        &mut self,
        luminance: bool,
        content: &mut dyn FnMut(&mut dyn Sink),
        mask: &mut dyn FnMut(&mut dyn Sink),
    );

    /// A rounded rectangle (one radius) blurred by σ device px, in `color`: the analytic shadow both engines have.
    fn blurred_rect(
        &mut self,
        transform: Affine,
        rect: Rect,
        radius: f64,
        sigma: f64,
        color: Color,
    );

    /// Renders `draw` into a transparent bitmap of `width` × `height` device px, blurs it by `sigma` device px
    /// (0: no blur), and hands it back as a bitmap to draw. None when the backend cannot (too large).
    fn effect_bitmap(
        &mut self,
        width: u32,
        height: u32,
        sigma: f64,
        draw: &mut dyn FnMut(&mut dyn Sink),
    ) -> Option<Handle>;

    /// What is drawn so far under the device rectangle, blurred by `sigma` (background blur). The bitmap covers
    /// exactly `rect` (its origin is the rect's top-left).
    fn backdrop(&mut self, rect: Rect, sigma: f64) -> Option<Handle>;

    /// A bitmap of straight-alpha RGBA8 pixels (text sprites), kept until released.
    fn upload(&mut self, width: u32, height: u32, rgba: &[u8]) -> Handle;

    /// Frees a bitmap made by `effect_bitmap`, `backdrop` or `upload`.
    fn release(&mut self, handle: Handle);

    /// Pixel size of a bitmap.
    fn bitmap_size(&self, handle: Handle) -> (u32, u32);

    /// Draws a whole bitmap through `brush` (a `BrushSpec::Bitmap` of the same handle): its footprint under
    /// `transform` (bitmap px → device).
    fn fill_bitmap(&mut self, handle: Handle, transform: Affine, brush: &BrushSpec<'_>) {
        let (w, h) = self.bitmap_size(handle);
        self.fill(
            transform,
            Fill::NonZero,
            brush,
            &kurbo::Shape::to_path(&Rect::new(0.0, 0.0, w as f64, h as f64), 0.1),
        );
    }

    /// Largest bitmap the backend makes for one effect (px²).
    fn max_bitmap_pixels(&self) -> u64 {
        16 * 1024 * 1024
    }
}
