//! The store's binary codec (postcard, `codec`) and its journal records (`Entry::to_bytes`) round-trip: a document
//! with nearly every optional field, a generated document of a few thousand nodes, a slab with holes, the small
//! fixtures, and journal entries; damaged frames are refused without a panic. (The bincode and rkyv variants compared
//! ran through these same tests in commit 122e59c.)

use morfa_model::store::{Document, Entry};
use morfa_model::{DesignDocument, DocumentPatch, codec, from_json, from_json_validated};
use serde_json::{Value, json};
use std::path::Path;

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

fn text_props(characters: &str) -> Value {
    json!({
        "characters": characters, "runs": [{"start": 0, "end": 1, "style": {"fontWeight": 700, "hyperlink": null}, "fills": []}],
        "style": {"fontFamily": "Inter", "fontWeight": 400, "italic": false, "fontSize": 16, "lineHeight": {"unit": "PIXELS", "value": 24},
                  "letterSpacing": {"unit": "PERCENT", "value": 0}, "textDecoration": "NONE", "textCase": "ORIGINAL",
                  "hyperlink": {"type": "URL", "url": "mailto:a@b.c"}},
        "textAlignHorizontal": "LEFT", "textAlignVertical": "TOP", "textAutoResize": "HEIGHT",
        "paragraphSpacing": 0, "paragraphIndent": 0, "listTypes": ["UNORDERED", "NONE"], "maxLines": null
    })
}

/// A page and a frame holding a rectangle with nearly every optional field, a text and a vector (as tests/store.rs).
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
    text["text"] = text_props("Привет 😀\nмир");
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

/// Two pages of `frames` frames, each holding a rectangle, a text, an ellipse and a vector with varied values.
fn generated(frames: usize) -> Value {
    let mut nodes = serde_json::Map::new();
    let mut pages = Vec::new();
    for page_index in 0..2 {
        let page_id = format!("page-{page_index}");
        let mut page = node(&page_id, "PAGE", None);
        let mut page_children = Vec::new();
        for f in 0..frames / 2 {
            let frame_id = format!("{page_index}:{f}");
            let mut frame = node(&frame_id, "FRAME", Some(&page_id));
            frame["name"] = json!(format!("Screen {f}"));
            frame["x"] = json!((f % 40) as f64 * 420.0);
            frame["y"] = json!((f / 40) as f64 * 900.0 + 0.25);
            frame["clipsContent"] = json!(f % 3 == 0);
            if f % 2 == 0 {
                frame["autoLayout"] = json!({"layoutMode": "VERTICAL", "layoutWrap": "NO_WRAP", "primaryAxisAlignItems": "MIN",
                    "counterAxisAlignItems": "CENTER", "counterAxisAlignContent": "AUTO", "paddingLeft": 8, "paddingRight": 8,
                    "paddingTop": 4, "paddingBottom": 4, "itemSpacing": f % 17, "counterAxisSpacing": 0,
                    "itemReverseZIndex": false, "strokesIncludedInLayout": false});
            }
            let kids: Vec<String> = ["rect", "text", "ellipse", "vector"]
                .iter()
                .map(|kind| format!("{frame_id}-{kind}"))
                .collect();
            let mut rect = node(&kids[0], "RECTANGLE", Some(&frame_id));
            rect["cornerRadius"] = json!(f % 12);
            rect["fills"][0]["color"] = json!({"r": (f % 255) as f64 / 255.0, "g": 0.5, "b": 0.25});
            let mut text = node(&kids[1], "TEXT", Some(&frame_id));
            text["name"] = json!(format!("Heading {}", f % 50));
            text["text"] = text_props(&format!("Text number {f}"));
            let mut ellipse = node(&kids[2], "ELLIPSE", Some(&frame_id));
            ellipse["width"] = json!(1.0 / (f as f64 + 3.0));
            let mut vector = node(&kids[3], "VECTOR", Some(&frame_id));
            vector["vectorPaths"] = json!([{"windingRule": "NONZERO", "commands": [{"type": "M", "x": 0, "y": f},
                {"type": "L", "x": 10, "y": 3.5}, {"type": "Z"}]}]);
            frame["children"] = json!(kids);
            for (key, value) in kids.iter().zip([rect, text, ellipse, vector]) {
                nodes.insert(key.clone(), value);
            }
            nodes.insert(frame_id.clone(), frame);
            page_children.push(frame_id);
        }
        page["children"] = json!(page_children);
        nodes.insert(page_id.clone(), page);
        pages.push(page_id);
    }
    json!({"schemaVersion": 1, "pages": pages, "nodes": nodes, "styles": {}, "images": {}, "variableCollections": {}, "variables": {}})
}

