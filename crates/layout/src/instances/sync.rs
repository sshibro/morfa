//! Instance sync (components.ts §Sync) on store nodes, function by function in
//! the TypeScript's order.
//!
//! A copy is rebuilt from the node it mirrors, its overrides, its owner instance's property values and its parent's
//! resize; top-level instances are rebuilt whole, nested instances of a main first. A rebuilt copy takes its main's
//! shared values (lists, text, auto layout: the `Arc`s of its bag) instead of copies of them, as TypeScript's copies
//! share the main's objects. TypeScript skips a copy it derived from the same source objects before (a `WeakMap` by
//! identity); [`Derived`] is that cache over the shared nodes, kept with the shadow between calls.

use std::rc::Rc;
use std::sync::Arc;

use indexmap::{IndexMap, IndexSet};
use morfa_model::store::draft::{SlotSet, Working};
use morfa_model::store::{
    Atom, Id, Node, Prop, PropKey, PropertyDefinition, PropertyValue, TextProps, TextRun,
};
use morfa_model::types::{
    ComponentPropertyType, LayoutPositioning, LayoutSizing, Map, NodeType, TextAutoResize,
};
use rustc_hash::{FxHashMap, FxHashSet};

use super::fields::{Field, FieldSet};
use super::overrides::{Parsed, Parts, apply_overrides, has, is_part_overridden, parse, sets};
use super::placed;
use super::variants::{
    definitions_in, display_name, property_name, variant_definitions_from_names, variant_values_in,
};
use crate::constraints::{scale_paths, scale_text_path};
use crate::instances::geom::{constrained_box, js_max, same_number, text_mode_after_resize};
use crate::is_auto_layout;

// ── Tree queries ─────────────────────────────────────────────────────────────────────────────────

/// `isInstanceCopy`: copies are exactly the nodes with a `mainId`.
pub fn is_instance_copy(node: Option<&Node>) -> bool {
    node.is_some_and(|node| node.props.main_id().is_some())
}

/// `rootInstanceIn`: the top-level instance a copy belongs to (the instance itself for an instance).
pub fn root_instance_in(draft: &Working, id: Id) -> Option<Id> {
    let mut node = draft.node(id);
    let mut guard = 0;
    while let Some(current) = node {
        if current.props.main_id().is_none() || guard >= 10_000 {
            break;
        }
        node = draft.node_opt(current.parent);
        guard += 1;
    }
    node.filter(|node| node.kind == NodeType::Instance)
        .map(|node| node.id)
}

/// `nearestComponentIn`: the COMPONENT a node is part of (itself for a component).
pub fn nearest_component_in(draft: &Working, id: Option<Id>) -> Option<Id> {
    let mut node = draft.node_opt(id);
    let mut guard = 0;
    while let Some(current) = node {
        if guard >= 10_000 {
            break;
        }
        if current.kind == NodeType::Component {
            return Some(current.id);
        }
        node = draft.node_opt(current.parent);
        guard += 1;
    }
    None
}

// ── Text that follows a copy ────────────────────────────────────────────────────────────────────

/// JavaScript's `string.length`: UTF-16 code units.
pub fn js_length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// `clipRuns`: `None` when every run already ends within `length` (TS returns the same array).
pub fn clip_runs(runs: &[TextRun], length: f64) -> Option<Vec<TextRun>> {
    if runs.iter().all(|run| run.end <= length) {
        return None;
    }
    let mut out = Vec::with_capacity(runs.len());
    for run in runs {
        if run.start >= length {
            continue;
        }
        if run.end > length {
            let mut clipped = run.clone();
            clipped.end = length;
            out.push(clipped);
        } else {
            out.push(run.clone());
        }
    }
    Some(out)
}

/// `withCharacters(text, characters)`.
pub fn with_characters(text: &mut TextProps, characters: &str) {
    text.characters = Arc::from(characters);
    if let Some(runs) = clip_runs(&text.runs, js_length(characters) as f64) {
        text.runs = runs.into();
    }
}

/// `sanitizeText`: runs clipped to the characters; the text stays shared when nothing is clipped.
pub fn sanitize_text(text: &Arc<TextProps>) -> Option<Arc<TextProps>> {
    let runs = clip_runs(&text.runs, js_length(&text.characters) as f64)?;
    let mut next = Arc::clone(text);
    Arc::make_mut(&mut next).runs = runs.into();
    Some(next)
}

// ── Building nodes ──────────────────────────────────────────────────────────────────────────────

/// `fromComponent`: an INSTANCE built from `component`'s fields with `placement`'s placement fields.
fn from_component(draft: &Working, component: &Node, placement: &Node, fields: FieldSet) -> Node {
    let mut node = Field::clone_except(component, sets().component_only);
    for field in &sets().placement_fields {
        if fields.has(*field) {
            field.copy(&mut node, placement);
        }
    }
    if fields.has(Field::Fixed(super::fields::Fixed::LayoutSizingHorizontal)) {
        node.layout_sizing_horizontal = placement.layout_sizing_horizontal;
    }
    if fields.has(Field::Fixed(super::fields::Fixed::LayoutSizingVertical)) {
        node.layout_sizing_vertical = placement.layout_sizing_vertical;
    }
    node.kind = NodeType::Instance;
    node.props.set(Prop::ComponentId(component.id));
    node.name = display_name(draft, component);
    node
}

/// `mirrorsSource`: a copy without overrides holding exactly its source's fields.
fn mirrors_source(copy: &Node, source: &Node) -> bool {
    if copy.props.main_id() != Some(&source.id) || copy.kind != source.kind {
        return false;
    }
    Field::all_same_except(copy, source, sets().copy_identity)
}

/// `sameIds(a, b)`.
fn same_ids(a: &[Id], b: Option<&[Id]>) -> bool {
    b.is_some_and(|b| a == b)
}

