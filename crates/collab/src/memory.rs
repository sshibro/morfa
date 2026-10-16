//! The node's memory cap (`MORFA_COLLAB_MEMORY_LIMIT_MB`): the process's resident set, read from `/proc/self/status`
//! (`VmRSS`) at most twice a second. Over the cap a node takes no new file: a join for a file it has not opened is
//! answered `bye {limit}` and the lease api's `/session` took for this node is let go, so the reconnect's `/session`
//! goes to another node; `/healthz` says `memory.full`, which api's health check reads to keep new files away
//! (server/design/collab/leases.ts). Files already open stay: their editors join as before.
//!
//! RSS rather than the engines' estimates: a store-loaded document's `approx_bytes` is an estimate per layer, while
//! the resident set is what the machine runs out of (lane B7).

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const REFRESH: Duration = Duration::from_millis(500);

struct Sample {
    bytes: AtomicU64,
    /// Milliseconds since `EPOCH` of the last read; 0: never read.
    at_ms: AtomicU64,
}

static SAMPLE: Sample = Sample {
    bytes: AtomicU64::new(0),
    at_ms: AtomicU64::new(0),
};

fn epoch() -> Instant {
    static EPOCH: std::sync::OnceLock<Instant> = std::sync::OnceLock::new();
    *EPOCH.get_or_init(Instant::now)
}

/// `VmRSS` of this process in bytes, read now; None where /proc is not there.
fn read_rss() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    let line = status.lines().find(|line| line.starts_with("VmRSS:"))?;
    let kib: u64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kib * 1024)
}

/// The resident set in bytes (cached for `REFRESH`); 0 where it cannot be read.
pub fn rss() -> u64 {
    let now = epoch().elapsed().as_millis() as u64 + 1;
    let at = SAMPLE.at_ms.load(Ordering::Relaxed);
    if at == 0 || now.saturating_sub(at) >= REFRESH.as_millis() as u64 {
        if let Some(bytes) = read_rss() {
            SAMPLE.bytes.store(bytes, Ordering::Relaxed);
        }
        SAMPLE.at_ms.store(now, Ordering::Relaxed);
    }
    SAMPLE.bytes.load(Ordering::Relaxed)
}

/// Whether the node is at or over `limit` bytes (never without a limit, or where RSS cannot be read).
pub fn full(limit: Option<u64>) -> bool {
    limit.is_some_and(|limit| {
        let rss = rss();
        rss > 0 && rss >= limit
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn the_resident_set_is_read_and_compared() {
        let rss = super::rss();
        if cfg!(target_os = "linux") {
            assert!(rss > 1024 * 1024, "{rss}");
            assert!(super::full(Some(1)));
            assert!(!super::full(Some(u64::MAX)));
        }
        assert!(!super::full(None));
    }
}
