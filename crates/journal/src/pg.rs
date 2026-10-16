//! [`PgJournal`]: the journal in PostgreSQL, group-committed.
//!
//! Ops are routed to a shard by file (so one file's ops commit in order, one statement after another) and each shard
//! owns one connection. A shard flushes what it holds at most once per `flush_interval`, and at once when it was idle
//! longer than that: an op on a quiet node waits only for its own commit, and under load one statement carries up
//! to `max_batch_ops` ops. The statement (one round trip, its own transaction):
//!
//! 1. takes the row lock of every file in the batch **under the fence the rows carry** (`UPDATE design_files … WHERE
//!    fence = $fence`), moving `design_files.version` to the batch's newest version — only for a file whose rows
//!    leave no hole: they are consecutive, the first continues `design_files.version` (or repeats committed rows),
//!    and none would be skipped for holding another op's version or client sequence. A file that fails this
//!    writes nothing, so a version is never committed (and acked) above a missing one;
//! 2. inserts the rows of the files it locked, `ON CONFLICT DO NOTHING` (only rows already committed by an earlier
//!    attempt are skipped), and returns what it inserted.
//!
//! A row that did not come back is explained by a second query: already there with the same fence, sender and size
//! (a retry after a commit whose answer was lost) is a success; a file whose fence moved is [`JournalError::Fenced`];
//! a row of a refused file that is not there is tried again on its own, in version order (the ops below the
//! offending one commit); anything else is [`JournalError::Conflict`]. Connection errors are retried with backoff for `retry_for` (TARGETS
//! D3: acks pause, nothing acked is lost), then the batch fails with [`JournalError::Unavailable`] and the actor rolls
//! the peers back. A statement refused for its data (a bound of the table) is retried op by op, so one bad op never
//! fails the others.

use crate::conn::{Conn, refused_for_data};
use crate::packed;
use crate::traits::{Body, ClientOp, Entry, Journal, JournalError, Row};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, OwnedSemaphorePermit, Semaphore, mpsc, oneshot};

/// How the journal batches and how long it keeps trying.
#[derive(Debug, Clone)]
pub struct Config {
    /// A libpq-style connection string or `postgresql://` URL.
    pub url: String,
    /// Shards (connections that commit in parallel); a file always goes to the same shard.
    pub shards: usize,
    /// At most this many ops per statement.
    pub max_batch_ops: usize,
    /// At most one statement per shard this often (the batching window under load). 1 ms: the best p50/p99 of
    /// the D1 bench at 2 000 editors; an idle shard flushes at once.
    pub flush_interval: Duration,
    /// Bytes of ops waiting for their commit, per journal (node); over it `append` answers `Overloaded`.
    pub max_queued_bytes: usize,
    /// How long a batch is retried while PostgreSQL is unreachable before its ops fail (TARGETS D3: a 30 s outage
    /// pauses acks; the queue's byte budget bounds what waits, and callers stop taking ops near it).
    pub retry_for: Duration,
    /// Connections for `tail`, `find_client_op` and `prune_below`.
    pub readers: usize,
}

impl Config {
    pub fn new(url: impl Into<String>) -> Self {
        Config {
            url: url.into(),
            shards: 2,
            max_batch_ops: 256,
            flush_interval: Duration::from_millis(1),
            max_queued_bytes: 64 << 20,
            retry_for: Duration::from_secs(120),
            readers: 2,
        }
    }
}

/// Counters of a journal since it started.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Stats {
    /// Statements that committed ops.
    pub batches: u64,
    /// Ops committed.
    pub ops: u64,
    /// The largest batch.
    pub max_batch: u64,
    /// Time spent in committing statements (microseconds).
    pub commit_us: u64,
    /// Statements retried after a connection error.
    pub retries: u64,
}

#[derive(Default)]
struct Counters {
    batches: AtomicU64,
    ops: AtomicU64,
    max_batch: AtomicU64,
    commit_us: AtomicU64,
    retries: AtomicU64,
}

/// One answer: a single op, or a batch of one file's consecutive ops that commits whole or not at all (never split
/// across statements).
struct Job {
    entries: Vec<Entry>,
    done: oneshot::Sender<Result<(), JournalError>>,
    _bytes: OwnedSemaphorePermit,
}

