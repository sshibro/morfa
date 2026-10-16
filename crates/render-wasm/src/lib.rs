//! `morfa-render-wasm`: lane L4's JavaScript boundary for the renderer — a wasm module of its own, loaded lazily by
//! the editor when the `render` module runs on the GPU (`src/design/engine/render-wasm.ts`) and by Node for the
//! CPU path (exports, thumbnails, the goldens test). The editor's main engine module keeps its 700 KiB budget.
//!
//! The document never crosses as scene subtrees: [`RenderDoc`] is fed the same JSON patches the editor's store
//! applies (`load`, `load_part`, `apply_patch`, or S1's binary `decode` for a whole file), plus the pictures and the
//! text sprites the host paints (text drawing is L3's). The web build (`--features gpu --no-default-features`)
//! ships [`GpuRenderer`]: tiles in a texture atlas, the composite pass, the live layer, straight to the canvas;
//! the nodejs build (default `cpu`) ships `RenderDoc::render` through vello_cpu.
// The entry points take the host's numbers one by one (wasm-bindgen passes scalars without allocation).
#![allow(clippy::too_many_arguments)]

use morfa_model::store::Document;
use morfa_model::{from_json, patch_from_json};
use morfa_render::doc::{RenderDoc as Inner, Sprite};
use morfa_render::kurbo::Rect;
use morfa_render::painter::{Counters, Dots, Options};
use morfa_render::peniko::color::{AlphaColor, Srgb};
use morfa_render::sink::Picture;
use std::collections::HashSet;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

fn fail(entry: &str, error: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("RenderDoc.{entry}: {error}"))
}

/// This crate's version (the workspace's), for the loader's smoke check.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// Painting options as the host sends them (JSON): `hidden` ids, `outlines`, `layoutGrids`, `minSize`,
/// `rootOpacity`, `spriteScale`, `clipToAncestors`, `paintHiddenRoots`.
fn options_of(doc: &Inner, json: &str) -> Result<Options, JsError> {
    #[derive(serde::Deserialize, Default)]
    #[serde(rename_all = "camelCase", default)]
    struct Raw {
        hidden: Vec<String>,
        outlines: bool,
        layout_grids: bool,
        paint_hidden_roots: bool,
        min_size: f64,
        root_opacity: Option<f64>,
        sprite_scale: Option<f64>,
        clip_to_ancestors: Option<bool>,
        dot_grid: Option<RawDots>,
    }
    #[derive(serde::Deserialize)]
    struct RawDots {
        lefts: Vec<f64>,
        tops: Vec<f64>,
        side: f64,
        /// r, g, b, a in 0–1 (as the background).
        color: [f64; 4],
    }
    let raw: Raw = if json.trim().is_empty() {
        Raw::default()
    } else {
        serde_json::from_str(json).map_err(|e| fail("options", e))?
    };
    let mut hidden = HashSet::new();
    for key in &raw.hidden {
        if let Some(id) = doc.id(key) {
            hidden.insert(id);
        }
    }
    Ok(Options {
        hidden,
        outlines: raw.outlines,
        layout_grids: raw.layout_grids,
        paint_hidden_roots: raw.paint_hidden_roots,
        min_size: raw.min_size,
        root_opacity: raw.root_opacity.unwrap_or(1.0),
        sprite_scale: raw.sprite_scale.unwrap_or(1.0),
        clip_to_ancestors: raw.clip_to_ancestors.unwrap_or(true),
        dots: raw.dot_grid.map(|d| Dots {
            lefts: d.lefts,
            tops: d.tops,
            side: d.side,
            color: color(d.color[0], d.color[1], d.color[2], d.color[3]),
        }),
    })
}

fn color(r: f64, g: f64, b: f64, a: f64) -> AlphaColor<Srgb> {
    AlphaColor::<Srgb>::new([r as f32, g as f32, b as f32, a as f32])
}

fn counters_json(c: &Counters) -> String {
    format!(
        "{{\"nodes\":{},\"fills\":{},\"strokes\":{},\"layers\":{},\"effectBitmaps\":{},\"backdrops\":{},\"sprites\":{},\"missingSprites\":{},\"missingPictures\":{}}}",
        c.nodes,
        c.fills,
        c.strokes,
        c.layers,
        c.effect_bitmaps,
        c.backdrops,
        c.sprites,
        c.missing_sprites,
        c.missing_pictures
    )
}

