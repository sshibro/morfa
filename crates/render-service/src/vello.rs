//! Lane L4's CPU renderer behind [`Rasterizer`]: `crates/render` on vello_cpu — the same painter as the canvas,
//! so a thumbnail and the editor draw the same pixels. The job's pictures are decoded here (PNG, JPEG, WebP: the
//! formats the editor uploads) and registered with the render document; its text gets real glyphs through
//! crates/export's layout and lane L3's outlines (`morfa_export::svg::text_outlines`), from the worker's fonts —
//! the faces the job named, the ones the PDF embeds — baked into sprites by the renderer itself
//! (`morfa_render::server`).

use std::io::Cursor;
use std::time::Instant;

use morfa_export::fonts::Fonts;
use morfa_export::svg::text_outlines;
use morfa_model::DesignDocument;
use morfa_model::store::Document;
use morfa_render::doc::RenderDoc;
use morfa_render::peniko::Color;
use morfa_render::server::{Outline, TextOutliner, layers_area, page_of, path_of, render_layers};
use morfa_text::measure::Measurer;

use crate::jobs::{Ctx, timeout};
use crate::raster::{Pixels, RasterAsk, Rasterizer};
use crate::request::Refusal;

/// The vello_cpu renderer.
#[derive(Default)]
pub struct Vello;

/// Glyphs from the export's layout and the worker's fonts.
struct ExportText<'a> {
    doc: &'a DesignDocument,
    measurer: &'a mut dyn Measurer,
    fonts: &'a mut Fonts,
}

impl TextOutliner for ExportText<'_> {
    fn outlines(&mut self, key: &str) -> Option<Vec<Outline>> {
        let outlines = text_outlines(self.doc, key, self.measurer, self.fonts)?;
        let node = self.doc.nodes.get(key)?;
        Some(
            outlines
                .into_iter()
                .map(|o| Outline {
                    path: path_of(&o.commands),
                    paint: o.paint.map(|p| p.get(node).clone()),
                })
                .collect(),
        )
    }
}

/// A decoded picture: straight-alpha RGBA8.
pub struct Decoded {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// Decodes a PNG, JPEG or WebP (by signature); None for anything else or a broken file.
pub fn decode_picture(bytes: &[u8]) -> Option<Decoded> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        decode_png(bytes)
    } else if bytes.starts_with(&[0xFF, 0xD8]) {
        decode_jpeg(bytes)
    } else if bytes.len() > 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        decode_webp(bytes)
    } else {
        None
    }
}

fn decode_png(bytes: &[u8]) -> Option<Decoded> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let frame = reader.next_frame(&mut buf).ok()?;
    let data = &buf[..frame.buffer_size()];
    let (width, height) = (frame.width, frame.height);
    let n = (width as usize) * (height as usize);
    let rgba = match frame.color_type {
        png::ColorType::Rgba => data.to_vec(),
        png::ColorType::Rgb => {
            let mut out = Vec::with_capacity(n * 4);
            for px in data.as_chunks::<3>().0 {
                out.extend_from_slice(&[px[0], px[1], px[2], 255]);
            }
            out
        }
        png::ColorType::Grayscale => {
            let mut out = Vec::with_capacity(n * 4);
            for &g in data {
                out.extend_from_slice(&[g, g, g, 255]);
            }
            out
        }
        png::ColorType::GrayscaleAlpha => {
            let mut out = Vec::with_capacity(n * 4);
            for px in data.as_chunks::<2>().0 {
                out.extend_from_slice(&[px[0], px[0], px[0], px[1]]);
            }
            out
        }
        png::ColorType::Indexed => return None,
    };
    (rgba.len() == n * 4).then_some(Decoded {
        width,
        height,
        rgba,
    })
}

fn decode_jpeg(bytes: &[u8]) -> Option<Decoded> {
    use zune_jpeg::JpegDecoder;
    use zune_jpeg::zune_core::colorspace::ColorSpace;
    use zune_jpeg::zune_core::options::DecoderOptions;
    let options = DecoderOptions::default().jpeg_set_out_colorspace(ColorSpace::RGBA);
    let mut decoder = JpegDecoder::new_with_options(bytes, options);
    let rgba = decoder.decode().ok()?;
    let info = decoder.info()?;
    let (width, height) = (info.width as u32, info.height as u32);
    (rgba.len() == (width as usize) * (height as usize) * 4).then_some(Decoded {
        width,
        height,
        rgba,
    })
}

fn decode_webp(bytes: &[u8]) -> Option<Decoded> {
    let mut decoder = image_webp::WebPDecoder::new(Cursor::new(bytes)).ok()?;
    let (width, height) = decoder.dimensions();
    let mut buf = vec![0; decoder.output_buffer_size()?];
    decoder.read_image(&mut buf).ok()?;
    let n = (width as usize) * (height as usize);
    let rgba = if decoder.has_alpha() {
        buf
    } else {
        let mut out = Vec::with_capacity(n * 4);
        for px in buf.as_chunks::<3>().0 {
            out.extend_from_slice(&[px[0], px[1], px[2], 255]);
        }
        out
    };
    (rgba.len() == n * 4).then_some(Decoded {
        width,
        height,
        rgba,
    })
}