/// `isCopyId(id, prefix, mainId)`: `id === `${prefix};${mainId}``.
fn is_copy_id(draft: &Working, id: Id, prefix: Id, main_id: Id) -> bool {
    let (id, prefix, main_id) = (draft.key(id), draft.key(prefix), draft.key(main_id));
    id.len() == prefix.len() + 1 + main_id.len()
        && id.as_bytes()[prefix.len()] == b';'
        && id.starts_with(prefix)
        && id.ends_with(main_id)
}

fn copy_id(draft: &mut Working, prefix: Id, main_id: Id) -> Id {
    let (prefix, main_id) = (draft.key(prefix), draft.key(main_id));
    let mut id = String::with_capacity(prefix.len() + 1 + main_id.len());
    id.push_str(prefix);
    id.push(';');
    id.push_str(main_id);
    draft.intern_id(&id)
}

/// How a copy's children follow when the copy's box differs from its source's (`ChildGeometry`).
#[derive(Clone, Copy, Debug)]
struct ChildGeometry {
    before: (f64, f64),
    after: (f64, f64),
    scale: bool,
}

/// `Placement`.
#[derive(Clone, Copy, Debug)]
struct Placement {
    geometry: Option<ChildGeometry>,
    flow: bool,
}

fn child_geometry(node: &Node, source: &Node) -> Option<ChildGeometry> {
    if same_number(node.width, source.width) && same_number(node.height, source.height) {
        return None;
    }
    if node.kind == NodeType::Section {
        return None;
    }
    Some(ChildGeometry {
        before: (source.width, source.height),
        after: (node.width, node.height),
        scale: matches!(node.kind, NodeType::Group | NodeType::BooleanOperation),
    })
}

/// `applyGeometry`: the copy follows its parent's resize by its constraints.
fn apply_geometry(node: &mut Node, overrides: Option<&Parsed>, geometry: &ChildGeometry) {
    let constraints = if geometry.scale {
        morfa_model::types::Constraints {
            horizontal: morfa_model::types::ConstraintType::Scale,
            vertical: morfa_model::types::ConstraintType::Scale,
        }
    } else {
        node.constraints
    };
    let rect = constrained_box(&placed(node), geometry.before, geometry.after, &constraints);
    let width = js_max(0.0, rect.width);
    let height = if node.kind == NodeType::Line {
        0.0
    } else {
        js_max(0.0, rect.height)
    };
    let width_changed = !same_number(width, node.width);
    let height_changed = !same_number(height, node.height);
    if !has(overrides, "x") {
        node.x = rect.x;
    }
    if !has(overrides, "y") {
        node.y = rect.y;
    }
    if !has(overrides, "width") {
        node.width = width;
    }
    if !has(overrides, "height") {
        node.height = height;
    }
    // A text stretched by its constraints stops growing on that axis, as constraints.ts does it.
    if let Some(text) = node.props.text()
        && (width_changed || height_changed)
        && !is_part_overridden(overrides, "text", "textAutoResize")
    {
        let mode = text_mode_after_resize(text.text_auto_resize, width_changed, height_changed);
        if mode != text.text_auto_resize {
            crate::set_text_auto_resize(node, mode);
            if !has(overrides, "layoutSizingHorizontal")
                && node.layout_sizing_horizontal != LayoutSizing::Fill
            {
                node.layout_sizing_horizontal = if mode == TextAutoResize::WidthAndHeight {
                    LayoutSizing::Hug
                } else {
                    LayoutSizing::Fixed
                };
            }
            if !has(overrides, "layoutSizingVertical")
                && node.layout_sizing_vertical != LayoutSizing::Fill
            {
                node.layout_sizing_vertical = if matches!(
                    mode,
                    TextAutoResize::WidthAndHeight | TextAutoResize::Height
                ) {
                    LayoutSizing::Hug
                } else {
                    LayoutSizing::Fixed
                };
            }
        }
    }
}

/// `keepLayoutOwned`: what auto layout and text measuring own stays as the copy was last laid out.
fn keep_layout_owned(
    node: &mut Node,
    old: &Node,
    overrides: Option<&Parsed>,
    flow: bool,
    root: bool,
) {
    let in_flow = flow && node.layout_positioning != LayoutPositioning::Absolute;
    if in_flow && !root {
        if !has(overrides, "x") {
            node.x = old.x;
        }
        if !has(overrides, "y") {
            node.y = old.y;
        }
    }
    // Measured sizes hold while the text is the same (the same shared text, or an equal one).
    let measured = match (node.props.text(), old.props.text()) {
        (Some(text), Some(old_text)) => Arc::ptr_eq(text, old_text) || **text == **old_text,
        _ => false,
    };
    let lays_out = is_auto_layout(Some(node));
    let sizing = |value: LayoutSizing| {
        (in_flow && value == LayoutSizing::Fill)
            || (value == LayoutSizing::Hug && (lays_out || measured))
    };
    if sizing(node.layout_sizing_horizontal) && !has(overrides, "width") {
        node.width = old.width;
    }
    if sizing(node.layout_sizing_vertical) && !has(overrides, "height") {
        node.height = old.height;
    }
    if measured && !in_flow {
        let mode = node.props.text().map(|text| text.text_auto_resize);
        if mode == Some(TextAutoResize::WidthAndHeight) {
            if !has(overrides, "width") {
                node.width = old.width;
            }
            if !has(overrides, "height") {
                node.height = old.height;
            }
        } else if mode == Some(TextAutoResize::Height)
            && same_number(node.width, old.width)
            && !has(overrides, "height")
        {
            node.height = old.height;
        }
    }
}

// ── Reverse index ───────────────────────────────────────────────────────────────────────────────

/// `InstanceIndex`: component → every INSTANCE showing it, in table order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct InstanceIndex {
    pub by_component: FxHashMap<Id, Vec<Id>>,
    pub count: usize,
}