/// The renderer's own shadow of the document plus the pictures and text sprites it draws with.
#[wasm_bindgen]
pub struct RenderDoc {
    inner: Inner,
    last: Counters,
    last_size: [u32; 2],
}

#[wasm_bindgen]
impl RenderDoc {
    /// A render document from a `DesignDocument` JSON (an empty skeleton with `nodes: {}` plus `load_part`s for
    /// a large file).
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<RenderDoc, JsError> {
        console_error_panic_hook::set_once();
        let model = from_json(json).map_err(|e| fail("new", e))?;
        Ok(RenderDoc {
            inner: Inner::new(Document::from_model(&model)),
            last: Counters::default(),
            last_size: [0, 0],
        })
    }

    /// Replaces the whole document.
    pub fn load(&mut self, json: &str) -> Result<(), JsError> {
        let model = from_json(json).map_err(|e| fail("load", e))?;
        self.inner.load(Document::from_model(&model));
        Ok(())
    }

    /// Replaces the whole document from S1's binary codec (`MorfaDoc.encode()` of the main engine module): the
    /// big-file path — no JSON of the file is written or parsed on the way (shared/design/big-files.ts).
    pub fn load_bytes(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let doc = morfa_model::codec::decode(bytes).map_err(|e| fail("load_bytes", e))?;
        self.inner.load(doc);
        Ok(())
    }

    /// A part of a document being loaded (a patch with a slice of the node table).
    pub fn load_part(&mut self, json: &str) -> Result<(), JsError> {
        let patch = patch_from_json(json).map_err(|e| fail("load_part", e))?;
        self.inner.load_part(&patch);
        Ok(())
    }

    /// One `DocumentPatch` as the store applied it.
    pub fn apply_patch(&mut self, json: &str) -> Result<(), JsError> {
        let patch = patch_from_json(json).map_err(|e| fail("apply_patch", e))?;
        self.inner.apply_patch(&patch);
        Ok(())
    }

    /// A whole document in S1's binary codec (`MorfaDoc.encode()` of the main engine module).
    pub fn decode(bytes: &[u8]) -> Result<RenderDoc, JsError> {
        console_error_panic_hook::set_once();
        let doc = morfa_model::codec::decode(bytes).map_err(|e| fail("decode", e))?;
        Ok(RenderDoc {
            inner: Inner::new(doc),
            last: Counters::default(),
            last_size: [0, 0],
        })
    }

    pub fn version(&self) -> f64 {
        self.inner.version() as f64
    }

    pub fn pages(&self) -> Vec<String> {
        self.inner
            .page_ids()
            .iter()
            .map(|id| self.inner.key(*id).to_owned())
            .collect()
    }

    /// Registers a decoded picture (straight-alpha RGBA8) under its image ref.
    pub fn register_image(
        &mut self,
        image_ref: &str,
        width: u32,
        height: u32,
        rgba: &[u8],
    ) -> Result<(), JsError> {
        if rgba.len() != (width * height * 4) as usize {
            return Err(fail(
                "register_image",
                "rgba length does not match the size",
            ));
        }
        self.inner
            .register_picture(image_ref, width, height, rgba.to_vec());
        Ok(())
    }

    pub fn has_image(&self, image_ref: &str) -> bool {
        self.inner.has_picture(image_ref)
    }

    /// A text sprite: the text node painted by the host at `scale` device px per local px, covering the local
    /// rectangle (x, y, w, h), `pw` × `ph` pixels of straight-alpha RGBA8, with the host's font revision.
    pub fn set_text_sprite(
        &mut self,
        id: &str,
        scale: f64,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        pw: u32,
        ph: u32,
        revision: u32,
        rgba: &[u8],
    ) -> Result<(), JsError> {
        let Some(node_id) = self.inner.id(id) else {
            return Err(fail("set_text_sprite", format!("no node '{id}'")));
        };
        if rgba.len() != (pw * ph * 4) as usize {
            return Err(fail(
                "set_text_sprite",
                "rgba length does not match the size",
            ));
        }
        let picture = Arc::new(Picture::flat(pw, ph, rgba.to_vec()));
        self.inner.set_sprite(
            node_id,
            Sprite {
                scale,
                rect: Rect::new(x, y, x + w, y + h),
                picture,
                revision,
            },
        );
        Ok(())
    }

