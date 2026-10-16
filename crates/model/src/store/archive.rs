//! The store as an rkyv archive (feature `rkyv`), for the codec comparison; postcard
//! (`crate::codec`) stays the stored format.
//!
//! Most types derive rkyv's traits (attribute lines next to their serde derives). What needs code is here:
//!
//! - **Symbols** ([`Id`], [`Atom`]) are archived as their `u32` (1-based, little-endian). Reading one back checks it against the
//!   interner sizes set by [`with_bounds`], as the serde path does, so a hostile archive is refused rather than
//!   resolved out of range. A zero-copy reader ([`ArchivedDocument`]) sees raw numbers and resolves them with a
//!   checked lookup ([`ArchivedDocument::try_key`]).
//! - **Interners** are archived as their list of strings (rebuilt and checked for repeats when read back).
//! - **[`List`] and [`Props`]** are archived as plain vectors (no shared-pointer bookkeeping); a bag read back is sorted
//!   as `Props::new` does.
//! - **The node slab** ([`Slab`]) keeps the nodes that exist, in slot order; reading back puts each in its id's slot.
//!
//! Every other `Arc` (a node's children, the values in its bag, the strings) uses rkyv's shared pointers: unique in a
//! document, so they cost a registry entry each while writing, validating and reading, but no copy.

use super::intern::Symbol;
use super::node::Prop;
use super::{Atom, Document, Id, Interner, List, Node, Props};
use rkyv::de::Pool;
use rkyv::rancor::{Fallible, Source, Strategy};
use rkyv::rend::u32_le;
use rkyv::ser::{Allocator, Writer};
use rkyv::string::{ArchivedString, StringResolver};
use rkyv::vec::{ArchivedVec, VecResolver};
use rkyv::with::{ArchiveWith, SerializeWith};
use rkyv::{Archive, Deserialize, Place, Serialize};
use std::cell::Cell;
use std::fmt;
use std::sync::Arc;

pub use super::document::ArchivedDocument;
pub use super::journal::ArchivedEntry;
pub use super::node::{ArchivedNode, ArchivedProp};

thread_local! {
    /// While an archive is read back: how many ids and atoms its interners hold.
    static BOUNDS: Cell<Option<(u32, u32)>> = const { Cell::new(None) };
}

/// Sets the symbol bounds for the reading in `run` on this thread.
pub(crate) fn with_bounds<T>(ids: usize, atoms: usize, run: impl FnOnce() -> T) -> T {
    let previous = BOUNDS.with(|bounds| bounds.replace(Some((ids as u32, atoms as u32))));
    let result = run();
    BOUNDS.with(|bounds| bounds.set(previous));
    result
}

/// Why an archive does not read back as a document.
#[derive(Debug)]
pub enum Refused {
    /// A symbol that is 0 or past its interner.
    OutOfRange(&'static str),
    /// A symbol read outside of [`with_bounds`].
    Unbounded(&'static str),
    /// A string twice in one interner.
    Repeated,
    /// Two nodes in one slot.
    NodeTwice,
}

impl fmt::Display for Refused {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        match self {
            Refused::OutOfRange(kind) => write!(formatter, "{kind} out of range"),
            Refused::Unbounded(kind) => write!(formatter, "{kind} read without interner bounds"),
            Refused::Repeated => formatter.write_str("a repeated string in an interner"),
            Refused::NodeTwice => formatter.write_str("a node stored twice"),
        }
    }
}

impl std::error::Error for Refused {}

// ── Symbols ──────────────────────────────────────────────────────────────────────────────────────

macro_rules! archive_symbol {
    ($name:ident, $bound:tt) => {
        impl Archive for $name {
            type Archived = u32_le;
            type Resolver = ();

            fn resolve(&self, (): (), out: Place<Self::Archived>) {
                // 1-based like the in-memory symbol: 0 is never a symbol.
                let number = self.index() as u32 + 1;
                number.resolve((), out);
            }
        }

        impl<S: Fallible + ?Sized> Serialize<S> for $name {
            fn serialize(&self, _: &mut S) -> Result<(), S::Error> {
                Ok(())
            }
        }

        impl<D: Fallible + ?Sized> Deserialize<$name, D> for u32_le
        where
            D::Error: Source,
        {
            fn deserialize(&self, _: &mut D) -> Result<$name, D::Error> {
                let number = self.to_native();
                let Some(bounds) = BOUNDS.with(Cell::get) else {
                    return Err(D::Error::new(Refused::Unbounded(stringify!($name))));
                };
                if number == 0 || number > bounds.$bound {
                    return Err(D::Error::new(Refused::OutOfRange(stringify!($name))));
                }
                Ok($name::from_index(number as usize - 1))
            }
        }
    };
}

archive_symbol!(Id, 0);
archive_symbol!(Atom, 1);

// ── Interners ────────────────────────────────────────────────────────────────────────────────────

/// One interned string, archived as an `ArchivedString` without copying it into a `String` first.
struct Text<'a>(&'a str);

