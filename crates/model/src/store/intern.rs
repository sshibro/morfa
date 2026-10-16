//! Interned strings: a document's node ids ([`Id`]) and its other repeated strings ([`Atom`]: names, style, variable
//! and image ids, font families, property names) are stored once and referred to by a 4-byte symbol.
//!
//! An [`Interner`] keeps its strings in one buffer (no allocation per string) and finds them through a table of
//! indexes hashed with foldhash. Symbols are dense, start at 1 (so `Option<Id>` is 4 bytes) and never change: the
//! interner is append-only, which lets a snapshot share it with later versions of the document and lets a journal
//! replay rebuild the same numbering.

use crate::draft::IdHasher as DefaultHashBuilder;
use hashbrown::HashTable;
use serde::de::{self, DeserializeSeed, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::cell::Cell;
use std::fmt;
use std::hash::BuildHasher;
use std::marker::PhantomData;
use std::num::NonZeroU32;
use std::sync::Arc;

/// A symbol of an [`Interner`].
pub trait Symbol: Copy + Eq + fmt::Debug {
    fn index(self) -> usize;
    fn from_index(index: usize) -> Self;
}

thread_local! {
    /// While a document is being decoded: how many ids and atoms its interners hold, so a symbol out of range is
    /// refused where it is read instead of panicking later (see `Document`'s `Deserialize`).
    static BOUNDS: Cell<Option<(u32, u32)>> = const { Cell::new(None) };
}

/// Sets the symbol bounds for the decoding in `run` on this thread.
pub(crate) fn with_bounds<T>(ids: usize, atoms: usize, run: impl FnOnce() -> T) -> T {
    let previous = BOUNDS.with(|bounds| bounds.replace(Some((ids as u32, atoms as u32))));
    let result = run();
    BOUNDS.with(|bounds| bounds.set(previous));
    result
}

macro_rules! symbol {
    ($(#[$doc:meta])* $name:ident, $bound:tt) => {
        $(#[$doc])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize)]
        #[serde(transparent)]
        pub struct $name(NonZeroU32);

        impl Symbol for $name {
            fn index(self) -> usize {
                self.0.get() as usize - 1
            }

            fn from_index(index: usize) -> Self {
                let number = u32::try_from(index + 1).expect("fewer than 2^32 strings in one interner");
                $name(NonZeroU32::new(number).expect("index + 1 is never 0"))
            }
        }

        impl fmt::Debug for $name {
            fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                write!(formatter, concat!(stringify!($name), "({})"), self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                let number = NonZeroU32::deserialize(deserializer)?;
                if let Some(bounds) = BOUNDS.with(Cell::get)
                    && number.get() > bounds.$bound
                {
                    return Err(de::Error::custom(concat!(stringify!($name), " out of range")));
                }
                Ok($name(number))
            }
        }
    };
}

symbol!(
    /// A node id of one document (`NodeId` in types.ts), and the key of its node table.
    Id,
    0
);
symbol!(
    /// Any other repeated string of one document: names, style, variable, mode and image ids, font families,
    /// component property names, override field names.
    Atom,
    1
);

/// An append-only set of strings, each named by a dense symbol.
#[derive(Clone)]
pub struct Interner<S> {
    /// Every string, one after the other.
    text: String,
    /// The end of each string in `text`; string `i` starts where string `i - 1` ends.
    ends: Vec<u32>,
    /// Indexes into `ends`, hashed by their string.
    table: HashTable<u32>,
    hasher: DefaultHashBuilder,
    symbol: PhantomData<S>,
}

impl<S> Default for Interner<S> {
    fn default() -> Self {
        Interner {
            text: String::new(),
            ends: Vec::new(),
            table: HashTable::new(),
            hasher: DefaultHashBuilder::default(),
            symbol: PhantomData,
        }
    }
}

fn span<'a>(text: &'a str, ends: &[u32], index: usize) -> &'a str {
    let start = if index == 0 {
        0
    } else {
        ends[index - 1] as usize
    };
    &text[start..ends[index] as usize]
}

impl<S: Symbol> Interner<S> {
    pub fn new() -> Self {
        Self::default()
    }

    /// The number of strings.
    pub fn len(&self) -> usize {
        self.ends.len()
    }

    pub fn is_empty(&self) -> bool {
        self.ends.is_empty()
    }

    /// The symbol of `value`, if it was interned.
    pub fn get(&self, value: &str) -> Option<S> {
        let hash = self.hasher.hash_one(value);
        self.table
            .find(hash, |&index| {
                span(&self.text, &self.ends, index as usize) == value
            })
            .map(|&index| S::from_index(index as usize))
    }

    /// The symbol of `value`, interning it when it is new.
    pub fn intern(&mut self, value: &str) -> S {
        let hash = self.hasher.hash_one(value);
        let Interner {
            text,
            ends,
            table,
            hasher,
            ..
        } = self;
        if let Some(&index) = table.find(hash, |&index| span(text, ends, index as usize) == value) {
            return S::from_index(index as usize);
        }
        S::from_index(Self::push(text, ends, table, hasher, hash, value))
    }

    /// Appends a string known to be new (decoding); `false` when it is already there.
    fn push_new(&mut self, value: &str) -> bool {
        let hash = self.hasher.hash_one(value);
        let Interner {
            text,
            ends,
            table,
            hasher,
            ..
        } = self;
        if table
            .find(hash, |&index| span(text, ends, index as usize) == value)
            .is_some()
        {
            return false;
        }
        Self::push(text, ends, table, hasher, hash, value);
        true
    }

    fn push(
        text: &mut String,
        ends: &mut Vec<u32>,
        table: &mut HashTable<u32>,
        hasher: &DefaultHashBuilder,
        hash: u64,
        value: &str,
    ) -> usize {
        let index = ends.len();
        text.push_str(value);
        ends.push(u32::try_from(text.len()).expect("an interner holds under 4 GiB of text"));
        let index_u32 = index as u32;
        table.insert_unique(hash, index_u32, |&other| {
            hasher.hash_one(span(text, ends, other as usize))
        });
        index
    }

    /// The string of a symbol of this interner. Panics on a symbol from another interner that is out of range.
    pub fn resolve(&self, symbol: S) -> &str {
        span(&self.text, &self.ends, symbol.index())
    }

    pub fn try_resolve(&self, symbol: S) -> Option<&str> {
        (symbol.index() < self.ends.len()).then(|| self.resolve(symbol))
    }

    /// Every string with its symbol, in symbol order.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = (S, &str)> {
        (0..self.ends.len())
            .map(|index| (S::from_index(index), span(&self.text, &self.ends, index)))
    }

    /// Heap bytes held (capacity, not length).
    pub fn heap_bytes(&self) -> usize {
        self.text.capacity() + self.ends.capacity() * 4 + self.table.capacity() * (4 + 1)
    }

    /// Forgets every string, keeping the buffers (a [`Layer`]'s extra interner between calls).
    pub fn clear(&mut self) {
        self.text.clear();
        self.ends.clear();
        self.table.clear();
    }

    pub fn reserve(&mut self, strings: usize, bytes: usize) {
        self.text.reserve(bytes);
        self.ends.reserve(strings);
        let Interner {
            text,
            ends,
            table,
            hasher,
            ..
        } = self;
        table.reserve(strings, |&other| {
            hasher.hash_one(span(text, ends, other as usize))
        });
    }
}