    pub fn drop_text_sprites(&mut self, id: &str) {
        if let Some(node_id) = self.inner.id(id) {
            self.inner.drop_sprites(node_id);
        }
    }

    pub fn clear_text_sprites(&mut self) {
        self.inner.clear_sprites();
    }

    pub fn set_sprite_budget(&mut self, bytes: f64) {
        self.inner.set_sprite_budget(bytes.max(0.0) as usize);
    }

    /// Ids of the text nodes under the page rectangle that have no sprite at `scale` with `revision`.
    pub fn sprites_needed(
        &mut self,
        page: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        scale: f64,
        revision: u32,
    ) -> Result<Vec<String>, JsError> {
        let page_id = self
            .inner
            .id(page)
            .ok_or_else(|| fail("sprites_needed", format!("no page '{page}'")))?;
        let ids =
            self.inner
                .sprites_needed(page_id, Rect::new(x, y, x + w, y + h), scale, revision);
        Ok(ids
            .iter()
            .map(|id| self.inner.key(*id).to_owned())
            .collect())
    }

    /// `[x, y, width, height]` of the page's painted area, or an empty array.
    pub fn page_area(&mut self, page: &str) -> Vec<f64> {
        let Some(page_id) = self.inner.id(page) else {
            return Vec::new();
        };
        match self.inner.page_area(page_id) {
            Some(r) => vec![r.x0, r.y0, r.width(), r.height()],
            None => Vec::new(),
        }
    }

    /// Page-space render bounds of a node on `page` (`[x, y, width, height]`), or an empty array.
    pub fn bounds(&mut self, page: &str, id: &str) -> Vec<f64> {
        let (Some(page_id), Some(node_id)) = (self.inner.id(page), self.inner.id(id)) else {
            return Vec::new();
        };
        self.inner.sync_bounds(page_id);
        match self.inner.bounds_of(node_id) {
            Some(r) => vec![r.x0, r.y0, r.width(), r.height()],
            None => Vec::new(),
        }
    }

    /// Page px the largest background blur on the page reads around itself.
    pub fn blur_margin(&self, page: &str) -> f64 {
        self.inner
            .id(page)
            .map(|id| self.inner.blur_margin(id))
            .unwrap_or(0.0)
    }

    /// `{nodes, version, pictureBytes, spriteBytes, memoryBytes}` as JSON (memoryBytes is the wasm memory).
    pub fn stats(&self) -> String {
        format!(
            "{{\"nodes\":{},\"version\":{},\"pictureBytes\":{},\"spriteBytes\":{},\"memoryBytes\":{}}}",
            self.inner.document().len(),
            self.inner.version(),
            self.inner.picture_bytes(),
            self.inner.sprite_bytes(),
            memory_bytes()
        )
    }

    /// The counters of the last render (JSON).
    pub fn last_counters(&self) -> String {
        counters_json(&self.last)
    }

    /// The CPU path: the page rectangle (x, y, w, h page px) at `scale` over the background colour, as
    /// straight-alpha RGBA8 of `ceil(w·scale)` × `ceil(h·scale)` px (the size is in `last_size`).
    #[cfg(feature = "cpu")]
    pub fn render(
        &mut self,
        page: &str,
        x: f64,
        y: f64,
        w: f64,
        h: f64,
        scale: f64,
        r: f64,
        g: f64,
        b: f64,
        options: &str,
    ) -> Result<Vec<u8>, JsError> {
        let page_id = self
            .inner
            .id(page)
            .ok_or_else(|| fail("render", format!("no page '{page}'")))?;
        let options = options_of(&self.inner, options)?;
        self.inner.sync_bounds(page_id);
        let (width, height, pixels, counters) = morfa_render::cpu::render_region(
            &self.inner,
            &options,
            page_id,
            Rect::new(x, y, x + w, y + h),
            scale,
            color(r, g, b, 1.0),
            0,
        );
        self.last = counters;
        self.last_size = [width, height];
        Ok(morfa_render::cpu::unpremultiplied(pixels))
    }

    /// `[width, height]` of the last `render`.
    pub fn last_size(&self) -> Vec<u32> {
        self.last_size.to_vec()
    }
}

