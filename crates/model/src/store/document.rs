//! A stored document: its interners, the node slab, and the document's other tables.

use super::convert::Resolving;
use super::intern::with_bounds;
use super::value::{ImageAsset, Style, Variable, VariableCollection};
use super::{Atom, Id, Interner, Node, Symbol};
use indexmap::IndexMap;
use serde::de::{self, DeserializeSeed, SeqAccess, Visitor};
use serde::ser::SerializeTuple;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::sync::Arc;

/// One design file in memory. Clone it to keep a version: the clone shares every node and table with the original
/// until one side writes it.
#[derive(Clone)]
pub struct Document {
    pub(super) ids: Arc<Interner<Id>>,
    pub(super) atoms: Arc<Interner<Atom>>,
    /// Indexed by [`Id`]; `None` for an id that names no node (a removed node, or one only referred to).
    pub(super) nodes: Vec<Option<Arc<Node>>>,
    pub(super) count: usize,
    /// `DESIGN_SCHEMA_VERSION` (1) in a valid file.
    pub schema_version: f64,
    /// Page ids in panel order.
    pub pages: Vec<Id>,
    pub styles: Arc<IndexMap<Atom, Style>>,
    pub images: Arc<IndexMap<Atom, ImageAsset>>,
    pub variable_collections: Arc<IndexMap<Atom, VariableCollection>>,
    pub variables: Arc<IndexMap<Atom, Variable>>,
    /// Frame-like nodes' mode per collection: node → collection → mode.
    pub variable_modes: Option<Arc<IndexMap<Id, IndexMap<Atom, Atom>>>>,
    /// A board's document.
    pub board: Option<bool>,
}

impl Default for Document {
    fn default() -> Self {
        Document {
            ids: Arc::default(),
            atoms: Arc::default(),
            nodes: Vec::new(),
            count: 0,
            schema_version: crate::types::DESIGN_SCHEMA_VERSION,
            pages: Vec::new(),
            styles: Arc::default(),
            images: Arc::default(),
            variable_collections: Arc::default(),
            variables: Arc::default(),
            variable_modes: None,
            board: None,
        }
    }
}

impl Document {
    /// The node ids interner.
    pub fn ids(&self) -> &Interner<Id> {
        &self.ids
    }

    /// The id interner, shared (a working copy layers its own strings over it: [`super::Layer`]).
    pub fn ids_arc(&self) -> &Arc<Interner<Id>> {
        &self.ids
    }

    /// The atom interner, shared.
    pub fn atoms_arc(&self) -> &Arc<Interner<Atom>> {
        &self.atoms
    }

    fn resolver(&self) -> (&Interner<Id>, &Interner<Atom>) {
        (&self.ids, &self.atoms)
    }

    /// The interner of every other repeated string.
    pub fn atoms(&self) -> &Interner<Atom> {
        &self.atoms
    }

    /// The symbol of a node id, if the document has seen it.
    pub fn id(&self, key: &str) -> Option<Id> {
        self.ids.get(key)
    }

    /// The text of a node id.
    pub fn key(&self, id: Id) -> &str {
        self.ids.resolve(id)
    }

    /// The text of an atom.
    pub fn atom(&self, atom: Atom) -> &str {
        self.atoms.resolve(atom)
    }

    /// The symbol of a node id, interning it when new.
    pub fn intern_id(&mut self, key: &str) -> Id {
        match self.ids.get(key) {
            Some(id) => id,
            None => Arc::make_mut(&mut self.ids).intern(key),
        }
    }

    /// The symbol of a string, interning it when new.
    pub fn intern_atom(&mut self, value: &str) -> Atom {
        match self.atoms.get(value) {
            Some(atom) => atom,
            None => Arc::make_mut(&mut self.atoms).intern(value),
        }
    }

    /// The number of nodes.
    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    pub fn node(&self, id: Id) -> Option<&Node> {
        self.nodes.get(id.index())?.as_deref()
    }

    /// The shared node itself, to keep it past a later write or compare it by pointer.
    pub fn node_arc(&self, id: Id) -> Option<&Arc<Node>> {
        self.nodes.get(id.index())?.as_ref()
    }

