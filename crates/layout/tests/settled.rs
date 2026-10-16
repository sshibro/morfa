//! The two caches a long-lived pipeline keeps between runs (lane N1 step 9): the layout stage's settled roots and
//! the instance step's up-to-date top-level instances. Each is checked against a fresh pipeline on the same
//! sequence of changes: the kept pipeline must write exactly what the fresh one writes (TypeScript, which has
//! neither cache, is the oracle in `MORFA_ENGINE=both`; here the fresh pipeline stands in for it).

use std::sync::Arc;

use morfa_layout::normalize::Pipeline;
use morfa_model::draft::Ctx;
use morfa_model::json::node_fields_from_json;
use morfa_model::store::Document;
use morfa_model::store::draft::Working;
use morfa_model::{DesignDocument, from_json};
use serde_json::{Value, json};

fn node(kind: &str, id: &str, parent: &str, props: Value) -> Value {
    let mut node = json!({
        "id": id, "type": kind, "name": id, "parentId": parent, "visible": true, "locked": false, "opacity": 1,
        "blendMode": "NORMAL", "isMask": false, "x": 0, "y": 0, "width": 100, "height": 100, "rotation": 0,
        "fills": [], "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE", "strokeCap": "NONE",
        "strokeJoin": "MITER", "strokeMiterLimit": 4, "dashPattern": [], "effects": [],
        "constraints": {"horizontal": "MIN", "vertical": "MIN"}, "layoutPositioning": "AUTO",
        "layoutSizingHorizontal": "FIXED", "layoutSizingVertical": "FIXED", "exportSettings": [], "reactions": []
    });
    if matches!(
        kind,
        "FRAME" | "GROUP" | "COMPONENT" | "INSTANCE" | "SECTION"
    ) {
        node["children"] = json!([]);
    }
    for (key, value) in props.as_object().unwrap() {
        node[key] = value.clone();
    }
    node
}

fn auto(mode: &str) -> Value {
    json!({
        "layoutMode": mode, "layoutWrap": "NO_WRAP", "primaryAxisAlignItems": "MIN", "counterAxisAlignItems": "MIN",
        "counterAxisAlignContent": "AUTO", "paddingLeft": 8, "paddingRight": 8, "paddingTop": 8, "paddingBottom": 8,
        "itemSpacing": 4, "counterAxisSpacing": 0, "itemReverseZIndex": false, "strokesIncludedInLayout": false
    })
}

fn text(characters: &str) -> Value {
    json!({
        "characters": characters,
        "style": {"fontFamily": "Inter", "fontWeight": 400, "italic": false, "fontSize": 16, "lineHeight": {"unit": "AUTO"},
                  "letterSpacing": {"unit": "PERCENT", "value": 0}, "textDecoration": "NONE", "textCase": "ORIGINAL"},
        "runs": [], "textAlignHorizontal": "LEFT", "textAlignVertical": "TOP", "textAutoResize": "HEIGHT",
        "paragraphSpacing": 0, "paragraphIndent": 0
    })
}

fn document(nodes: Vec<Value>) -> DesignDocument {
    let mut table = serde_json::Map::new();
    let mut page = node("PAGE", "page", "", json!({"width": 0, "height": 0}));
    page["parentId"] = Value::Null;
    page["children"] = json!([]);
    table.insert("page".into(), page);
    for node in nodes {
        let id = node["id"].as_str().unwrap().to_owned();
        let parent = node["parentId"].as_str().unwrap().to_owned();
        table.insert(id.clone(), node);
        table[&parent]["children"]
            .as_array_mut()
            .unwrap()
            .push(json!(id));
    }
    let doc = json!({"schemaVersion": 1, "pages": ["page"], "nodes": table, "styles": {}, "images": {},
                     "variableCollections": {}, "variables": {}});
    from_json(&doc.to_string()).expect("the test document parses")
}

/// A frame in vertical auto layout with a picture and a hugging text: the card of TARGETS E3.
fn card(id: &str, parent: &str, kind: &str, x: f64) -> Vec<Value> {
    vec![
        node(
            kind,
            id,
            parent,
            json!({"x": x, "width": 200, "height": 150, "autoLayout": auto("VERTICAL")}),
        ),
        node(
            "RECTANGLE",
            &format!("{id}-pic"),
            id,
            json!({"width": 184, "height": 80, "layoutSizingHorizontal": "FILL",
            "fills": [{"type": "SOLID", "color": {"r": 0.5, "g": 0.5, "b": 0.5}, "opacity": 1, "visible": true, "blendMode": "NORMAL"}]}),
        ),
        node(
            "TEXT",
            &format!("{id}-title"),
            id,
            json!({"width": 184, "height": 20, "layoutSizingHorizontal": "FILL",
            "text": text("A title")}),
        ),
    ]
}