#[cfg(target_arch = "wasm32")]
fn memory_bytes() -> usize {
    core::arch::wasm32::memory_size(0) * 65_536
}

#[cfg(not(target_arch = "wasm32"))]
fn memory_bytes() -> usize {
    0
}

#[cfg(all(feature = "gpu", target_arch = "wasm32"))]
pub use gpu::GpuRenderer;

#[cfg(all(feature = "gpu", target_arch = "wasm32"))]
mod gpu {
    use super::*;
    use morfa_render::gpu::{Gpu, Quad, TileRenderer};
    use morfa_render::kurbo::Affine;

    fn gpu_fail(entry: &str, error: impl std::fmt::Display) -> JsError {
        JsError::new(&format!("GpuRenderer.{entry}: {error}"))
    }

    /// Tiles on WebGPU, composited straight onto the canvas.
    #[wasm_bindgen]
    pub struct GpuRenderer {
        tiles: TileRenderer,
        surface: wgpu::Surface<'static>,
        config: wgpu::SurfaceConfiguration,
        adapter: String,
        /// The off-screen frame of `frame_pixels`, kept by size.
        offscreen: Option<(wgpu::Texture, u32, u32)>,
    }

    #[wasm_bindgen]
    impl GpuRenderer {
        /// A renderer on `canvas` with an atlas of `tiles` slots (1 MiB each).
        pub async fn create(
            canvas: web_sys::HtmlCanvasElement,
            tiles: u32,
        ) -> Result<GpuRenderer, JsError> {
            console_error_panic_hook::set_once();
            let width = canvas.width().max(1);
            let height = canvas.height().max(1);
            let mut descriptor = wgpu::InstanceDescriptor::new_without_display_handle();
            descriptor.backends = wgpu::Backends::BROWSER_WEBGPU;
            let instance = wgpu::Instance::new(descriptor);
            let surface = instance
                .create_surface(wgpu::SurfaceTarget::Canvas(canvas))
                .map_err(|e| gpu_fail("create", e))?;
            let gpu = Gpu::new(&instance, Some(&surface))
                .await
                .map_err(|e| gpu_fail("create", e))?;
            // A lost device shows as odd failures later (every `createBuffer` "too large"): name the loss where it happens.
            gpu.device.set_device_lost_callback(|reason, message| {
                web_sys::console::error_1(&JsValue::from_str(&format!(
                    "GpuRenderer: the WebGPU device was lost ({reason:?}): {message}"
                )));
            });
            let adapter = format!("{} ({:?})", gpu.adapter_info.name, gpu.adapter_info.backend);
            let mut config = surface
                .get_default_config(&gpu.adapter, width, height)
                .ok_or_else(|| {
                    gpu_fail("create", "the canvas surface has no default configuration")
                })?;
            config.format = config.format.remove_srgb_suffix();
            config.present_mode = wgpu::PresentMode::AutoVsync;
            surface.configure(&gpu.device, &config);
            let tiles =
                TileRenderer::new(gpu, config.format, tiles).map_err(|e| gpu_fail("create", e))?;
            Ok(GpuRenderer {
                tiles,
                surface,
                config,
                adapter,
                offscreen: None,
            })
        }

        pub fn adapter(&self) -> String {
            self.adapter.clone()
        }

        pub fn capacity(&self) -> u32 {
            self.tiles.capacity()
        }

        pub fn resize(&mut self, width: u32, height: u32) {
            self.config.width = width.max(1);
            self.config.height = height.max(1);
            self.surface
                .configure(&self.tiles.backend.gpu.device, &self.config);
        }

        /// Rasterizes tile (i, j) of `page` at `scale` into atlas slot `slot`; the counters as JSON.
        pub fn raster_tile(
            &mut self,
            doc: &mut RenderDoc,
            page: &str,
            scale: f64,
            i: f64,
            j: f64,
            slot: u32,
            r: f64,
            g: f64,
            b: f64,
            margin: u32,
            options: &str,
        ) -> Result<String, JsError> {
            let page_id = doc
                .inner
                .id(page)
                .ok_or_else(|| gpu_fail("raster_tile", format!("no page '{page}'")))?;
            let options = options_of(&doc.inner, options)?;
            doc.inner.sync_bounds(page_id);
            let counters = self
                .tiles
                .raster_tile(
                    &doc.inner,
                    &options,
                    page_id,
                    scale,
                    i as i64,
                    j as i64,
                    slot,
                    color(r, g, b, 1.0),
                    margin,
                )
                .map_err(|e| gpu_fail("raster_tile", e))?;
            doc.last = counters;
            Ok(counters_json(&counters))
        }

