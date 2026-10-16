//! The binary wire (`?wire=bin`): every message is the JSON data model the JSON wire carries, written with
//! postcard (the encoding of S1's codec, `morfa_model::codec`) in a stateless form:
//!
//! - a frame starts with one byte: [`MESSAGE`] (one message), [`PRESENCE`] or [`CHANGES`] (a batch of message frames
//!   made once and spliced, as the JSON codec splices its text);
//! - a message frame is `{keys, root}`: the object keys of the message once each, then the value tree with keys as
//!   indexes into that table (`Item::Obj` entries). A 20-layer op names each node field once, not twenty times;
//! - numbers that are whole and within ±2^53 (every count, id-free coordinate and flag of the model) are zigzag
//!   varints; others are 8-byte floats. `-0` stays a float.
//!
//! It is stateless: nothing depends on a document both sides hold (S1's store `Entry` is relative to the document's
//! interners, which a client and the server do not share). Readers and writers are serde's: the model's types read
//! from a frame exactly as they read from JSON text, strictly (a struct only from an object, a unit variant only from
//! a string), and [`frame_to_json`] / [`json_to_frame`] translate a frame and its JSON text both ways for the browser
//! edge (TS sees JSON, as it does with the shadow document).

use crate::codec::{Codec, DecodeError, Frame, FrameKind};
use crate::{ClientMsg, Copies, ErrorCode, Op, Peer, Seq, ServerMsg, Wire};
use bytes::{BufMut, Bytes, BytesMut};
use morfa_model::DocumentPatch;
use serde::de::{self, DeserializeSeed, IntoDeserializer, MapAccess, SeqAccess, Visitor};
use serde::ser::{self, Serialize};
use serde::{Deserialize, Deserializer};
use std::borrow::Cow;
use std::collections::HashMap;
use std::fmt;

mod stream;

/// One message.
pub const MESSAGE: u8 = 0xB1;
/// `presence {peers}`: peer frames ([`MESSAGE`] each).
pub const PRESENCE: u8 = 0xB2;
/// `changes {changes}`: `change` message frames.
pub const CHANGES: u8 = 0xB3;

/// Whole numbers in this range are varints.
const SAFE: f64 = 9_007_199_254_740_992.0;

/// One JSON value. Strings borrow from the frame they were read from.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum Item<'a> {
    Null,
    Bool(bool),
    Int(i64),
    Num(f64),
    Str(#[serde(borrow)] Cow<'a, str>),
    Arr(#[serde(borrow)] Vec<Item<'a>>),
    Obj(#[serde(borrow)] Vec<(u32, Item<'a>)>),
}

/// A message frame after its tag byte.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Tree<'a> {
    #[serde(borrow)]
    pub keys: Vec<Cow<'a, str>>,
    #[serde(borrow)]
    pub root: Item<'a>,
}

impl<'a> Tree<'a> {
    /// Reads a [`MESSAGE`] frame (tag included).
    pub fn read(frame: &'a [u8]) -> Result<Tree<'a>, Error> {
        match frame.split_first() {
            Some((&MESSAGE, body)) => {
                let (tree, rest) = postcard::take_from_bytes::<Tree>(body)
                    .map_err(|e| Error(format!("damaged frame: {e}")))?;
                if !rest.is_empty() {
                    return Err(Error("bytes after the message".into()));
                }
                if let Some(bad) = tree.max_key()
                    && bad as usize >= tree.keys.len()
                {
                    return Err(Error("a key outside the key table".into()));
                }
                Ok(tree)
            }
            _ => Err(Error("not a message frame".into())),
        }
    }

    fn max_key(&self) -> Option<u32> {
        fn walk(item: &Item, max: &mut Option<u32>) {
            match item {
                Item::Arr(items) => items.iter().for_each(|i| walk(i, max)),
                Item::Obj(entries) => {
                    for (k, v) in entries {
                        *max = Some(max.map_or(*k, |m| m.max(*k)));
                        walk(v, max);
                    }
                }
                _ => {}
            }
        }
        let mut max = None;
        walk(&self.root, &mut max);
        max
    }

    /// The value as `T` (the model's types read strictly, as from JSON).
    pub fn value<T: Deserialize<'a>>(&'a self) -> Result<T, Error> {
        T::deserialize(De {
            item: &self.root,
            keys: &self.keys,
        })
    }

    /// The entry `key` of the root object.
    pub fn field(&self, key: &str) -> Option<&Item<'a>> {
        match &self.root {
            Item::Obj(entries) => entries
                .iter()
                .find(|(k, _)| self.keys[*k as usize] == key)
                .map(|(_, v)| v),
            _ => None,
        }
    }

    /// `T` from one item of this tree.
    pub fn read_item<T: Deserialize<'a>>(&'a self, item: &'a Item<'a>) -> Result<T, Error> {
        T::deserialize(De {
            item,
            keys: &self.keys,
        })
    }
}

/// A frame that does not read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Error(pub String);

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl de::Error for Error {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        Error(msg.to_string())
    }
}

impl ser::Error for Error {
    fn custom<T: fmt::Display>(msg: T) -> Self {
        Error(msg.to_string())
    }
}

fn number(value: f64) -> Item<'static> {
    if value.fract() == 0.0 && value.abs() < SAFE && !(value == 0.0 && value.is_sign_negative()) {
        Item::Int(value as i64)
    } else {
        Item::Num(value)
    }
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────

/// Builds a [`Tree`] from any `Serialize` value as serde_json would see it.
#[derive(Default)]
pub struct Encoder {
    keys: Vec<Cow<'static, str>>,
    index: HashMap<String, u32>,
}

