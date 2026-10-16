//! JSON read exactly as JavaScript's `JSON.parse` reads it, for the documents serde_json's fast reader refuses.
//!
//! Two inputs that `JSON.parse` takes and serde_json does not:
//! - A key repeated in one object: `JSON.parse` keeps the last value at the first key's position; serde's derived
//!   structs refuse a duplicate field.
//! - A number beyond `f64` (`1e400`): `JSON.parse` reads ±Infinity, which zod then refuses in a known field but drops
//!   with an unknown key; serde_json refuses the number wherever it stands.
//!
//! `json.rs` reads every document with serde_json first and comes here only when that fails, so a valid document never
//! pays for this. The tree keeps each object's keys in first-seen order and each number as the double `JSON.parse`
//! makes of it; [`Tree`] is a serde `Deserializer` the model's strict reader runs over. Lone UTF-16 surrogates become
//! U+FFFD here too, as in the fast path.

use indexmap::IndexMap;
use serde::de::{
    self, DeserializeSeed, Deserializer, IntoDeserializer, MapAccess, SeqAccess, Visitor,
};
use std::fmt;

/// One JSON value as `JSON.parse` builds it.
#[derive(Debug, Clone, PartialEq)]
pub enum Tree {
    Null,
    Bool(bool),
    Number(f64),
    String(String),
    Array(Vec<Tree>),
    Object(IndexMap<String, Tree>),
}

/// Why a text is not JSON.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SyntaxError {
    pub message: &'static str,
    pub offset: usize,
}

impl fmt::Display for SyntaxError {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        write!(formatter, "{} at byte {}", self.message, self.offset)
    }
}

/// Values nested deeper than this are checked for syntax without recursion and kept as `null`: nothing the schema
/// reads is deeper than a dozen levels, so only stripped keys reach here, and `JSON.parse` takes any depth.
const TREE_DEPTH: usize = 64;

/// Parses `text` as `JSON.parse` does.
pub fn parse(text: &str) -> Result<Tree, SyntaxError> {
    let mut parser = Parser {
        bytes: text.as_bytes(),
        at: 0,
    };
    parser.whitespace();
    let tree = parser.value(0)?;
    parser.whitespace();
    if parser.at != parser.bytes.len() {
        return Err(parser.error("unexpected text after the value"));
    }
    Ok(tree)
}

