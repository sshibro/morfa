//! The shadow document: a `store::Document` (crates/model, lane S1) that follows the editor's store patch by patch
//! (`shared/design/engine-switch.ts` feeds it from `onPatch`), so module entry points read the document by id instead
//! of taking scene subtrees across the boundary. JSON is the edge's format (docs/TARGETS.md §3b); the binary codec
//! (`encode`/`decode`) moves whole documents when JSON is not needed.

use morfa_model::store::{Document, Entry};
use morfa_model::{from_json, patch_from_json, to_json};
use std::cell::RefCell;
use std::sync::Arc;

use crate::normalize::Kept;
use wasm_bindgen::prelude::*;

fn fail(entry: &str, error: impl std::fmt::Display) -> JsError {
    JsError::new(&format!("MorfaDoc.{entry}: {error}"))
}

#[wasm_bindgen]
pub struct MorfaDoc {
    /// Shared with the working copies of the entry points (`Working::new`), which live within one call: writes go
    /// through `Arc::make_mut`, which copies nothing once they are gone.
    doc: Arc<Document>,
    /// Changes applied since the last load: 0 after `new`, `load` and `decode`, +1 per `apply_patch`.
    version: u32,
    /// The normalize steps' indexes of this document (crates/wasm/src/normalize.rs).
    kept: RefCell<Kept>,
    /// The normalize stages with their text cache, kept between calls (a text laid out once is not laid out again).
    steps: crate::normalize::Steps,
    /// The slot table the working copies reuse between calls (all zeros between them, grown to the document).
    slots: RefCell<Vec<u32>>,
    /// The last `normalize`'s result as a journal entry (its patch's and its own writes), which the commit that
    /// follows replays: `apply_patch_with` takes the kept nodes from here instead of from JSON. Dropped by any change.
    pending: RefCell<Option<Entry>>,
}

impl MorfaDoc {
    /// The stored document, for the module entry points of the other files of this crate.
    pub(crate) fn document(&self) -> &Document {
        &self.doc
    }

    /// The stored document itself, for a working copy that reads it by slot.
    pub(crate) fn shared(&self) -> Arc<Document> {
        Arc::clone(&self.doc)
    }

    /// Where `normalize` leaves its final entry.
    pub(crate) fn pending(&self) -> &RefCell<Option<Entry>> {
        &self.pending
    }

    /// The normalize stages and their measurer, kept between calls.
    pub(crate) fn steps(&self) -> &crate::normalize::Steps {
        &self.steps
    }

    /// The kept indexes, for the normalize entries.
    pub(crate) fn kept(&self) -> &RefCell<Kept> {
        &self.kept
    }

    /// The slot table, for the normalize entries.
    pub(crate) fn slots(&self) -> &RefCell<Vec<u32>> {
        &self.slots
    }

    pub(crate) fn document_mut(&mut self) -> &mut Document {
        Arc::make_mut(&mut self.doc)
    }

    pub(crate) fn with(doc: Document) -> MorfaDoc {
        MorfaDoc {
            doc: Arc::new(doc),
            version: 0,
            kept: RefCell::default(),
            steps: crate::normalize::Steps::default(),
            slots: RefCell::default(),
            pending: RefCell::default(),
        }
    }

    /// Replays `entry` on the shadow in place (the caller dropped what it leaves invalid) and counts the change.
    pub(crate) fn replay_entry_in_place(&mut self, entry: &Entry) -> Result<(), String> {
        self.document_mut()
            .replay(entry)
            .map_err(|error| error.to_string())?;
        *self.pending.get_mut() = None;
        self.version += 1;
        Ok(())
    }
}

#[wasm_bindgen]
impl MorfaDoc {
    /// A shadow of the document in `json` (types.ts `DesignDocument`; the shape is checked, the bounds are the TS
    /// store's: it only holds valid documents).
    #[wasm_bindgen(constructor)]
    pub fn new(json: &str) -> Result<MorfaDoc, JsError> {
        let model = from_json(json).map_err(|error| fail("new", error))?;
        Ok(MorfaDoc::with(Document::from_model(&model)))
    }

