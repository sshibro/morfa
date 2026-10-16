//! shared/design/merge.ts: co-editing (docs/design-tool.md "Co-editing", "Merge rules"). A change made
//! on an older version of a file lands on the newer one field by field. The server runs this for every save whose
//! `baseVersion` is behind, and every editor runs the same function to rebase its unsaved changes over the others',
//! so both sides reach the same document. Pure and deterministic.
//!
//! This is a line-by-line port: the TypeScript is the oracle, and the outcome (the patch, the `adjusted` flag, even
//! the key order of every object written) equals it. Sets and maps iterate in insertion order as JavaScript's do
//! (`IndexSet`, `IndexMap`), ids sort by UTF-16 code units as `Array.prototype.sort` does.
//!
//! The rules, in short:
//! - Fields: a field the change did not touch keeps the target's value; a field it touched takes the change's value
//!   (the later writer wins). Records keyed by id merge one level deeper; `overrides` merges as a set; lists of
//!   entries with ids (annotations, measurements) merge entry by entry.
//! - Text: the characters of a text layer merge when the two edits touch different places; otherwise the later wins.
//! - Structure: `parentId` decides where a layer lives and each `children` list is rebuilt from it ([`merge_list`]).
//!   A move into a layer that no longer exists, or one that would make a cycle, is refused (decided in id order).
//! - Removal: removal wins over an edit; a removal takes what its author saw, and a layer someone else put into the
//!   removed part moves up to the nearest surviving ancestor in place. Instance copies go with their instance.
//! - A group or boolean left without layers is removed; the last page is never removed.

use crate::doc::DocRead;
use crate::geometry::{Matrix, local_matrix, multiply, placement_for};
use crate::patch::{pages_of, table_of};
use crate::text::{RunOverride, caret_style_at, insert_text};
use crate::value::{Object, Str, Value, from_utf16, utf16};
use foldhash::fast::FixedState;
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, VecDeque};
use std::hash::Hash;

type IndexSet<T> = indexmap::IndexSet<T, FixedState>;
type IndexMap<K, V> = indexmap::IndexMap<K, V, FixedState>;
type HashSet<T> = std::collections::HashSet<T, FixedState>;

/// The tables other than `nodes` (`MergeTable`).
pub const MERGE_TABLES: [&str; 5] = [
    "styles",
    "images",
    "variableCollections",
    "variables",
    "variableModes",
];

/// The node types that hold children (`CONTAINER_TYPES`).
pub const CONTAINER_TYPES: [&str; 8] = [
    "PAGE",
    "FRAME",
    "GROUP",
    "SECTION",
    "COMPONENT",
    "COMPONENT_SET",
    "INSTANCE",
    "BOOLEAN_OPERATION",
];

/// The hidden page of library copies, never listed in `pages` (`LIBRARY_PAGE_ID`).
pub const LIBRARY_PAGE_ID: &str = "morfa:library";

/// `DESIGN_FIELD_LIMITS.depth + 8`: a walk up the tree longer than this is a cycle.
const WALK_LIMIT: usize = 256 + 8;
/// `DESIGN_FIELD_LIMITS.characters`.
const CHARACTERS_LIMIT: usize = 100_000;

const STRUCTURE: [&str; 3] = ["id", "parentId", "children"];
const NODE_RECORDS: [&str; 9] = [
    "autoLayout",
    "boundVariables",
    "componentProperties",
    "componentPropertyDefinitions",
    "pluginData",
    "constraints",
    "board",
    "grid",
    "gridChild",
];
const NODE_ENTRY_LISTS: [&str; 2] = ["annotations", "measurements"];

pub fn is_container(kind: Option<&str>) -> bool {
    kind.is_some_and(|kind| CONTAINER_TYPES.contains(&kind))
}

/// `Array.prototype.sort`'s order of strings: UTF-16 code units.
pub fn js_cmp(a: &str, b: &str) -> Ordering {
    if a.is_ascii() && b.is_ascii() {
        return a.cmp(b);
    }
    a.encode_utf16().cmp(b.encode_utf16())
}

/// What a merge reads of the document a change lands on (`MergeTarget`).
pub trait MergeTarget {
    /// The page order (an array of ids).
    fn pages(&self) -> Value;
    fn node(&self, id: &str) -> Option<Value>;
    /// The entry, or None when the table has none.
    fn entry(&self, table: &str, key: &str) -> Option<Value>;
    /// A hint: these entries will be read.
    fn prefetch(&self, _table: &str, _keys: &mut dyn Iterator<Item = &Str>) {}
}

/// `documentTarget`: a document held as a [`Value`].
pub struct DocumentTarget<'a>(pub &'a dyn DocRead);

impl MergeTarget for DocumentTarget<'_> {
    fn pages(&self) -> Value {
        let pages = self.0.pages();
        if pages.is_null() {
            Value::array(Vec::new())
        } else {
            pages
        }
    }

    fn node(&self, id: &str) -> Option<Value> {
        self.0.entry("nodes", id)
    }

    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        self.0.entry(table, key)
    }

    fn prefetch(&self, table: &str, keys: &mut dyn Iterator<Item = &Str>) {
        self.0.prefetch(table, keys);
    }
}

/// `MergeOutcome`.
#[derive(Clone, Debug)]
pub struct MergeOutcome {
    /// Entries to write onto the target (whole entries, null removes), and the page order when it changes.
    pub patch: Value,
    /// The change did not land as it was sent.
    pub adjusted: bool,
}

// ── Small readers ─────────────────────────────────────────────────────────────────────────────────

fn same_option(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => a.same(b),
        _ => false,
    }
}

fn kind(node: &Value) -> Option<&str> {
    node.get("type").and_then(Value::as_str)
}

/// `node.parentId` as a string; `null` and anything else read as None.
fn parent_of(node: &Value) -> Option<Str> {
    match node.get("parentId") {
        Some(Value::String(parent)) => Some(parent.clone()),
        _ => None,
    }
}

fn children_of(node: &Value) -> &[Value] {
    node.get("children")
        .and_then(Value::as_array)
        .unwrap_or(&[])
}

fn ids_of(list: &[Value]) -> Vec<Str> {
    list.iter()
        .filter_map(|id| {
            if let Value::String(id) = id {
                Some(id.clone())
            } else {
                None
            }
        })
        .collect()
}

fn str_list(ids: Vec<Str>) -> Value {
    Value::array(ids.into_iter().map(Value::String).collect())
}

fn is_plain_object(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Object(_)))
}

fn is_array(value: Option<&Value>) -> bool {
    matches!(value, Some(Value::Array(_)))
}

fn object_of(value: &Value) -> Object {
    value.as_object().cloned().unwrap_or_default()
}

/// A value as a member of a JavaScript `Set`/`Map` key (SameValueZero): strings by content, objects by identity.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
enum SetKey {
    Null,
    Undefined,
    Bool(bool),
    Number(u64),
    String(Str),
    Pointer(usize),
}

fn set_key(value: Option<&Value>) -> SetKey {
    match value {
        None => SetKey::Undefined,
        Some(Value::Null) => SetKey::Null,
        Some(Value::Bool(value)) => SetKey::Bool(*value),
        Some(Value::Number(value)) => {
            let value = if *value == 0.0 { 0.0 } else { *value };
            SetKey::Number(if value.is_nan() {
                f64::NAN.to_bits()
            } else {
                value.to_bits()
            })
        }
        Some(Value::String(value)) => SetKey::String(value.clone()),
        Some(Value::Array(items)) => SetKey::Pointer(std::sync::Arc::as_ptr(items) as usize),
        Some(Value::Object(object)) => {
            SetKey::Pointer(std::sync::Arc::as_ptr(object).cast::<u8>() as usize)
        }
    }
}

