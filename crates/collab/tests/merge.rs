//! OpsEngine against the Node route, op by op: the reference is lane L2a's port of `applyDocumentChange` and
//! `checkPatchedDocument` over JSON values (crates/ops), run exactly as `patchDesignDocument` runs them (merge
//! when the op carries `before` copies, store nothing for an empty result, refuse what the check refuses). The
//! engine skips the merge when nothing moved under the op and the patch passes as sent (crate::engine); this test
//! is what backs that shortcut. Random structural ops (moves, reparenting, adds, removals, reorders, pages, and
//! deliberately broken ones), on the current version and on older ones.

use morfa_collab::engine::{DocEngine, OpInput, OpsEngine};
use morfa_model::{DocumentPatch, Map, SceneNode, from_json_validated, patch_from_json, to_json};
use morfa_ops::{DocRead, Value};
use rand::rngs::StdRng;
use rand::seq::SliceRandom;
use rand::{Rng, SeedableRng};
use serde_json::{Value as Json, json};

fn node(id: &str, kind: &str, parent: Option<&str>) -> Json {
    let mut node = json!({
        "id": id, "type": kind, "name": id, "parentId": parent,
        "visible": true, "locked": false, "opacity": 1, "blendMode": "PASS_THROUGH", "isMask": false,
        "x": 0, "y": 0, "width": 100, "height": 50, "rotation": 0,
        "fills": [], "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE", "strokeCap": "NONE",
        "strokeJoin": "MITER", "strokeMiterLimit": 4, "dashPattern": [], "effects": [],
        "constraints": {"horizontal": "MIN", "vertical": "MIN"}, "layoutPositioning": "AUTO",
        "layoutSizingHorizontal": "FIXED", "layoutSizingVertical": "FIXED", "exportSettings": [], "reactions": []
    });
    if kind == "PAGE" || kind == "FRAME" || kind == "GROUP" {
        node["children"] = json!([]);
    }
    if kind == "PAGE" {
        node["backgroundColor"] = json!({"r": 0.96, "g": 0.96, "b": 0.96});
        node["guides"] = json!([]);
        node["flowStartingPoints"] = json!([]);
        node["prototypeDevice"] = json!({"type": "NONE"});
    }
    node
}

/// Two pages; each a few frames (some nested) of rectangles.
fn document(rng: &mut StdRng) -> Json {
    let mut nodes = serde_json::Map::new();
    let mut pages = Vec::new();
    for p in 0..2 {
        let page_id = format!("p{p}");
        let mut page = node(&page_id, "PAGE", None);
        for f in 0..3 {
            let frame_id = format!("f{p}{f}");
            let mut frame = node(&frame_id, "FRAME", Some(&page_id));
            for r in 0..rng.gen_range(1..4) {
                let id = format!("r{p}{f}{r}");
                nodes.insert(id.clone(), node(&id, "RECTANGLE", Some(&frame_id)));
                frame["children"].as_array_mut().unwrap().push(json!(id));
            }
            if f == 2 {
                let inner = format!("g{p}");
                let mut group = node(&inner, "FRAME", Some(&frame_id));
                let id = format!("r{p}x");
                nodes.insert(id.clone(), node(&id, "RECTANGLE", Some(&inner)));
                group["children"] = json!([id]);
                nodes.insert(inner.clone(), group);
                frame["children"].as_array_mut().unwrap().push(json!(inner));
            }
            nodes.insert(frame_id.clone(), frame);
            page["children"]
                .as_array_mut()
                .unwrap()
                .push(json!(frame_id));
        }
        nodes.insert(page_id.clone(), page);
        pages.push(json!(page_id));
    }
    json!({"schemaVersion": 1, "pages": pages, "nodes": nodes, "styles": {}, "images": {},
           "variableCollections": {}, "variables": {}})
}

fn children(doc: &Json, id: &str) -> Vec<String> {
    doc["nodes"][id]["children"]
        .as_array()
        .map(|c| c.iter().map(|v| v.as_str().unwrap().to_owned()).collect())
        .unwrap_or_default()
}

fn kind(doc: &Json, id: &str) -> String {
    doc["nodes"][id]["type"].as_str().unwrap_or("").to_owned()
}

