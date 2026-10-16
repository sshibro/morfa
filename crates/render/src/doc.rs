//! The render document: the stored document the painter reads, plus what the painter needs beside it — decoded
//! pictures (with their filtered copies and mips), text sprites (text painted by the host at a scale, since text
//! drawing is lane L3's), and the page-space bounds of every node of a page (culling, effect sizes).

use crate::bounds::{TextBounds, recombine_ancestors, subtree_render_bounds, world_matrix};
use crate::paint::{apply_image_filters, filters_key, neutral_filters};
use crate::sink::Picture;
use kurbo::{Affine, Rect};
use morfa_model::store::Document;
use morfa_model::store::{Id, ImageFilters, Symbol};
use morfa_model::{DocumentPatch, NodeType};
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

/// Text painted by the host (Canvas2D, L3's glyphs) at one scale: straight-alpha RGBA8 covering the local
/// rectangle `rect` (local units, the text's own region) at `scale` device px per local px.
#[derive(Debug, Clone)]
pub struct Sprite {
    pub scale: f64,
    pub rect: Rect,
    /// The pixels as a flat picture (no mips): the backends draw it as an image.
    pub picture: Arc<Picture>,
    /// Revision of the host's fonts when painted (a loaded face repaints).
    pub revision: u32,
}

#[derive(Default)]
struct PageBounds {
    page: Option<Id>,
    rects: Vec<Option<Rect>>,
    /// Nodes whose subtree bounds must be recomputed before the next ask (patched nodes, texts whose sprite
    /// changed); `full`: everything (a load, a page change, every sprite dropped).
    dirty: HashSet<Id>,
    full: bool,
}

/// The document the painter reads and everything it needs beside it.
pub struct RenderDoc {
    doc: Document,
    /// +1 per change (load, patch).
    version: u64,
    pictures: HashMap<String, Arc<Picture>>,
    /// Filtered copies of pictures by (ref, filters key).
    filtered: RefCell<HashMap<(String, String), Arc<Picture>>>,
    checker: Arc<Picture>,
    sprites: HashMap<Id, Vec<Sprite>>,
    sprite_bytes: usize,
    sprite_budget: usize,
    sprites_version: u64,
    bounds: PageBounds,
    /// `blur_margin` of (page, version), the last asked.
    blur_reach: std::cell::Cell<Option<((Id, u64), f64)>>,
}

impl Default for RenderDoc {
    fn default() -> Self {
        RenderDoc::new(Document::default())
    }
}

impl RenderDoc {
    pub fn new(doc: Document) -> RenderDoc {
        RenderDoc {
            doc,
            version: 0,
            pictures: HashMap::new(),
            filtered: RefCell::new(HashMap::new()),
            checker: Arc::new(crate::paint::checker_picture()),
            sprites: HashMap::new(),
            sprite_bytes: 0,
            sprite_budget: 96 * 1024 * 1024,
            sprites_version: 0,
            bounds: PageBounds::default(),
            blur_reach: std::cell::Cell::new(None),
        }
    }

    pub fn document(&self) -> &Document {
        &self.doc
    }

    pub fn version(&self) -> u64 {
        self.version
    }

    /// Replaces the document (a load).
    pub fn load(&mut self, doc: Document) {
        self.doc = doc;
        self.version += 1;
        self.sprites.clear();
        self.sprite_bytes = 0;
        self.bounds.full = true;
    }

    /// A part of a document being loaded (`load_part`): applied without a version step of its own.
    pub fn load_part(&mut self, patch: &DocumentPatch) {
        self.doc.apply_patch(patch);
        self.version += 1;
        self.bounds.full = true;
    }

    /// One committed patch, as the store applied it: the patched nodes' subtrees (and their old and new places)
    /// are what the next bounds sync recomputes.
    pub fn apply_patch(&mut self, patch: &DocumentPatch) {
        if let Some(nodes) = &patch.nodes {
            for key in nodes.keys() {
                if let Some(id) = self.doc.id(key) {
                    self.drop_sprites(id);
                    self.bounds.dirty.insert(id);
                }
            }
        }
        self.doc.apply_patch(patch);
        self.version += 1;
        if let Some(nodes) = &patch.nodes {
            for key in nodes.keys() {
                if let Some(id) = self.doc.id(key) {
                    self.bounds.dirty.insert(id);
                }
            }
        }
        if patch.nodes.is_none() {
            self.bounds.full = true;
        }
    }

    pub fn page_ids(&self) -> Vec<Id> {
        self.doc.pages.clone()
    }

