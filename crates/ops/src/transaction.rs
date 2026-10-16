//! shared/design/transaction.ts: the copy-on-write transaction every change to a document goes through, with the
//! same checks, the same children lists, the same `keepWorld` placement, the same dirty set and the same patch (keys in
//! the same order) as the TypeScript.
//!
//! The TypeScript copies the node table once and writes into the copy; here the transaction keeps an **overlay** over
//! the base document instead (the entries it wrote or removed, per table), so it never copies a table at all and a
//! commit costs the change. The base is any [`DocRead`]: a [`Value`] document, or one that stays in JavaScript.
//!
//! `commit` normalizes the touched part of the document (`normalizeDetailed`). Until the Rust normalize exists the commit has two steps: [`Transaction::stage`] closes the transaction and answers the dirty set for the
//! caller's normalize, [`Transaction::normalized`] takes the entries normalization wrote, and [`Transaction::finish`]
//! builds the patch and its inverse from the keys written, never by diffing.
//!
//! Identity is JavaScript's: an entry the transaction copied or wrote differs from the base's even when it holds the
//! same values (`before[key] === after[key]` in `buildPatch`), so a node moved away and back is in the patch, as in
//! the TypeScript. A mirror (the wasm harness keeps the JavaScript draft in step) can ask for the [`Effect`]s of each
//! operation.

use crate::doc::DocRead;
use crate::geometry::{IDENTITY, Matrix, Placement, invert, local_matrix, multiply, placement_for};
use crate::merge::is_container;
use crate::patch::{TABLES, invert_patch};
use crate::value::{Object, Str, Value};
use foldhash::fast::FixedState;
use indexmap::{IndexMap, IndexSet};
use std::collections::{HashMap, HashSet};
use std::fmt;

/// The hidden page that holds a file's copies of library components (types.ts `LIBRARY_PAGE_ID`).
pub const LIBRARY_PAGE_ID: &str = "morfa:library";

const STRUCTURAL: [&str; 3] = ["id", "parentId", "children"];
/// What every node read of the transaction asks for (a document read field by field, [`DocRead::partial_nodes`]).
const BASE_FIELDS: [&str; 4] = ["id", "type", "parentId", "children"];
/// What `move` with `keepWorld` reads of the node and its ancestors.
const GEOMETRY: &[&str] = &["x", "y", "width", "height", "rotation", "flipX", "flipY"];
const NODES: usize = 0;
const STYLES: usize = 1;
const IMAGES: usize = 2;
const COLLECTIONS: usize = 3;
const VARIABLES: usize = 4;
const MODES: usize = 5;

type Set = IndexSet<Str, FixedState>;
type Map<V> = IndexMap<Str, V, FixedState>;
/// The fields known of a node read field by field: a handful, so a list (no hashing per field).
#[derive(Clone, Debug, Default)]
struct Fields(Vec<Str>);

impl Fields {
    fn contains(&self, field: &str) -> bool {
        self.0.iter().any(|known| &**known == field)
    }

    fn insert(&mut self, field: Str) {
        if !self.contains(&field) {
            self.0.push(field);
        }
    }
}

impl Extend<Str> for Fields {
    fn extend<I: IntoIterator<Item = Str>>(&mut self, fields: I) {
        for field in fields {
            self.insert(field);
        }
    }
}

impl FromIterator<Str> for Fields {
    fn from_iter<I: IntoIterator<Item = Str>>(fields: I) -> Self {
        let mut out = Fields::default();
        out.extend(fields);
        out
    }
}
/// The base's nodes read so far, each with the fields known of it (`None`: absent).
type BaseNodes = std::cell::RefCell<HashMap<Str, Option<(Object, Fields)>, FixedState>>;

/// `TransactionError`: what the TypeScript throws, with its message word for word.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TransactionError(pub String);

impl fmt::Display for TransactionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for TransactionError {}

type Result<T> = std::result::Result<T, TransactionError>;

fn error<T>(message: impl Into<String>) -> Result<T> {
    Err(TransactionError(message.into()))
}