impl InstanceIndex {
    /// `buildInstanceIndex` over the table as it stands.
    pub fn build(draft: &Working) -> Self {
        let mut index = InstanceIndex::default();
        draft.for_each_id(|id| {
            let Some(node) = draft.node(id) else { return };
            if node.kind != NodeType::Instance {
                return;
            }
            let Some(component) = node.props.component_id() else {
                return;
            };
            index.count += 1;
            index
                .by_component
                .entry(*component)
                .or_default()
                .push(node.id);
        });
        index
    }
}

// ── The identity cache ──────────────────────────────────────────────────────────────────────────

/// Copy → the source node it was last derived from, recorded only when nothing else fed the derivation (no parent
/// resize, no property references, no swap transfer), one table for children of a plain parent and one for children
/// of an auto-layout parent (TypeScript's `derivedFrom` WeakMaps). Both nodes are held, so the pointers compared name
/// those versions and no other; while the copy and its source are the same shared nodes the copy is up to date and
/// syncing skips it. Kept with the shadow between calls.
#[derive(Default)]
pub struct Derived {
    tables: [DerivedTable; 2],
    /// Top-level instance → what its last rebuild read when it found the instance's own node up to date.
    roots: FxHashMap<Id, RootDerived>,
}

/// Copy → (its source as derived, the copy as derived).
type DerivedTable = FxHashMap<Id, (Arc<Node>, Arc<Node>)>;

/// What `rebuild_root` reads to build a top-level instance's own node (its children aside), as they were when the
/// node it built equalled the instance (so nothing was written): the component and its set, the instance itself, the
/// parent's flow and whether layout's size is kept. The same again builds the same node: only the children are
/// rebuilt (lane N1 step 9; TypeScript rebuilds the node and finds it equal).
struct RootDerived {
    component: Arc<Node>,
    set: Option<Arc<Node>>,
    instance: Arc<Node>,
    flow: bool,
    keeps: bool,
}

impl RootDerived {
    fn same(
        &self,
        component: &Arc<Node>,
        set: &Option<Arc<Node>>,
        instance: &Arc<Node>,
        flow: bool,
        keeps: bool,
    ) -> bool {
        self.flow == flow
            && self.keeps == keeps
            && Arc::ptr_eq(&self.component, component)
            && Arc::ptr_eq(&self.instance, instance)
            && match (&self.set, set) {
                (None, None) => true,
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                _ => false,
            }
    }
}

impl Derived {
    fn hit(&self, flow: bool, id: Id, source: &Arc<Node>, copy: &Arc<Node>) -> bool {
        self.tables[usize::from(flow)]
            .get(&id)
            .is_some_and(|(from, old)| Arc::ptr_eq(from, source) && Arc::ptr_eq(old, copy))
    }

    fn set(&mut self, flow: bool, id: Id, source: &Arc<Node>, copy: &Arc<Node>) {
        self.tables[usize::from(flow)].insert(id, (Arc::clone(source), Arc::clone(copy)));
    }

    /// Forgets everything (the document was replaced).
    pub fn clear(&mut self) {
        for table in &mut self.tables {
            table.clear();
        }
        self.roots.clear();
    }

    /// How many top-level instances are known up to date (tests).
    pub fn roots_len(&self) -> usize {
        self.roots.len()
    }

    pub fn len(&self) -> usize {
        self.tables[0].len() + self.tables[1].len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

// ── Sync ────────────────────────────────────────────────────────────────────────────────────────

/// The owner instance's property values its copies read (`Owner`): shared with the instance node they end up in.
type Props = Arc<IndexMap<Atom, PropertyValue>>;

/// `Transfer`: old copies by name path, for a swap.
type Transfer = FxHashMap<String, Arc<Node>>;

/// `RootState`.
#[derive(Default)]
struct RootState {
    stale: Vec<(Id, Id)>,
}

/// `validPropertyValue`.
fn valid_property_value(def: &PropertyDefinition, value: &PropertyValue) -> bool {
    match def.kind {
        ComponentPropertyType::Boolean => matches!(value, PropertyValue::Boolean(_)),
        _ => matches!(value, PropertyValue::Text(_)),
    }
}

/// `SyncRun`: one sync pass over a table.
struct SyncRun<'t> {
    draft: &'t mut Working,
    derived: Option<&'t mut Derived>,
    pending: IndexSet<Id>,
    done: FxHashSet<Id>,
    active: FxHashSet<Id>,
    /// Components being materialized: a data cycle stops here.
    stack: Vec<Id>,
    definitions: FxHashMap<Id, Rc<IndexMap<Atom, PropertyDefinition>>>,
    variants: FxHashMap<Id, Rc<Map<String>>>,
    /// Parents of the copies removed (as they were before).
    former_parents: SlotSet,
}

impl<'t> SyncRun<'t> {
    fn new(draft: &'t mut Working, derived: Option<&'t mut Derived>) -> Self {
        Self {
            draft,
            derived,
            pending: IndexSet::new(),
            done: FxHashSet::default(),
            active: FxHashSet::default(),
            stack: Vec::new(),
            definitions: FxHashMap::default(),
            variants: FxHashMap::default(),
            former_parents: SlotSet::new(),
        }
    }

    fn run(&mut self) {
        let pending: Vec<Id> = self.pending.iter().copied().collect();
        for id in pending {
            self.ensure(id);
        }
    }

    fn ensure(&mut self, id: Id) {
        if self.done.contains(&id) || self.active.contains(&id) {
            return;
        }
        if let Some(node) = self.draft.arc(id)
            && node.kind == NodeType::Instance
            && node.props.main_id().is_none()
        {
            let node = Arc::clone(node);
            self.active.insert(id);
            self.rebuild_root(node);
            self.active.remove(&id);
        }
        self.done.insert(id);
    }

