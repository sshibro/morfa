//! The open of a big file from its checkpoint: `MorfaDoc.decode` reads the binary
//! document, and the editor's store is built from it in parts of about 2 000 nodes, each one JSON string written by
//! today's writers (`node_out`, `push_json`), so no 400 MB string and no whole-file `JSON.parse` ever happen.
//!
//! With `shared`, the heavy values (`fills`, `strokes`, `effects`, `constraints`, `text`) cross once per part: each
//! is written as its index `k` in the part's `values` (none of these fields is ever a number), and
//! shared/design/parts.ts puts the one parsed object back in every node that names it. Values are keyed by their JSON text: a decoded document shares no
//! value between nodes (every node's lists are read on their own), so the Rust value's address would find none of
//! the repeats a generated or copied page is made of. One JS object per distinct value per part is what lowers the
//! store's heap and lets the identity-keyed caches hit.
//!
//! A part is ASCII: any other character is written as `\uXXXX` (only names and text have them). One non-ASCII
//! character makes the whole string two-byte in V8, and the UTF-8 → string step and `JSON.parse` of a 1.1 MB part
//! with Cyrillic names took 13.2 and 18.5 ms against 3.6 and 15.3 ms escaped (Chromium at 2×, this container).

use crate::delta::push_json;
use crate::doc::MorfaDoc;
use indexmap::IndexMap;
use morfa_model::SceneNode;
use morfa_model::store::{Atom, Document, Id, Symbol, TextProps};
use serde::Serialize;
use serde::ser::{self, Impossible};
use std::collections::HashMap;
use std::fmt;
use wasm_bindgen::prelude::*;

/// The fields a shared part writes as an index into its `values`.
const HEAVY: [&str; 5] = ["fills", "strokes", "effects", "constraints", "text"];

#[wasm_bindgen]
impl MorfaDoc {
    /// `decode` of checkpoint bytes JavaScript holds, read 64 KiB at a time instead of copied into wasm memory first:
    /// the memory's peak is the document (plus its strings' scratch), not the document and the bytes (f500k: 76 MiB of
    /// bytes, and linear memory never shrinks). The same frames are accepted and refused as by `decode`.
    pub fn decode_from(bytes: &js_sys::Uint8Array) -> Result<MorfaDoc, JsError> {
        let fill = |at: usize, out: &mut [u8]| {
            bytes
                .subarray(at as u32, (at + out.len()) as u32)
                .copy_to(out)
        };
        let doc = decode_chunks(&fill, bytes.length() as usize)
            .map_err(|error| JsError::new(&format!("MorfaDoc.decode_from: {error}")))?;
        Ok(MorfaDoc::with(doc))
    }

    /// The document without its nodes: `to_json()`'s text with `"nodes": {}` (schemaVersion, pages, every table and
    /// other top-level field, as `to_json` writes them). The open builds `{...JSON.parse(tables_json()), nodes}` from it
    /// and the parts (shared/design/parts.ts `documentOf`).
    pub fn tables_json(&self) -> String {
        tables_json(self.document())
    }

    /// One past the highest node slot: parts cover slots `[start, start + count)`, so `part_json` from 0 by `count`
    /// up to `part_slots()` writes every node once (a slot with no node is skipped; a part may hold fewer than `count`).
    pub fn part_slots(&self) -> u32 {
        self.document().slots() as u32
    }

    /// The nodes in slots `[start, start + count)` (for a decoded checkpoint, the file's key order) as
    /// `{"nodes": {id: SceneNode}}`, each node the JSON `node(id)` parses from (ASCII only: other characters as
    /// `\uXXXX`). With `shared`, every heavy value is its index `k` and the part ends with `"values": [value k, …]`,
    /// one entry per distinct value in the part (shared/design/parts.ts `readPart` puts them back).
    pub fn part_json(&self, start: u32, count: u32, shared: bool) -> String {
        write_part(self.document(), start as usize, count as usize, shared)
    }