fn model(doc: &Value) -> DesignDocument {
    from_json_validated(&doc.to_string()).expect("the test document is valid")
}

fn round_trip(doc: &Document, model: &DesignDocument) {
    let bytes = codec::encode(doc);
    let decoded = codec::decode(&bytes).unwrap_or_else(|error| panic!("{error}"));
    assert!(decoded == *doc, "the decoded store differs");
    assert!(decoded.to_model() == *model, "the decoded model differs");
    // Encoding is deterministic: the decoded document writes the same bytes.
    assert!(codec::encode(&decoded) == bytes, "re-encoding differs");
}

#[test]
fn rich_document_round_trips() {
    let model = model(&rich());
    round_trip(&Document::from_model(&model), &model);
}

#[test]
fn generated_document_round_trips() {
    let model = model(&generated(800));
    let doc = Document::from_model(&model);
    assert_eq!(doc.len(), 4002);
    round_trip(&doc, &model);
}

#[test]
fn edited_documents_round_trip() {
    // Holes in the slab (removed nodes) and nodes put after them.
    let model = model(&generated(40));
    let mut doc = Document::from_model(&model);
    let mut expected = model.clone();
    let patch: DocumentPatch = serde_json::from_value(json!({
        "nodes": {"0:3-rect": null, "0:3-text": null, "0:3": serde_json::to_value({
            let mut frame = model.nodes["0:3"].clone();
            frame.children = Some(vec!["0:3-ellipse".into(), "0:3-vector".into()]);
            frame
        }).unwrap()}
    }))
    .unwrap();
    patch.apply(&mut expected);
    doc.apply_patch(&patch);
    round_trip(&doc, &expected);
}

#[test]
fn small_fixtures_round_trip() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/documents");
    let Ok(entries) = std::fs::read_dir(&dir) else {
        eprintln!("no fixtures at {}", dir.display());
        return;
    };
    let mut seen = 0;
    for entry in entries.flatten() {
        let path = entry.path();
        let name = path.file_name().unwrap().to_string_lossy().into_owned();
        // The large ones run in the bench (release); debug builds keep to the small ones.
        if !name.ends_with(".json")
            || name == "index.json"
            || entry.metadata().unwrap().len() > 1 << 20
        {
            continue;
        }
        let model = from_json_validated(&std::fs::read_to_string(&path).unwrap())
            .unwrap_or_else(|error| panic!("{name}: {error:?}"));
        round_trip(&Document::from_model(&model), &model);
        seen += 1;
    }
    eprintln!("{seen} fixtures");
}

#[test]
fn journal_entries_round_trip() {
    let model = model(&generated(20));
    let mut doc = Document::from_model(&model);
    let snapshot = doc.clone();
    let mut moved = model.nodes["0:1-rect"].clone();
    moved.x += 7.5;
    let mut added = model.nodes["0:2-text"].clone();
    added.id = "new-text".into();
    added.name = "New text".into();
    added.parent_id = Some("0:2".into());
    let mut frame = model.nodes["0:2"].clone();
    frame.children.as_mut().unwrap().push("new-text".into());
    let patches: Vec<DocumentPatch> = vec![
        serde_json::from_value(json!({"nodes": {"0:1-rect": serde_json::to_value(&moved).unwrap()}})).unwrap(),
        serde_json::from_value(json!({"nodes": {"new-text": serde_json::to_value(&added).unwrap(), "0:2": serde_json::to_value(&frame).unwrap()},
                                      "styles": {"S:new": {"id": "S:new", "type": "EFFECT", "name": "Drop shadow", "description": "", "effects": []}},
                                      "variableModes": {"0:2": {"c": "m"}}}))
        .unwrap(),
        serde_json::from_value(json!({"nodes": {"0:4-vector": null}, "styles": {"S:new": null}, "pages": ["page-1", "page-0"]})).unwrap(),
    ];
    let entries: Vec<Entry> = patches.iter().map(|patch| doc.commit(patch)).collect();
    let mut rebuilt = snapshot.clone();
    for entry in &entries {
        let decoded = Entry::from_bytes(&entry.to_bytes()).unwrap();
        assert!(decoded == *entry, "the decoded entry differs");
        rebuilt.replay(&decoded).unwrap();
    }
    assert!(rebuilt == doc, "replay differs");
    // A symbol past what the entry may refer to is refused: an entry claiming no earlier strings.
    let mut lying = entries[0].clone();
    lying.ids_before = 0;
    lying.atoms_before = 0;
    assert!(
        Entry::from_bytes(&lying.to_bytes()).is_err(),
        "out-of-range symbol accepted"
    );
}

