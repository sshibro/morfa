//! Textured-quad passes in WGSL: copies (resampling: the blur's downsample and upsample steps, texture → texture
//! moves) and the separable Gaussian blur. Large radii are blurred at a lower resolution: halve until σ ≤ 6 px,
//! blur, and resample back (what `blurCanvas` gets from the browser's `filter: blur()`), so a 250 px blur costs
//! the same taps as a 6 px one.

use wgpu::util::DeviceExt;

const QUAD_WGSL: &str = r#"
struct Params {
    // Target size in px, then padding.
    size: vec2<f32>,
    pad: vec2<f32>,
}
struct Instance {
    @location(0) dst: vec4<f32>,
    @location(1) src: vec4<f32>,
    @location(2) layer_alpha: vec2<f32>,
}
struct Out {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
    @location(1) layer: f32,
    @location(2) alpha: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

@vertex
fn vs_main(@builtin(vertex_index) index: u32, instance: Instance) -> Out {
    let corner = vec2<f32>(f32((index & 1u) ^ ((index >> 1u) & 1u)), f32((index >> 1u) & 1u));
    // index 0,1,2 → (0,0) (1,0) (1,1)? Use an explicit table instead.
    var corners = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
    let c = corners[index];
    let px = instance.dst.xy + (instance.dst.zw - instance.dst.xy) * c;
    let ndc = vec2(px.x / params.size.x * 2.0 - 1.0, 1.0 - px.y / params.size.y * 2.0);
    var out: Out;
    out.position = vec4(ndc, 0.0, 1.0);
    out.uv = instance.src.xy + (instance.src.zw - instance.src.xy) * c;
    out.layer = instance.layer_alpha.x;
    out.alpha = instance.layer_alpha.y;
    let _unused = corner;
    return out;
}

@fragment
fn fs_main(in: Out) -> @location(0) vec4<f32> {
    return textureSample(source, source_sampler, in.uv) * in.alpha;
}
"#;

const BLUR_WGSL: &str = r#"
struct Params {
    // Direction in uv per tap, sigma, radius (taps each side).
    dir: vec2<f32>,
    sigma: f32,
    radius: f32,
}
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var source: texture_2d<f32>;
@group(0) @binding(2) var source_sampler: sampler;

struct Out {
    @builtin(position) position: vec4<f32>,
    @location(0) uv: vec2<f32>,
}

@vertex
fn vs_main(@builtin(vertex_index) index: u32) -> Out {
    var corners = array<vec2<f32>, 6>(vec2(0.0, 0.0), vec2(1.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, 1.0), vec2(0.0, 1.0));
    let c = corners[index];
    var out: Out;
    out.position = vec4(c.x * 2.0 - 1.0, 1.0 - c.y * 2.0, 0.0, 1.0);
    out.uv = c;
    return out;
}

@fragment
fn fs_main(in: Out) -> @location(0) vec4<f32> {
    let radius = i32(params.radius);
    let two_s2 = 2.0 * params.sigma * params.sigma;
    var sum = vec4<f32>(0.0);
    var weights = 0.0;
    for (var i = -radius; i <= radius; i = i + 1) {
        let w = exp(-f32(i * i) / two_s2);
        sum = sum + textureSample(source, source_sampler, in.uv + params.dir * f32(i)) * w;
        weights = weights + w;
    }
    return sum / weights;
}
"#;

/// One textured quad: device-px destination rectangle, normalized source rectangle, layer and alpha.
#[repr(C)]
#[derive(Clone, Copy, Debug, bytemuck::Pod, bytemuck::Zeroable)]
pub struct QuadInstance {
    pub dst: [f32; 4],
    pub src: [f32; 4],
    pub layer_alpha: [f32; 2],
    pub _pad: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct QuadParams {
    size: [f32; 2],
    pad: [f32; 2],
}

#[repr(C)]
#[derive(Clone, Copy, bytemuck::Pod, bytemuck::Zeroable)]
struct BlurParams {
    dir: [f32; 2],
    sigma: f32,
    radius: f32,
}

/// The two quad pipelines for one texture format (copies/composites with premultiplied blending, blur replacing).
pub struct Passes {
    pub format: wgpu::TextureFormat,
    quad_layout: wgpu::BindGroupLayout,
    quad_blend: wgpu::RenderPipeline,
    quad_replace: wgpu::RenderPipeline,
    blur_layout: wgpu::BindGroupLayout,
    blur: wgpu::RenderPipeline,
    linear: wgpu::Sampler,
    nearest: wgpu::Sampler,
}

impl Passes {
    pub fn new(device: &wgpu::Device, format: wgpu::TextureFormat) -> Passes {
        let quad_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("morfa quad"),
            source: wgpu::ShaderSource::Wgsl(QUAD_WGSL.into()),
        });
        let blur_module = device.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("morfa blur"),
            source: wgpu::ShaderSource::Wgsl(BLUR_WGSL.into()),
        });
        let entries = |uniform_size: u64| {
            [
                wgpu::BindGroupLayoutEntry {
                    binding: 0,
                    visibility: wgpu::ShaderStages::VERTEX_FRAGMENT,
                    ty: wgpu::BindingType::Buffer {
                        ty: wgpu::BufferBindingType::Uniform,
                        has_dynamic_offset: false,
                        min_binding_size: wgpu::BufferSize::new(uniform_size),
                    },
                    count: None,
                },
                wgpu::BindGroupLayoutEntry {
                    binding: 1,
                    visibility: wgpu::ShaderStages::FRAGMENT,
                    ty: wgpu::BindingType::Texture {
                        sample_type: wgpu::TextureSampleType::Float { filterable: true },
                        view_dimension: wgpu::TextureViewDimension::D2,
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
            ]
        };
        let quad_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("morfa quad"),
            entries: &entries(16),
        });
        let blur_layout = device.create_bind_group_layout(&wgpu::BindGroupLayoutDescriptor {
            label: Some("morfa blur"),
            entries: &entries(16),
        });
        let quad_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&quad_layout)],
            immediate_size: 0,
        });
        let blur_pipeline_layout = device.create_pipeline_layout(&wgpu::PipelineLayoutDescriptor {
            label: None,
            bind_group_layouts: &[Some(&blur_layout)],
            immediate_size: 0,
        });
        let instance_layout = wgpu::VertexBufferLayout {
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
        };
        let quad_pipeline = |blend: Option<wgpu::BlendState>| {
            device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
                label: Some("morfa quad"),
                layout: Some(&quad_pipeline_layout),
                vertex: wgpu::VertexState {
                    module: &quad_module,
                    entry_point: Some("vs_main"),
                    buffers: &[Some(instance_layout.clone())],
                    compilation_options: Default::default(),
                },
                fragment: Some(wgpu::FragmentState {
                    module: &quad_module,
                    entry_point: Some("fs_main"),
                    targets: &[Some(wgpu::ColorTargetState {
                        format,
                        blend,
                        write_mask: wgpu::ColorWrites::ALL,
                    })],
                    compilation_options: Default::default(),
                }),
                primitive: wgpu::PrimitiveState::default(),
                depth_stencil: None,
                multisample: wgpu::MultisampleState::default(),
                multiview_mask: None,
                cache: None,
            })
        };
        let blur = device.create_render_pipeline(&wgpu::RenderPipelineDescriptor {
            label: Some("morfa blur"),
            layout: Some(&blur_pipeline_layout),
            vertex: wgpu::VertexState {
                module: &blur_module,
                entry_point: Some("vs_main"),
                buffers: &[],
                compilation_options: Default::default(),
            },
            fragment: Some(wgpu::FragmentState {
                module: &blur_module,
                entry_point: Some("fs_main"),
                targets: &[Some(wgpu::ColorTargetState {
                    format,
                    blend: None,
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
        Passes {
            format,
            quad_layout,
            quad_blend: quad_pipeline(Some(wgpu::BlendState::PREMULTIPLIED_ALPHA_BLENDING)),
            quad_replace: quad_pipeline(None),
            blur_layout,
            blur,
            linear: sampler(wgpu::FilterMode::Linear),
            nearest: sampler(wgpu::FilterMode::Nearest),
        }
    }

    /// Draws `quads` of `source` onto `target` (size `width` × `height`): premultiplied source-over when `blend`,
    /// replacing otherwise; `clear` first when given.
    pub fn draw_quads(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::TextureView,
        target: &wgpu::TextureView,
        width: u32,
        height: u32,
        quads: &[QuadInstance],
        blend: bool,
        linear: bool,
        clear: Option<wgpu::Color>,
        scissor: Option<[u32; 4]>,
    ) {
        if quads.is_empty() && clear.is_none() {
            return;
        }
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::bytes_of(&QuadParams {
                size: [width as f32, height as f32],
                pad: [0.0; 2],
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let instances = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::cast_slice(quads),
            usage: wgpu::BufferUsages::VERTEX,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.quad_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(source),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(if linear {
                        &self.linear
                    } else {
                        &self.nearest
                    }),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("morfa quads"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: clear.map(wgpu::LoadOp::Clear).unwrap_or(wgpu::LoadOp::Load),
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        if quads.is_empty() {
            return;
        }
        if let Some([x, y, w, h]) = scissor {
            pass.set_scissor_rect(x, y, w, h);
        }
        pass.set_pipeline(if blend {
            &self.quad_blend
        } else {
            &self.quad_replace
        });
        pass.set_bind_group(0, &bind, &[]);
        pass.set_vertex_buffer(0, instances.slice(..));
        pass.draw(0..6, 0..quads.len() as u32);
    }

    fn blur_pass(
        &self,
        device: &wgpu::Device,
        encoder: &mut wgpu::CommandEncoder,
        source: &wgpu::TextureView,
        target: &wgpu::TextureView,
        dir: [f32; 2],
        sigma: f32,
        radius: u32,
    ) {
        let params = device.create_buffer_init(&wgpu::util::BufferInitDescriptor {
            label: None,
            contents: bytemuck::bytes_of(&BlurParams {
                dir,
                sigma,
                radius: radius as f32,
            }),
            usage: wgpu::BufferUsages::UNIFORM,
        });
        let bind = device.create_bind_group(&wgpu::BindGroupDescriptor {
            label: None,
            layout: &self.blur_layout,
            entries: &[
                wgpu::BindGroupEntry {
                    binding: 0,
                    resource: params.as_entire_binding(),
                },
                wgpu::BindGroupEntry {
                    binding: 1,
                    resource: wgpu::BindingResource::TextureView(source),
                },
                wgpu::BindGroupEntry {
                    binding: 2,
                    resource: wgpu::BindingResource::Sampler(&self.linear),
                },
            ],
        });
        let mut pass = encoder.begin_render_pass(&wgpu::RenderPassDescriptor {
            label: Some("morfa blur"),
            color_attachments: &[Some(wgpu::RenderPassColorAttachment {
                view: target,
                resolve_target: None,
                ops: wgpu::Operations {
                    load: wgpu::LoadOp::Clear(wgpu::Color::TRANSPARENT),
                    store: wgpu::StoreOp::Store,
                },
                depth_slice: None,
            })],
            depth_stencil_attachment: None,
            timestamp_writes: None,
            occlusion_query_set: None,
            multiview_mask: None,
        });
        pass.set_pipeline(&self.blur);
        pass.set_bind_group(0, &bind, &[]);
        pass.draw(0..6, 0..1);
    }

    /// Blurs `texture` (size `width` × `height`, premultiplied) in place by σ px.
    pub fn blur_texture(
        &self,
        device: &wgpu::Device,
        queue: &wgpu::Queue,
        texture: &wgpu::Texture,
        width: u32,
        height: u32,
        sigma: f64,
    ) {
        if !(sigma > 0.05) || width == 0 || height == 0 {
            return;
        }
        // Halve the picture until σ is small enough for a short kernel.
        let mut steps = 0u32;
        let mut s = sigma;
        let (mut w, mut h) = (width, height);
        while s > 6.0 && w > 8 && h > 8 {
            s /= 2.0;
            w = w.div_ceil(2);
            h = h.div_ceil(2);
            steps += 1;
        }
        let radius = ((3.0 * s).ceil() as u32).clamp(1, 24);
        let make = |label: &str, tw: u32, th: u32| {
            device.create_texture(&wgpu::TextureDescriptor {
                label: Some(label),
                size: wgpu::Extent3d {
                    width: tw,
                    height: th,
                    depth_or_array_layers: 1,
                },
                mip_level_count: 1,
                sample_count: 1,
                dimension: wgpu::TextureDimension::D2,
                format: self.format,
                usage: wgpu::TextureUsages::TEXTURE_BINDING
                    | wgpu::TextureUsages::RENDER_ATTACHMENT
                    | wgpu::TextureUsages::COPY_SRC
                    | wgpu::TextureUsages::COPY_DST,
                view_formats: &[],
            })
        };
        let mut encoder = device.create_command_encoder(&wgpu::CommandEncoderDescriptor {
            label: Some("morfa blur"),
        });
        let full = texture.create_view(&wgpu::TextureViewDescriptor::default());
        // Down: full → small (one resampling pass per halving).
        let mut current_view = full;
        let mut current_size = (width, height);
        let mut keep: Vec<wgpu::Texture> = Vec::new();
        for _ in 0..steps {
            let next_size = (current_size.0.div_ceil(2), current_size.1.div_ceil(2));
            let next = make("morfa blur down", next_size.0, next_size.1);
            let next_view = next.create_view(&wgpu::TextureViewDescriptor::default());
            let quad = QuadInstance {
                dst: [0.0, 0.0, next_size.0 as f32, next_size.1 as f32],
                src: [0.0, 0.0, 1.0, 1.0],
                layer_alpha: [0.0, 1.0],
                _pad: [0.0; 2],
            };
            self.draw_quads(
                device,
                &mut encoder,
                &current_view,
                &next_view,
                next_size.0,
                next_size.1,
                &[quad],
                false,
                true,
                Some(wgpu::Color::TRANSPARENT),
                None,
            );
            keep.push(next);
            current_view = next_view;
            current_size = next_size;
        }
        // Blur: horizontal into a temp, vertical back.
        let temp = make("morfa blur temp", current_size.0, current_size.1);
        let temp_view = temp.create_view(&wgpu::TextureViewDescriptor::default());
        let back = make("morfa blur back", current_size.0, current_size.1);
        let back_view = back.create_view(&wgpu::TextureViewDescriptor::default());
        self.blur_pass(
            device,
            &mut encoder,
            &current_view,
            &temp_view,
            [1.0 / current_size.0 as f32, 0.0],
            s as f32,
            radius,
        );
        self.blur_pass(
            device,
            &mut encoder,
            &temp_view,
            &back_view,
            [0.0, 1.0 / current_size.1 as f32],
            s as f32,
            radius,
        );
        // Up: resample back into the original texture.
        let target = texture.create_view(&wgpu::TextureViewDescriptor::default());
        let quad = QuadInstance {
            dst: [0.0, 0.0, width as f32, height as f32],
            src: [0.0, 0.0, 1.0, 1.0],
            layer_alpha: [0.0, 1.0],
            _pad: [0.0; 2],
        };
        self.draw_quads(
            device,
            &mut encoder,
            &back_view,
            &target,
            width,
            height,
            &[quad],
            false,
            true,
            Some(wgpu::Color::TRANSPARENT),
            None,
        );
        queue.submit([encoder.finish()]);
        drop(keep);
    }
}
