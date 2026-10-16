//! `DocActor`: one tokio task per open file owning its authoritative document (docs/BACKEND.md §2). Everything
//! that touches the document runs here, fed by a bounded inbox (sockets) and an unbounded control channel (the
//! committer, background reads, timers); no locks on the document.
//!
//! Per op: `ACL → apply (merge, check, apply) → tail.push → fan-out (M1 ends here) → journal.enqueue → ack after
//! commit (M1b)`. The committer task group-commits whatever queued while the previous commit ran. A failed
//! commit rolls the document back to the last committed version and sends `rollback {version}` to everyone.

use crate::backpressure::{DirectWrites, Fanout, Out, Outbox};
use crate::catchup::{CatchUp, Tail, TailEntry, frames_from_journal};
use crate::engine::{DocEngine, EngineStats, OpInput, Refusal, Snapshot};
use crate::internal::ReplaceError;
use crate::journal::{EntryBody, JournalEntry, JournalError};
use crate::metrics::metrics;
use crate::presence::{ConnId, PresenceHub, PresenceInbox};
use crate::router::{Docs, Shared};
use morfa_model::{DesignDocument, DocumentPatch};
use morfa_protocol::{
    ByeReason, Change, ClientId, Codec, ErrorCode, Frame, Op, PeerInfo, PresenceUpdate, Role, Seq,
    ServerMsg, Version, Welcome, Wire,
};
use std::collections::{HashMap, VecDeque};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio::time::{MissedTickBehavior, interval, sleep_until};

// Lane B5: the node drain (crate::drain).
mod drain;

/// Frames one actor turn may write straight into idle sockets; a larger fan-out queues the rest for the
/// connections' writer tasks, which run on every thread of the runtime.
const DIRECT_WRITES_PER_TURN: u32 = 32;

/// A document this large is copied off the actor's thread when someone holds it (a snapshot, an inspection),
/// so the next op does not copy it on the actor's.
const SPARE_FROM_NODES: usize = 1000;

/// Recent `(seq, version)` pairs kept per client for re-acks; older re-sends ask the journal.
const RECENT_SEQS: usize = 1024;

/// Bytes of applied ops not yet committed, over every file of the process (TARGETS D3): past seven eighths of the
/// journal's queue budget, new ops are refused as busy before they apply.
static UNCOMMITTED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// What an uncommitted op counts against the budget: its frame's bytes and the journal's per-row allowance.
const ROW_COST: usize = 256;

fn uncommitted_add(bytes: usize) {
    UNCOMMITTED.fetch_add(bytes, std::sync::atomic::Ordering::Relaxed);
}

fn uncommitted_sub(bytes: usize) {
    UNCOMMITTED.fetch_sub(bytes, std::sync::atomic::Ordering::Relaxed);
}

pub struct JoinRequest {
    pub user: String,
    pub name: String,
    pub role: Role,
    pub client: ClientId,
    pub outbox: Arc<Outbox>,
    pub wire: Wire,
    /// The client takes field-level changes (protocol 2, `Hello::fields`).
    pub fields: bool,
    pub since: Option<Version>,
    /// The last `seq` the client says it sent.
    pub last_seq: Seq,
    /// `(last_seq, version)` when the journal holds the client's last op (looked up before joining).
    pub journal_last: Option<(Seq, Version)>,
    pub reply: oneshot::Sender<Result<Joined, ByeReason>>,
}

/// A connection the actor took.
pub struct Joined {
    pub conn: ConnId,
    /// Where the connection's reader puts presence updates.
    pub presence: Arc<PresenceInbox>,
}

/// What a test or `/internal/doc` sees of an actor.
pub struct Inspect {
    pub version: Version,
    pub committed: Version,
    pub document: Arc<DesignDocument>,
    pub stats: EngineStats,
    pub conns: usize,
    pub tail: usize,
}

pub enum ActorMsg {
    Join(Box<JoinRequest>),
    Op {
        conn: ConnId,
        op: Box<Op>,
        received: Instant,
    },
    /// Presence updates wait in the `PresenceInbox`: schedule a flush.
    PresenceDue,
    Pull {
        conn: ConnId,
        since: Version,
    },
    Leave {
        conn: ConnId,
    },
    /// api pushed a role change (None: access removed).
    Acl {
        user: String,
        role: Option<Role>,
    },
    /// api renamed the file, or closed it (trash, erase).
    File {
        name: Option<String>,
        close: Option<ByeReason>,
    },
    /// api replaced the document (restore, import): everyone reloads. Answered once the new version is
    /// committed; refused when `base_version` is set and the actor is past it.
    Replace {
        document: Box<DesignDocument>,
        user: String,
        base_version: Option<Version>,
        reply: oneshot::Sender<Result<Version, ReplaceError>>,
    },
    /// A file-class event from api (`comments`, `meeting`) for every socket, or for `only` that user's.
    Notice {
        msg: Box<ServerMsg>,
        only: Option<String>,
    },
    Inspect {
        reply: oneshot::Sender<Inspect>,
    },
    Shutdown {
        reason: ByeReason,
    },
    /// The node drains (crate::drain): checkpoint, then `bye {shutdown}`.
    Drain,
}

enum Ctl {
    Committed {
        epoch: u64,
        upto: Version,
    },
    CommitFailed {
        epoch: u64,
        from: Version,
        error: JournalError,
    },
    CatchUpReady {
        conn: ConnId,
        token: u64,
        frames: Option<Vec<Frame>>,
    },
    SnapshotReady {
        conn: ConnId,
        token: u64,
        frame: Frame,
    },
    /// A checkpoint write ended.
    Checkpointed {
        version: Version,
        ok: bool,
    },
    /// A copy of the document at `version`, made off the actor's thread while a snapshot encodes.
    Spare {
        version: Version,
        document: Box<DesignDocument>,
    },
    Lease {
        ok: bool,
    },
    Revalidated {
        user: String,
        role: Option<Role>,
    },
    DupAck {
        conn: ConnId,
        seq: Seq,
        version: Option<Version>,
    },
    /// The journal's answer for an op of a client to verify.
    Verified {
        client: ClientId,
        seq: Seq,
        found: Result<Option<Version>, JournalError>,
    },
}

/// What waits for a connection while its catch-up or snapshot is prepared off the actor.
enum Held {
    Change(Version, Out),
    Control(Out),
}

struct Waiting {
    token: u64,
    held: Vec<Held>,
    bytes: usize,
}

struct Conn {
    info: PeerInfo,
    client: ClientId,
    outbox: Arc<Outbox>,
    wire: Wire,
    /// Protocol 2: others' changes go as fields.
    fields: bool,
    waiting: Option<Waiting>,
}

#[derive(Default)]
struct ClientState {
    /// The highest seq applied (or found in the journal).
    last_seq: Seq,
    recent: VecDeque<(Seq, Version)>,
    /// Ops up to this seq may already be journaled by an earlier owner of the file: each is looked up before it
    /// applies (a client the actor never saw, reconnecting after a node change).
    verify_upto: Seq,
    /// The op being looked up, and the client's ops that wait behind it (in order).
    checking: bool,
    parked: VecDeque<(ConnId, Op, Instant)>,
    /// The seq the journal said it does not hold: it applies.
    verified: Option<Seq>,
}

struct PendingAck {
    version: Version,
    conn: ConnId,
    seq: Seq,
    received: Instant,
    own: Option<Arc<DocumentPatch>>,
}

/// One message encoded at most once per wire.
struct Encoded<'a> {
    msg: &'a ServerMsg,
    json: Option<(Frame, Out)>,
    bin: Option<(Frame, Out)>,
}

