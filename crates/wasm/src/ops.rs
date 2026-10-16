//! Ops entry points (lane L2a, `crates/ops`): patches, the merge, the patched-document check and transactions, called
//! by shared/design/ops-engine.ts through the engine switch (`withEngine('ops', …)`).
//!
//! Every call crosses as JSON text with an **entry pool**, so JavaScript identity survives the boundary where the
//! TypeScript observes it (`diffDocuments` compares entries with `===`, `rebaseLocal` shows an entry unless it is the
//! very object the document holds, `applyPatch` keeps untouched entries): the caller lists every object down to
//! depth 3 of its arguments (documents, tables, entries, page lists) once in `pool`, and the arguments refer to them
//! as `{"$r": index}`. The result refers back the same way to every pool value it holds unchanged.

use crate::scratch;
use morfa_ops::doc::DocRead;
use morfa_ops::merge::{DocumentTarget, merge_change, merge_list, rebase_local, text_edit};
use morfa_ops::patch::{
    apply_patch, compose_patches, diff_documents, invert_patch, is_empty_patch,
};
use morfa_ops::value::{Object, Str, Value, write_string};
use morfa_ops::{apply, check};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

/// How deep refs reach: argument → document → table → entry (a change's `patch` adds one level).
const REF_DEPTH: usize = 3;

fn fail(entry: &str, error: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{entry}: {error}"))
}

fn reference(value: &Value) -> Option<usize> {
    let object = value.as_object()?;
    if object.len() != 1 {
        return None;
    }
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    object
        .get("$r")
        .and_then(Value::as_f64)
        .map(|index| index as usize)
}

#[wasm_bindgen]
extern "C" {
    /// The JavaScript side of a call (shared/design/ops-engine.ts `CallContext`): reads the documents that stay in
    /// JavaScript, entry by entry. Answers are `{"i": index, "v": value}` (`v` left out when the index was sent
    /// before), so an entry's identity is its index in the call's pool.
    pub type Lookup;
    #[wasm_bindgen(method)]
    fn entry(this: &Lookup, doc: u32, table: &str, key: &str) -> Option<String>;
    #[wasm_bindgen(method)]
    fn pages(this: &Lookup, doc: u32) -> String;
    #[wasm_bindgen(method)]
    fn size(this: &Lookup, doc: u32, table: &str) -> u32;
    #[wasm_bindgen(method)]
    fn identities(this: &Lookup, doc: u32, table: &str) -> String;
    /// Several entries at once: `keys` a JSON array, the answer a JSON array of answers (null: absent).
    #[wasm_bindgen(method)]
    fn entries(this: &Lookup, doc: u32, table: &str, keys: &str) -> String;
    /// Nodes with only some fields (`DocRead::projection`): `keys` and `fields` JSON arrays, the answer a JSON array of
    /// projections or null.
    #[wasm_bindgen(method)]
    fn projections(this: &Lookup, doc: u32, keys: &str, fields: &str) -> String;
}

/// One call: its pool (indexes chosen by JavaScript) and the lookup into the documents it did not send.
struct Call {
    pool: RefCell<Vec<Option<Value>>>,
    /// Pool index by the address of its object or array (the pool keeps them alive, so an address is never reused).
    pointers: RefCell<HashMap<usize, usize>>,
    lookup: Option<Lookup>,
}

impl Call {
    fn new(lookup: Option<Lookup>) -> Self {
        Call {
            pool: RefCell::new(Vec::new()),
            pointers: RefCell::new(HashMap::new()),
            lookup,
        }
    }

    fn set(&self, index: usize, value: Value) {
        let mut pointers = self.pointers.borrow_mut();
        if let Some(pointer) = pointer(&value) {
            pointers.insert(pointer, index);
        }
        let mut pool = self.pool.borrow_mut();
        if pool.len() <= index {
            pool.resize(index + 1, None);
        }
        // The value it replaces may be dropped now, and its address reused.
        if let Some(old) = pool[index]
            .as_ref()
            .and_then(pointer)
            .filter(|old| pointers.get(old) == Some(&index) && Some(*old) != pointer(&value))
        {
            pointers.remove(&old);
        }
        pool[index] = Some(value);
    }

    /// Pool items `[{i, v}]`, children first, each resolved against the ones before it.
    fn load(&self, items: Option<&Value>) {
        for item in items.and_then(Value::as_array).unwrap_or(&[]) {
            let index = item.get("i").and_then(Value::as_f64).unwrap_or(-1.0);
            let value = self.resolve(item.get("v").unwrap_or(&Value::Null), REF_DEPTH);
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            if index >= 0.0 {
                self.set(index as usize, value);
            }
        }
    }

    fn get(&self, index: usize) -> Option<Value> {
        self.pool.borrow().get(index).cloned().flatten()
    }

    /// `{"i", "v"?}` → the value, registered at its index.
    fn answer(&self, text: &str) -> Value {
        let Ok(parsed) = Value::from_json(text) else {
            return Value::Null;
        };
        self.register(&parsed)
    }

    /// A parsed answer `{"i", "v"?}` → the value, registered at its index. An answer with a `pool` (a transaction's
    /// lookups pool each entry's fields) loads it first, and the entry is one of its items.
    fn register(&self, parsed: &Value) -> Value {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        let index = parsed
            .get("i")
            .and_then(Value::as_f64)
            .map(|index| index as usize);
        if parsed.get("pool").is_some() {
            self.load(parsed.get("pool"));
            return index
                .and_then(|index| self.get(index))
                .unwrap_or(Value::Null);
        }
        match (index, parsed.get("v")) {
            (Some(index), Some(value)) => {
                self.set(index, value.clone());
                value.clone()
            }
            (Some(index), None) => self.get(index).unwrap_or(Value::Null),
            (None, value) => value.cloned().unwrap_or(Value::Null),
        }
    }

