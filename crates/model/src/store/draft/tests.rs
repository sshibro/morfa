//! `Working` against a reference that applies the same writes to the JSON model as TypeScript's `Draft` and
//! `DocumentDraft` do (`update` compares each key with `sameValue`, keeping the stored value within `LAYOUT_EPSILON`):
//! the same writes give the same document, and the entry it ends with replays onto its base.

use super::*;
use crate::draft::same_value;
use crate::types::{DesignDocument, Map, SceneNode};
use serde_json::{Value, json};

fn node_json(id: &str, kind: &str, parent: Option<&str>, children: Option<Vec<&str>>) -> Value {
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
    if kind == "TEXT" {
        node["text"] = json!({
            "characters": "Привет", "runs": [],
            "style": {"fontFamily": "Inter", "fontWeight": 400, "italic": false, "fontSize": 16, "lineHeight": {"unit": "AUTO"},
                      "letterSpacing": {"unit": "PERCENT", "value": 0}, "textDecoration": "NONE", "textCase": "ORIGINAL"},
            "textAlignHorizontal": "LEFT", "textAlignVertical": "TOP", "textAutoResize": "WIDTH_AND_HEIGHT",
            "paragraphSpacing": 0, "paragraphIndent": 0
        });
    }
    if kind == "RECTANGLE" {
        node["cornerRadius"] = json!(4);
    }
    node
}

/// A page holding `frames` frames of `each` children (rectangles and texts), with variable modes on the first frame.
fn document(frames: usize, each: usize) -> DesignDocument {
    let mut nodes = serde_json::Map::new();
    let mut page_children = Vec::new();
    for f in 0..frames {
        let frame = format!("f{f}");
        let children: Vec<String> = (0..each).map(|c| format!("f{f}c{c}")).collect();
        for (c, child) in children.iter().enumerate() {
            let kind = if c % 3 == 1 { "TEXT" } else { "RECTANGLE" };
            nodes.insert(child.clone(), node_json(child, kind, Some(&frame), None));
        }
        let refs: Vec<&str> = children.iter().map(String::as_str).collect();
        nodes.insert(
            frame.clone(),
            node_json(&frame, "FRAME", Some("page"), Some(refs)),
        );
        page_children.push(frame);
    }
    let refs: Vec<&str> = page_children.iter().map(String::as_str).collect();
    nodes.insert("page".into(), node_json("page", "PAGE", None, Some(refs)));
    let doc = json!({
        "schemaVersion": 1, "pages": ["page"], "nodes": nodes,
        "styles": {}, "images": {}, "variableCollections": {}, "variables": {},
        "variableModes": {"f0": {"collection": "dark"}}
    });
    serde_json::from_value(doc).expect("a valid document")
}

fn rect_model(doc: &DesignDocument, id: &str, parent: &str) -> SceneNode {
    let mut node = doc.nodes["f0c0"].clone();
    node.id = id.to_owned();
    node.name = id.to_owned();
    node.parent_id = Some(parent.to_owned());
    node
}

/// One write, applied the same way to both drafts.
#[derive(Clone, Debug)]
enum Op {
    X(String, f64),
    Width(String, f64),
    Name(String, String),
    Fills(String),
    Radius(String, f64),
    Box(String, Option<f64>, Option<f64>, Option<f64>, Option<f64>),
    Characters(String, String),
    Put(String),
    Insert(String, String, Option<usize>),
    Remove(String),
    Modes(String, Option<Vec<(String, String)>>),
}

/// TypeScript's `Draft` (constraints.ts) and `DocumentDraft` (components.ts) on the JSON model, as the stages wrote
/// into them before lane N1: `update` compares each key with `sameValue` and keeps the stored value where the new one
/// is the same within `LAYOUT_EPSILON`; `put` stores exactly; `insert` and `remove` keep the parent's children in step.
struct Reference {
    doc: DesignDocument,
    /// Ids written or removed, in the order first written.
    written: Vec<String>,
    /// Ids written in more than their box.
    full: std::collections::HashSet<String>,
    modes_written: Vec<String>,
}

