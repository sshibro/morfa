//! The node drain (crate::drain, lane B5; docs/BACKEND.md §10): `SIGTERM` → stop taking files → checkpoint every
//! open document → `bye {shutdown}` → exit within the stop timeout, with no acked op lost and every lease released.

mod common;

use async_trait::async_trait;
use common::*;
use morfa_collab::client;
use morfa_collab::drain::DrainConfig;
use morfa_collab::journal::{Journal, JournalEntry, JournalError, Loaded, MemJournal};
use morfa_collab::lease::{Lease, MemLease};
use morfa_model::DesignDocument;
use morfa_protocol::{
    ByeReason, ClientId, ClientMsg, Hello, PROTOCOL_VERSION, Role, Seq, ServerMsg, Version, Wire,
};
use parking_lot::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// The in-memory journal, recording the checkpoints it is asked for; `checkpoint_delay` holds them up.
#[derive(Default)]
struct Recorder {
    inner: MemJournal,
    checkpoints: Mutex<Vec<(String, Version)>>,
    checkpoint_delay: Mutex<Duration>,
}

#[async_trait]
impl Journal for Recorder {
    async fn load(&self, file: &str) -> Result<Option<Loaded>, JournalError> {
        self.inner.load(file).await
    }
    async fn commit(
        &self,
        file: &str,
        fence: u64,
        batch: &[JournalEntry],
    ) -> Result<(), JournalError> {
        self.inner.commit(file, fence, batch).await
    }
    async fn read(
        &self,
        file: &str,
        after: Version,
        upto: Version,
        limit: usize,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        self.inner.read(file, after, upto, limit).await
    }
    async fn find_client_op(
        &self,
        file: &str,
        client: &ClientId,
        seq: Seq,
    ) -> Result<Option<Version>, JournalError> {
        self.inner.find_client_op(file, client, seq).await
    }
    async fn checkpoint(
        &self,
        file: &str,
        _fence: u64,
        version: Version,
        _document: Arc<DesignDocument>,
    ) -> Result<(), JournalError> {
        self.record(file, version).await
    }
    /// The actor's store-backed engine checkpoints its compact store (main's B7 hot path): recorded the same way.
    async fn checkpoint_store(
        &self,
        file: &str,
        _fence: u64,
        version: Version,
        _document: Arc<morfa_model::store::Document>,
    ) -> Result<(), JournalError> {
        self.record(file, version).await
    }
}

impl Recorder {
    async fn record(&self, file: &str, version: Version) -> Result<(), JournalError> {
        let delay = *self.checkpoint_delay.lock();
        tokio::time::sleep(delay).await;
        self.checkpoints.lock().push((file.to_owned(), version));
        Ok(())
    }
}

async fn start() -> (Server, Arc<Recorder>, Arc<MemLease>) {
    let recorder = Arc::new(Recorder::default());
    let lease = Arc::new(MemLease::new());
    let server = Server::start_with(Options {
        storage: Some((recorder.clone(), lease.clone())),
        ..Default::default()
    })
    .await;
    (server, recorder, lease)
}

const QUICK: DrainConfig = DrainConfig {
    notice: Duration::from_millis(200),
    deadline: Duration::from_secs(10),
};

