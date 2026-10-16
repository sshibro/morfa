//! A JSON value as JavaScript holds it, for the co-editing code that works field by field without knowing the
//! schema (shared/design/merge.ts walks `Object.keys` of nodes it never names).
//!
//! The model's typed structs (`morfa_model::types`) mirror types.ts for parity; the merge rules, however, are written
//! against open records: a field the change touched, a record merged one level deeper, an entry list merged by id.
//! [`Value`] keeps what those rules observe in JavaScript:
//!
//! - **Key order.** An [`Object`] keeps its keys in JavaScript's order: array-index keys (`"0"`, `"17"`) first in
//!   ascending order, then the others in insertion order. Replacing a key keeps its place; removing one keeps the
//!   order of the rest (`delete`).
//! - **Numbers** are doubles, compared with `===` (`NaN` differs from itself, `0` equals `-0`) and written as
//!   `JSON.stringify` writes them ([`morfa_model::js_number`]; non-finite numbers as `null`).
//! - **Identity.** Objects, arrays and strings are shared (`Arc`): a clone is a pointer copy, as assigning an object
//!   in JavaScript is, and [`Value::same`] answers an identical pair without walking it.
//!
//! JSON text is read with serde_json (`JSON.parse`'s numbers: `float_roundtrip`; a repeated key keeps the last
//! value at the first key's place) and written by [`Value::write_json`] byte for byte as `JSON.stringify` writes the
//! same value.

use foldhash::fast::FixedState;
use serde::de::{self, Deserialize, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{Serialize, SerializeMap, SerializeSeq, Serializer};
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

/// A shared string.
pub type Str = Arc<str>;

/// One JSON value. `undefined` has no place here: an absent key is absent (`Option<&Value>` where a JavaScript
/// read could give `undefined`).
#[derive(Clone, Default)]
pub enum Value {
    #[default]
    Null,
    Bool(bool),
    Number(f64),
    String(Str),
    Array(Arc<Vec<Value>>),
    Object(Arc<Object>),
}

/// Objects up to this many keys find a key by scanning (no index to build or allocate): a node has about forty.
const INDEXED: usize = 64;

type Index = HashMap<Str, usize, FixedState>;

/// A JavaScript object's own enumerable string keys and their values, in JavaScript's key order: the entries in
/// order, and for more than [`INDEXED`] of them a hash index, built on the first lookup (a copy starts without one).
#[derive(Default)]
pub struct Object {
    entries: Vec<(Str, Value)>,
    index: std::sync::OnceLock<Index>,
}

impl Clone for Object {
    fn clone(&self) -> Self {
        Object {
            entries: self.entries.clone(),
            index: std::sync::OnceLock::new(),
        }
    }
}

/// An array index key: the canonical decimal form of an integer in 0..2^32-1 (ECMAScript's "array index").
pub fn is_index_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 10 || !bytes.iter().all(u8::is_ascii_digit) {
        return false;
    }
    if bytes.len() > 1 && bytes[0] == b'0' {
        return false;
    }
    key.parse::<u64>().is_ok_and(|value| value < 4_294_967_295)
}

impl Object {
    pub fn new() -> Self {
        Object::default()
    }