/// One write of an operation, for a mirror of the draft (each one is what the TypeScript does to its draft there).
#[derive(Clone, Debug)]
pub enum Effect {
    /// `touched.nodes.add(id)` (only when new).
    Touch(Str),
    /// The node is copied before its first write (`writable`).
    Copy(Str),
    /// `node[field] = value`.
    Set(Str, Str, Value),
    /// `delete node[field]`.
    Delete(Str, Str),
    /// `insertAt(writableChildren(parent), id, …)` put `id` at this index of the parent's list.
    Insert(Str, usize, Str),
    /// `reorder`: the parent's child at `from` moved to `to` (of the list without it).
    Reorder(Str, usize, usize),
    /// `flush`: these ids dropped from the parent's list (`(children ?? []).filter(…)`).
    Drop(Str, Vec<Str>),
    /// `doc[table][key] = value` (a created node, a page, a style, an image, a variable, a collection, modes).
    Put(&'static str, Str, Value),
    /// `delete doc[table][key]`.
    Remove(&'static str, Str),
    /// `doc.pages` is now this list.
    Pages(Vec<Str>),
}

impl Effect {
    /// The effect as the harness sends it: `["touch", id]`, `["set", id, field, value]`, ….
    pub fn to_value(&self) -> Value {
        let s = |text: &Str| Value::String(text.clone());
        let list = |ids: &[Str]| Value::array(ids.iter().cloned().map(Value::String).collect());
        Value::array(match self {
            Effect::Touch(id) => vec![Value::str("touch"), s(id)],
            Effect::Copy(id) => vec![Value::str("copy"), s(id)],
            Effect::Set(id, field, value) => {
                vec![Value::str("set"), s(id), s(field), value.clone()]
            }
            Effect::Delete(id, field) => vec![Value::str("delete"), s(id), s(field)],
            #[allow(clippy::cast_precision_loss)]
            Effect::Insert(parent, at, id) => vec![
                Value::str("insert"),
                s(parent),
                Value::Number(*at as f64),
                s(id),
            ],
            #[allow(clippy::cast_precision_loss)]
            Effect::Reorder(parent, from, to) => {
                vec![
                    Value::str("reorder"),
                    s(parent),
                    Value::Number(*from as f64),
                    Value::Number(*to as f64),
                ]
            }
            Effect::Drop(parent, removed) => vec![Value::str("drop"), s(parent), list(removed)],
            Effect::Put(table, key, value) => {
                vec![Value::str("put"), Value::str(table), s(key), value.clone()]
            }
            Effect::Remove(table, key) => vec![Value::str("remove"), Value::str(table), s(key)],
            Effect::Pages(pages) => vec![Value::str("pages"), list(pages)],
        })
    }
}

/// What a commit answers: the patch from the base to the committed document, its inverse, and the nodes the
/// transaction touched (and their old and new parents) before normalization widened it.
#[derive(Clone, Debug)]
pub struct TransactionResult {
    pub patch: Value,
    pub inverse: Value,
    pub dirty: Vec<Str>,
}

/// An entry of the committed document as a caller that holds it reports it (the wasm harness: the document is
/// JavaScript's, and so is `===`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Entry {
    Absent,
    /// The very entry the base holds.
    Base,
    /// Another one.
    Changed,
}

/// The keys of a patch built from reported entries: `pages` when the order changed, and per table each key with
/// whether the committed document has it.
#[derive(Clone, Debug, Default)]
pub struct PatchKeys {
    pub pages: bool,
    pub tables: Vec<(&'static str, Vec<(Str, bool)>)>,
}

/// `placementChanges`: only the fields of `placement` that differ from the node (absent flips read as false), in the
/// TypeScript's order.
pub fn placement_changes(node: &Value, placement: &Placement) -> Vec<(&'static str, Value)> {
    let mut out = Vec::new();
    let differs = |key: &str, value: f64| {
        !node
            .get(key)
            .is_some_and(|current| current.identical(&Value::Number(value)))
    };
    if differs("x", placement.x) {
        out.push(("x", Value::Number(placement.x)));
    }
    if differs("y", placement.y) {
        out.push(("y", Value::Number(placement.y)));
    }
    let rotation = node
        .get("rotation")
        .filter(|rotation| rotation.truthy())
        .cloned()
        .unwrap_or(Value::Number(0.0));
    if !rotation.identical(&Value::Number(placement.rotation)) {
        out.push(("rotation", Value::Number(placement.rotation)));
    }
    if node.get("flipX").is_some_and(Value::truthy) != placement.flip_x {
        out.push(("flipX", Value::Bool(placement.flip_x)));
    }
    if node.get("flipY").is_some_and(Value::truthy) != placement.flip_y {
        out.push(("flipY", Value::Bool(placement.flip_y)));
    }
    out
}

/// `${value}` of a value the messages name (a type, an id).
fn text(value: Option<&Value>) -> String {
    match value {
        None => "undefined".to_owned(),
        Some(Value::String(text)) => text.to_string(),
        Some(Value::Null) => "null".to_owned(),
        Some(Value::Bool(value)) => value.to_string(),
        Some(Value::Number(value)) => morfa_model::js_number::js_number(*value),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    text(Some(item))
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".to_owned(),
    }
}

fn kind(node: &Value) -> Option<&str> {
    node.get("type").and_then(Value::as_str)
}

fn ids_of(list: Option<&Value>) -> Vec<Str> {
    list.and_then(Value::as_array)
        .unwrap_or(&[])
        .iter()
        .filter_map(|id| {
            if let Value::String(id) = id {
                Some(id.clone())
            } else {
                None
            }
        })
        .collect()
}

fn list_value(ids: &[Str]) -> Value {
    Value::array(ids.iter().cloned().map(Value::String).collect())
}

/// `insertAt`: at the end without an index or past the end, else at `max(0, round(index))` (`splice` reads NaN as 0).
fn insert_at(list: &mut Vec<Str>, id: Str, index: Option<f64>) {
    let at = insert_index(list.len(), index);
    list.insert(at, id);
}

/// Where `insertAt` puts an id in a list of `len` ids.
fn insert_index(len: usize, index: Option<f64>) -> usize {
    #[allow(clippy::cast_precision_loss)]
    match index {
        Some(index) if index.is_nan() || index < len as f64 => {
            let at = crate::geometry::js_round(index);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let at = if at.is_nan() || at <= 0.0 {
                0
            } else {
                at as usize
            };
            at.min(len)
        }
        _ => len,
    }
}

/// `sameIds`.
fn same_ids(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (Some(a), Some(b)) if a.identical(b) => true,
        (Some(Value::Array(a)), Some(Value::Array(b))) => {
            a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.identical(y))
        }
        (None, None) => true,
        _ => false,
    }
}

/// A transaction on `base` (`beginTransaction`). Operations take the TypeScript's arguments: a partial is a list of
/// fields with `None` for a key set to `undefined`; an index is a JavaScript number (`None` for `undefined`).
pub struct Transaction<B: DocRead> {
    base: B,
    /// The entries written (`Some`) or removed (`None`), per table in `TABLES` order.
    overlay: [Map<Option<Value>>; 6],
    /// Tables the transaction made its own (`tableFor`): they exist in the draft even when the base has none.
    owned_tables: [bool; 6],
    owned_nodes: HashSet<Str, FixedState>,
    owned_children: HashSet<Str, FixedState>,
    /// Removed children per parent, dropped from the parent's list in one pass (`flush`).
    pending: Map<Set>,
    touched: [Set; 6],
    dirty: Set,
    pages: Option<Vec<Str>>,
    pages_touched: bool,
    closed: bool,
    /// Tables normalization replaced (compared over all their keys, `allKeys`), with the draft's keys of each.
    replaced: [bool; 6],
    effects: Option<Vec<Effect>>,
    /// The base's nodes read field by field: the fields known of each (`None`: the node is absent).
    partial: bool,
    base_nodes: BaseNodes,
    /// The fields known of each node of the overlay (`None`: all, a node the transaction made).
    known: HashMap<Str, Option<Fields>, FixedState>,
    /// Whether the base has variable modes at all (asked once).
    base_modes: std::cell::OnceCell<bool>,
}

impl<B: DocRead> Transaction<B> {
    pub fn new(base: B) -> Self {
        Transaction {
            base,
            overlay: Default::default(),
            owned_tables: [false; 6],
            owned_nodes: HashSet::default(),
            owned_children: HashSet::default(),
            pending: Map::default(),
            touched: Default::default(),
            dirty: Set::default(),
            pages: None,
            pages_touched: false,
            closed: false,
            replaced: [false; 6],
            effects: None,
            partial: false,
            base_nodes: std::cell::RefCell::new(HashMap::default()),
            known: HashMap::default(),
            base_modes: std::cell::OnceCell::new(),
        }
        .reading()
    }

    fn reading(mut self) -> Self {
        self.partial = self.base.partial_nodes();
        self
    }

    /// Records the [`Effect`]s of each operation from now on ([`Transaction::take_effects`] hands them over).
    pub fn record_effects(&mut self) {
        self.effects = Some(Vec::new());
    }

    pub fn take_effects(&mut self) -> Vec<Effect> {
        self.effects
            .as_mut()
            .map(std::mem::take)
            .unwrap_or_default()
    }

    fn effect(&mut self, effect: impl FnOnce() -> Effect) {
        if let Some(effects) = self.effects.as_mut() {
            effects.push(effect());
        }
    }

    pub fn base(&self) -> &B {
        &self.base
    }

