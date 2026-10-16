//! TARGETS D2: `kill -9` of a collab node under load loses no acked op, and a new owner serves within 3 s
//! (checkpoint + journal tail). Runs `B2_DURABILITY_RUNS` times (default 2).

mod common;

use morfa_blobs::DirStore;
use morfa_checkpoint::{Checkpoints, Format};
use morfa_journal::Lease;
use morfa_journal::testdb::TestDb;
use morfa_lease::PgLease;
use morfa_storagesim::{digest, expected};
use std::time::{Duration, Instant};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn kill_9_under_load_loses_no_acked_op() {
    let runs: usize = std::env::var("B2_DURABILITY_RUNS")
        .ok()
        .and_then(|n| n.parse().ok())
        .unwrap_or(2);
    for run in 0..runs {
        let Some(db) = TestDb::create("kill_9_under_load_loses_no_acked_op").await else {
            return;
        };
        let files = common::files(&db, 5).await;
        let store = common::temp_store(&format!("durability-{run}"));
        let node = common::Node::spawn(
            &db,
            &store,
            "node-a",
            &files,
            &[
                "--rate",
                "150",
                "--inflight",
                "16",
                "--checkpoint-every",
                "100",
                "--keep",
                "50",
            ],
        );
        // Kill at a different moment each run, mid-stream: ops in flight, checkpoints being written.
        node.wait_for("ACK", 1200 + 250 * run, Duration::from_secs(60))
            .await;
        let checkpoints_before_kill = node.count("CKPT");
        let events = node.kill().await;
        let killed = Instant::now();
        let acked = {
            let mut acked = std::collections::HashMap::<String, u64>::new();
            for (kind, file, rest) in events.lock().unwrap().iter() {
                if kind == "ACK" {
                    let version: u64 = rest[0].parse().unwrap();
                    let top = acked.entry(file.clone()).or_default();
                    *top = (*top).max(version);
                }
            }
            acked
        };
        // api sees the node's health check fail and expires its leases at once; a new owner takes each file.
        let lease = PgLease::new(&db.url);
        lease.expire_node("node-a").await.unwrap();
        let checkpoints = std::sync::Arc::new(Checkpoints::new(
            DirStore::new(&store),
            &db.url,
            Format::Bin,
        ));
        let mut loads = Vec::new();
        for file in &files {
            let (checkpoints, file, url) = (checkpoints.clone(), file.clone(), db.url.clone());
            loads.push(tokio::spawn(async move {
                let grant = PgLease::new(&url)
                    .acquire(&file, "node-b", Duration::from_secs(15))
                    .await
                    .unwrap_or_else(|error| panic!("{file}: acquire: {error}"))
                    .expect("free after expiry");
                let loaded = checkpoints
                    .load(&file)
                    .await
                    .unwrap_or_else(|error| panic!("{file}: load: {error}"))
                    .unwrap();
                (file, grant.fence, loaded)
            }));
        }
        let mut served = Vec::new();
        for load in loads {
            served.push(load.await.unwrap());
        }
        let serving = killed.elapsed();
        assert!(
            serving <= Duration::from_secs(3),
            "new owner serving after {serving:?}"
        );
        let mut from_checkpoint = 0;
        for (file, fence, loaded) in served {
            assert_eq!(fence, 2, "one new owner");
            let top = acked.get(&file).copied().unwrap_or(1);
            assert!(
                loaded.version >= top,
                "{file}: loaded {} but {top} was acked",
                loaded.version
            );
            assert_eq!(
                digest(&loaded.doc),
                digest(&expected(loaded.version, common::RECTS, common::LAYERS)),
                "{file}: the document at {} is not the journal's",
                loaded.version
            );
            from_checkpoint += usize::from(loaded.checkpoint_version.is_some());
        }
        eprintln!(
            "run {run}: acked {} ops, {checkpoints_before_kill} checkpoints, new owner served {} files in {serving:?} ({from_checkpoint} from a checkpoint)",
            acked.values().map(|v| v - 1).sum::<u64>(),
            files.len()
        );
        assert!(from_checkpoint > 0, "the cold loads used checkpoints");
        let _ = std::fs::remove_dir_all(&store);
        db.drop_db().await;
    }
}