impl<'a> Encoded<'a> {
    fn new(msg: &'a ServerMsg) -> Self {
        Encoded {
            msg,
            json: None,
            bin: None,
        }
    }
    fn both(&mut self, wire: Wire) -> &(Frame, Out) {
        let slot = match wire {
            Wire::Json => &mut self.json,
            Wire::Binary => &mut self.bin,
        };
        slot.get_or_insert_with(|| {
            let frame = wire.codec().encode_server(self.msg);
            (frame.clone(), Out::from(frame))
        })
    }
    /// What a socket sends.
    fn get(&mut self, wire: Wire) -> &Out {
        &self.both(wire).1
    }
    /// Whether a frame of this message was encoded.
    fn encoded(&self) -> bool {
        self.json.is_some() || self.bin.is_some()
    }

    /// The frames encoded so far (the default wire's when none), for the tail.
    fn frames(&mut self) -> (Frame, Option<Frame>) {
        if self.json.is_none() && self.bin.is_none() {
            self.both(Wire::DEFAULT);
        }
        let mut frames = self
            .json
            .take()
            .into_iter()
            .chain(self.bin.take())
            .map(|(f, _)| f);
        let frame = frames.next().expect("one at least");
        (frame, frames.next())
    }
}

fn encode(wire: Wire, msg: &ServerMsg) -> Frame {
    wire.codec().encode_server(msg)
}

/// The latest checkpoint and whether one is being written (TARGETS S4: every `CHECKPOINT_OPS` ops, every
/// `CHECKPOINT_EVERY`, and when the last socket leaves).
struct CheckpointState {
    version: Version,
    /// The newest checkpoint object api serves for this file (`Journal::serves_checkpoints`), by its version: where a
    /// reload can start (BIG.md stage E). None: none known.
    object: Option<Version>,
    at: Instant,
    writing: bool,
    /// This file's `CHECKPOINT_EVERY`, shortened by up to a quarter at random: files opened together (a node
    /// start) do not all checkpoint in the same second.
    every: Duration,
}

/// A replace waiting for its commit, with what it replaced (a failed commit puts that back).
struct PendingReplace {
    version: Version,
    /// The document before the replace (a snapshot: a store's shares its nodes), restored if the commit fails.
    prior: Snapshot,
    reply: oneshot::Sender<Result<Version, ReplaceError>>,
}

/// How long a stopping actor waits for the commits of the ops it applied, so their acks go out before `bye`.
const DRAIN_ACKS: Duration = Duration::from_secs(5);

const CHECKPOINT_OPS: Version = 1000;
const CHECKPOINT_EVERY: Duration = Duration::from_secs(60);

pub struct DocActor {
    fence: u64,
    checkpoint: CheckpointState,
    file: String,
    shared: Arc<Shared>,
    engine: Box<dyn DocEngine>,
    name: Option<String>,
    conns: HashMap<ConnId, Conn>,
    next_conn: ConnId,
    presence: PresenceHub,
    presence_inbox: Arc<PresenceInbox>,
    /// The flush's buffer for the inbox's updates (kept for its capacity).
    presence_updates: Vec<(ConnId, PresenceUpdate)>,
    presence_due: Option<tokio::time::Instant>,
    /// The last presence flush: the next may follow `presence_flush_ms` after it.
    presence_flushed: Option<tokio::time::Instant>,
    tail: Tail,
    clients: HashMap<ClientId, ClientState>,
    pending_acks: VecDeque<PendingAck>,
    late_acks: Vec<PendingAck>,
    /// `(version, bytes)` of each op sent to the committer and not yet committed ([`UNCOMMITTED`]).
    uncommitted: VecDeque<(Version, usize)>,
    committed: Version,
    epoch: u64,
    committer: Option<mpsc::UnboundedSender<(u64, JournalEntry)>>,
    ctl_tx: mpsc::UnboundedSender<Ctl>,
    colors: HashMap<String, u32>,
    /// What a fan-out queued and has yet to send (kept for its capacity).
    fanout: Fanout,
    /// The connections' writers' runtime (large fan-outs are released there).
    writers: Option<tokio::runtime::Handle>,
    next_token: u64,
    idle_since: Option<Instant>,
    stop: Option<ByeReason>,
    drain: Option<drain::Drain>,
    replacing: Option<PendingReplace>,
}

/// Starts the actor of `file`: takes the lease, loads the document, then serves the inbox.
pub fn spawn(
    file: String,
    shared: Arc<Shared>,
    docs: Arc<Docs>,
    generation: u64,
) -> mpsc::Sender<ActorMsg> {
    let (tx, rx) = mpsc::channel(shared.config.inbox);
    tokio::spawn(async move {
        let refuse = |mut rx: mpsc::Receiver<ActorMsg>, reason: ByeReason| {
            rx.close();
            while let Ok(msg) = rx.try_recv() {
                if let ActorMsg::Join(join) = msg {
                    let _ = join.reply.send(Err(reason));
                }
            }
        };
        let fence = match shared.lease.acquire(&file, &shared.config.node).await {
            Ok(fence) => fence,
            Err(error) => {
                tracing::warn!(file, ?error, "lease not taken");
                docs.remove(&file, generation);
                refuse(rx, ByeReason::Moved);
                return;
            }
        };
        let loaded = match shared.journal.load(&file).await {
            Ok(Some(loaded)) => loaded,
            Ok(None) => {
                docs.remove(&file, generation);
                shared
                    .lease
                    .release(&file, &shared.config.node, fence)
                    .await;
                refuse(rx, ByeReason::Erased);
                return;
            }
            Err(error) => {
                tracing::error!(file, %error, "load failed");
                docs.remove(&file, generation);
                shared
                    .lease
                    .release(&file, &shared.config.node, fence)
                    .await;
                refuse(rx, ByeReason::Shutdown);
                return;
            }
        };
        let version = loaded.version;
        let object = loaded.checkpoint;
        // Building the engine converts or sizes the document (a 20 000-layer page: tens of milliseconds): off
        // the shard's thread, where other files' ops wait.
        let factory = Arc::clone(&shared.engine);
        let source = loaded.source;
        let built = tokio::task::spawn_blocking(move || factory(source, version));
        let engine = match built.await {
            Ok(engine) => engine,
            Err(error) => {
                tracing::error!(file, %error, "engine not built");
                docs.remove(&file, generation);
                shared
                    .lease
                    .release(&file, &shared.config.node, fence)
                    .await;
                refuse(rx, ByeReason::Shutdown);
                return;
            }
        };
        let (ctl_tx, ctl_rx) = mpsc::unbounded_channel();
        let (commit_tx, commit_rx) = mpsc::unbounded_channel();
        let committer = tokio::spawn(run_committer(
            file.clone(),
            Arc::clone(&shared),
            fence,
            commit_rx,
            ctl_tx.clone(),
        ));
        let mut actor = DocActor {
            file: file.clone(),
            shared: Arc::clone(&shared),
            engine,
            name: loaded.name,
            conns: HashMap::new(),
            next_conn: 1,
            presence: PresenceHub::default(),
            presence_inbox: Arc::default(),
            presence_updates: Vec::new(),
            presence_due: None,
            presence_flushed: None,
            tail: Tail::with_limits(shared.config.tail_entries, shared.config.tail_bytes),
            clients: HashMap::new(),
            pending_acks: VecDeque::new(),
            late_acks: Vec::new(),
            uncommitted: VecDeque::new(),
            committed: version,
            epoch: 0,
            committer: Some(commit_tx),
            ctl_tx,
            colors: HashMap::new(),
            fanout: Fanout::default(),
            writers: docs.writers.clone(),
            next_token: 1,
            idle_since: Some(Instant::now()),
            stop: None,
            drain: None,
            replacing: None,
            fence,
            checkpoint: CheckpointState {
                version,
                object,
                at: Instant::now(),
                every: CHECKPOINT_EVERY.mul_f64(1.0 - rand::random::<f64>() * 0.25),
                writing: false,
            },
        };
        metrics().docs_open.add(1);
        let resident = actor.engine.stats().approx_bytes as i64;
        metrics().doc_resident_bytes.add(resident);
        let mut rx = rx;
        actor.run(&mut rx, ctl_rx, fence).await;
        metrics().docs_open.add(-1);
        metrics()
            .doc_resident_bytes
            .add(-(actor.engine.stats().approx_bytes as i64));
        // The committer stores what is queued, then releases the lease; only then may a new actor load.
        actor.committer = None;
        let _ = committer.await;
        uncommitted_sub(actor.uncommitted.drain(..).map(|(_, bytes)| bytes).sum());
        docs.remove(&file, generation);
        drop(rx);
    });
    tx
}

