//! `morfa-storagesim`: a collab node reduced to what B2's storage sees (docs/BACKEND.md §2 apply pipeline from the
//! journal's side). Each file: take the lease, load cold, then apply deterministic ops at a steady rate, journal each
//! one with several in flight (the actor fans out before the commit), print an ack when its commit returns,
//! checkpoint every `checkpoint_every` versions once those versions are journaled, prune the rows below it. It
//! stops a file when its lease is lost or a journal write is fenced (`bye {moved}` in the real service).
//!
//! The documents and ops are deterministic ([`document`], [`op`], [`expected`]), so a test can rebuild the document
//! at any version on its own and compare it with what a new owner loads.

use morfa_model::DocumentPatch;
use morfa_model::store::Document;
use sha2::{Digest, Sha256};

/// One rectangle layer as the editor writes it.
pub fn layer(
    id: &str,
    kind: &str,
    parent: Option<&str>,
    x: f64,
    children: Option<&[String]>,
) -> String {
    let parent = parent.map_or("null".to_owned(), |p| format!("\"{p}\""));
    let children = children.map_or(String::new(), |c| {
        format!(
            ",\"children\":[{}]",
            c.iter()
                .map(|id| format!("\"{id}\""))
                .collect::<Vec<_>>()
                .join(",")
        )
    });
    format!(
        r#"{{"id":"{id}","type":"{kind}","name":"Layer {id}","parentId":{parent},"visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":{x},"y":-3,"width":100,"height":50,"rotation":0,"fills":[{{"type":"SOLID","color":{{"r":0.85,"g":0.85,"b":0.85}},"opacity":1,"visible":true,"blendMode":"NORMAL"}}],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{{"horizontal":"MIN","vertical":"MIN"}},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[]{children}}}"#
    )
}

fn rect(k: usize) -> String {
    format!("r{k}")
}

/// The document every simulated file starts as (version 1): a page with `rects` rectangles.
pub fn document(rects: usize) -> String {
    let ids: Vec<String> = (0..rects).map(rect).collect();
    let mut nodes = vec![format!(
        "\"page\":{}",
        layer("page", "PAGE", None, 0.0, Some(&ids))
    )];
    nodes.extend(ids.iter().enumerate().map(|(k, id)| {
        format!(
            "\"{id}\":{}",
            layer(id, "RECTANGLE", Some("page"), k as f64, None)
        )
    }));
    format!(
        r#"{{"schemaVersion":1,"pages":["page"],"nodes":{{{}}},"styles":{{}},"images":{{}},"variableCollections":{{}},"variables":{{}}}}"#,
        nodes.join(",")
    )
}

/// The op that makes `version` (≥ 2): `layers` rectangles moved (TARGETS §3: 20 per op, ~9 KB as JSON), whole nodes
/// as the editor sends them.
pub fn op_json(version: u64, rects: usize, layers: usize) -> String {
    let moved: Vec<String> = (0..layers.min(rects))
        .map(|j| {
            let k = (version as usize * 7 + j * 13) % rects;
            let id = rect(k);
            format!(
                "\"{id}\":{}",
                layer(
                    &id,
                    "RECTANGLE",
                    Some("page"),
                    version as f64 + j as f64 / 100.0,
                    None
                )
            )
        })
        .collect();
    format!(r#"{{"nodes":{{{}}}}}"#, moved.join(","))
}

pub fn op(version: u64, rects: usize, layers: usize) -> DocumentPatch {
    morfa_model::patch_from_json(&op_json(version, rects, layers)).expect("a valid op")
}

pub fn initial(rects: usize) -> Document {
    Document::from_model(
        &morfa_model::from_json_validated(&document(rects)).expect("a valid document"),
    )
}

/// The document at `version`, rebuilt from scratch.
pub fn expected(version: u64, rects: usize, layers: usize) -> Document {
    let mut doc = initial(rects);
    for v in 2..=version {
        doc.apply_patch(&op(v, rects, layers));
    }
    doc
}

/// A digest of a document's content (its JSON as types.ts writes it), equal for equal documents whatever their
/// interners' order.
pub fn digest(doc: &Document) -> String {
    let hash = Sha256::digest(morfa_model::to_json(&doc.to_model()).as_bytes());
    hash.iter().map(|b| format!("{b:02x}")).collect()
}