/// The journal of one collab node.
pub struct PgJournal {
    shards: Vec<mpsc::UnboundedSender<Job>>,
    budget: Arc<Semaphore>,
    budget_permits: usize,
    readers: Vec<Mutex<Conn>>,
    next_reader: AtomicU64,
    counters: Arc<Counters>,
}

const INSERT: &str = "WITH r AS (
  SELECT * FROM unnest($1::text[],$2::int8[],$3::int8[],$4::text[],$5::int8[],$6::text[],$7::bytea[],$8::text[])
    AS r(file_id,version,fence,client_id,client_seq,user_id,op,patch)
), clash AS (
  SELECT DISTINCT r.file_id FROM r
   WHERE EXISTS (SELECT 1 FROM public.design_file_changes c WHERE c.file_id=r.file_id AND c.version=r.version
                    AND (c.fence IS DISTINCT FROM r.fence OR c.client_id IS DISTINCT FROM r.client_id
                         OR c.client_seq IS DISTINCT FROM r.client_seq
                         OR octet_length(coalesce(c.op,convert_to(c.patch,'UTF8')))
                            <>octet_length(coalesce(r.op,convert_to(r.patch,'UTF8')))))
      OR (r.client_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.design_file_changes c WHERE c.file_id=r.file_id AND c.client_id=r.client_id
               AND c.client_seq=r.client_seq AND c.version<>r.version
            UNION ALL
            SELECT 1 FROM r r2 WHERE r2.file_id=r.file_id AND r2.client_id=r.client_id
               AND r2.client_seq=r.client_seq AND r2.version<>r.version))
), m AS (
  SELECT file_id,fence,min(version) AS low,max(version) AS top,count(DISTINCT version) AS n,count(*) AS rows
    FROM r GROUP BY file_id,fence
), owned AS (
  UPDATE public.design_files f
     SET version=greatest(f.version,m.top),
         updated_at=CASE WHEN f.updated_at<clock_timestamp()-interval '60 seconds' THEN clock_timestamp() ELSE f.updated_at END
    FROM m WHERE f.id=m.file_id AND f.fence=m.fence
     AND f.version>=m.low-1 AND m.n=m.top-m.low+1 AND m.rows=m.n
     AND NOT EXISTS (SELECT 1 FROM clash WHERE clash.file_id=m.file_id)
  RETURNING f.id,f.fence
)
INSERT INTO public.design_file_changes(file_id,version,fence,client_id,client_seq,user_id,op,patch)
SELECT r.file_id,r.version,r.fence,r.client_id,r.client_seq,r.user_id,r.op,r.patch
  FROM r JOIN owned o ON o.id=r.file_id AND o.fence=r.fence
ON CONFLICT DO NOTHING
RETURNING file_id,version";