    /// The parents whose removed children are not yet dropped from their lists (a mirror reads through
    /// [`Transaction::flush`] for these).
    pub fn pending(&self) -> impl Iterator<Item = &Str> {
        self.pending.keys()
    }

    /// The nodes touched so far (`touched.nodes`), in order.
    pub fn touched_nodes(&self) -> impl Iterator<Item = &Str> {
        self.touched[NODES].iter()
    }

    pub fn dirty(&self) -> impl Iterator<Item = &Str> {
        self.dirty.iter()
    }

    // ── Reading the draft ─────────────────────────────────────────────────────────────────────────

    /// `draft[table][key]`.
    pub fn entry(&self, table: usize, key: &str) -> Option<Value> {
        match self.overlay[table].get(key) {
            Some(written) => written.clone(),
            None => self.base.entry(TABLES[table], key),
        }
    }

    fn node(&self, id: &str) -> Option<Value> {
        self.read(id, &[])
    }

    /// A node of the draft with at least the structure fields and `extra` (all of them unless the base is read field
    /// by field).
    fn read(&self, id: &str, extra: &[&str]) -> Option<Value> {
        if !self.partial {
            return self.entry(NODES, id);
        }
        let wanted = || BASE_FIELDS.iter().chain(extra.iter()).copied();
        match self.overlay[NODES].get(id) {
            Some(None) => None,
            Some(Some(node)) => {
                let missing: Vec<&str> = match self.known.get(id) {
                    Some(Some(known)) => wanted().filter(|field| !known.contains(field)).collect(),
                    _ => Vec::new(),
                };
                if missing.is_empty() {
                    return Some(node.clone());
                }
                // Fields the transaction never wrote are the base's.
                let base = self.base_fields(id, &missing).unwrap_or_default();
                let mut merged = node.as_object().cloned().unwrap_or_default();
                for field in missing {
                    if let Some(value) = base.get(field) {
                        merged.insert(field, value.clone());
                    }
                }
                Some(Value::object(merged))
            }
            None => self
                .base_fields(id, &wanted().collect::<Vec<_>>())
                .map(Value::object),
        }
    }

    /// What the caller already knows of a base node (`None`: absent): these fields of it, the ones it has in `node`.
    /// Saves the read through the boundary the transaction would make; a node already read is left as it is.
    pub fn seed(&self, id: &str, fields: &[&str], node: Option<&Value>) {
        if !self.partial {
            return;
        }
        let mut cache = self.base_nodes.borrow_mut();
        if cache.contains_key(id) {
            return;
        }
        let entry = node.map(|node| {
            let object = node.as_object().cloned().unwrap_or_default();
            let mut known: Fields = fields.iter().map(|field| Str::from(*field)).collect();
            known.extend(object.keys().cloned());
            (object, known)
        });
        cache.insert(Str::from(id), entry);
    }

    /// The base's node with at least these fields, read once each.
    fn base_fields(&self, id: &str, fields: &[&str]) -> Option<Object> {
        let mut cache = self.base_nodes.borrow_mut();
        if let Some(known) = cache.get_mut(id) {
            let (node, known) = known.as_mut()?;
            let missing: Vec<&str> = fields
                .iter()
                .copied()
                .filter(|field| !known.contains(field))
                .collect();
            if !missing.is_empty() {
                if let Some(Value::Object(fetched)) = self.base.node_fields(id, &missing) {
                    for (key, value) in fetched.iter() {
                        if !known.contains(key) {
                            node.insert(key.clone(), value.clone());
                        }
                    }
                }
                known.extend(missing.into_iter().map(Str::from));
            }
            return Some(node.clone());
        }
        let fetched = self.base.node_fields(id, fields);
        let entry = fetched.map(|node| {
            let object = node.as_object().cloned().unwrap_or_default();
            let mut known: Fields = fields.iter().map(|field| Str::from(*field)).collect();
            known.extend(object.keys().cloned());
            (object, known)
        });
        let answer = entry.as_ref().map(|(node, _)| node.clone());
        cache.insert(Str::from(id), entry);
        answer
    }

    /// Whether the base has this entry.
    fn base_has(&self, table: usize, key: &str) -> bool {
        if table == NODES && self.partial {
            return self.base_fields(key, &[]).is_some();
        }
        self.base.entry(TABLES[table], key).is_some()
    }

    /// `draft.pages`.
    pub fn pages(&self) -> Vec<Str> {
        match &self.pages {
            Some(pages) => pages.clone(),
            None => ids_of(Some(&self.base.pages())),
        }
    }

    /// The draft's keys of a table, in JavaScript's order (the base's, then the ones written since).
    fn table_keys(&self, table: usize) -> Vec<Str> {
        let mut object = Object::new();
        for (key, _) in self.base.identities(TABLES[table]) {
            object.insert(key, Value::Null);
        }
        for (key, written) in &self.overlay[table] {
            match written {
                Some(_) => object.insert(key.clone(), Value::Null),
                None => {
                    object.remove(key);
                }
            }
        }
        object.keys().cloned().collect()
    }

    /// `get(id)`: the node as the transaction has changed it so far.
    pub fn get(&mut self, id: &str) -> Option<Value> {
        self.get_with(id, &[])
    }

    fn get_with(&mut self, id: &str, extra: &[&str]) -> Option<Value> {
        if self.pending.contains_key(id) {
            self.flush(id);
        }
        self.read(id, extra)
    }

    /// The pending removals dropped from their parents' lists (`doc` reads after this).
    pub fn flush_all(&mut self) {
        let ids: Vec<Str> = self.pending.keys().cloned().collect();
        for id in ids {
            self.flush(&id);
        }
    }

    // ── Operations ────────────────────────────────────────────────────────────────────────────────

    fn assert_open(&self) -> Result<()> {
        if self.closed {
            error("The transaction is already committed")
        } else {
            Ok(())
        }
    }

    fn require(&mut self, id: &str) -> Result<Value> {
        self.require_with(id, &[])
    }

    fn require_with(&mut self, id: &str, extra: &[&str]) -> Result<Value> {
        match self.get_with(id, extra) {
            Some(node) => Ok(node),
            None => error(format!("Node {id} does not exist")),
        }
    }

