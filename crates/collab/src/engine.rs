//! `DocEngine`: the authoritative document of one file and the one step that changes it.
//!
//! [`OpsEngine`] holds the model's `DesignDocument` and applies an op as `patchDesignDocument`
//! (server/design/files.ts) with `applyDocumentChange` (server/design/apply.ts) does:
//! - the patch's shape is validated (`validatePatch`); an empty patch changes nothing;
//! - without `before` copies the op must be on the current version and applies as sent;
//! - with them it merges onto the current version (lane L2a's `mergeChange`, crates/ops), however far the file
//!   moved on since the client's version;
//! - the patched document is checked (L2a's `checkPatchedDocument`) and a refusal leaves the document as it was.
//!
//! The merge reads every entry it touches as a JSON-like value, which costs about 30 µs a layer. An op that only
//! edits plain fields of existing layers on the current version (moves, sizes, colours: most ops) has nothing to
//! merge ([`OpsEngine::nothing_to_merge`] says exactly when) and skips it; every other op, and any op the check
//! refuses as sent, takes the merge, so the result is always what the Node route stores. Checked against L2a's
//! `applyDocumentChange` by crates/collab/tests/merge.rs and against the TypeScript itself by
//! crates/collab/harness/shadow.ts.

use crate::ops::{
    After, Before, DocView, Projections, Target, base_value, patch_outline, patch_value,
};
use morfa_model::store::Document as Store;
use morfa_model::{
    DesignDocument, DocumentPatch, Map, SceneNode, patch_from_json, to_json, validate_patch,
};
use morfa_protocol::{Copies, DecodeError, ErrorCode, Op, Version};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::Arc;

/// What an op asks of the document.
#[derive(Debug, Clone)]
pub struct OpInput<'a> {
    pub base_version: Version,
    pub patch: &'a DocumentPatch,
    pub before: Option<&'a Map<Option<SceneNode>>>,
    pub before_tables: Option<&'a DocumentPatch>,
}

impl<'a> OpInput<'a> {
    /// What `op` asks of an engine at `version`. Raw `before` copies are read only when the op is on another
    /// version (an op on the current one lands as sent and never looks at them).
    pub fn of(op: &'a mut Op, version: Version) -> Result<Self, Refusal> {
        let Op {
            seq,
            base_version,
            patch,
            before,
            before_tables,
            fields,
        } = op;
        debug_assert!(
            fields.is_none(),
            "field ops are expanded before they apply (crate::fields_op)"
        );
        if let Some(copies) = before.as_mut()
            && *base_version != version
        {
            copies.read(*seq)?;
        }
        let before = before.as_ref().and_then(Copies::as_read);
        Ok(OpInput {
            base_version: *base_version,
            patch,
            before,
            before_tables: before_tables.as_ref(),
        })
    }
}

impl From<DecodeError> for Refusal {
    fn from(error: DecodeError) -> Self {
        Refusal {
            code: error.code,
            message: error.message,
            node_id: error
                .path
                .as_deref()
                .and_then(|p| p.strip_prefix("before."))
                .map(|p| p.split('.').next().unwrap_or(p).to_owned()),
            path: error.path,
            current_version: None,
        }
    }
}

/// An applied op.
#[derive(Debug, Clone)]
pub struct Applied {
    pub version: Version,
    /// What was written (`stored` of `applyDocumentChange`).
    pub stored: Arc<DocumentPatch>,
    /// The stored patch differs from the one sent.
    pub adjusted: bool,
    /// What the ack carries as `own` when the op did not land as sent: the server's value of every entry the
    /// client sent or the merge wrote (`storedValues`), so the client puts its copy right.
    pub own: Option<Arc<DocumentPatch>>,
    /// The entries the op replaced, as they were: applying it restores the previous version (rollback).
    pub undo: DocumentPatch,
}

/// A refused op.
#[derive(Debug, Clone, PartialEq)]
pub struct Refusal {
    pub code: ErrorCode,
    pub message: String,
    pub path: Option<String>,
    pub node_id: Option<String>,
    pub current_version: Option<Version>,
}

impl Refusal {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Refusal {
            code,
            message: message.into(),
            path: None,
            node_id: None,
            current_version: None,
        }
    }
}

/// Sizes the actor reports (`doc_resident_bytes`, the memory cap).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct EngineStats {
    pub nodes: usize,
    /// An estimate of the document's resident bytes: its JSON size at load plus the JSON size of what ops
    /// added since (TARGETS M6 measures the real number).
    pub approx_bytes: usize,
}

