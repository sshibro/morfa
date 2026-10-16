//! `morfa-collab`: the co-editing service (docs/BACKEND.md §2).
//!
//!     morfa-collab [serve]          serve (configuration from the environment, below)
//!     morfa-collab keygen           print a new Ed25519 key pair for tickets (private for api, public for collab)
//!     morfa-collab ticket <private key> <file> <user> <role> [name] [ttl seconds]
//!                                   mint a ticket (loadgen and local runs)
//!
//! Environment:
//!   MORFA_COLLAB_ADDR               listen address (127.0.0.1:3410)
//!   MORFA_COLLAB_NODE               this node's id in the lease (the host name)
//!   MORFA_COLLAB_TICKET_KEY         api's ticket public key, base64url (required unless dev tickets)
//!   MORFA_COLLAB_DEV_TICKETS=1      accept unsigned `dev.` tickets (never in production)
//!   MORFA_COLLAB_INTERNAL_SECRET    bearer secret of /internal/* (unset: /internal/* is refused)
//!   MORFA_COLLAB_API_URL            api's base URL for ACL re-validation (unset: pushes only)
//!   MORFA_COLLAB_ORIGINS            comma-separated allowed upgrade origins (unset: any)
//!   MORFA_COLLAB_PG_URL             PostgreSQL (lane B2's journal, lease and checkpoint records); unset: in memory
//!   MORFA_COLLAB_S3_ENDPOINT        checkpoint objects in S3 (with _REGION, _BUCKET, _ACCESS_KEY, _SECRET_KEY);
//!   MORFA_COLLAB_CHECKPOINT_DIR     else in this directory (./collab-checkpoints)
//!   MORFA_COLLAB_SEED               a document JSON every unknown file loads as (in-memory journal; loadgen)
//!   MORFA_COLLAB_SHARDS             shard threads, each a single-threaded runtime (one per core; 0: none)
//!   MORFA_COLLAB_JOURNAL_SHARDS     PostgreSQL journal connections committing in parallel (2)
//!   MORFA_COLLAB_SOCKET_COST        a new socket's assumed cost when placing files on shards, ‰ of a core (1.5)
//!   MORFA_COLLAB_MEM_JOURNAL_KEEP  journal entries kept per file before folding (4096; until B2's journal)
//!   MORFA_COLLAB_ENGINE             `ops` (the model engine; the only one until L2a's merge lands)
//!   MORFA_COLLAB_SEND_QUEUE_BYTES   per-connection send queue (4 MiB)
//!   MORFA_COLLAB_TICKET_PRIVATE_KEY the tickets' signing key (`keygen`; the private half of MORFA_COLLAB_TICKET_KEY): this
//!                                   node then serves GET /api/design-files/:id/session (session.rs, lane A7) and needs
//!                                   MORFA_COLLAB_PG_URL and api's settings below, read as api reads them:
//!     DESIGN_COLLAB_NODES, DESIGN_COLLAB, DESIGN_COLLAB_ACCOUNTS, ENABLE_DESIGN_TOOL, DESIGN_TOOL_ACCOUNTS
//!   MORFA_COLLAB_SESSION_COOKIE     the session cookie's name (`__Host-forma_session`; `forma_session` outside production)
//!   MORFA_COLLAB_APP_ORIGIN         the page origin tickets are bound to (api's APP_ORIGIN; unset: the request's Origin)
//!   MORFA_COLLAB_SESSION_POOL       PostgreSQL connections of that route (8)
//!   MORFA_COLLAB_DRAIN_NOTICE_MS    on SIGTERM/SIGINT, /healthz says "draining" this long before files close (2500)
//!   MORFA_COLLAB_DRAIN_TIMEOUT_MS   the whole drain; files still open then are stopped at once (25000)
//!   OTEL_EXPORTER_OTLP_ENDPOINT     op spans to this collector over OTLP/HTTP JSON (src/observe.rs; unset: off)
//!   MORFA_COLLAB_MEMORY_LIMIT_MB    resident set over which the node opens no new file (unset: no cap; src/memory.rs)
//!   RUST_LOG                        tracing filter (info)
//!
//! SIGTERM (systemd stop, deploys) or SIGINT drains the node (src/drain.rs): checkpoint every open file, `bye
//! {shutdown}`, release the leases, exit within the unit's 30 s; a second signal exits at once.

use morfa_collab::journal::MemJournal;
use morfa_collab::lease::MemLease;
use morfa_collab::router::ops_engine;
use morfa_collab::{App, Config, Shared, Tickets};
use morfa_protocol::Role;
use morfa_protocol::ticket::{
    Claims, mint, signing_key_from_base64, signing_key_to_base64, verifying_key_from_base64,
    verifying_key_to_base64,
};
use std::sync::Arc;

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn fail(message: &str) -> ! {
    eprintln!("morfa-collab: {message}");
    std::process::exit(2)
}

