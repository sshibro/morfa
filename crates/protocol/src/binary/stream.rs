//! Reading a message frame without its [`Tree`](super::Tree): the model's types deserialize straight from the
//! postcard bytes, with the same rules as [`super::De`] over the tree (a struct only from an object, a sequence only
//! from an array, a unit variant only from a string). Every byte goes through postcard's own readers, as
//! `Tree::read` reads them (varints, booleans, UTF-8, the item tags), skipped values included, and every key must
//! index the key table; so a frame this reads, the tree reads too, to the same values. Callers fall back to the tree
//! on any error, which then gives the error the tree path gives.

use super::Error;
use serde::de::{self, DeserializeSeed, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer};

pub(super) type Postcard<'de> = postcard::Deserializer<'de, postcard::de_flavors::Slice<'de>>;

// `Item`'s variants, in their order (postcard writes the index).
const NULL: u32 = 0;
const BOOL: u32 = 1;
const INT: u32 = 2;
const NUM: u32 = 3;
const STR: u32 = 4;
const ARR: u32 = 5;
const OBJ: u32 = 6;

fn bad(e: postcard::Error) -> Error {
    Error(format!("damaged frame: {e}"))
}

/// Reads the next item's tag.
pub(super) fn tag(de: &mut Postcard<'_>) -> Result<u32, Error> {
    let tag = u32::deserialize(&mut *de).map_err(bad)?;
    if tag > OBJ {
        return Err(Error("damaged frame: an unknown item".into()));
    }
    Ok(tag)
}

pub(super) fn len(de: &mut Postcard<'_>) -> Result<usize, Error> {
    usize::deserialize(&mut *de).map_err(bad)
}

pub(super) fn int(de: &mut Postcard<'_>) -> Result<i64, Error> {
    i64::deserialize(&mut *de).map_err(bad)
}

pub(super) fn string<'de>(de: &mut Postcard<'de>) -> Result<&'de str, Error> {
    <&str>::deserialize(&mut *de).map_err(bad)
}

/// An object key: its index, checked against the table.
pub(super) fn key<'k>(de: &mut Postcard<'_>, keys: &[&'k str]) -> Result<&'k str, Error> {
    let index = u32::deserialize(&mut *de).map_err(bad)? as usize;
    keys.get(index)
        .copied()
        .ok_or_else(|| Error("a key outside the key table".into()))
}

/// Reads and drops the item whose tag was read.
pub(super) fn skip(de: &mut Postcard<'_>, keys: &[&str], tag: u32) -> Result<(), Error> {
    match tag {
        NULL => {}
        BOOL => {
            bool::deserialize(&mut *de).map_err(bad)?;
        }
        INT => {
            int(de)?;
        }
        NUM => {
            f64::deserialize(&mut *de).map_err(bad)?;
        }
        STR => {
            string(de)?;
        }
        ARR => {
            for _ in 0..len(de)? {
                let tag = self::tag(de)?;
                skip(de, keys, tag)?;
            }
        }
        _ => {
            for _ in 0..len(de)? {
                key(de, keys)?;
                let tag = self::tag(de)?;
                skip(de, keys, tag)?;
            }
        }
    }
    Ok(())
}

/// One item whose tag is read, as a serde deserializer.
pub(super) struct Item<'s, 'de> {
    pub(super) de: &'s mut Postcard<'de>,
    pub(super) keys: &'s [&'de str],
    pub(super) tag: u32,
}

impl<'s, 'de> Item<'s, 'de> {
    fn wrong<V: Visitor<'de>, T>(self, visitor: &V) -> Result<T, Error> {
        let unexpected = match self.tag {
            NULL => de::Unexpected::Unit,
            BOOL => de::Unexpected::Other("a boolean"),
            INT | NUM => de::Unexpected::Other("a number"),
            STR => de::Unexpected::Other("a string"),
            ARR => de::Unexpected::Seq,
            _ => de::Unexpected::Map,
        };
        Err(de::Error::invalid_type(unexpected, visitor))
    }
}