/// Reads until `bye`; answers it and every ack seen on the way.
async fn until_bye(editor: &mut Editor) -> (ByeReason, Vec<(Seq, Version)>) {
    let mut acks = Vec::new();
    loop {
        match editor.next().await {
            Some(ServerMsg::Ack { seq, version, .. }) => acks.push((seq, version)),
            Some(ServerMsg::Bye { reason }) => return (reason, acks),
            Some(_) => {}
            None => panic!("socket closed without bye"),
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_drain_checkpoints_says_bye_and_frees_the_lease() {
    let (server, recorder, lease) = start().await;
    recorder.inner.insert("f", rect_doc(5), 0);
    let mut a = Editor::join(&server, "f", "a", Role::Editor).await;
    let mut b = Editor::join(&server, "f", "b", Role::Editor).await;
    for i in 0..3 {
        let seq = a
            .send_patch(a.move_patch(&["r1"], 1.0 + i as f64, 0.0))
            .await;
        assert!(matches!(a.answer(seq).await, ServerMsg::Ack { .. }));
    }
    b.reach(3).await;
    // One more op still in flight when the drain starts: it must be acked before the bye.
    let last = a.send_patch(a.move_patch(&["r2"], 0.0, 9.0)).await;

    let app = server.app.clone();
    let drain = tokio::spawn(async move { app.drain(QUICK).await });
    // During the notice the node is up but says it drains: api stops sending files here.
    tokio::time::sleep(Duration::from_millis(50)).await;
    let (status, body) = http(&server, "GET", "/healthz", "", None).await;
    assert_eq!(status, 503, "{body}");
    assert!(body.contains("\"draining\":true"), "{body}");
    let (status, metrics_text) = http(&server, "GET", "/metrics", "", None).await;
    assert_eq!(status, 200);
    assert!(metrics_text.contains("collab_draining 1"), "{metrics_text}");

    let (reason_a, acks_a) = until_bye(&mut a).await;
    let (reason_b, _) = until_bye(&mut b).await;
    assert_eq!(
        (reason_a, reason_b),
        (ByeReason::Shutdown, ByeReason::Shutdown)
    );
    assert!(
        acks_a
            .iter()
            .any(|(seq, version)| *seq == last && *version == 4),
        "the op in flight is acked before the bye: {acks_a:?}"
    );
    let report = drain.await.unwrap();
    assert_eq!(
        (report.files, report.forced, report.left),
        (1, 0, 0),
        "{report:?}"
    );
    assert!(report.elapsed < QUICK.deadline, "{report:?}");
    assert!(server.app.docs.is_empty());
    // The checkpoint is of the last journaled version; the journal holds every acked op.
    assert_eq!(*recorder.checkpoints.lock(), vec![("f".to_owned(), 4)]);
    let (document, version) = recorder.inner.replay("f").unwrap();
    assert_eq!(version, 4);
    assert_eq!(a.replica.version, 4);
    assert!(same_doc(&document, &a.replica.doc), "0 acked ops lost");
    // The lease is free for the next owner at once (no 15 s wait).
    assert!(lease.acquire("f", "other-node").await.is_ok());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_draining_node_refuses_new_files_and_gives_their_lease_back() {
    let (server, recorder, lease) = start().await;
    recorder.inner.insert("g", rect_doc(1), 0);
    let app = server.app.clone();
    let drain = tokio::spawn(async move {
        app.drain(DrainConfig {
            notice: Duration::from_millis(500),
            deadline: Duration::from_secs(5),
        })
        .await
    });
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert!(server.app.draining());
    // api took the lease for this node just before it saw the drain.
    lease.acquire("g", "local").await.unwrap();
    let (mut tx, mut rx) = client::connect(&server.url("g"), Wire::Json).await.unwrap();
    tx.send(&ClientMsg::Hello(Hello {
        ticket: server.ticket("g", "a", Role::Editor),
        client_id: ClientId::new("tab-a"),
        since: None,
        last_seq: 0,
        protocol: PROTOCOL_VERSION,
    }))
    .await
    .unwrap();
    let first = tokio::time::timeout(TIMEOUT, rx.recv()).await.unwrap();
    assert!(
        matches!(
            first,
            Some(ServerMsg::Bye {
                reason: ByeReason::Shutdown
            })
        ),
        "{first:?}"
    );
    assert!(server.app.docs.get("g").is_none(), "no actor was started");
    assert!(
        lease.acquire("g", "other-node").await.is_ok(),
        "the lease api took for the draining node was given back"
    );
    let report = drain.await.unwrap();
    assert_eq!(report.files, 0);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_deadline_stops_a_file_whose_checkpoint_hangs() {
    let (server, recorder, lease) = start().await;
    recorder.inner.insert("h", rect_doc(2), 0);
    *recorder.checkpoint_delay.lock() = Duration::from_secs(30);
    let mut a = Editor::join(&server, "h", "a", Role::Editor).await;
    let seq = a.send_patch(a.move_patch(&["r1"], 1.0, 0.0)).await;
    assert!(matches!(
        a.answer(seq).await,
        ServerMsg::Ack { version: 1, .. }
    ));
    let started = Instant::now();
    let report = server
        .app
        .drain(DrainConfig {
            notice: Duration::from_millis(50),
            deadline: Duration::from_secs(1),
        })
        .await;
    assert!(started.elapsed() < Duration::from_secs(4), "{report:?}");
    assert_eq!(
        (report.files, report.forced, report.left),
        (1, 1, 0),
        "{report:?}"
    );
    let (reason, _) = until_bye(&mut a).await;
    assert_eq!(reason, ByeReason::Shutdown);
    // The acked op is in the journal even without the checkpoint.
    assert_eq!(recorder.inner.versions("h"), vec![1]);
    assert!(lease.acquire("h", "other-node").await.is_ok());
}

/// A busy file (ops arriving faster than the journal commits) still drains well before the deadline: ops reaching the
/// draining actor are left for the next owner, its journal catches up, the checkpoint is written and every acked op is in
/// the journal.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_busy_file_drains_and_every_acked_op_is_journaled() {
    let (server, recorder, _lease) = start().await;
    recorder.inner.insert("busy", rect_doc(3), 0);
    let mut a = Editor::join(&server, "busy", "a", Role::Editor).await;
    let seq = a.send_patch(a.move_patch(&["r1"], 1.0, 0.0)).await;
    assert!(matches!(a.answer(seq).await, ServerMsg::Ack { .. }));
    let app = server.app.clone();
    let drain = tokio::spawn(async move {
        app.drain(DrainConfig {
            notice: Duration::from_millis(100),
            deadline: Duration::from_secs(10),
        })
        .await
    });
    // Ops without pause until the bye: the sender never waits for its acks.
    let mut acked: Vec<(Seq, Version)> = Vec::new();
    let mut x = 1.0;
    let reason = loop {
        x += 1.0;
        let patch = a.move_patch(&["r2"], x, 0.0);
        a.send_patch(patch).await;
        match tokio::time::timeout(Duration::from_millis(1), a.rx.recv()).await {
            Ok(Some(ServerMsg::Ack { seq, version, .. })) => acked.push((seq, version)),
            Ok(Some(ServerMsg::Bye { reason })) => break reason,
            Ok(Some(_)) | Err(_) => {}
            Ok(None) => panic!("closed without bye"),
        }
    };
    assert_eq!(reason, ByeReason::Shutdown);
    let report = drain.await.unwrap();
    assert_eq!(
        (report.forced, report.left, report.sockets_left),
        (0, 0, 0),
        "{report:?}"
    );
    assert!(report.elapsed < Duration::from_secs(5), "{report:?}");
    let journaled = recorder.inner.versions("busy");
    for (seq, version) in &acked {
        assert!(
            journaled.contains(version),
            "acked seq {seq} at {version} is not journaled"
        );
    }
    let checkpoint = recorder
        .checkpoints
        .lock()
        .last()
        .cloned()
        .expect("a checkpoint");
    assert_eq!(
        checkpoint.1,
        *journaled.last().unwrap(),
        "the checkpoint is of the last journaled version"
    );
}
