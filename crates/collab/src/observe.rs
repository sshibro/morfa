//! Lane B5's observability for the deploy (docs/BACKEND.md §9): what crate::metrics does not already measure, appended
//! to `/metrics` — checkpoints (`collab_checkpoint_seconds`, failures for the alert), the drain, the process (CPU,
//! resident memory, descriptors: TARGETS M5/K1 per service without node_exporter) and the build — and per-op spans
//! exported to Tempo as OTLP/HTTP JSON.
//!
//! Spans: one op is one trace whose id is derived from `(file, client, seq)`, so its fan-out span (`collab.op`: op
//! received → change queued to every peer, M1) and its ack span (`collab.ack`: op received → ack queued after the
//! journal commit, M1b) land in the same trace without any state between them. An op is exported when its id falls
//! in the sampled fraction (`MORFA_TRACE_SAMPLE`, 1 %) or when either half took longer than `MORFA_TRACE_SLOW_MS`
//! (20 ms). No exporter dependency: a background task posts JSON batches over plain HTTP to the collector on the
//! private network (`OTEL_EXPORTER_OTLP_ENDPOINT`, e.g. `http://127.0.0.1:4318`); unset, nothing is recorded and every
//! hook returns after one atomic load.
//!
//! Environment (read once by [`init`], from main.rs):
//!   OTEL_EXPORTER_OTLP_ENDPOINT         collector base URL (`/v1/traces` is appended); or
//!   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT  the full traces URL
//!   OTEL_SERVICE_NAME                   service.name (morfa-collab)
//!   MORFA_TRACE_SAMPLE                  sampled fraction of ops, 0..=1 (0.01)
//!   MORFA_TRACE_SLOW_MS                 every op slower than this is exported (20)

use crate::metrics::{Counter, Gauge, Histogram};
use morfa_protocol::{ClientId, Seq, Version};
use sha2::{Digest, Sha256};
use std::fmt::Write as _;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::mpsc;

/// A gauge of seconds (an f64 kept as its bits).
#[derive(Default)]
pub struct SecondsGauge(AtomicU64);

impl SecondsGauge {
    pub fn set_secs(&self, value: Duration) {
        self.0
            .store(value.as_secs_f64().to_bits(), Ordering::Relaxed);
    }
    pub fn get(&self) -> f64 {
        f64::from_bits(self.0.load(Ordering::Relaxed))
    }
}

/// The metrics this module adds to `/metrics`.
#[derive(Default)]
pub struct Observe {
    /// A checkpoint written (serialize + zstd + upload + integrity re-read), off the actor's thread (TARGETS S3).
    pub checkpoint: Histogram,
    pub checkpoints_total: Counter,
    /// Checkpoints that failed (alert: deploy/observability/prometheus/alerts.yml).
    pub checkpoint_failures_total: Counter,
    /// 1 while the node drains.
    pub draining: Gauge,
    /// How long the last drain took.
    pub drain_seconds: SecondsGauge,
    /// Ops a draining actor left for the file's next owner (crate::actor::drain).
    pub drain_deferred_ops_total: Counter,
    pub spans_exported_total: Counter,
    /// Spans dropped because the export queue was full or the collector refused them.
    pub spans_dropped_total: Counter,
}

pub fn observe() -> &'static Observe {
    static OBSERVE: OnceLock<Observe> = OnceLock::new();
    OBSERVE.get_or_init(Observe::default)
}

/// A checkpoint write ended (crate::actor `maybe_checkpoint`).
pub fn checkpoint_done(elapsed: Duration, ok: bool) {
    let o = observe();
    o.checkpoint.record(elapsed);
    o.checkpoints_total.inc();
    if !ok {
        o.checkpoint_failures_total.inc();
    }
}