/// An interner layered over a shared one: symbols below `offset` resolve in the base (never copied), new strings go
/// to `extra` and get the symbols after it, so what a working copy interns is exactly what a journal [`Entry`]
/// records as the strings it introduced (`new_ids`, `new_atoms`) and [`Document::replay`] rebuilds the same
/// numbering.
///
/// [`Entry`]: super::Entry
/// [`Document::replay`]: super::Document::replay
#[derive(Clone)]
pub struct Layer<S> {
    base: Arc<Interner<S>>,
    extra: Interner<S>,
    offset: usize,
}

impl<S: Symbol> Layer<S> {
    pub fn new(base: Arc<Interner<S>>) -> Self {
        let offset = base.len();
        Layer {
            base,
            extra: Interner::new(),
            offset,
        }
    }

    /// Starts over on `base`, keeping the extra interner's buffers.
    pub fn reset(&mut self, base: Arc<Interner<S>>) {
        self.offset = base.len();
        self.base = base;
        self.extra.clear();
    }

    pub fn base(&self) -> &Arc<Interner<S>> {
        &self.base
    }

    /// Every symbol below this is the base's.
    pub fn offset(&self) -> usize {
        self.offset
    }

    /// The number of strings, the base's included.
    pub fn len(&self) -> usize {
        self.offset + self.extra.len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// The strings interned here, in symbol order (an entry's `new_ids` / `new_atoms`).
    pub fn extra(&self) -> impl ExactSizeIterator<Item = &str> {
        self.extra.iter().map(|(_, value)| value)
    }

    pub fn get(&self, value: &str) -> Option<S> {
        match self.base.get(value) {
            Some(symbol) => Some(symbol),
            None => self
                .extra
                .get(value)
                .map(|symbol| S::from_index(symbol.index() + self.offset)),
        }
    }

    pub fn intern(&mut self, value: &str) -> S {
        match self.base.get(value) {
            Some(symbol) => symbol,
            None => S::from_index(self.extra.intern(value).index() + self.offset),
        }
    }

    pub fn resolve(&self, symbol: S) -> &str {
        let index = symbol.index();
        if index < self.offset {
            self.base.resolve(symbol)
        } else {
            self.extra.resolve(S::from_index(index - self.offset))
        }
    }

    pub fn try_resolve(&self, symbol: S) -> Option<&str> {
        (symbol.index() < self.len()).then(|| self.resolve(symbol))
    }
}

impl<S: Symbol> fmt::Debug for Layer<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter
            .debug_struct("Layer")
            .field("base", &self.offset)
            .field("extra", &self.extra)
            .finish()
    }
}

