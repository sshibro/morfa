//! The service's HTTP surface and the file → actor map (docs/BACKEND.md §2 "Routing", §9, §11).
//!
//! - `GET /collab/:file?wire=json`: the socket (conn.rs).
//! - `GET /api/design-files/:file/session`: the socket's ticket, as api answers it (session.rs; with a signing key).
//! - `GET /healthz`, `GET /metrics` (Prometheus text).
//! - `POST /internal/acl` `{file, user, role|null}`: api pushes a role change.
//! - `POST /internal/file` `{file, name?, close?}`: renamed, or closed (`trashed`, `erased`, `shutdown`).
//! - `POST /internal/replace` `{file, user, baseVersion?, document}`: api's `PUT` (restore, import) while collab
//!   owns the file; answered after the commit.
//! - `POST /internal/notice` `{file, kind: comments|meeting, revision?, user?}`: a file-class event for the sockets.
//! - `POST /internal/shadow-op`: BACKEND §7 step 2 (internal.rs); `GET /internal/shadow-doc/:file`: the copy.
//! - `GET /internal/doc/:file`: `{version, committed, hash, nodes}` of an open file.
//!
//! `/internal/*` reads bodies up to [`INTERNAL_BODY_BYTES`] (a whole document at the cap plus an op).
//!
//! `/internal/*` needs `Authorization: Bearer <MORFA_COLLAB_INTERNAL_SECRET>` and is refused when no secret is
//! configured; bind it to the private network (B5).

use crate::acl::AclSource;
use crate::actor::{self, ActorMsg};
use crate::engine::{DocEngine, EngineSource, OpsEngine};
use crate::internal;
use crate::journal::Journal;
use crate::lease::Lease;
use crate::metrics::metrics;
use crate::shard::Shards;
use axum::Router;
use axum::extract::{DefaultBodyLimit, Path, Query, Request, State};
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use hyper_util::rt::TokioIo;
use morfa_model::store::Document as Store;
use morfa_protocol::ticket::{Claims, TicketError, TicketVerifyingKey};
use morfa_protocol::{Version, Wire};
use parking_lot::Mutex;
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// The largest body `/internal/*` reads: a whole document at `DESIGN_DOCUMENT_CAPS.bytes` (a replace, a shadow
/// seed) plus the op a seed carries and the envelope. Larger: 413.
pub const INTERNAL_BODY_BYTES: usize = morfa_protocol::limits::DOCUMENT_BYTES
    + morfa_protocol::limits::MAX_MESSAGE_BYTES
    + 1024 * 1024;

/// How often the shards are checked for a hot one (crate::shard `rebalance_candidate`).
const REBALANCE_EVERY: Duration = Duration::from_secs(2);

pub type EngineFactory = Arc<dyn Fn(EngineSource, Version) -> Box<dyn DocEngine> + Send + Sync>;

/// The actors' engine: `OpsEngine` on the model's compact store (TARGETS M6).
pub fn ops_engine() -> EngineFactory {
    Arc::new(|source, version| {
        Box::new(match source {
            EngineSource::Model(document) => {
                let bytes = morfa_model::to_json(&document).len();
                OpsEngine::new_store(Store::from_model(&document), version, Some(bytes))
            }
            EngineSource::Store(store) => OpsEngine::new_store(store, version, None),
        })
    })
}

/// How `hello` tickets are checked.
#[derive(Clone)]
pub enum Tickets {
    /// api's Ed25519 public key (production).
    Ed25519(TicketVerifyingKey),
    /// Unsigned `dev.<base64url claims>` tickets (loadgen and local runs only; `MORFA_COLLAB_DEV_TICKETS=1`).
    Dev,
}

