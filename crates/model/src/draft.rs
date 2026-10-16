//! What every stage of normalization shares: the hasher of node ids, `sameValue`'s tolerance and comparison, the text
//! measurer the stages are given ([`Ctx`]). The working copy itself is [`crate::store::draft::Working`] (lane N1): the
//! stages read the store's own nodes and write fields; this file keeps the pieces that do not depend on the node
//! representation.
//!
//! **Equality.** TS's `update(id, fields)` compares each key it is given with `sameValue` and keeps only the keys that
//! differ: numbers within [`LAYOUT_EPSILON`], everything else exactly. [`same_value`] walks a value's serde
//! serialization, so it covers every type the model has without a hand-written comparison per type (`Working` compares
//! pointer-first and reaches for it only where a value differs).

use std::fmt;

use serde::ser::{self, Serialize};

/// Node ids in the order they were added: iteration is deterministic.
/// The hasher of node ids in the drafts and the store's interners: foldhash (hashbrown's default), except in the
/// editor's wasm build, where foldhash's 64×64-bit multiplies are emulated and the hashing showed in the normalize
/// profile (lane E1): FxHash there. The server's wasm build keeps foldhash (feature `foldhash-ids`): it reads ids from
/// requests, where FxHash's collisions could be forced.
#[cfg(any(not(target_family = "wasm"), feature = "foldhash-ids"))]
pub type IdHasher = hashbrown::DefaultHashBuilder;
#[cfg(all(target_family = "wasm", not(feature = "foldhash-ids")))]
pub type IdHasher = rustc_hash::FxBuildHasher;

/// Writes closer than this to the stored value are dropped (`LAYOUT_EPSILON` in constraints.ts):
/// without a tolerance, floating-point noise would turn every re-run of a pass into a change and
/// normalizing would never settle.
pub const LAYOUT_EPSILON: f64 = 1e-6;

/// `sameValue` for two numbers.
pub fn same_f64(a: f64, b: f64) -> bool {
    a == b || (a - b).abs() <= LAYOUT_EPSILON
}

/// `sameValue` (constraints.ts) for any serializable value: numbers within [`LAYOUT_EPSILON`],
/// strings, booleans and nulls exactly, arrays and objects member by member, an absent optional
/// field the same as an absent one. Values are compared as their JSON would be (`Some(x)` is `x`,
/// every number type is a number), so it works for model types and `serde_json::Value` alike.
/// Struct fields and map entries are compared in order.
pub fn same_value<T: Serialize + ?Sized>(a: &T, b: &T) -> bool {
    Comparer::default().same(a, b)
}