    /// Every face the text under `root` sets type in, as export-raster.ts `fontSpecsUnder` lists them (JSON
    /// `[{family, weight, italic, size}]`, same order, same entries): the faces are told apart by the family's atom,
    /// never by its text. Every page's, in page order, when `root` is absent; `[]` for an id with no node.
    pub fn font_specs(&self, root: Option<String>) -> String {
        let doc = self.document();
        let roots: Vec<Id> = match root {
            Some(key) => doc.id(&key).into_iter().collect(),
            None => doc.pages.clone(),
        };
        let mut specs: IndexMap<(Atom, u64, bool), (f64, f64)> = IndexMap::new();
        for root in roots {
            font_specs_under(doc, root, &mut specs);
        }
        let mut out = String::from("[");
        for (index, ((family, _, italic), (weight, size))) in specs.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str("{\"family\":");
            push_json(&mut out, doc.atom(*family));
            out.push_str(",\"weight\":");
            push_json(&mut out, weight);
            out.push_str(",\"italic\":");
            out.push_str(if *italic { "true" } else { "false" });
            out.push_str(",\"size\":");
            push_json(&mut out, size);
            out.push('}');
        }
        out.push(']');
        out
    }
}

/// [`MorfaDoc::tables_json`] on a stored document.
pub(crate) fn tables_json(doc: &Document) -> String {
    let mut out = String::new();
    push_json(&mut out, &doc.tables_model());
    ascii(out)
}

/// `morfa_model::codec::decode` through [`decode_chunks`]: `MorfaDoc.decode` and `decode_from` share one reader of the
/// store's shape (postcard builds the whole document reader once per flavor: a second one cost the web build 31 KiB
/// gzip).
pub(crate) fn decode_bytes(bytes: &[u8]) -> Result<Document, String> {
    decode_chunks(
        &|at, out: &mut [u8]| out.copy_from_slice(&bytes[at..at + out.len()]),
        bytes.len(),
    )
}

/// Where a frame's bytes come from: `fill(at, out)` copies the frame's bytes from `at` on into all of `out`.
type Fill<'f> = &'f dyn Fn(usize, &mut [u8]);

/// Bytes read from the source at a time.
const CHUNK: usize = 64 * 1024;

/// The document of a checkpoint frame of `len` bytes (`morfa_model::codec::decode`'s checks and errors: the frame's
/// magic and format, the whole payload one document), read a chunk at a time. Strings the document borrows while it
/// is read are copied to a scratch buffer: an eighth of the frame first (f500k needs a sixteenth), the frame's size
/// when that runs out.
pub(crate) fn decode_chunks(fill: Fill<'_>, len: usize) -> Result<Document, String> {
    use morfa_model::codec::{CodecError, FORMAT, MAGIC};
    use serde::Deserialize as _;
    const HEADER: usize = MAGIC.len() + 2;
    let mut header = [0u8; HEADER];
    if len < HEADER {
        return Err(CodecError::NotAFrame.to_string());
    }
    fill(0, &mut header);
    if header[..MAGIC.len()] != MAGIC {
        return Err(CodecError::NotAFrame.to_string());
    }
    let format = u16::from_le_bytes([header[4], header[5]]);
    if format != FORMAT {
        return Err(CodecError::Format(format).to_string());
    }
    let payload = |error: postcard::Error| CodecError::Payload(error.to_string()).to_string();
    let mut scratch_len = (len / 8).max(CHUNK);
    loop {
        let mut scratch = vec![0u8; scratch_len];
        let out_of_scratch = std::cell::Cell::new(false);
        let mut deserializer = postcard::Deserializer::from_flavor(Chunked {
            fill,
            len,
            next: HEADER,
            chunk: Vec::with_capacity(CHUNK),
            at: 0,
            scratch: &mut scratch,
            out_of_scratch: &out_of_scratch,
            temp: Vec::new(),
        });
        match Document::deserialize(&mut deserializer) {
            Ok(doc) => {
                let rest = deserializer.finalize().map_err(payload)?;
                if rest > 0 {
                    return Err(
                        CodecError::Payload(format!("{rest} bytes after the document")).to_string(),
                    );
                }
                return Ok(doc);
            }
            Err(_) if out_of_scratch.get() && scratch_len < len => scratch_len = len,
            Err(error) => return Err(payload(error)),
        }
    }
}