    pub fn id(&self, key: &str) -> Option<Id> {
        self.doc.id(key)
    }

    pub fn key(&self, id: Id) -> &str {
        self.doc.key(id)
    }

    // ── Pictures ──

    /// Registers a decoded picture (straight-alpha RGBA8) under its image ref.
    pub fn register_picture(&mut self, image_ref: &str, width: u32, height: u32, rgba: Vec<u8>) {
        self.pictures.insert(
            image_ref.to_owned(),
            Arc::new(Picture::new(width, height, rgba)),
        );
        self.filtered
            .borrow_mut()
            .retain(|(r, _), _| r != image_ref);
    }

    pub fn has_picture(&self, image_ref: &str) -> bool {
        self.pictures.contains_key(image_ref)
    }

    pub fn checker(&self) -> &Arc<Picture> {
        &self.checker
    }

    /// The picture for a paint, with its filters applied (cached), or None while it is not registered.
    pub fn picture(&self, image_ref: &str, filters: Option<&ImageFilters>) -> Option<Arc<Picture>> {
        let base = self.pictures.get(image_ref)?;
        if neutral_filters(filters) {
            return Some(Arc::clone(base));
        }
        let filters = filters.expect("non-neutral filters");
        let key = (image_ref.to_owned(), filters_key(filters));
        if let Some(found) = self.filtered.borrow().get(&key) {
            return Some(Arc::clone(found));
        }
        let mut rgba = base.rgba.as_ref().clone();
        apply_image_filters(&mut rgba, filters);
        let picture = Arc::new(Picture::new(base.width, base.height, rgba));
        self.filtered.borrow_mut().insert(key, Arc::clone(&picture));
        Some(picture)
    }

    pub fn picture_bytes(&self) -> usize {
        self.pictures.values().map(|p| p.bytes()).sum::<usize>()
            + self
                .filtered
                .borrow()
                .values()
                .map(|p| p.bytes())
                .sum::<usize>()
    }

    // ── Text sprites ──

    /// Keeps a text sprite for a node at a scale (replacing one at that scale).
    pub fn set_sprite(&mut self, id: Id, sprite: Sprite) {
        let list = self.sprites.entry(id).or_default();
        if let Some(pos) = list.iter().position(|s| s.scale == sprite.scale) {
            self.sprite_bytes -= list[pos].picture.bytes();
            list.remove(pos);
        }
        self.sprite_bytes += sprite.picture.bytes();
        list.push(sprite);
        self.sprites_version += 1;
        self.bounds.dirty.insert(id);
        if self.sprite_bytes > self.sprite_budget {
            self.trim_sprites();
        }
    }

    fn trim_sprites(&mut self) {
        // Drop the sprites at scales other than the latest ones first; simple and bounded.
        let mut entries: Vec<(Id, usize, u32)> = Vec::new();
        for (id, list) in &self.sprites {
            for (k, s) in list.iter().enumerate() {
                entries.push((*id, k, s.revision));
            }
        }
        entries.sort_by_key(|e| e.2);
        for (id, _, _) in entries {
            if self.sprite_bytes <= self.sprite_budget / 2 {
                break;
            }
            if let Some(list) = self.sprites.get_mut(&id) {
                if let Some(s) = list.pop() {
                    self.sprite_bytes -= s.picture.bytes();
                }
                if list.is_empty() {
                    self.sprites.remove(&id);
                }
                self.bounds.dirty.insert(id);
            }
        }
    }

    pub fn set_sprite_budget(&mut self, bytes: usize) {
        self.sprite_budget = bytes;
        if self.sprite_bytes > bytes {
            self.trim_sprites();
        }
    }

    pub fn drop_sprites(&mut self, id: Id) {
        if let Some(list) = self.sprites.remove(&id) {
            self.sprite_bytes -= list.iter().map(|s| s.picture.bytes()).sum::<usize>();
            self.sprites_version += 1;
            self.bounds.dirty.insert(id);
        }
    }

    pub fn clear_sprites(&mut self) {
        self.sprites.clear();
        self.sprite_bytes = 0;
        self.sprites_version += 1;
        self.bounds.full = true;
    }

    pub fn sprite_bytes(&self) -> usize {
        self.sprite_bytes
    }

    /// The sprite of a text at exactly `scale`, else the nearest one (drawn resampled), else None.
    pub fn sprite(&self, id: Id, scale: f64) -> Option<&Sprite> {
        let list = self.sprites.get(&id)?;
        if let Some(exact) = list.iter().find(|s| s.scale == scale) {
            return Some(exact);
        }
        list.iter().min_by(|a, b| {
            let da = (a.scale / scale).ln().abs();
            let db = (b.scale / scale).ln().abs();
            da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
        })
    }