/// A random op made on `doc`: `(patch, before copies)`.
fn random_op(doc: &Json, rng: &mut StdRng, fresh: &mut u32, moves: f64) -> Json {
    let ids: Vec<String> = doc["nodes"].as_object().unwrap().keys().cloned().collect();
    let layers: Vec<&String> = ids.iter().filter(|id| kind(doc, id) != "PAGE").collect();
    let containers: Vec<&String> = ids
        .iter()
        .filter(|id| matches!(kind(doc, id).as_str(), "FRAME" | "PAGE"))
        .collect();
    let mut nodes = serde_json::Map::new();
    let mut pages: Option<Json> = None;
    let get = |id: &str| doc["nodes"][id].clone();
    let pick = if rng.gen_bool(moves) {
        0
    } else {
        rng.gen_range(0..10)
    };
    // Everything removed: add.
    let pick = if layers.is_empty() { 4 } else { pick };
    match pick {
        // Move one to three layers.
        0..=2 => {
            for _ in 0..rng.gen_range(1..4) {
                let id = layers.choose(rng).unwrap().as_str();
                let mut n = nodes.get(id).cloned().unwrap_or_else(|| get(id));
                n["x"] = json!(n["x"].as_f64().unwrap() + rng.gen_range(-5..6) as f64);
                n["y"] = json!(rng.gen_range(0..3) as f64);
                nodes.insert(id.to_owned(), n);
            }
        }
        // Reparent a layer into another container (sometimes leaving its old parent's list stale).
        3 => {
            let id = layers.choose(rng).unwrap().as_str();
            let target = containers.choose(rng).unwrap().as_str();
            let old = get(id)["parentId"].as_str().unwrap().to_owned();
            if target != id && target != old {
                let mut n = get(id);
                n["parentId"] = json!(target);
                let mut t = get(target);
                let mut list = children(doc, target);
                list.insert(rng.gen_range(0..=list.len()), id.to_owned());
                t["children"] = json!(list);
                nodes.insert(target.to_owned(), t);
                if rng.gen_bool(0.85) {
                    let mut o = get(&old);
                    o["children"] = json!(
                        children(doc, &old)
                            .into_iter()
                            .filter(|c| c != id)
                            .collect::<Vec<_>>()
                    );
                    nodes.insert(old, o);
                }
                nodes.insert(id.to_owned(), n);
            }
        }
        // Add a layer (sometimes not listed in its parent).
        4 | 5 => {
            *fresh += 1;
            let id = format!("n{fresh}");
            let parent = containers.choose(rng).unwrap().as_str();
            let kind = if rng.gen_bool(0.3) {
                "FRAME"
            } else {
                "RECTANGLE"
            };
            nodes.insert(id.clone(), node(&id, kind, Some(parent)));
            if rng.gen_bool(0.9) {
                let mut p = get(parent);
                let mut list = children(doc, parent);
                list.insert(rng.gen_range(0..=list.len()), id);
                p["children"] = json!(list);
                nodes.insert(parent.to_owned(), p);
            }
        }
        // Remove a layer and what it holds (sometimes forgetting the parent's list or a child).
        6 => {
            let id = layers.choose(rng).unwrap().as_str();
            let parent = get(id)["parentId"].as_str().unwrap().to_owned();
            let mut stack = vec![id.to_owned()];
            while let Some(gone) = stack.pop() {
                stack.extend(children(doc, &gone));
                if gone == id || rng.gen_bool(0.95) {
                    nodes.insert(gone, Json::Null);
                }
            }
            if rng.gen_bool(0.9) {
                let mut p = get(&parent);
                p["children"] = json!(
                    children(doc, &parent)
                        .into_iter()
                        .filter(|c| c != id)
                        .collect::<Vec<_>>()
                );
                nodes.insert(parent, p);
            }
        }
        // Reorder a container's children.
        7 => {
            let id = containers.choose(rng).unwrap().as_str();
            let mut list = children(doc, id);
            list.shuffle(rng);
            let mut n = get(id);
            n["children"] = json!(list);
            nodes.insert(id.to_owned(), n);
        }
        // Pages: reorder, or add one.
        8 => {
            let mut order: Vec<String> = doc["pages"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_owned())
                .collect();
            if rng.gen_bool(0.5) {
                order.reverse();
            } else {
                *fresh += 1;
                let id = format!("page{fresh}");
                nodes.insert(id.clone(), node(&id, "PAGE", None));
                order.insert(rng.gen_range(0..=order.len()), id);
            }
            pages = Some(json!(order));
        }
        // A layer under a rectangle (never valid), or a cycle.
        _ => {
            let id = layers.choose(rng).unwrap().as_str();
            let target = layers.choose(rng).unwrap().as_str();
            if id != target {
                let mut n = get(id);
                n["parentId"] = json!(target);
                let mut t = get(target);
                let mut list = children(doc, target);
                list.push(id.to_owned());
                t["children"] = json!(list);
                nodes.insert(id.to_owned(), n);
                nodes.insert(target.to_owned(), t);
            }
        }
    }
    let mut patch = serde_json::Map::new();
    patch.insert("nodes".into(), Json::Object(nodes));
    if let Some(pages) = pages {
        patch.insert("pages".into(), pages);
    }
    Json::Object(patch)
}