/// A postcard flavor over a frame read a chunk at a time: a byte is popped from the chunk (as fast as the slice
/// flavor), a string the document borrows is copied to `scratch`, which lives as long as the read.
struct Chunked<'de> {
    fill: Fill<'de>,
    len: usize,
    /// Where in the frame the next chunk starts.
    next: usize,
    chunk: Vec<u8>,
    /// Where in `chunk` the next byte is.
    at: usize,
    scratch: &'de mut [u8],
    out_of_scratch: &'de std::cell::Cell<bool>,
    /// A value read across two chunks without being borrowed.
    temp: Vec<u8>,
}

impl Chunked<'_> {
    /// Bytes not read yet.
    fn left(&self) -> usize {
        self.chunk.len() - self.at + self.len - self.next
    }

    #[cold]
    fn refill(&mut self) -> postcard::Result<()> {
        let n = (self.len - self.next).min(CHUNK);
        if n == 0 {
            return Err(postcard::Error::DeserializeUnexpectedEnd);
        }
        self.chunk.resize(n, 0);
        (self.fill)(self.next, &mut self.chunk);
        self.next += n;
        self.at = 0;
        Ok(())
    }

    /// The next `out.len()` bytes, across chunks (the caller checked there are that many).
    fn read_into(&mut self, mut out: &mut [u8]) -> postcard::Result<()> {
        while !out.is_empty() {
            if self.at == self.chunk.len() {
                self.refill()?;
            }
            let n = (self.chunk.len() - self.at).min(out.len());
            let (head, tail) = std::mem::take(&mut out).split_at_mut(n);
            head.copy_from_slice(&self.chunk[self.at..self.at + n]);
            self.at += n;
            out = tail;
        }
        Ok(())
    }
}

impl<'de> postcard::de_flavors::Flavor<'de> for Chunked<'de> {
    /// The bytes left after the document.
    type Remainder = usize;
    type Source = ();

    #[inline]
    fn pop(&mut self) -> postcard::Result<u8> {
        if self.at == self.chunk.len() {
            self.refill()?;
        }
        let byte = self.chunk[self.at];
        self.at += 1;
        Ok(byte)
    }

    fn try_take_n(&mut self, ct: usize) -> postcard::Result<&'de [u8]> {
        if ct > self.left() {
            return Err(postcard::Error::DeserializeUnexpectedEnd);
        }
        if ct > self.scratch.len() {
            self.out_of_scratch.set(true);
            return Err(postcard::Error::DeserializeUnexpectedEnd);
        }
        let (out, rest) = std::mem::take(&mut self.scratch).split_at_mut(ct);
        self.scratch = rest;
        self.read_into(out)?;
        Ok(out)
    }

    fn try_take_n_temp<'a>(&'a mut self, ct: usize) -> postcard::Result<&'a [u8]>
    where
        'de: 'a,
    {
        if ct > self.left() {
            return Err(postcard::Error::DeserializeUnexpectedEnd);
        }
        if self.chunk.len() - self.at >= ct {
            let start = self.at;
            self.at += ct;
            return Ok(&self.chunk[start..start + ct]);
        }
        let mut temp = std::mem::take(&mut self.temp);
        temp.resize(ct, 0);
        self.read_into(&mut temp)?;
        self.temp = temp;
        Ok(&self.temp)
    }

    fn finalize(self) -> postcard::Result<usize> {
        Ok(self.left())
    }
}

/// `fontSpecsUnder`'s walk: a stack from `root`, children pushed in order (so visited last first), each text node's
/// style and then each run's style laid over it; a face seen again keeps its place and takes the later size.
fn font_specs_under(doc: &Document, root: Id, specs: &mut IndexMap<(Atom, u64, bool), (f64, f64)>) {
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.node(id) else { continue };
        if let Some(text) = node.props.text() {
            add_faces(text, specs);
        }
        if let Some(children) = &node.children {
            stack.extend(children.iter().copied());
        }
    }
}

