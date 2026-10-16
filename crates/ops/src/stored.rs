//! A document put together from its stored text without reading all of it: the node table's entries stay slices of
//! the text until something reads or replaces them, and a slice is written back as it is. What a server does with a
//! file it opens (document-store.ts: the stored text, then the changes waiting on it, then merges that read a few
//! dozen nodes) costs a scan of the text instead of building twenty thousand nodes, and holds the text instead of a
//! parsed copy beside it.
//!
//! Exactness: a slice is kept only when it is exactly what `JSON.stringify` writes for the value `JSON.parse` reads
//! from it (no whitespace, numbers in JavaScript's shortest form, strings escaped as `JSON.stringify` escapes them,
//! no array-index keys, no repeated keys); any other entry is read at once. So [`StoredDocument::to_json`] is byte
//! for byte `JSON.stringify(applyPatch(JSON.parse(text), …))`, and every entry reads as `JSON.parse` reads it. A
//! text whose outer shape the scan does not expect (whitespace between the top-level keys, an index-like node id)
//! is read whole.

use crate::doc::{DocRead, identity};
use crate::patch::{apply_patch_mut, table_of};
use crate::value::{Object, Str, Value, is_index_key};
use foldhash::fast::FixedState;
use indexmap::IndexMap;
use std::collections::HashSet;
use std::ops::Range;
use std::sync::{Arc, OnceLock};

/// One entry of the node table.
enum Slot {
    /// A slice of the text, read on first use (then always the same value: identity is kept).
    Raw(Range<usize>, OnceLock<Value>),
    Value(Value),
    /// Removed; the key keeps its place until it is written again (then it goes last, as `delete` then `=` does).
    Removed,
}

pub struct StoredDocument {
    text: Arc<str>,
    /// The document without its nodes (`nodes` holds null in its place, for the key order).
    head: Value,
    nodes: IndexMap<Str, Slot, FixedState>,
    /// Whether `nodes` is an object (held in `nodes`), not some other value kept in `head`.
    table: bool,
    removed: usize,
}

impl StoredDocument {
    /// `JSON.parse(text)`, the node table left as slices where that is exact.
    pub fn from_json(text: &str) -> Result<StoredDocument, serde_json::Error> {
        let text: Arc<str> = Arc::from(text);
        if let Some(document) = scan(&text) {
            return Ok(document);
        }
        StoredDocument::from_value(Value::from_json(&text)?)
    }

    /// A document already read.
    pub fn from_value(value: Value) -> Result<StoredDocument, serde_json::Error> {
        let mut head = value.as_object().cloned().unwrap_or_default();
        let mut nodes = IndexMap::with_hasher(FixedState::default());
        let mut held = false;
        if let Some(Value::Object(table)) = head.get("nodes") {
            for (key, node) in table.iter() {
                nodes.insert(key.clone(), Slot::Value(node.clone()));
            }
            head.insert("nodes", Value::Null);
            held = true;
        }
        Ok(StoredDocument {
            text: Arc::from(""),
            head: Value::object(head),
            nodes,
            table: held,
            removed: 0,
        })
    }

    fn has_nodes(&self) -> bool {
        self.table
    }

    fn node(&self, key: &str) -> Option<Value> {
        match self.nodes.get(key)? {
            Slot::Raw(range, value) => Some(
                value
                    .get_or_init(|| read(&self.text[range.clone()]))
                    .clone(),
            ),
            Slot::Value(value) => Some(value.clone()),
            Slot::Removed => None,
        }
    }

    /// The number of nodes.
    pub fn node_count(&self) -> usize {
        self.nodes.len() - self.removed
    }

