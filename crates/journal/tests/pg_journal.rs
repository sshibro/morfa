//! PgJournal against PostgreSQL (MORFA_B2_PG_URL; skipped without it).

use morfa_journal::testdb::TestDb;
use morfa_journal::{Body, ClientOp, Config, Entry, Journal, JournalError, PgJournal};
use std::sync::Arc;
use std::time::Duration;

fn entry(file: &str, version: u64, fence: u64, seq: u64) -> Entry {
    Entry {
        file: file.into(),
        version,
        fence,
        client: Some(ClientOp {
            id: "tab-1".into(),
            seq,
        }),
        user_id: Some("user".into()),
        body: Body::Op(format!("op {version}").into_bytes()),
    }
}

async fn own(db: &TestDb, file: &str, fence: i64) {
    db.client()
        .await
        .execute(
            "UPDATE design_files SET fence=$2,collab_node='n',lease_until=now()+interval '15 s' WHERE id=$1",
            &[&file, &fence],
        )
        .await
        .unwrap();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn appends_commit_in_order_and_read_back() {
    let Some(db) = TestDb::create("appends_commit_in_order_and_read_back").await else {
        return;
    };
    let file = db.file(&db.client().await).await;
    own(&db, &file, 1).await;
    let journal = PgJournal::start(Config::new(&db.url));
    for version in 2..=6 {
        journal
            .append(entry(&file, version, 1, version))
            .await
            .unwrap();
    }
    let rows = journal.tail(&file, 3, 10).await.unwrap();
    assert_eq!(
        rows.iter().map(|row| row.version).collect::<Vec<_>>(),
        [4, 5, 6]
    );
    assert_eq!(rows[0].body, Body::Op(b"op 4".to_vec()));
    assert_eq!(rows[0].fence, Some(1));
    assert_eq!(
        rows[0].client,
        Some(ClientOp {
            id: "tab-1".into(),
            seq: 4
        })
    );
    assert_eq!(rows[0].user_id.as_deref(), Some("user"));
    assert_eq!(journal.tail(&file, 0, 2).await.unwrap().len(), 2);
    // The file's version follows the journal: design_files.version, or with MORFA_JOURNAL_VERSION_HEADS=1 the head
    // beside it (migration 016) while design_files.version stays where it was.
    let row = db
        .client()
        .await
        .query_one(
            "SELECT f.version,h.version AS head FROM design_files f
               LEFT JOIN design_file_heads h ON h.file_id=f.id WHERE f.id=$1",
            &[&file],
        )
        .await
        .unwrap();
    let (version, head): (i64, Option<i64>) = (row.get(0), row.get(1));
    if morfa_journal::version_heads() {
        assert_eq!((version, head), (1, Some(6)));
    } else {
        assert_eq!((version, head), (6, None));
    }
    assert_eq!(
        journal.find_client_op(&file, "tab-1", 5).await.unwrap(),
        Some(5)
    );
    assert_eq!(
        journal.find_client_op(&file, "tab-1", 50).await.unwrap(),
        None
    );
    // The same op again (a retry) is a success; other content at the same version is a conflict.
    journal.append(entry(&file, 6, 1, 6)).await.unwrap();
    let mut other = entry(&file, 6, 1, 7);
    other.body = Body::Op(b"something else".to_vec());
    assert_eq!(
        journal.append(other).await,
        Err(JournalError::Conflict {
            file: file.as_str().into(),
            version: 6
        })
    );
    // A re-sent op under a new version is refused by the client index.
    assert!(matches!(
        journal.append(entry(&file, 7, 1, 6)).await,
        Err(JournalError::Conflict { version: 7, .. })
    ));
    // The refused op above left nothing: the file is still at 6.
    let version: i64 = db
        .client()
        .await
        .query_one(
            "SELECT greatest(f.version,coalesce(h.version,0)) FROM design_files f
               LEFT JOIN design_file_heads h ON h.file_id=f.id WHERE f.id=$1",
            &[&file],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(version, 6);
    // A version that would leave a hole below it is refused, never acked over the gap.
    assert!(matches!(
        journal.append(entry(&file, 8, 1, 8)).await,
        Err(JournalError::Conflict { version: 8, .. })
    ));
    // Submitted in order, answered on other tasks in any order: both commit.
    let (seven, eight) = (
        journal.submit(entry(&file, 7, 1, 7)),
        journal.submit(entry(&file, 8, 1, 8)),
    );
    let eight = tokio::spawn(eight);
    let seven = tokio::spawn(seven);
    eight.await.unwrap().unwrap();
    seven.await.unwrap().unwrap();
    assert_eq!(
        journal
            .tail(&file, 6, 10)
            .await
            .unwrap()
            .iter()
            .map(|row| row.version)
            .collect::<Vec<_>>(),
        [7, 8]
    );
    // Pruning keeps the newest `keep` versions and never passes the checkpoint.
    assert_eq!(journal.prune_below(&file, 4, 1).await.unwrap(), 3);
    assert_eq!(journal.tail(&file, 0, 10).await.unwrap()[0].version, 5);
    assert_eq!(journal.prune_below(&file, 100, 1).await.unwrap(), 3);
    assert_eq!(journal.tail(&file, 0, 10).await.unwrap().len(), 1);
    drop(journal);
    db.drop_db().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_stale_fence_is_refused_and_others_commit() {
    let Some(db) = TestDb::create("a_stale_fence_is_refused_and_others_commit").await else {
        return;
    };
    let client = db.client().await;
    let (a, b) = (db.file(&client).await, db.file(&client).await);
    own(&db, &a, 2).await;
    own(&db, &b, 1).await;
    let journal = Arc::new(PgJournal::start(Config {
        flush_interval: Duration::from_millis(20),
        ..Config::new(&db.url)
    }));
    // The same statement carries a stale row of `a` and good rows of `b`, and a row that breaks a bound.
    let stale = tokio::spawn(journal.submit(entry(&a, 2, 1, 1)));
    let good = tokio::spawn(journal.submit(entry(&b, 2, 1, 1)));
    let mut bad = entry(&b, 3, 1, 2);
    bad.client = Some(ClientOp {
        id: "not a client id".into(),
        seq: 2,
    });
    let bad = tokio::spawn(journal.submit(bad));
    assert_eq!(
        stale.await.unwrap(),
        Err(JournalError::Fenced {
            file: a.as_str().into(),
            current: Some(2)
        })
    );
    assert_eq!(good.await.unwrap(), Ok(()));
    assert!(matches!(bad.await.unwrap(), Err(JournalError::Invalid(_))));
    assert!(journal.tail(&a, 0, 10).await.unwrap().is_empty());
    assert_eq!(journal.tail(&b, 0, 10).await.unwrap().len(), 1);
    // The trigger refuses a stale row from any other writer too.
    let error = client
        .execute(
            "INSERT INTO design_file_changes(file_id,version,op,fence) VALUES($1,9,'\\x01',1)",
            &[&a],
        )
        .await
        .unwrap_err();
    assert_eq!(error.code().unwrap().code(), "MRF01");
    drop(journal);
    db.drop_db().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_editors_share_commits() {
    let Some(db) = TestDb::create("concurrent_editors_share_commits").await else {
        return;
    };
    let client = db.client().await;
    let mut files = Vec::new();
    for _ in 0..20 {
        let file = db.file(&client).await;
        own(&db, &file, 1).await;
        files.push(file);
    }
    let journal = Arc::new(PgJournal::start(Config::new(&db.url)));
    // 20 documents, 50 ops each, each document's ops submitted in order and answered on their own tasks, all
    // documents at once.
    let tasks: Vec<_> = files
        .iter()
        .map(|file| {
            let journal = journal.clone();
            let file = file.clone();
            tokio::spawn(async move {
                let mut pending = Vec::new();
                for version in 2..52 {
                    pending.push(tokio::spawn(
                        journal.submit(entry(&file, version, 1, version)),
                    ));
                    tokio::task::yield_now().await;
                }
                for task in pending {
                    task.await.unwrap().unwrap();
                }
            })
        })
        .collect();
    for task in tasks {
        task.await.unwrap();
    }
    for file in &files {
        let rows = journal.tail(file, 0, 100).await.unwrap();
        assert_eq!(
            rows.iter().map(|row| row.version).collect::<Vec<_>>(),
            (2..52).collect::<Vec<_>>()
        );
    }
    let stats = journal.stats();
    assert_eq!(stats.ops, 1000);
    assert!(stats.batches < 1000, "ops share statements: {stats:?}");
    drop(journal);
    db.drop_db().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn unreachable_database_fails_after_the_retry_window_and_the_queue_is_bounded() {
    // Nothing listens on port 1.
    let journal = PgJournal::start(Config {
        retry_for: Duration::from_millis(300),
        max_queued_bytes: 4096,
        ..Config::new("postgresql://nobody:x@127.0.0.1:1/none?connect_timeout=1")
    });
    let started = std::time::Instant::now();
    let pending = journal.append(entry("f", 2, 1, 1));
    let mut big = entry("f", 3, 1, 2);
    big.body = Body::Op(vec![1; 8192]);
    assert_eq!(journal.append(big).await, Err(JournalError::Overloaded));
    assert!(matches!(pending.await, Err(JournalError::Unavailable(_))));
    assert!(started.elapsed() >= Duration::from_millis(300));
    assert!(journal.stats().retries >= 1);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_batch_commits_whole_or_not_at_all() {
    let Some(db) = TestDb::create("a_batch_commits_whole_or_not_at_all").await else {
        return;
    };
    let file = db.file(&db.client().await).await;
    own(&db, &file, 1).await;
    let journal = PgJournal::start(Config::new(&db.url));
    journal.append(entry(&file, 2, 1, 1)).await.unwrap();
    // The middle op re-sends the client sequence of version 2: nothing of the batch is journaled.
    let batch = vec![
        entry(&file, 3, 1, 3),
        entry(&file, 4, 1, 1),
        entry(&file, 5, 1, 5),
    ];
    assert!(matches!(
        journal.append_batch(batch).await,
        Err(JournalError::Conflict { .. })
    ));
    assert_eq!(journal.tail(&file, 0, 10).await.unwrap().len(), 1);
    // Batches queued back to back, the first refused: the second cannot commit over its hole either.
    let refused = journal.submit_batch(vec![entry(&file, 3, 1, 1)]);
    let after = journal.submit_batch(vec![entry(&file, 4, 1, 4), entry(&file, 5, 1, 5)]);
    assert!(refused.await.is_err());
    assert!(matches!(
        after.await,
        Err(JournalError::Conflict { version: 4, .. })
    ));
    let good = (3..=5).map(|v| entry(&file, v, 1, v)).collect();
    journal.append_batch(good).await.unwrap();
    // The same batch again (an answer lost) is a success.
    let again = (3..=5).map(|v| entry(&file, v, 1, v)).collect();
    journal.append_batch(again).await.unwrap();
    assert_eq!(
        journal
            .tail(&file, 0, 10)
            .await
            .unwrap()
            .iter()
            .map(|row| row.version)
            .collect::<Vec<_>>(),
        [2, 3, 4, 5]
    );
    // Not one file's consecutive versions: refused before it is queued.
    assert!(matches!(
        journal
            .append_batch(vec![entry(&file, 6, 1, 6), entry(&file, 8, 1, 8)])
            .await,
        Err(JournalError::Invalid(_))
    ));
    assert!(matches!(
        journal.append_batch(Vec::new()).await,
        Err(JournalError::Invalid(_))
    ));
    drop(journal);
    db.drop_db().await;
}
