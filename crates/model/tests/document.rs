//! Reading, validating and writing documents without Node: a small valid file, then one change at a time that
//! `validateDocument` (shared/design/schema.ts) accepts or refuses. The full parity run against zod is the Node
//! harness (`npx tsx scripts/model/check.ts --all`).

use morfa_model::{
    DocumentPatch, NodeType, Paint, from_json, from_json_validated, patch_from_json_validated,
    to_json,
};
use serde_json::{Value, json};

fn node(id: &str, kind: &str, parent: Option<&str>) -> Value {
    json!({
        "id": id, "type": kind, "name": id, "parentId": parent,
        "visible": true, "locked": false, "opacity": 1, "blendMode": "PASS_THROUGH", "isMask": false,
        "x": 0, "y": 0, "width": 100, "height": 50, "rotation": 0,
        "fills": [{"type": "SOLID", "color": {"r": 1, "g": 0.5, "b": 0}, "opacity": 1, "visible": true, "blendMode": "NORMAL"}],
        "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE", "strokeCap": "NONE", "strokeJoin": "MITER",
        "strokeMiterLimit": 4, "dashPattern": [], "effects": [],
        "constraints": {"horizontal": "MIN", "vertical": "MIN"}, "layoutPositioning": "AUTO",
        "layoutSizingHorizontal": "FIXED", "layoutSizingVertical": "FIXED", "exportSettings": [], "reactions": []
    })
}

/// A page holding a frame holding a rectangle and a text.
fn document() -> Value {
    let mut page = node("page", "PAGE", None);
    page["children"] = json!(["frame"]);
    let mut frame = node("frame", "FRAME", Some("page"));
    frame["children"] = json!(["rect", "text"]);
    let rect = node("rect", "RECTANGLE", Some("frame"));
    let mut text = node("text", "TEXT", Some("frame"));
    text["text"] = json!({
        "characters": "Привет 😀", "runs": [{"start": 0, "end": 6, "style": {"fontWeight": 700}}],
        "style": {"fontFamily": "Inter", "fontWeight": 400, "italic": false, "fontSize": 16, "lineHeight": {"unit": "AUTO"},
                  "letterSpacing": {"unit": "PERCENT", "value": 0}, "textDecoration": "NONE", "textCase": "ORIGINAL"},
        "textAlignHorizontal": "LEFT", "textAlignVertical": "TOP", "textAutoResize": "WIDTH_AND_HEIGHT",
        "paragraphSpacing": 0, "paragraphIndent": 0
    });
    json!({
        "schemaVersion": 1, "pages": ["page"],
        "nodes": {"page": page, "frame": frame, "rect": rect, "text": text},
        "styles": {}, "images": {}, "variableCollections": {}, "variables": {}
    })
}

fn verdict(doc: &Value) -> Result<(), String> {
    from_json_validated(&doc.to_string())
        .map(|_| ())
        .map_err(|error| error.to_string())
}

fn accepts(change: impl FnOnce(&mut Value)) {
    let mut doc = document();
    change(&mut doc);
    if let Err(error) = verdict(&doc) {
        panic!("refused: {error}\n{doc:#}");
    }
}

fn refuses(change: impl FnOnce(&mut Value)) {
    let mut doc = document();
    change(&mut doc);
    assert!(verdict(&doc).is_err(), "accepted:\n{doc:#}");
}

