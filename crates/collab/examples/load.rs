//! A load driver for the M-rows of docs/TARGETS.md on a dev box, until B0's `crates/loadgen` lands: it opens
//! sockets against a running `morfa-collab` (with `MORFA_COLLAB_DEV_TICKETS=1` and a seed document) and reads the
//! server's CPU from `/proc/<pid>/stat` and its histograms from `/metrics`.
//!
//!     cargo run --release -p morfa-collab --example load -- seed <nodes>        print a seed document of N rectangles
//!     … load -- cursors <addr> <pid> <files> <users per file> <hz> <seconds>    M10
//!     … load -- edit <addr> <pid> <files> <editors> <viewers> <layers> <ops/s> <cursor hz> <seconds>
//!                     [slow viewers per file] [full-document joins per second]  M1, M4, M5 (each editor moves its own layers and its cursor; viewers only read);
//!                                                                               M12 with slow viewers (64 kbit/s readers)
//!   (LOAD_WIRE=bin: the binary wire)
//!     … load -- catchup <addr> <pid> <ops> [layers per op, 2]                   M8 (a reader misses <ops>, then catches up)
//!     … load -- pg-wal <database url>                                           the WAL position in bytes (K3)
//!     … load -- pg-drop <database url>                                          drops a pg-seed database
//!     … load -- pg-seed <files> <layers> <edit|m10>                             a database of seeded files for a
//!                     PostgreSQL run (MORFA_B2_PG_URL; then LOAD_UUID_FILES=1 LOAD_SINCE=1 for the modes above)
//!
//! Edits carry their send time in the moved layers' names, so a receiver reads the op → change latency from the
//! change itself (client clocks are the driver's own).

use morfa_collab::client::{self, Receiver, Sender};
use morfa_collab::router::dev_ticket;
use morfa_model::{DocumentPatch, Map, SceneNode, Vec2, from_json_validated};
use morfa_protocol::ticket::Claims;
use morfa_protocol::{
    ClientId, ClientMsg, Hello, Op, PROTOCOL_VERSION, PresenceUpdate, Role, ServerMsg, Version,
    Wire,
};
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const PAGE: &str = r#"{"id":"page","type":"PAGE","name":"Page 1","parentId":null,"visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":0,"y":0,"width":0,"height":0,"rotation":0,"fills":[],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"children":[],"guides":[],"flowStartingPoints":[],"prototypeDevice":{"type":"NONE"},"backgroundColor":{"r":0.96,"g":0.96,"b":0.96}}"#;
const RECT: &str = r#"{"id":"ID","type":"RECTANGLE","name":"Rectangle","parentId":"page","visible":true,"locked":false,"opacity":1,"blendMode":"NORMAL","isMask":false,"x":0,"y":0,"width":100,"height":30,"rotation":0,"fills":[{"type":"SOLID","color":{"r":0.85,"g":0.85,"b":0.85},"opacity":1,"visible":true,"blendMode":"NORMAL"}],"strokes":[],"strokeWeight":1,"strokeAlign":"INSIDE","strokeCap":"NONE","strokeJoin":"MITER","strokeMiterLimit":4,"dashPattern":[],"effects":[],"constraints":{"horizontal":"MIN","vertical":"MIN"},"layoutPositioning":"AUTO","layoutSizingHorizontal":"FIXED","layoutSizingVertical":"FIXED","exportSettings":[],"reactions":[],"cornerRadius":0,"cornerSmoothing":0}"#;

/// Layers per group, as `heavyPage` (tests/helpers/design-big-files.ts) nests them.
const GROUP: usize = 48;

/// The group layer `r{i}` lies in.
fn group_of(i: usize) -> String {
    let g = i / GROUP;
    format!("g{}k{}", g / 10, g % 10)
}