    /// `update(id, partial)`: a shallow merge; a key set to `undefined` (`None`) is removed.
    pub fn update(&mut self, id: &str, partial: &[(Str, Option<Value>)]) -> Result<()> {
        self.assert_open()?;
        let keys: Vec<&str> = partial.iter().map(|(key, _)| &**key).collect();
        let node = self.require_with(id, &keys)?;
        let mut changed = false;
        for (key, value) in partial {
            let current = node.get(key);
            if STRUCTURAL.contains(&&**key) {
                let same = if &**key == "children" {
                    same_ids(current, value.as_ref())
                } else {
                    same_value(current, value.as_ref())
                };
                if !same {
                    return error(format!("\"{key}\" changes through create, move or remove"));
                }
                continue;
            }
            if &**key == "type" && !same_value(value.as_ref(), node.get("type")) {
                let to = value.as_ref().and_then(Value::as_str);
                let from = kind(&node);
                if to == Some("PAGE")
                    || from == Some("PAGE")
                    || is_container(to) != is_container(from)
                {
                    return error(format!(
                        "A {} cannot become a {}",
                        text(node.get("type")),
                        text(value.as_ref())
                    ));
                }
            }
            if !same_value(current, value.as_ref()) {
                changed = true;
            }
        }
        if !changed {
            return Ok(());
        }
        let id = self.key_of(id, &node);
        self.writable(&id)?;
        for (key, value) in partial {
            if STRUCTURAL.contains(&&**key) {
                continue;
            }
            self.write_field(&id, key, value.clone());
        }
        self.dirty.insert(id);
        Ok(())
    }

    /// `create(node, parentId, index)`: a new node under `parentId` at `index` of its children (default top).
    pub fn create(&mut self, node: &Value, parent_id: &str, index: Option<f64>) -> Result<()> {
        self.assert_open()?;
        if kind(node) == Some("PAGE") {
            return error("Pages are added with addPage");
        }
        let id: Str = node
            .get("id")
            .and_then(Value::as_str)
            .map_or_else(|| Str::from(text(node.get("id"))), Str::from);
        if self.node(&id).is_some_and(|existing| existing.truthy()) {
            return error(format!("Node {id} already exists"));
        }
        let parent = self.require(parent_id)?;
        if !is_container(kind(&parent)) {
            return error(format!(
                "A {} cannot hold children",
                text(parent.get("type"))
            ));
        }
        let parent_id = self.key_of(parent_id, &parent);
        drop(parent);
        let mut copy = node.as_object().cloned().unwrap_or_default();
        copy.insert("parentId", Value::String(parent_id.clone()));
        let container = is_container(kind(node));
        if container {
            copy.insert("children", Value::array(Vec::new()));
        } else {
            copy.remove("children");
        }
        self.put_node(id.clone(), Value::object(copy), container);
        self.insert_child(&parent_id, id.clone(), index)?;
        self.dirty.insert(id);
        self.dirty.insert(parent_id);
        Ok(())
    }

    /// A new node of the transaction's own in the table (`create`, `addPage`, `addLibraryPage`).
    fn put_node(&mut self, id: Str, node: Value, container: bool) {
        self.effect(|| Effect::Put("nodes", id.clone(), node.clone()));
        self.overlay[NODES].insert(id.clone(), Some(node));
        self.known.insert(id.clone(), None);
        self.owned_nodes.insert(id.clone());
        if container {
            self.owned_children.insert(id.clone());
        }
        self.touch(id);
    }

    fn touch(&mut self, id: Str) {
        if self.touched[NODES].insert(id.clone()) {
            self.effect(|| Effect::Touch(id));
        }
    }

    /// `remove(id)`: the node and its subtree; a missing node is nothing to do, a page goes through `removePage`.
    pub fn remove(&mut self, id: &str) -> Result<()> {
        self.assert_open()?;
        let Some(node) = self.node(id) else {
            return Ok(());
        };
        if kind(&node) == Some("PAGE") {
            return self.remove_page(id);
        }
        let id = self.key_of(id, &node);
        self.drop_subtree(&id);
        let parent_id: Str = match node.get("parentId") {
            Some(Value::String(parent)) => parent.clone(),
            other => Str::from(text(other)),
        };
        self.pending
            .entry(parent_id.clone())
            .or_default()
            .insert(id.clone());
        self.dirty.insert(id);
        self.dirty.insert(parent_id);
        Ok(())
    }

    /// `move(id, parentId, index, {keepWorld})`.
    pub fn move_node(
        &mut self,
        id: &str,
        parent_id: &str,
        index: Option<f64>,
        keep_world: bool,
    ) -> Result<()> {
        self.assert_open()?;
        let node = self.require_with(id, GEOMETRY)?;
        let target = self.require(parent_id)?;
        if kind(&node) == Some("PAGE") {
            return error("Pages stay at the root");
        }
        if !is_container(kind(&target)) {
            return error(format!(
                "A {} cannot hold children",
                text(target.get("type"))
            ));
        }
        if id == parent_id || self.is_ancestor(id, parent_id) {
            return error("A node cannot move into itself");
        }
        let old_parent: Str = match node.get("parentId") {
            Some(Value::String(parent)) => parent.clone(),
            other => Str::from(text(other)),
        };
        if *old_parent == *parent_id {
            #[allow(clippy::cast_precision_loss)]
            return self.reorder(id, index.unwrap_or(9_007_199_254_740_991.0));
        }
        let changes = if keep_world {
            let local = multiply(
                &invert(&self.world_matrix(parent_id)),
                &self.world_matrix(id),
            );
            placement_changes(&node, &placement_for(&node, &local, None))
        } else {
            Vec::new()
        };
        let id = self.key_of(id, &node);
        let parent_id = self.key_of(parent_id, &target);
        drop(target);
        self.pending
            .entry(old_parent.clone())
            .or_default()
            .insert(id.clone());
        self.insert_child(&parent_id, id.clone(), index)?;
        self.writable(&id)?;
        self.write_field(&id, "parentId", Some(Value::String(parent_id.clone())));
        for (key, value) in changes {
            self.write_field(&id, key, Some(value));
        }
        self.dirty.insert(id);
        self.dirty.insert(old_parent);
        self.dirty.insert(parent_id);
        Ok(())
    }

    /// `reorder(id, index)`: within its parent's children (or the page list), to `index` of the result.
    pub fn reorder(&mut self, id: &str, index: f64) -> Result<()> {
        self.assert_open()?;
        let node = self.require(id)?;
        if id == LIBRARY_PAGE_ID {
            return Ok(());
        }
        if kind(&node) == Some("PAGE") {
            let pages = self.pages();
            let mut order: Vec<Str> = pages
                .iter()
                .filter(|page| ***page != *id)
                .cloned()
                .collect();
            insert_at(&mut order, self.key_of(id, &node), Some(index));
            if order
                .iter()
                .enumerate()
                .any(|(at, page)| pages.get(at) != Some(page))
            {
                self.set_pages(&order)?;
            }
            return Ok(());
        }
        let parent_id: Str = match node.get("parentId") {
            Some(Value::String(parent)) => parent.clone(),
            other => Str::from(text(other)),
        };
        self.flush(&parent_id);
        let (from, len) = {
            let parent = self.node(&parent_id);
            let current = parent
                .as_ref()
                .and_then(|parent| parent.get("children"))
                .and_then(Value::as_array)
                .unwrap_or(&[]);
            (
                current.iter().position(|child| child.as_str() == Some(id)),
                current.len(),
            )
        };
        let Some(from) = from else {
            return Ok(());
        };
        #[allow(clippy::cast_precision_loss)]
        let last = len as f64 - 1.0;
        let rounded = crate::geometry::js_round(index);
        let to = if rounded.is_nan() {
            f64::NAN
        } else {
            rounded.min(last).max(0.0)
        };
        #[allow(clippy::cast_precision_loss)]
        if !to.is_nan() && from as f64 == to {
            return Ok(());
        }
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let to = if to.is_nan() { 0 } else { to as usize };
        self.writable_children(&parent_id)?;
        if let Some(children) = self.children_mut(&parent_id) {
            let moved = children.remove(from);
            let to = to.min(children.len());
            children.insert(to, moved);
            if let Some(effects) = self.effects.as_mut() {
                effects.push(Effect::Reorder(parent_id.clone(), from, to));
            }
        }
        let id = self.key_of(id, &node);
        self.dirty.insert(id);
        self.dirty.insert(parent_id);
        Ok(())
    }

