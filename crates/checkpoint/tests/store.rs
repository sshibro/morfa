//! Writing checkpoints to object storage and loading documents cold (PostgreSQL from MORFA_B2_PG_URL; the in-memory
//! object store, or S3 from MORFA_B2_S3_* for the last test).

mod common;

use morfa_blobs::{MemoryStore, ObjectStore, S3, S3Config};
use morfa_checkpoint::{CheckpointError, Checkpoints, Format, format};
use morfa_journal::testdb::TestDb;
use morfa_journal::{Body, Config, Entry, Journal, PgJournal};
use std::sync::Arc;

async fn owned_file(db: &TestDb, document: &str) -> String {
    let client = db.client().await;
    let file = db.file(&client).await;
    client
        .execute(
            "UPDATE design_files SET document=$2,bytes=octet_length($2),fence=1,collab_node='n',lease_until=now()+interval '15 s' WHERE id=$1",
            &[&file, &document],
        )
        .await
        .unwrap();
    file
}

fn row(file: &str, version: u64, body: Body) -> Entry {
    Entry {
        file: file.into(),
        version,
        fence: 1,
        client: None,
        user_id: None,
        body,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn write_verify_record_and_load_cold() {
    let Some(db) = TestDb::create("write_verify_record_and_load_cold").await else {
        return;
    };
    let file = owned_file(&db, &common::document(30)).await;
    let journal = PgJournal::start(Config::new(&db.url));
    let store = Arc::new(MemoryStore::new());
    let checkpoints = Checkpoints::new(store.clone(), &db.url, Format::Bin);
    // Without a checkpoint: design_files.document and the rows after it (Node's and collab's alike).
    let mut expected = common::store(&common::document(30));
    for version in 2..=4 {
        let patch = common::move_patch(version as usize, version as f64 * 10.0);
        expected.apply_patch(&morfa_model::patch_from_json(&patch).unwrap());
        journal
            .append(row(&file, version, Body::Patch(patch)))
            .await
            .unwrap();
    }
    let loaded = checkpoints.load(&file).await.unwrap().unwrap();
    assert_eq!(
        (loaded.version, loaded.checkpoint_version, loaded.rows),
        (4, None, 3)
    );
    assert_eq!(loaded.doc, expected);
    // A checkpoint at 4: written, read back, recorded.
    let written = checkpoints
        .write(&file, 1, 4, Arc::new(loaded.doc))
        .await
        .unwrap();
    assert_eq!(written.key, format!("ckpt/{file}/4.bin.zst"));
    assert_eq!(store.gets(), 1, "the integrity re-read");
    let recorded = db.client().await.query_one("SELECT checkpoint_key,checkpoint_version,checkpoint_format FROM design_files WHERE id=$1", &[&file]).await.unwrap();
    assert_eq!(
        (
            recorded.get::<_, String>(0),
            recorded.get::<_, i64>(1),
            recorded.get::<_, String>(2)
        ),
        (written.key.clone(), 4, "bin".to_owned())
    );
    // Rows after it, including a whole-document replacement and the edit after it.
    for version in 5..=6 {
        let patch = common::move_patch(1, version as f64);
        expected.apply_patch(&morfa_model::patch_from_json(&patch).unwrap());
        journal
            .append(row(&file, version, Body::Patch(patch)))
            .await
            .unwrap();
    }
    let loaded = checkpoints.load(&file).await.unwrap().unwrap();
    assert_eq!(
        (loaded.version, loaded.checkpoint_version, loaded.rows),
        (6, Some(4), 2)
    );
    assert_eq!(loaded.doc, expected);
    let mut replacement = common::store(&common::document(4));
    journal
        .append(row(
            &file,
            7,
            morfa_checkpoint::ops::replace_body(&replacement, 7, Format::Bin),
        ))
        .await
        .unwrap();
    let patch = common::move_patch(0, 1.5);
    replacement.apply_patch(&morfa_model::patch_from_json(&patch).unwrap());
    journal
        .append(row(&file, 8, Body::Patch(patch)))
        .await
        .unwrap();
    let loaded = checkpoints.load(&file).await.unwrap().unwrap();
    assert_eq!((loaded.version, loaded.rows), (8, 4));
    assert_eq!(loaded.doc, replacement);
    // An older checkpoint never replaces a newer one; a stale owner cannot record one.
    assert_eq!(
        checkpoints
            .write(&file, 1, 3, Arc::new(expected.clone()))
            .await
            .unwrap_err(),
        CheckpointError::Stale
    );
    db.client()
        .await
        .execute("UPDATE design_files SET fence=2 WHERE id=$1", &[&file])
        .await
        .unwrap();
    assert_eq!(
        checkpoints
            .write(&file, 1, 8, Arc::new(replacement.clone()))
            .await
            .unwrap_err(),
        CheckpointError::Fenced
    );
    // The JSON format is read the same way (the reader takes both forever).
    let json = Checkpoints::new(store.clone(), &db.url, Format::Json);
    json.write(&file, 2, 8, Arc::new(replacement.clone()))
        .await
        .unwrap();
    let loaded = checkpoints.load(&file).await.unwrap().unwrap();
    assert_eq!(
        (loaded.version, loaded.checkpoint_version, loaded.rows),
        (8, Some(8), 0)
    );
    assert_eq!(loaded.doc, replacement);
    assert_eq!(
        checkpoints
            .load("00000000-0000-4000-8000-000000000000")
            .await
            .unwrap()
            .map(|l| l.version),
        None
    );
    drop(journal);
    db.drop_db().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn storage_failures_and_damage() {
    let Some(db) = TestDb::create("storage_failures_and_damage").await else {
        return;
    };
    let file = owned_file(&db, &common::document(10)).await;
    let store = Arc::new(MemoryStore::new());
    let mut checkpoints = Checkpoints::new(store.clone(), &db.url, Format::Bin);
    checkpoints.attempts = 2;
    let doc = Arc::new(common::store(&common::document(10)));
    // S3 down: the write fails after its retries and nothing is recorded.
    store.set_down(true);
    assert!(matches!(
        checkpoints.write(&file, 1, 1, doc.clone()).await,
        Err(CheckpointError::Store(_))
    ));
    store.set_down(false);
    let key: Option<String> = db
        .client()
        .await
        .query_one(
            "SELECT checkpoint_key FROM design_files WHERE id=$1",
            &[&file],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(key, None);
    // A checkpoint damaged in storage fails the cold load loudly (it is never served).
    let written = checkpoints.write(&file, 1, 1, doc.clone()).await.unwrap();
    store.damage(&written.key, format::HEADER_BYTES + 3);
    assert!(matches!(
        checkpoints.load(&file).await,
        Err(CheckpointError::Format(_))
    ));
    // S3 down at load time: 503 for the caller (docs/BACKEND.md §8).
    store.set_down(true);
    assert!(matches!(
        checkpoints.load(&file).await,
        Err(CheckpointError::Store(_))
    ));
    store.set_down(false);
    // A gap in the journal is refused.
    checkpoints.write(&file, 1, 1, doc.clone()).await.unwrap();
    db.client()
        .await
        .execute("UPDATE design_files SET version=3 WHERE id=$1", &[&file])
        .await
        .unwrap();
    db.client()
        .await
        .execute(
            "INSERT INTO design_file_changes(file_id,version,patch) VALUES($1,3,'{}')",
            &[&file],
        )
        .await
        .unwrap();
    assert_eq!(
        checkpoints.load(&file).await.unwrap_err(),
        CheckpointError::Gap { after: 1, found: 3 }
    );
    db.drop_db().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn checkpoints_through_s3() {
    let Some(db) = TestDb::create("checkpoints_through_s3").await else {
        return;
    };
    let Ok(endpoint) = std::env::var("MORFA_B2_S3_ENDPOINT") else {
        eprintln!("skipped: MORFA_B2_S3_ENDPOINT is not set");
        db.drop_db().await;
        return;
    };
    let var = |name: &str| std::env::var(format!("MORFA_B2_S3_{name}")).unwrap_or_default();
    let mut config = S3Config::new(
        &endpoint,
        &var("REGION"),
        &var("BUCKET"),
        &var("KEY"),
        &var("SECRET"),
    );
    config.part_size = 5 << 20;
    let store = S3::new(config).unwrap();
    let file = owned_file(&db, &common::document(2000)).await;
    let checkpoints = Checkpoints::new(store.clone(), &db.url, Format::Json);
    let doc = Arc::new(common::store(&common::document(2000)));
    let written = checkpoints.write(&file, 1, 1, doc.clone()).await.unwrap();
    let loaded = checkpoints.load(&file).await.unwrap().unwrap();
    assert_eq!(loaded.doc, *doc);
    assert!(
        checkpoints
            .snapshot_url(&written.key, std::time::Duration::from_secs(60))
            .unwrap()
            .contains("X-Amz-Signature=")
    );
    store.delete(&written.key).await.unwrap();
    db.drop_db().await;
}
