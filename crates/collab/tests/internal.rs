//! api's bridge and the socket's liveness:
//! `/internal/*` body limits, `replace` with `baseVersion` answered after the commit, `notice` → socket
//! messages, acks before `bye` when the file moves, the shadow copy itself, and server-sent pings.

mod common;

use common::*;
use morfa_collab::metrics::metrics;
use morfa_collab::router::INTERNAL_BODY_BYTES;
use morfa_model::{DocumentPatch, to_json};
use morfa_protocol::{ByeReason, ClientMsg, Role, ServerMsg};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Reads until a message `pick` takes; panics on a close first.
async fn until<T>(editor: &mut Editor, mut pick: impl FnMut(&ServerMsg) -> Option<T>) -> T {
    loop {
        let msg = editor.next().await.expect("socket closed");
        if let Some(found) = pick(&msg) {
            return found;
        }
    }
}

/// Pings and reads to the pong: what came before it.
async fn drain(editor: &mut Editor) -> Vec<ServerMsg> {
    editor.tx.send(&ClientMsg::Ping).await.unwrap();
    let mut seen = Vec::new();
    loop {
        match editor.next().await.expect("socket closed") {
            ServerMsg::Pong => return seen,
            other => seen.push(other),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn notices_reach_the_sockets_as_the_sse_events() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(2), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Viewer).await;
    drain(&mut a).await;
    drain(&mut b).await;
    let (status, body) = http(
        &server,
        "POST",
        "/internal/notice",
        r#"{"file":"f","kind":"comments"}"#,
        Some("secret"),
    )
    .await;
    assert_eq!((status, body.as_str()), (200, r#"{"open":true}"#));
    for editor in [&mut a, &mut b] {
        until(editor, |m| {
            matches!(m, ServerMsg::Comments {}).then_some(())
        })
        .await;
    }
    // A meeting change for everyone, then one only `b`'s own votes changed in.
    for body in [
        r#"{"file":"f","kind":"meeting","revision":4}"#,
        r#"{"file":"f","kind":"meeting","revision":5,"user":"b"}"#,
    ] {
        let (status, _) = http(&server, "POST", "/internal/notice", body, Some("secret")).await;
        assert_eq!(status, 200);
    }
    let meetings = |seen: &[ServerMsg]| {
        seen.iter()
            .filter_map(|m| match m {
                ServerMsg::Meeting { revision, user } => Some((*revision, user.clone())),
                _ => None,
            })
            .collect::<Vec<_>>()
    };
    let at_b = until(&mut b, |m| match m {
        ServerMsg::Meeting { revision: 5, user } => Some(user.clone()),
        _ => None,
    })
    .await;
    assert_eq!(at_b.as_deref(), Some("b"));
    assert_eq!(meetings(&drain(&mut a).await), vec![(4, None)]);
    // The wire form is the SSE event's data.
    assert_eq!(
        String::from_utf8(
            morfa_protocol::JsonCodec
                .encode_server(&ServerMsg::Meeting {
                    revision: 5,
                    user: Some("b".into())
                })
                .bytes
                .to_vec()
        )
        .unwrap(),
        r#"{"t":"meeting","revision":5,"user":"b"}"#
    );
    // Unknown kinds and files nobody holds.
    let (status, _) = http(
        &server,
        "POST",
        "/internal/notice",
        r#"{"file":"f","kind":"meeting"}"#,
        Some("secret"),
    )
    .await;
    assert_eq!(status, 400);
    let (status, body) = http(
        &server,
        "POST",
        "/internal/notice",
        r#"{"file":"nobody","kind":"comments"}"#,
        Some("secret"),
    )
    .await;
    assert_eq!((status, body.as_str()), (200, r#"{"open":false}"#));
    let (status, _) = http(
        &server,
        "POST",
        "/internal/notice",
        r#"{"file":"f","kind":"comments"}"#,
        None,
    )
    .await;
    assert_eq!(status, 403);
}

use morfa_protocol::Codec;

fn replace_body(file: &str, base: Option<u64>, doc: &morfa_model::DesignDocument) -> String {
    let base = base.map_or(String::new(), |b| format!(r#","baseVersion":{b}"#));
    format!(
        r#"{{"file":"{file}","user":"api"{base},"document":{}}}"#,
        to_json(doc)
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_replace_checks_its_base_and_answers_after_the_commit() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(3), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let seq = a.send_patch(a.move_patch(&["r1"], 5.0, 0.0)).await;
    a.answer(seq).await;
    let next = rect_doc(7);
    // Made on version 0, the actor is at 1: refused with where it is.
    let (status, body) = http(
        &server,
        "POST",
        "/internal/replace",
        &replace_body("f", Some(0), &next),
        Some("secret"),
    )
    .await;
    assert_eq!(status, 409, "{body}");
    let answer: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(answer["code"], "version_conflict");
    assert_eq!(answer["currentVersion"], 1);
    assert_eq!(server.settled("f").await.version, 1);
    // On the current version, with a slow journal: the answer waits for the commit.
    server.journal.delay_commits(Duration::from_millis(400));
    let started = Instant::now();
    let (status, body) = http(
        &server,
        "POST",
        "/internal/replace",
        &replace_body("f", Some(1), &next),
        Some("secret"),
    )
    .await;
    assert_eq!(status, 200, "{body}");
    assert!(started.elapsed() >= Duration::from_millis(400));
    assert_eq!(body, r#"{"open":true,"version":2}"#);
    assert_eq!(server.journal.versions("f"), vec![1, 2]);
    assert!(same_doc(&server.journal.replay("f").unwrap().0, &next));
    let closed = until(&mut a, |m| match m {
        ServerMsg::Bye { reason } => Some(*reason),
        _ => None,
    })
    .await;
    assert_eq!(closed, ByeReason::Replaced);
    server.journal.delay_commits(Duration::ZERO);

    // A replace whose commit fails: 503, and the document it replaced is back.
    let _b = Editor::join(&server, "f", "b", Role::Editor).await;
    server.journal.fail_next(1);
    let (status, _) = http(
        &server,
        "POST",
        "/internal/replace",
        &replace_body("f", None, &rect_doc(1)),
        Some("secret"),
    )
    .await;
    assert_eq!(status, 503);
    let inspect = server.settled("f").await;
    assert_eq!(inspect.version, 2);
    assert!(same_doc(&inspect.document, &next));
    // Without a base (older api builds): replaced whatever the version.
    let (status, body) = http(
        &server,
        "POST",
        "/internal/replace",
        &replace_body("f", None, &rect_doc(1)),
        Some("secret"),
    )
    .await;
    assert_eq!(
        (status, body.as_str()),
        (200, r#"{"open":true,"version":3}"#)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn internal_bodies_up_to_a_whole_document_at_the_cap() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(1), 0);
    let _a = Editor::join(&server, "f", "a", Role::Editor).await;
    // A document over 6 MiB (axum's default limit is 2 MiB): read and replaced.
    let big = rect_doc(20_000);
    let body = replace_body("f", Some(0), &big);
    assert!(body.len() > 6 * 1024 * 1024, "{}", body.len());
    let (status, answer) = http(&server, "POST", "/internal/replace", &body, Some("secret")).await;
    assert_eq!(status, 200, "{}", &answer[..answer.len().min(200)]);
    // Past the limit: 413 (api then lets the node go and writes it itself).
    let over = format!(
        r#"{{"file":"f","user":"api","pad":"{}","document":{{}}}}"#,
        "x".repeat(INTERNAL_BODY_BYTES)
    );
    let (status, _) = http(&server, "POST", "/internal/replace", &over, Some("secret")).await;
    assert_eq!(status, 413);
    // A shadow seed of the same size is read too.
    let seeded = format!(
        r#"{{"t":"op","seq":0,"baseVersion":0,"patch":{{}},"file":"s","version":0,"document":{}}}"#,
        to_json(&big)
    );
    let (status, _) = http(
        &server,
        "POST",
        "/internal/shadow-op",
        &seeded,
        Some("secret"),
    )
    .await;
    assert_eq!(status, 200);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_moved_file_acks_every_committed_op_before_bye() {
    let server = Server::start().await;
    server.journal.insert("f", rect_doc(5), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    // Ops whose commits are still running when the file moves.
    server.journal.delay_commits(Duration::from_millis(300));
    let mut seqs = Vec::new();
    for i in 0..5 {
        seqs.push(
            a.send_patch(a.move_patch(&[&format!("r{i}")], 1.0, 0.0))
                .await,
        );
    }
    // The actor applied them, none committed yet.
    let deadline = Instant::now() + Duration::from_secs(5);
    while server.inspect("f").await.version < 5 {
        assert!(Instant::now() < deadline, "the ops did not apply");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    assert!(server.journal.versions("f").len() < 5);
    let (status, _) = http(
        &server,
        "POST",
        "/internal/file",
        r#"{"file":"f","close":"moved"}"#,
        Some("secret"),
    )
    .await;
    assert_eq!(status, 200);
    let mut acked = Vec::new();
    loop {
        match a.next().await.expect("closed without bye") {
            ServerMsg::Ack { seq, .. } => acked.push(seq),
            ServerMsg::Bye { reason } => {
                assert_eq!(reason, ByeReason::Moved);
                break;
            }
            ServerMsg::Refused { seq, .. } => panic!("op {seq} refused"),
            _ => {}
        }
    }
    assert_eq!(acked, seqs, "every committed op acked before bye");
    assert_eq!(server.journal.versions("f"), vec![1, 2, 3, 4, 5]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_shadow_copy_is_served_whole() {
    let server = Server::start().await;
    let doc = rect_doc(3);
    let mut node = doc.nodes["r2"].clone();
    node.x = 9.0;
    let patch = DocumentPatch {
        nodes: Some([("r2".to_owned(), Some(node))].into_iter().collect()),
        ..Default::default()
    };
    let (status, _) = http(
        &server,
        "GET",
        "/internal/shadow-doc/s1",
        "",
        Some("secret"),
    )
    .await;
    assert_eq!(status, 404);
    let seeded = format!(
        r#"{{"t":"op","seq":0,"baseVersion":3,"patch":{},"file":"s1","version":4,"document":{}}}"#,
        to_json(&patch),
        to_json(&doc)
    );
    let (status, _) = http(
        &server,
        "POST",
        "/internal/shadow-op",
        &seeded,
        Some("secret"),
    )
    .await;
    assert_eq!(status, 200);
    let (status, body) = http(
        &server,
        "GET",
        "/internal/shadow-doc/s1",
        "",
        Some("secret"),
    )
    .await;
    assert_eq!(status, 200);
    let mut expected = doc.clone();
    patch.apply(&mut expected);
    assert_eq!(
        body,
        format!(r#"{{"version":4,"document":{}}}"#, to_json(&expected))
    );
    let (status, _) = http(&server, "GET", "/internal/shadow-doc/s1", "", None).await;
    assert_eq!(status, 403);
}

/// A background tab's timers may run once a minute, so its own `ping` comes too late: the server's WebSocket
/// pings (answered by the client's socket layer, not its code) keep it open; a socket that answers nothing is
/// still closed.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn server_pings_keep_a_quiet_client_and_close_a_dead_one() {
    let server = Server::start_with(Options {
        config: Box::new(|config| {
            config.ping = Duration::from_millis(300);
            config.silence = Duration::from_millis(1500);
        }),
        ..Options::default()
    })
    .await;
    server.journal.insert("f", rect_doc(2), 0);
    let mut quiet = Editor::join(&server, "f", "q", Role::Viewer).await;
    let dead = Editor::join(&server, "f", "d", Role::Viewer).await;
    let pings = metrics().pings_sent_total.get();
    // `quiet` never sends a message of its own, but its socket is read (and so answers the pings); `dead` is
    // never read (its pings stay unanswered).
    let started = Instant::now();
    while started.elapsed() < Duration::from_secs(4) {
        match tokio::time::timeout(Duration::from_millis(200), quiet.rx.recv()).await {
            Ok(Some(ServerMsg::Bye { reason })) => panic!("a quiet client closed: {reason:?}"),
            Ok(None) => panic!("a quiet client closed after {:?}", started.elapsed()),
            Ok(Some(_)) | Err(_) => {}
        }
    }
    assert!(metrics().pings_sent_total.get() > pings, "pings were sent");
    assert_eq!(server.inspect("f").await.conns, 1, "the dead socket closed");
    drop(dead);
    // The quiet one still edits nothing but is there.
    let inspect = server.inspect("f").await;
    assert_eq!(inspect.conns, 1);
}

/// Two api processes forward one file, each with its own idea of where the copy is: an op that applied at Node on
/// another version than the copy's is not applied (409 `shadow_stale`), so a seed from one process never turns into a
/// difference for the other.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_shadow_op_on_a_moved_copy_is_stale_not_applied() {
    let server = Server::start().await;
    let doc = rect_doc(3);
    let moved = |x: f64| {
        let mut node = doc.nodes["r1"].clone();
        node.x = x;
        to_json(&DocumentPatch {
            nodes: Some([("r1".to_owned(), Some(node))].into_iter().collect()),
            ..Default::default()
        })
    };
    let post = |body: String| {
        let server = &server;
        async move {
            let (status, answer) =
                http(server, "POST", "/internal/shadow-op", &body, Some("secret")).await;
            (
                status,
                serde_json::from_str::<serde_json::Value>(&answer).unwrap(),
            )
        }
    };
    // Process A seeds at 5 and applies 6; process B seeds again at 4 (its document is older).
    let (status, _) = post(format!(
        r#"{{"t":"op","seq":1,"baseVersion":5,"patch":{},"file":"s2","version":6,"appliedOn":5,"document":{}}}"#,
        moved(10.0),
        to_json(&doc)
    ))
    .await;
    assert_eq!(status, 200);
    let (status, _) = post(format!(
        r#"{{"t":"op","seq":1,"baseVersion":4,"patch":{},"file":"s2","version":5,"appliedOn":4,"document":{}}}"#,
        moved(20.0),
        to_json(&doc)
    ))
    .await;
    assert_eq!(status, 200);
    // A's next op applied on 6 at Node: the copy is at 5 now.
    let (status, answer) = post(format!(
        r#"{{"t":"op","seq":2,"baseVersion":6,"patch":{},"file":"s2","version":7,"appliedOn":6}}"#,
        moved(30.0)
    ))
    .await;
    assert_eq!(
        (status, &answer["code"]),
        (409, &serde_json::json!("shadow_stale"))
    );
    assert_eq!(answer["version"], 5);
    // B's next one fits; without `appliedOn` (older api builds) nothing is checked.
    let (status, answer) = post(format!(
        r#"{{"t":"op","seq":2,"baseVersion":5,"patch":{},"file":"s2","version":6,"appliedOn":5}}"#,
        moved(40.0)
    ))
    .await;
    assert_eq!(
        (status, answer["applied"].clone()),
        (200, serde_json::json!(true))
    );
    let (status, _) = post(format!(
        r#"{{"t":"op","seq":3,"baseVersion":6,"patch":{},"file":"s2","version":7}}"#,
        moved(50.0)
    ))
    .await;
    assert_eq!(status, 200);
}

/// Over the memory cap the node opens no new file: the join gets `bye {limit}` and the lease api's /session took for
/// this node is let go (the reconnect's /session picks another node); /healthz says `memory.full`.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn over_the_memory_cap_a_new_file_is_refused_and_its_lease_let_go() {
    use morfa_collab::lease::Lease;
    let server = Server::start_with(Options {
        // Any process is over one byte.
        config: Box::new(|config| config.memory_limit = Some(1)),
        ..Options::default()
    })
    .await;
    server.journal.insert("f", rect_doc(2), 0);
    // api's /session took the lease for this node.
    server.lease.steal("f", "local");
    let refused = metrics().joins_refused_memory_total.get();
    let (mut tx, mut rx) =
        morfa_collab::client::connect(&server.url("f"), morfa_protocol::Wire::Json)
            .await
            .unwrap();
    tx.send(&ClientMsg::Hello(morfa_protocol::Hello {
        ticket: server.ticket("f", "a", Role::Editor),
        client_id: morfa_protocol::ClientId::new("tab-mem"),
        since: None,
        last_seq: 0,
        protocol: morfa_protocol::PROTOCOL_VERSION,
    }))
    .await
    .unwrap();
    match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
        Ok(Some(ServerMsg::Bye { reason })) => assert_eq!(reason, ByeReason::Limit),
        other => panic!("{other:?}"),
    }
    assert!(metrics().joins_refused_memory_total.get() > refused);
    assert!(server.app.docs.get("f").is_none(), "no actor started");
    assert!(
        server.lease.acquire("f", "another-node").await.is_ok(),
        "the lease is free for another node"
    );
    let (status, body) = http(&server, "GET", "/healthz", "", None).await;
    assert_eq!(status, 200);
    let health: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(health["memory"]["full"], true);
    assert_eq!(health["memory"]["limit"], 1);
    assert!(health["memory"]["rss"].as_u64().unwrap() > 0);
}

/// /healthz lists each shard's measured CPU, sockets and the messages waiting in its files' inboxes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn healthz_shows_each_shard() {
    let server = Server::start_with(Options {
        config: Box::new(|config| config.shards = 2),
        ..Options::default()
    })
    .await;
    server.journal.insert("f", rect_doc(2), 0);
    let _a = Editor::join(&server, "f", "a", Role::Editor).await;
    let (status, body) = http(&server, "GET", "/healthz", "", None).await;
    assert_eq!(status, 200);
    let health: serde_json::Value = serde_json::from_str(&body).unwrap();
    let shards = health["shards"].as_array().unwrap();
    assert_eq!(shards.len(), 2);
    assert_eq!(
        shards
            .iter()
            .map(|s| s["conns"].as_u64().unwrap())
            .sum::<u64>(),
        1
    );
    assert!(
        shards
            .iter()
            .all(|s| s["busy"].is_u64() && s["queued"].is_u64())
    );
}

/// A shard that stays hot while another is cool gives up its busiest room: its editors get their acks and
/// `bye {moved}`, reconnect, and the file opens again on the cool shard (lane B7's K1 case: files opened while quiet
/// stay packed when their editors arrive).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_hot_shard_gives_up_its_busiest_room() {
    let server = Server::start_with(Options {
        config: Box::new(|config| config.shards = 2),
        ..Options::default()
    })
    .await;
    server.journal.insert("busy", rect_doc(3), 0);
    server.journal.insert("quiet", rect_doc(3), 0);
    let mut a = Editor::join(&server, "busy", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "busy", "b", Role::Editor).await;
    let _q = Editor::join(&server, "quiet", "q", Role::Editor).await;
    let shards = &server.app.shards;
    assert_eq!(shards.shard_of("busy"), Some(0));
    assert_eq!(shards.shard_of("quiet"), Some(0));
    let seq = a.send_patch(a.move_patch(&["r1"], 1.0, 0.0)).await;
    // Shard 0 measured hot, shard 1 idle, held there while the room moves and reopens (the shards' own samples
    // would overwrite it every 500 ms).
    let hold = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let holder = {
        let (app, hold) = (server.app.clone(), Arc::clone(&hold));
        std::thread::spawn(move || {
            while hold.load(std::sync::atomic::Ordering::Relaxed) {
                app.shards.set_busy(0, 950);
                app.shards.set_busy(1, 50);
                std::thread::sleep(Duration::from_millis(1));
            }
        })
    };
    let mut moved = None;
    for _ in 0..10 {
        tokio::time::sleep(Duration::from_millis(20)).await;
        if let Some(file) = server.app.rebalance_once().await {
            moved = Some(file);
            break;
        }
    }
    assert_eq!(moved.as_deref(), Some("busy"));
    let mut acked = false;
    loop {
        match a.next().await.expect("closed without bye") {
            ServerMsg::Ack { seq: s, .. } if s == seq => acked = true,
            ServerMsg::Bye { reason } => {
                assert_eq!(reason, ByeReason::Moved);
                break;
            }
            _ => {}
        }
    }
    assert!(acked, "the op was acked before bye");
    until(&mut b, |m| {
        matches!(
            m,
            ServerMsg::Bye {
                reason: ByeReason::Moved
            }
        )
        .then_some(())
    })
    .await;
    drop((a, b));
    // The editors come back: the file opens on the cool shard, with the op in it.
    let deadline = Instant::now() + Duration::from_secs(5);
    let back = loop {
        if server.app.docs.get("busy").is_none() {
            break Editor::join(&server, "busy", "a", Role::Editor).await;
        }
        assert!(Instant::now() < deadline, "the room did not close");
        tokio::time::sleep(Duration::from_millis(10)).await;
    };
    assert_eq!(shards.shard_of("busy"), Some(1));
    assert_eq!(back.replica.version, 1);
    assert_eq!(shards.shard_of("quiet"), Some(0), "the other room stays");
    assert!(metrics().rebalances_total.get() >= 1);
    hold.store(false, std::sync::atomic::Ordering::Relaxed);
    holder.join().unwrap();
}