    pub fn set_style(&mut self, style: Value) -> Result<()> {
        self.assert_open()?;
        let id = key_field(&style);
        self.write_entry(STYLES, id, style);
        Ok(())
    }

    pub fn remove_style(&mut self, id: &str) -> Result<()> {
        self.assert_open()?;
        self.delete_entry(STYLES, id);
        Ok(())
    }

    pub fn set_image(&mut self, reference: &str, asset: Value) -> Result<()> {
        self.assert_open()?;
        self.write_entry(IMAGES, Str::from(reference), asset);
        Ok(())
    }

    pub fn remove_image(&mut self, reference: &str) -> Result<()> {
        self.assert_open()?;
        self.delete_entry(IMAGES, reference);
        Ok(())
    }

    /// `setPages(order)`: a new order of the same pages.
    pub fn set_pages(&mut self, order: &[Str]) -> Result<()> {
        self.assert_open()?;
        let current: HashSet<Str> = self.pages().into_iter().collect();
        let distinct: HashSet<&Str> = order.iter().collect();
        if order.len() != current.len()
            || distinct.len() != order.len()
            || order.iter().any(|id| !current.contains(id))
        {
            return error("setPages takes a new order of the same pages");
        }
        self.write_pages(order.to_vec());
        Ok(())
    }

    fn write_pages(&mut self, pages: Vec<Str>) {
        self.effect(|| Effect::Pages(pages.clone()));
        self.pages = Some(pages);
        self.pages_touched = true;
    }

    /// `addPage(node, index)`.
    pub fn add_page(&mut self, node: &Value, index: Option<f64>) -> Result<()> {
        self.assert_open()?;
        if kind(node) != Some("PAGE") {
            return error("addPage takes a PAGE");
        }
        let id = key_field(node);
        if self.node(&id).is_some_and(|existing| existing.truthy()) {
            return error(format!("Node {id} already exists"));
        }
        let mut copy = node.as_object().cloned().unwrap_or_default();
        copy.insert("parentId", Value::Null);
        copy.insert("children", Value::array(Vec::new()));
        self.put_node(id.clone(), Value::object(copy), true);
        let mut pages = self.pages();
        insert_at(&mut pages, id.clone(), index);
        self.write_pages(pages);
        self.dirty.insert(id);
        Ok(())
    }

    /// `removePage(id)`: a page and everything on it; the last page stays.
    pub fn remove_page(&mut self, id: &str) -> Result<()> {
        self.assert_open()?;
        let node = self.node(id);
        let Some(node) = node.filter(|node| kind(node) == Some("PAGE")) else {
            return error(format!("{id} is not a page"));
        };
        let id = self.key_of(id, &node);
        if *id == *LIBRARY_PAGE_ID {
            self.drop_subtree(&id);
            self.dirty.insert(id);
            return Ok(());
        }
        let pages = self.pages();
        if pages.len() <= 1 {
            return error("A file keeps at least one page");
        }
        self.drop_subtree(&id);
        self.write_pages(pages.into_iter().filter(|page| *page != id).collect());
        self.dirty.insert(id);
        Ok(())
    }

    /// `addLibraryPage()`: `page` is the node the TypeScript makes there (`createNode('PAGE', {id: LIBRARY_PAGE_ID,
    /// name: 'Libraries', parentId: null, children: []})`), the caller's to make (defaults.ts is not ported).
    pub fn add_library_page(&mut self, page: Value) -> Result<()> {
        self.assert_open()?;
        if self
            .node(LIBRARY_PAGE_ID)
            .is_some_and(|existing| existing.truthy())
        {
            return Ok(());
        }
        self.put_node(Str::from(LIBRARY_PAGE_ID), page, true);
        self.dirty.insert(Str::from(LIBRARY_PAGE_ID));
        Ok(())
    }

    pub fn set_variable_collection(&mut self, collection: Value) -> Result<()> {
        self.assert_open()?;
        let id = key_field(&collection);
        self.write_entry(COLLECTIONS, id, collection);
        Ok(())
    }

    /// `removeVariableCollection(id)`: the collection and its variables.
    pub fn remove_variable_collection(&mut self, id: &str) -> Result<()> {
        self.assert_open()?;
        let Some(collection) = self.entry(COLLECTIONS, id).filter(Value::truthy) else {
            return Ok(());
        };
        for variable in ids_of(collection.get("variableIds")) {
            self.delete_entry(VARIABLES, &variable);
        }
        let variables: Vec<Value> = self
            .table_keys(VARIABLES)
            .iter()
            .filter_map(|key| self.entry(VARIABLES, key))
            .collect();
        for variable in variables {
            if variable.get("collectionId").and_then(Value::as_str) == Some(id) {
                let key = key_field(&variable);
                self.delete_entry(VARIABLES, &key);
            }
        }
        self.delete_entry(COLLECTIONS, id);
        Ok(())
    }

    /// `setVariable(variable)`: adds or replaces it and keeps its collection's `variableIds` in step.
    pub fn set_variable(&mut self, variable: Value) -> Result<()> {
        self.assert_open()?;
        let collection_id = variable.get("collectionId");
        let Some(collection) = collection_id
            .and_then(Value::as_str)
            .and_then(|key| self.entry(COLLECTIONS, key))
            .filter(Value::truthy)
        else {
            return error(format!("Collection {} does not exist", text(collection_id)));
        };
        let id = key_field(&variable);
        let previous = self.entry(VARIABLES, &id).filter(Value::truthy);
        if let Some(previous) = previous
            && !same_value(previous.get("collectionId"), collection_id)
        {
            self.unlist_variable(&previous);
        }
        self.write_entry(VARIABLES, id.clone(), variable);
        let list = collection
            .get("variableIds")
            .and_then(Value::as_array)
            .unwrap_or(&[]);
        if !list.iter().any(|item| item.as_str() == Some(&id)) {
            let mut copy = collection.as_object().cloned().unwrap_or_default();
            let mut ids = list.to_vec();
            ids.push(Value::String(id));
            copy.insert("variableIds", Value::array(ids));
            self.write_entry(COLLECTIONS, key_field(&collection), Value::object(copy));
        }
        Ok(())
    }

