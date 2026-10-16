//! `morfa-protocol`: the messages of the co-editing socket (docs/BACKEND.md §2, lane B1).
//!
//! One WebSocket per open file per tab. The client opens with `hello`, then sends `op`s (today's
//! `PATCH /:id/document` body), `presence` and `ping`; the server answers `welcome`, `ack`/`refused` per op, the
//! others' `change`s in version order, coalesced `presence`, and the control frames of `shared/design/live.ts`
//! (`access`, `file`, `bye`) plus `rollback`, `catchUp` and `resync`. Op payloads are model types
//! (`DocumentPatch`, `SceneNode`), never `serde_json::Value`.
//!
//! The encoding sits behind [`Codec`]: [`JsonCodec`] (text frames, the debug mode and the default until S1's
//! binary codec lands in `crates/model`, TARGETS §3b). `schema.json` beside this crate describes every message
//! for loadgen (B0) and the browser client (B3); `tests/schema.rs` keeps it in step with these types.

pub mod binary;
pub mod codec;
pub mod fields;
#[cfg(feature = "ticket")]
pub mod ticket;

pub use codec::{Codec, DecodeError, Frame, JsonCodec, Wire};
pub use fields::{ChangeFields, NodeDiff, NodeFields};

use morfa_model::{DocumentPatch, Map, NodeId, SceneNode, Vec2};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::sync::Arc;

/// The protocol's version; `hello` carries the one the client speaks. 2 (lane W): a `change` carries the nodes the
/// file already had as the fields that changed ([`fields`]). The server speaks every version from
/// [`PROTOCOL_MIN`] to this one; anything else is `bye {protocol}`.
pub const PROTOCOL_VERSION: u32 = 2;
/// The oldest version the server still speaks (whole nodes in every `change`).
pub const PROTOCOL_MIN: u32 = 1;
/// The first version whose changes carry `fields`.
pub const PROTOCOL_FIELDS: u32 = 2;

/// Limits of BACKEND §2 and `shared/design/live.ts`, shared by the server and the clients.
pub mod limits {
    /// A message over this is refused (`design_document_too_large`, as `DESIGN_PATCH_MAX_BYTES`).
    pub const MAX_MESSAGE_BYTES: usize = 8 * 1024 * 1024;
    /// A document's JSON over this is not stored (`DESIGN_DOCUMENT_CAPS.bytes`).
    pub const DOCUMENT_BYTES: usize = 20 * 1024 * 1024;
    /// Ops per second per connection (a burst of twice that).
    pub const OPS_PER_SECOND: u32 = 50;
    /// Inbound bytes per second per connection.
    pub const BYTES_PER_SECOND: u32 = 2 * 1024 * 1024;
    /// Presence messages per second per connection (30 Hz, a burst of twice that).
    pub const PRESENCE_PER_SECOND: u32 = 30;
    /// The server sends a peer's presence to a receiver at most this often.
    pub const PRESENCE_FLUSH_MS: u64 = 33;
    /// Selected layers a presence carries (`DESIGN_LIVE.maxSelection`).
    pub const MAX_SELECTION: usize = 200;
    /// A connection's send queue (BACKEND §2): presence is dropped over half, changes become one `catchUp` over
    /// three quarters, and the connection is closed with `bye {slow}` over all of it.
    pub const SEND_QUEUE_BYTES: usize = 4 * 1024 * 1024;
    /// The server closes a socket silent for this long; clients ping every `PING_MS`.
    pub const SILENCE_MS: u64 = 50_000;
    pub const PING_MS: u64 = 20_000;
}

/// The file's version: the server's one order of changes (`design_files.version`).
pub type Version = u64;
/// A client's op counter, increasing by one per op from 1; `(clientId, seq)` makes a re-sent op idempotent.
pub type Seq = u64;

/// A client's stable id for one tab's editing session (kept across reconnects; at most 64 characters).
#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(transparent)]
pub struct ClientId(pub Arc<str>);