    fn component(&self, id: Option<Id>) -> Option<Arc<Node>> {
        self.draft
            .arc(id?)
            .filter(|node| node.kind == NodeType::Component)
            .cloned()
    }

    fn defs(&mut self, component: &Node) -> Rc<IndexMap<Atom, PropertyDefinition>> {
        if let Some(defs) = self.definitions.get(&component.id) {
            return defs.clone();
        }
        let defs = Rc::new(definitions_in(self.draft, component));
        self.definitions.insert(component.id, defs.clone());
        defs
    }

    fn variant_of(&mut self, component: &Node) -> Rc<Map<String>> {
        if let Some(values) = self.variants.get(&component.id) {
            return values.clone();
        }
        let values = Rc::new(variant_values_in(self.draft, component));
        self.variants.insert(component.id, values.clone());
        values
    }

    /// `keeps` of `rebuild_root`: a size layout gave this instance stays until layout runs again, unless the instance
    /// now shows another component.
    fn keeps_layout_size(&self, instance: &Node, component: &Node) -> bool {
        match instance.children().first().copied() {
            None => true,
            Some(first) if self.draft.key(first).is_empty() => true,
            Some(first) => {
                let main = self
                    .draft
                    .node(first)
                    .and_then(|copy| copy.props.main_id().copied());
                self.draft
                    .node_opt(main)
                    .is_some_and(|main| main.parent == Some(component.id))
            }
        }
    }

    fn rebuild_root(&mut self, instance: Arc<Node>) {
        let Some(component) = self.component(instance.props.component_id().copied()) else {
            return;
        };
        if self.stack.contains(&component.id) {
            return;
        }
        let flow = is_auto_layout(self.draft.node_opt(instance.parent));
        let keeps = self.keeps_layout_size(&instance, &component);
        let set: Option<Arc<Node>> = component
            .parent
            .and_then(|parent| self.draft.arc(parent))
            .filter(|parent| parent.kind == NodeType::ComponentSet)
            .cloned();
        if self.derived.as_deref().is_some_and(|derived| {
            derived
                .roots
                .get(&instance.id)
                .is_some_and(|root| root.same(&component, &set, &instance, flow, keeps))
        }) {
            // The instance's own node is as its last rebuild left it (the same component, set, instance and parent
            // flow build the same node): only its children may need work. Its property values are the ones that
            // rebuild moved into it.
            let props: Props = instance
                .props
                .component_properties()
                .cloned()
                .unwrap_or_default();
            let mut state = RootState::default();
            self.stack.push(component.id);
            let children = self.build_children(
                &instance,
                Some(&instance),
                &component,
                instance.id,
                &props,
                None,
                "",
                &mut state,
            );
            self.stack.pop();
            if !same_ids(&children, instance.children.as_deref()) {
                let mut node = (*instance).clone();
                node.children = Some(children.into());
                self.draft.put(node);
                if let Some(derived) = self.derived.as_deref_mut() {
                    derived.roots.remove(&instance.id);
                }
            }
            self.remove_stale(state);
            return;
        }
        let mut state = RootState::default();
        let overrides = instance
            .props
            .overrides()
            .filter(|list| !list.is_empty())
            .map(|list| parse(self.draft, list));
        let mut node = from_component(self.draft, &component, &instance, sets().placement);
        node.id = instance.id;
        node.parent = instance.parent;
        if let Some(overrides) = &overrides {
            apply_overrides(self.draft, &mut node, &instance, overrides);
        }
        // FILL only means something in an auto-layout parent.
        if !flow {
            if node.layout_sizing_horizontal == LayoutSizing::Fill {
                node.layout_sizing_horizontal = LayoutSizing::Fixed;
            }
            if node.layout_sizing_vertical == LayoutSizing::Fill {
                node.layout_sizing_vertical = LayoutSizing::Fixed;
            }
        }
        if keeps {
            keep_layout_owned(&mut node, &instance, overrides.as_ref(), flow, true);
        }
        let (values, list) = self.properties(&component, None, Some(&instance), overrides.as_ref());
        if let Some(list) = list.filter(|list| !list.is_empty()) {
            let atoms: Vec<Atom> = list
                .iter()
                .map(|path| self.draft.intern_atom(path))
                .collect();
            node.props.set(Prop::Overrides(atoms.into()));
        }
        if let Some(text) = node.props.text()
            && let Some(sanitized) = sanitize_text(text)
        {
            node.props.set(Prop::Text(sanitized));
        }
        self.stack.push(component.id);
        let props: Props = Arc::new(values);
        let children = self.build_children(
            &node,
            Some(&instance),
            &component,
            instance.id,
            &props,
            None,
            "",
            &mut state,
        );
        node.children = Some(children.into());
        // The values the copies shared while they were built, moved into the instance.
        node.props.set(Prop::ComponentProperties(props));
        self.stack.pop();
        let written = self.write(Some(&instance), node);
        if let Some(derived) = self.derived.as_deref_mut() {
            if written {
                derived.roots.remove(&instance.id);
            } else {
                derived.roots.insert(
                    instance.id,
                    RootDerived {
                        component,
                        set,
                        instance,
                        flow,
                        keeps,
                    },
                );
            }
        }
        self.remove_stale(state);
    }

