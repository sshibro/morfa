//! A probe of the backends with one picture drawn at three mip levels and one blurred bitmap, to PNGs.
//!   cargo run -p morfa-render --release --features gpu --example gpu_probe -- <out dir>
use kurbo::{Affine, Rect, Shape};
use morfa_render::record::Recorder;
use morfa_render::sink::{BrushSpec, Picture, Sink};
use peniko::Fill;
use peniko::color::{AlphaColor, Srgb};
use std::sync::Arc;

fn picture() -> Arc<Picture> {
    let (w, h) = (400u32, 300u32);
    let mut data = vec![0u8; (w * h * 4) as usize];
    for y in 0..h {
        for x in 0..w {
            let i = ((y * w + x) * 4) as usize;
            let stripe = (x / 25) % 2 == 0;
            data[i] = if stripe { 40 } else { 220 };
            data[i + 1] = (y * 255 / h) as u8;
            data[i + 2] = if stripe { 200 } else { 80 };
            data[i + 3] = 255;
        }
    }
    Arc::new(Picture::new(w, h, data))
}

fn draw(sink: &mut dyn Sink, picture: &Arc<Picture>) {
    // First use of levels 0 and 1 inside a nested render (an effect bitmap), as the fixture does.
    let l1 = &picture.levels[1];
    let nested = sink.effect_bitmap(100, 100, 0.0, &mut |inner: &mut dyn Sink| {
        let t = Affine::scale(100.0 / l1.width as f64);
        inner.fill(
            Affine::IDENTITY,
            Fill::NonZero,
            &BrushSpec::Picture {
                picture,
                level: 1,
                transform: t,
                repeat: false,
                alpha: 1.0,
            },
            &Rect::new(0.0, 0.0, 100.0, 75.0).to_path(0.1),
        );
        inner.fill(
            Affine::IDENTITY,
            Fill::NonZero,
            &BrushSpec::Picture {
                picture,
                level: 0,
                transform: Affine::scale(0.1),
                repeat: false,
                alpha: 1.0,
            },
            &Rect::new(0.0, 75.0, 40.0, 100.0).to_path(0.1),
        );
    });
    if let Some(nested) = nested {
        sink.fill_bitmap(
            nested,
            Affine::translate((700.0, 90.0)),
            &BrushSpec::Bitmap {
                handle: nested,
                transform: Affine::translate((700.0, 90.0)),
                alpha: 1.0,
            },
        );
        sink.release(nested);
    }
    for level in 0..3usize {
        let l = &picture.levels[level];
        let x = 20.0 + level as f64 * 220.0;
        let t = Affine::translate((x, 20.0)) * Affine::scale(200.0 / l.width as f64);
        let brush = BrushSpec::Picture {
            picture,
            level,
            transform: t,
            repeat: false,
            alpha: 1.0,
        };
        sink.fill(
            Affine::IDENTITY,
            Fill::NonZero,
            &brush,
            &Rect::new(x, 20.0, x + 200.0, 170.0).to_path(0.1),
        );
    }
    // A large blur (downsampled) and a shadow made of a silhouette bitmap through DEST_IN, as the painter does.
    for (k, sigma) in [12.0, 40.0].into_iter().enumerate() {
        let big = sink.effect_bitmap(160, 160, sigma, &mut |inner: &mut dyn Sink| {
            inner.fill(
                Affine::IDENTITY,
                Fill::NonZero,
                &BrushSpec::Solid(AlphaColor::<Srgb>::new([0.1, 0.3, 0.9, 1.0])),
                &Rect::new(50.0, 50.0, 110.0, 110.0).to_path(0.1),
            );
        });
        if let Some(big) = big {
            let at = Affine::translate((20.0 + k as f64 * 170.0, 190.0));
            sink.fill_bitmap(
                big,
                at,
                &BrushSpec::Bitmap {
                    handle: big,
                    transform: at,
                    alpha: 1.0,
                },
            );
            sink.release(big);
        }
    }
    let silhouette = sink.effect_bitmap(100, 100, 0.0, &mut |inner: &mut dyn Sink| {
        inner.fill(
            Affine::IDENTITY,
            Fill::NonZero,
            &BrushSpec::Solid(AlphaColor::<Srgb>::new([0.0, 0.0, 0.0, 1.0])),
            &Rect::new(20.0, 20.0, 80.0, 80.0).to_path(0.1),
        );
    });
    if let Some(silhouette) = silhouette {
        let shadow = sink.effect_bitmap(140, 140, 5.0, &mut |inner: &mut dyn Sink| {
            inner.push_layer(
                peniko::BlendMode::new(peniko::Mix::Normal, peniko::Compose::SrcOver),
                1.0,
                None,
            );
            inner.fill_rect(
                Affine::IDENTITY,
                &BrushSpec::Solid(AlphaColor::<Srgb>::new([0.9, 0.1, 0.5, 1.0])),
                Rect::new(0.0, 0.0, 140.0, 140.0),
            );
            inner.push_layer(
                peniko::BlendMode::new(peniko::Mix::Normal, peniko::Compose::DestIn),
                1.0,
                None,
            );
            inner.fill_bitmap(
                silhouette,
                Affine::translate((20.0, 20.0)),
                &BrushSpec::Bitmap {
                    handle: silhouette,
                    transform: Affine::translate((20.0, 20.0)),
                    alpha: 1.0,
                },
            );
            inner.pop_layer();
            inner.pop_layer();
        });
        if let Some(shadow) = shadow {
            let at = Affine::translate((380.0, 190.0));
            sink.fill_bitmap(
                shadow,
                at,
                &BrushSpec::Bitmap {
                    handle: shadow,
                    transform: at,
                    alpha: 1.0,
                },
            );
            sink.release(shadow);
        }
        sink.release(silhouette);
    }
    let handle = sink.effect_bitmap(120, 120, 6.0, &mut |inner: &mut dyn Sink| {
        inner.fill(
            Affine::IDENTITY,
            Fill::NonZero,
            &BrushSpec::Solid(AlphaColor::<Srgb>::new([0.9, 0.2, 0.1, 1.0])),
            &Rect::new(30.0, 30.0, 90.0, 90.0).to_path(0.1),
        );
    });
    if let Some(handle) = handle {
        let brush = BrushSpec::Bitmap {
            handle,
            transform: Affine::translate((680.0, 20.0)),
            alpha: 1.0,
        };
        sink.fill_bitmap(handle, Affine::translate((680.0, 20.0)), &brush);
        sink.release(handle);
    }
}

