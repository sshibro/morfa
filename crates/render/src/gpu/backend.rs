//! vello (compute) on wgpu as a [`Backend`]: recordings become a `vello::Scene` and `render_to_texture` draws them;
//! bitmaps are `Rgba8Unorm` textures vello samples through `register_texture` (premultiplied, as its own output
//! is), blurred by the WGSL passes of [`super::blur`].

use super::blur::{Passes, QuadInstance};
use crate::record::{Backend, Brush, Op, Recording};
use crate::sink::{Handle, Picture};
use kurbo::{Affine, Rect, Shape};
use peniko::{
    BlendMode, Brush as PenikoBrush, Color, Compose, Extend, Fill, ImageAlphaType, ImageBrush,
    ImageData, ImageFormat, Mix,
};
use std::collections::HashMap;
use std::sync::Arc;
use vello::{AaConfig, AaSupport, RenderParams, Renderer, RendererOptions, Scene};

/// The device every GPU object shares.
#[derive(Clone)]
pub struct Gpu {
    pub adapter: wgpu::Adapter,
    pub device: wgpu::Device,
    pub queue: wgpu::Queue,
    pub adapter_info: wgpu::AdapterInfo,
}

impl Gpu {
    /// A device on the first adapter of `backends` (native: Vulkan or Metal; the browser: WebGPU).
    pub async fn new(
        instance: &wgpu::Instance,
        compatible_surface: Option<&wgpu::Surface<'_>>,
    ) -> Result<Gpu, String> {
        let adapter = instance
            .request_adapter(&wgpu::RequestAdapterOptions {
                power_preference: wgpu::PowerPreference::HighPerformance,
                force_fallback_adapter: false,
                compatible_surface,
                apply_limit_buckets: false,
            })
            .await
            .map_err(|e| format!("no WebGPU adapter: {e}"))?;
        let limits = adapter.limits();
        let (device, queue) = adapter
            .request_device(&wgpu::DeviceDescriptor {
                label: Some("morfa render"),
                required_features: wgpu::Features::empty(),
                required_limits: limits,
                ..Default::default()
            })
            .await
            .map_err(|e| format!("no WebGPU device: {e}"))?;
        let adapter_info = adapter.get_info();
        Ok(Gpu {
            adapter,
            device,
            queue,
            adapter_info,
        })
    }

