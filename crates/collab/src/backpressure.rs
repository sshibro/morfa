//! A connection's bounded send queue (docs/BACKEND.md §2 "Backpressure"). The actor pushes and never waits; the
//! connection's writer task drains it into the socket. By the bytes waiting:
//! - over half: presence frames are dropped (the next flush carries the newer presence anyway);
//! - over three quarters: `change` frames stop being queued; the versions skipped are remembered and, once the
//!   queue has drained, sent as one `catchUp {from, to}` the client pulls when ready;
//! - over all of it: the connection is closed with `bye {slow}` and the client reconnects with `since`.
//!
//! A slow reader therefore costs the actor one lock and a comparison per frame, never a wait (TARGETS M12).
//!
//! When the queue is empty and the writer idle, a frame is written straight into the socket by whoever pushes it
//! (non-blocking, within [`DirectWrites`]); whatever the socket does not take is queued as usual.

use crate::metrics::metrics;
use crate::ws::{self, Wrote};
use bytes::Bytes;
use morfa_protocol::codec::FrameKind;
use morfa_protocol::{ByeReason, Frame, Version};
use parking_lot::Mutex;
use std::cell::Cell;
use std::collections::VecDeque;
use std::sync::Arc;
use tokio::sync::Notify;

/// A WebSocket message as the socket sends it: an opcode and the payload (shared by every receiver of a fan-out).
#[derive(Debug, Clone, PartialEq)]
pub struct Out {
    pub opcode: u8,
    pub bytes: Bytes,
}

impl Out {
    pub fn len(&self) -> usize {
        self.bytes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.bytes.is_empty()
    }

    /// The close frame: `code` and a short reason.
    pub fn close(code: u16, reason: &str) -> Self {
        let mut payload = Vec::with_capacity(2 + reason.len());
        payload.extend_from_slice(&code.to_be_bytes());
        payload.extend_from_slice(reason.as_bytes());
        Out {
            opcode: ws::OP_CLOSE,
            bytes: payload.into(),
        }
    }

    /// A WebSocket ping (empty payload): the server's liveness probe.
    pub fn ping() -> Self {
        Out {
            opcode: ws::OP_PING,
            bytes: Bytes::new(),
        }
    }

    pub fn pong(payload: Bytes) -> Self {
        Out {
            opcode: ws::OP_PONG,
            bytes: payload,
        }
    }

    /// Header and payload as the socket writes them.
    pub fn framed(&self) -> [Bytes; 2] {
        let (head, n) = ws::header(self.opcode, self.bytes.len());
        [Bytes::copy_from_slice(&head[..n]), self.bytes.clone()]
    }
}

impl From<Frame> for Out {
    fn from(frame: Frame) -> Self {
        Out {
            opcode: match frame.kind {
                FrameKind::Text => ws::OP_TEXT,
                FrameKind::Binary => ws::OP_BINARY,
            },
            bytes: frame.bytes,
        }
    }
}

thread_local! {
    static DIRECT: Cell<u32> = const { Cell::new(0) };
}

/// While alive, pushes on this thread may write up to `n` frames straight into idle sockets (the actor sets it
/// per message it handles). Beyond it frames are queued for the connections' writer tasks, so a fan-out to 500
/// receivers spreads its writes over the runtime's threads instead of running them all on the actor's.
pub struct DirectWrites(());

impl DirectWrites {
    pub fn allow(n: u32) -> Self {
        DIRECT.with(|d| d.set(n));
        DirectWrites(())
    }
}

impl Drop for DirectWrites {
    fn drop(&mut self) {
        DIRECT.with(|d| d.set(0));
    }
}

fn take_direct() -> bool {
    DIRECT.with(|d| {
        let n = d.get();
        if n > 0 {
            d.set(n - 1);
        }
        n > 0
    })
}

/// Up to this many held outboxes are released by the actor itself (within its [`DirectWrites`]).
const RELEASE_INLINE: usize = 32;
/// Larger fan-outs are released by tasks of the writers' runtime, this many outboxes each.
const RELEASE_CHUNK: usize = 64;

/// The outboxes a fan-out queued frames into without sending them ([`Outbox::push_change_held`],
/// [`Outbox::push_presence_held`]). A small fan-out is released on the actor's thread; a large one by a few tasks
/// on the writers' runtime, each writing its share straight into idle sockets: a handful of task wakes per
/// fan-out instead of one per receiver (TARGETS M4: 500 receivers of one file).
#[derive(Default)]
pub struct Fanout {
    held: Vec<Arc<Outbox>>,
}

