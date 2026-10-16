//! Normalize entry points on the shadow document (on the store's own nodes). `normalize`: normalize.ts
//! `normalizeDetailed` with the transaction's patch laid over the shadow, answering the changed fields of every written
//! node. `normalize_stage`: one stage of `normalizeDocument` run alone (or the whole orchestrator), for the stage
//! oracle (`tests/helpers/stage-diff.ts`); the stages and their order are `crates/layout/src/normalize.rs`.
//! `normalize_layout_frame` … `normalize_group_fit`: the standalone entries,
//! called by shared/design/layout-wasm.ts through `withEngine('normalize', …)`. Text is measured with the fixed-width
//! fake both sides use (`Ctx::default()`); the TypeScript sends a measuring call here only with that measurer.
//!
//! Every entry takes ids and numbers (a JSON array for a list of ids), reads the document from the shadow and hands
//! back only what its working copy wrote. A [`Working`] reads the shadow's nodes by slot and writes fields; nothing is
//! converted to the JSON model on the way in, and on the way out only a new node crosses whole (crates/wasm/src/delta.rs
//! for the rest). The final working copy becomes a journal `Entry` the commit replays (`apply_patch_with`): no JSON
//! back, no conversion.

use std::rc::Rc;

use morfa_layout::instances::sync::InstanceIndex;
use morfa_layout::instances::variables::{
    VariableUsage, aliases_of, aliases_of_model, same_bindings,
};
use morfa_layout::normalize::{Indexes, Pipeline};
use morfa_model::store::draft::Working;
use morfa_model::store::fields::{Field, changed_mask};
use morfa_model::store::{Document, Entry, Id, Node, PropKey, Symbol};
use morfa_model::{Ctx, DocumentPatch, NodeType};
use wasm_bindgen::prelude::*;

use crate::delta::{
    Planned, SHARED, heavy_ptr, push_box, push_json, write_box_delta, write_planned,
};
use crate::doc::MorfaDoc;

/// Maps and sets of symbols and addresses, hashed as the drafts hash ids (`IdHasher`: FxHash in the editor's build).
type FxHashMap<K, V> = std::collections::HashMap<K, V, morfa_model::draft::IdHasher>;
type FxHashSet<T> = std::collections::HashSet<T, morfa_model::draft::IdHasher>;

/// The instance index and the variable usage of the shadow by symbol, kept between calls as TypeScript keeps them per
/// node table (table-cache.ts `DeriveIndex`): a change keeps the index while no entry it changes shows another
/// component, the usage while every entry it changes binds the same variables; otherwise the next call that needs one
/// builds it again. Built in the store's slot order, the order a working copy walks its table in.
#[derive(Default)]
pub(crate) struct Kept {
    instances: Option<InstanceIndex>,
    usage: Option<VariableUsage>,
}

/// `shownComponent` of a stored node.
fn shown_component(doc: &Document, node: Option<&Node>) -> Option<Id> {
    node.filter(|node| node.kind == NodeType::Instance)
        .and_then(|node| node.props.component_id().copied())
        .filter(|id| doc.ids().try_resolve(*id).is_none_or(|key| !key.is_empty()))
}

impl Kept {
    /// Before a JSON patch is applied to `doc`: drops what it leaves invalid.
    pub(crate) fn before_patch(&mut self, doc: &Document, patch: &DocumentPatch) {
        for (key, after) in patch.nodes.iter().flatten() {
            if self.instances.is_none() && self.usage.is_none() {
                return;
            }
            let stored = doc.node_by_key(key);
            if self.instances.is_some() {
                let before = shown_component(doc, stored).map(|id| doc.key(id));
                let after_component = after
                    .as_ref()
                    .filter(|node| node.kind == NodeType::Instance)
                    .and_then(|node| node.component_id.as_deref())
                    .filter(|id| !id.is_empty());
                if before != after_component {
                    self.instances = None;
                }
            }
            if self.usage.is_some() {
                let mut before: Vec<&str> = Vec::new();
                if let Some(stored) = stored {
                    aliases_of(stored, &mut |atom| before.push(doc.atom(atom)));
                }
                let mut after_aliases: Vec<String> = Vec::new();
                if let Some(after) = after {
                    aliases_of_model(after, &mut |id| after_aliases.push(id.to_owned()));
                }
                if before.len() != after_aliases.len()
                    || before.iter().zip(&after_aliases).any(|(a, b)| *a != b)
                {
                    self.usage = None;
                }
            }
        }
    }

