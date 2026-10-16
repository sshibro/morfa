//! The bridge to lane L2a's `crates/ops`: the co-editing merge (`mergeChange`) and the patched-document check
//! (`checkPatchedDocument`) read documents as JSON-like [`Value`]s, while the engine holds the model's typed
//! `DesignDocument`. This module reads the typed document for them, an entry at a time:
//! - [`Target`]: what the merge reads (whole entries, built on demand);
//! - [`After`] and [`Before`]: what the check reads, mostly node projections of [`CHECK_FIELDS`]. Projections
//!   of the document after an op are cached across ops ([`Projections`]): a page of 20 000 layers is rebuilt
//!   only when its own entry changes, not on every move of one of its layers.
//!
//! The engine's document is read through [`DocView`]: the model's typed `DesignDocument`, or its compact store
//! (`morfa_model::store::Document`, an actor's: about a seventh of the memory), whose nodes are converted to the
//! typed model one by one as they are read.

use morfa_model::store::Document as Store;
use morfa_model::{DesignDocument, DocumentPatch, Map, SceneNode};
use morfa_ops::doc::CHECK_FIELDS;
use morfa_ops::{DocRead, MergeTarget, Object, Str, Value};
use serde::Serialize;
use std::borrow::Cow;
use std::cell::RefCell;
use std::collections::HashMap;

/// A document as the engine reads it.
pub trait DocView {
    /// A node in the typed model.
    fn node(&self, id: &str) -> Option<Cow<'_, SceneNode>>;
    fn has_node(&self, id: &str) -> bool;
    fn node_count(&self) -> usize;
    /// Every node's id, in the table's order.
    fn node_ids(&self) -> Vec<String>;
    fn page_ids(&self) -> Vec<String>;
    /// The document's other tables (pages, styles, images, variables, collections, variable modes) in the typed
    /// model; its node table may be empty.
    fn tables(&self) -> Cow<'_, DesignDocument>;
}

impl DocView for DesignDocument {
    fn node(&self, id: &str) -> Option<Cow<'_, SceneNode>> {
        self.nodes.get(id).map(Cow::Borrowed)
    }
    fn has_node(&self, id: &str) -> bool {
        self.nodes.contains_key(id)
    }
    fn node_count(&self) -> usize {
        self.nodes.len()
    }
    fn node_ids(&self) -> Vec<String> {
        self.nodes.keys().cloned().collect()
    }
    fn page_ids(&self) -> Vec<String> {
        self.pages.clone()
    }
    fn tables(&self) -> Cow<'_, DesignDocument> {
        Cow::Borrowed(self)
    }
}

impl DocView for Store {
    fn node(&self, id: &str) -> Option<Cow<'_, SceneNode>> {
        self.node_model(id).map(Cow::Owned)
    }
    fn has_node(&self, id: &str) -> bool {
        self.node_by_key(id).is_some()
    }
    fn node_count(&self) -> usize {
        self.len()
    }
    fn node_ids(&self) -> Vec<String> {
        self.nodes()
            .map(|node| self.key(node.id).to_owned())
            .collect()
    }
    fn page_ids(&self) -> Vec<String> {
        self.pages
            .iter()
            .map(|&page| self.key(page).to_owned())
            .collect()
    }
    fn tables(&self) -> Cow<'_, DesignDocument> {
        Cow::Owned(self.tables_model())
    }
}

fn value<T: Serialize + ?Sized>(typed: &T) -> Value {
    Value::from_serialize(typed).expect("model values serialize")
}

fn ids<'a>(ids: impl Iterator<Item = &'a String>) -> Value {
    Value::array(ids.map(|id| Value::str(id)).collect())
}

/// A node's [`CHECK_FIELDS`] (a superset of `STRUCTURE_FIELDS`), as the check reads them.
pub fn projection(node: &SceneNode) -> Value {
    let mut out = Object::with_capacity(CHECK_FIELDS.len());
    out.insert("id", Value::str(&node.id));
    out.insert("type", value(&node.kind));
    out.insert(
        "parentId",
        node.parent_id.as_deref().map_or(Value::Null, Value::str),
    );
    if let Some(children) = &node.children {
        out.insert("children", ids(children.iter()));
    }
    if let Some(main) = &node.main_id {
        out.insert("mainId", Value::str(main));
    }
    if let Some(remote) = &node.remote {
        out.insert("remote", value(remote));
    }
    if let Some(text) = &node.text {
        out.insert("text", value(text));
    }
    if let Some(text_path) = &node.text_path {
        out.insert("textPath", value(text_path));
    }
    if let Some(measurements) = &node.measurements {
        out.insert("measurements", value(measurements));
    }
    if let Some(annotations) = &node.annotations {
        out.insert("annotations", value(annotations));
    }
    if let Some(paths) = &node.vector_paths {
        out.insert("vectorPaths", value(paths));
    }
    Value::object(out)
}