fn write(path: &str, w: u32, h: u32, premul: Vec<u8>) {
    let rgba = morfa_render::cpu::unpremultiplied(premul);
    let file = std::fs::File::create(path).expect("out");
    let mut encoder = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&rgba)
        .unwrap();
}

fn main() {
    let out = std::env::args().nth(1).unwrap_or_else(|| ".".into());
    let picture = picture();
    let bg = AlphaColor::<Srgb>::new([1.0, 1.0, 1.0, 1.0]);
    let (w, h) = (820u32, 360u32);
    let mut cpu = morfa_render::cpu::CpuBackend::new(0);
    let mut rec = Recorder::new(&mut cpu, w, h, bg);
    draw(&mut rec, &picture);
    let recording = rec.into_recording();
    let pixels = cpu.render_pixels(&recording);
    write(&format!("{out}/probe-cpu.png"), w, h, pixels);
    #[cfg(feature = "gpu")]
    {
        use morfa_render::gpu::{Gpu, GpuBackend, block_on};
        let gpu = Gpu::native().expect("adapter");
        let mut backend = GpuBackend::new(gpu).expect("renderer");
        let mut rec = Recorder::new(&mut backend, w, h, bg);
        draw(&mut rec, &picture);
        let recording = rec.into_recording();
        let pixels = block_on(backend.render_pixels(&recording)).expect("gpu");
        write(&format!("{out}/probe-gpu.png"), w, h, pixels);
    }
    let _ = recording.len();
}