    fn resolve(&self, value: &Value, depth: usize) -> Value {
        self.resolved(value, depth).unwrap_or_else(|| value.clone())
    }

    /// The value with its refs replaced, None when it holds none (no copy then).
    fn resolved(&self, value: &Value, depth: usize) -> Option<Value> {
        if let Some(index) = reference(value) {
            return Some(self.get(index).unwrap_or(Value::Null));
        }
        if depth == 0 {
            return None;
        }
        match value {
            Value::Object(object) => {
                let mut changed: Vec<(usize, Value)> = Vec::new();
                for (at, item) in object.values().enumerate() {
                    if let Some(item) = self.resolved(item, depth - 1) {
                        changed.push((at, item));
                    }
                }
                if changed.is_empty() {
                    return None;
                }
                let mut out = Object::with_capacity(object.len());
                let mut next = changed.into_iter().peekable();
                for (at, (key, item)) in object.iter().enumerate() {
                    let item = if next.peek().is_some_and(|(index, _)| *index == at) {
                        next.next().map(|(_, item)| item).unwrap_or(Value::Null)
                    } else {
                        item.clone()
                    };
                    out.insert(key.clone(), item);
                }
                Some(Value::object(out))
            }
            Value::Array(items) => {
                let resolved: Vec<Option<Value>> = items
                    .iter()
                    .map(|item| self.resolved(item, depth - 1))
                    .collect();
                if resolved.iter().all(Option::is_none) {
                    return None;
                }
                Some(Value::array(
                    items
                        .iter()
                        .zip(resolved)
                        .map(|(item, resolved)| resolved.unwrap_or_else(|| item.clone()))
                        .collect(),
                ))
            }
            _ => None,
        }
    }
}

/// A document that stays in JavaScript, read through the call's lookup (each entry once).
struct LazyDoc<'a> {
    call: &'a Call,
    doc: u32,
    entries: RefCell<HashMap<(String, String), Option<Value>>>,
    projections: RefCell<HashMap<(usize, String), Option<Value>>>,
    pages: RefCell<Option<Value>>,
}

impl DocRead for LazyDoc<'_> {
    fn pages(&self) -> Value {
        if let Some(pages) = self.pages.borrow().as_ref() {
            return pages.clone();
        }
        let pages = self.call.lookup.as_ref().map_or(Value::Null, |lookup| {
            self.call.answer(&lookup.pages(self.doc))
        });
        *self.pages.borrow_mut() = Some(pages.clone());
        pages
    }

    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        let cache_key = (table.to_owned(), key.to_owned());
        if let Some(hit) = self.entries.borrow().get(&cache_key) {
            return hit.clone();
        }
        let value = self
            .call
            .lookup
            .as_ref()
            .and_then(|lookup| lookup.entry(self.doc, table, key))
            .map(|text| self.call.answer(&text));
        self.entries.borrow_mut().insert(cache_key, value.clone());
        value
    }

    fn size(&self, table: &str) -> usize {
        self.call
            .lookup
            .as_ref()
            .map_or(0, |lookup| lookup.size(self.doc, table) as usize)
    }

    fn prefetch(&self, table: &str, keys: &mut dyn Iterator<Item = &Str>) {
        let Some(lookup) = self.call.lookup.as_ref() else {
            return;
        };
        let wanted: Vec<Str> = {
            let cache = self.entries.borrow();
            keys.filter(|key| !cache.contains_key(&(table.to_owned(), key.to_string())))
                .cloned()
                .collect()
        };
        if wanted.is_empty() {
            return;
        }
        let list = Value::array(wanted.iter().cloned().map(Value::String).collect()).to_json();
        let answers =
            Value::from_json(&lookup.entries(self.doc, table, &list)).unwrap_or(Value::Null);
        let mut cache = self.entries.borrow_mut();
        for (key, answer) in wanted.iter().zip(answers.as_array().unwrap_or(&[])) {
            let value = if answer.is_null() {
                None
            } else {
                Some(self.call.register(answer))
            };
            cache.insert((table.to_owned(), key.to_string()), value);
        }
    }

    fn projection(&self, id: &str, fields: &'static [&'static str]) -> Option<Value> {
        if let Some(hit) = self
            .entries
            .borrow()
            .get(&("nodes".to_owned(), id.to_owned()))
        {
            return hit.clone();
        }
        let cache_key = (fields.as_ptr() as usize, id.to_owned());
        if let Some(hit) = self.projections.borrow().get(&cache_key) {
            return hit.clone();
        }
        let key = Str::from(id);
        self.prefetch_projection(&mut std::iter::once(&key), fields);
        self.projections.borrow().get(&cache_key).cloned().flatten()
    }

    fn prefetch_projection(
        &self,
        keys: &mut dyn Iterator<Item = &Str>,
        fields: &'static [&'static str],
    ) {
        let Some(lookup) = self.call.lookup.as_ref() else {
            return;
        };
        let set = fields.as_ptr() as usize;
        let wanted: Vec<Str> = {
            let known = self.projections.borrow();
            let mut seen = std::collections::HashSet::new();
            keys.filter(|key| {
                !known.contains_key(&(set, key.to_string())) && seen.insert(key.to_string())
            })
            .cloned()
            .collect()
        };
        if wanted.is_empty() {
            return;
        }
        let list = Value::array(wanted.iter().cloned().map(Value::String).collect()).to_json();
        let names = Value::array(fields.iter().map(|field| Value::str(field)).collect()).to_json();
        let answers =
            Value::from_json(&lookup.projections(self.doc, &list, &names)).unwrap_or(Value::Null);
        let mut known = self.projections.borrow_mut();
        for (key, answer) in wanted.iter().zip(answers.as_array().unwrap_or(&[])) {
            known.insert(
                (set, key.to_string()),
                (!answer.is_null()).then(|| answer.clone()),
            );
        }
    }

    fn identities(&self, table: &str) -> Vec<(Str, usize)> {
        let Some(lookup) = self.call.lookup.as_ref() else {
            return Vec::new();
        };
        let parsed = Value::from_json(&lookup.identities(self.doc, table)).unwrap_or(Value::Null);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        parsed
            .as_array()
            .unwrap_or(&[])
            .iter()
            .filter_map(|pair| {
                let pair = pair.as_array()?;
                Some((
                    Str::from(pair.first()?.as_str()?),
                    pair.get(1)?.as_f64()? as usize,
                ))
            })
            .collect()
    }
}