        /// One frame: the background, the tiles (`quads`: 10 numbers each — slot, x0, y0, x1, y1, scissor x, y, w, h
        /// (w < 0: none), smooth), then the live roots (`live`: a JSON array of `{ids, clip}` groups, at `base` page →
        /// device, six numbers [a, b, c, d, e, f]), then an uploaded overlay bitmap (`overlay` handle, 0 for none);
        /// presented.
        pub fn frame(
            &mut self,
            doc: &mut RenderDoc,
            r: f64,
            g: f64,
            b: f64,
            quads: &[f32],
            live: &str,
            base: &[f64],
            scale: f64,
            options: &str,
            overlay: u32,
        ) -> Result<String, JsError> {
            let frame = match self.surface.get_current_texture() {
                wgpu::CurrentSurfaceTexture::Success(frame)
                | wgpu::CurrentSurfaceTexture::Suboptimal(frame) => frame,
                other => {
                    return Err(gpu_fail(
                        "frame",
                        format!("surface texture unavailable: {other:?}"),
                    ));
                }
            };
            let view = frame.texture.create_view(&wgpu::TextureViewDescriptor {
                format: Some(self.config.format),
                ..Default::default()
            });
            let (width, height) = (self.config.width, self.config.height);
            let counters = self.draw(
                &view, width, height, doc, r, g, b, quads, live, base, scale, options, overlay,
            )?;
            self.tiles.backend.gpu.queue.present(frame);
            Ok(counters_json(&counters))
        }

        /// The same frame drawn off screen at the canvas size and read back as RGBA8 (the harness on a software
        /// adapter, where a presented frame loses the device; tests). Nothing is presented.
        pub async fn frame_pixels(
            &mut self,
            doc: &mut RenderDoc,
            r: f64,
            g: f64,
            b: f64,
            quads: &[f32],
            live: &str,
            base: &[f64],
            scale: f64,
            options: &str,
            overlay: u32,
        ) -> Result<Vec<u8>, JsError> {
            let (width, height) = (self.config.width, self.config.height);
            let texture =
                match &self.offscreen {
                    Some((texture, w, h)) if *w == width && *h == height => texture.clone(),
                    _ => {
                        let texture = self.tiles.backend.gpu.device.create_texture(
                            &wgpu::TextureDescriptor {
                                label: Some("morfa offscreen frame"),
                                size: wgpu::Extent3d {
                                    width,
                                    height,
                                    depth_or_array_layers: 1,
                                },
                                mip_level_count: 1,
                                sample_count: 1,
                                dimension: wgpu::TextureDimension::D2,
                                format: self.config.format,
                                usage: wgpu::TextureUsages::RENDER_ATTACHMENT
                                    | wgpu::TextureUsages::COPY_SRC,
                                view_formats: &[],
                            },
                        );
                        self.offscreen = Some((texture.clone(), width, height));
                        texture
                    }
                };
            let view = texture.create_view(&wgpu::TextureViewDescriptor::default());
            self.draw(
                &view, width, height, doc, r, g, b, quads, live, base, scale, options, overlay,
            )?;
            let mut pixels = self
                .tiles
                .backend
                .gpu
                .read_texture(&texture, width, height)
                .await;
            if matches!(
                self.config.format,
                wgpu::TextureFormat::Bgra8Unorm | wgpu::TextureFormat::Bgra8UnormSrgb
            ) {
                for px in pixels.chunks_exact_mut(4) {
                    px.swap(0, 2);
                }
            }
            Ok(pixels)
        }