    /// `applyPatch`, in place.
    pub fn apply_patch(&mut self, patch: &Value) {
        if let Some(changes) = table_of(patch, "nodes").filter(|changes| !changes.is_empty()) {
            if !self.table {
                // `copyTable(doc.nodes ?? {})`: the table appears (an object `nodes` is never not held).
                if let Some(head) = self.head.as_object_mut() {
                    head.insert("nodes", Value::Null);
                }
                self.table = true;
            }
            for (key, value) in changes.iter() {
                if value.is_null() {
                    if let Some(slot) = self.nodes.get_mut(key)
                        && !matches!(slot, Slot::Removed)
                    {
                        *slot = Slot::Removed;
                        self.removed += 1;
                    }
                    continue;
                }
                match self.nodes.get_mut(key) {
                    Some(Slot::Removed) => {
                        self.nodes.shift_remove(key);
                        self.removed -= 1;
                        self.nodes.insert(key.clone(), Slot::Value(value.clone()));
                    }
                    Some(slot) => *slot = Slot::Value(value.clone()),
                    None => {
                        self.nodes.insert(key.clone(), Slot::Value(value.clone()));
                    }
                }
            }
            // Many removals: the tombstones go (keys never written again keep their order either way).
            if self.removed > 1024 && self.removed * 4 > self.nodes.len() {
                self.nodes.retain(|_, slot| !matches!(slot, Slot::Removed));
                self.removed = 0;
            }
        }
        let mut rest = patch.as_object().cloned().unwrap_or_default();
        rest.remove("nodes");
        if !rest.is_empty() {
            apply_patch_mut(&mut self.head, &Value::object(rest));
        }
    }

    /// `JSON.stringify` of the document.
    pub fn to_json(&self) -> String {
        let mut out = String::with_capacity(self.text.len() + 1024);
        let Some(head) = self.head.as_object() else {
            self.head.write_json(&mut out);
            return out;
        };
        out.push('{');
        let mut first = true;
        for (key, value) in head.iter() {
            if !first {
                out.push(',');
            }
            first = false;
            crate::value::write_string(&mut out, key);
            out.push(':');
            if &**key == "nodes" && self.table {
                self.write_nodes(&mut out);
            } else {
                value.write_json(&mut out);
            }
        }
        out.push('}');
        out
    }

    fn write_nodes(&self, out: &mut String) {
        out.push('{');
        let mut first = true;
        for (key, slot) in &self.nodes {
            let write = |out: &mut String| {
                crate::value::write_string(out, key);
                out.push(':');
            };
            match slot {
                Slot::Removed => continue,
                Slot::Raw(range, _) => {
                    if !first {
                        out.push(',');
                    }
                    write(out);
                    out.push_str(&self.text[range.clone()]);
                }
                Slot::Value(value) => {
                    if !first {
                        out.push(',');
                    }
                    write(out);
                    value.write_json(out);
                }
            }
            first = false;
        }
        out.push('}');
    }

    /// The whole document as a [`Value`] (every slice read).
    pub fn to_value(&self) -> Value {
        let mut head = self.head.as_object().cloned().unwrap_or_default();
        if self.has_nodes() {
            let mut table = Object::with_capacity(self.node_count());
            for key in self.nodes.keys() {
                if let Some(node) = self.node(key) {
                    table.insert(key.clone(), node);
                }
            }
            head.insert("nodes", Value::object(table));
        }
        Value::object(head)
    }
}

/// An entry's text as `JSON.parse` reads it (the scan checked it is JSON).
fn read(text: &str) -> Value {
    Value::from_json(text).unwrap_or(Value::Null)
}

impl DocRead for StoredDocument {
    fn pages(&self) -> Value {
        self.head.get("pages").cloned().unwrap_or(Value::Null)
    }

    fn entry(&self, table: &str, key: &str) -> Option<Value> {
        if table == "nodes" {
            return self.node(key);
        }
        table_of(&self.head, table)
            .and_then(|entries| entries.get(key))
            .cloned()
    }

    fn size(&self, table: &str) -> usize {
        if table == "nodes" {
            return self.node_count();
        }
        table_of(&self.head, table).map_or(0, Object::len)
    }

