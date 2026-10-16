//! `morfa-render`: the scene renderer (`docs/decisions/renderer.md`).
//!
//! One painter ([`painter`]) walks the shadow document (`morfa_model::store::Document`) in the order and with the
//! geometry of `src/design/engine/render/painter.ts` — drop shadows → background blur → fills → inner shadows →
//! children (clipped) → strokes → grids, masks and booleans through layers — and emits device-space drawing to a
//! [`sink::Sink`]. Two sinks draw it: `vello_cpu` ([`cpu`], feature `cpu`: exports, thumbnails, the Node tests
//! against the goldens) and `vello` on wgpu ([`gpu`], feature `gpu`: WebGPU in the browser, Vulkan on lavapipe in
//! the tests, Metal on the Mac). Blur (layer blur, inner shadows, shadows of non-rectangles, background blur) is a
//! pass of our own on both: render the caster to a bitmap, blur it, draw it as an image ([`blur`] on the CPU, a WGSL
//! separable blur on the GPU).
//!
//! The renderer never takes scene subtrees across the JavaScript boundary: [`doc::RenderDoc`] holds the document
//! (fed by the same patches the editor's store applies) plus the pictures and text sprites the painter needs.

// `!(x > 0.0)` is the TypeScript's own test and is true for NaN; `partial_cmp` would hide that.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
// Nested `if`s and pixel loops mirror the TypeScript statement by statement (the port is reviewed side by side).
#![allow(
    clippy::too_many_arguments,
    clippy::collapsible_if,
    clippy::type_complexity
)]
#![allow(
    clippy::chunks_exact_to_as_chunks,
    clippy::manual_checked_ops,
    clippy::redundant_pattern_matching
)]

pub mod blur;
pub mod bounds;
#[cfg(feature = "cpu")]
pub mod cpu;
pub mod doc;
#[cfg(feature = "gpu")]
pub mod gpu;
pub mod live;
pub mod paint;
pub mod painter;
pub mod record;
#[cfg(feature = "cpu")]
pub mod server;
pub mod shape;
pub mod sink;

pub use kurbo;
pub use peniko;

/// Straight-alpha RGBA8 of a premultiplied render (readbacks for PNGs and comparisons), without the `cpu` feature.
pub fn cpu_free_unpremultiply(mut premul: Vec<u8>) -> Vec<u8> {
    blur::unpremultiply(&mut premul);
    premul
}

/// This crate's name, as the gate's smoke test reads it.
pub const CRATE: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn names_itself() {
        assert_eq!(super::CRATE, "morfa-render");
    }
}