fn add_faces(text: &TextProps, specs: &mut IndexMap<(Atom, u64, bool), (f64, f64)>) {
    let style = &text.style;
    let mut add = |family: Atom, weight: f64, italic: bool, size: f64| {
        // `${family}|${weight}|${italic}`: weights equal as JavaScript prints them (0 and -0 print alike).
        let weight_key = if weight == 0.0 { 0 } else { weight.to_bits() };
        specs.insert((family, weight_key, italic), (weight, size));
    };
    add(
        style.font_family,
        style.font_weight,
        style.italic,
        style.font_size,
    );
    for run in text.runs.iter() {
        let over = &run.style;
        add(
            over.font_family.unwrap_or(style.font_family),
            over.font_weight.unwrap_or(style.font_weight),
            over.italic.unwrap_or(style.italic),
            over.font_size.unwrap_or(style.font_size),
        );
    }
}

/// [`MorfaDoc::part_json`] on a stored document.
pub(crate) fn write_part(doc: &Document, start: usize, count: usize, shared: bool) -> String {
    let end = start.saturating_add(count).min(doc.slots());
    let mut out = String::with_capacity(count.min(4096) * 640);
    out.push_str("{\"nodes\":{");
    let mut table = Table::default();
    let mut first = true;
    for index in start.min(end)..end {
        let id = Id::from_index(index);
        let Some(node) = doc.node_model_of(id) else {
            continue;
        };
        if !first {
            out.push(',');
        }
        first = false;
        push_json(&mut out, doc.key(id));
        out.push(':');
        if shared {
            write_shared(&mut out, &node, &mut table);
        } else {
            push_json(&mut out, &node);
        }
    }
    out.push('}');
    if shared {
        out.push_str(",\"values\":[");
        out.push_str(&table.values);
        out.push(']');
    }
    out.push('}');
    ascii(out)
}

/// `json` with every character past ASCII written as `\uXXXX` (UTF-16 units, as `JSON.stringify` would escape them):
/// outside strings a part is ASCII already, so the text parses to the same values.
fn ascii(json: String) -> String {
    if json.is_ascii() {
        return json;
    }
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(json.len() + json.len() / 8);
    let mut units = [0u16; 2];
    let mut rest = json.as_str();
    // ASCII runs are copied whole; only the characters past them are escaped one by one.
    while let Some(at) = rest.bytes().position(|byte| !byte.is_ascii()) {
        out.push_str(&rest[..at]);
        let ch = rest[at..].chars().next().expect("a character starts here");
        for &unit in ch.encode_utf16(&mut units).iter() {
            out.push_str("\\u");
            for shift in [12, 8, 4, 0] {
                out.push(HEX[usize::from((unit >> shift) & 0xf)] as char);
            }
        }
        rest = &rest[at + ch.len_utf8()..];
    }
    out.push_str(rest);
    out
}

/// The distinct heavy values of one part: their JSON text by index, and the text joined as the `values` array.
#[derive(Default)]
struct Table {
    index: HashMap<String, u32>,
    values: String,
    scratch: String,
}

impl Table {
    /// The index of `value` in the part's table, adding it when new.
    fn index_of<T: Serialize + ?Sized>(&mut self, value: &T) -> u32 {
        self.scratch.clear();
        push_json(&mut self.scratch, value);
        if let Some(&k) = self.index.get(self.scratch.as_str()) {
            return k;
        }
        let k = self.index.len() as u32;
        if k > 0 {
            self.values.push(',');
        }
        self.values.push_str(&self.scratch);
        self.index.insert(self.scratch.clone(), k);
        k
    }
}

/// `node` as `push_json` writes it, its heavy fields as indexes into `values` (the same field order: serde's walk of
/// `SceneNode`).
fn write_shared(out: &mut String, node: &SceneNode, table: &mut Table) {
    let at = out.len();
    out.push('{');
    let mut writer = Writer {
        out,
        table,
        first: true,
    };
    // Only a struct reaches `Writer`; were that to change, the node crosses whole (the part stays right, only bigger).
    if node.serialize(&mut writer).is_err() {
        out.truncate(at);
        push_json(out, node);
        return;
    }
    out.push('}');
}

struct Writer<'a> {
    out: &'a mut String,
    table: &'a mut Table,
    first: bool,
}

#[derive(Debug)]
struct NotAStruct;

impl fmt::Display for NotAStruct {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("not a struct")
    }
}

impl std::error::Error for NotAStruct {}

