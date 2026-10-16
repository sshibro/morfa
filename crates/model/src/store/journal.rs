//! The op journal: each committed change as the server appends it to disk, and how a document is rebuilt from a
//! snapshot and the entries after it.
//!
//! An [`Entry`] is a patch already in the document's symbols: the strings it introduced (the tail of each interner
//! after the change), then whole nodes and table entries to put or remove. Replaying entries in order on the snapshot
//! they follow rebuilds the same interners, symbol for symbol, and the same document. Each entry records the interner
//! sizes it continues from, so an entry replayed on the wrong state is refused rather than misread.

use super::convert::entry_in;
use super::intern::with_bounds;
use super::value::{ImageAsset, Style, Variable, VariableCollection};
use super::{Atom, Document, Id, Node};
use crate::patch::DocumentPatch;
use indexmap::IndexMap;
use serde::de::{self, SeqAccess, Visitor};
use serde::ser::SerializeTuple;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::sync::Arc;

/// One committed change.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Entry {
    /// The id interner's size before this entry.
    pub ids_before: u32,
    /// The atom interner's size before this entry.
    pub atoms_before: u32,
    /// Node ids this entry introduced, in symbol order.
    pub new_ids: Vec<Box<str>>,
    /// Other strings this entry introduced, in symbol order.
    pub new_atoms: Vec<Box<str>>,
    /// Nodes put (whole) or removed.
    pub nodes: Vec<(Id, Option<Arc<Node>>)>,
    /// The new page order, when it changed.
    pub pages: Option<Vec<Id>>,
    pub styles: Vec<(Atom, Option<Style>)>,
    pub images: Vec<(Atom, Option<ImageAsset>)>,
    pub variable_collections: Vec<(Atom, Option<VariableCollection>)>,
    pub variables: Vec<(Atom, Option<Variable>)>,
    /// Mode choices put or removed; any entry here creates the table, as `applyPatch` does.
    pub variable_modes: Vec<(Id, Option<IndexMap<Atom, Atom>>)>,
}

/// Why an entry does not follow a document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReplayError {
    /// The entry continues interners of other sizes: it belongs to another state of the document.
    Sequence {
        ids: (u32, usize),
        atoms: (u32, usize),
    },
    /// A string the entry introduces is already interned.
    Repeated(String),
    /// A node stored under another node's id.
    Mismatch(Id),
}

impl fmt::Display for ReplayError {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        match self {
            ReplayError::Sequence { ids, atoms } => write!(
                formatter,
                "the entry follows {} ids and {} atoms, the document has {} and {}",
                ids.0, atoms.0, ids.1, atoms.1
            ),
            ReplayError::Repeated(value) => {
                write!(formatter, "the entry introduces {value:?} again")
            }
            ReplayError::Mismatch(id) => {
                write!(formatter, "a node stored under {id:?} has another id")
            }
        }
    }
}

impl std::error::Error for ReplayError {}

impl Document {
    /// Applies a patch (`applyPatch`) and returns its journal entry. A node put back after a removal takes its old
    /// slot (JavaScript would move its key to the end of the table).
    pub fn commit(&mut self, patch: &DocumentPatch) -> Entry {
        let entry = entry_in(self, patch);
        self.write(&entry);
        entry
    }

    /// Applies a patch in place, without keeping its entry.
    pub fn apply_patch(&mut self, patch: &DocumentPatch) {
        self.commit(patch);
    }

    /// Applies a journal entry: its new strings first (checked to continue this document's interners), then its writes.
    pub fn replay(&mut self, entry: &Entry) -> Result<(), ReplayError> {
        let (ids, atoms) = (self.ids.len(), self.atoms.len());
        if entry.ids_before as usize != ids || entry.atoms_before as usize != atoms {
            return Err(ReplayError::Sequence {
                ids: (entry.ids_before, ids),
                atoms: (entry.atoms_before, atoms),
            });
        }
        if let Some((id, _)) = entry
            .nodes
            .iter()
            .find(|(id, node)| node.as_ref().is_some_and(|node| node.id != *id))
        {
            return Err(ReplayError::Mismatch(*id));
        }
        if let Some(value) = entry
            .new_ids
            .iter()
            .find(|value| self.ids.get(value).is_some())
        {
            return Err(ReplayError::Repeated(value.to_string()));
        }
        if let Some(value) = entry
            .new_atoms
            .iter()
            .find(|value| self.atoms.get(value).is_some())
        {
            return Err(ReplayError::Repeated(value.to_string()));
        }
        if !entry.new_ids.is_empty() {
            let interner = Arc::make_mut(&mut self.ids);
            for value in &entry.new_ids {
                interner.intern(value);
            }
        }
        if !entry.new_atoms.is_empty() {
            let interner = Arc::make_mut(&mut self.atoms);
            for value in &entry.new_atoms {
                interner.intern(value);
            }
        }
        // A string repeated inside the entry itself would leave the interner short of what its symbols expect.
        if self.ids.len() != ids + entry.new_ids.len() {
            return Err(ReplayError::Repeated("a node id twice in one entry".into()));
        }
        if self.atoms.len() != atoms + entry.new_atoms.len() {
            return Err(ReplayError::Repeated("a string twice in one entry".into()));
        }
        self.write(entry);
        Ok(())
    }