impl Encoder {
    fn key(&mut self, key: &str) -> u32 {
        if let Some(&i) = self.index.get(key) {
            return i;
        }
        let i = self.keys.len() as u32;
        self.keys.push(Cow::Owned(key.to_owned()));
        self.index.insert(key.to_owned(), i);
        i
    }

    /// The tree of `value`.
    pub fn tree<T: Serialize + ?Sized>(value: &T) -> Result<Tree<'static>, Error> {
        let mut encoder = Encoder::default();
        let root = value.serialize(&mut encoder)?;
        Ok(Tree {
            keys: encoder.keys,
            root,
        })
    }
}

/// A [`MESSAGE`] frame of `value`.
pub fn encode<T: Serialize + ?Sized>(value: &T) -> Bytes {
    let tree = Encoder::tree(value).expect("protocol messages always serialize");
    write_tree(&tree)
}

fn write_tree(tree: &Tree) -> Bytes {
    let mut out = Vec::with_capacity(256);
    out.push(MESSAGE);
    let out = postcard::to_extend(tree, out).expect("writing to a Vec never fails");
    out.into()
}

pub struct SeqBuilder<'e> {
    encoder: &'e mut Encoder,
    items: Vec<Item<'static>>,
}

pub struct MapBuilder<'e> {
    encoder: &'e mut Encoder,
    entries: Vec<(u32, Item<'static>)>,
    key: Option<u32>,
    /// A variant wrapping the map (`{"Variant": {…}}`).
    variant: Option<u32>,
}

pub struct VariantSeq<'e> {
    variant: u32,
    inner: SeqBuilder<'e>,
}

impl<'e> ser::Serializer for &'e mut Encoder {
    type Ok = Item<'static>;
    type Error = Error;
    type SerializeSeq = SeqBuilder<'e>;
    type SerializeTuple = SeqBuilder<'e>;
    type SerializeTupleStruct = SeqBuilder<'e>;
    type SerializeTupleVariant = VariantSeq<'e>;
    type SerializeMap = MapBuilder<'e>;
    type SerializeStruct = MapBuilder<'e>;
    type SerializeStructVariant = MapBuilder<'e>;

    fn serialize_bool(self, v: bool) -> Result<Item<'static>, Error> {
        Ok(Item::Bool(v))
    }
    fn serialize_i8(self, v: i8) -> Result<Item<'static>, Error> {
        Ok(Item::Int(v.into()))
    }
    fn serialize_i16(self, v: i16) -> Result<Item<'static>, Error> {
        Ok(Item::Int(v.into()))
    }
    fn serialize_i32(self, v: i32) -> Result<Item<'static>, Error> {
        Ok(Item::Int(v.into()))
    }
    fn serialize_i64(self, v: i64) -> Result<Item<'static>, Error> {
        Ok(number(v as f64))
    }
    fn serialize_u8(self, v: u8) -> Result<Item<'static>, Error> {
        Ok(Item::Int(v.into()))
    }
    fn serialize_u16(self, v: u16) -> Result<Item<'static>, Error> {
        Ok(Item::Int(v.into()))
    }
    fn serialize_u32(self, v: u32) -> Result<Item<'static>, Error> {
        Ok(Item::Int(v.into()))
    }
    fn serialize_u64(self, v: u64) -> Result<Item<'static>, Error> {
        Ok(number(v as f64))
    }
    fn serialize_f32(self, v: f32) -> Result<Item<'static>, Error> {
        self.serialize_f64(v.into())
    }
    fn serialize_f64(self, v: f64) -> Result<Item<'static>, Error> {
        // JSON has no NaN or infinity: serde_json writes null.
        Ok(if v.is_finite() { number(v) } else { Item::Null })
    }
    fn serialize_char(self, v: char) -> Result<Item<'static>, Error> {
        Ok(Item::Str(Cow::Owned(v.to_string())))
    }
    fn serialize_str(self, v: &str) -> Result<Item<'static>, Error> {
        Ok(Item::Str(Cow::Owned(v.to_owned())))
    }
    fn serialize_bytes(self, v: &[u8]) -> Result<Item<'static>, Error> {
        Ok(Item::Arr(
            v.iter().map(|b| Item::Int((*b).into())).collect(),
        ))
    }
    fn serialize_none(self) -> Result<Item<'static>, Error> {
        Ok(Item::Null)
    }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<Item<'static>, Error> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<Item<'static>, Error> {
        Ok(Item::Null)
    }
    fn serialize_unit_struct(self, _name: &'static str) -> Result<Item<'static>, Error> {
        Ok(Item::Null)
    }
    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result<Item<'static>, Error> {
        Ok(Item::Str(Cow::Borrowed(variant)))
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<Item<'static>, Error> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<Item<'static>, Error> {
        let key = self.key(variant);
        let value = value.serialize(&mut *self)?;
        Ok(Item::Obj(vec![(key, value)]))
    }
    fn serialize_seq(self, len: Option<usize>) -> Result<SeqBuilder<'e>, Error> {
        Ok(SeqBuilder {
            encoder: self,
            items: Vec::with_capacity(len.unwrap_or(0)),
        })
    }
    fn serialize_tuple(self, len: usize) -> Result<SeqBuilder<'e>, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_struct(
        self,
        _name: &'static str,
        len: usize,
    ) -> Result<SeqBuilder<'e>, Error> {
        self.serialize_seq(Some(len))
    }
    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<VariantSeq<'e>, Error> {
        let variant = self.key(variant);
        Ok(VariantSeq {
            variant,
            inner: self.serialize_seq(Some(len))?,
        })
    }
    fn serialize_map(self, len: Option<usize>) -> Result<MapBuilder<'e>, Error> {
        Ok(MapBuilder {
            encoder: self,
            entries: Vec::with_capacity(len.unwrap_or(0)),
            key: None,
            variant: None,
        })
    }
    fn serialize_struct(self, _name: &'static str, len: usize) -> Result<MapBuilder<'e>, Error> {
        self.serialize_map(Some(len))
    }
    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        len: usize,
    ) -> Result<MapBuilder<'e>, Error> {
        let variant = self.key(variant);
        let mut map = self.serialize_map(Some(len))?;
        map.variant = Some(variant);
        Ok(map)
    }
}

