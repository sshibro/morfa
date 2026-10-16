//! The co-editing socket's binary wire (`?wire=bin`, lane B1's `crates/protocol/src/binary.rs`) at the browser edge,
//! for lane B3's transport (`src/design/realtime/transport/ws.ts`). Free functions: a frame in, its message out; the
//! frame is the only thing that crosses (no document is read).
//!
//! The JavaScript side holds messages as `JSON.parse` would give them, so the edge's form is JSON text: the decode
//! writes it in one pass over the frame and `JSON.parse` turns it into objects (faster in V8 than building them
//! through `js_sys` property by property).
//!
//! The decode reads the frame directly into the text (`write_frame`) instead of `binary::frame_to_json`, which builds
//! the frame's `Item` tree and allocates per string and number first: a 1 000-op catch-up (5.8 MB) took 262 ms that
//! way in Node's wasm. It reads the same postcard layout as strictly (lengths, UTF-8, key indices, nothing left over)
//! and writes the same text; the tests hold it to `frame_to_json` on every message shape and damaged frame.

use morfa_protocol::binary::{self, CHANGES, MESSAGE, PRESENCE};
use wasm_bindgen::prelude::*;

fn fail(entry: &str, error: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("{entry}: {error}"))
}

/// The JSON text of a server frame (a message, a presence batch or a changes batch), as the JSON wire would carry it.
#[wasm_bindgen]
pub fn decode_frame(bytes: &[u8]) -> Result<String, JsError> {
    frame_text(bytes).map_err(|e| fail("decode_frame", e))
}

/// [`decode_frame`], with a `changes` frame of consecutive versions composed into one change as the transport's
/// `composeChanges` does (src/design/realtime/transport/frame-decoder.ts): only the composite becomes text, so a
/// 1 000-op catch-up of a few people's selections costs a skim of the frame, not 14 MB of JSON. Any other frame, and a
/// changes frame that does not compose (one change, a gap, a table that is not an object, field-level changes of
/// protocol 2), is `decode_frame`'s text.
#[wasm_bindgen]
pub fn decode_frame_composed(bytes: &[u8]) -> Result<String, JsError> {
    if bytes.first() == Some(&CHANGES)
        && let Some(text) = composed(bytes).map_err(|e| fail("decode_frame_composed", e))?
    {
        return Ok(text);
    }
    frame_text(bytes).map_err(|e| fail("decode_frame_composed", e))
}

/// The binary frame of a client message given as JSON text (`JSON.stringify` of the message).
#[wasm_bindgen]
pub fn encode_frame(json: &str) -> Result<Vec<u8>, JsError> {
    binary::json_to_frame(json).map_err(|e| fail("encode_frame", e.0))
}

/// `binary::frame_to_json`, read and written in one pass.
pub(crate) fn frame_text(frame: &[u8]) -> Result<String, &'static str> {
    let mut out = Vec::with_capacity(frame.len() * 3);
    match frame.first() {
        Some(&MESSAGE) => message(&frame[1..], &mut out)?,
        Some(&tag @ (PRESENCE | CHANGES)) => {
            out.extend_from_slice(if tag == PRESENCE {
                br#"{"t":"presence","peers":["#
            } else {
                br#"{"t":"changes","changes":["#
            });
            let mut body = Reader { bytes: &frame[1..] };
            let count = body.batch_len()?;
            for i in 0..count {
                if i > 0 {
                    out.push(b',');
                }
                let len = body.batch_len()?;
                let part = body
                    .take(len)
                    .map_err(|_| "a batch shorter than its parts")?;
                match part.split_first() {
                    Some((&MESSAGE, rest)) => message(rest, &mut out)?,
                    _ => return Err("not a message frame"),
                }
            }
            if !body.bytes.is_empty() {
                return Err("bytes after the batch");
            }
            out.extend_from_slice(b"]}");
        }
        _ => return Err("not a binary frame"),
    }
    // Every byte written is ASCII punctuation, a number, or a string checked as UTF-8 when read.
    String::from_utf8(out).map_err(|_| "not UTF-8")
}

