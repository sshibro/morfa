//! Field-level remote changes (protocol 2, lane W): a `change` carries a node the file already had as the fields that
//! changed, not as the whole node. `fields: {<id>: {set: {<field>: value}, unset: [<field>]}}` beside `patch`, field
//! names as `shared/design/types.ts` writes them; `patch.nodes` keeps only the nodes that are new or removed.
//!
//! The receiver spreads `set` over the node it holds at the change's previous version and drops `unset`: the result is
//! the node the server stored, and every value the change did not touch (fills, strokes, effects, text) keeps the
//! receiver's own object, so caches keyed by identity survive other people's edits.
//!
//! The server computes the fields once per change from what it already has: the stored patch and the op's undo (the
//! node before). A field is compared by its postcard bytes (exact: the same value writes the same bytes, `-0` and `0`
//! differ). Nothing else changes: the journal, checkpoints, acks (`own`) and `op`s keep whole nodes.

use morfa_model::{DocumentPatch, Map, NodeId, SceneNode};
use serde::de::{Deserialize, Deserializer};
use serde::ser::{self, Serialize, SerializeMap, SerializeStruct, Serializer};
use std::fmt;

/// One node's fields as the server computed them: `set` and `unset` name fields of `Change::patch.nodes[index]`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NodeDiff {
    /// Where the node is in the change's `patch.nodes`.
    pub index: usize,
    pub set: Vec<&'static str>,
    pub unset: Vec<&'static str>,
}

/// One node's fields as read from a frame.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NodeFields {
    #[serde(default, skip_serializing_if = "serde_json::Map::is_empty")]
    pub set: serde_json::Map<String, serde_json::Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unset: Vec<String>,
}

/// A change's field-level nodes.
#[derive(Debug, Clone, PartialEq)]
pub enum ChangeFields {
    /// What the server sends. The change's `patch` is then the whole stored patch; these nodes are written as
    /// `fields` and left out of `patch.nodes` on the wire.
    Diff(Vec<NodeDiff>),
    /// As a client reads it: `patch` holds only what the frame's `patch` held.
    Read(Map<NodeFields>),
}

impl ChangeFields {
    pub fn len(&self) -> usize {
        match self {
            ChangeFields::Diff(diffs) => diffs.len(),
            ChangeFields::Read(map) => map.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl<'de> Deserialize<'de> for ChangeFields {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Map::<NodeFields>::deserialize(deserializer).map(ChangeFields::Read)
    }
}

// ── Computing ────────────────────────────────────────────────────────────────────────────────────

/// The field-level form of a stored patch: every node that existed before (`undo` holds it) and still exists, as the
/// fields that differ. None when no node qualifies (the change is all new or removed nodes, or other tables): the
/// whole-node change is then the same message in both protocols.
pub fn diff(stored: &DocumentPatch, undo: &DocumentPatch) -> Option<ChangeFields> {
    let nodes = stored.nodes.as_ref()?;
    let before = undo.nodes.as_ref()?;
    let mut diffs = Vec::new();
    let (mut old, mut new) = (Split::default(), Split::default());
    for (index, (id, node)) in nodes.iter().enumerate() {
        let (Some(node), Some(Some(prior))) = (node, before.get(id)) else {
            continue;
        };
        if old.read(prior).is_err() || new.read(node).is_err() {
            // Never for the model's types; the node then goes whole.
            continue;
        }
        diffs.push(new.against(&old, index));
    }
    (!diffs.is_empty()).then_some(ChangeFields::Diff(diffs))
}

/// A node's top-level fields: name and the bytes of its value (postcard), in declaration order.
#[derive(Default)]
struct Split {
    bytes: Vec<u8>,
    fields: Vec<(&'static str, usize, usize)>,
}

impl Split {
    fn read(&mut self, node: &SceneNode) -> Result<(), Unsupported> {
        self.bytes.clear();
        self.fields.clear();
        node.serialize(&mut *self)
    }

    fn value(&self, at: usize) -> &[u8] {
        let (_, start, end) = self.fields[at];
        &self.bytes[start..end]
    }

    /// The fields of this node that differ from `old`'s, and those `old` has and this one does not. Both list their
    /// fields in declaration order (one type), so one walk pairs them.
    fn against(&self, old: &Split, index: usize) -> NodeDiff {
        let (mut set, mut unset) = (Vec::new(), Vec::new());
        let mut j = 0;
        for (i, &(name, _, _)) in self.fields.iter().enumerate() {
            let mut found = None;
            for k in j..old.fields.len() {
                if std::ptr::eq(old.fields[k].0, name) || old.fields[k].0 == name {
                    found = Some(k);
                    break;
                }
            }
            match found {
                Some(k) => {
                    unset.extend(old.fields[j..k].iter().map(|f| f.0));
                    if old.value(k) != self.value(i) {
                        set.push(name);
                    }
                    j = k + 1;
                }
                None => set.push(name),
            }
        }
        unset.extend(old.fields[j..].iter().map(|f| f.0));
        NodeDiff { index, set, unset }
    }
}

#[derive(Debug)]
struct Unsupported;

impl fmt::Display for Unsupported {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("a node is a struct")
    }
}

impl std::error::Error for Unsupported {}

impl ser::Error for Unsupported {
    fn custom<T: fmt::Display>(_: T) -> Self {
        Unsupported
    }
}

impl serde::de::Error for Unsupported {
    fn custom<T: fmt::Display>(_: T) -> Self {
        Unsupported
    }
}

/// Every field `SceneNode` reads, as JSON names it (serde's own list, taken once from its derived reader): an op's
/// field names are matched against it, so a [`NodeDiff`] names fields by `&'static str` as the server's diff does.
pub fn scene_node_fields() -> &'static [&'static str] {
    static FIELDS: std::sync::OnceLock<&'static [&'static str]> = std::sync::OnceLock::new();
    FIELDS.get_or_init(|| {
        struct Capture(&'static [&'static str]);
        impl<'de> Deserializer<'de> for &mut Capture {
            type Error = Unsupported;
            fn deserialize_any<V: serde::de::Visitor<'de>>(self, _: V) -> Result<V::Value, Unsupported> {
                Err(Unsupported)
            }
            fn deserialize_struct<V: serde::de::Visitor<'de>>(
                self,
                _: &'static str,
                fields: &'static [&'static str],
                _: V,
            ) -> Result<V::Value, Unsupported> {
                self.0 = fields;
                Err(Unsupported)
            }
            serde::forward_to_deserialize_any! {
                bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str string bytes byte_buf option unit
                unit_struct newtype_struct seq tuple tuple_struct map enum identifier ignored_any
            }
        }
        let mut capture = Capture(&[]);
        let _ = SceneNode::deserialize(&mut capture);
        capture.0
    })
}

