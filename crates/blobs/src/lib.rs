//! `morfa-blobs`: object storage for the collab backend (lane B2, docs/BACKEND.md §3).
//!
//! - [`ObjectStore`]: what the checkpoint writer and the picture store need from S3 (put, get, head, delete, a
//!   presigned GET). [`S3`] speaks the S3 protocol itself (path-style addressing by default, as the Russian providers
//!   want; SigV4 in [`sigv4`]; multipart above `part_size`; retries with backoff). [`MemoryStore`] is the in-memory
//!   fake the tests use, with switches to take it down or damage an object; [`DirStore`] keeps objects as files
//!   (`DESIGN_BLOBS=local`, and the tests that share a store between processes).
//! - [`Blobs`]: pictures become content-addressed: `img/<sha256>` and `thumb/<sha256>.webp`, uploaded once
//!   (dedup by key), verified against their hash when read, linked through signed URLs ([`Links`]).

mod blobs;
mod dir;
mod memory;
mod s3;
pub mod sigv4;

pub use blobs::{Blobs, Kind, Links, Stored, hex_sha256, image_key, thumbnail_key};
pub use bytes::Bytes;
pub use dir::DirStore;
pub use memory::MemoryStore;
pub use s3::{S3, S3Config};

use std::fmt;
use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

/// Why a storage call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// The store did not answer (network, 5xx) after the retries.
    Unavailable(String),
    /// The store answered with a refusal (4xx other than a missing object).
    Refused { status: u16, message: String },
    /// What came back is not what was stored (hash or length mismatch).
    Damaged(String),
}

impl fmt::Display for StoreError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            StoreError::Unavailable(error) => write!(f, "object store unavailable: {error}"),
            StoreError::Refused { status, message } => {
                write!(f, "object store refused ({status}): {message}")
            }
            StoreError::Damaged(error) => write!(f, "stored object damaged: {error}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// An S3-compatible object store.
pub trait ObjectStore: Send + Sync {
    /// Stores `body` under `key` (replacing what was there).
    fn put(
        &self,
        key: &str,
        body: Bytes,
        content_type: &str,
    ) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// The object, or `None` when there is none.
    fn get(&self, key: &str) -> impl Future<Output = Result<Option<Bytes>, StoreError>> + Send;

    /// The object's size, or `None` when there is none.
    fn head(&self, key: &str) -> impl Future<Output = Result<Option<u64>, StoreError>> + Send;

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), StoreError>> + Send;

    /// A URL anyone can GET the object from for `ttl` (None when the store has no such URLs).
    fn presign_get(&self, key: &str, ttl: Duration) -> Option<String>;
}

impl<T: ObjectStore> ObjectStore for Arc<T> {
    fn put(
        &self,
        key: &str,
        body: Bytes,
        content_type: &str,
    ) -> impl Future<Output = Result<(), StoreError>> + Send {
        (**self).put(key, body, content_type)
    }

    fn get(&self, key: &str) -> impl Future<Output = Result<Option<Bytes>, StoreError>> + Send {
        (**self).get(key)
    }

    fn head(&self, key: &str) -> impl Future<Output = Result<Option<u64>, StoreError>> + Send {
        (**self).head(key)
    }

    fn delete(&self, key: &str) -> impl Future<Output = Result<(), StoreError>> + Send {
        (**self).delete(key)
    }

    fn presign_get(&self, key: &str, ttl: Duration) -> Option<String> {
        (**self).presign_get(key, ttl)
    }
}