    /// Replaces the whole document (the store's `replace`: version restore, a reload after a conflict).
    pub fn load(&mut self, json: &str) -> Result<(), JsError> {
        let model = from_json(json).map_err(|error| fail("load", error))?;
        *self = MorfaDoc::with(Document::from_model(&model));
        Ok(())
    }

    /// Applies one `DocumentPatch` (shared/design/patch.ts `applyPatch`) in place.
    pub fn apply_patch(&mut self, json: &str) -> Result<(), JsError> {
        let patch = patch_from_json(json).map_err(|error| fail("apply_patch", error))?;
        self.apply(patch);
        Ok(())
    }

    /// `apply_patch` of a patch whose node entries `ids` (a JSON array) are left out of `json`: their values are the
    /// last `normalize`'s final nodes (shared/design/engine-switch.ts sends the ids of entries that are the very
    /// objects that call returned), replayed from the entry it kept instead of parsed from JSON. Errors, changing
    /// nothing, when one is not there.
    pub fn apply_patch_with(&mut self, json: &str, ids: &str) -> Result<(), JsError> {
        let patch = patch_from_json(json).map_err(|error| fail("apply_patch_with", error))?;
        let ids: Vec<String> =
            serde_json::from_str(ids).map_err(|error| fail("apply_patch_with", error))?;
        match self.pending.get_mut().take() {
            Some(entry) => self
                .replay_pending(entry, &ids)
                .map_err(|error| fail("apply_patch_with", error))?,
            None => {
                if let Some(id) = ids.first() {
                    return Err(fail("apply_patch_with", format!("no pending node '{id}'")));
                }
            }
        }
        self.apply(patch);
        Ok(())
    }

    /// Adds a part of the document being loaded: a patch (usually `{"nodes": {...}}` with a slice of the node table)
    /// applied without counting as a change. Loading a large document as an empty skeleton (`new`/`load` of the
    /// document with `nodes: {}`) and then its nodes in parts keeps the wasm memory's peak at one part's JSON model
    /// instead of the whole file's (linear memory never shrinks: a 20 000-node file parsed whole leaves ≈ 98 MiB).
    pub fn load_part(&mut self, json: &str) -> Result<(), JsError> {
        *self.kept.get_mut() = Kept::default();
        *self.pending.get_mut() = None;
        self.steps.pipeline.forget_derived();
        // A nodes-only part is read node by node straight into the store (lane N1 step 7: no JSON model of the whole
        // part, so the wasm heap does not fragment around it); anything else, or a part the strict reader refuses, goes
        // the patch way (the server's build also reads what only JSON.parse takes).
        let nodes_only = json.trim_start().starts_with("{\"nodes\"");
        if nodes_only
            && let Ok(morfa_model::store::load::Loaded::Nodes(_)) =
                self.document_mut().load_nodes_json(json)
        {
            return Ok(());
        }
        // (A part refused halfway leaves the nodes read so far in place; the patch below writes them again, the same.)
        let patch = patch_from_json(json).map_err(|error| fail("load_part", error))?;
        self.document_mut().apply_patch(&patch);
        Ok(())
    }

    /// Applies `patch` (and hands it back).
    fn apply(&mut self, patch: morfa_model::DocumentPatch) -> morfa_model::DocumentPatch {
        *self.pending.get_mut() = None;
        self.kept.get_mut().before_patch(&self.doc, &patch);
        self.document_mut().apply_patch(&patch);
        self.version += 1;
        patch
    }

    /// Changes applied since the last load.
    pub fn version(&self) -> u32 {
        self.version
    }

