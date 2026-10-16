//! Protocol 2's field-level changes (lane W): what the server computes from a stored patch and its undo, written on
//! both wires and read back, spreads over the receiver's nodes into exactly the stored patch.

use morfa_model::{DocumentPatch, Map, SceneNode};
use morfa_protocol::binary::BinaryCodec;
use morfa_protocol::fields::{diff, resolve};
use morfa_protocol::*;
use std::sync::Arc;

const RECT: &str = r#"{"id":"r","type":"RECTANGLE","name":"R","parentId":"p","visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":1,"y":2,"width":3,"height":4,"rotation":0,"fills":[{"type":"SOLID","color":{"r":1,"g":0,"b":0},"opacity":1,"visible":true,"blendMode":"NORMAL"}],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"cornerRadius":4}"#;

fn node(id: &str, edit: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>)) -> SceneNode {
    let mut value: serde_json::Value = serde_json::from_str(RECT).unwrap();
    let object = value.as_object_mut().unwrap();
    object.insert("id".into(), id.into());
    edit(object);
    serde_json::from_value(value).unwrap_or_else(|e| panic!("{e}"))
}

/// Before: a, b, c, d. The change moves a, recolours b and drops its corner radius, gives c a min width, removes d
/// and adds e; plus a page order.
fn case() -> (Map<SceneNode>, DocumentPatch, DocumentPatch) {
    let before: Map<SceneNode> = ["a", "b", "c", "d"]
        .into_iter()
        .map(|id| (id.to_owned(), node(id, |_| {})))
        .collect();
    let mut nodes: Map<Option<SceneNode>> = Map::default();
    nodes.insert(
        "a".into(),
        Some(node("a", |o| {
            o.insert("x".into(), 10.5.into());
            o.insert("y".into(), (-0.0f64).into());
        })),
    );
    nodes.insert("b".into(), Some(node("b", |o| {
        o.insert(
            "fills".into(),
            serde_json::json!([{"type":"SOLID","color":{"r":0,"g":0.5,"b":1},"opacity":1,"visible":true,"blendMode":"NORMAL"}]),
        );
        o.remove("cornerRadius");
    })));
    nodes.insert(
        "c".into(),
        Some(node("c", |o| {
            o.insert("minWidth".into(), 40.into());
        })),
    );
    nodes.insert("d".into(), None);
    nodes.insert("e".into(), Some(node("e", |_| {})));
    let stored = DocumentPatch {
        nodes: Some(nodes),
        pages: Some(vec!["p".into()]),
        ..Default::default()
    };
    let undo = DocumentPatch {
        nodes: Some(
            ["a", "b", "c", "d", "e"]
                .into_iter()
                .map(|id| (id.to_owned(), before.get(id).cloned()))
                .collect(),
        ),
        pages: Some(vec!["q".into()]),
        ..Default::default()
    };
    (before, stored, undo)
}

fn change(stored: &DocumentPatch) -> Change {
    Change {
        version: 9,
        by: Some("c1".into()),
        client: Some(ClientId::new("tab")),
        seq: Some(3),
        user: "u".into(),
        patch: Arc::new(stored.clone()),
        fields: None,
    }
}

#[test]
fn the_diff_names_exactly_the_changed_fields() {
    let (_, stored, undo) = case();
    let Some(ChangeFields::Diff(diffs)) = diff(&stored, &undo) else {
        panic!("a, b and c qualify")
    };
    let named: Vec<(usize, Vec<&str>, Vec<&str>)> = diffs
        .iter()
        .map(|d| (d.index, d.set.clone(), d.unset.clone()))
        .collect();
    assert_eq!(
        named,
        vec![
            (0, vec!["x", "y"], vec![]),
            (1, vec!["fills"], vec!["cornerRadius"]),
            (2, vec!["minWidth"], vec![]),
        ]
    );
    // Nothing qualifies: only new and removed nodes.
    let only_new = DocumentPatch {
        nodes: Some(
            [("e".to_owned(), Some(node("e", |_| {})))]
                .into_iter()
                .collect(),
        ),
        ..Default::default()
    };
    let undo_new = DocumentPatch {
        nodes: Some([("e".to_owned(), None)].into_iter().collect()),
        ..Default::default()
    };
    assert!(diff(&only_new, &undo_new).is_none());
    assert!(change(&only_new).with_fields(&undo_new).is_none());
}

