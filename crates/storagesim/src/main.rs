//! `storagesim`: the simulated collab node and the journal bench.
//!
//! ```text
//! storagesim node  --db URL --store DIR --node NAME --files ID,ID… [--rects 200] [--layers 20] [--rate 50]
//!                  [--inflight 8] [--checkpoint-every 200] [--keep 100] [--ttl-ms 15000] [--renew-ms 5000]
//!                  [--duration-ms 0] [--steal] [--format bin|json]
//! storagesim bench --db URL (--files ID,ID… | --create N) [--editors 2000] [--rate 1] [--seconds 20] [--rects 200] [--layers 20]
//!                  [--shards 2] [--interval-ms 1]
//! storagesim open-save --db URL --doc FILE.json [--copies 1] [--tail 1000] [--runs 3] [--format bin|json]
//!                  [--store DIR | --s3]
//! ```
//!
//! `node` prints one line per event on stdout: `READY <file> <version> <fence>`, `ACK <file> <version>`,
//! `CKPT <file> <version>`, `FENCED <file> <version>`, `LOST <file> <state>`, `ERR <file> <what>`,
//! `DONE <file> <version> <digest>` (every op journaled, `digest` of the document at `version`), `STOPPED <file>`.
//! `bench` drives `editors` synthetic editors at `rate` ops/s each over the files (the files' leases must be free)
//! and prints the commit latency p50/p99/max (TARGETS D1) and the WAL bytes per op (K3).

use morfa_blobs::DirStore;
use morfa_checkpoint::{Checkpoints, Format, ops};
use morfa_journal::{Config, Entry, Journal, JournalError, PgJournal};
use morfa_lease::{Keeper, PgLease};
use morfa_storagesim::{digest, op};
use std::collections::{BTreeSet, HashMap};
use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::{Semaphore, watch};

fn say(line: String) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

struct Args(HashMap<String, String>);

impl Args {
    fn parse(args: &[String]) -> Args {
        let mut map = HashMap::new();
        let mut k = 0;
        while k < args.len() {
            let name = args[k].trim_start_matches("--").to_owned();
            if args
                .get(k + 1)
                .is_some_and(|value| !value.starts_with("--"))
            {
                map.insert(name, args[k + 1].clone());
                k += 2;
            } else {
                map.insert(name, String::new());
                k += 1;
            }
        }
        Args(map)
    }

    fn text(&self, name: &str) -> String {
        self.0
            .get(name)
            .cloned()
            .unwrap_or_else(|| panic!("--{name} is required"))
    }

    fn num<T: std::str::FromStr>(&self, name: &str, default: T) -> T {
        self.0.get(name).map_or(default, |value| {
            value.parse().unwrap_or_else(|_| panic!("--{name} {value}"))
        })
    }

    fn flag(&self, name: &str) -> bool {
        self.0.contains_key(name)
    }
}

struct Node {
    keeper: Keeper,
    lease: Arc<PgLease>,
    journal: PgJournal,
    checkpoints: Checkpoints<DirStore>,
    rects: usize,
    layers: usize,
    rate: f64,
    inflight: usize,
    checkpoint_every: u64,
    keep: u64,
    deadline: Option<Instant>,
    steal: bool,
}

const STEAL: &str = "UPDATE public.design_files SET collab_node=NULL,lease_until=NULL WHERE id=$1";

/// Versions acked so far: everything up to `through` and some above it.
struct Acked {
    through: u64,
    above: BTreeSet<u64>,
}

impl Acked {
    fn ack(&mut self, version: u64) -> u64 {
        self.above.insert(version);
        while self.above.remove(&(self.through + 1)) {
            self.through += 1;
        }
        self.through
    }
}