/// `doc[table][key]` as a whole entry.
fn entry(doc: &dyn DocView, table: &str, key: &str) -> Option<Value> {
    if table == "nodes" {
        return doc.node(key).map(|node| value(&*node));
    }
    let doc = doc.tables();
    match table {
        "styles" => doc.styles.get(key).map(value),
        "images" => doc.images.get(key).map(value),
        "variableCollections" => doc.variable_collections.get(key).map(value),
        "variables" => doc.variables.get(key).map(value),
        "variableModes" => doc
            .variable_modes
            .as_ref()
            .and_then(|t| t.get(key))
            .map(value),
        _ => None,
    }
}

fn keys(doc: &dyn DocView, table: &str) -> Vec<String> {
    fn of<T>(map: &Map<T>) -> Vec<String> {
        map.keys().cloned().collect()
    }
    if table == "nodes" {
        return doc.node_ids();
    }
    let doc = doc.tables();
    match table {
        "styles" => of(&doc.styles),
        "images" => of(&doc.images),
        "variableCollections" => of(&doc.variable_collections),
        "variables" => of(&doc.variables),
        "variableModes" => doc.variable_modes.as_ref().map(of).unwrap_or_default(),
        _ => Vec::new(),
    }
}

/// Keys a patch table writes, each with whether it puts a value (`true`) or removes (`false`).
fn patch_keys<'a>(patch: &'a DocumentPatch, table: &str) -> Option<Vec<(&'a str, bool)>> {
    fn of<T>(map: &Option<Map<Option<T>>>) -> Option<Vec<(&str, bool)>> {
        map.as_ref()
            .map(|m| m.iter().map(|(k, v)| (k.as_str(), v.is_some())).collect())
    }
    match table {
        "nodes" => of(&patch.nodes),
        "styles" => of(&patch.styles),
        "images" => of(&patch.images),
        "variableCollections" => of(&patch.variable_collections),
        "variables" => of(&patch.variables),
        "variableModes" => of(&patch.variable_modes),
        _ => None,
    }
}

fn patch_entry(patch: &DocumentPatch, table: &str, key: &str) -> Option<Option<Value>> {
    fn of<T: Serialize>(map: &Option<Map<Option<T>>>, key: &str) -> Option<Option<Value>> {
        map.as_ref()?.get(key).map(|v| v.as_ref().map(value))
    }
    match table {
        "nodes" => of(&patch.nodes, key),
        "styles" => of(&patch.styles, key),
        "images" => of(&patch.images, key),
        "variableCollections" => of(&patch.variable_collections, key),
        "variables" => of(&patch.variables, key),
        "variableModes" => of(&patch.variable_modes, key),
        _ => None,
    }
}

/// What the merge reads of the engine's document.
pub struct Target<'a>(pub &'a dyn DocView);

impl MergeTarget for Target<'_> {
    fn pages(&self) -> Value {
        ids(self.0.page_ids().iter())
    }
    fn node(&self, id: &str) -> Option<Value> {
        self.0.node(id).map(|node| value(&*node))
    }
    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        entry(self.0, table, key)
    }
}

/// Node projections of the engine's current document, kept across ops. Whoever changes the document forgets
/// the entries it changed ([`Projections::forget`]).
#[derive(Default)]
pub struct Projections {
    cache: RefCell<HashMap<String, Value>>,
}

/// More cached projections than this and the cache starts over (a bound, not a tuning).
const PROJECTIONS_KEPT: usize = 16_384;

impl Projections {
    fn get(&self, doc: &dyn DocView, id: &str) -> Option<Value> {
        if let Some(hit) = self.cache.borrow().get(id) {
            return Some(hit.clone());
        }
        let projected = projection(&*doc.node(id)?);
        let mut cache = self.cache.borrow_mut();
        if cache.len() >= PROJECTIONS_KEPT {
            cache.clear();
        }
        cache.insert(id.to_owned(), projected.clone());
        Some(projected)
    }

    /// The nodes `patch` writes changed.
    pub fn forget(&self, patch: &DocumentPatch) {
        if let Some(nodes) = &patch.nodes {
            let mut cache = self.cache.borrow_mut();
            for id in nodes.keys() {
                cache.remove(id);
            }
        }
    }

    pub fn clear(&self) {
        self.cache.borrow_mut().clear();
    }
}

/// The document after an op, as the check reads it.
pub struct After<'a> {
    pub doc: &'a dyn DocView,
    pub projections: &'a Projections,
}