impl Fanout {
    pub fn hold(&mut self, outbox: &Arc<Outbox>) {
        self.held.push(Arc::clone(outbox));
    }

    pub fn len(&self) -> usize {
        self.held.len()
    }

    pub fn is_empty(&self) -> bool {
        self.held.is_empty()
    }

    /// Sends every held frame (`writers`: the connections' writers' runtime; None: here).
    pub fn release(&mut self, writers: Option<&tokio::runtime::Handle>) {
        match writers {
            Some(writers) if self.held.len() > RELEASE_INLINE => {
                while !self.held.is_empty() {
                    let at = self.held.len().saturating_sub(RELEASE_CHUNK);
                    let chunk = self.held.split_off(at);
                    writers.spawn(async move {
                        let _direct = DirectWrites::allow(u32::MAX);
                        for outbox in chunk {
                            outbox.release();
                        }
                    });
                }
            }
            _ => {
                for outbox in self.held.drain(..) {
                    outbox.release();
                }
            }
        }
    }
}

/// What the writer sends next.
#[derive(Debug, Clone, PartialEq)]
pub enum Next {
    Frame(Out),
    /// The rest of a frame a direct write left half-sent (framed bytes).
    Raw(Bytes),
    /// The client missed changes `from..=to`: tell it to pull.
    CatchUp {
        from: Version,
        to: Version,
    },
    /// Send `bye {reason}` and close.
    Bye(ByeReason),
}

#[derive(Debug)]
enum Item {
    Frame(Out),
    Raw(Bytes),
}

impl Item {
    fn len(&self) -> usize {
        match self {
            Item::Frame(out) => out.len(),
            Item::Raw(bytes) => bytes.len(),
        }
    }
}

#[derive(Default)]
struct State {
    queue: VecDeque<Item>,
    bytes: usize,
    lag: Option<(Version, Version)>,
    closing: Option<ByeReason>,
    /// Closing after what is queued (an error frame before `bye`).
    drain: bool,
    /// The writer holds frames it has not finished writing: nothing may overtake them.
    writing: bool,
}

pub struct Outbox {
    state: Mutex<State>,
    notify: Notify,
    cap: usize,
    socket: Option<Arc<ws::Writer>>,
}

impl Outbox {
    /// A queue without a socket of its own (tests): every frame waits for [`Outbox::next`].
    pub fn new(cap: usize) -> Self {
        Outbox {
            state: Mutex::new(State::default()),
            notify: Notify::new(),
            cap,
            socket: None,
        }
    }

    /// A queue that may write straight into `socket` when it is idle.
    pub fn with_socket(cap: usize, socket: Arc<ws::Writer>) -> Self {
        Outbox {
            state: Mutex::new(State::default()),
            notify: Notify::new(),
            cap,
            socket: Some(socket),
        }
    }

    pub fn capacity(&self) -> usize {
        self.cap
    }

    pub fn queued_bytes(&self) -> usize {
        self.state.lock().bytes
    }

    pub fn is_closing(&self) -> bool {
        self.state.lock().closing.is_some()
    }

    /// Writes `frame` now when nothing waits before it and the socket takes it; false: queue it.
    fn try_direct(&self, state: &mut State, frame: &Out) -> bool {
        let Some(socket) = &self.socket else {
            return false;
        };
        if !state.queue.is_empty() || state.writing || state.lag.is_some() || !take_direct() {
            return false;
        }
        match socket.try_frame(frame.opcode, &frame.bytes) {
            Ok(Wrote::All) => {
                metrics().bytes_out_total.add(frame.len() as u64);
                true
            }
            Ok(Wrote::Part(sent)) => {
                // The socket is full: the rest goes first when the writer finds room.
                let [head, payload] = frame.framed();
                let mut rest = Vec::with_capacity(head.len() + payload.len() - sent);
                if sent < head.len() {
                    rest.extend_from_slice(&head[sent..]);
                    rest.extend_from_slice(&payload);
                } else {
                    rest.extend_from_slice(&payload[sent - head.len()..]);
                }
                metrics().bytes_out_total.add(frame.len() as u64);
                state.bytes += rest.len();
                metrics().send_queue_bytes.add(rest.len() as i64);
                state.queue.push_back(Item::Raw(rest.into()));
                self.notify.notify_one();
                true
            }
            // The writer meets the same error and ends the connection.
            Err(_) => false,
        }
    }

    fn enqueue(&self, state: &mut State, frame: Out) {
        if self.try_direct(state, &frame) {
            return;
        }
        state.bytes += frame.len();
        metrics().send_queue_bytes.add(frame.len() as i64);
        state.queue.push_back(Item::Frame(frame));
        self.notify.notify_one();
    }