    /// One node as types.ts `SceneNode` (a plain object), `undefined` when no node has this id.
    pub fn node(&self, id: &str) -> Result<JsValue, JsError> {
        match self.doc.node_model(id) {
            None => Ok(JsValue::UNDEFINED),
            Some(node) => js_sys::JSON::parse(&to_json(&node))
                .map_err(|_| JsError::new("MorfaDoc.node: the node's JSON does not parse")),
        }
    }

    /// The page order.
    pub fn pages(&self) -> Vec<String> {
        self.doc
            .pages
            .iter()
            .map(|&page| self.doc.key(page).to_owned())
            .collect()
    }

    /// The whole document as JSON (tests and debugging; module calls never need it).
    pub fn to_json(&self) -> String {
        to_json(&self.doc.to_model())
    }

    /// The document in S1's binary codec (`MRFA` frame, postcard).
    pub fn encode(&self) -> Vec<u8> {
        morfa_model::codec::encode(&self.doc)
    }

    /// A shadow of a document in S1's binary codec.
    pub fn decode(bytes: &[u8]) -> Result<MorfaDoc, JsError> {
        // The codec's checks and errors, through the reader `decode_from` uses (parts.rs: one copy of it in the build).
        let doc = crate::parts::decode_bytes(bytes).map_err(|error| fail("decode", error))?;
        Ok(MorfaDoc::with(doc))
    }

    /// `{nodes, ids, atoms, version, memoryBytes}`: memoryBytes is the whole wasm memory (every shadow and the
    /// allocator's free space; 0 outside wasm).
    pub fn stats(&self) -> Result<JsValue, JsError> {
        let stats = js_sys::Object::new();
        let set = |key: &str, value: f64| js_sys::Reflect::set(&stats, &key.into(), &value.into());
        set("nodes", self.doc.len() as f64)
            .and(set("ids", self.doc.ids().len() as f64))
            .and(set("atoms", self.doc.atoms().len() as f64))
            .and(set("version", self.version as f64))
            .and(set("memoryBytes", memory_bytes() as f64))
            .map_err(|_| JsError::new("MorfaDoc.stats: could not build the object"))?;
        Ok(stats.into())
    }
}

#[cfg(target_arch = "wasm32")]
fn memory_bytes() -> usize {
    core::arch::wasm32::memory_size(0) * 65_536
}

#[cfg(not(target_arch = "wasm32"))]
fn memory_bytes() -> usize {
    0
}

/// The store journal entries of collab's journal rows (`MRFJ`): api's build only (feature `server`).
#[cfg(feature = "server")]
#[wasm_bindgen]
impl MorfaDoc {
    /// Applies one `DocumentPatch` as `apply_patch` does and answers its store journal entry (`MRFJ` bytes, what
    /// `replay_entry` takes on a document in the state this one was in).
    pub fn commit_entry(&mut self, json: &str) -> Result<Vec<u8>, JsError> {
        let patch = patch_from_json(json).map_err(|error| fail("commit_entry", error))?;
        *self.pending.get_mut() = None;
        self.kept.get_mut().before_patch(&self.doc, &patch);
        let entry = self.document_mut().commit(&patch);
        self.version += 1;
        Ok(entry.to_bytes())
    }

    /// Replays one store journal entry (`MRFJ`, `morfa_model::store::Entry::to_bytes`) as crates/checkpoint's
    /// load does: the entry must continue this document's interners exactly (a document decoded from a checkpoint,
    /// or made from the stored text, with the rows before it applied). Errors, changing nothing, otherwise.
    pub fn replay_entry(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        let entry = Entry::from_bytes(bytes).map_err(|error| fail("replay_entry", error))?;
        let mut doc = (*self.doc).clone();
        doc.replay(&entry)
            .map_err(|error| fail("replay_entry", error))?;
        self.doc = Arc::new(doc);
        *self.kept.get_mut() = Kept::default();
        *self.pending.get_mut() = None;
        self.version += 1;
        Ok(())
    }
}