// ── Records, sets, entry lists ────────────────────────────────────────────────────────────────────

/// `new Set([...Object.keys(a), ...Object.keys(b)])`.
fn key_union(a: &Object, b: &Object) -> Vec<Str> {
    // The common case: the same keys in the same order (two versions of one entry).
    if a.len() == b.len()
        && a.keys()
            .zip(b.keys())
            .all(|(x, y)| std::sync::Arc::ptr_eq(x, y) || x == y)
    {
        return a.keys().cloned().collect();
    }
    if b.keys().all(|key| a.contains_key(key)) {
        return a.keys().cloned().collect();
    }
    let mut keys: IndexSet<Str> =
        IndexSet::with_capacity_and_hasher(a.len() + b.len(), FixedState::default());
    keys.extend(a.keys().cloned());
    keys.extend(b.keys().cloned());
    keys.into_iter().collect()
}

/// `mergeRecord`: `theirs` with the record entries `ours` changed against `base`.
fn merge_record(base: &Object, ours: &Object, theirs: &Object) -> Object {
    let mut out = theirs.clone();
    for key in key_union(base, ours) {
        if same_option(base.get(&key), ours.get(&key)) {
            continue;
        }
        match ours.get(&key) {
            None => {
                out.remove(&key);
            }
            Some(value) => out.insert(key, value.clone()),
        }
    }
    out
}

/// `mergeSet`: what `ours` added and removed, applied to `theirs` (order: theirs, then additions). None: undefined.
fn merge_set(base: Option<&Value>, ours: Option<&Value>, theirs: Option<&Value>) -> Option<Value> {
    fn list(value: Option<&Value>) -> &[Value] {
        value.and_then(Value::as_array).unwrap_or(&[])
    }
    let b: HashSet<SetKey> = list(base)
        .iter()
        .map(|value| set_key(Some(value)))
        .collect();
    let o: HashSet<SetKey> = list(ours)
        .iter()
        .map(|value| set_key(Some(value)))
        .collect();
    let mut out: Vec<Value> = list(theirs)
        .iter()
        .filter(|value| {
            let key = set_key(Some(value));
            !(b.contains(&key) && !o.contains(&key))
        })
        .cloned()
        .collect();
    let mut seen: HashSet<SetKey> = out.iter().map(|value| set_key(Some(value))).collect();
    for value in list(ours) {
        let key = set_key(Some(value));
        if !b.contains(&key) && !seen.contains(&key) {
            seen.insert(key);
            out.push(value.clone());
        }
    }
    if !out.is_empty() || ours.is_some() {
        Some(Value::array(out))
    } else {
        None
    }
}

/// `mergeEntries`: a list of `{id}` entries: `theirs` without what `ours` removed, with what `ours` added or changed,
/// in `ours`'s order where it moved entries. None when empty.
fn merge_entries(base: Option<&Value>, ours: &[Value], theirs: Option<&Value>) -> Option<Value> {
    let entry_id = |entry: &Value| set_key(entry.get("id"));
    let mut b: IndexMap<SetKey, &Value> = IndexMap::default();
    for entry in base.and_then(Value::as_array).unwrap_or(&[]) {
        b.insert(entry_id(entry), entry);
    }
    let mut o: IndexMap<SetKey, &Value> = IndexMap::default();
    for entry in ours {
        o.insert(entry_id(entry), entry);
    }
    let theirs = theirs.and_then(Value::as_array).unwrap_or(&[]);
    let mut value: IndexMap<SetKey, Value> = IndexMap::default();
    for entry in theirs {
        let id = entry_id(entry);
        if b.contains_key(&id) && !o.contains_key(&id) {
            continue;
        }
        let chosen = match o.get(&id) {
            Some(mine) if !same_option(b.get(&id).copied(), Some(mine)) => (*mine).clone(),
            _ => entry.clone(),
        };
        value.insert(id, chosen);
    }
    let mut added = Vec::new();
    for entry in ours {
        let id = entry_id(entry);
        if !b.contains_key(&id) && !value.contains_key(&id) {
            value.insert(id.clone(), entry.clone());
            added.push(id);
        }
    }
    if value.is_empty() {
        return None;
    }
    let mut list: Vec<SetKey> = theirs
        .iter()
        .map(entry_id)
        .filter(|id| value.contains_key(id))
        .collect();
    list.extend(added);
    let base_ids: Vec<SetKey> = b.keys().cloned().collect();
    let our_ids: Vec<SetKey> = o.keys().cloned().collect();
    let merged = merge_list(&list, &base_ids, &our_ids, |id| value.contains_key(id));
    Some(Value::array(
        merged
            .iter()
            .filter_map(|id| value.get(id).cloned())
            .collect(),
    ))
}

// ── Text ──────────────────────────────────────────────────────────────────────────────────────────