async fn run_committer(
    file: String,
    shared: Arc<Shared>,
    fence: u64,
    mut rx: mpsc::UnboundedReceiver<(u64, JournalEntry)>,
    ctl: mpsc::UnboundedSender<Ctl>,
) {
    let mut failed_epoch: Option<u64> = None;
    let mut batch: Vec<JournalEntry> = Vec::with_capacity(256);
    while let Some(first) = rx.recv().await {
        batch.clear();
        let mut epoch = first.0;
        let stale = |e: u64| failed_epoch.is_some_and(|f| e <= f);
        if !stale(first.0) {
            batch.push(first.1);
        }
        while batch.len() < 256 {
            match rx.try_recv() {
                Ok((e, entry)) if !stale(e) => {
                    epoch = e;
                    batch.push(entry);
                }
                Ok(_) => {}
                Err(_) => break,
            }
        }
        if batch.is_empty() {
            continue;
        }
        let started = Instant::now();
        let result = shared.journal.commit(&file, fence, &batch).await;
        metrics().journal_commit.record(started.elapsed());
        let upto = batch.last().expect("non-empty").version;
        let message = match result {
            Ok(()) => Ctl::Committed { epoch, upto },
            Err(error) => {
                failed_epoch = Some(epoch);
                Ctl::CommitFailed {
                    epoch,
                    from: batch[0].version,
                    error,
                }
            }
        };
        let _ = ctl.send(message);
    }
    shared
        .lease
        .release(&file, &shared.config.node, fence)
        .await;
}

impl DocActor {
    async fn run(
        &mut self,
        inbox: &mut mpsc::Receiver<ActorMsg>,
        mut ctl: mpsc::UnboundedReceiver<Ctl>,
        fence: u64,
    ) {
        let config = &self.shared.config;
        let mut lease_tick = interval(config.lease_renew);
        lease_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        lease_tick.reset();
        let jitter = rand::random::<f64>() * 0.5 + 0.75;
        let mut revalidate_tick = interval(config.revalidate.mul_f64(jitter));
        revalidate_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        revalidate_tick.reset();
        let mut idle_tick = interval(
            config
                .idle_close
                .min(Duration::from_secs(5))
                .max(Duration::from_millis(10)),
        );
        idle_tick.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let idle_close = config.idle_close;
        loop {
            let presence_due = self.presence_due;
            // Whatever a turn sends may go straight into idle sockets, up to a bound (backpressure.rs). The
            // allowance is per thread, so it is set inside each arm, after the await.
            let direct = || DirectWrites::allow(DIRECT_WRITES_PER_TURN);
            tokio::select! {
                biased;
                Some(message) = ctl.recv() => {
                    let _direct = direct();
                    self.on_ctl(message)
                }
                message = inbox.recv() => match message {
                    Some(message) => {
                        let _direct = direct();
                        self.on_msg(message)
                    }
                    None => break,
                },
                _ = async { sleep_until(presence_due.expect("guarded")).await }, if presence_due.is_some() => {
                    let _direct = direct();
                    self.flush_presence();
                }
                _ = lease_tick.tick() => self.renew_lease(fence),
                _ = revalidate_tick.tick() => self.revalidate(),
                _ = idle_tick.tick() => {
                    self.maybe_checkpoint(self.conns.is_empty());
                    if self.conns.is_empty()
                        && self.pending_acks.is_empty()
                        && self.idle_since.is_some_and(|since| since.elapsed() >= idle_close)
                    {
                        break;
                    }
                }
            }
            self.drain_step();
            if let Some(reason) = self.stop {
                self.drain_acks(&mut ctl).await;
                self.close_all(reason);
                break;
            }
        }
    }

    /// Before the sockets close: waits (up to `DRAIN_ACKS`) for the commits of every op already applied and acks
    /// them, so a client that leaves for another node or for PATCH does not send acked ops again. Nothing new
    /// applies meanwhile (the inbox is not read: an op sent now stays unacked and is re-sent on the new path).
    async fn drain_acks(&mut self, ctl: &mut mpsc::UnboundedReceiver<Ctl>) {
        let deadline = tokio::time::Instant::now() + DRAIN_ACKS;
        while !(self.pending_acks.is_empty()
            && self.late_acks.is_empty()
            && self.replacing.is_none())
            && self.committer.is_some()
        {
            let message = tokio::select! {
                message = ctl.recv() => message,
                _ = tokio::time::sleep_until(deadline) => None,
            };
            let Some(message) = message else { break };
            match message {
                // Only the journal's answers matter now (and a lease that is gone ends the wait at once).
                Ctl::Committed { .. } | Ctl::CommitFailed { .. } => {
                    let _direct = DirectWrites::allow(DIRECT_WRITES_PER_TURN);
                    self.on_ctl(message);
                }
                Ctl::Lease { ok: false } => break,
                _ => {}
            }
        }
        if let Some(pending) = self.replacing.take() {
            let _ = pending
                .reply
                .send(Err(ReplaceError::Failed("the file closed".into())));
        }
    }

    // ── Messages ─────────────────────────────────────────────────────────────────────────────────

    fn on_msg(&mut self, message: ActorMsg) {
        match message {
            ActorMsg::Join(join) if self.drain.is_some() => drain::refuse_join(*join),
            ActorMsg::Op { .. } if self.drain.is_some() => drain::defer_op(),
            ActorMsg::Join(join) => self.on_join(*join),
            ActorMsg::Op { conn, op, received } => self.on_op(conn, *op, received),
            ActorMsg::PresenceDue => self.schedule_presence(),
            ActorMsg::Pull { conn, since } => self.serve_catch_up(conn, since, false),
            ActorMsg::Leave { conn } => self.remove_conn(conn, None),
            ActorMsg::Acl { user, role } => self.on_acl(&user, role),
            ActorMsg::File { name, close } => {
                if let Some(name) = name {
                    self.name = Some(name.clone());
                    self.broadcast(&ServerMsg::File { name }, None);
                }
                if let Some(reason) = close {
                    self.stop = Some(reason);
                }
            }
            ActorMsg::Replace {
                document,
                user,
                base_version,
                reply,
            } => self.on_replace(*document, user, base_version, reply),
            ActorMsg::Notice { msg, only } => self.notice(&msg, only.as_deref()),
            ActorMsg::Inspect { reply } => {
                let snapshot = self.engine.snapshot();
                let version = self.engine.version();
                if let Snapshot::Model(document) = &snapshot
                    && document.nodes.len() >= SPARE_FROM_NODES
                {
                    // Whoever asked holds the document a while (`/internal/doc` hashes it): copy it off the
                    // actor's thread, as for a snapshot.
                    let (copy, ctl) = (Arc::clone(document), self.ctl_tx.clone());
                    tokio::task::spawn_blocking(move || {
                        let _ = ctl.send(Ctl::Spare {
                            version,
                            document: Box::new((*copy).clone()),
                        });
                    });
                }
                let (committed, stats, conns, tail) = (
                    self.committed,
                    self.engine.stats(),
                    self.conns.len(),
                    self.tail.len(),
                );
                let large = snapshot.nodes() >= SPARE_FROM_NODES;
                let send = move || {
                    let _ = reply.send(Inspect {
                        version,
                        committed,
                        document: snapshot.model(),
                        stats,
                        conns,
                        tail,
                    });
                };
                if large {
                    // A store's conversion of a large document: off the actor's thread.
                    tokio::task::spawn_blocking(send);
                } else {
                    send();
                }
            }
            ActorMsg::Shutdown { reason } => self.stop = Some(reason),
            ActorMsg::Drain => self.begin_drain(),
        }
    }

