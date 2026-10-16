//! Deserialization that accepts what `shared/design/schema.ts` (zod) accepts, and nothing more.
//!
//! serde's defaults are looser than zod in three ways, and this module closes each:
//! - A derived struct also deserializes from a JSON array (its fields in order), and serde_json reads a unit
//!   enum from `{"VARIANT": null}` as well as from `"VARIANT"`. [`Strict`] wraps a deserializer so structs
//!   read only from objects and enums only from strings, at every depth.
//! - `Option<T>` reads `null` as `None`; zod's `.optional()` refuses `null`. Fields that are optional but not
//!   nullable use [`some`].
//! - A missing `Option<T>` field is `None`; zod's `.nullable()` without `.optional()` requires the key. Such
//!   fields use [`nullable`] (serde then reports the missing field), and `.nullable().optional()` fields use
//!   [`nullable_optional`] to keep `null` apart from an absent key.
//!
//! Unions that zod tells apart by a field (`z.discriminatedUnion`) or by trying each option in order
//! (`z.union`) are read through a `serde_json::Value` buffer with [`buffer`], then each option through
//! [`from_value`], which keeps the strict rules inside the buffered value.

use serde::Deserialize;
use serde::de::{
    self, DeserializeOwned, DeserializeSeed, Deserializer, EnumAccess, IntoDeserializer, MapAccess,
    SeqAccess, Visitor,
};
use serde_json::Value;
use std::fmt;

/// A deserializer that reads structs only from JSON objects and unit enums only from strings, and wraps every
/// nested deserializer the same way.
pub struct Strict<D>(pub D);

macro_rules! forward {
    ($($method:ident)*) => {$(
        fn $method<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, D::Error> {
            self.0.$method(Wrap(visitor))
        }
    )*};
}

impl<'de, D: Deserializer<'de>> Deserializer<'de> for Strict<D> {
    type Error = D::Error;

    forward! {
        deserialize_any deserialize_bool deserialize_i8 deserialize_i16 deserialize_i32 deserialize_i64
        deserialize_i128 deserialize_u8 deserialize_u16 deserialize_u32 deserialize_u64 deserialize_u128
        deserialize_f32 deserialize_f64 deserialize_char deserialize_str deserialize_string deserialize_bytes
        deserialize_byte_buf deserialize_option deserialize_unit deserialize_seq deserialize_map
    }

    fn deserialize_unit_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, D::Error> {
        self.0.deserialize_unit_struct(name, Wrap(visitor))
    }

    fn deserialize_newtype_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        visitor: V,
    ) -> Result<V::Value, D::Error> {
        self.0.deserialize_newtype_struct(name, Wrap(visitor))
    }

    fn deserialize_tuple<V: Visitor<'de>>(
        self,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, D::Error> {
        self.0.deserialize_tuple(len, Wrap(visitor))
    }

    fn deserialize_tuple_struct<V: Visitor<'de>>(
        self,
        name: &'static str,
        len: usize,
        visitor: V,
    ) -> Result<V::Value, D::Error> {
        self.0.deserialize_tuple_struct(name, len, Wrap(visitor))
    }

    /// zod objects are JSON objects only: never read a struct from an array.
    fn deserialize_struct<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _fields: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, D::Error> {
        self.0.deserialize_map(Wrap(visitor))
    }

    /// zod enums are strings only: never read `{"VARIANT": null}`.
    fn deserialize_enum<V: Visitor<'de>>(
        self,
        _name: &'static str,
        _variants: &'static [&'static str],
        visitor: V,
    ) -> Result<V::Value, D::Error> {
        self.0.deserialize_str(EnumFromStr(visitor))
    }

    fn deserialize_identifier<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, D::Error> {
        self.0.deserialize_identifier(visitor)
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, D::Error> {
        self.0.deserialize_ignored_any(visitor)
    }

    fn is_human_readable(&self) -> bool {
        self.0.is_human_readable()
    }
}

/// A visitor whose nested deserializers, sequences and maps are [`Strict`] too.
struct Wrap<V>(V);

macro_rules! pass {
    ($($method:ident($ty:ty))*) => {$(
        fn $method<E: de::Error>(self, value: $ty) -> Result<V::Value, E> {
            self.0.$method(value)
        }
    )*};
}