/// `textEdit` in UTF-16 code units: [start, end) of `a` becomes `inserted`. None when `a == b`.
pub fn text_edit_units(a: &[u16], b: &[u16]) -> Option<(usize, usize, Vec<u16>)> {
    if a == b {
        return None;
    }
    let max = a.len().min(b.len());
    let mut prefix = 0;
    while prefix < max && a[prefix] == b[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < max - prefix && a[a.len() - 1 - suffix] == b[b.len() - 1 - suffix] {
        suffix += 1;
    }
    Some((
        prefix,
        a.len() - suffix,
        b[prefix..b.len() - suffix].to_vec(),
    ))
}

/// `textEdit(a, b)`: `{start, end, inserted}` or null.
pub fn text_edit(a: &str, b: &str) -> Value {
    match text_edit_units(&utf16(a), &utf16(b)) {
        None => Value::Null,
        Some((start, end, inserted)) => {
            let mut out = Object::with_capacity(3);
            #[allow(clippy::cast_precision_loss)]
            {
                out.insert("start", Value::Number(start as f64));
                out.insert("end", Value::Number(end as f64));
            }
            out.insert("inserted", Value::String(from_utf16(&inserted).into()));
            Value::object(out)
        }
    }
}

fn characters(text: &Value) -> &str {
    text.get("characters").and_then(Value::as_str).unwrap_or("")
}

/// `sameContent`: characters, runs and list types.
fn same_content(a: &Value, b: &Value) -> bool {
    characters(a) == characters(b)
        && same_option(a.get("runs"), b.get("runs"))
        && same_option(a.get("listTypes"), b.get("listTypes"))
}

/// `mergeTextContent`: `ours`'s edit replayed on `theirs` when it is one replacement that does not overlap theirs.
#[allow(clippy::cast_precision_loss)]
fn merge_text_content(base: &Value, ours: &Value, theirs: &Value) -> Option<Value> {
    let base_units = utf16(characters(base));
    let (mine_start, mine_end, mine_inserted) =
        text_edit_units(&base_units, &utf16(characters(ours)))?;
    let (other_start, other_end, other_inserted) =
        text_edit_units(&base_units, &utf16(characters(theirs)))?;
    let mut replaced = 0;
    let at = if mine_start == mine_end && other_start == other_end && mine_start == other_start {
        // Ours goes on from what theirs typed there: the same typing, once (a save sent again after its answer was lost).
        if mine_inserted.starts_with(&other_inserted) {
            replaced = other_inserted.len();
            mine_start
        } else {
            mine_start + other_inserted.len() // both typed at one place: theirs first
        }
    } else if mine_end <= other_start {
        mine_start
    } else if other_end <= mine_start {
        mine_start + other_inserted.len() - (other_end - other_start)
    } else {
        return None; // the edits overlap: the later writer decides
    };
    // Ours must be exactly that replacement (typing, deleting, pasting one style): otherwise it also restyled text.
    let style: Option<RunOverride> = if mine_inserted.is_empty() {
        None
    } else {
        caret_style_at(
            ours,
            mine_start as f64,
            (mine_start + mine_inserted.len()) as f64,
        )
    };
    let replayed = insert_text(
        base,
        mine_start as f64,
        mine_end as f64,
        &mine_inserted,
        Some(style.clone()),
    );
    if !same_option(replayed.get("runs"), ours.get("runs"))
        || !same_option(replayed.get("listTypes"), ours.get("listTypes"))
    {
        return None;
    }
    let merged = insert_text(
        theirs,
        at as f64,
        (at + (mine_end - mine_start) + replaced) as f64,
        &mine_inserted,
        Some(style),
    );
    if characters(&merged).encode_utf16().count() > CHARACTERS_LIMIT {
        return None;
    }
    Some(merged)
}

/// `mergeText`: a text layer's `text`: its content as above, its other fields one by one.
fn merge_text(base: &Value, ours: &Value, theirs: &Value) -> (Value, bool) {
    let mut out = merge_record(&object_of(base), &object_of(ours), &object_of(theirs));
    let ours_changed = !same_content(base, ours);
    let theirs_changed = !same_content(base, theirs);
    let mut adjusted = false;
    let merged;
    let content = if ours_changed && !theirs_changed {
        ours
    } else if ours_changed && theirs_changed && same_content(ours, theirs) {
        // The same edit on both sides (a save sent again after its answer was lost, which the server already holds): once.
        theirs
    } else if ours_changed && theirs_changed {
        merged = merge_text_content(base, ours, theirs);
        adjusted = merged.is_some();
        merged.as_ref().unwrap_or(ours)
    } else {
        theirs
    };
    // `{...out, characters, runs}`: an undefined value stays a key JSON never writes; here it is absent.
    match content.get("characters") {
        Some(value) => out.insert("characters", value.clone()),
        None => {
            out.remove("characters");
        }
    }
    match content.get("runs") {
        Some(value) => out.insert("runs", value.clone()),
        None => {
            out.remove("runs");
        }
    }
    match content.get("listTypes").filter(|types| types.truthy()) {
        Some(types) => out.insert("listTypes", types.clone()),
        None => {
            out.remove("listTypes");
        }
    }
    (Value::object(out), adjusted)
}

// ── Fields ────────────────────────────────────────────────────────────────────────────────────────

/// `mergeNodeFields`: `theirs` with every field `ours` changed against `base` (structure aside).
fn merge_node_fields(base: &Value, ours: &Value, theirs: &Value) -> (Object, bool) {
    let mut out = object_of(theirs);
    let (b, o) = (object_of(base), object_of(ours));
    let t = theirs;
    let mut adjusted = false;
    let t_object = t.as_object();
    for (at, key) in key_union(&b, &o).into_iter().enumerate() {
        if STRUCTURE.contains(&&*key) {
            continue;
        }
        let (before, after) = (b.get_hinted(&key, at), o.get_hinted(&key, at));
        if same_option(before, after) {
            if !same_option(t_object.and_then(|t| t.get_hinted(&key, at)), after) {
                adjusted = true;
            }
            continue;
        }
        let Some(after) = after else {
            out.remove(&key);
            continue;
        };
        let theirs_value = t_object.and_then(|t| t.get_hinted(&key, at));
        if &*key == "text"
            && before.is_some_and(Value::truthy)
            && theirs_value.is_some_and(Value::truthy)
            && after.as_object().is_some()
        {
            let (text, text_adjusted) = merge_text(
                before.expect("a base text"),
                after,
                theirs_value.expect("their text"),
            );
            out.insert(key, text);
            adjusted |= text_adjusted;
        } else if &*key == "overrides" {
            match merge_set(before, Some(after), theirs_value) {
                Some(set) => out.insert(key, set),
                None => {
                    out.remove(&key);
                }
            }
        } else if NODE_ENTRY_LISTS.contains(&&*key)
            && (before.is_none() || is_array(before))
            && is_array(Some(after))
            && (theirs_value.is_none() || is_array(theirs_value))
        {
            match merge_entries(before, after.as_array().unwrap_or(&[]), theirs_value) {
                Some(merged) => out.insert(key.clone(), merged),
                None => {
                    out.remove(&key);
                }
            }
            if !same_option(out.get(&key), Some(after)) {
                adjusted = true;
            }
        } else if NODE_RECORDS.contains(&&*key)
            && is_plain_object(before)
            && is_plain_object(Some(after))
            && is_plain_object(theirs_value)
        {
            let merged = merge_record(
                &object_of(before.expect("a record")),
                &object_of(after),
                &object_of(theirs_value.expect("a record")),
            );
            let merged = Value::object(merged);
            if !merged.same(after) {
                adjusted = true;
            }
            out.insert(key, merged);
        } else {
            out.insert(key, after.clone());
        }
    }
    (out, adjusted)
}

/// `mergeEntryFields`: a table entry field by field; a variable's values by mode and a mode choice entry by entry.
fn merge_entry_fields(
    table: &str,
    base: &Value,
    ours: &Value,
    theirs: &Value,
    keep_variable: &dyn Fn(&Str) -> bool,
) -> Value {
    let (b, o, t) = (object_of(base), object_of(ours), object_of(theirs));
    if table == "variableModes" {
        return Value::object(merge_record(&b, &o, &t));
    }
    let mut out = t.clone();
    for key in key_union(&b, &o) {
        let (before, after) = (b.get(&key), o.get(&key));
        if same_option(before, after) {
            continue;
        }
        let Some(after) = after else {
            out.remove(&key);
            continue;
        };
        let theirs_value = t.get(&key);
        if table == "variables"
            && &*key == "valuesByMode"
            && is_plain_object(before)
            && is_plain_object(Some(after))
            && is_plain_object(theirs_value)
        {
            let merged = merge_record(
                &object_of(before.expect("a record")),
                &object_of(after),
                &object_of(theirs_value.expect("a record")),
            );
            out.insert(key, Value::object(merged));
        } else if table == "variableCollections"
            && &*key == "variableIds"
            && is_array(before)
            && is_array(Some(after))
            && is_array(theirs_value)
        {
            let list = ids_of(theirs_value.and_then(Value::as_array).unwrap_or(&[]));
            let base_ids = ids_of(before.and_then(Value::as_array).unwrap_or(&[]));
            let our_ids = ids_of(after.as_array().unwrap_or(&[]));
            out.insert(
                key,
                str_list(merge_list(&list, &base_ids, &our_ids, |id| {
                    keep_variable(id)
                })),
            );
        } else {
            out.insert(key, after.clone());
        }
    }
    Value::object(out)
}

// ── Lists ─────────────────────────────────────────────────────────────────────────────────────────

/// Indexes (into `values`) of a longest strictly increasing subsequence (`longestIncreasing`).
fn longest_increasing(values: &[usize]) -> Vec<bool> {
    let mut tails: Vec<usize> = Vec::new();
    let mut previous: Vec<Option<usize>> = vec![None; values.len()];
    for i in 0..values.len() {
        let (mut lo, mut hi) = (0, tails.len());
        while lo < hi {
            let mid = (lo + hi) >> 1;
            if values[tails[mid]] < values[i] {
                lo = mid + 1;
            } else {
                hi = mid;
            }
        }
        if lo > 0 {
            previous[i] = Some(tails[lo - 1]);
        }
        if lo == tails.len() {
            tails.push(i);
        } else {
            tails[lo] = i;
        }
    }
    let mut out = vec![false; values.len()];
    let mut at = tails.last().copied();
    while let Some(i) = at {
        out[i] = true;
        at = previous[i];
    }
    out
}

/// `mergeList`: a list of ids after `ours` reordered `base`: `list` is the target's list. Ids `ours` added or moved out
/// of order go before the next id `ours` kept in its order (at the end when none follows); every other id keeps the
/// target's order. Linear in the lists' lengths.
pub fn merge_list<K: Clone + Eq + Hash>(
    list: &[K],
    base: &[K],
    ours: &[K],
    keep: impl Fn(&K) -> bool,
) -> Vec<K> {
    let mut base_pos: HashMap<&K, usize, FixedState> =
        HashMap::with_capacity_and_hasher(base.len(), FixedState::default());
    for (i, id) in base.iter().enumerate() {
        base_pos.insert(id, i);
    }
    let mut common = Vec::new();
    let mut common_ids = Vec::new();
    for id in ours {
        if let Some(&position) = base_pos.get(id) {
            common.push(position);
            common_ids.push(id);
        }
    }
    let mut steady: HashSet<&K> = HashSet::default();
    for (i, increasing) in longest_increasing(&common).into_iter().enumerate() {
        if increasing {
            steady.insert(common_ids[i]);
        }
    }
    let mut moved: HashSet<&K> = HashSet::default();
    for id in ours {
        if !steady.contains(id) && keep(id) {
            moved.insert(id);
        }
    }
    if moved.is_empty() {
        return list.iter().filter(|id| keep(id)).cloned().collect();
    }
    let listed: HashSet<&K> = list.iter().collect();
    // Each moved id goes before the next steady id ours lists after it that the target still holds here.
    let mut before: HashMap<&K, Vec<&K>, FixedState> = HashMap::default();
    let mut tail: Vec<&K> = Vec::new();
    let mut anchor: Option<&K> = None;
    for id in ours.iter().rev() {
        if steady.contains(id) {
            if listed.contains(id) && keep(id) {
                anchor = Some(id);
            }
            continue;
        }
        if !moved.contains(id) {
            continue;
        }
        match anchor {
            None => tail.push(id),
            Some(anchor) => before.entry(anchor).or_default().push(id),
        }
    }
    let mut out = Vec::with_capacity(list.len() + moved.len());
    for id in list {
        if moved.contains(id) || !keep(id) {
            continue;
        }
        if let Some(bucket) = before.get(id) {
            out.extend(bucket.iter().rev().map(|&id| id.clone()));
        }
        out.push(id.clone());
    }
    out.extend(tail.iter().rev().map(|&id| id.clone()));
    out
}

// ── The merge ─────────────────────────────────────────────────────────────────────────────────────

/// The target, each node read once.
struct Reader<'a> {
    target: &'a dyn MergeTarget,
    cache: RefCell<HashMap<Str, Option<Value>, FixedState>>,
}