impl Reference {
    fn new(doc: DesignDocument) -> Self {
        Self {
            doc,
            written: Vec::new(),
            full: std::collections::HashSet::new(),
            modes_written: Vec::new(),
        }
    }

    fn note(&mut self, id: &str, full: bool) {
        if !self.written.iter().any(|w| w == id) {
            self.written.push(id.to_owned());
        }
        if full {
            self.full.insert(id.to_owned());
        }
    }

    /// `update(id, fields)`: key by key, a value the same within epsilon keeps the stored one.
    fn update_by(&mut self, id: &str, full: bool, change: impl FnOnce(&mut SceneNode)) -> bool {
        let Some(current) = self.doc.nodes.get(id) else {
            return false;
        };
        let mut next = current.clone();
        change(&mut next);
        let mut after = serde_json::to_value(&next).unwrap();
        let before = serde_json::to_value(current).unwrap();
        let (Value::Object(after_map), Value::Object(before_map)) = (&mut after, &before) else {
            unreachable!("nodes are objects")
        };
        let mut changed = before_map.keys().any(|key| !after_map.contains_key(key));
        for (key, value) in after_map.iter_mut() {
            match before_map.get(key) {
                Some(stored) if same_value(value, stored) => *value = stored.clone(),
                _ => changed = true,
            }
        }
        if !changed {
            return false;
        }
        let node: SceneNode = serde_json::from_value(after).expect("a node");
        self.doc.nodes.insert(id.to_owned(), node);
        self.note(id, full);
        true
    }

    fn update(&mut self, id: &str, change: impl FnOnce(&mut SceneNode)) -> bool {
        self.update_by(id, true, change)
    }

    fn update_box(
        &mut self,
        id: &str,
        x: Option<f64>,
        y: Option<f64>,
        width: Option<f64>,
        height: Option<f64>,
    ) -> bool {
        let full = self.full.contains(id);
        self.update_by(id, full, |node| {
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
        })
    }

    /// `DocumentDraft.put`: exactly as given, always written.
    fn put(&mut self, node: SceneNode) {
        let id = node.id.clone();
        self.doc.nodes.insert(id.clone(), node);
        self.note(&id, true);
    }

    /// components.ts `insertChild`: the node, then its parent's children.
    fn insert(&mut self, node: SceneNode, index: Option<usize>) -> bool {
        if self.doc.nodes.contains_key(&node.id) {
            return false;
        }
        let id = node.id.clone();
        let parent = node.parent_id.clone();
        self.doc.nodes.insert(id.clone(), node);
        self.note(&id, true);
        if let Some(parent) = parent {
            self.update(&parent, |parent| {
                let children = parent.children.get_or_insert_with(Vec::new);
                children.retain(|child| *child != id);
                let at = index.unwrap_or(children.len()).min(children.len());
                children.insert(at, id.clone());
            });
        }
        true
    }

    /// TS `remove`: out of the parent's children, then the subtree, children before their parent, modes dropped.
    fn remove(&mut self, id: &str) -> bool {
        let Some(node) = self.doc.nodes.get(id) else {
            return false;
        };
        if let Some(parent) = node.parent_id.clone()
            && self
                .doc
                .nodes
                .get(&parent)
                .is_some_and(|parent| parent.children.is_some())
        {
            self.update(&parent, |parent| {
                if let Some(children) = &mut parent.children {
                    children.retain(|child| child != id);
                }
            });
        }
        self.drop_subtree(id);
        true
    }

    fn drop_subtree(&mut self, id: &str) {
        let Some(node) = self.doc.nodes.get(id) else {
            return;
        };
        for child in node.children.clone().into_iter().flatten() {
            self.drop_subtree(&child);
        }
        self.doc.nodes.shift_remove(id);
        self.note(id, true);
        if self
            .doc
            .variable_modes
            .as_ref()
            .is_some_and(|modes| modes.contains_key(id))
        {
            self.set_modes(id, None);
        }
    }

