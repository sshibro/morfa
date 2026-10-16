//! The working copy the normalize stages write into, over the store's own nodes: the
//! successor of the JSON-model draft, with TypeScript's `Draft`/`DocumentDraft` rules.
//!
//! A [`Working`] reads a shared [`Document`] by slot (`slot[Id::index()]`, then `Document::nodes[index]`: no string
//! hashing), keeps its writes beside it as `Arc<Node>`s (a write copies one node's fixed part; its lists and bag
//! values stay shared with the version it came from), and interns the strings it needs in layered interners
//! ([`Layer`]) over the document's. So what it ends with is exactly a journal [`Entry`]: the strings it introduced
//! and the nodes it put or removed, which [`Document::replay`] applies to the document it started from without
//! converting anything ([`Working::into_entry`]).
//!
//! The rules are `Draft`'s (and the TypeScript's, constraints.ts `Draft` and components.ts `DocumentDraft`): a
//! write that changes nothing is dropped, numbers within [`LAYOUT_EPSILON`] of the stored value keep it
//! (`sameValue`), every id written or removed is reported in the order first written, `put` stores a node exactly.
//! A transaction's writes can be laid over the document first ([`Working::lay_over`]): they are what the stages
//! start from, not what they wrote.

use std::fmt;
use std::sync::Arc;

use indexmap::IndexMap;

use super::convert::{self, Resolver, Resolving, Symbols};
use super::value::{ImageAsset, Style, Variable, VariableCollection};
use super::{Atom, Document, Entry, Id, Layer, List, Node, Prop, Props, Symbol};
use crate::draft::{Comparer, Ctx, same_f64};
use crate::json::NodeField;
use crate::patch::DocumentPatch;

pub use crate::draft::LAYOUT_EPSILON;

// ── SlotSet ──────────────────────────────────────────────────────────────────────────────────────

/// A set of node ids with the order they were added (deterministic iteration, as the TypeScript's `Set`s): a bit
/// per slot and the ids in order. The dirty, touched and collected sets of the stages.
#[derive(Clone, Default)]
pub struct SlotSet {
    bits: Vec<u64>,
    order: Vec<Id>,
}

impl SlotSet {
    pub fn new() -> Self {
        Self::default()
    }

    /// An empty set with room for `slots` slots.
    pub fn with_slots(slots: usize) -> Self {
        SlotSet {
            bits: vec![0; slots.div_ceil(64)],
            order: Vec::new(),
        }
    }

    pub fn len(&self) -> usize {
        self.order.len()
    }

    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    pub fn contains(&self, id: Id) -> bool {
        let index = id.index();
        self.bits
            .get(index / 64)
            .is_some_and(|word| word & (1 << (index % 64)) != 0)
    }

    /// Adds `id`; `false` when it was there.
    pub fn insert(&mut self, id: Id) -> bool {
        let index = id.index();
        let word = index / 64;
        if word >= self.bits.len() {
            self.bits.resize(word + 1, 0);
        }
        let bit = 1 << (index % 64);
        if self.bits[word] & bit != 0 {
            return false;
        }
        self.bits[word] |= bit;
        self.order.push(id);
        true
    }

    pub fn extend(&mut self, ids: impl IntoIterator<Item = Id>) {
        for id in ids {
            self.insert(id);
        }
    }

    /// The ids in the order added.
    pub fn iter(&self) -> impl ExactSizeIterator<Item = Id> + '_ {
        self.order.iter().copied()
    }

    pub fn as_slice(&self) -> &[Id] {
        &self.order
    }

    /// Empties the set, keeping its room.
    pub fn clear(&mut self) {
        for id in self.order.drain(..) {
            let index = id.index();
            self.bits[index / 64] &= !(1 << (index % 64));
        }
    }
}

impl fmt::Debug for SlotSet {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter.debug_set().entries(self.order.iter()).finish()
    }
}

impl FromIterator<Id> for SlotSet {
    fn from_iter<I: IntoIterator<Item = Id>>(ids: I) -> Self {
        let mut set = SlotSet::new();
        set.extend(ids);
        set
    }
}

impl<'a> IntoIterator for &'a SlotSet {
    type Item = Id;
    type IntoIter = std::iter::Copied<std::slice::Iter<'a, Id>>;

    fn into_iter(self) -> Self::IntoIter {
        self.order.iter().copied()
    }
}

impl PartialEq for SlotSet {
    fn eq(&self, other: &Self) -> bool {
        self.order == other.order
    }
}

// ── Working ──────────────────────────────────────────────────────────────────────────────────────

/// The document's other tables as the working copy reads them (a patch's changes applied; the stages never write
/// them except `variable_modes`, which goes through [`Working::set_modes`]).
#[derive(Clone)]
struct Tables {
    pages: Vec<Id>,
    styles: Arc<IndexMap<Atom, Style>>,
    images: Arc<IndexMap<Atom, ImageAsset>>,
    variable_collections: Arc<IndexMap<Atom, VariableCollection>>,
    variables: Arc<IndexMap<Atom, Variable>>,
    variable_modes: Option<Arc<IndexMap<Id, IndexMap<Atom, Atom>>>>,
}

