# crates

The Rust engine lives here: the root `Cargo.toml` (`members = ["crates/*"]`) and `rust-toolchain.toml` define the
workspace. Commands: `docs/dev.md` §Rust.

## Crate map

- `model` (`morfa-model`): serde document types mirroring `shared/design/types.ts`.
- `geometry` (`morfa-geometry`): paths, bounds, boolean, outline stroke, flatten, hit test, spatial index.
- `text` (`morfa-text`): shaping, text layout, glyph outlines and drawing.
- `layout` (`morfa-layout`): auto layout, constraints, group fit, instances, variants, variables; `src/normalize.rs` is the orchestrator.
- `ops` (`morfa-ops`): transactions, patches, co-editing merge.
- `render` (`morfa-render`): the scene renderer.
- `export` (`morfa-export`): SVG, PDF and raster export.
- `geometry-wasm` (`morfa-geometry-wasm`): the geometry module of its own (booleans, outline stroke; feature `harness` for the differential harness), built by `scripts/wasm-geometry-build.sh` into `src/design/wasm-geometry/` (web, loaded lazily) and `server/design/wasm-geometry/` (nodejs), never committed.
- `wasm` (`morfa-wasm`): the JavaScript boundary (wasm-bindgen API, shadow document), built by `scripts/wasm-build.sh` into `src/design/wasm/` (web) and `server/design/wasm/` (nodejs), never committed.

## Contracts

`crates/model`, the `crates/wasm` API and `crates/layout/src/normalize.rs` (and, on the TypeScript side,
`shared/design/engine-switch.ts`) are the contracts between the crates. A change to one (a model field, a wasm entry
point) is noted in `crates/model/CHANGELOG.md`.