    pub fn remove_variable(&mut self, id: &str) -> Result<()> {
        self.assert_open()?;
        let Some(variable) = self.entry(VARIABLES, id).filter(Value::truthy) else {
            return Ok(());
        };
        self.unlist_variable(&variable);
        self.delete_entry(VARIABLES, id);
        Ok(())
    }

    /// `setVariableModes(nodeId, modes)`: `None` for `null`.
    pub fn set_variable_modes(&mut self, node_id: &str, modes: Option<&Value>) -> Result<()> {
        self.assert_open()?;
        let key = if let Some(modes) = modes {
            let node = self.require(node_id)?;
            let key = self.key_of(node_id, &node);
            // `{...modes}`: a copy of the transaction's own.
            self.write_entry(
                MODES,
                key.clone(),
                Value::object(modes.as_object().cloned().unwrap_or_default()),
            );
            key
        } else {
            self.delete_entry(MODES, node_id);
            Str::from(node_id)
        };
        self.dirty.insert(key);
        Ok(())
    }

    // ── Commit ───────────────────────────────────────────────────────────────────────────────────

    /// The first step of `commit`: the transaction closes and answers the nodes to normalize (`dirty`; nothing to
    /// normalize when it is empty).
    pub fn stage(&mut self) -> Result<Vec<Str>> {
        self.assert_open()?;
        self.flush_all();
        self.closed = true;
        Ok(self.dirty.iter().cloned().collect())
    }

    /// The nodes normalization wrote (`out.changed`, with the entries it left: `None` for a node it removed). The patch
    /// covers them too.
    pub fn normalized(&mut self, written: impl IntoIterator<Item = (Str, Option<Value>)>) {
        for (id, node) in written {
            self.overlay[NODES].insert(id.clone(), node);
            self.touch(id);
        }
    }

    /// An entry of another table normalization wrote (it removes an instance's copies' variable modes): the table is
    /// then compared over all its keys, as the TypeScript compares a table normalization replaced.
    pub fn normalized_entry(&mut self, table: usize, key: Str, value: Option<Value>) {
        self.overlay[table].insert(key, value);
        self.owned_tables[table] = true;
        self.replaced[table] = true;
    }

    /// The last step of `commit`: the patch from the base to the committed draft, built from the keys the transaction
    /// and normalization wrote, and its inverse. An empty patch means the commit changed nothing (the document stays
    /// the base).
    pub fn finish(&self) -> TransactionResult {
        let keys = self.patch_keys(|table, key| self.entry_status(table, key), &[]);
        let patch = self.patch_from(&keys);
        let inverse = if crate::patch::is_empty_patch(&patch) {
            Value::object(Object::new())
        } else {
            invert_patch(&self.base, &patch)
        };
        TransactionResult {
            patch,
            inverse,
            dirty: self.dirty.iter().cloned().collect(),
        }
    }

    /// What the draft holds at a key, against the base (identity, as `===`).
    pub fn entry_status(&self, table: usize, key: &str) -> Entry {
        let before = self.base.entry(TABLES[table], key);
        match self.overlay[table].get(key) {
            None => {
                if before.is_some() {
                    Entry::Base
                } else {
                    Entry::Absent
                }
            }
            Some(None) => Entry::Absent,
            Some(Some(after)) => match before {
                Some(before) if before.identical(after) => Entry::Base,
                _ => Entry::Changed,
            },
        }
    }

    /// `commit` without normalization (a caller whose changes need none, or that normalized through
    /// [`Transaction::normalized`] between [`Transaction::stage`] and [`Transaction::finish`]).
    pub fn commit(mut self) -> Result<TransactionResult> {
        self.stage()?;
        Ok(self.finish())
    }

    /// `buildPatch`'s keys: per table the keys the transaction touched (all keys of a table normalization replaced,
    /// `replaced` giving the committed table's keys in order), each kept when the committed document's entry differs
    /// from the base's. `status` says what the committed document holds at a key.
    pub fn patch_keys(
        &self,
        status: impl Fn(usize, &str) -> Entry,
        replaced: &[(usize, Vec<Str>)],
    ) -> PatchKeys {
        let pages = self.pages_touched
            && self
                .pages
                .as_ref()
                .is_some_and(|pages| *pages != ids_of(Some(&self.base.pages())));
        let mut tables = Vec::new();
        for (table, name) in TABLES.iter().enumerate() {
            let keys: Vec<Str> =
                if let Some((_, after)) = replaced.iter().find(|(at, _)| *at == table) {
                    all_keys(after, &self.base.identities(name))
                } else if self.replaced[table] {
                    all_keys(&self.table_keys(table), &self.base.identities(name))
                } else {
                    self.touched[table].iter().cloned().collect()
                };
            let mut changes = Vec::new();
            for key in keys {
                let had = self.base_has(table, &key);
                let after = status(table, &key);
                let has = after != Entry::Absent;
                if !had && !has {
                    continue;
                }
                if had && after == Entry::Base {
                    continue;
                }
                changes.push((key, has));
            }
            if !changes.is_empty() {
                tables.push((*name, changes));
            }
        }
        PatchKeys { pages, tables }
    }

    /// The patch of these keys, with the draft's entries.
    fn patch_from(&self, keys: &PatchKeys) -> Value {
        let mut patch = Object::new();
        if keys.pages {
            patch.insert("pages", list_value(&self.pages()));
        }
        for (name, changes) in &keys.tables {
            let table = TABLES.iter().position(|each| each == name).unwrap_or(NODES);
            let mut out = Object::with_capacity(changes.len());
            for (key, has) in changes {
                let value = if *has {
                    self.entry(table, key).unwrap_or(Value::Null)
                } else {
                    Value::Null
                };
                out.insert(key.clone(), value);
            }
            patch.insert(*name, Value::object(out));
        }
        Value::object(patch)
    }

    // ── Internals ────────────────────────────────────────────────────────────────────────────────

    /// The id as a shared string (the node's own when it is the same text).
    fn key_of(&self, id: &str, node: &Value) -> Str {
        match node.get("id") {
            Some(Value::String(own)) if **own == *id => own.clone(),
            _ => Str::from(id),
        }
    }