impl ser::SerializeSeq for SeqBuilder<'_> {
    type Ok = Item<'static>;
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        self.items.push(value.serialize(&mut *self.encoder)?);
        Ok(())
    }
    fn end(self) -> Result<Item<'static>, Error> {
        Ok(Item::Arr(self.items))
    }
}

impl ser::SerializeTuple for SeqBuilder<'_> {
    type Ok = Item<'static>;
    type Error = Error;
    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<Item<'static>, Error> {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleStruct for SeqBuilder<'_> {
    type Ok = Item<'static>;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        ser::SerializeSeq::serialize_element(self, value)
    }
    fn end(self) -> Result<Item<'static>, Error> {
        ser::SerializeSeq::end(self)
    }
}

impl ser::SerializeTupleVariant for VariantSeq<'_> {
    type Ok = Item<'static>;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        ser::SerializeSeq::serialize_element(&mut self.inner, value)
    }
    fn end(self) -> Result<Item<'static>, Error> {
        Ok(Item::Obj(vec![(self.variant, Item::Arr(self.inner.items))]))
    }
}

/// Map keys are strings in JSON: strings stay, numbers and booleans become their text (as serde_json does).
struct KeyWriter;

impl ser::Serializer for KeyWriter {
    type Ok = String;
    type Error = Error;
    type SerializeSeq = ser::Impossible<String, Error>;
    type SerializeTuple = ser::Impossible<String, Error>;
    type SerializeTupleStruct = ser::Impossible<String, Error>;
    type SerializeTupleVariant = ser::Impossible<String, Error>;
    type SerializeMap = ser::Impossible<String, Error>;
    type SerializeStruct = ser::Impossible<String, Error>;
    type SerializeStructVariant = ser::Impossible<String, Error>;

    fn serialize_str(self, v: &str) -> Result<String, Error> {
        Ok(v.to_owned())
    }
    fn serialize_char(self, v: char) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_bool(self, v: bool) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_i8(self, v: i8) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_i16(self, v: i16) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_i32(self, v: i32) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_i64(self, v: i64) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_u8(self, v: u8) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_u16(self, v: u16) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_u32(self, v: u32) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_u64(self, v: u64) -> Result<String, Error> {
        Ok(v.to_string())
    }
    fn serialize_f32(self, _v: f32) -> Result<String, Error> {
        Err(Error("a float map key".into()))
    }
    fn serialize_f64(self, _v: f64) -> Result<String, Error> {
        Err(Error("a float map key".into()))
    }
    fn serialize_bytes(self, _v: &[u8]) -> Result<String, Error> {
        Err(Error("a bytes map key".into()))
    }
    fn serialize_none(self) -> Result<String, Error> {
        Err(Error("a null map key".into()))
    }
    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<String, Error> {
        value.serialize(self)
    }
    fn serialize_unit(self) -> Result<String, Error> {
        Err(Error("a unit map key".into()))
    }
    fn serialize_unit_struct(self, _: &'static str) -> Result<String, Error> {
        Err(Error("a unit map key".into()))
    }
    fn serialize_unit_variant(
        self,
        _: &'static str,
        _: u32,
        variant: &'static str,
    ) -> Result<String, Error> {
        Ok(variant.to_owned())
    }
    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        value: &T,
    ) -> Result<String, Error> {
        value.serialize(self)
    }
    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: &T,
    ) -> Result<String, Error> {
        Err(Error("a compound map key".into()))
    }
    fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Error> {
        Err(Error("a compound map key".into()))
    }
    fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, Error> {
        Err(Error("a compound map key".into()))
    }
    fn serialize_tuple_struct(
        self,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleStruct, Error> {
        Err(Error("a compound map key".into()))
    }
    fn serialize_tuple_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeTupleVariant, Error> {
        Err(Error("a compound map key".into()))
    }
    fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Error> {
        Err(Error("a compound map key".into()))
    }
    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Self::SerializeStruct, Error> {
        Err(Error("a compound map key".into()))
    }
    fn serialize_struct_variant(
        self,
        _: &'static str,
        _: u32,
        _: &'static str,
        _: usize,
    ) -> Result<Self::SerializeStructVariant, Error> {
        Err(Error("a compound map key".into()))
    }
}

impl MapBuilder<'_> {
    fn finish(self) -> Item<'static> {
        let object = Item::Obj(self.entries);
        match self.variant {
            Some(variant) => Item::Obj(vec![(variant, object)]),
            None => object,
        }
    }
}

impl ser::SerializeMap for MapBuilder<'_> {
    type Ok = Item<'static>;
    type Error = Error;
    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), Error> {
        let key = key.serialize(KeyWriter)?;
        self.key = Some(self.encoder.key(&key));
        Ok(())
    }
    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Error> {
        let key = self
            .key
            .take()
            .ok_or_else(|| Error("a value without a key".into()))?;
        let value = value.serialize(&mut *self.encoder)?;
        self.entries.push((key, value));
        Ok(())
    }
    fn end(self) -> Result<Item<'static>, Error> {
        Ok(self.finish())
    }
}

