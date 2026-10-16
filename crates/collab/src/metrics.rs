//! Prometheus metrics of docs/BACKEND.md §9, in Prometheus text at `/metrics`, and the same histograms for the
//! benchmarks (percentiles within ~3 %). Lock-free: atomics only, so the actor never waits on a scrape.

use std::fmt::Write as _;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::time::Duration;

const SUB_BITS: u32 = 5;
const SUB: usize = 1 << SUB_BITS;
const BUCKETS: usize = (64 - SUB_BITS as usize + 1) * SUB;

/// A log-linear histogram of nanoseconds: 32 sub-buckets per power of two.
pub struct Histogram {
    counts: Box<[AtomicU64]>,
    sum_ns: AtomicU64,
    count: AtomicU64,
}

fn bucket_of(ns: u64) -> usize {
    if ns < SUB as u64 {
        return ns as usize;
    }
    let msb = 63 - ns.leading_zeros();
    let shift = msb - SUB_BITS;
    let sub = ((ns >> shift) as usize) & (SUB - 1);
    ((shift as usize + 1) << SUB_BITS) + sub
}

/// The largest value of a bucket.
fn bucket_upper(index: usize) -> u64 {
    if index < SUB {
        return index as u64;
    }
    let shift = (index >> SUB_BITS) as u32 - 1;
    let sub = (index & (SUB - 1)) as u64;
    (((SUB as u64) | sub) << shift) + ((1u64 << shift) - 1)
}

impl Default for Histogram {
    fn default() -> Self {
        Self::new()
    }
}

impl Histogram {
    pub fn new() -> Self {
        Histogram {
            counts: (0..BUCKETS).map(|_| AtomicU64::new(0)).collect(),
            sum_ns: AtomicU64::new(0),
            count: AtomicU64::new(0),
        }
    }

    pub fn record(&self, elapsed: Duration) {
        self.record_ns(elapsed.as_nanos().min(u64::MAX as u128) as u64);
    }

    pub fn record_ns(&self, ns: u64) {
        self.counts[bucket_of(ns)].fetch_add(1, Ordering::Relaxed);
        self.sum_ns.fetch_add(ns, Ordering::Relaxed);
        self.count.fetch_add(1, Ordering::Relaxed);
    }

    pub fn count(&self) -> u64 {
        self.count.load(Ordering::Relaxed)
    }

    pub fn reset(&self) {
        for c in self.counts.iter() {
            c.store(0, Ordering::Relaxed);
        }
        self.sum_ns.store(0, Ordering::Relaxed);
        self.count.store(0, Ordering::Relaxed);
    }

    /// The value at quantile `q` (0..=1), as the upper bound of its bucket.
    pub fn quantile(&self, q: f64) -> Duration {
        let total = self.count();
        if total == 0 {
            return Duration::ZERO;
        }
        let rank = ((q * total as f64).ceil() as u64).clamp(1, total);
        let mut seen = 0;
        for (i, c) in self.counts.iter().enumerate() {
            seen += c.load(Ordering::Relaxed);
            if seen >= rank {
                return Duration::from_nanos(bucket_upper(i));
            }
        }
        Duration::from_nanos(u64::MAX)
    }

    pub fn mean(&self) -> Duration {
        Duration::from_nanos(
            self.sum_ns
                .load(Ordering::Relaxed)
                .checked_div(self.count())
                .unwrap_or(0),
        )
    }

    /// `p50 / p95 / p99` in milliseconds, for reports.
    pub fn summary_ms(&self) -> String {
        let ms = |q| self.quantile(q).as_secs_f64() * 1e3;
        format!(
            "n={} p50={:.3} p95={:.3} p99={:.3} max={:.3} ms",
            self.count(),
            ms(0.5),
            ms(0.95),
            ms(0.99),
            ms(1.0)
        )
    }