fn canonical(value: &Value) -> String {
    fn sorted(value: Json) -> Json {
        match value {
            Json::Object(map) => {
                let mut entries: Vec<(String, Json)> = map.into_iter().collect();
                entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
                Json::Object(entries.into_iter().map(|(k, v)| (k, sorted(v))).collect())
            }
            Json::Array(items) => Json::Array(items.into_iter().map(sorted).collect()),
            other => other,
        }
    }
    sorted(serde_json::from_str(&value.to_json()).unwrap()).to_string()
}

fn copies(doc: &Json, patch: &Json) -> Json {
    let mut out = serde_json::Map::new();
    for id in patch["nodes"].as_object().unwrap().keys() {
        out.insert(
            id.clone(),
            doc["nodes"].get(id).cloned().unwrap_or(Json::Null),
        );
    }
    Json::Object(out)
}

/// What the Node route does with `change` on `current`: Err(path) for a refusal, else `(stored, next)`.
fn reference(current: &Value, change: &Value) -> Result<(Value, Value), String> {
    let patch = change.get("patch").unwrap();
    if morfa_ops::is_empty_patch(patch) {
        return Ok((Value::from_json("{}").unwrap(), current.clone()));
    }
    let applied = morfa_ops::apply_document_change(current, change);
    if morfa_ops::is_empty_patch(&applied.stored) {
        return Ok((applied.stored, current.clone()));
    }
    let count = applied.doc.size("nodes");
    match morfa_ops::check::check_patched_document(
        current,
        &applied.doc,
        &applied.stored,
        Some(&|| count),
    ) {
        Some(invalid) => Err(invalid.path),
        None => Ok((applied.stored, applied.doc)),
    }
}

