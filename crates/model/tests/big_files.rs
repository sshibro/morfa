//! The big-files switch (crates/model src/limits.rs, docs/decisions/big-files.md §1): its own test binary, because
//! the switch is process-wide.

use morfa_model::limits::{big_files, caps, set_big_files};
use morfa_model::{from_json_validated, patch_from_json_validated};
use serde_json::{Value, json};

fn node(id: &str, kind: &str, parent: Option<&str>) -> Value {
    json!({
        "id": id, "type": kind, "name": id, "parentId": parent,
        "visible": true, "locked": false, "opacity": 1, "blendMode": "PASS_THROUGH", "isMask": false,
        "x": 0, "y": 0, "width": 100, "height": 50, "rotation": 0,
        "fills": [], "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE", "strokeCap": "NONE", "strokeJoin": "MITER",
        "strokeMiterLimit": 4, "dashPattern": [], "effects": [],
        "constraints": {"horizontal": "MIN", "vertical": "MIN"}, "layoutPositioning": "AUTO",
        "layoutSizingHorizontal": "FIXED", "layoutSizingVertical": "FIXED", "exportSettings": [], "reactions": []
    })
}

/// A page with `n` rectangles: `n + 1` layers.
fn document(n: usize) -> String {
    let mut nodes = serde_json::Map::new();
    let mut children = Vec::with_capacity(n);
    for i in 0..n {
        let id = format!("r{i}");
        nodes.insert(id.clone(), node(&id, "RECTANGLE", Some("page")));
        children.push(Value::String(id));
    }
    let mut page = node("page", "PAGE", None);
    page["children"] = Value::Array(children);
    nodes.insert("page".into(), page);
    json!({
        "schemaVersion": 1, "pages": ["page"], "nodes": nodes,
        "styles": {}, "images": {}, "variableCollections": {}, "variables": {}
    })
    .to_string()
}

#[test]
fn the_switch_moves_the_caps() {
    set_big_files(Some(false));
    assert!(!big_files());
    assert_eq!(caps::nodes(), caps::NODES);
    assert_eq!(caps::pages(), caps::PAGES);
    assert_eq!(caps::bytes(), caps::BYTES);
    let past_the_cap = document(caps::NODES);
    let refused =
        from_json_validated(&past_the_cap).expect_err("50 001 layers refused with the switch off");
    assert_eq!(refused.path, "nodes");
    assert_eq!(
        refused.message,
        format!("The file has more than {} layers.", caps::NODES)
    );
    let removals = format!(
        "{{\"nodes\":{{{}}}}}",
        (0..=caps::NODES)
            .map(|i| format!("\"n{i}\":null"))
            .collect::<Vec<_>>()
            .join(",")
    );
    assert!(
        patch_from_json_validated(&removals).is_err(),
        "a patch past the cap is refused"
    );

    set_big_files(Some(true));
    assert!(big_files());
    assert_eq!(caps::nodes(), caps::big::NODES);
    assert_eq!(caps::pages(), caps::big::PAGES);
    assert_eq!(caps::bytes(), caps::big::BYTES);
    let doc =
        from_json_validated(&past_the_cap).expect("50 001 layers accepted with the switch on");
    assert_eq!(doc.nodes.len(), caps::NODES + 1);
    assert!(patch_from_json_validated(&removals).is_ok());

    // Unset: the environment decides (unset in this test binary → the default).
    set_big_files(None);
    assert_eq!(
        big_files(),
        morfa_model::limits::DEFAULT_BIG_FILES
            || std::env::var("MORFA_BIG_FILES").is_ok_and(|v| v == "1")
    );
}
