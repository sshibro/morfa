//! Draining a node for a deploy (docs/BACKEND.md §10; lane B5): `SIGTERM` → stop taking files → checkpoint every
//! open document → `bye {shutdown}` → exit, inside the unit's 30 s stop timeout (deploy/systemd/morfa-collab@.service).
//!
//! 1. [`App::drain`] marks the node draining: `/healthz` answers 503 `{"draining": true}` at once, so api stops sending
//!    idle files here (server/design/collab/leases.ts marks a draining node unhealthy on that answer and leaves its
//!    leases alone: this node gives them back itself).
//! 2. After `notice` (api checks health every 2 s) every actor gets `ActorMsg::Drain`: it refuses new joins, waits
//!    until its journal holds every applied op, writes a checkpoint of that version, closes its sockets with
//!    `bye {shutdown}` after what is already queued (the acks), and stops; its committer stores whatever is left and
//!    releases the lease (crate::actor::drain).
//! 3. A socket for a file this node does not hold is refused with `bye {shutdown}` ([`refuse_new_file`]); a lease api
//!    took for this node in the meantime is released at once, so the client's next `/session` names another node.
//! 4. An actor still open at the deadline is stopped (`bye {shutdown}` at once). Nothing acked is lost that way either:
//!    an ack is sent only after its op is journaled, and the next owner replays the journal tail above the last
//!    checkpoint (it just has more of it to replay).
//! 5. Ops that reach a draining actor are not applied (the clients re-send them to the next owner), so even a busy
//!    file's journal catches up; the drain then waits up to 1.5 s for the sockets' writers to send their last frames.

use crate::actor::ActorMsg;
use crate::router::App;
use morfa_protocol::ByeReason;
use parking_lot::Mutex;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::time::{Duration, Instant};

/// One socket's writer, counted while it runs (conn.rs): the drain waits for the writers to send their last frames
/// (acks, `bye`) before the process exits.
pub struct SocketGuard(Arc<DrainState>);

impl Drop for SocketGuard {
    fn drop(&mut self) {
        self.0.sockets.fetch_sub(1, Ordering::AcqRel);
    }
}

/// How long the drain waits for the sockets' writers to send their last frames (acks, `bye`).
const FLUSH_WAIT: Duration = Duration::from_millis(1500);

/// How long `/healthz` says "draining" before the actors start closing: one api health interval (2 s) and a margin.
pub const DRAIN_NOTICE: Duration = Duration::from_millis(2500);
/// The whole drain, notice included; the unit's `TimeoutStopSec=30` kills the process after 30 s.
pub const DRAIN_DEADLINE: Duration = Duration::from_secs(25);

/// Whether this node is draining, shared by the HTTP surface and the sockets.
#[derive(Default)]
pub struct DrainState {
    draining: AtomicBool,
    started: Mutex<Option<Instant>>,
    /// Socket writers still running.
    sockets: AtomicI64,
}

impl DrainState {
    /// Counts a socket's writer until the guard drops.
    pub fn socket(self: &Arc<Self>) -> SocketGuard {
        self.sockets.fetch_add(1, Ordering::AcqRel);
        SocketGuard(Arc::clone(self))
    }

    /// Socket writers still running (they may hold frames).
    pub fn sockets_open(&self) -> i64 {
        self.sockets.load(Ordering::Acquire)
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::Acquire)
    }

    /// Marks the node draining; false when it already was.
    fn begin(&self) -> bool {
        let first = !self.draining.swap(true, Ordering::AcqRel);
        if first {
            *self.started.lock() = Some(Instant::now());
            crate::observe::observe().draining.set(1);
        }
        first
    }

    /// Since when the node drains.
    pub fn since(&self) -> Option<Instant> {
        *self.started.lock()
    }
}

/// The two timings of a drain (env `MORFA_COLLAB_DRAIN_NOTICE_MS`, `MORFA_COLLAB_DRAIN_TIMEOUT_MS` in main.rs).
#[derive(Clone, Copy, Debug)]
pub struct DrainConfig {
    /// `/healthz` says "draining" this long before the actors start closing.
    pub notice: Duration,
    /// The whole drain; actors still open then are stopped at once.
    pub deadline: Duration,
}