impl DocRead for After<'_> {
    fn pages(&self) -> Value {
        ids(self.doc.page_ids().iter())
    }
    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        entry(self.doc, table, key)
    }
    fn size(&self, table: &str) -> usize {
        match table {
            "nodes" => self.doc.node_count(),
            other => keys(self.doc, other).len(),
        }
    }
    /// Identity tokens are per key here (the typed document shares nothing with another one): only
    /// `diffDocuments` reads them, never the check.
    fn identities(&self, table: &str) -> Vec<(Str, usize)> {
        keys(self.doc, table)
            .into_iter()
            .enumerate()
            .map(|(i, key)| (Str::from(key), i + 1))
            .collect()
    }
    fn projection(&self, id: &str, _fields: &'static [&'static str]) -> Option<Value> {
        self.projections.get(self.doc, id)
    }
}

/// The document before an op: the document after it with the op's `undo` laid over.
pub struct Before<'a> {
    pub after: &'a After<'a>,
    pub undo: &'a DocumentPatch,
}

impl DocRead for Before<'_> {
    fn pages(&self) -> Value {
        match &self.undo.pages {
            Some(pages) => ids(pages.iter()),
            None => self.after.pages(),
        }
    }
    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        match patch_entry(self.undo, table, key) {
            Some(before) => before,
            None => self.after.entry(table, key),
        }
    }
    fn size(&self, table: &str) -> usize {
        let mut size = self.after.size(table) as isize;
        for (key, present) in patch_keys(self.undo, table).unwrap_or_default() {
            let now = self.after.entry_exists(table, key);
            size += isize::from(present) - isize::from(now);
        }
        size.max(0) as usize
    }
    fn identities(&self, table: &str) -> Vec<(Str, usize)> {
        let mut keys: Vec<Str> = self
            .after
            .identities(table)
            .into_iter()
            .map(|(k, _)| k)
            .collect();
        for (key, present) in patch_keys(self.undo, table).unwrap_or_default() {
            let listed = keys.iter().position(|k| &**k == key);
            match (present, listed) {
                (true, None) => keys.push(Str::from(key)),
                (false, Some(at)) => {
                    keys.remove(at);
                }
                _ => {}
            }
        }
        keys.into_iter()
            .enumerate()
            .map(|(i, key)| (key, i + 1))
            .collect()
    }
    fn projection(&self, id: &str, fields: &'static [&'static str]) -> Option<Value> {
        match self.undo.nodes.as_ref().and_then(|nodes| nodes.get(id)) {
            Some(before) => before.as_ref().map(projection),
            None => self.after.projection(id, fields),
        }
    }
}

impl After<'_> {
    fn entry_exists(&self, table: &str, key: &str) -> bool {
        if table == "nodes" {
            return self.doc.has_node(key);
        }
        let doc = self.doc.tables();
        match table {
            "styles" => doc.styles.contains_key(key),
            "images" => doc.images.contains_key(key),
            "variableCollections" => doc.variable_collections.contains_key(key),
            "variables" => doc.variables.contains_key(key),
            "variableModes" => doc
                .variable_modes
                .as_ref()
                .is_some_and(|t| t.contains_key(key)),
            _ => false,
        }
    }
}

/// What the check reads of a patch: its keys, which of them remove, the ids of the entries it puts in the
/// tables whose entries carry one, and the page order. (Node contents are read from the documents.)
pub fn patch_outline(patch: &DocumentPatch) -> Value {
    let mut out = Object::new();
    for table in morfa_model::patch::PATCH_TABLES {
        let Some(entries) = patch_keys(patch, table) else {
            continue;
        };
        let mut outline = Object::with_capacity(entries.len());
        for (key, present) in entries {
            let entry = if !present {
                Value::Null
            } else {
                let mut stub = Object::new();
                let id = match table {
                    "styles" => patch
                        .styles
                        .as_ref()
                        .and_then(|t| t.get(key)?.as_ref().map(|s| s.id.clone())),
                    "variableCollections" => patch
                        .variable_collections
                        .as_ref()
                        .and_then(|t| t.get(key)?.as_ref().map(|c| c.id.clone())),
                    "variables" => patch
                        .variables
                        .as_ref()
                        .and_then(|t| t.get(key)?.as_ref().map(|v| v.id.clone())),
                    _ => None,
                };
                if let Some(id) = id {
                    stub.insert("id", Value::str(&id));
                }
                Value::object(stub)
            };
            outline.insert(key, entry);
        }
        out.insert(table, Value::object(outline));
    }
    if let Some(pages) = &patch.pages {
        out.insert("pages", ids(pages.iter()));
    }
    Value::object(out)
}

/// A typed patch as a [`Value`] (the merge reads whole entries).
pub fn patch_value(patch: &DocumentPatch) -> Value {
    value(patch)
}

/// `{...beforeTables, nodes: before ?? {}}`: the client's copies as the merge reads them.
pub fn base_value(
    before: Option<&Map<Option<SceneNode>>>,
    before_tables: Option<&DocumentPatch>,
) -> Value {
    let mut base = before_tables
        .map(value)
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default();
    base.insert(
        "nodes",
        before.map_or_else(|| Value::object(Object::new()), value),
    );
    Value::object(base)
}