    /// The entry's writes, its strings already interned.
    fn write(&mut self, entry: &Entry) {
        for (id, node) in &entry.nodes {
            match node {
                Some(node) => {
                    self.insert(node.clone());
                }
                None => {
                    self.remove(*id);
                }
            }
        }
        if let Some(pages) = &entry.pages {
            self.pages.clone_from(pages);
        }
        fn table<K: Copy + std::hash::Hash + Eq, V: Clone>(
            target: &mut Arc<IndexMap<K, V>>,
            changes: &[(K, Option<V>)],
        ) {
            if changes.is_empty() {
                return;
            }
            let target = Arc::make_mut(target);
            for (key, change) in changes {
                match change {
                    Some(value) => {
                        target.insert(*key, value.clone());
                    }
                    None => {
                        target.shift_remove(key);
                    }
                }
            }
        }
        table(&mut self.styles, &entry.styles);
        table(&mut self.images, &entry.images);
        table(&mut self.variable_collections, &entry.variable_collections);
        table(&mut self.variables, &entry.variables);
        if !entry.variable_modes.is_empty() {
            table(
                self.variable_modes.get_or_insert_with(Arc::default),
                &entry.variable_modes,
            );
        }
    }
}

/// The first bytes of an encoded entry.
pub const ENTRY_MAGIC: [u8; 4] = *b"MRFJ";

impl Entry {
    /// The entry as one journal record: `ENTRY_MAGIC`, the codec's format version, then the entry in postcard.
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(64 + self.nodes.len() * 160);
        out.extend_from_slice(&ENTRY_MAGIC);
        out.extend_from_slice(&crate::codec::FORMAT.to_le_bytes());
        postcard::to_io(self, &mut out).expect("writing to a Vec never fails");
        out
    }

    /// The entry of one journal record. Symbols are checked against what the entry may refer to; whether it follows
    /// a given document is checked by [`Document::replay`].
    pub fn from_bytes(bytes: &[u8]) -> Result<Entry, crate::codec::CodecError> {
        use crate::codec::CodecError;
        if bytes.len() < 6 || bytes[..4] != ENTRY_MAGIC {
            return Err(CodecError::NotAFrame);
        }
        let format = u16::from_le_bytes([bytes[4], bytes[5]]);
        if format != crate::codec::FORMAT {
            return Err(CodecError::Format(format));
        }
        let (entry, rest) = postcard::take_from_bytes::<Entry>(&bytes[6..])
            .map_err(|error| CodecError::Payload(error.to_string()))?;
        if !rest.is_empty() {
            return Err(CodecError::Payload(format!(
                "{} bytes after the entry",
                rest.len()
            )));
        }
        Ok(entry)
    }
}

// ── Binary shape ─────────────────────────────────────────────────────────────────────────────────
// The sizes and new strings first, so every symbol after them is checked against what the entry may refer to.

const FIELDS: usize = 11;

impl Serialize for Entry {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut tuple = serializer.serialize_tuple(FIELDS)?;
        tuple.serialize_element(&self.ids_before)?;
        tuple.serialize_element(&self.atoms_before)?;
        tuple.serialize_element(&self.new_ids)?;
        tuple.serialize_element(&self.new_atoms)?;
        tuple.serialize_element(&self.nodes)?;
        tuple.serialize_element(&self.pages)?;
        tuple.serialize_element(&self.styles)?;
        tuple.serialize_element(&self.images)?;
        tuple.serialize_element(&self.variable_collections)?;
        tuple.serialize_element(&self.variables)?;
        tuple.serialize_element(&self.variable_modes)?;
        tuple.end()
    }
}

impl<'de> Deserialize<'de> for Entry {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EntryVisitor;
        impl<'de> Visitor<'de> for EntryVisitor {
            type Value = Entry;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a journal entry")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Entry, A::Error> {
                fn next<'de, T: Deserialize<'de>, A: SeqAccess<'de>>(
                    seq: &mut A,
                    at: usize,
                ) -> Result<T, A::Error> {
                    seq.next_element()?
                        .ok_or_else(|| de::Error::invalid_length(at, &"a journal entry"))
                }
                let ids_before: u32 = next(&mut seq, 0)?;
                let atoms_before: u32 = next(&mut seq, 1)?;
                let new_ids: Vec<Box<str>> = next(&mut seq, 2)?;
                let new_atoms: Vec<Box<str>> = next(&mut seq, 3)?;
                let ids = ids_before as usize + new_ids.len();
                let atoms = atoms_before as usize + new_atoms.len();
                with_bounds(ids, atoms, || {
                    Ok(Entry {
                        nodes: next(&mut seq, 4)?,
                        pages: next(&mut seq, 5)?,
                        styles: next(&mut seq, 6)?,
                        images: next(&mut seq, 7)?,
                        variable_collections: next(&mut seq, 8)?,
                        variables: next(&mut seq, 9)?,
                        variable_modes: next(&mut seq, 10)?,
                        ids_before,
                        atoms_before,
                        new_ids,
                        new_atoms,
                    })
                })
            }
        }
        deserializer.deserialize_tuple(FIELDS, EntryVisitor)
    }
}