impl Archive for Text<'_> {
    type Archived = ArchivedString;
    type Resolver = StringResolver;

    fn resolve(&self, resolver: StringResolver, out: Place<ArchivedString>) {
        ArchivedString::resolve_from_str(self.0, resolver, out);
    }
}

impl<S: Fallible + Writer + ?Sized> Serialize<S> for Text<'_>
where
    S::Error: Source,
{
    fn serialize(&self, serializer: &mut S) -> Result<StringResolver, S::Error> {
        ArchivedString::serialize_from_str(self.0, serializer)
    }
}

impl<Sym: Symbol> Archive for Interner<Sym> {
    type Archived = ArchivedVec<ArchivedString>;
    type Resolver = VecResolver;

    fn resolve(&self, resolver: VecResolver, out: Place<Self::Archived>) {
        ArchivedVec::resolve_from_len(self.len(), resolver, out);
    }
}

impl<Sym: Symbol, S: Fallible + Allocator + Writer + ?Sized> Serialize<S> for Interner<Sym>
where
    S::Error: Source,
{
    fn serialize(&self, serializer: &mut S) -> Result<VecResolver, S::Error> {
        let texts: Vec<Text> = self.iter().map(|(_, value)| Text(value)).collect();
        ArchivedVec::serialize_from_slice(&texts, serializer)
    }
}

impl<Sym: Symbol, D: Fallible + ?Sized> Deserialize<Interner<Sym>, D> for ArchivedVec<ArchivedString>
where
    D::Error: Source,
{
    fn deserialize(&self, _: &mut D) -> Result<Interner<Sym>, D::Error> {
        let mut interner = Interner::new();
        let bytes = self.iter().map(|value| value.len()).sum();
        interner.reserve(self.len(), bytes);
        for value in self.iter() {
            let before = interner.len();
            interner.intern(value.as_str());
            if interner.len() == before {
                return Err(D::Error::new(Refused::Repeated));
            }
        }
        Ok(interner)
    }
}

// ── Lists and bags ───────────────────────────────────────────────────────────────────────────────

impl<T: Archive> Archive for List<T> {
    type Archived = ArchivedVec<T::Archived>;
    type Resolver = VecResolver;

    fn resolve(&self, resolver: VecResolver, out: Place<Self::Archived>) {
        ArchivedVec::resolve_from_len(self.len(), resolver, out);
    }
}

impl<T: Serialize<S>, S: Fallible + Allocator + Writer + ?Sized> Serialize<S> for List<T> {
    fn serialize(&self, serializer: &mut S) -> Result<VecResolver, S::Error> {
        ArchivedVec::serialize_from_slice(self.as_slice(), serializer)
    }
}

impl<T: Archive, D: Fallible + ?Sized> Deserialize<List<T>, D> for ArchivedVec<T::Archived>
where
    T::Archived: Deserialize<T, D>,
{
    fn deserialize(&self, deserializer: &mut D) -> Result<List<T>, D::Error> {
        let mut items = Vec::with_capacity(self.len());
        for item in self.iter() {
            items.push(item.deserialize(deserializer)?);
        }
        Ok(List::from(items))
    }
}

impl Archive for Props {
    type Archived = ArchivedVec<ArchivedProp>;
    type Resolver = VecResolver;

    fn resolve(&self, resolver: VecResolver, out: Place<Self::Archived>) {
        ArchivedVec::resolve_from_len(self.len(), resolver, out);
    }
}

impl<S: Fallible + Allocator + Writer + ?Sized> Serialize<S> for Props
where
    Prop: Serialize<S>,
{
    fn serialize(&self, serializer: &mut S) -> Result<VecResolver, S::Error> {
        ArchivedVec::serialize_from_slice(self.as_slice(), serializer)
    }
}

