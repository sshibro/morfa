//! The op journal and the document store, as traits (lane B2 supplies PostgreSQL + S3; docs/BACKEND.md §3).
//!
//! The actor hands every applied op to its committer task, which calls [`Journal::commit`] with whatever has
//! queued since the last call (per-file group commit; B2's implementation may also group across files). The ack
//! waits for the commit; the fan-out does not (TARGETS M1 vs M1b). A failed commit makes the actor roll back
//! (`rollback {version}` to the peers).

use async_trait::async_trait;
use morfa_model::{DesignDocument, DocumentPatch};
use morfa_protocol::{ClientId, Seq, Version};
use parking_lot::Mutex;
use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

/// What one version of a file is.
#[derive(Debug, Clone, PartialEq)]
pub enum EntryBody {
    /// An op as applied (`design_file_changes.op`, S1's codec in B2's rows).
    Patch(Arc<DocumentPatch>),
    /// The whole document replaced (restore, import through api's `PUT`).
    Replace(Arc<DesignDocument>),
}

/// One journal row (`design_file_changes`, migration 012).
#[derive(Debug, Clone, PartialEq)]
pub struct JournalEntry {
    pub version: Version,
    pub user: String,
    /// The connection that sent it; None for api's changes.
    pub connection: Option<String>,
    pub client: Option<ClientId>,
    pub seq: Option<Seq>,
    pub body: EntryBody,
}

/// A document as the store holds it: the checkpoint with the journal tail applied.
#[derive(Debug, Clone)]
pub struct Loaded {
    /// The document, typed or in the model's compact store, as the journal read it.
    pub source: crate::engine::EngineSource,
    pub version: Version,
    pub name: Option<String>,
    /// The version of the file's checkpoint object, which api serves as `GET /api/design-files/:id/checkpoint`
    /// (BIG.md stage E); None: no object, or a journal that does not write them ([`Journal::serves_checkpoints`]).
    pub checkpoint: Option<Version>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JournalError {
    /// The store is unreachable or refused the write; nothing of the batch is stored.
    Unavailable(String),
    /// The lease fence no longer matches: another node owns the file (BACKEND §8 split brain).
    Fenced,
}

impl fmt::Display for JournalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            JournalError::Unavailable(why) => write!(f, "journal unavailable: {why}"),
            JournalError::Fenced => f.write_str("journal write fenced: the lease moved"),
        }
    }
}

impl std::error::Error for JournalError {}

#[async_trait]
pub trait Journal: Send + Sync + 'static {
    /// Loads a file's document (checkpoint + tail). None: no such file.
    async fn load(&self, file: &str) -> Result<Option<Loaded>, JournalError>;
    /// Stores a batch of consecutive versions atomically, under the lease `fence`. All or nothing.
    async fn commit(
        &self,
        file: &str,
        fence: u64,
        batch: &[JournalEntry],
    ) -> Result<(), JournalError>;
    /// The entries `(after, upto]` in version order, at most `limit`. Fewer than asked means the journal no
    /// longer holds them (below the last checkpoint): the client reloads.
    async fn read(
        &self,
        file: &str,
        after: Version,
        upto: Version,
        limit: usize,
    ) -> Result<Vec<JournalEntry>, JournalError>;
    /// The version a client's op was journaled as, if its row is still kept (B2's `find_client_op`): a
    /// reconnecting client's re-sent ops are re-acked from it, never re-applied.
    async fn find_client_op(
        &self,
        file: &str,
        client: &ClientId,
        seq: Seq,
    ) -> Result<Option<Version>, JournalError>;
    /// Stores `document`, the file at the journaled `version`, as a checkpoint under `fence`, and lets the journal
    /// drop the rows it covers (BACKEND §3, TARGETS S4). A journal without checkpoints does nothing.
    async fn checkpoint(
        &self,
        _file: &str,
        _fence: u64,
        _version: Version,
        _document: Arc<DesignDocument>,
    ) -> Result<(), JournalError> {
        Ok(())
    }
    /// Whether the checkpoints this journal writes are objects api serves (`GET /api/design-files/:id/checkpoint`):
    /// then a client that must reload can load the newest one and catch up from it (BIG.md stage E).
    fn serves_checkpoints(&self) -> bool {
        false
    }
    /// The store's queue of uncommitted ops is nearly full (PostgreSQL slow or away, TARGETS D3): new ops are
    /// refused as busy before they apply, instead of failing their commit and rolling every peer back.
    fn backlogged(&self) -> bool {
        false
    }
    /// The bytes of uncommitted ops the store may hold: the node stops taking ops near it, counting from the
    /// moment an op applies (ops wait in their file's committer while an earlier commit of the file hangs).
    fn queue_budget(&self) -> usize {
        usize::MAX
    }
    /// [`Journal::checkpoint`] of the document in the model's compact store (the actor's mirror: a snapshot of it
    /// costs a clone of its node pointers, not of the document). A journal with checkpoints implements both.
    async fn checkpoint_store(
        &self,
        _file: &str,
        _fence: u64,
        _version: Version,
        _document: Arc<morfa_model::store::Document>,
    ) -> Result<(), JournalError> {
        Ok(())
    }
}