    /// `properties`: effective property values of an instance (or nested copy) of `component`, and its override list
    /// (as paths).
    fn properties(
        &mut self,
        component: &Node,
        inherited: Option<&IndexMap<Atom, PropertyValue>>,
        old: Option<&Node>,
        overrides: Option<&Parsed>,
    ) -> (IndexMap<Atom, PropertyValue>, Option<Vec<String>>) {
        let defs = self.defs(component);
        let empty = IndexMap::new();
        let own: &IndexMap<Atom, PropertyValue> = old
            .and_then(|old| old.props.component_properties())
            .map(|own| &**own)
            .unwrap_or(&empty);
        let overridden = overrides.and_then(|overrides| overrides.get("componentProperties"));
        let is_set = |draft: &Working, key: Atom| match overridden {
            Some(Parts::Whole) => true,
            Some(Parts::Keys(keys)) => {
                let key = draft.atom(key);
                keys.iter().any(|candidate| candidate == key)
            }
            None => false,
        };
        let mut values: IndexMap<Atom, PropertyValue> = IndexMap::with_capacity(defs.len());
        let mut variant: Option<Rc<Map<String>>> = None;
        for (key, def) in defs.iter() {
            if def.kind == ComponentPropertyType::Variant {
                let variant = match &variant {
                    Some(variant) => variant.clone(),
                    None => {
                        let values = self.variant_of(component);
                        variant = Some(values.clone());
                        values
                    }
                };
                let value = match variant.get(self.draft.atom(*key)) {
                    Some(value) => PropertyValue::Text(self.draft.intern_atom(value)),
                    None => def.default_value.clone(),
                };
                values.insert(*key, value);
            } else if let Some(value) = own
                .get(key)
                .filter(|value| is_set(self.draft, *key) && valid_property_value(def, value))
            {
                values.insert(*key, value.clone());
            } else if let Some(value) = inherited
                .and_then(|inherited| inherited.get(key))
                .filter(|value| valid_property_value(def, value))
            {
                values.insert(*key, value.clone());
            } else {
                values.insert(*key, def.default_value.clone());
            }
        }
        let mut list: Option<Vec<String>> = old.and_then(|old| old.props.overrides()).map(|list| {
            list.iter()
                .map(|atom| self.draft.atom(*atom).to_owned())
                .collect()
        });
        if let Some(Parts::Keys(overridden)) = overridden {
            for key in overridden {
                if self
                    .draft
                    .atom_of(key)
                    .and_then(|atom| defs.get(&atom))
                    .is_some_and(|def| def.kind != ComponentPropertyType::Variant)
                {
                    continue;
                }
                let entry = format!("componentProperties.{key}");
                let mut kept: Vec<String> = list
                    .take()
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|item| *item != entry)
                    .collect();
                let name = property_name(key);
                let found = defs.iter().find(|(candidate, def)| {
                    let candidate = self.draft.atom(**candidate);
                    def.kind != ComponentPropertyType::Variant
                        && property_name(candidate) == name
                        && !overridden.iter().any(|item| item == candidate)
                });
                if let Some((matched, def)) = found
                    && let Some(value) = self.draft.atom_of(key).and_then(|atom| own.get(&atom))
                    && valid_property_value(def, value)
                {
                    values.insert(*matched, value.clone());
                    kept.push(format!("componentProperties.{}", self.draft.atom(*matched)));
                }
                list = Some(kept);
            }
        }
        (values, list)
    }

    /// `buildChildren`: the copies of `source`'s children under `node`, reusing `old`'s.
    #[allow(clippy::too_many_arguments)]
    fn build_children(
        &mut self,
        node: &Node,
        old: Option<&Node>,
        source: &Node,
        prefix: Id,
        owner: &Props,
        transfer: Option<&Transfer>,
        path: &str,
        state: &mut RootState,
    ) -> Vec<Id> {
        let source_children: &[Id] = source.children();
        let old_children: &[Id] = old.map(Node::children).unwrap_or(&[]);
        let mut own_transfer: Option<Transfer> = None;
        let mut base_path = path;
        if !old_children.is_empty()
            && (node.kind == NodeType::Instance
                || old.is_some_and(|old| old.kind == NodeType::Instance))
            && !(!source_children.is_empty()
                && is_copy_id(self.draft, old_children[0], prefix, source_children[0]))
        {
            // A swap: every old copy is gone. Figma keeps the overrides of layers with the same name and place in
            // the hierarchy; index the old ones by that path.
            let expected: FxHashSet<Id> = source_children
                .iter()
                .map(|id| copy_id(self.draft, prefix, *id))
                .collect();
            if !old_children.iter().any(|id| expected.contains(id)) {
                own_transfer = Some(self.transfer_index(old_children));
                base_path = "";
            }
        }
        let next_transfer: Option<&Transfer> = own_transfer.as_ref().or(transfer);
        let placement = Placement {
            geometry: child_geometry(node, source),
            flow: is_auto_layout(Some(node)),
        };
        let mut counts: Option<FxHashMap<Atom, usize>> =
            next_transfer.map(|_| FxHashMap::default());
        let mut ids: Vec<Id> = Vec::with_capacity(source_children.len());
        let node_id = node.id;
        for (i, &source_id) in source_children.iter().enumerate() {
            let Some(mut child) = self.draft.arc(source_id).cloned() else {
                continue;
            };
            if child.kind == NodeType::Instance
                && child.props.main_id().is_none()
                && self.pending.contains(&source_id)
                && !self.done.contains(&source_id)
            {
                self.ensure(source_id);
                match self.draft.arc(source_id) {
                    Some(again) => child = Arc::clone(again),
                    None => continue,
                }
            }
            let mut child_path = String::new();
            if let Some(counts) = counts.as_mut() {
                let n = counts.entry(child.name).or_insert(0);
                *n += 1;
                child_path = format!("{base_path}/{}#{}", self.draft.atom(child.name), n);
            }
            let id = if i < old_children.len()
                && is_copy_id(self.draft, old_children[i], prefix, source_id)
            {
                old_children[i]
            } else {
                copy_id(self.draft, prefix, source_id)
            };
            let written = self.materialize(
                child,
                id,
                prefix,
                node_id,
                owner,
                &placement,
                next_transfer,
                &child_path,
                state,
            );
            ids.push(written);
        }
        if !old_children.is_empty() && !same_ids(&ids, Some(old_children)) {
            let kept: FxHashSet<Id> = ids.iter().copied().collect();
            for &id in old_children {
                if kept.contains(&id) {
                    continue;
                }
                // Only copies go when their main node does; a stray layer that is no copy stays on top.
                match self.draft.node(id) {
                    Some(stray) if stray.props.main_id().is_none() => ids.push(id),
                    _ => state.stale.push((id, node_id)),
                }
            }
        }
        ids
    }

