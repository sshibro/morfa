//! Reconnect and catch-up (docs/BACKEND.md §2): the actor keeps the last changes in memory (the tail, at most
//! 20 000 ops or 8 MB), each with its `change` frame already encoded, so a catch-up from the tail is a copy of
//! bytes into one `changes` frame per megabyte (TARGETS M8). Older changes come from the journal; past
//! TARGETS M9 (more than 5 MB or 20 000 ops behind) the client reloads the document instead. A protocol 2 client gets
//! the tail's field-level frames where the fan-out made them, and whole nodes from the journal (it reads both).

use crate::journal::{EntryBody, JournalEntry};
use morfa_model::DocumentPatch;
use morfa_protocol::codec::{FrameKind, transcode};
use morfa_protocol::{Change, Codec, Frame, ServerMsg, Version, Wire};
use std::collections::VecDeque;
use std::sync::Arc;

pub const TAIL_MAX_ENTRIES: usize = 20_000;
/// A catch-up from the tail sends at most [`CATCHUP_MAX_BYTES`] of its frames, so older frames are never served
/// from memory: they would only cost each busy file up to 64 MB (TARGETS K1). The margin covers a catch-up that
/// starts just before the tail (it reads the journal, as any older one does).
pub const TAIL_MAX_BYTES: usize = 8 * 1024 * 1024;
/// TARGETS M9: a catch-up larger than this reloads the document instead.
pub const CATCHUP_MAX_BYTES: usize = 5 * 1024 * 1024;
pub const CATCHUP_MAX_OPS: usize = 20_000;
/// One `changes` frame carries at most this many bytes of changes.
pub const CHANGES_FRAME_BYTES: usize = 1024 * 1024;

/// The patch a committed tail entry keeps instead of its own.
static COMMITTED: std::sync::LazyLock<Arc<DocumentPatch>> = std::sync::LazyLock::new(Arc::default);

pub struct TailEntry {
    pub change: Change,
    /// The encoded whole-node `change` frame, shared with every peer's send queue (of the wire its peers spoke first),
    /// and the same change on the other wire when some peer spoke it. None when only protocol 2 clients were there
    /// and the change has a field form (lane W): a protocol 1 client's catch-up over it reloads instead.
    pub whole: Option<(Frame, Option<Frame>)>,
    /// Protocol 2 (lane W): the change with its nodes as fields, on the wire(s) its peers spoke, when a node
    /// qualified. A field-level client catches up from these, or from the whole frames when absent.
    pub fields: Option<(Frame, Option<Frame>)>,
    /// What restores the previous version, until the journal commit makes a rollback impossible.
    pub undo: Option<DocumentPatch>,
}

impl TailEntry {
    pub fn version(&self) -> Version {
        self.change.version
    }

    /// The change's patch; None once the entry is committed (the journal holds it then).
    pub fn patch(&self) -> Option<&Arc<DocumentPatch>> {
        (!Arc::ptr_eq(&self.change.patch, &COMMITTED)).then_some(&self.change.patch)
    }

    /// The bytes this entry keeps in memory.
    pub fn bytes(&self) -> usize {
        self.whole.as_ref().map_or(0, |(frame, _)| frame.len())
            + self.fields.as_ref().map_or(0, |(frame, _)| frame.len())
    }

    fn pair(&self, fields: bool) -> Option<&(Frame, Option<Frame>)> {
        match (&self.fields, &self.whole) {
            (Some(pair), _) if fields => Some(pair),
            (_, Some(pair)) => Some(pair),
            _ => None,
        }
    }

    /// The change on `wire` (field-level when `fields` and the entry has it): as encoded for the fan-out, or
    /// translated from the other wire's frame. None for a protocol 1 client when the entry has no whole frame.
    pub fn frame_for(&self, wire: Wire, fields: bool) -> Option<Frame> {
        let kind = |frame: &Frame| match frame.kind {
            FrameKind::Text => Wire::Json,
            FrameKind::Binary => Wire::Binary,
        };
        let (first, other) = self.pair(fields)?;
        for frame in std::iter::once(first).chain(other) {
            if kind(frame) == wire {
                return Some(frame.clone());
            }
        }
        Some(transcode(first, wire).expect("frames this service encoded translate"))
    }

    /// The length of what [`TailEntry::frame_for`] gives (before any translation).
    fn len_for(&self, fields: bool) -> Option<usize> {
        self.pair(fields).map(|(frame, _)| frame.len())
    }
}

/// How a client at `since` catches up.
pub enum CatchUp {
    /// Nothing to send.
    Current,
    /// `changes` frames from the tail.
    Frames(Vec<Frame>),
    /// The tail starts later: read `(since, upto]` from the journal, then send `tail` (the tail's `change`
    /// frames after `upto`, taken now so later changes keep their order).
    Journal {
        since: Version,
        upto: Version,
        tail: Vec<Frame>,
    },
    /// Reload the document (too far behind, or ahead of the server after a rollback).
    Reload,
}

pub struct Tail {
    entries: VecDeque<TailEntry>,
    bytes: usize,
    committed: Version,
    max_entries: usize,
    max_bytes: usize,
}

impl Default for Tail {
    fn default() -> Self {
        Tail::with_limits(TAIL_MAX_ENTRIES, TAIL_MAX_BYTES)
    }
}