impl ser::SerializeStruct for MapBuilder<'_> {
    type Ok = Item<'static>;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Error> {
        let key = self.encoder.key(key);
        let value = value.serialize(&mut *self.encoder)?;
        self.entries.push((key, value));
        Ok(())
    }
    fn end(self) -> Result<Item<'static>, Error> {
        Ok(self.finish())
    }
}

impl ser::SerializeStructVariant for MapBuilder<'_> {
    type Ok = Item<'static>;
    type Error = Error;
    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Error> {
        ser::SerializeStruct::serialize_field(self, key, value)
    }
    fn end(self) -> Result<Item<'static>, Error> {
        Ok(self.finish())
    }
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────

/// Reads a value from one item of a tree. Strict as the model's JSON reader: a struct only from an object, a
/// sequence only from an array, a unit variant only from a string.
#[derive(Clone, Copy)]
struct De<'a, 'de> {
    item: &'a Item<'de>,
    keys: &'a [Cow<'de, str>],
}

fn unexpected(item: &Item) -> de::Unexpected<'static> {
    match item {
        Item::Null => de::Unexpected::Unit,
        Item::Bool(b) => de::Unexpected::Bool(*b),
        Item::Int(i) => de::Unexpected::Signed(*i),
        Item::Num(f) => de::Unexpected::Float(*f),
        Item::Str(_) => de::Unexpected::Other("a string"),
        Item::Arr(_) => de::Unexpected::Seq,
        Item::Obj(_) => de::Unexpected::Map,
    }
}

impl<'a, 'de> De<'a, 'de> {
    fn str<V: Visitor<'de>>(self, s: &'a Cow<'de, str>, visitor: V) -> Result<V::Value, Error> {
        match s {
            Cow::Borrowed(b) => visitor.visit_borrowed_str(b),
            Cow::Owned(o) => visitor.visit_str(o),
        }
    }
}

impl<'a, 'de> Deserializer<'de> for De<'a, 'de> {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.item {
            Item::Null => visitor.visit_unit(),
            Item::Bool(b) => visitor.visit_bool(*b),
            Item::Int(i) => visitor.visit_i64(*i),
            Item::Num(f) => visitor.visit_f64(*f),
            Item::Str(s) => self.str(s, visitor),
            Item::Arr(items) => visitor.visit_seq(SeqDe {
                items: items.iter(),
                keys: self.keys,
            }),
            Item::Obj(entries) => visitor.visit_map(MapDe {
                entries: entries.iter(),
                keys: self.keys,
                value: None,
            }),
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.item {
            Item::Null => visitor.visit_none(),
            _ => visitor.visit_some(self),
        }
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        visitor: V,
    ) -> Result<V::Value, Error> {
        visitor.visit_newtype_struct(self)
    }

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.item {
            Item::Arr(_) => self.deserialize_any(visitor),
            other => Err(de::Error::invalid_type(unexpected(other), &visitor)),
        }
    }

    fn deserialize_tuple<V: Visitor<'de>>(
        self,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.deserialize_seq(visitor)
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _len: usize,
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.deserialize_seq(visitor)
    }

    fn deserialize_map<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.item {
            Item::Obj(_) => self.deserialize_any(visitor),
            other => Err(de::Error::invalid_type(unexpected(other), &visitor)),
        }
    }

    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        self.deserialize_map(visitor)
    }

    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self.item {
            Item::Str(_) => visitor.visit_enum(Enum {
                variant: self,
                value: None,
            }),
            Item::Obj(entries) if entries.len() == 1 => {
                let (key, value) = &entries[0];
                visitor.visit_enum(Enum {
                    variant: KeyDe {
                        key: &self.keys[*key as usize],
                    },
                    value: Some(De {
                        item: value,
                        keys: self.keys,
                    }),
                })
            }
            other => Err(de::Error::invalid_type(unexpected(other), &visitor)),
        }
    }

    fn deserialize_str<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.item {
            Item::Str(s) => self.str(s, visitor),
            other => Err(de::Error::invalid_type(unexpected(other), &visitor)),
        }
    }

    fn deserialize_string<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_str(visitor)
    }

    fn deserialize_identifier<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_str(visitor)
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        visitor.visit_unit()
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char bytes byte_buf unit unit_struct
    }
}

/// A variant name taken from an object key.
#[derive(Clone, Copy)]
struct KeyDe<'a, 'de> {
    key: &'a Cow<'de, str>,
}

impl<'a, 'de> Deserializer<'de> for KeyDe<'a, 'de> {
    type Error = Error;
    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.key {
            Cow::Borrowed(b) => visitor.visit_borrowed_str(b),
            Cow::Owned(o) => visitor.visit_str(o),
        }
    }
    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option unit
        unit_struct newtype_struct seq tuple tuple_struct map struct enum identifier ignored_any
    }
}

/// A variant: from a string (unit) or a one-entry object (`{"Variant": value}`).
enum VariantDe<'a, 'de> {
    Str(De<'a, 'de>),
    Key(KeyDe<'a, 'de>),
}

struct Enum<'a, 'de, K> {
    variant: K,
    value: Option<De<'a, 'de>>,
}

impl<'a, 'de> From<De<'a, 'de>> for VariantDe<'a, 'de> {
    fn from(de: De<'a, 'de>) -> Self {
        VariantDe::Str(de)
    }
}

impl<'a, 'de> From<KeyDe<'a, 'de>> for VariantDe<'a, 'de> {
    fn from(de: KeyDe<'a, 'de>) -> Self {
        VariantDe::Key(de)
    }
}

impl<'a, 'de, K: Into<VariantDe<'a, 'de>>> de::EnumAccess<'de> for Enum<'a, 'de, K> {
    type Error = Error;
    type Variant = Variant<'a, 'de>;
    fn variant_seed<S: DeserializeSeed<'de>>(
        self,
        seed: S,
    ) -> Result<(S::Value, Variant<'a, 'de>), Error> {
        let name = match self.variant.into() {
            VariantDe::Str(de) => seed.deserialize(de)?,
            VariantDe::Key(key) => seed.deserialize(key)?,
        };
        Ok((name, Variant { value: self.value }))
    }
}