async fn run_file(node: Arc<Node>, file: String, db: String) {
    let started = Instant::now();
    let mut held = loop {
        if node.steal
            && let Ok((client, connection)) =
                tokio_postgres::connect(&db, tokio_postgres::NoTls).await
        {
            tokio::spawn(connection);
            let _ = client.execute(STEAL, &[&file]).await;
        }
        match node.keeper.acquire(&file).await {
            Ok(Some(held)) => break held,
            Ok(None) if started.elapsed() < Duration::from_secs(60) => {
                tokio::time::sleep(Duration::from_millis(50)).await
            }
            Ok(None) => return say(format!("ERR {file} lease held elsewhere")),
            Err(error) => {
                say(format!("ERR {file} {error}"));
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }
    };
    let _ = &node.lease;
    let fence = held.fence;
    let loaded = match node.checkpoints.load(&file).await {
        Ok(Some(loaded)) => loaded,
        Ok(None) => return say(format!("ERR {file} no such file")),
        Err(error) => return say(format!("ERR {file} load: {error}")),
    };
    say(format!("READY {file} {} {fence}", loaded.version));
    let mut doc = loaded.doc;
    let mut version = loaded.version;
    let stop = Arc::new(AtomicBool::new(false));
    let (through_tx, through_rx) = watch::channel(version);
    let acked = Arc::new(Mutex::new(Acked {
        through: version,
        above: BTreeSet::new(),
    }));
    let watcher = {
        let (stop, file) = (stop.clone(), file.clone());
        tokio::spawn(async move {
            let state = held.ended().await;
            stop.store(true, Ordering::SeqCst);
            say(format!("LOST {file} {state:?}"));
        })
    };
    let slots = Arc::new(Semaphore::new(node.inflight.max(1)));
    let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / node.rate.max(0.001)));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
    let file_arc: Arc<str> = file.as_str().into();
    while !stop.load(Ordering::SeqCst)
        && node
            .deadline
            .is_none_or(|deadline| Instant::now() < deadline)
    {
        tick.tick().await;
        let slot = slots.clone().acquire_owned().await.expect("open");
        if stop.load(Ordering::SeqCst) {
            break;
        }
        version += 1;
        let patch = op(version, node.rects, node.layers);
        doc.apply_patch(&patch);
        let entry = Entry {
            file: file_arc.clone(),
            version,
            fence,
            client: None,
            user_id: None,
            body: ops::patch_body(&patch),
        };
        // Queued here, in version order; only the answer is awaited on its own task.
        let pending = node.journal.submit(entry);
        let (stop2, acked2, through_tx2, file2) = (
            stop.clone(),
            acked.clone(),
            through_tx.clone(),
            file.clone(),
        );
        tokio::spawn(async move {
            let result = pending.await;
            drop(slot);
            match result {
                Ok(()) => {
                    say(format!("ACK {file2} {version}"));
                    let through = acked2.lock().expect("acked").ack(version);
                    let _ = through_tx2.send(through);
                }
                Err(JournalError::Fenced { .. }) => {
                    stop2.store(true, Ordering::SeqCst);
                    say(format!("FENCED {file2} {version}"));
                }
                Err(error) => {
                    stop2.store(true, Ordering::SeqCst);
                    say(format!("ERR {file2} {version} {error}"));
                }
            }
        });
        if node.checkpoint_every > 0 && version % node.checkpoint_every == 0 {
            // A checkpoint holds journaled versions only: it waits for its version's commit.
            let snapshot = Arc::new(doc.clone());
            let (node2, mut through_rx2, file2, stop2) =
                (node.clone(), through_rx.clone(), file.clone(), stop.clone());
            tokio::spawn(async move {
                while *through_rx2.borrow_and_update() < version {
                    if stop2.load(Ordering::SeqCst) || through_rx2.changed().await.is_err() {
                        return;
                    }
                }
                match node2
                    .checkpoints
                    .write(&file2, fence, version, snapshot)
                    .await
                {
                    Ok(_) => {
                        say(format!("CKPT {file2} {version}"));
                        if let Err(error) =
                            node2.journal.prune_below(&file2, version, node2.keep).await
                        {
                            say(format!("ERR {file2} prune {error}"));
                        }
                    }
                    Err(error) => say(format!("ERR {file2} checkpoint {version} {error}")),
                }
            });
        }
    }
    // Every op in flight answers before the file is reported.
    let _all = slots
        .acquire_many(node.inflight.max(1) as u32)
        .await
        .expect("open");
    watcher.abort();
    let through = acked.lock().expect("acked").through;
    if !stop.load(Ordering::SeqCst) && through == version {
        say(format!("DONE {file} {version} {}", digest(&doc)));
    } else {
        say(format!("STOPPED {file}"));
    }
}