    fn set_modes(&mut self, id: &str, modes: Option<Map<String>>) -> bool {
        let modes = modes.filter(|modes| !modes.is_empty());
        let current = self
            .doc
            .variable_modes
            .as_ref()
            .and_then(|table| table.get(id));
        if current == modes.as_ref() {
            return false;
        }
        let table = self.doc.variable_modes.get_or_insert_with(Map::new);
        match modes {
            Some(modes) => {
                table.insert(id.to_owned(), modes);
            }
            None => {
                table.shift_remove(id);
            }
        }
        if !self.modes_written.iter().any(|w| w == id) {
            self.modes_written.push(id.to_owned());
        }
        true
    }

    fn box_only(&self, id: &str) -> bool {
        self.written.iter().any(|w| w == id) && !self.full.contains(id)
    }

    fn ids(&self) -> Vec<&str> {
        self.doc.nodes.keys().map(String::as_str).collect()
    }

    fn into_document(mut self) -> DesignDocument {
        if self.doc.variable_modes.as_ref().is_some_and(Map::is_empty) {
            self.doc.variable_modes = None;
        }
        self.doc
    }
}

fn apply_model(draft: &mut Reference, source: &DesignDocument, op: &Op) -> bool {
    match op {
        Op::X(id, x) => draft.update(id, |node| node.x = *x),
        Op::Width(id, width) => draft.update(id, |node| node.width = *width),
        Op::Name(id, name) => draft.update(id, |node| node.name.clone_from(name)),
        Op::Fills(id) => draft.update(id, |node| {
            if node.fills.is_empty() {
                node.fills = source.nodes["f0c0"].fills.clone();
            } else {
                node.fills.clear();
            }
        }),
        Op::Radius(id, radius) => draft.update(id, |node| node.corner_radius = Some(*radius)),
        Op::Box(id, x, y, w, h) => draft.update_box(id, *x, *y, *w, *h),
        Op::Characters(id, text) => draft.update(id, |node| {
            if let Some(props) = node.text.as_mut() {
                props.characters.clone_from(text);
            }
        }),
        Op::Put(id) => {
            let Some(mut node) = draft.doc.nodes.get(id).cloned() else {
                return false;
            };
            node.opacity = 0.5;
            draft.put(node);
            true
        }
        Op::Insert(id, parent, index) => draft.insert(rect_model(source, id, parent), *index),
        Op::Remove(id) => draft.remove(id),
        Op::Modes(id, modes) => draft.set_modes(
            id,
            modes.as_ref().map(|pairs| {
                pairs
                    .iter()
                    .map(|(k, v)| (k.clone(), v.clone()))
                    .collect::<Map<String>>()
            }),
        ),
    }
}

fn apply_store(draft: &mut Working, source: &Document, op: &Op) -> bool {
    let id_of = |draft: &mut Working, key: &str| draft.intern_id(key);
    match op {
        Op::X(id, x) => {
            let id = id_of(draft, id);
            draft.update(id, |node| node.x = *x)
        }
        Op::Width(id, width) => {
            let id = id_of(draft, id);
            draft.update(id, |node| node.width = *width)
        }
        Op::Name(id, name) => {
            let id = id_of(draft, id);
            let name = draft.intern_atom(name);
            draft.update(id, |node| node.name = name)
        }
        Op::Fills(id) => {
            let id = id_of(draft, id);
            let fills = source.node_by_key("f0c0").unwrap().fills.clone();
            draft.update(id, |node| {
                if node.fills.is_empty() {
                    node.fills = fills;
                } else {
                    node.fills = List::new();
                }
            })
        }
        Op::Radius(id, radius) => {
            let id = id_of(draft, id);
            draft.update(id, |node| node.props.set(Prop::CornerRadius(*radius)))
        }
        Op::Box(id, x, y, w, h) => {
            let id = id_of(draft, id);
            draft.update_box(id, *x, *y, *w, *h)
        }
        Op::Characters(id, text) => {
            let id = id_of(draft, id);
            draft.update(id, |node| {
                if let Some(props) = node.props.text() {
                    let mut props = Arc::clone(props);
                    Arc::make_mut(&mut props).characters = Arc::from(text.as_str());
                    node.props.set(Prop::Text(props));
                }
            })
        }
        Op::Put(id) => {
            let id = id_of(draft, id);
            let Some(mut node) = draft.node(id).cloned() else {
                return false;
            };
            node.opacity = 0.5;
            draft.put(node);
            true
        }
        Op::Insert(id, parent, index) => {
            let template = source.node_by_key("f0c0").unwrap().clone();
            let id_sym = id_of(draft, id);
            let parent_sym = id_of(draft, parent);
            let name = draft.intern_atom(id);
            let node = Node {
                id: id_sym,
                parent: Some(parent_sym),
                name,
                ..template
            };
            draft.insert(node, *index)
        }
        Op::Remove(id) => {
            let id = id_of(draft, id);
            draft.remove(id)
        }
        Op::Modes(id, modes) => {
            let id = id_of(draft, id);
            let modes = modes.as_ref().map(|pairs| {
                pairs
                    .iter()
                    .map(|(k, v)| (draft.intern_atom(k), draft.intern_atom(v)))
                    .collect::<IndexMap<Atom, Atom>>()
            });
            draft.set_modes(id, modes)
        }
    }
}

struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 ^= self.0 << 13;
        self.0 ^= self.0 >> 7;
        self.0 ^= self.0 << 17;
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        (self.next() % bound as u64) as usize
    }

    fn pick<'a>(&mut self, items: &'a [String]) -> &'a str {
        &items[self.below(items.len())]
    }
}

fn random_ops(rng: &mut Rng, ids: &[String], count: usize) -> Vec<Op> {
    let mut ops = Vec::with_capacity(count);
    let mut added = 0;
    for _ in 0..count {
        let id = rng.pick(ids).to_owned();
        let op = match rng.below(12) {
            0 => Op::X(id, rng.below(50) as f64),
            // Within epsilon of the stored value: dropped.
            1 => Op::X(id, 10.0 + 1e-8),
            2 => Op::Width(id, 100.0 + rng.below(3) as f64),
            3 => Op::Name(id, format!("name {}", rng.below(4))),
            4 => Op::Fills(id),
            5 => Op::Radius(id, 4.0 + if rng.below(2) == 0 { 1e-9 } else { 2.0 }),
            6 => Op::Box(
                id,
                Some(rng.below(30) as f64),
                None,
                Some(100.0 + rng.below(2) as f64),
                Some(50.0 + 1e-9),
            ),
            7 => Op::Characters(id, format!("text {}", rng.below(3))),
            8 => Op::Put(id),
            9 => {
                added += 1;
                Op::Insert(format!("new{added}"), id, Some(rng.below(3)))
            }
            10 => Op::Remove(id),
            _ => Op::Modes(
                id,
                if rng.below(3) == 0 {
                    None
                } else {
                    Some(vec![("collection".into(), format!("mode{}", rng.below(2)))])
                },
            ),
        };
        ops.push(op);
    }
    ops
}

/// A model document with an empty `variableModes` table and one without are the same document (`DocumentDraft.finish`
/// drops the table when it empties; `applyPatch` keeps it).
fn same_document(a: &DesignDocument, b: &DesignDocument) {
    let mut a = a.clone();
    let mut b = b.clone();
    if a.variable_modes.as_ref().is_some_and(Map::is_empty) {
        a.variable_modes = None;
    }
    if b.variable_modes.as_ref().is_some_and(Map::is_empty) {
        b.variable_modes = None;
    }
    assert_eq!(a.nodes.len(), b.nodes.len());
    for (id, node) in &a.nodes {
        assert_eq!(Some(node), b.nodes.get(id), "node {id}");
    }
    assert_eq!(
        a.nodes.keys().collect::<Vec<_>>(),
        b.nodes.keys().collect::<Vec<_>>(),
        "table order"
    );
    assert_eq!(a.variable_modes, b.variable_modes);
    assert_eq!(a, b);
}