impl Tickets {
    pub fn verify(
        &self,
        ticket: &str,
        file: &str,
        origin: Option<&str>,
    ) -> Result<Claims, TicketError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        match self {
            Tickets::Ed25519(key) => morfa_protocol::ticket::verify(key, ticket, file, origin, now),
            Tickets::Dev => {
                use base64::Engine;
                let payload = ticket.strip_prefix("dev.").ok_or(TicketError::Malformed)?;
                let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
                    .decode(payload)
                    .map_err(|_| TicketError::Malformed)?;
                let claims: Claims =
                    serde_json::from_slice(&bytes).map_err(|_| TicketError::Malformed)?;
                if claims.file != file {
                    return Err(TicketError::WrongFile);
                }
                Ok(claims)
            }
        }
    }
}

/// A dev ticket (`Tickets::Dev`).
pub fn dev_ticket(claims: &Claims) -> String {
    use base64::Engine;
    format!(
        "dev.{}",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(claims).expect("claims"))
    )
}

#[derive(Clone)]
pub struct Config {
    /// This node's id in the lease (`design_files.collab_node`).
    pub node: String,
    pub send_queue_bytes: usize,
    /// The actor's inbox; a full inbox makes the sockets' read loops wait.
    pub inbox: usize,
    pub conns_per_file: usize,
    pub presence_flush_ms: u64,
    /// An actor with no connections stops after this.
    pub idle_close: Duration,
    pub lease_renew: Duration,
    pub revalidate: Duration,
    pub internal_secret: Option<String>,
    pub tickets: Tickets,
    /// Allowed `Origin`s of the upgrade; empty: any (the ticket's own origin binding still applies).
    pub allowed_origins: Vec<String>,
    pub hello_timeout: Duration,
    /// A socket quiet this long gets a WebSocket ping (answered by the browser itself).
    pub ping: Duration,
    pub silence: Duration,
    pub ops_per_second: u32,
    pub bytes_per_second: u32,
    pub presence_per_second: u32,
    /// The in-memory tail of each document (catch-up without the journal).
    pub tail_entries: usize,
    pub tail_bytes: usize,
    /// Shard threads (crate::shard); 0: actors and sockets run on the serving runtime.
    pub shards: usize,
    /// `SO_SNDBUF` of accepted sockets; None: the kernel's (tests shrink it so writes fill the socket).
    pub send_buffer: Option<usize>,
    /// The resident set over which the node takes no new file (crate::memory); None: no cap.
    pub memory_limit: Option<u64>,
    /// Resync through the file's checkpoint: a client that must reload the document gets
    /// `snapshotUrl` (api's `GET /api/design-files/:id/checkpoint`) and then the changes after the checkpoint, instead of
    /// the document encoded here and sent down its socket, when the checkpoint is at most `snapshot_max_ops` versions
    /// behind and the catch-up from it can be served. Off by default (`MORFA_COLLAB_SNAPSHOT_URL=1`) until the client's
    /// open from checkpoint bytes is enabled.
    pub snapshot_url: bool,
    pub snapshot_max_ops: u64,
    /// Move the busiest room off a shard that stays hot (crate::shard `rebalance_candidate`); tests that measure
    /// sockets turn it off and call [`App::rebalance_once`] themselves.
    pub rebalance: bool,
}

impl Config {
    pub fn new(tickets: Tickets) -> Self {
        use morfa_protocol::limits;
        Config {
            node: "local".into(),
            send_queue_bytes: limits::SEND_QUEUE_BYTES,
            inbox: 4096,
            conns_per_file: 600,
            presence_flush_ms: limits::PRESENCE_FLUSH_MS,
            idle_close: Duration::from_secs(60),
            lease_renew: crate::lease::LEASE_RENEW,
            revalidate: crate::acl::REVALIDATE,
            internal_secret: None,
            tickets,
            allowed_origins: Vec::new(),
            hello_timeout: Duration::from_secs(10),
            ping: Duration::from_millis(limits::PING_MS),
            silence: Duration::from_millis(limits::SILENCE_MS),
            ops_per_second: limits::OPS_PER_SECOND,
            bytes_per_second: limits::BYTES_PER_SECOND,
            presence_per_second: limits::PRESENCE_PER_SECOND,
            tail_entries: crate::catchup::TAIL_MAX_ENTRIES,
            tail_bytes: crate::catchup::TAIL_MAX_BYTES,
            shards: 0,
            send_buffer: None,
            memory_limit: None,
            rebalance: true,
            snapshot_url: false,
            snapshot_max_ops: crate::catchup::CATCHUP_MAX_OPS as u64,
        }
    }
}