    fn identities(&self, table: &str) -> Vec<(Str, usize)> {
        if table != "nodes" {
            return self.head.identities(table);
        }
        self.nodes
            .iter()
            .filter_map(|(key, slot)| match slot {
                // A slice not read yet is no other entry's: a token outside any address in use.
                Slot::Raw(range, value) => Some((
                    key.clone(),
                    value.get().map_or(usize::MAX - range.start, identity),
                )),
                Slot::Value(value) => Some((key.clone(), identity(value))),
                Slot::Removed => None,
            })
            .collect()
    }
}

// ── The scan ────────────────────────────────────────────────────────────────────────────────────

struct Scanner<'a> {
    bytes: &'a [u8],
    at: usize,
    /// The keys of the object being read at each depth (cleared, not dropped, between objects).
    keys: Vec<HashSet<&'a [u8], FixedState>>,
}

/// Where a value ended, and whether its text is exactly `JSON.stringify`'s of what `JSON.parse` reads.
type Skipped = Option<bool>;

impl<'a> Scanner<'a> {
    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn eat(&mut self, byte: u8) -> Option<()> {
        (self.peek()? == byte).then(|| self.at += 1)
    }

    /// A string; the answer says whether its escapes are `JSON.stringify`'s.
    fn string(&mut self) -> Skipped {
        self.eat(b'"')?;
        let mut canonical = true;
        loop {
            // Plain characters in one sweep.
            let rest = self.bytes.get(self.at..)?;
            self.at += rest
                .iter()
                .position(|&b| b == b'"' || b == b'\\' || b < 0x20)?;
            let byte = self.peek()?;
            self.at += 1;
            match byte {
                b'"' => return Some(canonical),
                b'\\' => {
                    let escape = self.peek()?;
                    self.at += 1;
                    match escape {
                        b'"' | b'\\' | b'b' | b'f' | b'n' | b'r' | b't' => {}
                        b'/' => canonical = false,
                        b'u' => {
                            let hex = self.bytes.get(self.at..self.at + 4)?;
                            self.at += 4;
                            let text = std::str::from_utf8(hex).ok()?;
                            let code = u32::from_str_radix(text, 16).ok()?;
                            // `JSON.stringify` writes `\u00XX` (lower case) only for control characters without a
                            // short escape; a lone surrogate is written so too, but is read whole here (rare).
                            let short = matches!(code, 0x08 | 0x09 | 0x0a | 0x0c | 0x0d);
                            if code >= 0x20 || short || text.bytes().any(|b| b.is_ascii_uppercase())
                            {
                                canonical = false;
                            }
                        }
                        _ => return None,
                    }
                }
                0..=0x1f => canonical = false,
                _ => {}
            }
        }
    }