/// The pool and the arguments of a call: `{pool, args}`, documents left in JavaScript as `{"$doc": index}`.
fn decode<'a>(input: &str, call: &'a Call) -> Result<Vec<Arg<'a>>, String> {
    let parsed = Value::from_json(input).map_err(|error| error.to_string())?;
    call.load(parsed.get("pool"));
    let mut args = Vec::new();
    for arg in parsed.get("args").and_then(Value::as_array).unwrap_or(&[]) {
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        if let Some(doc) = arg
            .as_object()
            .filter(|object| object.len() == 1)
            .and_then(|object| object.get("$doc"))
            .and_then(Value::as_f64)
        {
            args.push(Arg::Lazy(LazyDoc {
                call,
                doc: doc as u32,
                entries: RefCell::new(HashMap::new()),
                projections: RefCell::new(HashMap::new()),
                pages: RefCell::new(None),
            }));
        } else {
            args.push(Arg::Value(call.resolve(arg, REF_DEPTH)));
        }
    }
    Ok(args)
}

/// An argument: a value that crossed, or a document read on demand.
enum Arg<'a> {
    Value(Value),
    Lazy(LazyDoc<'a>),
}

impl Arg<'_> {
    fn value(&self) -> Value {
        match self {
            Arg::Value(value) => value.clone(),
            Arg::Lazy(_) => Value::Null,
        }
    }

    fn doc(&self) -> &dyn DocRead {
        match self {
            Arg::Value(value) => value,
            Arg::Lazy(doc) => doc,
        }
    }
}

fn pointer(value: &Value) -> Option<usize> {
    match value {
        Value::Object(object) => Some(Arc::as_ptr(object).cast::<u8>() as usize),
        Value::Array(items) => Some(Arc::as_ptr(items).cast::<u8>() as usize),
        _ => None,
    }
}

/// The result as JSON, every pool value it holds written as its ref.
fn encode(result: &Value, call: &Call) -> String {
    let index = call.pointers.borrow();
    let mut out = String::new();
    write_with_refs(result, &index, REF_DEPTH + 1, &mut out);
    out
}

fn write_with_refs(value: &Value, index: &HashMap<usize, usize>, depth: usize, out: &mut String) {
    if let Some(at) = pointer(value).and_then(|pointer| index.get(&pointer)) {
        out.push_str("{\"$r\":");
        out.push_str(&at.to_string());
        out.push('}');
        return;
    }
    if depth == 0 {
        value.write_json(out);
        return;
    }
    match value {
        Value::Object(object) => {
            out.push('{');
            for (at, (key, item)) in object.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_string(out, key);
                out.push(':');
                write_with_refs(item, index, depth - 1, out);
            }
            out.push('}');
        }
        Value::Array(items) => {
            out.push('[');
            for (at, item) in items.iter().enumerate() {
                if at > 0 {
                    out.push(',');
                }
                write_with_refs(item, index, depth - 1, out);
            }
            out.push(']');
        }
        other => other.write_json(out),
    }
}

fn arg(args: &[Arg], at: usize) -> Value {
    args.get(at).map_or(Value::Null, Arg::value)
}

fn doc<'a>(args: &'a [Arg], at: usize) -> &'a dyn DocRead {
    const NULL: &Value = &Value::Null;
    args.get(at).map_or(NULL as &dyn DocRead, Arg::doc)
}

fn optional(value: Value) -> Option<Value> {
    (!value.is_null()).then_some(value)
}

fn record(entries: Vec<(&str, Value)>) -> Value {
    let mut out = Object::with_capacity(entries.len());
    for (key, value) in entries {
        out.insert(key, value);
    }
    Value::object(out)
}

/// `applyPatch` on a document that stays in JavaScript: the writes, `{pages?, tables: [[table, sets, removes]]}`, for
/// the caller to make into its copy of the tables (the only work `applyPatch` does; [`apply_patch`] does it on a
/// document held here).
fn patch_writes(patch: &Value) -> Value {
    let mut out = Object::new();
    if let Some(pages) = morfa_ops::patch::pages_of(patch) {
        out.insert("pages", pages.clone());
    }
    let mut tables = Vec::new();
    for table in morfa_ops::patch::TABLES {
        let Some(changes) =
            morfa_ops::patch::table_of(patch, table).filter(|changes| !changes.is_empty())
        else {
            continue;
        };
        let mut sets = Object::new();
        let mut removes = Vec::new();
        for (key, value) in changes.iter() {
            if value.is_null() {
                removes.push(Value::String(key.clone()));
            } else {
                sets.insert(key.clone(), value.clone());
            }
        }
        tables.push(Value::array(vec![
            Value::str(table),
            Value::object(sets),
            Value::array(removes),
        ]));
    }
    out.insert("tables", Value::array(tables));
    Value::object(out)
}

/// `placementFor(node, matrix, prefer?)` of a call's arguments.
fn placement_of(args: &[Arg]) -> morfa_ops::geometry::Placement {
    let matrix = arg(args, 1);
    let mut m = morfa_ops::geometry::IDENTITY;
    for (row, values) in matrix.as_array().unwrap_or(&[]).iter().take(2).enumerate() {
        for (column, value) in values.as_array().unwrap_or(&[]).iter().take(3).enumerate() {
            m[row][column] = value.as_f64().unwrap_or(f64::NAN);
        }
    }
    let prefer = arg(args, 2);
    let prefer = (!prefer.is_null()).then(|| {
        (
            prefer.get("flipX").is_some_and(Value::truthy),
            prefer.get("flipY").is_some_and(Value::truthy),
        )
    });
    morfa_ops::geometry::placement_for(&arg(args, 0), &m, prefer)
}