impl ClientId {
    pub const MAX_LEN: usize = 64;
    pub fn new(id: impl AsRef<str>) -> Self {
        Self(Arc::from(id.as_ref()))
    }
    pub fn as_str(&self) -> &str {
        &self.0
    }
    /// Non-empty, at most 64 characters of `[A-Za-z0-9_-]` (uuids, nanoids).
    pub fn is_valid(&self) -> bool {
        !self.0.is_empty()
            && self.0.len() <= Self::MAX_LEN
            && self
                .0
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    }
}

impl fmt::Debug for ClientId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "ClientId({})", self.0)
    }
}

/// `DesignTeamRole` (shared/design/teams.ts).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Owner,
    Admin,
    Editor,
    Developer,
    Viewer,
}

impl Role {
    /// `canEditTeamFiles`: owners, admins and editors write; developers and viewers never send `op`.
    pub fn can_edit(self) -> bool {
        matches!(self, Role::Owner | Role::Admin | Role::Editor)
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Role::Owner => "owner",
            Role::Admin => "admin",
            Role::Editor => "editor",
            Role::Developer => "developer",
            Role::Viewer => "viewer",
        }
    }
    pub fn parse(text: &str) -> Option<Role> {
        Some(match text {
            "owner" => Role::Owner,
            "admin" => Role::Admin,
            "editor" => Role::Editor,
            "developer" => Role::Developer,
            "viewer" => Role::Viewer,
            _ => return None,
        })
    }
}

/// Error codes the client branches on: `DesignErrorCode` of `shared/design/api.ts` where one fits, plus the
/// socket's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    /// 409: a stale `baseVersion` that could not be merged; `currentVersion` says where the file is.
    VersionConflict,
    /// 400: the patch or the document after it fails the schema; `path` (and `nodeId`) name the value.
    DesignDocumentInvalid,
    /// 413: one op over 8 MB; the client saves the whole document through api's `PUT` instead.
    DesignDocumentTooLarge,
    /// 413: the document would grow past its memory cap (`design_documents_limit`).
    DesignDocumentsLimit,
    /// 403: the connection's role does not write (viewer, developer, a demoted editor).
    DesignForbidden,
    /// 503: the service cannot take the op now (journal down, the file is moving); re-send it later.
    DesignUnavailable,
    /// 429: over the per-connection op, byte or presence rate.
    DesignLiveBusy,
    /// A message the server could not read.
    BadMessage,
    /// The `hello` ticket is missing, malformed, forged, expired or for another file.
    BadTicket,
}

impl ErrorCode {
    /// The HTTP status the same refusal has on api's `PATCH` route.
    pub fn status(self) -> u16 {
        match self {
            ErrorCode::VersionConflict => 409,
            ErrorCode::DesignDocumentInvalid | ErrorCode::BadMessage => 400,
            ErrorCode::DesignDocumentTooLarge | ErrorCode::DesignDocumentsLimit => 413,
            ErrorCode::DesignForbidden => 403,
            ErrorCode::BadTicket => 401,
            ErrorCode::DesignUnavailable => 503,
            ErrorCode::DesignLiveBusy => 429,
        }
    }
}

/// Why the server closes the socket (`DesignLiveBye` plus the socket's own reasons).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ByeReason {
    /// Lost access to the file.
    Access,
    /// The session ended (signed out).
    Session,
    Trashed,
    Erased,
    /// Over a server limit (connections per file, account, node).
    Limit,
    /// The send queue overflowed: reconnect with `since`.
    Slow,
    /// The node is draining for a deploy: reconnect through `/session`.
    Shutdown,
    /// The document was replaced (restore, import): reconnect and reload.
    Replaced,
    /// Another node owns the file now (the lease moved): reconnect through `/session`.
    Moved,
    /// The ticket was refused.
    Ticket,
    /// A protocol error (no `hello` first, an unknown protocol version, a frame the server cannot read twice).
    Protocol,
    /// The connection sent nothing for `SILENCE_MS`.
    Silent,
}

/// `DesignViewportPresence`.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Viewport {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
    pub width: f64,
    pub height: f64,
}