/// This module's lines of `/metrics` (after crate::metrics' own).
pub fn render() -> String {
    let o = observe();
    let mut out = String::with_capacity(4 * 1024);
    o.checkpoint.write_prometheus(
        &mut out,
        "collab_checkpoint_seconds",
        "One checkpoint written: serialize, zstd, upload and integrity re-read (S3).",
    );
    let counters: [(&str, &str, &Counter); 5] = [
        (
            "collab_drain_deferred_ops_total",
            "Ops a draining node left unapplied for the next owner (the clients re-send them).",
            &o.drain_deferred_ops_total,
        ),
        (
            "collab_checkpoints_total",
            "Checkpoints attempted.",
            &o.checkpoints_total,
        ),
        (
            "collab_checkpoint_failures_total",
            "Checkpoints that failed.",
            &o.checkpoint_failures_total,
        ),
        (
            "collab_spans_exported_total",
            "Op spans posted to the OTLP collector.",
            &o.spans_exported_total,
        ),
        (
            "collab_spans_dropped_total",
            "Op spans dropped (queue full or collector unavailable).",
            &o.spans_dropped_total,
        ),
    ];
    for (name, help, counter) in counters {
        let _ = writeln!(
            out,
            "# HELP {name} {help}\n# TYPE {name} counter\n{name} {}",
            counter.get()
        );
    }
    let _ = writeln!(
        out,
        "# HELP collab_draining 1 while the node drains (deploy).\n# TYPE collab_draining gauge\ncollab_draining {}",
        o.draining.get()
    );
    let _ = writeln!(
        out,
        "# HELP collab_drain_last_seconds How long the last drain took.\n# TYPE collab_drain_last_seconds gauge\ncollab_drain_last_seconds {}",
        o.drain_seconds.get()
    );
    let _ = writeln!(
        out,
        "# HELP collab_build_info The running build.\n# TYPE collab_build_info gauge\ncollab_build_info{{version=\"{}\",commit=\"{}\"}} 1",
        env!("CARGO_PKG_VERSION"),
        option_env!("MORFA_BUILD_COMMIT").unwrap_or("unknown")
    );
    process::render(&mut out);
    out
}

/// Process metrics with the standard names (Linux `/proc/self`; nothing elsewhere).
mod process {
    use std::fmt::Write as _;

    /// `sysconf(_SC_CLK_TCK)` on Linux.
    const CLOCK_TICKS: f64 = 100.0;

    pub fn render(out: &mut String) {
        let Ok(stat) = std::fs::read_to_string("/proc/self/stat") else {
            return;
        };
        // Fields after the command name (which may hold spaces) start at the state, field 3.
        let Some(rest) = stat.rsplit_once(')').map(|(_, rest)| rest) else {
            return;
        };
        let fields: Vec<&str> = rest.split_whitespace().collect();
        let field = |n: usize| -> f64 {
            fields
                .get(n - 3)
                .and_then(|v| v.parse().ok())
                .unwrap_or(0.0)
        };
        let cpu = (field(14) + field(15)) / CLOCK_TICKS;
        // VmRSS in kB from /proc/self/status: right whatever the page size (16K/64K pages on some aarch64 hosts).
        let rss = std::fs::read_to_string("/proc/self/status")
            .ok()
            .and_then(|status| {
                status
                    .lines()
                    .find_map(|line| line.strip_prefix("VmRSS:"))
                    .and_then(|v| v.trim().trim_end_matches("kB").trim().parse::<u64>().ok())
            })
            .unwrap_or(0)
            * 1024;
        let _ = writeln!(
            out,
            "# HELP process_cpu_seconds_total User and system CPU time.\n# TYPE process_cpu_seconds_total counter\nprocess_cpu_seconds_total {cpu}"
        );
        let _ = writeln!(
            out,
            "# HELP process_resident_memory_bytes Resident memory.\n# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes {rss}"
        );
        if let Ok(fds) = std::fs::read_dir("/proc/self/fd") {
            let _ = writeln!(
                out,
                "# HELP process_open_fds Open file descriptors.\n# TYPE process_open_fds gauge\nprocess_open_fds {}",
                fds.count()
            );
        }
        if let Some(boot) = std::fs::read_to_string("/proc/stat").ok().and_then(|text| {
            text.lines()
                .find_map(|line| line.strip_prefix("btime "))
                .and_then(|v| v.trim().parse::<f64>().ok())
        }) {
            let _ = writeln!(
                out,
                "# HELP process_start_time_seconds Start time since the epoch.\n# TYPE process_start_time_seconds gauge\nprocess_start_time_seconds {}",
                boot + field(22) / CLOCK_TICKS
            );
        }
    }
}