/// `name` as [`scene_node_fields`] holds it.
pub fn scene_node_field(name: &str) -> Option<&'static str> {
    scene_node_fields()
        .iter()
        .copied()
        .find(|field| *field == name)
}

/// The serializer methods a [`Split`] or an [`Only`] does not take: anything but a struct.
macro_rules! not_a_struct {
    ($ok:ty, $err:expr) => {
        fn serialize_bool(self, _: bool) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_i8(self, _: i8) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_i16(self, _: i16) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_i32(self, _: i32) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_i64(self, _: i64) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_u8(self, _: u8) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_u16(self, _: u16) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_u32(self, _: u32) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_u64(self, _: u64) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_f32(self, _: f32) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_f64(self, _: f64) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_char(self, _: char) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_str(self, _: &str) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_bytes(self, _: &[u8]) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_none(self) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_some<T: Serialize + ?Sized>(self, _: &T) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_unit(self) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_unit_struct(self, _: &'static str) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_unit_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
        ) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_newtype_struct<T: Serialize + ?Sized>(
            self,
            _: &'static str,
            _: &T,
        ) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_newtype_variant<T: Serialize + ?Sized>(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: &T,
        ) -> Result<$ok, Self::Error> {
            Err($err)
        }
        fn serialize_seq(self, _: Option<usize>) -> Result<Self::SerializeSeq, Self::Error> {
            Err($err)
        }
        fn serialize_tuple(self, _: usize) -> Result<Self::SerializeTuple, Self::Error> {
            Err($err)
        }
        fn serialize_tuple_struct(
            self,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleStruct, Self::Error> {
            Err($err)
        }
        fn serialize_tuple_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeTupleVariant, Self::Error> {
            Err($err)
        }
        fn serialize_map(self, _: Option<usize>) -> Result<Self::SerializeMap, Self::Error> {
            Err($err)
        }
        fn serialize_struct_variant(
            self,
            _: &'static str,
            _: u32,
            _: &'static str,
            _: usize,
        ) -> Result<Self::SerializeStructVariant, Self::Error> {
            Err($err)
        }
    };
}

impl Serializer for &mut Split {
    type Ok = ();
    type Error = Unsupported;
    type SerializeSeq = ser::Impossible<(), Unsupported>;
    type SerializeTuple = ser::Impossible<(), Unsupported>;
    type SerializeTupleStruct = ser::Impossible<(), Unsupported>;
    type SerializeTupleVariant = ser::Impossible<(), Unsupported>;
    type SerializeMap = ser::Impossible<(), Unsupported>;
    type SerializeStruct = Self;
    type SerializeStructVariant = ser::Impossible<(), Unsupported>;

    not_a_struct!((), Unsupported);

    fn serialize_struct(self, _: &'static str, _: usize) -> Result<Self, Unsupported> {
        Ok(self)
    }
}

impl SerializeStruct for &mut Split {
    type Ok = ();
    type Error = Unsupported;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), Unsupported> {
        let start = self.bytes.len();
        let bytes = std::mem::take(&mut self.bytes);
        self.bytes = postcard::to_extend(value, bytes).map_err(|_| Unsupported)?;
        self.fields.push((key, start, self.bytes.len()));
        Ok(())
    }

    fn end(self) -> Result<(), Unsupported> {
        Ok(())
    }
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────

/// `patch` without the nodes `diffs` carry; `nodes` is left out when nothing is left in it.
pub(crate) struct PatchWithout<'a> {
    pub patch: &'a DocumentPatch,
    pub diffs: &'a [NodeDiff],
}