    pub fn with_capacity(capacity: usize) -> Self {
        Object {
            entries: Vec::with_capacity(capacity),
            index: std::sync::OnceLock::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    fn position(&self, key: &str) -> Option<usize> {
        if self.entries.len() <= INDEXED {
            // The same shared string first (keys of one parse are interned), then length and first byte before
            // comparing the text: most keys differ there.
            let bytes = key.as_bytes();
            return self.entries.iter().position(|(existing, _)| {
                std::ptr::eq(existing.as_ptr(), bytes.as_ptr()) && existing.len() == bytes.len()
                    || (existing.len() == bytes.len()
                        && existing.as_bytes().first() == bytes.first()
                        && existing.as_bytes() == bytes)
            });
        }
        let index = self.index.get_or_init(|| {
            let mut index =
                Index::with_capacity_and_hasher(self.entries.len(), FixedState::default());
            for (at, (key, _)) in self.entries.iter().enumerate() {
                index.insert(key.clone(), at);
            }
            index
        });
        index.get(key).copied()
    }

    /// The index no longer describes the entries: it is built again on the next lookup.
    fn reindex(&mut self) {
        self.index = std::sync::OnceLock::new();
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.position(key).map(|at| &self.entries[at].1)
    }

    /// `get` when the key is likely at `at` (two versions of one entry keep their keys in the same order): that
    /// place is tried first.
    pub fn get_hinted(&self, key: &str, at: usize) -> Option<&Value> {
        if let Some((existing, value)) = self.entries.get(at)
            && **existing == *key
        {
            return Some(value);
        }
        self.get(key)
    }

    pub fn get_mut(&mut self, key: &str) -> Option<&mut Value> {
        self.position(key).map(|at| &mut self.entries[at].1)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.position(key).is_some()
    }

    /// `object[key] = value`: an existing key keeps its place, a new one goes where JavaScript puts it.
    pub fn insert(&mut self, key: impl Into<Str> + AsRef<str>, value: Value) {
        if let Some(at) = self.position(key.as_ref()) {
            self.entries[at].1 = value;
            return;
        }
        let key: Str = key.into();
        if is_index_key(&key) {
            // Index keys come first, ascending: count the index keys below this one.
            let number: u64 = key.parse().unwrap_or(0);
            let at = self
                .entries
                .iter()
                .take_while(|(existing, _)| {
                    is_index_key(existing) && existing.parse::<u64>().unwrap_or(0) < number
                })
                .count();
            if at < self.entries.len() {
                self.entries.insert(at, (key, value));
                self.reindex();
                return;
            }
        }
        self.entries.push((key.clone(), value));
        if let Some(index) = self.index.get_mut() {
            index.insert(key, self.entries.len() - 1);
        }
    }

    /// `delete object[key]`: the other keys keep their order.
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        let at = self.position(key)?;
        let (_, value) = self.entries.remove(at);
        if let Some(index) = self.index.get_mut() {
            index.remove(key);
            for (later, (key, _)) in self.entries.iter().enumerate().skip(at) {
                if let Some(slot) = index.get_mut(&**key) {
                    *slot = later;
                }
            }
        }
        Some(value)
    }

    /// `delete object[key]` for each of `keys`, in one pass (a removal shifts the entries after it; many of them one
    /// by one would be quadratic on a large table).
    pub fn remove_all(&mut self, keys: &std::collections::HashSet<&str, FixedState>) {
        let before = self.entries.len();
        self.entries.retain(|(key, _)| !keys.contains(&**key));
        if self.entries.len() != before {
            self.reindex();
        }
    }

    pub fn keys(&self) -> impl ExactSizeIterator<Item = &Str> + DoubleEndedIterator {
        self.entries.iter().map(|(key, _)| key)
    }

    pub fn values(&self) -> impl ExactSizeIterator<Item = &Value> + DoubleEndedIterator {
        self.entries.iter().map(|(_, value)| value)
    }

    pub fn iter(&self) -> impl ExactSizeIterator<Item = (&Str, &Value)> + DoubleEndedIterator {
        self.entries.iter().map(|(key, value)| (key, value))
    }

    /// The key as stored (a shared string), when present.
    pub fn key(&self, key: &str) -> Option<&Str> {
        self.position(key).map(|at| &self.entries[at].0)
    }
}

impl fmt::Debug for Object {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.debug_map().entries(self.iter()).finish()
    }
}

impl FromIterator<(Str, Value)> for Object {
    fn from_iter<I: IntoIterator<Item = (Str, Value)>>(items: I) -> Self {
        let mut object = Object::new();
        for (key, value) in items {
            object.insert(key, value);
        }
        object
    }
}

impl fmt::Debug for Value {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Value::Null => formatter.write_str("null"),
            Value::Bool(value) => write!(formatter, "{value}"),
            Value::Number(value) => formatter.write_str(&morfa_model::js_number(*value)),
            Value::String(value) => write!(formatter, "{:?}", &**value),
            Value::Array(items) => formatter.debug_list().entries(items.iter()).finish(),
            Value::Object(object) => object.fmt(formatter),
        }
    }
}

/// `===` on numbers.
#[allow(clippy::float_cmp)]
fn same_number(a: f64, b: f64) -> bool {
    a == b
}

impl Value {
    pub fn str(value: &str) -> Value {
        Value::String(value.into())
    }

    pub fn object(object: Object) -> Value {
        Value::Object(Arc::new(object))
    }

    pub fn array(items: Vec<Value>) -> Value {
        Value::Array(Arc::new(items))
    }