struct Variant<'a, 'de> {
    value: Option<De<'a, 'de>>,
}

impl<'a, 'de> de::VariantAccess<'de> for Variant<'a, 'de> {
    type Error = Error;
    fn unit_variant(self) -> Result<(), Error> {
        match self.value {
            // A unit variant only from a string (the model's strict rule).
            None => Ok(()),
            Some(_) => Err(Error("a unit variant written as an object".into())),
        }
    }
    fn newtype_variant_seed<S: DeserializeSeed<'de>>(self, seed: S) -> Result<S::Value, Error> {
        match self.value {
            Some(value) => seed.deserialize(value),
            None => Err(Error("a newtype variant without its value".into())),
        }
    }
    fn tuple_variant<V: Visitor<'de>>(self, _len: usize, visitor: V) -> Result<V::Value, Error> {
        match self.value {
            Some(value) => value.deserialize_seq(visitor),
            None => Err(Error("a tuple variant without its value".into())),
        }
    }
    fn struct_variant<V: Visitor<'de>>(
        self,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, Error> {
        match self.value {
            Some(value) => value.deserialize_map(visitor),
            None => Err(Error("a struct variant without its value".into())),
        }
    }
}

struct SeqDe<'a, 'de> {
    items: std::slice::Iter<'a, Item<'de>>,
    keys: &'a [Cow<'de, str>],
}

impl<'a, 'de> SeqAccess<'de> for SeqDe<'a, 'de> {
    type Error = Error;
    fn next_element_seed<S: DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<Option<S::Value>, Error> {
        match self.items.next() {
            Some(item) => seed
                .deserialize(De {
                    item,
                    keys: self.keys,
                })
                .map(Some),
            None => Ok(None),
        }
    }
    fn size_hint(&self) -> Option<usize> {
        Some(self.items.len())
    }
}

struct MapDe<'a, 'de> {
    entries: std::slice::Iter<'a, (u32, Item<'de>)>,
    keys: &'a [Cow<'de, str>],
    value: Option<&'a Item<'de>>,
}

impl<'a, 'de> MapAccess<'de> for MapDe<'a, 'de> {
    type Error = Error;
    fn next_key_seed<S: DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<Option<S::Value>, Error> {
        match self.entries.next() {
            Some((key, value)) => {
                self.value = Some(value);
                seed.deserialize(KeyDe {
                    key: &self.keys[*key as usize],
                })
                .map(Some)
            }
            None => Ok(None),
        }
    }
    fn next_value_seed<S: DeserializeSeed<'de>>(&mut self, seed: S) -> Result<S::Value, Error> {
        let item = self
            .value
            .take()
            .ok_or_else(|| Error("a value without a key".into()))?;
        seed.deserialize(De {
            item,
            keys: self.keys,
        })
    }
    fn size_hint(&self) -> Option<usize> {
        Some(self.entries.len())
    }
}

impl<'de> IntoDeserializer<'de, Error> for De<'_, 'de> {
    type Deserializer = Self;
    fn into_deserializer(self) -> Self {
        self
    }
}

// ── JSON text, both ways (the browser edge) ──────────────────────────────────────────────────────

fn write_json(item: &Item, keys: &[Cow<str>], out: &mut String) {
    use std::fmt::Write;
    match item {
        Item::Null => out.push_str("null"),
        Item::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Item::Int(i) => {
            let _ = write!(out, "{i}");
        }
        Item::Num(f) => out.push_str(&morfa_model::js_number(*f)),
        Item::Str(s) => write_string(s, out),
        Item::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json(item, keys, out);
            }
            out.push(']');
        }
        Item::Obj(entries) => {
            out.push('{');
            for (i, (key, value)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_string(&keys[*key as usize], out);
                out.push(':');
                write_json(value, keys, out);
            }
            out.push('}');
        }
    }
}

/// A string as `JSON.stringify` writes it.
fn write_string(s: &str, out: &mut String) {
    out.push_str(&serde_json::to_string(s).expect("strings serialize"));
}

/// The JSON text of a binary frame (any of the three kinds), as the JSON wire would carry the same message.
pub fn frame_to_json(frame: &[u8]) -> Result<String, Error> {
    let mut out = String::with_capacity(frame.len() * 3);
    match frame.first() {
        Some(&MESSAGE) => {
            let tree = Tree::read(frame)?;
            write_json(&tree.root, &tree.keys, &mut out);
        }
        Some(&tag @ (PRESENCE | CHANGES)) => {
            out.push_str(if tag == PRESENCE {
                r#"{"t":"presence","peers":["#
            } else {
                r#"{"t":"changes","changes":["#
            });
            for (i, part) in parts(&frame[1..])?.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                let tree = Tree::read(part)?;
                write_json(&tree.root, &tree.keys, &mut out);
            }
            out.push_str("]}");
        }
        _ => return Err(Error("not a binary frame".into())),
    }
    Ok(out)
}

fn tree_of(json: &morfa_model::js_json::Tree, encoder: &mut Encoder) -> Item<'static> {
    use morfa_model::js_json::Tree as J;
    match json {
        J::Null => Item::Null,
        J::Bool(b) => Item::Bool(*b),
        J::Number(n) => number(*n),
        J::String(s) => Item::Str(Cow::Owned(s.clone())),
        J::Array(items) => Item::Arr(items.iter().map(|i| tree_of(i, encoder)).collect()),
        J::Object(entries) => Item::Obj(
            entries
                .iter()
                .map(|(k, v)| (encoder.key(k), tree_of(v, encoder)))
                .collect(),
        ),
    }
}

