//! `/metrics` in Prometheus text: jobs by kind and outcome, their durations (a fixed set of buckets), the queue's
//! length and the jobs running. Atomics only: a scrape never waits on a worker.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use crate::request::Kind;

const KINDS: [Kind; 6] = [
    Kind::Pdf,
    Kind::Svg,
    Kind::Png,
    Kind::Jpeg,
    Kind::Webp,
    Kind::Thumbnail,
];
/// Seconds.
const BUCKETS: [f64; 12] = [
    0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 60.0,
];

#[derive(Default)]
struct PerKind {
    ok: AtomicU64,
    failed: AtomicU64,
    buckets: [AtomicU64; BUCKETS.len()],
    sum_us: AtomicU64,
}

#[derive(Default)]
pub struct Metrics {
    kinds: [PerKind; KINDS.len()],
    pub queued: AtomicU64,
    pub refused_busy: AtomicU64,
    pub refused_limits: AtomicU64,
    pub timeouts: AtomicU64,
}

fn index(kind: Kind) -> usize {
    KINDS.iter().position(|k| *k == kind).unwrap_or(0)
}

impl Metrics {
    /// A job ran (or was dropped at its deadline): its kind, time and refusal code.
    pub fn finish(&self, kind: Kind, took: Duration, failed: Option<&str>) {
        let k = &self.kinds[index(kind)];
        match failed {
            None => k.ok.fetch_add(1, Ordering::Relaxed),
            Some(code) => {
                if code == "design_pdf_timeout" {
                    self.timeouts.fetch_add(1, Ordering::Relaxed);
                }
                k.failed.fetch_add(1, Ordering::Relaxed)
            }
        };
        let s = took.as_secs_f64();
        for (at, bound) in BUCKETS.iter().enumerate() {
            if s <= *bound {
                k.buckets[at].fetch_add(1, Ordering::Relaxed);
            }
        }
        k.sum_us
            .fetch_add(took.as_micros() as u64, Ordering::Relaxed);
    }

    pub fn render(&self, running: usize, workers: usize) -> String {
        let mut out = String::new();
        out.push_str("# TYPE morfa_render_jobs_total counter\n");
        for kind in KINDS {
            let k = &self.kinds[index(kind)];
            for (outcome, v) in [("ok", &k.ok), ("failed", &k.failed)] {
                let _ = writeln!(
                    out,
                    "morfa_render_jobs_total{{kind=\"{}\",outcome=\"{outcome}\"}} {}",
                    kind.name(),
                    v.load(Ordering::Relaxed)
                );
            }
        }
        out.push_str("# TYPE morfa_render_job_seconds histogram\n");
        for kind in KINDS {
            let k = &self.kinds[index(kind)];
            let count = k.ok.load(Ordering::Relaxed) + k.failed.load(Ordering::Relaxed);
            for (at, bound) in BUCKETS.iter().enumerate() {
                let _ = writeln!(
                    out,
                    "morfa_render_job_seconds_bucket{{kind=\"{}\",le=\"{bound}\"}} {}",
                    kind.name(),
                    k.buckets[at].load(Ordering::Relaxed)
                );
            }
            let _ = writeln!(
                out,
                "morfa_render_job_seconds_bucket{{kind=\"{}\",le=\"+Inf\"}} {count}\nmorfa_render_job_seconds_sum{{kind=\"{}\"}} {}\nmorfa_render_job_seconds_count{{kind=\"{}\"}} {count}",
                kind.name(),
                kind.name(),
                k.sum_us.load(Ordering::Relaxed) as f64 / 1e6,
                kind.name()
            );
        }
        let _ = writeln!(
            out,
            "# TYPE morfa_render_queued gauge\nmorfa_render_queued {}\n# TYPE morfa_render_running gauge\nmorfa_render_running {running}\n# TYPE morfa_render_workers gauge\nmorfa_render_workers {workers}\n# TYPE morfa_render_refused_total counter\nmorfa_render_refused_total{{reason=\"busy\"}} {}\nmorfa_render_refused_total{{reason=\"limits\"}} {}\n# TYPE morfa_render_timeouts_total counter\nmorfa_render_timeouts_total {}",
            self.queued.load(Ordering::Relaxed),
            self.refused_busy.load(Ordering::Relaxed),
            self.refused_limits.load(Ordering::Relaxed),
            self.timeouts.load(Ordering::Relaxed),
        );
        out
    }
}