    fn is_ancestor(&self, ancestor: &str, id: &str) -> bool {
        let mut node = self.node(id);
        let mut guard = 0usize;
        while let Some(current) = node {
            let Some(parent) = current.get("parentId").filter(|parent| parent.truthy()) else {
                return false;
            };
            if parent.as_str() == Some(ancestor) {
                return true;
            }
            guard += 1;
            if guard > 1_000_000 {
                return false;
            }
            node = self.node(&text(Some(parent)));
        }
        false
    }

    /// `worldMatrix(draft, id)`: node local box → page space; pages are the identity.
    fn world_matrix(&self, id: &str) -> Matrix {
        let mut chain = Vec::new();
        let mut node = self.read(id, GEOMETRY);
        while let Some(current) = node {
            if kind(&current) == Some("PAGE") || chain.len() > 1_000_000 {
                break;
            }
            let parent = current
                .get("parentId")
                .filter(|parent| parent.truthy())
                .map(|parent| text(Some(parent)));
            chain.push(current);
            node = parent.and_then(|parent| self.read(&parent, GEOMETRY));
        }
        let mut m = IDENTITY;
        for node in chain.iter().rev() {
            m = multiply(&m, &local_matrix(node));
        }
        m
    }

    /// `writable(id)`: the node copied once, touched.
    fn writable(&mut self, id: &Str) -> Result<()> {
        let Some(node) = self.node(id) else {
            return error(format!("Node {id} does not exist"));
        };
        if !self.owned_nodes.contains(id) {
            self.effect(|| Effect::Copy(id.clone()));
            let copy = Value::object(node.as_object().cloned().unwrap_or_default());
            if self.partial && !matches!(self.known.get(id), Some(None)) {
                let known = self
                    .base_nodes
                    .borrow()
                    .get(id)
                    .and_then(|entry| entry.as_ref().map(|(_, known)| known.clone()))
                    .unwrap_or_default();
                self.known.insert(id.clone(), Some(known));
            }
            self.overlay[NODES].insert(id.clone(), Some(copy));
            self.owned_nodes.insert(id.clone());
        }
        self.touch(id.clone());
        Ok(())
    }

    /// `target[key] = value` (`None`: `delete target[key]`) on a node made writable.
    fn write_field(&mut self, id: &Str, key: &str, value: Option<Value>) {
        if let Some(Some(known)) = self.known.get_mut(id) {
            known.insert(Str::from(key));
        }
        let Some(Some(node)) = self.overlay[NODES].get_mut(id) else {
            return;
        };
        let Some(object) = node.as_object_mut() else {
            return;
        };
        match value {
            Some(value) => {
                let key = Str::from(key);
                if let Some(effects) = self.effects.as_mut() {
                    effects.push(Effect::Set(id.clone(), key.clone(), value.clone()));
                }
                object.insert(key, value);
            }
            None => {
                object.remove(key);
                if let Some(effects) = self.effects.as_mut() {
                    effects.push(Effect::Delete(id.clone(), Str::from(key)));
                }
            }
        }
    }

    /// `writableChildren(id)`: the parent's list after its pending removals made the transaction's own (copied on
    /// its first write, as the TypeScript copies it once).
    fn writable_children(&mut self, id: &Str) -> Result<()> {
        self.flush(id);
        self.writable(id)?;
        self.owned_children.insert(id.clone());
        Ok(())
    }

    /// The children list of a node the transaction made writable (`[]` set when it has none, as `?? []` does).
    fn children_mut(&mut self, id: &Str) -> Option<&mut Vec<Value>> {
        let object = self.overlay[NODES].get_mut(id)?.as_mut()?.as_object_mut()?;
        if !matches!(object.get("children"), Some(Value::Array(_))) {
            object.insert("children", Value::array(Vec::new()));
        }
        match object.get_mut("children")? {
            Value::Array(items) => Some(std::sync::Arc::make_mut(items)),
            _ => None,
        }
    }

    fn insert_child(&mut self, parent: &Str, id: Str, index: Option<f64>) -> Result<()> {
        self.writable_children(parent)?;
        if let Some(children) = self.children_mut(parent) {
            let at = insert_index(children.len(), index);
            children.insert(at, Value::String(id.clone()));
            if let Some(effects) = self.effects.as_mut() {
                effects.push(Effect::Insert(parent.clone(), at, id));
            }
        }
        Ok(())
    }

    /// `flush(id)`: the parent's pending removals dropped from its list in one pass.
    pub fn flush(&mut self, id: &str) {
        let Some(removed) = self.pending.shift_remove(id) else {
            return;
        };
        let Some(node) = self.node(id) else { return };
        let id = self.key_of(id, &node);
        // (No copy of the node may be alive while its list is written in place.)
        drop(node);
        if self.writable(&id).is_err() {
            return;
        }
        self.owned_children.insert(id.clone());
        if let Some(children) = self.children_mut(&id) {
            children.retain(|child| child.as_str().is_none_or(|child| !removed.contains(child)));
        }
        if let Some(effects) = self.effects.as_mut() {
            effects.push(Effect::Drop(id, removed.into_iter().collect()));
        }
    }

    /// `dropSubtree(id)`: the node and its descendants leave the table (the parent's list is the caller's).
    fn drop_subtree(&mut self, id: &Str) {
        let mut ids = Vec::new();
        let mut stack = vec![id.clone()];
        while let Some(next) = stack.pop() {
            if self.pending.contains_key(&next) {
                self.flush(&next);
            }
            let children = ids_of(
                self.node(&next)
                    .as_ref()
                    .and_then(|node| node.get("children")),
            );
            ids.push(next);
            stack.extend(children.into_iter().rev());
        }
        for each in ids {
            self.effect(|| Effect::Remove("nodes", each.clone()));
            self.overlay[NODES].insert(each.clone(), None);
            self.known.remove(&each);
            self.owned_nodes.remove(&each);
            self.owned_children.remove(&each);
            self.pending.shift_remove(&each);
            self.touch(each.clone());
            if self.may_have_modes() && self.entry(MODES, &each).is_some() {
                self.delete_entry(MODES, &each);
            }
        }
    }

    /// Whether the draft can hold variable modes: the transaction wrote some, or the base has some.
    fn may_have_modes(&self) -> bool {
        !self.overlay[MODES].is_empty()
            || *self
                .base_modes
                .get_or_init(|| self.base.size(TABLES[MODES]) > 0)
    }

    fn write_entry(&mut self, table: usize, key: Str, value: Value) {
        self.effect(|| Effect::Put(TABLES[table], key.clone(), value.clone()));
        self.overlay[table].insert(key.clone(), Some(value));
        self.owned_tables[table] = true;
        self.touched[table].insert(key);
    }

    fn delete_entry(&mut self, table: usize, key: &str) {
        if self.entry(table, key).is_none() {
            return;
        }
        let key = Str::from(key);
        self.effect(|| Effect::Remove(TABLES[table], key.clone()));
        self.overlay[table].insert(key.clone(), None);
        self.owned_tables[table] = true;
        self.touched[table].insert(key);
    }

