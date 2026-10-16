//! docs/BACKEND.md §8 "Split brain": two processes hold the same file on purpose. The stale owner's journal writes are
//! refused by the fence, it stops (`bye {moved}` in the service) and never acks an op after the takeover; the
//! survivor's document equals the journal's replay.

mod common;

use morfa_blobs::DirStore;
use morfa_checkpoint::{Checkpoints, Format};
use morfa_journal::testdb::TestDb;
use morfa_storagesim::{digest, expected};
use std::time::Duration;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_stale_owner_is_fenced_and_the_survivor_matches_the_journal() {
    let Some(db) =
        TestDb::create("the_stale_owner_is_fenced_and_the_survivor_matches_the_journal").await
    else {
        return;
    };
    let files = common::files(&db, 1).await;
    let file = files[0].clone();
    let store = common::temp_store("split-brain");
    // A holds the file with a long lease and keeps writing; it never stops on its own.
    let a = common::Node::spawn(
        &db,
        &store,
        "node-a",
        &files,
        &[
            "--rate",
            "200",
            "--inflight",
            "8",
            "--checkpoint-every",
            "100",
            "--ttl-ms",
            "15000",
            "--renew-ms",
            "300",
        ],
    );
    a.wait_for("ACK", 300, Duration::from_secs(30)).await;
    // B takes the file while A is alive (api's view says A is gone; it is not).
    let b = common::Node::spawn(
        &db,
        &store,
        "node-b",
        &files,
        &[
            "--rate",
            "200",
            "--inflight",
            "8",
            "--checkpoint-every",
            "100",
            "--steal",
            "--duration-ms",
            "3000",
        ],
    );
    b.wait_for("READY", 1, Duration::from_secs(30)).await;
    let ready = b.of("READY");
    let (base, fence_b): (u64, i64) = (
        ready[0].1[0].parse().unwrap(),
        ready[0].1[1].parse().unwrap(),
    );
    let a_events = a.finish().await;
    let b_events = b.finish().await;
    let a_events = a_events.lock().unwrap().clone();
    let b_events = b_events.lock().unwrap().clone();
    // A learned it lost the file: by its fenced journal write or by its renewal.
    assert!(
        a_events
            .iter()
            .any(|(kind, _, _)| kind == "FENCED" || kind == "LOST"),
        "A was told: {:?}",
        &a_events[a_events.len().saturating_sub(5)..]
    );
    assert!(a_events.iter().any(|(kind, _, _)| kind == "STOPPED"));
    // A never acked an op past the takeover.
    let a_top = a_events
        .iter()
        .filter(|(kind, _, _)| kind == "ACK")
        .map(|(_, _, rest)| rest[0].parse::<u64>().unwrap())
        .max()
        .unwrap();
    assert!(a_top <= base, "A acked {a_top} after B took over at {base}");
    // B finished every op it started; its document is the journal's.
    let done = b_events
        .iter()
        .find(|(kind, _, _)| kind == "DONE")
        .expect("B finished");
    let (version, b_digest): (u64, &str) = (done.2[0].parse().unwrap(), &done.2[1]);
    assert!(version > base);
    let loaded = Checkpoints::new(DirStore::new(&store), &db.url, Format::Bin)
        .load(&file)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(loaded.version, version);
    assert_eq!(
        digest(&loaded.doc),
        b_digest,
        "the survivor's document equals the journal replay"
    );
    assert_eq!(
        b_digest,
        digest(&expected(version, common::RECTS, common::LAYERS))
    );
    // Every row after the takeover carries B's fence.
    let stale: i64 = db
        .client()
        .await
        .query_one("SELECT count(*) FROM design_file_changes WHERE file_id=$1 AND version>$2 AND fence IS DISTINCT FROM $3", &[&file, &(base as i64), &fence_b])
        .await
        .unwrap()
        .get(0);
    assert_eq!(stale, 0);
    eprintln!(
        "split brain: A acked through {a_top}, B took over at {base} (fence {fence_b}) and journaled through {version}"
    );
    let _ = std::fs::remove_dir_all(&store);
    db.drop_db().await;
}