/// lane L3 owns text and may refine it. It lives here because [`Ctx`] carries one and every crate
/// with stages depends on this one.
pub trait TextMeasurer {
    /// Advance width in px of `text` set in `font`, without letter spacing.
    fn width(&self, text: &str, font: &FontSpec<'_>) -> f64;
    /// Ascent above and descent below the baseline in px, both positive.
    fn metrics(&self, font: &FontSpec<'_>) -> FontMetrics;
}

/// `FontSpec` (text-layout.ts).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontSpec<'a> {
    pub family: &'a str,
    pub weight: f64,
    pub italic: bool,
    pub size: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FontMetrics {
    pub ascent: f64,
    pub descent: f64,
}

/// The fixed-width fake both sides of the normalize oracle measure with (`testMeasurer` in
/// `tests/helpers/design-big-files.ts`): every UTF-16 unit is half the font size wide (JavaScript's
/// `text.length` counts UTF-16 units), ascent 0.8 and descent 0.2 of the size.
#[derive(Clone, Copy, Debug, Default)]
pub struct FixedWidthMeasurer;

impl TextMeasurer for FixedWidthMeasurer {
    fn width(&self, text: &str, font: &FontSpec<'_>) -> f64 {
        text.encode_utf16().count() as f64 * font.size * 0.5
    }

    fn metrics(&self, font: &FontSpec<'_>) -> FontMetrics {
        FontMetrics {
            ascent: font.size * 0.8,
            descent: font.size * 0.2,
        }
    }
}

/// What stages read besides the draft (TS `NormalizeContext`).
pub struct Ctx {
    /// Text auto-resize and layout measure text with it. [`FixedWidthMeasurer`] by default.
    pub measurer: Box<dyn TextMeasurer>,
}

impl Default for Ctx {
    fn default() -> Self {
        Self {
            measurer: Box::new(FixedWidthMeasurer),
        }
    }
}

impl fmt::Debug for Ctx {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Ctx").finish_non_exhaustive()
    }
}

// ── sameValue over serde ─────────────────────────────────────────────────────────────────────────

/// Compares values by their serialization: the first is recorded as tokens, the second checked
/// against them as it serializes (stopping at the first difference). The buffers are kept between
/// comparisons, so a draft's comparisons allocate nothing once warm.
#[derive(Clone, Debug, Default)]
pub(crate) struct Comparer {
    tokens: Vec<Recorded>,
    text: Vec<u8>,
}

impl Comparer {
    pub(crate) fn same<T: Serialize + ?Sized>(&mut self, a: &T, b: &T) -> bool {
        self.tokens.clear();
        self.text.clear();
        if a.serialize(&mut Tokens(Recorder(self))).is_err() {
            return false;
        }
        let mut checker = Checker {
            comparer: self,
            at: 0,
        };
        b.serialize(&mut Tokens(&mut checker)).is_ok()
            && checker.at == checker.comparer.tokens.len()
    }
}

/// A step of a serialization as JSON sees it: every number is a number, `Some(x)` is `x`, structs
/// and maps are objects, an enum variant with data is `{variant: data}`.
#[derive(Clone, Copy, Debug)]
enum Token<'a> {
    Number(f64),
    Bool(bool),
    Text(&'a str),
    Bytes(&'a [u8]),
    Null,
    Seq,
    Map,
    End,
    Field(&'static str),
}

/// A recorded token, its text kept in the comparer's buffer.
#[derive(Clone, Debug)]
enum Recorded {
    Number(f64),
    Bool(bool),
    Text(usize, usize),
    Bytes(usize, usize),
    Null,
    Seq,
    Map,
    End,
    Field(&'static str),
}

/// The values differ (or one failed to serialize).
#[derive(Debug)]
struct Differs;

impl fmt::Display for Differs {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("the values differ")
    }
}

impl std::error::Error for Differs {}

impl ser::Error for Differs {
    fn custom<T: fmt::Display>(_: T) -> Self {
        Differs
    }
}

trait Sink {
    fn token(&mut self, token: Token<'_>) -> Result<(), Differs>;
}

struct Recorder<'c>(&'c mut Comparer);

impl Sink for Recorder<'_> {
    fn token(&mut self, token: Token<'_>) -> Result<(), Differs> {
        let comparer = &mut *self.0;
        let mut text = |bytes: &[u8]| {
            let start = comparer.text.len();
            comparer.text.extend_from_slice(bytes);
            (start, comparer.text.len())
        };
        let recorded = match token {
            Token::Number(n) => Recorded::Number(n),
            Token::Bool(b) => Recorded::Bool(b),
            Token::Text(s) => {
                let (start, end) = text(s.as_bytes());
                Recorded::Text(start, end)
            }
            Token::Bytes(b) => {
                let (start, end) = text(b);
                Recorded::Bytes(start, end)
            }
            Token::Null => Recorded::Null,
            Token::Seq => Recorded::Seq,
            Token::Map => Recorded::Map,
            Token::End => Recorded::End,
            Token::Field(name) => Recorded::Field(name),
        };
        comparer.tokens.push(recorded);
        Ok(())
    }
}

struct Checker<'c> {
    comparer: &'c Comparer,
    at: usize,
}

impl Sink for &mut Checker<'_> {
    fn token(&mut self, token: Token<'_>) -> Result<(), Differs> {
        let Some(recorded) = self.comparer.tokens.get(self.at) else {
            return Err(Differs);
        };
        self.at += 1;
        let text = &self.comparer.text;
        let same = match (recorded, token) {
            (Recorded::Number(a), Token::Number(b)) => same_f64(*a, b),
            (Recorded::Bool(a), Token::Bool(b)) => *a == b,
            (Recorded::Text(start, end), Token::Text(s)) => text[*start..*end] == *s.as_bytes(),
            (Recorded::Bytes(start, end), Token::Bytes(b)) => text[*start..*end] == *b,
            (Recorded::Null, Token::Null)
            | (Recorded::Seq, Token::Seq)
            | (Recorded::Map, Token::Map)
            | (Recorded::End, Token::End) => true,
            (Recorded::Field(a), Token::Field(b)) => *a == b,
            _ => false,
        };
        if same { Ok(()) } else { Err(Differs) }
    }
}