/// One node written (`Some`) or removed (`None`).
struct Write {
    id: Id,
    node: Option<Arc<Node>>,
    /// Every write of this node was [`Working::update_box`]: it differs from the base in x, y, width or height only.
    box_only: bool,
    /// The box of the node before this draft's first write of it.
    base_box: [f64; 4],
    /// The entry the patch laid over this id ([`Working::lay_over`]), when it had one: the node the draft started
    /// from (`Some(None)`: the patch removed it).
    over: Option<Option<Arc<Node>>>,
}

/// `slot[i]` of an id the patch laid over and no stage wrote: the entry's index in `over`, tagged.
const OVER: u32 = 1 << 31;

/// A working copy of a document's nodes and variable modes; see the module documentation.
pub struct Working {
    base: Arc<Document>,
    ids: Layer<Id>,
    atoms: Layer<Atom>,
    tables: Tables,
    /// The patch's table changes, for the entry.
    table_changes: Entry,
    /// The patch's node entries, in its order (`from` in crates/wasm's output: JavaScript holds these).
    over: Vec<(Id, Option<Arc<Node>>)>,
    /// Every node written or removed, in the order first written.
    writes: Vec<Write>,
    /// By slot: 0 = the base's node, `OVER | k` = `over[k]`, else `writes[slot - 1]`.
    slot: Vec<u32>,
    /// `variableModes` entries written (`None`: removed), in the order first written.
    modes: Vec<(Id, Option<IndexMap<Atom, Atom>>)>,
    /// The id sets of the `collect` calls under way, innermost last.
    watchers: Vec<SlotSet>,
    comparer: Comparer,
}

/// The working copy's interners as a conversion's symbol source.
struct Layers<'a> {
    ids: &'a mut Layer<Id>,
    atoms: &'a mut Layer<Atom>,
    /// Grown with the ids: every id has a slot.
    slot: &'a mut Vec<u32>,
}

impl Symbols for Layers<'_> {
    fn id(&mut self, key: &str) -> Id {
        let id = self.ids.intern(key);
        if id.index() >= self.slot.len() {
            self.slot.resize(id.index() + 1, 0);
        }
        id
    }

    fn atom(&mut self, value: &str) -> Atom {
        self.atoms.intern(value)
    }

    fn get_id(&self, key: &str) -> Option<Id> {
        self.ids.get(key)
    }

    fn get_atom(&self, value: &str) -> Option<Atom> {
        self.atoms.get(value)
    }
}

impl Resolver for Working {
    fn key(&self, id: Id) -> &str {
        self.ids.resolve(id)
    }

    fn atom(&self, atom: Atom) -> &str {
        self.atoms.resolve(atom)
    }
}

impl fmt::Debug for Working {
    fn fmt(&self, formatter: &mut fmt::Formatter) -> fmt::Result {
        formatter
            .debug_struct("Working")
            .field("base", &self.base)
            .field("over", &self.over.len())
            .field("writes", &self.writes.len())
            .finish_non_exhaustive()
    }
}

impl Working {
    /// A working copy over `base`, which it shares and never writes.
    pub fn new(base: Arc<Document>) -> Self {
        Self::with_slots(base, Vec::new())
    }

    /// A working copy over a JSON-model document (tests, the stage harness binary): `Document::from_model` first.
    pub fn from_model(doc: &crate::types::DesignDocument) -> Self {
        Self::new(Arc::new(Document::from_model(doc)))
    }

    /// The document as the JSON model with every write (and the patch) applied: `into_document().to_model()`.
    pub fn into_model(self) -> crate::types::DesignDocument {
        self.into_document().to_model()
    }

    /// [`Working::new`] reusing a slot table an earlier working copy gave back ([`Working::into_entry_and_slots`]):
    /// all zeros, grown to the document's slots.
    pub fn with_slots(base: Arc<Document>, mut slot: Vec<u32>) -> Self {
        debug_assert!(slot.iter().all(|&mark| mark == 0));
        if slot.len() < base.slots() {
            slot.resize(base.slots(), 0);
        }
        let tables = Tables {
            pages: base.pages.clone(),
            styles: Arc::clone(&base.styles),
            images: Arc::clone(&base.images),
            variable_collections: Arc::clone(&base.variable_collections),
            variables: Arc::clone(&base.variables),
            variable_modes: base.variable_modes.clone(),
        };
        Working {
            ids: Layer::new(Arc::clone(&base.ids)),
            atoms: Layer::new(Arc::clone(&base.atoms)),
            tables,
            table_changes: Entry::default(),
            base,
            over: Vec::new(),
            writes: Vec::new(),
            slot,
            modes: Vec::new(),
            watchers: Vec::new(),
            comparer: Comparer::default(),
        }
    }