impl Reader<'_> {
    fn node(&self, id: &str) -> Option<Value> {
        if let Some(hit) = self.cache.borrow().get(id) {
            return hit.clone();
        }
        let node = self.target.node(id);
        self.cache.borrow_mut().insert(id.into(), node.clone());
        node
    }
}

struct Rescue {
    matrix: Option<Matrix>,
}

/// `mergeChange(target, change, before)`: `change` (entries after it) made by someone whose copy of each entry was
/// `before` (null: absent; an entry without a before copy is taken whole), landed on `target`: the entries to write.
#[allow(clippy::too_many_lines)]
pub fn merge_change(
    target: &dyn MergeTarget,
    change: &Value,
    before: Option<&Value>,
) -> MergeOutcome {
    let empty = Object::new();
    let mut out = Object::new();
    let mut adjusted = false;
    let p_table = table_of(change, "nodes").unwrap_or(&empty);
    let b_table = before
        .and_then(|before| table_of(before, "nodes"))
        .unwrap_or(&empty);
    // Target reads are cached: a target may build its values on demand (the server's compact store).
    let reader = Reader {
        target,
        cache: RefCell::new(HashMap::default()),
    };
    let target_node = &reader;
    let has_before = |id: &str| b_table.contains_key(id);
    let p = |id: &str| -> Option<&Value> { p_table.get(id) };

    let mut ids: Vec<Str> = p_table.keys().cloned().collect();
    ids.sort_by(|a, b| js_cmp(a, b));
    // The entries the change names, and their parents, in one trip each (a target behind a boundary).
    target.prefetch("nodes", &mut ids.iter());
    let parents: Vec<Str> = p_table
        .values()
        .chain(b_table.values())
        .filter_map(parent_of)
        .collect();
    target.prefetch("nodes", &mut parents.iter());
    for table in MERGE_TABLES {
        if let Some(changes) = table_of(change, table) {
            target.prefetch(table, &mut changes.keys());
        }
    }

    // The target nodes every id names, read once.
    let mut current_of: HashMap<Str, Option<Value>, FixedState> = HashMap::default();
    let mut base_of_map: HashMap<Str, Option<Value>, FixedState> = HashMap::default();
    let mut created: IndexSet<Str> = IndexSet::default();
    let mut edited: IndexSet<Str> = IndexSet::default();
    let mut removing: IndexSet<Str> = IndexSet::default();
    for id in &ids {
        let ours = p(id).expect("a listed id");
        let current = target_node.node(id);
        let base = if has_before(id) {
            b_table.get(id).filter(|value| !value.is_null()).cloned()
        } else {
            current.clone()
        };
        current_of.insert(id.clone(), current.clone());
        base_of_map.insert(id.clone(), base.clone());
        if ours.is_null() {
            if current.is_some() {
                removing.insert(id.clone());
            }
            continue;
        }
        if current.is_none() {
            // Removed by someone else meanwhile: removal wins over the edit.
            if base.is_none() {
                created.insert(id.clone());
            } else {
                adjusted = true;
            }
            continue;
        }
        edited.insert(id.clone());
    }

    // Everything below reads the target through these (each answer cached).
    let node_of = |id: &str, target_node: &Reader| -> Option<Value> { target_node.node(id) };
    let base_of = |id: &str, target_node: &Reader| -> Option<Value> {
        if has_before(id) {
            b_table.get(id).filter(|value| !value.is_null()).cloned()
        } else {
            target_node.node(id)
        }
    };
    let _ = &base_of_map;
    let _ = &current_of;

    // The state the closures of the TypeScript share.
    struct State {
        created: IndexSet<Str>,
        final_parent: IndexMap<Str, Option<Str>>,
        gone: IndexSet<Str>,
    }
    let mut state = State {
        created,
        final_parent: IndexMap::default(),
        gone: IndexSet::default(),
    };

    let exists = |state: &State, id: Option<&str>, target_node: &Reader| -> bool {
        match id {
            Some(id) if !id.is_empty() => {
                state.created.contains(id) || target_node.node(id).is_some()
            }
            _ => false,
        }
    };
    let type_of = |id: &str, target_node: &Reader| -> Option<Str> {
        let node = match p(id) {
            Some(value) if !value.is_null() => Some(value.clone()),
            _ => target_node.node(id),
        };
        node.and_then(|node| match node.get("type") {
            Some(Value::String(kind)) => Some(kind.clone()),
            _ => None,
        })
    };
    let parent_now = |state: &State, id: &str, target_node: &Reader| -> Option<Str> {
        if let Some(parent) = state.final_parent.get(id) {
            return parent.clone();
        }
        if state.created.contains(id) {
            return p(id).and_then(parent_of);
        }
        target_node.node(id).as_ref().and_then(parent_of)
    };

    let mut orphans: Vec<Str> = Vec::new();
    for id in &ids {
        if !state.created.contains(id) && !edited.contains(id) {
            continue;
        }
        let ours = p(id).expect("a listed id");
        if kind(ours) == Some("PAGE") {
            state.final_parent.insert(id.clone(), None);
            continue;
        }
        let current = node_of(id, target_node);
        let base = base_of(id, target_node);
        let want = if state.created.contains(id)
            || base.is_none()
            || parent_of(ours) != base.as_ref().and_then(parent_of)
        {
            parent_of(ours)
        } else {
            current.as_ref().and_then(parent_of)
        };
        if let Some(current) = &current
            && want == parent_of(current)
        {
            state.final_parent.insert(id.clone(), want);
            continue;
        }
        if let Some(want_id) = &want
            && exists(&state, Some(want_id), target_node)
            && is_container(type_of(want_id, target_node).as_deref())
            && kind(ours) != Some("PAGE")
        {
            // createsCycle: walk up from the new parent.
            let mut at: Option<Str> = Some(want_id.clone());
            let mut steps = 0;
            let mut cycle = false;
            while let Some(here) = at {
                if *here == **id || steps > WALK_LIMIT {
                    cycle = true;
                    break;
                }
                at = parent_now(&state, &here, target_node);
                steps += 1;
            }
            if !cycle {
                state.final_parent.insert(id.clone(), want);
                continue;
            }
        }
        adjusted = true;
        if let Some(current) = &current {
            state.final_parent.insert(id.clone(), parent_of(current));
        } else {
            orphans.push(id.clone());
        }
    }

    // Pages: the change's order merged into the target's; the last page is never removed.
    let listed_page =
        |id: &str| id != LIBRARY_PAGE_ID && p(id).is_some_and(|node| kind(node) == Some("PAGE"));
    let target_pages_value = target.pages();
    let target_pages: Vec<Str> = ids_of(target_pages_value.as_array().unwrap_or(&[]));
    let mut page_removals: IndexSet<Str> = IndexSet::default();
    for id in &removing {
        if &**id != LIBRARY_PAGE_ID && target_node.node(id).as_ref().and_then(kind) == Some("PAGE")
        {
            page_removals.insert(id.clone());
        }
    }
    let surviving_pages = target_pages
        .iter()
        .filter(|id| !page_removals.contains(*id))
        .count()
        + state.created.iter().filter(|id| listed_page(id)).count();
    if surviving_pages == 0 && !page_removals.is_empty() {
        if let Some(keep_page) = target_pages
            .iter()
            .find(|id| page_removals.contains(*id))
            .cloned()
        {
            removing.shift_remove(&keep_page);
            page_removals.shift_remove(&keep_page);
        }
        adjusted = true;
    }

    // Removal: what the remover saw goes; what someone else put into it meanwhile is rescued.
    let mut roots: HashSet<Str> = HashSet::default();
    for id in &removing {
        let base = base_of(id, target_node).or_else(|| target_node.node(id));
        let parent = base.as_ref().and_then(parent_of);
        if parent
            .as_ref()
            .is_none_or(|parent| !removing.contains(parent))
        {
            roots.insert(id.clone());
        }
    }
    let mut removed_memo: HashMap<Str, bool, FixedState> = HashMap::default();
    let mut sorted_removing: Vec<Str> = removing.iter().cloned().collect();
    sorted_removing.sort_by(|a, b| js_cmp(a, b));
    for id in &sorted_removing {
        // removedByChange, iteratively: walk up while the answer is unknown, then fill the memo on the way back.
        let mut chain: Vec<Str> = Vec::new();
        let mut at = id.clone();
        let result = loop {
            if let Some(&known) = removed_memo.get(&at) {
                break known;
            }
            if !(removing.contains(&at) && target_node.node(&at).is_some()) {
                removed_memo.insert(at.clone(), false);
                break false;
            }
            if roots.contains(&at) {
                removed_memo.insert(at.clone(), true);
                break true;
            }
            let parent = parent_now(&state, &at, target_node);
            match parent {
                Some(parent) if removing.contains(&parent) => {
                    chain.push(at.clone());
                    if chain.len() > WALK_LIMIT * 4 {
                        break false;
                    }
                    at = parent;
                }
                _ => {
                    removed_memo.insert(at.clone(), false);
                    break false;
                }
            }
        };
        for link in chain {
            removed_memo.insert(link, result);
        }
        if result {
            state.gone.insert(id.clone());
        }
    }
    for id in &removing {
        if !state.gone.contains(id) {
            adjusted = true;
        }
    }

    let alive = |state: &State, id: &str, target_node: &Reader| -> bool {
        exists(state, Some(id), target_node) && !state.gone.contains(id)
    };
    let first_page = |state: &State, target_node: &Reader| -> Option<Str> {
        if let Some(page) = target_pages.iter().find(|id| alive(state, id, target_node)) {
            return Some(page.clone());
        }
        let mut created: Vec<&Str> = state.created.iter().collect();
        created.sort_by(|a, b| js_cmp(a, b));
        created.into_iter().find(|id| listed_page(id)).cloned()
    };

    // Layers that change parent without the change asking (rescued), with their new placement.
    let mut rescued: HashMap<Str, Rescue, FixedState> = HashMap::default();
    let mut extra: IndexMap<Str, Vec<Str>> = IndexMap::default();

    // The nearest living ancestor above `start` (a removed layer), and the removed ones on the way.
    let survivor = |state: &State,
                    start: Option<Str>,
                    lookup: &dyn Fn(&str) -> Option<Value>,
                    target_node: &Reader|
     -> (Option<Str>, Vec<Value>) {
        let mut chain = Vec::new();
        let mut at = start;
        let mut steps = 0;
        while let Some(here) = at.clone() {
            if alive(state, &here, target_node) || steps > WALK_LIMIT {
                break;
            }
            let Some(node) = lookup(&here) else {
                return (first_page(state, target_node), chain);
            };
            at = parent_of(&node);
            chain.push(node);
            steps += 1;
        }
        match at {
            Some(here) if alive(state, &here, target_node) => (Some(here), chain),
            _ => (first_page(state, target_node), chain),
        }
    };
    let carried = |node: &Value, chain: &[Value]| -> Option<Matrix> {
        if chain.is_empty() {
            return None;
        }
        let mut m = local_matrix(node);
        for ancestor in chain {
            if kind(ancestor) != Some("PAGE") {
                m = multiply(&local_matrix(ancestor), &m);
            }
        }
        Some(m)
    };
    let mut dropped: IndexSet<Str> = IndexSet::default();
    // An instance copy cannot leave its instance: it goes, with everything under it.
    let drop = |state: &State, dropped: &mut IndexSet<Str>, id: Str, target_node: &Reader| {
        let mut queue: VecDeque<Str> = VecDeque::from([id]);
        while let Some(node_id) = queue.pop_front() {
            if dropped.contains(&node_id) {
                continue;
            }
            dropped.insert(node_id.clone());
            let node = if state.created.contains(&node_id) {
                p(&node_id).cloned()
            } else {
                target_node.node(&node_id)
            };
            if let Some(node) = node {
                queue.extend(ids_of(children_of(&node)));
            }
        }
    };

    // New layers whose parent was removed by someone else move up, keeping their place on the page.
    for id in &orphans {
        let ours = p(id).expect("an orphan");
        if ours.get("mainId").is_some() {
            drop(&state, &mut dropped, id.clone(), target_node);
            continue;
        }
        let lookup = |at: &str| {
            if has_before(at) {
                b_table.get(at).filter(|value| !value.is_null()).cloned()
            } else {
                None
            }
        };
        let (parent, chain) = survivor(&state, parent_of(ours), &lookup, target_node);
        let Some(parent) = parent else {
            drop(&state, &mut dropped, id.clone(), target_node);
            continue;
        };
        state.final_parent.insert(id.clone(), Some(parent.clone()));
        rescued.insert(
            id.clone(),
            Rescue {
                matrix: carried(ours, &chain),
            },
        );
        extra.entry(parent).or_default().push(id.clone());
    }
    // Layers under removed ones that the remover did not remove (added or moved there by someone else) move up.
    let mut removed_parents: Vec<Str> = state.gone.iter().cloned().collect();
    removed_parents.sort_by(|a, b| js_cmp(a, b));
    for removed in &removed_parents {
        let Some(node) = target_node.node(removed) else {
            continue;
        };
        for child in ids_of(children_of(&node)) {
            if state.gone.contains(&child)
                || parent_now(&state, &child, target_node).as_deref() != Some(&**removed)
                || dropped.contains(&child)
            {
                continue;
            }
            let kept = match p(&child) {
                Some(value) if !value.is_null() => Some(value.clone()),
                _ => target_node.node(&child),
            };
            let Some(kept) = kept else { continue };
            adjusted = true;
            if kept.get("mainId").is_some() {
                drop(&state, &mut dropped, child, target_node);
                continue;
            }
            // `target.node` itself, uncached: the closure borrows the cache mutably already.
            let lookup = |at: &str| target.node(at);
            let (parent, chain) = survivor(&state, Some(removed.clone()), &lookup, target_node);
            let Some(parent) = parent else {
                drop(&state, &mut dropped, child, target_node);
                continue;
            };
            state
                .final_parent
                .insert(child.clone(), Some(parent.clone()));
            rescued.insert(
                child.clone(),
                Rescue {
                    matrix: carried(&kept, &chain),
                },
            );
            extra.entry(parent).or_default().push(child);
        }
    }
    for id in &dropped {
        state.gone.insert(id.clone());
    }

    // Children lists of every parent the change or the rules above touched.
    let mut affected: IndexSet<Str> = IndexSet::default();
    for id in &ids {
        let ours = p(id).expect("a listed id");
        if ours.is_null() || !is_container(kind(ours)) {
            continue;
        }
        let base = base_of(id, target_node);
        if state.created.contains(id)
            || !same_option(
                base.as_ref().and_then(|base| base.get("children")),
                ours.get("children"),
            )
        {
            affected.insert(id.clone());
        }
    }
    for (id, parent) in &state.final_parent {
        let was = target_node.node(id).as_ref().and_then(parent_of);
        if was != *parent {
            if let Some(was) = was {
                affected.insert(was);
            }
            if let Some(parent) = parent {
                affected.insert(parent.clone());
            }
        }
    }
    for id in &state.gone {
        let parent = match target_node.node(id).as_ref().and_then(parent_of) {
            Some(parent) => Some(parent),
            None if state.created.contains(id) => p(id).and_then(parent_of),
            None => target_node.node(id).as_ref().and_then(parent_of),
        };
        if let Some(parent) = parent {
            affected.insert(parent);
        }
    }
    for parent in extra.keys() {
        affected.insert(parent.clone());
    }

    // Layers that arrive under a parent by an accepted move, in id order.
    let mut arriving: HashMap<Str, Vec<Str>, FixedState> = HashMap::default();
    let mut moved_ids: Vec<Str> = state.final_parent.keys().cloned().collect();
    moved_ids.sort_by(|a, b| js_cmp(a, b));
    for id in &moved_ids {
        let Some(parent) = state.final_parent.get(id).cloned().flatten() else {
            continue;
        };
        if rescued.contains_key(id) {
            continue;
        }
        if let Some(node) = target_node.node(id)
            && parent_of(&node).as_ref() == Some(&parent)
        {
            continue;
        }
        arriving.entry(parent).or_default().push(id.clone());
    }

    let belongs = |state: &State, parent: &str, id: &Str, target_node: &Reader| -> bool {
        alive(state, id, target_node)
            && parent_now(state, id, target_node).as_deref() == Some(parent)
    };
    let mut lists: HashMap<Str, Vec<Str>, FixedState> = HashMap::default();
    let mut pending: VecDeque<Str> = {
        let mut sorted: Vec<Str> = affected.into_iter().collect();
        sorted.sort_by(|a, b| js_cmp(a, b));
        sorted.into()
    };
    while let Some(parent) = pending.pop_front() {
        if !alive(&state, &parent, target_node) {
            continue;
        }
        // listOf(parent)
        let ours = p(&parent).filter(|value| !value.is_null());
        let mut list: Vec<Str>;
        {
            let mut keep_cache: HashMap<Str, bool, FixedState> = HashMap::default();
            let mut keep = |id: &Str| -> bool {
                if let Some(&known) = keep_cache.get(id) {
                    return known;
                }
                let answer = belongs(&state, &parent, id, target_node);
                keep_cache.insert(id.clone(), answer);
                answer
            };
            if state.created.contains(&parent) {
                list = ids_of(children_of(ours.expect("a created parent")))
                    .into_iter()
                    .filter(|id| keep(id))
                    .collect();
            } else {
                let held = target_node.node(&parent).expect("a living parent");
                list = ids_of(children_of(&held))
                    .into_iter()
                    .filter(|id| keep(id))
                    .collect();
                if let Some(ours) = ours {
                    let base = base_of(&parent, target_node);
                    let base_children = base.as_ref().and_then(|base| base.get("children"));
                    if !same_option(base_children, ours.get("children")) {
                        let base_ids =
                            ids_of(base_children.and_then(Value::as_array).unwrap_or(&[]));
                        let our_ids = ids_of(children_of(ours));
                        // merge_list's keep is a plain Fn: answer from a precomputed table.
                        let mut known: HashMap<Str, bool, FixedState> = HashMap::default();
                        for id in list.iter().chain(base_ids.iter()).chain(our_ids.iter()) {
                            if !known.contains_key(id) {
                                known.insert(id.clone(), keep(id));
                            }
                        }
                        list = merge_list(&list, &base_ids, &our_ids, |id| {
                            known.get(id).copied().unwrap_or(false)
                        });
                    }
                }
            }
            let mut listed: HashSet<Str> = list.iter().cloned().collect();
            // Accepted moves the change's list does not order (a parent it did not send) and rescued layers: on top.
            for id in arriving
                .get(&parent)
                .into_iter()
                .flatten()
                .chain(extra.get(&parent).into_iter().flatten())
            {
                if !listed.contains(id) && keep(id) {
                    list.push(id.clone());
                    listed.insert(id.clone());
                }
            }
        }
        let parent_type = type_of(&parent, target_node);
        if list.is_empty() && matches!(parent_type.as_deref(), Some("GROUP" | "BOOLEAN_OPERATION"))
        {
            // Groups and booleans left empty go too (and may empty their own parent).
            state.gone.insert(parent.clone());
            adjusted = true;
            if let Some(up) = parent_now(&state, &parent, target_node)
                && !pending.contains(&up)
            {
                pending.push_back(up);
            }
            lists.remove(&parent);
        } else {
            lists.insert(parent, list);
        }
    }

    // The node entries.
    let mut nodes = Object::new();
    for id in &state.gone {
        if target_node.node(id).is_some() {
            nodes.insert(id.clone(), Value::Null);
        }
    }
    let mut touched: IndexSet<Str> = IndexSet::default();
    touched.extend(ids.iter().cloned());
    touched.extend(lists.keys().cloned());
    touched.extend(state.final_parent.keys().cloned());
    let mut touched: Vec<Str> = touched.into_iter().collect();
    touched.sort_by(|a, b| js_cmp(a, b));
    for id in &touched {
        if state.gone.contains(id) || !alive(&state, id, target_node) {
            continue;
        }
        let ours = p(id).filter(|value| !value.is_null());
        let current = target_node.node(id);
        let mut node: Object = if state.created.contains(id) {
            object_of(ours.expect("a created node"))
        } else if let Some(ours) = ours.filter(|_| edited.contains(id)) {
            let current = current.as_ref().expect("an edited node");
            let base = base_of(id, target_node).unwrap_or_else(|| current.clone());
            let (merged, node_adjusted) = merge_node_fields(&base, ours, current);
            adjusted |= node_adjusted;
            merged
        } else {
            object_of(current.as_ref().expect("a living node"))
        };
        let node_kind: Option<Str> = match node.get("type") {
            Some(Value::String(kind)) => Some(kind.clone()),
            _ => None,
        };
        let parent: Value = if node_kind.as_deref() == Some("PAGE") {
            Value::Null
        } else if let Some(parent) = state.final_parent.get(id) {
            parent.clone().map_or(Value::Null, Value::String)
        } else {
            match current
                .as_ref()
                .and_then(|current| current.get("parentId"))
                .filter(|parent| !parent.is_null())
            {
                Some(parent) => parent.clone(),
                None => node.get("parentId").cloned().unwrap_or(Value::Null),
            }
        };
        node.insert("parentId", parent);
        if let Some(list) = lists.get(id) {
            node.insert("children", str_list(list.clone()));
        } else if !state.created.contains(id)
            && current.is_some()
            && is_container(node_kind.as_deref())
        {
            let children = current
                .as_ref()
                .and_then(|current| current.get("children"))
                .filter(|children| !children.is_null());
            node.insert(
                "children",
                children
                    .cloned()
                    .unwrap_or_else(|| Value::array(Vec::new())),
            );
        } else if state.created.contains(id) && is_container(node_kind.as_deref()) {
            let children = ids_of(
                node.get("children")
                    .and_then(Value::as_array)
                    .unwrap_or(&[]),
            );
            let kept: Vec<Str> = children
                .into_iter()
                .filter(|child| belongs(&state, id, child, target_node))
                .collect();
            node.insert("children", str_list(kept));
        }
        if let Some(Rescue {
            matrix: Some(matrix),
        }) = rescued.get(id)
        {
            let node_value = Value::object(node.clone());
            let placement = placement_for(&node_value, matrix, None);
            node.insert("x", Value::Number(placement.x));
            node.insert("y", Value::Number(placement.y));
            node.insert("rotation", Value::Number(placement.rotation));
            if placement.flip_x {
                node.insert("flipX", Value::Bool(true));
            } else {
                node.remove("flipX");
            }
            if placement.flip_y {
                node.insert("flipY", Value::Bool(true));
            } else {
                node.remove("flipY");
            }
        }
        let node = Value::object(node);
        if let Some(current) = &current
            && node.same(current)
        {
            continue;
        }
        nodes.insert(id.clone(), node);
    }
    if !nodes.is_empty() {
        out.insert("nodes", Value::object(nodes));
    }

    // The page order.
    let page_keep = |state: &State, id: &Str, target_node: &Reader| -> bool {
        &**id != LIBRARY_PAGE_ID
            && alive(state, id, target_node)
            && type_of(id, target_node).as_deref() == Some("PAGE")
    };
    let change_pages = pages_of(change);
    if change_pages.is_some()
        || !page_removals.is_empty()
        || state.created.iter().any(|id| listed_page(id))
    {
        let mut keep_cache: HashMap<Str, bool, FixedState> = HashMap::default();
        let mut keep = |id: &Str| -> bool {
            if let Some(&known) = keep_cache.get(id) {
                return known;
            }
            let answer = page_keep(&state, id, target_node);
            keep_cache.insert(id.clone(), answer);
            answer
        };
        let mut pages: Vec<Str> = target_pages.iter().filter(|id| keep(id)).cloned().collect();
        if let Some(change_pages) = change_pages {
            let base_pages = match before
                .and_then(|before| before.get("pages"))
                .filter(|pages| !pages.is_null())
            {
                Some(pages) => ids_of(pages.as_array().unwrap_or(&[])),
                None => target_pages.clone(),
            };
            let our_pages = ids_of(change_pages.as_array().unwrap_or(&[]));
            let mut known: HashMap<Str, bool, FixedState> = HashMap::default();
            for id in pages
                .iter()
                .chain(base_pages.iter())
                .chain(our_pages.iter())
            {
                if !known.contains_key(id) {
                    known.insert(id.clone(), keep(id));
                }
            }
            pages = merge_list(&pages, &base_pages, &our_pages, |id| {
                known.get(id).copied().unwrap_or(false)
            });
        }
        let mut listed: HashSet<Str> = pages.iter().cloned().collect();
        let mut created: Vec<Str> = state.created.iter().cloned().collect();
        created.sort_by(|a, b| js_cmp(a, b));
        for id in created {
            if listed_page(&id) && !listed.contains(&id) && keep(&id) {
                listed.insert(id.clone());
                pages.push(id);
            }
        }
        let pages = str_list(pages);
        if !pages.same(&target_pages_value) {
            out.insert("pages", pages);
        }
    }

    // The other tables, entry by entry. A variable is there after the merge unless the change removed it, or edited
    // one someone else removed.
    let variable_alive = |id: &Str| -> bool {
        let ours = table_of(change, "variables").and_then(|variables| variables.get(id));
        let current = target.entry("variables", id);
        match ours {
            None => current.is_some(),
            Some(Value::Null) => false,
            Some(_) if current.is_some() => true,
            Some(_) => {
                let base = before
                    .and_then(|before| table_of(before, "variables"))
                    .and_then(|variables| variables.get(id));
                base.is_none_or(Value::is_null)
            }
        }
    };
    for table in MERGE_TABLES {
        let Some(changes) = change.get(table).filter(|changes| changes.truthy()) else {
            continue;
        };
        let changes = changes.as_object().unwrap_or(&empty);
        let bases = before
            .and_then(|before| before.get(table))
            .and_then(Value::as_object);
        let mut written = Object::new();
        let mut keys: Vec<&Str> = changes.keys().collect();
        keys.sort_by(|a, b| js_cmp(a, b));
        for key in keys {
            let ours = changes.get(key).expect("a listed key");
            let current = target.entry(table, key);
            let base: Option<Value> = match bases.and_then(|bases| bases.get(key)) {
                Some(value) => (!value.is_null()).then(|| value.clone()),
                None => current.clone(),
            };
            if ours.is_null() {
                if current.is_some() {
                    written.insert(key.clone(), Value::Null);
                }
                continue;
            }
            if table == "variableModes" && !alive(&state, key, target_node) {
                adjusted = true;
                if current.is_some() {
                    written.insert(key.clone(), Value::Null);
                }
                continue;
            }
            let Some(current) = current else {
                if base.is_none() {
                    written.insert(key.clone(), ours.clone());
                } else {
                    adjusted = true;
                }
                continue;
            };
            let merged = merge_entry_fields(
                table,
                base.as_ref().unwrap_or(&current),
                ours,
                &current,
                &variable_alive,
            );
            if !merged.same(ours) {
                adjusted = true;
            }
            if !merged.same(&current) {
                written.insert(key.clone(), merged);
            }
        }
        if !written.is_empty() {
            out.insert(table, Value::object(written));
        }
    }
    // A removed layer's mode choices go with it.
    for id in &state.gone {
        if target.entry("variableModes", id).is_some() {
            let mut modes = match out.remove("variableModes") {
                Some(Value::Object(modes)) => modes,
                _ => std::sync::Arc::new(Object::new()),
            };
            std::sync::Arc::make_mut(&mut modes).insert(id.clone(), Value::Null);
            out.insert("variableModes", Value::Object(modes));
        }
    }

    MergeOutcome {
        patch: Value::object(out),
        adjusted,
    }
}