impl Serialize for PatchWithout<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        // Every field by name: a new table does not compile until it is written here too (as the derived impl does).
        let DocumentPatch {
            nodes,
            pages,
            styles,
            images,
            variable_collections,
            variables,
            variable_modes,
        } = self.patch;
        let mut out = serializer.serialize_struct("DocumentPatch", 7)?;
        match nodes {
            Some(nodes) if nodes.len() > self.diffs.len() => out.serialize_field(
                "nodes",
                &NodesWithout {
                    nodes,
                    diffs: self.diffs,
                },
            )?,
            Some(_) => out.skip_field("nodes")?,
            None => out.skip_field("nodes")?,
        }
        macro_rules! table {
            ($name:literal, $value:expr) => {
                match $value {
                    Some(value) => out.serialize_field($name, value)?,
                    None => out.skip_field($name)?,
                }
            };
        }
        table!("pages", pages);
        table!("styles", styles);
        table!("images", images);
        table!("variableCollections", variable_collections);
        table!("variables", variables);
        table!("variableModes", variable_modes);
        out.end()
    }
}

struct NodesWithout<'a> {
    nodes: &'a Map<Option<SceneNode>>,
    diffs: &'a [NodeDiff],
}

impl Serialize for NodesWithout<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_map(Some(self.nodes.len() - self.diffs.len()))?;
        let mut skip = self.diffs.iter().map(|d| d.index).peekable();
        for (index, (id, node)) in self.nodes.iter().enumerate() {
            if skip.next_if_eq(&index).is_some() {
                continue;
            }
            out.serialize_entry(id, node)?;
        }
        out.end()
    }
}

/// The `fields` object of a [`ChangeFields::Diff`] over `patch`.
pub(crate) struct DiffOut<'a> {
    pub patch: &'a DocumentPatch,
    pub diffs: &'a [NodeDiff],
}

impl Serialize for DiffOut<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let nodes = self.patch.nodes.as_ref();
        let mut out = serializer.serialize_map(Some(self.diffs.len()))?;
        for diff in self.diffs {
            let Some((id, Some(node))) = nodes.and_then(|nodes| nodes.get_index(diff.index)) else {
                return Err(ser::Error::custom(
                    "a field change names a node the patch does not hold",
                ));
            };
            out.serialize_entry(id, &DiffNode { node, diff })?;
        }
        out.end()
    }
}

struct DiffNode<'a> {
    node: &'a SceneNode,
    diff: &'a NodeDiff,
}

impl Serialize for DiffNode<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut out = serializer.serialize_struct("NodeFields", 2)?;
        if self.diff.set.is_empty() {
            out.skip_field("set")?;
        } else {
            out.serialize_field(
                "set",
                &Only {
                    node: self.node,
                    keys: &self.diff.set,
                },
            )?;
        }
        if self.diff.unset.is_empty() {
            out.skip_field("unset")?;
        } else {
            out.serialize_field("unset", &self.diff.unset)?;
        }
        out.end()
    }
}

/// The fields `keys` of `node`, written by the node's own `Serialize` (same names, same values, same order).
struct Only<'a> {
    node: &'a SceneNode,
    keys: &'a [&'static str],
}

impl Serialize for Only<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        self.node.serialize(OnlySer {
            inner: serializer,
            keys: self.keys,
        })
    }
}

struct OnlySer<'a, S> {
    inner: S,
    keys: &'a [&'static str],
}

struct OnlyStruct<'a, S> {
    inner: S,
    keys: &'a [&'static str],
}

fn not_struct<E: ser::Error>() -> E {
    E::custom("only a struct's fields can be picked")
}