    /// Before a journal entry is replayed on `doc`.
    pub(crate) fn before_entry(&mut self, doc: &Document, entry: &Entry) {
        for (id, after) in &entry.nodes {
            if self.instances.is_none() && self.usage.is_none() {
                return;
            }
            let stored = doc.node(*id);
            let after = after.as_deref();
            if self.instances.is_some()
                && shown_component(doc, stored) != shown_component(doc, after)
            {
                self.instances = None;
            }
            if self.usage.is_some() && !same_bindings(stored, after) {
                self.usage = None;
            }
        }
    }
}

/// `buildInstanceIndex` over the shadow itself, in slot order.
fn scan_store(doc: &Document) -> InstanceIndex {
    let mut index = InstanceIndex::default();
    for node in doc.nodes() {
        if let Some(component) = shown_component(doc, Some(node)) {
            index.count += 1;
            index
                .by_component
                .entry(component)
                .or_default()
                .push(node.id);
        }
    }
    index
}

/// What one normalize call reads the kept indexes through: the shadow, its kept indexes, and indexes built for this
/// call only (an entry shows another component now).
struct ShadowIndexes<'a> {
    doc: &'a Document,
    kept: &'a mut Kept,
    instances: Option<InstanceIndex>,
}

/// Every id where the working copy can differ from the shadow in more than its box: the call's patch and the copy's
/// own writes (a box-only write changes neither the component a node shows nor its bindings).
fn changed(draft: &Working) -> Vec<Id> {
    draft
        .over_ids()
        .chain(draft.written().filter(|id| !draft.box_only(*id)))
        .collect()
}

impl Indexes for ShadowIndexes<'_> {
    fn instances(&mut self, draft: &Working) -> Option<&InstanceIndex> {
        let doc = self.doc;
        let changed = changed(draft);
        if changed
            .iter()
            .all(|&id| shown_component(doc, doc.node(id)) == shown_component(doc, draft.node(id)))
        {
            return Some(self.kept.instances.get_or_insert_with(|| scan_store(doc)));
        }
        // An entry shows another component now (an instance made, removed or swapped): scanned for this call.
        let changed: FxHashSet<Id> = changed.into_iter().collect();
        let mut index = InstanceIndex::default();
        draft.for_each_id(|id| {
            let node = if changed.contains(&id) {
                draft.node(id)
            } else {
                doc.node(id)
            };
            if let Some(component) = shown_component(doc, node) {
                index.count += 1;
                index.by_component.entry(component).or_default().push(id);
            }
        });
        self.instances = Some(index);
        self.instances.as_ref()
    }

    fn usage(&mut self, draft: &Working) -> Option<&VariableUsage> {
        let doc = self.doc;
        let valid = changed(draft)
            .iter()
            .all(|&id| same_bindings(doc.node(id), draft.node(id)));
        // Changed bindings: the step scans the working copy itself (rare: an edit that binds or unbinds a variable).
        if !valid {
            return None;
        }
        Some(self.kept.usage.get_or_insert_with(|| {
            let mut usage = VariableUsage::default();
            for node in doc.nodes() {
                usage.add(node.id, node);
            }
            usage
        }))
    }
}

/// The normalize pipeline of a shadow and the context its stages measure with, both kept between calls so the text
/// layouts the stages cache stay valid: one for the fixed-width fake (the shadow's life), one for the editor's own
/// measurer reached through JavaScript (`Measured`, kept while the same measurer at the same revision asks).
#[derive(Default)]
pub(crate) struct Steps {
    pub(crate) pipeline: Pipeline,
    pub(crate) ctx: Ctx,
    measured: std::cell::RefCell<Option<Measured>>,
    /// The box changes of the last `normalize`, for `normalized_numbers(0)`.
    pub(crate) boxes: std::cell::RefCell<Vec<f64>>,
    /// The shared values of the last `normalize`, for `normalized_numbers(1)`.
    pub(crate) shares: std::cell::RefCell<Vec<f64>>,
}