    fn on_ctl(&mut self, message: Ctl) {
        match message {
            Ctl::Committed { epoch, upto } => {
                if epoch == self.epoch {
                    self.on_committed(upto);
                }
            }
            Ctl::CommitFailed { epoch, from, error } => {
                if epoch == self.epoch {
                    self.on_commit_failed(from, error);
                }
            }
            Ctl::CatchUpReady {
                conn,
                token,
                frames,
            } => {
                let Some(c) = self.conns.get(&conn) else {
                    return;
                };
                if c.waiting.as_ref().is_none_or(|w| w.token != token) {
                    return;
                }
                match frames {
                    Some(frames) => {
                        for frame in frames {
                            c.outbox.push_force(frame);
                        }
                        self.release_held(conn);
                    }
                    None => {
                        // The journal no longer reaches back: reload (the held changes follow the snapshot).
                        let version = self.engine.version();
                        let resync = encode(
                            c.wire,
                            &ServerMsg::Resync {
                                version,
                                snapshot_url: None,
                            },
                        );
                        c.outbox.push(resync);
                        self.send_snapshot(conn);
                    }
                }
            }
            Ctl::Spare { version, document } => self.engine.adopt_copy(*document, version),
            Ctl::Checkpointed { version, ok } => {
                self.checkpoint.writing = false;
                if ok {
                    self.checkpoint.version = self.checkpoint.version.max(version);
                    if self.shared.journal.serves_checkpoints() {
                        self.checkpoint.object = self.checkpoint.object.max(Some(version));
                    }
                    self.checkpoint.at = Instant::now();
                    // api hears of it (the file card's thumbnail through the render service); nothing waits.
                    if let Some(acl) = self.shared.acl.clone() {
                        let file = self.file.clone();
                        tokio::spawn(async move { acl.checkpointed(&file, version).await });
                    }
                }
            }
            Ctl::SnapshotReady { conn, token, frame } => {
                let Some(c) = self.conns.get(&conn) else {
                    return;
                };
                if c.waiting.as_ref().is_some_and(|w| w.token == token) {
                    c.outbox.push_force(frame);
                    self.release_held(conn);
                }
            }
            Ctl::Lease { ok } => {
                if !ok {
                    metrics().lease_moves_total.inc();
                    self.stop = Some(ByeReason::Moved);
                }
            }
            Ctl::Revalidated { user, role } => self.on_acl(&user, role),
            Ctl::Verified { client, seq, found } => self.on_verified(client, seq, found),
            Ctl::DupAck { conn, seq, version } => {
                if let Some(c) = self.conns.get(&conn) {
                    let msg = match version {
                        Some(version) => ServerMsg::Ack {
                            seq,
                            version,
                            own: None,
                        },
                        None => refused(
                            seq,
                            Refusal::new(ErrorCode::BadMessage, "seq already used."),
                        ),
                    };
                    c.outbox.push(encode(c.wire, &msg));
                }
            }
        }
    }

    // ── Joining ──────────────────────────────────────────────────────────────────────────────────

    fn color_for(&mut self, user: &str) -> u32 {
        if let Some(&color) = self.colors.get(user) {
            return color;
        }
        let mut used = [0u32; 8];
        for &c in self.colors.values() {
            used[c as usize % 8] += 1;
        }
        let color = (0..8u32)
            .min_by_key(|&c| (used[c as usize], c))
            .unwrap_or(0);
        self.colors.insert(user.to_owned(), color);
        color
    }

    fn on_join(&mut self, join: JoinRequest) {
        if self.stop.is_some() {
            let _ = join.reply.send(Err(ByeReason::Shutdown));
            return;
        }
        if self.conns.len() >= self.shared.config.conns_per_file {
            let _ = join.reply.send(Err(ByeReason::Limit));
            return;
        }
        let id = self.next_conn;
        self.next_conn += 1;
        let connection = format!("{:012x}", rand::random::<u64>() >> 16);
        let color = self.color_for(&join.user);
        let info = PeerInfo {
            connection: connection.clone(),
            user: join.user.clone(),
            name: join.name.clone(),
            color,
            role: join.role,
        };
        let known = self.clients.contains_key(&join.client);
        let client = self.clients.entry(join.client.clone()).or_default();
        if !known {
            match join.journal_last {
                Some((seq, version)) => {
                    client.last_seq = seq;
                    client.recent.push_back((seq, version));
                }
                None => client.verify_upto = join.last_seq,
            }
        }
        let acked_seq = client.last_seq;
        let version = self.engine.version();
        let resync = match join.since {
            None => true,
            Some(since) => since > version,
        };
        // A reload through the checkpoint object when it is near enough (BIG.md stage E); else the document frame.
        let via = if resync {
            self.via_checkpoint(join.wire, join.fields)
        } else {
            None
        };
        let welcome = ServerMsg::Welcome(Box::new(Welcome {
            connection,
            version,
            role: join.role,
            can_edit: join.role.can_edit(),
            user: join.user,
            name: join.name,
            color,
            peers: self.presence.roster(id),
            resync,
            snapshot_url: via.as_ref().map(|(url, _)| url.clone()),
            acked_seq,
        }));
        join.outbox.push(encode(join.wire, &welcome));
        if let Some(name) = &self.name {
            join.outbox
                .push(encode(join.wire, &ServerMsg::File { name: name.clone() }));
        }
        self.conns.insert(
            id,
            Conn {
                info: info.clone(),
                client: join.client,
                outbox: join.outbox,
                wire: join.wire,
                fields: join.fields,
                waiting: None,
            },
        );
        metrics().conn_open.add(1);
        self.idle_since = None;
        self.presence.join(id, info);
        let _ = join.reply.send(Ok(Joined {
            conn: id,
            presence: Arc::clone(&self.presence_inbox),
        }));
        match (join.since, via) {
            (Some(since), _) if !resync => self.serve_catch_up(id, since, true),
            (_, Some((_, from))) => self.serve_catch_up(id, from, true),
            _ => self.send_snapshot(id),
        }
        self.schedule_presence();
    }

    // ── Ops ──────────────────────────────────────────────────────────────────────────────────────