/// The postcard reader of a frame's body.
struct Reader<'a> {
    bytes: &'a [u8],
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], &'static str> {
        if self.bytes.len() < n {
            return Err("damaged frame");
        }
        let (head, rest) = self.bytes.split_at(n);
        self.bytes = rest;
        Ok(head)
    }

    fn byte(&mut self) -> Result<u8, &'static str> {
        Ok(self.take(1)?[0])
    }

    /// A LEB128 varint of at most `max` bytes whose value fits `bits` (postcard's checks).
    fn varint(&mut self, max: usize, bits: u32) -> Result<u64, &'static str> {
        let mut n = 0u64;
        for i in 0..max {
            let b = self.byte()?;
            n |= u64::from(b & 0x7f) << (7 * i);
            if b & 0x80 == 0 {
                if bits < 64 && n >> bits != 0 {
                    return Err("damaged frame");
                }
                // The last byte of a full-width varint holds the top bits only.
                if i == max - 1 && u32::from(b) >> (bits - 7 * (max as u32 - 1)) != 0 {
                    return Err("damaged frame");
                }
                return Ok(n);
            }
        }
        Err("damaged frame")
    }

    fn u32(&mut self) -> Result<u32, &'static str> {
        Ok(self.varint(5, 32)? as u32)
    }

    fn len(&mut self) -> Result<usize, &'static str> {
        // usize on wasm32: postcard's varint(usize) is at most 5 bytes there.
        let n = self.varint(10, 64)?;
        usize::try_from(n).map_err(|_| "damaged frame")
    }

    /// A batch's count or part length (`binary::read_varint`: up to 10 bytes, no width check).
    fn batch_len(&mut self) -> Result<usize, &'static str> {
        let mut n = 0u64;
        for i in 0..10 {
            let b = self.byte().map_err(|_| "a damaged length")?;
            n |= u64::from(b & 0x7f).wrapping_shl(7 * i);
            if b & 0x80 == 0 {
                return usize::try_from(n).map_err(|_| "a damaged length");
            }
        }
        Err("a damaged length")
    }

    fn str(&mut self) -> Result<&'a str, &'static str> {
        let len = self.len()?;
        std::str::from_utf8(self.take(len)?).map_err(|_| "damaged frame")
    }
}

/// Nesting deeper than this is refused (a frame from the server is a few levels deep; a stack must not overflow).
const MAX_DEPTH: u32 = 256;

/// One message (after its tag): the key table, then the root item.
fn message(body: &[u8], out: &mut Vec<u8>) -> Result<(), &'static str> {
    let mut r = Reader { bytes: body };
    let count = r.len()?;
    // Each key written once, as `"key":`, then copied for every entry that names it.
    let mut keys: Vec<Vec<u8>> = Vec::with_capacity(count.min(r.bytes.len()));
    for _ in 0..count {
        let key = r.str()?;
        let mut text = Vec::with_capacity(key.len() + 3);
        write_string(key, &mut text);
        text.push(b':');
        keys.push(text);
    }
    item(&mut r, &keys, out, 0)?;
    if !r.bytes.is_empty() {
        return Err("bytes after the message");
    }
    Ok(())
}

fn item(
    r: &mut Reader,
    keys: &[Vec<u8>],
    out: &mut Vec<u8>,
    depth: u32,
) -> Result<(), &'static str> {
    if depth > MAX_DEPTH {
        return Err("damaged frame");
    }
    match r.u32()? {
        0 => out.extend_from_slice(b"null"),
        1 => match r.byte()? {
            0 => out.extend_from_slice(b"false"),
            1 => out.extend_from_slice(b"true"),
            _ => return Err("damaged frame"),
        },
        2 => {
            let zigzag = r.varint(10, 64)?;
            let n = ((zigzag >> 1) as i64) ^ -((zigzag & 1) as i64);
            write_int(n, out);
        }
        3 => {
            let bytes: [u8; 8] = r.take(8)?.try_into().expect("eight bytes");
            let _ = morfa_model::js_number::write_js_number(out, f64::from_le_bytes(bytes));
        }
        4 => write_string(r.str()?, out),
        5 => {
            let len = r.len()?;
            out.push(b'[');
            for i in 0..len {
                if i > 0 {
                    out.push(b',');
                }
                item(r, keys, out, depth + 1)?;
            }
            out.push(b']');
        }
        6 => {
            let len = r.len()?;
            out.push(b'{');
            for i in 0..len {
                if i > 0 {
                    out.push(b',');
                }
                let key = keys
                    .get(r.u32()? as usize)
                    .ok_or("a key outside the key table")?;
                out.extend_from_slice(key);
                item(r, keys, out, depth + 1)?;
            }
            out.push(b'}');
        }
        _ => return Err("damaged frame"),
    }
    Ok(())
}