/// A serde serializer that turns a value into [`Token`]s for a [`Sink`].
struct Tokens<S>(S);

impl<S: Sink> Tokens<S> {
    fn emit(&mut self, token: Token<'_>) -> Result<(), Differs> {
        self.0.token(token)
    }

    fn variant(&mut self, variant: &'static str, open: Token<'_>) -> Result<&mut Self, Differs> {
        self.emit(Token::Map)?;
        self.emit(Token::Field(variant))?;
        self.emit(open)?;
        Ok(self)
    }
}

impl<S: Sink> ser::Serializer for &mut Tokens<S> {
    type Ok = ();
    type Error = Differs;
    type SerializeSeq = Self;
    type SerializeTuple = Self;
    type SerializeTupleStruct = Self;
    type SerializeTupleVariant = Self;
    type SerializeMap = Self;
    type SerializeStruct = Self;
    type SerializeStructVariant = Self;

    fn serialize_bool(self, v: bool) -> Result<(), Differs> {
        self.emit(Token::Bool(v))
    }

    fn serialize_i8(self, v: i8) -> Result<(), Differs> {
        self.emit(Token::Number(v.into()))
    }

    fn serialize_i16(self, v: i16) -> Result<(), Differs> {
        self.emit(Token::Number(v.into()))
    }

    fn serialize_i32(self, v: i32) -> Result<(), Differs> {
        self.emit(Token::Number(v.into()))
    }

    fn serialize_i64(self, v: i64) -> Result<(), Differs> {
        self.emit(Token::Number(v as f64))
    }

    fn serialize_i128(self, v: i128) -> Result<(), Differs> {
        self.emit(Token::Number(v as f64))
    }

    fn serialize_u8(self, v: u8) -> Result<(), Differs> {
        self.emit(Token::Number(v.into()))
    }

    fn serialize_u16(self, v: u16) -> Result<(), Differs> {
        self.emit(Token::Number(v.into()))
    }

    fn serialize_u32(self, v: u32) -> Result<(), Differs> {
        self.emit(Token::Number(v.into()))
    }

    fn serialize_u64(self, v: u64) -> Result<(), Differs> {
        self.emit(Token::Number(v as f64))
    }

    fn serialize_u128(self, v: u128) -> Result<(), Differs> {
        self.emit(Token::Number(v as f64))
    }

    fn serialize_f32(self, v: f32) -> Result<(), Differs> {
        self.emit(Token::Number(v.into()))
    }

    fn serialize_f64(self, v: f64) -> Result<(), Differs> {
        self.emit(Token::Number(v))
    }

    fn serialize_char(self, v: char) -> Result<(), Differs> {
        self.emit(Token::Text(v.encode_utf8(&mut [0; 4])))
    }

    fn serialize_str(self, v: &str) -> Result<(), Differs> {
        self.emit(Token::Text(v))
    }

    fn serialize_bytes(self, v: &[u8]) -> Result<(), Differs> {
        self.emit(Token::Bytes(v))
    }

    fn serialize_none(self) -> Result<(), Differs> {
        self.emit(Token::Null)
    }

    fn serialize_some<T: Serialize + ?Sized>(self, value: &T) -> Result<(), Differs> {
        value.serialize(self)
    }

