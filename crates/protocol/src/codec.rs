//! Frames on the socket and the [`Codec`] that writes and reads them.
//!
//! The wire format is one choice behind one trait: [`JsonCodec`] writes text frames with the
//! model's JavaScript number formatting and reads ops through the model's strict reader, so a patch decodes
//! exactly as `validatePatch` reads it. TARGETS §3b picks the model's binary codec once `crates/model` exports one;
//! that lands as a second impl and [`Wire::DEFAULT`] moves to it, nothing else changes.
//!
//! Every message is an object whose first key is `t` (the tag). The server's reader takes the tag from the
//! frame's first bytes, so an `op` is scanned once for its envelope and parsed once for its patch.

use crate::{ClientMsg, Copies, ErrorCode, Op, Peer, PeerInfo, Seq, ServerMsg};
use bytes::{BufMut, Bytes, BytesMut};
use morfa_model::{JsFormatter, Map, SceneNode, patch_from_json};
use serde::Deserialize;
use serde::Serialize;
use serde_json::value::RawValue;
use std::fmt;

/// The kind of WebSocket frame a message travels in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrameKind {
    Text,
    Binary,
}

/// An encoded message: shared (`Bytes`) so one `change` is encoded once and queued to every peer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub kind: FrameKind,
    pub bytes: Bytes,
}

impl Frame {
    pub fn len(&self) -> usize {
        self.bytes.len()
    }
    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }
}

/// A message the reader refused. `seq` is set when the frame was an `op` whose envelope was readable, so the
/// server can answer `refused {seq}` instead of dropping it.
#[derive(Debug, Clone, PartialEq)]
pub struct DecodeError {
    pub code: ErrorCode,
    pub message: String,
    pub seq: Option<Seq>,
    pub path: Option<String>,
}

impl DecodeError {
    fn bad(message: impl fmt::Display) -> Self {
        DecodeError {
            code: ErrorCode::BadMessage,
            message: message.to_string(),
            seq: None,
            path: None,
        }
    }
}

impl fmt::Display for DecodeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}: {}", self.code, self.message)
    }
}

impl std::error::Error for DecodeError {}

/// The wire formats. `DEFAULT` is the one the server speaks unless the client asks for another in the upgrade
/// URL (`?wire=json`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Wire {
    Json,
    /// The JSON data model in postcard, stateless (crate::binary).
    Binary,
}

impl Wire {
    /// TARGETS §3b: JSON until S1's binary codec is exported by `crates/model`.
    pub const DEFAULT: Wire = Wire::Json;

    pub fn codec(self) -> &'static dyn Codec {
        match self {
            Wire::Json => &JsonCodec,
            Wire::Binary => &crate::binary::BinaryCodec,
        }
    }

    pub fn parse(name: &str) -> Option<Wire> {
        match name {
            "json" => Some(Wire::Json),
            "bin" => Some(Wire::Binary),
            _ => None,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Wire::Json => "json",
            Wire::Binary => "bin",
        }
    }
}

/// The same message as a frame of the other wire (a frame encoded for one wire, needed on the other).
pub fn transcode(frame: &Frame, to: Wire) -> Result<Frame, DecodeError> {
    let bad = |message: String| DecodeError {
        code: ErrorCode::BadMessage,
        message,
        seq: None,
        path: None,
    };
    match (frame.kind, to) {
        (FrameKind::Text, Wire::Json) | (FrameKind::Binary, Wire::Binary) => Ok(frame.clone()),
        (FrameKind::Binary, Wire::Json) => crate::binary::frame_to_json(&frame.bytes)
            .map(|text| text_frame(Bytes::from(text)))
            .map_err(|e| bad(e.0)),
        (FrameKind::Text, Wire::Binary) => {
            let text = std::str::from_utf8(&frame.bytes).map_err(|e| bad(e.to_string()))?;
            crate::binary::json_to_frame(text)
                .map(|bytes| Frame {
                    kind: FrameKind::Binary,
                    bytes: bytes.into(),
                })
                .map_err(|e| bad(e.0))
        }
    }
}

fn text_frame(bytes: Bytes) -> Frame {
    Frame {
        kind: FrameKind::Text,
        bytes,
    }
}