fn placement_value(placement: &morfa_ops::geometry::Placement) -> Value {
    record(vec![
        ("x", Value::Number(placement.x)),
        ("y", Value::Number(placement.y)),
        ("rotation", Value::Number(placement.rotation)),
        ("flipX", Value::Bool(placement.flip_x)),
        ("flipY", Value::Bool(placement.flip_y)),
    ])
}

/// One call of a ported function by its TypeScript name: `input` is `{pool, args}`, `lookup` reads the documents
/// passed as `{"$doc": index}`; the answer is the result with refs into the pool.
#[wasm_bindgen]
pub fn ops_call(name: &str, input: &str, lookup: Option<Lookup>) -> Result<String, JsError> {
    morfa_ops::value::take_lossy();
    let answer = ops_call_inner(name, input, lookup)?;
    if morfa_ops::value::take_lossy() {
        return Err(fail(&format!("ops_call({name})"), LOSSY));
    }
    Ok(answer)
}

/// The error of a call that read a lone UTF-16 surrogate (JavaScript strings may hold one, Rust's cannot): the switch
/// takes the `unsupported:` prefix for EngineUnsupported, so TypeScript answers and the call counts as a fallback.
const LOSSY: &str = "unsupported: a string holds a lone UTF-16 surrogate";

fn ops_call_inner(name: &str, input: &str, lookup: Option<Lookup>) -> Result<String, JsError> {
    let call = Call::new(lookup);
    let args = decode(input, &call).map_err(|error| fail(&format!("ops_call({name})"), error))?;
    let result = match name {
        "applyPatch" => match args.first() {
            Some(Arg::Lazy(_)) => patch_writes(&arg(&args, 1)),
            _ => apply_patch(&arg(&args, 0), &arg(&args, 1)),
        },
        "invertPatch" => invert_patch(doc(&args, 0), &arg(&args, 1)),
        "composePatches" => compose_patches(&arg(&args, 0), &arg(&args, 1)),
        "diffDocuments" => diff_documents(doc(&args, 0), doc(&args, 1)),
        "isEmptyPatch" => Value::Bool(is_empty_patch(&arg(&args, 0))),
        "mergeChange" => {
            let outcome = merge_change(
                &DocumentTarget(doc(&args, 0)),
                &arg(&args, 1),
                optional(arg(&args, 2)).as_ref(),
            );
            // `debug_fault("ops.mergeChange")`: the switch's own tests prove `both` sees a wrong answer.
            let adjusted = outcome.adjusted != crate::fault::is_on("ops.mergeChange");
            record(vec![
                ("patch", outcome.patch),
                ("adjusted", Value::Bool(adjusted)),
            ])
        }
        "mergeList" => {
            let ids = |value: Value| -> Vec<Str> {
                value
                    .as_array()
                    .unwrap_or(&[])
                    .iter()
                    .filter_map(|id| id.as_str().map(Str::from))
                    .collect()
            };
            let keep: std::collections::HashSet<Str> = ids(arg(&args, 3)).into_iter().collect();
            let list = merge_list(
                &ids(arg(&args, 0)),
                &ids(arg(&args, 1)),
                &ids(arg(&args, 2)),
                |id| keep.contains(id),
            );
            Value::array(list.into_iter().map(Value::String).collect())
        }
        "textEdit" => text_edit(
            arg(&args, 0).as_str().unwrap_or(""),
            arg(&args, 1).as_str().unwrap_or(""),
        ),
        "rebaseLocal" => {
            let rebased = rebase_local(
                doc(&args, 0),
                &arg(&args, 1),
                &arg(&args, 2),
                &arg(&args, 3),
                false,
            );
            record(vec![
                ("display", rebased.display),
                ("local", rebased.local),
                ("server", rebased.server),
            ])
        }
        "applyDocumentChange" => match args.first() {
            // A document left in JavaScript: the merge's answer; the caller applies `stored` (applyPatch).
            Some(Arg::Lazy(current)) => {
                // `{patch, before?, beforeTables?}` from its parts (each crossed on its own, entries pooled).
                let mut change = Object::new();
                change.insert("patch", arg(&args, 1));
                if arg(&args, 4).truthy() {
                    change.insert("before", arg(&args, 2));
                }
                if arg(&args, 5).truthy() {
                    change.insert("beforeTables", arg(&args, 3));
                }
                let change = Value::object(change);
                let (stored, adjusted) = apply::merge_document_change(current, &change);
                record(vec![
                    ("stored", stored),
                    ("adjusted", Value::Bool(adjusted)),
                ])
            }
            _ => {
                let applied = apply::apply_document_change(&arg(&args, 0), &arg(&args, 1));
                record(vec![
                    ("doc", applied.doc),
                    ("stored", applied.stored),
                    ("adjusted", Value::Bool(applied.adjusted)),
                ])
            }
        },
        "storedValues" => apply::stored_values(doc(&args, 0), &arg(&args, 1), &arg(&args, 2)),
        "checkPatchedDocument" => {
            #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
            let count = arg(&args, 3).as_f64().map(|count| count as usize);
            check::check_patched_document_json(doc(&args, 0), doc(&args, 1), &arg(&args, 2), count)
        }
        "boxOrigin" => {
            let centre = arg(&args, 0);
            let number = |value: Option<&Value>| value.and_then(Value::as_f64).unwrap_or(f64::NAN);
            let (x, y) = morfa_ops::geometry::box_origin(
                (number(centre.get("x")), number(centre.get("y"))),
                number(Some(&arg(&args, 1))),
                number(Some(&arg(&args, 2))),
                number(Some(&arg(&args, 3))),
            );
            record(vec![("x", Value::Number(x)), ("y", Value::Number(y))])
        }
        "placementFor" => placement_value(&placement_of(&args)),
        "placementChanges" => {
            let placement = arg(&args, 1);
            let flag = |key: &str| placement.get(key).is_some_and(Value::truthy);
            let number = |key: &str| {
                placement
                    .get(key)
                    .and_then(Value::as_f64)
                    .unwrap_or(f64::NAN)
            };
            let placement = morfa_ops::geometry::Placement {
                x: number("x"),
                y: number("y"),
                rotation: number("rotation"),
                flip_x: flag("flipX"),
                flip_y: flag("flipY"),
            };
            record(morfa_ops::transaction::placement_changes(
                &arg(&args, 0),
                &placement,
            ))
        }
        _ => return Err(fail("ops_call", format!("no function {name}"))),
    };
    Ok(encode(&result, &call))
}

