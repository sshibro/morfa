//! Reading and writing documents as JSON, the way the TypeScript does.
//!
//! Reading: `from_json` is the typed shape (serde with the strict rules of `de.rs`, unknown keys dropped as zod's
//! default `strip` does); `from_json_validated` adds every bound and invariant, so it accepts exactly what
//! `validateDocument` accepts. Writing: `to_json` writes numbers as JavaScript's `String(n)` does (`1`, not `1.0`).
//! The output equals `JSON.stringify` of the same document semantically; key order follows the struct (or the
//! map's order), not the TypeScript's object spreads, so it is not byte-identical.

use crate::de::Strict;
#[cfg(feature = "js-json-fallback")]
use crate::js_json;
use crate::js_number::{JsFormatter, JsPrettyFormatter};
use crate::patch::DocumentPatch;
use crate::types::DesignDocument;
use crate::validate::{Invalid, validate_document, validate_patch};
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::borrow::Cow;

/// The JSON of a value that does not fit the model's shape: serde's own message, no zod path.
fn shape_error(error: serde_json::Error) -> Invalid {
    Invalid::new(format!("Invalid value: {error}."), "")
}

fn parse<T: DeserializeOwned>(json: &str) -> Result<T, Invalid> {
    let text = replace_lone_surrogates(json);
    let mut deserializer = serde_json::Deserializer::from_str(&text);
    let fast = T::deserialize(Strict(&mut deserializer))
        .and_then(|value| deserializer.end().map(|()| value));
    match fast {
        Ok(value) => Ok(value),
        // serde_json refuses a few texts JSON.parse takes (a repeated key, a number beyond f64): read those again as
        // JSON.parse does. Only refused documents get here, so a valid one is read once.
        #[cfg(feature = "js-json-fallback")]
        Err(error) => {
            let tree = js_json::parse(json).map_err(|_| shape_error(error))?;
            T::deserialize(Strict(&tree))
                .map_err(|error| Invalid::new(format!("Invalid value: {error}."), ""))
        }
        // Without the fallback (the browser's shadow document, which only reads JSON.stringify's output): refused.
        #[cfg(not(feature = "js-json-fallback"))]
        Err(error) => Err(shape_error(error)),
    }
}

/// A document's typed shape, without bounds or invariants.
pub fn from_json(json: &str) -> Result<DesignDocument, Invalid> {
    parse(json)
}

/// A document exactly as `validateDocument` accepts it.
pub fn from_json_validated(json: &str) -> Result<DesignDocument, Invalid> {
    let doc = from_json(json)?;
    validate_document(&doc)?;
    Ok(doc)
}

/// A patch's typed shape.
pub fn patch_from_json(json: &str) -> Result<DocumentPatch, Invalid> {
    parse(json)
}

/// A patch's typed shape read from a deserializer positioned at it (a message envelope read in one pass), with the
/// strict rules of [`patch_from_json`]. An error is not final: the caller reads the patch's text again with
/// [`patch_from_json`], which also takes what only `JSON.parse` takes (a repeated key, a lone surrogate).
pub fn patch_from_deserializer<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<DocumentPatch, D::Error> {
    <DocumentPatch as serde::Deserialize>::deserialize(Strict(deserializer))
}

/// One field JavaScript set over a node the reader already holds ([`node_fields_from_json`]).
#[derive(Debug, Clone, PartialEq)]
pub enum NodeField {
    X(f64),
    Y(f64),
    Width(f64),
    Height(f64),
    Rotation(f64),
    Opacity(f64),
    Visible(bool),
    Name(String),
    Text(crate::types::TextProps),
    /// `text.characters` alone (the node has a text: the rest of it stays).
    Characters(String),
    Fills(Vec<crate::types::Paint>),
    Strokes(Vec<crate::types::Paint>),
    Effects(Vec<crate::types::Effect>),
}

/// The keys [`NodeField`] reads, as `SceneNode` names them in JSON.
pub const NODE_FIELD_KEYS: [&str; 13] = [
    "x",
    "y",
    "width",
    "height",
    "rotation",
    "opacity",
    "visible",
    "name",
    "text",
    "text.characters",
    "fills",
    "strokes",
    "effects",
];

impl NodeField {
    /// Sets the field on `node`; `false` for `Characters` on a node without a text (nothing set).
    pub fn apply(self, node: &mut crate::types::SceneNode) -> bool {
        match self {
            NodeField::Characters(value) => match node.text.as_mut() {
                Some(text) => text.characters = value,
                None => return false,
            },
            NodeField::X(value) => node.x = value,
            NodeField::Y(value) => node.y = value,
            NodeField::Width(value) => node.width = value,
            NodeField::Height(value) => node.height = value,
            NodeField::Rotation(value) => node.rotation = value,
            NodeField::Opacity(value) => node.opacity = value,
            NodeField::Visible(value) => node.visible = value,
            NodeField::Name(value) => node.name = value,
            NodeField::Text(value) => node.text = Some(value),
            NodeField::Fills(value) => node.fills = value,
            NodeField::Strokes(value) => node.strokes = value,
            NodeField::Effects(value) => node.effects = value,
        }
        true
    }
}