#[test]
fn damaged_frames_are_refused_without_panicking() {
    let model = model(&rich());
    let doc = Document::from_model(&model);
    let bytes = codec::encode(&doc);
    assert_eq!(
        codec::decode(b"nope").err(),
        Some(codec::CodecError::NotAFrame)
    );
    let mut other = bytes.clone();
    other[4] = 9;
    assert_eq!(
        codec::decode(&other).err(),
        Some(codec::CodecError::Format(9))
    );
    for cut in [7, 8, bytes.len() / 2, bytes.len() - 1] {
        assert!(codec::decode(&bytes[..cut]).is_err(), "cut at {cut}");
    }
    // Every single-byte change either decodes to some document or is refused; none panics. Symbols never end up out
    // of range: every decoded document converts back to the JSON model.
    for at in 6..bytes.len() {
        for mask in [0x01, 0x5a, 0xff] {
            let mut flipped = bytes.clone();
            flipped[at] ^= mask;
            if let Ok(decoded) = codec::decode(&flipped) {
                let _ = decoded.to_model();
            }
        }
    }
}

/// Lane N1 step 12: bytes written by the codec before the grid fields (main 82bf1ae; `tests/fixtures/pre-step-11`,
/// dumped by that crate's own tests) still decode in this crate and mean the same document — the appended variants and
/// props are append-safe, and `codec::FORMAT` stays 1. The same document encodes to the same bytes today, and the
/// journal records of that day replay to the document they led to.
#[test]
fn pre_step_11_bytes_still_decode() {
    const DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/pre-step-11/");
    let bytes = |name: &str| std::fs::read(format!("{DIR}{name}")).expect(name);
    let text = |name: &str| std::fs::read_to_string(format!("{DIR}{name}")).expect(name);
    let model = from_json_validated(&text("rich.json")).expect("the fixture is valid");
    let stored = bytes("rich.bin");
    let decoded = codec::decode(&stored).unwrap_or_else(|error| panic!("rich: {error}"));
    assert!(
        decoded.to_model() == model,
        "rich: the decoded model differs from the JSON of the day"
    );
    assert!(
        codec::encode(&Document::from_model(&model)) == stored,
        "rich: today's bytes differ"
    );
    assert!(
        codec::encode(&decoded) == stored,
        "rich: re-encoding differs"
    );
    let base = from_json_validated(&text("journal-base.json")).expect("valid");
    let mut doc = Document::from_model(&base);
    for i in 0..3 {
        let entry = Entry::from_bytes(&bytes(&format!("journal-entry-{i}.bin")))
            .unwrap_or_else(|error| panic!("entry {i}: {error}"));
        doc.replay(&entry)
            .unwrap_or_else(|error| panic!("entry {i} replay: {error:?}"));
    }
    // The third record deletes a layer its frame still lists (as the round-trip test of the day did): read unvalidated.
    let after = from_json(&text("journal-after.json")).expect("the JSON of the day parses");
    assert!(
        doc.to_model() == after,
        "the replayed document differs from the document of the day"
    );
    assert!(
        codec::decode(&bytes("journal-after.bin")).unwrap() == doc,
        "the stored document after the journal differs"
    );
}

/// Bytes written before lane G's step 3 (the board's new fields, appended without a FORMAT bump): the kitchen sink and the
/// board with every object, encoded by main's codec at 1fa8d42, still decode to the model of the same JSON, and re-encode to
/// the same bytes.
#[test]
fn bytes_written_before_the_board_fields_still_decode() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/tables");
    for name in ["kitchen-sink", "board-everything"] {
        let json = std::fs::read_to_string(dir.join(format!("{name}.pre-g3.json"))).expect("json");
        let bytes = std::fs::read(dir.join(format!("{name}.pre-g3.bin"))).expect("bytes");
        let model = from_json_validated(&json).unwrap_or_else(|error| panic!("{name}: {error}"));
        let decoded = codec::decode(&bytes).unwrap_or_else(|error| panic!("{name}: {error}"));
        assert!(
            decoded.to_model() == model,
            "{name}: the old bytes decode to another model"
        );
        assert!(
            codec::encode(&decoded) == bytes,
            "{name}: the old bytes re-encode differently"
        );
    }
}