/// [`INSERT`] with the version counter in `design_file_heads` (migration 016; [`version_heads`]). The file's row is
/// only locked under the fence (`FOR SHARE`: a new owner's lease, an UPDATE, still waits for the commit in flight)
/// instead of updated: the UPDATE of the wide `design_files` row re-evaluated its 22 CHECK constraints and wrote a new
/// row version on every commit. The hole check reads the file's version as the greater of the two counters;
/// `updated_at` is still touched at most once a minute.
const INSERT_HEADS: &str = "WITH r AS (
  SELECT * FROM unnest($1::text[],$2::int8[],$3::int8[],$4::text[],$5::int8[],$6::text[],$7::bytea[],$8::text[])
    AS r(file_id,version,fence,client_id,client_seq,user_id,op,patch)
), clash AS (
  SELECT DISTINCT r.file_id FROM r
   WHERE EXISTS (SELECT 1 FROM public.design_file_changes c WHERE c.file_id=r.file_id AND c.version=r.version
                    AND (c.fence IS DISTINCT FROM r.fence OR c.client_id IS DISTINCT FROM r.client_id
                         OR c.client_seq IS DISTINCT FROM r.client_seq
                         OR octet_length(coalesce(c.op,convert_to(c.patch,'UTF8')))
                            <>octet_length(coalesce(r.op,convert_to(r.patch,'UTF8')))))
      OR (r.client_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM public.design_file_changes c WHERE c.file_id=r.file_id AND c.client_id=r.client_id
               AND c.client_seq=r.client_seq AND c.version<>r.version
            UNION ALL
            SELECT 1 FROM r r2 WHERE r2.file_id=r.file_id AND r2.client_id=r.client_id
               AND r2.client_seq=r.client_seq AND r2.version<>r.version))
), m AS (
  SELECT file_id,fence,min(version) AS low,max(version) AS top,count(DISTINCT version) AS n,count(*) AS rows
    FROM r GROUP BY file_id,fence
), owned AS (
  SELECT f.id,f.fence FROM public.design_files f JOIN m ON f.id=m.file_id AND f.fence=m.fence
    LEFT JOIN public.design_file_heads h ON h.file_id=f.id
   WHERE greatest(f.version,coalesce(h.version,0))>=m.low-1 AND m.n=m.top-m.low+1 AND m.rows=m.n
     AND NOT EXISTS (SELECT 1 FROM clash WHERE clash.file_id=m.file_id)
   FOR SHARE OF f
), bump AS (
  INSERT INTO public.design_file_heads(file_id,version) SELECT o.id,m.top FROM owned o JOIN m ON m.file_id=o.id AND m.fence=o.fence
  ON CONFLICT (file_id) DO UPDATE SET version=greatest(public.design_file_heads.version,EXCLUDED.version)
), touched AS (
  UPDATE public.design_files f SET updated_at=clock_timestamp()
    FROM owned o WHERE f.id=o.id AND f.updated_at<clock_timestamp()-interval '60 seconds'
)
INSERT INTO public.design_file_changes(file_id,version,fence,client_id,client_seq,user_id,op,patch)
SELECT r.file_id,r.version,r.fence,r.client_id,r.client_seq,r.user_id,r.op,r.patch
  FROM r JOIN owned o ON o.id=r.file_id AND o.fence=r.fence
ON CONFLICT DO NOTHING
RETURNING file_id,version";

const EXPLAIN: &str = "SELECT r.file_id,r.version,c.fence,c.client_id,c.client_seq,
  octet_length(coalesce(c.op,convert_to(c.patch,'UTF8')))::int8 AS bytes,f.fence AS current
FROM unnest($1::text[],$2::int8[]) AS r(file_id,version)
LEFT JOIN public.design_file_changes c ON c.file_id=r.file_id AND c.version=r.version
LEFT JOIN public.design_files f ON f.id=r.file_id";

const TAIL: &str =
    "SELECT version,fence,client_id,client_seq,user_id,op,patch FROM public.design_file_changes
WHERE file_id=$1 AND version>$2 ORDER BY version LIMIT $3";

const FIND_CLIENT_OP: &str = "SELECT version FROM public.design_file_changes WHERE file_id=$1 AND client_id=$2 AND client_seq=$3";

const PRUNE: &str = "DELETE FROM public.design_file_changes WHERE file_id=$1 AND version<=least($2,
  (SELECT max(version) FROM public.design_file_changes WHERE file_id=$1)-$3)";

/// Whether this process keeps the journal's version counter in `design_file_heads` (migration 016):
/// `MORFA_JOURNAL_VERSION_HEADS=1`. Off by default. Every reader of the file's version must read
/// `greatest(design_files.version, design_file_heads.version)` before a node runs with it on; crates/checkpoint's cold load and record do.
pub fn version_heads() -> bool {
    static ON: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *ON.get_or_init(|| std::env::var("MORFA_JOURNAL_VERSION_HEADS").as_deref() == Ok("1"))
}

fn int(value: u64) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn uint(value: i64) -> u64 {
    u64::try_from(value).unwrap_or(0)
}

impl PgJournal {
    /// Starts the shards (connections open on first use). Must be called inside a tokio runtime.
    pub fn start(config: Config) -> Self {
        let counters = Arc::new(Counters::default());
        let shards = (0..config.shards.max(1))
            .map(|_| {
                let (sender, receiver) = mpsc::unbounded_channel();
                tokio::spawn(run_shard(receiver, config.clone(), counters.clone()));
                sender
            })
            .collect();
        let budget_permits = config.max_queued_bytes.min(Semaphore::MAX_PERMITS);
        PgJournal {
            shards,
            budget: Arc::new(Semaphore::new(budget_permits)),
            budget_permits,
            readers: (0..config.readers.max(1))
                .map(|_| Mutex::new(Conn::new(&config.url)))
                .collect(),
            next_reader: AtomicU64::new(0),
            counters,
        }
    }

