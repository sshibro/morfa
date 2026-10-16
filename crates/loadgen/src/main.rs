//! `loadgen`: N synthetic editors against Morfa's co-editing server (docs/TARGETS.md §3).
//!
//! ```text
//! loadgen --config run.json [--out result.json]
//! ```
//!
//! Each editor opens the file's live connection, sends one op a second that moves its 20 layers (today's
//! `PATCH /:id/document` body: the moved nodes plus their `before` copies) and cursor presence at `cursorHz`. Two modes:
//!
//! - `legacy`: today's Node server. A `text/event-stream` from `GET /api/design-files/:id/events` brings the others'
//!   changes and presence; ops are `PATCH /api/design-files/:id/document` (one in flight per editor, later ticks
//!   coalesce, as autosave does), presence is `POST /:id/presence` (one in flight).
//! - `ws`: the collab service's socket (`crates/protocol/schema.json` of lane B1, JSON text frames): `hello` →
//!   `welcome`, `op` → `ack`, the others' `change`s and `presence`. Mirrors the messages without depending on the crate.
//!
//! Printed (JSON): ack latency (op sent → its answer: the server's ack), arrival (op sent → the change seen at every other
//! editor of the file, M3), presence round trips, statuses, bytes, coalesced ticks, stream drops, reconnects, receiver
//! presence rates, the peak of open live connections, and this process's own CPU (it must never be the bottleneck).
//! Samples count only inside the measurement window (after `rampMs + warmupMs`, for `durationMs`).

mod hist;

use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use hist::{Histogram, HistogramJson};
use http_body_util::{BodyExt, Full};
use hyper::client::conn::http1::SendRequest;
use hyper_util::rt::TokioIo;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::sync::atomic::{AtomicI64, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, watch};

