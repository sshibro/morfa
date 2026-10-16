//! `morfa-lease`: one owner per document (lane B2; docs/BACKEND.md §2 "Routing and the lease", §8 "Split brain").
//!
//! The lease lives in `design_files` (migration 012): `collab_node`, `lease_until` and `fence`. Taking a file moves
//! its fence up by one, always, so every owner the file ever had holds a different, larger fence than the one before;
//! the journal writes each row under its owner's fence and PostgreSQL refuses rows under an older one (crates/journal,
//! the migration's trigger). Time is the database's (`clock_timestamp()`): nodes need no synchronised clocks. A
//! grant's local deadline is measured from before the request left, so it ends no later than the database's lease.
//!
//! [`PgLease`] implements the [`Lease`] trait (acquire, renew, release). [`Keeper`] is what a collab node runs: it
//! holds the node's leases and renews all of them in one statement every `renew_every`; each [`Held`] lease tells
//! its document actor when it was lost (another owner took the file: close with `bye {moved}`) or ran out without a
//! renewal (PostgreSQL unreachable for a whole TTL: stop serving, the journal could not take the ops anyway).

mod keeper;

pub use keeper::{Held, Keeper, LeaseState};
pub use morfa_journal::{Grant, Lease, LeaseError};

use morfa_journal::conn::Conn;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

/// Who holds a file now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Holder {
    pub node: Option<String>,
    pub fence: u64,
    /// Whether the holder's lease is still running (by the database's clock).
    pub live: bool,
}

/// The lease table, over one connection (lease calls are rare: once per open, once per renewal round).
pub struct PgLease {
    conn: Mutex<Conn>,
}

const ACQUIRE: &str = "UPDATE public.design_files
   SET collab_node=$2,lease_until=clock_timestamp()+$3::float8*interval '1 millisecond',fence=fence+1
 WHERE id=$1 AND (collab_node IS NULL OR lease_until<clock_timestamp() OR collab_node=$2)
 RETURNING fence";

const RENEW: &str = "UPDATE public.design_files SET lease_until=clock_timestamp()+$4::float8*interval '1 millisecond'
 WHERE id=$1 AND collab_node=$2 AND fence=$3 RETURNING fence";

const RENEW_ALL: &str = "UPDATE public.design_files f SET lease_until=clock_timestamp()+$4::float8*interval '1 millisecond'
  FROM unnest($1::text[],$2::int8[]) AS h(id,fence)
 WHERE f.id=h.id AND f.fence=h.fence AND f.collab_node=$3
 RETURNING f.id";

const RELEASE: &str = "UPDATE public.design_files SET collab_node=NULL,lease_until=NULL
 WHERE id=$1 AND collab_node=$2 AND fence=$3";

const EXPIRE_NODE: &str =
    "UPDATE public.design_files SET collab_node=NULL,lease_until=NULL WHERE collab_node=$1";

const HOLDER: &str =
    "SELECT collab_node,fence,coalesce(lease_until>=clock_timestamp(),false) AS live
  FROM public.design_files WHERE id=$1";

fn millis(ttl: Duration) -> f64 {
    ttl.as_secs_f64() * 1000.0
}

fn unavailable(error: tokio_postgres::Error) -> LeaseError {
    if morfa_journal::conn::refused_for_data(&error) {
        LeaseError::Invalid(error.to_string())
    } else {
        LeaseError::Unavailable(error.to_string())
    }
}

impl PgLease {
    pub fn new(url: &str) -> Self {
        PgLease {
            conn: Mutex::new(Conn::new(url)),
        }
    }

    async fn query(
        &self,
        sql: &'static str,
        params: &[&(dyn tokio_postgres::types::ToSql + Sync)],
    ) -> Result<Vec<tokio_postgres::Row>, LeaseError> {
        let mut conn = self.conn.lock().await;
        conn.query(sql, params).await.map_err(|error| {
            if !morfa_journal::conn::refused_for_data(&error) {
                conn.reset();
            }
            unavailable(error)
        })
    }

    /// Renews every lease `node` holds in `held` (file, fence) at once; returns the files whose lease it still holds.
    pub async fn renew_all(
        &self,
        node: &str,
        held: &[(String, u64)],
        ttl: Duration,
    ) -> Result<(Vec<String>, Instant), LeaseError> {
        let sent = Instant::now();
        let files: Vec<&str> = held.iter().map(|(file, _)| file.as_str()).collect();
        let fences: Vec<i64> = held.iter().map(|(_, fence)| *fence as i64).collect();
        let rows = self
            .query(RENEW_ALL, &[&files, &fences, &node, &millis(ttl)])
            .await?;
        Ok((rows.iter().map(|row| row.get(0)).collect(), sent + ttl))
    }

    /// Ends every lease of `node` at once (api calls this when the node's health check fails, so its files move
    /// without waiting for the TTL). Returns how many files it held.
    pub async fn expire_node(&self, node: &str) -> Result<u64, LeaseError> {
        let mut conn = self.conn.lock().await;
        conn.execute(EXPIRE_NODE, &[&node]).await.map_err(|error| {
            conn.reset();
            unavailable(error)
        })
    }

    /// Who holds `file` (`None` when there is no such file).
    pub async fn holder(&self, file: &str) -> Result<Option<Holder>, LeaseError> {
        let rows = self.query(HOLDER, &[&file]).await?;
        Ok(rows.first().map(|row| Holder {
            node: row.get(0),
            fence: row.get::<_, i64>(1) as u64,
            live: row.get(2),
        }))
    }
}

impl Lease for PgLease {
    async fn acquire(
        &self,
        file: &str,
        node: &str,
        ttl: Duration,
    ) -> Result<Option<Grant>, LeaseError> {
        let sent = Instant::now();
        let rows = self.query(ACQUIRE, &[&file, &node, &millis(ttl)]).await?;
        Ok(rows.first().map(|row| Grant {
            fence: row.get::<_, i64>(0) as u64,
            valid_until: sent + ttl,
        }))
    }

    async fn renew(
        &self,
        file: &str,
        node: &str,
        fence: u64,
        ttl: Duration,
    ) -> Result<Option<Instant>, LeaseError> {
        let sent = Instant::now();
        let rows = self
            .query(RENEW, &[&file, &node, &(fence as i64), &millis(ttl)])
            .await?;
        Ok(rows.first().map(|_| sent + ttl))
    }

    async fn release(&self, file: &str, node: &str, fence: u64) -> Result<(), LeaseError> {
        self.query(RELEASE, &[&file, &node, &(fence as i64)])
            .await?;
        Ok(())
    }
}