// ── Spans ────────────────────────────────────────────────────────────────────────────────────────

/// The OTLP export, when configured.
struct Exporter {
    tx: mpsc::Sender<Span>,
    sample: f64,
    slow: Duration,
}

static EXPORTER: OnceLock<Exporter> = OnceLock::new();

/// One finished span.
#[derive(Clone, Debug)]
pub struct Span {
    pub trace_id: [u8; 16],
    pub span_id: [u8; 8],
    pub name: &'static str,
    pub start: SystemTime,
    pub end: SystemTime,
    pub attributes: Vec<(&'static str, Value)>,
}

#[derive(Clone, Debug)]
pub enum Value {
    Str(String),
    Int(i64),
}

/// The export settings read from the environment.
#[derive(Clone, Debug, PartialEq)]
pub struct ExportConfig {
    pub url: String,
    pub service: String,
    pub instance: String,
    pub sample: f64,
    pub slow: Duration,
}

impl ExportConfig {
    /// From `OTEL_*` / `MORFA_TRACE_*` (see the module); None when no collector is configured.
    pub fn from_env(instance: &str) -> Option<ExportConfig> {
        Self::from_lookup(|name| std::env::var(name).ok(), instance)
    }

    /// The same from any lookup (tests).
    pub fn from_lookup(
        lookup: impl Fn(&str) -> Option<String>,
        instance: &str,
    ) -> Option<ExportConfig> {
        let var = |name: &str| lookup(name).filter(|v| !v.trim().is_empty());
        let url = var("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT").or_else(|| {
            var("OTEL_EXPORTER_OTLP_ENDPOINT")
                .map(|base| format!("{}/v1/traces", base.trim_end_matches('/')))
        })?;
        let sample = var("MORFA_TRACE_SAMPLE")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| (0.0..=1.0).contains(v))
            .unwrap_or(0.01);
        let slow = var("MORFA_TRACE_SLOW_MS")
            .and_then(|v| v.parse::<u64>().ok())
            .map_or(Duration::from_millis(20), Duration::from_millis);
        Some(ExportConfig {
            url,
            service: var("OTEL_SERVICE_NAME").unwrap_or_else(|| "morfa-collab".into()),
            instance: instance.to_owned(),
            sample,
            slow,
        })
    }
}

/// Starts the export (inside the tokio runtime); a second call does nothing.
pub fn init(config: ExportConfig) {
    if !config.url.starts_with("http://") {
        tracing::warn!(
            url = config.url,
            "OTLP export needs a plain http:// collector on the private network; spans are off"
        );
        return;
    }
    let (tx, rx) = mpsc::channel(EXPORT_QUEUE);
    let exporter = Exporter {
        tx,
        sample: config.sample,
        slow: config.slow,
    };
    if EXPORTER.set(exporter).is_err() {
        return;
    }
    tracing::info!(
        url = config.url,
        sample = config.sample,
        slow_ms = config.slow.as_millis() as u64,
        "op spans exported over OTLP/HTTP"
    );
    tokio::spawn(export_loop(config, rx));
}

const EXPORT_QUEUE: usize = 8192;
const EXPORT_BATCH: usize = 512;
const EXPORT_EVERY: Duration = Duration::from_secs(2);