impl Tail {
    pub fn with_limits(max_entries: usize, max_bytes: usize) -> Self {
        Tail {
            entries: VecDeque::new(),
            bytes: 0,
            committed: 0,
            max_entries,
            max_bytes,
        }
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn bytes(&self) -> usize {
        self.bytes
    }

    pub fn first_version(&self) -> Option<Version> {
        self.entries.front().map(TailEntry::version)
    }

    /// The entries from `version` on, oldest first.
    pub fn from_version(&self, version: Version) -> impl Iterator<Item = &TailEntry> {
        let skip = self
            .first_version()
            .map_or(0, |first| version.saturating_sub(first) as usize);
        self.entries.iter().skip(skip)
    }

    pub fn push(&mut self, entry: TailEntry) {
        self.bytes += entry.bytes();
        self.entries.push_back(entry);
        self.trim();
    }

    /// The journal stored everything up to `upto`: those entries can no longer be rolled back.
    pub fn mark_committed(&mut self, upto: Version) {
        for entry in self.entries.iter_mut().rev() {
            if entry.version() <= self.committed {
                break;
            }
            if entry.version() <= upto {
                entry.undo = None;
                // Committed: only the frame is served from here on (catch-up batches); the parsed patch,
                // usually several times the frame's size, is the journal's now.
                entry.change.patch = Arc::clone(&COMMITTED);
            }
        }
        self.committed = self.committed.max(upto);
        self.trim();
    }

    /// Committed entries beyond the limits leave; uncommitted ones stay (a rollback needs them).
    fn trim(&mut self) {
        while (self.entries.len() > self.max_entries || self.bytes > self.max_bytes)
            && self
                .entries
                .front()
                .is_some_and(|e| e.version() <= self.committed)
        {
            let entry = self.entries.pop_front().expect("checked");
            self.bytes -= entry.bytes();
        }
    }

    /// Removes the entries from `from` on (newest first), for a rollback.
    pub fn pop_from(&mut self, from: Version) -> Vec<TailEntry> {
        let mut popped = Vec::new();
        while self.entries.back().is_some_and(|e| e.version() >= from) {
            let entry = self.entries.pop_back().expect("checked");
            self.bytes -= entry.bytes();
            popped.push(entry);
        }
        popped
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    /// The catch-up of a client at `since` when the document is at `version` (`fields`: it takes field-level
    /// changes).
    pub fn catch_up(
        &self,
        codec: &dyn Codec,
        fields: bool,
        since: Version,
        version: Version,
    ) -> CatchUp {
        if since == version {
            return CatchUp::Current;
        }
        if since > version || version - since > CATCHUP_MAX_OPS as u64 {
            return CatchUp::Reload;
        }
        match self.first_version() {
            Some(first) if first <= since + 1 => {}
            Some(first) => {
                let Some(tail) = self
                    .entries
                    .iter()
                    .map(|e| e.frame_for(codec.wire(), fields))
                    .collect::<Option<Vec<_>>>()
                else {
                    return CatchUp::Reload;
                };
                return CatchUp::Journal {
                    since,
                    upto: first - 1,
                    tail,
                };
            }
            None => {
                return CatchUp::Journal {
                    since,
                    upto: version,
                    tail: Vec::new(),
                };
            }
        }
        let start = (since + 1 - self.first_version().expect("checked")) as usize;
        let wanted = self.entries.range(start..);
        let Some(bytes) = self
            .entries
            .range(start..)
            .map(|e| e.len_for(fields))
            .sum::<Option<usize>>()
        else {
            return CatchUp::Reload;
        };
        if bytes > CATCHUP_MAX_BYTES {
            return CatchUp::Reload;
        }
        let Some(frames) = wanted
            .map(|e| e.frame_for(codec.wire(), fields))
            .collect::<Option<Vec<Frame>>>()
        else {
            return CatchUp::Reload;
        };
        CatchUp::Frames(batch_frames(codec, frames.iter()))
    }
}

/// Splits encoded `change` frames into `changes` frames of about a megabyte.
pub fn batch_frames<'a>(codec: &dyn Codec, frames: impl Iterator<Item = &'a Frame>) -> Vec<Frame> {
    let mut out = Vec::new();
    let mut chunk: Vec<&Frame> = Vec::new();
    let mut bytes = 0;
    for frame in frames {
        if bytes + frame.len() > CHANGES_FRAME_BYTES && !chunk.is_empty() {
            out.push(codec.changes_frame(&mut chunk.iter().map(|f| &f.bytes)));
            chunk.clear();
            bytes = 0;
        }
        bytes += frame.len();
        chunk.push(frame);
    }
    if !chunk.is_empty() {
        out.push(codec.changes_frame(&mut chunk.iter().map(|f| &f.bytes)));
    }
    out
}

/// A catch-up from journal rows, encoded off the actor. None: the rows do not reach back to `since` or a
/// document replacement lies in between, so the client reloads. The journal keeps whole nodes; a protocol 2 client
/// takes them as well.
pub fn frames_from_journal(
    codec: &dyn Codec,
    since: Version,
    upto: Version,
    rows: &[JournalEntry],
    tail: &[Frame],
) -> Option<Vec<Frame>> {
    let mut expected = since + 1;
    let mut frames = Vec::with_capacity(rows.len());
    let mut bytes = 0;
    for row in rows {
        if row.version != expected {
            return None;
        }
        let EntryBody::Patch(patch) = &row.body else {
            return None;
        };
        let frame = codec.encode_server(&ServerMsg::Change(Change {
            version: row.version,
            by: row.connection.clone(),
            client: row.client.clone(),
            seq: row.seq,
            user: row.user.clone(),
            patch: Arc::clone(patch),
            fields: None,
        }));
        bytes += frame.len();
        if bytes > CATCHUP_MAX_BYTES {
            return None;
        }
        frames.push(frame);
        expected += 1;
    }
    if expected != upto + 1
        || bytes + tail.iter().map(Frame::len).sum::<usize>() > CATCHUP_MAX_BYTES
    {
        return None;
    }
    Some(batch_frames(codec, frames.iter().chain(tail)))
}