    /// A device for tests and the server: any native adapter (lavapipe when no GPU is present).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn native() -> Result<Gpu, String> {
        let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle());
        super::block_on(Gpu::new(&instance, None))
    }

    pub fn texture(&self, label: &str, width: u32, height: u32) -> wgpu::Texture {
        self.device.create_texture(&wgpu::TextureDescriptor {
            label: Some(label),
            size: wgpu::Extent3d {
                width: width.max(1),
                height: height.max(1),
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba8Unorm,
            usage: wgpu::TextureUsages::STORAGE_BINDING
                | wgpu::TextureUsages::TEXTURE_BINDING
                | wgpu::TextureUsages::COPY_SRC
                | wgpu::TextureUsages::COPY_DST
                | wgpu::TextureUsages::RENDER_ATTACHMENT,
            view_formats: &[],
        })
    }

    /// The pixels of a texture (premultiplied RGBA8), read back through a mapped buffer.
    pub async fn read_texture(&self, texture: &wgpu::Texture, width: u32, height: u32) -> Vec<u8> {
        let bytes_per_row = (width * 4).div_ceil(256) * 256;
        let buffer = self.device.create_buffer(&wgpu::BufferDescriptor {
            label: Some("morfa readback"),
            size: (bytes_per_row * height) as u64,
            usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
            mapped_at_creation: false,
        });
        let mut encoder = self
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("morfa readback"),
            });
        encoder.copy_texture_to_buffer(
            wgpu::TexelCopyTextureInfo {
                texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyBufferInfo {
                buffer: &buffer,
                layout: wgpu::TexelCopyBufferLayout {
                    offset: 0,
                    bytes_per_row: Some(bytes_per_row),
                    rows_per_image: Some(height),
                },
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.queue.submit([encoder.finish()]);
        let slice = buffer.slice(..);
        let (sender, receiver) = futures_intrusive::channel::shared::oneshot_channel();
        slice.map_async(wgpu::MapMode::Read, move |result| {
            let _ = sender.send(result);
        });
        #[cfg(not(target_arch = "wasm32"))]
        let _ = self.device.poll(wgpu::PollType::wait_indefinitely());
        #[cfg(target_arch = "wasm32")]
        let _ = self.device.poll(wgpu::PollType::Poll);
        let _ = receiver.receive().await;
        let data = slice.get_mapped_range().expect("mapped readback");
        let mut out = vec![0u8; (width * height * 4) as usize];
        for y in 0..height as usize {
            let row =
                &data[y * bytes_per_row as usize..y * bytes_per_row as usize + width as usize * 4];
            out[y * width as usize * 4..(y + 1) * width as usize * 4].copy_from_slice(row);
        }
        drop(data);
        buffer.unmap();
        out
    }
}

struct Bitmap {
    texture: wgpu::Texture,
    image: ImageData,
    width: u32,
    height: u32,
}

/// The GPU backend: vello's renderer, the quad passes, bitmaps by handle.
pub struct GpuBackend {
    pub gpu: Gpu,
    renderer: Renderer,
    pub passes: Passes,
    scene: Scene,
    bitmaps: HashMap<Handle, Bitmap>,
    next_handle: Handle,
    /// Picture levels as vello images (uploaded to its atlas on first use, cached by blob id).
    pictures: HashMap<(u64, usize), ImageData>,
    max_pixels: u64,
    /// Images (pictures, bitmaps) drawn inside a nested render (an effect bitmap, a backdrop): what vello 0.11 uploads
    /// to its persistent image atlas during one `render_to_texture` is not there for the next one, so they are
    /// marked dirty (uploaded again) before the next top-level render.
    nested_pictures: Vec<ImageData>,
    nested: bool,
}

impl GpuBackend {
    pub fn new(gpu: Gpu) -> Result<GpuBackend, String> {
        let renderer = Renderer::new(
            &gpu.device,
            RendererOptions {
                antialiasing_support: AaSupport::area_only(),
                ..Default::default()
            },
        )
        .map_err(|e| format!("vello renderer: {e}"))?;
        let passes = Passes::new(&gpu.device, wgpu::TextureFormat::Rgba8Unorm);
        let max_pixels = (gpu.device.limits().max_texture_dimension_2d as u64)
            .pow(2)
            .min(16 * 1024 * 1024);
        Ok(GpuBackend {
            gpu,
            renderer,
            passes,
            scene: Scene::new(),
            bitmaps: HashMap::new(),
            next_handle: 1,
            pictures: HashMap::new(),
            max_pixels,
            nested_pictures: Vec::new(),
            nested: false,
        })
    }

    pub fn adapter_name(&self) -> String {
        format!(
            "{} ({:?})",
            self.gpu.adapter_info.name, self.gpu.adapter_info.backend
        )
    }

    fn register_bitmap(&mut self, texture: wgpu::Texture, width: u32, height: u32) -> Handle {
        let mut image = self.renderer.register_texture(texture.clone());
        image.alpha_type = ImageAlphaType::AlphaPremultiplied;
        let handle = self.next_handle;
        self.next_handle += 1;
        self.bitmaps.insert(
            handle,
            Bitmap {
                texture,
                image,
                width,
                height,
            },
        );
        handle
    }

    fn picture_image(&mut self, picture: &Arc<Picture>, level: usize) -> ImageData {
        let key = (picture.id, level);
        if let Some(image) = self.pictures.get(&key) {
            if self.nested {
                self.nested_pictures.push(image.clone());
            }
            return image.clone();
        }
        let l = &picture.levels[level.min(picture.levels.len() - 1)];
        let blob: peniko::Blob<u8> =
            peniko::Blob::new(Arc::clone(&l.rgba) as Arc<dyn AsRef<[u8]> + Send + Sync>);
        let image = ImageData {
            data: blob,
            format: ImageFormat::Rgba8,
            alpha_type: ImageAlphaType::Alpha,
            width: l.width,
            height: l.height,
        };
        self.pictures.insert(key, image.clone());
        if self.nested {
            self.nested_pictures.push(image.clone());
        }
        image
    }

    fn brush_of(&mut self, brush: &Brush, transform: Affine) -> (PenikoBrush, Option<Affine>) {
        match brush {
            Brush::Solid(c) => (PenikoBrush::Solid(*c), None),
            Brush::Gradient(g, t) => (
                PenikoBrush::Gradient(g.clone()),
                Some(transform.inverse() * *t),
            ),
            Brush::Picture {
                picture,
                level,
                transform: t,
                repeat,
                alpha,
            } => {
                let image = self.picture_image(picture, *level);
                let brush = ImageBrush::new(image)
                    .with_extend(if *repeat { Extend::Repeat } else { Extend::Pad })
                    .with_alpha(*alpha);
                (PenikoBrush::Image(brush), Some(transform.inverse() * *t))
            }
            Brush::Bitmap {
                handle,
                transform: t,
                alpha,
            } => match self.bitmaps.get(handle) {
                Some(bitmap) => {
                    if self.nested {
                        self.nested_pictures.push(bitmap.image.clone());
                    }
                    let brush = ImageBrush::new(bitmap.image.clone())
                        .with_extend(Extend::Pad)
                        .with_alpha(*alpha);
                    (PenikoBrush::Image(brush), Some(transform.inverse() * *t))
                }
                None => (PenikoBrush::Solid(Color::TRANSPARENT), None),
            },
        }
    }

    fn replay_ops(&mut self, ops: &[Op], width: u32, height: u32) {
        let whole = Rect::new(0.0, 0.0, width as f64, height as f64);
        for op in ops {
            match op {
                Op::Fill {
                    transform,
                    rule,
                    brush,
                    path,
                } => {
                    let (b, bt) = self.brush_of(brush, *transform);
                    self.scene.fill(*rule, *transform, &b, bt, path);
                }
                Op::Stroke {
                    transform,
                    stroke,
                    brush,
                    path,
                } => {
                    let (b, bt) = self.brush_of(brush, *transform);
                    self.scene.stroke(stroke, *transform, &b, bt, path);
                }
                Op::PushLayer { blend, alpha, clip } => match clip {
                    Some((t, rule, path)) => self.scene.push_layer(*rule, *blend, *alpha, *t, path),
                    None => self.scene.push_layer(
                        Fill::NonZero,
                        *blend,
                        *alpha,
                        Affine::IDENTITY,
                        &whole,
                    ),
                },
                Op::PopLayer => self.scene.pop_layer(),
                Op::MaskGroup {
                    luminance,
                    content,
                    mask,
                } => {
                    self.scene
                        .push_layer(Fill::NonZero, SRC_OVER, 1.0, Affine::IDENTITY, &whole);
                    self.replay_ops(content, width, height);
                    if *luminance {
                        self.scene.push_luminance_mask_layer(
                            Fill::NonZero,
                            1.0,
                            Affine::IDENTITY,
                            &whole,
                        );
                    } else {
                        self.scene.push_layer(
                            Fill::NonZero,
                            DEST_IN,
                            1.0,
                            Affine::IDENTITY,
                            &whole,
                        );
                    }
                    self.replay_ops(mask, width, height);
                    self.scene.pop_layer();
                    self.scene.pop_layer();
                }
                Op::BlurredRect {
                    transform,
                    rect,
                    radius,
                    sigma,
                    color,
                } => {
                    self.scene.draw_blurred_rounded_rect(
                        *transform,
                        *rect,
                        *color,
                        *radius,
                        sigma.max(0.01),
                    );
                }
            }
        }
    }

    /// Renders a recording into a texture view of its size.
    pub fn render_into(
        &mut self,
        recording: &Recording,
        view: &wgpu::TextureView,
    ) -> Result<(), String> {
        // vello 0.11 keeps its image atlas between renders only for what the last render uploaded (what an earlier
        // `render_to_texture` put there reads back empty): every picture and bitmap this backend knows is marked dirty
        // before each render, so the ones this scene uses are uploaded again (pictures by `write_texture` from their
        // bytes, bitmaps by a texture copy). A further win once vello keeps residents: upload once.
        let images: Vec<ImageData> = self
            .pictures
            .values()
            .cloned()
            .chain(self.bitmaps.values().map(|b| b.image.clone()))
            .collect();
        for image in images {
            self.renderer.mark_override_image_dirty(&image);
        }
        self.scene.reset();
        self.replay_ops(&recording.ops, recording.width, recording.height);
        let params = RenderParams {
            base_color: recording.base,
            width: recording.width,
            height: recording.height,
            antialiasing_method: AaConfig::Area,
        };
        let scene = std::mem::take(&mut self.scene);
        let result = self
            .renderer
            .render_to_texture(&self.gpu.device, &self.gpu.queue, &scene, view, &params)
            .map_err(|e| format!("vello render: {e}"));
        self.scene = scene;
        result
    }

    /// Renders a recording into a new texture of its size.
    pub fn render_texture(&mut self, recording: &Recording) -> Result<wgpu::Texture, String> {
        let texture = self
            .gpu
            .texture("morfa bitmap", recording.width, recording.height);
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.render_into(recording, &view)?;
        Ok(texture)
    }

    /// A recording rendered and read back (tests, exports): premultiplied RGBA8.
    pub async fn render_pixels(&mut self, recording: &Recording) -> Result<Vec<u8>, String> {
        let texture = self.render_texture(recording)?;
        let pixels = self
            .gpu
            .read_texture(&texture, recording.width, recording.height)
            .await;
        self.finish(recording);
        Ok(pixels)
    }

    pub fn texture_of(&self, handle: Handle) -> Option<&wgpu::Texture> {
        self.bitmaps.get(&handle).map(|b| &b.texture)
    }

    pub fn bitmap_count(&self) -> usize {
        self.bitmaps.len()
    }
}

const SRC_OVER: BlendMode = BlendMode {
    mix: Mix::Normal,
    compose: Compose::SrcOver,
};
const DEST_IN: BlendMode = BlendMode {
    mix: Mix::Normal,
    compose: Compose::DestIn,
};

impl Backend for GpuBackend {
    fn render(&mut self, recording: &Recording) -> Option<Handle> {
        if recording.width == 0 || recording.height == 0 {
            return None;
        }
        self.nested = true;
        let texture = self.render_texture(recording);
        self.nested = false;
        let texture = texture.ok()?;
        Some(self.register_bitmap(texture, recording.width, recording.height))
    }

    fn blur(&mut self, handle: Handle, sigma: f64) {
        let Some(bitmap) = self.bitmaps.get(&handle) else {
            return;
        };
        self.passes.blur_texture(
            &self.gpu.device,
            &self.gpu.queue,
            &bitmap.texture,
            bitmap.width,
            bitmap.height,
            sigma,
        );
        // vello caches what it read from the texture: tell it the pixels moved.
        self.renderer.mark_override_image_dirty(&bitmap.image);
    }

    fn crop(&mut self, handle: Handle, rect: Rect) -> Option<Handle> {
        let bitmap = self.bitmaps.get(&handle)?;
        let x0 = (rect.x0.floor() as i64).clamp(0, bitmap.width as i64) as u32;
        let y0 = (rect.y0.floor() as i64).clamp(0, bitmap.height as i64) as u32;
        let x1 = (rect.x1.ceil() as i64).clamp(0, bitmap.width as i64) as u32;
        let y1 = (rect.y1.ceil() as i64).clamp(0, bitmap.height as i64) as u32;
        if x1 <= x0 || y1 <= y0 {
            return None;
        }
        let (w, h) = (x1 - x0, y1 - y0);
        let texture = self.gpu.texture("morfa crop", w, h);
        let mut encoder = self
            .gpu
            .device
            .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                label: Some("morfa crop"),
            });
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &bitmap.texture,
                mip_level: 0,
                origin: wgpu::Origin3d { x: x0, y: y0, z: 0 },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: w,
                height: h,
                depth_or_array_layers: 1,
            },
        );
        self.gpu.queue.submit([encoder.finish()]);
        Some(self.register_bitmap(texture, w, h))
    }

    fn upload(&mut self, width: u32, height: u32, rgba: &[u8]) -> Handle {
        let mut premul = rgba.to_vec();
        crate::blur::premultiply(&mut premul);
        let texture = self.gpu.texture("morfa upload", width, height);
        self.gpu.queue.write_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            &premul,
            wgpu::TexelCopyBufferLayout {
                offset: 0,
                bytes_per_row: Some(width * 4),
                rows_per_image: Some(height),
            },
            wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
        );
        self.register_bitmap(texture, width, height)
    }

    fn release(&mut self, handle: Handle) {
        if let Some(bitmap) = self.bitmaps.remove(&handle) {
            self.renderer.unregister_texture(bitmap.image);
        }
    }

    fn bitmap_size(&self, handle: Handle) -> (u32, u32) {
        self.bitmaps
            .get(&handle)
            .map(|b| (b.width, b.height))
            .unwrap_or((0, 0))
    }

    fn max_bitmap_pixels(&self) -> u64 {
        self.max_pixels
    }
}

/// A full-size quad of a texture: the live layer and a bitmap drawn over a frame.
pub fn whole_quad(width: u32, height: u32, alpha: f32) -> QuadInstance {
    QuadInstance {
        dst: [0.0, 0.0, width as f32, height as f32],
        src: [0.0, 0.0, 1.0, 1.0],
        layer_alpha: [0.0, alpha],
        _pad: [0.0; 2],
    }
}

#[allow(dead_code)]
fn _rect_path(r: Rect) -> kurbo::BezPath {
    r.to_path(0.1)
}
