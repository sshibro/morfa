//! Tiles on the GPU (docs/design-tool.md §Performance, kept): a tile is one 512 × 512 layer of a texture array
//! (whole device pixels, edge to edge) painted by one vello render from the recording culled to it; a frame
//! composites the visible tiles as textured quads at integer device positions (the seam rule), each fallback level
//! only inside the holes it fills (scissor rectangles), then the live layer — the nodes under a gesture, rendered
//! straight into a screen-size texture — on top.

use super::backend::{Gpu, GpuBackend};
use super::blur::{Passes, QuadInstance};
use crate::doc::RenderDoc;
use crate::painter::{Counters, Options, Painter, Target};
use crate::record::{Backend, Recorder};
use kurbo::{Affine, Rect};
use morfa_model::store::Id;
use peniko::Color;
use wgpu::util::DeviceExt;

pub const TILE: u32 = 512;

const ATLAS_WGSL: &str = r#"
struct Params { size: vec2<f32>, pad: vec2<f32> }
struct Instance {
    @location(0) dst: vec4<f32>,
    @location(1) src: vec4<f32>,
    @location(2) layer_alpha: vec2<f32>,
}
struct Out {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) @interpolate(flat) layer: i32,
    @location(2) alpha: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var atlas: texture_2d_array<f32>;
@group(0) @binding(2) var atlas_sampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) index: u32, instance: Instance) -> Out {
    var corners = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
    let c = corners[index];
    let px = instance.dst.xy + (instance.dst.zw - instance.dst.xy) * c;
    var out: Out;
    out.position = vec4(px.x / params.size.x * 2.0 - 1.0, 1.0 - px.y / params.size.y * 2.0, 0.0, 1.0);
    out.uv = instance.src.xy + (instance.src.zw - instance.src.xy) * c;
    out.layer = i32(instance.layer_alpha.x);
    out.alpha = instance.layer_alpha.y;
    return out;
}

@fragment
fn fs_main(in: Out) -> @location(0) vec4<f32> {
    return textureSample(atlas, atlas_sampler, in.uv, in.layer) * in.alpha;
}
"#;

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct Params {
    size: [f32; 2],
    pad: [f32; 2],
}

/// The quad pass over the atlas for one target format.
struct AtlasPass {
    layout: wgpu::BindGroupLayout,
    pipeline: wgpu::RenderPipeline,
    linear: wgpu::Sampler,
    nearest: wgpu::Sampler,
}

impl AtlasPass {
    fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> AtlasPass {
        let module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("morfa atlas"),
            source: wgpu::ShaderSource::Wgsl(ATLAS_WGSL.into()),
        });
        let layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("morfa atlas"),
            entries: &[
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(16),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2Array,
                        multisampled: false,
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 2,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Sampler(wgpu::SamplerBindingType::Filtering),
                    count: None,
                },
            ],
        });
        let pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&layout)],
            immediate_size: 0,
        });
        let pipeline = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("morfa atlas"),
            layout: Some(&pipeline_layout),
            vertex: wgpu::VertexState {
                module: &module,
                entry_point: Some("vs_main"),
                buffers: &[Some(wgpu::VertexBufferLayout {
                    array_stride: std::mem::size_of::<QuadInstance>() as u64,
                    step_mode: wgpu::VertexStepMode::Instance,
                    attributes: &[
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x4,
                            offset: 0,
                            shader_location: 0,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x4,
                            offset: 16,
                            shader_location: 1,
                        },
                        wgpu::VertexAttribute {
                            format: wgpu::VertexFormat::Float32x2,
                            offset: 32,
                            shader_location: 2,
                        },
                    ],
                })],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING),
                    write_mask: wgpu::ColorWrites::ALL,
                })],
                compilation_options: Default::default(),
            }),
            primitive: wgpu::PrimitiveState::default(),
            depth_stencil: None,
            multisample: wgpu::MultisampleState::default(),
            multiview_mask: None,
            cache: None,
        });
        let sampler = |filter: wgpu::FilterMode| {
            device.create_sampler(&wgpu::SamplerDescriptor {
                address_mode_u: wgpu::AddressMode::ClampToEdge,
                address_mode_v: wgpu::AddressMode::ClampToEdge,
                mag_filter: filter,
                min_filter: filter,
                ..Default::default()
            })
        };
        AtlasPass {
            layout,
            pipeline,
            linear: sampler(wgpu::FilterMode::Linear),
            nearest: sampler(wgpu::FilterMode::Nearest),
        }
    }
}

