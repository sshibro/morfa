//! Presence of one file (docs/BACKEND.md §2 "Presence", docs/design-tool.md "Presence"): ephemeral, never
//! journaled, dropped first under backpressure. Updates mark a peer dirty; the actor flushes at most every
//! `PRESENCE_FLUSH_MS`, so each receiver gets at most one frame per peer per 33 ms (≤ 30 Hz), and never its own.
//!
//! Each dirty peer is encoded once per flush; a receiver's frame is a copy of those bytes. Receivers that are
//! not dirty themselves all get the same frame (built once); a dirty receiver gets the others without itself.

use crate::backpressure::{Fanout, Out, Outbox};
use crate::metrics::metrics;
use bytes::Bytes;
use morfa_protocol::codec::JsonCodec;
use morfa_protocol::{Peer, PeerInfo, Presence, PresenceUpdate, Wire};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::sync::Arc;

pub type ConnId = u64;

/// Presence updates on their way from the sockets' readers to the actor, without an actor message each: the
/// first update after a flush tells the actor (`ActorMsg::PresenceDue`), the flush takes them all. At 30 Hz per
/// cursor this wakes the actor once per flush instead of once per update (TARGETS M10).
#[derive(Default)]
pub struct PresenceInbox {
    state: Mutex<InboxState>,
}

#[derive(Default)]
struct InboxState {
    updates: Vec<(ConnId, PresenceUpdate)>,
    /// The actor was told and has not taken the updates yet.
    armed: bool,
}

impl PresenceInbox {
    /// Queues an update; true when the actor must be told.
    pub fn push(&self, conn: ConnId, update: PresenceUpdate) -> bool {
        let mut state = self.state.lock();
        state.updates.push((conn, update));
        !std::mem::replace(&mut state.armed, true)
    }

    /// Swaps the queued updates into `out` (empty, its buffer reused); the next push tells the actor again.
    pub fn take(&self, out: &mut Vec<(ConnId, PresenceUpdate)>) {
        let mut state = self.state.lock();
        std::mem::swap(&mut state.updates, out);
        state.armed = false;
    }
}

struct Slot {
    info: PeerInfo,
    presence: Presence,
    dirty: bool,
    /// The JSON text of `info` (`JsonCodec::peer_identity`), made at the first flush that needs it.
    json_identity: Option<Bytes>,
}

impl Slot {
    /// This peer as `wire` writes it.
    fn encode(&mut self, wire: Wire) -> Bytes {
        match wire {
            Wire::Json => {
                let info = &self.info;
                let identity = self
                    .json_identity
                    .get_or_insert_with(|| JsonCodec::peer_identity(info));
                JsonCodec::peer_with(identity, &self.presence)
            }
            _ => wire.codec().encode_peer(&PresenceHub::peer(self)),
        }
    }
}

#[derive(Default)]
pub struct PresenceHub {
    slots: HashMap<ConnId, Slot>,
    dirty: Vec<ConnId>,
}

impl PresenceHub {
    pub fn join(&mut self, conn: ConnId, info: PeerInfo) {
        self.slots.insert(
            conn,
            Slot {
                info,
                presence: Presence::default(),
                dirty: true,
                json_identity: None,
            },
        );
        self.dirty.push(conn);
    }

    /// False when nothing changed.
    pub fn update(&mut self, conn: ConnId, update: PresenceUpdate) -> bool {
        let Some(slot) = self.slots.get_mut(&conn) else {
            return false;
        };
        if !update.apply_to(&mut slot.presence) {
            return false;
        }
        if !slot.dirty {
            slot.dirty = true;
            self.dirty.push(conn);
        }
        true
    }

    /// A peer's role changed: the others see it in the next flush.
    pub fn set_role(&mut self, conn: ConnId, role: morfa_protocol::Role) {
        if let Some(slot) = self.slots.get_mut(&conn)
            && slot.info.role != role
        {
            slot.info.role = role;
            slot.json_identity = None;
            if !slot.dirty {
                slot.dirty = true;
                self.dirty.push(conn);
            }
        }
    }

    pub fn leave(&mut self, conn: ConnId) -> Option<PeerInfo> {
        let slot = self.slots.remove(&conn)?;
        if slot.dirty {
            self.dirty.retain(|&c| c != conn);
        }
        Some(slot.info)
    }

    pub fn is_dirty(&self) -> bool {
        !self.dirty.is_empty()
    }

    fn peer(slot: &Slot) -> Peer {
        Peer {
            connection: slot.info.connection.clone(),
            user: slot.info.user.clone(),
            name: slot.info.name.clone(),
            color: slot.info.color,
            role: slot.info.role,
            presence: slot.presence.clone(),
        }
    }

    /// Everyone but `except`, for `welcome`.
    pub fn roster(&self, except: ConnId) -> Vec<Peer> {
        let mut peers: Vec<(ConnId, Peer)> = self
            .slots
            .iter()
            .filter(|(id, _)| **id != except)
            .map(|(id, slot)| (*id, Self::peer(slot)))
            .collect();
        peers.sort_by_key(|(id, _)| *id);
        peers.into_iter().map(|(_, peer)| peer).collect()
    }

    /// Sends the dirty peers to every receiver (except each to itself) and clears the dirty set. Peers are
    /// encoded once per wire the receivers speak.
    pub fn flush<'a>(
        &mut self,
        receivers: impl Iterator<Item = (ConnId, &'a Arc<Outbox>, Wire)>,
        fanout: &mut Fanout,
    ) {
        if self.dirty.is_empty() {
            return;
        }
        let started = std::time::Instant::now();
        let mut dirty = std::mem::take(&mut self.dirty);
        dirty.retain(|id| match self.slots.get_mut(id) {
            Some(slot) => {
                slot.dirty = false;
                true
            }
            None => false,
        });
        // Per wire: each peer's bytes, and the frame of all of them (built when a receiver needs it).
        struct ForWire {
            encoded: Vec<(ConnId, Bytes)>,
            shared: Option<Out>,
        }
        let mut wires: [Option<ForWire>; 2] = [None, None];
        for (receiver, outbox, wire) in receivers {
            let codec = wire.codec();
            let slot = &mut wires[usize::from(wire == Wire::Binary)];
            let slots = &mut self.slots;
            let for_wire = slot.get_or_insert_with(|| ForWire {
                encoded: dirty
                    .iter()
                    .map(|id| (*id, slots.get_mut(id).expect("kept above").encode(wire)))
                    .collect(),
                shared: None,
            });
            let encoded = &for_wire.encoded;
            let own = encoded.iter().any(|(id, _)| *id == receiver);
            let frame = if own {
                if encoded.len() == 1 {
                    continue;
                }
                Out::from(
                    codec.presence_frame(
                        &mut encoded
                            .iter()
                            .filter(|(id, _)| *id != receiver)
                            .map(|(_, bytes)| bytes),
                    ),
                )
            } else {
                for_wire
                    .shared
                    .get_or_insert_with(|| {
                        Out::from(codec.presence_frame(&mut encoded.iter().map(|(_, bytes)| bytes)))
                    })
                    .clone()
            };
            if outbox.push_presence_held(frame) {
                fanout.hold(outbox);
                metrics().presence_frames_total.inc();
            }
        }
        metrics().presence_flush.record(started.elapsed());
    }
}