/// `DesignPresence`: what one connection shows the others.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Presence {
    pub cursor: Option<Vec2>,
    pub page: Option<NodeId>,
    pub selection: Vec<NodeId>,
    pub selection_count: u32,
    pub viewport: Option<Viewport>,
    pub editing: Option<NodeId>,
    /// "Meeting" presence (shared/design/meeting.ts); absent until the meeting module sends it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meeting: Option<MeetingPresence>,
}

/// `MeetingPresence` (shared/design/meeting.ts): cursor chat, the last emote burst, a wave, a spotlight.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct MeetingPresence {
    pub chat: Option<String>,
    pub emote: Option<MeetingEmote>,
    pub wave: Option<f64>,
    pub spotlight: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct MeetingEmote {
    pub id: String,
    pub n: f64,
}

/// Characters of cursor chat a presence carries.
pub const MAX_CHAT_CHARS: usize = 500;

/// `presence` from the client: only the fields that changed. An absent field keeps its value; `null` clears it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PresenceUpdate {
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub cursor: Option<Option<Vec2>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub page: Option<Option<NodeId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection: Option<Vec<NodeId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_count: Option<u32>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub viewport: Option<Option<Viewport>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub editing: Option<Option<NodeId>>,
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "double_option"
    )]
    pub meeting: Option<Option<MeetingPresence>>,
}

impl PresenceUpdate {
    /// Writes the update onto a presence; true when anything changed.
    pub fn apply_to(self, to: &mut Presence) -> bool {
        let mut changed = false;
        macro_rules! set {
            ($field:ident) => {
                if let Some(value) = self.$field {
                    if to.$field != value {
                        to.$field = value;
                        changed = true;
                    }
                }
            };
        }
        let mut meeting = self.meeting;
        if let Some(Some(value)) = &mut meeting
            && let Some(chat) = &mut value.chat
            && chat.chars().count() > MAX_CHAT_CHARS
        {
            *chat = chat.chars().take(MAX_CHAT_CHARS).collect();
        }
        if let Some(value) = meeting
            && to.meeting != value
        {
            to.meeting = value;
            changed = true;
        }
        set!(cursor);
        set!(page);
        set!(viewport);
        set!(editing);
        if let Some(mut selection) = self.selection {
            let count = self.selection_count.unwrap_or(selection.len() as u32);
            selection.truncate(limits::MAX_SELECTION);
            if to.selection != selection || to.selection_count != count {
                to.selection = selection;
                to.selection_count = count;
                changed = true;
            }
        } else if let Some(count) = self.selection_count
            && to.selection_count != count
        {
            to.selection_count = count;
            changed = true;
        }
        changed
    }
}

mod double_option {
    use serde::{Deserialize, Deserializer, Serialize, Serializer};
    pub fn serialize<T: Serialize, S: Serializer>(
        value: &Option<Option<T>>,
        serializer: S,
    ) -> Result<S::Ok, S::Error> {
        match value {
            Some(inner) => inner.serialize(serializer),
            None => serializer.serialize_none(),
        }
    }
    pub fn deserialize<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
        deserializer: D,
    ) -> Result<Option<Option<T>>, D::Error> {
        Option::<T>::deserialize(deserializer).map(Some)
    }
}

/// `DesignPeer`: another connection in the file with its presence.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub connection: String,
    pub user: String,
    pub name: String,
    /// Index into `DESIGN_LIVE_COLORS`; one person keeps one colour in a file.
    pub color: u32,
    pub role: Role,
    #[serde(flatten)]
    pub presence: Presence,
}

/// A peer without its presence: who is behind a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerInfo {
    pub connection: String,
    pub user: String,
    pub name: String,
    pub color: u32,
    pub role: Role,
}

/// One accepted change of the file: what the server stored as `version`.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Change {
    pub version: Version,
    /// The connection that sent it (null for a change made by api: restore, import).
    pub by: Option<String>,
    /// The client session that sent it, so a reconnecting client knows its own ops in a catch-up.
    #[serde(default)]
    pub client: Option<ClientId>,
    #[serde(default)]
    pub seq: Option<Seq>,
    pub user: String,
    pub patch: Arc<DocumentPatch>,
    /// Protocol 2: nodes the file had before, as the fields that changed ([`fields`]). With [`ChangeFields::Diff`]
    /// `patch` is the whole stored patch and those nodes are written here instead of in `patch.nodes`.
    #[serde(default)]
    pub fields: Option<Arc<ChangeFields>>,
}