/// The pipeline of a measurer that lives in JavaScript (the editor's canvas `measureText`, a font-loading test fake):
/// text widths and metrics are asked of it, through one function, only where the stages' caches miss.
struct Measured {
    id: u32,
    revision: f64,
    pipeline: Pipeline,
    ctx: Ctx,
    failed: Rc<std::cell::Cell<bool>>,
}

/// shared/design/normalize.ts's measurer function: `(text, font) => width`, or `(null, font) => [ascent, descent]`, the
/// font as `family \0 weight \0 italic(0/1) \0 size`.
pub(crate) struct JsMeasurer {
    pub(crate) measure: js_sys::Function,
    pub(crate) failed: Rc<std::cell::Cell<bool>>,
}

fn font_key(font: &morfa_model::draft::FontSpec<'_>) -> String {
    format!(
        "{}\u{0}{}\u{0}{}\u{0}{}",
        font.family,
        font.weight,
        u8::from(font.italic),
        font.size
    )
}

impl morfa_model::draft::TextMeasurer for JsMeasurer {
    fn width(&self, text: &str, font: &morfa_model::draft::FontSpec<'_>) -> f64 {
        match self.measure.call2(
            &JsValue::NULL,
            &JsValue::from_str(text),
            &JsValue::from_str(&font_key(font)),
        ) {
            Ok(value) => value.as_f64().unwrap_or_else(|| {
                self.failed.set(true);
                0.0
            }),
            Err(_) => {
                self.failed.set(true);
                0.0
            }
        }
    }

    fn metrics(&self, font: &morfa_model::draft::FontSpec<'_>) -> morfa_model::draft::FontMetrics {
        let answer = self.measure.call2(
            &JsValue::NULL,
            &JsValue::NULL,
            &JsValue::from_str(&font_key(font)),
        );
        let pair = answer.ok().map(|value| js_sys::Array::from(&value));
        match pair
            .as_ref()
            .map(|pair| (pair.get(0).as_f64(), pair.get(1).as_f64()))
        {
            Some((Some(ascent), Some(descent))) => {
                morfa_model::draft::FontMetrics { ascent, descent }
            }
            _ => {
                self.failed.set(true);
                morfa_model::draft::FontMetrics {
                    ascent: 0.0,
                    descent: 0.0,
                }
            }
        }
    }
}

/// `{id: {collection: mode}, …}` of the variable modes a working copy wrote (`null`: removed).
fn mode_entries(out: &mut String, working: &Working) {
    out.push('{');
    for (index, (id, modes)) in working.mode_changes().enumerate() {
        if index > 0 {
            out.push(',');
        }
        push_json(out, working.key(id));
        out.push(':');
        match modes {
            Some(modes) => {
                out.push('{');
                for (at, (collection, mode)) in modes.iter().enumerate() {
                    if at > 0 {
                        out.push(',');
                    }
                    push_json(out, working.atom(*collection));
                    out.push(':');
                    push_json(out, working.atom(*mode));
                }
                out.push('}');
            }
            None => out.push_str("null"),
        }
    }
    out.push('}');
}

#[wasm_bindgen]
impl MorfaDoc {
    /// Runs the stage `name` on a working copy of the shadow document with `dirty` (a JSON array of node ids) and
    /// returns `{"reported": [ids the stage returned], "written": [ids it wrote or removed, in order], "nodes": {id: node
    /// or null}, "modes": {id: variable modes or null}}` as JSON. `name` `normalize` runs the whole orchestrator
    /// (`reported` is then every id written). The shadow itself is not changed. Errors for a name no stage has.
    pub fn normalize_stage(&self, name: &str, dirty: &str) -> Result<String, JsError> {
        let fail = |error: String| JsError::new(&format!("MorfaDoc.normalize_stage: {error}"));
        let ids: Vec<String> =
            serde_json::from_str(dirty).map_err(|error| fail(format!("dirty: {error}")))?;
        let mut working = Working::new(self.shared());
        let dirty = working.slot_set(ids);
        let ctx = Ctx::default();
        let reported = if name == "normalize" {
            morfa_layout::normalize::normalize(&mut working, &dirty, &ctx)
        } else {
            morfa_layout::normalize::run_stage_with(name, &mut working, &dirty, &ctx, None)
                .map_err(fail)?
        };
        let keys = |ids: &[Id]| -> Vec<&str> { ids.iter().map(|&id| working.key(id)).collect() };
        let mut out = String::from("{\"reported\":");
        push_json(&mut out, &keys(reported.as_slice()));
        let written: Vec<Id> = working.written().collect();
        out.push_str(",\"written\":");
        push_json(&mut out, &keys(&written));
        out.push_str(",\"nodes\":{");
        for (index, (id, node)) in working.changes().enumerate() {
            if index > 0 {
                out.push(',');
            }
            push_json(&mut out, working.key(id));
            out.push(':');
            match node {
                Some(node) => push_json(&mut out, &working.model_of(node)),
                None => out.push_str("null"),
            }
        }
        out.push_str("},\"modes\":");
        mode_entries(&mut out, &working);
        out.push('}');
        Ok(out)
    }

