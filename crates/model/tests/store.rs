//! The store and its codec on small documents: lossless to and from the JSON model, binary round trip, cheap
//! clones, patches. Every fixture goes through the same round trip in the Node harness (scripts/model/check.ts).

use morfa_model::store::{Document, Prop, PropKey};
use morfa_model::{DesignDocument, DocumentPatch, codec, from_json_validated, to_json};
use serde_json::{Value, json};
use std::sync::Arc;

fn node(id: &str, kind: &str, parent: Option<&str>) -> Value {
    json!({
        "id": id, "type": kind, "name": "Rectangle", "parentId": parent,
        "visible": true, "locked": false, "opacity": 1, "blendMode": "NORMAL", "isMask": false,
        "x": 10.5, "y": -3, "width": 100, "height": 50, "rotation": 0,
        "fills": [{"type": "SOLID", "color": {"r": 0.85, "g": 0.85, "b": 0.85}, "opacity": 1, "visible": true, "blendMode": "NORMAL"}],
        "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE", "strokeCap": "NONE", "strokeJoin": "MITER",
        "strokeMiterLimit": 4, "dashPattern": [], "effects": [],
        "constraints": {"horizontal": "MIN", "vertical": "MIN"}, "layoutPositioning": "AUTO",
        "layoutSizingHorizontal": "FIXED", "layoutSizingVertical": "FIXED", "exportSettings": [], "reactions": []
    })
}

