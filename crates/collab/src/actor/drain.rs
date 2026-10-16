//! The actor's part of a node drain (crate::drain; lane B5): once every applied op is journaled, write a checkpoint
//! of that version, then close every socket with `bye {shutdown}` after what is already queued, and stop. The
//! committer then stores what is left and releases the lease (`spawn`), so the next owner loads the checkpoint plus
//! at most the few ops that arrived while it was written.

use super::{DocActor, JoinRequest};
use crate::metrics::metrics;
use morfa_protocol::ByeReason;
use std::time::Instant;

/// A drain under way in one actor.
pub(super) struct Drain {
    since: Instant,
    /// The drain's checkpoint was started (it is written once, whatever its outcome).
    checkpoint_started: bool,
}

/// A join that reaches a draining actor: the client asks `/session` again and goes to another node.
pub(super) fn refuse_join(join: JoinRequest) {
    let _ = join.reply.send(Err(ByeReason::Shutdown));
}

/// An op that reaches a draining actor is not applied: the document stops moving so its journal catches up and the
/// checkpoint can be written, however busy the file is. The op stays unacked at its client, which re-sends it with the
/// same `seq` to the file's next owner after the `bye` (BACKEND §2 "Reconnect and catch-up").
pub(super) fn defer_op() {
    crate::observe::observe().drain_deferred_ops_total.inc();
}

impl DocActor {
    /// `ActorMsg::Drain`.
    pub(super) fn begin_drain(&mut self) {
        if self.drain.is_none() {
            self.drain = Some(Drain {
                since: Instant::now(),
                checkpoint_started: false,
            });
        }
        self.drain_step();
    }

    /// Moves a drain on; called after every message of the actor's loop (a commit or a checkpoint that ends is
    /// what it waits for). Does nothing when the actor is not draining.
    pub(super) fn drain_step(&mut self) {
        let Some(drain) = &self.drain else { return };
        if self.stop.is_some() || self.checkpoint.writing {
            return;
        }
        let version = self.engine.version();
        if version != self.committed {
            // The commit's end comes back through the loop.
            return;
        }
        if !drain.checkpoint_started && version > self.checkpoint.version {
            if let Some(drain) = &mut self.drain {
                drain.checkpoint_started = true;
            }
            // `leaving`: the checkpoint is written whatever the cadence says (TARGETS S4's "last disconnect").
            self.maybe_checkpoint(true);
            if self.checkpoint.writing {
                return;
            }
        }
        // Journaled and checkpointed (or the checkpoint failed: the journal still holds every op above the last one).
        let since = self.drain.as_ref().map_or_else(Instant::now, |d| d.since);
        tracing::debug!(
            file = self.file,
            version,
            checkpoint = self.checkpoint.version,
            conns = self.conns.len(),
            elapsed_ms = since.elapsed().as_millis() as u64,
            "drained"
        );
        for (_, conn) in self.conns.drain() {
            metrics().conn_open.add(-1);
            conn.outbox.close_after_queued(ByeReason::Shutdown);
        }
        self.stop = Some(ByeReason::Shutdown);
    }
}
