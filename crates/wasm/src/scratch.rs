//! The scratch buffer: 256 numbers in wasm memory that entry points write small results into (`*_into` entry
//! points), read by JavaScript through one `Float64Array` view (engine-switch.ts `engineScratch`). Returning a
//! `Vec<f64>` allocates in wasm, copies into a new `Float64Array` and frees, per call: about 0.9 µs in Node for six
//! numbers; the scratch buffer is a write and a read.

use std::cell::RefCell;
use wasm_bindgen::prelude::*;

pub const SCRATCH_LEN: usize = 256;

thread_local! {
    static SCRATCH: RefCell<[f64; SCRATCH_LEN]> = const { RefCell::new([0.0; SCRATCH_LEN]) };
}

/// The buffer's address in wasm memory (bytes); it never moves.
#[wasm_bindgen]
pub fn scratch_ptr() -> usize {
    SCRATCH.with(|scratch| scratch.as_ptr() as usize)
}

/// The wasm module's memory, for the view on the scratch buffer.
#[wasm_bindgen]
pub fn scratch_memory() -> JsValue {
    wasm_bindgen::memory()
}

/// Writes `values` at the start of the scratch buffer.
pub(crate) fn write(values: &[f64]) {
    SCRATCH.with(|scratch| scratch.borrow_mut()[..values.len()].copy_from_slice(values));
}