    pub fn as_object(&self) -> Option<&Object> {
        match self {
            Value::Object(object) => Some(object),
            _ => None,
        }
    }

    /// The object, copied first when someone else holds it too.
    pub fn as_object_mut(&mut self) -> Option<&mut Object> {
        match self {
            Value::Object(object) => Some(Arc::make_mut(object)),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Value]> {
        match self {
            Value::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Value::String(value) => Some(value),
            _ => None,
        }
    }

    pub fn as_f64(&self) -> Option<f64> {
        match self {
            Value::Number(value) => Some(*value),
            _ => None,
        }
    }

    pub fn is_null(&self) -> bool {
        matches!(self, Value::Null)
    }

    /// JavaScript truthiness.
    pub fn truthy(&self) -> bool {
        match self {
            Value::Null => false,
            Value::Bool(value) => *value,
            Value::Number(value) => *value != 0.0 && !value.is_nan(),
            Value::String(value) => !value.is_empty(),
            Value::Array(_) | Value::Object(_) => true,
        }
    }

    /// `object[key]` (None when this is not an object or has no such key).
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.as_object().and_then(|object| object.get(key))
    }

    /// `a === b`: primitives by value, objects and arrays by identity.
    pub fn identical(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Null, Value::Null) => true,
            (Value::Bool(a), Value::Bool(b)) => a == b,
            (Value::Number(a), Value::Number(b)) => same_number(*a, *b),
            (Value::String(a), Value::String(b)) => Arc::ptr_eq(a, b) || a == b,
            (Value::Array(a), Value::Array(b)) => Arc::ptr_eq(a, b),
            (Value::Object(a), Value::Object(b)) => Arc::ptr_eq(a, b),
            _ => false,
        }
    }

    /// `sameValue` (shared/design/text-edit.ts): structural equality of JSON-like values; keys are compared as a set.
    pub fn same(&self, other: &Value) -> bool {
        match (self, other) {
            (Value::Array(a), Value::Array(b)) => {
                Arc::ptr_eq(a, b)
                    || (a.len() == b.len() && a.iter().zip(b.iter()).all(|(x, y)| x.same(y)))
            }
            (Value::Object(a), Value::Object(b)) => {
                Arc::ptr_eq(a, b)
                    || (a.len() == b.len()
                        && a.iter()
                            .enumerate()
                            .all(|(at, (key, x))| b.get_hinted(key, at).is_some_and(|y| x.same(y))))
            }
            _ => self.identical(other),
        }
    }

    /// The JSON text `JSON.stringify` writes for this value.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }

    pub fn write_json(&self, out: &mut String) {
        match self {
            Value::Null => out.push_str("null"),
            Value::Bool(true) => out.push_str("true"),
            Value::Bool(false) => out.push_str("false"),
            Value::Number(value) => write_number(out, *value),
            Value::String(value) => write_string(out, value),
            Value::Array(items) => {
                out.push('[');
                for (at, item) in items.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    item.write_json(out);
                }
                out.push(']');
            }
            Value::Object(object) => {
                out.push('{');
                for (at, (key, value)) in object.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    write_string(out, key);
                    out.push(':');
                    value.write_json(out);
                }
                out.push('}');
            }
        }
    }

    /// Reads JSON text as `JSON.parse` does. A lone UTF-16 surrogate (`"\ud800"`, which `JSON.parse` keeps and a Rust
    /// string cannot hold) reads as U+FFFD, as the model's reader does (`morfa_model::json`).
    pub fn from_json(text: &str) -> Result<Value, serde_json::Error> {
        match serde_json::from_str(text) {
            Ok(value) => Ok(value),
            Err(error) => match repair_lone_surrogates(text) {
                Some(repaired) => {
                    note_lossy();
                    serde_json::from_str(&repaired)
                }
                None => Err(error),
            },
        }
    }

    /// Any serializable value of the model (a typed `SceneNode`, a `DocumentPatch`) as a [`Value`].
    pub fn from_serialize<T: Serialize + ?Sized>(value: &T) -> Result<Value, serde_json::Error> {
        // The model writes JSON exactly as types.ts holds it; reading that text back is the plainest exact route.
        let text = serde_json::to_string(value)?;
        Value::from_json(&text)
    }

    /// The value as a model type (`SceneNode`, `DesignDocument`...), read by the model's own reader.
    pub fn to_model<T: de::DeserializeOwned>(&self) -> Result<T, serde_json::Error> {
        serde_json::from_str(&self.to_json())
    }
}

