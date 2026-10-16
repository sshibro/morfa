//! The socket's behaviours: reconnect with gaps and idempotent re-send, catch-up
//! from the journal, slow readers, poison ops, rollback after a failed commit, permissions, presence coalescing,
//! tickets and the internal endpoints.

mod common;

use common::*;
use morfa_collab::client::{self, Replica};
use morfa_collab::engine::{
    Applied, DocEngine, EngineStats, OpInput, OpsEngine, Refusal, document_hash,
};
use morfa_collab::metrics::metrics;
use morfa_model::{DesignDocument, DocumentPatch, Vec2, to_json};
use morfa_protocol::{
    ByeReason, ClientId, ClientMsg, ErrorCode, Hello, PROTOCOL_VERSION, PresenceUpdate, Role,
    ServerMsg, Version, Wire,
};
use std::sync::Arc;
use std::time::{Duration, Instant};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn reconnect_with_a_gap_and_resend_is_idempotent() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(10), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Editor).await;
    for i in 0..5 {
        let seq = a.send_patch(a.move_patch(&["r1"], 1.0, 0.0)).await;
        assert!(matches!(a.answer(seq).await, ServerMsg::Ack { version, .. } if version == i + 1));
    }
    b.reach(5).await;
    // b sends an op and drops the socket before reading its ack.
    let patch = b.move_patch(&["r2"], 0.0, 7.0);
    let seq = b.send_patch(patch.clone()).await;
    let (client, replica, last_seq) = (b.client.clone(), b.replica.clone(), b.seq);
    // The op landed (a sees it) before b goes: a socket dropped with unread data is reset, and a reset discards
    // whatever the server had not read yet.
    a.reach(6).await;
    drop(b);
    for _ in 0..30 {
        let seq = a.send_patch(a.move_patch(&["r3"], 1.0, 1.0)).await;
        a.answer(seq).await;
    }
    let mut b = Editor::join_as(
        &server,
        "f",
        "b",
        Role::Editor,
        client,
        Some(replica),
        last_seq,
        Some(5),
    )
    .await;
    let ServerMsg::Welcome(welcome) = &b.log[0] else {
        panic!()
    };
    assert_eq!(welcome.acked_seq, seq, "the server holds b's op");
    assert!(!welcome.resync);
    // Re-sending the same seq is re-acked with its version, not applied twice.
    let version_before = server.inspect("f").await.version;
    b.tx.send(&ClientMsg::Op(Box::new(morfa_protocol::Op {
        seq,
        base_version: 5,
        patch,
        before: None,
        before_tables: None,
        fields: None,
    })))
    .await
    .unwrap();
    let ack = b.answer(seq).await;
    let ServerMsg::Ack { version: acked, .. } = ack else {
        panic!("{ack:?}")
    };
    assert_eq!(acked, 6, "b's op landed right after version 5");
    let inspect = server.settled("f").await;
    assert_eq!(inspect.version, version_before);
    b.reach(inspect.version).await;
    assert!(same_doc(&b.replica.doc, &inspect.document));
    a.reach(inspect.version).await;
    assert!(same_doc(&a.replica.doc, &inspect.document));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn catch_up_reads_the_journal_beyond_the_tail() {
    let server = Server::start_with(Options {
        config: Box::new(|c| c.tail_entries = 8),
        ..Default::default()
    })
    .await;
    server.journal.insert("f", rect_doc(10), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let b = Editor::join(&server, "f", "b", Role::Viewer).await;
    let (client, replica) = (b.client.clone(), b.replica.clone());
    drop(b);
    for _ in 0..40 {
        let seq = a.send_patch(a.move_patch(&["r1", "r2"], 1.0, 0.0)).await;
        a.answer(seq).await;
    }
    let inspect = server.settled("f").await;
    assert!(server.inspect("f").await.tail <= 8);
    let before = metrics().catchup_total.get();
    let mut b = Editor::join_as(
        &server,
        "f",
        "b",
        Role::Viewer,
        client,
        Some(replica),
        0,
        Some(0),
    )
    .await;
    b.reach(inspect.version).await;
    assert!(same_doc(&b.replica.doc, &inspect.document));
    assert!(metrics().catchup_total.get() > before);
    assert!(b.log.iter().any(|m| matches!(m, ServerMsg::Changes { .. })));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_client_gets_the_document() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let seq = a.send_patch(a.move_patch(&["r0"], 5.0, 5.0)).await;
    a.answer(seq).await;
    let b = Editor::join(&server, "f", "b", Role::Viewer).await;
    assert_eq!(b.replica.version, 1);
    assert!(same_doc(
        &b.replica.doc,
        &server.inspect("f").await.document
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_slow_reader_is_told_to_catch_up_and_nobody_waits() {
    let server = Server::start_with(Options {
        config: Box::new(|c| {
            c.send_queue_bytes = 256 * 1024;
            c.ops_per_second = 1_000_000;
            c.bytes_per_second = 1_000_000_000;
        }),
        ..Default::default()
    })
    .await;
    server.journal.insert("f", rect_doc(200), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    // The slow one joins and does not read. It speaks protocol 1: whole nodes fill its queue (protocol 2's field-level
    // moves are ~15× smaller and would not).
    let mut slow = Editor::join_protocol(
        &server,
        "f",
        "slow",
        Role::Viewer,
        ClientId::new("tab-slow"),
        None,
        0,
        None,
        Wire::Json,
        1,
    )
    .await;
    let ids: Vec<String> = (0..100).map(|i| format!("r{i}")).collect();
    let ids: Vec<&str> = ids.iter().map(String::as_str).collect();
    let started = Instant::now();
    let ops = 400;
    for _ in 0..ops {
        let seq = a.send_patch(a.move_patch(&ids, 1.0, 0.0)).await;
        assert!(matches!(a.answer(seq).await, ServerMsg::Ack { .. }));
    }
    let busy = started.elapsed();
    assert!(
        metrics().catchup_notices_total.get() > 0,
        "the slow reader never lagged ({busy:?})"
    );
    // Now it reads: a catchUp notice comes, it pulls, it converges.
    let inspect = server.settled("f").await;
    let mut pulled = false;
    while slow.replica.version < inspect.version {
        match slow.next().await.expect("open") {
            ServerMsg::CatchUp { from, .. } if !pulled => {
                slow.tx
                    .send(&ClientMsg::Pull { since: from - 1 })
                    .await
                    .unwrap();
                pulled = true;
            }
            _ => {}
        }
    }
    assert!(pulled);
    assert!(same_doc(&slow.replica.doc, &inspect.document));
}

/// An engine that panics on a layer named `poison`.
struct Poisoned(OpsEngine);

impl DocEngine for Poisoned {
    fn apply(&mut self, op: &OpInput<'_>) -> Result<Applied, Refusal> {
        if op
            .patch
            .nodes
            .as_ref()
            .is_some_and(|n| n.contains_key("poison"))
        {
            panic!("poison op");
        }
        self.0.apply(op)
    }
    fn revert(&mut self, undo: &DocumentPatch, to: Version) {
        self.0.revert(undo, to)
    }
    fn replace(&mut self, d: DesignDocument, v: Version) {
        self.0.replace(d, v)
    }
    fn document(&mut self) -> Arc<DesignDocument> {
        self.0.document()
    }
    fn version(&self) -> Version {
        self.0.version()
    }
    fn stats(&self) -> EngineStats {
        self.0.stats()
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_poison_op_is_refused_and_the_actor_goes_on() {
    let server = Server::start_with(Options {
        engine: Arc::new(|d, v| Box::new(Poisoned(OpsEngine::new(d.into_model(), v)))),
        ..Default::default()
    })
    .await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let panics = metrics().panics_total.get();
    let patch = DocumentPatch {
        nodes: Some(
            [("poison".to_owned(), Some(rect("poison")))]
                .into_iter()
                .collect(),
        ),
        ..Default::default()
    };
    let seq = a.send_patch(patch).await;
    match a.answer(seq).await {
        ServerMsg::Refused { code, .. } => assert_eq!(code, ErrorCode::DesignDocumentInvalid),
        other => panic!("{other:?}"),
    }
    assert!(metrics().panics_total.get() > panics);
    let seq = a.send_patch(a.move_patch(&["r1"], 1.0, 1.0)).await;
    assert!(matches!(
        a.answer(seq).await,
        ServerMsg::Ack { version: 1, .. }
    ));
    assert!(same_doc(
        &a.replica.doc,
        &server.settled("f").await.document
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_failed_commit_rolls_back_and_peers_resync() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(5), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Editor).await;
    let seq = a.send_patch(a.move_patch(&["r1"], 1.0, 0.0)).await;
    a.answer(seq).await;
    b.reach(1).await;
    server.journal.fail_next(1);
    let seq = a.send_patch(a.move_patch(&["r1"], 50.0, 0.0)).await;
    match a.answer(seq).await {
        ServerMsg::Refused {
            code,
            current_version,
            ..
        } => {
            assert_eq!(code, ErrorCode::DesignUnavailable);
            assert_eq!(current_version, Some(1));
        }
        other => panic!("{other:?}"),
    }
    // b saw version 2, then the rollback to 1.
    loop {
        if let ServerMsg::Rollback { version } = b.next().await.unwrap() {
            assert_eq!(version, 1);
            break;
        }
    }
    let inspect = server.settled("f").await;
    assert_eq!(inspect.version, 1);
    assert_eq!(server.journal.versions("f"), vec![1]);
    // The same op again lands as version 2; b reloads and converges.
    let patch = a.move_patch(&["r1"], 50.0, 0.0);
    a.tx.send(&ClientMsg::Op(Box::new(morfa_protocol::Op {
        seq,
        base_version: 1,
        patch: patch.clone(),
        before: None,
        before_tables: None,
        fields: None,
    })))
    .await
    .unwrap();
    a.replica.sent(seq, patch);
    assert!(matches!(
        a.answer(seq).await,
        ServerMsg::Ack { version: 2, .. }
    ));
    drop(b);
    let b = Editor::join(&server, "f", "b", Role::Editor).await;
    let inspect = server.settled("f").await;
    assert!(same_doc(&b.replica.doc, &inspect.document));
    assert!(same_doc(&a.replica.doc, &inspect.document));
    assert!(same_doc(
        &server.journal.replay("f").unwrap().0,
        &inspect.document
    ));
}

/// TARGETS D3: while the journal's queue is full (PostgreSQL away), ops are refused as busy before they apply:
/// no rollback, the peers see nothing, and the same op lands once the queue drains.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_full_journal_defers_ops_without_a_rollback() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(5), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Editor).await;
    server.journal.set_backlogged(true);
    let patch = a.move_patch(&["r1"], 30.0, 0.0);
    let seq = a.send_patch(patch.clone()).await;
    match a.answer(seq).await {
        ServerMsg::Refused {
            code,
            current_version,
            ..
        } => {
            assert_eq!(code, ErrorCode::DesignLiveBusy);
            assert_eq!(current_version, Some(0));
        }
        other => panic!("{other:?}"),
    }
    assert_eq!(server.settled("f").await.version, 0);
    server.journal.set_backlogged(false);
    a.tx.send(&ClientMsg::Op(Box::new(morfa_protocol::Op {
        seq,
        base_version: 0,
        patch: patch.clone(),
        before: None,
        before_tables: None,
        fields: None,
    })))
    .await
    .unwrap();
    a.replica.sent(seq, patch);
    assert!(matches!(
        a.answer(seq).await,
        ServerMsg::Ack { version: 1, .. }
    ));
    // b got the change and never a rollback.
    loop {
        match b.next().await.unwrap() {
            ServerMsg::Rollback { .. } => panic!("a rollback"),
            ServerMsg::Change(change) if change.version == 1 => break,
            _ => {}
        }
    }
    assert_eq!(server.journal.versions("f"), vec![1]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn viewers_cannot_edit_and_roles_follow_api() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut v = Editor::join(&server, "f", "v", Role::Viewer).await;
    let seq = v.send_patch(v.move_patch(&["r0"], 1.0, 0.0)).await;
    assert!(matches!(
        v.answer(seq).await,
        ServerMsg::Refused {
            code: ErrorCode::DesignForbidden,
            ..
        }
    ));
    // Promoted through the internal push.
    let (status, _) = http(
        &server,
        "POST",
        "/internal/acl",
        r#"{"file":"f","user":"v","role":"editor"}"#,
        Some("secret"),
    )
    .await;
    assert_eq!(status, 200);
    loop {
        if let ServerMsg::Access { role, can_edit } = v.next().await.unwrap() {
            assert_eq!((role, can_edit), (Role::Editor, true));
            break;
        }
    }
    let seq = v.send_patch(v.move_patch(&["r0"], 1.0, 0.0)).await;
    assert!(matches!(v.answer(seq).await, ServerMsg::Ack { .. }));
    // Without the secret the push is refused.
    let (status, _) = http(
        &server,
        "POST",
        "/internal/acl",
        r#"{"file":"f","user":"v","role":null}"#,
        Some("wrong"),
    )
    .await;
    assert_eq!(status, 403);
    // Access removed: bye {access}, then the socket closes.
    let (status, _) = http(
        &server,
        "POST",
        "/internal/acl",
        r#"{"file":"f","user":"v","role":null}"#,
        Some("secret"),
    )
    .await;
    assert_eq!(status, 200);
    loop {
        match v.next().await {
            Some(ServerMsg::Bye { reason }) => {
                assert_eq!(reason, ByeReason::Access);
                break;
            }
            Some(_) => {}
            None => panic!("closed without bye"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn revalidation_demotes_through_api() {
    let acl = Arc::new(morfa_collab::acl::StaticAcl::default());
    let source = acl.clone();
    let server = Server::start_with(Options {
        config: Box::new(|c| c.revalidate = Duration::from_millis(100)),
        acl: Some(source),
        ..Default::default()
    })
    .await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut e = Editor::join(&server, "f", "e", Role::Editor).await;
    acl.set("f", "e", Some(Role::Viewer));
    loop {
        if let ServerMsg::Access { role, can_edit } = e.next().await.unwrap() {
            assert_eq!((role, can_edit), (Role::Viewer, false));
            break;
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn presence_is_coalesced_and_never_echoed() {
    let server = Server::start_with(Options {
        config: Box::new(|c| c.presence_per_second = 10_000),
        ..Default::default()
    })
    .await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Viewer).await;
    // a moves its cursor 300 times in about a second.
    let sender = tokio::spawn(async move {
        for i in 0..300 {
            a.tx.send(&ClientMsg::Presence(PresenceUpdate {
                cursor: Some(Some(Vec2 {
                    x: i as f64,
                    y: 0.0,
                })),
                ..Default::default()
            }))
            .await
            .unwrap();
            tokio::time::sleep(Duration::from_millis(3)).await;
        }
        a
    });
    let started = Instant::now();
    let mut frames = 0;
    let mut last_x = -1.0;
    while last_x < 299.0 {
        if let Some(ServerMsg::Presence { peers }) = b.next().await {
            frames += 1;
            for peer in peers {
                assert_ne!(peer.connection, b.connection, "own presence echoed");
                if let Some(cursor) = peer.presence.cursor {
                    last_x = cursor.x;
                }
            }
        }
    }
    let seconds = started.elapsed().as_secs_f64();
    let rate = frames as f64 / seconds;
    assert!(rate <= 31.0, "{frames} frames in {seconds:.2}s");
    let a = sender.await.unwrap();
    // a never got its own presence back.
    assert!(!a.log.iter().any(|m| matches!(m, ServerMsg::Presence { peers } if peers.iter().any(|p| p.connection == a.connection))));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn bad_tickets_are_refused() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(1), 0);
    let (mut tx, mut rx) = client::connect(&server.url("f"), Wire::Json).await.unwrap();
    let ticket = server.ticket("other-file", "u", Role::Editor);
    tx.send(&ClientMsg::Hello(Hello {
        ticket,
        client_id: ClientId::new("t1"),
        since: None,
        last_seq: 0,
        protocol: PROTOCOL_VERSION,
    }))
    .await
    .unwrap();
    let first = rx.recv().await;
    assert!(
        matches!(
            first,
            Some(ServerMsg::Error {
                code: ErrorCode::BadTicket,
                ..
            })
        ),
        "{first:?}"
    );
    assert!(matches!(
        rx.recv().await,
        Some(ServerMsg::Bye {
            reason: ByeReason::Ticket
        })
    ));
    assert!(rx.recv().await.is_none());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn invalid_and_stale_ops_are_refused() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    // A layer pointing at a missing parent.
    let mut orphan = rect("x1");
    orphan.parent_id = Some("missing".into());
    let patch = DocumentPatch {
        nodes: Some([("x1".to_owned(), Some(orphan))].into_iter().collect()),
        ..Default::default()
    };
    let seq = a.send_patch(patch).await;
    match a.answer(seq).await {
        ServerMsg::Refused { code, node_id, .. } => {
            assert_eq!(code, ErrorCode::DesignDocumentInvalid);
            assert_eq!(node_id.as_deref(), Some("x1"));
        }
        other => panic!("{other:?}"),
    }
    // A malformed patch is refused by the reader with its seq.
    a.tx.send_text(r#"{"t":"op","seq":99,"baseVersion":0,"patch":{"nodes":{"r0":{"id":"r0"}}}}"#)
        .await
        .unwrap();
    assert!(matches!(
        a.answer(99).await,
        ServerMsg::Refused {
            code: ErrorCode::DesignDocumentInvalid,
            ..
        }
    ));
    // A stale op without `before` copies: 409.
    let seq = a.send_patch(a.move_patch(&["r0"], 1.0, 0.0)).await;
    a.answer(seq).await;
    a.seq += 1;
    let patch = a.move_patch(&["r1"], 1.0, 0.0);
    a.tx.send(&ClientMsg::Op(Box::new(morfa_protocol::Op {
        seq: a.seq,
        base_version: 0,
        patch,
        before: None,
        before_tables: None,
        fields: None,
    })))
    .await
    .unwrap();
    assert!(matches!(
        a.answer(a.seq).await,
        ServerMsg::Refused {
            code: ErrorCode::VersionConflict,
            current_version: Some(1),
            ..
        }
    ));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn shadow_op_answers_the_document_hash() {
    let server = Server::start().await;
    let doc = rect_doc(4);
    let mut expected = doc.clone();
    let mut node = expected.nodes["r2"].clone();
    node.x = 77.0;
    let patch = DocumentPatch {
        nodes: Some([("r2".to_owned(), Some(node))].into_iter().collect()),
        ..Default::default()
    };
    let body = format!(
        r#"{{"t":"op","seq":0,"baseVersion":3,"patch":{},"file":"s1","version":4}}"#,
        to_json(&patch)
    );
    let (status, answer) = http(
        &server,
        "POST",
        "/internal/shadow-op",
        &body,
        Some("secret"),
    )
    .await;
    assert_eq!(
        (status, answer.as_str()),
        (404, r#"{"code":"shadow_unseeded"}"#)
    );
    let seeded = format!(
        r#"{{"t":"op","seq":0,"baseVersion":3,"patch":{},"file":"s1","version":4,"document":{}}}"#,
        to_json(&patch),
        to_json(&doc)
    );
    let (status, answer) = http(
        &server,
        "POST",
        "/internal/shadow-op",
        &seeded,
        Some("secret"),
    )
    .await;
    assert_eq!(status, 200, "{answer}");
    patch.apply(&mut expected);
    let answer: serde_json::Value = serde_json::from_str(&answer).unwrap();
    assert_eq!(answer["hash"], document_hash(&expected));
    assert_eq!(answer["version"], 4);
    assert_eq!(answer["applied"], true);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_new_owner_reacks_journaled_ops_and_applies_the_rest() {
    let server = Server::start_with(Options {
        config: Box::new(|c| c.idle_close = Duration::from_millis(50)),
        ..Default::default()
    })
    .await;
    server.journal.insert("f", rect_doc(5), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    for _ in 0..3 {
        let seq = a.send_patch(a.move_patch(&["r1"], 1.0, 0.0)).await;
        a.answer(seq).await;
    }
    // Ops 4 and 5 go out; the socket drops before their acks.
    let p4 = a.move_patch(&["r2"], 0.0, 4.0);
    let s4 = a.send_patch(p4.clone()).await;
    let p5 = a.move_patch(&["r3"], 0.0, 5.0);
    let s5 = a.send_patch(p5.clone()).await;
    let (client, mut replica, version) = (a.client.clone(), a.replica.clone(), a.replica.version);
    drop(a);
    // The actor idles out once the journal has everything; a new one loads from the journal.
    for _ in 0..200 {
        if server.app.docs.get("f").is_none() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert!(
        server.app.docs.get("f").is_none(),
        "the actor never stopped"
    );
    assert_eq!(server.journal.versions("f"), vec![1, 2, 3, 4, 5]);
    replica.refused(s4);
    replica.refused(s5);
    // The client says it sent up to seq 7 (6 and 7 never reached the server).
    let mut a = Editor::join_as(
        &server,
        "f",
        "a",
        Role::Editor,
        client,
        Some(replica),
        7,
        Some(version),
    )
    .await;
    let ServerMsg::Welcome(welcome) = &a.log[0] else {
        panic!()
    };
    assert_eq!(welcome.acked_seq, 0, "the journal does not hold seq 7");
    for (seq, patch) in [(s4, p4), (s5, p5)] {
        a.tx.send(&ClientMsg::Op(Box::new(morfa_protocol::Op {
            seq,
            base_version: version,
            patch,
            before: None,
            before_tables: None,
            fields: None,
        })))
        .await
        .unwrap();
    }
    assert!(matches!(
        a.answer(s4).await,
        ServerMsg::Ack { version: 4, .. }
    ));
    assert!(matches!(
        a.answer(s5).await,
        ServerMsg::Ack { version: 5, .. }
    ));
    a.seq = 5;
    let seq = a.send_patch(a.move_patch(&["r4"], 6.0, 0.0)).await;
    assert_eq!(seq, 6);
    assert!(matches!(
        a.answer(seq).await,
        ServerMsg::Ack { version: 6, .. }
    ));
    let inspect = server.settled("f").await;
    assert_eq!(inspect.version, 6);
    a.reach(6).await;
    assert!(same_doc(&a.replica.doc, &inspect.document));
}

/// A file with clients on both wires: a binary client catching up on changes only JSON clients saw gets them
/// translated, and presence crosses the wires both ways.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn wires_mix_in_one_file() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(5), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    for _ in 0..5 {
        let seq = a.send_patch(a.move_patch(&["r1"], 1.0, 0.0)).await;
        assert!(matches!(a.answer(seq).await, ServerMsg::Ack { .. }));
    }
    // b joins on the binary wire from version 0: the tail holds JSON frames only.
    let mut b = Editor::join_full(
        &server,
        "f",
        "b",
        Role::Editor,
        ClientId::new("tab-b"),
        Some(Replica::new(rect_doc(5), 0)),
        0,
        Some(0),
        Wire::Binary,
    )
    .await;
    b.reach(5).await;
    let inspect = server.settled("f").await;
    assert!(same_doc(&b.replica.doc, &inspect.document));
    // b edits; a (JSON) gets it.
    let seq = b.send_patch(b.move_patch(&["r2"], 0.0, 3.0)).await;
    assert!(matches!(
        b.answer(seq).await,
        ServerMsg::Ack { version: 6, .. }
    ));
    a.reach(6).await;
    // Presence both ways.
    b.tx.send(&ClientMsg::Presence(PresenceUpdate {
        cursor: Some(Some(Vec2 { x: 7.0, y: 8.0 })),
        ..Default::default()
    }))
    .await
    .unwrap();
    loop {
        if let Some(ServerMsg::Presence { peers }) = a.next().await
            && peers
                .iter()
                .any(|p| p.presence.cursor == Some(Vec2 { x: 7.0, y: 8.0 }))
        {
            break;
        }
    }
    a.tx.send(&ClientMsg::Presence(PresenceUpdate {
        cursor: Some(Some(Vec2 { x: 1.0, y: 2.0 })),
        ..Default::default()
    }))
    .await
    .unwrap();
    loop {
        if let Some(ServerMsg::Presence { peers }) = b.next().await
            && peers
                .iter()
                .any(|p| p.presence.cursor == Some(Vec2 { x: 1.0, y: 2.0 }))
        {
            break;
        }
    }
}

/// A client that sends nothing for `silence` is closed `bye {silent}`; one that pings stays (a browser pings every
/// PING_MS).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_silent_client_is_closed_and_a_pinging_one_stays() {
    let server = Server::start_with(Options {
        config: Box::new(|config| config.silence = Duration::from_millis(1500)),
        ..Options::default()
    })
    .await;
    server.journal.insert("f", rect_doc(2), 0);
    let mut silent = Editor::join(&server, "f", "s", Role::Editor).await;
    let mut pinging = Editor::join(&server, "f", "p", Role::Editor).await;
    let started = Instant::now();
    loop {
        match silent.next().await {
            Some(ServerMsg::Bye { reason }) => {
                assert_eq!(reason, ByeReason::Silent);
                break;
            }
            Some(_) => {}
            None => panic!("closed without bye"),
        }
    }
    assert!(started.elapsed() >= Duration::from_millis(1000));
    assert!(silent.next().await.is_none());
    for _ in 0..6 {
        pinging.tx.send(&ClientMsg::Ping).await.unwrap();
        loop {
            match pinging.next().await {
                Some(ServerMsg::Pong) => break,
                Some(ServerMsg::Bye { reason }) => panic!("a pinging client closed: {reason:?}"),
                Some(_) => {}
                None => panic!("a pinging client closed"),
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}
