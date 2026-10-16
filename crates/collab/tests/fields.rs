//! Protocol 2 (lane W): a client that says `protocol: 2` gets the others' changes of existing nodes as the fields
//! that changed, live and in a catch-up from the tail; a protocol 1 client in the same file gets whole nodes; both
//! end on the server's document.

mod common;

use common::*;
use morfa_protocol::{ChangeFields, ClientId, Role, ServerMsg, Wire};

fn changes(log: &[ServerMsg]) -> Vec<&morfa_protocol::Change> {
    log.iter()
        .flat_map(|msg| match msg {
            ServerMsg::Change(change) => vec![change],
            ServerMsg::Changes { changes } => changes.iter().collect(),
            _ => vec![],
        })
        .collect()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn each_protocol_gets_its_own_form_of_a_change() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(10), 0);
    for wire in [Wire::Json, Wire::Binary] {
        let file = format!("f-{}", wire.name());
        server.journal.insert(&file, rect_doc(10), 0);
        let mut a = Editor::join_wire(&server, &file, "a", Role::Editor, wire).await;
        let id = |user: &str| ClientId::new(format!("tab-{user}-{}", rand::random::<u32>()));
        let mut old = Editor::join_protocol(
            &server,
            &file,
            "o",
            Role::Viewer,
            id("o"),
            None,
            0,
            None,
            wire,
            1,
        )
        .await;
        let mut new = Editor::join_protocol(
            &server,
            &file,
            "n",
            Role::Viewer,
            id("n"),
            None,
            0,
            None,
            wire,
            2,
        )
        .await;
        // A move of existing layers, a new layer, a removed one.
        let mut patch = a.move_patch(&["r1", "r2"], 5.0, -3.5);
        let nodes = patch.nodes.as_mut().unwrap();
        nodes.insert("x".into(), Some(rect("x")));
        nodes.insert("r9".into(), None);
        let mut page = a.replica.doc.nodes["page"].clone();
        let children = page.children.as_mut().unwrap();
        children.retain(|c| c != "r9");
        children.push("x".into());
        nodes.insert("page".into(), Some(page));
        let seq = a.send_patch(patch).await;
        a.answer(seq).await;
        old.reach(1).await;
        new.reach(1).await;
        let doc = server.settled(&file).await;
        for editor in [&a, &old, &new] {
            assert!(
                same_doc(&editor.replica.doc, &doc.document),
                "{} on {wire:?}",
                editor.user
            );
        }
        let old_change = changes(&old.log)[0];
        assert!(old_change.fields.is_none());
        assert_eq!(old_change.patch.nodes.as_ref().unwrap().len(), 5);
        let new_change = changes(&new.log)[0];
        let Some(ChangeFields::Read(fields)) = new_change.fields.as_deref() else {
            panic!("fields on {wire:?}")
        };
        assert_eq!(fields.keys().collect::<Vec<_>>(), ["r1", "r2", "page"]);
        assert_eq!(
            fields["r1"].set.keys().collect::<Vec<_>>(),
            ["x", "y"],
            "only what moved"
        );
        assert_eq!(fields["page"].set.keys().collect::<Vec<_>>(), ["children"]);
        assert_eq!(
            new_change
                .patch
                .nodes
                .as_ref()
                .unwrap()
                .keys()
                .collect::<Vec<_>>(),
            ["x", "r9"]
        );
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_catch_up_from_the_tail_carries_fields() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(10), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let b = Editor::join(&server, "f", "b", Role::Viewer).await;
    let (client, replica) = (b.client.clone(), b.replica.clone());
    drop(b);
    for i in 0..20 {
        let ids = if i % 2 == 0 {
            ["r1", "r2"]
        } else {
            ["r3", "r1"]
        };
        let seq = a.send_patch(a.move_patch(&ids, 1.0, 0.5)).await;
        a.answer(seq).await;
    }
    let doc = server.settled("f").await;
    for protocol in [1, 2] {
        let mut b = Editor::join_protocol(
            &server,
            "f",
            "b",
            Role::Viewer,
            client.clone(),
            Some(replica.clone()),
            0,
            Some(0),
            Wire::Json,
            protocol,
        )
        .await;
        b.reach(20).await;
        assert!(
            same_doc(&b.replica.doc, &doc.document),
            "protocol {protocol}"
        );
        let got = changes(&b.log);
        if protocol == 2 {
            assert_eq!(got.len(), 20);
            assert!(got.iter().all(|c| c.fields.is_some()));
        } else {
            // Only protocol 2 peers were there: the tail never encoded whole frames, so protocol 1 reloads.
            assert!(got.is_empty());
            assert!(
                b.log
                    .iter()
                    .any(|m| matches!(m, ServerMsg::Document { .. }))
            );
        }
    }
}

