//! BIG.md stage E (lane W): a client that must reload gets `snapshotUrl` (api's `GET /api/design-files/:id/checkpoint`)
//! and then the changes after the checkpoint when the checkpoint is near enough; the document frame otherwise, and
//! always while the switch is off.

mod common;

use common::*;
use morfa_collab::client::Replica;
use morfa_protocol::{ClientId, ClientMsg, Hello, Role, ServerMsg, Version, Wire};

const URL: &str = "/api/design-files/f/checkpoint";

async fn server(on: bool, max_ops: u64) -> Server {
    let server = Server::start_with(Options {
        config: Box::new(move |config| {
            config.snapshot_url = on;
            config.snapshot_max_ops = max_ops;
        }),
        ..Options::default()
    })
    .await;
    server.journal.serve_checkpoints();
    server.journal.insert("f", rect_doc(3), 0);
    server
}

/// Joins without a document. Through a snapshot URL the replica starts from the checkpoint (what api serves there:
/// the journal's base) and the changes after it follow; else it waits for the document frame.
async fn join(server: &Server, user: &str, wire: Wire) -> Editor {
    let client = ClientId::new(format!("tab-{user}-{}", rand::random::<u32>()));
    let (mut tx, mut rx) = morfa_collab::client::connect(&server.url_for("f", wire), wire)
        .await
        .unwrap();
    tx.send(&ClientMsg::Hello(Hello {
        ticket: server.ticket("f", user, Role::Editor),
        client_id: client.clone(),
        since: None,
        last_seq: 0,
        protocol: 2,
    }))
    .await
    .unwrap();
    let Some(ServerMsg::Welcome(welcome)) = rx.recv().await else {
        panic!("welcome")
    };
    assert!(welcome.resync);
    let replica = match &welcome.snapshot_url {
        Some(url) => {
            assert_eq!(url, URL);
            let (base, version) = server.journal.base("f").expect("a checkpoint");
            Replica::new((*base).clone(), version)
        }
        None => Replica::new(rect_doc(0), 0),
    };
    let mut editor = Editor {
        tx,
        rx,
        replica,
        client,
        seq: 0,
        connection: welcome.connection.clone(),
        user: user.into(),
        log: vec![ServerMsg::Welcome(welcome.clone())],
    };
    if welcome.snapshot_url.is_none() {
        while !matches!(editor.next().await, Some(ServerMsg::Document { .. })) {}
    }
    editor
}

fn documents(editor: &Editor) -> usize {
    editor
        .log
        .iter()
        .filter(|m| matches!(m, ServerMsg::Document { .. }))
        .count()
}

/// Three moves by `a`: the file at version 3, the checkpoint (the base) at 0.
async fn three_moves(a: &mut Editor) -> Version {
    for k in 1..=3 {
        let patch = a.move_patch(&["r0"], k as f64, 0.0);
        let seq = a.send_patch(patch).await;
        a.answer(seq).await;
    }
    3
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn within_reach_the_reload_goes_through_the_checkpoint() {
    for wire in [Wire::Json, Wire::Binary] {
        let server = server(true, 5).await;
        let mut a = join(&server, "a", wire).await;
        let version = three_moves(&mut a).await;
        let mut b = join(&server, "b", wire).await;
        b.reach(version).await;
        let doc = server.settled("f").await.document;
        assert!(same_doc(&b.replica.doc, &doc), "{wire:?}");
        assert_eq!(documents(&b), 0, "no document frame: {wire:?}");
        // A pull from beyond the file's version is a reload too: through the checkpoint again.
        b.tx.send(&ClientMsg::Pull { since: 99 }).await.unwrap();
        let resync = loop {
            if let Some(ServerMsg::Resync {
                version,
                snapshot_url,
            }) = b.next().await
            {
                break (version, snapshot_url);
            }
        };
        assert_eq!(resync, (version, Some(URL.to_owned())), "{wire:?}");
        let (base, at) = server.journal.base("f").unwrap();
        b.replica = Replica::new((*base).clone(), at);
        b.reach(version).await;
        assert!(same_doc(&b.replica.doc, &doc), "{wire:?}");
        assert_eq!(documents(&b), 0, "{wire:?}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn beyond_reach_or_switched_off_the_document_frame_stays() {
    for (on, max_ops) in [(true, 2), (false, 5)] {
        let server = server(on, max_ops).await;
        let mut a = join(&server, "a", Wire::Json).await;
        let version = three_moves(&mut a).await;
        let mut b = join(&server, "b", Wire::Json).await;
        let ServerMsg::Welcome(welcome) = &b.log[0] else {
            panic!("welcome")
        };
        assert_eq!(welcome.snapshot_url, None, "on {on}, max {max_ops}");
        assert_eq!(documents(&b), 1);
        b.reach(version).await;
        assert!(same_doc(
            &b.replica.doc,
            &server.settled("f").await.document
        ));
    }
}