impl Change {
    /// The same change with its nodes as fields where the server had them before (`undo`: the op's previous
    /// values); None when no node qualifies (the whole-node change is the field-level one then).
    pub fn with_fields(&self, undo: &DocumentPatch) -> Option<Change> {
        let fields = fields::diff(&self.patch, undo)?;
        Some(Change {
            fields: Some(Arc::new(fields)),
            ..self.clone()
        })
    }

    /// The same change with these nodes as fields, known without a diff (an op's own fields that landed as sent).
    /// Each diff's index must name a node of `patch.nodes`, in order.
    pub fn with_diffs(&self, diffs: Vec<NodeDiff>) -> Option<Change> {
        (!diffs.is_empty()).then(|| Change {
            fields: Some(Arc::new(ChangeFields::Diff(diffs))),
            ..self.clone()
        })
    }
}

impl Serialize for Change {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut out = serializer.serialize_struct("Change", 7)?;
        out.serialize_field("version", &self.version)?;
        out.serialize_field("by", &self.by)?;
        match &self.client {
            Some(client) => out.serialize_field("client", client)?,
            None => out.skip_field("client")?,
        }
        match &self.seq {
            Some(seq) => out.serialize_field("seq", seq)?,
            None => out.skip_field("seq")?,
        }
        out.serialize_field("user", &self.user)?;
        match self.fields.as_deref() {
            Some(ChangeFields::Diff(diffs)) => {
                out.serialize_field(
                    "patch",
                    &fields::PatchWithout {
                        patch: &self.patch,
                        diffs,
                    },
                )?;
                out.serialize_field(
                    "fields",
                    &fields::DiffOut {
                        patch: &self.patch,
                        diffs,
                    },
                )?;
            }
            Some(ChangeFields::Read(map)) => {
                out.serialize_field("patch", &self.patch)?;
                out.serialize_field("fields", map)?;
            }
            None => {
                out.serialize_field("patch", &self.patch)?;
                out.skip_field("fields")?;
            }
        }
        out.end()
    }
}

/// `hello`: the first message on a socket.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// The api-minted ticket (Ed25519, 60 s, bound to user + file + role).
    pub ticket: String,
    pub client_id: ClientId,
    /// The version the client holds; changes after it follow `welcome` in a `changes` frame. Absent: the client has no
    /// document yet and the server sends it (`snapshotUrl` or a `document` frame).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub since: Option<Version>,
    /// The last `seq` the client sent; ops after `lastAcked` up to it are re-sent and re-acked, not re-applied.
    #[serde(default)]
    pub last_seq: Seq,
    /// The protocol version the client speaks ([`PROTOCOL_MIN`]..=[`PROTOCOL_VERSION`]); absent: 1.
    #[serde(default = "protocol_version")]
    pub protocol: u32,
}

fn protocol_version() -> u32 {
    PROTOCOL_MIN
}

impl Hello {
    /// The client speaks a version the server serves.
    pub fn protocol_ok(&self) -> bool {
        (PROTOCOL_MIN..=PROTOCOL_VERSION).contains(&self.protocol)
    }

    /// The client takes field-level changes.
    pub fn fields(&self) -> bool {
        self.protocol >= PROTOCOL_FIELDS
    }
}

/// `op`: today's `PATCH /:id/document` body (`DesignDocumentPatchBody`) plus the client's `seq`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Op {
    pub seq: Seq,
    pub base_version: Version,
    pub patch: DocumentPatch,
    /// The client's copy of every node the patch touches as it was at `baseVersion` (null: absent).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<Copies>,
    /// The same for the other tables and the page order.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before_tables: Option<DocumentPatch>,
    /// Protocol 2 (lane W): nodes the op changes as the fields it wrote, beside `patch` (which then holds only new
    /// and removed nodes and the other tables). The server expands them over its own nodes before the op applies.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fields: Option<OpFields>,
}