/// A seed of `n` layers shaped as `heavyPage` (`f20k` at n = 19 200): screens of 10 sections, each a group of 48
/// layers `r0…` (rectangles), so a layer's parent lists 48 children, as in the real file.
fn seed(n: usize) -> String {
    let groups = n.div_ceil(GROUP);
    let screens = groups.div_ceil(10);
    let frame = |id: &str, parent: &str, kind: &str, children: Vec<String>| {
        let quoted: Vec<String> = children.iter().map(|c| format!("\"{c}\"")).collect();
        RECT.replace("\"ID\"", &format!("\"{id}\""))
            .replace("\"RECTANGLE\"", &format!("\"{kind}\""))
            .replace(
                "\"parentId\":\"page\"",
                &format!("\"parentId\":\"{parent}\""),
            )
            .replace(",\"cornerRadius\":0,\"cornerSmoothing\":0", "")
            .replacen(
                "\"reactions\":[]",
                &format!("\"reactions\":[],\"children\":[{}]", quoted.join(",")),
                1,
            )
    };
    let mut nodes = Vec::new();
    let mut screen_ids = Vec::new();
    for s in 0..screens {
        let screen = format!("s{s}");
        let mut sections = Vec::new();
        for k in 0..10 {
            let g = s * 10 + k;
            if g >= groups {
                break;
            }
            let section = format!("s{s}k{k}");
            let group = format!("g{s}k{k}");
            let layers: Vec<String> = (g * GROUP..((g + 1) * GROUP).min(n))
                .map(|i| format!("r{i}"))
                .collect();
            for id in &layers {
                nodes.push(format!(
                    "\"{id}\":{}",
                    RECT.replace("\"ID\"", &format!("\"{id}\"")).replace(
                        "\"parentId\":\"page\"",
                        &format!("\"parentId\":\"{group}\"")
                    )
                ));
            }
            nodes.push(format!(
                "\"{group}\":{}",
                frame(&group, &section, "GROUP", layers)
            ));
            nodes.push(format!(
                "\"{section}\":{}",
                frame(&section, &screen, "FRAME", vec![group])
            ));
            sections.push(section);
        }
        nodes.push(format!(
            "\"{screen}\":{}",
            frame(&screen, "page", "FRAME", sections)
        ));
        screen_ids.push(screen);
    }
    let quoted: Vec<String> = screen_ids.iter().map(|c| format!("\"{c}\"")).collect();
    let page = PAGE.replace(
        "\"children\":[]",
        &format!("\"children\":[{}]", quoted.join(",")),
    );
    nodes.push(format!("\"page\":{page}"));
    format!(
        r#"{{"schemaVersion":1,"pages":["page"],"nodes":{{{}}},"styles":{{}},"images":{{}},"variableCollections":{{}},"variables":{{}}}}"#,
        nodes.join(",")
    )
}

/// The seed's layer `r{i}` as the seed holds it.
fn layer(template: &SceneNode, i: usize) -> SceneNode {
    let mut node = template.clone();
    node.id = format!("r{i}");
    node.parent_id = Some(group_of(i));
    node
}

/// The id of file `f` of a scenario: `edit-3`, or with `LOAD_UUID_FILES=1` an id as api makes them (the files
/// `load pg-seed` creates in PostgreSQL).
fn file_id(kind: &str, f: usize) -> String {
    if std::env::var("LOAD_UUID_FILES").as_deref() == Ok("1")
        || std::env::args().nth(1).as_deref() == Some("pg-seed")
    {
        let code: u64 = match kind {
            "edit" => 0xe,
            "m10" => 0xc,
            _ => 0xa,
        };
        format!("{f:08x}-0000-4000-8000-{code:012x}")
    } else {
        format!("{kind}-{f}")
    }
}

/// The version editors join at (`LOAD_SINCE`; 0 for the in-memory seed, 1 for `pg-seed` files).
fn since() -> Version {
    std::env::var("LOAD_SINCE")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0)
}

/// `pg-seed <files> <layers> <edit|m10>`: a fresh migrated database on the server `MORFA_B2_PG_URL` names (a
/// role that may create databases), holding `files` files of a `layers`-layer seed with the ids [`file_id`]
/// gives (version 1: join with `LOAD_SINCE=1`); prints the database's URL.
async fn pg_seed(files: usize, layers: usize, kind: &str) {
    let Some(db) = morfa_journal::testdb::TestDb::create("pg-seed").await else {
        panic!("set MORFA_B2_PG_URL");
    };
    let client = db.client().await;
    let document = seed(layers);
    let user = "load-user".to_owned();
    client
        .execute(
            "INSERT INTO users(id,email,name,password) VALUES($1,'load@example.invalid','load','')",
            &[&user],
        )
        .await
        .expect("a user");
    let nodes = (morfa_model::from_json(&document).expect("seed").nodes.len()) as i32;
    for f in 0..files {
        client
            .execute(
                "INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,'load',$3,octet_length($3),$4)",
                &[&file_id(kind, f), &user, &document, &nodes],
            )
            .await
            .expect("a file");
    }
    println!("{}", db.url);
}

/// The wire the driver speaks: `LOAD_WIRE=bin` for the binary one.
fn wire() -> Wire {
    match std::env::var("LOAD_WIRE").as_deref() {
        Ok("bin") => Wire::Binary,
        _ => Wire::Json,
    }
}