async fn node(args: Args) {
    let db = args.text("db");
    let lease = Arc::new(PgLease::new(&db));
    let ttl = Duration::from_millis(args.num("ttl-ms", 15_000));
    let renew = Duration::from_millis(args.num("renew-ms", 5_000));
    let duration: u64 = args.num("duration-ms", 0);
    let format = Format::parse(&args.num("format", "bin".to_owned())).expect("--format bin|json");
    let node = Arc::new(Node {
        keeper: Keeper::start(lease.clone(), &args.text("node"), ttl, renew),
        lease,
        journal: PgJournal::start(Config::new(&db)),
        checkpoints: Checkpoints::new(DirStore::new(args.text("store")), &db, format),
        rects: args.num("rects", 200),
        layers: args.num("layers", 20),
        rate: args.num("rate", 50.0),
        inflight: args.num("inflight", 8),
        checkpoint_every: args.num("checkpoint-every", 200),
        keep: args.num("keep", 100),
        deadline: (duration > 0).then(|| Instant::now() + Duration::from_millis(duration)),
        steal: args.flag("steal"),
    });
    let tasks: Vec<_> = args
        .text("files")
        .split(',')
        .map(|file| tokio::spawn(run_file(node.clone(), file.to_owned(), db.clone())))
        .collect();
    for task in tasks {
        let _ = task.await;
    }
}

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    if sorted.is_empty() {
        return Duration::ZERO;
    }
    sorted[((sorted.len() - 1) as f64 * p).round() as usize]
}