/// A document held in wasm memory: the server's way of using the engine (one parse, then patches and merges by
/// id), and what the benches measure.
#[wasm_bindgen]
pub struct OpsDocument {
    /// The stored text, its node table read entry by entry as merges and patches need them.
    doc: morfa_ops::stored::StoredDocument,
}

#[wasm_bindgen]
impl OpsDocument {
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<OpsDocument, JsError> {
        Ok(OpsDocument {
            doc: morfa_ops::stored::StoredDocument::from_json(json)
                .map_err(|error| fail("OpsDocument.new", error))?,
        })
    }

    /// `applyPatch`, in place.
    #[wasm_bindgen(js_name = applyPatch)]
    pub fn apply_patch(&mut self, patch: &str) -> Result<(), JsError> {
        let patch =
            Value::from_json(patch).map_err(|error| fail("OpsDocument.applyPatch", error))?;
        self.doc.apply_patch(&patch);
        Ok(())
    }

    /// `mergeChange(documentTarget(doc), change, before)` → `{patch, adjusted}` as JSON.
    #[wasm_bindgen(js_name = mergeChange)]
    pub fn merge_change(&self, change: &str, before: Option<String>) -> Result<String, JsError> {
        let change =
            Value::from_json(change).map_err(|error| fail("OpsDocument.mergeChange", error))?;
        let before = before
            .map(|before| Value::from_json(&before))
            .transpose()
            .map_err(|error| fail("OpsDocument.mergeChange", error))?;
        let outcome = merge_change(&DocumentTarget(&self.doc), &change, before.as_ref());
        Ok(record(vec![
            ("patch", outcome.patch),
            ("adjusted", Value::Bool(outcome.adjusted)),
        ])
        .to_json())
    }

    /// `applyDocumentChange`, in place → `{stored, adjusted}` as JSON.
    #[wasm_bindgen(js_name = applyDocumentChange)]
    pub fn apply_document_change(&mut self, change: &str) -> Result<String, JsError> {
        let change = Value::from_json(change)
            .map_err(|error| fail("OpsDocument.applyDocumentChange", error))?;
        let (stored, adjusted) = apply::merge_document_change(&self.doc, &change);
        self.doc.apply_patch(&stored);
        Ok(record(vec![
            ("stored", stored),
            ("adjusted", Value::Bool(adjusted)),
        ])
        .to_json())
    }

    #[wasm_bindgen(js_name = toJson)]
    pub fn to_json(&self) -> String {
        self.doc.to_json()
    }

    #[wasm_bindgen(js_name = nodeCount)]
    pub fn node_count(&self) -> usize {
        self.doc.node_count()
    }
}

/// The base document of a transaction, read through the transaction's lookup (each entry once, so an entry keeps its
/// identity for the transaction's life).
struct TxDoc {
    call: std::rc::Rc<Call>,
    entries: RefCell<HashMap<(String, String), Option<Value>>>,
    pages: RefCell<Option<Value>>,
}

impl DocRead for TxDoc {
    fn pages(&self) -> Value {
        if let Some(pages) = self.pages.borrow().as_ref() {
            return pages.clone();
        }
        let pages = self
            .call
            .lookup
            .as_ref()
            .map_or(Value::Null, |lookup| self.call.answer(&lookup.pages(0)));
        *self.pages.borrow_mut() = Some(pages.clone());
        pages
    }

    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        let cache_key = (table.to_owned(), key.to_owned());
        if let Some(hit) = self.entries.borrow().get(&cache_key) {
            return hit.clone();
        }
        let value = self
            .call
            .lookup
            .as_ref()
            .and_then(|lookup| lookup.entry(0, table, key))
            .map(|text| self.call.answer(&text));
        self.entries.borrow_mut().insert(cache_key, value.clone());
        value
    }

    fn size(&self, table: &str) -> usize {
        self.call
            .lookup
            .as_ref()
            .map_or(0, |lookup| lookup.size(0, table) as usize)
    }

    fn partial_nodes(&self) -> bool {
        true
    }

    /// A projection whose object fields are pooled (`{pool, v: [node | null]}`), so a partial can name them.
    fn node_fields(&self, id: &str, fields: &[&str]) -> Option<Value> {
        let lookup = self.call.lookup.as_ref()?;
        let keys = Value::array(vec![Value::str(id)]).to_json();
        let names = Value::array(fields.iter().map(|field| Value::str(field)).collect()).to_json();
        let parsed = Value::from_json(&lookup.projections(0, &keys, &names)).ok()?;
        self.call.load(parsed.get("pool"));
        let node = parsed
            .get("v")
            .and_then(Value::as_array)
            .and_then(|list| list.first().cloned())
            .filter(|node| !node.is_null())?;
        Some(self.call.resolve(&node, 1))
    }

    fn identities(&self, table: &str) -> Vec<(Str, usize)> {
        let Some(lookup) = self.call.lookup.as_ref() else {
            return Vec::new();
        };
        let parsed = Value::from_json(&lookup.identities(0, table)).unwrap_or(Value::Null);
        #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
        parsed
            .as_array()
            .unwrap_or(&[])
            .iter()
            .filter_map(|pair| {
                let pair = pair.as_array()?;
                Some((
                    Str::from(pair.first()?.as_str()?),
                    pair.get(1)?.as_f64()? as usize,
                ))
            })
            .collect()
    }
}