/// The engine of one document. Runs only inside its `DocActor`; never shared, never locked.
pub trait DocEngine: Send + 'static {
    fn apply(&mut self, op: &OpInput<'_>) -> Result<Applied, Refusal>;
    /// Restores the previous version after a failed journal commit: `undo` of [`Applied`], in reverse order.
    fn revert(&mut self, undo: &DocumentPatch, to_version: Version);
    /// Replaces the whole document (restore, import, a shadow seed).
    fn replace(&mut self, document: DesignDocument, version: Version);
    /// The document as it is now, shared: the next op copies it while someone still holds it. A store-backed
    /// engine converts its whole document here: on the actor's thread, use [`DocEngine::snapshot`].
    fn document(&mut self) -> Arc<DesignDocument>;
    /// The document as it is now, cheap to take (a store-backed engine clones its node pointers): convert it off
    /// the actor's thread ([`Snapshot::model`], [`Snapshot::store`]).
    fn snapshot(&mut self) -> Snapshot {
        Snapshot::Model(self.document())
    }
    /// An equal copy of the document at `version`, made elsewhere: the engine may write to it instead of copying
    /// its document itself while a snapshot of it is held. Ignored when the engine moved on.
    fn adopt_copy(&mut self, _copy: DesignDocument, _version: Version) {}
    fn version(&self) -> Version;
    fn stats(&self) -> EngineStats;
    /// One node as it is now, in the typed model (protocol 2's field ops spread over it, crate::fields_op). None:
    /// the document has no such node, or the engine does not read nodes one by one (field ops are then refused).
    fn node(&self, _id: &str) -> Option<SceneNode> {
        None
    }
    /// [`stored_values`] over the document as it is now (an ack's `own`); None when the engine cannot read it.
    fn stored_values(
        &self,
        _sent: &DocumentPatch,
        _stored: &DocumentPatch,
    ) -> Option<DocumentPatch> {
        None
    }
}

/// A document at one version, as an engine hands it out.
#[derive(Clone)]
pub enum Snapshot {
    Model(Arc<DesignDocument>),
    Store(Arc<Store>),
}

impl Snapshot {
    /// The typed document (a store's whole conversion: 20 000 layers ≈ 25 ms; off the actor's thread).
    pub fn model(&self) -> Arc<DesignDocument> {
        match self {
            Snapshot::Model(doc) => Arc::clone(doc),
            Snapshot::Store(store) => Arc::new(store.to_model()),
        }
    }

    /// The document in the compact store (a typed document's whole conversion; off the actor's thread).
    pub fn store(&self) -> Arc<Store> {
        match self {
            Snapshot::Model(doc) => Arc::new(Store::from_model(doc)),
            Snapshot::Store(store) => Arc::clone(store),
        }
    }

    pub fn nodes(&self) -> usize {
        match self {
            Snapshot::Model(doc) => doc.nodes.len(),
            Snapshot::Store(store) => store.len(),
        }
    }
}

/// What an engine is built from: the document a journal loaded, in whichever form it read it.
#[derive(Debug, Clone)]
pub enum EngineSource {
    Model(Box<DesignDocument>),
    Store(Store),
}

impl EngineSource {
    pub fn into_model(self) -> DesignDocument {
        match self {
            EngineSource::Model(doc) => *doc,
            EngineSource::Store(store) => store.to_model(),
        }
    }
}

/// The engine's document: the model's typed one (the shadow path, tests) or its compact store (an actor's:
/// 7.6 MB for the 20 000-layer page instead of ~60 MB, TARGETS M6; a node read converts it, ~0.2 µs a layer).
enum Doc {
    Typed(Arc<DesignDocument>),
    Store(Store),
}

impl Doc {
    fn view(&self) -> &dyn DocView {
        match self {
            Doc::Typed(doc) => &**doc,
            Doc::Store(store) => store,
        }
    }

    fn apply(&mut self, patch: &DocumentPatch) {
        match self {
            Doc::Typed(doc) => patch.apply(Arc::make_mut(doc)),
            Doc::Store(store) => store.apply_patch(patch),
        }
    }
}

/// A store's JSON size is not kept: about this many bytes a layer (the 20 000-layer page: 702).
pub const APPROX_BYTES_PER_NODE: usize = 720;