/// The trace of one op: 32 bytes of SHA-256 over `(file, client, seq)`; bytes 0..16 the trace id, 16..24 the
/// fan-out span, 24..32 the ack span. Its first 8 bytes also decide the sample (the same answer for both halves).
fn op_digest(file: &str, client: &ClientId, seq: Seq) -> [u8; 32] {
    let mut hash = Sha256::new();
    hash.update(file.as_bytes());
    hash.update([0]);
    hash.update(client.as_str().as_bytes());
    hash.update([0]);
    hash.update(seq.to_le_bytes());
    hash.finalize().into()
}

fn sampled(digest: &[u8; 32], fraction: f64) -> bool {
    let draw = u64::from_le_bytes(digest[..8].try_into().expect("8 bytes"));
    (draw as f64) < fraction * u64::MAX as f64
}

/// Whether an op whose halves took `elapsed` is exported; with the digest when it is.
fn chosen(
    file: &str,
    client: &ClientId,
    seq: Seq,
    elapsed: Duration,
) -> Option<(&'static Exporter, [u8; 32])> {
    let exporter = EXPORTER.get()?;
    let digest = op_digest(file, client, seq);
    (elapsed >= exporter.slow || sampled(&digest, exporter.sample)).then_some((exporter, digest))
}

fn send(exporter: &Exporter, span: Span) {
    if exporter.tx.try_send(span).is_err() {
        observe().spans_dropped_total.inc();
    }
}

/// The op's change was queued to every peer (M1): `received` is the frame's arrival, `applied_from` the engine's start.
pub fn op_fanned_out(
    file: &str,
    client: &ClientId,
    seq: Seq,
    version: Version,
    received: Instant,
    applied_from: Instant,
    peers: u64,
) {
    let elapsed = received.elapsed();
    let Some((exporter, digest)) = chosen(file, client, seq, elapsed) else {
        return;
    };
    let end = SystemTime::now();
    send(
        exporter,
        Span {
            trace_id: digest[..16].try_into().expect("16 bytes"),
            span_id: digest[16..24].try_into().expect("8 bytes"),
            name: "collab.op",
            start: end - elapsed,
            end,
            attributes: vec![
                ("file", Value::Str(file.to_owned())),
                ("client", Value::Str(client.as_str().to_owned())),
                ("seq", Value::Int(seq as i64)),
                ("version", Value::Int(version as i64)),
                ("peers", Value::Int(peers as i64)),
                (
                    "queue_us",
                    Value::Int(applied_from.saturating_duration_since(received).as_micros() as i64),
                ),
                ("fanout_us", Value::Int(elapsed.as_micros() as i64)),
            ],
        },
    );
}

/// The op's ack was queued after its journal commit (M1b).
pub fn op_acked(file: &str, client: &ClientId, seq: Seq, version: Version, received: Instant) {
    let elapsed = received.elapsed();
    let Some((exporter, digest)) = chosen(file, client, seq, elapsed) else {
        return;
    };
    let end = SystemTime::now();
    send(
        exporter,
        Span {
            trace_id: digest[..16].try_into().expect("16 bytes"),
            span_id: digest[24..32].try_into().expect("8 bytes"),
            name: "collab.ack",
            start: end - elapsed,
            end,
            attributes: vec![
                ("file", Value::Str(file.to_owned())),
                ("client", Value::Str(client.as_str().to_owned())),
                ("seq", Value::Int(seq as i64)),
                ("version", Value::Int(version as i64)),
                ("ack_us", Value::Int(elapsed.as_micros() as i64)),
            ],
        },
    );
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(out, "{b:02x}");
    }
    out
}

fn unix_nanos(time: SystemTime) -> String {
    time.duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos())
        .to_string()
}

