//! `morfa-export` (lane L5): the export of `shared/design/{svg-export,pdf-export}.ts` in Rust.
//!
//! - [`svg`]: `exportSvg`/`exportSvgPage`, byte-equal to the TypeScript (the oracle, `withEngine('export', …)`).
//! - [`pdf`]: a vector PDF written directly (no Chromium): pages of the SVG exporter's print flavour drawn as PDF
//!   operators, text as real glyphs in embedded font subsets (feature `fonts`).
//! - raster export waits for the CPU renderer.
//!
//! The JavaScript boundary is `crates/export-wasm`, a module of its own loaded only when something is exported.

// `!(x > 0.0)` is the TypeScript's own test and is true for NaN; `partial_cmp` would hide that.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
#![allow(clippy::collapsible_if)]

#[cfg(feature = "fonts")]
pub mod fonts;
#[cfg(feature = "pdf")]
pub mod pdf;
pub mod strings;
pub mod stroke_profile;
pub mod svg;
pub mod text;
pub mod xml;

/// This crate's name, as the gate's smoke test reads it.
pub const CRATE: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn names_itself() {
        assert_eq!(super::CRATE, "morfa-export");
    }
}