/// A transaction (`beginTransaction`) whose base and draft stay in JavaScript: each operation answers the writes it
/// made ([`morfa_ops::transaction::Effect`]s, values that crossed written as their refs) for the harness's mirror of the
/// draft, and the commit has two steps around the TypeScript normalize (`stage`, then `finish`). One pool serves the
/// transaction's whole life, so an object keeps its identity from call to call.
#[wasm_bindgen]
pub struct OpsTransaction {
    call: std::rc::Rc<Call>,
    tx: morfa_ops::transaction::Transaction<TxDoc>,
}

/// `update` of `[id, partial, keys, base?]`: `keys` lists every key of the partial in order, those set to undefined
/// too; `base` is the base's node with the structure fields and those keys (null: absent), when the caller sends it
/// ahead (the node is not yet the transaction's).
fn update_from(
    tx: &mut morfa_ops::transaction::Transaction<TxDoc>,
    args: &[Value],
) -> Result<(), morfa_ops::TransactionError> {
    let at = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
    if let Some(base) = args.get(3).filter(|base| {
        base.as_object()
            .is_some_and(|hint| hint.contains_key("node"))
    }) {
        let names: Vec<String> = at(2)
            .as_array()
            .unwrap_or(&[])
            .iter()
            .filter_map(|key| key.as_str().map(str::to_owned))
            .collect();
        let mut fields: Vec<&str> = vec!["id", "type", "parentId", "children"];
        fields.extend(names.iter().map(String::as_str));
        let node = base.get("node").filter(|node| !node.is_null());
        tx.seed(&str_arg(&at(0)), &fields, node);
    }
    let partial = at(1);
    let fields: Vec<(Str, Option<Value>)> = at(2)
        .as_array()
        .unwrap_or(&[])
        .iter()
        .filter_map(|key| {
            key.as_str()
                .map(|key| (Str::from(key), partial.get(key).cloned()))
        })
        .collect();
    tx.update(&str_arg(&at(0)), &fields)
}

/// One queued update: the id, the partial's fields (`None`: undefined), the base fields sent ahead (`Some(None)`: the
/// base has no such node).
type QueuedUpdate = (Str, Vec<(Str, Option<Value>)>, Option<Option<Value>>);

/// The mirror's queued updates (shared/design/ops-transaction.ts `MirrorTransaction`: ones that cannot fail, with
/// plain values) in order, as fields separated by NUL: per update its id, the number of keys, each key with its value,
/// then `0` (no base fields), `1` (the base has no such node) or `2`, the number of base fields and each field with
/// its value. A value is a type letter and its text: `n` a number as `String(n)` writes it, `s` a string, `t`/`f`,
/// `l` null, `u` undefined. Answers `{codes, pending, effects, error?}`: a code per update (`update_code`), up to the
/// one that failed.
fn decode_updates(input: &str) -> Vec<QueuedUpdate> {
    let mut tokens = input.split('\0');
    let mut next = || tokens.next().unwrap_or("");
    let value = |token: &str| -> Option<Value> {
        let (kind, text) = token.split_at(token.len().min(1));
        match kind {
            "n" => Some(Value::Number(text.parse::<f64>().unwrap_or(f64::NAN))),
            "s" => Some(Value::String(Str::from(text))),
            "t" => Some(Value::Bool(true)),
            "f" => Some(Value::Bool(false)),
            "l" => Some(Value::Null),
            _ => None,
        }
    };
    let count = |token: &str| token.parse::<usize>().unwrap_or(0);
    let mut out = Vec::new();
    loop {
        let id = next();
        if id.is_empty() {
            break;
        }
        let id = Str::from(id);
        let keys = count(next());
        let mut fields = Vec::with_capacity(keys);
        for _ in 0..keys {
            let key = Str::from(next());
            fields.push((key, value(next())));
        }
        let base = match next() {
            "1" => Some(None),
            "2" => {
                let n = count(next());
                let mut node = Object::with_capacity(n);
                for _ in 0..n {
                    let field = Str::from(next());
                    if let Some(value) = value(next()) {
                        node.insert(field, value);
                    }
                }
                Some(Some(Value::object(node)))
            }
            _ => None,
        };
        out.push((id, fields, base));
    }
    out
}

impl OpsTransaction {
    /// The `updates` operation (see `decode_updates`).
    fn updates(&mut self, input: &str) -> String {
        let tx = &mut self.tx;
        let mut codes = Vec::new();
        let mut failed = None;
        for (id, fields, base) in decode_updates(input) {
            if let Some(node) = base {
                let mut known: Vec<&str> = vec!["id", "type", "parentId", "children"];
                known.extend(fields.iter().map(|(key, _)| &**key));
                tx.seed(&id, &known, node.as_ref());
            }
            let result = tx.update(&id, &fields);
            codes.push(update_code(&tx.take_effects()));
            if let Err(error) = result {
                failed = Some(error.0);
                break;
            }
        }
        let pending = Value::array(tx.pending().cloned().map(Value::String).collect());
        let mut fields = vec![
            ("effects", Value::array(Vec::new())),
            ("pending", pending),
            ("codes", Value::array(codes)),
        ];
        if let Some(error) = failed {
            fields.push(("error", Value::str(&error)));
        }
        record(fields).to_json()
    }
}