/// What every actor and connection shares.
pub struct Shared {
    pub config: Config,
    pub journal: Arc<dyn Journal>,
    pub lease: Arc<dyn Lease>,
    pub acl: Option<Arc<dyn AclSource>>,
    pub engine: EngineFactory,
}

/// Open files: id → the actor's inbox.
pub struct Docs {
    map: Mutex<HashMap<String, (u64, mpsc::Sender<ActorMsg>)>>,
    next: Mutex<u64>,
    /// Where files run (an actor keeps its file placed).
    shards: Arc<Shards>,
    /// The connections' writers' runtime ([`App::writers`]): actors hand large fan-outs to it.
    pub writers: Option<tokio::runtime::Handle>,
}

impl Docs {
    pub fn new(shards: Arc<Shards>, writers: Option<tokio::runtime::Handle>) -> Self {
        Docs {
            map: Mutex::default(),
            next: Mutex::default(),
            shards,
            writers,
        }
    }

    pub fn get(&self, file: &str) -> Option<mpsc::Sender<ActorMsg>> {
        self.map.lock().get(file).map(|(_, tx)| tx.clone())
    }

    pub fn get_or_spawn(
        self: &Arc<Self>,
        file: &str,
        shared: &Arc<Shared>,
    ) -> mpsc::Sender<ActorMsg> {
        let mut map = self.map.lock();
        if let Some((_, tx)) = map.get(file)
            && !tx.is_closed()
        {
            return tx.clone();
        }
        let generation = {
            let mut next = self.next.lock();
            *next += 1;
            *next
        };
        let tx = actor::spawn(
            file.to_owned(),
            Arc::clone(shared),
            Arc::clone(self),
            generation,
        );
        map.insert(file.to_owned(), (generation, tx.clone()));
        self.shards.actor_alive(file, true);
        tx
    }

    pub fn remove(&self, file: &str, generation: u64) {
        let mut map = self.map.lock();
        if map.get(file).is_some_and(|(g, _)| *g == generation) {
            map.remove(file);
            self.shards.actor_alive(file, false);
        }
    }

    pub fn len(&self) -> usize {
        self.map.lock().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Messages waiting in each open file's inbox (ops, joins, presence wakes): `(file, waiting)`.
    pub fn waiting(&self) -> Vec<(String, usize)> {
        self.map
            .lock()
            .iter()
            .map(|(file, (_, tx))| (file.clone(), tx.max_capacity() - tx.capacity()))
            .collect()
    }

    pub fn all(&self) -> Vec<mpsc::Sender<ActorMsg>> {
        self.map.lock().values().map(|(_, tx)| tx.clone()).collect()
    }
}

#[derive(Clone)]
pub struct App {
    pub shared: Arc<Shared>,
    pub docs: Arc<Docs>,
    pub shadow: Arc<internal::Shadow>,
    pub shards: Arc<Shards>,
    /// The runtime the connections' writer tasks run on: the multi-threaded one that serves HTTP. What an actor
    /// does not write into idle sockets itself (a fan-out beyond its allowance, a full socket) is written there,
    /// on every core, rather than on the file's shard thread alone (TARGETS M4: 500 receivers of one file).
    pub writers: Option<tokio::runtime::Handle>,
    /// `GET /api/design-files/{file}/session` (session.rs): set on a node given the tickets' signing key (lane A7).
    pub minting: Option<Arc<crate::session::Minting>>,
    /// Whether the node drains (crate::drain).
    pub drain: Arc<crate::drain::DrainState>,
}

impl App {
    pub fn new(shared: Shared) -> Self {
        let shards = match shared.config.shards {
            0 => Shards::none(),
            n => Shards::start(n),
        };
        let shards = Arc::new(shards);
        let writers = (!shards.is_empty())
            .then(tokio::runtime::Handle::try_current)
            .and_then(Result::ok);
        let app = App {
            docs: Arc::new(Docs::new(Arc::clone(&shards), writers.clone())),
            writers,
            minting: None,
            drain: Arc::default(),
            shared: Arc::new(shared),
            shadow: Arc::new(internal::Shadow::default()),
            shards,
        };
        // A shard that stays hot gives up its busiest room (crate::shard `rebalance_candidate`).
        if !app.shards.is_empty()
            && app.shared.config.rebalance
            && let Ok(runtime) = tokio::runtime::Handle::try_current()
        {
            let rebalancing = app.clone();
            runtime.spawn(async move {
                let mut tick = tokio::time::interval(REBALANCE_EVERY);
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tick.tick().await;
                    rebalancing.rebalance_once().await;
                }
            });
        }
        app
    }