impl PartialEq for Value {
    /// Structural equality ([`Value::same`]).
    fn eq(&self, other: &Value) -> bool {
        self.same(other)
    }
}

impl From<&str> for Value {
    fn from(value: &str) -> Value {
        Value::String(value.into())
    }
}

impl From<Str> for Value {
    fn from(value: Str) -> Value {
        Value::String(value)
    }
}

impl From<f64> for Value {
    fn from(value: f64) -> Value {
        Value::Number(value)
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Value {
        Value::Bool(value)
    }
}

impl From<Object> for Value {
    fn from(object: Object) -> Value {
        Value::object(object)
    }
}

impl From<Vec<Value>> for Value {
    fn from(items: Vec<Value>) -> Value {
        Value::array(items)
    }
}

fn write_number(out: &mut String, value: f64) {
    if value.is_finite() {
        // Integers are the common case: no formatter needed.
        if value.fract() == 0.0 && value.abs() < 1e15 {
            if value == 0.0 {
                out.push('0');
            } else {
                use std::fmt::Write;
                // Exact: |value| < 1e15 < 2^63.
                #[allow(clippy::cast_possible_truncation)]
                let _ = write!(out, "{}", value as i64);
            }
        } else {
            out.push_str(&morfa_model::js_number(value));
        }
    } else {
        out.push_str("null");
    }
}

/// `JSON.stringify` of a string: `"` and `\` escaped, `\b \f \n \r \t` short, other controls as `\u00xx`.
pub fn write_string(out: &mut String, value: &str) {
    out.push('"');
    let bytes = value.as_bytes();
    let mut start = 0;
    for (at, &byte) in bytes.iter().enumerate() {
        let escape: &str = match byte {
            b'"' => "\\\"",
            b'\\' => "\\\\",
            b'\n' => "\\n",
            b'\r' => "\\r",
            b'\t' => "\\t",
            0x08 => "\\b",
            0x0c => "\\f",
            0..=0x1f => "",
            _ => continue,
        };
        out.push_str(&value[start..at]);
        if escape.is_empty() {
            use std::fmt::Write;
            let _ = write!(out, "\\u{byte:04x}");
        } else {
            out.push_str(escape);
        }
        start = at + 1;
    }
    out.push_str(&value[start..]);
    out.push('"');
}

// ── serde ────────────────────────────────────────────────────────────────────────────────────────

/// Short strings read in one parse, shared: a document repeats its keys (`"id"`, `"type"`, `"fills"`...) and short
/// values (`"RECTANGLE"`, `"NORMAL"`) tens of thousands of times, and one allocation each was most of a parse.
#[derive(Default)]
struct Interner {
    strings: std::collections::HashSet<Str, FixedState>,
    /// The entries of the objects being read, innermost last: an object is built at its exact size when it ends
    /// (JSON gives no length up front, and growing each map and its index step by step was most of a parse).
    entries: Vec<(Str, Value)>,
    /// The same for arrays.
    items: Vec<Value>,
    /// Scratch for the repeated-key check of an object being built.
    pointers: Vec<usize>,
}

/// Strings longer than this are not looked up (ids and texts rarely repeat).
const INTERN_MAX: usize = 24;

impl Interner {
    fn get(&mut self, value: &str) -> Str {
        if value.len() > INTERN_MAX {
            return value.into();
        }
        if let Some(known) = self.strings.get(value) {
            return known.clone();
        }
        let shared: Str = value.into();
        self.strings.insert(shared.clone());
        shared
    }
}

/// Reads one value, sharing short strings through the parse's interner.
struct Seed<'a>(&'a std::cell::RefCell<Interner>);

impl<'de> de::DeserializeSeed<'de> for Seed<'_> {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        deserializer.deserialize_any(ValueVisitor(self.0))
    }
}

impl<'de> Deserialize<'de> for Value {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
        let interner = std::cell::RefCell::new(Interner::default());
        de::DeserializeSeed::deserialize(Seed(&interner), deserializer)
    }
}

struct ValueVisitor<'a>(&'a std::cell::RefCell<Interner>);

