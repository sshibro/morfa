//! server/design/apply.ts: THE apply step of `PATCH /api/design-files/:id/document`: the stored document and a change
//! → the next document. With `before` copies the change merges field by field into whatever version the file is at
//! now ([`merge_change`]); without them it applies as it is.

use crate::doc::DocRead;
use crate::merge::{DocumentTarget, merge_change};
use crate::patch::{TABLES, apply_patch_mut, pages_of};
use crate::value::{Object, Str, Value};

/// `AppliedChange`: the next document, the entries written (`stored`), and whether they differ from what was sent.
#[derive(Clone, Debug)]
pub struct AppliedChange {
    pub doc: Value,
    pub stored: Value,
    pub adjusted: bool,
}

/// `applyDocumentChange(current, change)`. `change` is `{patch, before?, beforeTables?}`.
pub fn apply_document_change(current: &Value, change: &Value) -> AppliedChange {
    let mut doc = current.clone();
    let (stored, adjusted) = apply_document_change_mut(&mut doc, change);
    AppliedChange {
        doc,
        stored,
        adjusted,
    }
}

/// [`apply_document_change`] in place: `doc` becomes the next document; returns `(stored, adjusted)`.
pub fn apply_document_change_mut(doc: &mut Value, change: &Value) -> (Value, bool) {
    let empty = Value::object(Object::new());
    let patch = change.get("patch").unwrap_or(&empty);
    let before = change.get("before");
    let before_tables = change.get("beforeTables");
    if before.is_none() && before_tables.is_none() {
        apply_patch_mut(doc, patch);
        return (patch.clone(), false);
    }
    let (stored, adjusted) = merge_document_change(&*doc, change);
    apply_patch_mut(doc, &stored);
    (stored, adjusted)
}

/// The merge half of [`apply_document_change`] for a change with `before` copies: `(stored, adjusted)`, read from
/// `current` entry by entry. Without `before` copies `stored` is the patch as sent.
pub fn merge_document_change(current: &dyn DocRead, change: &Value) -> (Value, bool) {
    let empty = Value::object(Object::new());
    let patch = change.get("patch").unwrap_or(&empty);
    let before = change.get("before");
    let before_tables = change.get("beforeTables");
    if before.is_none() && before_tables.is_none() {
        return (patch.clone(), false);
    }
    // `{...change.beforeTables, nodes: change.before ?? {}}`
    let mut base = before_tables
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    base.insert(
        "nodes",
        before
            .filter(|before| !before.is_null())
            .cloned()
            .unwrap_or_else(|| empty.clone()),
    );
    let merged = merge_change(&DocumentTarget(current), patch, Some(&Value::object(base)));
    (merged.patch, merged.adjusted)
}

/// `storedValues(doc, sent, stored)`: what the server holds now for every entry the client sent or the merge wrote.
pub fn stored_values(doc: &dyn DocRead, sent: &Value, stored: &Value) -> Value {
    let mut out = Object::new();
    for table in TABLES {
        let mut keys: indexmap::IndexSet<Str, foldhash::fast::FixedState> =
            indexmap::IndexSet::default();
        for source in [sent, stored] {
            if let Some(entries) = source
                .get(table)
                .filter(|value| !value.is_null())
                .and_then(Value::as_object)
            {
                keys.extend(entries.keys().cloned());
            }
        }
        if keys.is_empty() {
            continue;
        }
        doc.prefetch(table, &mut keys.iter());
        let mut values = Object::with_capacity(keys.len());
        for key in keys {
            let value = doc.entry(table, &key).unwrap_or(Value::Null);
            values.insert(key, value);
        }
        out.insert(table, Value::object(values));
    }
    if pages_of(sent).is_some() || pages_of(stored).is_some() {
        let pages = match doc.pages() {
            Value::Array(items) => Value::array(items.as_ref().clone()),
            _ => Value::array(Vec::new()),
        };
        out.insert("pages", pages);
    }
    Value::object(out)
}