/// An op's field-level nodes (protocol 2, crates/protocol/src/fields.rs): for each node, the fields the op sets, the
/// fields it removes, and what the client's copy at `baseVersion` held in those fields (`was`; a field absent there
/// was absent). A node is in `set`, in `unset`, or in both; field names as `shared/design/types.ts` writes them.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct OpFields {
    #[serde(default)]
    pub set: Map<serde_json::Map<String, serde_json::Value>>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub unset: Map<Vec<String>>,
    #[serde(default, skip_serializing_if = "Map::is_empty")]
    pub was: Map<serde_json::Map<String, serde_json::Value>>,
}

impl OpFields {
    /// The nodes the op changes as fields, in order (those in `set`, then those only in `unset`).
    pub fn ids(&self) -> impl Iterator<Item = &NodeId> {
        self.set
            .keys()
            .chain(self.unset.keys().filter(|id| !self.set.contains_key(*id)))
    }
}

/// An op's `before` copies. The JSON codec keeps them as they came ([`Copies::Raw`]): they matter only to an op
/// made on an older version (the merge reads them), and reading 20 nodes with the strict reader costs about as much
/// as the patch itself. [`Copies::read`] reads them when an op needs them, with the same reader and errors.
#[derive(Debug, Clone)]
pub enum Copies {
    Read(Map<Option<SceneNode>>),
    Raw(Box<serde_json::value::RawValue>),
    /// The binary frame of the op (crate::binary): the copies are read from it when needed.
    Bin(bytes::Bytes),
}

impl Copies {
    /// Reads raw copies in place; the error is the one decoding would have given (`before.<path>`).
    pub fn read(&mut self, seq: Seq) -> Result<&Map<Option<SceneNode>>, DecodeError> {
        match self {
            Copies::Raw(raw) => *self = Copies::Read(codec::read_copies(raw.get(), seq)?),
            Copies::Bin(frame) => *self = Copies::Read(binary::read_copies(frame, seq)?),
            Copies::Read(_) => {}
        }
        match self {
            Copies::Read(map) => Ok(map),
            _ => unreachable!("read above"),
        }
    }

    /// The copies when already read.
    pub fn as_read(&self) -> Option<&Map<Option<SceneNode>>> {
        match self {
            Copies::Read(map) => Some(map),
            _ => None,
        }
    }
}

impl From<Map<Option<SceneNode>>> for Copies {
    fn from(map: Map<Option<SceneNode>>) -> Self {
        Copies::Read(map)
    }
}

impl PartialEq for Copies {
    fn eq(&self, other: &Self) -> bool {
        let (mut a, mut b) = (self.clone(), other.clone());
        match (a.read(0), b.read(0)) {
            (Ok(a), Ok(b)) => a == b,
            _ => false,
        }
    }
}

impl Serialize for Copies {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Copies::Read(map) => map.serialize(serializer),
            Copies::Raw(raw) => raw.serialize(serializer),
            Copies::Bin(frame) => binary::read_copies(frame, 0)
                .map_err(|e| serde::ser::Error::custom(e.message))?
                .serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Copies {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Map::deserialize(deserializer).map(Copies::Read)
    }
}

/// Client → server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ClientMsg {
    Hello(Hello),
    Op(Box<Op>),
    Presence(PresenceUpdate),
    /// Fetch the changes after `since` (after a `catchUp` notice, or a gap).
    Pull {
        since: Version,
    },
    Ping,
}

/// `welcome`: the answer to `hello`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Welcome {
    pub connection: String,
    pub version: Version,
    pub role: Role,
    pub can_edit: bool,
    pub user: String,
    pub name: String,
    pub color: u32,
    pub peers: Vec<Peer>,
    /// The client must load the document instead: from `snapshotUrl` when set, else from the `document` frame
    /// that follows.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub resync: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub snapshot_url: Option<String>,
    /// The highest `seq` of this client the file holds, so the client re-sends only what is after it.
    #[serde(default)]
    pub acked_seq: Seq,
}