impl<'de, V: Visitor<'de>> Visitor<'de> for Wrap<V> {
    type Value = V::Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        self.0.expecting(formatter)
    }

    pass! {
        visit_bool(bool) visit_i64(i64) visit_i128(i128) visit_u64(u64) visit_u128(u128) visit_f64(f64)
        visit_char(char) visit_str(&str) visit_borrowed_str(&'de str) visit_string(String) visit_bytes(&[u8])
        visit_borrowed_bytes(&'de [u8]) visit_byte_buf(Vec<u8>)
    }

    fn visit_unit<E: de::Error>(self) -> Result<V::Value, E> {
        self.0.visit_unit()
    }

    fn visit_none<E: de::Error>(self) -> Result<V::Value, E> {
        self.0.visit_none()
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<V::Value, D::Error> {
        self.0.visit_some(Strict(deserializer))
    }

    fn visit_newtype_struct<D: Deserializer<'de>>(
        self,
        deserializer: D,
    ) -> Result<V::Value, D::Error> {
        self.0.visit_newtype_struct(Strict(deserializer))
    }

    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<V::Value, A::Error> {
        self.0.visit_seq(StrictSeq(seq))
    }

    fn visit_map<A: MapAccess<'de>>(self, map: A) -> Result<V::Value, A::Error> {
        self.0.visit_map(StrictMap(map))
    }

    fn visit_enum<A: EnumAccess<'de>>(self, _data: A) -> Result<V::Value, A::Error> {
        Err(de::Error::invalid_type(de::Unexpected::Enum, &self))
    }
}

struct StrictSeq<A>(A);

impl<'de, A: SeqAccess<'de>> SeqAccess<'de> for StrictSeq<A> {
    type Error = A::Error;

    fn next_element_seed<T: DeserializeSeed<'de>>(
        &mut self,
        seed: T,
    ) -> Result<Option<T::Value>, A::Error> {
        self.0.next_element_seed(StrictSeed(seed))
    }

    fn size_hint(&self) -> Option<usize> {
        self.0.size_hint()
    }
}

struct StrictMap<A>(A);

impl<'de, A: MapAccess<'de>> MapAccess<'de> for StrictMap<A> {
    type Error = A::Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, A::Error> {
        self.0.next_key_seed(seed)
    }

    fn next_value_seed<T: DeserializeSeed<'de>>(&mut self, seed: T) -> Result<T::Value, A::Error> {
        self.0.next_value_seed(StrictSeed(seed))
    }

    fn size_hint(&self) -> Option<usize> {
        self.0.size_hint()
    }
}

struct StrictSeed<S>(S);

impl<'de, S: DeserializeSeed<'de>> DeserializeSeed<'de> for StrictSeed<S> {
    type Value = S::Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<S::Value, D::Error> {
        self.0.deserialize(Strict(deserializer))
    }
}

/// Reads a unit enum from a string only.
struct EnumFromStr<V>(V);

impl<'de, V: Visitor<'de>> Visitor<'de> for EnumFromStr<V> {
    type Value = V::Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        self.0.expecting(formatter)
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<V::Value, E> {
        self.0.visit_enum(value.into_deserializer())
    }

    fn visit_borrowed_str<E: de::Error>(self, value: &'de str) -> Result<V::Value, E> {
        self.0
            .visit_enum(de::value::BorrowedStrDeserializer::new(value))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<V::Value, E> {
        self.0.visit_enum(value.into_deserializer())
    }
}

// ── Field helpers ────────────────────────────────────────────────────────────────────────────────

/// `.optional()`: absent is `None` (with `#[serde(default)]`), `null` is refused.
pub fn some<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(deserializer).map(Some)
}

/// `.nullable()`: the key is required (serde reports it missing), `null` is `None`.
pub fn nullable<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<T>, D::Error> {
    Option::<T>::deserialize(deserializer)
}

/// `.nullable().optional()`: absent is `None` (with `#[serde(default)]`), `null` is `Some(None)`.
pub fn nullable_optional<'de, D: Deserializer<'de>, T: Deserialize<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

// ── Unions ───────────────────────────────────────────────────────────────────────────────────────

/// Reads one JSON value whole, for a union to look at before choosing an option. Values nested deeper than
/// [`BUFFER_DEPTH`] are skipped and kept as `null`: the unions' own fields are a few levels deep, so only keys zod
/// strips go that deep, and `JSON.parse` (unlike a recursive reader) takes any depth.
pub fn buffer<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Value, D::Error> {
    Buffer { depth: 0 }.deserialize(deserializer)
}