    /// Lays `patch` over the document (not recorded as this draft's writes): the document as a transaction left it
    /// before normalizing (crates/wasm `MorfaDoc::normalize`). Its strings are interned here, its nodes converted,
    /// its table changes applied to what the stages read. Costs the patch, not the file. Once, before any write.
    pub fn lay_over(&mut self, patch: &DocumentPatch) {
        debug_assert!(self.writes.is_empty() && self.over.is_empty());
        let mut layers = Layers {
            ids: &mut self.ids,
            atoms: &mut self.atoms,
            slot: &mut self.slot,
        };
        let mut entry = convert::entry_from_patch(&mut layers, patch);
        for (id, node) in std::mem::take(&mut entry.nodes) {
            let index = id.index();
            match self.slot[index] {
                0 => {
                    self.slot[index] = OVER | self.over.len() as u32;
                    self.over.push((id, node));
                }
                // The same id twice in one patch (a map cannot, but a caller's list could): the later wins.
                mark => self.over[(mark & !OVER) as usize].1 = node,
            }
        }
        if let Some(pages) = &entry.pages {
            self.tables.pages.clone_from(pages);
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
        table(&mut self.tables.styles, &entry.styles);
        table(&mut self.tables.images, &entry.images);
        table(
            &mut self.tables.variable_collections,
            &entry.variable_collections,
        );
        table(&mut self.tables.variables, &entry.variables);
        if !entry.variable_modes.is_empty() {
            table(
                self.tables.variable_modes.get_or_insert_with(Arc::default),
                &entry.variable_modes,
            );
        }
        self.table_changes = entry;
    }

    /// Lays a few fields of a node the document holds over it (crates/wasm `MorfaDoc.normalize`'s `fields`: a
    /// transaction's write of x, y, width, a text's characters… crossing as those fields, `crate::json::NodeField`):
    /// the document's node with those set, as the patch's entry for that id. A keystroke is one new shared text; the
    /// node's other values stay shared. `Err` names a node the document lacks, or `text.characters` on a node without
    /// text.
    pub fn lay_over_fields(&mut self, key: &str, fields: Vec<NodeField>) -> Result<(), String> {
        let Some(id) = self.ids.get(key) else {
            return Err(format!(
                "fields of '{key}', which the document does not hold"
            ));
        };
        let Some(current) = self.arc(id) else {
            return Err(format!(
                "fields of '{key}', which the document does not hold"
            ));
        };
        let mut next = Arc::clone(current);
        let node = Arc::make_mut(&mut next);
        let mut layers = Layers {
            ids: &mut self.ids,
            atoms: &mut self.atoms,
            slot: &mut self.slot,
        };
        let mut cx = convert::Interning::new(&mut layers);
        for field in fields {
            match field {
                NodeField::X(value) => node.x = value,
                NodeField::Y(value) => node.y = value,
                NodeField::Width(value) => node.width = value,
                NodeField::Height(value) => node.height = value,
                NodeField::Rotation(value) => node.rotation = value,
                NodeField::Opacity(value) => node.opacity = value,
                NodeField::Visible(value) => node.visible = value,
                NodeField::Name(value) => node.name = cx.symbols.atom(&value),
                NodeField::Text(value) => {
                    node.props.set(Prop::Text(Arc::new(convert::text_props_in(
                        &value, &mut cx,
                    ))));
                }
                NodeField::Characters(value) => {
                    let Some(text) = node.props.text() else {
                        return Err(format!("the characters of '{key}', which has no text"));
                    };
                    let mut text = Arc::clone(text);
                    Arc::make_mut(&mut text).characters = Arc::from(value.as_str());
                    node.props.set(Prop::Text(text));
                }
                NodeField::Fills(value) => node.fills = convert::paints_in(&value, &mut cx),
                NodeField::Strokes(value) => node.strokes = convert::paints_in(&value, &mut cx),
                NodeField::Effects(value) => node.effects = convert::effects_in(&value),
            }
        }
        let index = id.index();
        match self.slot[index] {
            0 => {
                self.slot[index] = OVER | self.over.len() as u32;
                self.over.push((id, Some(next)));
            }
            mark if mark & OVER != 0 => self.over[(mark & !OVER) as usize].1 = Some(next),
            _ => return Err(format!("fields of '{key}' after a write of it")),
        }
        Ok(())
    }

    // ── Symbols ──

    /// The document the draft started from (its nodes before the patch and the writes).
    pub fn base(&self) -> &Arc<Document> {
        &self.base
    }

    /// The symbol of a node id, if the document or this draft has seen it.
    pub fn id(&self, key: &str) -> Option<Id> {
        self.ids.get(key)
    }

    /// The symbol of a node id, interning it when new (a node this draft adds).
    pub fn intern_id(&mut self, key: &str) -> Id {
        let id = self.ids.intern(key);
        if id.index() >= self.slot.len() {
            self.slot.resize(id.index() + 1, 0);
        }
        id
    }

    /// The symbol of a string, if the document or this draft has seen it.
    pub fn atom_of(&self, value: &str) -> Option<Atom> {
        self.atoms.get(value)
    }

    /// The symbol of a string, interning it when new.
    pub fn intern_atom(&mut self, value: &str) -> Atom {
        self.atoms.intern(value)
    }

    /// The text of a node id.
    pub fn key(&self, id: Id) -> &str {
        self.ids.resolve(id)
    }

    /// The text of an atom.
    pub fn atom(&self, atom: Atom) -> &str {
        self.atoms.resolve(atom)
    }

    /// One past the highest id this draft knows: the length of a table indexed by node id.
    pub fn slots(&self) -> usize {
        self.ids.len()
    }

    // ── Tables ──

    /// Page ids in panel order.
    pub fn pages(&self) -> &[Id] {
        &self.tables.pages
    }

    pub fn styles(&self) -> &IndexMap<Atom, Style> {
        &self.tables.styles
    }

    pub fn images(&self) -> &IndexMap<Atom, ImageAsset> {
        &self.tables.images
    }

    pub fn variable_collections(&self) -> &IndexMap<Atom, VariableCollection> {
        &self.tables.variable_collections
    }

    pub fn variables(&self) -> &IndexMap<Atom, Variable> {
        &self.tables.variables
    }

    /// A board's document.
    pub fn board(&self) -> Option<bool> {
        self.base.board
    }

    // ── Reads ──

    /// The node as it stands (earlier writes included), `None` if it does not exist or was removed.
    #[inline]
    pub fn node(&self, id: Id) -> Option<&Node> {
        self.arc(id).map(|node| &**node)
    }

    /// The node as it stands, shared: to keep it past a later write or compare it by pointer.
    #[inline]
    pub fn arc(&self, id: Id) -> Option<&Arc<Node>> {
        let index = id.index();
        match self.slot.get(index).copied().unwrap_or(0) {
            0 => self.base.nodes.get(index)?.as_ref(),
            mark if mark & OVER != 0 => self.over[(mark & !OVER) as usize].1.as_ref(),
            mark => self.writes[mark as usize - 1].node.as_ref(),
        }
    }

    /// `node` for an optional id.
    #[inline]
    pub fn node_opt(&self, id: Option<Id>) -> Option<&Node> {
        self.node(id?)
    }

    /// The node as it was before any write of this draft (the patch's entry, else the document's).
    pub fn base_node(&self, id: Id) -> Option<&Node> {
        self.base_arc(id).map(|node| &**node)
    }

    /// [`Working::base_node`], shared.
    pub fn base_arc(&self, id: Id) -> Option<&Arc<Node>> {
        let index = id.index();
        match self.slot.get(index).copied().unwrap_or(0) {
            0 => self.base.nodes.get(index)?.as_ref(),
            mark if mark & OVER != 0 => self.over[(mark & !OVER) as usize].1.as_ref(),
            mark => match &self.writes[mark as usize - 1].over {
                Some(over) => over.as_ref(),
                None => self.base.nodes.get(index)?.as_ref(),
            },
        }
    }

    /// The base's x, y, width and height of `id` (what a box-only write is compared with).
    pub fn base_box(&self, id: Id) -> Option<[f64; 4]> {
        let index = id.index();
        match self.slot.get(index).copied().unwrap_or(0) {
            0 => self.base.nodes.get(index)?.as_ref(),
            mark if mark & OVER != 0 => self.over[(mark & !OVER) as usize].1.as_ref(),
            mark => return Some(self.writes[mark as usize - 1].base_box),
        }
        .map(|node| [node.x, node.y, node.width, node.height])
    }

    pub fn contains(&self, id: Id) -> bool {
        self.arc(id).is_some()
    }

    /// The ids of every node as it stands, in the order the TypeScript's table has them: the document's own in slot
    /// order, then the ids the patch added, then the ids the draft added.
    pub fn for_each_id(&self, mut visit: impl FnMut(Id)) {
        for (index, node) in self.base.nodes.iter().enumerate() {
            if node.is_some() {
                let id = Id::from_index(index);
                if self.contains(id) {
                    visit(id);
                }
            }
        }
        for &(id, _) in &self.over {
            if self.base.node(id).is_none() && self.contains(id) {
                visit(id);
            }
        }
        for write in &self.writes {
            if write.node.is_some() && self.base.node(write.id).is_none() && write.over.is_none() {
                visit(write.id);
            }
        }
    }

    /// [`Working::for_each_id`] collected.
    pub fn ids(&self) -> Vec<Id> {
        let mut ids = Vec::new();
        self.for_each_id(|id| ids.push(id));
        ids
    }

    /// The node's variable modes (collection → mode) as they stand.
    pub fn modes_of(&self, id: Id) -> Option<&IndexMap<Atom, Atom>> {
        match self.modes.iter().find(|(written, _)| *written == id) {
            Some((_, modes)) => modes.as_ref(),
            None => self.tables.variable_modes.as_ref()?.get(&id),
        }
    }

    // ── Writes ──

    /// Changes the node with `change` (TS `update(id, fields)`). Returns whether the node changed: fields equal to
    /// the stored ones, or within [`LAYOUT_EPSILON`] of them number by number, keep their stored value (and stay
    /// shared with it), and a node with no field really changed is not written (nor reported). `false` for a node
    /// that does not exist. `change` must not change the node's id.
    pub fn update(&mut self, id: Id, change: impl FnOnce(&mut Node)) -> bool {
        let Some(current) = self.arc(id) else {
            return false;
        };
        let current = Arc::clone(current);
        let mut next = Arc::clone(&current);
        let node = Arc::make_mut(&mut next);
        change(node);
        debug_assert_eq!(node.id, id, "Working::update must not change a node's id");
        node.id = id;
        let mut comparer = std::mem::take(&mut self.comparer);
        let changed = keep_same_fields(&mut comparer, node, &current);
        self.comparer = comparer;
        if !changed {
            return false;
        }
        self.write(id, Some(next));
        true
    }

    /// `update` of the box fields alone (`None`: left as it is): the same rule field by field, without copying a
    /// node this draft has written already (it is changed in place) and without comparing its other fields. The
    /// layout stages' writes (arrange, resize, group fit) are these.
    pub fn update_box(
        &mut self,
        id: Id,
        x: Option<f64>,
        y: Option<f64>,
        width: Option<f64>,
        height: Option<f64>,
    ) -> bool {
        let Some(current) = self.node(id) else {
            return false;
        };
        let before = [current.x, current.y, current.width, current.height];
        let pick = |next: Option<f64>, stored: f64| next.filter(|&next| !same_f64(next, stored));
        let (x, y) = (pick(x, current.x), pick(y, current.y));
        let (width, height) = (pick(width, current.width), pick(height, current.height));
        if x.is_none() && y.is_none() && width.is_none() && height.is_none() {
            return false;
        }
        let set = |node: &mut Node| {
            if let Some(x) = x {
                node.x = x;
            }
            if let Some(y) = y {
                node.y = y;
            }
            if let Some(width) = width {
                node.width = width;
            }
            if let Some(height) = height {
                node.height = height;
            }
        };
        let mark = self.slot[id.index()];
        if mark != 0 && mark & OVER == 0 {
            let write = &mut self.writes[mark as usize - 1];
            set(Arc::make_mut(write.node.as_mut().expect("the node exists")));
            self.note(id);
        } else {
            let mut next = Arc::clone(self.arc(id).expect("looked up above"));
            set(Arc::make_mut(&mut next));
            self.record(id, Some(next), true, before);
        }
        true
    }

    /// Stores `node` under its id, replacing the node there or adding it (without linking it into its parent's
    /// children: see [`Working::insert`]). Replacing follows `update`'s rule: fields within epsilon keep their
    /// stored value and an unchanged node is not written. Returns whether it wrote.
    pub fn set(&mut self, mut node: Node) -> bool {
        if let Some(current) = self.arc(node.id) {
            let current = Arc::clone(current);
            let mut comparer = std::mem::take(&mut self.comparer);
            let changed = keep_same_fields(&mut comparer, &mut node, &current);
            self.comparer = comparer;
            if !changed {
                return false;
            }
        }
        let id = node.id;
        self.write(id, Some(Arc::new(node)));
        true
    }

    /// Stores `node` under its id exactly as given and reports it written, even when it equals the stored node
    /// (components.ts `DocumentDraft.put`): no `LAYOUT_EPSILON` rule. Not linked into its parent's children.
    pub fn put(&mut self, node: Node) {
        self.put_arc(Arc::new(node));
    }

    /// [`Working::put`] of a node already shared (a copy that takes its main's values).
    pub fn put_arc(&mut self, node: Arc<Node>) {
        let id = node.id;
        self.write(id, Some(node));
    }

    /// Adds a new node and links it into its parent's children at `index` (clamped; the end when `None`), as
    /// components.ts `insertChild` does. Returns `false`, writing nothing, when a node with that id exists. A node
    /// whose parent does not exist is added unlinked.
    pub fn insert(&mut self, node: Node, index: Option<usize>) -> bool {
        let id = node.id;
        if self.contains(id) {
            return false;
        }
        let parent = node.parent;
        self.write(id, Some(Arc::new(node)));
        if let Some(parent) = parent {
            self.update(parent, |parent| {
                let mut children: Vec<Id> = parent.children().to_vec();
                children.retain(|child| *child != id);
                let at = index.unwrap_or(children.len()).min(children.len());
                children.insert(at, id);
                parent.children = Some(children.into());
            });
        }
        true
    }

    /// Removes the node and its subtree, and takes it out of its parent's children (TS `remove`). Removed nodes
    /// lose their variable modes too, as `DocumentDraft.delete` does. Every id removed and the parent are reported
    /// written. Returns `false` for a node that does not exist.
    pub fn remove(&mut self, id: Id) -> bool {
        let Some(node) = self.node(id) else {
            return false;
        };
        if let Some(parent) = node.parent
            && self
                .node(parent)
                .is_some_and(|parent| parent.children.is_some())
        {
            self.update(parent, |parent| {
                if parent.children().contains(&id) {
                    let children: Vec<Id> = parent
                        .children()
                        .iter()
                        .copied()
                        .filter(|child| *child != id)
                        .collect();
                    parent.children = Some(children.into());
                }
            });
        }
        // Children before their parent, in order, as TS's recursive `drop`. `seen` guards against a cycle (an
        // invalid document) looping forever.
        let mut seen = SlotSet::new();
        let mut stack = vec![(id, false)];
        while let Some((current, expanded)) = stack.pop() {
            if expanded {
                self.write(current, None);
                if self.modes_of(current).is_some() {
                    self.set_modes(current, None);
                }
                continue;
            }
            let Some(node) = self.node(current) else {
                continue;
            };
            if !seen.insert(current) {
                continue;
            }
            let children: Vec<(Id, bool)> = node
                .children()
                .iter()
                .rev()
                .map(|child| (*child, false))
                .collect();
            stack.push((current, true));
            stack.extend(children);
        }
        true
    }

    /// Removes one node (not its children) and any variable modes it carried, as components.ts `DocumentDraft.delete`:
    /// its parent's children list is not touched. Returns `false` for a node that does not exist.
    pub fn delete(&mut self, id: Id) -> bool {
        if !self.contains(id) {
            return false;
        }
        self.write(id, None);
        if self.modes_of(id).is_some() {
            self.set_modes(id, None);
        }
        true
    }

    /// Sets or (with `None` or an empty map) removes the node's variable modes (`DocumentDraft.setModes`). Returns
    /// whether they changed. Not reported in [`Working::written`]: modes are their own table.
    pub fn set_modes(&mut self, id: Id, modes: Option<IndexMap<Atom, Atom>>) -> bool {
        let modes = modes.filter(|modes| !modes.is_empty());
        if self.modes_of(id) == modes.as_ref() {
            return false;
        }
        match self.modes.iter_mut().find(|(written, _)| *written == id) {
            Some((_, slot)) => *slot = modes,
            None => self.modes.push((id, modes)),
        }
        true
    }

    /// Runs `work` and returns the ids it wrote or removed (TS `collect`), in the order first touched. Calls nest:
    /// an id touched inside an inner `collect` is reported by every outer one.
    pub fn collect(&mut self, work: impl FnOnce(&mut Self)) -> SlotSet {
        self.watchers.push(SlotSet::new());
        work(self);
        self.watchers.pop().expect("collect pushed its own set")
    }

    /// Records a full write (or, with `None`, a removal) of `id`.
    fn write(&mut self, id: Id, node: Option<Arc<Node>>) {
        let before = self
            .node(id)
            .map_or([0.0; 4], |node| [node.x, node.y, node.width, node.height]);
        self.record(id, node, false, before);
    }

    fn record(&mut self, id: Id, node: Option<Arc<Node>>, box_only: bool, before: [f64; 4]) {
        let index = id.index();
        if index >= self.slot.len() {
            self.slot.resize(index + 1, 0);
        }
        match self.slot[index] {
            0 => {
                self.slot[index] = self.writes.len() as u32 + 1;
                self.writes.push(Write {
                    id,
                    node,
                    box_only,
                    base_box: before,
                    over: None,
                });
            }
            mark if mark & OVER != 0 => {
                let over = self.over[(mark & !OVER) as usize].1.clone();
                self.slot[index] = self.writes.len() as u32 + 1;
                self.writes.push(Write {
                    id,
                    node,
                    box_only,
                    base_box: before,
                    over: Some(over),
                });
            }
            mark => {
                let write = &mut self.writes[mark as usize - 1];
                write.node = node;
                write.box_only &= box_only;
            }
        }
        self.note(id);
    }

    /// Tells the `collect` calls under way that `id` was written.
    fn note(&mut self, id: Id) {
        for ids in &mut self.watchers {
            ids.insert(id);
        }
    }

    // ── What was written ──

    /// Every node id written or removed so far, in the order first written (TS `written`): a superset of the nodes
    /// that differ from the original (a node changed and changed back stays). The patch's entries are not writes.
    pub fn written(&self) -> impl ExactSizeIterator<Item = Id> + '_ {
        self.writes.iter().map(|write| write.id)
    }