fn write_int(n: i64, out: &mut Vec<u8>) {
    let mut digits = [0u8; 20];
    let mut at = digits.len();
    let mut rest = n.unsigned_abs();
    loop {
        at -= 1;
        digits[at] = b'0' + (rest % 10) as u8;
        rest /= 10;
        if rest == 0 {
            break;
        }
    }
    if n < 0 {
        out.push(b'-');
    }
    out.extend_from_slice(&digits[at..]);
}

/// A string as `JSON.stringify` (and serde_json) writes it: `"` `\` and control characters escaped, the rest as is.
fn write_string(s: &str, out: &mut Vec<u8>) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    out.push(b'"');
    let bytes = s.as_bytes();
    let mut start = 0;
    for (i, &b) in bytes.iter().enumerate() {
        let escape: &[u8] = match b {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            b'\n' => b"\\n",
            b'\r' => b"\\r",
            b'\t' => b"\\t",
            0x08 => b"\\b",
            0x0c => b"\\f",
            0x00..=0x1f => &[
                b'\\',
                b'u',
                b'0',
                b'0',
                HEX[(b >> 4) as usize],
                HEX[(b & 0xf) as usize],
            ],
            _ => continue,
        };
        out.extend_from_slice(&bytes[start..i]);
        out.extend_from_slice(escape);
        start = i + 1;
    }
    out.extend_from_slice(&bytes[start..]);
    out.push(b'"');
}

// ── The composed catch-up ────────────────────────────────────────────────────────────────────────

/// Where an item starts: the batch part (its key table) and the offset in the part's body.
#[derive(Clone, Copy)]
struct At {
    part: usize,
    offset: usize,
}

/// A message part of a batch: its body after the tag, its key table (raw, and written as `"key":`).
struct Part<'a> {
    body: &'a [u8],
    keys: Vec<&'a str>,
    written: Vec<Vec<u8>>,
    /// Where the root item starts in `body`.
    root: usize,
}

fn part(body: &[u8]) -> Result<Part<'_>, &'static str> {
    let mut r = Reader { bytes: body };
    let count = r.len()?;
    let mut keys = Vec::with_capacity(count.min(body.len()));
    let mut written = Vec::with_capacity(count.min(body.len()));
    for _ in 0..count {
        let key = r.str()?;
        let mut text = Vec::with_capacity(key.len() + 3);
        write_string(key, &mut text);
        text.push(b':');
        keys.push(key);
        written.push(text);
    }
    Ok(Part {
        root: body.len() - r.bytes.len(),
        body,
        keys,
        written,
    })
}

/// Reads past one item (checked as `item` checks it), writing nothing.
fn skip(r: &mut Reader, keys: usize, depth: u32) -> Result<(), &'static str> {
    if depth > MAX_DEPTH {
        return Err("damaged frame");
    }
    match r.u32()? {
        0 => {}
        1 => {
            if r.byte()? > 1 {
                return Err("damaged frame");
            }
        }
        2 => {
            r.varint(10, 64)?;
        }
        3 => {
            r.take(8)?;
        }
        4 => {
            r.str()?;
        }
        5 => {
            for _ in 0..r.len()? {
                skip(r, keys, depth + 1)?;
            }
        }
        6 => {
            for _ in 0..r.len()? {
                if r.u32()? as usize >= keys {
                    return Err("a key outside the key table");
                }
                skip(r, keys, depth + 1)?;
            }
        }
        _ => return Err("damaged frame"),
    }
    Ok(())
}

