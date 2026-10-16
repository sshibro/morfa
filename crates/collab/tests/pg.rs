//! The service on the PostgreSQL journal and lease (crate::pg): editors edit a real design file, every op is
//! a journal row under the lease's fence, the last socket leaving writes a checkpoint, and a second node loads the file
//! from it to the same document.
//! Prints TARGETS M1b (the ack after the group commit). Skips without `MORFA_B2_PG_URL`.

mod common;

use common::*;
use morfa_collab::pg::{FileStats, PgLeases, PgStore};
use morfa_journal::testdb::TestDb;
use morfa_model::to_json;
use morfa_protocol::ticket::{Claims, mint};
use morfa_protocol::{ClientId, ClientMsg, Hello, PROTOCOL_VERSION, Role, ServerMsg, Wire};
use std::sync::Arc;

fn storage(
    url: &str,
    dir: &std::path::Path,
) -> (
    Arc<dyn morfa_collab::journal::Journal>,
    Arc<dyn morfa_collab::lease::Lease>,
) {
    storage_with(url, dir, std::time::Duration::ZERO)
}

/// `storage` whose checkpoints wait `stats_delay` between their record and their exact stats.
fn storage_with(
    url: &str,
    dir: &std::path::Path,
    stats_delay: std::time::Duration,
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
    let mut store = PgStore::new(journal, checkpoints, url);
    store.stats_delay = stats_delay;
    (
        Arc::new(store),
        Arc::new(PgLeases(morfa_lease::PgLease::new(url))),
    )
}

