//! Convergence: 2, 5 and 100 editors edit one file at once; every editor's replica, the
//! server's document and the journal's replay end equal.

mod common;

use common::*;
use morfa_protocol::{ErrorCode, Role, ServerMsg, Wire};
use rand::{Rng, SeedableRng};

async fn run(editors: usize, ops_each: usize, nodes: usize, seed: u64) {
    run_on(editors, ops_each, nodes, seed, 0).await
}

/// With `shards` > 0 the sockets move to shard threads after the upgrade (crate::shard).
async fn run_on(editors: usize, ops_each: usize, nodes: usize, seed: u64, shards: usize) {
    run_wires(editors, ops_each, nodes, seed, shards, None, |_| Wire::Json).await
}

/// Editor `e` speaks `wire(e)`; `send_buffer` shrinks the server's socket buffers (writes then fill sockets, as
/// on macOS's loopback).
#[allow(clippy::too_many_arguments)]
async fn run_wires(
    editors: usize,
    ops_each: usize,
    nodes: usize,
    seed: u64,
    shards: usize,
    send_buffer: Option<usize>,
    wire: impl Fn(usize) -> Wire,
) {
    let server = Server::start_with(Options {
        config: Box::new(move |config| {
            config.shards = shards;
            config.send_buffer = send_buffer;
        }),
        ..Options::default()
    })
    .await;
    let file = format!("conv-{editors}");
    server.journal.insert(&file, rect_doc(nodes), 0);
    let mut tasks = Vec::new();
    for e in 0..editors {
        let mut editor =
            Editor::join_wire(&server, &file, &format!("u{e}"), Role::Editor, wire(e)).await;
        tasks.push(tokio::spawn(async move {
            let mut rng = rand::rngs::StdRng::seed_from_u64(seed + e as u64);
            let (mut acked, mut conflicts) = (0, 0);
            while acked < ops_each {
                // 1–3 layers, sometimes ones others move too.
                let count = rng.gen_range(1..=3);
                let ids: Vec<String> = (0..count)
                    .map(|_| format!("r{}", rng.gen_range(0..nodes)))
                    .collect();
                let mut ids: Vec<&str> = ids.iter().map(String::as_str).collect();
                ids.sort();
                ids.dedup();
                let patch = editor.move_patch(&ids, rng.gen_range(-5.0..5.0_f64).round(), 1.0);
                let seq = editor.send_patch(patch).await;
                match editor.answer(seq).await {
                    ServerMsg::Ack { .. } => acked += 1,
                    ServerMsg::Refused {
                        code: ErrorCode::VersionConflict,
                        ..
                    } => conflicts += 1,
                    other => panic!("editor {e}: {other:?}"),
                }
                if conflicts > ops_each * 50 {
                    panic!("editor {e}: livelock");
                }
            }
            (editor, conflicts)
        }));
    }
    let mut done = Vec::new();
    for task in tasks {
        done.push(task.await.unwrap());
    }
    let inspect = server.settled(&file).await;
    // Every acked op is a version, except one the merge left nothing of (two editors made the same move): the
    // Node route stores nothing for those either, and acks them on the version they found.
    assert!(inspect.version <= (editors * ops_each) as u64);
    assert!(inspect.version >= (editors * ops_each) as u64 * 9 / 10);
    let conflicts: usize = done.iter().map(|(_, c)| c).sum();
    for (editor, _) in done.iter_mut() {
        editor.reach(inspect.version).await;
        assert_eq!(editor.replica.version, inspect.version);
        assert!(
            same_doc(&editor.replica.doc, &inspect.document),
            "{} diverged",
            editor.user
        );
    }
    let (replayed, version) = server.journal.replay(&file).unwrap();
    assert_eq!(version, inspect.version);
    assert!(
        same_doc(&replayed, &inspect.document),
        "journal replay diverged"
    );
    let m = morfa_collab::metrics::metrics();
    eprintln!(
        "{editors} editors × {ops_each} ops: {conflicts} conflicts retried; fanout {}; ack {}; apply {}; longest \
         wait {} ms",
        m.op_fanout.summary_ms(),
        m.op_ack.summary_ms(),
        m.op_apply.summary_ms(),
        MAX_WAIT_MS.load(std::sync::atomic::Ordering::Relaxed)
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_editors_converge() {
    run(2, 50, 20, 1).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn five_editors_converge() {
    run(5, 40, 50, 2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn hundred_editors_converge() {
    run(100, 10, 2000, 3).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editors_on_shard_threads_converge() {
    run_on(20, 10, 200, 4, 2).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editors_on_the_binary_wire_converge() {
    run_wires(5, 40, 50, 5, 0, None, |_| Wire::Binary).await;
}

/// Half the editors on each wire: every change reaches the others on theirs. 4 KiB socket buffers: frames go
/// out in parts, through the writer's partial writes and the actor's half-sent direct writes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn editors_on_both_wires_converge() {
    run_wires(10, 20, 100, 6, 2, Some(4096), |e| {
        if e % 2 == 0 { Wire::Json } else { Wire::Binary }
    })
    .await;
}