struct Parser<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl Parser<'_> {
    fn error(&self, message: &'static str) -> SyntaxError {
        SyntaxError {
            message,
            offset: self.at,
        }
    }

    fn peek(&self) -> Option<u8> {
        self.bytes.get(self.at).copied()
    }

    fn whitespace(&mut self) {
        while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.peek() {
            self.at += 1;
        }
    }

    fn literal(&mut self, word: &[u8], tree: Tree) -> Result<Tree, SyntaxError> {
        if self.bytes[self.at..].starts_with(word) {
            self.at += word.len();
            Ok(tree)
        } else {
            Err(self.error("unexpected character"))
        }
    }

    fn value(&mut self, depth: usize) -> Result<Tree, SyntaxError> {
        if depth > TREE_DEPTH {
            self.skip()?;
            return Ok(Tree::Null);
        }
        match self.peek() {
            Some(b'{') => self.object(depth),
            Some(b'[') => self.array(depth),
            Some(b'"') => self.string().map(Tree::String),
            Some(b't') => self.literal(b"true", Tree::Bool(true)),
            Some(b'f') => self.literal(b"false", Tree::Bool(false)),
            Some(b'n') => self.literal(b"null", Tree::Null),
            Some(b'-' | b'0'..=b'9') => self.number(),
            Some(_) => Err(self.error("unexpected character")),
            None => Err(self.error("unexpected end")),
        }
    }

    /// Checks one value's syntax without building it, iteratively (any depth).
    fn skip(&mut self) -> Result<(), SyntaxError> {
        let mut open: Vec<u8> = Vec::new();
        loop {
            self.whitespace();
            match self.peek() {
                Some(b'{') => {
                    self.at += 1;
                    self.whitespace();
                    if self.peek() == Some(b'}') {
                        self.at += 1;
                    } else {
                        open.push(b'{');
                        self.key()?;
                        continue;
                    }
                }
                Some(b'[') => {
                    self.at += 1;
                    self.whitespace();
                    if self.peek() == Some(b']') {
                        self.at += 1;
                    } else {
                        open.push(b'[');
                        continue;
                    }
                }
                Some(b'"') => {
                    self.string()?;
                }
                Some(b't') => {
                    self.literal(b"true", Tree::Null)?;
                }
                Some(b'f') => {
                    self.literal(b"false", Tree::Null)?;
                }
                Some(b'n') => {
                    self.literal(b"null", Tree::Null)?;
                }
                Some(b'-' | b'0'..=b'9') => {
                    self.number()?;
                }
                Some(_) => return Err(self.error("unexpected character")),
                None => return Err(self.error("unexpected end")),
            }
            // After a value: close what ends here, or move to the next item.
            loop {
                self.whitespace();
                let Some(&container) = open.last() else {
                    return Ok(());
                };
                match (container, self.peek()) {
                    (_, Some(b',')) => {
                        self.at += 1;
                        if container == b'{' {
                            self.key()?;
                        }
                        break;
                    }
                    (b'[', Some(b']')) | (b'{', Some(b'}')) => {
                        self.at += 1;
                        open.pop();
                    }
                    _ => return Err(self.error("expected ',' or the end of a list or object")),
                }
            }
        }
    }

    /// `"key":` inside an object being skipped.
    fn key(&mut self) -> Result<(), SyntaxError> {
        self.whitespace();
        if self.peek() != Some(b'"') {
            return Err(self.error("expected a key"));
        }
        self.string()?;
        self.whitespace();
        if self.peek() != Some(b':') {
            return Err(self.error("expected ':'"));
        }
        self.at += 1;
        Ok(())
    }

    fn object(&mut self, depth: usize) -> Result<Tree, SyntaxError> {
        self.at += 1;
        let mut map = IndexMap::new();
        self.whitespace();
        if self.peek() == Some(b'}') {
            self.at += 1;
            return Ok(Tree::Object(map));
        }
        loop {
            self.whitespace();
            if self.peek() != Some(b'"') {
                return Err(self.error("expected a key"));
            }
            let key = self.string()?;
            self.whitespace();
            if self.peek() != Some(b':') {
                return Err(self.error("expected ':'"));
            }
            self.at += 1;
            self.whitespace();
            let value = self.value(depth + 1)?;
            // A repeated key keeps its first position and takes the last value, as JSON.parse does.
            map.insert(key, value);
            self.whitespace();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b'}') => {
                    self.at += 1;
                    return Ok(Tree::Object(map));
                }
                _ => return Err(self.error("expected ',' or '}'")),
            }
        }
    }

    fn array(&mut self, depth: usize) -> Result<Tree, SyntaxError> {
        self.at += 1;
        let mut items = Vec::new();
        self.whitespace();
        if self.peek() == Some(b']') {
            self.at += 1;
            return Ok(Tree::Array(items));
        }
        loop {
            self.whitespace();
            items.push(self.value(depth + 1)?);
            self.whitespace();
            match self.peek() {
                Some(b',') => self.at += 1,
                Some(b']') => {
                    self.at += 1;
                    return Ok(Tree::Array(items));
                }
                _ => return Err(self.error("expected ',' or ']'")),
            }
        }
    }

    fn digits(&mut self) -> usize {
        let start = self.at;
        while let Some(b'0'..=b'9') = self.peek() {
            self.at += 1;
        }
        self.at - start
    }

    /// `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`, read as the nearest double (±Infinity beyond the range).
    fn number(&mut self) -> Result<Tree, SyntaxError> {
        let start = self.at;
        if self.peek() == Some(b'-') {
            self.at += 1;
        }
        match self.peek() {
            Some(b'0') => self.at += 1,
            Some(b'1'..=b'9') => {
                self.digits();
            }
            _ => return Err(self.error("expected a digit")),
        }
        if self.peek() == Some(b'.') {
            self.at += 1;
            if self.digits() == 0 {
                return Err(self.error("expected a digit"));
            }
        }
        if let Some(b'e' | b'E') = self.peek() {
            self.at += 1;
            if let Some(b'+' | b'-') = self.peek() {
                self.at += 1;
            }
            if self.digits() == 0 {
                return Err(self.error("expected a digit"));
            }
        }
        let text = std::str::from_utf8(&self.bytes[start..self.at]).expect("ASCII digits");
        // Rust's float parsing is correctly rounded and overflows to ±Infinity, as ECMAScript's does.
        text.parse::<f64>()
            .map(Tree::Number)
            .map_err(|_| SyntaxError {
                message: "bad number",
                offset: start,
            })
    }

    fn hex4(&mut self) -> Result<u16, SyntaxError> {
        let digits = self
            .bytes
            .get(self.at..self.at + 4)
            .ok_or_else(|| self.error("short \\u escape"))?;
        let text = std::str::from_utf8(digits).map_err(|_| self.error("bad \\u escape"))?;
        let value = u16::from_str_radix(text, 16).map_err(|_| self.error("bad \\u escape"))?;
        if !digits.iter().all(u8::is_ascii_hexdigit) {
            return Err(self.error("bad \\u escape"));
        }
        self.at += 4;
        Ok(value)
    }

    fn string(&mut self) -> Result<String, SyntaxError> {
        self.at += 1;
        let mut out = String::new();
        loop {
            let start = self.at;
            while let Some(byte) = self.peek() {
                if byte == b'"' || byte == b'\\' || byte < 0x20 {
                    break;
                }
                self.at += 1;
            }
            // The input is a &str, so any run of non-special bytes is valid UTF-8.
            out.push_str(std::str::from_utf8(&self.bytes[start..self.at]).expect("UTF-8 input"));
            match self.peek() {
                Some(b'"') => {
                    self.at += 1;
                    return Ok(out);
                }
                Some(b'\\') => {
                    self.at += 1;
                    let escape = self.peek().ok_or_else(|| self.error("unexpected end"))?;
                    self.at += 1;
                    match escape {
                        b'"' => out.push('"'),
                        b'\\' => out.push('\\'),
                        b'/' => out.push('/'),
                        b'b' => out.push('\u{8}'),
                        b'f' => out.push('\u{c}'),
                        b'n' => out.push('\n'),
                        b'r' => out.push('\r'),
                        b't' => out.push('\t'),
                        b'u' => {
                            let unit = self.hex4()?;
                            out.push(self.code_point(unit)?);
                        }
                        _ => return Err(self.error("bad escape")),
                    }
                }
                Some(_) => return Err(self.error("control character in a string")),
                None => return Err(self.error("unterminated string")),
            }
        }
    }

    /// One `\u` escape, joined with the next one when they form a surrogate pair; a lone surrogate is U+FFFD.
    fn code_point(&mut self, unit: u16) -> Result<char, SyntaxError> {
        match unit {
            0xD800..=0xDBFF => {
                if self.bytes[self.at..].starts_with(b"\\u") {
                    let save = self.at;
                    self.at += 2;
                    let low = self.hex4()?;
                    if (0xDC00..=0xDFFF).contains(&low) {
                        let value = 0x10000
                            + ((u32::from(unit) - 0xD800) << 10)
                            + (u32::from(low) - 0xDC00);
                        return Ok(char::from_u32(value).expect("a surrogate pair is a code point"));
                    }
                    self.at = save;
                }
                Ok('\u{FFFD}')
            }
            0xDC00..=0xDFFF => Ok('\u{FFFD}'),
            _ => Ok(char::from_u32(u32::from(unit)).expect("not a surrogate")),
        }
    }
}