/// Joins `file` as `user` (the ticket names the user's real id).
async fn join(server: &Server, file: &str, user: &str) -> Editor {
    let exp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 60;
    let ticket = mint(
        &server.key,
        &Claims {
            file: file.into(),
            user: user.into(),
            name: "Designer".into(),
            role: Role::Editor,
            team: None,
            origin: None,
            exp,
        },
    );
    let (mut tx, mut rx) = morfa_collab::client::connect(&server.url(file), Wire::Json)
        .await
        .unwrap();
    let client = ClientId::new(format!("tab-{}", rand::random::<u32>()));
    tx.send(&ClientMsg::Hello(Hello {
        ticket,
        client_id: client.clone(),
        since: None,
        last_seq: 0,
        protocol: PROTOCOL_VERSION,
    }))
    .await
    .unwrap();
    let mut replica = morfa_collab::client::Replica::new(rect_doc(0), 0);
    let welcome = match rx.recv().await.expect("welcome") {
        ServerMsg::Welcome(welcome) => welcome,
        other => panic!("{other:?}"),
    };
    if welcome.resync {
        loop {
            let msg = rx.recv().await.expect("document");
            let done = matches!(msg, ServerMsg::Document { .. });
            replica.on_message(&msg);
            if done {
                break;
            }
        }
    }
    let connection = welcome.connection;
    Editor {
        tx,
        rx,
        replica,
        client,
        seq: 0,
        connection,
        user: user.into(),
        log: Vec::new(),
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn edits_are_journaled_in_postgresql_and_load_on_another_node() {
    let Some(db) = TestDb::create("collab-pg").await else {
        return;
    };
    let client = db.client().await;
    let user = format!("user-{}", rand::random::<u32>());
    let file = format!("{:08x}-0000-4000-8000-000000000001", rand::random::<u32>());
    client
        .execute(
            "INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')",
            &[&user, &format!("{user}@example.invalid")],
        )
        .await
        .unwrap();
    // A picture in the document: the checkpoint writes `image_files` (api's erase keeps what it lists).
    let mut seed = rect_doc(20);
    seed.images.insert(
        "img-1".into(),
        serde_json::from_str::<morfa_model::ImageAsset>(
            r#"{"url":"/uploads/pic-1.png","width":10,"height":10}"#,
        )
        .unwrap(),
    );
    let document = to_json(&seed);
    client
        .execute(
            "INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,'Design',$3,octet_length($3),21)",
            &[&file, &user, &document],
        )
        .await
        .unwrap();
    let dir = std::env::temp_dir().join(format!("collab-pg-{}", rand::random::<u32>()));

    let server = Server::start_with(Options {
        storage: Some(storage(&db.url, &dir)),
        ..Options::default()
    })
    .await;
    let mut a = join(&server, &file, &user).await;
    let mut b = join(&server, &file, &user).await;
    let start = a.replica.version;
    let ops = 200;
    for i in 0..ops {
        let editor = if i % 2 == 0 { &mut a } else { &mut b };
        let seq = editor
            .send_patch(editor.move_patch(&[&format!("r{}", i % 20)], 1.0, 0.0))
            .await;
        match editor.answer(seq).await {
            ServerMsg::Ack { .. } => {}
            other => panic!("op {i}: {other:?}"),
        }
        editor.reach(start + i + 1).await;
        let other = if i % 2 == 0 { &mut b } else { &mut a };
        other.reach(start + i + 1).await;
    }
    let m = morfa_collab::metrics::metrics();
    eprintln!(
        "M1b (ack after the PostgreSQL commit, 2 editors, sequential ops): {}; commit {}",
        m.op_ack.summary_ms(),
        m.journal_commit.summary_ms()
    );
    let rows: i64 = client
        .query_one(
            "SELECT count(*) FROM design_file_changes WHERE file_id=$1",
            &[&file],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(rows, ops as i64);
    let held = server.inspect(&file).await;
    drop(a);
    drop(b);
    // The last socket left: the actor writes a checkpoint of the journaled version (TARGETS S4).
    let mut checkpoint = None;
    for _ in 0..100 {
        checkpoint = client
            .query_one(
                "SELECT checkpoint_version FROM design_files WHERE id=$1",
                &[&file],
            )
            .await
            .unwrap()
            .get::<_, Option<i64>>(0);
        if checkpoint.is_some() {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(
        checkpoint,
        Some(held.version as i64),
        "a checkpoint at the last version"
    );
    // With it, what api keeps beside a document: its JSON's length, its layers, its pictures.
    let expected = FileStats::of(&held.document);
    assert_eq!(expected.image_files, vec!["pic-1.png".to_owned()]);
    assert_eq!(expected.bytes as usize, to_json(&held.document).len());
    let mut stats = None;
    for _ in 0..100 {
        let row = client
            .query_one(
                "SELECT bytes,node_count,image_files FROM design_files WHERE id=$1",
                &[&file],
            )
            .await
            .unwrap();
        stats = Some(FileStats {
            bytes: row.get(0),
            node_count: row.get(1),
            image_files: row.get(2),
        });
        if stats.as_ref() == Some(&expected) {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }
    assert_eq!(
        stats,
        Some(expected),
        "design_files stats of the checkpoint"
    );
    drop(server);

    // Another node: the lease runs out or is released; the file loads from PostgreSQL to the same document.
    tokio::time::sleep(std::time::Duration::from_millis(500)).await;
    client
        .execute(
            "UPDATE design_files SET lease_until=now() WHERE id=$1",
            &[&file],
        )
        .await
        .unwrap();
    let other = Server::start_with(Options {
        storage: Some(storage(&db.url, &dir)),
        config: Box::new(|c| c.node = "node-2".into()),
        ..Options::default()
    })
    .await;
    let c = join(&other, &file, &user).await;
    assert_eq!(c.replica.version, held.version);
    assert!(same_doc(&c.replica.doc, &held.document));
    drop(c);
    drop(other);
    drop(client);
    db.drop_db().await;
}

/// api announces every permission push on `design_acl` (server/design/collab/acl-push.ts): a node that missed the
/// POST still applies it.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn design_acl_notifications_reach_the_files_actor() {
    let Some(db) = TestDb::create("collab-acl").await else {
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
    let document = to_json(&rect_doc(2));
    client
        .execute(
            "INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,'Design',$3,octet_length($3),3)",
            &[&file, &user, &document],
        )
        .await
        .unwrap();
    let dir = std::env::temp_dir().join(format!("collab-acl-{}", rand::random::<u32>()));
    let server = Server::start_with(Options {
        storage: Some(storage(&db.url, &dir)),
        config: Box::new(|c| c.node = "node-a".into()),
        ..Options::default()
    })
    .await;
    tokio::spawn(morfa_collab::pg::listen_acl(
        db.url.clone(),
        server.app.clone(),
    ));
    let mut a = join(&server, &file, &user).await;
    let notify = |payload: String| {
        let client = &client;
        async move {
            client
                .execute("SELECT pg_notify('design_acl',$1)", &[&payload])
                .await
                .unwrap();
        }
    };
    // The listener connects in the background: notify until the role change arrives.
    let demote = format!(r#"{{"file":"{file}","user":"{user}","role":"viewer","node":"node-a"}}"#);
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
    'demoted: loop {
        assert!(std::time::Instant::now() < deadline, "no access message");
        notify(demote.clone()).await;
        while let Ok(Some(msg)) =
            tokio::time::timeout(std::time::Duration::from_millis(200), a.rx.recv()).await
        {
            if let ServerMsg::Access { role, can_edit } = msg {
                assert_eq!((role, can_edit), (Role::Viewer, false));
                break 'demoted;
            }
        }
    }
    // Another node's notice changes nothing here; access removed closes the socket.
    notify(format!(
        r#"{{"file":"{file}","user":"{user}","role":null,"node":"node-b"}}"#
    ))
    .await;
    notify(format!(
        r#"{{"file":"{file}","user":"{user}","role":null,"node":"node-a"}}"#
    ))
    .await;
    loop {
        match tokio::time::timeout(std::time::Duration::from_secs(10), a.rx.recv())
            .await
            .expect("no bye")
        {
            Some(ServerMsg::Bye { reason }) => {
                assert_eq!(reason, morfa_protocol::ByeReason::Access);
                break;
            }
            Some(ServerMsg::Access { role, .. }) => {
                panic!("another node's notice applied: {role:?}")
            }
            Some(_) => {}
            None => panic!("closed without bye"),
        }
    }
    drop(a);
    drop(server);
    drop(client);
    db.drop_db().await;
}

/// api's erase keeps a holder's pictures that a file's `image_files` lists, or that rows of collab above the file's
/// checkpoint may show (server/design/files.ts). So when a checkpoint is recorded (its rows no longer "above" it),
/// `image_files` must already list every picture of the checkpointed document: never a moment with neither. The
/// coordinator saw that window once under load (the exact stats are written after the record).
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_recorded_checkpoint_never_leaves_its_pictures_unlisted() {
    let Some(db) = TestDb::create("collab-pictures").await else {
        return;
    };
    let client = db.client().await;
    let user = format!("user-{}", rand::random::<u32>());
    let file = format!("{:08x}-0000-4000-8000-000000000003", rand::random::<u32>());
    client
        .execute(
            "INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')",
            &[&user, &format!("{user}@example.invalid")],
        )
        .await
        .unwrap();
    let document = to_json(&rect_doc(2));
    client
        .execute(
            "INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,'Design',$3,octet_length($3),3)",
            &[&file, &user, &document],
        )
        .await
        .unwrap();
    let dir = std::env::temp_dir().join(format!("collab-pictures-{}", rand::random::<u32>()));
    // The window between the record and the exact stats held open for two seconds.
    let server = Server::start_with(Options {
        storage: Some(storage_with(
            &db.url,
            &dir,
            std::time::Duration::from_secs(2),
        )),
        ..Options::default()
    })
    .await;
    let mut a = join(&server, &file, &user).await;
    let asset: morfa_model::ImageAsset =
        serde_json::from_str(r#"{"url":"/uploads/pic-2.png","width":10,"height":10}"#).unwrap();
    let mut patch = a.move_patch(&["r1"], 1.0, 0.0);
    patch.images = Some([("img-2".to_owned(), Some(asset))].into_iter().collect());
    let seq = a.send_patch(patch).await;
    match a.answer(seq).await {
        ServerMsg::Ack { .. } => {}
        other => panic!("{other:?}"),
    }
    let version = a.replica.version as i64;
    drop(a);
    // The last socket left: the checkpoint of `version` is written. From the moment it is recorded, the picture is
    // listed.
    let mut seen = None;
    for _ in 0..1000 {
        let row = client
            .query_one(
                "SELECT checkpoint_version,image_files FROM design_files WHERE id=$1",
                &[&file],
            )
            .await
            .unwrap();
        if row.get::<_, Option<i64>>(0) == Some(version) {
            seen = Some(row.get::<_, Vec<String>>(1));
            break;
        }
        tokio::time::sleep(std::time::Duration::from_millis(5)).await;
    }
    let listed = seen.expect("a checkpoint at the op's version");
    assert!(
        listed.contains(&"pic-2.png".to_owned()),
        "image_files {listed:?} when the checkpoint was recorded"
    );
    drop(server);
    drop(client);
    db.drop_db().await;
}
