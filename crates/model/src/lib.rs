//! `morfa-model`: the document model of the design tool in Rust.
//!
//! Mirrors `shared/design/types.ts` field for field (Figma plugin API names kept, serialized in camelCase) and
//! accepts exactly what `shared/design/schema.ts` `validateDocument` accepts: unknown keys are dropped as zod's
//! default `strip` does, every bound and structural invariant is checked. Changes are noted in `CHANGELOG.md`
//! (crates/README.md has the crate map).

pub mod codec;
mod de;
pub mod draft;
mod invariants;
pub mod js_json;
pub mod js_number;
pub mod json;
pub mod limits;
pub mod patch;
pub mod store;
pub mod types;
pub mod validate;

pub use draft::Ctx;
pub use js_number::{JsFormatter, JsPrettyFormatter, js_number};
pub use json::{
    from_json, from_json_validated, patch_from_deserializer, patch_from_json,
    patch_from_json_validated, to_json, to_json_pretty,
};
pub use patch::DocumentPatch;
pub use store::draft::{SlotSet, Stage, Working};
pub use types::*;
pub use validate::{Invalid, validate_document, validate_patch};