/// The document caps the engine enforces.
#[derive(Debug, Clone, Copy)]
pub struct EngineLimits {
    /// `DESIGN_DOCUMENT_CAPS.nodes`.
    pub max_nodes: usize,
    /// Refuse ops that grow the document past this (`design_documents_limit`).
    pub max_bytes: usize,
}

impl Default for EngineLimits {
    /// With the big-files switch on (`morfa_model::limits::big_files`, docs/decisions/big-files.md) the caps of
    /// `DESIGN_BIG_FILE_CAPS` and four times its JSON bytes resident; otherwise the server's own headroom above the
    /// fixed cap (the ops check refuses past 50 000 layers before these matter).
    fn default() -> Self {
        use morfa_model::limits::{big_files, caps};
        if big_files() {
            EngineLimits {
                max_nodes: caps::big::NODES,
                max_bytes: caps::big::BYTES.saturating_mul(4),
            }
        } else {
            EngineLimits {
                max_nodes: 200_000,
                max_bytes: 1024 * 1024 * 1024,
            }
        }
    }
}

/// The engine over `crates/model`.
pub struct OpsEngine {
    doc: Doc,
    version: Version,
    limits: EngineLimits,
    approx_bytes: usize,
    /// Node projections of `doc` the check reads (crate::ops).
    projections: Projections,
    /// The newest version whose op changed the tree (a layer added or removed, or its parent, children, type or
    /// component link changed); ops made on it or later saw today's tree.
    tree_version: Version,
    /// Nodes the check passed since the last change of any node's projection ([`OpsEngine::checks_unchanged`]).
    checked: HashSet<String>,
}

/// More remembered checks than this and the memo starts over (a bound, not a tuning).
const CHECKED_KEPT: usize = 16_384;

/// Whether `new` and `old` agree on every field the patched-document check reads of a node
/// (`morfa_ops::doc::CHECK_FIELDS`: its projection).
fn same_projection(new: &SceneNode, old: &SceneNode) -> bool {
    new.id == old.id
        && new.kind == old.kind
        && new.parent_id == old.parent_id
        && new.children == old.children
        && new.main_id == old.main_id
        && new.remote == old.remote
        && new.text == old.text
        && new.text_path == old.text_path
        && new.measurements == old.measurements
        && new.annotations == old.annotations
        && new.vector_paths == old.vector_paths
}

impl OpsEngine {
    pub fn new(document: DesignDocument, version: Version) -> Self {
        let approx_bytes = to_json(&document).len();
        OpsEngine {
            doc: Doc::Typed(Arc::new(document)),
            version,
            limits: EngineLimits::default(),
            approx_bytes,
            projections: Projections::default(),
            tree_version: version,
            checked: HashSet::new(),
        }
    }

    /// An engine on the model's compact store (what an actor runs). `approx_bytes`: the document's JSON size when
    /// known, else estimated from its layers.
    pub fn new_store(store: Store, version: Version, approx_bytes: Option<usize>) -> Self {
        let approx_bytes = approx_bytes.unwrap_or(store.len() * APPROX_BYTES_PER_NODE);
        OpsEngine {
            doc: Doc::Store(store),
            version,
            limits: EngineLimits::default(),
            approx_bytes,
            projections: Projections::default(),
            tree_version: version,
            checked: HashSet::new(),
        }
    }

    pub fn with_limits(mut self, limits: EngineLimits) -> Self {
        self.limits = limits;
        self
    }

    /// The typed document of an engine made by [`OpsEngine::new`] (the shadow path); a store-backed engine
    /// panics: use [`DocEngine::snapshot`].
    pub fn doc(&self) -> &DesignDocument {
        match &self.doc {
            Doc::Typed(doc) => doc,
            Doc::Store(_) => panic!("OpsEngine::doc of a store-backed engine"),
        }
    }

    /// Writes a patch as it is, unchecked, as `version` (the shadow path's fallback: what Node stored).
    pub fn apply_stored(&mut self, patch: &DocumentPatch, version: Version) {
        self.doc.apply(patch);
        self.projections.forget(patch);
        self.checked.clear();
        self.version = version;
        self.tree_version = version;
    }

    pub fn set_version(&mut self, version: Version) {
        if version != self.version {
            // A change this engine did not see (made through api): assume it moved the tree.
            self.tree_version = version;
        }
        self.version = version;
    }