impl<'a, S: Serializer> Serializer for OnlySer<'a, S> {
    type Ok = S::Ok;
    type Error = S::Error;
    type SerializeSeq = ser::Impossible<S::Ok, S::Error>;
    type SerializeTuple = ser::Impossible<S::Ok, S::Error>;
    type SerializeTupleStruct = ser::Impossible<S::Ok, S::Error>;
    type SerializeTupleVariant = ser::Impossible<S::Ok, S::Error>;
    type SerializeMap = ser::Impossible<S::Ok, S::Error>;
    type SerializeStruct = OnlyStruct<'a, S::SerializeStruct>;
    type SerializeStructVariant = ser::Impossible<S::Ok, S::Error>;

    not_a_struct!(S::Ok, not_struct());

    fn serialize_struct(
        self,
        name: &'static str,
        _: usize,
    ) -> Result<Self::SerializeStruct, S::Error> {
        Ok(OnlyStruct {
            inner: self.inner.serialize_struct(name, self.keys.len())?,
            keys: self.keys,
        })
    }
}

impl<S: SerializeStruct> SerializeStruct for OnlyStruct<'_, S> {
    type Ok = S::Ok;
    type Error = S::Error;

    fn serialize_field<T: Serialize + ?Sized>(
        &mut self,
        key: &'static str,
        value: &T,
    ) -> Result<(), S::Error> {
        if self.keys.contains(&key) {
            self.inner.serialize_field(key, value)
        } else {
            Ok(())
        }
    }

    fn end(self) -> Result<S::Ok, S::Error> {
        self.inner.end()
    }
}

// ── Applying (Rust clients: loadgen, tests) ──────────────────────────────────────────────────────

/// `{...node, ...set}` without `unset`: the node the server stored.
pub fn spread(node: &SceneNode, fields: &NodeFields) -> Result<SceneNode, String> {
    spread_owned(node.clone(), &fields.set, &fields.unset)
}

/// `node` with `set` written and `unset` removed, every value read as `SceneNode` reads it. The fields the hot paths
/// write (`morfa_model::json::NODE_FIELD_KEYS`: position, size, rotation, opacity, visibility, name, text, fills,
/// strokes, effects) are read straight into the typed node; any other goes through the model's strict reader on the
/// node's JSON form.
pub fn spread_owned(
    mut node: SceneNode,
    set: &serde_json::Map<String, serde_json::Value>,
    unset: &[String],
) -> Result<SceneNode, String> {
    use morfa_model::json::{NODE_FIELD_KEYS, node_fields_from_json};
    if unset.is_empty()
        && set
            .keys()
            .all(|key| NODE_FIELD_KEYS.contains(&key.as_str()))
    {
        if set.is_empty() {
            return Ok(node);
        }
        let text =
            serde_json::to_string(&serde_json::json!({ "n": set })).map_err(|e| e.to_string())?;
        let entries = node_fields_from_json(&text).map_err(|e| e.message)?;
        for (_, fields) in entries {
            for field in fields {
                if !field.apply(&mut node) {
                    return Err("text.characters on a layer without text".into());
                }
            }
        }
        return Ok(node);
    }
    let serde_json::Value::Object(mut object) =
        serde_json::to_value(&node).map_err(|e| e.to_string())?
    else {
        return Err("a node is an object".into());
    };
    for (key, value) in set {
        object.insert(key.clone(), value.clone());
    }
    for key in unset {
        object.remove(key);
    }
    let patch = serde_json::json!({ "nodes": { "n": object } });
    let mut read: DocumentPatch =
        morfa_model::patch_from_deserializer(patch).map_err(|e| e.to_string())?;
    read.nodes
        .as_mut()
        .and_then(|nodes| nodes.shift_remove("n"))
        .flatten()
        .ok_or_else(|| "a node is an object".into())
}

/// The whole-node patch of a change read from a frame, its field-level nodes spread over `node(id)`: the node the
/// receiver holds at the change's previous version. An error when a node is missing or does not read back.
pub fn resolve(
    patch: &DocumentPatch,
    fields: Option<&ChangeFields>,
    mut node: impl FnMut(&NodeId) -> Option<SceneNode>,
) -> Result<DocumentPatch, String> {
    let Some(fields) = fields else {
        return Ok(patch.clone());
    };
    let mut out = patch.clone();
    match fields {
        ChangeFields::Diff(_) => {}
        ChangeFields::Read(map) => {
            let nodes = out.nodes.get_or_insert_with(Map::default);
            for (id, fields) in map {
                let base = node(id).ok_or_else(|| format!("fields for {id}, a node not held"))?;
                nodes.insert(id.clone(), Some(spread(&base, fields)?));
            }
        }
    }
    Ok(out)
}