/// One OTLP/HTTP JSON request body (opentelemetry-proto `ExportTraceServiceRequest`, JSON mapping: ids as hex, 64-bit
/// integers as strings).
pub fn otlp_json(service: &str, instance: &str, spans: &[Span]) -> String {
    let attr = |key: &str, value: &Value| match value {
        Value::Str(s) => serde_json::json!({"key": key, "value": {"stringValue": s}}),
        Value::Int(i) => serde_json::json!({"key": key, "value": {"intValue": i.to_string()}}),
    };
    let spans: Vec<serde_json::Value> = spans
        .iter()
        .map(|span| {
            serde_json::json!({
                "traceId": hex(&span.trace_id),
                "spanId": hex(&span.span_id),
                "name": span.name,
                // SPAN_KIND_INTERNAL: the op's work inside the service.
                "kind": 1,
                "startTimeUnixNano": unix_nanos(span.start),
                "endTimeUnixNano": unix_nanos(span.end),
                "attributes": span.attributes.iter().map(|(k, v)| attr(k, v)).collect::<Vec<_>>(),
                "status": {},
            })
        })
        .collect();
    serde_json::json!({
        "resourceSpans": [{
            "resource": {"attributes": [
                attr("service.name", &Value::Str(service.to_owned())),
                attr("service.instance.id", &Value::Str(instance.to_owned())),
                attr("service.version", &Value::Str(env!("CARGO_PKG_VERSION").to_owned())),
            ]},
            "scopeSpans": [{"scope": {"name": "morfa-collab"}, "spans": spans}],
        }]
    })
    .to_string()
}

async fn export_loop(config: ExportConfig, mut rx: mpsc::Receiver<Span>) {
    let mut batch: Vec<Span> = Vec::with_capacity(EXPORT_BATCH);
    loop {
        let deadline = tokio::time::sleep(EXPORT_EVERY);
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                span = rx.recv() => match span {
                    Some(span) => {
                        batch.push(span);
                        if batch.len() >= EXPORT_BATCH {
                            break;
                        }
                    }
                    None => {
                        flush(&config, &mut batch).await;
                        return;
                    }
                },
                _ = &mut deadline => break,
            }
        }
        flush(&config, &mut batch).await;
    }
}

async fn flush(config: &ExportConfig, batch: &mut Vec<Span>) {
    if batch.is_empty() {
        return;
    }
    let body = otlp_json(&config.service, &config.instance, batch);
    let count = batch.len() as u64;
    batch.clear();
    match post_json(&config.url, &body, Duration::from_secs(5)).await {
        Ok(()) => observe().spans_exported_total.add(count),
        Err(error) => {
            observe().spans_dropped_total.add(count);
            tracing::debug!(error, "OTLP export failed");
        }
    }
}

