//! The layout stages on small documents whose answers are worked out by hand (the stage diff against the
//! TypeScript, `scripts/layout/stage-diff.ts`, is the exhaustive check), and the JavaScript-exact maths.

use morfa_layout::constraints::{
    ResizeHooks, ResizeMode, resize_by_hand, resize_node, scale_by_tool,
};
use morfa_layout::geom::{Rect, Vec2};
use morfa_layout::math;
use morfa_layout::normalize;
use morfa_layout::{AutoLayoutStage, GroupFitStage, SizingFixesStage, TextResizeStage};
use morfa_model::draft::Ctx;
use morfa_model::store::Node;
use morfa_model::store::draft::{Stage, Working};
use morfa_model::types::{LayoutSizing, NodeType, TextAutoResize};
use morfa_model::{DesignDocument, from_json};
use serde_json::{Value, json};

/// A node with createNode's defaults (shared/design/defaults.ts), then `props`.
fn node(kind: &str, id: &str, parent: &str, props: Value) -> Value {
    let mut node = json!({
        "id": id, "type": kind, "name": id, "parentId": parent, "visible": true, "locked": false, "opacity": 1,
        "blendMode": "NORMAL", "isMask": false, "x": 0, "y": 0, "width": 100, "height": 100, "rotation": 0,
        "fills": [], "strokes": [], "strokeWeight": 1, "strokeAlign": "INSIDE", "strokeCap": "NONE",
        "strokeJoin": "MITER", "strokeMiterLimit": 4, "dashPattern": [], "effects": [],
        "constraints": {"horizontal": "MIN", "vertical": "MIN"}, "layoutPositioning": "AUTO",
        "layoutSizingHorizontal": "FIXED", "layoutSizingVertical": "FIXED", "exportSettings": [], "reactions": []
    });
    if matches!(kind, "FRAME" | "GROUP" | "BOOLEAN_OPERATION" | "SECTION") {
        node["children"] = json!([]);
    }
    if kind == "BOOLEAN_OPERATION" {
        node["booleanOperation"] = json!("UNION");
    }
    for (key, value) in props.as_object().unwrap() {
        node[key] = value.clone();
    }
    node
}

fn auto(mode: &str, props: Value) -> Value {
    let mut layout = json!({
        "layoutMode": mode, "layoutWrap": "NO_WRAP", "primaryAxisAlignItems": "MIN", "counterAxisAlignItems": "MIN",
        "counterAxisAlignContent": "AUTO", "paddingLeft": 0, "paddingRight": 0, "paddingTop": 0, "paddingBottom": 0,
        "itemSpacing": 0, "counterAxisSpacing": 0, "itemReverseZIndex": false, "strokesIncludedInLayout": false
    });
    for (key, value) in props.as_object().unwrap() {
        layout[key] = value.clone();
    }
    layout
}

fn text(characters: &str, mode: &str) -> Value {
    json!({
        "characters": characters,
        "style": {"fontFamily": "Inter", "fontWeight": 400, "italic": false, "fontSize": 16, "lineHeight": {"unit": "AUTO"},
                  "letterSpacing": {"unit": "PERCENT", "value": 0}, "textDecoration": "NONE", "textCase": "ORIGINAL"},
        "runs": [], "textAlignHorizontal": "LEFT", "textAlignVertical": "TOP", "textAutoResize": mode,
        "paragraphSpacing": 0, "paragraphIndent": 0
    })
}

/// A document of one page holding `nodes` (each listed in its parent's children, in order).
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

fn run(stage: &dyn Stage, doc: DesignDocument, ids: &[&str]) -> Working {
    let mut draft = Working::from_model(&doc);
    let dirty = draft.slot_set(ids);
    stage.run(&mut draft, &dirty, &Ctx::default());
    draft
}

/// The draft's node `id`, by its key.
fn get<'d>(draft: &'d Working, id: &str) -> Option<&'d Node> {
    draft.node(draft.id(id)?)
}

fn rect(draft: &Working, id: &str) -> (f64, f64, f64, f64) {
    let node = get(draft, id).unwrap();
    (node.x, node.y, node.width, node.height)
}