/// A page and a frame holding a rectangle with nearly every optional field, a text and a vector.
fn rich() -> Value {
    let mut page = node("page", "PAGE", None);
    page["children"] = json!(["frame"]);
    page["guides"] = json!([{"axis": "X", "offset": 10}]);
    page["flowStartingPoints"] = json!([{"nodeId": "frame", "name": "Start"}]);
    page["prototypeDevice"] = json!({"type": "PRESET", "presetId": "iphone-15", "rotation": 90});
    page["measurements"] = json!([{"id": "m1", "start": {"nodeId": "rect", "side": "LEFT"}, "end": {"nodeId": "rect", "side": "RIGHT"},
                                   "offset": {"type": "OUTER", "fixed": 12}, "freeText": "width"}]);
    page["backgroundColor"] = json!({"r": 0.96, "g": 0.96, "b": 0.96});
    let mut frame = node("frame", "FRAME", Some("page"));
    frame["children"] = json!(["rect", "text", "vector"]);
    frame["autoLayout"] = json!({"layoutMode": "VERTICAL", "layoutWrap": "NO_WRAP", "primaryAxisAlignItems": "MIN", "counterAxisAlignItems": "CENTER",
        "counterAxisAlignContent": "AUTO", "paddingLeft": 8, "paddingRight": 8, "paddingTop": 4, "paddingBottom": 4, "itemSpacing": 12,
        "counterAxisSpacing": 0, "itemReverseZIndex": false, "strokesIncludedInLayout": false});
    frame["clipsContent"] = json!(true);
    frame["layoutGrids"] = json!([{"pattern": "COLUMNS", "alignment": "STRETCH", "count": 12, "gutterSize": 20, "offset": 0, "sectionSize": 10,
                                   "visible": true, "color": {"r": 1, "g": 0, "b": 0, "a": 0.1}}]);
    frame["overflowDirection"] = json!("VERTICAL");
    frame["overlayBackground"] =
        json!({"type": "SOLID_COLOR", "color": {"r": 0, "g": 0, "b": 0, "a": 0.5}});
    frame["effects"] = json!([{"type": "DROP_SHADOW", "color": {"r": 0, "g": 0, "b": 0, "a": 0.25}, "offset": {"x": 0, "y": 4}, "radius": 8,
                               "spread": 0, "visible": true, "blendMode": "NORMAL", "showShadowBehindNode": false},
                              {"type": "BACKGROUND_BLUR", "radius": 20, "visible": true}]);
    let mut rect = node("rect", "RECTANGLE", Some("frame"));
    rect["cornerRadius"] = json!(8);
    rect["rectangleCornerRadii"] = Value::Null;
    rect["minWidth"] = Value::Null;
    rect["maxWidth"] = json!(400);
    rect["dashPattern"] = json!([4, 2]);
    rect["fillStyleId"] = json!("S:brand");
    rect["boundVariables"] = json!({"width": {"type": "VARIABLE_ALIAS", "id": "v1"}});
    rect["strokes"] = json!([{"type": "GRADIENT_RADIAL", "opacity": 1, "visible": true, "blendMode": "NORMAL",
        "gradientStops": [{"position": 0, "color": {"r": 1, "g": 1, "b": 1, "a": 1}}, {"position": 1, "color": {"r": 0, "g": 0, "b": 0, "a": 1}}],
        "gradientHandlePositions": [{"x": 0.5, "y": 0.5}, {"x": 1, "y": 0.5}, {"x": 0.5, "y": 1}]},
        {"type": "IMAGE", "opacity": 1, "visible": true, "blendMode": "NORMAL", "imageRef": "", "scaleMode": "CROP",
         "imageTransform": [[1, 0, 0], [0, 1, 0]], "filters": {"exposure": 0.2}}]);
    rect["exportSettings"] =
        json!([{"format": "PNG", "suffix": "@2x", "constraint": {"type": "SCALE", "value": 2}}]);
    rect["reactions"] = json!([{"trigger": {"type": "AFTER_TIMEOUT", "timeout": 0.8}, "actions": [
        {"type": "NODE", "navigation": "NAVIGATE", "destinationId": "frame", "transition": {"type": "PUSH", "direction": "LEFT", "duration": 0.3, "easing": "EASE_OUT"}},
        {"type": "URL", "url": "https://example.com", "openInNewTab": true}, {"type": "BACK"}]}]);
    rect["annotations"] =
        json!([{"id": "a1", "label": "Padding 8", "properties": [{"type": "padding"}]}]);
    rect["pluginData"] = json!({"figma": "1:23"});
    rect["board"] = json!({"kind": "connector", "line": "elbow", "start": {"node": "text", "magnet": "auto"}, "end": {"x": 3, "y": 4}});
    let mut text = node("text", "TEXT", Some("frame"));
    text["text"] = json!({
        "characters": "Привет 😀\nмир", "runs": [{"start": 0, "end": 6, "style": {"fontWeight": 700, "hyperlink": null}, "fills": []}],
        "style": {"fontFamily": "Inter", "fontWeight": 400, "italic": false, "fontSize": 16, "lineHeight": {"unit": "PIXELS", "value": 24},
                  "letterSpacing": {"unit": "PERCENT", "value": 0}, "textDecoration": "NONE", "textCase": "ORIGINAL",
                  "hyperlink": {"type": "URL", "url": "mailto:a@b.c"}},
        "textAlignHorizontal": "LEFT", "textAlignVertical": "TOP", "textAutoResize": "HEIGHT",
        "paragraphSpacing": 0, "paragraphIndent": 0, "listTypes": ["UNORDERED", "NONE"], "maxLines": null
    });
    let mut vector = node("vector", "VECTOR", Some("frame"));
    vector["vectorPaths"] = json!([{"windingRule": "EVENODD", "commands": [{"type": "M", "x": 0, "y": 0}, {"type": "C", "x1": 1, "y1": 2, "x2": 3, "y2": 4, "x": 5, "y": 6},
                                                                        {"type": "Q", "x1": 1, "y1": 1, "x": 2, "y": 2}, {"type": "Z"}]}]);
    vector["strokeStartMarker"] = json!("NONE");
    vector["strokeEndMarker"] = json!("TRIANGLE_ARROW");
    vector["variableWidthStrokeProperties"] =
        json!({"widthProfile": "CUSTOM", "variableWidthPoints": [{"position": 0, "width": 1}]});
    json!({
        "schemaVersion": 1, "pages": ["page"],
        "nodes": {"page": page, "frame": frame, "rect": rect, "text": text, "vector": vector},
        "styles": {"S:brand": {"id": "S:brand", "type": "FILL", "name": "Brand/Primary", "description": "",
                               "paints": [{"type": "SOLID", "color": {"r": 0.2, "g": 0.4, "b": 1}, "opacity": 1, "visible": true, "blendMode": "NORMAL",
                                           "boundVariables": {}}]}},
        "images": {"img1": {"url": "/uploads/img1.png", "width": 800, "height": 600, "name": "Photo"}},
        "variableCollections": {"c1": {"id": "c1", "name": "Colors", "modes": [{"modeId": "m1", "name": "Light"}], "defaultModeId": "m1", "variableIds": ["v1"]}},
        "variables": {"v1": {"id": "v1", "name": "Width", "collectionId": "c1", "type": "FLOAT", "description": "",
                             "valuesByMode": {"m1": 320}}},
        "variableModes": {"frame": {"c1": "m1"}},
        "board": true
    })
}