/// Levels a union's buffer keeps.
pub const BUFFER_DEPTH: usize = 16;

struct Buffer {
    depth: usize,
}

impl<'de> DeserializeSeed<'de> for Buffer {
    type Value = Value;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        if self.depth > BUFFER_DEPTH {
            de::IgnoredAny::deserialize(deserializer)?;
            return Ok(Value::Null);
        }
        deserializer.deserialize_any(self)
    }
}

impl<'de> Visitor<'de> for Buffer {
    type Value = Value;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    fn visit_bool<E: de::Error>(self, value: bool) -> Result<Value, E> {
        Ok(Value::Bool(value))
    }

    fn visit_i64<E: de::Error>(self, value: i64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    fn visit_u64<E: de::Error>(self, value: u64) -> Result<Value, E> {
        Ok(Value::from(value))
    }

    /// ±Infinity (`1e400` as `JSON.parse` reads it) has no JSON value: it becomes `null`, refused by every numeric
    /// field as Infinity is.
    fn visit_f64<E: de::Error>(self, value: f64) -> Result<Value, E> {
        Ok(serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number))
    }

    fn visit_str<E: de::Error>(self, value: &str) -> Result<Value, E> {
        Ok(Value::String(value.to_owned()))
    }

    fn visit_string<E: de::Error>(self, value: String) -> Result<Value, E> {
        Ok(Value::String(value))
    }