    pub fn write_prometheus(&self, out: &mut String, name: &str, help: &str) {
        const BOUNDS: [f64; 17] = [
            0.0001, 0.00025, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.015, 0.02, 0.03, 0.05, 0.1, 0.25,
            0.5, 1.0, 2.5, 10.0,
        ];
        let _ = writeln!(out, "# HELP {name} {help}\n# TYPE {name} histogram");
        // The fine quantiles (32 sub-buckets per power of two) as a comment, for the load runs' reports.
        let _ = writeln!(out, "# SUMMARY {name} {}", self.summary_ms());
        // The fine buckets themselves (`upper ns:count`, nonzero only): a load run diffs two scrapes for the
        // quantiles of its measured window, without the warm-up.
        let _ = write!(out, "# FINE {name}");
        for (i, c) in self.counts.iter().enumerate() {
            let c = c.load(Ordering::Relaxed);
            if c > 0 {
                let _ = write!(out, " {}:{c}", bucket_upper(i));
            }
        }
        let _ = writeln!(out);
        let mut cumulative = 0u64;
        let mut index = 0;
        for bound in BOUNDS {
            let bound_ns = (bound * 1e9) as u64;
            while index < BUCKETS && bucket_upper(index) <= bound_ns {
                cumulative += self.counts[index].load(Ordering::Relaxed);
                index += 1;
            }
            let _ = writeln!(out, "{name}_bucket{{le=\"{bound}\"}} {cumulative}");
        }
        let count = self.count();
        let _ = writeln!(out, "{name}_bucket{{le=\"+Inf\"}} {count}");
        let _ = writeln!(
            out,
            "{name}_sum {}\n{name}_count {count}",
            self.sum_ns.load(Ordering::Relaxed) as f64 / 1e9
        );
    }
}

#[derive(Default)]
pub struct Counter(AtomicU64);
impl Counter {
    pub fn inc(&self) {
        self.0.fetch_add(1, Ordering::Relaxed);
    }
    pub fn add(&self, n: u64) {
        self.0.fetch_add(n, Ordering::Relaxed);
    }
    pub fn get(&self) -> u64 {
        self.0.load(Ordering::Relaxed)
    }
}

#[derive(Default)]
pub struct Gauge(AtomicI64);
impl Gauge {
    pub fn add(&self, n: i64) {
        self.0.fetch_add(n, Ordering::Relaxed);
    }
    pub fn set(&self, n: i64) {
        self.0.store(n, Ordering::Relaxed);
    }
    pub fn get(&self) -> i64 {
        self.0.load(Ordering::Relaxed)
    }
}

/// Every metric of the service.
#[derive(Default)]
pub struct Metrics {
    /// M1: op frame received → change queued to every peer (journal excluded).
    pub op_fanout: Histogram,
    /// M1b: op frame received → ack queued after the journal commit.
    pub op_ack: Histogram,
    /// The engine's apply step alone (merge + check + apply).
    pub op_apply: Histogram,
    /// W1 on the server: decoding one op frame.
    pub op_decode: Histogram,
    /// Op frame received → the actor takes it (decode and the inbox wait).
    pub op_queue: Histogram,
    pub journal_commit: Histogram,
    /// M8: a catch-up served (tail or journal), server time.
    pub catchup: Histogram,
    pub presence_flush: Histogram,
    /// A2: `GET /api/design-files/:id/session` served by this node (session.rs), every answer.
    pub session: Histogram,
    /// Tickets this node minted (session.rs; 200 answers).
    pub tickets_total: Counter,
    pub ops_total: Counter,
    pub ops_refused_total: Counter,
    /// Ops refused as busy because the journal's queue was nearly full (TARGETS D3).
    pub ops_deferred_total: Counter,
    pub changes_sent_total: Counter,
    pub presence_dropped_total: Counter,
    pub presence_frames_total: Counter,
    pub catchup_total: Counter,
    pub catchup_notices_total: Counter,
    pub slow_closed_total: Counter,
    pub rollback_total: Counter,
    pub panics_total: Counter,
    pub lease_moves_total: Counter,
    pub bytes_in_total: Counter,
    pub bytes_out_total: Counter,
    /// WebSocket pings the server sent to quiet sockets.
    pub pings_sent_total: Counter,
    /// Joins of files this node had not opened, refused over the memory cap (crate::memory).
    pub joins_refused_memory_total: Counter,
    /// Rooms moved off a hot shard (crate::shard `rebalance_candidate`).
    pub rebalances_total: Counter,
    pub docs_open: Gauge,
    pub doc_resident_bytes: Gauge,
    pub conn_open: Gauge,
    pub send_queue_bytes: Gauge,
}