/// Encoding and decoding of both directions. Object-safe so the server picks one per connection.
pub trait Codec: Send + Sync {
    fn wire(&self) -> Wire;
    fn encode_server(&self, msg: &ServerMsg) -> Frame;
    fn decode_server(&self, bytes: &[u8]) -> Result<ServerMsg, DecodeError>;
    fn encode_client(&self, msg: &ClientMsg) -> Frame;
    fn decode_client(&self, bytes: &[u8]) -> Result<ClientMsg, DecodeError>;
    /// One peer of a `presence` frame, encoded once per change of that peer.
    fn encode_peer(&self, peer: &Peer) -> Bytes;
    /// A `presence` frame from peers encoded by [`Codec::encode_peer`] (a copy of their bytes, no re-encoding).
    fn presence_frame(&self, peers: &mut dyn Iterator<Item = &Bytes>) -> Frame;
    /// A `changes` frame from `change` frames this codec encoded (a copy of their bytes, no re-encoding).
    fn changes_frame(&self, changes: &mut dyn Iterator<Item = &Bytes>) -> Frame;
}

/// JSON text frames (the debug mode, and the default until the binary codec lands).
#[derive(Debug, Clone, Copy, Default)]
pub struct JsonCodec;

fn to_json_bytes<T: Serialize + ?Sized>(value: &T, capacity: usize) -> Bytes {
    // A Vec, not a BytesMut writer: serde_json writes in many small pieces, and a Vec takes them for less.
    let mut out = Vec::with_capacity(capacity);
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, JsFormatter);
    value
        .serialize(&mut serializer)
        .expect("protocol messages always serialize");
    out.into()
}

impl JsonCodec {
    /// The start of [`Codec::encode_peer`]'s text for a peer of `info`: `{"connection":…,"role":…`, without the
    /// presence and the closing brace. The presence hub keeps it while the peer's identity holds (TARGETS M10: the
    /// name and ids were most of each flush's encoding).
    pub fn peer_identity(info: &PeerInfo) -> Bytes {
        #[derive(Serialize)]
        struct Identity<'a> {
            connection: &'a str,
            user: &'a str,
            name: &'a str,
            color: u32,
            role: crate::Role,
        }
        let mut text = to_json_bytes(
            &Identity {
                connection: &info.connection,
                user: &info.user,
                name: &info.name,
                color: info.color,
                role: info.role,
            },
            128,
        )
        .to_vec();
        text.pop();
        text.into()
    }

    /// [`Codec::encode_peer`] of the peer whose [`JsonCodec::peer_identity`] is `identity`, with `presence`: the same
    /// bytes. The presence's keys are written as they are; its values through serde_json, as `Peer` writes them.
    pub fn peer_with(identity: &[u8], presence: &crate::Presence) -> Bytes {
        fn value<T: Serialize + ?Sized>(out: &mut Vec<u8>, value: &T) {
            value
                .serialize(&mut serde_json::Serializer::with_formatter(
                    &mut *out,
                    JsFormatter,
                ))
                .expect("presence always serializes");
        }
        // Every field by name: a new one does not compile until it is written here too.
        let crate::Presence {
            cursor,
            page,
            selection,
            selection_count,
            viewport,
            editing,
            meeting,
        } = presence;
        let mut out = Vec::with_capacity(identity.len() + 160);
        out.extend_from_slice(identity);
        out.extend_from_slice(b",\"cursor\":");
        match cursor {
            Some(cursor) => {
                out.extend_from_slice(b"{\"x\":");
                value(&mut out, &cursor.x);
                out.extend_from_slice(b",\"y\":");
                value(&mut out, &cursor.y);
                out.push(b'}');
            }
            None => out.extend_from_slice(b"null"),
        }
        out.extend_from_slice(b",\"page\":");
        value(&mut out, page);
        out.extend_from_slice(b",\"selection\":");
        value(&mut out, selection);
        out.extend_from_slice(b",\"selectionCount\":");
        value(&mut out, selection_count);
        out.extend_from_slice(b",\"viewport\":");
        value(&mut out, viewport);
        out.extend_from_slice(b",\"editing\":");
        value(&mut out, editing);
        if let Some(meeting) = meeting {
            out.extend_from_slice(b",\"meeting\":");
            value(&mut out, meeting);
        }
        out.push(b'}');
        out.into()
    }
}

fn text(bytes: Bytes) -> Frame {
    Frame {
        kind: FrameKind::Text,
        bytes,
    }
}

/// The envelope of an `op`: the patch and the copies stay unparsed until the strict reader takes them.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpEnvelope<'a> {
    #[allow(dead_code)]
    t: &'a str,
    seq: Seq,
    base_version: u64,
    #[serde(borrow)]
    patch: &'a RawValue,
    #[serde(borrow, default)]
    before: Option<&'a RawValue>,
    #[serde(borrow, default)]
    before_tables: Option<&'a RawValue>,
    #[serde(default)]
    fields: Option<crate::OpFields>,
}