/// One random history; `store`: the engine on the model's compact store (what actors run), else on the typed
/// document (the shadow path).
fn run(seed: u64, steps: usize, moves: f64, store: bool) -> (usize, usize, usize) {
    let mut rng = StdRng::seed_from_u64(seed);
    let start = document(&mut rng);
    let typed = from_json_validated(&start.to_string()).expect("a valid start");
    let mut engine = if store {
        OpsEngine::new_store(morfa_model::store::Document::from_model(&typed), 0, None)
    } else {
        OpsEngine::new(typed, 0)
    };
    // The documents by version, as JSON (to make ops on) and as the reference holds them.
    let mut history: Vec<Json> = vec![start];
    let mut fresh = 0;
    let (mut applied, mut refused, mut merged) = (0, 0, 0);
    for step in 0..steps {
        let current_version = history.len() - 1;
        // Mostly the current version; sometimes one or two behind (another editor's ops landed first).
        let behind = match rng.gen_range(0..10) {
            0..=5 => 0,
            6..=8 => 1,
            _ => 2,
        }
        .min(current_version);
        let base = current_version - behind;
        let made_on = &history[base];
        let patch_json = random_op(made_on, &mut rng, &mut fresh, moves);
        let with_before = behind > 0 || rng.gen_bool(0.8);
        let before_json = copies(made_on, &patch_json);
        let mut change = json!({"patch": patch_json});
        if with_before {
            change["before"] = before_json.clone();
        }

        // The engine.
        let patch = patch_from_json(&patch_json.to_string()).unwrap();
        let before: Option<Map<Option<SceneNode>>> = with_before.then(|| {
            patch_from_json(&json!({"nodes": before_json}).to_string())
                .unwrap()
                .nodes
                .unwrap_or_default()
        });
        let input = OpInput {
            base_version: base as u64,
            patch: &patch,
            before: before.as_ref(),
            before_tables: None,
        };
        let got = engine.apply(&input);

        // The Node route.
        let current = Value::from_json(&history[current_version].to_string()).unwrap();
        let expected = if !with_before && behind > 0 {
            Err("version_conflict".to_owned())
        } else {
            reference(&current, &Value::from_json(&change.to_string()).unwrap())
        };

        match (got, expected) {
            (Err(refusal), Err(path)) => {
                refused += 1;
                if path != "version_conflict" {
                    assert_eq!(
                        refusal.path.as_deref(),
                        Some(path.as_str()),
                        "step {step}: refusal path"
                    );
                }
            }
            (Ok(done), Ok((stored, next))) => {
                let stored_got = Value::from_json(&to_json(&*done.stored)).unwrap();
                // Canonical text (keys sorted at every depth), as the shadow comparison's document hash reads
                // documents: the typed model writes a node's fields in its own order, and the merge sorts entries.
                assert!(
                    canonical(&stored_got) == canonical(&stored),
                    "step {step}: stored\n engine {}\n node   {}\n change {change}",
                    stored_got.to_json(),
                    stored.to_json()
                );
                if done.adjusted {
                    merged += 1;
                }
                let doc_got = Value::from_json(&to_json(&*engine.document())).unwrap();
                assert!(
                    canonical(&doc_got) == canonical(&next),
                    "step {step}: documents differ\n change {change}"
                );
                if !morfa_ops::is_empty_patch(&stored) {
                    applied += 1;
                    assert_eq!(done.version as usize, current_version + 1);
                    history.push(serde_json::from_str(&next.to_json()).unwrap());
                } else {
                    assert_eq!(done.version as usize, current_version);
                }
            }
            (got, expected) => panic!(
                "step {step}: engine {:?}, node {:?}\n change {change}",
                got.map(|a| to_json(&*a.stored)),
                expected.map(|(s, _)| s.to_json())
            ),
        }
    }
    let _ = DocumentPatch::default();
    (applied, refused, merged)
}

#[test]
fn the_engine_stores_what_the_node_route_stores() {
    let mut totals = (0, 0, 0);
    for seed in 0..40 {
        let (a, r, m) = run(seed, 150, 0.0, seed % 2 == 1);
        totals = (totals.0 + a, totals.1 + r, totals.2 + m);
    }
    eprintln!(
        "applied {} (merged with adjustments {}), refused {}",
        totals.0, totals.2, totals.1
    );
    // The generator reaches every path.
    assert!(
        totals.0 > 1000 && totals.1 > 50 && totals.2 > 100,
        "{totals:?}"
    );
}

/// Mostly moves, often on older versions, between occasional structural ops: the merge-free path for ops made
/// before other in-place edits landed (crate::engine `nothing_to_merge`).
/// The same histories on both engines: the store-backed one stores what the typed one does.
#[test]
fn the_store_engine_stores_what_the_node_route_stores() {
    let mut totals = (0, 0, 0);
    for seed in 200..230 {
        let (a, r, m) = run(seed, 150, 0.3, true);
        totals = (totals.0 + a, totals.1 + r, totals.2 + m);
    }
    assert!(
        totals.0 > 1000 && totals.1 > 20 && totals.2 > 50,
        "{totals:?}"
    );
}

#[test]
fn stale_moves_store_what_the_node_route_stores() {
    let mut applied = 0;
    for seed in 100..130 {
        applied += run(seed, 200, 0.85, seed % 2 == 1).0;
    }
    assert!(applied > 3000, "{applied}");
}