#[test]
fn reads_validates_and_writes_back() {
    let doc = from_json_validated(&document().to_string()).unwrap();
    assert_eq!(doc.nodes.len(), 4);
    assert_eq!(doc.nodes["frame"].kind, NodeType::Frame);
    assert!(matches!(doc.nodes["rect"].fills[0], Paint::Solid(_)));
    let written: Value = serde_json::from_str(&to_json(&doc)).unwrap();
    assert_eq!(written, document());
    assert!(
        to_json(&doc).contains(r#""width":100,"#),
        "integers are written without .0"
    );
}

#[test]
fn drops_unknown_keys_as_zod_strips_them() {
    let mut doc = document();
    doc["extra"] = json!(1);
    doc["nodes"]["rect"]["cache"] = json!({"anything": [1, 2]});
    doc["nodes"]["rect"]["fills"][0]["gradientStops"] = json!("not read for a SOLID paint");
    let read = from_json_validated(&doc.to_string()).unwrap();
    let written: Value = serde_json::from_str(&to_json(&read)).unwrap();
    assert_eq!(written, document());
}

#[test]
fn shape() {
    refuses(|doc| doc["nodes"]["rect"]["fills"][0]["color"] = json!([1, 0.5, 0]));
    refuses(|doc| doc["nodes"]["rect"]["blendMode"] = json!({"NORMAL": null}));
    refuses(|doc| doc["nodes"]["rect"]["blendMode"] = json!("normal"));
    refuses(|doc| doc["nodes"]["rect"]["maskType"] = Value::Null);
    accepts(|doc| doc["nodes"]["rect"]["minWidth"] = Value::Null);
    refuses(|doc| {
        doc["nodes"]["rect"]
            .as_object_mut()
            .unwrap()
            .remove("parentId")
            .map(|_| ())
            .unwrap()
    });
    refuses(|doc| doc["nodes"]["rect"]["fills"][0]["type"] = json!("GRADIENT_LINEAR"));
    refuses(|doc| doc["nodes"]["rect"]["fills"] = json!([[]]));
    refuses(|doc| doc["nodes"]["rect"]["rectangleCornerRadii"] = json!([1, 2, 3]));
    accepts(|doc| doc["nodes"]["rect"]["rectangleCornerRadii"] = json!([1, 2, 3, 4]));
    refuses(|doc| doc["schemaVersion"] = json!(2));
    refuses(|doc| doc["board"] = json!(false));
    accepts(|doc| doc["board"] = json!(true));
}

#[test]
fn bounds() {
    refuses(|doc| doc["nodes"]["rect"]["opacity"] = json!(1.01));
    refuses(|doc| doc["nodes"]["rect"]["x"] = json!(1e9 + 1.0));
    accepts(|doc| doc["nodes"]["rect"]["x"] = json!(-1e9));
    refuses(|doc| doc["nodes"]["rect"]["width"] = json!(-0.5));
    // Cyrillic letters count as one UTF-16 unit each (two UTF-8 bytes).
    refuses(|doc| doc["nodes"]["rect"]["name"] = json!("ж".repeat(501)));
    accepts(|doc| doc["nodes"]["rect"]["name"] = json!("ж".repeat(500)));
    refuses(|doc| doc["nodes"]["rect"]["name"] = json!("😀".repeat(251)));
    refuses(|doc| doc["nodes"]["rect"]["fillStyleId"] = json!("bad id"));
    refuses(|doc| doc["nodes"]["rect"]["fillStyleId"] = json!("__proto__"));
    refuses(|doc| doc["nodes"]["text"]["text"]["runs"][0]["end"] = json!(5.5));
    refuses(|doc| doc["nodes"]["rect"]["pluginData"] = json!({"__proto__": "x"}));
    accepts(|doc| doc["nodes"]["rect"]["pluginData"] = json!({"Иконка#12": "x"}));
    refuses(|doc| doc["nodes"]["rect"]["fills"][0]["color"]["r"] = json!(2));
}

#[test]
fn urls() {
    let link = |url: &str| json!({"trigger": {"type": "ON_CLICK"}, "actions": [{"type": "URL", "url": url, "openInNewTab": true}]});
    accepts(|doc| doc["nodes"]["rect"]["reactions"] = json!([link("https://example.com")]));
    accepts(|doc| doc["nodes"]["rect"]["reactions"] = json!([link("mailto:a@b.c")]));
    refuses(|doc| doc["nodes"]["rect"]["reactions"] = json!([link("javascript:alert(1)")]));
    refuses(|doc| doc["nodes"]["rect"]["reactions"] = json!([link("http://exa mple.com")]));
    refuses(|doc| doc["images"] = json!({"img": {"url": "/uploads/..", "width": 1, "height": 1}}));
    accepts(|doc| {
        doc["images"] = json!({"img": {"url": "/uploads/a.png", "width": 1, "height": 1}})
    });
}

#[test]
fn unions_take_the_first_option_that_passes() {
    // An rgba out of range with alias keys is the alias; in range it is the colour (the alias keys dropped).
    let variable = |value: Value| json!({"v": {"id": "v", "name": "v", "collectionId": "c", "type": "COLOR", "description": "", "valuesByMode": {"m": value}}});
    let mut doc = document();
    doc["variables"] =
        variable(json!({"r": 2, "g": 0, "b": 0, "a": 1, "type": "VARIABLE_ALIAS", "id": "x"}));
    let read = from_json_validated(&doc.to_string()).unwrap();
    assert_eq!(
        serde_json::to_value(&read.variables["v"].values_by_mode["m"]).unwrap(),
        json!({"type": "VARIABLE_ALIAS", "id": "x"})
    );
    doc["variables"] =
        variable(json!({"r": 1, "g": 0, "b": 0, "a": 1, "type": "VARIABLE_ALIAS", "id": "x"}));
    let read = from_json_validated(&doc.to_string()).unwrap();
    assert_eq!(
        serde_json::to_value(&read.variables["v"].values_by_mode["m"]).unwrap(),
        json!({"r": 1.0, "g": 0.0, "b": 0.0, "a": 1.0})
    );
    // A connector end with a bad node id but valid coordinates is the point.
    accepts(
        |doc| doc["nodes"]["rect"]["board"] = json!({"kind": "connector", "line": "straight", "start": {"node": "bad id", "magnet": "auto", "x": 1, "y": 2}, "end": {"x": 0, "y": 0}}),
    );
    refuses(
        |doc| doc["nodes"]["rect"]["board"] = json!({"kind": "connector", "line": "straight", "start": {"node": "bad id", "magnet": "auto"}, "end": {"x": 0, "y": 0}}),
    );
}

#[test]
fn invariants() {
    refuses(|doc| doc["nodes"]["frame"]["children"] = json!(["rect"]));
    refuses(|doc| doc["nodes"]["frame"]["children"] = json!(["rect", "text", "rect"]));
    refuses(|doc| doc["nodes"]["rect"]["parentId"] = json!("page"));
    refuses(|doc| doc["nodes"]["rect"]["children"] = json!([]));
    refuses(|doc| {
        doc["nodes"]["frame"]
            .as_object_mut()
            .unwrap()
            .remove("children")
            .map(|_| ())
            .unwrap()
    });
    refuses(|doc| doc["pages"] = json!(["page", "page"]));
    refuses(|doc| doc["pages"] = json!(["frame"]));
    refuses(|doc| doc["pages"] = json!([]));
    refuses(|doc| doc["nodes"]["text"]["text"]["runs"][0]["end"] = json!(11));
    accepts(|doc| doc["nodes"]["text"]["text"]["runs"][0]["end"] = json!(9));
    refuses(|doc| doc["nodes"]["rect"]["text"] = doc["nodes"]["text"]["text"].clone());
    refuses(|doc| doc["nodes"]["rect"]["mainId"] = json!("x"));
    refuses(|doc| doc["nodes"]["rect"]["measurements"] = json!([]));
    accepts(|doc| doc["nodes"]["page"]["measurements"] = json!([]));
    refuses(|doc| doc["nodes"]["page"]["annotations"] = json!([]));
    refuses(|doc| {
        doc["nodes"]["rect"]["annotations"] =
            json!([{"id": "a", "label": ""}, {"id": "a", "label": ""}])
    });
    refuses(|doc| {
        doc["nodes"]["rect"]["remote"] =
            json!({"libraryId": "0".repeat(36), "key": "k", "version": 1})
    });
    refuses(|doc| doc["nodes"]["rect"]["id"] = json!("other"));
    // A cycle away from every page: the links agree, but nothing reaches it.
    refuses(|doc| {
        let mut a = node("a", "FRAME", Some("b"));
        a["children"] = json!(["b"]);
        let mut b = node("b", "FRAME", Some("a"));
        b["children"] = json!(["a"]);
        doc["nodes"]["a"] = a;
        doc["nodes"]["b"] = b;
    });
}

#[test]
fn deep_nesting_is_refused_without_recursion() {
    let mut doc = document();
    let mut parent = "frame".to_owned();
    for level in 0..300 {
        let id = format!("g{level}");
        doc["nodes"][&parent]["children"]
            .as_array_mut()
            .unwrap()
            .push(json!(id));
        let mut frame = node(&id, "FRAME", Some(&parent));
        frame["children"] = json!([]);
        doc["nodes"][&id] = frame;
        parent = id;
    }
    let error = verdict(&doc).unwrap_err();
    assert!(error.to_lowercase().contains("nesting"), "{error}");
}

#[test]
fn instances() {
    let mut doc = document();
    doc["nodes"]["frame"]["type"] = json!("INSTANCE");
    doc["nodes"]["frame"]["componentId"] = json!("c");
    for child in ["rect", "text"] {
        let copy = format!("frame;{child}");
        let mut value = doc["nodes"][child].take();
        value["id"] = json!(copy);
        value["mainId"] = json!(child);
        doc["nodes"].as_object_mut().unwrap().remove(child);
        doc["nodes"][&copy] = value;
    }
    doc["nodes"]["frame"]["children"] = json!(["frame;rect", "frame;text"]);
    assert_eq!(verdict(&doc), Ok(()));
    doc["nodes"]["frame;rect"]["mainId"] = json!("other");
    assert!(verdict(&doc).unwrap_err().contains("outside its instance"));
}

#[test]
fn patches() {
    let patch = json!({"nodes": {"rect": null, "frame": document()["nodes"]["frame"]}, "pages": ["page"], "variableModes": {"frame": {"c": "m"}}});
    let read = patch_from_json_validated(&patch.to_string()).unwrap();
    assert!(read.nodes.as_ref().unwrap()["rect"].is_none());
    assert!(patch_from_json_validated(r#"{"pages": []}"#).is_err());
    assert!(patch_from_json_validated(r#"{"nodes": {"bad id": null}}"#).is_err());
    assert!(patch_from_json_validated(r#"{"nodes": null}"#).is_err());

    let mut doc = from_json(&document().to_string()).unwrap();
    let mut frame = doc.nodes["frame"].clone();
    frame.children = Some(vec!["text".into()]);
    let patch = DocumentPatch {
        nodes: Some(
            [("rect".to_owned(), None), ("frame".to_owned(), Some(frame))]
                .into_iter()
                .collect(),
        ),
        ..DocumentPatch::default()
    };
    assert!(!patch.is_empty());
    patch.apply(&mut doc);
    assert_eq!(
        doc.nodes.keys().collect::<Vec<_>>(),
        ["page", "frame", "text"]
    );
    morfa_model::validate_document(&doc).unwrap();
}

#[test]
fn reads_what_json_parse_reads() {
    // A repeated key: the last value wins (and only it is validated).
    let text = document().to_string().replacen(
        r#""horizontal":"MIN""#,
        r#""horizontal":"MAX","horizontal":"MIN""#,
        1,
    );
    assert_eq!(from_json_validated(&text).map(|_| ()), Ok(()));
    let text = document().to_string().replacen(
        r#""horizontal":"MIN""#,
        r#""horizontal":"MIN","horizontal":"NOPE""#,
        1,
    );
    assert!(from_json_validated(&text).is_err());
    // A number beyond f64 is ±Infinity: dropped with an unknown key, refused in a known one.
    let text =
        document()
            .to_string()
            .replacen(r#""rotation":0"#, r#""rotation":0,"unknown":1e400"#, 1);
    assert_eq!(from_json_validated(&text).map(|_| ()), Ok(()));
    let text = document()
        .to_string()
        .replacen(r#""rotation":0"#, r#""rotation":-1e400"#, 1);
    assert!(from_json_validated(&text).is_err());
    let text =
        document()
            .to_string()
            .replacen(r#""type":"SOLID""#, r#""type":"SOLID","extra":1e999"#, 1);
    assert_eq!(from_json_validated(&text).map(|_| ()), Ok(()));
    // Still no struct from an array on this path.
    let text = document().to_string().replacen(
        r#""rotation":0"#,
        r#""rotation":0,"x":1e400,"constraints":["MIN","MIN"]"#,
        1,
    );
    assert!(from_json_validated(&text).is_err());
}

#[test]
fn deep_values_under_stripped_keys_and_tuple_lengths() {
    let deep = |levels: usize| format!("{}1{}", "[".repeat(levels), "]".repeat(levels));
    // Inside a union object (a paint), on a node, and in a document that also takes the JSON.parse path.
    for levels in [130, 1100, 20_000] {
        let text = document().to_string().replacen(
            r#""type":"SOLID""#,
            &format!(r#""type":"SOLID","deep":{}"#, deep(levels)),
            1,
        );
        assert_eq!(
            from_json_validated(&text).map(|_| ()),
            Ok(()),
            "{levels} levels in a paint"
        );
        let text = document().to_string().replacen(
            r#""rotation":0"#,
            &format!(r#""rotation":0,"deep":{}"#, deep(levels)),
            1,
        );
        assert_eq!(
            from_json_validated(&text).map(|_| ()),
            Ok(()),
            "{levels} levels on a node"
        );
        let text = text.replacen(r#""locked":false"#, r#""locked":1,"locked":false"#, 1);
        assert_eq!(
            from_json_validated(&text).map(|_| ()),
            Ok(()),
            "{levels} levels with a repeated key"
        );
    }
    // A fixed-length tuple refuses extra items on both paths.
    let text = document().to_string().replacen(
        r#""rotation":0"#,
        r#""rotation":0,"rectangleCornerRadii":[1,2,3,4,5]"#,
        1,
    );
    assert!(from_json_validated(&text).is_err());
    let text = text.replacen(r#""locked":false"#, r#""locked":1,"locked":false"#, 1);
    assert!(from_json_validated(&text).is_err());
}

/// The board's new fields, each optional, bounded as zod bounds them
/// (tests/design-board-fields.test.ts holds the same cases for `validateDocument`).
#[test]
fn board_fields_of_step_three() {
    let connector = |extra: Value| {
        let mut meta = json!({"kind": "connector", "line": "curved", "start": {"node": "frame", "magnet": "auto"}, "end": {"x": 0, "y": 0}});
        for (key, value) in extra.as_object().unwrap() {
            meta[key] = value.clone();
        }
        meta
    };
    let set = |meta: Value| move |doc: &mut Value| doc["nodes"]["rect"]["board"] = meta;
    // An end anywhere on an object, in fractions of its box.
    accepts(set(connector(
        json!({"end": {"node": "frame", "at": {"x": 0.25, "y": 1}}}),
    )));
    refuses(set(connector(
        json!({"end": {"node": "frame", "at": {"x": 1.5, "y": 0}}}),
    )));
    refuses(set(connector(
        json!({"end": {"node": "bad id", "at": {"x": 0, "y": 0}}}),
    )));
    // The label's place and the waypoints.
    accepts(set(connector(json!({"labelAt": 0, "points": []}))));
    accepts(set(connector(
        json!({"labelAt": 1, "points": [{"x": -5, "y": 1e9}]}),
    )));
    refuses(set(connector(json!({"labelAt": 1.01}))));
    refuses(set(connector(json!({"points": [{"x": 1}]}))));
    refuses(set(connector(
        json!({"points": vec![json!({"x": 0, "y": 0}); 1_001]}),
    )));
    // Merged cells: whole numbers from 1.
    accepts(set(
        json!({"kind": "part", "part": "cell", "colSpan": 2, "rowSpan": 1000}),
    ));
    refuses(set(json!({"kind": "part", "part": "cell", "colSpan": 0})));
    refuses(set(json!({"kind": "part", "part": "cell", "rowSpan": 1.5})));
    refuses(set(
        json!({"kind": "part", "part": "cell", "rowSpan": 1001}),
    ));
    // The section's flags; the new figures.
    accepts(set(json!({"kind": "section"})));
    accepts(set(
        json!({"kind": "section", "hidden": true, "backgroundLocked": false}),
    ));
    refuses(set(json!({"kind": "section", "hidden": 1})));
    for shape in [
        "cylinder-horizontal",
        "file",
        "folder",
        "documents",
        "predefined-process",
        "shield",
        "manual-input",
        "internal-storage",
        "or",
        "summing-junction",
    ] {
        accepts(set(json!({"kind": "shape", "shape": shape})));
    }
    refuses(set(json!({"kind": "shape", "shape": "cloud"})));
    // Written back as read; a magnet end with an `at` beside it stays the magnet end (zod's first option), `at` dropped.
    let mut doc = document();
    doc["nodes"]["rect"]["board"] = connector(json!({
        "start": {"node": "frame", "magnet": "top", "at": {"x": 0, "y": 0}},
        "end": {"node": "frame", "at": {"x": 0.5, "y": 0.5}}, "labelAt": 0.3, "points": [{"x": 1, "y": 2}]
    }));
    let read = from_json_validated(&doc.to_string()).unwrap();
    let back: Value = serde_json::from_str(&to_json(&read)).unwrap();
    assert_eq!(
        back["nodes"]["rect"]["board"],
        json!({"kind": "connector", "start": {"node": "frame", "magnet": "top"}, "end": {"node": "frame", "at": {"x": 0.5, "y": 0.5}},
               "line": "curved", "labelAt": 0.3, "points": [{"x": 1, "y": 2}]})
    );
}
