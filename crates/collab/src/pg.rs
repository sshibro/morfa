//! The journal and the lease over the PostgreSQL crates (`crates/journal`, `crates/lease`,
//! `crates/checkpoint`): what a production node runs
//! (`MORFA_COLLAB_PG_URL`); [`crate::journal::MemJournal`] and [`crate::lease::MemLease`] remain for tests and
//! single-node runs.
//!
//! - commit → `PgJournal::append_batch` (one file's consecutive versions, all or nothing, under the fence); rows
//!   hold the patch as JSON (`ops::patch_body`) while the binary patch codec is the wire's, not the model's;
//! - load → `Checkpoints::load` (checkpoint object + the rows above it, or `design_files.document`);
//! - read → `PgJournal::tail` decoded with `ops::decode`; a row that only replays on the store (`MRFJ`) ends the
//!   read early, which makes the client reload, as a pruned journal does;
//! - the lease → `PgLease` (acquire / renew / release with the fence); each actor renews its own;
//! - `LISTEN design_acl` ([`listen_acl`]): api announces every permission push there too, so a lost
//!   `POST /internal/acl` still reaches the file's actor.

use crate::journal::{EntryBody, Journal, JournalEntry, JournalError, Loaded};
use crate::lease::{LEASE_TTL, Lease, LeaseError};
use async_trait::async_trait;
use morfa_blobs::ObjectStore;
use morfa_checkpoint::Checkpoints;
use morfa_checkpoint::ops::{self, Op};
use morfa_journal::{
    ClientOp, Entry, Journal as _, JournalError as PgError, Lease as _, LeaseError as PgLeaseError,
    PgJournal,
};
use morfa_lease::PgLease;
use morfa_model::DesignDocument;
use morfa_model::store::Document;
use morfa_protocol::{ClientId, Seq, Version};
use std::sync::Arc;

pub struct PgStore<S> {
    pub journal: PgJournal,
    pub checkpoints: Checkpoints<S>,
    /// Writes `design_files.bytes`, `node_count`, `image_files` after each checkpoint ([`FileStats`]).
    stats: tokio::sync::Mutex<morfa_journal::conn::Conn>,
    /// Waits this long between recording a checkpoint and writing its exact stats (tests of that window).
    #[doc(hidden)]
    pub stats_delay: std::time::Duration,
}

impl<S> PgStore<S> {
    pub fn new(journal: PgJournal, checkpoints: Checkpoints<S>, url: &str) -> Self {
        PgStore {
            journal,
            checkpoints,
            stats: tokio::sync::Mutex::new(morfa_journal::conn::Conn::new(url)),
            stats_delay: std::time::Duration::ZERO,
        }
    }
}

/// What api keeps beside a stored document (server/design/files.ts `prepare`): its JSON's byte length, its layer
/// count and the pictures it points at (`/uploads/<file>` → `<file>`, each once). api's storage accounting reads
/// `bytes`, and erasing a file keeps every picture another file's `image_files` lists.
#[derive(Debug, Clone, PartialEq)]
pub struct FileStats {
    pub bytes: i32,
    pub node_count: i32,
    pub image_files: Vec<String>,
}

impl FileStats {
    pub fn of(document: &DesignDocument) -> Self {
        let mut image_files: Vec<String> = Vec::new();
        for asset in document.images.values() {
            let file = asset
                .url
                .strip_prefix("/uploads/")
                .unwrap_or(&asset.url)
                .to_owned();
            if !image_files.contains(&file) {
                image_files.push(file);
            }
        }
        FileStats {
            bytes: i32::try_from(morfa_model::to_json(document).len()).unwrap_or(i32::MAX),
            node_count: document.nodes.len() as i32,
            image_files,
        }
    }
}

/// Before a checkpoint is recorded: its pictures join `image_files` (a superset keeps pictures, never loses one).
/// Recording it ends the rows "above" it, which api's erase also keeps pictures for; without this the moment
/// between the record and `RECORD_STATS` listed the checkpoint's new pictures nowhere.
const LIST_PICTURES: &str = "UPDATE public.design_files
 SET image_files=ARRAY(SELECT DISTINCT unnest(image_files || $3::text[]))
 WHERE id=$1 AND fence=$2 AND NOT ($3::text[] <@ image_files)";

/// Recorded only for the checkpoint just written, under the writer's fence.
const RECORD_STATS: &str = "UPDATE public.design_files SET bytes=$3,node_count=$4,image_files=$5
 WHERE id=$1 AND fence=$2 AND checkpoint_version=$6";

fn unavailable(error: impl std::fmt::Display) -> JournalError {
    JournalError::Unavailable(error.to_string())
}

fn mapped(error: PgError) -> JournalError {
    match error {
        PgError::Fenced { .. } => JournalError::Fenced,
        other => unavailable(other),
    }
}