    fn visit_unit<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<Value, E> {
        Ok(Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<Value, D::Error> {
        self.deserialize(deserializer)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Value, A::Error> {
        let mut items = Vec::new();
        while let Some(item) = seq.next_element_seed(Buffer {
            depth: self.depth + 1,
        })? {
            items.push(item);
        }
        Ok(Value::Array(items))
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Value, A::Error> {
        let mut object = serde_json::Map::new();
        while let Some(key) = map.next_key::<String>()? {
            let value = map.next_value_seed(Buffer {
                depth: self.depth + 1,
            })?;
            // A repeated key keeps its first position and takes the last value, as JSON.parse does.
            object.insert(key, value);
        }
        Ok(Value::Object(object))
    }
}

/// A `z.discriminatedUnion` (types.rs `discriminated!`): its options by tag, read straight from the object when the
/// tag is its first key (as every writer of the model puts it), else through the [`buffer`].
pub trait Discriminated: Sized {
    const FIELD: &'static str;
    /// The option `tag`, read from the rest of its object; None: no option has this tag.
    fn option<'de, A: MapAccess<'de>>(tag: &str, rest: A) -> Option<Result<Self, A::Error>>;
    /// The option read from the whole buffered value.
    fn from_buffer<E: de::Error>(value: &Value) -> Result<Self, E>;
}

/// Reads a [`Discriminated`] union. With the tag first, the option reads the rest of the object directly (its
/// values through the same strict deserializer), with no buffer: what the buffered path accepts, this accepts with
/// the same value, except a repeated tag, which it refuses (the JSON reader then takes the text as `JSON.parse`
/// does, `json.rs`). Otherwise (another key first, a tag that is not a string, not an object) the value is buffered
/// as before.
pub fn discriminated<'de, T: Discriminated, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<T, D::Error> {
    deserializer.deserialize_any(Union(std::marker::PhantomData))
}

struct Union<T>(std::marker::PhantomData<T>);

macro_rules! buffered {
    ($($method:ident($ty:ty))*) => {$(
        fn $method<E: de::Error>(self, value: $ty) -> Result<T, E> {
            T::from_buffer(&Buffer { depth: 0 }.$method::<E>(value)?)
        }
    )*};
}

impl<'de, T: Discriminated> Visitor<'de> for Union<T> {
    type Value = T;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a JSON value")
    }

    buffered! {
        visit_bool(bool) visit_i64(i64) visit_u64(u64) visit_f64(f64) visit_str(&str) visit_string(String)
    }

    fn visit_unit<E: de::Error>(self) -> Result<T, E> {
        T::from_buffer(&Value::Null)
    }

    fn visit_none<E: de::Error>(self) -> Result<T, E> {
        T::from_buffer(&Value::Null)
    }

    fn visit_some<D: Deserializer<'de>>(self, deserializer: D) -> Result<T, D::Error> {
        T::from_buffer(&Buffer { depth: 0 }.deserialize(deserializer)?)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, seq: A) -> Result<T, A::Error> {
        T::from_buffer(&Buffer { depth: 0 }.visit_seq(seq)?)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<T, A::Error> {
        let mut object = serde_json::Map::new();
        match map.next_key_seed(KeyIs(T::FIELD))? {
            None => {}
            Some(Key::Tag) => {
                let value = map.next_value_seed(Buffer { depth: 1 })?;
                if let Value::String(tag) = &value {
                    return T::option(
                        tag,
                        Rest {
                            map,
                            field: T::FIELD,
                        },
                    )
                    .unwrap_or_else(|| Err(unknown_tag(T::FIELD, tag)));
                }
                object.insert(T::FIELD.to_owned(), value);
            }
            Some(Key::Other(key)) => {
                let value = map.next_value_seed(Buffer { depth: 1 })?;
                object.insert(key.into_owned(), value);
            }
        }
        // The buffered path: the rest as `Buffer::visit_map` reads it (a repeated key keeps its first position and
        // takes the last value).
        while let Some(key) = map.next_key::<String>()? {
            let value = map.next_value_seed(Buffer { depth: 1 })?;
            object.insert(key, value);
        }
        T::from_buffer(&Value::Object(object))
    }
}

/// A map key: the union's tag, or another (borrowed from the input when it can be).
enum Key<'de> {
    Tag,
    Other(std::borrow::Cow<'de, str>),
}

struct KeyIs(&'static str);

impl<'de> DeserializeSeed<'de> for KeyIs {
    type Value = Key<'de>;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<Key<'de>, D::Error> {
        deserializer.deserialize_str(self)
    }
}

impl<'de> Visitor<'de> for KeyIs {
    type Value = Key<'de>;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a key")
    }

    fn visit_borrowed_str<E: de::Error>(self, key: &'de str) -> Result<Key<'de>, E> {
        Ok(if key == self.0 {
            Key::Tag
        } else {
            Key::Other(key.into())
        })
    }

    fn visit_str<E: de::Error>(self, key: &str) -> Result<Key<'de>, E> {
        Ok(if key == self.0 {
            Key::Tag
        } else {
            Key::Other(key.to_owned().into())
        })
    }
}

/// The rest of a union's object after its leading tag: the option reads it as a map; the tag again is refused.
pub struct Rest<A> {
    map: A,
    field: &'static str,
}

impl<'de, A: MapAccess<'de>> MapAccess<'de> for Rest<A> {
    type Error = A::Error;

    fn next_key_seed<K: DeserializeSeed<'de>>(
        &mut self,
        seed: K,
    ) -> Result<Option<K::Value>, A::Error> {
        match self.map.next_key_seed(KeyIs(self.field))? {
            None => Ok(None),
            Some(Key::Tag) => Err(de::Error::custom(format_args!(
                "a repeated discriminator `{}`",
                self.field
            ))),
            Some(Key::Other(std::borrow::Cow::Borrowed(key))) => seed
                .deserialize(de::value::BorrowedStrDeserializer::new(key))
                .map(Some),
            Some(Key::Other(std::borrow::Cow::Owned(key))) => seed
                .deserialize(de::value::StringDeserializer::new(key))
                .map(Some),
        }
    }

    fn next_value_seed<V: DeserializeSeed<'de>>(&mut self, seed: V) -> Result<V::Value, A::Error> {
        self.map.next_value_seed(seed)
    }

    fn size_hint(&self) -> Option<usize> {
        self.map.size_hint()
    }
}

/// A tag-only option (`{"type": "NONE", …}`): the rest of the object is read and dropped.
pub fn drain<'de, A: MapAccess<'de>>(mut rest: A) -> Result<(), A::Error> {
    while rest.next_key::<de::IgnoredAny>()?.is_some() {
        rest.next_value::<de::IgnoredAny>()?;
    }
    Ok(())
}

/// One option of a union, read from the buffered value with the strict rules.
pub fn from_value<T: DeserializeOwned, E: de::Error>(value: &Value) -> Result<T, E> {
    T::deserialize(Strict(value)).map_err(E::custom)
}

