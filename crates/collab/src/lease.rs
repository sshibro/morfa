//! The per-file lease (docs/BACKEND.md §2 "Routing and the lease", §8): one owner node per document. api takes
//! the lease when it answers `/session` for an idle file; the owning actor renews it every `RENEW` and stops
//! (closing its sockets with `bye {moved}`) when a renewal fails. Every journal commit carries the lease's fence.
//! B2 supplies the PostgreSQL implementation (`design_files.collab_node, lease_until, fence`, migration 012).

use async_trait::async_trait;
use parking_lot::Mutex;
use std::collections::HashMap;
use std::time::{Duration, Instant};

pub const LEASE_TTL: Duration = Duration::from_secs(15);
pub const LEASE_RENEW: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseError {
    /// Another node holds the lease.
    Held {
        node: String,
    },
    Unavailable(String),
}

#[async_trait]
pub trait Lease: Send + Sync + 'static {
    /// Takes the file's lease for `node` (or confirms this node already holds it); answers the fence.
    async fn acquire(&self, file: &str, node: &str) -> Result<u64, LeaseError>;
    /// Extends the lease; false when it is no longer this fence's.
    async fn renew(&self, file: &str, node: &str, fence: u64) -> Result<bool, LeaseError>;
    async fn release(&self, file: &str, node: &str, fence: u64);
}

/// Leases in memory (tests, a single node before B2).
#[derive(Default)]
pub struct MemLease {
    held: Mutex<HashMap<String, (String, u64, Instant)>>,
    next_fence: Mutex<u64>,
}

impl MemLease {
    pub fn new() -> Self {
        Self::default()
    }

    /// Moves the lease to another node (tests of `bye {moved}`).
    pub fn steal(&self, file: &str, node: &str) -> u64 {
        let fence = {
            let mut next = self.next_fence.lock();
            *next += 1;
            *next
        };
        self.held.lock().insert(
            file.to_owned(),
            (node.to_owned(), fence, Instant::now() + LEASE_TTL),
        );
        fence
    }
}

#[async_trait]
impl Lease for MemLease {
    async fn acquire(&self, file: &str, node: &str) -> Result<u64, LeaseError> {
        let mut held = self.held.lock();
        let now = Instant::now();
        if let Some((holder, fence, until)) = held.get_mut(file) {
            if holder == node {
                *until = now + LEASE_TTL;
                return Ok(*fence);
            }
            if *until > now {
                return Err(LeaseError::Held {
                    node: holder.clone(),
                });
            }
        }
        let fence = {
            let mut next = self.next_fence.lock();
            *next += 1;
            *next
        };
        held.insert(file.to_owned(), (node.to_owned(), fence, now + LEASE_TTL));
        Ok(fence)
    }

    async fn renew(&self, file: &str, node: &str, fence: u64) -> Result<bool, LeaseError> {
        let mut held = self.held.lock();
        match held.get_mut(file) {
            Some((holder, held_fence, until)) if holder == node && *held_fence == fence => {
                *until = Instant::now() + LEASE_TTL;
                Ok(true)
            }
            _ => Ok(false),
        }
    }

    async fn release(&self, file: &str, node: &str, fence: u64) {
        let mut held = self.held.lock();
        if held
            .get(file)
            .is_some_and(|(holder, f, _)| holder == node && *f == fence)
        {
            held.remove(file);
        }
    }
}