    /// `max_queued_bytes`: what may wait for its commit.
    pub fn queue_budget(&self) -> usize {
        self.budget_permits
    }

    /// Bytes of ops waiting for their commit (TARGETS D3: what an outage holds in memory).
    pub fn queued_bytes(&self) -> usize {
        self.budget_permits
            .saturating_sub(self.budget.available_permits())
    }

    /// Whether the queue holds more than seven eighths of `max_queued_bytes`: new ops should wait (an append past
    /// the budget fails with [`JournalError::Overloaded`]).
    pub fn backlogged(&self) -> bool {
        self.queued_bytes() > self.budget_permits / 8 * 7
    }

    pub fn stats(&self) -> Stats {
        let c = &self.counters;
        Stats {
            batches: c.batches.load(Ordering::Relaxed),
            ops: c.ops.load(Ordering::Relaxed),
            max_batch: c.max_batch.load(Ordering::Relaxed),
            commit_us: c.commit_us.load(Ordering::Relaxed),
            retries: c.retries.load(Ordering::Relaxed),
        }
    }

    /// [`Journal::append`] with the op queued now, not when the answer is first awaited: ops of one file submitted
    /// one after another commit in that order even when their answers are awaited on different tasks (a pipelining
    /// caller spawns them). The statement refuses a batch that would leave a hole below it anyway
    /// ([`JournalError::Conflict`]), so out-of-order appends fail instead of being acked over a gap.
    pub fn submit(
        &self,
        entry: Entry,
    ) -> impl std::future::Future<Output = Result<(), JournalError>> + Send + 'static {
        self.submit_batch(vec![entry])
    }

    /// Consecutive ops of one file as one unit: all are journaled or none (B1's `Journal::commit`). Queued now,
    /// like [`PgJournal::submit`]; never split across statements, so the answer is one result for the whole batch.
    pub fn submit_batch(
        &self,
        entries: Vec<Entry>,
    ) -> impl std::future::Future<Output = Result<(), JournalError>> + Send + 'static {
        let queued = self.queue(entries);
        async move { queued?.await.unwrap_or(Err(JournalError::Closed)) }
    }

    /// [`PgJournal::submit_batch`], awaited.
    pub async fn append_batch(&self, entries: Vec<Entry>) -> Result<(), JournalError> {
        self.submit_batch(entries).await
    }

    fn queue(
        &self,
        mut entries: Vec<Entry>,
    ) -> Result<oneshot::Receiver<Result<(), JournalError>>, JournalError> {
        // Packed on the caller's thread (shards stay free for statements); the row stores what the job carries.
        for entry in &mut entries {
            entry.body = packed::pack(std::mem::replace(&mut entry.body, Body::Op(Vec::new())));
        }
        let Some(first) = entries.first() else {
            return Err(JournalError::Invalid("an empty batch".into()));
        };
        if entries.iter().any(|entry| entry.body.is_empty()) {
            return Err(JournalError::Invalid("an op has bytes".into()));
        }
        let consecutive = entries.iter().enumerate().all(|(k, entry)| {
            entry.file == first.file
                && entry.fence == first.fence
                && entry.version == first.version + k as u64
        });
        if !consecutive {
            return Err(JournalError::Invalid(
                "a batch is consecutive versions of one file under one fence".into(),
            ));
        }
        let cost = entries
            .iter()
            .map(|entry| entry.body.len() + 256)
            .sum::<usize>();
        let permit = self
            .budget
            .clone()
            .try_acquire_many_owned(u32::try_from(cost).unwrap_or(u32::MAX))
            .map_err(|_| JournalError::Overloaded)?;
        let (done, answer) = oneshot::channel();
        self.shards[self.shard_of(&first.file)]
            .send(Job {
                entries,
                done,
                _bytes: permit,
            })
            .map_err(|_| JournalError::Closed)?;
        Ok(answer)
    }

    fn shard_of(&self, file: &str) -> usize {
        // FNV-1a: stable across processes (a file keeps its shard for the life of the node).
        let hash = file.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| {
            (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
        });
        (hash % self.shards.len() as u64) as usize
    }

    fn reader(&self) -> &Mutex<Conn> {
        let k = self.next_reader.fetch_add(1, Ordering::Relaxed) as usize;
        &self.readers[k % self.readers.len()]
    }

    async fn read<T>(
        &self,
        work: impl AsyncFnOnce(&mut Conn) -> Result<T, tokio_postgres::Error>,
    ) -> Result<T, JournalError> {
        let mut conn = self.reader().lock().await;
        match work(&mut conn).await {
            Ok(value) => Ok(value),
            Err(error) => {
                if !refused_for_data(&error) {
                    conn.reset();
                }
                Err(JournalError::Unavailable(error.to_string()))
            }
        }
    }
}