impl<D: Fallible + ?Sized> Deserialize<Props, D> for ArchivedVec<ArchivedProp>
where
    ArchivedProp: Deserialize<Prop, D>,
{
    fn deserialize(&self, deserializer: &mut D) -> Result<Props, D::Error> {
        let mut props = Vec::with_capacity(self.len());
        for prop in self.iter() {
            props.push(prop.deserialize(deserializer)?);
        }
        Ok(Props::new(props))
    }
}

// ── The document ─────────────────────────────────────────────────────────────────────────────────

/// The node slab as the list of nodes that exist, in slot order.
pub struct Slab;

impl ArchiveWith<Vec<Option<Arc<Node>>>> for Slab {
    type Archived = ArchivedVec<ArchivedNode>;
    type Resolver = VecResolver;

    fn resolve_with(
        slots: &Vec<Option<Arc<Node>>>,
        resolver: VecResolver,
        out: Place<Self::Archived>,
    ) {
        ArchivedVec::resolve_from_len(slots.iter().flatten().count(), resolver, out);
    }
}

impl<S: Fallible + Allocator + Writer + ?Sized> SerializeWith<Vec<Option<Arc<Node>>>, S> for Slab
where
    Node: Serialize<S>,
{
    fn serialize_with(
        slots: &Vec<Option<Arc<Node>>>,
        serializer: &mut S,
    ) -> Result<VecResolver, S::Error> {
        let nodes: Vec<&Node> = slots.iter().flatten().map(|node| &**node).collect();
        ArchivedVec::serialize_from_iter::<Node, _, _>(nodes.iter().copied(), serializer)
    }
}

/// Read back as the serde path does: interners first, every symbol after them checked against their sizes, each node
/// into its id's slot.
impl<E: Source> Deserialize<Document, Strategy<Pool, E>> for ArchivedDocument {
    fn deserialize(&self, deserializer: &mut Strategy<Pool, E>) -> Result<Document, E> {
        let ids: Interner<Id> = self.ids.deserialize(deserializer)?;
        let atoms: Interner<Atom> = self.atoms.deserialize(deserializer)?;
        let mut doc = with_bounds(ids.len(), atoms.len(), || -> Result<Document, E> {
            let mut nodes: Vec<Option<Arc<Node>>> = vec![None; ids.len()];
            for archived in self.nodes.iter() {
                let node: Node = archived.deserialize(deserializer)?;
                let slot = &mut nodes[node.id.index()];
                if slot.is_some() {
                    return Err(E::new(Refused::NodeTwice));
                }
                *slot = Some(Arc::new(node));
            }
            Ok(Document {
                count: self.nodes.len(),
                nodes,
                schema_version: self.schema_version.to_native(),
                pages: self.pages.deserialize(deserializer)?,
                styles: Arc::new(self.styles.deserialize(deserializer)?),
                images: Arc::new(self.images.deserialize(deserializer)?),
                variable_collections: Arc::new(self.variable_collections.deserialize(deserializer)?),
                variables: Arc::new(self.variables.deserialize(deserializer)?),
                variable_modes: match self.variable_modes.as_ref() {
                    Some(modes) => Some(Arc::new(modes.deserialize(deserializer)?)),
                    None => None,
                },
                board: self.board.as_ref().copied(),
                ..Document::default()
            })
        })?;
        doc.ids = Arc::new(ids);
        doc.atoms = Arc::new(atoms);
        Ok(doc)
    }
}

/// Zero-copy reading: what a server can do with a validated archive without building the document.
impl ArchivedDocument {
    /// The nodes that exist, in slot order.
    pub fn nodes(&self) -> &[ArchivedNode] {
        self.nodes.as_slice()
    }

    /// The number of ids (node symbols run from 1 to this).
    pub fn id_count(&self) -> usize {
        self.ids.len()
    }

    /// The text of an archived node symbol, if it is in range.
    pub fn try_key(&self, id: u32_le) -> Option<&str> {
        let index = (id.to_native() as usize).checked_sub(1)?;
        self.ids.get(index).map(ArchivedString::as_str)
    }

    /// The text of an archived atom, if it is in range.
    pub fn try_atom(&self, atom: u32_le) -> Option<&str> {
        let index = (atom.to_native() as usize).checked_sub(1)?;
        self.atoms.get(index).map(ArchivedString::as_str)
    }
}