fn model() -> DesignDocument {
    from_json_validated(&rich().to_string()).expect("the rich document is valid")
}

#[test]
fn model_to_store_and_back_is_lossless() {
    let model = model();
    let store = Document::from_model(&model);
    assert_eq!(store.len(), 5);
    assert_eq!(store.to_model(), model);
    let written: Value = serde_json::from_str(&to_json(&store.to_model())).unwrap();
    assert_eq!(written, rich());
}

#[test]
fn ids_and_names_are_interned() {
    let store = Document::from_model(&model());
    let frame = store.node_by_key("frame").unwrap();
    let rect = store.node_by_key("rect").unwrap();
    assert_eq!(rect.parent, Some(frame.id));
    assert_eq!(
        frame.children(),
        [
            store.id("rect").unwrap(),
            store.id("text").unwrap(),
            store.id("vector").unwrap()
        ]
    );
    // Every node shares one "Rectangle".
    assert!(store.nodes().all(|node| node.name == rect.name));
    assert_eq!(store.atom(rect.name), "Rectangle");
    assert_eq!(rect.props.corner_radius(), Some(&8.0));
    assert_eq!(rect.props.min_width(), Some(&None));
    assert_eq!(rect.props.max_width(), Some(&Some(400.0)));
}

#[test]
fn binary_round_trip() {
    let store = Document::from_model(&model());
    let bytes = codec::encode(&store);
    let decoded = codec::decode(&bytes).unwrap();
    assert_eq!(decoded, store);
    assert_eq!(decoded.to_model(), model());
    assert!(
        bytes.len() < to_json(&model()).len() / 2,
        "{} bytes",
        bytes.len()
    );
}

#[test]
fn damaged_frames_are_refused() {
    let bytes = codec::encode(&Document::from_model(&model()));
    assert_eq!(codec::decode(b"nope"), Err(codec::CodecError::NotAFrame));
    let mut other = bytes.clone();
    other[4] = 9;
    assert!(matches!(
        codec::decode(&other),
        Err(codec::CodecError::Format(9))
    ));
    for cut in [7, bytes.len() / 2, bytes.len() - 1] {
        assert!(codec::decode(&bytes[..cut]).is_err(), "cut at {cut}");
    }
    // Every single-byte change either decodes to some document or is refused; none panics.
    for at in 6..bytes.len() {
        let mut flipped = bytes.clone();
        flipped[at] ^= 0x5a;
        let _ = codec::decode(&flipped);
    }
}

#[test]
fn clones_share_unchanged_nodes() {
    let mut store = Document::from_model(&model());
    let snapshot = store.clone();
    let rect = store.id("rect").unwrap();
    let text = store.id("text").unwrap();
    store.node_mut(rect).unwrap().x = 99.0;
    store
        .node_mut(rect)
        .unwrap()
        .props
        .set(Prop::CornerRadius(2.0));
    assert!(!Arc::ptr_eq(
        store.node_arc(rect).unwrap(),
        snapshot.node_arc(rect).unwrap()
    ));
    assert!(Arc::ptr_eq(
        store.node_arc(text).unwrap(),
        snapshot.node_arc(text).unwrap()
    ));
    assert_eq!(snapshot.node(rect).unwrap().x, 10.5);
    assert_eq!(store.node(rect).unwrap().props.corner_radius(), Some(&2.0));
    // The text's props (its TextProps) are still the same allocation in both versions.
    let shared = |doc: &Document| doc.node(text).unwrap().props.text().cloned().unwrap();
    assert!(Arc::ptr_eq(&shared(&store), &shared(&snapshot)));
    store
        .node_mut(rect)
        .unwrap()
        .props
        .remove(PropKey::CornerRadius);
    assert_eq!(store.node(rect).unwrap().props.corner_radius(), None);
}