fn now_us() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_micros() as f64
}

/// utime + stime of `pid`, in seconds (0 for pid 0: the server runs elsewhere and its host measures it).
fn cpu_seconds(pid: u32) -> f64 {
    if pid == 0 {
        return 0.0;
    }
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).expect("server pid");
    let after = &stat[stat.rfind(')').unwrap() + 2..];
    let fields: Vec<&str> = after.split_whitespace().collect();
    let ticks: f64 = fields[11].parse::<f64>().unwrap() + fields[12].parse::<f64>().unwrap();
    ticks / 100.0
}

async fn join(
    addr: &str,
    file: &str,
    user: &str,
    role: Role,
    since: Option<Version>,
) -> (Sender, Receiver, Version) {
    let (mut tx, mut rx) = client::connect(
        &format!("ws://{addr}/collab/{file}?wire={}", wire().name()),
        wire(),
    )
    .await
    .expect("connect");
    let claims = Claims {
        file: file.into(),
        user: user.into(),
        name: format!("Member {user}"),
        role,
        team: None,
        origin: None,
        exp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 600,
    };
    tx.send(&ClientMsg::Hello(Hello {
        ticket: dev_ticket(&claims),
        client_id: ClientId::new(format!("load-{user}")),
        since,
        last_seq: 0,
        protocol: PROTOCOL_VERSION,
    }))
    .await
    .expect("hello");
    let mut version;
    loop {
        match rx.recv().await.expect("welcome") {
            ServerMsg::Welcome(welcome) => {
                version = welcome.version;
                if !welcome.resync {
                    break;
                }
            }
            ServerMsg::Document { version: v, .. } => {
                version = v;
                break;
            }
            _ => {}
        }
    }
    (tx, rx, version)
}

/// The number after the first (or last) `"key":` in a JSON frame.
fn field(frame: &[u8], key: &str, last: bool) -> Option<f64> {
    let needle = format!("\"{key}\":");
    let needle = needle.trim_end_matches(':').trim_end_matches('"');
    let needle = needle.as_bytes();
    let mut positions = frame
        .windows(needle.len())
        .enumerate()
        .filter(|(_, w)| *w == needle)
        .map(|(i, _)| i);
    let at = if last {
        positions.next_back()?
    } else {
        positions.next()?
    } + needle.len();
    let rest = &frame[at..];
    let rest = rest
        .strip_prefix(b"\":")
        .or_else(|| rest.strip_prefix(b":"))
        .unwrap_or(rest);
    let end = rest
        .iter()
        .position(|b| !(b.is_ascii_digit() || *b == b'.' || *b == b'-'))
        .unwrap_or(rest.len());
    std::str::from_utf8(&rest[..end]).ok()?.parse().ok()
}

/// Sorted samples (µs) → p50/p95/p99 in ms.
fn quantiles(mut samples: Vec<f64>) -> String {
    if samples.is_empty() {
        return "no samples".into();
    }
    samples.sort_by(|a, b| a.total_cmp(b));
    let q = |p: f64| samples[((samples.len() - 1) as f64 * p) as usize] / 1000.0;
    format!(
        "p50 {:.2} / p95 {:.2} / p99 {:.2} ms (n={})",
        q(0.5),
        q(0.95),
        q(0.99),
        samples.len()
    )
}

/// The server's `/metrics` as it is.
async fn scrape(addr: &str) -> String {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(addr).await.expect("metrics");
    stream
        .write_all(b"GET /metrics HTTP/1.1\r\nHost: load\r\nConnection: close\r\n\r\n")
        .await
        .unwrap();
    let mut body = String::new();
    stream.read_to_string(&mut body).await.unwrap();
    body
}