#[test]
fn field_changes_round_trip_on_both_wires() {
    let (before, stored, undo) = case();
    let whole = change(&stored);
    let fields = whole.with_fields(&undo).expect("fields");
    for wire in [Wire::Json, Wire::Binary] {
        let codec = wire.codec();
        let whole_frame = codec.encode_server(&ServerMsg::Change(whole.clone()));
        let frame = codec.encode_server(&ServerMsg::Change(fields.clone()));
        assert!(
            frame.len() * 3 < whole_frame.len() * 2,
            "{wire:?}: {} vs {}",
            frame.len(),
            whole_frame.len()
        );
        let ServerMsg::Change(read) = codec.decode_server(&frame.bytes).unwrap() else {
            panic!("a change")
        };
        // The patch keeps the new and removed nodes and the other tables; fields hold the rest.
        let nodes = read.patch.nodes.as_ref().unwrap();
        assert_eq!(nodes.keys().collect::<Vec<_>>(), ["d", "e"]);
        assert_eq!(read.patch.pages, stored.pages);
        let Some(ChangeFields::Read(map)) = read.fields.as_deref() else {
            panic!("fields read")
        };
        assert_eq!(map.keys().collect::<Vec<_>>(), ["a", "b", "c"]);
        assert_eq!(map["b"].unset, ["cornerRadius"]);
        assert!(map["a"].unset.is_empty());
        let resolved = resolve(&read.patch, read.fields.as_deref(), |id| {
            before.get(id).cloned()
        })
        .unwrap();
        let mut want = stored.nodes.clone().unwrap();
        let mut got = resolved.nodes.clone().unwrap();
        want.sort_keys();
        got.sort_keys();
        assert_eq!(got, want, "{wire:?}");
        // y of a went 0 → -0: a change by its bytes (the JSON wire writes it as 0, as it writes the whole node).
        assert!(map["a"].set.contains_key("y"));
        // The same text through the other wire's frame (the tail translates frames).
        let other = morfa_protocol::codec::transcode(
            &frame,
            if wire == Wire::Json {
                Wire::Binary
            } else {
                Wire::Json
            },
        )
        .unwrap();
        let back = if wire == Wire::Json {
            BinaryCodec.decode_server(&other.bytes)
        } else {
            JsonCodec.decode_server(&other.bytes)
        }
        .unwrap();
        let ServerMsg::Change(back) = back else {
            panic!("a change")
        };
        let mut again = resolve(&back.patch, back.fields.as_deref(), |id| {
            before.get(id).cloned()
        })
        .unwrap()
        .nodes
        .unwrap();
        again.sort_keys();
        assert_eq!(again, want, "{wire:?} translated");
    }
}

#[test]
fn a_missing_base_node_is_an_error() {
    let (_, stored, undo) = case();
    let fields = change(&stored).with_fields(&undo).unwrap();
    let frame = JsonCodec.encode_server(&ServerMsg::Change(fields));
    let ServerMsg::Change(read) = JsonCodec.decode_server(&frame.bytes).unwrap() else {
        panic!()
    };
    assert!(resolve(&read.patch, read.fields.as_deref(), |_| None).is_err());
}

#[test]
fn hello_negotiates_the_version() {
    let hello = |protocol: Option<u32>| {
        let text = match protocol {
            Some(p) => format!(r#"{{"t":"hello","ticket":"t","clientId":"c","protocol":{p}}}"#),
            None => r#"{"t":"hello","ticket":"t","clientId":"c"}"#.to_owned(),
        };
        match JsonCodec.decode_client(text.as_bytes()).unwrap() {
            ClientMsg::Hello(hello) => hello,
            _ => panic!(),
        }
    };
    assert!(hello(None).protocol_ok() && !hello(None).fields());
    assert!(hello(Some(1)).protocol_ok() && !hello(Some(1)).fields());
    assert!(hello(Some(2)).protocol_ok() && hello(Some(2)).fields());
    assert!(!hello(Some(3)).protocol_ok());
    assert!(!hello(Some(0)).protocol_ok());
}

#[test]
fn field_ops_round_trip_on_both_wires() {
    let text = r#"{"t":"op","seq":3,"baseVersion":7,"patch":{"nodes":{"n":null}},"fields":{"set":{"a":{"x":10.5,"name":"Layer"},"b":{}},"unset":{"b":["cornerRadius"]},"was":{"a":{"x":1}}}}"#;
    let ClientMsg::Op(op) = JsonCodec.decode_client(text.as_bytes()).unwrap() else {
        panic!("an op")
    };
    let fields = op.fields.as_ref().expect("fields read");
    assert_eq!(fields.ids().collect::<Vec<_>>(), ["a", "b"]);
    assert_eq!(fields.set["a"]["x"], 10.5);
    assert_eq!(fields.unset["b"], ["cornerRadius"]);
    assert_eq!(fields.was["a"]["x"], 1);
    assert_eq!(op.patch.nodes.as_ref().unwrap().len(), 1);
    for wire in [Wire::Json, Wire::Binary] {
        let frame = wire.codec().encode_client(&ClientMsg::Op(op.clone()));
        let ClientMsg::Op(back) = wire.codec().decode_client(&frame.bytes).unwrap() else {
            panic!("an op")
        };
        assert_eq!(back.fields, op.fields, "{wire:?}");
        assert_eq!(back.patch, op.patch, "{wire:?}");
    }
    // The buffered readers (a key repeated elsewhere, the tag not first) read the same fields.
    let reordered = text.replace(r#"{"t":"op","seq":3,"#, r#"{"seq":3,"t":"op","#);
    let ClientMsg::Op(slow) = JsonCodec.decode_client(reordered.as_bytes()).unwrap() else {
        panic!("an op")
    };
    assert_eq!(slow.fields, op.fields);
    // Every SceneNode field name is known, as JSON writes it.
    let names = morfa_protocol::fields::scene_node_fields();
    for name in [
        "x",
        "fills",
        "parentId",
        "cornerRadius",
        "minWidth",
        "type",
        "text",
    ] {
        assert!(names.contains(&name), "{name}");
    }
    assert!(morfa_protocol::fields::scene_node_field("kind").is_none());
}