    /// normalize.ts `normalizeDetailed` in Rust (crates/layout/src/normalize.rs, every stage in the TypeScript's order)
    /// on the shadow document with `patch` laid over it first: a `DocumentPatch` (JSON) taking the shadow to the
    /// document being normalized (a transaction's writes since its base, which the shadow holds), applied to the working
    /// copy only, never to the shadow; `fields` (empty for none) adds nodes the shadow holds that changed in a few
    /// fields only, as `{id: {key: value}}` (morfa-model `node_fields_from_json`: no whole node to read for a drag
    /// frame's width or a keystroke's text). `dirty` is a JSON array of node ids. Returns `{"written": [ids written or
    /// removed, in order], "from": [the patch's ids], "nodes": {id: entry}, "numbers": [box numbers, share numbers],
    /// "modes": {id: variable modes or null}}`, an entry `null` (removed), `{"node": …}` (added) or `{"set": {…},
    /// "unset": […], "same"?: {key: id}}` (the fields that changed, a heavy value equal to one the entry of `id` sent
    /// crossing as that id: crates/wasm/src/delta.rs); a written node that changed its box alone has no entry there but
    /// five numbers in `normalized_numbers(0)`. Costs what the stages read and the patch, not the file. `keep`: hold
    /// the result for the commit's `apply_patch_with`.
    ///
    /// `measure` (with `measurer`, the TypeScript measurer's id, and its `revision`): text is measured by that
    /// JavaScript function (shared/design/normalize.ts) instead of the fixed-width fake; the text layouts kept for it
    /// start over when another measurer or another revision asks.
    #[allow(clippy::too_many_arguments)] // JavaScript calls it with positional arguments (normalize.ts).
    pub fn normalize(
        &self,
        patch: &str,
        fields: &str,
        dirty: &str,
        keep: bool,
        measure: Option<js_sys::Function>,
        measurer: u32,
        revision: f64,
    ) -> Result<String, JsError> {
        let fail = |error: String| JsError::new(&format!("MorfaDoc.normalize: {error}"));
        let patch =
            morfa_model::patch_from_json(patch).map_err(|error| fail(format!("patch: {error}")))?;
        let dirty: Vec<String> =
            serde_json::from_str(dirty).map_err(|error| fail(format!("dirty: {error}")))?;
        *self.pending().borrow_mut() = None;
        let slots = std::mem::take(&mut *self.slots().borrow_mut());
        let mut working = Working::with_slots(self.shared(), slots);
        working.lay_over(&patch);
        if !fields.is_empty() {
            // Nodes the transaction changed in a few fields only: the shadow's node with those set.
            let entries = morfa_model::json::node_fields_from_json(fields)
                .map_err(|error| fail(format!("patch: {error}")))?;
            for (id, fields) in entries {
                working
                    .lay_over_fields(&id, fields)
                    .map_err(|error| fail(format!("patch: {error}")))?;
            }
        }
        let dirty = working.slot_set(dirty);
        let mut kept = self.kept().borrow_mut();
        // A panic with the indexes borrowed, as a real one inside the stages would leave them (the switch's crash test).
        if crate::fault::is_on("normalize.panic") {
            panic!("debug_fault normalize.panic");
        }
        let mut indexes = ShadowIndexes {
            doc: self.document(),
            kept: &mut kept,
            instances: None,
        };
        let steps = self.steps();
        match measure {
            None => {
                steps
                    .pipeline
                    .run(&mut working, &dirty, &steps.ctx, Some(&mut indexes));
            }
            Some(measure) => {
                let mut held = steps.measured.borrow_mut();
                if !held
                    .as_ref()
                    .is_some_and(|m| m.id == measurer && m.revision.to_bits() == revision.to_bits())
                {
                    let failed = Rc::new(std::cell::Cell::new(false));
                    *held = Some(Measured {
                        id: measurer,
                        revision,
                        pipeline: Pipeline::new(),
                        ctx: Ctx {
                            measurer: Box::new(JsMeasurer {
                                measure,
                                failed: Rc::clone(&failed),
                            }),
                        },
                        failed,
                    });
                }
                let held = held.as_ref().expect("set above");
                held.failed.set(false);
                held.pipeline
                    .run(&mut working, &dirty, &held.ctx, Some(&mut indexes));
                if held.failed.get() {
                    // Widths of a failed call may be cached: start over next time.
                    held.pipeline.forget_text();
                    *self.slots().borrow_mut() = working.into_slots();
                    return Err(fail("the measurer did not answer".to_owned()));
                }
            }
        }
        drop(kept);

        let written: Vec<Id> = working.written().collect();
        let over: Vec<Id> = working.over_ids().collect();
        let keys = |ids: &[Id]| -> Vec<&str> { ids.iter().map(|&id| working.key(id)).collect() };
        let mut out = String::from("{\"written\":");
        push_json(&mut out, &keys(&written));
        // The patch's nodes can be senders too (JavaScript holds them: a main's text the transaction set is the text
        // of its copies), at places after `written`, in `from`'s order.
        out.push_str(",\"from\":");
        push_json(&mut out, &keys(&over));
        out.push_str(",\"nodes\":{");
        let mut boxes = steps.boxes.borrow_mut();
        boxes.clear();
        let mut shares = steps.shares.borrow_mut();
        shares.clear();
        // The heavy values JavaScript holds or this output sent, by address: (the sender, its place).
        let mut senders: [FxHashMap<usize, (Id, usize)>; 4] = Default::default();
        for (at, &id) in over.iter().enumerate() {
            // JavaScript holds the patch's entry; written since, it merges the written fields into that object, so
            // only the heavy values the write left alone (still the same shared value) can be taken from it.
            let (Some(held), Some(node)) = (working.base_node(id), working.node(id)) else {
                continue;
            };
            for (k, (field, _)) in SHARED.iter().enumerate() {
                if let Some(ptr) = heavy_ptr(held, *field)
                    && heavy_ptr(node, *field) == Some(ptr)
                {
                    senders[k].entry(ptr).or_insert((id, written.len() + at));
                }
            }
        }
        let mut first = true;
        for (index, (id, node)) in working.changes().enumerate() {
            let Some(node) = node else {
                if !first {
                    out.push(',');
                }
                first = false;
                push_json(&mut out, working.key(id));
                out.push_str(":null");
                continue;
            };
            if working.box_only(id)
                && let Some(base) = working.base_box(id)
            {
                if push_box(&mut boxes, index, node, base) {
                    continue;
                }
                if !first {
                    out.push(',');
                }
                first = false;
                push_json(&mut out, working.key(id));
                out.push(':');
                write_box_delta(&mut out, node, base);
                continue;
            }
            let Some(base) = working.base_node(id) else {
                // A new node, whole.
                if !first {
                    out.push(',');
                }
                first = false;
                push_json(&mut out, working.key(id));
                out.push_str(":{\"node\":");
                push_json(&mut out, &working.model_of(node));
                out.push('}');
                continue;
            };
            let mut mask = changed_mask(node, base);
            let mut same: Vec<(u32, &'static str, usize, &str)> = Vec::new();
            for (k, (field, key)) in SHARED.iter().enumerate() {
                let bit = field.bit();
                if mask & (1u128 << bit) == 0 {
                    continue;
                }
                // A key the node already has in JavaScript (so the merge keeps the keys' order).
                if *field == Field::Prop(PropKey::Text) && base.props.text().is_none() {
                    continue;
                }
                let Some(ptr) = heavy_ptr(node, *field) else {
                    continue;
                };
                match senders[k].get(&ptr) {
                    Some((sender, at)) if *sender != id => {
                        mask &= !(1u128 << bit);
                        same.push((bit, key, *at, working.key(*sender)));
                    }
                    Some(_) => {}
                    None => {
                        senders[k].insert(ptr, (id, index));
                    }
                }
            }
            if mask == 0 && !same.is_empty() {
                // Only values an earlier node sent: three numbers each (`normalized_numbers(1)`).
                for (bit, _, sender, _) in &same {
                    shares.extend([index as f64, f64::from(*bit), *sender as f64]);
                }
                continue;
            }
            if !first {
                out.push(',');
            }
            first = false;
            push_json(&mut out, working.key(id));
            out.push(':');
            let planned = Planned { mask, same };
            write_planned(&mut out, &working.model_of(node), &planned);
        }
        // How many numbers `normalized_numbers` holds (JavaScript asks only for those it needs).
        out.push_str("},\"numbers\":[");
        out.push_str(&boxes.len().to_string());
        out.push(',');
        out.push_str(&shares.len().to_string());
        drop(boxes);
        drop(shares);
        out.push_str("],\"modes\":");
        mode_entries(&mut out, &working);
        out.push('}');
        if keep {
            // The document as normalized, as the entry the commit's patch replays (`apply_patch_with`).
            let (entry, slots) = working.into_entry_and_slots();
            *self.pending().borrow_mut() = Some(entry);
            *self.slots().borrow_mut() = slots;
        } else {
            *self.slots().borrow_mut() = working.into_slots();
        }
        Ok(out)
    }

    /// Where in wasm memory (bytes) the numbers of the last `normalize` are, read by JavaScript through a view (no
    /// copy) right after the call; `which` 0: its box changes, five numbers per node: `index × 16 + mask` (its place in
    /// `written`; bits x, y, width, height of the values that changed), then x, y, width and height (0 where
    /// unchanged); 1: the nodes that changed only heavy values an earlier node of it sent (crates/wasm delta.rs), three
    /// numbers per value: the node's place in `written`, the field (19 fills, 20 strokes, 27 effects, 68 text: bits of
    /// `store::fields::changed_mask`) and the sender's place in `written`, then in `from`. How many: the output's
    /// `numbers`.
    pub fn normalized_numbers(&self, which: u32) -> usize {
        let steps = self.steps();
        let numbers = if which == 0 {
            &steps.boxes
        } else {
            &steps.shares
        };
        numbers.borrow().as_ptr() as usize
    }
}

impl MorfaDoc {
    /// `apply_patch_with`: the pending entry's nodes at `kept` (ids whose JavaScript objects are the very ones the
    /// normalize returned or was sent) replayed, the rest of the entry dropped (the commit's JSON carries those ids as
    /// JavaScript holds them). Errors, changing nothing, when a kept id is not in the entry.
    pub(crate) fn replay_pending(
        &mut self,
        mut entry: Entry,
        kept: &[String],
    ) -> Result<(), String> {
        let doc = self.document();
        let new_ids: FxHashMap<&str, Id> = entry
            .new_ids
            .iter()
            .enumerate()
            .map(|(index, key)| (&**key, Id::from_index(entry.ids_before as usize + index)))
            .collect();
        let mut keep: FxHashSet<Id> = FxHashSet::default();
        for key in kept {
            let id = doc
                .id(key)
                .or_else(|| new_ids.get(key.as_str()).copied())
                .ok_or_else(|| format!("no pending node '{key}'"))?;
            if !entry
                .nodes
                .iter()
                .any(|(at, node)| *at == id && node.is_some())
            {
                return Err(format!("no pending node '{key}'"));
            }
            keep.insert(id);
        }
        entry.nodes.retain(|(id, _)| keep.contains(id));
        // The rest of the entry (its tables, the modes) rides in the JSON the commit sends too; the replay applies
        // the entry's own copy first, the JSON the same values after.
        self.kept().borrow_mut().before_entry(doc, &entry);
        self.replay_entry_in_place(&entry)
    }
}

/// `[[id, node | null], …]`: the entries `draft` wrote, in the order first written.
fn written_entries(draft: &Working) -> String {
    let mut out = String::from("[");
    for (index, (id, node)) in draft.changes().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('[');
        push_json(&mut out, draft.key(id));
        out.push(',');
        match node {
            Some(node) => push_json(&mut out, &draft.model_of(node)),
            None => out.push_str("null"),
        }
        out.push(']');
    }
    out.push(']');
    out
}