    /// A presence frame; false when it was dropped.
    pub fn push_presence(&self, frame: Out) -> bool {
        let mut state = self.state.lock();
        if state.closing.is_some() || state.bytes + frame.len() > self.cap / 2 {
            metrics().presence_dropped_total.inc();
            return false;
        }
        self.enqueue(&mut state, frame);
        true
    }

    /// A `change` of `version`; replaced by a catch-up notice while the queue is over three quarters.
    pub fn push_change(&self, version: Version, frame: &Out) {
        let mut state = self.state.lock();
        if state.closing.is_some() {
            return;
        }
        if let Some((_, to)) = &mut state.lag {
            *to = version;
            return;
        }
        if state.bytes + frame.len() > self.cap * 3 / 4 {
            state.lag = Some((version, version));
            metrics().catchup_notices_total.inc();
            return;
        }
        self.enqueue(&mut state, frame.clone());
    }

    /// [`Outbox::push_presence`] without sending, as [`Outbox::push_change_held`].
    pub fn push_presence_held(&self, frame: Out) -> bool {
        let mut state = self.state.lock();
        if state.closing.is_some() || state.bytes + frame.len() > self.cap / 2 {
            metrics().presence_dropped_total.inc();
            return false;
        }
        state.bytes += frame.len();
        metrics().send_queue_bytes.add(frame.len() as i64);
        state.queue.push_back(Item::Frame(frame));
        true
    }

    /// [`Outbox::push_change`] without sending: the frame is queued, the socket untouched and the writer not
    /// woken. True when it was queued: the caller then calls [`Outbox::release`]. A fan-out queues its change for
    /// every peer first and only then writes (TARGETS M1 ends when every peer has it queued).
    pub fn push_change_held(&self, version: Version, frame: &Out) -> bool {
        let mut state = self.state.lock();
        if state.closing.is_some() {
            return false;
        }
        if let Some((_, to)) = &mut state.lag {
            *to = version;
            return false;
        }
        if state.bytes + frame.len() > self.cap * 3 / 4 {
            state.lag = Some((version, version));
            metrics().catchup_notices_total.inc();
            return false;
        }
        state.bytes += frame.len();
        metrics().send_queue_bytes.add(frame.len() as i64);
        state.queue.push_back(Item::Frame(frame.clone()));
        true
    }

    /// Sends what [`Outbox::push_change_held`] queued: straight into the socket when it is the only frame
    /// waiting and the writer is idle (within [`DirectWrites`]), else by the writer.
    pub fn release(&self) {
        let mut state = self.state.lock();
        if state.queue.len() == 1 && !state.writing && state.lag.is_none() {
            let Some(Item::Frame(frame)) = state.queue.pop_front() else {
                unreachable!("one frame queued");
            };
            state.bytes -= frame.len();
            metrics().send_queue_bytes.add(-(frame.len() as i64));
            if self.try_direct(&mut state, &frame) {
                return;
            }
            state.bytes += frame.len();
            metrics().send_queue_bytes.add(frame.len() as i64);
            state.queue.push_front(Item::Frame(frame));
        }
        drop(state);
        self.notify.notify_one();
    }

    /// Any other frame (welcome, ack, refused, control, a pulled batch). Over the cap the connection closes
    /// `slow`; a single frame larger than the cap still goes when nothing else waits (a whole document).
    pub fn push(&self, frame: impl Into<Out>) {
        let frame = frame.into();
        let mut state = self.state.lock();
        if state.closing.is_some() {
            return;
        }
        if state.bytes > 0 && state.bytes + frame.len() > self.cap {
            drop(state);
            metrics().slow_closed_total.inc();
            self.close(ByeReason::Slow);
            return;
        }
        self.enqueue(&mut state, frame);
    }

    /// A frame that must go whatever the queue holds (a catch-up bounded by TARGETS M9, a snapshot).
    pub fn push_force(&self, frame: impl Into<Out>) {
        let frame = frame.into();
        let mut state = self.state.lock();
        if state.closing.is_none() {
            self.enqueue(&mut state, frame);
        }
    }

    /// Closes with `bye {reason}`: frames still queued are dropped (a closing reader gets nothing more).
    pub fn close(&self, reason: ByeReason) {
        let mut state = self.state.lock();
        if state.closing.is_none() || state.drain {
            state.closing.get_or_insert(reason);
            state.drain = false;
            metrics().send_queue_bytes.add(-(state.bytes as i64));
            state.bytes = 0;
            // A half-sent frame must still finish, or the stream breaks mid-frame.
            state.queue.retain(|item| matches!(item, Item::Raw(_)));
            state.bytes = state.queue.iter().map(Item::len).sum();
            metrics().send_queue_bytes.add(state.bytes as i64);
        }
        drop(state);
        self.notify.notify_one();
    }