/// An update's writes in a number when they are the usual ones: 0 none; else 1, +2 the node was copied first, +4 it
/// was touched for the first time, and then every non-structural key of the partial set (or deleted when undefined),
/// in order, to the partial's own values. Anything else: the effects themselves.
fn update_code(effects: &[morfa_ops::Effect]) -> Value {
    use morfa_ops::Effect;
    let mut code = 0.0;
    for (at, effect) in effects.iter().enumerate() {
        match effect {
            Effect::Copy(_) if at == 0 => code += 2.0,
            Effect::Touch(_)
                if code < 4.0 && effects[..at].iter().all(|e| matches!(e, Effect::Copy(_))) =>
            {
                code += 4.0;
            }
            Effect::Set(..) | Effect::Delete(..) => {}
            _ => return Value::array(effects.iter().map(Effect::to_value).collect()),
        }
    }
    if effects.is_empty() {
        Value::Number(0.0)
    } else {
        Value::Number(code + 1.0)
    }
}

fn index_arg(value: &Value) -> Option<f64> {
    value.as_f64()
}

fn str_arg(value: &Value) -> String {
    match value {
        Value::String(text) => text.to_string(),
        other => other.to_json(),
    }
}

#[wasm_bindgen]
impl OpsTransaction {
    /// `lookup` reads the base document (its `doc` argument is always 0).
    #[wasm_bindgen(constructor)]
    pub fn new(lookup: Lookup) -> OpsTransaction {
        let call = std::rc::Rc::new(Call::new(Some(lookup)));
        let base = TxDoc {
            call: call.clone(),
            entries: RefCell::new(HashMap::new()),
            pages: RefCell::new(None),
        };
        let mut tx = morfa_ops::transaction::Transaction::new(base);
        tx.record_effects();
        OpsTransaction { call, tx }
    }

    /// One operation by the TypeScript method's name; `input` is `{pool, args}`. The answer: `{effects, pending,
    /// error?}` and the operation's own fields (`dirty` for `stage`, `pages` and `tables` for `finish`).
    pub fn op(&mut self, name: &str, input: &str) -> Result<String, JsError> {
        morfa_ops::value::take_lossy();
        let answer = self.op_inner(name, input)?;
        if morfa_ops::value::take_lossy() {
            return Err(fail(&format!("OpsTransaction.op({name})"), LOSSY));
        }
        Ok(answer)
    }
}

impl OpsTransaction {
    fn op_inner(&mut self, name: &str, input: &str) -> Result<String, JsError> {
        if name == "updates" {
            return Ok(self.updates(input));
        }
        let parsed = Value::from_json(input)
            .map_err(|error| fail(&format!("OpsTransaction.op({name})"), error))?;
        self.call.load(parsed.get("pool"));
        let args: Vec<Value> = parsed
            .get("args")
            .and_then(Value::as_array)
            .unwrap_or(&[])
            .iter()
            .map(|arg| self.call.resolve(arg, REF_DEPTH))
            .collect();
        let at = |index: usize| args.get(index).cloned().unwrap_or(Value::Null);
        let tx = &mut self.tx;
        let mut extra: Vec<(&str, Value)> = Vec::new();
        let outcome = match name {
            "update" => update_from(tx, &args),
            "create" => tx.create(&at(0), &str_arg(&at(1)), index_arg(&at(2))),
            "remove" => tx.remove(&str_arg(&at(0))),
            "move" => tx.move_node(
                &str_arg(&at(0)),
                &str_arg(&at(1)),
                index_arg(&at(2)),
                at(3).truthy(),
            ),
            "reorder" => tx.reorder(&str_arg(&at(0)), at(1).as_f64().unwrap_or(f64::NAN)),
            "setStyle" => tx.set_style(at(0)),
            "removeStyle" => tx.remove_style(&str_arg(&at(0))),
            "setImage" => tx.set_image(&str_arg(&at(0)), at(1)),
            "removeImage" => tx.remove_image(&str_arg(&at(0))),
            "setPages" => {
                let order: Vec<Str> = at(0)
                    .as_array()
                    .unwrap_or(&[])
                    .iter()
                    .map(|id| Str::from(str_arg(id)))
                    .collect();
                tx.set_pages(&order)
            }
            "addPage" => tx.add_page(&at(0), index_arg(&at(1))),
            "removePage" => tx.remove_page(&str_arg(&at(0))),
            "addLibraryPage" => tx.add_library_page(at(0)),
            "setVariableCollection" => tx.set_variable_collection(at(0)),
            "removeVariableCollection" => tx.remove_variable_collection(&str_arg(&at(0))),
            "setVariable" => tx.set_variable(at(0)),
            "removeVariable" => tx.remove_variable(&str_arg(&at(0))),
            "setVariableModes" => {
                let modes = at(1);
                tx.set_variable_modes(&str_arg(&at(0)), (!modes.is_null()).then_some(&modes))
            }
            "flush" => {
                tx.flush(&str_arg(&at(0)));
                Ok(())
            }
            "flushAll" => {
                tx.flush_all();
                Ok(())
            }
            "stage" => tx.stage().map(|dirty| {
                extra.push((
                    "dirty",
                    Value::array(dirty.into_iter().map(Value::String).collect()),
                ))
            }),
            "finish" => {
                // `[changed, statuses, replaced, based?]`: the ids normalization wrote; per touched node what the
                // committed document holds (0 absent, 1 the base's entry, 2 another); per table normalization
                // replaced, its keys in order with the same codes; per id normalization wrote, whether the base has
                // it (1 or 0: what the transaction would otherwise ask the caller id by id).
                if let Some(based) = at(3).as_object() {
                    let known = Value::object(Object::new());
                    for (id, has) in based.iter() {
                        tx.seed(id, &[], has.truthy().then_some(&known));
                    }
                }
                let changed: Vec<Str> = at(0)
                    .as_array()
                    .unwrap_or(&[])
                    .iter()
                    .map(|id| Str::from(str_arg(id)))
                    .collect();
                tx.normalized(changed.into_iter().map(|id| (id, None)));
                let code = |value: Option<&Value>| match value.and_then(Value::as_f64) {
                    Some(1.0) => morfa_ops::transaction::Entry::Base,
                    Some(2.0) => morfa_ops::transaction::Entry::Changed,
                    _ => morfa_ops::transaction::Entry::Absent,
                };
                let statuses = at(1);
                let replaced_value = at(2);
                let mut replaced: Vec<(usize, Vec<Str>)> = Vec::new();
                let mut replaced_status: HashMap<(usize, String), morfa_ops::transaction::Entry> =
                    HashMap::new();
                for (table, name) in morfa_ops::patch::TABLES.iter().enumerate() {
                    let Some(list) = replaced_value.get(name).and_then(Value::as_array) else {
                        continue;
                    };
                    let mut keys = Vec::new();
                    for pair in list {
                        let Some(pair) = pair.as_array() else {
                            continue;
                        };
                        let key = Str::from(pair.first().map(str_arg).unwrap_or_default());
                        replaced_status.insert((table, key.to_string()), code(pair.get(1)));
                        keys.push(key);
                    }
                    replaced.push((table, keys));
                }
                let keys = tx.patch_keys(
                    |table, key| {
                        if table == 0 {
                            return code(statuses.get(key));
                        }
                        if let Some(status) = replaced_status.get(&(table, key.to_owned())) {
                            return *status;
                        }
                        if replaced.iter().any(|(at, _)| *at == table) {
                            return morfa_ops::transaction::Entry::Absent;
                        }
                        tx.entry_status(table, key)
                    },
                    &replaced,
                );
                extra.push(("pages", Value::Bool(keys.pages)));
                let tables = keys
                    .tables
                    .into_iter()
                    .map(|(name, changes)| {
                        let list = changes
                            .into_iter()
                            .map(|(key, has)| {
                                Value::array(vec![Value::String(key), Value::Bool(has)])
                            })
                            .collect();
                        Value::array(vec![Value::str(name), Value::array(list)])
                    })
                    .collect();
                extra.push(("tables", Value::array(tables)));
                Ok(())
            }
            _ => {
                return Err(fail("OpsTransaction.op", format!("no operation {name}")));
            }
        };
        let effects = Value::array(
            self.tx
                .take_effects()
                .iter()
                .map(morfa_ops::transaction::Effect::to_value)
                .collect(),
        );
        let pending = Value::array(self.tx.pending().cloned().map(Value::String).collect());
        let mut fields = vec![("effects", effects), ("pending", pending)];
        if let Err(error) = outcome {
            fields.push(("error", Value::str(&error.0)));
        }
        fields.extend(extra);
        Ok(encode(&record(fields), &self.call))
    }
}