/// The journal in memory, for tests and for running the service before B2 lands. `fail_next` injects failed
/// commits (the rollback path).
#[derive(Default)]
pub struct MemJournal {
    files: Mutex<HashMap<String, MemFile>>,
    fail_commits: AtomicUsize,
    /// Reports a full queue ([`Journal::backlogged`]; tests).
    backlog: std::sync::atomic::AtomicBool,
    /// Each commit waits this long first, in milliseconds (tests of what waits for a commit).
    commit_delay_ms: AtomicU64,
    /// A seed for files the journal has never seen (`--seed`, loadgen runs).
    seed: Mutex<Option<Arc<DesignDocument>>>,
    commits: AtomicU64,
    /// Entries kept per file beyond its base; older ones are folded into the base (a checkpoint), so a long
    /// run holds what B2's journal would, not every op since the start. None: keep everything (tests).
    keep: Option<usize>,
    /// Tests of the resync through a checkpoint: each file's base counts as its checkpoint object.
    checkpoints: std::sync::atomic::AtomicBool,
}

#[derive(Clone)]
struct MemFile {
    base: Arc<DesignDocument>,
    base_version: Version,
    entries: Vec<JournalEntry>,
    name: Option<String>,
}

impl MemJournal {
    pub fn new() -> Self {
        Self::default()
    }

    /// Every unknown file loads as this document at version 0.
    pub fn with_seed(self, document: DesignDocument) -> Self {
        *self.seed.lock() = Some(Arc::new(document));
        self
    }

    pub fn insert(&self, file: &str, document: DesignDocument, version: Version) {
        self.files.lock().insert(
            file.to_owned(),
            MemFile {
                base: Arc::new(document),
                base_version: version,
                entries: Vec::new(),
                name: None,
            },
        );
    }

    /// Each file's base document (as inserted, or with the entries folded in) counts as its checkpoint object
    /// ([`Journal::serves_checkpoints`]; tests of the resync through a checkpoint).
    pub fn serve_checkpoints(&self) {
        self.checkpoints.store(true, Ordering::SeqCst);
    }

    /// The base document of a file and its version: what its checkpoint object holds under
    /// [`MemJournal::serve_checkpoints`].
    pub fn base(&self, file: &str) -> Option<(Arc<DesignDocument>, Version)> {
        let files = self.files.lock();
        let file = files.get(file)?;
        Some((Arc::clone(&file.base), file.base_version))
    }

    /// Keeps at most about `2 × keep` entries per file: then the oldest are folded into the base document.
    pub fn with_keep(mut self, keep: usize) -> Self {
        self.keep = Some(keep.max(1));
        self
    }

    /// The next `n` commits fail with `Unavailable`.
    pub fn fail_next(&self, n: usize) {
        self.fail_commits.store(n, Ordering::SeqCst);
    }

    /// Reports the queue full (or not) from now on.
    pub fn set_backlogged(&self, full: bool) {
        self.backlog.store(full, Ordering::SeqCst);
    }

    /// Every commit from now on takes `delay` before it stores.
    pub fn delay_commits(&self, delay: std::time::Duration) {
        self.commit_delay_ms
            .store(delay.as_millis() as u64, Ordering::SeqCst);
    }

    pub fn commits(&self) -> u64 {
        self.commits.load(Ordering::Relaxed)
    }

    /// The versions stored for a file.
    pub fn versions(&self, file: &str) -> Vec<Version> {
        self.files
            .lock()
            .get(file)
            .map(|f| f.entries.iter().map(|e| e.version).collect())
            .unwrap_or_default()
    }

    /// The document the journal holds: the base with every entry applied (what a new owner would load).
    pub fn replay(&self, file: &str) -> Option<(DesignDocument, Version)> {
        let file = self.files.lock().get(file).cloned()?;
        let mut doc = (*file.base).clone();
        let mut version = file.base_version;
        for entry in &file.entries {
            match &entry.body {
                EntryBody::Patch(patch) => patch.apply(&mut doc),
                EntryBody::Replace(d) => doc = (**d).clone(),
            }
            version = entry.version;
        }
        Some((doc, version))
    }
}