    /// Closes with `bye {reason}` after the frames already queued.
    pub fn close_after_queued(&self, reason: ByeReason) {
        let mut state = self.state.lock();
        if state.closing.is_none() {
            state.closing = Some(reason);
            state.drain = true;
        }
        drop(state);
        self.notify.notify_one();
    }

    fn pop(state: &mut State) -> Option<Next> {
        if let Some(Item::Raw(_)) = state.queue.front() {
            // Finishing a half-sent frame comes before anything, a close included.
        } else if let Some(reason) = state.closing
            && (!state.drain || state.queue.is_empty())
        {
            return Some(Next::Bye(reason));
        }
        if let Some(item) = state.queue.pop_front() {
            state.bytes -= item.len();
            metrics().send_queue_bytes.add(-(item.len() as i64));
            state.writing = true;
            return Some(match item {
                Item::Frame(out) => Next::Frame(out),
                Item::Raw(bytes) => Next::Raw(bytes),
            });
        }
        let lag = state.lag.take()?;
        state.writing = true;
        Some(Next::CatchUp {
            from: lag.0,
            to: lag.1,
        })
    }

    /// The writer's next item; waits while nothing is queued. Only one writer may call it, and it calls
    /// [`Outbox::written`] once what it took is in the socket.
    pub async fn next(&self) -> Next {
        loop {
            if let Some(next) = Self::pop(&mut self.state.lock()) {
                return next;
            }
            self.notify.notified().await;
        }
    }

    /// Like [`Outbox::next`] without waiting (tests, and the writer batching frames into one write).
    pub fn try_next(&self) -> Option<Next> {
        Self::pop(&mut self.state.lock())
    }

    /// The writer wrote everything it took: frames may go straight to the socket again while the queue is empty.
    pub fn written(&self) {
        let mut state = self.state.lock();
        if state.queue.is_empty() {
            state.writing = false;
        }
    }
}

impl Drop for Outbox {
    fn drop(&mut self) {
        let bytes = self.state.get_mut().bytes;
        metrics().send_queue_bytes.add(-(bytes as i64));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    fn frame(n: usize) -> Out {
        Frame {
            kind: FrameKind::Text,
            bytes: Bytes::from(vec![b'x'; n]),
        }
        .into()
    }

    #[test]
    fn presence_then_changes_then_close() {
        let outbox = Outbox::new(1000);
        assert!(outbox.push_presence(frame(400)));
        // 400 + 200 > 500: presence dropped.
        assert!(!outbox.push_presence(frame(200)));
        outbox.push_change(1, &frame(300)); // 700 ≤ 750
        outbox.push_change(2, &frame(100)); // 800 > 750: lagging from 2
        outbox.push_change(3, &frame(10)); // lagging to 3
        assert_eq!(outbox.queued_bytes(), 700);
        assert!(matches!(outbox.try_next(), Some(Next::Frame(f)) if f.len() == 400));
        assert!(matches!(outbox.try_next(), Some(Next::Frame(f)) if f.len() == 300));
        assert_eq!(outbox.try_next(), Some(Next::CatchUp { from: 2, to: 3 }));
        assert_eq!(outbox.try_next(), None);
        // A control frame over the cap with others waiting: slow.
        outbox.push(frame(600));
        outbox.push(frame(600));
        assert_eq!(outbox.try_next(), Some(Next::Bye(ByeReason::Slow)));
        // A single frame larger than the cap goes when the queue is empty.
        let big = Outbox::new(1000);
        big.push(frame(5000));
        assert!(matches!(big.try_next(), Some(Next::Frame(f)) if f.len() == 5000));
    }

    #[test]
    fn held_changes_wait_for_release() {
        let outbox = Outbox::new(1000);
        assert!(outbox.push_change_held(1, &frame(300)));
        assert_eq!(outbox.queued_bytes(), 300);
        // Over three quarters: a catch-up notice instead, nothing to release.
        assert!(!outbox.push_change_held(2, &frame(500)));
        assert!(!outbox.push_change_held(3, &frame(10)));
        // No socket: release leaves the frame to the writer.
        outbox.release();
        assert!(matches!(outbox.try_next(), Some(Next::Frame(f)) if f.len() == 300));
        assert_eq!(outbox.try_next(), Some(Next::CatchUp { from: 2, to: 3 }));
        outbox.close(ByeReason::Session);
        assert!(!outbox.push_change_held(4, &frame(10)));
    }
}