impl<'s, 'de> Deserializer<'de> for Item<'s, 'de> {
    type Error = Error;

    fn deserialize_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.tag {
            NULL => visitor.visit_unit(),
            BOOL => visitor.visit_bool(bool::deserialize(&mut *self.de).map_err(bad)?),
            INT => visitor.visit_i64(int(self.de)?),
            NUM => visitor.visit_f64(f64::deserialize(&mut *self.de).map_err(bad)?),
            STR => visitor.visit_borrowed_str(string(self.de)?),
            ARR => {
                let left = len(self.de)?;
                let mut seq = Seq {
                    de: self.de,
                    keys: self.keys,
                    left,
                };
                let value = visitor.visit_seq(&mut seq)?;
                // What the visitor left is read and dropped, as the tree's reader leaves it.
                while seq.left > 0 {
                    seq.left -= 1;
                    let tag = tag(seq.de)?;
                    skip(seq.de, seq.keys, tag)?;
                }
                Ok(value)
            }
            _ => {
                let left = len(self.de)?;
                let mut map = Map {
                    de: self.de,
                    keys: self.keys,
                    left,
                    value: None,
                };
                let value = visitor.visit_map(&mut map)?;
                map.drain()?;
                Ok(value)
            }
        }
    }

    fn deserialize_option<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.tag {
            NULL => visitor.visit_none(),
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
        match self.tag {
            ARR => self.deserialize_any(visitor),
            _ => self.wrong(&visitor),
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
        match self.tag {
            OBJ => self.deserialize_any(visitor),
            _ => self.wrong(&visitor),
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
        match self.tag {
            STR => visitor.visit_enum(Enum {
                name: string(self.de)?,
                value: None,
            }),
            OBJ => {
                if len(self.de)? != 1 {
                    return Err(Error(
                        "an enum from an object of other than one entry".into(),
                    ));
                }
                let name = key(self.de, self.keys)?;
                let tag = tag(self.de)?;
                visitor.visit_enum(Enum {
                    name,
                    value: Some(Item {
                        de: self.de,
                        keys: self.keys,
                        tag,
                    }),
                })
            }
            _ => self.wrong(&visitor),
        }
    }

    fn deserialize_str<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        match self.tag {
            STR => visitor.visit_borrowed_str(string(self.de)?),
            _ => self.wrong(&visitor),
        }
    }

    fn deserialize_string<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_str(visitor)
    }

    fn deserialize_identifier<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        self.deserialize_str(visitor)
    }

    fn deserialize_ignored_any<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Error> {
        skip(self.de, self.keys, self.tag)?;
        visitor.visit_unit()
    }

    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char bytes byte_buf unit unit_struct
    }
}

struct Seq<'s, 'de> {
    de: &'s mut Postcard<'de>,
    keys: &'s [&'de str],
    left: usize,
}

impl<'de> SeqAccess<'de> for &mut Seq<'_, 'de> {
    type Error = Error;

    fn next_element_seed<S: DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<Option<S::Value>, Error> {
        if self.left == 0 {
            return Ok(None);
        }
        self.left -= 1;
        let tag = tag(self.de)?;
        seed.deserialize(Item {
            de: self.de,
            keys: self.keys,
            tag,
        })
        .map(Some)
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.left)
    }
}

struct Map<'s, 'de> {
    de: &'s mut Postcard<'de>,
    keys: &'s [&'de str],
    left: usize,
    /// A key was read and its value not yet.
    value: Option<()>,
}

impl Map<'_, '_> {
    /// Reads and drops what the visitor left: an unread value, then the remaining entries.
    fn drain(&mut self) -> Result<(), Error> {
        if self.value.take().is_some() {
            let tag = tag(self.de)?;
            skip(self.de, self.keys, tag)?;
        }
        while self.left > 0 {
            self.left -= 1;
            key(self.de, self.keys)?;
            let tag = tag(self.de)?;
            skip(self.de, self.keys, tag)?;
        }
        Ok(())
    }
}

impl<'de> MapAccess<'de> for &mut Map<'_, 'de> {
    type Error = Error;

    fn next_key_seed<S: DeserializeSeed<'de>>(
        &mut self,
        seed: S,
    ) -> Result<Option<S::Value>, Error> {
        if self.value.take().is_some() {
            // The tree's reader moves on to the next entry when a value is not read.
            let tag = tag(self.de)?;
            skip(self.de, self.keys, tag)?;
        }
        if self.left == 0 {
            return Ok(None);
        }
        self.left -= 1;
        let key = key(self.de, self.keys)?;
        self.value = Some(());
        seed.deserialize(de::value::BorrowedStrDeserializer::new(key))
            .map(Some)
    }

    fn next_value_seed<S: DeserializeSeed<'de>>(&mut self, seed: S) -> Result<S::Value, Error> {
        if self.value.take().is_none() {
            return Err(Error("a value without a key".into()));
        }
        let tag = tag(self.de)?;
        seed.deserialize(Item {
            de: self.de,
            keys: self.keys,
            tag,
        })
    }

    fn size_hint(&self) -> Option<usize> {
        Some(self.left)
    }
}

struct Enum<'s, 'de> {
    name: &'de str,
    value: Option<Item<'s, 'de>>,
}

impl<'s, 'de> de::EnumAccess<'de> for Enum<'s, 'de> {
    type Error = Error;
    type Variant = Variant<'s, 'de>;

    fn variant_seed<S: DeserializeSeed<'de>>(
        self,
        seed: S,
    ) -> Result<(S::Value, Variant<'s, 'de>), Error> {
        let name = seed.deserialize(de::value::BorrowedStrDeserializer::new(self.name))?;
        Ok((name, Variant { value: self.value }))
    }
}

struct Variant<'s, 'de> {
    value: Option<Item<'s, 'de>>,
}

impl<'de> de::VariantAccess<'de> for Variant<'_, 'de> {
    type Error = Error;

    fn unit_variant(self) -> Result<(), Error> {
        match self.value {
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