/// `{id: {key: value}}`: fields JavaScript set over nodes the reader holds (crates/wasm `MorfaDoc.normalize`, a
/// transaction's write that changed only [`NODE_FIELD_KEYS`] of a node crossing as those instead of the whole node).
/// Each value is read as `SceneNode`'s own reading reads that field, with the rules of [`patch_from_json`] (a
/// `null` is refused as there: every one of these fields is required or refuses `null`).
pub fn node_fields_from_json(
    json: &str,
) -> Result<Vec<(crate::types::NodeId, Vec<NodeField>)>, Invalid> {
    use serde::de::{self, MapAccess, Visitor};
    use std::fmt;

    struct Entries;
    struct Fields;

    impl<'de> Visitor<'de> for Entries {
        type Value = Vec<(crate::types::NodeId, Vec<NodeField>)>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("an object of node fields by id")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some(id) = map.next_key::<String>()? {
                out.push((id, map.next_value_seed(Fields)?));
            }
            Ok(out)
        }
    }

    impl<'de> de::DeserializeSeed<'de> for Fields {
        type Value = Vec<NodeField>;

        fn deserialize<D: serde::Deserializer<'de>>(
            self,
            deserializer: D,
        ) -> Result<Self::Value, D::Error> {
            deserializer.deserialize_map(self)
        }
    }

    impl<'de> Visitor<'de> for Fields {
        type Value = Vec<NodeField>;

        fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
            formatter.write_str("an object of node fields")
        }

        fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
            let mut out = Vec::new();
            while let Some(key) = map.next_key::<String>()? {
                out.push(match key.as_str() {
                    "x" => NodeField::X(map.next_value()?),
                    "y" => NodeField::Y(map.next_value()?),
                    "width" => NodeField::Width(map.next_value()?),
                    "height" => NodeField::Height(map.next_value()?),
                    "rotation" => NodeField::Rotation(map.next_value()?),
                    "opacity" => NodeField::Opacity(map.next_value()?),
                    "visible" => NodeField::Visible(map.next_value()?),
                    "name" => NodeField::Name(map.next_value()?),
                    "text" => NodeField::Text(map.next_value()?),
                    "text.characters" => NodeField::Characters(map.next_value()?),
                    "fills" => NodeField::Fills(map.next_value()?),
                    "strokes" => NodeField::Strokes(map.next_value()?),
                    "effects" => NodeField::Effects(map.next_value()?),
                    other => return Err(de::Error::unknown_field(other, &NODE_FIELD_KEYS)),
                });
            }
            Ok(out)
        }
    }

    let text = replace_lone_surrogates(json);
    let mut deserializer = serde_json::Deserializer::from_str(&text);
    let entries = serde::Deserializer::deserialize_map(Strict(&mut deserializer), Entries)
        .and_then(|value| deserializer.end().map(|()| value))
        .map_err(shape_error)?;
    Ok(entries)
}

/// A patch exactly as `validatePatch` accepts it.
pub fn patch_from_json_validated(json: &str) -> Result<DocumentPatch, Invalid> {
    let patch = patch_from_json(json)?;
    validate_patch(&patch)?;
    Ok(patch)
}

fn write<T: Serialize + ?Sized, F: serde_json::ser::Formatter>(value: &T, formatter: F) -> String {
    let mut out = Vec::with_capacity(4096);
    let mut serializer = serde_json::Serializer::with_formatter(&mut out, formatter);
    value
        .serialize(&mut serializer)
        .expect("the model always serializes");
    String::from_utf8(out).expect("serde_json writes UTF-8")
}

/// Compact JSON with JavaScript's number formatting.
pub fn to_json<T: Serialize + ?Sized>(value: &T) -> String {
    write(value, JsFormatter)
}

/// Indented JSON (two spaces, as `JSON.stringify(value, null, 2)`) with JavaScript's number formatting.
pub fn to_json_pretty<T: Serialize + ?Sized>(value: &T) -> String {
    write(value, JsPrettyFormatter::new())
}