// ── Configuration ────────────────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum Mode {
    Legacy,
    Ws,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    mode: Mode,
    /// `http://host:port` (legacy) or `ws://host:port` (ws).
    base: String,
    /// The Origin header of writes (legacy: the app's origin, server/app.ts refuses others).
    #[serde(default)]
    origin: Option<String>,
    duration_ms: u64,
    #[serde(default)]
    warmup_ms: u64,
    /// Editors start spread over this long.
    #[serde(default)]
    ramp_ms: u64,
    #[serde(default = "default_op_interval")]
    op_interval_ms: u64,
    #[serde(default)]
    cursor_hz: f64,
    /// ws mode: the socket path, `{file}` replaced by the file id.
    #[serde(default = "default_ws_path")]
    ws_path: String,
    #[serde(default)]
    record_acked: bool,
    /// Cursors carry their send time (x = ms since the run started), so receivers measure presence delivery (M11).
    #[serde(default)]
    presence_probe: bool,
    #[serde(default)]
    threads: Option<usize>,
    /// ws mode: the protocol version `hello` asks for (2: others' changes as the fields that changed, lane W; 1: whole
    /// nodes). Only a change's version is read either way.
    #[serde(default = "default_protocol")]
    protocol: u32,
    files: Vec<FileConfig>,
}
fn default_op_interval() -> u64 {
    1000
}
fn default_protocol() -> u32 {
    2
}
fn default_ws_path() -> String {
    "/collab/{file}?wire=json".to_string()
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileConfig {
    id: String,
    version: u64,
    editors: Vec<EditorConfig>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EditorConfig {
    /// `forma_session=<token>` (legacy).
    #[serde(default)]
    cookie: String,
    /// `editor` sends ops; `viewer` only presence.
    #[serde(default = "default_role")]
    role: String,
    /// The layers this editor moves: whole SceneNode objects as the file holds them.
    #[serde(default)]
    nodes: Vec<Value>,
    /// A slow reader (TARGETS M12): the live stream is read at most this fast.
    #[serde(default)]
    read_bytes_per_second: Option<u64>,
    /// ws mode: the api-minted ticket and the client id.
    #[serde(default)]
    ticket: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    /// No presence from this editor.
    #[serde(default)]
    quiet: bool,
}
fn default_role() -> String {
    "editor".to_string()
}

// ── Shared state ─────────────────────────────────────────────────────────────────────────────────

struct Clock {
    start: Instant,
    window_from: Duration,
    window_to: Duration,
}
impl Clock {
    fn in_window(&self, at: Instant) -> bool {
        let t = at.duration_since(self.start);
        t >= self.window_from && t <= self.window_to
    }
    fn second(&self, at: Instant) -> usize {
        at.duration_since(self.start).as_secs() as usize
    }
}

/// Per file: when each version's op was sent (from its ack) and when each editor saw it.
#[derive(Default)]
struct FileTrack {
    sent: Mutex<Vec<(u64, Instant)>>,
    arrived: Mutex<Vec<(u64, Instant)>>,
}

#[derive(Default)]
struct Global {
    open_streams: AtomicI64,
    peak_streams: AtomicI64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct EditorStats {
    #[serde(skip)]
    ack: Histogram,
    #[serde(skip)]
    presence_rtt: Histogram,
    #[serde(skip)]
    presence_delivery: Histogram,
    statuses: BTreeMap<String, u64>,
    presence_statuses: BTreeMap<String, u64>,
    ops_sent: u64,
    ops_acked: u64,
    ops_coalesced: u64,
    presence_sent: u64,
    presence_coalesced: u64,
    bytes_in: u64,
    bytes_out: u64,
    changes_received: u64,
    presence_frames: u64,
    presence_entries: u64,
    stream_ends: u64,
    reconnects: u64,
    resyncs: u64,
    errors: u64,
    byes: BTreeMap<String, u64>,
    /// (seq, version, x offset) of every acked op, when recordAcked.
    acked: Vec<(u64, u64, u64)>,
    #[serde(skip)]
    acks_per_second: Vec<u32>,
    #[serde(skip)]
    errors_per_second: Vec<u32>,
    #[serde(skip)]
    window_presence_entries: u64,
}

fn bump(map: &mut BTreeMap<String, u64>, key: impl ToString) {
    *map.entry(key.to_string()).or_insert(0) += 1;
}
fn bump_second(series: &mut Vec<u32>, second: usize) {
    if series.len() <= second {
        series.resize(second + 1, 0);
    }
    series[second] += 1;
}

struct Editor {
    index: usize,
    probe: bool,
    file: Arc<String>,
    config: EditorConfig,
    track: Arc<FileTrack>,
    stats: Arc<Mutex<EditorStats>>,
    clock: Arc<Clock>,
    global: Arc<Global>,
    /// The newest version this editor knows (its acks and the others' changes).
    known: Arc<AtomicU64>,
    stop: watch::Receiver<bool>,
}

// ── HTTP/1.1 on our own connections ──────────────────────────────────────────────────────────────

struct Http {
    host: String,
    addr: String,
    origin: String,
    sender: Option<SendRequest<Full<Bytes>>>,
}

impl Http {
    fn new(base: &str, origin: &Option<String>) -> Http {
        let rest = base.trim_start_matches("http://").trim_end_matches('/');
        Http {
            host: rest.to_string(),
            addr: rest.to_string(),
            origin: origin.clone().unwrap_or_else(|| base.to_string()),
            sender: None,
        }
    }

    async fn connect(&self) -> Result<SendRequest<Full<Bytes>>, String> {
        let stream = TcpStream::connect(&self.addr)
            .await
            .map_err(|e| format!("connect: {e}"))?;
        stream.set_nodelay(true).ok();
        let (sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(stream))
            .await
            .map_err(|e| format!("handshake: {e}"))?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(sender)
    }

    fn request(
        &self,
        method: &str,
        path: &str,
        cookie: &str,
        body: Option<Vec<u8>>,
    ) -> hyper::Request<Full<Bytes>> {
        let mut builder = hyper::Request::builder()
            .method(method)
            .uri(path)
            .header(hyper::header::HOST, &self.host)
            .header(hyper::header::COOKIE, cookie);
        if body.is_some() {
            builder = builder
                .header(hyper::header::CONTENT_TYPE, "application/json")
                .header(hyper::header::ORIGIN, &self.origin);
        }
        builder
            .body(Full::new(body.map(Bytes::from).unwrap_or_default()))
            .expect("request")
    }

    /// Sends one request on this connection (reconnecting once when it was closed) and reads the whole answer.
    async fn send(&mut self, request: hyper::Request<Full<Bytes>>) -> Result<(u16, Bytes), String> {
        if self.sender.as_ref().is_none_or(|sender| sender.is_closed()) {
            self.sender = Some(self.connect().await?);
        }
        let sender = self.sender.as_mut().expect("sender");
        if sender.ready().await.is_err() {
            self.sender = Some(self.connect().await?);
        }
        let sender = self.sender.as_mut().expect("sender");
        let response = match sender.send_request(request).await {
            Ok(response) => response,
            Err(error) => {
                self.sender = None;
                return Err(format!("send: {error}"));
            }
        };
        let status = response.status().as_u16();
        let body = response
            .into_body()
            .collect()
            .await
            .map_err(|e| format!("body: {e}"))?
            .to_bytes();
        Ok((status, body))
    }
}

// ── Ops ──────────────────────────────────────────────────────────────────────────────────────────

/// The editor's layers as JSON objects, each with its starting x; op `seq` puts every one at x0 + seq.
struct Layers {
    /// Per layer: `"id":` and its JSON split around the value of x (rendered once; an op only writes the numbers).
    nodes: Vec<(String, String, String, f64)>,
}

/// A value no layer has, to find where x goes in a node's JSON.
const X_MARK: f64 = 987_654_321.125;

impl Layers {
    fn new(nodes: &[Value]) -> Layers {
        Layers {
            nodes: nodes
                .iter()
                .filter_map(|node| {
                    let mut object = node.as_object()?.clone();
                    let id = object.get("id")?.as_str()?.to_string();
                    let x = object.get("x").and_then(Value::as_f64).unwrap_or(0.0);
                    object.insert("x".into(), json!(X_MARK));
                    let text = serde_json::to_string(&Value::Object(object)).ok()?;
                    let mark = X_MARK.to_string();
                    let at = text.find(&mark)?;
                    Some((
                        serde_json::to_string(&id).ok()?,
                        text[..at].to_string(),
                        text[at + mark.len()..].to_string(),
                        x,
                    ))
                })
                .collect(),
        }
    }

    /// `{"<id>":<node at x0 + seq>,…}` for the patch and the same at x0 + seq − 1 for `before`.
    fn at(&self, seq: u64) -> (String, String) {
        let mut patch = String::with_capacity(16 * 1024);
        let mut before = String::with_capacity(16 * 1024);
        for (target, offset) in [(&mut patch, 0), (&mut before, 1)] {
            target.push('{');
            for (i, (id, head, tail, x0)) in self.nodes.iter().enumerate() {
                if i > 0 {
                    target.push(',');
                }
                let x = x0 + seq.saturating_sub(offset) as f64;
                target.push_str(id);
                target.push(':');
                target.push_str(head);
                target.push_str(
                    &serde_json::Number::from_f64(x)
                        .map(|n| n.to_string())
                        .unwrap_or_else(|| "0".into()),
                );
                target.push_str(tail);
            }
            target.push('}');
        }
        (patch, before)
    }

    /// Protocol 2's field op of the same move (lane W): `{"set":{"<id>":{"x":…}},"was":{"<id>":{"x":…}}}`.
    fn fields_at(&self, seq: u64) -> String {
        let number = |x: f64| {
            serde_json::Number::from_f64(x)
                .map(|n| n.to_string())
                .unwrap_or_else(|| "0".into())
        };
        let mut out = String::with_capacity(64 * self.nodes.len() + 32);
        for (key, offset) in [("set", 0), ("was", 1)] {
            out.push_str(if key == "set" {
                "{\"set\":{"
            } else {
                "},\"was\":{"
            });
            for (i, (id, _, _, x0)) in self.nodes.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push_str(id);
                out.push_str(":{\"x\":");
                out.push_str(&number(x0 + seq.saturating_sub(offset) as f64));
                out.push('}');
            }
        }
        out.push_str("}}");
        out
    }
}

#[derive(Deserialize)]
struct Saved {
    version: u64,
    #[serde(default)]
    resync: bool,
}

// ── Legacy: SSE + PATCH ──────────────────────────────────────────────────────────────────────────

struct Hello {
    connection: String,
    token: String,
}

/// Reads one event stream until it ends or the run stops; `true` when it ended by itself (reconnect).
async fn legacy_stream(
    editor: &Editor,
    base: &str,
    hello_tx: &watch::Sender<Option<Arc<Hello>>>,
) -> bool {
    let http = Http::new(base, &None);
    let mut stop = editor.stop.clone();
    let since = editor.known.load(Ordering::Relaxed);
    let path = format!("/api/design-files/{}/events?since={since}", editor.file);
    let mut sender = match http.connect().await {
        Ok(sender) => sender,
        Err(_) => {
            editor.stats.lock().unwrap().errors += 1;
            return true;
        }
    };
    let response = match sender
        .send_request(http.request("GET", &path, &editor.config.cookie, None))
        .await
    {
        Ok(response) => response,
        Err(_) => {
            editor.stats.lock().unwrap().errors += 1;
            return true;
        }
    };
    if response.status() != 200 {
        let status = response.status().as_u16();
        let mut stats = editor.stats.lock().unwrap();
        bump(&mut stats.statuses, format!("events {status}"));
        stats.errors += 1;
        return true;
    }
    let mut body = response.into_body();
    let mut buffer: Vec<u8> = Vec::with_capacity(64 * 1024);
    let mut counted = false;
    let rate = editor.config.read_bytes_per_second;
    let ended = loop {
        let frame = tokio::select! {
            frame = body.frame() => frame,
            _ = stop.changed() => break false,
        };
        let Some(Ok(frame)) = frame else { break true };
        let Ok(data) = frame.into_data() else {
            continue;
        };
        let now = Instant::now();
        buffer.extend_from_slice(&data);
        {
            let mut stats = editor.stats.lock().unwrap();
            stats.bytes_in += data.len() as u64;
        }
        while let Some(end) = find(&buffer, b"\n\n") {
            let block: Vec<u8> = buffer.drain(..end + 2).collect();
            if let Some(hello) = handle_event(editor, &block, now) {
                if !counted {
                    counted = true;
                    let open = editor.global.open_streams.fetch_add(1, Ordering::Relaxed) + 1;
                    editor
                        .global
                        .peak_streams
                        .fetch_max(open, Ordering::Relaxed);
                }
                hello_tx.send_replace(Some(Arc::new(hello)));
            }
        }
        if let Some(rate) = rate {
            let wait = Duration::from_secs_f64(data.len() as f64 / rate.max(1) as f64);
            tokio::select! {
                _ = tokio::time::sleep(wait) => {},
                _ = stop.changed() => break false,
            }
        }
    };
    if counted {
        editor.global.open_streams.fetch_sub(1, Ordering::Relaxed);
    }
    if ended {
        editor.stats.lock().unwrap().stream_ends += 1;
    }
    ended
}

#[cfg(test)]
mod layer_tests {
    use super::*;

    #[test]
    fn an_op_is_the_nodes_at_x0_plus_seq_with_their_before_copies() {
        let nodes = vec![
            // A Cyrillic name: the patch text keeps non-ASCII intact.
            json!({"id": "n1", "type": "RECTANGLE", "x": 20, "y": 5, "name": "Прямоугольник"}),
            json!({"id": "n2", "x": 130.5, "y": 5}),
        ];
        let (patch, before) = Layers::new(&nodes).at(3);
        let patch: Value = serde_json::from_str(&patch).unwrap();
        let before: Value = serde_json::from_str(&before).unwrap();
        assert_eq!(patch["n1"]["x"].as_f64(), Some(23.0));
        assert_eq!(patch["n2"]["x"].as_f64(), Some(133.5));
        assert_eq!(before["n1"]["x"].as_f64(), Some(22.0));
        assert_eq!(patch["n1"]["name"], "Прямоугольник");
        assert_eq!(patch["n1"]["y"].as_f64(), Some(5.0));
        // Protocol 2: the same move as the field it writes, with the base value.
        let fields: Value = serde_json::from_str(&Layers::new(&nodes).fields_at(3)).unwrap();
        assert_eq!(
            fields,
            json!({"set": {"n1": {"x": 23.0}, "n2": {"x": 133.5}}, "was": {"n1": {"x": 22.0}, "n2": {"x": 132.5}}})
        );
    }

    #[test]
    fn frames_are_read_without_a_parse() {
        let frame =
            br#"{"t":"change","version":42,"by":"c","patch":{"nodes":{"a":{"version":7}}}}"#;
        assert_eq!(frame_tag(frame), b"change");
        assert_eq!(number_after(frame, b"\"version\":"), Some(42));
        assert_eq!(frame_tag(b"{\"x\":1}"), b"");
    }
}

/// The tag of a socket frame: the value of its first key `"t"`.
fn frame_tag(frame: &[u8]) -> &[u8] {
    let Some(rest) = frame.strip_prefix(b"{\"t\":\"") else {
        return b"";
    };
    let end = rest.iter().position(|&b| b == b'"').unwrap_or(0);
    &rest[..end]
}

/// The whole number right after the first `key` (e.g. `"version":`).
fn number_after(frame: &[u8], key: &[u8]) -> Option<u64> {
    let at = find(frame, key)? + key.len();
    let digits: &[u8] = &frame[at..];
    let end = digits
        .iter()
        .position(|b| !b.is_ascii_digit())
        .unwrap_or(digits.len());
    std::str::from_utf8(&digits[..end]).ok()?.parse().ok()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
fn count(haystack: &[u8], needle: &[u8]) -> u64 {
    let mut n = 0;
    let mut at = 0;
    while let Some(found) = find(&haystack[at..], needle) {
        n += 1;
        at += found + needle.len();
    }
    n
}

/// Presence entries whose cursor x is the send time (ms since the start): now − x is the delivery time.
fn record_delivery(clock: &Clock, histogram: &mut Histogram, value: &Value, now: Instant) {
    let Some(peers) = value.get("peers").and_then(Value::as_array) else {
        return;
    };
    let now_ms = now.duration_since(clock.start).as_secs_f64() * 1000.0;
    for peer in peers {
        if let Some(x) = peer
            .get("cursor")
            .and_then(|cursor| cursor.get("x"))
            .and_then(Value::as_f64)
            && x > 0.0
            && x <= now_ms
        {
            histogram.record_ms(now_ms - x);
        }
    }
}

/// One SSE event block; answers the hello when it is one.
fn handle_event(editor: &Editor, block: &[u8], now: Instant) -> Option<Hello> {
    let mut name: &[u8] = b"message";
    let mut id: Option<u64> = None;
    let mut data: &[u8] = b"";
    for line in block.split(|&b| b == b'\n') {
        if let Some(rest) = line.strip_prefix(b"event: ") {
            name = rest;
        } else if let Some(rest) = line.strip_prefix(b"id: ") {
            id = std::str::from_utf8(rest)
                .ok()
                .and_then(|text| text.parse().ok());
        } else if let Some(rest) = line.strip_prefix(b"data: ") {
            data = rest;
        }
    }
    match name {
        b"change" => {
            if let Some(version) = id {
                editor.known.fetch_max(version, Ordering::Relaxed);
                editor.track.arrived.lock().unwrap().push((version, now));
                editor.stats.lock().unwrap().changes_received += 1;
            }
            None
        }
        b"presence" => {
            let entries = count(data, b"\"connection\":");
            let mut stats = editor.stats.lock().unwrap();
            stats.presence_frames += 1;
            stats.presence_entries += entries;
            if editor.clock.in_window(now) {
                stats.window_presence_entries += entries;
                if editor.probe
                    && let Ok(value) = serde_json::from_slice::<Value>(data)
                {
                    record_delivery(&editor.clock, &mut stats.presence_delivery, &value, now);
                }
            }
            None
        }
        b"hello" => {
            let value: Value = serde_json::from_slice(data).ok()?;
            if let Some(version) = value.get("version").and_then(Value::as_u64) {
                editor.known.fetch_max(version, Ordering::Relaxed);
            }
            Some(Hello {
                connection: value.get("connection")?.as_str()?.to_string(),
                token: value.get("token")?.as_str()?.to_string(),
            })
        }
        b"resync" => {
            let value: Option<Value> = serde_json::from_slice(data).ok();
            if let Some(version) = value
                .as_ref()
                .and_then(|v| v.get("version"))
                .and_then(Value::as_u64)
            {
                editor.known.fetch_max(version, Ordering::Relaxed);
            }
            editor.stats.lock().unwrap().resyncs += 1;
            None
        }
        b"bye" => {
            let value: Option<Value> = serde_json::from_slice(data).ok();
            let reason = value
                .as_ref()
                .and_then(|v| v.get("reason"))
                .and_then(Value::as_str)
                .unwrap_or("?")
                .to_string();
            bump(&mut editor.stats.lock().unwrap().byes, reason);
            None
        }
        _ => None,
    }
}

async fn legacy_editor(editor: Arc<Editor>, config: Arc<Config>) {
    let (hello_tx, hello_rx) = watch::channel::<Option<Arc<Hello>>>(None);
    let hello_tx = Arc::new(hello_tx);
    // The stream, reconnecting like the editor does (after 500 ms, with `since`).
    let stream = {
        let editor = editor.clone();
        let base = config.base.clone();
        let hello_tx = hello_tx.clone();
        tokio::spawn(async move {
            loop {
                let ended = legacy_stream(&editor, &base, &hello_tx).await;
                if !ended || *editor.stop.borrow() {
                    break;
                }
                editor.stats.lock().unwrap().reconnects += 1;
                tokio::time::sleep(Duration::from_millis(500)).await;
                if *editor.stop.borrow() {
                    break;
                }
            }
        })
    };
    let mut ready = hello_rx.clone();
    let mut stop = editor.stop.clone();
    tokio::select! {
        _ = ready.wait_for(|hello| hello.is_some()) => {},
        _ = stop.wait_for(|stopped| *stopped) => {},
    }
    let ops = (editor.config.role == "editor" && !editor.config.nodes.is_empty()).then(|| {
        let editor = editor.clone();
        let config = config.clone();
        let hello_rx = hello_rx.clone();
        tokio::spawn(async move { legacy_ops(editor, config, hello_rx).await })
    });
    let presence = (config.cursor_hz > 0.0 && !editor.config.quiet).then(|| {
        let editor = editor.clone();
        let config = config.clone();
        let hello_rx = hello_rx.clone();
        tokio::spawn(async move { legacy_presence(editor, config, hello_rx).await })
    });
    let _ = stop.wait_for(|stopped| *stopped).await;
    if let Some(ops) = ops {
        let _ = tokio::time::timeout(Duration::from_secs(5), ops).await;
    }
    if let Some(presence) = presence {
        let _ = tokio::time::timeout(Duration::from_secs(2), presence).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(2), stream).await;
}

async fn legacy_ops(
    editor: Arc<Editor>,
    config: Arc<Config>,
    hello: watch::Receiver<Option<Arc<Hello>>>,
) {
    let layers = Layers::new(&editor.config.nodes);
    let mut http = Http::new(&config.base, &config.origin);
    let path = format!("/api/design-files/{}/document", editor.file);
    let interval = Duration::from_millis(config.op_interval_ms.max(1));
    // Spread the editors' ticks over the interval.
    let phase = Duration::from_millis((editor.index as u64 * 7919) % config.op_interval_ms.max(1));
    let mut ticker = tokio::time::interval_at(tokio::time::Instant::now() + phase, interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut stop = editor.stop.clone();
    let mut seq: u64 = 0;
    loop {
        // One op in flight: ticks that pass while it runs are coalesced into the next one (Delay fires it at once).
        tokio::select! {
            _ = ticker.tick() => {},
            _ = stop.changed() => break,
        }
        if *editor.stop.borrow() {
            break;
        }
        seq += 1;
        let (patch, before) = layers.at(seq);
        let client = hello
            .borrow()
            .as_ref()
            .map(|hello| serde_json::to_string(&hello.connection).unwrap_or_else(|_| "null".into()))
            .unwrap_or_else(|| "null".into());
        let base = editor.known.load(Ordering::Relaxed).max(1);
        let bytes = format!(r#"{{"baseVersion":{base},"patch":{{"nodes":{patch}}},"before":{before},"client":{client}}}"#).into_bytes();
        let request = http.request("PATCH", &path, &editor.config.cookie, Some(bytes.clone()));
        let sent = Instant::now();
        {
            let mut stats = editor.stats.lock().unwrap();
            stats.ops_sent += 1;
            stats.bytes_out += bytes.len() as u64;
        }
        let result = http.send(request).await;
        let now = Instant::now();
        let mut stats = editor.stats.lock().unwrap();
        stats.ops_coalesced +=
            (now.duration_since(sent).as_secs_f64() / interval.as_secs_f64()).floor() as u64;
        match result {
            Ok((200, body)) => {
                stats.bytes_in += body.len() as u64;
                bump(&mut stats.statuses, 200);
                if let Ok(saved) = serde_json::from_slice::<Saved>(&body) {
                    editor.known.fetch_max(saved.version, Ordering::Relaxed);
                    if saved.resync {
                        stats.resyncs += 1;
                    }
                    stats.ops_acked += 1;
                    if config.record_acked {
                        stats.acked.push((seq, saved.version, seq));
                    }
                    if editor.clock.in_window(sent) {
                        stats
                            .ack
                            .record_ms(now.duration_since(sent).as_secs_f64() * 1000.0);
                    }
                    let second = editor.clock.second(now);
                    bump_second(&mut stats.acks_per_second, second);
                    drop(stats);
                    editor
                        .track
                        .sent
                        .lock()
                        .unwrap()
                        .push((saved.version, sent));
                }
            }
            Ok((status, body)) => {
                stats.bytes_in += body.len() as u64;
                let code = serde_json::from_slice::<Value>(&body)
                    .ok()
                    .and_then(|v| v.get("code").and_then(Value::as_str).map(str::to_string))
                    .unwrap_or_default();
                bump(
                    &mut stats.statuses,
                    if code.is_empty() {
                        status.to_string()
                    } else {
                        format!("{status} {code}")
                    },
                );
                let second = editor.clock.second(now);
                bump_second(&mut stats.errors_per_second, second);
                // A refused op is sent again with the next tick (autosave retries), x keeps growing.
            }
            Err(error) => {
                stats.errors += 1;
                bump(
                    &mut stats.statuses,
                    format!("error {}", error.split(':').next().unwrap_or("?")),
                );
                let second = editor.clock.second(now);
                bump_second(&mut stats.errors_per_second, second);
            }
        }
    }
}

/// The cursor of step `step`: a circle, or with the probe the send time (x) and the editor (y).
fn cursor_at(editor: &Editor, step: u64) -> (f64, f64) {
    if editor.probe {
        return (
            Instant::now()
                .duration_since(editor.clock.start)
                .as_secs_f64()
                * 1000.0,
            editor.index as f64,
        );
    }
    let angle = step as f64 / 30.0;
    (
        400.0 + 300.0 * angle.cos() + editor.index as f64,
        300.0 + 200.0 * angle.sin(),
    )
}

async fn legacy_presence(
    editor: Arc<Editor>,
    config: Arc<Config>,
    hello: watch::Receiver<Option<Arc<Hello>>>,
) {
    let mut http = Http::new(&config.base, &config.origin);
    let path = format!("/api/design-files/{}/presence", editor.file);
    let interval = Duration::from_secs_f64(1.0 / config.cursor_hz.max(0.1));
    let mut ticker = tokio::time::interval(interval);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut stop = editor.stop.clone();
    let mut step: u64 = 0;
    loop {
        tokio::select! {
            _ = ticker.tick() => {},
            _ = stop.changed() => break,
        }
        if *editor.stop.borrow() {
            break;
        }
        let Some(token) = hello.borrow().as_ref().map(|hello| hello.token.clone()) else {
            continue;
        };
        step += 1;
        let (x, y) = cursor_at(&editor, step);
        let body = format!(r#"{{"token":"{token}","cursor":{{"x":{x:.1},"y":{y:.1}}}}}"#);
        let length = body.len() as u64;
        let request = http.request(
            "POST",
            &path,
            &editor.config.cookie,
            Some(body.into_bytes()),
        );
        let sent = Instant::now();
        let result = http.send(request).await;
        let now = Instant::now();
        let mut stats = editor.stats.lock().unwrap();
        stats.presence_sent += 1;
        stats.bytes_out += length;
        // A tick missed while the post was in flight is skipped (coalesced), as the editor does.
        let missed =
            (now.duration_since(sent).as_secs_f64() / interval.as_secs_f64()).floor() as u64;
        stats.presence_coalesced += missed;
        match result {
            Ok((status, _)) => {
                bump(&mut stats.presence_statuses, status);
                if editor.clock.in_window(sent) {
                    stats
                        .presence_rtt
                        .record_ms(now.duration_since(sent).as_secs_f64() * 1000.0);
                }
            }
            Err(_) => bump(&mut stats.presence_statuses, "error"),
        }
    }
}

// ── ws: the collab socket ────────────────────────────────────────────────────────────────────────

async fn ws_editor(editor: Arc<Editor>, config: Arc<Config>) {
    let url = format!(
        "{}{}",
        config.base.trim_end_matches('/'),
        config.ws_path.replace("{file}", &editor.file)
    );
    let mut stop = editor.stop.clone();
    // TCP_NODELAY as browsers set it on WebSockets (lane B5): with Nagle on, an op frame behind an unacknowledged one waits
    // for the server's delayed ACK, which added about one RTT to M2/M3/M11 over ru-net.
    let Ok((socket, _)) =
        tokio_tungstenite::connect_async_with_config(url.as_str(), None, true).await
    else {
        editor.stats.lock().unwrap().errors += 1;
        return;
    };
    let (mut sink, mut source) = socket.split();
    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<String>();
    let writer = {
        let editor = editor.clone();
        tokio::spawn(async move {
            while let Some(text) = out_rx.recv().await {
                editor.stats.lock().unwrap().bytes_out += text.len() as u64;
                if sink
                    .send(tokio_tungstenite::tungstenite::Message::text(text))
                    .await
                    .is_err()
                {
                    break;
                }
            }
            let _ = sink.close().await;
        })
    };
    let client_id = editor
        .config
        .client_id
        .clone()
        .unwrap_or_else(|| format!("loadgen-{}", editor.index));
    let hello = json!({"t": "hello", "ticket": editor.config.ticket.clone().unwrap_or_default(), "clientId": client_id, "since": editor.known.load(Ordering::Relaxed), "lastSeq": 0, "protocol": config.protocol});
    let _ = out_tx.send(hello.to_string());
    let sent_at: Arc<Mutex<BTreeMap<u64, Instant>>> = Arc::default();
    let welcomed = Arc::new(tokio::sync::Notify::new());
    let reader = {
        let editor = editor.clone();
        let sent_at = sent_at.clone();
        let welcomed = welcomed.clone();
        let record_acked = config.record_acked;
        tokio::spawn(async move {
            let mut counted = false;
            let mut stop = editor.stop.clone();
            loop {
                let message = tokio::select! {
                    message = source.next() => message,
                    _ = stop.changed() => break,
                };
                let Some(Ok(message)) = message else {
                    editor.stats.lock().unwrap().stream_ends += 1;
                    break;
                };
                let now = Instant::now();
                let Ok(text) = message.into_text() else {
                    continue;
                };
                editor.stats.lock().unwrap().bytes_in += text.len() as u64;
                // A slow reader (TARGETS M12, lane B5): it takes frames no faster than `readBytesPerSecond`, so the
                // socket's TCP window fills and the server's backpressure is what the run measures.
                if let Some(rate) = editor.config.read_bytes_per_second.filter(|rate| *rate > 0) {
                    tokio::time::sleep(Duration::from_secs_f64(text.len() as f64 / rate as f64))
                        .await;
                }
                // The big frames are read without a parse (the tag is the first key, schema.json): a change only for its
                // version, presence only counted unless the probe needs the cursors. loadgen must not be the bottleneck.
                let bytes = text.as_bytes();
                let tag = frame_tag(bytes);
                if tag == b"change" {
                    if let Some(version) = number_after(bytes, b"\"version\":") {
                        editor.known.fetch_max(version, Ordering::Relaxed);
                        editor.track.arrived.lock().unwrap().push((version, now));
                        editor.stats.lock().unwrap().changes_received += 1;
                    }
                    continue;
                }
                if tag == b"presence" && !editor.probe {
                    let entries = count(bytes, b"\"connection\":");
                    let mut stats = editor.stats.lock().unwrap();
                    stats.presence_frames += 1;
                    stats.presence_entries += entries;
                    if editor.clock.in_window(now) {
                        stats.window_presence_entries += entries;
                    }
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(text.as_str()) else {
                    continue;
                };
                match value.get("t").and_then(Value::as_str).unwrap_or("") {
                    "welcome" => {
                        if let Some(version) = value.get("version").and_then(Value::as_u64) {
                            editor.known.fetch_max(version, Ordering::Relaxed);
                        }
                        if !counted {
                            counted = true;
                            let open =
                                editor.global.open_streams.fetch_add(1, Ordering::Relaxed) + 1;
                            editor
                                .global
                                .peak_streams
                                .fetch_max(open, Ordering::Relaxed);
                        }
                        welcomed.notify_one();
                    }
                    "ack" => {
                        let seq = value.get("seq").and_then(Value::as_u64).unwrap_or(0);
                        let version = value.get("version").and_then(Value::as_u64).unwrap_or(0);
                        editor.known.fetch_max(version, Ordering::Relaxed);
                        let sent = sent_at.lock().unwrap().remove(&seq);
                        let mut stats = editor.stats.lock().unwrap();
                        stats.ops_acked += 1;
                        bump(&mut stats.statuses, "ack");
                        if record_acked {
                            stats.acked.push((seq, version, seq));
                        }
                        let second = editor.clock.second(now);
                        bump_second(&mut stats.acks_per_second, second);
                        if let Some(sent) = sent {
                            if editor.clock.in_window(sent) {
                                stats
                                    .ack
                                    .record_ms(now.duration_since(sent).as_secs_f64() * 1000.0);
                            }
                            drop(stats);
                            editor.track.sent.lock().unwrap().push((version, sent));
                        }
                    }
                    "refused" => {
                        let code = value
                            .get("code")
                            .and_then(Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        let seq = value.get("seq").and_then(Value::as_u64).unwrap_or(0);
                        sent_at.lock().unwrap().remove(&seq);
                        let mut stats = editor.stats.lock().unwrap();
                        bump(&mut stats.statuses, format!("refused {code}"));
                        let second = editor.clock.second(now);
                        bump_second(&mut stats.errors_per_second, second);
                    }
                    "change" => {
                        if let Some(version) = value.get("version").and_then(Value::as_u64) {
                            editor.known.fetch_max(version, Ordering::Relaxed);
                            editor.track.arrived.lock().unwrap().push((version, now));
                            editor.stats.lock().unwrap().changes_received += 1;
                        }
                    }
                    "changes" => {
                        if let Some(list) = value.get("changes").and_then(Value::as_array) {
                            for change in list {
                                if let Some(version) = change.get("version").and_then(Value::as_u64)
                                {
                                    editor.known.fetch_max(version, Ordering::Relaxed);
                                }
                            }
                        }
                    }
                    "presence" => {
                        let entries = value
                            .get("peers")
                            .and_then(Value::as_array)
                            .map(|peers| peers.len() as u64)
                            .unwrap_or(1);
                        let mut stats = editor.stats.lock().unwrap();
                        stats.presence_frames += 1;
                        stats.presence_entries += entries;
                        if editor.clock.in_window(now) {
                            stats.window_presence_entries += entries;
                            if editor.probe {
                                record_delivery(
                                    &editor.clock,
                                    &mut stats.presence_delivery,
                                    &value,
                                    now,
                                );
                            }
                        }
                    }
                    "resync" | "rollback" | "catchUp" => editor.stats.lock().unwrap().resyncs += 1,
                    "bye" => {
                        let reason = value
                            .get("reason")
                            .and_then(Value::as_str)
                            .unwrap_or("?")
                            .to_string();
                        bump(&mut editor.stats.lock().unwrap().byes, reason);
                    }
                    _ => {}
                }
            }
            if counted {
                editor.global.open_streams.fetch_sub(1, Ordering::Relaxed);
            }
        })
    };
    tokio::select! {
        _ = welcomed.notified() => {},
        _ = stop.wait_for(|stopped| *stopped) => {},
        _ = tokio::time::sleep(Duration::from_secs(15)) => { editor.stats.lock().unwrap().errors += 1; },
    }
    let layers = Layers::new(&editor.config.nodes);
    let sends_ops = editor.config.role == "editor" && !layers.nodes.is_empty();
    let op_interval = Duration::from_millis(config.op_interval_ms.max(1));
    let phase = Duration::from_millis((editor.index as u64 * 7919) % config.op_interval_ms.max(1));
    let mut ops = tokio::time::interval_at(tokio::time::Instant::now() + phase, op_interval);
    let cursor_every = Duration::from_secs_f64(1.0 / config.cursor_hz.max(0.1));
    let mut cursors = tokio::time::interval(cursor_every);
    cursors.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let presence = config.cursor_hz > 0.0 && !editor.config.quiet;
    let mut seq = 0u64;
    let mut step = 0u64;
    loop {
        tokio::select! {
            _ = ops.tick(), if sends_ops => {
                seq += 1;
                let base = editor.known.load(Ordering::Relaxed);
                let message = if config.protocol >= 2 {
                    let fields = layers.fields_at(seq);
                    format!(r#"{{"t":"op","seq":{seq},"baseVersion":{base},"patch":{{}},"fields":{fields}}}"#)
                } else {
                    let (patch, before) = layers.at(seq);
                    format!(r#"{{"t":"op","seq":{seq},"baseVersion":{base},"patch":{{"nodes":{patch}}},"before":{before}}}"#)
                };
                sent_at.lock().unwrap().insert(seq, Instant::now());
                editor.stats.lock().unwrap().ops_sent += 1;
                if out_tx.send(message).is_err() { break; }
            }
            _ = cursors.tick(), if presence => {
                step += 1;
                let (x, y) = cursor_at(&editor, step);
                let message = format!(r#"{{"t":"presence","cursor":{{"x":{x:.1},"y":{y:.1}}}}}"#);
                editor.stats.lock().unwrap().presence_sent += 1;
                if out_tx.send(message).is_err() { break; }
            }
            _ = stop.changed() => break,
        }
        if *editor.stop.borrow() {
            break;
        }
    }
    drop(out_tx);
    let _ = tokio::time::timeout(Duration::from_secs(2), writer).await;
    let _ = tokio::time::timeout(Duration::from_secs(2), reader).await;
}

// ── The run ──────────────────────────────────────────────────────────────────────────────────────

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    mode: Mode,
    editors: usize,
    viewers: usize,
    files: usize,
    duration_ms: u64,
    window_ms: u64,
    wall_ms: f64,
    ack: HistogramJson,
    arrival: HistogramJson,
    presence_rtt: HistogramJson,
    presence_delivery: HistogramJson,
    statuses: BTreeMap<String, u64>,
    presence_statuses: BTreeMap<String, u64>,
    byes: BTreeMap<String, u64>,
    ops_sent: u64,
    ops_acked: u64,
    ops_coalesced: u64,
    presence_sent: u64,
    presence_coalesced: u64,
    bytes_in: u64,
    bytes_out: u64,
    changes_received: u64,
    presence_frames: u64,
    presence_entries: u64,
    /// Presence entries a receiver got per other person per second in the window: median and max over receivers.
    receiver_hz_median: f64,
    receiver_hz_max: f64,
    stream_ends: u64,
    reconnects: u64,
    resyncs: u64,
    errors: u64,
    peak_streams: i64,
    acks_per_second: Vec<u32>,
    errors_per_second: Vec<u32>,
    self_cpu_ms: Option<f64>,
    self_cores: Option<f64>,
    acked: Vec<AckedOps>,
}

#[derive(Serialize)]
struct AckedOps {
    file: String,
    editor: usize,
    /// (seq, version, x offset)
    ops: Vec<(u64, u64, u64)>,
}

/// This process's CPU time in milliseconds: /proc on Linux, `ps` elsewhere (no unsafe code for getrusage).
fn self_cpu_ms() -> Option<f64> {
    if let Ok(stat) = std::fs::read_to_string("/proc/self/stat") {
        let fields: Vec<&str> = stat.rsplit(')').next()?.split_whitespace().collect();
        let ticks: f64 =
            fields.get(11)?.parse::<f64>().ok()? + fields.get(12)?.parse::<f64>().ok()?;
        return Some(ticks * 10.0);
    }
    let output = std::process::Command::new("ps")
        .args(["-o", "time=", "-p", &std::process::id().to_string()])
        .output()
        .ok()?;
    let text = String::from_utf8(output.stdout).ok()?;
    let mut seconds = 0.0;
    for part in text.trim().split(':') {
        seconds = seconds * 60.0 + part.replace('-', "").parse::<f64>().ok()?;
    }
    Some(seconds * 1000.0)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let value = |name: &str| {
        args.iter()
            .position(|arg| arg == name)
            .and_then(|i| args.get(i + 1))
            .cloned()
    };
    let Some(config_path) = value("--config") else {
        eprintln!("usage: loadgen --config run.json [--out result.json]");
        std::process::exit(2);
    };
    let text =
        std::fs::read_to_string(&config_path).unwrap_or_else(|e| panic!("{config_path}: {e}"));
    let config: Config =
        serde_json::from_str(&text).unwrap_or_else(|e| panic!("{config_path}: {e}"));
    let threads = config.threads.unwrap_or(2).max(1);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(threads)
        .enable_all()
        .build()
        .expect("runtime");
    let report = runtime.block_on(run(Arc::new(config)));
    let json = serde_json::to_string(&report).expect("report");
    match value("--out") {
        Some(out) => std::fs::write(&out, json).unwrap_or_else(|e| panic!("{out}: {e}")),
        None => println!("{json}"),
    }
    runtime.shutdown_timeout(Duration::from_secs(1));
}

async fn run(config: Arc<Config>) -> Report {
    let cpu_before = self_cpu_ms();
    let start = Instant::now();
    let window_from = Duration::from_millis(config.ramp_ms + config.warmup_ms);
    let window_to = window_from + Duration::from_millis(config.duration_ms);
    let clock = Arc::new(Clock {
        start,
        window_from,
        window_to,
    });
    let global = Arc::new(Global::default());
    let (stop_tx, stop_rx) = watch::channel(false);
    let total: usize = config.files.iter().map(|file| file.editors.len()).sum();
    let mut editors = Vec::new();
    let mut tracks = Vec::new();
    let mut tasks = Vec::new();
    let mut index = 0;
    for file in &config.files {
        let track = Arc::new(FileTrack::default());
        tracks.push(track.clone());
        let file_id = Arc::new(file.id.clone());
        for editor_config in &file.editors {
            let editor = Arc::new(Editor {
                index,
                probe: config.presence_probe,
                file: file_id.clone(),
                config: editor_config.clone(),
                track: track.clone(),
                stats: Arc::default(),
                clock: clock.clone(),
                global: global.clone(),
                known: Arc::new(AtomicU64::new(file.version)),
                stop: stop_rx.clone(),
            });
            let delay = if total > 1 {
                Duration::from_millis(config.ramp_ms * index as u64 / total as u64)
            } else {
                Duration::ZERO
            };
            let task_editor = editor.clone();
            let task_config = config.clone();
            tasks.push(tokio::spawn(async move {
                tokio::time::sleep(delay).await;
                match task_config.mode {
                    Mode::Legacy => legacy_editor(task_editor, task_config).await,
                    Mode::Ws => ws_editor(task_editor, task_config).await,
                }
            }));
            editors.push((file.id.clone(), editor));
            index += 1;
        }
    }
    tokio::time::sleep(window_to).await;
    // In-flight ops get a moment to be answered before the stop.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let _ = stop_tx.send(true);
    for task in tasks {
        let _ = tokio::time::timeout(Duration::from_secs(10), task).await;
    }
    let wall = start.elapsed();
    let cpu_after = self_cpu_ms();

    let mut ack = Histogram::default();
    let mut presence_rtt = Histogram::default();
    let mut presence_delivery = Histogram::default();
    let mut statuses = BTreeMap::new();
    let mut presence_statuses = BTreeMap::new();
    let mut byes = BTreeMap::new();
    let mut acks_per_second: Vec<u32> = Vec::new();
    let mut errors_per_second: Vec<u32> = Vec::new();
    let mut receiver_hz = Vec::new();
    let mut acked = Vec::new();
    let (mut ops_sent, mut ops_acked, mut ops_coalesced, mut presence_sent, mut presence_coalesced) =
        (0, 0, 0, 0, 0);
    let (
        mut bytes_in,
        mut bytes_out,
        mut changes_received,
        mut presence_frames,
        mut presence_entries,
    ) = (0, 0, 0, 0, 0);
    let (mut stream_ends, mut reconnects, mut resyncs, mut errors) = (0, 0, 0, 0);
    let window_s = config.duration_ms as f64 / 1000.0;
    let peers_of: BTreeMap<String, usize> = config
        .files
        .iter()
        .map(|file| {
            (
                file.id.clone(),
                file.editors.iter().filter(|e| !e.quiet).count(),
            )
        })
        .collect();
    for (file, editor) in &editors {
        let stats = editor.stats.lock().unwrap();
        ack.merge(&stats.ack);
        presence_rtt.merge(&stats.presence_rtt);
        presence_delivery.merge(&stats.presence_delivery);
        for (k, v) in &stats.statuses {
            *statuses.entry(k.clone()).or_insert(0) += v;
        }
        for (k, v) in &stats.presence_statuses {
            *presence_statuses.entry(k.clone()).or_insert(0) += v;
        }
        for (k, v) in &stats.byes {
            *byes.entry(k.clone()).or_insert(0) += v;
        }
        for (series, into) in [
            (&stats.acks_per_second, &mut acks_per_second),
            (&stats.errors_per_second, &mut errors_per_second),
        ] {
            if into.len() < series.len() {
                into.resize(series.len(), 0);
            }
            for (i, n) in series.iter().enumerate() {
                into[i] += n;
            }
        }
        ops_sent += stats.ops_sent;
        ops_acked += stats.ops_acked;
        ops_coalesced += stats.ops_coalesced;
        presence_sent += stats.presence_sent;
        presence_coalesced += stats.presence_coalesced;
        bytes_in += stats.bytes_in;
        bytes_out += stats.bytes_out;
        changes_received += stats.changes_received;
        presence_frames += stats.presence_frames;
        presence_entries += stats.presence_entries;
        stream_ends += stats.stream_ends;
        reconnects += stats.reconnects;
        resyncs += stats.resyncs;
        errors += stats.errors;
        let others = peers_of
            .get(file)
            .copied()
            .unwrap_or(1)
            .saturating_sub(if editor.config.quiet { 0 } else { 1 });
        if others > 0 && config.cursor_hz > 0.0 {
            receiver_hz.push(stats.window_presence_entries as f64 / others as f64 / window_s);
        }
        if config.record_acked {
            acked.push(AckedOps {
                file: file.clone(),
                editor: editor.index,
                ops: stats.acked.clone(),
            });
        }
    }
    // Arrival: op sent (its version from the ack) → the change seen at each other editor.
    let mut arrival = Histogram::default();
    for track in &tracks {
        let sent: BTreeMap<u64, Instant> = track.sent.lock().unwrap().iter().copied().collect();
        for (version, at) in track.arrived.lock().unwrap().iter() {
            if let Some(from) = sent.get(version)
                && clock.in_window(*from)
                && *at >= *from
            {
                arrival.record_ms(at.duration_since(*from).as_secs_f64() * 1000.0);
            }
        }
    }
    receiver_hz.sort_by(|a, b| a.total_cmp(b));
    let self_cpu = match (cpu_before, cpu_after) {
        (Some(a), Some(b)) => Some(b - a),
        _ => None,
    };
    let viewers = config
        .files
        .iter()
        .flat_map(|file| &file.editors)
        .filter(|e| e.role != "editor")
        .count();
    Report {
        mode: config.mode,
        editors: total - viewers,
        viewers,
        files: config.files.len(),
        duration_ms: config.duration_ms,
        window_ms: config.duration_ms,
        wall_ms: wall.as_secs_f64() * 1000.0,
        ack: ack.to_json(),
        arrival: arrival.to_json(),
        presence_rtt: presence_rtt.to_json(),
        presence_delivery: presence_delivery.to_json(),
        statuses,
        presence_statuses,
        byes,
        ops_sent,
        ops_acked,
        ops_coalesced,
        presence_sent,
        presence_coalesced,
        bytes_in,
        bytes_out,
        changes_received,
        presence_frames,
        presence_entries,
        receiver_hz_median: receiver_hz
            .get(receiver_hz.len() / 2)
            .copied()
            .unwrap_or(f64::NAN),
        receiver_hz_max: receiver_hz.last().copied().unwrap_or(f64::NAN),
        stream_ends,
        reconnects,
        resyncs,
        errors,
        peak_streams: global.peak_streams.load(Ordering::Relaxed),
        acks_per_second,
        errors_per_second,
        self_cpu_ms: self_cpu,
        self_cores: self_cpu.map(|ms| ms / (wall.as_secs_f64() * 1000.0)),
        acked,
    }
}