/// The report's lines of a scrape: every histogram's quantiles since the server started, and the counters.
fn report_lines(body: &str) -> String {
    body.lines()
        .filter(|l| {
            l.starts_with("# SUMMARY") && !l.contains(" n=0 ")
                || (!l.starts_with('#') && l.contains("_total") && !l.ends_with(" 0"))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

async fn metrics(addr: &str) -> String {
    report_lines(&scrape(addr).await)
}

/// `# STEADY <histogram> n= p50= p95= p99= max= ms`: the quantiles of what the server recorded between two scrapes
/// (the measured window, without the warm-up), from their `# FINE` buckets.
fn steady(before: &str, after: &str) -> String {
    fn fine(body: &str) -> std::collections::HashMap<&str, std::collections::HashMap<u64, u64>> {
        body.lines()
            .filter_map(|l| l.strip_prefix("# FINE "))
            .filter_map(|l| {
                let mut parts = l.split(' ');
                let name = parts.next()?;
                let buckets = parts
                    .filter_map(|b| {
                        let (upper, count) = b.split_once(':')?;
                        Some((upper.parse().ok()?, count.parse().ok()?))
                    })
                    .collect();
                Some((name, buckets))
            })
            .collect()
    }
    let before = fine(before);
    let mut lines = Vec::new();
    let mut after: Vec<_> = fine(after).into_iter().collect();
    after.sort_by_key(|(name, _)| *name);
    for (name, buckets) in after {
        let earlier = before.get(name);
        let mut window: Vec<(u64, u64)> = buckets
            .into_iter()
            .map(|(upper, n)| {
                let was = earlier.and_then(|b| b.get(&upper)).copied().unwrap_or(0);
                (upper, n.saturating_sub(was))
            })
            .filter(|(_, n)| *n > 0)
            .collect();
        let total: u64 = window.iter().map(|(_, n)| n).sum();
        if total == 0 {
            continue;
        }
        window.sort_unstable();
        let ms = |q: f64| {
            let rank = ((q * total as f64).ceil() as u64).clamp(1, total);
            let mut seen = 0;
            for (upper, n) in &window {
                seen += n;
                if seen >= rank {
                    return *upper as f64 / 1e6;
                }
            }
            f64::NAN
        };
        lines.push(format!(
            "# STEADY {name} n={total} p50={:.3} p95={:.3} p99={:.3} max={:.3} ms",
            ms(0.5),
            ms(0.95),
            ms(0.99),
            ms(1.0)
        ));
    }
    lines.join("\n")
}

async fn cursors(addr: String, pid: u32, files: usize, per_file: usize, hz: f64, secs: u64) {
    let received = Arc::new(AtomicU64::new(0));
    let peers_seen = Arc::new(AtomicU64::new(0));
    // M11: a cursor's x is its send time (ms since the run started); a receiver reads the delivery from it.
    let start = Instant::now();
    let delivery = Arc::new(parking_lot::Mutex::new(Vec::<f64>::new()));
    let measuring = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let mut tasks = Vec::new();
    for f in 0..files {
        for u in 0..per_file {
            let (addr, received, peers_seen) =
                (addr.clone(), Arc::clone(&received), Arc::clone(&peers_seen));
            let (delivery, measuring) = (Arc::clone(&delivery), Arc::clone(&measuring));
            tasks.push(tokio::spawn(async move {
                let (mut tx, mut rx, _) = join(
                    &addr,
                    &file_id("m10", f),
                    &format!("u{f}-{u}"),
                    Role::Editor,
                    Some(since()),
                )
                .await;
                let reader = tokio::spawn(async move {
                    while let Some(msg) = rx.recv().await {
                        if let ServerMsg::Presence { peers } = msg {
                            received.fetch_add(1, Ordering::Relaxed);
                            peers_seen.fetch_add(peers.len() as u64, Ordering::Relaxed);
                            if measuring.load(Ordering::Relaxed) {
                                let now = start.elapsed().as_secs_f64() * 1000.0;
                                let mut delivery = delivery.lock();
                                for peer in &peers {
                                    if let Some(cursor) = &peer.presence.cursor {
                                        delivery.push((now - cursor.x) * 1000.0);
                                    }
                                }
                            }
                        }
                    }
                });
                let period = Duration::from_secs_f64(1.0 / hz);
                tokio::time::sleep(period.mul_f64(rand::random::<f64>())).await;
                let mut tick = tokio::time::interval(period);
                let end = Instant::now() + Duration::from_secs(secs + 3);
                while Instant::now() < end {
                    tick.tick().await;
                    let update = PresenceUpdate {
                        cursor: Some(Some(Vec2 {
                            x: start.elapsed().as_secs_f64() * 1000.0,
                            y: u as f64,
                        })),
                        ..Default::default()
                    };
                    if tx.send(&ClientMsg::Presence(update)).await.is_err() {
                        break;
                    }
                }
                tx.close().await;
                reader.abort();
            }));
        }
    }
    // Warm-up, then the measured window.
    tokio::time::sleep(Duration::from_secs(2)).await;
    measuring.store(true, Ordering::Relaxed);
    let (cpu0, t0) = (cpu_seconds(pid), Instant::now());
    let (r0, p0) = (
        received.load(Ordering::Relaxed),
        peers_seen.load(Ordering::Relaxed),
    );
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let (cpu1, dt) = (cpu_seconds(pid), t0.elapsed().as_secs_f64());
    let (r1, p1) = (
        received.load(Ordering::Relaxed),
        peers_seen.load(Ordering::Relaxed),
    );
    let users = (files * per_file) as f64;
    println!(
        "M10 cursors: {files} files × {per_file} users at {hz} Hz: server CPU {:.3} cores; \
         presence frames per receiver {:.1}/s; peer entries per receiver {:.1}/s (≤ {:.0} = 30 Hz × peers)",
        (cpu1 - cpu0) / dt,
        (r1 - r0) as f64 / dt / users,
        (p1 - p0) as f64 / dt / users,
        30.0 * (per_file - 1) as f64
    );
    measuring.store(false, Ordering::Relaxed);
    println!(
        "M11 presence delivery (cursor sent → seen by a peer): {}",
        quantiles(std::mem::take(&mut delivery.lock()))
    );
    for task in tasks {
        let _ = task.await;
    }
}

#[allow(clippy::too_many_arguments)]
async fn edit(
    addr: String,
    pid: u32,
    files: usize,
    editors: usize,
    viewers: usize,
    layers: usize,
    ops_hz: f64,
    cursor_hz: f64,
    secs: u64,
    slow: usize,
    joins_hz: f64,
) {
    // Late joiners that load the whole document (no `since`): snapshots in flight while editors edit.
    if joins_hz > 0.0 {
        for f in 0..files {
            let addr = addr.clone();
            tokio::spawn(async move {
                let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / joins_hz));
                let end = Instant::now() + Duration::from_secs(secs + 2);
                let mut n = 0;
                while Instant::now() < end {
                    tick.tick().await;
                    n += 1;
                    let addr = addr.clone();
                    tokio::spawn(async move {
                        let (mut tx, _rx, _) = join(
                            &addr,
                            &file_id("edit", f),
                            &format!("late{f}-{n}"),
                            Role::Viewer,
                            None,
                        )
                        .await;
                        tx.close().await;
                    });
                }
            });
        }
    }
    // TARGETS M12: viewers reading at 64 kbit/s on every file.
    for f in 0..files {
        for v in 0..slow {
            let addr = addr.clone();
            tokio::spawn(async move {
                slow_viewer(addr, file_id("edit", f), format!("slow{f}-{v}"), secs + 5).await
            });
        }
    }
    let acks = Arc::new(parking_lot::Mutex::new(Vec::<f64>::new()));
    let arrivals = Arc::new(parking_lot::Mutex::new(Vec::<f64>::new()));
    let measuring = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let template: SceneNode = {
        let doc = from_json_validated(&seed(1)).unwrap();
        doc.nodes["r0"].clone()
    };
    let mut tasks = Vec::new();
    for f in 0..files {
        for e in 0..editors + viewers {
            let editor = e < editors;
            let (addr, acks, arrivals, measuring, template) = (
                addr.clone(),
                Arc::clone(&acks),
                Arc::clone(&arrivals),
                Arc::clone(&measuring),
                template.clone(),
            );
            tasks.push(tokio::spawn(async move {
                let role = if editor { Role::Editor } else { Role::Viewer };
                let (mut tx, mut rx, mut version) =
                    join(&addr, &file_id("edit", f), &format!("e{f}-{e}"), role, Some(since())).await;
                let sent = Arc::new(parking_lot::Mutex::new(std::collections::HashMap::<u64, f64>::new()));
                let base = Arc::new(AtomicU64::new(version));
                let reader = {
                    let (sent, base, measuring) = (Arc::clone(&sent), Arc::clone(&base), Arc::clone(&measuring));
                    tokio::spawn(async move {
                        // Frames are peeked at, not decoded: 500 receivers decoding every change would
                        // measure the driver instead of the server.
                        while let Some(frame) = rx.recv_bytes().await {
                            let now = now_us();
                            // Binary frames are peeked at through their JSON text.
                            let text;
                            let frame = if frame.first().is_some_and(|b| *b >= 0xB1) {
                                text = morfa_protocol::binary::frame_to_json(&frame).unwrap_or_default();
                                bytes::Bytes::from(text)
                            } else {
                                frame
                            };
                            let on = measuring.load(Ordering::Relaxed);
                            let frame = &frame[..];
                            if frame.starts_with(b"{\"t\":\"ack\"") {
                                let (Some(seq), Some(version)) = (field(frame, "seq", false), field(frame, "version", false)) else { continue };
                                base.fetch_max(version as u64, Ordering::Relaxed);
                                if let Some(t) = sent.lock().remove(&(seq as u64))
                                    && on
                                {
                                    acks.lock().push(now - t);
                                }
                            } else if frame.starts_with(b"{\"t\":\"change\"") {
                                if let Some(version) = field(frame, "version", false) {
                                    base.fetch_max(version as u64, Ordering::Relaxed);
                                }
                                if on && let Some(t) = field(frame, "name\":\"t", false) {
                                    arrivals.lock().push(now - t);
                                }
                            } else if frame.starts_with(b"{\"t\":\"changes\"") {
                                if let Some(version) = field(frame, "version", true) {
                                    base.fetch_max(version as u64, Ordering::Relaxed);
                                }
                            } else if frame.starts_with(b"{\"t\":\"refused\"") {
                                if let Some(seq) = field(frame, "seq", false) {
                                    sent.lock().remove(&(seq as u64));
                                }
                                eprintln!("{}", String::from_utf8_lossy(frame));
                            }
                        }
                    })
                };
                let mut copies: Vec<SceneNode> =
                    (0..layers).map(|i| layer(&template, e * layers + i)).collect();
                let end = Instant::now() + Duration::from_secs(secs + 3);
                let cursor_period = Duration::from_secs_f64(1.0 / cursor_hz.max(0.001));
                let op_period = Duration::from_secs_f64(1.0 / ops_hz.max(0.001));
                // Random phases: the intervals start after the sleep, so editors do not all send at once.
                tokio::time::sleep(op_period.mul_f64(rand::random::<f64>())).await;
                let mut op_tick = tokio::time::interval(op_period);
                if cursor_hz > 0.0 {
                    tokio::time::sleep(cursor_period.mul_f64(rand::random::<f64>())).await;
                }
                let mut cursor_tick = tokio::time::interval(cursor_period);
                let mut seq = 0;
                if !editor {
                    tokio::time::sleep_until(end.into()).await;
                }
                while editor && Instant::now() < end {
                    tokio::select! {
                        _ = cursor_tick.tick(), if cursor_hz > 0.0 => {
                            let update = PresenceUpdate {
                                cursor: Some(Some(Vec2 { x: rand::random::<f64>() * 1000.0, y: 1.0 })),
                                ..Default::default()
                            };
                            if tx.send(&ClientMsg::Presence(update)).await.is_err() { break; }
                        }
                        _ = op_tick.tick() => {
                            seq += 1;
                            let t = now_us();
                            let mut moves = Vec::with_capacity(copies.len());
                            for copy in copies.iter_mut() {
                                let before = copy.clone();
                                copy.x += 1.0;
                                copy.name = format!("t{t}");
                                moves.push((before, copy.clone()));
                            }
                            version = base.load(Ordering::Relaxed);
                            let op = move_op(seq, version, moves);
                            sent.lock().insert(seq, t);
                            if tx.send(&ClientMsg::Op(Box::new(op))).await.is_err() { break; }
                        }
                    }
                }
                tx.close().await;
                reader.abort();
            }));
        }
    }
    tokio::time::sleep(Duration::from_secs(2)).await;
    measuring.store(true, Ordering::Relaxed);
    let warm = scrape(&addr).await;
    let (cpu0, t0) = (cpu_seconds(pid), Instant::now());
    tokio::time::sleep(Duration::from_secs(secs)).await;
    let (cpu1, dt) = (cpu_seconds(pid), t0.elapsed().as_secs_f64());
    measuring.store(false, Ordering::Relaxed);
    let measured = scrape(&addr).await;
    println!(
        "edit: {files} files × ({editors} editors + {viewers} viewers), {layers} layers per op at {ops_hz}/s, cursors {cursor_hz} Hz"
    );
    println!("  server CPU {:.3} cores", (cpu1 - cpu0) / dt);
    println!(
        "  ack (client RTT): {}",
        quantiles(std::mem::take(&mut acks.lock()))
    );
    println!(
        "  op → change at a peer: {}",
        quantiles(std::mem::take(&mut arrivals.lock()))
    );
    println!("{}", report_lines(&measured));
    println!("{}", steady(&warm, &measured));
    for task in tasks {
        let _ = task.await;
    }
}

/// A viewer that reads its socket at 64 kbit/s (1 KB every 125 ms), over a raw WebSocket.
async fn slow_viewer(addr: String, file: String, user: String, secs: u64) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut tcp = tokio::net::TcpStream::connect(&addr)
        .await
        .expect("connect");
    let request = format!(
        "GET /collab/{file}?wire=json HTTP/1.1\r\nHost: load\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\
         Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"
    );
    tcp.write_all(request.as_bytes()).await.unwrap();
    let claims = Claims {
        file,
        user: user.clone(),
        name: user.clone(),
        role: Role::Viewer,
        team: None,
        origin: None,
        exp: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_secs()
            + 600,
    };
    let hello = Wire::Json
        .codec()
        .encode_client(&ClientMsg::Hello(Hello {
            ticket: dev_ticket(&claims),
            client_id: ClientId::new(format!("load-{user}")),
            since: Some(since()),
            last_seq: 0,
            protocol: PROTOCOL_VERSION,
        }))
        .bytes;
    let mut frame = vec![0x81u8];
    let len = hello.len();
    if len < 126 {
        frame.push(0x80 | len as u8);
    } else {
        frame.push(0x80 | 126);
        frame.extend_from_slice(&(len as u16).to_be_bytes());
    }
    frame.extend_from_slice(&[0, 0, 0, 0]);
    frame.extend_from_slice(&hello);
    tcp.write_all(&frame).await.unwrap();
    let end = Instant::now() + Duration::from_secs(secs);
    let mut chunk = [0u8; 1024];
    let mut total = 0usize;
    while Instant::now() < end {
        match tcp.read(&mut chunk).await {
            Ok(0) | Err(_) => break,
            Ok(n) => total += n,
        }
        tokio::time::sleep(Duration::from_millis(125)).await;
    }
    eprintln!("slow viewer {user}: read {} KB", total / 1024);
}