// The arguments are written with 18 digits as Node printed them (they parse to the same doubles).
#[allow(clippy::excessive_precision, clippy::approx_constant)]
#[test]
fn sine_and_cosine_are_v8s() {
    // (x, Math.cos(x), Math.sin(x)) from Node 22 (V8 12.4, fdlibm), as bit patterns.
    let table: [(f64, u64, u64); 19] = [
        (
            1.00000000000000006e-1,
            0x3fefd712f9a817c0,
            0x3fb98eaecb8bcb2c,
        ),
        (
            5.00000000000000000e-1,
            0x3fec1528065b7d50,
            0x3fdeaee8744b05f0,
        ),
        (
            7.85398163397448279e-1,
            0x3fe6a09e667f3bcd,
            0x3fe6a09e667f3bcc,
        ),
        (
            1.00000000000000000e+0,
            0x3fe14a280fb5068c,
            0x3feaed548f090cee,
        ),
        (
            1.57079632679489656e+0,
            0x3c91a62633145c07,
            0x3ff0000000000000,
        ),
        (
            2.00000000000000000e+0,
            0xbfdaa22657537205,
            0x3fed18f6ead1b446,
        ),
        (
            3.14159265358979312e+0,
            0xbff0000000000000,
            0x3ca1a62633145c07,
        ),
        (
            -2.50000000000000000e+0,
            0xbfe9a2f7ef858b7d,
            0xbfe326af0dcfcab0,
        ),
        (
            4.71238898038468967e+0,
            0xbcaa79394c9e8a0a,
            0xbff0000000000000,
        ),
        (
            6.28318530717958623e+0,
            0x3ff0000000000000,
            0xbcb1a62633145c07,
        ),
        (
            1.00000000000000000e+1,
            0xbfead9ac890c6b1f,
            0xbfe1689ef5f34f52,
        ),
        (
            1.00000000000000000e+2,
            0x3feb981dbf665fdf,
            0xbfe03425b78c4db8,
        ),
        (
            1.00000000000000000e+5,
            0xbfeffac3841b3da7,
            0x3fa24daa9c527e96,
        ),
        (
            1.00000000000000000e+6,
            0x3fedf9df9906d32c,
            0xbfd6664b2568d867,
        ),
        (
            1.70000000000000000e+7,
            0x3fef5524a8e1e020,
            0x3fca017a567254eb,
        ),
        (
            -3.00000000000000000e+8,
            0x3fecbe31d447d1e2,
            0x3fdc219eed2e54c4,
        ),
        (
            1.23456789000000004e+5,
            0x3faa74d27c41b22a,
            0xbfeff50e60ab53f9,
        ),
        (
            5.23598775598298816e-1,
            0x3febb67ae8584cab,
            0x3fdfffffffffffff,
        ),
        (
            -1.74532925199432955e-2,
            0x3feffec097f5af8a,
            0xbf91df0b2b89dd1e,
        ),
    ];
    for (x, cos, sin) in table {
        assert_eq!(math::fdlibm::cos(x).to_bits(), cos, "cos({x})");
        assert_eq!(math::fdlibm::sin(x).to_bits(), sin, "sin({x})");
    }
    assert!(math::fdlibm::cos(f64::NAN).is_nan() && math::fdlibm::sin(f64::INFINITY).is_nan());
}

#[test]
fn hypot_and_max_are_javascripts() {
    assert_eq!(math::hypot(3.0, 4.0), 5.0);
    assert_eq!(math::hypot(0.1, 0.2).to_bits(), 0x3fcc9f25c5bfedda);
    assert_eq!(math::hypot(1e-3, 2.5).to_bits(), 0x400400001ad7f289);
    assert_eq!(math::hypot(f64::INFINITY, f64::NAN), f64::INFINITY);
    assert!(math::max(0.0, f64::NAN).is_nan(), "Math.max propagates NaN");
    assert!(math::min(f64::NAN, 1.0).is_nan());
    assert!(math::max(-0.0, 0.0).is_sign_positive() && math::min(0.0, -0.0).is_sign_negative());
}