    pub fn is_written(&self, id: Id) -> bool {
        let mark = self.slot.get(id.index()).copied().unwrap_or(0);
        mark != 0 && mark & OVER == 0
    }

    /// The ids removed (and not added again) so far.
    pub fn removed(&self) -> impl Iterator<Item = Id> + '_ {
        self.writes
            .iter()
            .filter(|write| write.node.is_none())
            .map(|write| write.id)
    }

    /// The ids the patch laid over, in its order (`from`: JavaScript holds those nodes).
    pub fn over_ids(&self) -> impl ExactSizeIterator<Item = Id> + '_ {
        self.over.iter().map(|(id, _)| *id)
    }

    /// Whether `id` was written by [`Working::update_box`] alone: it differs from the base in x, y, width or height
    /// only.
    pub fn box_only(&self, id: Id) -> bool {
        let mark = self.slot.get(id.index()).copied().unwrap_or(0);
        mark != 0 && mark & OVER == 0 && self.writes[mark as usize - 1].box_only
    }

    /// The node ids whose variable modes were set or removed.
    pub fn modes_written(&self) -> impl ExactSizeIterator<Item = Id> + '_ {
        self.modes.iter().map(|(id, _)| *id)
    }

    /// Whether anything was written.
    pub fn changed(&self) -> bool {
        !self.writes.is_empty() || !self.modes.is_empty()
    }

    /// The writes as a patch's `nodes` table: each id written with its new value, or `None` if removed.
    pub fn changes(&self) -> impl ExactSizeIterator<Item = (Id, Option<&Arc<Node>>)> + '_ {
        self.writes
            .iter()
            .map(|write| (write.id, write.node.as_ref()))
    }

    /// The writes as a patch's `variableModes` table.
    pub fn mode_changes(
        &self,
    ) -> impl ExactSizeIterator<Item = (Id, Option<&IndexMap<Atom, Atom>>)> + '_ {
        self.modes.iter().map(|(id, modes)| (*id, modes.as_ref()))
    }

    /// One node in the JSON model (types.ts `SceneNode`), as it stands.
    pub fn node_model(&self, id: Id) -> Option<crate::types::SceneNode> {
        let node = self.node(id)?;
        Some(convert::node_out(node, &Resolving::new(self)))
    }

    /// [`Working::node_model`] of a shared node this draft's symbols name.
    pub fn model_of(&self, node: &Node) -> crate::types::SceneNode {
        convert::node_out(node, &Resolving::new(self))
    }

    /// The patch's entries and the draft's writes as one journal entry of the base document: the strings
    /// introduced, every id laid over or written with its final node (`None`: removed), the patch's table changes
    /// and the variable modes written. `base.replay(&entry)` is the document as normalized.
    pub fn into_entry(self) -> Entry {
        self.into_entry_and_slots().0
    }

    /// [`Working::into_entry`], also handing back the slot table, cleared, for the next working copy over the same
    /// document ([`Working::with_slots`]).
    pub fn into_entry_and_slots(mut self) -> (Entry, Vec<u32>) {
        let mut entry = std::mem::take(&mut self.table_changes);
        entry.ids_before = self.ids.offset() as u32;
        entry.atoms_before = self.atoms.offset() as u32;
        entry.new_ids = self.ids.extra().map(Box::from).collect();
        entry.new_atoms = self.atoms.extra().map(Box::from).collect();
        entry.nodes.reserve(self.over.len() + self.writes.len());
        for (id, node) in &self.over {
            let mark = self.slot[id.index()];
            if mark & OVER != 0 {
                entry.nodes.push((*id, node.clone()));
            }
            self.slot[id.index()] = 0;
        }
        for write in &self.writes {
            entry.nodes.push((write.id, write.node.clone()));
            self.slot[write.id.index()] = 0;
        }
        entry.variable_modes.append(&mut self.modes);
        debug_assert!(self.slot.iter().all(|&mark| mark == 0));
        (entry, std::mem::take(&mut self.slot))
    }

    /// The slot table back, cleared, the writes dropped (a call whose result is not kept).
    pub fn into_slots(mut self) -> Vec<u32> {
        for (id, _) in &self.over {
            self.slot[id.index()] = 0;
        }
        for write in &self.writes {
            self.slot[write.id.index()] = 0;
        }
        std::mem::take(&mut self.slot)
    }

    /// The document with every write (and the patch) applied: for tests and the stage oracle.
    pub fn into_document(self) -> Document {
        let mut doc = (*self.base).clone();
        let entry = self.into_entry();
        doc.replay(&entry)
            .expect("the entry continues its own base");
        doc
    }
}

