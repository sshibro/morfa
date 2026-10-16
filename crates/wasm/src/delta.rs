//! The entries a working copy wrote, as JavaScript applies them: a node that existed crosses as the fields that changed
//! (`{"set": {key: value}, "unset": [keys]}`, merged over the node JavaScript holds; the mask is
//! `store::fields::changed_mask`, pointer-first), a new node whole, a removed one as `null`, a node that changed its
//! box alone as five numbers. A layout write moves four numbers of a node with sixty fields: sending the whole node
//! cost ≈ 16 µs to write and ≈ 12 µs to parse back, per node.

use morfa_model::store::fields::Field;
use morfa_model::store::{Node, PropKey};
use morfa_model::{JsFormatter, SceneNode, to_json};
use serde::Serialize;
use serde::ser::{self, Impossible};
use std::cell::RefCell;
use std::fmt;
use std::sync::Arc;

thread_local! {
    /// The bytes [`push_json`] writes through, kept between calls.
    static BYTES: RefCell<Vec<u8>> = const { RefCell::new(Vec::new()) };
}

/// `out.push_str(&to_json(value))` without `to_json`'s fresh 4 KiB buffer per value (one per field and id of an
/// output: the allocator's work showed in the normalize profile).
pub(crate) fn push_json<T: Serialize + ?Sized>(out: &mut String, value: &T) {
    BYTES.with(|bytes| {
        let mut bytes = bytes.borrow_mut();
        bytes.clear();
        let mut serializer = serde_json::Serializer::with_formatter(&mut *bytes, JsFormatter);
        value
            .serialize(&mut serializer)
            .expect("the model always serializes");
        out.push_str(std::str::from_utf8(&bytes).expect("serde_json writes UTF-8"));
    });
}

/// Bits of `store::fields::changed_mask` whose values a component edit copies to every copy of it alike
/// (instances/sync.rs): the fields `normalize` shares between the nodes of one output ([`SHARED`]), as the TypeScript
/// side reads them from `normalized_numbers(1)` (shared/design/engine-switch.ts).
#[cfg(test)]
const FILLS: u32 = 19;
#[cfg(test)]
const STROKES: u32 = 20;
#[cfg(test)]
const EFFECTS: u32 = 27;
#[cfg(test)]
const TEXT: u32 = 68;

/// The heavy fields a copy shares with its main (`same`): their bit in `changed_mask` and their key.
pub(crate) const SHARED: [(Field, &str); 4] = [
    (Field::Fills, "fills"),
    (Field::Strokes, "strokes"),
    (Field::Effects, "effects"),
    (Field::Prop(PropKey::Text), "text"),
];

/// The address of a node's heavy value, `None` for an empty list or no text.
pub(crate) fn heavy_ptr(node: &Node, field: Field) -> Option<usize> {
    match field {
        Field::Fills => node.fills.ptr(),
        Field::Strokes => node.strokes.ptr(),
        Field::Effects => node.effects.ptr(),
        _ => node.props.text().map(|text| Arc::as_ptr(text) as usize),
    }
}

/// A node that differs from `base` in x, y, width or height at most (`Working::box_only`) as five numbers for
/// `MorfaDoc.normalized_numbers(0)`: `index × 16 + mask` (its place in `written`; bit 0 x, 1 y, 2 width, 3 height: the
/// values that changed) and then x, y, width and height (0 where unchanged). `false` for a changed value JSON has no
/// number for (the entry then crosses as [`write_box_delta`]'s JSON, which writes it as `null` as the field walk does).
pub(crate) fn push_box(out: &mut Vec<f64>, index: usize, next: &Node, base: [f64; 4]) -> bool {
    let now = [next.x, next.y, next.width, next.height];
    let mut mask = 0u32;
    for (bit, (value, was)) in now.iter().zip(base).enumerate() {
        if *value != was {
            if !value.is_finite() {
                return false;
            }
            mask |= 1 << bit;
        }
    }
    out.push((index * 16) as f64 + f64::from(mask));
    for (bit, value) in now.into_iter().enumerate() {
        out.push(if mask & (1 << bit) != 0 { value } else { 0.0 });
    }
    true
}