/// One tile drawn on screen: its atlas slot, its device-px rectangle (whole pixels), and the scissor rectangle of
/// the holes it fills (none for the current level).
#[derive(Clone, Copy, Debug)]
pub struct Quad {
    pub slot: u32,
    pub dst: [f32; 4],
    pub scissor: Option<[u32; 4]>,
    /// Stretched tiles of another level: bilinear; same-scale tiles: nearest (pixel for pixel).
    pub smooth: bool,
}

/// The tile atlas and the passes that draw it.
pub struct TileRenderer {
    pub backend: GpuBackend,
    atlas: wgpu::Texture,
    layer_views: Vec<wgpu::TextureView>,
    atlas_view: wgpu::TextureView,
    capacity: u32,
    target_format: wgpu::TextureFormat,
    atlas_pass: AtlasPass,
    /// Quad passes onto the target format (the live layer, bitmaps over the frame).
    target_passes: Passes,
    scratch: Option<(wgpu::Texture, u32)>,
    live: Option<(wgpu::Texture, u32, u32)>,
}

impl TileRenderer {
    /// `capacity` tiles of 512 × 512 (1 MiB each) in the atlas; `target_format` is the surface's.
    pub fn new(
        gpu: Gpu,
        target_format: wgpu::TextureFormat,
        capacity: u32,
    ) -> Result<TileRenderer, String> {
        let max_layers = gpu.device.limits().max_texture_array_layers;
        let capacity = capacity.clamp(1, max_layers);
        let atlas = gpu.device.create_texture(&wgpu::TextureDescriptor {
            label: Some("morfa tile atlas"),
            size: wgpu::Extent3d {
                width: TILE,
                height: TILE,
                depth_or_array_layers: capacity,
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
        });
        let layer_views = (0..capacity)
            .map(|layer| {
                atlas.create_view(&wgpu::TextureViewDescriptor {
                    label: Some("morfa tile"),
                    dimension: Some(wgpu::TextureViewDimension::D2),
                    base_array_layer: layer,
                    array_layer_count: Some(1),
                    ..Default::default()
                })
            })
            .collect();
        let atlas_view = atlas.create_view(&wgpu::TextureViewDescriptor {
            label: Some("morfa atlas"),
            dimension: Some(wgpu::TextureViewDimension::D2Array),
            ..Default::default()
        });
        let atlas_pass = AtlasPass::new(&gpu.device, target_format);
        let target_passes = Passes::new(&gpu.device, target_format);
        let backend = GpuBackend::new(gpu)?;
        Ok(TileRenderer {
            backend,
            atlas,
            layer_views,
            atlas_view,
            capacity,
            target_format,
            atlas_pass,
            target_passes,
            scratch: None,
            live: None,
        })
    }

    pub fn capacity(&self) -> u32 {
        self.capacity
    }

    pub fn target_format(&self) -> wgpu::TextureFormat {
        self.target_format
    }

    /// Rasterizes tile (i, j) of `page` at `scale` into atlas slot `slot`. `margin` device px around the tile are
    /// painted too (background blur reads around itself) and cut off.
    pub fn raster_tile(
        &mut self,
        doc: &RenderDoc,
        options: &Options,
        page: Id,
        scale: f64,
        i: i64,
        j: i64,
        slot: u32,
        background: Color,
        margin: u32,
    ) -> Result<Counters, String> {
        let m = margin.min(256);
        let size = TILE + 2 * m;
        let base = Affine::translate((
            m as f64 - (i * TILE as i64) as f64,
            m as f64 - (j * TILE as i64) as f64,
        )) * Affine::scale(scale);
        let target = Target {
            base,
            scale,
            clip: Rect::new(0.0, 0.0, size as f64, size as f64),
        };
        let painter = Painter::new(doc, options);
        let mut recorder = Recorder::new(&mut self.backend, size, size, background);
        if let Some(dots) = &options.dots {
            dots.paint(&mut recorder);
        }
        painter.paint_roots(&mut recorder, &target, &[page]);
        let counters = painter.counters();
        let recording = recorder.into_recording();
        if m == 0 {
            let view = &self.layer_views[slot as usize];
            self.backend.render_into(&recording, view)?;
        } else {
            let scratch = match &self.scratch {
                Some((texture, s)) if *s == size => texture.clone(),
                _ => {
                    let texture = self.backend.gpu.texture("morfa tile scratch", size, size);
                    self.scratch = Some((texture.clone(), size));
                    texture
                }
            };
            let view = scratch.create_view(&wgpu::TextureViewDescriptor::default());
            self.backend.render_into(&recording, &view)?;
            let mut encoder =
                self.backend
                    .gpu
                    .device
                    .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                        label: Some("morfa tile copy"),
                    });
            encoder.copy_texture_to_texture(
                wgpu::TexelCopyTextureInfo {
                    texture: &scratch,
                    mip_level: 0,
                    origin: wgpu::Origin3d { x: m, y: m, z: 0 },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::TexelCopyTextureInfo {
                    texture: &self.atlas,
                    mip_level: 0,
                    origin: wgpu::Origin3d {
                        x: 0,
                        y: 0,
                        z: slot,
                    },
                    aspect: wgpu::TextureAspect::All,
                },
                wgpu::Extent3d {
                    width: TILE,
                    height: TILE,
                    depth_or_array_layers: 1,
                },
            );
            self.backend.gpu.queue.submit([encoder.finish()]);
        }
        self.backend.finish(&recording);
        Ok(counters)
    }

