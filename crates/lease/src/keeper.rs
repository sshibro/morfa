//! [`Keeper`]: the leases of one collab node, renewed together.

use crate::PgLease;
use morfa_journal::{Lease, LeaseError};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::watch;
use tokio::task::JoinHandle;

/// Where a held lease stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LeaseState {
    /// Held until `valid_until` (local clock, conservative), renewed before then while PostgreSQL answers.
    Held { valid_until: Instant },
    /// Another owner took the file (its fence moved): close the document's sockets with `bye {moved}`.
    Lost,
    /// No renewal reached PostgreSQL for a whole TTL: another node may own the file by now; stop serving it.
    Expired,
}

/// A lease the node holds for one document actor.
pub struct Held {
    pub file: Arc<str>,
    pub fence: u64,
    state: watch::Receiver<LeaseState>,
}

impl Held {
    pub fn state(&self) -> LeaseState {
        let state = *self.state.borrow();
        match state {
            LeaseState::Held { valid_until } if Instant::now() >= valid_until => {
                LeaseState::Expired
            }
            state => state,
        }
    }

    /// Whether the actor may still act as the owner right now.
    pub fn valid(&self) -> bool {
        matches!(self.state(), LeaseState::Held { .. })
    }

    /// Waits until the lease is lost or runs out; returns which.
    pub async fn ended(&mut self) -> LeaseState {
        loop {
            let deadline = match self.state() {
                LeaseState::Held { valid_until } => valid_until,
                ended => return ended,
            };
            tokio::select! {
                changed = self.state.changed() => {
                    if changed.is_err() {
                        // The keeper stopped: nothing renews the lease any more.
                        tokio::time::sleep_until(deadline.into()).await;
                    }
                }
                _ = tokio::time::sleep_until(deadline.into()) => {}
            }
        }
    }
}

type Leases = HashMap<Arc<str>, (u64, watch::Sender<LeaseState>)>;

/// Holds the leases of one node and renews them every `renew_every` in one statement.
pub struct Keeper {
    lease: Arc<PgLease>,
    node: Arc<str>,
    ttl: Duration,
    held: Arc<Mutex<Leases>>,
    task: JoinHandle<()>,
}

impl Keeper {
    /// docs/BACKEND.md: leases last 15 s, renewed every 5 s.
    pub const TTL: Duration = Duration::from_secs(15);
    pub const RENEW_EVERY: Duration = Duration::from_secs(5);

    pub fn start(lease: Arc<PgLease>, node: &str, ttl: Duration, renew_every: Duration) -> Self {
        let held: Arc<Mutex<Leases>> = Arc::default();
        let node: Arc<str> = node.into();
        let task = tokio::spawn(renew_loop(
            lease.clone(),
            node.clone(),
            ttl,
            renew_every,
            held.clone(),
        ));
        Keeper {
            lease,
            node,
            ttl,
            held,
            task,
        }
    }

    pub fn node(&self) -> &str {
        &self.node
    }

    /// Takes `file` for this node (`None`: another live node holds it).
    pub async fn acquire(&self, file: &str) -> Result<Option<Held>, LeaseError> {
        let Some(grant) = self.lease.acquire(file, &self.node, self.ttl).await? else {
            return Ok(None);
        };
        let (sender, state) = watch::channel(LeaseState::Held {
            valid_until: grant.valid_until,
        });
        let file: Arc<str> = file.into();
        self.held
            .lock()
            .expect("lease map")
            .insert(file.clone(), (grant.fence, sender));
        Ok(Some(Held {
            file,
            fence: grant.fence,
            state,
        }))
    }

    /// Gives a file up (its last editor left, or the actor stopped).
    pub async fn release(&self, held: Held) -> Result<(), LeaseError> {
        let mine = {
            let mut leases = self.held.lock().expect("lease map");
            match leases.get(&held.file) {
                Some((fence, _)) if *fence == held.fence => leases.remove(&held.file).is_some(),
                _ => false,
            }
        };
        if mine {
            self.lease
                .release(&held.file, &self.node, held.fence)
                .await?;
        }
        Ok(())
    }

    /// How many leases the node holds.
    pub fn len(&self) -> usize {
        self.held.lock().expect("lease map").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

impl Drop for Keeper {
    fn drop(&mut self) {
        self.task.abort();
    }
}

async fn renew_loop(
    lease: Arc<PgLease>,
    node: Arc<str>,
    ttl: Duration,
    every: Duration,
    held: Arc<Mutex<Leases>>,
) {
    let mut tick = tokio::time::interval(every);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    tick.tick().await;
    loop {
        tick.tick().await;
        let snapshot: Vec<(String, u64)> = held
            .lock()
            .expect("lease map")
            .iter()
            .map(|(file, (fence, _))| (file.to_string(), *fence))
            .collect();
        if snapshot.is_empty() {
            continue;
        }
        match lease.renew_all(&node, &snapshot, ttl).await {
            Ok((renewed, valid_until)) => {
                let renewed: std::collections::HashSet<String> = renewed.into_iter().collect();
                let mut leases = held.lock().expect("lease map");
                for (file, fence) in snapshot {
                    let key: &str = &file;
                    let Some((current, sender)) = leases.get(key) else {
                        continue;
                    };
                    if *current != fence {
                        continue;
                    }
                    if renewed.contains(&file) {
                        let _ = sender.send(LeaseState::Held { valid_until });
                    } else {
                        let _ = sender.send(LeaseState::Lost);
                        leases.remove(key);
                    }
                }
            }
            Err(_) => {
                // PostgreSQL unreachable: leases whose deadline passed are over (another node may own the file).
                let now = Instant::now();
                held.lock().expect("lease map").retain(|_, (_, sender)| {
                    let expired = matches!(*sender.borrow(), LeaseState::Held { valid_until } if now >= valid_until);
                    if expired {
                        let _ = sender.send(LeaseState::Expired);
                    }
                    !expired
                });
            }
        }
    }
}