    fn on_op(&mut self, conn_id: ConnId, op: Op, received: Instant) {
        metrics().op_queue.record(received.elapsed());
        let Some(conn) = self.conns.get(&conn_id) else {
            return;
        };
        let wire = conn.wire;
        if !conn.info.role.can_edit() {
            metrics().ops_refused_total.inc();
            conn.outbox.push(encode(
                wire,
                &refused(
                    op.seq,
                    Refusal::new(ErrorCode::DesignForbidden, "You do not have permission to edit this file."),
                ),
            ));
            return;
        }
        let journal = &self.shared.journal;
        if journal.backlogged()
            || UNCOMMITTED.load(std::sync::atomic::Ordering::Relaxed)
                > journal.queue_budget() / 8 * 7
        {
            // The journal cannot take more now (TARGETS D3): the client keeps the op and sends it again later;
            // nothing applies, so nobody rolls back.
            metrics().ops_refused_total.inc();
            metrics().ops_deferred_total.inc();
            let version = self.engine.version();
            conn.outbox.push(encode(
                wire,
                &refused(
                    op.seq,
                    Refusal {
                        current_version: Some(version),
                        ..Refusal::new(
                            ErrorCode::DesignLiveBusy,
                            "Changes are being saved. Try again later.",
                        )
                    },
                ),
            ));
            return;
        }
        let client_id = conn.client.clone();
        let client = self.clients.entry(client_id.clone()).or_default();
        if client.checking {
            client.parked.push_back((conn_id, op, received));
            return;
        }
        if op.seq <= client.last_seq {
            self.on_resent(conn_id, &client_id, op.seq);
            return;
        }
        if op.seq <= client.verify_upto && client.verified != Some(op.seq) {
            client.checking = true;
            let seq = op.seq;
            client.parked.push_front((conn_id, op, received));
            let journal = Arc::clone(&self.shared.journal);
            let file = self.file.clone();
            let ctl = self.ctl_tx.clone();
            tokio::spawn(async move {
                let found = journal.find_client_op(&file, &client_id, seq).await;
                let _ = ctl.send(Ctl::Verified {
                    client: client_id,
                    seq,
                    found,
                });
            });
            return;
        }
        let mut op = op;
        let seq = op.seq;
        // Protocol 2's field ops become whole nodes over the actor's own (crate::fields_op), timed with the apply.
        let started = Instant::now();
        let engine = &self.engine;
        let expanded =
            match crate::fields_op::expand(&mut op, engine.version(), |id| engine.node(id)) {
                Ok(expanded) => expanded,
                Err(refusal) => {
                    metrics().ops_refused_total.inc();
                    let conn = &self.conns[&conn_id];
                    conn.outbox.push(encode(wire, &refused(seq, refusal)));
                    return;
                }
            };
        let input = match OpInput::of(&mut op, self.engine.version()) {
            Ok(input) => input,
            Err(refusal) => {
                metrics().ops_refused_total.inc();
                let conn = &self.conns[&conn_id];
                conn.outbox.push(encode(wire, &refused(seq, refusal)));
                return;
            }
        };
        let engine = &mut self.engine;
        let result = catch_unwind(AssertUnwindSafe(|| engine.apply(&input)));
        metrics().op_apply.record(started.elapsed());
        let mut applied = match result {
            Ok(Ok(applied)) => applied,
            Ok(Err(refusal)) => {
                metrics().ops_refused_total.inc();
                let conn = &self.conns[&conn_id];
                conn.outbox.push(encode(wire, &refused(op.seq, refusal)));
                return;
            }
            Err(panic) => {
                metrics().panics_total.inc();
                let message = panic
                    .downcast_ref::<&str>()
                    .map(|s| s.to_string())
                    .or_else(|| panic.downcast_ref::<String>().cloned())
                    .unwrap_or_default();
                tracing::error!(
                    file = self.file,
                    seq = op.seq,
                    client = client_id.as_str(),
                    message,
                    "op panicked the engine"
                );
                let conn = &self.conns[&conn_id];
                conn.outbox.push(encode(
                    wire,
                    &refused(
                        op.seq,
                        Refusal::new(
                            ErrorCode::DesignDocumentInvalid,
                            "The change could not be applied.",
                        ),
                    ),
                ));
                return;
            }
        };
        if !expanded.dropped.is_empty() {
            // Edits of layers someone removed were dropped: the ack says what the server holds for every layer of the
            // op, as for an op the merge adjusted.
            let mut sent = op.patch.clone();
            let nodes = sent.nodes.get_or_insert_with(Default::default);
            for id in &expanded.dropped {
                nodes.insert(id.clone(), None);
            }
            if let Some(own) = self.engine.stored_values(&sent, &applied.stored) {
                applied.own = Some(Arc::new(own));
                applied.adjusted = true;
            }
        }
        metrics().ops_total.inc();
        let version = applied.version;
        if applied.stored.is_empty() {
            // Nothing changed (an empty patch, or a merge that dropped every entry): acked on the current
            // version once that is journaled; nothing to journal or send.
            let client = self.clients.get_mut(&client_id).expect("inserted above");
            client.last_seq = op.seq;
            if client.recent.len() >= RECENT_SEQS {
                client.recent.pop_front();
            }
            client.recent.push_back((op.seq, version));
            let ack = PendingAck {
                version,
                conn: conn_id,
                seq: op.seq,
                received,
                own: applied.own,
            };
            if version <= self.committed {
                self.send_ack(ack);
            } else {
                self.pending_acks.push_back(ack);
            }
            return;
        }
        let conn = &self.conns[&conn_id];
        let change = Change {
            version,
            by: Some(conn.info.connection.clone()),
            client: Some(client_id.clone()),
            seq: Some(op.seq),
            user: conn.info.user.clone(),
            patch: Arc::clone(&applied.stored),
            fields: None,
        };
        let user = change.user.clone();
        let connection = change.by.clone();
        // Protocol 2 (lane W): the nodes the file had as the fields that changed, computed once when anyone here
        // takes them; None when no node qualifies (then both protocols get the same frame).
        // An op whose field nodes landed as sent names its fields itself (no diff), when they are all the change's
        // existing nodes.
        let by_field = self
            .conns
            .values()
            .any(|c| c.fields)
            .then(|| {
                let known = (!applied.adjusted && !expanded.nodes.is_empty())
                    .then(|| crate::fields_op::diffs(&expanded.nodes, &applied.stored))
                    .flatten()
                    .filter(|diffs| diffs.len() == existing_nodes(&applied.undo));
                match known {
                    Some(diffs) => change.with_diffs(diffs),
                    None => change.with_fields(&applied.undo),
                }
            })
            .flatten()
            .map(ServerMsg::Change);
        let msg = ServerMsg::Change(change);
        let mut encoded = Encoded::new(&msg);
        let mut encoded_fields = by_field.as_ref().map(Encoded::new);
        let mut sent = 0;
        for (&id, peer) in self.conns.iter_mut() {
            if id == conn_id {
                continue;
            }
            let frame = match (&mut encoded_fields, peer.fields) {
                (Some(fields), true) => fields.get(peer.wire),
                _ => encoded.get(peer.wire),
            };
            match &mut peer.waiting {
                Some(waiting) => {
                    waiting.bytes += frame.len();
                    waiting.held.push(Held::Change(version, frame.clone()));
                }
                None => {
                    if peer.outbox.push_change_held(version, frame) {
                        self.fanout.hold(&peer.outbox);
                    }
                }
            }
            sent += 1;
        }
        // M1: received → change queued to every peer. Then the frames go out (straight into idle sockets).
        metrics().op_fanout.record(received.elapsed());
        metrics().changes_sent_total.add(sent);
        crate::observe::op_fanned_out(
            &self.file, &client_id, seq, version, received, started, sent,
        );
        self.fanout.release(self.writers.as_ref());
        // The tail keeps the frames the fan-out made (one per wire its peers speak; the default when none), and the
        // field-level ones for catch-ups of protocol 2 clients.
        // Whole frames only when a peer took them, or when the change has no field form: with protocol 2 clients
        // alone the whole change is never encoded (a protocol 1 catch-up over it reloads, crate::catchup).
        let fields = encoded_fields.map(|mut e| e.frames());
        let whole = (encoded.encoded() || fields.is_none()).then(|| encoded.frames());
        // What the op counts against the journal's budget (TARGETS D3): the whole frame's bytes, as before; without
        // one, the stored patch's nodes at the engine's estimate of a node's JSON (the journal still holds them
        // whole), never the small field frame.
        let cost = match &whole {
            Some((frame, _)) => frame.len(),
            None => {
                applied.stored.nodes.as_ref().map_or(0, |nodes| nodes.len())
                    * crate::engine::APPROX_BYTES_PER_NODE
                    + fields.as_ref().map_or(0, |(frame, _)| frame.len())
            }
        } + ROW_COST;
        let ServerMsg::Change(change) = msg else {
            unreachable!()
        };
        self.tail.push(TailEntry {
            change,
            whole,
            fields,
            undo: Some(applied.undo),
        });
        let client = self.clients.get_mut(&client_id).expect("inserted above");
        client.last_seq = op.seq;
        if client.recent.len() >= RECENT_SEQS {
            client.recent.pop_front();
        }
        client.recent.push_back((op.seq, version));
        if let Some(committer) = &self.committer {
            let _ = committer.send((
                self.epoch,
                JournalEntry {
                    version,
                    user,
                    connection,
                    client: Some(client_id),
                    seq: Some(op.seq),
                    body: EntryBody::Patch(Arc::clone(&applied.stored)),
                },
            ));
            self.uncommitted.push_back((version, cost));
            uncommitted_add(cost);
        }
        self.pending_acks.push_back(PendingAck {
            version,
            conn: conn_id,
            seq: op.seq,
            received,
            own: applied.own,
        });
        self.check_holds();
    }

