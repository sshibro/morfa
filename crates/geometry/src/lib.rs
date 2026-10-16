//! `morfa-geometry`: the TypeScript geometry of `shared/design/{geometry,paths,boolean,
//! outline-stroke,shapes}.ts` and the pure parts of `src/design/engine/{hit-test,render/spatial-index,
//! render/stroke-math}.ts`, ported in the same operation order so both engines give the same numbers.
//! The TS functions stay the oracle. The JavaScript boundary is `crates/geometry-wasm` (the
//! editor's lazily loaded module, and the differential harness under its feature `harness`).

// `!(x > 0.0)` is the TypeScript's own test and is true for NaN; `partial_cmp` would hide that.
#![allow(clippy::neg_cmp_op_on_partial_ord)]
// Nested `if`s mirror the TypeScript statement by statement (the port is reviewed side by side with it).
#![allow(clippy::collapsible_if)]

pub mod boolean;
pub mod bounds;
pub mod clip;
pub mod hit_test;
pub mod js;
pub mod matrix;
pub mod outline;
pub mod paths;
pub mod shapes;
mod sincos;
pub mod spatial;
pub mod stroke_math;
pub mod text_bounds;

pub mod proof;

/// This crate's name, as the gate's smoke test reads it.
pub const CRATE: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn names_itself() {
        assert_eq!(super::CRATE, "morfa-geometry");
    }
}