async fn catchup(addr: String, pid: u32, ops: u64, layers: u64) {
    let file = format!("m8-{}", rand::random::<u32>());
    let template: SceneNode = from_json_validated(&seed(1)).unwrap().nodes["r0"].clone();
    // The reader's version before it drops.
    let (_, _, version) = join(&addr, &file, "reader-0", Role::Viewer, Some(0)).await;
    // The missed ops come from 20 editors (one socket's op rate is limited), each moving its own layers.
    let writers = 20u64;
    let mut last = version;
    for w in 0..writers {
        let (mut tx, mut rx, _) = join(
            &addr,
            &file,
            &format!("writer-{w}"),
            Role::Editor,
            Some(last),
        )
        .await;
        let mut copies: Vec<SceneNode> = (0..layers)
            .map(|i| layer(&template, (w * layers + i) as usize))
            .collect();
        for seq in 1..=ops / writers {
            let mut moves = Vec::with_capacity(copies.len());
            for copy in copies.iter_mut() {
                let before = copy.clone();
                copy.x += 1.0;
                moves.push((before, copy.clone()));
            }
            let op = move_op(seq, last, moves);
            tx.send(&ClientMsg::Op(Box::new(op))).await.unwrap();
            loop {
                match rx.recv().await {
                    Some(ServerMsg::Ack { version, .. }) => {
                        last = version;
                        break;
                    }
                    Some(refused @ ServerMsg::Refused { .. }) => panic!("op {seq}: {refused:?}"),
                    Some(_) => {}
                    None => panic!("closed at op {seq}"),
                }
            }
        }
        tx.close().await;
    }
    let cpu0 = cpu_seconds(pid);
    let t0 = Instant::now();
    let (_tx2, mut rx2, _) = join(&addr, &file, "reader", Role::Viewer, Some(version)).await;
    let mut got = version;
    let mut bytes = 0;
    while got < last {
        match rx2.recv_raw().await {
            Some((ServerMsg::Changes { changes }, n)) => {
                bytes += n;
                if let Some(c) = changes.last() {
                    got = c.version;
                }
            }
            Some((ServerMsg::Change(c), n)) => {
                bytes += n;
                got = c.version;
            }
            Some((ServerMsg::Bye { reason }, _)) => panic!("bye {reason:?} at {got}"),
            Some((ServerMsg::CatchUp { from, to }, _)) => panic!("catchUp {from}..{to} at {got}"),
            Some((ServerMsg::Resync { .. } | ServerMsg::Document { .. }, _)) => {
                panic!("the server sent the document instead (over TARGETS M9's catch-up limit)")
            }
            Some(_) => {}
            None => panic!("closed"),
        }
    }
    println!(
        "M8 catch-up of {ops} ops: converged in {:.1} ms (loopback), {} KB; server time per catch-up in collab_catchup_seconds (CPU {:.0} ms, 10 ms ticks)",
        t0.elapsed().as_secs_f64() * 1000.0,
        bytes / 1024,
        (cpu_seconds(pid) - cpu0) * 1000.0
    );
    println!("{}", metrics(&addr).await);
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let arg = |i: usize| -> &str {
        args.get(i)
            .map(String::as_str)
            .unwrap_or_else(|| panic!("argument {i}"))
    };
    let num = |i: usize| -> f64 {
        arg(i)
            .parse()
            .unwrap_or_else(|_| panic!("argument {i}: a number"))
    };
    if arg(0) == "seed" {
        println!("{}", seed(num(1) as usize));
        return;
    }
    if arg(0) == "pg-wal" {
        // `pg-wal <database url>`: the server's WAL position in bytes (K3: WAL per op is the difference / ops).
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let rows = morfa_journal::conn::Conn::new(arg(1))
                .query(
                    "SELECT pg_wal_lsn_diff(pg_current_wal_lsn(),'0/0')::int8",
                    &[],
                )
                .await
                .expect("pg_current_wal_lsn");
            println!("{}", rows[0].get::<_, i64>(0));
        });
        return;
    }
    if arg(0) == "pg-drop" {
        // `pg-drop <database url>`: drops a database `pg-seed` made (on the server MORFA_B2_PG_URL names).
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let name = arg(1).rsplit('/').next().unwrap_or_default().to_owned();
        assert!(name.starts_with("b2_"), "not a pg-seed database: {name}");
        runtime.block_on(async {
            let admin = std::env::var("MORFA_B2_PG_URL").expect("MORFA_B2_PG_URL");
            morfa_journal::conn::Conn::new(&admin)
                .batch(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
                .await
                .expect("drop the database");
        });
        return;
    }
    if arg(0) == "pg-seed" {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(pg_seed(num(1) as usize, num(2) as usize, arg(3)));
        return;
    }
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(2)
        .enable_all()
        .build()
        .unwrap();
    let (addr, pid) = (arg(1).to_owned(), num(2) as u32);
    runtime.block_on(async {
        match arg(0) {
            "cursors" => {
                cursors(
                    addr,
                    pid,
                    num(3) as usize,
                    num(4) as usize,
                    num(5),
                    num(6) as u64,
                )
                .await
            }
            "edit" => {
                edit(
                    addr,
                    pid,
                    num(3) as usize,
                    num(4) as usize,
                    num(5) as usize,
                    num(6) as usize,
                    num(7),
                    num(8),
                    num(9) as u64,
                    args.get(10).map_or(0, |_| num(10) as usize),
                    args.get(11).map_or(0.0, |_| num(11)),
                )
                .await
            }
            "catchup" => {
                catchup(
                    addr,
                    pid,
                    num(3) as u64,
                    args.get(4).map_or(2, |_| num(4) as u64),
                )
                .await
            }
            other => panic!("unknown mode {other}"),
        }
    });
}