#[async_trait]
impl Journal for MemJournal {
    async fn load(&self, file: &str) -> Result<Option<Loaded>, JournalError> {
        if !self.files.lock().contains_key(file) {
            let seed = self.seed.lock().clone();
            match seed {
                Some(seed) => {
                    self.files.lock().entry(file.to_owned()).or_insert(MemFile {
                        base: seed,
                        base_version: 0,
                        entries: Vec::new(),
                        name: None,
                    });
                }
                None => return Ok(None),
            }
        }
        let (name, base_version) = {
            let files = self.files.lock();
            let file = files.get(file).expect("present");
            (file.name.clone(), file.base_version)
        };
        let (document, version) = self.replay(file).expect("present");
        Ok(Some(Loaded {
            source: crate::engine::EngineSource::Model(Box::new(document)),
            version,
            name,
            checkpoint: self.serves_checkpoints().then_some(base_version),
        }))
    }

    fn serves_checkpoints(&self) -> bool {
        self.checkpoints.load(Ordering::SeqCst)
    }

    fn backlogged(&self) -> bool {
        self.backlog.load(Ordering::SeqCst)
    }

    async fn commit(
        &self,
        file: &str,
        _fence: u64,
        batch: &[JournalEntry],
    ) -> Result<(), JournalError> {
        let delay = self.commit_delay_ms.load(Ordering::SeqCst);
        if delay > 0 {
            tokio::time::sleep(std::time::Duration::from_millis(delay)).await;
        }
        if self
            .fail_commits
            .try_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1))
            .is_ok()
        {
            return Err(JournalError::Unavailable("injected".into()));
        }
        let mut files = self.files.lock();
        let f = files
            .get_mut(file)
            .ok_or_else(|| JournalError::Unavailable(format!("no file {file}")))?;
        let first = f.entries.last().map_or(f.base_version, |e| e.version) + 1;
        for (next, entry) in (first..).zip(batch) {
            if entry.version != next {
                return Err(JournalError::Unavailable(format!(
                    "version {} after {}",
                    entry.version,
                    next - 1
                )));
            }
        }
        f.entries.extend_from_slice(batch);
        if let Some(keep) = self.keep
            && f.entries.len() > 2 * keep
        {
            let folded: Vec<JournalEntry> = f.entries.drain(..f.entries.len() - keep).collect();
            let mut base = (*f.base).clone();
            for entry in &folded {
                match &entry.body {
                    EntryBody::Patch(patch) => patch.apply(&mut base),
                    EntryBody::Replace(d) => base = (**d).clone(),
                }
            }
            f.base = Arc::new(base);
            f.base_version = folded.last().map_or(f.base_version, |e| e.version);
        }
        self.commits.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    async fn read(
        &self,
        file: &str,
        after: Version,
        upto: Version,
        limit: usize,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        let files = self.files.lock();
        let Some(f) = files.get(file) else {
            return Ok(Vec::new());
        };
        if after < f.base_version {
            return Ok(Vec::new());
        }
        Ok(f.entries
            .iter()
            .filter(|e| e.version > after && e.version <= upto)
            .take(limit)
            .cloned()
            .collect())
    }

    async fn find_client_op(
        &self,
        file: &str,
        client: &ClientId,
        seq: Seq,
    ) -> Result<Option<Version>, JournalError> {
        let files = self.files.lock();
        Ok(files.get(file).and_then(|f| {
            f.entries
                .iter()
                .find(|e| e.seq == Some(seq) && e.client.as_ref() == Some(client))
                .map(|e| e.version)
        }))
    }
}

/// A journal that stores nothing (shadow mode: the Node path is authoritative and writes the rows).
pub struct NullJournal;

#[async_trait]
impl Journal for NullJournal {
    async fn load(&self, _file: &str) -> Result<Option<Loaded>, JournalError> {
        Ok(None)
    }
    async fn commit(&self, _: &str, _: u64, _: &[JournalEntry]) -> Result<(), JournalError> {
        Ok(())
    }
    async fn read(
        &self,
        _: &str,
        _: Version,
        _: Version,
        _: usize,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        Ok(Vec::new())
    }
    async fn find_client_op(
        &self,
        _: &str,
        _: &ClientId,
        _: Seq,
    ) -> Result<Option<Version>, JournalError> {
        Ok(None)
    }
}