impl Rasterizer for Vello {
    fn render(
        &self,
        doc: &DesignDocument,
        ask: &RasterAsk,
        ctx: &mut Ctx,
    ) -> Result<Pixels, Refusal> {
        if Instant::now() >= ctx.deadline {
            return Err(timeout());
        }
        let mut rdoc = RenderDoc::new(Document::from(doc));
        let mut ids = Vec::with_capacity(ask.ids.len());
        for key in ask.ids {
            match rdoc.id(key) {
                Some(id) => ids.push(id),
                None => return Err(Refusal::invalid(format!("raster: unknown layer '{key}'"))),
            }
        }
        let Some(&first) = ids.first() else {
            return Err(Refusal::invalid("raster: no layers to draw"));
        };
        let page = page_of(rdoc.document(), first)
            .ok_or_else(|| Refusal::invalid("raster: the layer is on no page"))?;
        let area = layers_area(&mut rdoc, page, &ids)
            .ok_or_else(|| Refusal::invalid("raster: nothing to draw (an empty area)"))?;
        // The output's size before any pixel is drawn: the raster cap refuses here, not after the work.
        let mut scale = if ask.scale.is_finite() && ask.scale > 0.0 {
            ask.scale
        } else {
            1.0
        };
        if let Some(max) = ask.max_side.filter(|m| *m > 0) {
            scale = scale.min(max as f64 / area.width().max(area.height()));
        }
        let pixels =
            (area.width() * scale).ceil().max(1.0) * (area.height() * scale).ceil().max(1.0);
        if pixels > ctx.limits.raster_megapixels * 1e6 {
            return Err(Refusal::too_large(
                "the raster is larger than one export may be",
            ));
        }
        // The job's pictures, decoded once per job.
        for picture in &ctx.header.pictures {
            let Some(bytes) = ctx.pictures.bytes.get(&picture.href) else {
                continue;
            };
            match decode_picture(bytes) {
                Some(d) => rdoc.register_picture(&picture.image_ref, d.width, d.height, d.rgba),
                None => {
                    tracing::warn!(image_ref = %picture.image_ref, "a picture could not be decoded")
                }
            }
        }
        let background = ask
            .background
            .map(|[r, g, b, a]| Color::from_rgba8(r, g, b, a));
        // vello_cpu's thread count: 0 draws on the calling thread.
        let threads = ctx.threads.min(64) as u16;
        let threads = if threads <= 1 { 0 } else { threads };
        let (rendered, _) = ctx.with_measurer(|measurer, _, fonts| {
            let mut text = ExportText {
                doc,
                measurer,
                fonts,
            };
            render_layers(
                &mut rdoc,
                &ids,
                scale,
                ask.max_side,
                background,
                Some(&mut text),
                threads,
            )
        });
        let rendered =
            rendered.ok_or_else(|| Refusal::invalid("raster: nothing to draw (an empty area)"))?;
        if !rendered.missing_text.is_empty() {
            tracing::warn!(
                texts = rendered.missing_text.len(),
                "texts drawn without glyphs: no face of their family was loaded"
            );
        }
        if Instant::now() >= ctx.deadline {
            return Err(timeout());
        }
        Ok(Pixels {
            width: rendered.width,
            height: rendered.height,
            rgba: rendered.rgba,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_png_rgb_and_rgba() {
        let mut out = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut out, 2, 1);
            encoder.set_color(png::ColorType::Rgb);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer.write_image_data(&[255, 0, 0, 0, 0, 255]).unwrap();
        }
        let d = decode_picture(&out).unwrap();
        assert_eq!((d.width, d.height), (2, 1));
        assert_eq!(d.rgba, vec![255, 0, 0, 255, 0, 0, 255, 255]);
        assert!(decode_picture(b"not a picture").is_none());
    }

    #[test]
    fn decodes_jpeg_round_trip() {
        let mut out = Vec::new();
        let encoder = jpeg_encoder::Encoder::new(&mut out, 100);
        encoder
            .encode(
                &[200, 30, 30, 255, 200, 30, 30, 255],
                2,
                1,
                jpeg_encoder::ColorType::Rgba,
            )
            .unwrap();
        let d = decode_picture(&out).unwrap();
        assert_eq!((d.width, d.height), (2, 1));
        assert!(d.rgba[0] > 150 && d.rgba[1] < 80, "{:?}", &d.rgba[..4]);
    }

    #[test]
    fn decodes_webp_round_trip() {
        let mut out = Vec::new();
        image_webp::WebPEncoder::new(&mut out)
            .encode(
                &[1, 2, 3, 255, 4, 5, 6, 128],
                2,
                1,
                image_webp::ColorType::Rgba8,
            )
            .unwrap();
        let d = decode_picture(&out).unwrap();
        assert_eq!((d.width, d.height), (2, 1));
        assert_eq!(d.rgba, vec![1, 2, 3, 255, 4, 5, 6, 128]);
    }
}