    /// `transferIndex`: old copies by `/name#n` paths, depth first in layer order.
    fn transfer_index(&self, old_children: &[Id]) -> Transfer {
        fn visit(draft: &Working, ids: &[Id], path: &str, index: &mut Transfer) {
            let mut counts: FxHashMap<Atom, usize> = FxHashMap::default();
            for &id in ids {
                let Some(node) = draft.arc(id) else { continue };
                let name = draft
                    .node_opt(node.props.main_id().copied())
                    .map(|main| main.name)
                    .unwrap_or(node.name);
                let n = counts.entry(name).or_insert(0);
                *n += 1;
                let key = format!("{path}/{}#{}", draft.atom(name), n);
                let children = node.children.clone();
                index.insert(key.clone(), Arc::clone(node));
                if let Some(children) = children {
                    visit(draft, &children, &key, index);
                }
            }
        }
        let mut index: Transfer = FxHashMap::default();
        visit(self.draft, old_children, "", &mut index);
        index
    }

    /// `materialize`: the copy of `source` under `parent_id`. Returns its id.
    #[allow(clippy::too_many_arguments)]
    fn materialize(
        &mut self,
        source: Arc<Node>,
        id: Id,
        prefix: Id,
        parent_id: Id,
        owner: &Props,
        placement: &Placement,
        transfer: Option<&Transfer>,
        path: &str,
        state: &mut RootState,
    ) -> Id {
        let mut old: Option<Arc<Node>> = self.draft.arc(id).cloned();
        let mut seeded = false;
        if old.is_none()
            && let Some(transfer) = transfer
            && let Some(found) = transfer.get(path)
            && found.kind == source.kind
        {
            old = Some(Arc::clone(found));
            seeded = true;
        }
        // Nothing this copy depends on changed since it was derived (or, without overrides, it already equals its
        // source): only its descendants may need work.
        let simple = placement.geometry.is_none()
            && transfer.is_none()
            && source.kind != NodeType::Instance
            && source.props.component_property_references().is_none();
        if simple
            && let Some(current) = &old
            && !seeded
            && current.parent == Some(parent_id)
        {
            let known = self
                .derived
                .as_deref()
                .is_some_and(|derived| derived.hit(placement.flow, id, &source, current));
            if known || (current.props.overrides().is_none() && mirrors_source(current, &source)) {
                // Known up to date: the cache already holds this pair (nothing to rewrite).
                if !known && let Some(derived) = self.derived.as_deref_mut() {
                    derived.set(placement.flow, id, &source, current);
                }
                let current = Arc::clone(current);
                return self.descend_unchanged(&current, &source, prefix, owner, path, state, id);
            }
        }
        self.materialize_anew(
            source, id, old, seeded, prefix, parent_id, owner, placement, transfer, path, state,
        )
    }

    /// A copy found up to date: only its descendants may need work (its children are rebuilt, and the copy rewritten
    /// if their ids changed).
    #[allow(clippy::too_many_arguments)]
    fn descend_unchanged(
        &mut self,
        current: &Arc<Node>,
        source: &Arc<Node>,
        prefix: Id,
        owner: &Props,
        path: &str,
        state: &mut RootState,
        id: Id,
    ) -> Id {
        if source.children.is_some() {
            let children = self.build_children(
                current,
                Some(current),
                source,
                prefix,
                owner,
                None,
                path,
                state,
            );
            if !same_ids(&children, current.children.as_deref()) {
                let mut next = (**current).clone();
                next.children = Some(children.into());
                self.draft.put(next);
            }
        }
        id
    }