#[async_trait]
impl<S: ObjectStore + Clone + 'static> Journal for PgStore<S> {
    async fn load(&self, file: &str) -> Result<Option<Loaded>, JournalError> {
        let Some(loaded) = self.checkpoints.load(file).await.map_err(unavailable)? else {
            return Ok(None);
        };
        // The engine runs on the store the checkpoint decoded into (TARGETS M6): no conversion.
        Ok(Some(Loaded {
            source: crate::engine::EngineSource::Store(loaded.doc),
            version: loaded.version,
            name: None,
            checkpoint: loaded.checkpoint_version,
        }))
    }

    async fn commit(
        &self,
        file: &str,
        fence: u64,
        batch: &[JournalEntry],
    ) -> Result<(), JournalError> {
        let file: Arc<str> = file.into();
        let entries = batch
            .iter()
            .map(|entry| Entry {
                file: Arc::clone(&file),
                version: entry.version,
                fence,
                client: entry
                    .client
                    .as_ref()
                    .zip(entry.seq)
                    .map(|(client, seq)| ClientOp {
                        id: client.0.clone(),
                        seq,
                    }),
                user_id: Some(entry.user.as_str().into()),
                body: match &entry.body {
                    EntryBody::Patch(patch) => ops::patch_body(patch),
                    EntryBody::Replace(document) => ops::replace_body(
                        &Document::from_model(document),
                        entry.version,
                        morfa_checkpoint::Format::Bin,
                    ),
                },
            })
            .collect();
        self.journal.append_batch(entries).await.map_err(mapped)
    }

    async fn read(
        &self,
        file: &str,
        after: Version,
        upto: Version,
        limit: usize,
    ) -> Result<Vec<JournalEntry>, JournalError> {
        let rows = self
            .journal
            .tail(file, after, limit)
            .await
            .map_err(mapped)?;
        let mut out = Vec::with_capacity(rows.len());
        for row in rows {
            if row.version > upto {
                break;
            }
            let body = match ops::decode(&row.body).map_err(unavailable)? {
                Op::Patch(patch) => EntryBody::Patch(Arc::new(*patch)),
                Op::Replace(document) => EntryBody::Replace(Arc::new(document.to_model())),
                // A store entry replays only on the store: stop here (the client reloads).
                Op::Entry(_) => break,
            };
            out.push(JournalEntry {
                version: row.version,
                user: row.user_id.unwrap_or_default(),
                connection: None,
                client: row.client.as_ref().map(|c| ClientId(c.id.clone())),
                seq: row.client.as_ref().map(|c| c.seq),
                body,
            });
        }
        Ok(out)
    }

    async fn find_client_op(
        &self,
        file: &str,
        client: &ClientId,
        seq: Seq,
    ) -> Result<Option<Version>, JournalError> {
        self.journal
            .find_client_op(file, &client.0, seq)
            .await
            .map_err(mapped)
    }

    async fn checkpoint(
        &self,
        file: &str,
        fence: u64,
        version: Version,
        document: Arc<DesignDocument>,
    ) -> Result<(), JournalError> {
        let stored = tokio::task::spawn_blocking(move || Document::from_model(&document))
            .await
            .map_err(unavailable)?;
        self.checkpoint_store(file, fence, version, Arc::new(stored))
            .await
    }

    fn serves_checkpoints(&self) -> bool {
        true
    }

    fn backlogged(&self) -> bool {
        self.journal.backlogged()
    }

    fn queue_budget(&self) -> usize {
        self.journal.queue_budget()
    }

    async fn checkpoint_store(
        &self,
        file: &str,
        fence: u64,
        version: Version,
        stored: Arc<Document>,
    ) -> Result<(), JournalError> {
        // api's accounting of the file (its JSON's bytes): from the snapshot, off the actor's thread.
        let snapshot = Arc::clone(&stored);
        let stats = tokio::task::spawn_blocking(move || FileStats::of(&snapshot.to_model()))
            .await
            .map_err(unavailable)?;
        // The checkpoint's pictures are listed before it is recorded (LIST_PICTURES); no record without them.
        {
            let mut conn = self.stats.lock().await;
            let fence = fence as i64;
            if let Err(error) = conn
                .execute(LIST_PICTURES, &[&file, &fence, &stats.image_files])
                .await
            {
                conn.reset();
                return Err(unavailable(error));
            }
        }
        self.checkpoints
            .write(file, fence, version, stored)
            .await
            .map_err(unavailable)?;
        if !self.stats_delay.is_zero() {
            tokio::time::sleep(self.stats_delay).await;
        }
        {
            let mut conn = self.stats.lock().await;
            let (fence, version) = (fence as i64, version as i64);
            if let Err(error) = conn
                .execute(
                    RECORD_STATS,
                    &[
                        &file,
                        &fence,
                        &stats.bytes,
                        &stats.node_count,
                        &stats.image_files,
                        &version,
                    ],
                )
                .await
            {
                // The checkpoint stands; the next one writes them again.
                conn.reset();
                tracing::warn!(file, %error, "file stats not recorded");
            }
        }
        // Rows the checkpoint covers go, but a tail stays for re-sent ops and catch-ups (as the actor's tail).
        self.journal
            .prune_below(file, version, KEEP_ROWS)
            .await
            .map_err(mapped)?;
        Ok(())
    }
}