// ── The placement helpers through the scratch buffer (`*_into`: a few numbers each way, no JSON) ─────────────────

/// A node with only these fields (absent: `None`), as the placement helpers read it.
fn placement_node(fields: &[(&str, Option<f64>)], flags: &[(&str, bool)]) -> Value {
    let mut node = Object::new();
    for (key, value) in fields {
        if let Some(value) = value {
            node.insert(*key, Value::Number(*value));
        }
    }
    for (key, value) in flags {
        node.insert(*key, Value::Bool(*value));
    }
    Value::object(node)
}

/// `boxOrigin(centre, width, height, rotation)` → scratch `[x, y]`.
#[wasm_bindgen]
pub fn ops_box_origin_into(cx: f64, cy: f64, width: f64, height: f64, rotation: f64) {
    let (x, y) = morfa_ops::geometry::box_origin((cx, cy), width, height, rotation);
    scratch::write(&[x, y]);
}

/// `placementFor(node, matrix, prefer)` with the matrix `[[a, c, e], [b, d, f]]` and the flags to prefer (the node's
/// own when the caller has none) → scratch `[x, y, rotation, flipX, flipY]` (flags as 0 or 1).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn ops_placement_for_into(
    a: f64,
    c: f64,
    e: f64,
    b: f64,
    d: f64,
    f: f64,
    width: Option<f64>,
    height: Option<f64>,
    prefer_flip_x: bool,
    prefer_flip_y: bool,
) {
    let node = placement_node(&[("width", width), ("height", height)], &[]);
    let placement = morfa_ops::geometry::placement_for(
        &node,
        &[[a, c, e], [b, d, f]],
        Some((prefer_flip_x, prefer_flip_y)),
    );
    scratch::write(&[
        placement.x,
        placement.y,
        placement.rotation,
        f64::from(u8::from(placement.flip_x)),
        f64::from(u8::from(placement.flip_y)),
    ]);
}

/// `placementChanges(node, placement)` from the node's placement fields (absent: `None`) → scratch `[mask]`: which of
/// x (1), y (2), rotation (4), flipX (8), flipY (16) the change writes (the values are the placement's).
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn ops_placement_changes_into(
    x: Option<f64>,
    y: Option<f64>,
    rotation: Option<f64>,
    flip_x: bool,
    flip_y: bool,
    to_x: f64,
    to_y: f64,
    to_rotation: f64,
    to_flip_x: bool,
    to_flip_y: bool,
) {
    let node = placement_node(
        &[("x", x), ("y", y), ("rotation", rotation)],
        &[("flipX", flip_x), ("flipY", flip_y)],
    );
    let placement = morfa_ops::geometry::Placement {
        x: to_x,
        y: to_y,
        rotation: to_rotation,
        flip_x: to_flip_x,
        flip_y: to_flip_y,
    };
    let mut mask = 0.0;
    for (key, _) in morfa_ops::transaction::placement_changes(&node, &placement) {
        mask += match key {
            "x" => 1.0,
            "y" => 2.0,
            "rotation" => 4.0,
            "flipX" => 8.0,
            _ => 16.0,
        };
    }
    scratch::write(&[mask]);
}