    fn unlist_variable(&mut self, variable: &Value) {
        let Some(collection_key) = variable.get("collectionId").and_then(Value::as_str) else {
            return;
        };
        let Some(collection) = self
            .entry(COLLECTIONS, collection_key)
            .filter(Value::truthy)
        else {
            return;
        };
        let id = variable.get("id");
        let list = collection
            .get("variableIds")
            .and_then(Value::as_array)
            .unwrap_or(&[]);
        if !list.iter().any(|item| same_value(Some(item), id)) {
            return;
        }
        let mut copy = collection.as_object().cloned().unwrap_or_default();
        copy.insert(
            "variableIds",
            Value::array(
                list.iter()
                    .filter(|item| !same_value(Some(item), id))
                    .cloned()
                    .collect(),
            ),
        );
        let key = key_field(&collection);
        self.write_entry(COLLECTIONS, key, Value::object(copy));
    }
}

impl Transaction<Value> {
    /// The document as the transaction has changed it so far (`doc`): the base's tables with the overlay applied.
    /// Untouched tables and entries are the base's.
    pub fn doc(&mut self) -> Value {
        self.flush_all();
        let mut doc = self.base.as_object().cloned().unwrap_or_default();
        if let Some(pages) = &self.pages {
            doc.insert("pages", list_value(pages));
        }
        for (table, name) in TABLES.iter().enumerate() {
            if self.overlay[table].is_empty() && !self.owned_tables[table] {
                continue;
            }
            let mut entries = self
                .base
                .get(name)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            for (key, written) in &self.overlay[table] {
                match written {
                    Some(value) => entries.insert(key.clone(), value.clone()),
                    None => {
                        entries.remove(key);
                    }
                }
            }
            doc.insert(*name, Value::object(entries));
        }
        Value::object(doc)
    }

    /// `commit(context)` for a base held here, normalization left to the caller: the committed document (the base
    /// when nothing changed) with the result.
    pub fn commit_doc(mut self) -> Result<(Value, TransactionResult)> {
        self.stage()?;
        let result = self.finish();
        if crate::patch::is_empty_patch(&result.patch) {
            return Ok((self.base.clone(), result));
        }
        let doc = self.doc();
        Ok((doc, result))
    }
}

/// `node[key] === value` with `undefined` as `None`.
fn same_value(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.identical(b),
        _ => false,
    }
}

/// `entry.id` as a key.
fn key_field(entry: &Value) -> Str {
    match entry.get("id") {
        Some(Value::String(id)) => id.clone(),
        other => Str::from(text(other)),
    }
}

/// `allKeys(before, after)`: the committed table's keys, then the base's it no longer has.
fn all_keys(after: &[Str], before: &[(Str, usize)]) -> Vec<Str> {
    let mut keys: IndexSet<Str, FixedState> = after.iter().cloned().collect();
    for (key, _) in before {
        keys.insert(key.clone());
    }
    keys.into_iter().collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Value {
        Value::from_json(
            r#"{"id":"d","pages":["p"],"nodes":{
                "p":{"id":"p","type":"PAGE","parentId":null,"children":["f","r"]},
                "f":{"id":"f","type":"FRAME","parentId":"p","children":["a"],"x":100,"y":50,"width":200,"height":200,"rotation":0},
                "a":{"id":"a","type":"RECTANGLE","parentId":"f","x":10,"y":10,"width":20,"height":20,"rotation":0},
                "r":{"id":"r","type":"RECTANGLE","parentId":"p","x":0,"y":0,"width":10,"height":10,"rotation":0}},
                "styles":{},"images":{},"variableCollections":{},"variables":{}}"#,
        )
        .unwrap()
    }

    #[test]
    fn move_keeps_the_world_place_and_builds_the_patch_from_written_keys() {
        let base = doc();
        let mut tx = Transaction::new(base.clone());
        tx.move_node("a", "p", None, true).unwrap();
        let (after, result) = tx.commit_doc().unwrap();
        let a = after.get("nodes").unwrap().get("a").unwrap();
        assert_eq!(a.get("x").unwrap().as_f64(), Some(110.0));
        assert_eq!(a.get("y").unwrap().as_f64(), Some(60.0));
        let keys: Vec<&str> = result
            .patch
            .get("nodes")
            .unwrap()
            .as_object()
            .unwrap()
            .keys()
            .map(|key| &**key)
            .collect();
        assert_eq!(keys, ["p", "a", "f"]);
        assert_eq!(
            result.dirty.iter().map(|id| &**id).collect::<Vec<_>>(),
            ["a", "f", "p"]
        );
        let children = after
            .get("nodes")
            .unwrap()
            .get("p")
            .unwrap()
            .get("children")
            .unwrap()
            .to_json();
        assert_eq!(children, r#"["f","r","a"]"#);
        // The untouched node is the base's own.
        assert!(
            after
                .get("nodes")
                .unwrap()
                .get("r")
                .unwrap()
                .identical(base.get("nodes").unwrap().get("r").unwrap())
        );
    }

    #[test]
    fn checks_as_the_typescript_does() {
        let mut tx = Transaction::new(doc());
        assert_eq!(
            tx.update("a", &[(Str::from("parentId"), Some(Value::str("p")))])
                .unwrap_err()
                .0,
            "\"parentId\" changes through create, move or remove"
        );
        assert_eq!(
            tx.move_node("f", "a", None, true).unwrap_err().0,
            "A RECTANGLE cannot hold children"
        );
        assert_eq!(
            tx.move_node("f", "f", None, true).unwrap_err().0,
            "A node cannot move into itself"
        );
        assert_eq!(
            tx.remove_page("p").unwrap_err().0,
            "A file keeps at least one page"
        );
        tx.update("a", &[(Str::from("x"), Some(Value::Number(10.0)))])
            .unwrap();
        let result = tx.commit().unwrap();
        assert!(crate::patch::is_empty_patch(&result.patch));
    }

    #[test]
    fn removal_drops_the_subtree_and_flushes_the_parent_once() {
        let mut tx = Transaction::new(doc());
        tx.remove("f").unwrap();
        tx.remove("r").unwrap();
        let (after, result) = tx.commit_doc().unwrap();
        assert_eq!(
            after
                .get("nodes")
                .unwrap()
                .get("p")
                .unwrap()
                .get("children")
                .unwrap()
                .to_json(),
            "[]"
        );
        assert_eq!(
            result.patch.to_json(),
            r#"{"nodes":{"f":null,"a":null,"r":null,"p":{"id":"p","type":"PAGE","parentId":null,"children":[]}}}"#
        );
        assert_eq!(
            result
                .inverse
                .get("nodes")
                .unwrap()
                .as_object()
                .unwrap()
                .len(),
            4
        );
    }
}