/// Journal rows kept behind the newest after a checkpoint: as many as an actor's tail holds.
const KEEP_ROWS: u64 = crate::catchup::TAIL_MAX_ENTRIES as u64;

/// The lease over `design_files.collab_node, lease_until, fence` (migration 012).
pub struct PgLeases(pub PgLease);

#[async_trait]
impl Lease for PgLeases {
    async fn acquire(&self, file: &str, node: &str) -> Result<u64, LeaseError> {
        match self.0.acquire(file, node, LEASE_TTL).await {
            Ok(Some(grant)) => Ok(grant.fence),
            Ok(None) => Err(LeaseError::Held {
                node: String::new(),
            }),
            Err(error) => Err(LeaseError::Unavailable(lease_error(error))),
        }
    }

    async fn renew(&self, file: &str, node: &str, fence: u64) -> Result<bool, LeaseError> {
        match self.0.renew(file, node, fence, LEASE_TTL).await {
            Ok(held) => Ok(held.is_some()),
            Err(error) => Err(LeaseError::Unavailable(lease_error(error))),
        }
    }

    async fn release(&self, file: &str, node: &str, fence: u64) {
        if let Err(error) = self.0.release(file, node, fence).await {
            tracing::warn!(file, %error, "lease not released (it runs out on its own)");
        }
    }
}

fn lease_error(error: PgLeaseError) -> String {
    error.to_string()
}

/// One `design_acl` notification (server/design/collab/acl-push.ts): `{file, user, role|null, node}`.
#[derive(serde::Deserialize)]
struct AclNotice {
    file: String,
    user: String,
    role: Option<morfa_protocol::Role>,
    #[serde(default)]
    node: Option<String>,
}

/// What a `design_acl` payload asks of this node: `(file, user, role)` when it names an open file of `node`.
pub fn acl_notice(
    payload: &str,
    node: &str,
) -> Option<(String, String, Option<morfa_protocol::Role>)> {
    let notice: AclNotice = serde_json::from_str(payload).ok()?;
    if notice.node.as_deref().is_some_and(|n| n != node) {
        return None;
    }
    Some((notice.file, notice.user, notice.role))
}

/// `LISTEN design_acl` for as long as the node runs: each notice for a file this node has open goes to its actor
/// as a role change (the same message as `POST /internal/acl`; a repeat changes nothing). A broken connection is
/// opened again after 1, 2, 4 … 30 s; what was announced meanwhile is still caught by the 20 s re-validation.
pub async fn listen_acl(url: String, app: crate::App) {
    use futures_util::StreamExt;
    use tokio_postgres::AsyncMessage;
    let mut backoff = std::time::Duration::from_secs(1);
    loop {
        match tokio_postgres::connect(&url, tokio_postgres::NoTls).await {
            Ok((client, mut connection)) => {
                let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
                let driver = tokio::spawn(async move {
                    let mut messages =
                        futures_util::stream::poll_fn(move |cx| connection.poll_message(cx));
                    while let Some(message) = messages.next().await {
                        match message {
                            Ok(AsyncMessage::Notification(n)) => {
                                if tx.send(n.payload().to_owned()).is_err() {
                                    break;
                                }
                            }
                            Ok(_) => {}
                            Err(error) => {
                                tracing::warn!(%error, "design_acl connection broke");
                                break;
                            }
                        }
                    }
                });
                match client.batch_execute("LISTEN design_acl").await {
                    Ok(()) => {
                        tracing::info!("listening on design_acl");
                        backoff = std::time::Duration::from_secs(1);
                        while let Some(payload) = rx.recv().await {
                            let Some((file, user, role)) =
                                acl_notice(&payload, &app.shared.config.node)
                            else {
                                continue;
                            };
                            if let Some(actor) = app.docs.get(&file) {
                                let _ =
                                    actor.send(crate::actor::ActorMsg::Acl { user, role }).await;
                            }
                        }
                    }
                    Err(error) => tracing::warn!(%error, "LISTEN design_acl failed"),
                }
                driver.abort();
                drop(client);
            }
            Err(error) => tracing::warn!(%error, "design_acl: no connection"),
        }
        tokio::time::sleep(backoff).await;
        backoff = (backoff * 2).min(std::time::Duration::from_secs(30));
    }
}