#[test]
fn a_hugging_row_takes_its_content_with_padding_and_spacing() {
    let doc = document(vec![
        node(
            "FRAME",
            "row",
            "page",
            json!({"x": 10, "y": 20, "width": 1, "height": 1, "layoutSizingHorizontal": "HUG",
            "layoutSizingVertical": "HUG", "autoLayout": auto("HORIZONTAL", json!({"paddingLeft": 8, "paddingRight": 4,
            "paddingTop": 2, "paddingBottom": 6, "itemSpacing": 10, "counterAxisAlignItems": "CENTER"}))}),
        ),
        node("RECTANGLE", "a", "row", json!({"width": 40, "height": 30})),
        node("RECTANGLE", "b", "row", json!({"width": 20, "height": 50})),
    ]);
    let draft = run(&AutoLayoutStage::default(), doc, &["a"]);
    assert_eq!(rect(&draft, "row"), (10.0, 20.0, 82.0, 58.0));
    assert_eq!(
        rect(&draft, "a"),
        (8.0, 12.0, 40.0, 30.0),
        "centred on the cross axis"
    );
    assert_eq!(rect(&draft, "b"), (58.0, 2.0, 20.0, 50.0));
}

#[test]
fn fill_children_share_the_free_space_clamped_by_their_limits() {
    let doc = document(vec![
        node(
            "FRAME",
            "row",
            "page",
            json!({"width": 300, "height": 40, "autoLayout": auto("HORIZONTAL", json!({"itemSpacing": 10}))}),
        ),
        node(
            "RECTANGLE",
            "fixed",
            "row",
            json!({"width": 50, "height": 40}),
        ),
        node(
            "RECTANGLE",
            "capped",
            "row",
            json!({"width": 1, "height": 40, "layoutSizingHorizontal": "FILL", "maxWidth": 60}),
        ),
        node(
            "RECTANGLE",
            "rest",
            "row",
            json!({"width": 1, "height": 40, "layoutSizingHorizontal": "FILL"}),
        ),
    ]);
    let draft = run(&AutoLayoutStage::default(), doc, &["row"]);
    // 300 − 50 − 2·10 = 230 to share: the capped child takes 60, the other the remaining 170.
    assert_eq!(rect(&draft, "capped"), (60.0, 0.0, 60.0, 40.0));
    assert_eq!(rect(&draft, "rest"), (130.0, 0.0, 170.0, 40.0));
}

#[test]
fn hugging_text_is_measured_with_the_fixed_width_fake() {
    // 8 px per UTF-16 unit at 16 px; a line is 16 px (ascent 12.8 + descent 3.2).
    let doc = document(vec![
        node(
            "FRAME",
            "col",
            "page",
            json!({"width": 1, "height": 1, "layoutSizingHorizontal": "HUG",
            "layoutSizingVertical": "HUG", "autoLayout": auto("VERTICAL", json!({}))}),
        ),
        node(
            "TEXT",
            "t",
            "col",
            json!({"width": 0, "height": 0, "layoutSizingHorizontal": "HUG", "layoutSizingVertical": "HUG",
            "text": text("Привет", "WIDTH_AND_HEIGHT")}),
        ),
    ]);
    let stage = AutoLayoutStage::default();
    let draft = run(&stage, doc, &["t"]);
    assert_eq!(rect(&draft, "t"), (0.0, 0.0, 48.0, 16.0));
    assert_eq!(rect(&draft, "col"), (0.0, 0.0, 48.0, 16.0));
    let counters = stage.kept.counters();
    // Unwrapped for the width, then again at that width for the height (layout.ts memoises per width).
    assert_eq!((counters.arranged, counters.text_measured), (1, 2));
}

#[test]
fn wrapping_rows_break_at_the_frame_width() {
    let doc = document(vec![
        node(
            "FRAME",
            "wrap",
            "page",
            json!({"width": 100, "height": 1, "layoutSizingVertical": "HUG",
            "autoLayout": auto("HORIZONTAL", json!({"layoutWrap": "WRAP", "itemSpacing": 10, "counterAxisSpacing": 5}))}),
        ),
        node("RECTANGLE", "a", "wrap", json!({"width": 40, "height": 20})),
        node("RECTANGLE", "b", "wrap", json!({"width": 40, "height": 30})),
        node("RECTANGLE", "c", "wrap", json!({"width": 40, "height": 10})),
    ]);
    let draft = run(&AutoLayoutStage::default(), doc, &["wrap"]);
    assert_eq!(
        rect(&draft, "c"),
        (0.0, 35.0, 40.0, 10.0),
        "the third goes to a second row"
    );
    assert_eq!(rect(&draft, "wrap").3, 45.0);
}