    pub fn has_sprite_at(&self, id: Id, scale: f64, revision: u32) -> bool {
        self.sprites.get(&id).is_some_and(|list| {
            list.iter()
                .any(|s| s.scale == scale && s.revision == revision)
        })
    }

    /// Text nodes under `area` (page space) of `page` that have no sprite at `scale` with the host's font
    /// `revision`: what the host must paint before the tile.
    pub fn sprites_needed(&mut self, page: Id, area: Rect, scale: f64, revision: u32) -> Vec<Id> {
        self.sync_bounds(page);
        // A walk from the page pruned by the subtree bounds: a tile of a 500 000-layer page asks about the few
        // texts under it, not every node (the bounds of a hidden or empty subtree are None: nothing under it paints).
        let mut out = Vec::new();
        let Some(page_node) = self.doc.node(page) else {
            return out;
        };
        let mut stack: Vec<Id> = page_node.children.as_deref().unwrap_or(&[]).to_vec();
        while let Some(id) = stack.pop() {
            let Some(rect) = self.bounds.rects.get(id.index()).copied().flatten() else {
                continue;
            };
            if !rect.overlaps(area) {
                continue;
            }
            let Some(node) = self.doc.node(id) else {
                continue;
            };
            if node.kind == NodeType::Text {
                if node.visible && !self.has_sprite_at(id, scale, revision) {
                    out.push(id);
                }
                continue;
            }
            if let Some(children) = &node.children {
                stack.extend(children.iter().copied());
            }
        }
        out
    }

    // ── Bounds ──

    /// Brings the page bounds up to date: everything after a load or a page change, else only the subtrees of the
    /// nodes patched or re-sprited since the last ask and their ancestors (an edit on a 500 000-layer page costs the
    /// edited subtree and its path to the page, not the page).
    pub fn sync_bounds(&mut self, page: Id) {
        let text = SpriteBounds {
            sprites: &self.sprites,
        };
        if self.bounds.page != Some(page) || self.bounds.full {
            let mut rects: Vec<Option<Rect>> = vec![None; self.doc.slots()];
            if let Some(node) = self.doc.node(page) {
                if let Some(children) = &node.children {
                    for &child in children.iter() {
                        if let Some(child_node) = self.doc.node(child) {
                            let world = crate::bounds::local_matrix(child_node);
                            subtree_render_bounds(&self.doc, child_node, world, &text, &mut rects);
                        }
                    }
                }
            }
            self.bounds = PageBounds {
                page: Some(page),
                rects,
                dirty: HashSet::new(),
                full: false,
            };
            return;
        }
        if self.bounds.dirty.is_empty() {
            return;
        }
        let dirty: Vec<Id> = self.bounds.dirty.drain().collect();
        let rects = &mut self.bounds.rects;
        if rects.len() < self.doc.slots() {
            rects.resize(self.doc.slots(), None);
        }
        // The subtrees first (a dirty node under another dirty node is simply computed twice), then the paths up.
        let mut on_page: Vec<Id> = Vec::with_capacity(dirty.len());
        for id in dirty {
            match self.doc.node(id) {
                Some(node)
                    if page_of(&self.doc, id) == Some(page) && node.kind != NodeType::Page =>
                {
                    let world = world_matrix(&self.doc, id);
                    subtree_render_bounds(&self.doc, node, world, &text, rects);
                    on_page.push(id);
                }
                _ => {
                    // Gone, or on another page now: nothing of it paints here.
                    if let Some(slot) = rects.get_mut(id.index()) {
                        *slot = None;
                    }
                }
            }
        }
        for id in on_page {
            recombine_ancestors(&self.doc, id, &text, rects);
        }
    }

    /// Page-space bounds of a node's subtree on the synced page.
    pub fn bounds_of(&self, id: Id) -> Option<Rect> {
        self.bounds.rects.get(id.index()).copied().flatten()
    }

    /// The painted area of a whole page (the union of its children), or None for an empty page.
    pub fn page_area(&mut self, page: Id) -> Option<Rect> {
        self.sync_bounds(page);
        let node = self.doc.node(page)?;
        let mut area: Option<Rect> = None;
        for &child in node.children.as_deref().unwrap_or(&[]) {
            if let Some(r) = self.bounds_of(child) {
                area = Some(area.map_or(r, |a| a.union(r)));
            }
        }
        area
    }