    /// `materialize` past the identity cache: the copy built anew from its source.
    #[allow(clippy::too_many_arguments)]
    fn materialize_anew(
        &mut self,
        source: Arc<Node>,
        id: Id,
        old: Option<Arc<Node>>,
        seeded: bool,
        prefix: Id,
        parent_id: Id,
        owner: &Props,
        placement: &Placement,
        transfer: Option<&Transfer>,
        path: &str,
        state: &mut RootState,
    ) -> Id {
        let overrides = old
            .as_ref()
            .and_then(|old| old.props.overrides())
            .filter(|list| !list.is_empty())
            .map(|list| parse(self.draft, list));

        let mut node: Node;
        let mut child_source: Option<Arc<Node>> = None;
        let mut child_prefix: Id = prefix;
        let mut props_component: Option<Arc<Node>> = None;
        let mut inherited: Option<Arc<IndexMap<Atom, PropertyValue>>> = None;
        let mut pushed = false;
        if source.kind == NodeType::Instance {
            let mut component_id = source.props.component_id().copied();
            if let Some(reference) = source
                .props
                .component_property_references()
                .and_then(|refs| refs.main_component)
                && let Some(PropertyValue::Text(value)) = owner.get(&reference)
                && let Some(value_id) = self.draft.id(self.draft.atom(*value))
                && self.component(Some(value_id)).is_some()
            {
                component_id = Some(value_id);
            }
            if has(overrides.as_ref(), "componentId")
                && let Some(old) = &old
                && self.component(old.props.component_id().copied()).is_some()
            {
                component_id = old.props.component_id().copied();
            }
            let swap_to = if component_id != source.props.component_id().copied() {
                self.component(component_id)
            } else {
                None
            };
            match swap_to {
                Some(swap_to) if !self.stack.contains(&swap_to.id) => {
                    node = from_component(self.draft, &swap_to, &source, sets().swap_placement);
                    child_prefix = id;
                    self.stack.push(swap_to.id);
                    child_source = Some(Arc::clone(&swap_to));
                    props_component = Some(swap_to);
                    pushed = true;
                }
                _ => {
                    node = (*source).clone();
                    child_source = Some(Arc::clone(&source));
                    props_component = self.component(source.props.component_id().copied());
                    inherited = source.props.component_properties().cloned();
                }
            }
        } else {
            node = (*source).clone();
            if source.children.is_some() {
                child_source = Some(Arc::clone(&source));
            }
        }
        node.id = id;
        node.parent = Some(parent_id);
        node.props.set(Prop::MainId(source.id));
        node.props.remove(PropKey::Overrides);
        if let (Some(overrides), Some(old)) = (&overrides, &old) {
            apply_overrides(self.draft, &mut node, old, overrides);
        }

        let refs = source.props.component_property_references();
        if let Some(reference) = refs.and_then(|refs| refs.visible)
            && !has(overrides.as_ref(), "visible")
            && let Some(PropertyValue::Boolean(value)) = owner.get(&reference)
        {
            node.visible = *value;
        }
        if let Some(text) = node.props.text() {
            let mut next: Option<Arc<TextProps>> = None;
            if let Some(reference) = refs.and_then(|refs| refs.characters)
                && !is_part_overridden(overrides.as_ref(), "text", "characters")
                && let Some(PropertyValue::Text(value)) = owner.get(&reference)
            {
                let value = self.draft.atom(*value);
                if value != &*text.characters {
                    let mut changed = Arc::clone(text);
                    with_characters(Arc::make_mut(&mut changed), value);
                    next = Some(changed);
                }
            }
            if let Some(sanitized) = sanitize_text(next.as_ref().unwrap_or(text)) {
                next = Some(sanitized);
            }
            if let Some(next) = next {
                node.props.set(Prop::Text(next));
            }
        }
        // Geometry: the main's, following the parent's resize by constraints (children in a flow wait for layout),
        // then what layout and measuring own is kept from the copy as last laid out.
        let in_flow = placement.flow && node.layout_positioning != LayoutPositioning::Absolute;
        if let Some(geometry) = &placement.geometry
            && !in_flow
        {
            apply_geometry(&mut node, overrides.as_ref(), geometry);
        }
        if let Some(old) = &old
            && !seeded
            && old.props.main_id() == Some(&source.id)
            && (node.kind != NodeType::Instance
                || old.props.component_id() == node.props.component_id())
        {
            keep_layout_owned(&mut node, old, overrides.as_ref(), placement.flow, false);
        }
        if node.kind == NodeType::Vector
            && !has(overrides.as_ref(), "vectorPaths")
            && (node.width != source.width || node.height != source.height)
            && source.width > 0.0
            && source.height > 0.0
            && let Some(paths) = node.props.vector_paths()
        {
            let scaled = scale_paths(
                paths,
                node.width / source.width,
                node.height / source.height,
            );
            node.props.set(Prop::VectorPaths(scaled.into()));
        }
        // A text on a path follows its copy's size the same way.
        if !has(overrides.as_ref(), "textPath")
            && (node.width != source.width || node.height != source.height)
            && source.width > 0.0
            && source.height > 0.0
            && let Some(text_path) = node.props.text_path()
        {
            let scaled = scale_text_path(
                text_path,
                node.width / source.width,
                node.height / source.height,
            );
            node.props.set(Prop::TextPath(Arc::new(scaled)));
        }

        let mut list: Option<Vec<String>> =
            old.as_ref()
                .and_then(|old| old.props.overrides())
                .map(|list| {
                    list.iter()
                        .map(|atom| self.draft.atom(*atom).to_owned())
                        .collect()
                });
        let mut child_owner = owner.clone();
        // An instance's own property values: shared with its copies while they are built, then moved into it.
        let mut own_values = false;
        if node.kind == NodeType::Instance
            && let Some(props_component) = &props_component
        {
            let (values, overrides_list) = self.properties(
                props_component,
                inherited.as_deref(),
                old.as_deref(),
                overrides.as_ref(),
            );
            list = overrides_list;
            child_owner = Arc::new(values);
            own_values = true;
        }
        if let Some(list) = list.filter(|list| !list.is_empty()) {
            let atoms: Vec<Atom> = list
                .iter()
                .map(|path| self.draft.intern_atom(path))
                .collect();
            node.props.set(Prop::Overrides(atoms.into()));
        }

        if let Some(child_source) = &child_source {
            let previous = if seeded { None } else { old.as_deref() };
            let children = self.build_children(
                &node,
                previous,
                child_source,
                child_prefix,
                &child_owner,
                transfer,
                path,
                state,
            );
            node.children = Some(children.into());
        } else if node.kind == NodeType::Instance {
            // Its main is gone or would recurse: keep what it shows.
            node.children = Some(if seeded {
                Vec::new().into()
            } else {
                old.as_ref()
                    .and_then(|old| old.children.clone())
                    .unwrap_or_else(|| Vec::new().into())
            });
        }
        if pushed {
            self.stack.pop();
        }
        if own_values {
            node.props.set(Prop::ComponentProperties(child_owner));
        }
        self.write(if seeded { None } else { old.as_deref() }, node);
        id
    }

    /// Stores the derived node unless it equals the existing one (`sameNode`). Whether it was stored.
    fn write(&mut self, old: Option<&Node>, node: Node) -> bool {
        if old.is_some_and(|old| Field::all_same_except(old, &node, FieldSet::empty())) {
            return false;
        }
        self.draft.put(node);
        true
    }

    fn remove_stale(&mut self, state: RootState) {
        let mut stack = state.stale;
        while let Some((id, parent_id)) = stack.pop() {
            let Some(node) = self.draft.node(id) else {
                continue;
            };
            // A node the rebuild placed under another parent was rewritten with that parent: it stays.
            if node.parent != Some(parent_id) {
                continue;
            }
            for child in node.children() {
                stack.push((*child, id));
            }
            if let Some(parent) = node.parent {
                self.former_parents.insert(parent);
            }
            self.draft.delete(id);
        }
    }
}

