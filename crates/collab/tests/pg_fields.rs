//! Field-level ops (lane W) on lane B2's PostgreSQL journal: a protocol 2 op is expanded over the actor's nodes and
//! journaled as today's row (the whole stored patch, packed as lane S packs it), the rows replay over the file's
//! document to the server's document, and a catch-up past the in-memory tail reads them back on both protocols.
//! Skips without `MORFA_B2_PG_URL`.

mod common;

use common::*;
use morfa_collab::pg::{PgLeases, PgStore};
use morfa_journal::testdb::TestDb;
use morfa_model::to_json;
use morfa_protocol::{ClientId, Role, ServerMsg, Wire};
use std::sync::Arc;

fn storage(
    url: &str,
    dir: &std::path::Path,
) -> (
    Arc<dyn morfa_collab::journal::Journal>,
    Arc<dyn morfa_collab::lease::Lease>,
) {
    let journal = morfa_journal::PgJournal::start(morfa_journal::Config::new(url.to_owned()));
    let checkpoints = morfa_checkpoint::Checkpoints::new(
        Arc::new(morfa_blobs::DirStore::new(dir)),
        url,
        morfa_checkpoint::Format::Bin,
    );
    (
        Arc::new(PgStore::new(journal, checkpoints, url)),
        Arc::new(PgLeases(morfa_lease::PgLease::new(url))),
    )
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn field_ops_are_journaled_as_whole_rows_and_caught_up() {
    let Some(db) = TestDb::create("collab-pg-fields").await else {
        return;
    };
    let client = db.client().await;
    let user = format!("user-{}", rand::random::<u32>());
    let file = format!("{:08x}-0000-4000-8000-000000000002", rand::random::<u32>());
    client
        .execute(
            "INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')",
            &[&user, &format!("{user}@example.invalid")],
        )
        .await
        .unwrap();
    let seed = rect_doc(20);
    let document = to_json(&seed);
    client
        .execute(
            "INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,'Design',$3,octet_length($3),21)",
            &[&file, &user, &document],
        )
        .await
        .unwrap();
    let dir = std::env::temp_dir().join(format!("collab-pg-fields-{}", rand::random::<u32>()));
    let server = Server::start_with(Options {
        storage: Some(storage(&db.url, &dir)),
        config: Box::new(|c| c.tail_entries = 8),
        ..Options::default()
    })
    .await;
    let ticket_user = user.clone();
    let join = |protocol: u32,
                client: ClientId,
                replica: Option<morfa_collab::client::Replica>,
                since: Option<u64>| {
        let server = &server;
        let file = file.clone();
        let user = ticket_user.clone();
        async move {
            Editor::join_protocol(
                server,
                &file,
                &user,
                Role::Editor,
                client,
                replica,
                0,
                since,
                Wire::Json,
                protocol,
            )
            .await
        }
    };
    let mut a = join(2, ClientId::new("tab-a"), None, None).await;
    let b = join(2, ClientId::new("tab-b"), None, None).await;
    let (b_client, b_replica, b_version) = (b.client.clone(), b.replica.clone(), b.replica.version);
    drop(b);
    // 40 field ops while b is away: well past the tail of 8.
    for i in 0..40u32 {
        let id = format!("r{}", i % 20);
        let x = a.replica.doc.nodes[&id].x;
        let mut fields = morfa_protocol::OpFields::default();
        fields.set.insert(
            id.clone(),
            serde_json::json!({"x": x + 1.0, "name": format!("n{i}")})
                .as_object()
                .unwrap()
                .clone(),
        );
        fields.was.insert(
            id.clone(),
            serde_json::json!({"x": x}).as_object().unwrap().clone(),
        );
        let seq = a.send_fields(fields).await;
        assert!(
            matches!(a.answer(seq).await, ServerMsg::Ack { .. }),
            "op {i}"
        );
    }
    let held = server.settled(&file).await;
    // Every row is today's row: the whole stored patch (packed, lane S), which every reader takes.
    let rows = client
        .query(
            "SELECT version, patch, op FROM design_file_changes WHERE file_id=$1 ORDER BY version",
            &[&file],
        )
        .await
        .unwrap();
    assert_eq!(rows.len(), 40);
    let mut replayed = morfa_model::store::Document::from_model(&seed);
    for row in &rows {
        let body = match (
            row.get::<_, Option<String>>(1),
            row.get::<_, Option<Vec<u8>>>(2),
        ) {
            (Some(text), _) => morfa_journal::Body::Patch(text),
            (None, Some(op)) => {
                assert!(!op.starts_with(b"MRFF"), "no field rows in this step");
                morfa_journal::Body::Op(op)
            }
            (None, None) => panic!("a row without a body"),
        };
        let decoded = morfa_checkpoint::ops::decode(&body).unwrap();
        morfa_checkpoint::ops::apply(&mut replayed, decoded).unwrap();
    }
    assert!(
        same_doc(&replayed.to_model(), &held.document),
        "the rows replay to the server's document"
    );
    // b comes back on protocol 2: caught up from the rows (read back as fields), past the tail.
    let mut b2 = join(
        2,
        b_client.clone(),
        Some(b_replica.clone()),
        Some(b_version),
    )
    .await;
    b2.reach(held.version).await;
    assert!(same_doc(&b2.replica.doc, &held.document));
    assert!(b2.log.iter().any(|m| matches!(m, ServerMsg::Changes { changes } if changes.iter().any(|c| c.fields.is_some()))));
    drop(b2);
    // On protocol 1 the same catch-up reloads (whole nodes only a document gives).
    let mut b1 = join(1, ClientId::new("tab-b1"), Some(b_replica), Some(b_version)).await;
    b1.reach(held.version).await;
    assert!(same_doc(&b1.replica.doc, &held.document));
    drop(b1);
    drop(a);
    drop(server);
    drop(client);
    db.drop_db().await;
}