/// The binary frame of a message's JSON text, read as `JSON.parse` reads it (the browser's outgoing messages).
pub fn json_to_frame(json: &str) -> Result<Vec<u8>, Error> {
    let parsed = morfa_model::js_json::parse(json).map_err(|e| Error(e.to_string()))?;
    let mut encoder = Encoder::default();
    let root = tree_of(&parsed, &mut encoder);
    Ok(write_tree(&Tree {
        keys: encoder.keys,
        root,
    })
    .to_vec())
}

// ── Batches ──────────────────────────────────────────────────────────────────────────────────────

fn varint(mut n: usize, out: &mut BytesMut) {
    while n >= 0x80 {
        out.put_u8((n as u8) | 0x80);
        n >>= 7;
    }
    out.put_u8(n as u8);
}

fn read_varint(bytes: &[u8]) -> Result<(usize, &[u8]), Error> {
    let mut n = 0usize;
    for (i, &b) in bytes.iter().enumerate().take(10) {
        n |= ((b & 0x7f) as usize) << (7 * i);
        if b & 0x80 == 0 {
            return Ok((n, &bytes[i + 1..]));
        }
    }
    Err(Error("a damaged length".into()))
}

/// The message frames of a batch body.
fn parts(mut body: &[u8]) -> Result<Vec<&[u8]>, Error> {
    let (count, rest) = read_varint(body)?;
    body = rest;
    let mut out = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        let (len, rest) = read_varint(body)?;
        if rest.len() < len {
            return Err(Error("a batch shorter than its parts".into()));
        }
        out.push(&rest[..len]);
        body = &rest[len..];
    }
    if !body.is_empty() {
        return Err(Error("bytes after the batch".into()));
    }
    Ok(out)
}

fn batch(tag: u8, items: &mut dyn Iterator<Item = &Bytes>) -> Bytes {
    let items: Vec<&Bytes> = items.collect();
    let mut out = BytesMut::with_capacity(8 + items.iter().map(|b| b.len() + 3).sum::<usize>());
    out.put_u8(tag);
    varint(items.len(), &mut out);
    for item in items {
        varint(item.len(), &mut out);
        out.put_slice(item);
    }
    out.freeze()
}

// ── The codec ────────────────────────────────────────────────────────────────────────────────────

/// Binary frames (`?wire=bin`).
#[derive(Debug, Clone, Copy, Default)]
pub struct BinaryCodec;

fn binary(bytes: Bytes) -> Frame {
    Frame {
        kind: FrameKind::Binary,
        bytes,
    }
}

fn bad(error: Error) -> DecodeError {
    DecodeError {
        code: ErrorCode::BadMessage,
        message: error.0,
        seq: None,
        path: None,
    }
}

fn invalid(seq: Seq, error: Error, path: &str) -> DecodeError {
    DecodeError {
        code: ErrorCode::DesignDocumentInvalid,
        message: format!("Invalid value: {error}."),
        seq: Some(seq),
        path: Some(path.to_owned()),
    }
}

/// Reads an `op` from its tree: the patch now, the `before` copies when an op needs them ([`Copies::Bin`]).
/// An `op` frame read without its tree ([`stream`]); None when anything is off (a repeated or missing key, a value
/// the model refuses, a damaged frame): the tree's reader then gives its answer, so both accept the same frames with
/// the same values.
fn decode_op_direct(frame: &[u8]) -> Option<Op> {
    let read = || -> Result<Option<Op>, Error> {
        let Some((&MESSAGE, body)) = frame.split_first() else {
            return Ok(None);
        };
        let mut de = stream::Postcard::from_bytes(body);
        let keys = Vec::<&str>::deserialize(&mut de).map_err(|e| Error(e.to_string()))?;
        if stream::tag(&mut de)? != 6 {
            return Ok(None);
        }
        let (mut t, mut seq, mut base_version, mut patch) = (false, None, None, None);
        let (mut before, mut before_tables, mut fields) = (None, None, None);
        for _ in 0..stream::len(&mut de)? {
            let key = stream::key(&mut de, &keys)?;
            let tag = stream::tag(&mut de)?;
            macro_rules! item {
                () => {
                    stream::Item {
                        de: &mut de,
                        keys: &keys,
                        tag,
                    }
                };
            }
            let number = |de: &mut stream::Postcard| match tag {
                2 => stream::int(de).map(|i| u64::try_from(i).ok()),
                _ => Ok(None),
            };
            match key {
                "t" if !t => {
                    if tag != 4 || stream::string(&mut de)? != "op" {
                        return Ok(None);
                    }
                    t = true;
                }
                "seq" if seq.is_none() => match number(&mut de)? {
                    Some(n) => seq = Some(n),
                    None => return Ok(None),
                },
                "baseVersion" if base_version.is_none() => match number(&mut de)? {
                    Some(n) => base_version = Some(n),
                    None => return Ok(None),
                },
                "patch" if patch.is_none() => patch = Some(DocumentPatch::deserialize(item!())?),
                "before" if before.is_none() => {
                    before = Some(tag != 0);
                    stream::skip(&mut de, &keys, tag)?;
                }
                "beforeTables" if before_tables.is_none() => {
                    before_tables = Some(match tag {
                        0 => None,
                        _ => Some(DocumentPatch::deserialize(item!())?),
                    });
                }
                "fields" if fields.is_none() => {
                    fields = Some(match tag {
                        0 => None,
                        _ => Some(crate::OpFields::deserialize(item!())?),
                    });
                }
                "t" | "seq" | "baseVersion" | "patch" | "before" | "beforeTables" | "fields" => {
                    return Ok(None);
                }
                _ => stream::skip(&mut de, &keys, tag)?,
            }
        }
        if !de.finalize().map_err(|e| Error(e.to_string()))?.is_empty() {
            return Ok(None);
        }
        let (true, Some(seq), Some(base_version), Some(patch)) = (t, seq, base_version, patch)
        else {
            return Ok(None);
        };
        Ok(Some(Op {
            seq,
            base_version,
            patch,
            before: before
                .unwrap_or(false)
                .then(|| Copies::Bin(Bytes::copy_from_slice(frame))),
            before_tables: before_tables.flatten(),
            fields: fields.flatten(),
        }))
    };
    read().ok().flatten()
}