async fn bench(args: Args) {
    let db = args.text("db");
    let (client, connection) = tokio_postgres::connect(&db, tokio_postgres::NoTls)
        .await
        .expect("connect");
    tokio::spawn(connection);
    let files: Vec<String> = match args.0.get("create") {
        Some(n) => {
            create_files(
                &client,
                n.parse().expect("--create N"),
                args.num("rects", 200),
            )
            .await
        }
        None => args.text("files").split(',').map(str::to_owned).collect(),
    };
    let editors: usize = args.num("editors", 2000);
    let rate: f64 = args.num("rate", 1.0);
    let seconds: f64 = args.num("seconds", 20.0);
    let rects: usize = args.num("rects", 200);
    let layers: usize = args.num("layers", 20);
    let journal = Arc::new(PgJournal::start(Config {
        shards: args.num("shards", 2),
        flush_interval: Duration::from_micros(
            (args.num::<f64>("interval-ms", 1.0) * 1000.0) as u64,
        ),
        ..Config::new(&db)
    }));
    let lease = PgLease::new(&db);
    let (client, connection) = tokio_postgres::connect(&db, tokio_postgres::NoTls)
        .await
        .expect("connect");
    tokio::spawn(connection);
    let mut fences = HashMap::new();
    for file in &files {
        let grant = morfa_journal::Lease::acquire(&lease, file, "bench", Duration::from_secs(600))
            .await
            .expect("lease")
            .expect("free");
        let version: i64 = client
            .query_one(
                "SELECT greatest(f.version,coalesce(h.version,0)) FROM design_files f
                   LEFT JOIN design_file_heads h ON h.file_id=f.id WHERE f.id=$1",
                &[file],
            )
            .await
            .expect("file")
            .get(0);
        fences.insert(
            file.clone(),
            (
                grant.fence,
                Arc::new(std::sync::atomic::AtomicU64::new(version as u64)),
            ),
        );
    }
    // One op body per file, re-sent with new versions (the cost is the journal's, not the op builder's).
    let body = ops::patch_body(&op(2, rects, layers));
    let op_bytes = body.len();
    let wal_before = wal(&client).await;

    let latencies = Arc::new(Mutex::new(Vec::with_capacity(
        (editors as f64 * rate * seconds) as usize,
    )));
    let errors = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let started = Instant::now();
    let deadline = started + Duration::from_secs_f64(seconds);
    let mut tasks = Vec::new();
    for editor in 0..editors {
        let file = files[editor % files.len()].clone();
        let (fence, next) = fences[&file].clone();
        let (journal, latencies, errors, body) = (
            journal.clone(),
            latencies.clone(),
            errors.clone(),
            body.clone(),
        );
        let file: Arc<str> = file.into();
        tasks.push(tokio::spawn(async move {
            // Spread the editors over the first period.
            tokio::time::sleep(Duration::from_secs_f64(
                editor as f64 / editors as f64 / rate,
            ))
            .await;
            let mut tick = tokio::time::interval(Duration::from_secs_f64(1.0 / rate));
            loop {
                tick.tick().await;
                if Instant::now() >= deadline {
                    break;
                }
                let version = next.fetch_add(1, Ordering::SeqCst) + 1;
                let entry = Entry {
                    file: file.clone(),
                    version,
                    fence,
                    client: None,
                    user_id: None,
                    body: body.clone(),
                };
                let (journal, latencies, errors) =
                    (journal.clone(), latencies.clone(), errors.clone());
                tokio::spawn(async move {
                    let sent = Instant::now();
                    match journal.append(entry).await {
                        Ok(()) => latencies.lock().expect("latencies").push(sent.elapsed()),
                        Err(_) => {
                            errors.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                });
            }
        }));
    }
    for task in tasks {
        let _ = task.await;
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    let wal_after = wal(&client).await;
    let mut sorted = latencies.lock().expect("latencies").clone();
    sorted.sort();
    let ops_done = sorted.len();
    let wal_bytes = match (wal_before, wal_after) {
        (Some(before), Some(after)) => client
            .query_one(
                "SELECT pg_wal_lsn_diff($1::text::pg_lsn,$2::text::pg_lsn)::float8",
                &[&after, &before],
            )
            .await
            .ok()
            .map(|row| row.get::<_, f64>(0)),
        _ => None,
    };
    let stats = journal.stats();
    let ms = |d: Duration| d.as_secs_f64() * 1000.0;
    say(format!(
        "D1 editors={editors} files={} rate={rate}/s ops={ops_done} errors={} op_bytes={op_bytes} commit p50={:.2}ms p99={:.2}ms max={:.2}ms batches={} max_batch={} ops/batch={:.1} wal/op={}",
        files.len(),
        errors.load(Ordering::Relaxed),
        ms(percentile(&sorted, 0.5)),
        ms(percentile(&sorted, 0.99)),
        ms(sorted.last().copied().unwrap_or_default()),
        stats.batches,
        stats.max_batch,
        stats.ops as f64 / stats.batches.max(1) as f64,
        wal_bytes.map_or("n/a".to_owned(), |bytes| format!(
            "{:.0}B",
            bytes / ops_done.max(1) as f64
        )),
    ));
}

/// `n` files of one account holding the simulation's document (`--create N`).
async fn create_files(client: &tokio_postgres::Client, n: usize, rects: usize) -> Vec<String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_millis() as u64;
    let user = format!("bench-{stamp}");
    client
        .execute(
            "INSERT INTO users(id,email,name,password) VALUES($1,$2,'bench','')",
            &[&user, &format!("{user}@example.invalid")],
        )
        .await
        .expect("a bench user");
    let document = morfa_storagesim::document(rects);
    let mut files = Vec::with_capacity(n);
    for k in 0..n {
        let id = format!(
            "{:08x}-0000-4000-8000-{:012x}",
            k as u32,
            stamp & 0xffff_ffff_ffff
        );
        client
            .execute(
                "INSERT INTO design_files(id,user_id,name,document,bytes,node_count) VALUES($1,$2,'bench',$3,octet_length($3),$4)",
                &[&id, &user, &document, &((rects + 1) as i32)],
            )
            .await
            .expect("a bench file");
        files.push(id);
    }
    files
}

async fn wal(client: &tokio_postgres::Client) -> Option<String> {
    client
        .query_one("SELECT pg_current_wal_lsn()::text", &[])
        .await
        .ok()
        .map(|row| row.get::<_, String>(0))
}

/// TARGETS S1/S3 on a document file (`--doc`, repeated `--copies` times under new ids): one checkpoint written
/// (encode + zstd CPU, upload, integrity re-read), `--tail` ops journaled after it, then the cold load `--runs` times.
async fn open_save(args: Args) {
    use morfa_blobs::{ObjectStore, S3, S3Config};
    let db = args.text("db");
    let copies: usize = args.num("copies", 1);
    let tail: u64 = args.num("tail", 1000);
    let runs: usize = args.num("runs", 3);
    let format = Format::parse(&args.num("format", "bin".to_owned())).expect("--format bin|json");
    let text = std::fs::read_to_string(args.text("doc")).expect("--doc file.json");
    let mut model = morfa_model::from_json(&text).expect("a document");
    let originals: Vec<_> = model.nodes.values().cloned().collect();
    let pages = model.pages.clone();
    for k in 1..copies {
        let rename = |id: &str| format!("{id}~{k}");
        for node in &originals {
            let mut copy = node.clone();
            copy.id = rename(&node.id);
            copy.parent_id = node.parent_id.as_deref().map(rename);
            copy.children = node
                .children
                .as_ref()
                .map(|children| children.iter().map(|c| rename(c)).collect());
            model.nodes.insert(copy.id.clone(), copy);
        }
        model.pages.extend(pages.iter().map(|page| rename(page)));
    }
    let json_bytes = morfa_model::to_json(&model).len();
    // The ops: 20 layers moved per op, whole nodes, as the editor sends them.
    let movable: Vec<_> = model
        .nodes
        .values()
        .filter(|node| node.parent_id.is_some())
        .take(4000)
        .cloned()
        .collect();
    let doc = std::sync::Arc::new(morfa_model::store::Document::from_model(&model));
    let (client, connection) = tokio_postgres::connect(&db, tokio_postgres::NoTls)
        .await
        .expect("connect");
    tokio::spawn(connection);
    let file = create_files(&client, 1, 1).await.remove(0);
    client.execute("UPDATE design_files SET fence=1,collab_node='bench',lease_until=now()+interval '1 hour' WHERE id=$1", &[&file]).await.expect("lease");
    say(format!(
        "document: {} layers, {:.1} MB as JSON",
        doc.len(),
        json_bytes as f64 / 1e6
    ));
    struct Plan {
        db: String,
        file: String,
        format: Format,
        doc: std::sync::Arc<morfa_model::store::Document>,
        movable: Vec<morfa_model::SceneNode>,
        tail: u64,
        runs: usize,
    }
    async fn run<S: ObjectStore + Clone + 'static>(store: S, plan: &Plan) {
        let Plan {
            db,
            file,
            format,
            doc,
            movable,
            tail,
            runs,
        } = plan;
        let (db, file, format, tail, runs) = (db.as_str(), file.as_str(), *format, *tail, *runs);
        let doc = doc.clone();
        let checkpoints = Checkpoints::new(store, db, format);
        let written = checkpoints
            .write(file, 1, 1, doc)
            .await
            .expect("checkpoint");
        say(format!(
            "S3 checkpoint {}: {:.1} MB object · encode+zstd {:.0} ms (CPU, blocking thread) · upload {:.0} ms · integrity re-read {:.0} ms",
            format.name(),
            written.bytes as f64 / 1e6,
            written.encode.as_secs_f64() * 1e3,
            written.upload.as_secs_f64() * 1e3,
            written.verify.as_secs_f64() * 1e3
        ));
        let journal = PgJournal::start(Config::new(db));
        let file_arc: Arc<str> = file.into();
        for version in 2..=tail + 1 {
            let mut patch = morfa_model::DocumentPatch::default();
            let nodes = patch.nodes.get_or_insert_with(Default::default);
            for j in 0..20 {
                let mut node = movable[((version as usize) * 20 + j) % movable.len()].clone();
                node.x += version as f64;
                nodes.insert(node.id.clone(), Some(node));
            }
            journal
                .append(Entry {
                    file: file_arc.clone(),
                    version,
                    fence: 1,
                    client: None,
                    user_id: None,
                    body: ops::patch_body(&patch),
                })
                .await
                .expect("journal");
        }
        for _ in 0..runs {
            let started = Instant::now();
            let loaded = checkpoints.load(file).await.expect("load").expect("file");
            say(format!(
                "S1 cold load: {:.0} ms (fetch checkpoint ‖ {} rows {:.0} ms, decode + apply {:.0} ms) → version {}",
                started.elapsed().as_secs_f64() * 1e3,
                loaded.rows,
                loaded.fetch.as_secs_f64() * 1e3,
                loaded.decode.as_secs_f64() * 1e3,
                loaded.version
            ));
        }
        let _ = checkpoints.store().delete(&written.key).await;
    }
    let plan = Plan {
        db: db.clone(),
        file,
        format,
        doc,
        movable,
        tail,
        runs,
    };
    match args.0.get("s3") {
        Some(_) => {
            let var =
                |name: &str| std::env::var(format!("MORFA_B2_S3_{name}")).expect("MORFA_B2_S3_*");
            let store = S3::new(S3Config::new(
                &var("ENDPOINT"),
                &var("REGION"),
                &var("BUCKET"),
                &var("KEY"),
                &var("SECRET"),
            ))
            .expect("s3");
            run(store, &plan).await;
        }
        None => {
            run(
                DirStore::new(args.num("store", "/tmp/morfa-b2-open-save".to_owned())),
                &plan,
            )
            .await
        }
    }
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("node") => node(Args::parse(&args[1..])).await,
        Some("bench") => bench(Args::parse(&args[1..])).await,
        Some("open-save") => open_save(Args::parse(&args[1..])).await,
        _ => {
            eprintln!("usage: storagesim node … | storagesim bench … (see the source's header)");
            std::process::exit(2);
        }
    }
}