fn keygen() {
    let mut seed = [0u8; 32];
    for b in seed.iter_mut() {
        *b = rand::random();
    }
    let key = ed25519_key(seed);
    println!(
        "MORFA_COLLAB_TICKET_PRIVATE_KEY={}",
        signing_key_to_base64(&key)
    );
    println!(
        "MORFA_COLLAB_TICKET_KEY={}",
        verifying_key_to_base64(&key.verifying_key())
    );
}

fn ed25519_key(seed: [u8; 32]) -> morfa_protocol::ticket::TicketSigningKey {
    morfa_protocol::ticket::TicketSigningKey::from_bytes(&seed)
}

fn ticket(args: &[String]) {
    if args.len() < 4 {
        fail("usage: morfa-collab ticket <private key> <file> <user> <role> [name] [ttl seconds]");
    }
    let key = signing_key_from_base64(&args[0]).unwrap_or_else(|| fail("bad private key"));
    let role =
        Role::parse(&args[3]).unwrap_or_else(|| fail("role: owner|admin|editor|developer|viewer"));
    let ttl: u64 = args.get(5).and_then(|t| t.parse().ok()).unwrap_or(60);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("clock")
        .as_secs();
    let claims = Claims {
        file: args[1].clone(),
        user: args[2].clone(),
        name: args.get(4).cloned().unwrap_or_else(|| "Member".into()),
        role,
        team: None,
        origin: None,
        exp: now + ttl,
    };
    println!("{}", mint(&key, &claims));
}

async fn serve() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();
    let tickets = match (
        env("MORFA_COLLAB_TICKET_KEY"),
        env("MORFA_COLLAB_DEV_TICKETS").as_deref(),
    ) {
        (Some(key), _) => Tickets::Ed25519(
            verifying_key_from_base64(&key)
                .unwrap_or_else(|| fail("MORFA_COLLAB_TICKET_KEY is not an Ed25519 public key")),
        ),
        (None, Some("1")) => {
            tracing::warn!("accepting unsigned dev tickets (MORFA_COLLAB_DEV_TICKETS=1)");
            Tickets::Dev
        }
        _ => fail("set MORFA_COLLAB_TICKET_KEY (or MORFA_COLLAB_DEV_TICKETS=1 for local runs)"),
    };
    let tickets_key = match &tickets {
        Tickets::Ed25519(key) => Some(*key),
        Tickets::Dev => None,
    };
    let mut config = Config::new(tickets);
    if let Some(node) = env("MORFA_COLLAB_NODE").or_else(|| env("HOSTNAME")) {
        config.node = node;
    }
    config.internal_secret = env("MORFA_COLLAB_INTERNAL_SECRET");
    config.snapshot_url = env("MORFA_COLLAB_SNAPSHOT_URL").as_deref() == Some("1");
    config.shards = shards();
    if let Some(origins) = env("MORFA_COLLAB_ORIGINS") {
        config.allowed_origins = origins.split(',').map(|o| o.trim().to_owned()).collect();
    }
    if let Some(mb) = env("MORFA_COLLAB_MEMORY_LIMIT_MB") {
        let mb: u64 = mb
            .parse()
            .unwrap_or_else(|_| fail("MORFA_COLLAB_MEMORY_LIMIT_MB: a whole number of MiB"));
        config.memory_limit = Some(mb * 1024 * 1024);
    }
    if let Some(bytes) = env("MORFA_COLLAB_SEND_QUEUE_BYTES").and_then(|b| b.parse().ok()) {
        config.send_queue_bytes = bytes;
    }
    match env("MORFA_COLLAB_ENGINE").as_deref() {
        None | Some("ops") => {}
        Some(other) => fail(&format!(
            "MORFA_COLLAB_ENGINE={other}: only `ops` exists (the JSON engine is gone; L2a's merge lands inside `ops`)"
        )),
    }
    let (journal, lease) = storage();
    let pg_url = env("MORFA_COLLAB_PG_URL");
    let internal_api = env("MORFA_COLLAB_API_URL").zip(config.internal_secret.clone());
    let acl = match (env("MORFA_COLLAB_API_URL"), &config.internal_secret) {
        (Some(url), Some(secret)) => Some(Arc::new(morfa_collab::acl::HttpAcl::new(
            url,
            secret.clone(),
        )) as Arc<dyn morfa_collab::acl::AclSource>),
        _ => None,
    };
    let addr = env("MORFA_COLLAB_ADDR").unwrap_or_else(|| "127.0.0.1:3410".into());
    let minting = minting(&tickets_key, pg_url.as_deref(), internal_api.clone());
    if let Some(export) = morfa_collab::observe::ExportConfig::from_env(&config.node) {
        morfa_collab::observe::init(export);
    }
    let app = App::new(Shared {
        config,
        journal,
        lease,
        acl,
        engine: ops_engine(),
    });
    let app = match minting {
        Some(minting) => app.with_minting(minting),
        None => app,
    };
    if let Some(url) = pg_url {
        tokio::spawn(morfa_collab::pg::listen_acl(url, app.clone()));
    }
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| fail(&format!("bind {addr}: {e}")));
    tracing::info!(addr, "morfa-collab listening");
    let drain = app.clone();
    let drain_config = drain_config();
    // The listener stays open while the node drains: /healthz answers 503 and new sockets get `bye {shutdown}`.
    let shutdown = async move {
        let signal = stop_signal().await;
        tracing::info!(signal, "stop requested: draining");
        tokio::spawn(async {
            let again = stop_signal().await;
            tracing::warn!(
                signal = again,
                "second stop signal: exiting without waiting for the drain"
            );
            std::process::exit(1);
        });
        drain.drain(drain_config).await;
    };
    if let Err(e) = morfa_collab::serve(listener, app, shutdown).await {
        fail(&e.to_string());
    }
}