impl<'de> Visitor<'de> for ValueVisitor<'_> {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_unit<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        de::DeserializeSeed::deserialize(Seed(self.0), deserializer)
    }

    fn visit_bool<E>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    #[allow(clippy::cast_precision_loss)]
    fn visit_i64<E>(self, value: i64) -> Result<Value, E> {
        Ok(Value::Number(value as f64))
    }

    #[allow(clippy::cast_precision_loss)]
    fn visit_u64<E>(self, value: u64) -> Result<Value, E> {
        Ok(Value::Number(value as f64))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Value, E> {
        Ok(Value::Number(value))
    }

    fn visit_str<E>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(self.0.borrow_mut().get(value)))
    }

    fn visit_string<E>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(self.0.borrow_mut().get(&value)))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let start = self.0.borrow().items.len();
        while let Some(item) = seq.next_element_seed(Seed(self.0))? {
            self.0.borrow_mut().items.push(item);
        }
        let items: Vec<Value> = self.0.borrow_mut().items.drain(start..).collect();
        if items.is_empty() {
            return Ok(Value::Array(empty_array()));
        }
        Ok(Value::array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let start = self.0.borrow().entries.len();
        while let Some(key) = map.next_key_seed(KeySeed(self.0))? {
            let value = map.next_value_seed(Seed(self.0))?;
            self.0.borrow_mut().entries.push((key, value));
        }
        let mut interner = self.0.borrow_mut();
        if interner.entries.len() == start {
            return Ok(Value::Object(empty_object()));
        }
        // The common case: no repeated key and no array-index key, so the entries are the object in order.
        let plain = {
            let interner = &mut *interner;
            let entries = &interner.entries[start..];
            if entries.iter().any(|(key, _)| {
                key.len() > INTERN_MAX
                    || key.as_bytes().first().is_some_and(u8::is_ascii_digit) && is_index_key(key)
            }) {
                // A long key (not interned) or an index key: the careful path.
                false
            } else {
                // Interned keys: the same text is the same pointer, so sorted pointers show a repeat side by side.
                let pointers = &mut interner.pointers;
                pointers.clear();
                pointers.extend(entries.iter().map(|(key, _)| key.as_ptr() as usize));
                pointers.sort_unstable();
                pointers.windows(2).all(|pair| pair[0] != pair[1])
            }
        };
        let mut object = Object::with_capacity(interner.entries.len() - start);
        if plain {
            object.entries.extend(interner.entries.drain(start..));
        } else {
            for (key, value) in interner.entries.drain(start..) {
                object.insert(key, value);
            }
        }
        Ok(Value::object(object))
    }
}

/// One shared `[]` for every empty array a parse reads (an allocation each was a large part of a document).
fn empty_array() -> Arc<Vec<Value>> {
    static EMPTY: std::sync::OnceLock<Arc<Vec<Value>>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| Arc::new(Vec::new())).clone()
}

/// One shared `{}` for every empty object a parse reads.
fn empty_object() -> Arc<Object> {
    static EMPTY: std::sync::OnceLock<Arc<Object>> = std::sync::OnceLock::new();
    EMPTY.get_or_init(|| Arc::new(Object::new())).clone()
}

/// A map key, shared through the interner.
struct KeySeed<'a>(&'a std::cell::RefCell<Interner>);

impl<'de> de::DeserializeSeed<'de> for KeySeed<'_> {
    type Value = Str;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Str, D::Error> {
        struct KeyVisitor<'a>(&'a std::cell::RefCell<Interner>);
        impl Visitor<'_> for KeyVisitor<'_> {
            type Value = Str;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a string key")
            }
            fn visit_str<E>(self, value: &str) -> Result<Str, E> {
                Ok(self.0.borrow_mut().get(value))
            }
        }
        deserializer.deserialize_str(KeyVisitor(self.0))
    }
}

impl Serialize for Value {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Value::Null => serializer.serialize_unit(),
            Value::Bool(value) => serializer.serialize_bool(*value),
            Value::Number(value) if value.is_finite() => serializer.serialize_f64(*value),
            Value::Number(_) => serializer.serialize_unit(),
            Value::String(value) => serializer.serialize_str(value),
            Value::Array(items) => {
                let mut seq = serializer.serialize_seq(Some(items.len()))?;
                for item in items.iter() {
                    seq.serialize_element(item)?;
                }
                seq.end()
            }
            Value::Object(object) => {
                let mut map = serializer.serialize_map(Some(object.len()))?;
                for (key, value) in object.iter() {
                    map.serialize_entry(&**key, value)?;
                }
                map.end()
            }
        }
    }
}