/// One change applied to the document and normalized by both pipelines; the entries must be the same.
struct Twins {
    kept: Pipeline,
    kept_doc: Arc<Document>,
    fresh_doc: Arc<Document>,
}

impl Twins {
    fn new(doc: &DesignDocument) -> Self {
        let store = Arc::new(Document::from_model(doc));
        Self {
            kept: Pipeline::new(),
            kept_doc: Arc::clone(&store),
            fresh_doc: store,
        }
    }

    /// Normalizes with `fields` (`{id: {key: value}}` JSON) laid over, `dirty` the ids changed, on the kept pipeline
    /// and on a fresh one; checks the two write the same, advances both documents and returns the ids written.
    fn step(&mut self, fields: &str, dirty: &[&str]) -> Vec<String> {
        let ctx = Ctx::default();
        let run = |pipeline: &Pipeline, doc: &Arc<Document>| {
            let mut working = Working::new(Arc::clone(doc));
            for (id, fields) in node_fields_from_json(fields).expect("fields") {
                working
                    .lay_over_fields(&id, fields)
                    .expect("a node of the document");
            }
            let dirty = working.slot_set(dirty.iter());
            pipeline.run(&mut working, &dirty, &ctx, None);
            let written: Vec<String> = working
                .written()
                .map(|id| working.key(id).to_owned())
                .collect();
            let (entry, _) = working.into_entry_and_slots();
            (written, entry)
        };
        let (written, entry) = run(&self.kept, &self.kept_doc);
        let (fresh_written, fresh_entry) = run(&Pipeline::new(), &self.fresh_doc);
        assert_eq!(
            written, fresh_written,
            "the kept pipeline writes what a fresh one writes"
        );
        assert_eq!(entry.nodes.len(), fresh_entry.nodes.len());
        for ((id, node), (fresh_id, fresh_node)) in entry.nodes.iter().zip(&fresh_entry.nodes) {
            assert_eq!(id, fresh_id);
            match (node, fresh_node) {
                (Some(node), Some(fresh)) => assert!(**node == **fresh, "node {id:?} differs"),
                (None, None) => {}
                _ => panic!("node {id:?}: one pipeline removed it"),
            }
        }
        Arc::make_mut(&mut self.kept_doc)
            .replay(&entry)
            .expect("replay");
        Arc::make_mut(&mut self.fresh_doc)
            .replay(&fresh_entry)
            .expect("replay");
        written
    }
}

const GREY: &str = r#"[{"type": "SOLID", "color": {"r": 0.5, "g": 0.5, "b": 0.5}, "opacity": 1, "visible": true, "blendMode": "NORMAL"}]"#;
const RED: &str = r#"[{"type": "SOLID", "color": {"r": 0.9, "g": 0.2, "b": 0.2}, "opacity": 1, "visible": true, "blendMode": "NORMAL"}]"#;