    fn conflict(&self) -> Refusal {
        Refusal {
            current_version: Some(self.version),
            ..Refusal::new(
                ErrorCode::VersionConflict,
                "The file has changed. This change was made on an older version.",
            )
        }
    }

    /// The op has nothing to merge: the tree has not changed since its version, and it edits only nodes that
    /// exist, each in place (the same parent, children, type and component link), holding the client's copy,
    /// changing something, and only in fields `mergeNodeFields` copies as they are. For such an op `mergeChange`
    /// returns the patch itself: every field it changed is taken from it, every list and record it left alone
    /// stays, and no structural rule (rescue, cycle, empty group, instance copies, page) can fire on a tree nobody
    /// changed. Text, overrides, the merged records and entry lists, new and removed layers, pages, the other
    /// tables, and any op older than the last change of the tree all take the merge.
    fn nothing_to_merge(&self, op: &OpInput<'_>) -> bool {
        let p = op.patch;
        let tables_untouched = p.pages.is_none()
            && p.styles.as_ref().is_none_or(Map::is_empty)
            && p.images.as_ref().is_none_or(Map::is_empty)
            && p.variable_collections.as_ref().is_none_or(Map::is_empty)
            && p.variables.as_ref().is_none_or(Map::is_empty)
            && p.variable_modes.as_ref().is_none_or(Map::is_empty);
        if op.base_version < self.tree_version || !tables_untouched {
            return false;
        }
        let Some(nodes) = &p.nodes else {
            return false;
        };
        let doc = self.doc.view();
        nodes.iter().all(|(id, change)| {
            let (Some(new), Some(now)) = (change.as_ref(), doc.node(id)) else {
                return false;
            };
            let now = &*now;
            let held = op
                .before
                .and_then(|before| before.get(id))
                .is_none_or(|copy| copy.as_ref() == Some(now));
            held && new != now
                && new.id == now.id
                && new.parent_id == now.parent_id
                && new.children == now.children
                && new.kind == now.kind
                && new.main_id == now.main_id
                && new.text == now.text
                && new.overrides == now.overrides
                && new.auto_layout == now.auto_layout
                && new.grid == now.grid
                && new.grid_child == now.grid_child
                && new.bound_variables == now.bound_variables
                && new.component_properties == now.component_properties
                && new.component_property_definitions == now.component_property_definitions
                && new.plugin_data == now.plugin_data
                && new.constraints == now.constraints
                && new.board == now.board
                && new.annotations == now.annotations
                && new.measurements == now.measurements
        })
    }

    /// Writes `patch` and checks the result (`checkPatchedDocument`); a refusal puts the document back.
    /// Answers the undo.
    fn write_checked(&mut self, patch: &DocumentPatch) -> Result<DocumentPatch, Refusal> {
        let unchanged = self.checks_unchanged(patch);
        let undo = undo_of(self.doc.view(), patch);
        self.doc.apply(patch);
        self.projections.forget(patch);
        if unchanged {
            // Every node the patch writes was checked on a document whose projections are today's, and the
            // patch changes none of them: the check would answer as it did then.
            return Ok(undo);
        }
        let invalid = {
            let doc = self.doc.view();
            let after = After {
                doc,
                projections: &self.projections,
            };
            let before = Before {
                after: &after,
                undo: &undo,
            };
            let count = doc.node_count();
            morfa_ops::check::check_patched_document(
                &before,
                &after,
                &patch_outline(patch),
                Some(&|| count),
            )
        };
        if let Some(invalid) = invalid {
            self.doc.apply(&undo);
            self.projections.forget(patch);
            let node_id = invalid
                .entry
                .as_ref()
                .filter(|e| e.table == "nodes")
                .and_then(|e| e.key.as_deref())
                .map(str::to_owned);
            return Err(Refusal {
                node_id,
                path: Some(invalid.path),
                ..Refusal::new(ErrorCode::DesignDocumentInvalid, invalid.message)
            });
        }
        if let Some(nodes) = patch.nodes.as_ref() {
            if self.checked.len() + nodes.len() > CHECKED_KEPT {
                self.checked.clear();
            }
            self.checked.extend(nodes.keys().cloned());
        }
        Ok(undo)
    }