fn fields(entries: &[(&str, serde_json::Value)]) -> morfa_protocol::OpFields {
    let mut out = morfa_protocol::OpFields::default();
    for (id, value) in entries {
        if let Some(set) = value.get("set").and_then(|v| v.as_object()) {
            out.set.insert((*id).to_owned(), set.clone());
        }
        if let Some(unset) = value.get("unset").and_then(|v| v.as_array()) {
            out.unset.insert(
                (*id).to_owned(),
                unset
                    .iter()
                    .map(|k| k.as_str().unwrap().to_owned())
                    .collect(),
            );
        }
        if let Some(was) = value.get("was").and_then(|v| v.as_object()) {
            out.was.insert((*id).to_owned(), was.clone());
        }
    }
    out
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn field_ops_apply_over_the_servers_nodes_and_fan_out_as_sent() {
    for wire in [Wire::Json, Wire::Binary] {
        let server = Server::start().await;
        server.journal.insert("f", rect_doc(10), 0);
        let mut a = Editor::join_wire(&server, "f", "a", Role::Editor, wire).await;
        let id = |user: &str| ClientId::new(format!("tab-{user}-{}", rand::random::<u32>()));
        let mut old = Editor::join_protocol(
            &server,
            "f",
            "o",
            Role::Viewer,
            id("o"),
            None,
            0,
            None,
            wire,
            1,
        )
        .await;
        let mut new = Editor::join_protocol(
            &server,
            "f",
            "n",
            Role::Viewer,
            id("n"),
            None,
            0,
            None,
            wire,
            2,
        )
        .await;
        let op = fields(&[
            // The hot fields (read straight into the node) and any other (through the strict reader).
            (
                "r1",
                serde_json::json!({"set": {"x": 50.5, "name": "New"}, "was": {"x": 0, "name": "Rectangle"}}),
            ),
            (
                "r2",
                serde_json::json!({"set": {"cornerRadius": 8}, "unset": ["cornerSmoothing"], "was": {"cornerRadius": 0, "cornerSmoothing": 0}}),
            ),
        ]);
        let seq = a.send_fields(op).await;
        assert!(
            matches!(
                a.answer(seq).await,
                ServerMsg::Ack {
                    version: 1,
                    own: None,
                    ..
                }
            ),
            "{wire:?}"
        );
        old.reach(1).await;
        new.reach(1).await;
        let doc = server.settled("f").await.document;
        assert_eq!(doc.nodes["r1"].x, 50.5);
        assert_eq!(doc.nodes["r1"].name, "New");
        assert_eq!(doc.nodes["r2"].corner_radius, Some(8.0));
        assert_eq!(doc.nodes["r2"].corner_smoothing, None);
        for editor in [&a, &old, &new] {
            assert!(
                same_doc(&editor.replica.doc, &doc),
                "{} on {wire:?}",
                editor.user
            );
        }
        // Peers of protocol 2 get the op's own fields; protocol 1 whole nodes.
        let Some(ChangeFields::Read(sent)) = changes(&new.log)[0].fields.as_deref() else {
            panic!("fields")
        };
        assert_eq!(sent["r1"].set.keys().collect::<Vec<_>>(), ["name", "x"]);
        assert_eq!(sent["r2"].set.keys().collect::<Vec<_>>(), ["cornerRadius"]);
        assert_eq!(sent["r2"].unset, ["cornerSmoothing"]);
        assert!(changes(&old.log)[0].fields.is_none());
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn field_ops_behind_merge_as_whole_nodes_do() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Editor).await;
    // Both on version 0: a moves r1, b renames it and moves r2.
    let sa = a
        .send_fields(fields(&[(
            "r1",
            serde_json::json!({"set": {"x": 5}, "was": {"x": 0}}),
        )]))
        .await;
    a.answer(sa).await;
    let sb = b
        .send_fields(fields(&[
            (
                "r1",
                serde_json::json!({"set": {"name": "B"}, "was": {"name": "Rectangle"}}),
            ),
            ("r2", serde_json::json!({"set": {"y": 9}, "was": {"y": 0}})),
        ]))
        .await;
    assert!(matches!(
        b.answer(sb).await,
        ServerMsg::Ack { version: 2, .. }
    ));
    a.reach(2).await;
    b.reach(2).await;
    let doc = server.settled("f").await.document;
    assert_eq!(
        (
            doc.nodes["r1"].x,
            doc.nodes["r1"].name.as_str(),
            doc.nodes["r2"].y
        ),
        (5.0, "B", 9.0)
    );
    assert!(same_doc(&a.replica.doc, &doc));
    assert!(same_doc(&b.replica.doc, &doc));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_grid_and_a_grid_child_merge_key_by_key() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(1), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Editor).await;
    // Numbers as the server's model writes them back (f64).
    let grid = serde_json::json!({"rowCount": 2.0, "columnCount": 2.0, "rowGap": 0.0, "columnGap": 0.0, "rowSizes": [],
        "columnSizes": [], "autoTracks": "NONE", "itemsPositioning": "ROW_AUTO_FLOW"});
    let with = |changes: serde_json::Value| {
        let mut out = grid.clone();
        out.as_object_mut()
            .unwrap()
            .extend(changes.as_object().unwrap().clone());
        out
    };
    let s0 = a
        .send_fields(fields(&[(
            "r0",
            serde_json::json!({"set": {"grid": grid, "gridChild": {"rowSpan": 1}}}),
        )]))
        .await;
    a.answer(s0).await;
    a.reach(1).await;
    b.reach(1).await;
    // Both at version 1: a changes the row gap and the span, b the column count and the alignment.
    let sa = a
        .send_fields(fields(&[(
            "r0",
            serde_json::json!({"set": {"grid": with(serde_json::json!({"rowGap": 8})), "gridChild": {"rowSpan": 2}},
                "was": {"grid": grid, "gridChild": {"rowSpan": 1}}}),
        )]))
        .await;
    a.answer(sa).await;
    let sb = b
        .send_fields(fields(&[(
            "r0",
            serde_json::json!({"set": {"grid": with(serde_json::json!({"columnCount": 3})),
                "gridChild": {"rowSpan": 1, "horizontalAlign": "CENTER"}},
                "was": {"grid": grid, "gridChild": {"rowSpan": 1}}}),
        )]))
        .await;
    assert!(matches!(
        b.answer(sb).await,
        ServerMsg::Ack { version: 3, .. }
    ));
    a.reach(3).await;
    b.reach(3).await;
    let doc = server.settled("f").await.document;
    let node = serde_json::to_value(&doc.nodes["r0"]).unwrap();
    assert_eq!(
        node["grid"],
        with(serde_json::json!({"rowGap": 8.0, "columnCount": 3.0}))
    );
    assert_eq!(
        node["gridChild"],
        serde_json::json!({"rowSpan": 2.0, "horizontalAlign": "CENTER"})
    );
    assert!(same_doc(&a.replica.doc, &doc));
    assert!(same_doc(&b.replica.doc, &doc));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_field_ops_are_refused() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(2), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let seq = a
        .send_fields(fields(&[("r1", serde_json::json!({"set": {"x": 1}}))]))
        .await;
    a.answer(seq).await;
    let unknown = morfa_protocol::OpFields {
        set: [(
            "r1".to_owned(),
            serde_json::json!({"nope": 1}).as_object().unwrap().clone(),
        )]
        .into_iter()
        .collect(),
        ..Default::default()
    };
    a.seq += 1;
    let op = morfa_protocol::Op {
        seq: a.seq,
        base_version: 1,
        patch: Default::default(),
        before: None,
        before_tables: None,
        fields: Some(unknown),
    };
    a.tx.send(&morfa_protocol::ClientMsg::Op(Box::new(op)))
        .await
        .unwrap();
    match a.answer(a.seq).await {
        ServerMsg::Refused { code, path, .. } => {
            assert_eq!(code, morfa_protocol::ErrorCode::DesignDocumentInvalid);
            assert_eq!(path.as_deref(), Some("fields.set.r1.nope"));
        }
        other => panic!("{other:?}"),
    }
    // A wrong value for a known field: the strict reader's refusal.
    let bad = fields(&[("r1", serde_json::json!({"set": {"x": "1"}}))]);
    a.seq += 1;
    let op = morfa_protocol::Op {
        seq: a.seq,
        base_version: 1,
        patch: Default::default(),
        before: None,
        before_tables: None,
        fields: Some(bad),
    };
    a.tx.send(&morfa_protocol::ClientMsg::Op(Box::new(op)))
        .await
        .unwrap();
    assert!(matches!(
        a.answer(a.seq).await,
        ServerMsg::Refused {
            code: morfa_protocol::ErrorCode::DesignDocumentInvalid,
            ..
        }
    ));
    // A layer the file does not have, on the current version: the op is invalid (behind, the edit would be dropped).
    let gone = fields(&[("zz", serde_json::json!({"set": {"x": 1}}))]);
    a.seq += 1;
    let op = morfa_protocol::Op {
        seq: a.seq,
        base_version: 1,
        patch: Default::default(),
        before: None,
        before_tables: None,
        fields: Some(gone),
    };
    a.tx.send(&morfa_protocol::ClientMsg::Op(Box::new(op)))
        .await
        .unwrap();
    assert!(matches!(
        a.answer(a.seq).await,
        ServerMsg::Refused {
            code: morfa_protocol::ErrorCode::DesignDocumentInvalid,
            ..
        }
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_field_edit_of_a_layer_removed_meanwhile_is_dropped_and_answered() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Editor).await;
    // a removes r1 (and takes it out of the page); b, still on version 0, moves it.
    let mut page = a.replica.doc.nodes["page"].clone();
    page.children.as_mut().unwrap().retain(|c| c != "r1");
    let mut nodes = morfa_model::Map::default();
    nodes.insert("r1".to_owned(), None);
    nodes.insert("page".to_owned(), Some(page));
    let sa = a
        .send_patch(morfa_model::DocumentPatch {
            nodes: Some(nodes),
            ..Default::default()
        })
        .await;
    a.answer(sa).await;
    let sb = b
        .send_fields(fields(&[(
            "r1",
            serde_json::json!({"set": {"x": 7}, "was": {"x": 0}}),
        )]))
        .await;
    match b.answer(sb).await {
        ServerMsg::Ack { own: Some(own), .. } => {
            assert_eq!(
                own.nodes.as_ref().unwrap().get("r1"),
                Some(&None),
                "removal wins"
            );
        }
        other => panic!("{other:?}"),
    }
    b.reach(1).await;
    let doc = server.settled("f").await.document;
    assert!(!doc.nodes.contains_key("r1"));
    assert!(same_doc(&b.replica.doc, &doc));
}
