//! The journal and lease contracts between `crates/collab` (B1, the document actors) and the storage that backs them
//! (B2). Futures are `Send` so an actor can await them on any tokio worker.

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// Who sent an op: the tab's id from `hello {clientId}` and the op's `seq`. A re-sent op is found by this pair and
/// re-acked, never applied twice.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientOp {
    pub id: Arc<str>,
    pub seq: u64,
}

/// What a journal row holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    /// The op in the model's codec (collab's rows).
    Op(Vec<u8>),
    /// The JSON patch as Node writes it (`shared/design/patch.ts` `DocumentPatch`; legacy and shadow rows).
    Patch(String),
}

impl Body {
    /// The bytes the row stores.
    pub fn len(&self) -> usize {
        match self {
            Body::Op(bytes) => bytes.len(),
            Body::Patch(text) => text.len(),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// One op to journal: the version it made, under the fence of its owner's lease.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    pub file: Arc<str>,
    pub version: u64,
    pub fence: u64,
    pub client: Option<ClientOp>,
    pub user_id: Option<Arc<str>>,
    pub body: Body,
}

/// One journal row, as [`Journal::tail`] reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Row {
    pub version: u64,
    /// `None` for rows Node wrote outside a lease.
    pub fence: Option<u64>,
    pub client: Option<ClientOp>,
    pub user_id: Option<String>,
    pub body: Body,
}

/// Why an op was not journaled.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalError {
    /// The file's lease moved to another owner (its fence is `current`): this owner must stop serving the file and
    /// close its sockets with `bye {moved}`.
    Fenced {
        file: Arc<str>,
        current: Option<u64>,
    },
    /// The version (or the client's op) is already journaled with other content: the document diverged from the
    /// journal, the actor sends `rollback` and reloads.
    Conflict { file: Arc<str>, version: u64 },
    /// The node's queue of unjournaled ops is full (TARGETS D3: 64 MB per node); the op is refused, not queued.
    Overloaded,
    /// PostgreSQL did not take the op within the retry window; the actor sends `rollback {version}`.
    Unavailable(String),
    /// The row breaks a bound of the table (an empty op, a malformed client id): a bug of the caller.
    Invalid(String),
    /// The journal was shut down.
    Closed,
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JournalError::Fenced { file, current } => {
                write!(
                    f,
                    "file {file} is held by a newer lease (fence {current:?})"
                )
            }
            JournalError::Conflict { file, version } => {
                write!(f, "file {file} version {version} is already journaled")
            }
            JournalError::Overloaded => f.write_str("journal queue full"),
            JournalError::Unavailable(error) => write!(f, "journal unavailable: {error}"),
            JournalError::Invalid(error) => write!(f, "journal row refused: {error}"),
            JournalError::Closed => f.write_str("journal closed"),
        }
    }
}

impl std::error::Error for JournalError {}

/// The op log of every document (TARGETS D1: `append` resolves after the commit that holds the op).
pub trait Journal: Send + Sync {
    /// Journals one op; resolves once it is committed (the ack may go out) or refused.
    fn append(&self, entry: Entry) -> impl Future<Output = Result<(), JournalError>> + Send;

    /// Rows of `file` above `since`, in version order, at most `limit`.
    fn tail(
        &self,
        file: &str,
        since: u64,
        limit: usize,
    ) -> impl Future<Output = Result<Vec<Row>, JournalError>> + Send;

    /// The version a client's op was journaled as, if its row is still kept.
    fn find_client_op(
        &self,
        file: &str,
        client_id: &str,
        seq: u64,
    ) -> impl Future<Output = Result<Option<u64>, JournalError>> + Send;

    /// Deletes rows at or below `version` (the checkpoint's) that are more than `keep` versions behind the newest
    /// row; returns how many went.
    fn prune_below(
        &self,
        file: &str,
        version: u64,
        keep: u64,
    ) -> impl Future<Output = Result<u64, JournalError>> + Send;
}

/// A lease the caller now holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Grant {
    /// The fence every journal row of this owner carries.
    pub fence: u64,
    /// Until when this process may act as the owner: the database's lease end, measured from before the request was
    /// sent, so it never outlives the lease the database holds.
    pub valid_until: Instant,
}

/// Why a lease call failed (a lost lease is `Ok(None)`, not an error).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseError {
    Unavailable(String),
    Invalid(String),
}

impl fmt::Display for LeaseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LeaseError::Unavailable(error) => write!(f, "lease store unavailable: {error}"),
            LeaseError::Invalid(error) => write!(f, "lease refused: {error}"),
        }
    }
}

impl std::error::Error for LeaseError {}

/// One owner per document (docs/BACKEND.md §2 "Routing and the lease", §8 "Split brain").
pub trait Lease: Send + Sync {
    /// Takes the file for `node` when nobody holds it (or the holder's lease ran out, or the holder is `node`
    /// itself, restarted). Every grant has a larger fence than any before it. `None`: another node holds it.
    fn acquire(
        &self,
        file: &str,
        node: &str,
        ttl: Duration,
    ) -> impl Future<Output = Result<Option<Grant>, LeaseError>> + Send;

    /// Extends a held lease; `None` when it was lost (another owner took the file).
    fn renew(
        &self,
        file: &str,
        node: &str,
        fence: u64,
        ttl: Duration,
    ) -> impl Future<Output = Result<Option<Instant>, LeaseError>> + Send;

    /// Gives the file up (the last editor left); the fence stays where it is.
    fn release(
        &self,
        file: &str,
        node: &str,
        fence: u64,
    ) -> impl Future<Output = Result<(), LeaseError>> + Send;
}