#[test]
fn patches_apply_as_on_the_model() {
    let mut model = model();
    let mut store = Document::from_model(&model);
    let mut frame = model.nodes["frame"].clone();
    frame.children = Some(vec!["text".into(), "vector".into(), "new".into()]);
    let mut new = model.nodes["rect"].clone();
    new.id = "new".into();
    new.name = "New".into();
    let patch: DocumentPatch = serde_json::from_value(json!({
        "nodes": {"rect": null, "frame": serde_json::to_value(&frame).unwrap(), "new": serde_json::to_value(&new).unwrap()},
        "styles": {"S:brand": null},
        "variableModes": {"frame": null}
    }))
    .unwrap();
    patch.apply(&mut model);
    store.apply_patch(&patch);
    assert_eq!(store.to_model(), model);
    assert!(store.node_by_key("rect").is_none());
    assert_eq!(store.len(), 5);
}

#[test]
fn journal_entries_rebuild_the_document() {
    let model = model();
    let snapshot = Document::from_model(&model);
    let mut live = snapshot.clone();
    let mut expected = model.clone();
    let mut journal = Vec::new();
    // Three commits: move a node, add one with new strings, remove one and drop a mode choice.
    let mut rect = model.nodes["rect"].clone();
    rect.x = 42.0;
    let mut added = model.nodes["text"].clone();
    added.id = "added".into();
    added.name = "Brand new layer".into();
    let mut frame = model.nodes["frame"].clone();
    frame.children = Some(vec![
        "rect".into(),
        "text".into(),
        "vector".into(),
        "added".into(),
    ]);
    let patches: Vec<DocumentPatch> = vec![
        serde_json::from_value(json!({"nodes": {"rect": serde_json::to_value(&rect).unwrap()}})).unwrap(),
        serde_json::from_value(json!({"nodes": {"added": serde_json::to_value(&added).unwrap(), "frame": serde_json::to_value(&frame).unwrap()},
                                      "styles": {"S:new": {"id": "S:new", "type": "EFFECT", "name": "Drop shadow", "description": "", "effects": []}}}))
        .unwrap(),
        serde_json::from_value(json!({"nodes": {"vector": null, "frame": serde_json::to_value(&{
            let mut frame = frame.clone();
            frame.children = Some(vec!["rect".into(), "text".into(), "added".into()]);
            frame
        }).unwrap()}, "variableModes": {"frame": null, "never-seen": null}, "pages": ["page"]}))
        .unwrap(),
    ];
    for patch in &patches {
        patch.apply(&mut expected);
        journal.push(live.commit(patch).to_bytes());
    }
    assert_eq!(live.to_model(), expected);
    morfa_model::validate_document(&expected).unwrap();
    // Snapshot bytes + the journal rebuild the live document exactly, symbols included.
    let mut rebuilt = codec::decode(&codec::encode(&snapshot)).unwrap();
    for record in &journal {
        rebuilt
            .replay(&morfa_model::store::Entry::from_bytes(record).unwrap())
            .unwrap();
    }
    assert_eq!(rebuilt, live);
    // An entry replayed twice, or out of order, is refused.
    let second = morfa_model::store::Entry::from_bytes(&journal[1]).unwrap();
    assert!(rebuilt.replay(&second).is_err());
    // Only the strings a commit introduces travel with it.
    let entry = morfa_model::store::Entry::from_bytes(&journal[0]).unwrap();
    assert!(entry.new_ids.is_empty() && entry.new_atoms.is_empty());
    let json = serde_json::to_string(&patches[0]).unwrap().len();
    assert!(
        journal[0].len() * 3 < json,
        "{} bytes against {json} of JSON",
        journal[0].len()
    );
}