/// `refreshVariantDefinitionsIn`: rewrites a set's VARIANT definitions from its variants' names.
pub fn refresh_variant_definitions_in(draft: &mut Working, set_id: Id) -> bool {
    let Some(set) = draft.node(set_id) else {
        return false;
    };
    if set.kind != NodeType::ComponentSet {
        return false;
    }
    let Some(next) = variant_definitions_from_names(draft, set_id) else {
        return false;
    };
    let mut set = draft.node(set_id).expect("still there").clone();
    set.props
        .set(Prop::ComponentPropertyDefinitions(Arc::new(next)));
    draft.put(set);
    true
}

/// What `syncDraft` reports: the ids it put or deleted (`changed`, in the order first touched) and the former parents
/// of removed copies.
#[derive(Debug, Default)]
pub struct Synced {
    pub changed: SlotSet,
    pub former_parents: SlotSet,
}

/// `syncDraft`: widens `dirty` to the instances that must be rebuilt and rebuilds them in the draft. `index`: the
/// instance index of the table as it stands (built here when absent and needed); `derived`: the identity cache kept
/// between calls, if any.
pub fn sync_draft(
    draft: &mut Working,
    dirty: &SlotSet,
    index: Option<&InstanceIndex>,
    derived: Option<&mut Derived>,
) -> Synced {
    if dirty.is_empty() {
        return Synced::default();
    }
    let mut former_parents = SlotSet::new();
    let changed = draft.collect(|draft| {
        let mut set_ids = IndexSet::<Id>::new();
        for id in dirty {
            let Some(node) = draft.node(id) else { continue };
            if node.kind == NodeType::ComponentSet {
                set_ids.insert(id);
            } else if node.kind == NodeType::Component
                && let Some(parent) = node.parent
                && draft
                    .node(parent)
                    .is_some_and(|parent| parent.kind == NodeType::ComponentSet)
            {
                set_ids.insert(parent);
            }
        }
        for set_id in &set_ids {
            refresh_variant_definitions_in(draft, *set_id);
        }

        let mut run = SyncRun::new(draft, derived);
        let mut affected: FxHashSet<Id> = FxHashSet::default();
        let mut queue: Vec<Id> = Vec::new();
        fn mark_component(id: Option<Id>, affected: &mut FxHashSet<Id>, queue: &mut Vec<Id>) {
            if let Some(id) = id
                && affected.insert(id)
            {
                queue.push(id);
            }
        }
        fn mark_instance(
            run: &mut SyncRun<'_>,
            id: Id,
            affected: &mut FxHashSet<Id>,
            queue: &mut Vec<Id>,
        ) {
            let Some(root) = root_instance_in(run.draft, id) else {
                return;
            };
            if run.pending.contains(&root) {
                return;
            }
            run.pending.insert(root);
            let component = nearest_component_in(run.draft, Some(root));
            mark_component(component, affected, queue);
        }
        for id in dirty {
            let Some(node) = run.draft.arc(id).cloned() else {
                continue;
            };
            if node.kind == NodeType::ComponentSet {
                for child in node.children() {
                    if run
                        .draft
                        .node(*child)
                        .is_some_and(|child| child.kind == NodeType::Component)
                    {
                        mark_component(Some(*child), &mut affected, &mut queue);
                    }
                }
                continue;
            }
            if node.kind == NodeType::Instance || node.props.main_id().is_some() {
                mark_instance(&mut run, id, &mut affected, &mut queue);
            }
            let component = nearest_component_in(run.draft, Some(id));
            mark_component(component, &mut affected, &mut queue);
        }
        if !affected.is_empty() {
            let built;
            let index = match index {
                Some(index) => index,
                None => {
                    built = InstanceIndex::build(run.draft);
                    &built
                }
            };
            while let Some(component_id) = queue.pop() {
                if let Some(instances) = index.by_component.get(&component_id) {
                    for instance in instances {
                        mark_instance(&mut run, *instance, &mut affected, &mut queue);
                    }
                }
            }
        }
        run.run();
        former_parents = std::mem::take(&mut run.former_parents);
    });
    Synced {
        changed,
        former_parents,
    }
}

/// `exposedInstancesOf`: exposed nested instances inside an instance, top layer first, through nested instances too.
pub fn exposed_instances_of(draft: &Working, instance_id: Id) -> Vec<Id> {
    fn visit(draft: &Working, id: Id, depth: usize, out: &mut Vec<Id>) {
        let Some(node) = draft.node(id) else { return };
        if node.children.is_none() || depth > 64 {
            return;
        }
        for child_id in node.children().iter().rev() {
            let Some(child) = draft.node(*child_id) else {
                continue;
            };
            if child.kind == NodeType::Instance
                && child.props.is_exposed_instance() == Some(&true)
                && child.props.main_id().is_some()
            {
                out.push(child.id);
            }
            visit(draft, child.id, depth + 1, out);
        }
    }
    let mut out = Vec::new();
    if draft
        .node(instance_id)
        .is_some_and(|node| node.kind == NodeType::Instance)
    {
        visit(draft, instance_id, 0, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copy_ids() {
        let model: morfa_model::DesignDocument = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1, "pages": [], "nodes": {}, "styles": {}, "images": {}, "variableCollections": {}, "variables": {}
        }))
        .unwrap();
        let store = Arc::new(morfa_model::store::Document::from_model(&model));
        let mut draft = Working::new(store);
        let (i, m, im, imm) = (
            draft.intern_id("i"),
            draft.intern_id("m"),
            draft.intern_id("i;m"),
            draft.intern_id("i;mm"),
        );
        assert!(is_copy_id(&draft, im, i, m));
        assert!(!is_copy_id(&draft, imm, i, m));
        assert_eq!(copy_id(&mut draft, i, m), im);
    }
}