impl ser::Error for NotAStruct {
    fn custom<T: fmt::Display>(_: T) -> Self {
        NotAStruct
    }
}

impl ser::SerializeStruct for &mut Writer<'_> {
    type Ok = ();
    type Error = NotAStruct;

    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), NotAStruct> {
        if !self.first {
            self.out.push(',');
        }
        self.first = false;
        self.out.push('"');
        self.out.push_str(key);
        self.out.push_str("\":");
        if HEAVY.contains(&key) {
            let k = self.table.index_of(value);
            push_json(self.out, &k);
        } else {
            push_json(self.out, value);
        }
        Ok(())
    }

    fn end(self) -> Result<(), NotAStruct> {
        Ok(())
    }
}

macro_rules! refuse {
    ($($name:ident($($arg:ty),*);)*) => {
        $(fn $name(self, $(_: $arg),*) -> Result<(), NotAStruct> { Err(NotAStruct) })*
    };
}

impl<'a, 'w> ser::Serializer for &'a mut Writer<'w> {
    type Ok = ();
    type Error = NotAStruct;
    type SerializeSeq = Impossible<(), NotAStruct>;
    type SerializeTuple = Impossible<(), NotAStruct>;
    type SerializeTupleStruct = Impossible<(), NotAStruct>;
    type SerializeTupleVariant = Impossible<(), NotAStruct>;
    type SerializeMap = Impossible<(), NotAStruct>;
    type SerializeStruct = &'a mut Writer<'w>;
    type SerializeStructVariant = Impossible<(), NotAStruct>;