    /// A number; canonical when it is JavaScript's shortest form of the double it reads as. Plain short numbers
    /// (the many) are decided while they are read; the others are formatted to compare.
    fn number(&mut self) -> Skipped {
        let start = self.at;
        let bytes = self.bytes;
        let negative = self.eat(b'-').is_some();
        let whole_start = self.at;
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.at += 1;
        }
        let whole = &bytes[whole_start..self.at];
        let mut fraction: &[u8] = &[];
        let mut plain = !whole.is_empty() && (whole.len() == 1 || whole[0] != b'0');
        if self.peek() == Some(b'.') {
            self.at += 1;
            let fraction_start = self.at;
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.at += 1;
            }
            fraction = &bytes[fraction_start..self.at];
            plain &= !fraction.is_empty() && fraction.last() != Some(&b'0');
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            self.at += 1;
            if matches!(self.peek(), Some(b'+' | b'-')) {
                self.at += 1;
            }
            while self.peek().is_some_and(|b| b.is_ascii_digit()) {
                self.at += 1;
            }
            plain = false;
        }
        if whole.is_empty() {
            return None;
        }
        // At most 15 significant digits (two such decimals are never the same double, so nothing shorter reads
        // back to it), not -0, and in the range JavaScript writes without an exponent (≥ 1e-6, < 1e21).
        let leading = whole.iter().take_while(|&&b| b == b'0').count();
        let significant = whole.len() - leading + fraction.len();
        let tiny = whole == b"0" && fraction.starts_with(b"000000");
        if plain
            && significant <= 15
            && !tiny
            && !(negative && whole == b"0" && fraction.is_empty())
        {
            return Some(true);
        }
        let token = std::str::from_utf8(&bytes[start..self.at]).ok()?;
        let value: f64 = token.parse().ok()?;
        if !value.is_finite() {
            return None;
        }
        Some(morfa_model::js_number::js_number(value) == token)
    }

    fn literal(&mut self, word: &[u8]) -> Skipped {
        if self.bytes.get(self.at..self.at + word.len())? == word {
            self.at += word.len();
            Some(true)
        } else {
            None
        }
    }

    /// Any value; whitespace anywhere makes it not canonical (the scan still finds its end).
    fn value(&mut self, depth: usize) -> Skipped {
        if depth > 512 {
            return None;
        }
        let mut canonical = !self.whitespace();
        let inner = match self.peek()? {
            b'"' => self.string()?,
            b'{' => {
                self.at += 1;
                if self.keys.len() <= depth {
                    self.keys.resize_with(depth + 1, HashSet::default);
                }
                self.keys[depth].clear();
                let mut ok = !self.whitespace();
                if self.eat(b'}').is_none() {
                    loop {
                        ok &= !self.whitespace();
                        let start = self.at;
                        ok &= self.string()?;
                        let bytes: &'a [u8] = self.bytes;
                        let key = &bytes[start + 1..self.at - 1];
                        // A repeated key or an array-index key changes what JSON.parse makes of the text.
                        let index = key.first().is_some_and(u8::is_ascii_digit)
                            && std::str::from_utf8(key).is_ok_and(is_index_key);
                        if !self.keys[depth].insert(key) || index {
                            ok = false;
                        }
                        ok &= !self.whitespace();
                        self.eat(b':')?;
                        ok &= self.value(depth + 1)?;
                        ok &= !self.whitespace();
                        match self.peek()? {
                            b',' => self.at += 1,
                            b'}' => {
                                self.at += 1;
                                break;
                            }
                            _ => return None,
                        }
                    }
                }
                ok
            }
            b'[' => {
                self.at += 1;
                let mut ok = !self.whitespace();
                if self.eat(b']').is_none() {
                    loop {
                        ok &= self.value(depth + 1)?;
                        ok &= !self.whitespace();
                        match self.peek()? {
                            b',' => self.at += 1,
                            b']' => {
                                self.at += 1;
                                break;
                            }
                            _ => return None,
                        }
                    }
                }
                ok
            }
            b't' => self.literal(b"true")?,
            b'f' => self.literal(b"false")?,
            b'n' => self.literal(b"null")?,
            _ => self.number()?,
        };
        canonical &= inner;
        Some(canonical)
    }

    /// Skips whitespace; true when there was some.
    fn whitespace(&mut self) -> bool {
        let start = self.at;
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.at += 1;
        }
        self.at > start
    }
}

