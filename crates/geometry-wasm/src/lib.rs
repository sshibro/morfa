//! `morfa-geometry-wasm`: the geometry (`crates/geometry`) as a wasm module of its own, apart from
//! `morfa-wasm`. The editor loads
//! it only when the engine switch runs `geometry` as `wasm` or `both` (src/design/engine/geometry-wasm.ts), Node
//! on first use (shared/design/geometry-wasm.ts); `scripts/wasm-geometry-build.sh` builds it into
//! src/design/wasm-geometry/ and server/design/wasm-geometry/.
//!
//! Pure functions only: path data and numbers in, areas and paths out (the encodings of `encode.rs`), no
//! document parsing, so morfa-model's JSON reader is not linked. The entries are the booleans and the outline
//! stroke of shared/design/{boolean,outline-stroke}.ts, which the TypeScript wires through
//! `withEngine('geometry', …)`. The readers of the shadow document (world matrix and box today; hit testing and
//! the spatial index next) live in `morfa-wasm`'s `MorfaDoc`.
//!
//! Feature `harness` adds every other entry of lane L1's differential harness (scripts/geometry/build.sh).

use std::cell::RefCell;

use morfa_geometry::clip::MultiPolygon;
use morfa_geometry::{boolean, outline};
use morfa_model::VectorPath;
use wasm_bindgen::prelude::*;

mod encode;
#[cfg(feature = "harness")]
mod harness;

use encode::{
    Reader, boolean_operation, decode_paths, encode_multipolygon, encode_paths, encode_polylines,
    marker, stroke_style,
};

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = Date, js_name = now)]
    fn date_now() -> f64;
}

/// Installs `Date.now` as the boolean time budget's clock (boolean.ts `BOOLEAN_TIME_BUDGET_MS`). The loaders call it
/// once, right after the module is instantiated.
#[wasm_bindgen(js_name = installClock)]
pub fn install_clock() {
    boolean::set_clock(date_now);
    // A panic traps (`unreachable`); its message is kept for `lastPanic` so the adapters can report it.
    std::panic::set_hook(Box::new(|info| {
        let message = info.to_string();
        LAST_PANIC.with(|p| *p.borrow_mut() = message);
    }));
}

thread_local! {
    static LAST_PANIC: RefCell<String> = const { RefCell::new(String::new()) };
}

/// The message of the last Rust panic (empty when none happened).
#[wasm_bindgen(js_name = lastPanic)]
pub fn last_panic() -> String {
    LAST_PANIC.with(|p| p.borrow().clone())
}

/// Bytes of the linear memory (the fuzz reports it beside the JS heap; it grows and never shrinks).
#[wasm_bindgen(js_name = memoryBytes)]
pub fn memory_bytes() -> f64 {
    #[cfg(target_arch = "wasm32")]
    return (core::arch::wasm32::memory_size(0) * 65536) as f64;
    #[cfg(not(target_arch = "wasm32"))]
    0.0
}
// ── Fault injection (the switch's fake-green test) ────────────────────────────────────────────

thread_local! {
    static FAULT: RefCell<String> = const { RefCell::new(String::new()) };
}

/// Turns on a deliberate wrong answer for one entry (`geometry.combinePaths`, `geometry.combinePathsLive`,
/// `geometry.strokeArea`), or off with `""`: tests prove the engine switch's `both` mode notices a wrong module (crates/wasm's `debug_fault` twin).
#[wasm_bindgen(js_name = debugFault)]
pub fn debug_fault(name: &str) {
    FAULT.with(|f| *f.borrow_mut() = name.to_owned());
}

/// The answer of `entry`, its first x moved by one when the entry's fault is on. `first_x`: where the first point's
/// x sits in the encoding (paths `[count, winding, length, M, x, …]`, areas `[count, rings, points, x, …]`).
fn faulted(entry: &str, first_x: usize, mut out: Vec<f64>) -> Vec<f64> {
    if out.len() > first_x && FAULT.with(|f| *f.borrow() == entry) {
        out[first_x] += 1.0;
    }
    out
}