    pub fn node_by_key(&self, key: &str) -> Option<&Node> {
        self.node(self.id(key)?)
    }

    /// A node to write: copied first if another version of the document still shares it.
    pub fn node_mut(&mut self, id: Id) -> Option<&mut Node> {
        self.nodes.get_mut(id.index())?.as_mut().map(Arc::make_mut)
    }

    /// Puts a node in its slot (its `id`), returning the node it replaces.
    pub fn insert(&mut self, node: impl Into<Arc<Node>>) -> Option<Arc<Node>> {
        let node = node.into();
        let index = node.id.index();
        assert!(
            index < self.ids.len(),
            "a node's id must come from this document's interner"
        );
        if index >= self.nodes.len() {
            self.nodes.resize(index + 1, None);
        }
        let previous = self.nodes[index].replace(node);
        if previous.is_none() {
            self.count += 1;
        }
        previous
    }

    pub fn remove(&mut self, id: Id) -> Option<Arc<Node>> {
        let removed = self.nodes.get_mut(id.index())?.take();
        if removed.is_some() {
            self.count -= 1;
        }
        removed
    }

    /// Every node, in slot order (for a document read from JSON, the file's key order).
    pub fn nodes(&self) -> impl Iterator<Item = &Node> {
        self.nodes.iter().filter_map(Option::as_deref)
    }

    /// Converts the whole document to the JSON model (types.ts).
    pub fn to_model(&self) -> crate::types::DesignDocument {
        super::convert::document_out(self, &Resolving::new(&self.resolver()))
    }

    /// The document's tables in the JSON model with an empty node table (pages, styles, images, variables,
    /// collections, variable modes, board); nodes are converted one by one ([`Document::node_model_of`]).
    pub fn tables_model(&self) -> crate::types::DesignDocument {
        super::convert::tables_out(self, &Resolving::new(&self.resolver()))
    }

    /// [`Document::node_model`] by symbol.
    pub fn node_model_of(&self, id: Id) -> Option<crate::types::SceneNode> {
        let node = self.node(id)?;
        Some(super::convert::node_out(
            node,
            &Resolving::new(&self.resolver()),
        ))
    }

    /// The slot count (one past the highest [`Id`] the interner gave): the length of a table indexed by node id.
    pub fn slots(&self) -> usize {
        self.ids.len()
    }

    /// One node in the JSON model (types.ts `SceneNode`), or `None` when the id names no node. The shadow document's
    /// `node(id)` (crates/wasm): one node converted, never the document.
    pub fn node_model(&self, key: &str) -> Option<crate::types::SceneNode> {
        let node = self.node_by_key(key)?;
        Some(super::convert::node_out(
            node,
            &Resolving::new(&self.resolver()),
        ))
    }
}

impl From<&crate::types::DesignDocument> for Document {
    fn from(doc: &crate::types::DesignDocument) -> Self {
        Document::from_model(doc)
    }
}

/// Two documents are equal when they hold the same strings under the same symbols, the same nodes and the same
/// tables (empty slots do not count).
impl PartialEq for Document {
    fn eq(&self, other: &Self) -> bool {
        self.ids == other.ids
            && self.atoms == other.atoms
            && self.count == other.count
            && self.nodes().eq(other.nodes())
            && self.schema_version.to_bits() == other.schema_version.to_bits()
            && self.pages == other.pages
            && self.styles == other.styles
            && self.images == other.images
            && self.variable_collections == other.variable_collections
            && self.variables == other.variables
            && self.variable_modes == other.variable_modes
            && self.board == other.board
    }
}

impl fmt::Debug for Document {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter
            .debug_struct("Document")
            .field("nodes", &self.count)
            .field("ids", &self.ids.len())
            .field("atoms", &self.atoms.len())
            .field("pages", &self.pages)
            .finish_non_exhaustive()
    }
}

// ── Binary shape ─────────────────────────────────────────────────────────────────────────────────
// A tuple: the two interners first (so every later symbol can be checked against them as it is read), then the nodes
// that exist, then the tables. For non-self-describing formats (`crate::codec`); JSON goes through the JSON model.