/// The journal and the lease: lane B2's PostgreSQL ones with `MORFA_COLLAB_PG_URL`, else in memory.
fn storage() -> (
    Arc<dyn morfa_collab::journal::Journal>,
    Arc<dyn morfa_collab::lease::Lease>,
) {
    use morfa_collab::pg::{PgLeases, PgStore};
    let Some(url) = env("MORFA_COLLAB_PG_URL") else {
        // Entries beyond the newest few thousand per file fold into the base, as a checkpoint would.
        let keep = env("MORFA_COLLAB_MEM_JOURNAL_KEEP")
            .map(|v| {
                v.parse()
                    .unwrap_or_else(|_| fail("MORFA_COLLAB_MEM_JOURNAL_KEEP: a count"))
            })
            .unwrap_or(4096);
        let mut journal = MemJournal::new().with_keep(keep);
        if let Some(path) = env("MORFA_COLLAB_SEED") {
            let text =
                std::fs::read_to_string(&path).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
            let doc =
                morfa_model::from_json(&text).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
            journal = journal.with_seed(doc);
        }
        tracing::warn!(
            "journal and lease in memory (no MORFA_COLLAB_PG_URL): a restart loses every change"
        );
        return (Arc::new(journal), Arc::new(MemLease::new()));
    };
    let mut config = morfa_journal::Config::new(url.clone());
    if let Some(n) = env("MORFA_COLLAB_JOURNAL_SHARDS") {
        config.shards = n
            .parse()
            .unwrap_or_else(|_| fail("MORFA_COLLAB_JOURNAL_SHARDS: a count"));
    }
    let journal = morfa_journal::PgJournal::start(config);
    let lease = Arc::new(PgLeases(morfa_lease::PgLease::new(&url)));
    let format = morfa_checkpoint::Format::Bin;
    match env("MORFA_COLLAB_S3_ENDPOINT") {
        Some(endpoint) => {
            let need = |name: &str| {
                env(name).unwrap_or_else(|| {
                    fail(&format!("{name} is required with MORFA_COLLAB_S3_ENDPOINT"))
                })
            };
            let store = morfa_blobs::S3::new(morfa_blobs::S3Config::new(
                &endpoint,
                &env("MORFA_COLLAB_S3_REGION").unwrap_or_else(|| "ru-1".into()),
                &need("MORFA_COLLAB_S3_BUCKET"),
                &need("MORFA_COLLAB_S3_ACCESS_KEY"),
                &need("MORFA_COLLAB_S3_SECRET_KEY"),
            ))
            .unwrap_or_else(|e| fail(&format!("S3: {e}")));
            let checkpoints = morfa_checkpoint::Checkpoints::new(Arc::new(store), &url, format);
            (Arc::new(PgStore::new(journal, checkpoints, &url)), lease)
        }
        None => {
            let dir =
                env("MORFA_COLLAB_CHECKPOINT_DIR").unwrap_or_else(|| "./collab-checkpoints".into());
            tracing::warn!(
                dir,
                "checkpoints in a local directory (no MORFA_COLLAB_S3_ENDPOINT)"
            );
            let store = morfa_blobs::DirStore::new(dir);
            let checkpoints = morfa_checkpoint::Checkpoints::new(Arc::new(store), &url, format);
            (Arc::new(PgStore::new(journal, checkpoints, &url)), lease)
        }
    }
}