/// `JSON.parse` keeps a lone UTF-16 surrogate (`"\ud800"`), which a Rust string cannot hold and serde_json refuses.
/// Each is read as U+FFFD instead: one UTF-16 unit like the surrogate, outside every id alphabet like it, so lengths
/// and verdicts stay the TypeScript's (the text itself differs, as the browser draws U+FFFD for it anyway).
fn replace_lone_surrogates(json: &str) -> Cow<'_, str> {
    let bytes = json.as_bytes();
    let escape_at = |at: usize| -> Option<u16> {
        if bytes.get(at) == Some(&b'\\') && bytes.get(at + 1) == Some(&b'u') {
            let hex = std::str::from_utf8(bytes.get(at + 2..at + 6)?).ok()?;
            u16::from_str_radix(hex, 16).ok()
        } else {
            None
        }
    };
    let mut out: Option<String> = None;
    let mut copied = 0;
    let mut at = 0;
    while let Some(offset) = json[at..].find('\\') {
        let start = at + offset;
        match escape_at(start) {
            Some(high @ 0xD800..=0xDBFF)
                if matches!(escape_at(start + 6), Some(0xDC00..=0xDFFF)) =>
            {
                let _ = high;
                at = start + 12;
            }
            Some(0xD800..=0xDFFF) => {
                let out = out.get_or_insert_with(|| String::with_capacity(json.len()));
                out.push_str(&json[copied..start]);
                out.push_str("\\ufffd");
                copied = start + 6;
                at = start + 6;
            }
            Some(_) => at = start + 6,
            // Any other escape is two characters: skip both, so an escaped backslash before `u` is not read as an escape.
            None => at = (start + 2).min(json.len()),
        }
    }
    match out {
        Some(mut out) => {
            out.push_str(&json[copied..]);
            Cow::Owned(out)
        }
        None => Cow::Borrowed(json),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_fields_read_as_the_node_reads_them() {
        let fields = node_fields_from_json(
            r#"{"a":{"width":12.5,"visible":false,"fills":[{"type":"SOLID","color":{"r":1,"g":0,"b":0},"opacity":1,"visible":true,"blendMode":"NORMAL"}]},"b":{"name":"n"}}"#,
        )
        .expect("fields");
        assert_eq!(fields.len(), 2);
        assert_eq!(fields[0].0, "a");
        assert_eq!(fields[0].1[0], NodeField::Width(12.5));
        assert_eq!(fields[0].1[1], NodeField::Visible(false));
        assert!(matches!(&fields[0].1[2], NodeField::Fills(fills) if fills.len() == 1));
        assert_eq!(fields[1].1, [NodeField::Name("n".to_owned())]);
        let characters =
            node_fields_from_json(r#"{"t":{"text.characters":"ab"}}"#).expect("characters");
        assert_eq!(characters[0].1, [NodeField::Characters("ab".to_owned())]);
        // What a node refuses, the fields refuse: null for a number, an unknown key, a paint without its type.
        assert!(node_fields_from_json(r#"{"a":{"x":null}}"#).is_err());
        assert!(node_fields_from_json(r#"{"a":{"locked":true}}"#).is_err());
        assert!(
            node_fields_from_json(r#"{"a":{"fills":[{"color":{"r":1,"g":0,"b":0}}]}}"#).is_err()
        );
        assert!(node_fields_from_json(r#"{"a":{"text":null}}"#).is_err());
    }

    #[test]
    fn lone_surrogates_become_replacement_characters() {
        // `e("d800")` is the six characters of a JSON escape; the backslash is spelled out to keep this file ASCII.
        let e = |hex: &str| format!("{}u{hex}", char::from(92));
        let replaced = |json: &str| replace_lone_surrogates(json).into_owned();
        assert_eq!(
            replaced(&format!("\"a{}b\"", e("d800"))),
            format!("\"a{}b\"", e("fffd"))
        );
        assert_eq!(
            replaced(&format!("\"{}\"", e("dc00"))),
            format!("\"{}\"", e("fffd"))
        );
        let pair = format!("{}{}", e("d83d"), e("de00"));
        assert_eq!(replaced(&format!("\"{pair}\"")), format!("\"{pair}\""));
        let escaped_backslash = format!("\"{}{}\"", char::from(92), e("d800"));
        assert_eq!(replaced(&escaped_backslash), escaped_backslash);
        assert_eq!(
            replaced(&format!("\"{}{pair}\"", e("d83d"))),
            format!("\"{}{pair}\"", e("fffd"))
        );
        assert!(matches!(
            replace_lone_surrogates(&format!("{{\"a\":\"{}n{}\"}}", char::from(92), e("0041"))),
            Cow::Borrowed(_)
        ));
        let doc: String = replaced(&format!("\"{}\"", e("d800")));
        assert_eq!(serde_json::from_str::<String>(&doc).unwrap(), "\u{fffd}");
    }
}