// ── The tree as a serde Deserializer ─────────────────────────────────────────────────────────────

/// Errors of reading a model value from a [`Tree`].
#[derive(Debug)]
pub struct TreeError(String);

impl fmt::Display for TreeError {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for TreeError {}

impl de::Error for TreeError {
    fn custom<T: fmt::Display>(message: T) -> Self {
        TreeError(message.to_string())
    }
}

impl<'de> Deserializer<'de> for &'de Tree {
    type Error = TreeError;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TreeError> {
        match self {
            Tree::Null => visitor.visit_unit(),
            Tree::Bool(value) => visitor.visit_bool(*value),
            Tree::Number(value) => visitor.visit_f64(*value),
            Tree::String(value) => visitor.visit_borrowed_str(value),
            Tree::Array(items) => visit_items(items, visitor),
            Tree::Object(map) => visit_entries(map, visitor),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TreeError> {
        match self {
            Tree::Null => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, TreeError> {
        match self {
            Tree::String(value) => visitor.visit_enum(value.as_str().into_deserializer()),
            _ => Err(de::Error::invalid_type(
                de::Unexpected::Other("a non-string value"),
                &visitor,
            )),
        }
    }

    /// Objects only: a struct or a map is never read from an array.
    fn deserialize_map<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, TreeError> {
        match self {
            Tree::Object(map) => visit_entries(map, visitor),
            _ => Err(de::Error::invalid_type(
                de::Unexpected::Other("a non-object value"),
                &visitor,
            )),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, TreeError> {
        visitor.visit_newtype_struct(self)
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf unit unit_struct seq tuple
        tuple_struct struct identifier ignored_any
    }
}

/// A list read whole: a visitor that stops early (a 4-tuple given 5 items) is refused, as serde_json's own value
/// reader refuses it.
fn visit_items<'de, V: Visitor<'de>>(
    items: &'de [Tree],
    visitor: V,
) -> Result<V::Value, TreeError> {
    let mut access = Items(items.iter());
    let value = visitor.visit_seq(&mut access)?;
    if access.0.len() == 0 {
        Ok(value)
    } else {
        Err(de::Error::invalid_length(items.len(), &"fewer items"))
    }
}

fn visit_entries<'de, V: Visitor<'de>>(
    map: &'de IndexMap<String, Tree>,
    visitor: V,
) -> Result<V::Value, TreeError> {
    let mut access = Entries {
        entries: map.iter(),
        value: None,
    };
    let value = visitor.visit_map(&mut access)?;
    if access.entries.len() == 0 {
        Ok(value)
    } else {
        Err(de::Error::invalid_length(map.len(), &"fewer entries"))
    }
}

struct Items<'de>(std::slice::Iter<'de, Tree>);

impl<'de> SeqAccess<'de> for Items<'de> {
    type Error = TreeError;

    fn next_element_seed<T: DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, TreeError> {
        self.0.next().map(|item| seed.deserialize(item)).transpose()
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.0.len())
    }
}

struct Entries<'de> {
    entries: indexmap::map::Iter<'de, String, Tree>,
    value: Option<&'de Tree>,
}

impl<'de> MapAccess<'de> for Entries<'de> {
    type Error = TreeError;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, TreeError> {
        match self.entries.next() {
            Some((key, value)) => {
                self.value = Some(value);
                seed.deserialize(de::value::BorrowedStrDeserializer::new(key))
                    .map(Some)
            }
            None => Ok(None),
        }
    }

    fn next_value_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<T::Value, TreeError> {
        seed.deserialize(self.value.take().expect("a value follows its key"))
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.entries.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_as_json_parse_does() {
        let tree = parse(r#" {"a": 1, "b": [true, null, -0.5e1], "a": "last"} "#).unwrap();
        let Tree::Object(map) = &tree else { panic!() };
        assert_eq!(map.keys().collect::<Vec<_>>(), ["a", "b"]);
        assert_eq!(map["a"], Tree::String("last".into()));
        assert_eq!(
            map["b"],
            Tree::Array(vec![Tree::Bool(true), Tree::Null, Tree::Number(-5.0)])
        );
        assert_eq!(parse("1e400").unwrap(), Tree::Number(f64::INFINITY));
        assert_eq!(parse("-1e400").unwrap(), Tree::Number(f64::NEG_INFINITY));
        assert_eq!(parse("0.1").unwrap(), Tree::Number(0.1));
    }

    #[test]
    fn refuses_what_json_parse_refuses() {
        for text in [
            "",
            "01",
            "1.",
            ".5",
            "+1",
            "[1,]",
            "{\"a\":1,}",
            "{'a':1}",
            "\"\t\"",
            "nul",
            "[1] 2",
            "\"\\x\"",
            "NaN",
        ] {
            assert!(parse(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn escapes_and_surrogates() {
        let backslash = char::from(92);
        let text = format!("\"{b}n{b}u0041{b}ud83d{b}ude00{b}ud800x\"", b = backslash);
        assert_eq!(
            parse(&text).unwrap(),
            Tree::String("\nA\u{1F600}\u{FFFD}x".into())
        );
    }
}