impl Journal for PgJournal {
    async fn append(&self, entry: Entry) -> Result<(), JournalError> {
        self.submit(entry).await
    }

    async fn tail(&self, file: &str, since: u64, limit: usize) -> Result<Vec<Row>, JournalError> {
        let (since, limit) = (int(since), int(limit as u64));
        let rows = self
            .read(async |conn| conn.query(TAIL, &[&file, &since, &limit]).await)
            .await?;
        rows.into_iter().map(row_of).collect()
    }

    async fn find_client_op(
        &self,
        file: &str,
        client_id: &str,
        seq: u64,
    ) -> Result<Option<u64>, JournalError> {
        let seq = int(seq);
        let rows = self
            .read(async |conn| conn.query(FIND_CLIENT_OP, &[&file, &client_id, &seq]).await)
            .await?;
        Ok(rows.first().map(|row| uint(row.get(0))))
    }

    async fn prune_below(&self, file: &str, version: u64, keep: u64) -> Result<u64, JournalError> {
        let (version, keep) = (int(version), int(keep));
        self.read(async |conn| conn.execute(PRUNE, &[&file, &version, &keep]).await)
            .await
    }
}

fn row_of(row: tokio_postgres::Row) -> Result<Row, JournalError> {
    let op: Option<Vec<u8>> = row.get("op");
    let patch: Option<String> = row.get("patch");
    let client_id: Option<String> = row.get("client_id");
    let client_seq: Option<i64> = row.get("client_seq");
    let body = match (op, patch) {
        (Some(op), None) => Body::Op(op),
        (None, Some(patch)) => Body::Patch(patch),
        _ => return Err(JournalError::Invalid("a row holds one body".into())),
    };
    Ok(Row {
        version: uint(row.get("version")),
        fence: row.get::<_, Option<i64>>("fence").map(uint),
        client: client_id.zip(client_seq).map(|(id, seq)| ClientOp {
            id: id.into(),
            seq: uint(seq),
        }),
        user_id: row.get("user_id"),
        body,
    })
}

async fn run_shard(
    mut inbox: mpsc::UnboundedReceiver<Job>,
    config: Config,
    counters: Arc<Counters>,
) {
    // The append statement's custom plans (PostgreSQL's default for its first five runs and whenever they look
    // cheaper, which they do for array parameters) re-plan the whole CTE on every batch: 18 % of PostgreSQL's
    // CPU at 2 000 editors (D1). The generic plan is all index scans, like the custom ones.
    let mut conn = Conn::new(&config.url).with_setup("SET plan_cache_mode = force_generic_plan");
    let mut held: Vec<Job> = Vec::new();
    let mut last_flush = Instant::now() - config.flush_interval;
    let mut open = true;
    while open || !held.is_empty() {
        if held.is_empty() {
            match inbox.recv().await {
                Some(job) => held.push(job),
                None => break,
            }
        }
        // Collect until the shard may flush again (at once when it was idle), or the batch is full.
        let due = last_flush + config.flush_interval;
        while held.len() < config.max_batch_ops {
            match inbox.try_recv() {
                Ok(job) => {
                    held.push(job);
                    continue;
                }
                Err(mpsc::error::TryRecvError::Disconnected) => {
                    open = false;
                    break;
                }
                Err(mpsc::error::TryRecvError::Empty) => {}
            }
            if Instant::now() >= due {
                break;
            }
            match tokio::time::timeout_at(due.into(), inbox.recv()).await {
                Ok(Some(job)) => held.push(job),
                Ok(None) => {
                    open = false;
                    break;
                }
                Err(_) => break,
            }
        }
        last_flush = Instant::now();
        // Whole jobs up to `max_batch_ops` ops (a larger job goes alone).
        let mut take = 0;
        let mut ops = 0;
        while take < held.len()
            && (take == 0 || ops + held[take].entries.len() <= config.max_batch_ops)
        {
            ops += held[take].entries.len();
            take += 1;
        }
        let batch: Vec<Job> = held.drain(..take).collect();
        flush(&mut conn, batch, &config, &counters).await;
    }
}