        fn draw(
            &mut self,
            view: &wgpu::TextureView,
            width: u32,
            height: u32,
            doc: &mut RenderDoc,
            r: f64,
            g: f64,
            b: f64,
            quads: &[f32],
            live: &str,
            base: &[f64],
            scale: f64,
            options: &str,
            overlay: u32,
        ) -> Result<Counters, JsError> {
            let list: Vec<Quad> = quads
                .chunks_exact(10)
                .map(|q| Quad {
                    slot: q[0] as u32,
                    dst: [q[1], q[2], q[3], q[4]],
                    scissor: if q[7] < 0.0 {
                        None
                    } else {
                        Some([
                            q[5].max(0.0) as u32,
                            q[6].max(0.0) as u32,
                            q[7] as u32,
                            q[8] as u32,
                        ])
                    },
                    smooth: q[9] > 0.5,
                })
                .collect();
            self.tiles
                .composite(view, width, height, color(r, g, b, 1.0), &list);
            let mut counters = Counters::default();
            #[derive(serde::Deserialize)]
            struct Group {
                ids: Vec<String>,
                clip: bool,
            }
            let groups: Vec<Group> = if live.trim().is_empty() {
                Vec::new()
            } else {
                serde_json::from_str(live).map_err(|e| gpu_fail("frame", e))?
            };
            if !groups.is_empty() && base.len() == 6 {
                let base_options = options_of(&doc.inner, options)?;
                let base = Affine::new([base[0], base[1], base[2], base[3], base[4], base[5]]);
                for group in groups {
                    let ids: Vec<_> = group.ids.iter().filter_map(|id| doc.inner.id(id)).collect();
                    if ids.is_empty() {
                        continue;
                    }
                    let options = Options {
                        clip_to_ancestors: group.clip,
                        ..base_options.clone()
                    };
                    let c = self
                        .tiles
                        .render_live(&doc.inner, &options, &ids, base, scale, view, width, height)
                        .map_err(|e| gpu_fail("frame", e))?;
                    counters.nodes += c.nodes;
                    counters.effect_bitmaps += c.effect_bitmaps;
                }
            }
            if overlay != 0 {
                self.tiles.draw_bitmap_over(overlay, view, width, height);
            }
            Ok(counters)
        }

        /// Uploads a straight-alpha RGBA8 bitmap (a labels overlay the host painted); its handle for `frame`.
        pub fn upload(&mut self, width: u32, height: u32, rgba: &[u8]) -> u32 {
            use morfa_render::record::Backend;
            self.tiles.backend.upload(width, height, rgba)
        }

        pub fn release(&mut self, handle: u32) {
            use morfa_render::record::Backend;
            self.tiles.backend.release(handle);
        }

        /// The pixels of an atlas slot as straight-alpha RGBA8 (512 × 512): the both-mode comparison, tests.
        pub async fn read_tile(&self, slot: u32) -> Vec<u8> {
            morfa_render::cpu_free_unpremultiply(self.tiles.read_tile(slot).await)
        }

        /// Renders a page rectangle off screen and reads it back (exports in the browser): straight-alpha RGBA8.
        pub async fn render(
            &mut self,
            doc: &mut RenderDoc,
            page: &str,
            x: f64,
            y: f64,
            w: f64,
            h: f64,
            scale: f64,
            r: f64,
            g: f64,
            b: f64,
            options: &str,
        ) -> Result<Vec<u8>, JsError> {
            use morfa_render::painter::{Painter, Target};
            use morfa_render::record::Recorder;
            let page_id = doc
                .inner
                .id(page)
                .ok_or_else(|| gpu_fail("render", format!("no page '{page}'")))?;
            let options = options_of(&doc.inner, options)?;
            doc.inner.sync_bounds(page_id);
            let width = (w * scale).ceil().max(1.0) as u32;
            let height = (h * scale).ceil().max(1.0) as u32;
            let painter = Painter::new(&doc.inner, &options);
            let target = Target {
                base: Affine::scale(scale) * Affine::translate((-x, -y)),
                scale,
                clip: Rect::new(0.0, 0.0, width as f64, height as f64),
            };
            let mut recorder =
                Recorder::new(&mut self.tiles.backend, width, height, color(r, g, b, 1.0));
            painter.paint_roots(&mut recorder, &target, &[page_id]);
            doc.last = painter.counters();
            doc.last_size = [width, height];
            let recording = recorder.into_recording();
            let pixels = self
                .tiles
                .backend
                .render_pixels(&recording)
                .await
                .map_err(|e| gpu_fail("render", e))?;
            Ok(morfa_render::cpu_free_unpremultiply(pixels))
        }

        /// Bytes of the atlas and of the bitmaps alive.
        pub fn memory_bytes(&self) -> f64 {
            self.tiles.atlas_bytes() as f64
        }
    }
}
