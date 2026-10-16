//! `morfa-journal`: the collab journal (lane B2, docs/BACKEND.md §3, TARGETS D1–D3).
//!
//! The journal is `design_file_changes` (migration 012): one row per document version, the op in the model's codec
//! (`op`) or, for rows Node wrote, the JSON patch (`patch`); collab's large JSON patches go in `op` packed with zstd
//! ([`packed`]). [`PgJournal`] group-commits the rows of a collab node: an
//! op is acknowledged only after the statement that holds it committed, and one statement carries every op that
//! arrived during the previous commit (at most [`Config::max_batch_ops`], at most one statement per
//! [`Config::flush_interval`] per shard), so the commit cost is shared by every editor of the node.
//!
//! Every row carries the lease fence its owner holds (crates/lease). The statement takes the file's row lock under
//! that fence before it inserts, so a stale owner's rows are refused ([`JournalError::Fenced`]) and a new owner's
//! lease waits for the commit in flight (then sees its rows). The database's trigger refuses the same for any other
//! writer.
//!
//! The [`Journal`] and [`Lease`] traits are the contract with `crates/collab`. They are defined here, and `crates/collab`
//! adopts them.

pub mod conn;
pub mod packed;
mod pg;
#[cfg(feature = "testdb")]
pub mod testdb;
mod traits;

pub use pg::{Config, PgJournal, Stats, version_heads};
pub use traits::{Body, ClientOp, Entry, Grant, Journal, JournalError, Lease, LeaseError, Row};
