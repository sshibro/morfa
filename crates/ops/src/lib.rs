//! `morfa-ops`: patches, the co-editing merge, the patched-document check and transactions. A port of shared/design/{patch,merge,transaction}.ts and server/design/apply.ts with the
//! TypeScript as the oracle: the same inputs give the same outputs, to the key order.
//!
//! Documents, patches and entries are [`Value`]s, JSON as JavaScript holds it (`value.rs` says why the merge is
//! written against open records rather than the model's typed structs). Native Rust callers (the collab server)
//! convert typed model values with [`Value::from_serialize`] / [`Value::to_model`], or implement
//! [`merge::MergeTarget`] over their own document store; JavaScript reaches it through crates/wasm (`src/ops.rs`), as JSON text.

pub mod apply;
pub mod check;
pub mod doc;
pub mod geometry;
pub mod merge;
pub mod patch;
pub mod stored;
pub mod text;
pub mod transaction;
pub mod value;

pub use apply::{AppliedChange, apply_document_change, stored_values};
pub use doc::DocRead;
pub use merge::{
    DocumentTarget, MergeOutcome, MergeTarget, Rebased, merge_change, merge_list, rebase_local,
    text_edit,
};
pub use patch::{
    apply_patch, apply_patch_mut, compose_patches, diff_documents, diff_documents_by_value,
    invert_patch, is_empty_patch,
};
pub use transaction::{Effect, Transaction, TransactionError, TransactionResult};
pub use value::{Object, Str, Value};

/// This crate's name, as the gate's smoke test reads it.
pub const CRATE: &str = env!("CARGO_PKG_NAME");

#[cfg(test)]
mod tests {
    #[test]
    fn names_itself() {
        assert_eq!(super::CRATE, "morfa-ops");
    }
}