/// `/api/design-files/:id/session` on this node (session.rs): with `MORFA_COLLAB_TICKET_PRIVATE_KEY`, the private half of
/// the key this node verifies with (never under dev tickets), and PostgreSQL.
fn minting(
    verifying: &Option<morfa_protocol::ticket::TicketVerifyingKey>,
    pg_url: Option<&str>,
    api: Option<(String, String)>,
) -> Option<Arc<morfa_collab::session::Minting>> {
    use morfa_collab::session::{Minting, MintingConfig, Switch, ToolSwitch, parse_nodes};
    let text = env("MORFA_COLLAB_TICKET_PRIVATE_KEY")?;
    let key = signing_key_from_base64(&text)
        .unwrap_or_else(|| fail("MORFA_COLLAB_TICKET_PRIVATE_KEY is not an Ed25519 private key"));
    match verifying {
        Some(public) if *public == key.verifying_key() => {}
        Some(_) => fail(
            "MORFA_COLLAB_TICKET_PRIVATE_KEY is not the private half of MORFA_COLLAB_TICKET_KEY",
        ),
        None => fail(
            "MORFA_COLLAB_TICKET_PRIVATE_KEY needs MORFA_COLLAB_TICKET_KEY (never dev tickets)",
        ),
    }
    let pg_url = pg_url
        .unwrap_or_else(|| fail("MORFA_COLLAB_TICKET_PRIVATE_KEY needs MORFA_COLLAB_PG_URL"))
        .to_owned();
    let raw = |name: &str| std::env::var(name).unwrap_or_default();
    let nodes = parse_nodes(&raw("DESIGN_COLLAB_NODES"));
    if nodes.is_empty() {
        tracing::warn!(
            "DESIGN_COLLAB_NODES is empty: /session answers collab_inactive (legacy), as api does"
        );
    }
    let pool = env("MORFA_COLLAB_SESSION_POOL")
        .map(|v| {
            v.parse()
                .unwrap_or_else(|_| fail("MORFA_COLLAB_SESSION_POOL: a count"))
        })
        .unwrap_or(8);
    tracing::info!(
        nodes = nodes.len(),
        pool,
        "serving /api/design-files/:id/session"
    );
    Some(Minting::start(MintingConfig {
        key,
        pg_url,
        pool,
        nodes,
        switch: Switch::parse(&raw("DESIGN_COLLAB"), &raw("DESIGN_COLLAB_ACCOUNTS")),
        tool: ToolSwitch::parse(&raw("ENABLE_DESIGN_TOOL"), &raw("DESIGN_TOOL_ACCOUNTS")),
        cookie: env("MORFA_COLLAB_SESSION_COOKIE").unwrap_or_else(|| "__Host-forma_session".into()),
        origin: env("MORFA_COLLAB_APP_ORIGIN"),
        api,
    }))
}

/// Waits for SIGTERM or SIGINT; answers its name.
async fn stop_signal() -> &'static str {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term =
            signal(SignalKind::terminate()).unwrap_or_else(|e| fail(&format!("SIGTERM: {e}")));
        let mut int =
            signal(SignalKind::interrupt()).unwrap_or_else(|e| fail(&format!("SIGINT: {e}")));
        tokio::select! {
            _ = term.recv() => "SIGTERM",
            _ = int.recv() => "SIGINT",
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
        "ctrl-c"
    }
}

/// `MORFA_COLLAB_DRAIN_NOTICE_MS`, `MORFA_COLLAB_DRAIN_TIMEOUT_MS` (src/drain.rs).
fn drain_config() -> morfa_collab::drain::DrainConfig {
    let ms = |name: &str| {
        env(name).map(|v| {
            std::time::Duration::from_millis(
                v.parse()
                    .unwrap_or_else(|_| fail(&format!("{name}: milliseconds"))),
            )
        })
    };
    let mut config = morfa_collab::drain::DrainConfig::default();
    if let Some(notice) = ms("MORFA_COLLAB_DRAIN_NOTICE_MS") {
        config.notice = notice;
    }
    if let Some(deadline) = ms("MORFA_COLLAB_DRAIN_TIMEOUT_MS") {
        config.deadline = deadline;
    }
    config
}

/// Shard threads: `MORFA_COLLAB_SHARDS`, else one per core.
fn shards() -> usize {
    env("MORFA_COLLAB_SHARDS")
        .map(|v| {
            v.parse()
                .unwrap_or_else(|_| fail("MORFA_COLLAB_SHARDS: a count"))
        })
        .unwrap_or_else(|| std::thread::available_parallelism().map_or(1, |n| n.get()))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match args.first().map(String::as_str) {
        Some("keygen") => keygen(),
        Some("ticket") => ticket(&args[1..]),
        None | Some("serve") => {
            // With shards the main runtime serves HTTP (the handshakes, /internal/*) and writes what the shards'
            // actors leave to the connections' writer tasks; it is idle while every file is small.
            let mut runtime = tokio::runtime::Builder::new_multi_thread();
            let runtime = runtime.enable_all().build().expect("tokio runtime");
            runtime.block_on(serve());
        }
        Some(other) => fail(&format!("unknown command {other}")),
    }
}
