//! The engine's in-memory document: what the browser's shadow document, the multiplayer server (every open document
//! in memory) and its op journal hold. The JSON model (`crate::types`) mirrors types.ts for parity with the
//! TypeScript; this one is built for size and speed:
//!
//! - **Nodes in a slab keyed by id.** A node id is an [`Id`], a 4-byte symbol of the document's id interner; the node
//!   table is a `Vec` indexed by it. Lookup is an index, children lists are 4 bytes per child.
//! - **Interned strings.** Names, style, variable and image ids, font families and property names are [`Atom`]s of a
//!   second interner: each distinct string is stored once.
//! - **Cheap clones of unchanged parts.** Nodes are `Arc`s in the slab, and their lists and larger values are `Arc`s
//!   too: cloning a document copies one pointer per node, and writing a node copies only that node's fixed part.
//! - **No catch-alls.** Every field of types.ts has its typed place (the node's core or its property bag); no
//!   `serde_json::Value`.
//!
//! [`Document::from_model`] and [`Document::to_model`] convert losslessly to and from the JSON model;
//! `crate::codec` writes it in binary.

mod convert;
mod document;
pub mod draft;
pub mod fields;
mod intern;
mod journal;
pub mod load;
mod node;
mod value;

pub use convert::Resolver;
pub use document::Document;
pub use intern::{Atom, Id, Interner, Layer, Symbol};
pub use journal::{Entry, ReplayError};
pub use node::{Node, Prop, PropKey, Props};
pub use value::*;

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::ops::Deref;
use std::sync::Arc;

/// A shared, immutable list: empty without an allocation, cloned by bumping a count. Change one by building a new
/// list (`List::from(vec)`); unchanged lists stay shared between versions of a document.
pub struct List<T>(Option<Arc<[T]>>);

impl<T> List<T> {
    pub fn new() -> Self {
        List(None)
    }

    pub fn as_slice(&self) -> &[T] {
        self.0.as_deref().unwrap_or(&[])
    }

    /// The address of the shared list, `None` for an empty one: names this list while it is held.
    pub fn ptr(&self) -> Option<usize> {
        self.0
            .as_ref()
            .map(|items| Arc::as_ptr(items) as *const T as usize)
    }

    /// Whether both are the same shared list (two empty lists count).
    pub fn ptr_eq(&self, other: &Self) -> bool {
        match (&self.0, &other.0) {
            (Some(a), Some(b)) => Arc::ptr_eq(a, b),
            (None, None) => true,
            _ => false,
        }
    }

    /// Heap bytes of the list itself (not of what its items point to).
    pub fn heap_bytes(&self) -> usize {
        self.0.as_ref().map_or(0, |items| {
            2 * std::mem::size_of::<usize>() + std::mem::size_of_val(&**items)
        })
    }
}

impl<T> Default for List<T> {
    fn default() -> Self {
        List(None)
    }
}

impl<T> Clone for List<T> {
    fn clone(&self) -> Self {
        List(self.0.clone())
    }
}

/// Equal when the same shared list (the pointer first: unchanged lists stay shared between versions), else item by
/// item.
impl<T: PartialEq> PartialEq for List<T> {
    fn eq(&self, other: &Self) -> bool {
        self.ptr_eq(other) || self.as_slice() == other.as_slice()
    }
}

impl<T> Deref for List<T> {
    type Target = [T];

    fn deref(&self) -> &[T] {
        self.as_slice()
    }
}

impl<T> From<Vec<T>> for List<T> {
    fn from(items: Vec<T>) -> Self {
        if items.is_empty() {
            List(None)
        } else {
            List(Some(items.into()))
        }
    }
}

impl<T> FromIterator<T> for List<T> {
    fn from_iter<I: IntoIterator<Item = T>>(items: I) -> Self {
        items.into_iter().collect::<Vec<T>>().into()
    }
}

impl<T: fmt::Debug> fmt::Debug for List<T> {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.debug_list().entries(self.as_slice()).finish()
    }
}

impl<T: Serialize> Serialize for List<T> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_seq(self.as_slice())
    }
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for List<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Vec::<T>::deserialize(deserializer).map(List::from)
    }
}