    /// Composites `quads` (in order, furthest level first) onto `target` of `width` × `height`, over `background`.
    pub fn composite(
        &mut self,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        background: Color,
        quads: &[Quad],
    ) {
        let device = &self.backend.gpu.device;
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::bytes_of(&Params {
                size: [width as f32, height as f32],
                pad: [0.0; 2],
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = |sampler: &wgpu::Sampler| {
            device.create_bind_group(&wgpu::BindGroupDescriptor {
                label: None,
                layout: &self.atlas_pass.layout,
                entries: &[
                    wgpu::BindGroupEntry {
                        binding: 0,
                        resource: params.as_entire_binding(),
                    },
                    wgpu::BindGroupEntry {
                        binding: 1,
                        resource: wgpu::BindingResource::TextureView(&self.atlas_view),
                    },
                    wgpu::BindGroupEntry {
                        binding: 2,
                        resource: wgpu::BindingResource::Sampler(sampler),
                    },
                ],
            })
        };
        let bind_linear = bind(&self.atlas_pass.linear);
        let bind_nearest = bind(&self.atlas_pass.nearest);
        let instances: Vec<QuadInstance> = quads
            .iter()
            .map(|q| QuadInstance {
                dst: q.dst,
                src: [0.0, 0.0, 1.0, 1.0],
                layer_alpha: [q.slot as f32, 1.0],
                _pad: [0.0; 2],
            })
            .collect();
        let buffer = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: if instances.is_empty() {
                &[0u8; 48]
            } else {
                bytemuck::cast_slice(&instances)
            },
            usage: wgpu::BufferUsages::VERTEX,
        });
        let [r, g, b, a] = background.components;
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("morfa composite"),
        });
        {
            let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
                label: Some("morfa composite"),
                color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                    view: target,
                    resolve_target: None,
                    ops: wgpu::Operations {
                        load: wgpu::LoadOp::Clear(wgpu::Color {
                            r: r as f64,
                            g: g as f64,
                            b: b as f64,
                            a: a as f64,
                        }),
                        store: wgpu::StoreOp::Store,
                    },
                    depth_slice: None,
                })],
                depth_stencil_attachment: None,
                timestamp_writes: None,
                occlusion_query_set: None,
                multiview_mask: None,
            });
            pass.set_pipeline(&self.atlas_pass.pipeline);
            pass.set_vertex_buffer(0, buffer.slice(..));
            // Runs of quads with the same scissor and sampler draw in one call.
            let mut k = 0;
            while k < quads.len() {
                let scissor = quads[k].scissor;
                let smooth = quads[k].smooth;
                let mut end = k + 1;
                while end < quads.len()
                    && quads[end].scissor == scissor
                    && quads[end].smooth == smooth
                {
                    end += 1;
                }
                match scissor {
                    Some([x, y, w, h]) => {
                        let x = x.min(width);
                        let y = y.min(height);
                        let w = w.min(width - x);
                        let h = h.min(height - y);
                        if w == 0 || h == 0 {
                            k = end;
                            continue;
                        }
                        pass.set_scissor_rect(x, y, w, h);
                    }
                    None => pass.set_scissor_rect(0, 0, width, height),
                }
                pass.set_bind_group(0, if smooth { &bind_linear } else { &bind_nearest }, &[]);
                pass.draw(0..6, k as u32..end as u32);
                k = end;
            }
        }
        self.backend.gpu.queue.submit([encoder.finish()]);
    }

    /// Renders `roots` (the live nodes) at `base` into a transparent screen-size texture and draws it over `target`.
    /// Each root is clipped by its clipping ancestors and dimmed by their opacity (`paintDetached`).
    pub fn render_live(
        &mut self,
        doc: &RenderDoc,
        options: &Options,
        roots: &[Id],
        base: Affine,
        scale: f64,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
    ) -> Result<Counters, String> {
        let painter = Painter::new(doc, options);
        let mut recorder = Recorder::new(&mut self.backend, width, height, Color::TRANSPARENT);
        let target_rect = Target {
            base,
            scale,
            clip: Rect::new(0.0, 0.0, width as f64, height as f64),
        };
        crate::live::paint_detached(
            &painter,
            &mut recorder,
            &target_rect,
            doc,
            roots,
            options.clip_to_ancestors,
        );
        let counters = painter.counters();
        let recording = recorder.into_recording();
        let texture = match &self.live {
            Some((texture, w, h)) if *w == width && *h == height => texture.clone(),
            _ => {
                let texture = self.backend.gpu.texture("morfa live", width, height);
                self.live = Some((texture.clone(), width, height));
                texture
            }
        };
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        self.backend.render_into(&recording, &view)?;
        self.backend.finish(&recording);
        let mut encoder =
            self.backend
                .gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("morfa live composite"),
                });
        let quad = super::backend::whole_quad(width, height, 1.0);
        self.target_passes.draw_quads(
            &self.backend.gpu.device,
            &mut encoder,
            &view,
            target,
            width,
            height,
            &[quad],
            true,
            false,
            None,
            None,
        );
        self.backend.gpu.queue.submit([encoder.finish()]);
        Ok(counters)
    }

    /// Draws a bitmap (a labels overlay the host painted) over `target`.
    pub fn draw_bitmap_over(
        &mut self,
        handle: u32,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
    ) {
        let Some(texture) = self.backend.texture_of(handle) else {
            return;
        };
        let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let (bw, bh) = self.backend.bitmap_size(handle);
        let quad = QuadInstance {
            dst: [0.0, 0.0, bw as f32, bh as f32],
            src: [0.0, 0.0, 1.0, 1.0],
            layer_alpha: [0.0, 1.0],
            _pad: [0.0; 2],
        };
        let mut encoder =
            self.backend
                .gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("morfa overlay"),
                });
        self.target_passes.draw_quads(
            &self.backend.gpu.device,
            &mut encoder,
            &view,
            target,
            width,
            height,
            &[quad],
            true,
            false,
            None,
            None,
        );
        self.backend.gpu.queue.submit([encoder.finish()]);
    }

    /// The pixels of one atlas slot (tests, the both-mode comparison): premultiplied RGBA8.
    pub async fn read_tile(&self, slot: u32) -> Vec<u8> {
        let texture = self.backend.gpu.texture("morfa tile read", TILE, TILE);
        let mut encoder =
            self.backend
                .gpu
                .device
                .create_command_encoder(&wgpu::CommandEncoderDescriptor {
                    label: Some("morfa tile read"),
                });
        encoder.copy_texture_to_texture(
            wgpu::TexelCopyTextureInfo {
                texture: &self.atlas,
                mip_level: 0,
                origin: wgpu::Origin3d {
                    x: 0,
                    y: 0,
                    z: slot,
                },
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::TexelCopyTextureInfo {
                texture: &texture,
                mip_level: 0,
                origin: wgpu::Origin3d::ZERO,
                aspect: wgpu::TextureAspect::All,
            },
            wgpu::Extent3d {
                width: TILE,
                height: TILE,
                depth_or_array_layers: 1,
            },
        );
        self.backend.gpu.queue.submit([encoder.finish()]);
        self.backend.gpu.read_texture(&texture, TILE, TILE).await
    }

    /// Bytes the atlas holds (every slot, allocated up front).
    pub fn atlas_bytes(&self) -> u64 {
        self.capacity as u64 * TILE as u64 * TILE as u64 * 4
    }
}