/// `{"set": {x, …}, "unset": []}` of a node that differs from `base` in x, y, width or height at most: those four
/// compared and written directly, the same text the field walk writes (declaration order).
pub(crate) fn write_box_delta(out: &mut String, next: &Node, base: [f64; 4]) {
    out.push_str("{\"set\":{");
    let mut first = true;
    let [x, y, width, height] = base;
    for (key, now, was) in [
        ("x", next.x, x),
        ("y", next.y, y),
        ("width", next.width, width),
        ("height", next.height, height),
    ] {
        if now != was {
            if !first {
                out.push(',');
            }
            first = false;
            out.push('"');
            out.push_str(key);
            out.push_str("\":");
            push_json(out, &now);
        }
    }
    out.push_str("},\"unset\":[]}");
}

/// What of a node crosses: the fields that changed, as values (`mask`, bits of `store::fields::changed_mask`, which
/// are the declaration order of `SceneNode`'s fields, serde's walk order), and those equal to a value an earlier node
/// sent (`same`: field bit, key, the sender's place in `written`, its id).
pub(crate) struct Planned<'a> {
    pub(crate) mask: u128,
    pub(crate) same: Vec<(u32, &'static str, usize, &'a str)>,
}

/// A planned node as `{"set": {…}, "unset": […], "same"?: {key: the sender's id}}`.
pub(crate) fn write_planned(out: &mut String, next: &SceneNode, planned: &Planned<'_>) {
    let mut walk = Walk {
        mask: planned.mask,
        index: 0,
        set: String::from("{"),
        unset: String::from("["),
    };
    // Only a struct reaches `Walk`; a failure would be a model change this code does not know: send the node whole.
    if next.serialize(&mut walk).is_err() {
        out.push_str(&to_json(next));
        return;
    }
    out.push_str("{\"set\":");
    out.push_str(&walk.set);
    out.push_str("},\"unset\":");
    out.push_str(&walk.unset);
    out.push(']');
    for (at, (_, key, _, sender)) in planned.same.iter().enumerate() {
        out.push_str(if at == 0 { ",\"same\":{\"" } else { ",\"" });
        out.push_str(key);
        out.push_str("\":");
        push_json(out, sender);
    }
    if !planned.same.is_empty() {
        out.push('}');
    }
    out.push('}');
}

struct Walk {
    mask: u128,
    index: u32,
    set: String,
    unset: String,
}

impl Walk {
    fn take(&mut self) -> bool {
        let keep = self.mask & (1u128 << self.index) != 0;
        self.index += 1;
        keep
    }
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

impl ser::SerializeStruct for &mut Walk {
    type Ok = ();
    type Error = NotAStruct;

    fn serialize_field<T: ?Sized + Serialize>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), NotAStruct> {
        if self.take() {
            if self.set.len() > 1 {
                self.set.push(',');
            }
            self.set.push('"');
            self.set.push_str(key);
            self.set.push_str("\":");
            push_json(&mut self.set, value);
        }
        Ok(())
    }

