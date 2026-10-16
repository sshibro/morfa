//! Renders a page of a document JSON through the CPU path to a PNG (a dev tool; the Node harness is the real one).
//!
//!   cargo run -p morfa-render --release --example render_fixture -- <doc.json> <page index> <scale> <out.png> [max side] [cpu|gpu]
//!
//! `gpu` (feature `gpu`) renders through vello on the first native adapter: lavapipe in the cloud, Metal on the Mac.
#![allow(clippy::chunks_exact_to_as_chunks)]

use kurbo::Rect;
use morfa_model::store::Document;
use morfa_render::cpu::{render_region, unpremultiplied};
use morfa_render::doc::RenderDoc;
use morfa_render::painter::Options;
use peniko::color::{AlphaColor, Srgb};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let json = std::fs::read_to_string(&args[0]).expect("document json");
    let page_index: usize = args.get(1).and_then(|v| v.parse().ok()).unwrap_or(0);
    let scale: f64 = args.get(2).and_then(|v| v.parse().ok()).unwrap_or(1.0);
    let out = args.get(3).cloned().unwrap_or_else(|| "out.png".into());
    let max_side: f64 = args.get(4).and_then(|v| v.parse().ok()).unwrap_or(4096.0);
    let t0 = Instant::now();
    let model = morfa_model::from_json(&json).expect("valid document");
    let doc = Document::from_model(&model);
    let mut render_doc = RenderDoc::new(doc);
    // Pictures: `ref=path.png` arguments after the engine.
    for arg in args.iter().skip(6) {
        let (image_ref, path) = arg.split_once('=').expect("ref=path.png");
        let decoder = png::Decoder::new(std::io::BufReader::new(
            std::fs::File::open(path).expect("picture"),
        ));
        let mut reader = decoder.read_info().expect("png");
        let mut buf = vec![0; reader.output_buffer_size().expect("png size")];
        let info = reader.next_frame(&mut buf).expect("png frame");
        let rgba = match info.color_type {
            png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
            png::ColorType::Rgb => buf[..info.buffer_size()]
                .chunks_exact(3)
                .flat_map(|p| [p[0], p[1], p[2], 255])
                .collect(),
            other => panic!("png colour type {other:?} not handled"),
        };
        render_doc.register_picture(image_ref, info.width, info.height, rgba);
    }
    let parse_ms = t0.elapsed().as_secs_f64() * 1e3;
    let pages = render_doc.page_ids();
    let page = pages[page_index];
    let t1 = Instant::now();
    let whole = render_doc
        .page_area(page)
        .unwrap_or(Rect::new(0.0, 0.0, 100.0, 100.0));
    let bounds_ms = t1.elapsed().as_secs_f64() * 1e3;
    // The goldens' framing: 2 px of page space around, snapped out, then the size cap from the top-left.
    let pad = 2.0;
    let x0 = (whole.x0 - pad).floor();
    let y0 = (whole.y0 - pad).floor();
    let full_w = (whole.x1 + pad).ceil() - x0;
    let full_h = (whole.y1 + pad).ceil() - y0;
    let width = (full_w * scale).ceil().min(max_side);
    let height = (full_h * scale).ceil().min(max_side);
    let mut area = Rect::new(x0, y0, x0 + width / scale, y0 + height / scale);
    // MORFA_RENDER_CROP=x0,y0,x1,y1 (page px) renders only that part.
    if let Ok(crop) = std::env::var("MORFA_RENDER_CROP") {
        let v: Vec<f64> = crop.split(',').filter_map(|t| t.parse().ok()).collect();
        if v.len() == 4 {
            area = Rect::new(v[0], v[1], v[2], v[3]);
        }
    }
    let page_node = render_doc.document().node(page).expect("page");
    let bg = page_node
        .props
        .background_color()
        .map(|c| AlphaColor::<Srgb>::new([c.r as f32, c.g as f32, c.b as f32, 1.0]))
        .unwrap_or(AlphaColor::<Srgb>::new([0.96, 0.96, 0.96, 1.0]));
    let options = Options {
        min_size: 0.5,
        root_opacity: 1.0,
        sprite_scale: scale,
        ..Options::default()
    };
    let engine = args.get(5).cloned().unwrap_or_else(|| "cpu".into());
    let t2 = Instant::now();
    let (w, h, pixels, counters) = if engine == "gpu" {
        render_gpu(&render_doc, &options, page, area, scale, bg)
    } else if engine == "tiled" {
        render_tiled(&render_doc, &options, page, area, scale, bg)
    } else {
        render_region(&render_doc, &options, page, area, scale, bg, 0)
    };
    let render_ms = t2.elapsed().as_secs_f64() * 1e3;
    let rgba = unpremultiplied(pixels);
    let file = std::fs::File::create(&out).expect("out");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .expect("png header")
        .write_image_data(&rgba)
        .expect("png data");
    println!(
        "{{\"width\":{w},\"height\":{h},\"parseMs\":{parse_ms:.1},\"boundsMs\":{bounds_ms:.1},\"renderMs\":{render_ms:.1},\"counters\":{counters:?}}}"
    );
}