// ── The epsilon rule on store nodes ─────────────────────────────────────────────────────────────

/// `update`'s rule for each field of `next` against `current` (each a TS key): equal fields are left alone, fields
/// equal within epsilon get `current`'s value back (and stay shared with it). Returns whether any field really
/// differs. Fixed numbers compare with [`same_f64`]; lists and bag values compare by pointer, then by value, and only
/// a value that differs is walked number by number (`crate::draft::Comparer`).
pub(crate) fn keep_same_fields(comparer: &mut Comparer, next: &mut Node, current: &Node) -> bool {
    let mut changed = false;
    macro_rules! exact {
        ($($field:ident),* $(,)?) => {
            $(if next.$field != current.$field { changed = true; })*
        };
    }
    macro_rules! numbers {
        ($($field:ident),* $(,)?) => {
            $(if next.$field != current.$field {
                if same_f64(next.$field, current.$field) {
                    next.$field = current.$field;
                } else {
                    changed = true;
                }
            })*
        };
    }
    macro_rules! lists {
        ($($field:ident),* $(,)?) => {
            $(if !next.$field.ptr_eq(&current.$field) {
                if next.$field == current.$field || comparer.same(&next.$field, &current.$field) {
                    next.$field = current.$field.clone();
                } else {
                    changed = true;
                }
            })*
        };
    }
    exact!(
        id,
        parent,
        name,
        kind,
        blend_mode,
        stroke_align,
        stroke_cap,
        stroke_join,
        layout_positioning,
        layout_sizing_horizontal,
        layout_sizing_vertical,
        constraints,
        visible,
        locked,
        is_mask,
        children,
    );
    numbers!(
        x,
        y,
        width,
        height,
        rotation,
        opacity,
        stroke_weight,
        stroke_miter_limit,
    );
    lists!(fills, strokes, effects);
    if !next.props.ptr_eq(&current.props) {
        changed |= keep_same_props(comparer, &mut next.props, &current.props);
    }
    changed
}