/// The tag when it is the first key (`{"t":"op",…`), as every encoder of this protocol writes it.
fn leading_tag(bytes: &[u8]) -> Option<&[u8]> {
    let rest = bytes.trim_ascii_start().strip_prefix(b"{")?;
    let rest = rest.trim_ascii_start().strip_prefix(b"\"t\"")?;
    let rest = rest.trim_ascii_start().strip_prefix(b":")?;
    let rest = rest.trim_ascii_start().strip_prefix(b"\"")?;
    let end = rest.iter().position(|&b| b == b'"' || b == b'\\')?;
    (rest[end] == b'"').then_some(&rest[..end])
}

fn invalid(seq: Seq, error: morfa_model::Invalid, prefix: &str) -> DecodeError {
    DecodeError {
        code: ErrorCode::DesignDocumentInvalid,
        message: error.message,
        seq: Some(seq),
        path: Some(if error.path.is_empty() {
            prefix.to_owned()
        } else {
            format!("{prefix}.{}", error.path)
        }),
    }
}

/// Reads an op's `before` copies (a node table) as a patch's `nodes`, with the same strict reader.
pub(crate) fn read_copies(raw: &str, seq: Seq) -> Result<Map<Option<SceneNode>>, DecodeError> {
    let wrapped = format!("{{\"nodes\":{raw}}}");
    let nodes = patch_from_json(&wrapped)
        .map_err(|e| invalid(seq, e, "before"))?
        .nodes;
    Ok(nodes.unwrap_or_default())
}

/// An `op` read in one pass: the patch straight from the frame with the model's strict reader, the copies kept raw.
/// None when anything is off (a missing or repeated key, a patch the strict reader refuses, a lone surrogate):
/// [`decode_op_buffered`] then reads the frame and gives its answer, so both readers accept the same frames with
/// the same values.
fn decode_op_direct(bytes: &[u8]) -> Option<Op> {
    struct Envelope;

    impl<'de> serde::de::Visitor<'de> for Envelope {
        type Value = Op;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("an op")
        }

        fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Op, A::Error> {
            use serde::de::Error;
            struct Patch;
            impl<'de> serde::de::DeserializeSeed<'de> for Patch {
                type Value = morfa_model::DocumentPatch;
                fn deserialize<D: serde::Deserializer<'de>>(
                    self,
                    deserializer: D,
                ) -> Result<Self::Value, D::Error> {
                    morfa_model::patch_from_deserializer(deserializer)
                }
            }
            let (mut t, mut seq, mut base_version, mut patch) = (false, None, None, None);
            let (mut before, mut before_tables, mut fields) = (None, None, None);
            let repeated = || A::Error::custom("a repeated key");
            while let Some(key) = map.next_key::<&str>()? {
                match key {
                    "t" if !t => {
                        map.next_value::<&str>()?;
                        t = true;
                    }
                    "seq" if seq.is_none() => seq = Some(map.next_value::<Seq>()?),
                    "baseVersion" if base_version.is_none() => {
                        base_version = Some(map.next_value::<u64>()?)
                    }
                    "patch" if patch.is_none() => patch = Some(map.next_value_seed(Patch)?),
                    "before" if before.is_none() => {
                        before = Some(map.next_value::<Option<&'de RawValue>>()?)
                    }
                    "beforeTables" if before_tables.is_none() => {
                        before_tables = Some(map.next_value::<Option<&'de RawValue>>()?)
                    }
                    "fields" if fields.is_none() => {
                        fields = Some(map.next_value::<Option<crate::OpFields>>()?)
                    }
                    "t" | "seq" | "baseVersion" | "patch" | "before" | "beforeTables"
                    | "fields" => {
                        return Err(repeated());
                    }
                    _ => {
                        map.next_value::<serde::de::IgnoredAny>()?;
                    }
                }
            }
            let (true, Some(seq), Some(base_version), Some(patch)) = (t, seq, base_version, patch)
            else {
                return Err(A::Error::custom("a missing key"));
            };
            let before = match before.flatten() {
                Some(raw) if raw.get() != "null" => Some(Copies::Raw(raw.to_owned())),
                _ => None,
            };
            let before_tables = match before_tables.flatten() {
                Some(raw) if raw.get() != "null" => {
                    Some(patch_from_json(raw.get()).map_err(|_| A::Error::custom("beforeTables"))?)
                }
                _ => None,
            };
            Ok(Op {
                seq,
                base_version,
                patch,
                before,
                before_tables,
                fields: fields.flatten(),
            })
        }
    }

    // Checked once here (a text frame is UTF-8 already): reading from bytes checks every string again.
    let text = std::str::from_utf8(bytes).ok()?;
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let op = serde::Deserializer::deserialize_map(&mut deserializer, Envelope).ok()?;
    deserializer.end().ok()?;
    Some(op)
}