    pub fn world_matrix(&self, id: Id) -> Affine {
        world_matrix(&self.doc, id)
    }

    /// The largest background blur on the page, as page px it reads around itself (tiles raster with this margin).
    /// Computed once per document version and page (a tile's raster asks every time).
    pub fn blur_margin(&self, page: Id) -> f64 {
        let key = (page, self.version);
        if let Some((k, reach)) = self.blur_reach.get() {
            if k == key {
                return reach;
            }
        }
        let reach = self.compute_blur_margin(page);
        self.blur_reach.set(Some((key, reach)));
        reach
    }

    fn compute_blur_margin(&self, page: Id) -> f64 {
        let mut reach: f64 = 0.0;
        let Some(page_node) = self.doc.node(page) else {
            return 0.0;
        };
        let mut stack: Vec<Id> = page_node.children.as_deref().unwrap_or(&[]).to_vec();
        while let Some(id) = stack.pop() {
            let Some(node) = self.doc.node(id) else {
                continue;
            };
            if !node.visible {
                continue;
            }
            for effect in node.effects.as_slice() {
                if let morfa_model::store::Effect::Blur(b) = effect {
                    if b.visible && b.kind == morfa_model::store::BlurKind::Background {
                        reach = reach.max(crate::bounds::blur_reach(b.radius));
                    }
                }
            }
            if let Some(children) = &node.children {
                stack.extend(children.iter().copied());
            }
        }
        reach
    }

    pub fn memory_bytes(&self) -> usize {
        self.picture_bytes()
            + self.sprite_bytes
            + self.bounds.rects.len() * std::mem::size_of::<Option<Rect>>()
    }
}

/// The page a node is on (None for a node without one).
fn page_of(doc: &Document, id: Id) -> Option<Id> {
    let mut at = id;
    for _ in 0..100_000 {
        let node = doc.node(at)?;
        if node.kind == NodeType::Page {
            return Some(at);
        }
        at = node.parent?;
    }
    None
}

struct SpriteBounds<'a> {
    sprites: &'a HashMap<Id, Vec<Sprite>>,
}

impl TextBounds for SpriteBounds<'_> {
    fn text_bounds(&self, id: Id) -> Option<Rect> {
        self.sprites.get(&id)?.first().map(|s| s.rect)
    }
}

#[cfg(test)]
mod tests {
    //! The incremental bounds against a full recomputation: every patch kind the store sends (a moved leaf, a moved
    //! frame with its subtree, a hidden group, a removed node, an added node, an effect added), on the `social`
    //! starter template, every node's rect equal to a fresh document's.

    use super::*;
    use morfa_model::DocumentPatch;
    use serde_json::{Value, json};

    const SOCIAL: &str = include_str!("../../render-service/tests/fixtures/social.json");

    fn render_doc_of(value: &Value) -> RenderDoc {
        let design = morfa_model::from_json(&value.to_string()).expect("the fixture parses");
        RenderDoc::new(Document::from(&design))
    }

    /// Applies `nodes` (a node's JSON, or null to remove it) to the JSON oracle and as a patch to `doc`.
    fn patch(doc: &mut RenderDoc, oracle: &mut Value, nodes: Value) {
        for (key, node) in nodes.as_object().expect("nodes") {
            if node.is_null() {
                oracle["nodes"].as_object_mut().unwrap().remove(key);
            } else {
                oracle["nodes"][key] = node.clone();
            }
        }
        let parsed: DocumentPatch =
            serde_json::from_value(json!({"nodes": nodes})).expect("a patch");
        doc.apply_patch(&parsed);
    }

    fn same_bounds(doc: &mut RenderDoc, oracle: &Value, what: &str) {
        let mut fresh = render_doc_of(oracle);
        let page = doc.page_ids()[0];
        let fresh_page = fresh.page_ids()[0];
        doc.sync_bounds(page);
        fresh.sync_bounds(fresh_page);
        let keys: Vec<String> = oracle["nodes"]
            .as_object()
            .unwrap()
            .keys()
            .cloned()
            .collect();
        for key in keys {
            let a = doc.id(&key).and_then(|id| doc.bounds_of(id));
            let b = fresh.id(&key).and_then(|id| fresh.bounds_of(id));
            let close = match (a, b) {
                (None, None) => true,
                (Some(a), Some(b)) => {
                    (a.x0 - b.x0).abs() < 1e-9
                        && (a.y0 - b.y0).abs() < 1e-9
                        && (a.x1 - b.x1).abs() < 1e-9
                        && (a.y1 - b.y1).abs() < 1e-9
                }
                _ => false,
            };
            assert!(close, "{what}: {key} incremental {a:?} vs full {b:?}");
        }
        assert_eq!(
            doc.page_area(page),
            fresh.page_area(fresh_page),
            "{what}: the page area"
        );
    }

