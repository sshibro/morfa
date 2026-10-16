//! Read access to a document, for the functions whose cost should be the change, never the file: the merge, the
//! inverse of a patch, the rebase, the patched-document check. A [`Value`] document implements it directly; the wasm
//! harness implements it over a document that stays in JavaScript (read entry by entry), and the collab server can
//! implement it over its own store.

use crate::patch::table_of;
use crate::value::{Str, Value};
use std::sync::Arc;

pub trait DocRead {
    /// `doc.pages` (null when absent).
    fn pages(&self) -> Value;
    /// `doc[table][key]`, None when the table or the entry is absent.
    fn entry(&self, table: &str, key: &str) -> Option<Value>;
    /// The number of entries of `table` (`Object.keys(doc[table]).length`).
    fn size(&self, table: &str) -> usize;
    /// Every key of `table` in order, each with a token that is equal for two entries exactly when they are the same
    /// object (JavaScript's `===`).
    fn identities(&self, table: &str) -> Vec<(Str, usize)>;
    /// A hint: these entries will be read (a document behind a boundary fetches them in one trip).
    fn prefetch(&self, _table: &str, _keys: &mut dyn Iterator<Item = &Str>) {}
    /// A node with only `fields` (those present): what a reader that needs a few fields asks, so a document behind a
    /// boundary sends little. A full node is a valid answer (a superset).
    fn projection(&self, id: &str, _fields: &'static [&'static str]) -> Option<Value> {
        self.entry("nodes", id)
    }
    /// Whether a transaction should read this document's nodes field by field ([`DocRead::node_fields`]): a document
    /// behind a boundary, where a whole node costs its forty fields to send and the transaction needs a few.
    fn partial_nodes(&self) -> bool {
        false
    }
    /// A node with at least `fields` (those it has), None when it is absent. A full node is a valid answer.
    fn node_fields(&self, id: &str, _fields: &[&str]) -> Option<Value> {
        self.entry("nodes", id)
    }
    /// A hint: these nodes' projections will be read.
    fn prefetch_projection(
        &self,
        _keys: &mut dyn Iterator<Item = &Str>,
        _fields: &'static [&'static str],
    ) {
    }
}

/// A node's place in the tree: what the patched-document check reads of the document a patch was made on.
pub const STRUCTURE_FIELDS: &[&str] = &["id", "type", "parentId", "children", "mainId"];
/// What the patched-document check reads of a node of the patched document.
pub const CHECK_FIELDS: &[&str] = &[
    "id",
    "type",
    "parentId",
    "children",
    "mainId",
    "remote",
    "text",
    "textPath",
    "measurements",
    "annotations",
    "vectorPaths",
];

/// An entry's identity token: the address of its shared allocation.
pub fn identity(value: &Value) -> usize {
    match value {
        Value::Object(object) => Arc::as_ptr(object).cast::<u8>() as usize,
        Value::Array(items) => Arc::as_ptr(items).cast::<u8>() as usize,
        Value::String(text) => Arc::as_ptr(text).cast::<u8>() as usize,
        Value::Null => 0,
        Value::Bool(value) => 1 + usize::from(*value),
        // Numbers in a table are not entries the schema allows; each compares unequal.
        Value::Number(_) => usize::MAX,
    }
}

impl DocRead for Value {
    fn pages(&self) -> Value {
        self.get("pages").cloned().unwrap_or(Value::Null)
    }

    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        table_of(self, table)
            .and_then(|entries| entries.get(key))
            .cloned()
    }

    fn size(&self, table: &str) -> usize {
        table_of(self, table).map_or(0, crate::value::Object::len)
    }

    fn identities(&self, table: &str) -> Vec<(Str, usize)> {
        table_of(self, table)
            .map(|entries| {
                entries
                    .iter()
                    .map(|(key, value)| (key.clone(), identity(value)))
                    .collect()
            })
            .unwrap_or_default()
    }
}

/// `applyPatch(base, patch)` read through, without making it: an entry the patch names is the patch's (`null`:
/// absent), any other the base's. What the server checks a merged change against before it writes the change into
/// the one document it holds (no copy of a 20 000-entry table to compare before and after).
pub struct Patched<'a> {
    pub base: &'a dyn DocRead,
    pub patch: &'a Value,
}

impl Patched<'_> {
    fn written(&self, table: &str, key: &str) -> Option<&Value> {
        table_of(self.patch, table).and_then(|changes| changes.get(key))
    }
}

impl DocRead for Patched<'_> {
    fn pages(&self) -> Value {
        crate::patch::pages_of(self.patch)
            .cloned()
            .unwrap_or_else(|| self.base.pages())
    }

    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        match self.written(table, key) {
            Some(value) if value.is_null() => None,
            Some(value) => Some(value.clone()),
            None => self.base.entry(table, key),
        }
    }

    fn size(&self, table: &str) -> usize {
        let mut size = self.base.size(table);
        if let Some(changes) = table_of(self.patch, table) {
            for (key, value) in changes.iter() {
                let had = self.base.entry(table, key).is_some();
                match (had, value.is_null()) {
                    (false, false) => size += 1,
                    (true, true) => size -= 1,
                    _ => {}
                }
            }
        }
        size
    }

    fn identities(&self, table: &str) -> Vec<(Str, usize)> {
        // The base's keys in order, the patch's written over them (a new key goes last, as `applyPatch` puts it).
        let mut out = crate::value::Object::new();
        for (key, token) in self.base.identities(table) {
            #[allow(clippy::cast_precision_loss)]
            out.insert(key, Value::Number(token as f64));
        }
        if let Some(changes) = table_of(self.patch, table) {
            for (key, value) in changes.iter() {
                if value.is_null() {
                    out.remove(key);
                } else {
                    #[allow(clippy::cast_precision_loss)]
                    out.insert(key.clone(), Value::Number(identity(value) as f64));
                }
            }
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        out.iter()
            .map(|(key, token)| (key.clone(), token.as_f64().unwrap_or(0.0) as usize))
            .collect()
    }

    fn prefetch(&self, table: &str, keys: &mut dyn Iterator<Item = &Str>) {
        let unwritten: Vec<&Str> = keys
            .filter(|key| self.written(table, key).is_none())
            .collect();
        self.base.prefetch(table, &mut unwritten.into_iter());
    }
}

/// A borrowed document reads as the document (a transaction on `&doc` leaves the caller its own).
impl<T: DocRead + ?Sized> DocRead for &T {
    fn pages(&self) -> Value {
        (**self).pages()
    }
    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        (**self).entry(table, key)
    }
    fn size(&self, table: &str) -> usize {
        (**self).size(table)
    }
    fn identities(&self, table: &str) -> Vec<(Str, usize)> {
        (**self).identities(table)
    }
    fn prefetch(&self, table: &str, keys: &mut dyn Iterator<Item = &Str>) {
        (**self).prefetch(table, keys);
    }
    fn projection(&self, id: &str, fields: &'static [&'static str]) -> Option<Value> {
        (**self).projection(id, fields)
    }
    fn partial_nodes(&self) -> bool {
        (**self).partial_nodes()
    }
    fn node_fields(&self, id: &str, fields: &[&str]) -> Option<Value> {
        (**self).node_fields(id, fields)
    }
    fn prefetch_projection(
        &self,
        keys: &mut dyn Iterator<Item = &Str>,
        fields: &'static [&'static str],
    ) {
        (**self).prefetch_projection(keys, fields);
    }
}
