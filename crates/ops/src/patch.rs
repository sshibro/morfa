//! shared/design/patch.ts: `DocumentPatch` and its algebra over documents held as [`Value`]s.
//!
//! A change to a file, at the granularity the editor and the server both understand: whole nodes, styles, images and
//! variables are replaced or removed (`null`); `pages` is the full new page order when it changed. Undo/redo,
//! autosave, version restore and the merge all move documents with these.
//!
//! Each function is the TypeScript one, reading its inputs as JavaScript would (a falsy table is skipped, a missing
//! one reads as empty). Identity: [`apply_patch`] keeps untouched tables and entries shared with the input, and
//! [`diff_documents`] compares entries by identity as the TypeScript does (immutable updates); a caller whose two
//! documents were parsed separately (no shared entries) uses [`diff_documents_by_value`].

use crate::doc::DocRead;
use crate::value::{Object, Str, Value};
use std::sync::Arc;

/// The tables a patch replaces entries of, in the TypeScript's order (`TABLES`, `PATCH_TABLES`).
pub const TABLES: [&str; 6] = [
    "nodes",
    "styles",
    "images",
    "variableCollections",
    "variables",
    "variableModes",
];

/// The value of `table` when it is an object (JavaScript skips a falsy one; the schema never lets another through).
pub fn table_of<'a>(value: &'a Value, table: &str) -> Option<&'a Object> {
    value.get(table).and_then(Value::as_object)
}

/// `patch.pages` when set (truthy).
pub fn pages_of(patch: &Value) -> Option<&Value> {
    patch.get("pages").filter(|pages| pages.truthy())
}

/// `[...list]`: a fresh copy of an array (anything else is copied as it is).
fn copy_list(list: &Value) -> Value {
    match list {
        Value::Array(items) => Value::array(items.as_ref().clone()),
        other => other.clone(),
    }
}

/// `isEmptyPatch`.
pub fn is_empty_patch(patch: &Value) -> bool {
    pages_of(patch).is_none()
        && TABLES
            .iter()
            .all(|table| table_of(patch, table).is_none_or(Object::is_empty))
}

/// `applyPatch`: a new document with the patch applied. Untouched tables and entries stay shared with `doc`.
pub fn apply_patch(doc: &Value, patch: &Value) -> Value {
    let mut next = doc.clone();
    apply_patch_mut(&mut next, patch);
    next
}

/// [`apply_patch`] in place: a table shared with another document is copied once, then written into (what
/// `applyPatch` does with a `nodesCopy`, the server's way of putting a document together from its waiting changes).
pub fn apply_patch_mut(doc: &mut Value, patch: &Value) {
    let Some(next) = doc.as_object_mut() else {
        return;
    };
    if let Some(pages) = pages_of(patch) {
        next.insert("pages", copy_list(pages));
    }
    for table in TABLES {
        let Some(changes) = table_of(patch, table) else {
            continue;
        };
        if changes.is_empty() {
            continue;
        }
        let mut copy = match next.get_mut(table) {
            Some(Value::Object(existing)) => std::mem::take(existing),
            _ => Arc::new(Object::new()),
        };
        let entries = Arc::make_mut(&mut copy);
        // Each key stands once in a patch, so the removals can go in one pass after the writes.
        let removals: std::collections::HashSet<&str, foldhash::fast::FixedState> = changes
            .iter()
            .filter(|(_, value)| value.is_null())
            .map(|(key, _)| &**key)
            .collect();
        for (key, value) in changes.iter() {
            if !value.is_null() {
                entries.insert(key.clone(), value.clone());
            }
        }
        if removals.len() > 4 {
            entries.remove_all(&removals);
        } else {
            for key in removals {
                entries.remove(key);
            }
        }
        next.insert(table, Value::Object(copy));
    }
}

/// `invertPatch`: the patch that takes `applyPatch(doc, patch)` back to `doc`. Reads only the entries the patch names.
pub fn invert_patch(doc: &dyn DocRead, patch: &Value) -> Value {
    let mut inverse = Object::new();
    if pages_of(patch).is_some() {
        let pages = doc.pages();
        inverse.insert(
            "pages",
            if pages.is_null() {
                Value::array(Vec::new())
            } else {
                copy_list(&pages)
            },
        );
    }
    for table in TABLES {
        let Some(changes) = table_of(patch, table) else {
            continue;
        };
        doc.prefetch(table, &mut changes.keys());
        let mut undo = Object::with_capacity(changes.len());
        for key in changes.keys() {
            undo.insert(key.clone(), doc.entry(table, key).unwrap_or(Value::Null));
        }
        inverse.insert(table, Value::object(undo));
    }
    Value::object(inverse)
}