/// The discriminator of a `z.discriminatedUnion` option: the value must be an object, and its tag a string.
pub fn tag<'a, E: de::Error>(value: &'a Value, field: &str) -> Result<&'a str, E> {
    match value {
        Value::Object(map) => match map.get(field) {
            Some(Value::String(tag)) => Ok(tag),
            _ => Err(E::custom(format_args!("invalid discriminator `{field}`"))),
        },
        _ => Err(E::invalid_type(unexpected(value), &"an object")),
    }
}

/// An unknown discriminator value.
pub fn unknown_tag<E: de::Error>(field: &str, tag: &str) -> E {
    E::custom(format_args!("invalid discriminator `{field}`: `{tag}`"))
}

fn unexpected(value: &Value) -> de::Unexpected<'_> {
    match value {
        Value::Null => de::Unexpected::Unit,
        Value::Bool(value) => de::Unexpected::Bool(*value),
        Value::Number(_) => de::Unexpected::Other("number"),
        Value::String(value) => de::Unexpected::Str(value),
        Value::Array(_) => de::Unexpected::Seq,
        Value::Object(_) => de::Unexpected::Map,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    #[derive(Debug, Deserialize, PartialEq)]
    struct Point {
        x: f64,
        y: f64,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "SCREAMING_SNAKE_CASE")]
    enum Mode {
        None,
        Horizontal,
    }

    #[derive(Debug, Deserialize, PartialEq)]
    #[serde(rename_all = "camelCase")]
    struct Holder {
        point: Point,
        mode: Mode,
        #[serde(default, deserialize_with = "some")]
        maybe: Option<f64>,
        #[serde(deserialize_with = "nullable")]
        parent_id: Option<String>,
        #[serde(default, deserialize_with = "nullable_optional")]
        min_width: Option<Option<f64>>,
        points: Vec<Point>,
    }

    fn parse(json: &str) -> Result<Holder, serde_json::Error> {
        let mut de = serde_json::Deserializer::from_str(json);
        let value = Holder::deserialize(Strict(&mut de))?;
        de.end()?;
        Ok(value)
    }

    #[test]
    fn reads_objects_and_strings() {
        let holder = parse(r#"{"point":{"x":1,"y":2},"mode":"NONE","parentId":null,"points":[{"x":0,"y":0}],"extra":[1]}"#).unwrap();
        assert_eq!(holder.point, Point { x: 1.0, y: 2.0 });
        assert_eq!(holder.mode, Mode::None);
        assert_eq!(holder.maybe, None);
        assert_eq!(holder.parent_id, None);
        assert_eq!(holder.min_width, None);
    }

    #[test]
    fn refuses_structs_from_arrays_at_any_depth() {
        assert!(parse(r#"{"point":[1,2],"mode":"NONE","parentId":null,"points":[]}"#).is_err());
        assert!(
            parse(r#"{"point":{"x":1,"y":2},"mode":"NONE","parentId":null,"points":[[0,0]]}"#)
                .is_err()
        );
        assert!(parse(r#"[{"x":1,"y":2},"NONE",null,null,null,[]]"#).is_err());
    }

    #[test]
    fn refuses_enums_from_maps() {
        assert!(
            parse(r#"{"point":{"x":1,"y":2},"mode":{"NONE":null},"parentId":null,"points":[]}"#)
                .is_err()
        );
        assert!(
            parse(r#"{"point":{"x":1,"y":2},"mode":"none","parentId":null,"points":[]}"#).is_err()
        );
    }

    #[test]
    fn optional_nullable_and_both() {
        let base = r#""point":{"x":1,"y":2},"mode":"HORIZONTAL","points":[]"#;
        // .optional(): null refused.
        assert!(parse(&format!(r#"{{{base},"parentId":null,"maybe":null}}"#)).is_err());
        assert_eq!(
            parse(&format!(r#"{{{base},"parentId":null,"maybe":3}}"#))
                .unwrap()
                .maybe,
            Some(3.0)
        );
        // .nullable(): the key is required.
        assert!(parse(&format!(r#"{{{base}}}"#)).is_err());
        assert_eq!(
            parse(&format!(r#"{{{base},"parentId":"a"}}"#))
                .unwrap()
                .parent_id
                .as_deref(),
            Some("a")
        );
        // .nullable().optional(): null and absent stay apart.
        assert_eq!(
            parse(&format!(r#"{{{base},"parentId":null,"minWidth":null}}"#))
                .unwrap()
                .min_width,
            Some(None)
        );
        assert_eq!(
            parse(&format!(r#"{{{base},"parentId":null,"minWidth":5}}"#))
                .unwrap()
                .min_width,
            Some(Some(5.0))
        );
    }

    #[test]
    fn buffered_values_stay_strict() {
        let value: Value = serde_json::from_str(r#"{"x":[1],"y":2}"#).unwrap();
        assert!(from_value::<Point, serde_json::Error>(&value).is_err());
        let value: Value = serde_json::from_str(r#"[1,2]"#).unwrap();
        assert!(from_value::<Point, serde_json::Error>(&value).is_err());
        let value: Value = serde_json::from_str(r#"{"x":1,"y":2,"z":"ignored"}"#).unwrap();
        assert_eq!(
            from_value::<Point, serde_json::Error>(&value).unwrap(),
            Point { x: 1.0, y: 2.0 }
        );
    }

    fn paint(json: &str) -> Result<crate::types::Paint, serde_json::Error> {
        let mut de = serde_json::Deserializer::from_str(json);
        let value = crate::types::Paint::deserialize(Strict(&mut de))?;
        de.end()?;
        Ok(value)
    }

    fn buffered(json: &str) -> Result<crate::types::Paint, serde_json::Error> {
        let value: Value = serde_json::from_str(json).unwrap();
        <crate::types::Paint as Discriminated>::from_buffer(&value)
    }

    #[test]
    fn unions_read_in_one_pass_as_through_the_buffer() {
        for json in [
            r#"{"type":"SOLID","color":{"r":1,"g":0,"b":0},"opacity":1,"visible":true,"blendMode":"NORMAL","x":[[1]]}"#,
            r#"{"color":{"r":1,"g":0,"b":0},"type":"SOLID","opacity":1,"visible":true,"blendMode":"NORMAL"}"#,
            r#"{"type":"GRADIENT_LINEAR","gradientStops":[{"position":0,"color":{"r":0,"g":0,"b":0,"a":1}}],"gradientHandlePositions":[{"x":0,"y":0},{"x":1,"y":0},{"x":0,"y":1}],"opacity":1,"visible":true,"blendMode":"NORMAL"}"#,
        ] {
            assert_eq!(paint(json).unwrap(), buffered(json).unwrap(), "{json}");
        }
        // Refused either way: an unknown or non-string tag, a missing field, a struct from an array, not an object.
        for json in [
            r#"{"type":"PLAID","opacity":1}"#,
            r#"{"type":1,"opacity":1}"#,
            r#"{"type":"SOLID","opacity":1,"visible":true,"blendMode":"NORMAL"}"#,
            r#"{"type":"SOLID","color":[1,0,0],"opacity":1,"visible":true,"blendMode":"NORMAL"}"#,
            r#""SOLID""#,
            r#"[{"type":"SOLID"}]"#,
        ] {
            assert!(paint(json).is_err(), "{json}");
            assert!(buffered(json).is_err(), "{json}");
        }
        let error = paint(r#"{"type":"PLAID","opacity":1}"#)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("invalid discriminator `type`: `PLAID`"),
            "{error}"
        );
        // A tag-only option drops the rest of its object.
        let mut de = serde_json::Deserializer::from_str(
            r#"{"type":"NONE","extra":{"deep":[1,{"a":null}]}}"#,
        );
        assert_eq!(
            crate::types::PrototypeDevice::deserialize(Strict(&mut de)).unwrap(),
            crate::types::PrototypeDevice::None
        );
    }

    #[test]
    fn a_repeated_tag_is_read_as_json_parse_does() {
        let json = r#"{"type":"SOLID","color":{"r":1,"g":0,"b":0},"opacity":1,"visible":true,"blendMode":"NORMAL","type":"PLAID"}"#;
        // One pass refuses it; the buffer (and JSON.parse) keeps the last tag, which is unknown here.
        assert!(paint(json).is_err());
        assert!(buffered(json).is_err());
        let json = r#"{"type":"PLAID","color":{"r":1,"g":0,"b":0},"opacity":1,"visible":true,"blendMode":"NORMAL","type":"SOLID"}"#;
        assert!(paint(json).is_err());
        assert!(matches!(buffered(json), Ok(crate::types::Paint::Solid(_))));
    }
}