    fn on_verified(
        &mut self,
        client_id: ClientId,
        seq: Seq,
        found: Result<Option<Version>, JournalError>,
    ) {
        let Some(client) = self.clients.get_mut(&client_id) else {
            return;
        };
        client.checking = false;
        let Some((conn, op, received)) = client.parked.pop_front() else {
            return;
        };
        debug_assert_eq!(op.seq, seq);
        match found {
            Ok(Some(version)) => {
                // Journaled by an earlier owner: a re-send.
                client.last_seq = client.last_seq.max(seq);
                client.recent.push_back((seq, version));
            }
            Ok(None) => client.verified = Some(seq),
            Err(error) => {
                tracing::warn!(file = self.file, %error, "client op lookup failed");
                if let Some(c) = self.conns.get(&conn) {
                    c.outbox.push(encode(
                        c.wire,
                        &refused(
                            seq,
                            Refusal::new(ErrorCode::DesignUnavailable, "Send it again."),
                        ),
                    ));
                }
                // The rest waits for its own re-send.
                let parked = std::mem::take(&mut client.parked);
                for (conn, op, _) in parked {
                    if let Some(c) = self.conns.get(&conn) {
                        c.outbox.push(encode(
                            c.wire,
                            &refused(
                                op.seq,
                                Refusal::new(ErrorCode::DesignUnavailable, "Send it again."),
                            ),
                        ));
                    }
                }
                return;
            }
        }
        self.on_op(conn, op, received);
        loop {
            let Some(client) = self.clients.get_mut(&client_id) else {
                return;
            };
            if client.checking {
                return;
            }
            let Some((conn, op, received)) = client.parked.pop_front() else {
                return;
            };
            self.on_op(conn, op, received);
        }
    }

    /// A re-sent op (`seq` already applied): re-acked with its version, never re-applied.
    fn on_resent(&mut self, conn_id: ConnId, client_id: &ClientId, seq: Seq) {
        let client = &self.clients[client_id];
        match client.recent.iter().find(|(s, _)| *s == seq) {
            Some(&(_, version)) => {
                let ack = PendingAck {
                    version,
                    conn: conn_id,
                    seq,
                    received: Instant::now(),
                    own: None,
                };
                if version <= self.committed {
                    self.send_ack(ack);
                } else {
                    self.late_acks.push(ack);
                }
            }
            None => {
                let journal = Arc::clone(&self.shared.journal);
                let file = self.file.clone();
                let client = client_id.clone();
                let ctl = self.ctl_tx.clone();
                tokio::spawn(async move {
                    let version = journal
                        .find_client_op(&file, &client, seq)
                        .await
                        .ok()
                        .flatten();
                    let _ = ctl.send(Ctl::DupAck {
                        conn: conn_id,
                        seq,
                        version,
                    });
                });
            }
        }
    }

    fn send_ack(&self, ack: PendingAck) {
        let Some(conn) = self.conns.get(&ack.conn) else {
            return;
        };
        conn.outbox.push(encode(
            conn.wire,
            &ServerMsg::Ack {
                seq: ack.seq,
                version: ack.version,
                own: ack.own,
            },
        ));
        metrics().op_ack.record(ack.received.elapsed());
        crate::observe::op_acked(&self.file, &conn.client, ack.seq, ack.version, ack.received);
    }

    /// Writes a checkpoint when the policy asks for one and every applied op is journaled (a checkpoint is of a
    /// journaled version). `leaving`: the last socket left.
    fn maybe_checkpoint(&mut self, leaving: bool) {
        let version = self.engine.version();
        let state = &self.checkpoint;
        if state.writing || version != self.committed || version <= state.version {
            return;
        }
        if !(leaving
            || version - state.version >= CHECKPOINT_OPS
            || state.at.elapsed() >= state.every)
        {
            return;
        }
        self.checkpoint.writing = true;
        let (journal, ctl) = (Arc::clone(&self.shared.journal), self.ctl_tx.clone());
        let (file, fence) = (self.file.clone(), self.fence);
        // A store-backed engine's snapshot shares its nodes (a clone of pointers); a typed one is copied off this
        // thread for the engine while the write holds it.
        let snapshot = self.engine.snapshot();
        if let Snapshot::Model(document) = &snapshot
            && document.nodes.len() >= SPARE_FROM_NODES
        {
            let (copy, ctl) = (Arc::clone(document), self.ctl_tx.clone());
            tokio::task::spawn_blocking(move || {
                let _ = ctl.send(Ctl::Spare {
                    version,
                    document: Box::new((*copy).clone()),
                });
            });
        }
        tokio::spawn(async move {
            let started = Instant::now();
            let result = match snapshot {
                Snapshot::Store(store) => {
                    journal.checkpoint_store(&file, fence, version, store).await
                }
                Snapshot::Model(document) => {
                    journal.checkpoint(&file, fence, version, document).await
                }
            };
            crate::observe::checkpoint_done(started.elapsed(), result.is_ok());
            if let Err(error) = &result {
                tracing::warn!(file, version, %error, "checkpoint not written");
            }
            let _ = ctl.send(Ctl::Checkpointed {
                version,
                ok: result.is_ok(),
            });
        });
    }

    fn on_committed(&mut self, upto: Version) {
        self.committed = self.committed.max(upto);
        while let Some(&(_, bytes)) = self.uncommitted.front().filter(|(v, _)| *v <= upto) {
            self.uncommitted.pop_front();
            uncommitted_sub(bytes);
        }
        if self.replacing.as_ref().is_some_and(|r| r.version <= upto) {
            let pending = self.replacing.take().expect("checked");
            let _ = pending.reply.send(Ok(pending.version));
        }
        self.tail.mark_committed(upto);
        while self
            .pending_acks
            .front()
            .is_some_and(|ack| ack.version <= upto)
        {
            let ack = self.pending_acks.pop_front().expect("checked");
            self.send_ack(ack);
        }
        if !self.late_acks.is_empty() {
            let (ready, later): (Vec<_>, Vec<_>) = std::mem::take(&mut self.late_acks)
                .into_iter()
                .partition(|ack| ack.version <= upto);
            self.late_acks = later;
            for ack in ready {
                self.send_ack(ack);
            }
        }
        self.maybe_checkpoint(self.conns.is_empty());
    }