    /// Whether the check of `patch` is known to pass, and keeps the memo true to the document either way.
    ///
    /// `checkPatchedDocument` reads only node projections (`CHECK_FIELDS`), the page list, the node count and
    /// the patch's outline (its keys, which remove, the ids of style and variable entries). A patch that writes
    /// existing nodes only, each with its projection unchanged, leaves all of those as they were, so the check
    /// of it answers what it answered for the same nodes before: a pass when each of them passed since the last
    /// change of any projection. Any other patch may change a projection: the memo starts over.
    fn checks_unchanged(&mut self, patch: &DocumentPatch) -> bool {
        let tables_untouched = patch.pages.is_none()
            && patch.styles.is_none()
            && patch.images.is_none()
            && patch.variable_collections.is_none()
            && patch.variables.is_none()
            && patch.variable_modes.is_none();
        let doc = self.doc.view();
        let plain = tables_untouched
            && patch.nodes.as_ref().is_some_and(|nodes| {
                nodes
                    .iter()
                    .all(|(id, new)| match (new.as_ref(), doc.node(id)) {
                        (Some(new), Some(old)) => same_projection(new, &old),
                        _ => false,
                    })
            });
        if !plain {
            self.checked.clear();
            return false;
        }
        let nodes = patch.nodes.as_ref().expect("plain");
        nodes.keys().all(|id| self.checked.contains(id))
    }

    /// An op that changed nothing: acked on the current version.
    fn unchanged(&self, adjusted: bool, sent: &DocumentPatch) -> Applied {
        Applied {
            version: self.version,
            stored: Arc::new(DocumentPatch::default()),
            adjusted,
            own: adjusted.then(|| {
                Arc::new(stored_values(
                    self.doc.view(),
                    sent,
                    &DocumentPatch::default(),
                ))
            }),
            undo: DocumentPatch::default(),
        }
    }
}

/// Whether a written patch changed the tree: added or removed a layer, or changed one's parent, children, type or
/// component link. `undo` holds the entries as they were.
fn changes_tree(patch: &DocumentPatch, undo: &DocumentPatch) -> bool {
    let Some(nodes) = &patch.nodes else {
        return false;
    };
    let before = undo.nodes.as_ref();
    nodes.iter().any(|(id, new)| {
        match (new, before.and_then(|b| b.get(id)).and_then(Option::as_ref)) {
            (Some(new), Some(old)) => {
                new.parent_id != old.parent_id
                    || new.children != old.children
                    || new.kind != old.kind
                    || new.main_id != old.main_id
            }
            _ => true,
        }
    })
}

fn drop_empty_tables(patch: &mut DocumentPatch) {
    fn drop<T>(table: &mut Option<Map<T>>) {
        if table.as_ref().is_some_and(Map::is_empty) {
            *table = None;
        }
    }
    drop(&mut patch.nodes);
    drop(&mut patch.styles);
    drop(&mut patch.images);
    drop(&mut patch.variable_collections);
    drop(&mut patch.variables);
    drop(&mut patch.variable_modes);
}

/// Whether a patch writes a table other than nodes and pages.
fn touches_tables(patch: &DocumentPatch) -> bool {
    patch.styles.is_some()
        || patch.images.is_some()
        || patch.variable_collections.is_some()
        || patch.variables.is_some()
        || patch.variable_modes.is_some()
}

/// `storedValues(doc, sent, stored)` (server/design/apply.ts): the document's value of every entry `sent` or
/// `stored` names, and the page order when either changes it.
pub fn stored_values(
    doc: &dyn DocView,
    sent: &DocumentPatch,
    stored: &DocumentPatch,
) -> DocumentPatch {
    fn table<T: Clone>(
        a: &Option<Map<Option<T>>>,
        b: &Option<Map<Option<T>>>,
        now: Option<&Map<T>>,
    ) -> Option<Map<Option<T>>> {
        if a.as_ref().is_none_or(Map::is_empty) && b.as_ref().is_none_or(Map::is_empty) {
            return None;
        }
        let mut out = Map::default();
        for key in a
            .iter()
            .flat_map(|t| t.keys())
            .chain(b.iter().flat_map(|t| t.keys()))
        {
            if !out.contains_key(key) {
                out.insert(key.clone(), now.and_then(|t| t.get(key)).cloned());
            }
        }
        Some(out)
    }
    let nodes = {
        let (a, b) = (&sent.nodes, &stored.nodes);
        if a.as_ref().is_none_or(Map::is_empty) && b.as_ref().is_none_or(Map::is_empty) {
            None
        } else {
            let mut out = Map::default();
            for key in a
                .iter()
                .flat_map(|t| t.keys())
                .chain(b.iter().flat_map(|t| t.keys()))
            {
                if !out.contains_key(key) {
                    out.insert(key.clone(), doc.node(key).map(Cow::into_owned));
                }
            }
            Some(out)
        }
    };
    let pages = (sent.pages.is_some() || stored.pages.is_some()).then(|| doc.page_ids());
    if !touches_tables(sent) && !touches_tables(stored) {
        return DocumentPatch {
            nodes,
            pages,
            ..DocumentPatch::default()
        };
    }
    let doc = doc.tables();
    DocumentPatch {
        nodes,
        pages,
        styles: table(&sent.styles, &stored.styles, Some(&doc.styles)),
        images: table(&sent.images, &stored.images, Some(&doc.images)),
        variable_collections: table(
            &sent.variable_collections,
            &stored.variable_collections,
            Some(&doc.variable_collections),
        ),
        variables: table(&sent.variables, &stored.variables, Some(&doc.variables)),
        variable_modes: table(
            &sent.variable_modes,
            &stored.variable_modes,
            doc.variable_modes.as_ref(),
        ),
    }
}