/// A `presence` (its `t` the first key, as `leading_tag` found it) read straight into the update, without the buffer
/// serde's internally tagged enums read through (TARGETS M10: 30 of them a second per cursor). None when anything is
/// off (a repeated key, an escaped key, a wrong value): the tagged reader then answers, so both accept the same
/// frames with the same values.
fn decode_presence_direct(bytes: &[u8]) -> Option<crate::PresenceUpdate> {
    use serde::de::{DeserializeSeed, Error, IgnoredAny, MapAccess};

    /// The message's keys after its tag; the tag again is refused.
    struct AfterTag<A>(A);

    impl<'de, A: MapAccess<'de>> MapAccess<'de> for AfterTag<A> {
        type Error = A::Error;

        fn next_key_seed<K: DeserializeSeed<'de>>(
            &mut self,
            seed: K,
        ) -> Result<Option<K::Value>, A::Error> {
            match self.0.next_key::<&'de str>()? {
                None => Ok(None),
                Some("t") => Err(A::Error::custom("a repeated tag")),
                Some(key) => seed
                    .deserialize(serde::de::value::BorrowedStrDeserializer::new(key))
                    .map(Some),
            }
        }

        fn next_value_seed<V: DeserializeSeed<'de>>(
            &mut self,
            seed: V,
        ) -> Result<V::Value, A::Error> {
            self.0.next_value_seed(seed)
        }
    }

    struct Message;

    impl<'de> serde::de::Visitor<'de> for Message {
        type Value = crate::PresenceUpdate;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("a presence")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            if map.next_key::<&str>()? != Some("t") {
                return Err(A::Error::custom("not the tag first"));
            }
            map.next_value::<IgnoredAny>()?;
            crate::PresenceUpdate::deserialize(serde::de::value::MapAccessDeserializer::new(
                AfterTag(map),
            ))
        }
    }

    let text = std::str::from_utf8(bytes).ok()?;
    let mut deserializer = serde_json::Deserializer::from_str(text);
    let update = serde::Deserializer::deserialize_map(&mut deserializer, Message).ok()?;
    deserializer.end().ok()?;
    Some(update)
}

/// Reads an `op` with the model's strict reader (the patch exactly as `validatePatch` reads its shape).
fn decode_op(bytes: &[u8]) -> Result<Op, DecodeError> {
    match decode_op_direct(bytes) {
        Some(op) => Ok(op),
        None => decode_op_buffered(bytes),
    }
}

/// The envelope first, then the patch from its text (errors name the op's `seq` and the patch's path).
fn decode_op_buffered(bytes: &[u8]) -> Result<Op, DecodeError> {
    let envelope: OpEnvelope = serde_json::from_slice(bytes).map_err(DecodeError::bad)?;
    let seq = envelope.seq;
    let patch = patch_from_json(envelope.patch.get()).map_err(|e| invalid(seq, e, "patch"))?;
    let before = match envelope.before {
        Some(raw) if raw.get() != "null" => Some(Copies::Raw(raw.to_owned())),
        _ => None,
    };
    let before_tables = match envelope.before_tables {
        Some(raw) if raw.get() != "null" => {
            Some(patch_from_json(raw.get()).map_err(|e| invalid(seq, e, "beforeTables"))?)
        }
        _ => None,
    };
    Ok(Op {
        seq,
        base_version: envelope.base_version,
        patch,
        before,
        before_tables,
        fields: envelope.fields,
    })
}

impl Codec for JsonCodec {
    fn wire(&self) -> Wire {
        Wire::Json
    }

    fn encode_server(&self, msg: &ServerMsg) -> Frame {
        let capacity = match msg {
            ServerMsg::Change(_) | ServerMsg::Changes { .. } | ServerMsg::Welcome(_) => 16 * 1024,
            ServerMsg::Document { .. } => 1024 * 1024,
            _ => 128,
        };
        text(to_json_bytes(msg, capacity))
    }

    fn decode_server(&self, bytes: &[u8]) -> Result<ServerMsg, DecodeError> {
        serde_json::from_slice(bytes).map_err(DecodeError::bad)
    }