/// The fast path: `{…, "nodes": {"id": <entry>, …}, …}` with no whitespace between the outer keys.
fn scan(text: &Arc<str>) -> Option<StoredDocument> {
    let bytes = text.as_bytes();
    let mut scanner = Scanner {
        bytes,
        at: 0,
        keys: Vec::new(),
    };
    scanner.eat(b'{')?;
    let mut head = Object::new();
    let mut nodes: IndexMap<Str, Slot, FixedState> = IndexMap::with_hasher(FixedState::default());
    if scanner.eat(b'}').is_none() {
        loop {
            let start = scanner.at;
            if !scanner.string()? {
                return None;
            }
            let key: Str = Str::from(std::str::from_utf8(&bytes[start + 1..scanner.at - 1]).ok()?);
            if is_index_key(&key) || head.contains_key(&key) {
                return None;
            }
            scanner.eat(b':')?;
            if &*key == "nodes" && scanner.peek() == Some(b'{') {
                scanner.at += 1;
                if scanner.eat(b'}').is_none() {
                    loop {
                        let key_start = scanner.at;
                        if !scanner.string()? {
                            return None;
                        }
                        let id = std::str::from_utf8(&bytes[key_start + 1..scanner.at - 1]).ok()?;
                        if is_index_key(id) || nodes.contains_key(id) {
                            return None;
                        }
                        scanner.eat(b':')?;
                        let value_start = scanner.at;
                        let canonical = scanner.value(0)?;
                        let range = value_start..scanner.at;
                        let slot = if canonical {
                            Slot::Raw(range, OnceLock::new())
                        } else {
                            Slot::Value(read(&text[range]))
                        };
                        nodes.insert(Str::from(id), slot);
                        match scanner.peek()? {
                            b',' => scanner.at += 1,
                            b'}' => {
                                scanner.at += 1;
                                break;
                            }
                            _ => return None,
                        }
                    }
                }
                head.insert(key, Value::Null);
            } else {
                if &*key == "nodes" {
                    return None;
                }
                let value_start = scanner.at;
                scanner.value(0)?;
                head.insert(key, read(&text[value_start..scanner.at]));
            }
            match scanner.peek()? {
                b',' => scanner.at += 1,
                b'}' => {
                    scanner.at += 1;
                    break;
                }
                _ => return None,
            }
        }
    }
    if scanner.at != bytes.len() {
        return None;
    }
    let table = head.contains_key("nodes");
    Some(StoredDocument {
        text: text.clone(),
        head: Value::object(head),
        nodes,
        table,
        removed: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn round_trip(text: &str) {
        let stored = StoredDocument::from_json(text).unwrap();
        let parsed = Value::from_json(text).unwrap();
        assert_eq!(stored.to_json(), parsed.to_json(), "{text}");
        assert_eq!(stored.to_value().to_json(), parsed.to_json());
    }

    #[test]
    fn writes_what_json_stringify_writes() {
        round_trip(
            r#"{"pages":["p"],"nodes":{"p":{"id":"p","x":1.5,"t":"a\nb"},"q":{"x":0.1,"y":-3}},"styles":{}}"#,
        );
        // Not JavaScript's own text: read, and written as JavaScript would.
        round_trip(
            r#"{"nodes":{"a":{"x":1.0,"y":1e2,"z":-0,"s":"é\/","w":0.0000001,"k":{"2":1,"1":2},"d":{"a":1,"a":2}}}}"#,
        );
        round_trip(r#"{"nodes":{"a":{ "x":1 }}, "pages":[]}"#);
        round_trip(
            r#"{"nodes":{"b":{"c":"\u001f","n":0.8509803921568627,"m":12345678901234567890}}}"#,
        );
    }

    #[test]
    fn patches_keep_javascripts_order() {
        let text = r#"{"pages":["p"],"nodes":{"a":{"id":"a"},"b":{"id":"b"},"c":{"id":"c"}}}"#;
        let mut stored = StoredDocument::from_json(text).unwrap();
        let mut value = Value::from_json(text).unwrap();
        for patch in [
            r#"{"nodes":{"a":null,"d":{"id":"d"}}}"#,
            r#"{"nodes":{"a":{"id":"a2"},"b":{"id":"b2"}},"pages":["p","q"]}"#,
        ] {
            let patch = Value::from_json(patch).unwrap();
            stored.apply_patch(&patch);
            apply_patch_mut(&mut value, &patch);
            assert_eq!(stored.to_json(), value.to_json());
        }
        assert_eq!(stored.node_count(), 4);
        assert_eq!(
            stored.entry("nodes", "c").unwrap().to_json(),
            r#"{"id":"c"}"#
        );
        assert!(
            stored
                .entry("nodes", "c")
                .unwrap()
                .identical(&stored.entry("nodes", "c").unwrap())
        );
        round_trip(r#"{"nodes":null,"pages":[]}"#);
        round_trip(r#"{"pages":[]}"#);
    }
}