    /// One rebalance check: the room a hot shard gives up closes with `bye {moved}` (after acking what it applied);
    /// its clients reconnect and the file opens again on a cooler shard. Answers the file moved.
    pub async fn rebalance_once(&self) -> Option<String> {
        let file = self.shards.rebalance_candidate()?;
        let actor = self.docs.get(&file)?;
        actor
            .send(ActorMsg::Shutdown {
                reason: morfa_protocol::ByeReason::Moved,
            })
            .await
            .ok()?;
        metrics().rebalances_total.inc();
        tracing::info!(file, "room moved off a hot shard");
        Some(file)
    }

    /// Serves `/api/design-files/{file}/session` (session.rs) with this signing key and settings.
    pub fn with_minting(mut self, minting: Arc<crate::session::Minting>) -> Self {
        self.minting = Some(minting);
        self
    }

    pub fn router(&self) -> Router {
        Router::new()
            .route("/collab/{file}", get(socket))
            .route(
                "/api/design-files/{file}/session",
                get(crate::session::serve),
            )
            .route("/healthz", get(healthz))
            .route("/metrics", get(metrics_text))
            .merge(
                Router::new()
                    .route("/internal/acl", post(internal::acl))
                    .route("/internal/file", post(internal::file))
                    .route("/internal/replace", post(internal::replace))
                    .route("/internal/notice", post(internal::notice))
                    .route("/internal/shadow-op", post(internal::shadow_op))
                    .route("/internal/shadow-doc/{file}", get(internal::shadow_doc))
                    .route("/internal/doc/{file}", get(internal::doc))
                    .layer(DefaultBodyLimit::max(INTERNAL_BODY_BYTES)),
            )
            .with_state(self.clone())
    }

    /// Drains the node (deploys, BACKEND §10): every actor closes its sockets with `bye {shutdown}`.
    pub async fn shutdown(&self) {
        for tx in self.docs.all() {
            let _ = tx
                .send(ActorMsg::Shutdown {
                    reason: morfa_protocol::ByeReason::Shutdown,
                })
                .await;
        }
    }
}