impl Default for DrainConfig {
    fn default() -> Self {
        DrainConfig {
            notice: DRAIN_NOTICE,
            deadline: DRAIN_DEADLINE,
        }
    }
}

/// What a drain did (logged by main.rs, asserted by tests/drain.rs).
#[derive(Clone, Copy, Debug, Default)]
pub struct DrainReport {
    /// Files open when the actors were told to drain.
    pub files: usize,
    /// Files whose actor had not finished by the deadline and was stopped.
    pub forced: usize,
    /// Files still open after the forced stop (their actors never answered).
    pub left: usize,
    /// Sockets whose writers had not finished when the drain returned.
    pub sockets_left: i64,
    pub elapsed: Duration,
}

impl App {
    /// Whether the node is draining (a deploy or a stop is under way).
    pub fn draining(&self) -> bool {
        self.drain.is_draining()
    }

    /// Drains the node (see the module): returns once every actor stopped, or at `config.deadline`.
    pub async fn drain(&self, config: DrainConfig) -> DrainReport {
        let started = Instant::now();
        if !self.drain.begin() {
            tracing::info!("drain already under way");
        }
        tracing::info!(
            notice_ms = config.notice.as_millis() as u64,
            "draining: /healthz answers 503, new files are refused"
        );
        let deadline = started + config.deadline;
        tokio::time::sleep(config.notice.min(config.deadline)).await;
        let files = self.docs.len();
        tracing::info!(files, "draining: checkpointing every open file");
        // `Drain` is idempotent: it is sent again every half second, so an actor whose inbox was full, or one that started
        // in the meantime, still gets it. try_send never makes the drain wait on an inbox.
        let mut told: Option<Instant> = None;
        while !self.docs.is_empty() && Instant::now() < deadline {
            if told.is_none_or(|at| at.elapsed() >= Duration::from_millis(500)) {
                for actor in self.docs.all() {
                    let _ = actor.try_send(ActorMsg::Drain);
                }
                told = Some(Instant::now());
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let forced = self.docs.len();
        if forced > 0 {
            tracing::warn!(
                forced,
                "drain deadline: stopping the files still open (their journal holds every acked op)"
            );
            let grace = Instant::now() + Duration::from_secs(2);
            while !self.docs.is_empty() && Instant::now() < grace {
                for actor in self.docs.all() {
                    let _ = actor.try_send(ActorMsg::Shutdown {
                        reason: ByeReason::Shutdown,
                    });
                }
                tokio::time::sleep(Duration::from_millis(50)).await;
            }
        }
        // The last acks and `bye` frames leave the writers before the runtime goes away.
        let flush = Instant::now() + FLUSH_WAIT;
        while self.drain.sockets_open() > 0 && Instant::now() < flush {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        let report = DrainReport {
            files,
            forced,
            left: self.docs.len(),
            sockets_left: self.drain.sockets_open(),
            elapsed: started.elapsed(),
        };
        crate::observe::observe()
            .drain_seconds
            .set_secs(report.elapsed);
        tracing::info!(
            files = report.files,
            forced = report.forced,
            left = report.left,
            elapsed_ms = report.elapsed.as_millis() as u64,
            "drained"
        );
        report
    }
}

/// While draining, a socket for a file this node does not hold is refused (the caller sends `bye {shutdown}`). api
/// may have taken the file's lease for this node just before it saw the drain: that lease is given back, so the
/// client's next `/session` takes it for another node instead of waiting for it to run out (15 s).
pub async fn refuse_new_file(app: &App, file: &str) -> bool {
    // A live actor of the file takes the join (it refuses it itself once told to drain); a stopped one does not count.
    if !app.draining() || app.docs.get(file).is_some_and(|actor| !actor.is_closed()) {
        return false;
    }
    let (lease, node) = (&app.shared.lease, &app.shared.config.node);
    // `acquire` confirms a lease this node holds (B2: the holder may take it again) and answers its fence; a lease
    // another node holds is left alone.
    if let Ok(fence) = lease.acquire(file, node).await {
        lease.release(file, node, fence).await;
    }
    true
}
