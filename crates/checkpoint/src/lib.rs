//! `morfa-checkpoint`: documents checkpointed to object storage, and the cold load (lane B2; docs/BACKEND.md §3,
//! TARGETS D5, S1–S4).
//!
//! [`Checkpoints::write`] runs off the document actor's thread: the actor hands over an `Arc` of the immutable store
//! document (S1's compact layout shares unchanged nodes, so the actor keeps editing), the document is encoded and
//! compressed on a blocking thread ([`format`]), uploaded (multipart when large) with retries, **read back, checked
//! against its hash and decoded again** (TARGETS D5), and only then recorded in `design_files.checkpoint_*` under
//! the owner's fence (a stale owner cannot move the pointer, an older checkpoint never replaces a newer one).
//!
//! [`Checkpoints::load`] is the cold load of a new owner: the checkpoint object and the journal rows above it are
//! fetched at the same time, the checkpoint is decoded on a blocking thread and the rows applied in version order. A
//! file without a checkpoint loads from `design_files.document` and the rows after it, exactly as
//! `server/design/document-store.ts` reads it. Rows are decoded by [`ops`] whatever wrote them.

pub mod format;
pub mod ops;

pub use format::{Format, FormatError, Header};

use morfa_blobs::{Bytes, ObjectStore, StoreError};
use morfa_journal::Body;
use morfa_journal::conn::Conn;
use morfa_model::store::Document;
use std::fmt;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CheckpointError {
    /// Object storage failed after the retries.
    Store(StoreError),
    /// PostgreSQL failed.
    Db(String),
    /// A checkpoint or a row that does not decode, or does not match its hash.
    Format(FormatError),
    /// The file's lease moved: this owner may not record checkpoints any more.
    Fenced,
    /// A newer checkpoint is already recorded (the same version again is accepted: a retried write).
    Stale,
    /// The journal rows after the base are not consecutive.
    Gap { after: u64, found: u64 },
}

impl fmt::Display for CheckpointError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            CheckpointError::Store(error) => error.fmt(f),
            CheckpointError::Db(error) => write!(f, "checkpoint database: {error}"),
            CheckpointError::Format(error) => error.fmt(f),
            CheckpointError::Fenced => f.write_str("the file's lease moved"),
            CheckpointError::Stale => f.write_str("a newer checkpoint is recorded"),
            CheckpointError::Gap { after, found } => {
                write!(f, "journal gap: version {found} follows {after}")
            }
        }
    }
}

impl std::error::Error for CheckpointError {}

impl From<StoreError> for CheckpointError {
    fn from(error: StoreError) -> Self {
        CheckpointError::Store(error)
    }
}

impl From<FormatError> for CheckpointError {
    fn from(error: FormatError) -> Self {
        CheckpointError::Format(error)
    }
}

fn db(error: tokio_postgres::Error) -> CheckpointError {
    CheckpointError::Db(error.to_string())
}

/// A written checkpoint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Written {
    pub key: String,
    pub version: u64,
    pub format: Format,
    /// The object's size (header + compressed payload).
    pub bytes: usize,
    /// Encoding and compression (CPU, on a blocking thread).
    pub encode: Duration,
    pub upload: Duration,
    /// The integrity re-read: download, hash check, decode.
    pub verify: Duration,
}

/// A document loaded cold.
#[derive(Debug)]
pub struct Loaded {
    pub doc: Document,
    pub version: u64,
    /// The checkpoint it started from (`None`: `design_files.document`).
    pub checkpoint_version: Option<u64>,
    /// Journal rows applied on top.
    pub rows: usize,
    /// Fetching the checkpoint and the rows (concurrently), then decoding and applying.
    pub fetch: Duration,
    pub decode: Duration,
}

/// Checkpoints of the files a node owns, in `store`, recorded in PostgreSQL at `url`.
pub struct Checkpoints<S> {
    store: S,
    db: Mutex<Conn>,
    format: Format,
    /// Tries of an upload (and of its integrity check) before `write` gives up.
    pub attempts: u32,
}

const RECORD: &str =
    "UPDATE public.design_files SET checkpoint_key=$3,checkpoint_version=$4,checkpoint_format=$5
 WHERE id=$1 AND fence=$2 AND coalesce(checkpoint_version,0)<=$4 AND version>=$4 RETURNING 1";

/// [`RECORD`] when the journal keeps the version in `design_file_heads` (migration 016,
/// [`morfa_journal::version_heads`]): the file's version is the greater of the two, and the record folds the head back
/// into `design_files.version` (its check keeps a checkpoint at or below it).
const RECORD_HEADS: &str = "UPDATE public.design_files f SET checkpoint_key=$3,checkpoint_version=$4,checkpoint_format=$5,
  version=greatest(f.version,$4)
 WHERE id=$1 AND fence=$2 AND coalesce(checkpoint_version,0)<=$4
   AND greatest(f.version,coalesce((SELECT h.version FROM public.design_file_heads h WHERE h.file_id=f.id),0))>=$4
 RETURNING 1";