/// `text` with every `\uXXXX` escape of a lone surrogate replaced by `\ufffd`; None when it has none.
fn repair_lone_surrogates(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let hex = |at: usize| -> Option<u16> {
        let digits = bytes.get(at..at + 4)?;
        u16::from_str_radix(std::str::from_utf8(digits).ok()?, 16).ok()
    };
    let escape_at = |at: usize| -> Option<u16> {
        if bytes.get(at) == Some(&b'\\') && bytes.get(at + 1) == Some(&b'u') {
            hex(at + 2)
        } else {
            None
        }
    };
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    let mut start = 0;
    let mut at = 0;
    while at < bytes.len() {
        if bytes[at] != b'\\' {
            at += 1;
            continue;
        }
        let Some(unit) = escape_at(at) else {
            at += 2;
            continue;
        };
        let lone = match unit {
            0xD800..=0xDBFF => {
                if escape_at(at + 6).is_some_and(|next| (0xDC00..=0xDFFF).contains(&next)) {
                    at += 12;
                    continue;
                }
                true
            }
            0xDC00..=0xDFFF => true,
            _ => false,
        };
        if lone {
            out.push_str(&text[start..at]);
            out.push_str("\\ufffd");
            changed = true;
            start = at + 6;
        }
        at += 6;
    }
    if !changed {
        return None;
    }
    out.push_str(&text[start..]);
    Some(out)
}

// ── UTF-16 ───────────────────────────────────────────────────────────────────────────────────────

/// A string's UTF-16 code units (JavaScript's `length`, `charCodeAt`, `slice`).
pub fn utf16(value: &str) -> Vec<u16> {
    value.encode_utf16().collect()
}

/// Code units back to a string. A lone surrogate (JavaScript keeps them) becomes U+FFFD.
pub fn from_utf16(units: &[u16]) -> String {
    String::from_utf16(units).unwrap_or_else(|_| {
        note_lossy();
        String::from_utf16_lossy(units)
    })
}

thread_local! {
    static LOSSY: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

fn note_lossy() {
    LOSSY.with(|lossy| lossy.set(true));
}

/// True when a lone surrogate was read as U+FFFD (by [`Value::from_json`] or [`from_utf16`]) since the last call:
/// the answer may then differ from JavaScript's, which keeps them. Clears the mark.
pub fn take_lossy() -> bool {
    LOSSY.with(|lossy| lossy.replace(false))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_follow_javascript_order() {
        let value = Value::from_json(r#"{"b":1,"2":2,"a":3,"1":4,"10":5,"01":6}"#).unwrap();
        assert_eq!(
            value.to_json(),
            r#"{"1":4,"2":2,"10":5,"b":1,"a":3,"01":6}"#
        );
        let value = Value::from_json(r#"{"a":1,"b":2,"a":3}"#).unwrap();
        assert_eq!(value.to_json(), r#"{"a":3,"b":2}"#);
    }

    #[test]
    fn writes_what_json_stringify_writes() {
        let value =
            Value::from_json(r#"[1.0,-0,1e21,0.1,"\u0001\n\"\\é/",1e-7,123456789012345678]"#)
                .unwrap();
        assert_eq!(
            value.to_json(),
            r#"[1,0,1e+21,0.1,"\u0001\n\"\\é/",1e-7,123456789012345680]"#
        );
    }

    #[test]
    fn lone_surrogates_read_as_replacement_characters() {
        let value = Value::from_json(r#"["\ud83d","\ud83d\ude00","\\ud83d","x\ude00y"]"#).unwrap();
        assert_eq!(
            value.to_json(),
            "[\"\u{fffd}\",\"😀\",\"\\\\ud83d\",\"x\u{fffd}y\"]"
        );
    }

    #[test]
    fn same_is_structural_and_ignores_key_order() {
        let a = Value::from_json(r#"{"x":[1,{"y":2,"z":3}]}"#).unwrap();
        let b = Value::from_json(r#"{"x":[1,{"z":3,"y":2}]}"#).unwrap();
        assert!(a.same(&b));
        assert!(!a.identical(&b));
        assert!(!Value::Number(f64::NAN).same(&Value::Number(f64::NAN)));
        assert!(Value::Number(0.0).same(&Value::Number(-0.0)));
    }
}