#[test]
fn the_same_writes_give_the_same_document_as_the_reference() {
    for seed in 1..=40u64 {
        let mut rng = Rng(seed.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let model = document(3, 5);
        let store = Arc::new(Document::from_model(&model));
        let ids: Vec<String> = model.nodes.keys().cloned().collect();
        let ops = random_ops(&mut rng, &ids, 24);
        let mut draft = Reference::new(model.clone());
        let mut working = Working::new(Arc::clone(&store));
        for op in &ops {
            let a = apply_model(&mut draft, &model, op);
            let b = apply_store(&mut working, &store, op);
            assert_eq!(a, b, "seed {seed}: {op:?} reported differently");
        }
        let written: Vec<&str> = draft.written.iter().map(String::as_str).collect();
        let store_written: Vec<&str> = working.written().map(|id| working.key(id)).collect();
        assert_eq!(written, store_written, "seed {seed}: written ids");
        let modes: Vec<&str> = draft.modes_written.iter().map(String::as_str).collect();
        let store_modes: Vec<&str> = working.modes_written().map(|id| working.key(id)).collect();
        assert_eq!(modes, store_modes, "seed {seed}: modes written");
        let box_only: Vec<&str> = written
            .iter()
            .copied()
            .filter(|id| draft.box_only(id))
            .collect();
        let store_box_only: Vec<&str> = store_written
            .iter()
            .copied()
            .filter(|id| working.box_only(working.id(id).unwrap()))
            .collect();
        assert_eq!(box_only, store_box_only, "seed {seed}: box-only writes");
        let ids: Vec<&str> = working
            .ids()
            .into_iter()
            .map(|id| working.key(id))
            .collect();
        assert_eq!(draft.ids(), ids, "seed {seed}: table order as it stands");
        same_document(&draft.into_document(), &working.into_document().to_model());
    }
}

#[test]
fn a_patch_laid_over_is_the_base_of_the_writes_and_part_of_the_entry() {
    let model = document(2, 3);
    let store = Arc::new(Document::from_model(&model));
    let mut patch = DocumentPatch::default();
    let mut moved = model.nodes["f0c0"].clone();
    moved.x = 99.0;
    let added = rect_model(&model, "dot", "f1");
    patch.nodes = Some(
        [
            ("f0c0".to_owned(), Some(moved)),
            ("dot".to_owned(), Some(added)),
            ("f1c2".to_owned(), None),
        ]
        .into_iter()
        .collect(),
    );
    patch.variable_modes = Some(
        [(
            "f1".to_owned(),
            Some([("c".to_owned(), "m".to_owned())].into_iter().collect()),
        )]
        .into_iter()
        .collect(),
    );
    let mut patched = model.clone();
    patch.apply(&mut patched);

    let mut working = Working::new(Arc::clone(&store));
    working.lay_over(&patch);
    let dot = working.id("dot").expect("the patch's new id is interned");
    assert!(working.contains(dot));
    assert_eq!(
        working
            .over_ids()
            .map(|id| working.key(id))
            .collect::<Vec<_>>(),
        ["f0c0", "dot", "f1c2"]
    );
    assert_eq!(working.written().len(), 0, "the patch is not a write");
    let f0c0 = working.id("f0c0").unwrap();
    assert_eq!(working.node(f0c0).map(|node| node.x), Some(99.0));
    assert_eq!(working.base_node(f0c0).map(|node| node.x), Some(99.0));
    assert!(working.update(f0c0, |node| node.x = 5.0));
    assert_eq!(
        working.base_node(f0c0).map(|node| node.x),
        Some(99.0),
        "the base is the patched node"
    );
    assert_eq!(working.base_box(f0c0), Some([99.0, 20.0, 100.0, 50.0]));
    assert!(working.update_box(dot, Some(1.0), None, None, None));
    assert!(working.box_only(dot));
    let f1 = working.id("f1").unwrap();
    let c = working.atom_of("c").unwrap();
    assert_eq!(
        working
            .modes_of(f1)
            .and_then(|modes| modes.get(&c))
            .map(|m| working.atom(*m)),
        Some("m")
    );

    // The same writes on the reference over the patched document.
    let mut draft = Reference::new(patched.clone());
    draft.update("f0c0", |node| node.x = 5.0);
    draft.update_box("dot", Some(1.0), None, None, None);
    let ids: Vec<&str> = working
        .ids()
        .into_iter()
        .map(|id| working.key(id))
        .collect();
    assert_eq!(draft.ids(), ids);

    let entry = working.into_entry();
    assert_eq!(entry.ids_before as usize, store.ids().len());
    assert_eq!(entry.new_ids, vec![Box::from("dot")]);
    let mut doc = (*store).clone();
    doc.replay(&entry).expect("the entry continues its base");
    same_document(&draft.into_document(), &doc.to_model());
    // Replaying it again is refused: it belongs to the state before.
    assert!(doc.replay(&entry).is_err());
}

#[test]
fn slot_sets_keep_order_and_bits() {
    let mut set = SlotSet::new();
    let ids = [Id::from_index(3), Id::from_index(130), Id::from_index(3)];
    assert!(set.insert(ids[0]));
    assert!(set.insert(ids[1]));
    assert!(!set.insert(ids[2]));
    assert_eq!(set.len(), 2);
    assert!(set.contains(Id::from_index(130)) && !set.contains(Id::from_index(129)));
    assert_eq!(set.iter().collect::<Vec<_>>(), [ids[0], ids[1]]);
    set.clear();
    assert!(set.is_empty() && !set.contains(ids[1]));
    let again: SlotSet = ids.into_iter().collect();
    assert_eq!(again.as_slice(), &ids[..2]);
}

#[test]
fn collect_reports_nested_writes_and_removal_order() {
    let model = document(1, 3);
    let store = Arc::new(Document::from_model(&model));
    let mut working = Working::new(Arc::clone(&store));
    let f0 = working.id("f0").unwrap();
    let collected = working.collect(|working| {
        let inner = working.collect(|working| {
            assert!(working.remove(f0));
        });
        assert_eq!(inner.len(), 5, "the parent, three children and the frame");
    });
    let names: Vec<&str> = collected.iter().map(|id| working.key(id)).collect();
    assert_eq!(names, ["page", "f0c0", "f0c1", "f0c2", "f0"]);
    assert_eq!(working.modes_of(f0), None, "removed nodes lose their modes");
    assert!(!working.remove(f0));
    let removed: Vec<&str> = working.removed().map(|id| working.key(id)).collect();
    assert_eq!(removed, ["f0c0", "f0c1", "f0c2", "f0"]);
    assert_eq!(working.ids().len(), 1);
    let (entry, slots) = working.into_entry_and_slots();
    assert!(slots.iter().all(|&mark| mark == 0) && slots.len() >= store.slots());
    assert_eq!(entry.nodes.len(), 5);
    assert_eq!(entry.variable_modes.len(), 1);
}

#[test]
fn pointer_first_equality_shares_what_is_equal() {
    let model = document(1, 2);
    let store = Arc::new(Document::from_model(&model));
    let mut working = Working::new(Arc::clone(&store));
    let id = working.id("f0c0").unwrap();
    let before = Arc::clone(working.arc(id).unwrap());
    // Fills replaced by an equal list: no change, nothing written.
    let same_fills = before.fills.as_slice().to_vec().into();
    assert!(!working.update(id, |node| node.fills = same_fills));
    assert!(working.written().len() == 0);
    // A real change beside a within-epsilon one: the within-epsilon value stays the stored one and the bag entry
    // stays shared.
    assert!(working.update(id, |node| {
        node.width = 120.0;
        node.props.set(Prop::CornerRadius(4.0 + 1e-9));
    }));
    let after = working.arc(id).unwrap();
    assert_eq!(after.width, 120.0);
    assert_eq!(after.props.corner_radius(), Some(&4.0));
    assert!(
        after.fills.ptr_eq(&before.fills),
        "unchanged lists stay shared"
    );
    assert!(after.props.as_slice()[0].ptr_eq(&before.props.as_slice()[0]));
    // Props: equal bags compare by pointer first, then by value.
    assert!(before.props == after.props);
    assert_eq!(before.fills, after.fills);
}