fn decode_op(frame: &[u8], tree: &Tree) -> Result<Op, DecodeError> {
    let number = |key: &str| -> Option<u64> {
        match tree.field(key)? {
            Item::Int(i) if *i >= 0 => Some(*i as u64),
            _ => None,
        }
    };
    let seq = number("seq").ok_or_else(|| bad(Error("an op without its seq".into())))?;
    let base_version = number("baseVersion").ok_or_else(|| DecodeError {
        seq: Some(seq),
        ..bad(Error("an op without its baseVersion".into()))
    })?;
    let patch_item = tree
        .field("patch")
        .ok_or_else(|| invalid(seq, Error("no patch".into()), "patch"))?;
    let patch: DocumentPatch = tree
        .read_item(patch_item)
        .map_err(|e| invalid(seq, e, "patch"))?;
    let before = match tree.field("before") {
        None | Some(Item::Null) => None,
        Some(_) => Some(Copies::Bin(Bytes::copy_from_slice(frame))),
    };
    let before_tables = match tree.field("beforeTables") {
        None | Some(Item::Null) => None,
        Some(item) => Some(
            tree.read_item::<DocumentPatch>(item)
                .map_err(|e| invalid(seq, e, "beforeTables"))?,
        ),
    };
    let fields = match tree.field("fields") {
        None | Some(Item::Null) => None,
        Some(item) => Some(
            tree.read_item::<crate::OpFields>(item)
                .map_err(|e| invalid(seq, e, "fields"))?,
        ),
    };
    Ok(Op {
        seq,
        base_version,
        patch,
        before,
        before_tables,
        fields,
    })
}

/// The `before` copies of an op frame.
pub(crate) fn read_copies(
    frame: &[u8],
    seq: Seq,
) -> Result<morfa_model::Map<Option<morfa_model::SceneNode>>, DecodeError> {
    let tree = Tree::read(frame).map_err(bad)?;
    match tree.field("before") {
        Some(item) => tree.read_item(item).map_err(|e| invalid(seq, e, "before")),
        None => Ok(Default::default()),
    }
}

impl Codec for BinaryCodec {
    fn wire(&self) -> Wire {
        Wire::Binary
    }

    fn encode_server(&self, msg: &ServerMsg) -> Frame {
        binary(encode(msg))
    }

    fn decode_server(&self, bytes: &[u8]) -> Result<ServerMsg, DecodeError> {
        match bytes.first() {
            Some(&MESSAGE) => {
                let tree = Tree::read(bytes).map_err(bad)?;
                tree.value().map_err(bad)
            }
            Some(&PRESENCE) => {
                let peers = parts(&bytes[1..])
                    .map_err(bad)?
                    .into_iter()
                    .map(|part| {
                        let tree = Tree::read(part)?;
                        tree.value::<Peer>()
                    })
                    .collect::<Result<Vec<Peer>, Error>>()
                    .map_err(bad)?;
                Ok(ServerMsg::Presence { peers })
            }
            Some(&CHANGES) => {
                let changes = parts(&bytes[1..])
                    .map_err(bad)?
                    .into_iter()
                    .map(|part| {
                        let tree = Tree::read(part)?;
                        match tree.value::<ServerMsg>()? {
                            ServerMsg::Change(change) => Ok(change),
                            _ => Err(Error("a batch of changes holds another message".into())),
                        }
                    })
                    .collect::<Result<Vec<_>, Error>>()
                    .map_err(bad)?;
                Ok(ServerMsg::Changes { changes })
            }
            _ => Err(bad(Error("not a binary frame".into()))),
        }
    }

    fn encode_client(&self, msg: &ClientMsg) -> Frame {
        binary(encode(msg))
    }

    fn decode_client(&self, bytes: &[u8]) -> Result<ClientMsg, DecodeError> {
        if let Some(op) = decode_op_direct(bytes) {
            return Ok(ClientMsg::Op(Box::new(op)));
        }
        let tree = Tree::read(bytes).map_err(bad)?;
        // Each message reads from the whole object (its `t` is an unknown key there), so the strict reader sees it
        // directly rather than through serde's buffering of tagged enums.
        let Some(Item::Str(tag)) = tree.field("t") else {
            return Err(bad(Error("a message without its t".into())));
        };
        match &**tag {
            "op" => decode_op(bytes, &tree).map(|op| ClientMsg::Op(Box::new(op))),
            "ping" => Ok(ClientMsg::Ping),
            "hello" => tree.value().map(ClientMsg::Hello).map_err(bad),
            "presence" => tree.value().map(ClientMsg::Presence).map_err(bad),
            "pull" => match tree.field("since") {
                Some(Item::Int(since)) if *since >= 0 => Ok(ClientMsg::Pull {
                    since: *since as u64,
                }),
                _ => Err(bad(Error("a pull without its since".into()))),
            },
            other => Err(bad(Error(format!("unknown message {other}")))),
        }
    }

    fn encode_peer(&self, peer: &Peer) -> Bytes {
        encode(peer)
    }