/// The rule over two bags: an entry equal to the stored one (by pointer, by value, or within epsilon) takes the
/// stored one; an entry added, removed or really changed is a change.
fn keep_same_props(comparer: &mut Comparer, next: &mut Props, current: &Props) -> bool {
    let (a, b) = (next.as_slice(), current.as_slice());
    let mut replacements: Vec<(usize, Prop)> = Vec::new();
    let mut changed = false;
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        match a[i].key().cmp(&b[j].key()) {
            std::cmp::Ordering::Less => {
                changed = true;
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                changed = true;
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                if !a[i].ptr_eq(&b[j]) {
                    if a[i] == b[j] || comparer.same(&a[i], &b[j]) {
                        replacements.push((i, b[j].clone()));
                    } else {
                        changed = true;
                    }
                }
                i += 1;
                j += 1;
            }
        }
    }
    if i < a.len() || j < b.len() {
        changed = true;
    }
    if !replacements.is_empty() {
        if changed {
            let mut props = a.to_vec();
            for (index, prop) in replacements {
                props[index] = prop;
            }
            *next = Props::from_sorted(props);
        } else {
            *next = current.clone();
        }
    }
    changed
}

/// `Prop`'s pointer-first equality for a value held in an `Option<Arc<T>>`.
pub fn same_arc<T: PartialEq + ?Sized>(a: &Arc<T>, b: &Arc<T>) -> bool {
    Arc::ptr_eq(a, b) || **a == **b
}