// ── An editor's unsaved changes over the server's ─────────────────────────────────────────────────

const ALL_TABLES: [&str; 6] = [
    "nodes",
    "styles",
    "images",
    "variableCollections",
    "variables",
    "variableModes",
];

/// `Rebased`.
#[derive(Clone, Debug)]
pub struct Rebased {
    /// Entries (and the page order) to write into the editor's document.
    pub display: Value,
    /// The unsaved changes after the rebase, and the server's copy of them.
    pub local: Value,
    pub server: Value,
}

/// `rebaseLocal(state, change)`: the server's copy changed (`change`): the editor's unsaved changes (`local`, with
/// the server's copy of them `server`, over the editor's document `doc`) are put on top of it with [`merge_change`].
///
/// `display` keeps an entry only when it is not the very value the editor's document holds: JavaScript compares by
/// identity there, and so does this (shared values compare equal); a caller whose inputs were parsed apart passes
/// `by_value` to compare by value instead, which leaves out entries that differ only by identity.
pub fn rebase_local(
    doc: &dyn DocRead,
    local: &Value,
    server: &Value,
    change: &Value,
    by_value: bool,
) -> Rebased {
    let server_value = |table: &str, key: &str| -> Value {
        if let Some(changed) = table_of(change, table)
            && let Some(value) = changed.get(key)
        {
            return value.clone();
        }
        if let Some(known) = table_of(server, table)
            && let Some(value) = known.get(key)
        {
            return value.clone();
        }
        doc.entry(table, key)
            .filter(|value| !value.is_null())
            .unwrap_or(Value::Null)
    };
    let nullish = |value: Option<&Value>| value.filter(|value| !value.is_null()).cloned();
    let server_pages = nullish(change.get("pages"))
        .or_else(|| nullish(server.get("pages")))
        .or_else(|| Some(doc.pages()))
        .unwrap_or(Value::Null);
    for table in ALL_TABLES {
        let keys: Vec<Str> = [change, local, server]
            .iter()
            .filter_map(|source| table_of(source, table))
            .flat_map(|entries| entries.keys().cloned())
            .collect();
        if !keys.is_empty() {
            doc.prefetch(table, &mut keys.iter());
        }
    }
    let mut overlaps = pages_of(change).is_some() && pages_of(local).is_some();
    for table in ALL_TABLES {
        if overlaps {
            break;
        }
        let (Some(changed), Some(mine)) = (
            change.get(table).filter(|value| value.truthy()),
            local.get(table).filter(|value| value.truthy()),
        ) else {
            continue;
        };
        if let (Some(changed), Some(mine)) = (changed.as_object(), mine.as_object()) {
            overlaps = changed.keys().any(|key| mine.contains_key(key));
        }
    }
    struct ServerTarget<'a> {
        pages: Value,
        value: &'a dyn Fn(&str, &str) -> Value,
    }
    impl MergeTarget for ServerTarget<'_> {
        fn pages(&self) -> Value {
            self.pages.clone()
        }
        fn node(&self, id: &str) -> Option<Value> {
            Some((self.value)("nodes", id)).filter(|value| !value.is_null())
        }
        fn entry(&self, table: &str, key: &str) -> Option<Value> {
            Some((self.value)(table, key)).filter(|value| !value.is_null())
        }
    }
    let merged = if overlaps {
        merge_change(
            &ServerTarget {
                pages: server_pages.clone(),
                value: &server_value,
            },
            local,
            Some(server),
        )
        .patch
    } else {
        local.clone()
    };
    let mut display = Object::new();
    let mut next_local = Object::new();
    let mut next_server = Object::new();
    for table in ALL_TABLES {
        let mut keys: IndexSet<Str> = IndexSet::default();
        for source in [change, local, &merged] {
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
        let mut shown = Object::new();
        let mut mine = Object::new();
        let mut theirs = Object::new();
        let result = merged
            .get(table)
            .filter(|value| value.truthy())
            .and_then(Value::as_object);
        for key in keys {
            let value = server_value(table, &key);
            let view = result
                .and_then(|result| result.get(&key))
                .cloned()
                .unwrap_or_else(|| value.clone());
            let held = doc.entry(table, &key);
            let held = held.as_ref();
            let unchanged = match (&view, held) {
                (Value::Null, None) => true,
                (view, Some(held)) => {
                    if by_value {
                        view.same(held)
                    } else {
                        view.identical(held)
                    }
                }
                _ => false,
            };
            if !unchanged {
                shown.insert(key.clone(), view.clone());
            }
            if !view.same(&value) {
                mine.insert(key.clone(), view);
                theirs.insert(key, value);
            }
        }
        if !shown.is_empty() {
            display.insert(table, Value::object(shown));
        }
        if !mine.is_empty() {
            next_local.insert(table, Value::object(mine));
            next_server.insert(table, Value::object(theirs));
        }
    }
    let pages = if overlaps {
        nullish(merged.get("pages")).unwrap_or_else(|| server_pages.clone())
    } else {
        nullish(local.get("pages")).unwrap_or_else(|| server_pages.clone())
    };
    let copy = |value: &Value| match value {
        Value::Array(items) => Value::array(items.as_ref().clone()),
        other => other.clone(),
    };
    let doc_pages = doc.pages();
    if !same_option(
        Some(&pages),
        Some(&doc_pages).filter(|pages| !pages.is_null()),
    ) {
        display.insert("pages", copy(&pages));
    }
    if !pages.same(&server_pages) {
        next_local.insert("pages", copy(&pages));
        next_server.insert("pages", copy(&server_pages));
    }
    Rebased {
        display: Value::object(display),
        local: Value::object(next_local),
        server: Value::object(next_server),
    }
}