/// POSTs a JSON body over plain HTTP/1.1 (the collector on the private network); Ok on a 2xx answer.
pub async fn post_json(url: &str, body: &str, timeout: Duration) -> Result<(), String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let rest = url
        .strip_prefix("http://")
        .ok_or_else(|| format!("only http:// is supported: {url}"))?;
    let (authority, path) = rest
        .find('/')
        .map_or((rest, "/"), |i| (&rest[..i], &rest[i..]));
    let address = if authority.contains(':') {
        authority.to_owned()
    } else {
        format!("{authority}:80")
    };
    let work = async {
        let mut stream = tokio::net::TcpStream::connect(&address)
            .await
            .map_err(|e| format!("connect {address}: {e}"))?;
        let head = format!(
            "POST {path} HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        );
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        stream
            .write_all(body.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        // The status line is all that is needed: read until the end of the head (a collector that keeps the connection
        // open despite `Connection: close` must not cost the timeout).
        let mut response = Vec::with_capacity(512);
        let mut chunk = [0u8; 512];
        while !response.windows(4).any(|w| w == b"\r\n\r\n") && response.len() < 64 * 1024 {
            let n = stream.read(&mut chunk).await.map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            response.extend_from_slice(&chunk[..n]);
        }
        Ok::<_, String>(response)
    };
    let response = tokio::time::timeout(timeout, work)
        .await
        .map_err(|_| format!("timeout after {timeout:?}"))??;
    let status: u16 = std::str::from_utf8(&response)
        .ok()
        .and_then(|text| text.split_whitespace().nth(1))
        .and_then(|s| s.parse().ok())
        .ok_or("no status")?;
    if (200..300).contains(&status) {
        Ok(())
    } else {
        Err(format!("status {status}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn both_halves_of_an_op_share_a_trace_and_a_sample() {
        let client = ClientId::new("tab-a");
        let a = op_digest("f", &client, 7);
        assert_eq!(a, op_digest("f", &client, 7));
        assert_ne!(a, op_digest("f", &client, 8));
        assert!(sampled(&a, 1.0));
        assert!(!sampled(&a, 0.0));
        let picked = (0..20_000u64)
            .filter(|seq| sampled(&op_digest("f", &client, *seq), 0.01))
            .count();
        assert!(
            (120..=280).contains(&picked),
            "1 % of 20 000 ≈ 200, got {picked}"
        );
    }

    #[test]
    fn otlp_json_follows_the_json_mapping() {
        let end = UNIX_EPOCH + Duration::from_nanos(2_000_000_123);
        let span = Span {
            trace_id: [0xab; 16],
            span_id: [0x01; 8],
            name: "collab.op",
            start: UNIX_EPOCH + Duration::from_secs(1),
            end,
            attributes: vec![("file", Value::Str("f".into())), ("seq", Value::Int(7))],
        };
        let body: serde_json::Value =
            serde_json::from_str(&otlp_json("morfa-collab", "a", &[span])).unwrap();
        let resource = &body["resourceSpans"][0];
        assert_eq!(
            resource["resource"]["attributes"][0]["value"]["stringValue"],
            "morfa-collab"
        );
        let span = &resource["scopeSpans"][0]["spans"][0];
        assert_eq!(span["traceId"], "ab".repeat(16));
        assert_eq!(span["spanId"], "01".repeat(8));
        assert_eq!(span["startTimeUnixNano"], "1000000000");
        assert_eq!(span["endTimeUnixNano"], "2000000123");
        assert_eq!(span["attributes"][1]["value"]["intValue"], "7");
    }

    #[test]
    fn export_config_reads_the_otel_variables() {
        let vars = |pairs: &'static [(&'static str, &'static str)]| {
            move |name: &str| {
                pairs
                    .iter()
                    .find(|(k, _)| *k == name)
                    .map(|(_, v)| (*v).to_owned())
            }
        };
        assert_eq!(ExportConfig::from_lookup(vars(&[]), "a"), None);
        let config = ExportConfig::from_lookup(
            vars(&[("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318/")]),
            "a",
        )
        .unwrap();
        assert_eq!(config.url, "http://127.0.0.1:4318/v1/traces");
        assert_eq!(config.service, "morfa-collab");
        assert_eq!(
            (config.sample, config.slow),
            (0.01, Duration::from_millis(20))
        );
        let config = ExportConfig::from_lookup(
            vars(&[
                ("OTEL_EXPORTER_OTLP_ENDPOINT", "http://ignored:4318"),
                (
                    "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
                    "http://tempo:4318/v1/traces",
                ),
                ("MORFA_TRACE_SAMPLE", "2"),
                ("MORFA_TRACE_SLOW_MS", "5"),
            ]),
            "b",
        )
        .unwrap();
        assert_eq!(config.url, "http://tempo:4318/v1/traces");
        assert_eq!(
            config.sample, 0.01,
            "a fraction above 1 falls back to the default"
        );
        assert_eq!(config.slow, Duration::from_millis(5));
    }

    #[test]
    fn render_names_the_checkpoint_and_drain_metrics() {
        checkpoint_done(Duration::from_millis(5), false);
        let text = render();
        assert!(text.contains("collab_checkpoint_seconds_bucket{le=\"+Inf\"}"));
        assert!(text.contains("collab_checkpoint_failures_total "));
        assert!(text.contains("collab_draining "));
        assert!(text.contains("collab_build_info{"));
    }
}