#[test]
fn sizing_fixes_turn_a_fill_outside_auto_layout_fixed() {
    let doc = document(vec![
        node("FRAME", "f", "page", json!({"width": 300, "height": 200})),
        node(
            "RECTANGLE",
            "r",
            "f",
            json!({"layoutSizingHorizontal": "FILL"}),
        ),
    ]);
    let draft = run(&SizingFixesStage, doc, &["f"]);
    assert_eq!(
        get(&draft, "r").unwrap().layout_sizing_horizontal,
        LayoutSizing::Fixed
    );
    assert_eq!(draft.written().count(), 1);
}

#[test]
fn centred_auto_width_text_keeps_its_centre() {
    let mut props = text("abcd", "WIDTH_AND_HEIGHT");
    props["textAlignHorizontal"] = json!("CENTER");
    let doc = document(vec![node(
        "TEXT",
        "t",
        "page",
        json!({"x": 100, "y": 10, "width": 10, "height": 16, "text": props}),
    )]);
    let stage = TextResizeStage::default();
    let draft = run(&stage, doc, &["t"]);
    // 4 units × 8 px = 32 wide; the centre stays at x = 105.
    assert_eq!(rect(&draft, "t"), (89.0, 10.0, 32.0, 16.0));
    assert_eq!(stage.kept.counters().text_resized, 1);
}

#[test]
fn groups_fit_their_children_and_empty_ones_go() {
    let doc = document(vec![
        node(
            "GROUP",
            "g",
            "page",
            json!({"x": 0, "y": 0, "width": 10, "height": 10}),
        ),
        node(
            "RECTANGLE",
            "a",
            "g",
            json!({"x": 20, "y": 30, "width": 10, "height": 10}),
        ),
        node(
            "RECTANGLE",
            "b",
            "g",
            json!({"x": 50, "y": 40, "width": 10, "height": 30}),
        ),
        node("GROUP", "empty", "page", json!({})),
    ]);
    let draft = run(&GroupFitStage::default(), doc, &["a", "empty"]);
    assert_eq!(rect(&draft, "g"), (20.0, 30.0, 40.0, 40.0));
    assert_eq!(
        rect(&draft, "a"),
        (0.0, 0.0, 10.0, 10.0),
        "children shift the other way: nothing moves on screen"
    );
    assert_eq!(rect(&draft, "b"), (30.0, 10.0, 10.0, 30.0));
    assert!(get(&draft, "empty").is_none());
    assert_eq!(
        draft.removed().map(|id| draft.key(id)).collect::<Vec<_>>(),
        ["empty"]
    );
}

#[test]
fn constraints_follow_a_resized_parent() {
    let doc = document(vec![
        node("FRAME", "p", "page", json!({"width": 100, "height": 100})),
        node(
            "RECTANGLE",
            "max",
            "p",
            json!({"x": 70, "y": 10, "width": 20, "height": 20, "constraints": {"horizontal": "MAX", "vertical": "CENTER"}}),
        ),
        node(
            "RECTANGLE",
            "stretch",
            "p",
            json!({"x": 10, "y": 10, "width": 80, "height": 10, "constraints": {"horizontal": "STRETCH", "vertical": "SCALE"}}),
        ),
    ]);
    let mut draft = Working::from_model(&doc);
    let p = draft.id("p").unwrap();
    resize_by_hand(&mut draft, p, Rect::new(0.0, 0.0, 150.0, 120.0));
    assert_eq!(rect(&draft, "max"), (120.0, 20.0, 20.0, 20.0));
    assert_eq!(rect(&draft, "stretch"), (10.0, 12.0, 130.0, 12.0));
    // By hand, a frame that hugged stops hugging on the side that changed.
    let doc = document(vec![node(
        "FRAME",
        "h",
        "page",
        json!({"layoutSizingHorizontal": "HUG", "autoLayout": auto("VERTICAL", json!({}))}),
    )]);
    let mut draft = Working::from_model(&doc);
    let h = draft.id("h").unwrap();
    let mut frames = indexmap::IndexSet::new();
    let mut hooks = ResizeHooks {
        measurer: None,
        resized_frames: Some(&mut frames),
    };
    resize_node(
        &mut draft,
        h,
        Rect::new(0.0, 0.0, 120.0, 100.0),
        ResizeMode::Hand,
        &mut hooks,
    );
    assert_eq!(
        get(&draft, "h").unwrap().layout_sizing_horizontal,
        LayoutSizing::Fixed
    );
    assert_eq!(frames.len(), 1, "the frame waits for the layout engine");
}