/// The arrays of one statement.
struct Columns<'a> {
    file: Vec<&'a str>,
    version: Vec<i64>,
    fence: Vec<i64>,
    client_id: Vec<Option<&'a str>>,
    client_seq: Vec<Option<i64>>,
    user_id: Vec<Option<&'a str>>,
    op: Vec<Option<&'a [u8]>>,
    patch: Vec<Option<&'a str>>,
}

impl<'a> Columns<'a> {
    fn of(jobs: &'a [Job]) -> Self {
        let entries = jobs.iter().flat_map(|job| &job.entries);
        Columns {
            file: entries.clone().map(|e| &*e.file).collect(),
            version: entries.clone().map(|e| int(e.version)).collect(),
            fence: entries.clone().map(|e| int(e.fence)).collect(),
            client_id: entries
                .clone()
                .map(|e| e.client.as_ref().map(|c| &*c.id))
                .collect(),
            client_seq: entries
                .clone()
                .map(|e| e.client.as_ref().map(|c| int(c.seq)))
                .collect(),
            user_id: entries.clone().map(|e| e.user_id.as_deref()).collect(),
            op: entries
                .clone()
                .map(|e| match &e.body {
                    Body::Op(bytes) => Some(bytes.as_slice()),
                    Body::Patch(_) => None,
                })
                .collect(),
            patch: entries
                .map(|e| match &e.body {
                    Body::Op(_) => None,
                    Body::Patch(text) => Some(text.as_str()),
                })
                .collect(),
        }
    }
}

async fn insert(
    conn: &mut Conn,
    jobs: &[Job],
) -> Result<HashSet<(String, u64)>, tokio_postgres::Error> {
    let c = Columns::of(jobs);
    let statement = if version_heads() {
        INSERT_HEADS
    } else {
        INSERT
    };
    let rows = conn
        .query(
            statement,
            &[
                &c.file,
                &c.version,
                &c.fence,
                &c.client_id,
                &c.client_seq,
                &c.user_id,
                &c.op,
                &c.patch,
            ],
        )
        .await?;
    Ok(rows
        .into_iter()
        .map(|row| (row.get::<_, String>(0), uint(row.get(1))))
        .collect())
}

async fn flush(conn: &mut Conn, jobs: Vec<Job>, config: &Config, counters: &Counters) {
    if jobs.is_empty() {
        return;
    }
    let deadline = Instant::now() + config.retry_for;
    let mut attempt = 0u32;
    loop {
        let started = Instant::now();
        match insert(conn, &jobs).await {
            Ok(inserted) => {
                let n = inserted.len() as u64;
                counters.batches.fetch_add(1, Ordering::Relaxed);
                counters.ops.fetch_add(n, Ordering::Relaxed);
                counters.max_batch.fetch_max(
                    jobs.iter().map(|job| job.entries.len()).sum::<usize>() as u64,
                    Ordering::Relaxed,
                );
                counters
                    .commit_us
                    .fetch_add(started.elapsed().as_micros() as u64, Ordering::Relaxed);
                let single = jobs.len() == 1;
                let refused = settle(conn, jobs, inserted, single).await;
                // Rows of a file refused for another row's sake: one by one, lowest version first.
                for job in refused {
                    Box::pin(flush(conn, vec![job], config, counters)).await;
                }
                return;
            }
            Err(error) if refused_for_data(&error) => {
                if jobs.len() == 1 {
                    let job = jobs.into_iter().next().expect("one job");
                    let answer = if error.code().is_some_and(|code| code.code() == "MRF01") {
                        Err(JournalError::Fenced {
                            file: job.entries[0].file.clone(),
                            current: None,
                        })
                    } else {
                        Err(JournalError::Invalid(error.to_string()))
                    };
                    let _ = job.done.send(answer);
                } else {
                    // One op broke a bound: the others commit on their own.
                    for job in jobs {
                        Box::pin(flush(conn, vec![job], config, counters)).await;
                    }
                }
                return;
            }
            Err(error) => {
                conn.reset();
                counters.retries.fetch_add(1, Ordering::Relaxed);
                if Instant::now() >= deadline {
                    let message = error.to_string();
                    for job in jobs {
                        let _ = job
                            .done
                            .send(Err(JournalError::Unavailable(message.clone())));
                    }
                    return;
                }
                let backoff =
                    Duration::from_millis(5u64 << attempt.min(8)).min(Duration::from_secs(1));
                attempt += 1;
                tokio::time::sleep(backoff.min(deadline.saturating_duration_since(Instant::now())))
                    .await;
            }
        }
    }
}