pub fn metrics() -> &'static Metrics {
    static METRICS: OnceLock<Metrics> = OnceLock::new();
    METRICS.get_or_init(Metrics::default)
}

impl Metrics {
    pub fn render(&self) -> String {
        let mut out = String::with_capacity(16 * 1024);
        self.op_fanout.write_prometheus(
            &mut out,
            "collab_op_fanout_seconds",
            "Op received to change queued to the peers (M1).",
        );
        self.op_ack.write_prometheus(
            &mut out,
            "collab_op_ack_seconds",
            "Op received to ack queued after the journal commit (M1b).",
        );
        self.op_apply.write_prometheus(
            &mut out,
            "collab_op_apply_seconds",
            "Merge, check and apply of one op.",
        );
        self.op_decode.write_prometheus(
            &mut out,
            "collab_op_decode_seconds",
            "Decoding one op frame (W1).",
        );
        self.op_queue.write_prometheus(
            &mut out,
            "collab_op_queue_seconds",
            "Op frame received to the actor taking it (decode and the inbox).",
        );
        self.journal_commit.write_prometheus(
            &mut out,
            "collab_journal_commit_seconds",
            "One group commit of a file's journal batch.",
        );
        self.catchup.write_prometheus(
            &mut out,
            "collab_catchup_seconds",
            "Serving one catch-up (M8).",
        );
        self.presence_flush.write_prometheus(
            &mut out,
            "collab_presence_flush_seconds",
            "One presence flush of a file.",
        );
        self.session.write_prometheus(
            &mut out,
            "collab_session_seconds",
            "GET /api/design-files/:id/session served by this node (A2), every answer.",
        );
        let counters: [(&str, &Counter); 18] = [
            ("collab_tickets_total", &self.tickets_total),
            ("collab_ops_total", &self.ops_total),
            ("collab_ops_refused_total", &self.ops_refused_total),
            ("collab_ops_deferred_total", &self.ops_deferred_total),
            ("collab_changes_sent_total", &self.changes_sent_total),
            (
                "collab_presence_dropped_total",
                &self.presence_dropped_total,
            ),
            ("collab_presence_frames_total", &self.presence_frames_total),
            ("collab_catchup_total", &self.catchup_total),
            ("collab_catchup_notices_total", &self.catchup_notices_total),
            ("collab_slow_closed_total", &self.slow_closed_total),
            ("collab_rollback_total", &self.rollback_total),
            ("collab_panics_total", &self.panics_total),
            ("collab_lease_moves_total", &self.lease_moves_total),
            ("collab_bytes_in_total", &self.bytes_in_total),
            ("collab_bytes_out_total", &self.bytes_out_total),
            ("collab_pings_sent_total", &self.pings_sent_total),
            (
                "collab_joins_refused_memory_total",
                &self.joins_refused_memory_total,
            ),
            ("collab_rebalances_total", &self.rebalances_total),
        ];
        for (name, counter) in counters {
            let _ = writeln!(out, "# TYPE {name} counter\n{name} {}", counter.get());
        }
        let gauges: [(&str, &Gauge); 4] = [
            ("collab_docs_open", &self.docs_open),
            ("collab_doc_resident_bytes", &self.doc_resident_bytes),
            ("collab_conn_open", &self.conn_open),
            ("collab_send_queue_bytes", &self.send_queue_bytes),
        ];
        for (name, gauge) in gauges {
            let _ = writeln!(out, "# TYPE {name} gauge\n{name} {}", gauge.get());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn buckets_are_ordered_and_tight() {
        let mut last = 0;
        for i in 1..BUCKETS - SUB {
            let upper = bucket_upper(i);
            assert!(upper > last, "bucket {i}");
            assert_eq!(bucket_of(upper), i);
            assert_eq!(bucket_of(last + 1), i);
            last = upper;
        }
        let h = Histogram::new();
        for us in 1..=1000u64 {
            h.record(Duration::from_micros(us));
        }
        let p99 = h.quantile(0.99).as_secs_f64() * 1e6;
        assert!((990.0..=990.0 * 1.04).contains(&p99), "{p99}");
        let text = metrics().render();
        assert!(text.contains("collab_op_fanout_seconds_bucket{le=\"+Inf\"}"));
    }
}