    fn encode_client(&self, msg: &ClientMsg) -> Frame {
        let capacity = if matches!(msg, ClientMsg::Op(_)) {
            16 * 1024
        } else {
            256
        };
        text(to_json_bytes(msg, capacity))
    }

    fn decode_client(&self, bytes: &[u8]) -> Result<ClientMsg, DecodeError> {
        match leading_tag(bytes) {
            Some(b"op") => decode_op(bytes).map(|op| ClientMsg::Op(Box::new(op))),
            Some(b"ping") => Ok(ClientMsg::Ping),
            Some(b"presence") => match decode_presence_direct(bytes) {
                Some(update) => Ok(ClientMsg::Presence(update)),
                None => serde_json::from_slice(bytes).map_err(DecodeError::bad),
            },
            Some(_) => serde_json::from_slice(bytes).map_err(DecodeError::bad),
            // A hand-written frame with `t` elsewhere: find the tag the slow way.
            None => {
                #[derive(Deserialize)]
                struct Tag<'a> {
                    #[serde(borrow)]
                    t: std::borrow::Cow<'a, str>,
                }
                let tag: Tag = serde_json::from_slice(bytes).map_err(DecodeError::bad)?;
                if tag.t == "op" {
                    decode_op(bytes).map(|op| ClientMsg::Op(Box::new(op)))
                } else {
                    serde_json::from_slice(bytes).map_err(DecodeError::bad)
                }
            }
        }
    }

    fn encode_peer(&self, peer: &Peer) -> Bytes {
        to_json_bytes(peer, 256)
    }

    fn presence_frame(&self, peers: &mut dyn Iterator<Item = &Bytes>) -> Frame {
        let mut out = BytesMut::with_capacity(1024);
        out.put_slice(b"{\"t\":\"presence\",\"peers\":[");
        let mut first = true;
        for peer in peers {
            if !first {
                out.put_u8(b',');
            }
            first = false;
            out.put_slice(peer);
        }
        out.put_slice(b"]}");
        text(out.freeze())
    }

    fn changes_frame(&self, changes: &mut dyn Iterator<Item = &Bytes>) -> Frame {
        // Each item is a whole `{"t":"change",…}` object: readers of `Change` skip the extra `t`.
        let mut out = BytesMut::with_capacity(64 * 1024);
        out.put_slice(b"{\"t\":\"changes\",\"changes\":[");
        let mut first = true;
        for change in changes {
            if !first {
                out.put_u8(b',');
            }
            first = false;
            out.put_slice(change);
        }
        out.put_slice(b"]}");
        text(out.freeze())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_tag_reads_the_first_key_only() {
        assert_eq!(leading_tag(br#"{"t":"op","seq":1}"#), Some(&b"op"[..]));
        assert_eq!(leading_tag(br#" { "t" : "ping" }"#), Some(&b"ping"[..]));
        assert_eq!(leading_tag(br#"{"seq":1,"t":"op"}"#), None);
        assert_eq!(leading_tag(br#"{"t":"o\"p"}"#), None);
    }

    #[test]
    fn ops_read_in_one_pass_as_through_the_envelope() {
        let rect = r#"{"id":"r","type":"RECTANGLE","name":"R","parentId":"p","visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":1,"y":2,"width":3,"height":4,"rotation":0,"fills":[{"type":"SOLID","color":{"r":1,"g":0,"b":0},"opacity":1,"visible":true,"blendMode":"NORMAL"}],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[]}"#;
        let frames = [
            format!(r#"{{"t":"op","seq":3,"baseVersion":7,"patch":{{"nodes":{{"r":{rect}}}}}}}"#),
            format!(
                r#"{{"t":"op","seq":3,"baseVersion":7,"patch":{{"nodes":{{"r":{rect},"q":null}}}},"before":{{"r":{rect}}},"x":[1]}}"#
            ),
            format!(
                r#"{{"patch":{{"nodes":{{"r":{rect}}}}},"before":null,"beforeTables":{{"pages":["p"]}},"baseVersion":7,"t":"op","seq":3}}"#
            ),
        ];
        for frame in &frames {
            let direct = decode_op_direct(frame.as_bytes()).expect("one pass reads it");
            let buffered = decode_op_buffered(frame.as_bytes()).unwrap();
            assert_eq!(
                serde_json::to_string(&direct).unwrap(),
                serde_json::to_string(&buffered).unwrap()
            );
        }
        // Anything off goes to the envelope reader, which gives the error with the op's seq and the path.
        let bad = [
            format!(
                r#"{{"t":"op","seq":3,"baseVersion":7,"patch":{{"nodes":{{"r":{}}}}}}}"#,
                rect.replace(r#""x":1"#, r#""x":"1""#)
            ),
            r#"{"t":"op","seq":3,"seq":4,"baseVersion":7,"patch":{}}"#.to_owned(),
            r#"{"t":"op","seq":3,"patch":{}}"#.to_owned(),
            r#"{"t":"op","seq":3,"baseVersion":7,"patch":{"nodes":{"r\ud800":null}}}"#.to_owned(),
        ];
        for frame in &bad {
            assert!(decode_op_direct(frame.as_bytes()).is_none(), "{frame}");
        }
        let error = decode_op(bad[0].as_bytes()).unwrap_err();
        assert_eq!((error.seq, error.path.as_deref()), (Some(3), Some("patch")));
    }

    #[test]
    fn presence_reads_directly_as_through_the_tagged_reader() {
        let frames = [
            r#"{"t":"presence","cursor":{"x":1.5,"y":-2}}"#,
            r#"{"t":"presence","cursor":null,"page":"p1","selection":["a","b"],"selectionCount":2}"#,
            r#"{"t":"presence","viewport":{"x":0,"y":0,"zoom":1,"width":800,"height":600},"editing":null}"#,
            r#"{"t":"presence","meeting":{"chat":"привет","emote":{"id":"wave","n":3},"wave":null,"spotlight":1}}"#,
            r#"{"t":"presence","meeting":null,"unknown":[1,{"x":2}]}"#,
            r#"{"t":"presence"}"#,
            r#"{"t":"presence","cursor":{"x":1,"y":2},"cursor":{"x":3,"y":4}}"#,
            r#"{"t":"presence","t":"presence","cursor":null}"#,
            r#"{"t":"presence","cursor":{"x":"1","y":2}}"#,
            r#"{"t":"presence","selectionCount":-1}"#,
            r#"{"t":"presence","selection":"a"}"#,
            r#"{"t":"presence","cursor":{"x":1,"y":2}} x"#,
            r#"{"t":"presence","c\u0075rsor":{"x":1,"y":2}}"#,
        ];
        let mut direct_count = 0;
        for frame in frames {
            let tagged = serde_json::from_slice::<ClientMsg>(frame.as_bytes());
            match decode_presence_direct(frame.as_bytes()) {
                Some(update) => {
                    direct_count += 1;
                    assert_eq!(
                        tagged.as_ref().unwrap(),
                        &ClientMsg::Presence(update),
                        "{frame}"
                    );
                }
                None => assert!(
                    tagged.is_err() || frame.contains('\\'),
                    "{frame}: refused directly, read tagged"
                ),
            }
            assert_eq!(
                JsonCodec.decode_client(frame.as_bytes()).ok(),
                tagged.ok(),
                "{frame}"
            );
        }
        assert_eq!(direct_count, 6);
    }

    #[test]
    fn peers_spliced_from_their_identity_are_the_same_bytes() {
        use crate::{MeetingEmote, MeetingPresence, Presence, Role, Viewport};
        let info = PeerInfo {
            connection: "c0ffee".into(),
            user: "u\"1".into(),
            name: "Участник “1”".into(),
            color: 3,
            role: Role::Editor,
        };
        let presences = [
            Presence::default(),
            Presence {
                cursor: Some(morfa_model::Vec2 { x: 1.5, y: -0.0 }),
                page: Some("p".into()),
                selection: vec!["a".into(), "b".into()],
                selection_count: 2,
                viewport: Some(Viewport {
                    x: 0.1,
                    y: 1e21,
                    zoom: 1.0,
                    width: 800.0,
                    height: 600.0,
                }),
                editing: Some("t".into()),
                meeting: Some(MeetingPresence {
                    chat: Some("hi".into()),
                    emote: Some(MeetingEmote {
                        id: "wave".into(),
                        n: 2.0,
                    }),
                    wave: None,
                    spotlight: Some(5.0),
                }),
            },
        ];
        let identity = JsonCodec::peer_identity(&info);
        for presence in presences {
            let peer = Peer {
                connection: info.connection.clone(),
                user: info.user.clone(),
                name: info.name.clone(),
                color: info.color,
                role: info.role,
                presence: presence.clone(),
            };
            assert_eq!(
                JsonCodec::peer_with(&identity, &presence),
                JsonCodec.encode_peer(&peer)
            );
        }
    }
}