#[test]
fn settled_roots_are_skipped_until_something_layout_reads_changes() {
    let doc = document(card("card", "page", "FRAME", 0.0));
    let mut twins = Twins::new(&doc);
    // The first pass lays the card out (the text takes its height, the picture its width): writes, nothing settled.
    let written = twins.step("{}", &["card"]);
    assert!(!written.is_empty());
    // The second finds it settled and remembers the root.
    assert!(twins.step("{}", &["card"]).is_empty());
    assert_eq!(twins.kept.settled_roots(), 1);
    // A fill change on the picture: dirty, laid out by TypeScript for nothing; the memo skips it, the same result.
    assert!(
        twins
            .step(
                &format!(r#"{{"card-pic": {{"fills": {RED}}}}}"#),
                &["card-pic"]
            )
            .is_empty()
    );
    assert_eq!(twins.kept.settled_roots(), 1);
    // A height change on the picture: the layout reads it, the card's text moves; both pipelines write the same.
    let written = twins.step(r#"{"card-pic": {"height": 120}}"#, &["card-pic"]);
    assert!(written.contains(&"card-title".to_owned()), "{written:?}");
    // Settled again after a pass that writes nothing.
    assert!(twins.step("{}", &["card-pic"]).is_empty());
    assert_eq!(twins.kept.settled_roots(), 1);
    // A text change is read too (measured): the card grows.
    let written = twins.step(r#"{"card-title": {"text": {"characters": "A much longer title that wraps onto a second line, at least", "style": {"fontFamily": "Inter", "fontWeight": 400, "italic": false, "fontSize": 16, "lineHeight": {"unit": "AUTO"}, "letterSpacing": {"unit": "PERCENT", "value": 0}, "textDecoration": "NONE", "textCase": "ORIGINAL"}, "runs": [], "textAlignHorizontal": "LEFT", "textAlignVertical": "TOP", "textAutoResize": "HEIGHT", "paragraphSpacing": 0, "paragraphIndent": 0}}}"#, &["card-title"]);
    assert!(
        written.contains(&"card".to_owned()) || written.contains(&"card-title".to_owned()),
        "{written:?}"
    );
}

#[test]
fn settled_roots_compare_the_dirty_paths_and_the_parents_flow() {
    // Two cards: a change in one leaves the other's path clean; the memo of the other must not be fooled by a run
    // where its path was dirty.
    let mut nodes = card("a", "page", "FRAME", 0.0);
    nodes.extend(card("b", "page", "FRAME", 300.0));
    let doc = document(nodes);
    let mut twins = Twins::new(&doc);
    twins.step("{}", &["a", "b"]);
    assert!(twins.step("{}", &["a", "b"]).is_empty());
    assert_eq!(twins.kept.settled_roots(), 2);
    assert!(twins.step("{}", &["a-pic"]).is_empty());
    assert!(
        twins
            .step(&format!(r#"{{"b-pic": {{"fills": {RED}}}}}"#), &["b-pic"])
            .is_empty()
    );
    let written = twins.step(r#"{"b-pic": {"height": 40}}"#, &["b-pic"]);
    assert!(written.contains(&"b-title".to_owned()), "{written:?}");
    assert!(!written.contains(&"a-title".to_owned()), "{written:?}");
}

#[test]
fn an_up_to_date_instance_is_not_rebuilt_but_its_copies_follow_the_component() {
    let mut nodes = card("main", "page", "COMPONENT", 0.0);
    for (k, id) in ["i1", "i2"].iter().enumerate() {
        let mut instance = node(
            "INSTANCE",
            id,
            "page",
            json!({"x": 300.0 * (k as f64 + 1.0), "width": 200, "height": 150, "componentId": "main"}),
        );
        instance["children"] = json!([]);
        nodes.push(instance);
    }
    let doc = document(nodes);
    let mut twins = Twins::new(&doc);
    // The first pass materializes the copies; the second finds the instances up to date and remembers them.
    let written = twins.step("{}", &["main", "i1", "i2"]);
    assert!(
        written.contains(&"i1".to_owned()) && written.iter().any(|id| id.starts_with("i1;")),
        "{written:?}"
    );
    assert!(twins.step("{}", &["main", "i1", "i2"]).is_empty());
    assert_eq!(twins.kept.derived_roots(), 2);
    // A fill on the component's picture: the copies are rewritten, the instances themselves are not (TARGETS E3).
    let written = twins.step(
        &format!(r#"{{"main-pic": {{"fills": {RED}}}}}"#),
        &["main-pic"],
    );
    assert!(
        written.contains(&"i1;main-pic".to_owned()) && written.contains(&"i2;main-pic".to_owned()),
        "{written:?}"
    );
    assert!(!written.contains(&"i1".to_owned()), "{written:?}");
    assert_eq!(twins.kept.derived_roots(), 2);
    assert!(
        twins
            .step(
                &format!(r#"{{"main-pic": {{"fills": {GREY}}}}}"#),
                &["main-pic"]
            )
            .len()
            == 2
    );
    // The instance moved: its own node changed, the rebuild runs again and finds the same (placement is its own).
    assert!(twins.step(r#"{"i1": {"x": 1000}}"#, &["i1"]).is_empty());
    // The component's name changes: every instance shows it.
    let written = twins.step(r#"{"main": {"name": "Card v2"}}"#, &["main"]);
    assert!(
        written.contains(&"i1".to_owned()) && written.contains(&"i2".to_owned()),
        "{written:?}"
    );
    assert!(twins.step("{}", &["i1", "i2"]).is_empty());
    assert_eq!(twins.kept.derived_roots(), 2);
}