    fn serialize_unit(self) -> Result<(), Differs> {
        self.emit(Token::Null)
    }

    fn serialize_unit_struct(self, _name: &'static str) -> Result<(), Differs> {
        self.emit(Token::Null)
    }

    fn serialize_unit_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
    ) -> Result<(), Differs> {
        self.emit(Token::Text(variant))
    }

    fn serialize_newtype_struct<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        value: &T,
    ) -> Result<(), Differs> {
        value.serialize(self)
    }

    fn serialize_newtype_variant<T: Serialize + ?Sized>(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        value: &T,
    ) -> Result<(), Differs> {
        self.emit(Token::Map)?;
        self.emit(Token::Field(variant))?;
        value.serialize(&mut *self)?;
        self.emit(Token::End)
    }

    fn serialize_seq(self, _len: Option<usize>) -> Result<Self, Differs> {
        self.emit(Token::Seq)?;
        Ok(self)
    }

    fn serialize_tuple(self, _len: usize) -> Result<Self, Differs> {
        self.emit(Token::Seq)?;
        Ok(self)
    }

    fn serialize_tuple_struct(self, _name: &'static str, _len: usize) -> Result<Self, Differs> {
        self.emit(Token::Seq)?;
        Ok(self)
    }

    fn serialize_tuple_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self, Differs> {
        self.variant(variant, Token::Seq)
    }

    fn serialize_map(self, _len: Option<usize>) -> Result<Self, Differs> {
        self.emit(Token::Map)?;
        Ok(self)
    }

    fn serialize_struct(self, _name: &'static str, _len: usize) -> Result<Self, Differs> {
        self.emit(Token::Map)?;
        Ok(self)
    }

    fn serialize_struct_variant(
        self,
        _name: &'static str,
        _index: u32,
        variant: &'static str,
        _len: usize,
    ) -> Result<Self, Differs> {
        self.variant(variant, Token::Map)
    }
}

impl<S: Sink> ser::SerializeSeq for &mut Tokens<S> {
    type Ok = ();
    type Error = Differs;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Differs> {
        value.serialize(&mut **self)
    }

    fn end(self) -> Result<(), Differs> {
        self.emit(Token::End)
    }
}

impl<S: Sink> ser::SerializeTuple for &mut Tokens<S> {
    type Ok = ();
    type Error = Differs;

    fn serialize_element<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Differs> {
        value.serialize(&mut **self)
    }

    fn end(self) -> Result<(), Differs> {
        self.emit(Token::End)
    }
}

impl<S: Sink> ser::SerializeTupleStruct for &mut Tokens<S> {
    type Ok = ();
    type Error = Differs;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Differs> {
        value.serialize(&mut **self)
    }

    fn end(self) -> Result<(), Differs> {
        self.emit(Token::End)
    }
}

impl<S: Sink> ser::SerializeTupleVariant for &mut Tokens<S> {
    type Ok = ();
    type Error = Differs;

    fn serialize_field<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Differs> {
        value.serialize(&mut **self)
    }

    fn end(self) -> Result<(), Differs> {
        self.emit(Token::End)?;
        self.emit(Token::End)
    }
}

impl<S: Sink> ser::SerializeMap for &mut Tokens<S> {
    type Ok = ();
    type Error = Differs;

    fn serialize_key<T: Serialize + ?Sized>(&mut self, key: &T) -> Result<(), Differs> {
        key.serialize(&mut **self)
    }

    fn serialize_value<T: Serialize + ?Sized>(&mut self, value: &T) -> Result<(), Differs> {
        value.serialize(&mut **self)
    }

    fn end(self) -> Result<(), Differs> {
        self.emit(Token::End)
    }
}

impl<S: Sink> ser::SerializeStruct for &mut Tokens<S> {
    type Ok = ();
    type Error = Differs;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Differs> {
        self.emit(Token::Field(key))?;
        value.serialize(&mut **self)
    }

    fn end(self) -> Result<(), Differs> {
        self.emit(Token::End)
    }
}