/// The entries of an object item at the reader: (key, where its value starts), the values skipped. None when the
/// item is not an object.
fn entries<'a>(
    r: &mut Reader,
    part: &Part<'a>,
    index: usize,
) -> Result<Option<Vec<(&'a str, At)>>, &'static str> {
    let start = r.bytes;
    if r.u32()? != 6 {
        r.bytes = start;
        skip(r, part.keys.len(), 1)?;
        return Ok(None);
    }
    let len = r.len()?;
    let mut out = Vec::with_capacity(len.min(r.bytes.len()));
    for _ in 0..len {
        let key = *part
            .keys
            .get(r.u32()? as usize)
            .ok_or("a key outside the key table")?;
        let at = At {
            part: index,
            offset: part.body.len() - r.bytes.len(),
        };
        skip(r, part.keys.len(), 2)?;
        out.push((key, at));
    }
    Ok(Some(out))
}

/// The whole number at `at`, if the item there is one.
fn int_at(parts: &[Part], at: At) -> Option<i64> {
    let mut r = Reader {
        bytes: &parts[at.part].body[at.offset..],
    };
    if r.u32().ok()? != 2 {
        return None;
    }
    let zigzag = r.varint(10, 64).ok()?;
    Some(((zigzag >> 1) as i64) ^ -((zigzag & 1) as i64))
}

fn write_at(parts: &[Part], at: At, out: &mut Vec<u8>) -> Result<(), &'static str> {
    let part = &parts[at.part];
    let mut r = Reader {
        bytes: &part.body[at.offset..],
    };
    item(&mut r, &part.written, out, 1)
}