/// `composePatches`: one patch with the effect of `first` then `second`.
pub fn compose_patches(first: &Value, second: &Value) -> Value {
    let mut out = Object::new();
    let pages = second
        .get("pages")
        .filter(|pages| !pages.is_null())
        .or_else(|| first.get("pages").filter(|pages| !pages.is_null()));
    if let Some(pages) = pages.filter(|pages| pages.truthy()) {
        out.insert("pages", copy_list(pages));
    }
    for table in TABLES {
        let a = first.get(table).filter(|value| value.truthy());
        let b = second.get(table).filter(|value| value.truthy());
        if a.is_none() && b.is_none() {
            continue;
        }
        let mut merged = Object::new();
        for side in [a, b].into_iter().flatten() {
            if let Some(entries) = side.as_object() {
                for (key, value) in entries.iter() {
                    merged.insert(key.clone(), value.clone());
                }
            }
        }
        out.insert(table, Value::object(merged));
    }
    Value::object(out)
}

/// `diffDocuments`: the patch that turns `before` into `after`, comparing entries by identity (immutable updates).
pub fn diff_documents(before: &dyn DocRead, after: &dyn DocRead) -> Value {
    let mut patch = Object::new();
    let (a_pages, b_pages) = (before.pages(), after.pages());
    if !a_pages.identical(&b_pages) {
        let a = a_pages.as_array().unwrap_or(&[]);
        let b = b_pages.as_array().unwrap_or(&[]);
        if a.len() != b.len() || a.iter().zip(b).any(|(x, y)| !x.identical(y)) {
            patch.insert("pages", copy_list(&b_pages));
        }
    }
    for table in TABLES {
        let a_ids = before.identities(table);
        let b_ids = after.identities(table);
        if a_ids.is_empty() && b_ids.is_empty() {
            continue;
        }
        let a: std::collections::HashMap<&Str, usize> =
            a_ids.iter().map(|(key, token)| (key, *token)).collect();
        let b: std::collections::HashSet<&Str> = b_ids.iter().map(|(key, _)| key).collect();
        let mut changes = Object::new();
        for (key, token) in &b_ids {
            if a.get(key) != Some(token) {
                changes.insert(key.clone(), after.entry(table, key).unwrap_or(Value::Null));
            }
        }
        for (key, _) in &a_ids {
            if !b.contains(key) {
                changes.insert(key.clone(), Value::Null);
            }
        }
        if !changes.is_empty() {
            patch.insert(table, Value::object(changes));
        }
    }
    Value::object(patch)
}

/// [`diff_documents`] for documents that share no entries (each parsed on its own): entries are compared by value.
pub fn diff_documents_by_value(before: &Value, after: &Value) -> Value {
    let mut patch = diff_documents(before, after);
    // Entries that differ only by identity are no change here.
    if let Some(object) = patch.as_object_mut() {
        for table in TABLES {
            let Some(Value::Object(changes)) = object.get_mut(table) else {
                continue;
            };
            let changes = std::sync::Arc::make_mut(changes);
            let same: Vec<Str> = changes
                .iter()
                .filter(|(key, value)| {
                    !value.is_null() && before.entry(table, key).is_some_and(|old| old.same(value))
                })
                .map(|(key, _)| key.clone())
                .collect();
            for key in same {
                changes.remove(&key);
            }
            if changes.is_empty() {
                object.remove(table);
            }
        }
    }
    patch
}

/// The keys a patch names in `table`.
pub fn patch_keys<'a>(patch: &'a Value, table: &str) -> impl Iterator<Item = &'a Str> {
    table_of(patch, table).into_iter().flat_map(Object::keys)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn json(text: &str) -> Value {
        Value::from_json(text).unwrap()
    }

    #[test]
    fn apply_invert_compose_diff() {
        let doc = json(
            r#"{"id":"d","pages":["p"],"nodes":{"p":{"id":"p"},"a":{"id":"a","x":1}},"styles":{},"images":{},"variableCollections":{},"variables":{}}"#,
        );
        let patch =
            json(r#"{"nodes":{"a":null,"b":{"id":"b"}},"pages":["p"],"variableModes":{"a":null}}"#);
        let next = apply_patch(&doc, &patch);
        assert_eq!(
            next.to_json(),
            r#"{"id":"d","pages":["p"],"nodes":{"p":{"id":"p"},"b":{"id":"b"}},"styles":{},"images":{},"variableCollections":{},"variables":{},"variableModes":{}}"#
        );
        // Untouched entries stay shared.
        assert!(
            next.get("nodes")
                .unwrap()
                .get("p")
                .unwrap()
                .identical(doc.get("nodes").unwrap().get("p").unwrap())
        );
        let inverse = invert_patch(&doc, &patch);
        assert_eq!(
            inverse.to_json(),
            r#"{"pages":["p"],"nodes":{"a":{"id":"a","x":1},"b":null},"variableModes":{"a":null}}"#
        );
        let back = apply_patch(&next, &inverse);
        assert!(diff_documents_by_value(&doc, &back).get("nodes").is_none());
        let composed = compose_patches(&patch, &inverse);
        assert_eq!(
            composed.to_json(),
            r#"{"pages":["p"],"nodes":{"a":{"id":"a","x":1},"b":null},"variableModes":{"a":null}}"#
        );
        let diff = diff_documents(&doc, &next);
        assert_eq!(diff.to_json(), r#"{"nodes":{"b":{"id":"b"},"a":null}}"#);
        assert!(is_empty_patch(&json(r#"{"nodes":{}}"#)));
        assert!(!is_empty_patch(&json(r#"{"pages":[]}"#)));
    }
}