/// File ids as api makes them (uuids) and tests name them.
pub fn valid_file_id(file: &str) -> bool {
    !file.is_empty()
        && file.len() <= 64
        && file
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

#[derive(Deserialize)]
struct SocketQuery {
    wire: Option<String>,
}

async fn socket(
    State(app): State<App>,
    Path(file): Path<String>,
    Query(query): Query<SocketQuery>,
    request: Request,
) -> Response {
    let headers = request.headers();
    let Some(accept) = crate::ws::accept_key(request.method(), headers) else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if !valid_file_id(&file) {
        return StatusCode::NOT_FOUND.into_response();
    }
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);
    let allowed = &app.shared.config.allowed_origins;
    if !allowed.is_empty() && !origin.as_ref().is_some_and(|o| allowed.contains(o)) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let wire = match query.wire.as_deref() {
        None => Wire::DEFAULT,
        Some(name) => match Wire::parse(name) {
            Some(wire) => wire,
            None => return StatusCode::BAD_REQUEST.into_response(),
        },
    };
    let upgrade = hyper::upgrade::on(request);
    tokio::spawn(async move {
        let upgraded = match upgrade.await {
            Ok(upgraded) => upgraded,
            Err(error) => {
                tracing::debug!(%error, "upgrade failed");
                return;
            }
        };
        // axum serves plain TCP streams: the socket is framed on the stream itself (crate::ws).
        let parts = match upgraded.downcast::<TokioIo<tokio::net::TcpStream>>() {
            Ok(parts) => parts,
            Err(_) => {
                tracing::error!("upgraded connection is not a TCP stream");
                return;
            }
        };
        let tcp = parts.io.into_inner();
        let read_buf = parts.read_buf;
        let placed = app.shards.place(&file);
        let placement = placed.as_ref().map_or(0, |(_, _, id)| *id);
        let serve = move |tcp: tokio::net::TcpStream| async move {
            let (read, write) = tcp.into_split();
            let reader = crate::ws::Reader::new(
                read,
                read_buf,
                2 * morfa_protocol::limits::MAX_MESSAGE_BYTES,
            );
            let writer = Arc::new(crate::ws::Writer::new(write));
            let shards = Arc::clone(&app.shards);
            let closed = file.clone();
            crate::conn::serve(app, file, wire, origin, reader, writer).await;
            shards.socket_closed(&closed, placement);
        };
        match placed {
            None => serve(tcp).await,
            // The socket moves to its file's shard, where the actor runs.
            Some((shard, guard, _)) => match tcp.into_std() {
                Ok(std) => {
                    shard.handle.spawn(async move {
                        let _counted = guard;
                        match tokio::net::TcpStream::from_std(std) {
                            Ok(tcp) => serve(tcp).await,
                            Err(error) => tracing::warn!(%error, "socket not moved to its shard"),
                        }
                    });
                }
                Err(error) => tracing::warn!(%error, "socket not moved to its shard"),
            },
        }
    });
    Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header(header::CONNECTION, "upgrade")
        .header(header::UPGRADE, "websocket")
        .header(header::SEC_WEBSOCKET_ACCEPT, accept)
        .body(axum::body::Body::empty())
        .expect("a valid response")
}

async fn healthz(State(app): State<App>) -> impl IntoResponse {
    // A draining node answers 503: api stops sending files here and leaves its leases to it (crate::drain).
    let draining = app.draining();
    let status = if draining {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    let body = axum::Json(serde_json::json!({
        "ok": !draining,
        "draining": draining,
        "node": app.shared.config.node,
        "docs": app.docs.len(),
        "conns": metrics().conn_open.get(),
        "memory": {
            "rss": crate::memory::rss(),
            "limit": app.shared.config.memory_limit,
            "full": crate::memory::full(app.shared.config.memory_limit),
        },
        "shards": shard_health(&app),
    }));
    (status, body)
}

async fn metrics_text() -> impl IntoResponse {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        metrics().render() + &crate::observe::render(),
    )
}

/// Each shard's measured CPU (‰ of a core, last sample), its sockets and the messages waiting in its files' inboxes
/// (`queued`: what api's placement reads with `busy`).
fn shard_health(app: &App) -> Vec<serde_json::Value> {
    let loads = app.shards.loads();
    let mut queued = vec![0usize; loads.len()];
    for (file, waiting) in app.docs.waiting() {
        if let Some(shard) = app.shards.shard_of(&file) {
            queued[shard] += waiting;
        }
    }
    loads
        .into_iter()
        .zip(queued)
        .map(|((busy, conns), queued)| serde_json::json!({"busy": busy, "conns": conns, "queued": queued}))
        .collect()
}