    fn skip_field(&mut self, key: &'static str) -> Result<(), NotAStruct> {
        if self.take() {
            if self.unset.len() > 1 {
                self.unset.push(',');
            }
            self.unset.push('"');
            self.unset.push_str(key);
            self.unset.push('"');
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

impl<'a> ser::Serializer for &'a mut Walk {
    type Ok = ();
    type Error = NotAStruct;
    type SerializeSeq = Impossible<(), NotAStruct>;
    type SerializeTuple = Impossible<(), NotAStruct>;
    type SerializeTupleStruct = Impossible<(), NotAStruct>;
    type SerializeTupleVariant = Impossible<(), NotAStruct>;
    type SerializeMap = Impossible<(), NotAStruct>;
    type SerializeStruct = &'a mut Walk;
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
    use morfa_model::store::Document;

    fn document(json: &str) -> morfa_model::DesignDocument {
        morfa_model::from_json(&format!(
            r#"{{"schemaVersion":1,"pages":["p"],"nodes":{{"p":{{"id":"p","type":"PAGE","name":"p","parentId":null,"children":["r"],"visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":0,"y":0,"width":0,"height":0,"rotation":0,"fills":[],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{{"horizontal":"MIN","vertical":"MIN"}},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[]}},"r":{json}}},"styles":{{}},"images":{{}},"variableCollections":{{}},"variables":{{}}}}"#
        ))
        .expect("a document")
    }

    fn node(json: &str) -> SceneNode {
        document(json).nodes["r"].clone()
    }

    const RECT: &str = r#"{"id":"r","type":"RECTANGLE","name":"r","parentId":"p","visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":1,"y":2,"width":3,"height":4,"rotation":0,"fills":[],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"cornerRadius":5}"#;

    fn bit(name: &str) -> u128 {
        1u128 << Field::from_name(name).expect(name).bit()
    }

    #[test]
    fn only_the_changed_fields_cross() {
        let mut next = node(RECT);
        next.x = 10.5;
        next.kind = morfa_model::NodeType::Ellipse;
        next.corner_radius = None;
        next.flip_x = Some(true);
        let planned = Planned {
            mask: bit("type") | bit("x") | bit("flipX") | bit("cornerRadius"),
            same: Vec::new(),
        };
        let mut out = String::new();
        write_planned(&mut out, &next, &planned);
        assert_eq!(
            out,
            r#"{"set":{"type":"ELLIPSE","x":10.5,"flipX":true},"unset":["cornerRadius"]}"#
        );
        let mut same = String::new();
        write_planned(
            &mut same,
            &node(RECT),
            &Planned {
                mask: 0,
                same: Vec::new(),
            },
        );
        assert_eq!(same, r#"{"set":{},"unset":[]}"#);
    }

    #[test]
    fn the_shared_fields_are_the_bits_they_name() {
        assert_eq!(Field::Fills.bit(), FILLS);
        assert_eq!(Field::Strokes.bit(), STROKES);
        assert_eq!(Field::Effects.bit(), EFFECTS);
        assert_eq!(Field::Prop(PropKey::Text).bit(), TEXT);
        for (field, key) in SHARED {
            assert_eq!(field.name(), key);
        }
    }

    #[test]
    fn a_value_sent_once_crosses_as_its_sender() {
        let mut copy = node(RECT);
        copy.width = 7.0;
        let planned = Planned {
            mask: bit("width"),
            same: vec![(TEXT, "text", 0, "main")],
        };
        let mut out = String::new();
        write_planned(&mut out, &copy, &planned);
        assert_eq!(
            out,
            r#"{"set":{"width":7},"unset":[],"same":{"text":"main"}}"#
        );
    }

    #[test]
    fn a_box_change_crosses_as_five_numbers() {
        let store = Document::from_model(&document(RECT));
        let mut next = store.node_by_key("r").expect("stored").clone();
        next.width = 30.25;
        next.y = -0.0;
        let mut out = Vec::new();
        assert!(push_box(&mut out, 3, &next, [1.0, 0.0, 3.0, 4.0]));
        assert_eq!(out, [3.0 * 16.0 + 4.0, 0.0, 0.0, 30.25, 0.0]);
        next.height = f64::NAN;
        assert!(!push_box(&mut out, 4, &next, [1.0, 0.0, 3.0, 4.0]));
        assert_eq!(out.len(), 5);
        let mut odd = String::new();
        write_box_delta(&mut odd, &next, [1.0, 0.0, 3.0, 4.0]);
        assert_eq!(odd, r#"{"set":{"width":30.25,"height":null},"unset":[]}"#);
    }
}