    fn on_commit_failed(&mut self, from: Version, error: JournalError) {
        tracing::error!(file = self.file, from, %error, "journal commit failed: rolling back");
        if error == JournalError::Fenced {
            metrics().lease_moves_total.inc();
            self.stop = Some(ByeReason::Moved);
        }
        metrics().rollback_total.inc();
        self.epoch += 1;
        let to = from - 1;
        while let Some(&(_, bytes)) = self.uncommitted.back().filter(|(v, _)| *v >= from) {
            self.uncommitted.pop_back();
            uncommitted_sub(bytes);
        }
        for entry in self.tail.pop_from(from) {
            if let Some(undo) = &entry.undo {
                self.engine.revert(undo, entry.version() - 1);
            }
            if let (Some(client), Some(seq)) = (&entry.change.client, entry.change.seq)
                && let Some(state) = self.clients.get_mut(client)
            {
                state.recent.retain(|(s, _)| *s < seq);
                state.last_seq = state.last_seq.min(seq - 1);
            }
        }
        // A replace in the failed batch: the document it replaced comes back (the ops after it are undone above).
        if self.replacing.as_ref().is_some_and(|r| r.version >= from) {
            let pending = self.replacing.take().expect("checked");
            self.engine
                .replace((*pending.prior.model()).clone(), pending.version - 1);
            let _ = pending
                .reply
                .send(Err(ReplaceError::Failed(error.to_string())));
            if self.engine.version() != to {
                // Ops the replace's `tail.clear()` dropped were in the failed batch too: they cannot be undone
                // here, so the actor stops and the next one loads what the journal holds.
                self.stop.get_or_insert(ByeReason::Shutdown);
            }
        }
        debug_assert!(self.stop.is_some() || self.engine.version() == to);
        let unavailable = |seq| {
            refused(
                seq,
                Refusal {
                    current_version: Some(to),
                    ..Refusal::new(
                        ErrorCode::DesignUnavailable,
                        "The change was not saved. Send it again.",
                    )
                },
            )
        };
        let failed: Vec<PendingAck> = self
            .pending_acks
            .drain(..)
            .chain(std::mem::take(&mut self.late_acks))
            .collect();
        for ack in failed {
            if ack.version <= to {
                // A re-ack of a committed version survives.
                self.pending_acks.push_back(ack);
                continue;
            }
            if let Some(conn) = self.conns.get(&ack.conn) {
                conn.outbox.push(encode(conn.wire, &unavailable(ack.seq)));
            }
        }
        self.broadcast_held(&ServerMsg::Rollback { version: to });
    }

    // ── Catch-up and snapshots ───────────────────────────────────────────────────────────────────

    fn serve_catch_up(&mut self, conn_id: ConnId, since: Version, joining: bool) {
        let Some(conn) = self.conns.get_mut(&conn_id) else {
            return;
        };
        if conn.waiting.is_some() {
            return;
        }
        let started = Instant::now();
        let version = self.engine.version();
        let codec: &dyn Codec = conn.wire.codec();
        match self.tail.catch_up(codec, conn.fields, since, version) {
            CatchUp::Current => {}
            CatchUp::Frames(frames) => {
                metrics().catchup_total.inc();
                for frame in frames {
                    conn.outbox.push_force(frame);
                }
                metrics().catchup.record(started.elapsed());
            }
            CatchUp::Journal { since, upto, tail } => {
                metrics().catchup_total.inc();
                let token = self.next_token;
                self.next_token += 1;
                conn.waiting = Some(Waiting {
                    token,
                    held: Vec::new(),
                    bytes: 0,
                });
                let journal = Arc::clone(&self.shared.journal);
                let file = self.file.clone();
                let ctl = self.ctl_tx.clone();
                let wire = conn.wire;
                tokio::spawn(async move {
                    let rows = journal
                        .read(&file, since, upto, crate::catchup::CATCHUP_MAX_OPS)
                        .await
                        .unwrap_or_default();
                    let frames = frames_from_journal(wire.codec(), since, upto, &rows, &tail);
                    metrics().catchup.record(started.elapsed());
                    let _ = ctl.send(Ctl::CatchUpReady {
                        conn: conn_id,
                        token,
                        frames,
                    });
                });
            }
            CatchUp::Reload => {
                let (wire, fields) = (conn.wire, conn.fields);
                if let Some((url, from)) = self.via_checkpoint(wire, fields) {
                    // The client loads the checkpoint and the changes after it follow (BIG.md stage E).
                    let conn = self.conns.get_mut(&conn_id).expect("present");
                    conn.outbox.push(encode(
                        wire,
                        &ServerMsg::Resync {
                            version,
                            snapshot_url: Some(url),
                        },
                    ));
                    return self.serve_catch_up(conn_id, from, joining);
                }
                if !joining {
                    let conn = self.conns.get_mut(&conn_id).expect("present");
                    conn.outbox.push(encode(
                        wire,
                        &ServerMsg::Resync {
                            version,
                            snapshot_url: None,
                        },
                    ));
                }
                self.send_snapshot(conn_id);
            }
        }
    }