/// A JSON array of node ids, or a `JsError` naming the entry.
fn id_list(entry: &str, json: &str) -> Result<Vec<String>, JsError> {
    serde_json::from_str::<Vec<String>>(json)
        .map_err(|error| JsError::new(&format!("MorfaDoc.{entry}: ids: {error}")))
}

#[wasm_bindgen]
impl MorfaDoc {
    /// layout.ts `layoutFrame(doc, id, measurer)`: lays out the auto-layout chain `id` belongs to. The entries written
    /// (`[[id, node | null], …]`).
    pub fn normalize_layout_frame(&self, id: &str) -> String {
        let ctx = Ctx::default();
        let text = morfa_layout::text::TextMeasure::new(&*ctx.measurer);
        let mut draft = Working::new(self.shared());
        let id = draft.intern_id(id);
        morfa_layout::auto_layout::layout_frame(&mut draft, id, text);
        written_entries(&draft)
    }

    /// layout.ts `layoutSizingUpdates(doc, id, axis, sizing)`: `vertical` picks the axis, `sizing` is `FIXED`, `HUG`
    /// or `FILL`. The entries written.
    pub fn normalize_layout_sizing(
        &self,
        id: &str,
        vertical: bool,
        sizing: &str,
    ) -> Result<String, JsError> {
        use morfa_layout::auto_layout::{SizingAxis, set_layout_sizing};
        use morfa_model::types::LayoutSizing;
        let sizing = match sizing {
            "FIXED" => LayoutSizing::Fixed,
            "HUG" => LayoutSizing::Hug,
            "FILL" => LayoutSizing::Fill,
            other => {
                return Err(JsError::new(&format!(
                    "MorfaDoc.normalize_layout_sizing: sizing '{other}'"
                )));
            }
        };
        let axis = if vertical {
            SizingAxis::Vertical
        } else {
            SizingAxis::Horizontal
        };
        let mut draft = Working::new(self.shared());
        let id = draft.intern_id(id);
        set_layout_sizing(&mut draft, id, axis, sizing);
        Ok(written_entries(&draft))
    }