    fn presence_frame(&self, peers: &mut dyn Iterator<Item = &Bytes>) -> Frame {
        binary(batch(PRESENCE, peers))
    }

    fn changes_frame(&self, changes: &mut dyn Iterator<Item = &Bytes>) -> Frame {
        binary(batch(CHANGES, changes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::{Rng, SeedableRng};

    const RECT: &str = r#"{"id":"r","type":"RECTANGLE","name":"R","parentId":"p","visible":true,"locked":false,"opacity":0.5,"blendMode":"NORMAL","isMask":false,"x":1.25,"y":-2,"width":3,"height":4,"rotation":0,"fills":[{"type":"SOLID","color":{"r":1,"g":0.2,"b":0},"opacity":1,"visible":true,"blendMode":"NORMAL"},{"blendMode":"NORMAL","type":"GRADIENT_LINEAR","gradientStops":[{"position":0,"color":{"r":0,"g":0,"b":0,"a":1}}],"gradientHandlePositions":[{"x":0,"y":0},{"x":1,"y":0},{"x":0,"y":1}],"opacity":1,"visible":true}],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[2,3],"effects":[{"type":"DROP_SHADOW","color":{"r":0,"g":0,"b":0,"a":0.25},"offset":{"x":0,"y":2},"radius":4,"spread":0,"visible":true,"blendMode":"NORMAL"}],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"cornerRadius":2,"unknown":{"deep":[1,"x",null]}}"#;

    /// The tree's reader, as `decode_client` used it alone.
    fn through_tree(frame: &[u8]) -> Result<Op, DecodeError> {
        let tree = Tree::read(frame).map_err(bad)?;
        match tree.field("t") {
            Some(Item::Str(t)) if t == "op" => decode_op(frame, &tree),
            _ => Err(bad(Error("not an op".into()))),
        }
    }

    fn same(a: &Op, b: &Op) -> bool {
        let text = |op: &Op| {
            let mut op = op.clone();
            // Copies::Bin holds the frame either way.
            op.before = op.before.map(|_| Copies::Read(Default::default()));
            serde_json::to_string(&op).unwrap()
        };
        text(a) == text(b)
    }

    fn frames() -> Vec<Vec<u8>> {
        [
            format!(r#"{{"t":"op","seq":3,"baseVersion":7,"patch":{{"nodes":{{"r":{RECT},"q":null}}}}}}"#),
            format!(r#"{{"seq":3,"t":"op","baseVersion":7,"x":{{"y":[{RECT}]}},"patch":{{"nodes":{{"r":{RECT}}},"pages":["p"]}},"before":{{"r":{RECT}}},"beforeTables":{{"pages":["p"]}}}}"#),
            format!(r#"{{"t":"op","seq":3,"baseVersion":7,"patch":{{"nodes":{{"r":{}}}}}}}"#, RECT.replace(r#"{"type":"SOLID","#, r#"{"opacity":1,"type":"SOLID","#)),
            format!(r#"{{"t":"op","seq":3,"baseVersion":7,"patch":{{"nodes":{{"r":{}}}}}}}"#, RECT.replace(r#""x":1.25"#, r#""x":"1""#)),
            format!(r#"{{"t":"op","seq":3,"baseVersion":7,"patch":{{"nodes":{{"r":{}}}}}}}"#, RECT.replace(r#""type":"SOLID""#, r#""type":"SOLID","type":"PLAID""#)),
            r#"{"t":"op","seq":3,"seq":4,"baseVersion":7,"patch":{}}"#.to_owned(),
            r#"{"t":"ping","seq":3,"baseVersion":7,"patch":{}}"#.to_owned(),
            r#"{"t":"op","seq":-3,"baseVersion":7,"patch":{}}"#.to_owned(),
        ]
        .iter()
        .map(|json| json_to_frame(json).unwrap())
        .collect()
    }

    #[test]
    fn ops_read_without_the_tree_as_through_it() {
        let frames = frames();
        for (i, frame) in frames.iter().enumerate() {
            let direct = decode_op_direct(frame);
            let tree = through_tree(frame);
            match (&direct, &tree) {
                (Some(a), Ok(b)) => assert!(same(a, b), "frame {i}"),
                (None, _) => {}
                (Some(_), Err(e)) => panic!("frame {i}: read directly, refused by the tree: {e:?}"),
            }
        }
        // The plain ones read in one pass.
        for i in [0, 1, 2] {
            assert!(decode_op_direct(&frames[i]).is_some(), "frame {i}");
        }
    }

    /// Damaged frames: whatever the direct reader takes, the tree takes too, to the same op.
    #[test]
    fn damaged_frames_read_no_more_directly_than_through_the_tree() {
        let frames = frames();
        let mut rng = rand::rngs::StdRng::seed_from_u64(11);
        let mut read = 0;
        for round in 0..40_000 {
            let mut frame = frames[round % 3].clone();
            for _ in 0..rng.gen_range(1..4) {
                if frame.len() < 2 {
                    break;
                }
                let at = rng.gen_range(1..frame.len());
                match rng.gen_range(0..4) {
                    0 => frame[at] = rng.r#gen(),
                    1 => frame[at] ^= 1 << rng.gen_range(0..8),
                    2 => frame.truncate(at),
                    _ => {
                        frame.remove(at);
                    }
                }
            }
            if let Some(op) = decode_op_direct(&frame) {
                read += 1;
                let tree = through_tree(&frame).unwrap_or_else(|e| {
                    panic!("round {round}: read directly, refused by the tree: {e:?}")
                });
                assert!(same(&op, &tree), "round {round}");
            }
        }
        assert!(read > 100, "{read} damaged frames still read");
    }
}