#[cfg(feature = "gpu")]
fn render_gpu(
    doc: &RenderDoc,
    options: &Options,
    page: morfa_model::store::Id,
    area: Rect,
    scale: f64,
    bg: AlphaColor<Srgb>,
) -> (u32, u32, Vec<u8>, morfa_render::painter::Counters) {
    use morfa_render::gpu::{Gpu, GpuBackend, block_on};
    use morfa_render::painter::{Painter, Target};
    use morfa_render::record::Recorder;
    let width = (area.width() * scale).ceil().max(1.0) as u32;
    let height = (area.height() * scale).ceil().max(1.0) as u32;
    let gpu = Gpu::native().expect("a native adapter");
    eprintln!(
        "gpu: {} ({:?})",
        gpu.adapter_info.name, gpu.adapter_info.backend
    );
    let mut backend = GpuBackend::new(gpu).expect("vello renderer");
    let painter = Painter::new(doc, options);
    let target = Target {
        base: kurbo::Affine::scale(scale) * kurbo::Affine::translate((-area.x0, -area.y0)),
        scale,
        clip: Rect::new(0.0, 0.0, width as f64, height as f64),
    };
    let mut recorder = Recorder::new(&mut backend, width, height, bg);
    painter.paint_roots(&mut recorder, &target, &[page]);
    let counters = painter.counters();
    let recording = recorder.into_recording();
    let pixels = block_on(backend.render_pixels(&recording)).expect("gpu render");
    (width, height, pixels, counters)
}

/// The production path: 512 px tiles rasterized into the atlas (with the page's blur margin) and read back, stitched.
#[cfg(feature = "gpu")]
fn render_tiled(
    doc: &RenderDoc,
    options: &Options,
    page: morfa_model::store::Id,
    area: Rect,
    scale: f64,
    bg: AlphaColor<Srgb>,
) -> (u32, u32, Vec<u8>, morfa_render::painter::Counters) {
    use morfa_render::gpu::{Gpu, TILE, TileRenderer, block_on};
    let width = (area.width() * scale).ceil().max(1.0) as u32;
    let height = (area.height() * scale).ceil().max(1.0) as u32;
    let gpu = Gpu::native().expect("a native adapter");
    eprintln!(
        "gpu: {} ({:?}), tiled",
        gpu.adapter_info.name, gpu.adapter_info.backend
    );
    let mut tiles =
        TileRenderer::new(gpu, wgpu::TextureFormat::Rgba8Unorm, 4).expect("tile renderer");
    let margin = (doc.blur_margin(page) * scale).ceil().min(256.0) as u32;
    // Tile (i, j) covers device px [i·TILE, (i+1)·TILE) of the page at `scale`; the area's origin is at device
    // (area.x0·scale, area.y0·scale).
    let ox = area.x0 * scale;
    let oy = area.y0 * scale;
    let i0 = (ox / TILE as f64).floor() as i64;
    let j0 = (oy / TILE as f64).floor() as i64;
    let i1 = ((ox + width as f64 - 1e-6) / TILE as f64).floor() as i64;
    let j1 = ((oy + height as f64 - 1e-6) / TILE as f64).floor() as i64;
    let mut out = vec![0u8; (width * height * 4) as usize];
    let mut counters = morfa_render::painter::Counters::default();
    for j in j0..=j1 {
        for i in i0..=i1 {
            let c = tiles
                .raster_tile(doc, options, page, scale, i, j, 0, bg, margin)
                .expect("tile");
            counters.nodes += c.nodes;
            counters.effect_bitmaps += c.effect_bitmaps;
            counters.backdrops += c.backdrops;
            let pixels = block_on(tiles.read_tile(0));
            for ty in 0..TILE as i64 {
                let y = j * TILE as i64 + ty - oy.round() as i64;
                if y < 0 || y >= height as i64 {
                    continue;
                }
                for tx in 0..TILE as i64 {
                    let x = i * TILE as i64 + tx - ox.round() as i64;
                    if x < 0 || x >= width as i64 {
                        continue;
                    }
                    let s = ((ty * TILE as i64 + tx) * 4) as usize;
                    let d = ((y * width as i64 + x) * 4) as usize;
                    out[d..d + 4].copy_from_slice(&pixels[s..s + 4]);
                }
            }
        }
    }
    (width, height, out, counters)
}

#[cfg(not(feature = "gpu"))]
fn render_tiled(
    _doc: &RenderDoc,
    _options: &Options,
    _page: morfa_model::store::Id,
    _area: Rect,
    _scale: f64,
    _bg: AlphaColor<Srgb>,
) -> (u32, u32, Vec<u8>, morfa_render::painter::Counters) {
    panic!("built without the gpu feature: cargo run --features gpu …");
}

#[cfg(not(feature = "gpu"))]
fn render_gpu(
    _doc: &RenderDoc,
    _options: &Options,
    _page: morfa_model::store::Id,
    _area: Rect,
    _scale: f64,
    _bg: AlphaColor<Srgb>,
) -> (u32, u32, Vec<u8>, morfa_render::painter::Counters) {
    panic!("built without the gpu feature: cargo run --features gpu …");
}