/// The previous values of every entry a patch writes, and the page order when it changes.
pub fn undo_of(doc: &dyn DocView, patch: &DocumentPatch) -> DocumentPatch {
    fn table<T: Clone>(
        changes: &Option<Map<Option<T>>>,
        now: Option<&Map<T>>,
    ) -> Option<Map<Option<T>>> {
        let changes = changes.as_ref()?;
        Some(
            changes
                .keys()
                .map(|key| (key.clone(), now.and_then(|t| t.get(key)).cloned()))
                .collect(),
        )
    }
    let pages = patch.pages.as_ref().map(|_| doc.page_ids());
    let nodes = patch.nodes.as_ref().map(|changes| {
        changes
            .keys()
            .map(|key| (key.clone(), doc.node(key).map(Cow::into_owned)))
            .collect()
    });
    if !touches_tables(patch) {
        return DocumentPatch {
            pages,
            nodes,
            ..DocumentPatch::default()
        };
    }
    let doc = doc.tables();
    DocumentPatch {
        pages,
        nodes,
        styles: table(&patch.styles, Some(&doc.styles)),
        images: table(&patch.images, Some(&doc.images)),
        variable_collections: table(&patch.variable_collections, Some(&doc.variable_collections)),
        variables: table(&patch.variables, Some(&doc.variables)),
        variable_modes: table(&patch.variable_modes, doc.variable_modes.as_ref()),
    }
}

impl DocEngine for OpsEngine {
    fn apply(&mut self, op: &OpInput<'_>) -> Result<Applied, Refusal> {
        if let Err(invalid) = validate_patch(op.patch) {
            let node_id = invalid
                .path
                .strip_prefix("nodes.")
                .map(|rest| rest.split('.').next().unwrap_or(rest).to_owned());
            return Err(Refusal {
                node_id,
                path: Some(invalid.path),
                ..Refusal::new(ErrorCode::DesignDocumentInvalid, invalid.message)
            });
        }
        let merging = op.before.is_some() || op.before_tables.is_some();
        if op.base_version > self.version || (!merging && op.base_version != self.version) {
            return Err(self.conflict());
        }
        if op.patch.is_empty() {
            return Ok(self.unchanged(false, op.patch));
        }
        let grows = op.patch.nodes.as_ref().map_or(0, |n| n.len()) * 512;
        if self.approx_bytes + grows > self.limits.max_bytes {
            return Err(Refusal::new(
                ErrorCode::DesignDocumentsLimit,
                "The document has reached its size limit.",
            ));
        }
        if !merging || self.nothing_to_merge(op) {
            match self.write_checked(op.patch) {
                Ok(undo) => {
                    self.version += 1;
                    if changes_tree(op.patch, &undo) {
                        self.tree_version = self.version;
                    }
                    self.approx_bytes = self.approx_bytes.saturating_add(grows / 4);
                    let mut stored = op.patch.clone();
                    if merging {
                        // The merge writes no empty table.
                        drop_empty_tables(&mut stored);
                    }
                    return Ok(Applied {
                        version: self.version,
                        stored: Arc::new(stored),
                        adjusted: false,
                        own: None,
                        undo,
                    });
                }
                Err(refusal) if !merging => return Err(refusal),
                // The merge may repair what the check refused as sent (the Node route merges first).
                Err(_) => {}
            }
        }
        let merged = morfa_ops::merge_change(
            &Target(self.doc.view()),
            &patch_value(op.patch),
            Some(&base_value(op.before, op.before_tables)),
        );
        let stored = patch_from_json(&merged.patch.to_json()).map_err(|invalid| Refusal {
            path: Some(invalid.path),
            ..Refusal::new(ErrorCode::DesignDocumentInvalid, invalid.message)
        })?;
        if stored.is_empty() {
            return Ok(self.unchanged(merged.adjusted, op.patch));
        }
        let undo = self.write_checked(&stored)?;
        self.version += 1;
        if changes_tree(&stored, &undo) {
            self.tree_version = self.version;
        }
        self.approx_bytes = self.approx_bytes.saturating_add(grows / 4);
        let own = merged
            .adjusted
            .then(|| Arc::new(stored_values(self.doc.view(), op.patch, &stored)));
        Ok(Applied {
            version: self.version,
            stored: Arc::new(stored),
            adjusted: merged.adjusted,
            own,
            undo,
        })
    }