/// A move of layers as an editor sends it: protocol 2's field op (`x` and `name`, what the moves change), or whole
/// nodes with their `before` copies under `MORFA_LOAD_WHOLE_OPS=1` (protocol 1's form, for comparison).
fn move_op(seq: u64, base_version: u64, moves: Vec<(SceneNode, SceneNode)>) -> Op {
    static WHOLE: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    if *WHOLE.get_or_init(|| std::env::var("MORFA_LOAD_WHOLE_OPS").is_ok_and(|v| v == "1")) {
        let mut before = Map::default();
        let mut nodes = Map::default();
        for (old, new) in moves {
            before.insert(old.id.clone(), Some(old));
            nodes.insert(new.id.clone(), Some(new));
        }
        return Op {
            seq,
            base_version,
            patch: DocumentPatch {
                nodes: Some(nodes),
                ..Default::default()
            },
            before: Some(before.into()),
            before_tables: None,
            fields: None,
        };
    }
    let mut fields = morfa_protocol::OpFields::default();
    for (old, new) in moves {
        let mut set = serde_json::Map::new();
        let mut was = serde_json::Map::new();
        set.insert("x".into(), new.x.into());
        was.insert("x".into(), old.x.into());
        if new.name != old.name {
            set.insert("name".into(), new.name.clone().into());
            was.insert("name".into(), old.name.clone().into());
        }
        fields.set.insert(new.id.clone(), set);
        fields.was.insert(new.id, was);
    }
    Op {
        seq,
        base_version,
        patch: DocumentPatch::default(),
        before: None,
        before_tables: None,
        fields: Some(fields),
    }
}