impl<S: Symbol> fmt::Debug for Interner<S> {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter
            .debug_list()
            .entries(self.iter().map(|(_, value)| value))
            .finish()
    }
}

impl<S: Symbol> PartialEq for Interner<S> {
    fn eq(&self, other: &Self) -> bool {
        self.ends == other.ends && self.text == other.text
    }
}

/// Written as the list of strings in symbol order.
impl<S: Symbol> Serialize for Interner<S> {
    fn serialize<Z: Serializer>(&self, serializer: Z) -> Result<Z::Ok, Z::Error> {
        serializer.collect_seq(self.iter().map(|(_, value)| value))
    }
}

/// Read back string by string into the buffer (no allocation per string); a repeated string is refused, since it
/// would shift every later symbol.
impl<'de, S: Symbol> Deserialize<'de> for Interner<S> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Strings<S>(PhantomData<S>);
        impl<'de, S: Symbol> Visitor<'de> for Strings<S> {
            type Value = Interner<S>;
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a list of distinct strings")
            }
            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Interner<S>, A::Error> {
                let mut interner = Interner::new();
                if let Some(count) = seq.size_hint() {
                    interner.reserve(count.min(1 << 20), 0);
                }
                while seq.next_element_seed(Element(&mut interner))?.is_some() {}
                Ok(interner)
            }
        }
        struct Element<'a, S>(&'a mut Interner<S>);
        impl<'de, S: Symbol> DeserializeSeed<'de> for Element<'_, S> {
            type Value = ();
            fn deserialize<D: Deserializer<'de>>(self, deserializer: D) -> Result<(), D::Error> {
                deserializer.deserialize_str(self)
            }
        }
        impl<'de, S: Symbol> Visitor<'de> for Element<'_, S> {
            type Value = ();
            fn expecting(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
                formatter.write_str("a string")
            }
            fn visit_str<E: de::Error>(self, value: &str) -> Result<(), E> {
                if self.0.push_new(value) {
                    Ok(())
                } else {
                    Err(E::custom("a repeated string in an interner"))
                }
            }
        }
        deserializer.deserialize_seq(Strings(PhantomData))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interns_once_and_resolves() {
        let mut ids = Interner::<Id>::new();
        let a = ids.intern("n1");
        let b = ids.intern("frame;rect");
        assert_eq!(ids.intern("n1"), a);
        assert_ne!(a, b);
        assert_eq!(ids.resolve(b), "frame;rect");
        assert_eq!(ids.get("frame;rect"), Some(b));
        assert_eq!(ids.get("missing"), None);
        assert_eq!(ids.len(), 2);
        assert_eq!(std::mem::size_of::<Option<Id>>(), 4);
    }

    #[test]
    fn grows_past_rehashing() {
        let mut atoms = Interner::<Atom>::new();
        let symbols: Vec<Atom> = (0..10_000)
            .map(|i| atoms.intern(&format!("name {i}")))
            .collect();
        for (i, symbol) in symbols.iter().enumerate() {
            assert_eq!(atoms.resolve(*symbol), format!("name {i}"));
            assert_eq!(atoms.get(&format!("name {i}")), Some(*symbol));
        }
        assert_eq!(atoms.intern(""), atoms.intern(""));
    }
}