#[test]
fn the_scale_tool_scales_lengths_too() {
    let doc = document(vec![node(
        "RECTANGLE",
        "r",
        "page",
        json!({"x": 10, "y": 10, "width": 20, "height": 10, "strokeWeight": 2, "cornerRadius": 3}),
    )]);
    let mut draft = Working::from_model(&doc);
    let r = draft.id("r").unwrap();
    scale_by_tool(&mut draft, &[r], Vec2 { x: 0.0, y: 0.0 }, 2.0, 2.0);
    let r = get(&draft, "r").unwrap();
    assert_eq!(
        (
            r.x,
            r.y,
            r.width,
            r.height,
            r.stroke_weight,
            r.props.corner_radius().copied()
        ),
        (20.0, 20.0, 40.0, 20.0, 4.0, Some(6.0))
    );
}

#[test]
fn normalize_knows_the_l2b_stages_by_their_names() {
    for name in ["sizing", "textResize", "layout", "groupFit"] {
        let stage = normalize::stage(name).unwrap_or_else(|| panic!("{name} is registered"));
        assert_eq!(stage.name(), name);
    }
    let doc = document(vec![node(
        "TEXT",
        "t",
        "page",
        json!({"width": 1, "height": 1, "text": text("ab", "HEIGHT")}),
    )]);
    let mut draft = Working::from_model(&doc);
    let dirty = draft.slot_set(["t"]);
    normalize::run_stage_with("textResize", &mut draft, &dirty, &Ctx::default(), None).unwrap();
    let t = get(&draft, "t").unwrap();
    assert_eq!(
        (t.kind, t.height),
        (NodeType::Text, 32.0),
        "two lines of one 8 px unit each in a 1 px box"
    );
    assert_eq!(
        t.props.text().unwrap().text_auto_resize,
        TextAutoResize::Height
    );
}

/// `copies` side-by-side screens: a hugging column of rows, each a hugging row of a text and a fixed box.
fn screens(copies: usize) -> DesignDocument {
    let mut nodes = Vec::new();
    for c in 0..copies {
        let screen = format!("s{c}");
        nodes.push(node("FRAME", &screen, "page", json!({"x": c as f64 * 500.0, "width": 400, "height": 1,
            "layoutSizingVertical": "HUG", "autoLayout": auto("VERTICAL", json!({"itemSpacing": 8, "paddingTop": 12}))})));
        for r in 0..20 {
            let row = format!("s{c}r{r}");
            nodes.push(node("FRAME", &row, &screen, json!({"width": 1, "height": 1, "layoutSizingHorizontal": "FILL",
                "layoutSizingVertical": "HUG", "autoLayout": auto("HORIZONTAL", json!({"itemSpacing": 4}))})));
            nodes.push(node(
                "TEXT",
                &format!("{row}t"),
                &row,
                json!({"width": 1, "height": 1, "layoutSizingHorizontal": "FILL",
                "layoutSizingVertical": "HUG", "text": text("Строка таблицы с текстом", "HEIGHT")}),
            ));
            nodes.push(node(
                "RECTANGLE",
                &format!("{row}b"),
                &row,
                json!({"width": 24, "height": 24}),
            ));
        }
    }
    document(nodes)
}

#[test]
fn a_drag_does_the_same_work_whatever_the_file_size() {
    let mut seen = None;
    for copies in [1, 8] {
        let mut doc = screens(copies);
        // A keystroke in one row of the first screen, after the file was laid out.
        let stage = AutoLayoutStage::default();
        let all: Vec<String> = doc.nodes.keys().cloned().collect();
        let mut draft = Working::from_model(&doc);
        let dirty = draft.slot_set(&all);
        stage.run(&mut draft, &dirty, &Ctx::default());
        doc = draft.into_model();
        if let Some(t) = doc.nodes.get_mut("s0r3t")
            && let Some(text) = t.text.as_mut()
        {
            text.characters
                .push_str(" и ещё немного слов, чтобы строка перенеслась");
        }
        let stage = AutoLayoutStage::default();
        let draft = run(&stage, doc, &["s0r3t"]);
        let counters = stage.kept.counters();
        let work = (
            counters.measured,
            counters.arranged,
            counters.text_measured,
            draft.written().count(),
        );
        assert!(work.3 > 0, "the edit moves the rows below it");
        match seen {
            None => seen = Some(work),
            Some(first) => assert_eq!(work, first, "{copies} screens"),
        }
    }
}
