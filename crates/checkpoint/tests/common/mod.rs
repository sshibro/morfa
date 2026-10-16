//! Small documents and patches for the checkpoint tests, as JSON (what the editor and Node send).
#![allow(dead_code)]

pub fn node(
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

pub fn rect_id(k: usize) -> String {
    format!("r{k}")
}

/// A page with `n` rectangles.
pub fn document(n: usize) -> String {
    let ids: Vec<String> = (0..n).map(rect_id).collect();
    let mut nodes = vec![format!(
        "\"page\":{}",
        node("page", "PAGE", None, 0.0, Some(&ids))
    )];
    nodes.extend(ids.iter().enumerate().map(|(k, id)| {
        format!(
            "\"{id}\":{}",
            node(id, "RECTANGLE", Some("page"), k as f64, None)
        )
    }));
    format!(
        r#"{{"schemaVersion":1,"pages":["page"],"nodes":{{{}}},"styles":{{}},"images":{{}},"variableCollections":{{}},"variables":{{}}}}"#,
        nodes.join(",")
    )
}

/// A patch moving rectangle `k` to `x` (the whole node, as the editor sends it).
pub fn move_patch(k: usize, x: f64) -> String {
    let id = rect_id(k);
    format!(
        r#"{{"nodes":{{"{id}":{}}}}}"#,
        node(&id, "RECTANGLE", Some("page"), x, None)
    )
}

pub fn store(json: &str) -> morfa_model::store::Document {
    morfa_model::store::Document::from_model(
        &morfa_model::from_json_validated(json).expect("a valid document"),
    )
}