    /// constraints.ts `resizeUpdates(doc, id, box)`: resizes `id` by hand to the box, in its parent's space. The
    /// entries written.
    pub fn normalize_resize(&self, id: &str, x: f64, y: f64, width: f64, height: f64) -> String {
        let target = morfa_layout::geom::Rect::new(x, y, width, height);
        let mut draft = Working::new(self.shared());
        let id = draft.intern_id(id);
        morfa_layout::constraints::resize_by_hand(&mut draft, id, target);
        written_entries(&draft)
    }

    /// constraints.ts `scaleUpdates(doc, ids, origin, sx, sy)` (the Scale tool); `ids` a JSON array, a list (an id
    /// twice scales twice). The entries written.
    pub fn normalize_scale(
        &self,
        ids: &str,
        ox: f64,
        oy: f64,
        sx: f64,
        sy: f64,
    ) -> Result<String, JsError> {
        let ids = id_list("normalize_scale", ids)?;
        let origin = morfa_layout::geom::Vec2 { x: ox, y: oy };
        let mut draft = Working::new(self.shared());
        let ids: Vec<Id> = ids.iter().map(|id| draft.intern_id(id)).collect();
        morfa_layout::constraints::scale_by_tool(&mut draft, &ids, origin, sx, sy);
        Ok(written_entries(&draft))
    }

    /// group-fit.ts `groupFitUpdates(doc, ids)`; `ids` a JSON array. `{"entries": […], "removed": [ids]}`, the removed
    /// ids in the order the TypeScript's `Draft.removed` lists them.
    pub fn normalize_group_fit(&self, ids: &str) -> Result<String, JsError> {
        let ids = id_list("normalize_group_fit", ids)?;
        let mut draft = Working::new(self.shared());
        let ids: Vec<Id> = ids.iter().map(|id| draft.intern_id(id)).collect();
        let mut removed = indexmap::IndexSet::new();
        morfa_layout::group_fit::fit_groups_removing(&mut draft, ids, &mut removed);
        let removed: Vec<&str> = removed.iter().map(|&id| draft.key(id)).collect();
        let mut out = String::from("{\"entries\":");
        out.push_str(&written_entries(&draft));
        out.push_str(",\"removed\":");
        push_json(&mut out, &removed);
        out.push('}');
        Ok(out)
    }
}