    fn serialize_struct(
        self,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeStruct, NotAStruct> {
        Ok(self)
    }

    refuse! {
        serialize_bool(bool); serialize_i8(i8); serialize_i16(i16); serialize_i32(i32); serialize_i64(i64);
        serialize_u8(u8); serialize_u16(u16); serialize_u32(u32); serialize_u64(u64); serialize_f32(f32);
        serialize_f64(f64); serialize_char(char); serialize_str(&str); serialize_bytes(&[u8]); serialize_none();
        serialize_unit(); serialize_unit_struct(&'static str);
        serialize_unit_variant(&'static str, u32, &'static str);
    }

    fn serialize_some<T: ?Sized + Serialize>(self, _: &T) -> Result<(), NotAStruct> {
        Err(NotAStruct)
    }

    fn serialize_newtype_struct<T: ?Sized + Serialize>(
        self,
        _: &'static str,
        _: &T,
    ) -> Result<(), NotAStruct> {
        Err(NotAStruct)
    }

    fn serialize_newtype_variant<T: ?Sized + Serialize>(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: &T,
    ) -> Result<(), NotAStruct> {
        Err(NotAStruct)
    }

    fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, NotAStruct> {
        Err(NotAStruct)
    }

    fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, NotAStruct> {
        Err(NotAStruct)
    }

    fn serialize_tuple_struct(
        self,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleStruct, NotAStruct> {
        Err(NotAStruct)
    }

    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleVariant, NotAStruct> {
        Err(NotAStruct)
    }

    fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, NotAStruct> {
        Err(NotAStruct)
    }

    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeStructVariant, NotAStruct> {
        Err(NotAStruct)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Document {
        let json = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../tests/fixtures/board-before-fj.json"
        ))
        .expect("fixture");
        Document::from_model(&morfa_model::from_json(&json).expect("a document"))
    }

    fn parse(part: &str) -> serde_json::Value {
        serde_json::from_str(part).expect("a part parses")
    }

    /// The part's `values` put back where an index names them.
    fn resolved(part: &serde_json::Value) -> serde_json::Map<String, serde_json::Value> {
        let values = part["values"].as_array().expect("values").clone();
        let mut nodes = part["nodes"].as_object().expect("nodes").clone();
        for node in nodes.values_mut() {
            for key in HEAVY {
                if let Some(slot) = node.get_mut(key) {
                    let k = slot.as_u64().expect("a reference") as usize;
                    *slot = values[k].clone();
                }
            }
        }
        nodes
    }

    #[test]
    fn parts_cover_every_node_once_as_node_writes_it() {
        let doc = doc();
        let whole: serde_json::Value = parse(&morfa_model::to_json(&doc.to_model()));
        let mut seen = 0;
        for shared in [false, true] {
            let mut nodes = serde_json::Map::new();
            for start in (0..doc.slots()).step_by(7) {
                let part = parse(&write_part(&doc, start, 7, shared));
                let part_nodes = if shared {
                    resolved(&part)
                } else {
                    part["nodes"].as_object().expect("nodes").clone()
                };
                for (id, node) in part_nodes {
                    assert_eq!(
                        node,
                        parse(&morfa_model::to_json(&doc.node_model(&id).expect("node"))),
                        "{id}"
                    );
                    assert!(nodes.insert(id, node).is_none());
                }
            }
            assert_eq!(serde_json::Value::Object(nodes), whole["nodes"]);
            seen += 1;
        }
        assert_eq!(seen, 2);
    }

    #[test]
    fn a_checkpoint_read_in_chunks_is_the_one_decode_reads() {
        let doc = doc();
        let bytes = morfa_model::codec::encode(&doc);
        let read = decode_bytes(&bytes).expect("decoded");
        assert_eq!(read.to_model(), doc.to_model());
        // A scratch too small for the strings is retried larger: a frame of tiny scratch still reads.
        let mut long = doc.clone();
        let text = "ж".repeat(200_000);
        let name = long.intern_atom(&text);
        let first = long.nodes().next().expect("a node").id;
        long.node_mut(first).expect("node").name = name;
        let bytes = morfa_model::codec::encode(&long);
        assert_eq!(
            decode_bytes(&bytes).expect("decoded").to_model(),
            long.to_model()
        );
        let refused = |bytes: &[u8]| decode_bytes(bytes).err();
        assert_eq!(
            refused(b"MRF"),
            Some(morfa_model::codec::CodecError::NotAFrame.to_string())
        );
        let mut other = bytes.clone();
        other[4] = 9;
        assert_eq!(
            refused(&other),
            morfa_model::codec::decode(&other)
                .err()
                .map(|e| e.to_string())
        );
        let mut extra = bytes.clone();
        extra.push(0);
        assert_eq!(
            refused(&extra),
            morfa_model::codec::decode(&extra)
                .err()
                .map(|e| e.to_string())
        );
        let small = morfa_model::codec::encode(&doc);
        for cut in (0..small.len()).step_by(37) {
            assert_eq!(
                refused(&small[..cut]),
                morfa_model::codec::decode(&small[..cut])
                    .err()
                    .map(|e| e.to_string()),
                "a frame cut at {cut}"
            );
        }
    }

    #[test]
    fn a_part_is_ascii_and_reads_as_the_text_it_escapes() {
        let text = r#"{"nodes":{"n1":{"name":"Экран “1” — ok 😀","x":1}}}"#.to_owned();
        let escaped = ascii(text.clone());
        assert!(escaped.is_ascii());
        assert_eq!(parse(&escaped), parse(&text));
        assert!(escaped.contains(r"\u042d") && escaped.contains(r"\ud83d\ude00"));
        let plain = r#"{"nodes":{}}"#.to_owned();
        assert_eq!(ascii(plain.clone()), plain);
    }

    #[test]
    fn the_tables_are_to_json_without_the_nodes() {
        let doc = doc();
        let mut whole = parse(&morfa_model::to_json(&doc.to_model()));
        whole["nodes"] = serde_json::json!({});
        assert_eq!(parse(&tables_json(&doc)), whole);
        assert!(tables_json(&doc).is_ascii());
    }

    #[test]
    fn a_repeated_value_crosses_once_per_part() {
        let doc = doc();
        let part = parse(&write_part(&doc, 0, doc.slots(), true));
        let values = part["values"].as_array().expect("values");
        let distinct: std::collections::HashSet<String> =
            values.iter().map(|value| value.to_string()).collect();
        assert_eq!(distinct.len(), values.len(), "each value once");
        assert!(values.len() < doc.len() * HEAVY.len());
        assert_eq!(
            write_part(&doc, doc.slots(), 10, true),
            "{\"nodes\":{},\"values\":[]}"
        );
        assert_eq!(write_part(&doc, 0, 0, false), "{\"nodes\":{}}");
    }
}