/// The composed `changes` text, or None when the frame's changes do not compose.
fn composed(frame: &[u8]) -> Result<Option<String>, &'static str> {
    let mut body = Reader { bytes: &frame[1..] };
    let count = body.batch_len()?;
    let mut parts = Vec::with_capacity(count.min(body.bytes.len()));
    for _ in 0..count {
        let len = body.batch_len()?;
        let bytes = body
            .take(len)
            .map_err(|_| "a batch shorter than its parts")?;
        match bytes.split_first() {
            Some((&MESSAGE, rest)) => parts.push(part(rest)?),
            _ => return Err("not a message frame"),
        }
    }
    if !body.bytes.is_empty() {
        return Err("bytes after the batch");
    }
    if parts.len() < 2 {
        return Ok(None);
    }
    // Tables in first-seen order, their entries in first-seen order with the latest value (Object.assign).
    let mut tables: Vec<(&str, Vec<(&str, At)>)> = Vec::new();
    let mut table_index: std::collections::HashMap<
        &str,
        (usize, std::collections::HashMap<&str, usize>),
    > = std::collections::HashMap::new();
    let mut pages: Option<(usize, At)> = None;
    let mut ops: Vec<(At, At, i64)> = Vec::new();
    let (mut first, mut last, mut user) = (0i64, 0i64, None);
    for (index, p) in parts.iter().enumerate() {
        let mut r = Reader {
            bytes: &p.body[p.root..],
        };
        let Some(fields) = entries(&mut r, p, index)? else {
            return Ok(None);
        };
        if !r.bytes.is_empty() {
            return Err("bytes after the message");
        }
        let field = |name: &str| {
            fields
                .iter()
                .rev()
                .find(|(k, _)| *k == name)
                .map(|(_, at)| *at)
        };
        let Some(version) = field("version").and_then(|at| int_at(&parts, at)) else {
            return Ok(None);
        };
        if index == 0 {
            first = version;
        } else if version != last + 1 {
            return Ok(None);
        }
        last = version;
        user = field("user");
        if field("fields").is_some() {
            // Field-level nodes (protocol 2) compose over the whole ones in the transport's `composeChanges`, which
            // reads them after this frame's text (frame-decoder.ts).
            return Ok(None);
        }
        if let (Some(client), Some(seq)) = (field("client"), field("seq")) {
            ops.push((client, seq, version));
        }
        let Some(patch) = field("patch") else {
            continue;
        };
        let mut r = Reader {
            bytes: &p.body[patch.offset..],
        };
        let Some(patch_tables) = entries(&mut r, p, index)? else {
            return Ok(None);
        };
        for (table, at) in patch_tables {
            if table == "pages" {
                // Replaced whole, at the place the table was first seen.
                let slot = match table_index.get(table) {
                    Some((slot, _)) => *slot,
                    None => {
                        tables.push((table, Vec::new()));
                        table_index.insert(table, (tables.len() - 1, Default::default()));
                        tables.len() - 1
                    }
                };
                pages = Some((slot, at));
                continue;
            }
            let mut r = Reader {
                bytes: &p.body[at.offset..],
            };
            // A table whose value is `null` adds no entries (Object.assign of null), but the table is there.
            let mut peek = Reader { bytes: r.bytes };
            let values = if peek.u32()? == 0 {
                Vec::new()
            } else {
                match entries(&mut r, p, index)? {
                    Some(values) => values,
                    None => return Ok(None),
                }
            };
            let (slot, index_of) = table_index.entry(table).or_insert_with(|| {
                tables.push((table, Vec::new()));
                (tables.len() - 1, Default::default())
            });
            let list = &mut tables[*slot].1;
            for (key, value) in values {
                match index_of.get(key) {
                    Some(&i) => list[i].1 = value,
                    None => {
                        index_of.insert(key, list.len());
                        list.push((key, value));
                    }
                }
            }
        }
    }
    let mut out = Vec::with_capacity(4096);
    out.extend_from_slice(br#"{"t":"changes","changes":[{"version":"#);
    write_int(last, &mut out);
    out.extend_from_slice(br#","first":"#);
    write_int(first, &mut out);
    out.extend_from_slice(br#","by":null"#);
    if let Some(user) = user {
        out.extend_from_slice(br#","user":"#);
        write_at(&parts, user, &mut out)?;
    }
    out.extend_from_slice(br#","patch":{"#);
    for (i, (table, values)) in tables.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        write_string(table, &mut out);
        out.push(b':');
        if *table == "pages" {
            let (_, at) = pages.expect("pages seen");
            write_at(&parts, at, &mut out)?;
            continue;
        }
        out.push(b'{');
        for (j, (key, value)) in values.iter().enumerate() {
            if j > 0 {
                out.push(b',');
            }
            write_string(key, &mut out);
            out.push(b':');
            write_at(&parts, *value, &mut out)?;
        }
        out.push(b'}');
    }
    out.extend_from_slice(br#"},"ops":["#);
    for (i, (client, seq, version)) in ops.iter().enumerate() {
        if i > 0 {
            out.push(b',');
        }
        out.extend_from_slice(br#"{"client":"#);
        write_at(&parts, *client, &mut out)?;
        out.extend_from_slice(br#","seq":"#);
        write_at(&parts, *seq, &mut out)?;
        out.extend_from_slice(br#","version":"#);
        write_int(*version, &mut out);
        out.push(b'}');
    }
    out.extend_from_slice(b"]}]}");
    String::from_utf8(out).map(Some).map_err(|_| "not UTF-8")
}

#[cfg(test)]
mod tests {
    use super::{composed, frame_text};
    use morfa_protocol::binary;

    /// Messages of every shape the wire carries: nesting, every scalar, escapes, repeated keys, big and fractional
    /// numbers, non-ASCII text.
    const MESSAGES: &[&str] = &[
        r#"{"t":"op","seq":3,"baseVersion":7,"patch":{"nodes":{"a":{"x":1.5,"name":"Слой"}}}}"#,
        r#"{"t":"pong"}"#,
        r#"{"t":"change","version":9007199254740991,"by":null,"user":"u","patch":{"pages":["p1","p2"],"nodes":{"b":null}}}"#,
        r#"{"t":"x","a":[],"o":{},"n":[-0.1,1e-7,123456789.125,-42,0,1e21,5e-324],"b":[true,false,null]}"#,
        r#"{"t":"s","s":"q\"b\\n\n\r\t\b\fcontrol\u0001\u001f /   😀 ё"}"#,
        r#"{"t":"deep","a":[[[[{"k":[{"k":[{"k":1}]}]}]]]]}"#,
    ];

    #[test]
    fn writes_what_frame_to_json_writes() {
        for json in MESSAGES {
            let frame = binary::json_to_frame(json).unwrap();
            assert_eq!(
                frame_text(&frame).unwrap(),
                binary::frame_to_json(&frame).unwrap(),
                "{json}"
            );
        }
        // Batches: presence and changes.
        let parts: Vec<Vec<u8>> = MESSAGES
            .iter()
            .map(|j| binary::json_to_frame(j).unwrap())
            .collect();
        for tag in [binary::PRESENCE, binary::CHANGES] {
            let mut frame = vec![tag, parts.len() as u8];
            for part in &parts {
                assert!(part.len() < 128);
                frame.push(part.len() as u8);
                frame.extend_from_slice(part);
            }
            assert_eq!(
                frame_text(&frame).unwrap(),
                binary::frame_to_json(&frame).unwrap()
            );
            assert_eq!(
                frame_text(&[tag, 0]).unwrap(),
                binary::frame_to_json(&[tag, 0]).unwrap()
            );
        }
    }

    fn batch(tag: u8, messages: &[String]) -> Vec<u8> {
        let mut frame = vec![tag];
        let varint = |mut n: usize, out: &mut Vec<u8>| {
            while n >= 0x80 {
                out.push((n as u8) | 0x80);
                n >>= 7;
            }
            out.push(n as u8);
        };
        varint(messages.len(), &mut frame);
        for json in messages {
            let part = binary::json_to_frame(json).unwrap_or_else(|e| panic!("{json}: {e:?}"));
            varint(part.len(), &mut frame);
            frame.extend_from_slice(&part);
        }
        frame
    }

    #[test]
    fn composes_consecutive_changes_and_leaves_the_rest() {
        let changes = [
            r#"{"t":"change","version":4,"by":"c2","user":"u2","patch":{"nodes":{"a":{"x":1},"b":{"x":2}},"pages":["p"]}}"#,
            r#"{"t":"change","version":5,"by":"c1","client":"me","seq":7,"user":"u1","patch":{"nodes":{"a":{"x":3},"c":null},"variables":{"v":1}}}"#,
            r#"{"t":"change","version":6,"by":"c2","user":"u3","patch":{"pages":["p","q"],"nodes":{"b":{"x":"ё\""}},"styles":null}}"#,
        ]
        .map(String::from);
        let text = composed(&batch(binary::CHANGES, &changes))
            .unwrap()
            .unwrap();
        assert_eq!(
            text,
            r#"{"t":"changes","changes":[{"version":6,"first":4,"by":null,"user":"u3","patch":{"nodes":{"a":{"x":3},"b":{"x":"ё\""},"c":null},"pages":["p","q"],"variables":{"v":1},"styles":{}},"ops":[{"client":"me","seq":7,"version":5}]}]}"#
        );
        // A gap, one change, a table that is not an object: not composed.
        assert!(
            composed(&batch(
                binary::CHANGES,
                &[changes[0].clone(), changes[2].clone()]
            ))
            .unwrap()
            .is_none()
        );
        assert!(
            composed(&batch(binary::CHANGES, &changes[..1]))
                .unwrap()
                .is_none()
        );
        let odd = r#"{"t":"change","version":5,"patch":{"nodes":[1]}}"#.to_owned();
        assert!(
            composed(&batch(binary::CHANGES, &[changes[0].clone(), odd]))
                .unwrap()
                .is_none()
        );
        // Field-level changes (protocol 2) are left to the transport's composer.
        let fields = r#"{"t":"change","version":5,"by":"c","user":"u","patch":{},"fields":{"a":{"set":{"x":2}}}}"#.to_owned();
        assert!(
            composed(&batch(binary::CHANGES, &[changes[0].clone(), fields]))
                .unwrap()
                .is_none()
        );
        // A damaged frame is an error, as decode_frame's.
        let mut bad = batch(binary::CHANGES, &changes);
        bad.truncate(bad.len() - 3);
        assert!(composed(&bad).is_err());
    }

    #[test]
    fn a_message_round_trips_through_the_edge() {
        let json = MESSAGES[0];
        let frame = binary::json_to_frame(json).unwrap();
        assert!(frame.len() < json.len());
        assert_eq!(frame_text(&frame).unwrap(), json);
    }

    #[test]
    fn refuses_what_frame_to_json_refuses() {
        let mut damaged: Vec<Vec<u8>> = vec![
            vec![],
            vec![0x00, 1, 2],
            vec![binary::MESSAGE],
            vec![binary::CHANGES],
            vec![binary::CHANGES, 1, 5, binary::MESSAGE],
        ];
        for json in MESSAGES {
            let frame = binary::json_to_frame(json).unwrap();
            // Every truncation, a byte too many, and every single byte flipped.
            for cut in 1..frame.len() {
                damaged.push(frame[..cut].to_vec());
            }
            let mut long = frame.clone();
            long.push(0);
            damaged.push(long);
            for at in 1..frame.len() {
                for flip in [0x01u8, 0x80, 0xff] {
                    let mut bad = frame.clone();
                    bad[at] ^= flip;
                    damaged.push(bad);
                }
            }
        }
        for frame in &damaged {
            match (frame_text(frame), binary::frame_to_json(frame)) {
                (Ok(fast), Ok(oracle)) => assert_eq!(fast, oracle, "{frame:?}"),
                (Err(_), Err(_)) => {}
                (fast, oracle) => panic!("{frame:?}: one pass {fast:?}, frame_to_json {oracle:?}"),
            }
        }
    }
}