struct Slab<'a>(&'a [Option<Arc<Node>>], usize);

impl Serialize for Slab<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = serializer.serialize_seq(Some(self.1))?;
        for node in self.0.iter().flatten() {
            seq.serialize_element(&**node)?;
        }
        seq.end()
    }
}

const FIELDS: usize = 11;

impl Serialize for Document {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut tuple = serializer.serialize_tuple(FIELDS)?;
        tuple.serialize_element(&*self.ids)?;
        tuple.serialize_element(&*self.atoms)?;
        tuple.serialize_element(&Slab(&self.nodes, self.count))?;
        tuple.serialize_element(&self.schema_version)?;
        tuple.serialize_element(&self.pages)?;
        tuple.serialize_element(&*self.styles)?;
        tuple.serialize_element(&*self.images)?;
        tuple.serialize_element(&*self.variable_collections)?;
        tuple.serialize_element(&*self.variables)?;
        tuple.serialize_element(&self.variable_modes)?;
        tuple.serialize_element(&self.board)?;
        tuple.end()
    }
}

/// Reads the node list straight into the slab, each node into its id's slot (no intermediate `Vec<Node>`: for a
/// 20 000-node file that list and its growth were 5 MB allocated and copied once more). The value is the node count.
struct IntoSlots<'a>(&'a mut [Option<Arc<Node>>]);

impl<'de> DeserializeSeed<'de> for IntoSlots<'_> {
    type Value = usize;

    fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<usize, D::Error> {
        deserializer.deserialize_seq(self)
    }
}

impl<'de> Visitor<'de> for IntoSlots<'_> {
    type Value = usize;

    fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.write_str("a list of nodes")
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<usize, A::Error> {
        let mut count = 0;
        while let Some(node) = seq.next_element::<Node>()? {
            // In range: the node's id was checked against the id interner as it was read.
            let slot = &mut self.0[node.id.index()];
            if slot.is_some() {
                return Err(de::Error::custom("a node stored twice"));
            }
            *slot = Some(Arc::new(node));
            count += 1;
        }
        Ok(count)
    }
}

impl<'de> Deserialize<'de> for Document {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct DocumentVisitor;
        impl<'de> Visitor<'de> for DocumentVisitor {
            type Value = Document;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a stored document")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Document, A::Error> {
                fn next<'de, T: Deserialize<'de>, A: SeqAccess<'de>>(
                    seq: &mut A,
                    at: usize,
                ) -> Result<T, A::Error> {
                    seq.next_element()?
                        .ok_or_else(|| de::Error::invalid_length(at, &"a stored document"))
                }
                let ids: Interner<Id> = next(&mut seq, 0)?;
                let atoms: Interner<Atom> = next(&mut seq, 1)?;
                let slots = ids.len();
                let mut doc = with_bounds(ids.len(), atoms.len(), || {
                    let mut nodes: Vec<Option<Arc<Node>>> = vec![None; slots];
                    let count = seq
                        .next_element_seed(IntoSlots(&mut nodes))?
                        .ok_or_else(|| de::Error::invalid_length(2, &"a stored document"))?;
                    Ok(Document {
                        nodes,
                        count,
                        schema_version: next(&mut seq, 3)?,
                        pages: next(&mut seq, 4)?,
                        styles: Arc::new(next(&mut seq, 5)?),
                        images: Arc::new(next(&mut seq, 6)?),
                        variable_collections: Arc::new(next(&mut seq, 7)?),
                        variables: Arc::new(next(&mut seq, 8)?),
                        variable_modes: next::<Option<IndexMap<Id, IndexMap<Atom, Atom>>>, A>(
                            &mut seq, 9,
                        )?
                        .map(Arc::new),
                        board: next(&mut seq, 10)?,
                        ..Document::default()
                    })
                })?;
                doc.ids = Arc::new(ids);
                doc.atoms = Arc::new(atoms);
                Ok(doc)
            }
        }
        deserializer.deserialize_tuple(FIELDS, DocumentVisitor)
    }
}