/// Server → client.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase")]
pub enum ServerMsg {
    Welcome(Box<Welcome>),
    /// The op is stored as `version` (after the journal commit). `own`: what the server stored when it differs
    /// from what was sent (`DesignSaved.own`).
    #[serde(rename_all = "camelCase")]
    Ack {
        seq: Seq,
        version: Version,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        own: Option<Arc<DocumentPatch>>,
    },
    /// The op was not applied.
    #[serde(rename_all = "camelCase")]
    Refused {
        seq: Seq,
        code: ErrorCode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        current_version: Option<Version>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        path: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        node_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Change(Change),
    /// A batch of changes in version order: the answer to `pull`.
    Changes {
        changes: Vec<Change>,
    },
    /// The client fell behind (its send queue filled): it should `pull {since: from - 1}` when ready.
    CatchUp {
        from: Version,
        to: Version,
    },
    /// Peers whose presence changed (joined, moved, selected...), never the receiver itself.
    Presence {
        peers: Vec<Peer>,
    },
    Leave {
        connection: String,
    },
    Pong,
    /// The caller's role changed (a demoted editor becomes read-only).
    #[serde(rename_all = "camelCase")]
    Access {
        role: Role,
        can_edit: bool,
    },
    File {
        name: String,
    },
    /// The file's comments changed: fetch what is new (`GET /:id/comments?since=`), as the SSE `comments` event.
    Comments {},
    /// The file's meeting (timer, vote) changed as `revision`: read it again. With `user`, only that person's own
    /// votes changed, and only their sockets hear it (the SSE `meeting` event).
    Meeting {
        revision: u64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        user: Option<String>,
    },
    /// A journal commit failed after fan-out: changes above `version` are gone; rebase as on a `resync`.
    Rollback {
        version: Version,
    },
    /// The document was replaced (restore, import): reload it (a `document` frame follows unless
    /// `snapshotUrl` is set).
    #[serde(rename_all = "camelCase")]
    Resync {
        version: Version,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        snapshot_url: Option<String>,
    },
    /// The whole document at `version` (when no snapshot URL serves it).
    Document {
        version: Version,
        document: Arc<morfa_model::DesignDocument>,
    },
    Error {
        code: ErrorCode,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        message: Option<String>,
    },
    Bye {
        reason: ByeReason,
    },
}

impl ServerMsg {
    /// The message's `t` tag, for logs and metrics.
    pub fn tag(&self) -> &'static str {
        match self {
            ServerMsg::Welcome(_) => "welcome",
            ServerMsg::Ack { .. } => "ack",
            ServerMsg::Refused { .. } => "refused",
            ServerMsg::Change(_) => "change",
            ServerMsg::Changes { .. } => "changes",
            ServerMsg::CatchUp { .. } => "catchUp",
            ServerMsg::Presence { .. } => "presence",
            ServerMsg::Leave { .. } => "leave",
            ServerMsg::Pong => "pong",
            ServerMsg::Access { .. } => "access",
            ServerMsg::File { .. } => "file",
            ServerMsg::Comments {} => "comments",
            ServerMsg::Meeting { .. } => "meeting",
            ServerMsg::Rollback { .. } => "rollback",
            ServerMsg::Resync { .. } => "resync",
            ServerMsg::Document { .. } => "document",
            ServerMsg::Error { .. } => "error",
            ServerMsg::Bye { .. } => "bye",
        }
    }
}

impl ClientMsg {
    pub fn tag(&self) -> &'static str {
        match self {
            ClientMsg::Hello(_) => "hello",
            ClientMsg::Op(_) => "op",
            ClientMsg::Presence(_) => "presence",
            ClientMsg::Pull { .. } => "pull",
            ClientMsg::Ping => "ping",
        }
    }
}

/// Every `t` tag, for the schema test and loadgen.
pub const CLIENT_TAGS: [&str; 5] = ["hello", "op", "presence", "pull", "ping"];
pub const SERVER_TAGS: [&str; 18] = [
    "welcome", "ack", "refused", "change", "changes", "catchUp", "presence", "leave", "pong",
    "access", "file", "comments", "meeting", "rollback", "resync", "document", "error", "bye",
];