/// Answers every job: one whose rows were all inserted succeeds, the others are explained by what the table holds
/// now (a job's rows are all inserted or none: the statement writes a file's rows whole). Returns, in version order,
/// the jobs of a statement of several (`!single`) whose rows are absent under a fence that still holds: their file
/// was refused for another job's sake and they are retried alone.
async fn settle(
    conn: &mut Conn,
    jobs: Vec<Job>,
    inserted: HashSet<(String, u64)>,
    single: bool,
) -> Vec<Job> {
    let (done, missing): (Vec<Job>, Vec<Job>) = jobs.into_iter().partition(|job| {
        job.entries
            .iter()
            .all(|e| inserted.contains(&(e.file.to_string(), e.version)))
    });
    for job in done {
        let _ = job.done.send(Ok(()));
    }
    if missing.is_empty() {
        return Vec::new();
    }
    let asked = missing
        .iter()
        .flat_map(|job| &job.entries)
        .filter(|e| !inserted.contains(&(e.file.to_string(), e.version)));
    let files: Vec<&str> = asked.clone().map(|e| &*e.file).collect();
    let versions: Vec<i64> = asked.map(|e| int(e.version)).collect();
    let found = match conn.query(EXPLAIN, &[&files, &versions]).await {
        Ok(rows) => rows,
        Err(error) => {
            conn.reset();
            let message = error.to_string();
            for job in missing {
                let _ = job
                    .done
                    .send(Err(JournalError::Unavailable(message.clone())));
            }
            return Vec::new();
        }
    };
    let by_key: HashMap<(String, u64), tokio_postgres::Row> = found
        .into_iter()
        .map(|row| {
            (
                (row.get::<_, String>("file_id"), uint(row.get("version"))),
                row,
            )
        })
        .collect();
    let mut again = Vec::new();
    'jobs: for job in missing {
        let mut answer = Ok(());
        for e in &job.entries {
            if inserted.contains(&(e.file.to_string(), e.version)) {
                continue;
            }
            let explained = match by_key.get(&(e.file.to_string(), e.version)) {
                Some(row) if !single && absent_under_own_fence(e, row) => {
                    again.push(job);
                    continue 'jobs;
                }
                Some(row) => explain(e, row),
                None => Err(JournalError::Unavailable("row vanished".into())),
            };
            if explained.is_err() {
                answer = explained;
                break;
            }
        }
        let _ = job.done.send(answer);
    }
    again.sort_by_key(|job| job.entries[0].version);
    again
}

/// No row at the entry's version and the file still under the entry's fence.
fn absent_under_own_fence(entry: &Entry, row: &tokio_postgres::Row) -> bool {
    row.get::<_, Option<i64>>("fence").is_none()
        && row.get::<_, Option<i64>>("current") == Some(int(entry.fence))
}

fn explain(entry: &Entry, row: &tokio_postgres::Row) -> Result<(), JournalError> {
    let fence: Option<i64> = row.get("fence");
    let client_id: Option<String> = row.get("client_id");
    let client_seq: Option<i64> = row.get("client_seq");
    let bytes: Option<i64> = row.get("bytes");
    let current: Option<i64> = row.get("current");
    let same_client = match &entry.client {
        Some(client) => {
            client_id.as_deref() == Some(&*client.id) && client_seq == Some(int(client.seq))
        }
        None => client_id.is_none(),
    };
    if fence == Some(int(entry.fence)) && same_client && bytes == Some(entry.body.len() as i64) {
        // Committed by an earlier attempt whose answer was lost.
        return Ok(());
    }
    if current != Some(int(entry.fence)) {
        return Err(JournalError::Fenced {
            file: entry.file.clone(),
            current: current.map(uint),
        });
    }
    Err(JournalError::Conflict {
        file: entry.file.clone(),
        version: entry.version,
    })
}
