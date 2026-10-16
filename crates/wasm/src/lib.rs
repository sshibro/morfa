//! `morfa-wasm`: the engine's JavaScript boundary. Only the coordinator edits this API (crates/README.md).
//!
//! `scripts/wasm-build.sh` builds it twice with wasm-pack: `--target web` into `src/design/wasm/` (the editor)
//! and `--target nodejs` into `server/design/wasm/` (the server and the unit tests).
//!
//! The TypeScript side is `shared/design/engine-switch.ts`: it picks `ts`, `wasm` or `both` per module and keeps one
//! [`MorfaDoc`] (the shadow document) in step with the editor's store, so module calls cross the boundary as an id
//! and a few numbers, never as scene subtrees. Module entry points are added here on request:
//! methods of `MorfaDoc` for calls that read the
//! document, free functions for pure ones.

use wasm_bindgen::prelude::*;

mod delta;
mod doc;
#[cfg(test)]
mod e3_timing;
mod fault;
mod geometry;
mod normalize;
mod ops;
mod parts;
mod protocol;
mod scratch;
#[cfg(feature = "server")]
mod server_document;

pub use doc::MorfaDoc;

/// Talc instead of the default dlmalloc (lane E1): the normalize path allocates per node it converts and writes.
#[cfg(all(not(target_feature = "atomics"), target_family = "wasm"))]
#[global_allocator]
static TALC: talc::wasm::WasmDynamicTalc = talc::wasm::new_wasm_dynamic_allocator();
pub use protocol::{decode_frame, encode_frame};
#[cfg(feature = "server")]
pub use server_document::{ServerDocument, read_server_document, read_server_put};

/// The engine's version: this crate's version from the workspace.
#[wasm_bindgen]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_owned()
}

/// The big-files switch of the model crate's caps (docs/decisions/big-files.md §1): the JavaScript side sets it
/// from `shared/design/big-files.ts` when the module is installed, so `both` mode compares like with like.
#[wasm_bindgen]
pub fn set_big_files(on: bool) {
    morfa_model::limits::set_big_files(Some(on));
}

#[cfg(test)]
mod tests {
    #[test]
    fn version_is_the_workspace_version() {
        assert_eq!(super::version(), "0.1.0");
    }
}