const WHY_NOT_RECORDED: &str = "SELECT fence FROM public.design_files WHERE id=$1";

const FILE: &str = "SELECT version,checkpoint_key,checkpoint_version,checkpoint_format,
  CASE WHEN checkpoint_key IS NULL THEN document END AS document
  FROM public.design_files WHERE id=$1";

/// [`FILE`] with the version in `design_file_heads` (migration 016).
const FILE_HEADS: &str = "SELECT greatest(f.version,coalesce(h.version,0)) AS version,f.checkpoint_key,f.checkpoint_version,
  f.checkpoint_format,CASE WHEN f.checkpoint_key IS NULL THEN f.document END AS document
  FROM public.design_files f LEFT JOIN public.design_file_heads h ON h.file_id=f.id WHERE f.id=$1";

const SNAPSHOT: &str = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";

const ROWS: &str = "SELECT version,op,patch FROM public.design_file_changes WHERE file_id=$1 AND version>$2 ORDER BY version";

impl<S: ObjectStore + Clone + 'static> Checkpoints<S> {
    pub fn new(store: S, url: &str, format: Format) -> Self {
        Checkpoints {
            store,
            db: Mutex::new(Conn::new(url)),
            format,
            attempts: 4,
        }
    }

    pub fn format(&self) -> Format {
        self.format
    }

    pub fn store(&self) -> &S {
        &self.store
    }

    /// Writes `doc` (the file at `version`) as a checkpoint, checks it, records it under `fence`.
    pub async fn write(
        &self,
        file: &str,
        fence: u64,
        version: u64,
        doc: Arc<Document>,
    ) -> Result<Written, CheckpointError> {
        let format = self.format;
        let started = Instant::now();
        let object = tokio::task::spawn_blocking(move || format::encode(&doc, version, format))
            .await
            .expect("checkpoint encoder panicked");
        let encode = started.elapsed();
        let object = Bytes::from(object);
        let key = format::key(file, version, format);
        let (mut upload, mut verify) = (Duration::ZERO, Duration::ZERO);
        let mut last = None;
        for attempt in 0..self.attempts.max(1) {
            if attempt > 0 {
                tokio::time::sleep(Duration::from_millis(200 << (attempt - 1).min(5))).await;
            }
            let started = Instant::now();
            if let Err(error) = self
                .store
                .put(&key, object.clone(), "application/octet-stream")
                .await
            {
                last = Some(CheckpointError::Store(error));
                continue;
            }
            upload = started.elapsed();
            let started = Instant::now();
            match self.verify(&key, &object, version).await {
                Ok(()) => {
                    verify = started.elapsed();
                    last = None;
                    break;
                }
                Err(error) => last = Some(error),
            }
        }
        if let Some(error) = last {
            return Err(error);
        }
        self.record(file, fence, version, &key).await?;
        Ok(Written {
            key,
            version,
            format,
            bytes: object.len(),
            encode,
            upload,
            verify,
        })
    }

    /// TARGETS D5: what the store holds now is read back, checked against its hash and decoded.
    async fn verify(&self, key: &str, sent: &Bytes, version: u64) -> Result<(), CheckpointError> {
        let Some(stored) = self.store.get(key).await? else {
            return Err(CheckpointError::Store(StoreError::Damaged(format!(
                "{key} is missing after its upload"
            ))));
        };
        if stored.len() != sent.len() {
            return Err(CheckpointError::Store(StoreError::Damaged(format!(
                "{key}: {} bytes stored, {} sent",
                stored.len(),
                sent.len()
            ))));
        }
        let header =
            tokio::task::spawn_blocking(move || format::decode(&stored).map(|(header, _)| header))
                .await
                .expect("checkpoint decoder panicked")?;
        if header.version != version {
            return Err(CheckpointError::Format(FormatError::Damaged(format!(
                "{key} holds version {}",
                header.version
            ))));
        }
        Ok(())
    }

    async fn record(
        &self,
        file: &str,
        fence: u64,
        version: u64,
        key: &str,
    ) -> Result<(), CheckpointError> {
        let mut conn = self.db.lock().await;
        let (fence, version_param, format) = (fence as i64, version as i64, self.format.name());
        let recorded = conn
            .query(
                if morfa_journal::version_heads() {
                    RECORD_HEADS
                } else {
                    RECORD
                },
                &[&file, &fence, &key, &version_param, &format],
            )
            .await
            .map_err(|error| {
                conn.reset();
                db(error)
            })?;
        if !recorded.is_empty() {
            return Ok(());
        }
        let row = conn.query(WHY_NOT_RECORDED, &[&file]).await.map_err(db)?;
        match row.first().map(|row| row.get::<_, i64>(0)) {
            Some(current) if current == fence => Err(CheckpointError::Stale),
            _ => Err(CheckpointError::Fenced),
        }
    }

    /// A short-lived URL of a checkpoint object for the browser (`snapshotUrl`, TARGETS S2).
    pub fn snapshot_url(&self, key: &str, ttl: Duration) -> Option<String> {
        self.store.presign_get(key, ttl)
    }

    /// The cold load: the file's document at its newest version (`None`: no such file).
    pub async fn load(&self, file: &str) -> Result<Option<Loaded>, CheckpointError> {
        let started = Instant::now();
        let mut conn = self.db.lock().await;
        // The pointer and the rows above it from one snapshot: a stale owner's last checkpoint record and prune can
        // still commit while this runs (a killed process's statement completes on the server), and read apart they
        // would leave a gap between the checkpoint read and the rows left.
        let rows = match conn.batch(SNAPSHOT).await {
            Ok(()) => {
                let file_sql = if morfa_journal::version_heads() {
                    FILE_HEADS
                } else {
                    FILE
                };
                conn.query(file_sql, &[&file]).await
            }
            Err(error) => Err(error),
        }
        .map_err(|error| {
            conn.reset();
            db(error)
        })?;
        let Some(row) = rows.first() else {
            conn.batch("COMMIT").await.map_err(|error| {
                conn.reset();
                db(error)
            })?;
            return Ok(None);
        };
        let file_version = row.get::<_, i64>("version") as u64;
        let checkpoint: Option<(String, u64)> = row
            .get::<_, Option<String>>("checkpoint_key")
            .zip(row.get::<_, Option<i64>>("checkpoint_version"))
            .map(|(key, version)| (key, version as u64));
        let text: Option<String> = row.get("document");
        let after = checkpoint
            .as_ref()
            .map_or(0, |(_, version)| *version as i64);
        // The checkpoint object and the rows above it, at the same time.
        let object = async {
            match &checkpoint {
                Some((key, _)) => self.store.get(key).await,
                None => Ok(None),
            }
        };
        let params: [&(dyn tokio_postgres::types::ToSql + Sync); 2] = [&file, &after];
        let (object, journal) = tokio::join!(object, conn.query(ROWS, &params));
        let journal = match journal {
            Ok(rows) => conn.batch("COMMIT").await.map(|()| rows),
            Err(error) => Err(error),
        }
        .map_err(|error| {
            conn.reset();
            db(error)
        })?;
        drop(conn);
        let object = object?;
        let fetch = started.elapsed();
        let mut bodies = Vec::with_capacity(journal.len());
        for row in journal {
            let version = row.get::<_, i64>("version") as u64;
            let body = match (
                row.get::<_, Option<Vec<u8>>>("op"),
                row.get::<_, Option<String>>("patch"),
            ) {
                (Some(op), _) => Body::Op(op),
                (None, Some(patch)) => Body::Patch(patch),
                (None, None) => {
                    return Err(CheckpointError::Format(FormatError::Payload(format!(
                        "row {version} has no body"
                    ))));
                }
            };
            bodies.push((version, body));
        }
        let base_version = match &checkpoint {
            Some((key, version)) => {
                if object.is_none() {
                    return Err(CheckpointError::Store(StoreError::Damaged(format!(
                        "{key} is missing"
                    ))));
                }
                *version
            }
            // document-store.ts: the stored text is the version right before the rows.
            None => file_version.saturating_sub(bodies.len() as u64),
        };
        let started = Instant::now();
        let (doc, version) =
            tokio::task::spawn_blocking(move || -> Result<(Document, u64), CheckpointError> {
                let mut doc = match (object, text) {
                    (Some(object), _) => {
                        let (header, doc) = format::decode(&object)?;
                        if header.version != base_version {
                            return Err(FormatError::Damaged(format!(
                                "checkpoint of version {}, recorded as {base_version}",
                                header.version
                            ))
                            .into());
                        }
                        doc
                    }
                    (None, Some(text)) => Document::from_model(
                        &morfa_model::from_json(&text)
                            .map_err(|error| FormatError::Payload(error.to_string()))?,
                    ),
                    (None, None) => {
                        return Err(FormatError::Payload(
                            "the file has neither a checkpoint nor a document".into(),
                        )
                        .into());
                    }
                };
                let mut version = base_version;
                for (row_version, body) in bodies {
                    if row_version != version + 1 {
                        return Err(CheckpointError::Gap {
                            after: version,
                            found: row_version,
                        });
                    }
                    ops::apply(&mut doc, ops::decode(&body)?)?;
                    version = row_version;
                }
                Ok((doc, version))
            })
            .await
            .expect("cold load panicked")?;
        let rows = (version - base_version) as usize;
        Ok(Some(Loaded {
            doc,
            version,
            checkpoint_version: checkpoint.map(|(_, version)| version),
            rows,
            fetch,
            decode: started.elapsed(),
        }))
    }
}