    #[test]
    fn patches_keep_the_bounds_of_a_full_recomputation() {
        let mut oracle: Value = serde_json::from_str(SOCIAL).unwrap();
        let mut doc = render_doc_of(&oracle);
        same_bounds(&mut doc, &oracle, "fresh");

        // A leaf moves (an ellipse in the icon row).
        let mut leaf = oracle["nodes"]["5hlra9owsx"].clone();
        leaf["x"] = json!(leaf["x"].as_f64().unwrap() + 37.0);
        patch(&mut doc, &mut oracle, json!({"5hlra9owsx": leaf}));
        same_bounds(&mut doc, &oracle, "a moved leaf");

        // A frame moves with everything under it.
        let mut frame = oracle["nodes"]["i1qljnxrm8"].clone();
        frame["x"] = json!(frame["x"].as_f64().unwrap() - 120.0);
        frame["y"] = json!(frame["y"].as_f64().unwrap() + 15.0);
        patch(&mut doc, &mut oracle, json!({"i1qljnxrm8": frame}));
        same_bounds(&mut doc, &oracle, "a moved frame");

        // A container hidden, then shown again.
        let mut hidden = oracle["nodes"]["ral6kvk7s5"].clone();
        hidden["visible"] = json!(false);
        patch(&mut doc, &mut oracle, json!({"ral6kvk7s5": hidden.clone()}));
        same_bounds(&mut doc, &oracle, "a hidden frame");
        hidden["visible"] = json!(true);
        patch(&mut doc, &mut oracle, json!({"ral6kvk7s5": hidden}));
        same_bounds(&mut doc, &oracle, "shown again");

        // A drop shadow on a text's frame: its bounds reach further than its children.
        let mut shadowed = oracle["nodes"]["sp418pt0rf"].clone();
        shadowed["effects"] = json!([{"type": "DROP_SHADOW", "visible": true, "color": {"r": 0, "g": 0, "b": 0, "a": 0.5}, "offset": {"x": 10, "y": 20}, "radius": 30, "spread": 4, "blendMode": "NORMAL"}]);
        patch(&mut doc, &mut oracle, json!({"sp418pt0rf": shadowed}));
        same_bounds(&mut doc, &oracle, "a shadow added");

        // A node removed: the leaf goes, its parent's children list without it.
        let mut parent = oracle["nodes"]["ral6kvk7s5"].clone();
        let children: Vec<Value> = parent["children"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c.as_str() != Some("mxag9d849m"))
            .cloned()
            .collect();
        parent["children"] = Value::Array(children);
        patch(
            &mut doc,
            &mut oracle,
            json!({"mxag9d849m": null, "ral6kvk7s5": parent}),
        );
        same_bounds(&mut doc, &oracle, "a removed node");

        // A node added far away from its siblings: the new id, its parent's list with it.
        let mut added = oracle["nodes"]["5hlra9owsx"].clone();
        added["id"] = json!("new-ellipse");
        added["x"] = json!(2000.0);
        added["y"] = json!(-500.0);
        let mut parent = oracle["nodes"]["ral6kvk7s5"].clone();
        parent["children"]
            .as_array_mut()
            .unwrap()
            .push(json!("new-ellipse"));
        patch(
            &mut doc,
            &mut oracle,
            json!({"new-ellipse": added, "ral6kvk7s5": parent}),
        );
        same_bounds(&mut doc, &oracle, "an added node");

        // A text's sprite gives it bounds of its own; dropping it takes them back.
        let text = doc.id("kac621dddp").unwrap();
        let page = doc.page_ids()[0];
        doc.sync_bounds(page);
        let before = doc.bounds_of(text);
        doc.set_sprite(
            text,
            Sprite {
                scale: 1.0,
                rect: Rect::new(-50.0, -50.0, 900.0, 300.0),
                picture: Arc::new(Picture::flat(1, 1, vec![0; 4])),
                revision: 1,
            },
        );
        doc.sync_bounds(page);
        let with = doc.bounds_of(text);
        assert_ne!(before, with, "the sprite widens the text");
        assert!(
            with.unwrap().width() >= 949.0,
            "the sprite's rect in page space: {with:?}"
        );
        doc.drop_sprites(text);
        same_bounds(&mut doc, &oracle, "the sprite dropped");
    }
}