    fn revert(&mut self, undo: &DocumentPatch, to_version: Version) {
        self.doc.apply(undo);
        self.projections.forget(undo);
        self.checked.clear();
        // What the undone ops did to the tree is not kept: only ops on this version saw the tree as it is now.
        self.tree_version = self.tree_version.max(to_version);
        self.version = to_version;
    }

    fn replace(&mut self, document: DesignDocument, version: Version) {
        self.approx_bytes = to_json(&document).len();
        self.doc = match self.doc {
            Doc::Typed(_) => Doc::Typed(Arc::new(document)),
            Doc::Store(_) => Doc::Store(Store::from_model(&document)),
        };
        self.projections.clear();
        self.checked.clear();
        self.tree_version = version;
        self.version = version;
    }

    fn document(&mut self) -> Arc<DesignDocument> {
        match &self.doc {
            Doc::Typed(doc) => Arc::clone(doc),
            Doc::Store(store) => Arc::new(store.to_model()),
        }
    }

    fn snapshot(&mut self) -> Snapshot {
        match &self.doc {
            Doc::Typed(doc) => Snapshot::Model(Arc::clone(doc)),
            // The clone shares every node with the engine's until one of them is written.
            Doc::Store(store) => Snapshot::Store(Arc::new(store.clone())),
        }
    }

    fn adopt_copy(&mut self, copy: DesignDocument, version: Version) {
        if let Doc::Typed(doc) = &self.doc
            && version == self.version
            && Arc::strong_count(doc) > 1
        {
            self.doc = Doc::Typed(Arc::new(copy));
        }
    }

    fn version(&self) -> Version {
        self.version
    }

    fn node(&self, id: &str) -> Option<SceneNode> {
        self.doc.view().node(id).map(std::borrow::Cow::into_owned)
    }

    fn stored_values(&self, sent: &DocumentPatch, stored: &DocumentPatch) -> Option<DocumentPatch> {
        Some(stored_values(self.doc.view(), sent, stored))
    }

    fn stats(&self) -> EngineStats {
        EngineStats {
            nodes: self.doc.view().node_count(),
            approx_bytes: self.approx_bytes,
        }
    }
}

/// The document hash `/internal/shadow-op` answers (schema.json `x-documentHash`): SHA-256 of the canonical JSON
/// (keys sorted by UTF-16 code units at every depth, JavaScript number formatting), lowercase hex.
pub fn document_hash(doc: &DesignDocument) -> String {
    let json = to_json(doc);
    let value: serde_json::Value = serde_json::from_str(&json).expect("the model writes JSON");
    let mut out = Vec::with_capacity(json.len());
    canonical(&value, &mut out);
    let digest = Sha256::digest(&out);
    digest.iter().map(|b| format!("{b:02x}")).collect()
}

fn canonical(value: &serde_json::Value, out: &mut Vec<u8>) {
    use serde_json::Value;
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            out.push(b'{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                out.extend_from_slice(to_json(key).as_bytes());
                out.push(b':');
                canonical(&map[key], out);
            }
            out.push(b'}');
        }
        Value::Array(items) => {
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                canonical(item, out);
            }
            out.push(b']');
        }
        other => out.extend_from_slice(to_json(other).as_bytes()),
    }
}