    /// Where a client that must reload can load the document instead of the document frame (BIG.md stage E): api's
    /// `GET /api/design-files/:id/checkpoint` and the checkpoint's version, when the resync through it is on, the
    /// file has a checkpoint object at most `snapshot_max_ops` versions behind, and the catch-up from it can be served
    /// (from the tail or the journal: never another reload, so this never loops). None: the document frame.
    fn via_checkpoint(&self, wire: Wire, fields: bool) -> Option<(String, Version)> {
        let config = &self.shared.config;
        let from = self.checkpoint.object?;
        let version = self.engine.version();
        if !config.snapshot_url || from > version || version - from > config.snapshot_max_ops {
            return None;
        }
        // An id that needs no escaping in a path (files are uuids); any other keeps the document frame.
        if self.file.is_empty()
            || !self
                .file
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return None;
        }
        if matches!(
            self.tail.catch_up(wire.codec(), fields, from, version),
            CatchUp::Reload
        ) {
            return None;
        }
        Some((format!("/api/design-files/{}/checkpoint", self.file), from))
    }

    /// Sends the whole document, encoded off the actor; changes after it wait in the connection's hold.
    fn send_snapshot(&mut self, conn_id: ConnId) {
        let token = self.next_token;
        self.next_token += 1;
        let version = self.engine.version();
        let snapshot = self.engine.snapshot();
        let Some(conn) = self.conns.get_mut(&conn_id) else {
            return;
        };
        conn.waiting = Some(Waiting {
            token,
            held: Vec::new(),
            bytes: 0,
        });
        let wire = conn.wire;
        let ctl = self.ctl_tx.clone();
        tokio::task::spawn_blocking(move || {
            // A typed engine's next op would clone the document on the actor's thread while this task holds it
            // (20 000 layers: tens of milliseconds): make that copy here, first. A store's snapshot shares its
            // nodes and is converted here.
            if let Snapshot::Model(document) = &snapshot {
                let _ = ctl.send(Ctl::Spare {
                    version,
                    document: Box::new((**document).clone()),
                });
            }
            let document = snapshot.model();
            let frame = encode(wire, &ServerMsg::Document { version, document });
            let _ = ctl.send(Ctl::SnapshotReady {
                conn: conn_id,
                token,
                frame,
            });
        });
    }

    fn release_held(&mut self, conn_id: ConnId) {
        let Some(conn) = self.conns.get_mut(&conn_id) else {
            return;
        };
        let Some(waiting) = conn.waiting.take() else {
            return;
        };
        for held in waiting.held {
            match held {
                Held::Change(version, frame) => conn.outbox.push_change(version, &frame),
                Held::Control(frame) => conn.outbox.push(frame),
            }
        }
    }

    /// A connection whose hold outgrew its send queue is closed `slow`, as a full queue would be.
    fn check_holds(&mut self) {
        let cap = self.shared.config.send_queue_bytes;
        let over: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, c)| c.waiting.as_ref().is_some_and(|w| w.bytes > cap))
            .map(|(&id, _)| id)
            .collect();
        for id in over {
            metrics().slow_closed_total.inc();
            self.remove_conn(id, Some(ByeReason::Slow));
        }
    }

    // ── Presence, roles, the file ────────────────────────────────────────────────────────────────

    /// Presence goes out at once when the last flush is at least `presence_flush_ms` old, else that long after it:
    /// at most one frame per receiver per interval (TARGETS M10), and no wait for a cursor that moves after a
    /// pause (M11: a trailing window made every such update wait the whole interval).
    fn schedule_presence(&mut self) {
        if self.presence_due.is_some() {
            return;
        }
        let every = Duration::from_millis(self.shared.config.presence_flush_ms);
        match self.presence_flushed {
            Some(last) if tokio::time::Instant::now() < last + every => {
                self.presence_due = Some(last + every);
            }
            _ => self.flush_presence(),
        }
    }

    fn flush_presence(&mut self) {
        self.presence_due = None;
        self.presence_flushed = Some(tokio::time::Instant::now());
        let mut updates = std::mem::take(&mut self.presence_updates);
        self.presence_inbox.take(&mut updates);
        for (conn, update) in updates.drain(..) {
            self.presence.update(conn, update);
        }
        self.presence_updates = updates;
        self.presence.flush(
            self.conns
                .iter()
                .filter(|(_, c)| c.waiting.is_none())
                .map(|(&id, c)| (id, &c.outbox, c.wire)),
            &mut self.fanout,
        );
        self.fanout.release(self.writers.as_ref());
    }

    fn on_acl(&mut self, user: &str, role: Option<Role>) {
        let ids: Vec<ConnId> = self
            .conns
            .iter()
            .filter(|(_, c)| c.info.user == user)
            .map(|(&id, _)| id)
            .collect();
        for id in ids {
            match role {
                None => self.remove_conn(id, Some(ByeReason::Access)),
                Some(role) => {
                    let conn = self.conns.get_mut(&id).expect("listed");
                    if conn.info.role != role {
                        conn.info.role = role;
                        conn.outbox.push(encode(
                            conn.wire,
                            &ServerMsg::Access {
                                role,
                                can_edit: role.can_edit(),
                            },
                        ));
                        self.presence.set_role(id, role);
                        self.schedule_presence();
                    }
                }
            }
        }
    }

    fn on_replace(
        &mut self,
        document: DesignDocument,
        user: String,
        base_version: Option<Version>,
        reply: oneshot::Sender<Result<Version, ReplaceError>>,
    ) {
        let current = self.engine.version();
        if base_version.is_some_and(|base| base != current) {
            let _ = reply.send(Err(ReplaceError::Conflict(current)));
            return;
        }
        if self.stop.is_some() || self.replacing.is_some() {
            // Stopping, or another replace waits for its commit: api asks again.
            let _ = reply.send(Err(ReplaceError::Failed("busy".into())));
            return;
        }
        let version = current + 1;
        let prior = self.engine.snapshot();
        let document = Arc::new(document);
        self.engine.replace((*document).clone(), version);
        self.tail.clear();
        if let Some(committer) = &self.committer {
            let cost = self.engine.stats().approx_bytes + ROW_COST;
            self.uncommitted.push_back((version, cost));
            uncommitted_add(cost);
            let _ = committer.send((
                self.epoch,
                JournalEntry {
                    version,
                    user,
                    connection: None,
                    client: None,
                    seq: None,
                    body: EntryBody::Replace(document),
                },
            ));
        }
        // Answered after the commit (on_committed), or with the failure (on_commit_failed).
        self.replacing = Some(PendingReplace {
            version,
            prior,
            reply,
        });
        // Everyone reloads (`bye {replaced}` as the SSE stream says it today).
        let ids: Vec<ConnId> = self.conns.keys().copied().collect();
        for id in ids {
            self.remove_conn(id, Some(ByeReason::Replaced));
        }
    }

    /// A file-class event for every socket (or `only` that user's), in order with what each has queued.
    fn notice(&mut self, msg: &ServerMsg, only: Option<&str>) {
        let mut encoded = Encoded::new(msg);
        for conn in self.conns.values_mut() {
            if only.is_some_and(|user| user != conn.info.user) {
                continue;
            }
            let frame = encoded.get(conn.wire).clone();
            match &mut conn.waiting {
                Some(waiting) => waiting.held.push(Held::Control(frame)),
                None => conn.outbox.push(frame),
            }
        }
    }

    fn remove_conn(&mut self, id: ConnId, bye: Option<ByeReason>) {
        let Some(conn) = self.conns.remove(&id) else {
            return;
        };
        metrics().conn_open.add(-1);
        if let Some(reason) = bye {
            conn.outbox.close(reason);
        }
        if let Some(info) = self.presence.leave(id) {
            self.broadcast(
                &ServerMsg::Leave {
                    connection: info.connection,
                },
                None,
            );
        }
        if self.conns.is_empty() {
            self.idle_since = Some(Instant::now());
            self.maybe_checkpoint(true);
        }
    }

    fn close_all(&mut self, reason: ByeReason) {
        let ids: Vec<ConnId> = self.conns.keys().copied().collect();
        for id in ids {
            if let Some(conn) = self.conns.remove(&id) {
                metrics().conn_open.add(-1);
                // After what is queued: the acks drain_acks just sent go before the `bye`.
                conn.outbox.close_after_queued(reason);
            }
        }
    }

    /// A control frame to every connection (except one), in order with what each already has queued.
    fn broadcast(&mut self, msg: &ServerMsg, except: Option<ConnId>) {
        let mut encoded = Encoded::new(msg);
        for (&id, conn) in self.conns.iter_mut() {
            if Some(id) == except {
                continue;
            }
            let frame = encoded.get(conn.wire).clone();
            match &mut conn.waiting {
                Some(waiting) => waiting.held.push(Held::Control(frame)),
                None => conn.outbox.push(frame),
            }
        }
    }

    fn broadcast_held(&mut self, msg: &ServerMsg) {
        self.broadcast(msg, None);
    }

    // ── Timers ───────────────────────────────────────────────────────────────────────────────────

    fn renew_lease(&self, fence: u64) {
        let lease = Arc::clone(&self.shared.lease);
        let file = self.file.clone();
        let node = self.shared.config.node.clone();
        let ctl = self.ctl_tx.clone();
        tokio::spawn(async move {
            // An unreachable lease store keeps the lease until it expires; only a definite "no" stops the actor.
            let ok = lease.renew(&file, &node, fence).await.unwrap_or(true);
            let _ = ctl.send(Ctl::Lease { ok });
        });
    }

    fn revalidate(&self) {
        let Some(source) = self.shared.acl.clone() else {
            return;
        };
        let mut users: Vec<String> = self.conns.values().map(|c| c.info.user.clone()).collect();
        users.sort();
        users.dedup();
        if users.is_empty() {
            return;
        }
        let file = self.file.clone();
        let ctl = self.ctl_tx.clone();
        tokio::spawn(async move {
            for user in users {
                match source.role(&file, &user).await {
                    Ok(role) => {
                        let _ = ctl.send(Ctl::Revalidated { user, role });
                    }
                    Err(error) => tracing::debug!(file, user, error, "acl re-validation failed"),
                }
            }
        });
    }
}

/// The nodes an op replaced that existed before it (the ones a change can carry as fields).
fn existing_nodes(undo: &DocumentPatch) -> usize {
    undo.nodes.as_ref().map_or(0, |nodes| {
        nodes.values().filter(|node| node.is_some()).count()
    })
}

fn refused(seq: Seq, refusal: Refusal) -> ServerMsg {
    ServerMsg::Refused {
        seq,
        code: refusal.code,
        current_version: refusal.current_version,
        path: refusal.path,
        node_id: refusal.node_id,
        message: Some(refusal.message),
    }
}