/// Two lists' equality, by pointer first.
pub fn same_list<T: PartialEq>(a: &List<T>, b: &List<T>) -> bool {
    a.ptr_eq(b) || a.as_slice() == b.as_slice()
}

// ── Stages ───────────────────────────────────────────────────────────────────────────────────────

/// One step of normalization on the store's nodes: the twin of [`crate::Stage`]. `run` reads and writes `draft`,
/// looks at `dirty` (the ids the change touched, plus what the stages before it reported) and returns the ids it
/// wrote or removed, and any others the stages after it must look at.
pub trait Stage {
    fn name(&self) -> &'static str;
    fn run(&self, draft: &mut Working, dirty: &SlotSet, ctx: &Ctx) -> SlotSet;
}

/// Runs `stages` in order. Each stage gets `dirty` together with every id the stages before it returned
/// (normalize.ts's growing `touched` set); returns that union after the last stage.
pub fn run_stages(
    stages: &[&dyn Stage],
    draft: &mut Working,
    dirty: &SlotSet,
    ctx: &Ctx,
) -> SlotSet {
    let mut touched = dirty.clone();
    for stage in stages {
        let reported = stage.run(draft, &touched, ctx);
        touched.extend(reported.iter());
    }
    touched
}

impl Working {
    /// The ids of `keys` as this draft's symbols, interning ones it has not seen (a dirty id that names no node,
    /// such as a variable's: the stages that look at variables resolve them back).
    pub fn slot_set(&mut self, keys: impl IntoIterator<Item = impl AsRef<str>>) -> SlotSet {
        let mut set = SlotSet::with_slots(self.slots());
        for key in keys {
            let id = self.intern_id(key.as_ref());
            set.insert(id);
        }
        set
    }
}

#[cfg(test)]
mod tests;
