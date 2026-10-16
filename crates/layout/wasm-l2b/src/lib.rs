//! The layout stages over the JavaScript boundary, shadow-document style: a document is loaded once
//! (`l2b_load`) as the engine holds it (`store::Document`), then each call names ids and gets back the entries
//! the stage wrote, as JSON (`[[id, node | null], …]`) or only their count. Lane-local: the engine's real entry
//! points are the coordinator's (`crates/wasm`).

use std::cell::RefCell;
use std::sync::Arc;

use indexmap::IndexSet;
use morfa_layout::constraints::resize_by_hand;
use morfa_layout::geom::Rect;
use morfa_layout::group_fit::fit_groups_removing;
use morfa_layout::text::{TextCache, TextMeasure};
use morfa_layout::{AutoLayoutStage, GroupFitStage, SizingFixesStage, TextResizeStage, auto_layout};
use morfa_model::draft::{Ctx, FixedWidthMeasurer};
use morfa_model::store::Document;
use morfa_model::store::draft::{Stage, Working};
use morfa_model::{DocumentPatch, from_json, patch_from_json, to_json};
use wasm_bindgen::prelude::*;

thread_local! {
    static DOCS: RefCell<Vec<Option<Arc<Document>>>> = const { RefCell::new(Vec::new()) };
    /// The stages live as long as the module, as an editor keeps them: their text caches persist.
    static STAGES: Stages = Stages::default();
    /// The standalone entries' text cache (text-layout.ts keeps one per measurer).
    static TEXT: RefCell<TextCache> = RefCell::new(TextCache::new());
}

#[derive(Default)]
struct Stages {
    sizing: SizingFixesStage,
    text: TextResizeStage,
    layout: AutoLayoutStage,
    groups: GroupFitStage,
}

fn ctx() -> Ctx {
    Ctx {
        measurer: Box::new(FixedWidthMeasurer),
    }
}

fn ids(text: &str) -> Vec<&str> {
    text.split('\n').filter(|id| !id.is_empty()).collect()
}

fn written(draft: &Working, serialize: bool) -> String {
    if !serialize {
        return draft.changes().len().to_string();
    }
    let mut out = String::from("[");
    for (i, (id, node)) in draft.changes().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&serde_json::to_string(draft.key(id)).unwrap());
        out.push(',');
        match node {
            Some(node) => out.push_str(&to_json(&draft.model_of(node))),
            None => out.push_str("null"),
        }
        out.push(']');
    }
    out.push(']');
    out
}

fn with_doc(handle: u32, work: impl FnOnce(Working) -> String) -> Result<String, JsError> {
    let doc = DOCS
        .with(|docs| docs.borrow().get(handle as usize).cloned().flatten())
        .ok_or_else(|| JsError::new("no such document"))?;
    Ok(work(Working::new(doc)))
}

/// Loads a document (JSON); returns its handle.
#[wasm_bindgen]
pub fn l2b_load(json: &str) -> Result<u32, JsError> {
    let doc = from_json(json).map_err(|e| JsError::new(&format!("{e:?}")))?;
    Ok(DOCS.with(|docs| {
        let mut docs = docs.borrow_mut();
        docs.push(Some(Arc::new(Document::from_model(&doc))));
        (docs.len() - 1) as u32
    }))
}

#[wasm_bindgen]
pub fn l2b_drop(handle: u32) {
    DOCS.with(|docs| {
        if let Some(slot) = docs.borrow_mut().get_mut(handle as usize) {
            *slot = None;
        }
    });
}

/// Applies a `DocumentPatch` (JSON) to the shadow document, as the store's `onPatch` would.
#[wasm_bindgen]
pub fn l2b_apply_patch(handle: u32, json: &str) -> Result<(), JsError> {
    let patch: DocumentPatch = patch_from_json(json).map_err(|e| JsError::new(&format!("{e:?}")))?;
    DOCS.with(|docs| {
        let mut docs = docs.borrow_mut();
        let doc = docs
            .get_mut(handle as usize)
            .and_then(Option::as_mut)
            .ok_or_else(|| JsError::new("no such document"))?;
        Arc::make_mut(doc).apply_patch(&patch);
        Ok(())
    })
}

/// Runs a stage (`sizing`, `textResize`, `layout`, `groupFit`) on a fresh working copy over the
/// document, `dirty` newline-separated ids. Returns the written entries as JSON, or their count.
#[wasm_bindgen]
pub fn l2b_stage(handle: u32, stage: &str, dirty: &str, serialize: bool) -> Result<String, JsError> {
    let ctx = ctx();
    with_doc(handle, |mut draft| {
        let dirty = draft.slot_set(ids(dirty));
        let known = STAGES.with(|stages| {
            let stage: &dyn Stage = match stage {
                "sizing" => &stages.sizing,
                "textResize" => &stages.text,
                "layout" => &stages.layout,
                "groupFit" => &stages.groups,
                _ => return false,
            };
            stage.run(&mut draft, &dirty, &ctx);
            true
        });
        if known { written(&draft, serialize) } else { String::from("unknown stage") }
    })
}

/// The layout stage's counters since the last call (measured, arranged, text measured), then reset.
#[wasm_bindgen]
pub fn l2b_layout_counters() -> Vec<f64> {
    STAGES.with(|stages| {
        let counters = stages.layout.kept.counters();
        stages.layout.kept.reset_counters();
        vec![counters.measured as f64, counters.arranged as f64, counters.text_measured as f64]
    })
}

/// `layoutFrame(doc, id)`: the entries it writes, as JSON or their count.
#[wasm_bindgen]
pub fn l2b_layout_frame(handle: u32, id: &str, serialize: bool) -> Result<String, JsError> {
    let ctx = ctx();
    with_doc(handle, |mut draft| {
        let id = draft.intern_id(id);
        TEXT.with(|cache| {
            let mut cache = cache.borrow_mut();
            auto_layout::layout_frame(&mut draft, id, TextMeasure::with_cache(&*ctx.measurer, &mut cache));
        });
        written(&draft, serialize)
    })
}

/// `groupFitUpdates(doc, ids)`.
#[wasm_bindgen]
pub fn l2b_group_fit(handle: u32, ids_text: &str, serialize: bool) -> Result<String, JsError> {
    with_doc(handle, |mut draft| {
        let list: Vec<_> = ids(ids_text).into_iter().map(|id| draft.intern_id(id)).collect();
        fit_groups_removing(&mut draft, list, &mut IndexSet::new());
        written(&draft, serialize)
    })
}

/// `resizeUpdates(doc, id, box)`.
#[wasm_bindgen]
pub fn l2b_resize(handle: u32, id: &str, x: f64, y: f64, width: f64, height: f64, serialize: bool) -> Result<String, JsError> {
    with_doc(handle, |mut draft| {
        let id = draft.intern_id(id);
        resize_by_hand(&mut draft, id, Rect::new(x, y, width, height));
        written(&draft, serialize)
    })
}