// ── boolean.ts ─────────────────────────────────────────────────────────────────────────────────

#[wasm_bindgen(js_name = fillArea)]
pub fn fill_area(paths: &[f64], tolerance: f64) -> Vec<f64> {
    encode_multipolygon(&boolean::fill_area(&decode_paths(paths), tolerance))
}

/// `operands`: count, then multipolygons.
#[wasm_bindgen(js_name = combineAreas)]
pub fn combine_areas(operation: u32, operands: &[f64]) -> Vec<f64> {
    let mut r = Reader::new(operands);
    let n = r.next() as usize;
    let areas: Vec<MultiPolygon> = (0..n).map(|_| r.multipolygon()).collect();
    encode_multipolygon(&boolean::combine_areas(
        boolean_operation(operation),
        &areas,
    ))
}

#[wasm_bindgen(js_name = areaToPaths)]
pub fn area_to_paths(area: &[f64]) -> Vec<f64> {
    encode_paths(&boolean::area_to_paths(&Reader::new(area).multipolygon()))
}

/// `operands`: count, then encoded paths lists.
#[wasm_bindgen(js_name = combinePaths)]
pub fn combine_paths(operation: u32, operands: &[f64], tolerance: f64) -> Vec<f64> {
    combine_with(operation, operands, tolerance, false)
}

/// `combinePaths` for what the editor draws live (`boolean::combine_paths_live`: the same area, other vertices,
/// compared with TypeScript by area). Same encoding as `combinePaths`.
#[wasm_bindgen(js_name = combinePathsLive)]
pub fn combine_paths_live(operation: u32, operands: &[f64], tolerance: f64) -> Vec<f64> {
    combine_with(operation, operands, tolerance, true)
}

fn combine_with(operation: u32, operands: &[f64], tolerance: f64, live: bool) -> Vec<f64> {
    let mut r = Reader::new(operands);
    let n = r.next() as usize;
    let lists: Vec<Vec<VectorPath>> = (0..n).map(|_| r.paths()).collect();
    let combine = if live {
        boolean::combine_paths_live
    } else {
        boolean::combine_paths
    };
    let out = encode_paths(&combine(boolean_operation(operation), &lists, tolerance));
    let entry = if live {
        "geometry.combinePathsLive"
    } else {
        "geometry.combinePaths"
    };
    faulted(entry, 4, out)
}

// ── outline-stroke.ts ──────────────────────────────────────────────────────────────────────────

/// `style`: [weight, align (CENTER 0, INSIDE 1, OUTSIDE 2), cap (NONE 0, ROUND 1, SQUARE 2), join (MITER 0, BEVEL 1,
/// ROUND 2), miterLimit, dash…]; `tolerance` NaN for the default; markers as `marker` codes.
#[wasm_bindgen(js_name = strokeArea)]
pub fn stroke_area(
    paths: &[f64],
    style: &[f64],
    tolerance: f64,
    start_marker: u32,
    end_marker: u32,
) -> Vec<f64> {
    let s = stroke_style(
        style[0],
        style[1] as u32,
        style[2] as u32,
        style[3] as u32,
        style[4],
        &style[5..],
    );
    let tolerance = (!tolerance.is_nan()).then_some(tolerance);
    let out = encode_multipolygon(&outline::stroke_area(
        &decode_paths(paths),
        &s,
        tolerance,
        marker(start_marker),
        marker(end_marker),
    ));
    faulted("geometry.strokeArea", 3, out)
}

#[wasm_bindgen(js_name = dashPolylines)]
pub fn dash_polylines(lines: &[f64], pattern: &[f64]) -> Vec<f64> {
    encode_polylines(&outline::dash_polylines(
        &Reader::new(lines).polylines(),
        pattern,
    ))
}

#[wasm_bindgen(js_name = polygonsToSmoothPaths)]
pub fn polygons_to_smooth_paths(area: &[f64], tolerance: f64) -> Vec<f64> {
    encode_paths(&outline::polygons_to_smooth_paths(
        &Reader::new(area).multipolygon(),
        tolerance,
    ))
}
