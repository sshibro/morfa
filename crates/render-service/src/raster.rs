//! Raster jobs — PNG/JPG/WebP at a scale and file-card thumbnails (TARGETS X1, X2, X5) — behind [`Rasterizer`].
//!
//! The pixels are lane L4's CPU renderer (`crates/render`, vello_cpu: the same painter as the canvas, so a
//! thumbnail and the canvas draw the same pixels) through [`crate::vello::Vello`]; a build without it runs with
//! [`Unavailable`], which refuses raster jobs with `501 render_raster_unavailable` (the api then keeps today's
//! paths: the editor's own raster export, the editor-posted thumbnail). The contract the adapter fills:
//!
//! - input: the document, the layers drawn together (`ids`, exportSvgPage's), device pixels per px (`scale`), a
//!   cap on the longest side (`max_side`, thumbnails 512 — the scale is lowered to fit), a background
//!   (`None`: transparent; JPG gets white, as export-raster.ts does), the job's pictures (decoded by the adapter)
//!   and the worker's fonts (lane L3's glyphs, the same faces the PDF embeds);
//! - output: straight-alpha RGBA8, row-major, `width × height` = ⌈bounds × scale⌉ of the layers' render bounds;
//! - limits: the 96 MP cap of one raster (PDF_EXPORT_LIMITS.rasterMegapixels) refuses with 413; the deadline is
//!   checked between tiles.
//!
//! Encoding is the service's: PNG (the `png` crate, as L5's PDF images use), JPG (`jpeg-encoder`: quality 92 by
//! default or the header's `quality`, 4:4:4) and WebP (`image-webp`: lossless, the only pure-Rust encoder;
//! `quality` is ignored).

use morfa_model::DesignDocument;

use crate::jobs::{Ctx, Output};
use crate::request::{Kind, Refusal};

/// What a raster job asks the renderer for.
pub struct RasterAsk<'a> {
    pub ids: &'a [String],
    pub scale: f64,
    pub max_side: Option<u32>,
    pub background: Option<[u8; 4]>,
}

/// Straight-alpha RGBA8.
pub struct Pixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// The CPU renderer behind raster jobs (lane L4's vello_cpu once merged).
pub trait Rasterizer: Send + Sync {
    fn render(
        &self,
        doc: &DesignDocument,
        ask: &RasterAsk,
        ctx: &mut Ctx,
    ) -> Result<Pixels, Refusal>;
    /// Whether this renderer draws (`/healthz` says so; the api routes raster jobs only then).
    fn available(&self) -> bool {
        true
    }
}

/// No renderer in this build: raster jobs are refused, the api keeps today's raster paths.
pub struct Unavailable;

impl Rasterizer for Unavailable {
    fn render(&self, _: &DesignDocument, _: &RasterAsk, _: &mut Ctx) -> Result<Pixels, Refusal> {
        Err(unavailable())
    }
    fn available(&self) -> bool {
        false
    }
}

fn unavailable() -> Refusal {
    Refusal::new(
        501,
        "render_raster_unavailable",
        "raster export needs lane L4's renderer (crates/render), not in this build",
    )
}

pub fn run(doc: &DesignDocument, ctx: &mut Ctx) -> Result<Output, Refusal> {
    let header = ctx.header;
    let thumbnail = header.kind == Kind::Thumbnail;
    let ask = RasterAsk {
        ids: &header.ids,
        scale: header.scale.unwrap_or(1.0),
        max_side: header.max_side.or(thumbnail.then_some(512)),
        background: (header.kind == Kind::Jpeg).then_some([255, 255, 255, 255]),
    };
    let rasterizer = ctx.rasterizer;
    let pixels = rasterizer.render(doc, &ask, ctx)?;
    let max = ctx.limits.raster_megapixels * 1e6;
    if pixels.width as f64 * pixels.height as f64 > max {
        return Err(Refusal::too_large(
            "the raster is larger than one export may be",
        ));
    }
    let (body, content_type) = match header.kind {
        Kind::Png | Kind::Thumbnail => (encode_png(&pixels)?, "image/png"),
        Kind::Jpeg => (
            encode_jpeg(&pixels, header.quality.unwrap_or(92))?,
            "image/jpeg",
        ),
        Kind::Webp => (encode_webp(&pixels)?, "image/webp"),
        Kind::Pdf | Kind::Svg => unreachable!("not a raster kind"),
    };
    let mut out = Output::new(body, content_type);
    out.pages = 1;
    out.rasters = 1;
    out.raster_pixels = pixels.width as u64 * pixels.height as u64;
    Ok(out)
}

/// JPEG at `quality` (1–100), 4:4:4; the pixels are opaque already (the job's white background).
pub fn encode_jpeg(pixels: &Pixels, quality: u8) -> Result<Vec<u8>, Refusal> {
    let failed =
        |e: jpeg_encoder::EncodingError| Refusal::new(500, "render_failed", format!("jpeg: {e}"));
    if pixels.width > u16::MAX as u32 || pixels.height > u16::MAX as u32 {
        return Err(Refusal::too_large("a JPEG side is at most 65 535 px"));
    }
    let mut out = Vec::new();
    let mut encoder = jpeg_encoder::Encoder::new(&mut out, quality.clamp(1, 100));
    encoder.set_sampling_factor(jpeg_encoder::SamplingFactor::F_1_1);
    encoder
        .encode(
            &pixels.rgba,
            pixels.width as u16,
            pixels.height as u16,
            jpeg_encoder::ColorType::Rgba,
        )
        .map_err(failed)?;
    Ok(out)
}

/// Lossless WebP.
pub fn encode_webp(pixels: &Pixels) -> Result<Vec<u8>, Refusal> {
    let failed =
        |e: image_webp::EncodingError| Refusal::new(500, "render_failed", format!("webp: {e}"));
    let mut out = Vec::new();
    image_webp::WebPEncoder::new(&mut out)
        .encode(
            &pixels.rgba,
            pixels.width,
            pixels.height,
            image_webp::ColorType::Rgba8,
        )
        .map_err(failed)?;
    Ok(out)
}

pub fn encode_png(pixels: &Pixels) -> Result<Vec<u8>, Refusal> {
    let failed = |e: png::EncodingError| Refusal::new(500, "render_failed", format!("png: {e}"));
    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, pixels.width, pixels.height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut writer = encoder.write_header().map_err(failed)?;
        writer.write_image_data(&pixels.rgba).map_err(failed)?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn png_round_trip() {
        let pixels = Pixels {
            width: 2,
            height: 1,
            rgba: vec![255, 0, 0, 255, 0, 0, 255, 128],
        };
        let bytes = encode_png(&pixels).unwrap();
        let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
        let mut reader = decoder.read_info().unwrap();
        let mut buf = vec![0; reader.output_buffer_size()];
        let info = reader.next_frame(&mut buf).unwrap();
        assert_eq!((info.width, info.height), (2, 1));
        assert_eq!(&buf[..8], &pixels.rgba[..]);
    }
}