impl<S: Sink> ser::SerializeStructVariant for &mut Tokens<S> {
    type Ok = ();
    type Error = Differs;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Differs> {
        self.emit(Token::Field(key))?;
        value.serialize(&mut **self)
    }

    fn end(self) -> Result<(), Differs> {
        self.emit(Token::End)?;
        self.emit(Token::End)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::DesignDocument;
    use serde_json::json;

    /// A page holding a frame holding a rectangle, as shared/design/defaults.ts `createNode` makes them.
    fn document() -> DesignDocument {
        let node = |id: &str, kind: &str, parent: Option<&str>, children: Option<Vec<&str>>| {
            let mut node = json!({
                "id": id, "type": kind, "name": id, "parentId": parent,
                "visible": true, "locked": false, "opacity": 1, "blendMode": "NORMAL", "isMask": false,
                "x": 10, "y": 20, "width": 100, "height": 50, "rotation": 0,
                "fills": [{"type": "SOLID", "color": {"r": 0.85, "g": 0.85, "b": 0.85}, "opacity": 1, "visible": true, "blendMode": "NORMAL"}],
                "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE", "strokeCap": "NONE", "strokeJoin": "MITER",
                "strokeMiterLimit": 4, "dashPattern": [], "effects": [], "constraints": {"horizontal": "MIN", "vertical": "MIN"},
                "layoutPositioning": "AUTO", "layoutSizingHorizontal": "FIXED", "layoutSizingVertical": "FIXED",
                "exportSettings": [], "reactions": []
            });
            if let Some(children) = children {
                node["children"] = json!(children);
            }
            node
        };
        let doc = json!({
            "schemaVersion": 1,
            "pages": ["page"],
            "nodes": {
                "page": node("page", "PAGE", None, Some(vec!["frame"])),
                "frame": node("frame", "FRAME", Some("page"), Some(vec!["rect"])),
                "rect": node("rect", "RECTANGLE", Some("frame"), None),
            },
            "styles": {}, "images": {}, "variableCollections": {}, "variables": {},
            "variableModes": {"frame": {"collection": "dark"}}
        });
        serde_json::from_value(doc).expect("a valid document")
    }

    #[test]
    fn same_value_is_typescripts() {
        assert!(same_value(&1.0, &(1.0 + 1e-7)));
        assert!(!same_value(&1.0, &1.00001));
        assert!(same_value(
            &json!({"a": [1, 2.0000001, {"b": "x"}]}),
            &json!({"a": [1, 2, {"b": "x"}]})
        ));
        assert!(!same_value(&json!({"a": [1, 2]}), &json!({"a": [1, 2, 3]})));
        assert!(!same_value(&json!({"a": "x"}), &json!({"a": "y"})));
        assert!(!same_value(&json!({"a": null}), &json!({"a": 0})));
        assert!(!same_value(&json!({"a": 1}), &json!({"b": 1})));
        assert!(same_value(&Some(vec![0.5_f32]), &Some(vec![0.5000001_f32])));
        assert!(!same_value(&None::<f64>, &Some(0.0)));
        let node = &document().nodes["rect"];
        let mut moved = node.clone();
        moved.fills = serde_json::from_value(json!([{"type": "SOLID", "color": {"r": 0.8500001, "g": 0.85, "b": 0.85}, "opacity": 1, "visible": true, "blendMode": "NORMAL"}])).expect("a paint");
        assert!(same_value(node, &moved) && *node != moved);
        moved.name = "other".into();
        assert!(!same_value(node, &moved));
    }

    #[test]
    fn the_fixed_width_measurer_counts_utf16_units() {
        let font = FontSpec {
            family: "Inter",
            weight: 400.0,
            italic: false,
            size: 20.0,
        };
        assert_eq!(FixedWidthMeasurer.width("Жук😀", &font), 50.0);
        assert_eq!(
            FixedWidthMeasurer.metrics(&font),
            FontMetrics {
                ascent: 16.0,
                descent: 4.0
            }
        );
    }
}
