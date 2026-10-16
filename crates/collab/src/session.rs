//! `GET /api/design-files/{file}/session` served by a collab node (lane A7, TARGETS A2; docs/BACKEND.md §2, §11): where
//! the file's actor runs and a 60 s ticket for its socket — what api's `server/design/collab/session.ts` answers, minted here
//! so a reconnect storm (every socket of a restarted node asking at once) never queues behind the api's file lists. Caddy
//! routes the URL to the collab nodes (lane B5); without that route api answers it, and api stays the oracle the tests
//! compare this with (`tests/postgresql-runtime-design-collab-session-node.test.ts`).
//!
//! The order of api's checks, each with api's status, `code` and words:
//!   1. ENABLE_DESIGN_TOOL off → 404 `design_unavailable` (router.ts, before the session);
//!   2. the session cookie (`MORFA_COLLAB_SESSION_COOKIE`, default `__Host-forma_session`) and a live session
//!      (auth.ts `currentUser`) → 401 `unauthorized`; `X-Forma-Account` naming another account → 409 `account_changed`;
//!   3. DESIGN_TOOL_ACCOUNTS (flag.ts `designToolAvailable`) → 404 `design_unavailable`;
//!   4. 60 opens a minute per account (router.ts `streamOpens`, express-rate-limit's fixed window per account; per node,
//!      as api's is per process) → 429 `rate_limited`;
//!   5. session.ts `openCollabSession`: no node configured → 409 `collab_inactive {mode: legacy}`; one statement
//!      (`server/design/collab/sql/session.sql`, the same text api runs) → 404 / 409 `collab_inactive {mode}`; the lease
//!      taken or found (`sql/take-or-find.sql`, three reads) → 503 `design_unavailable {retryable}` without a holder; the
//!      role (a trashed file: viewer for editing roles), the name (trimmed as JS trims, 80 code points, with the default display name when empty), the
//!      origin (`MORFA_COLLAB_APP_ORIGIN`, else the request's Origin), an Ed25519 ticket of `TICKET_TTL_SECONDS`.
//!
//! The node the file hashes to is session.ts `nodeFor`'s rendezvous hashing over `DESIGN_COLLAB_NODES` (the api's own
//! setting, same grammar), skipping peers whose `/healthz` failed three times in a row (api's rule; api alone expires
//! their leases). When this answer took the lease, api is told (`/internal/design-files/:id/collab-taken`): it drops its
//! stale copy and moves open SSE streams of the file, as session.ts does when it takes one itself.

use crate::metrics::metrics;
use crate::router::App;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use morfa_journal::conn::Conn;
use morfa_protocol::Role;
use morfa_protocol::ticket::{Claims, TICKET_TTL_SECONDS, TicketSigningKey, mint};
use parking_lot::Mutex;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// The statement api's session.ts runs (one text, two readers).
const SESSION: &str = include_str!("../../../server/design/collab/sql/session.sql");
const TAKE_OR_FIND: &str = include_str!("../../../server/design/collab/sql/take-or-find.sql");
/// auth.ts `currentUser`'s predicate (the columns this route needs: the id and the rollout's e-mail).
const USER: &str = "SELECT u.id,u.email FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token=$1 AND s.expires>$2 AND u.deletion_requested_at IS NULL";

const TOOL_UNAVAILABLE: &str = "Design is unavailable.";
const SIGN_IN_REQUIRED: &str = "Sign in to continue.";
const ACCOUNT_CHANGED: &str = "The account was changed in another tab. Refresh the page.";
const RATE_LIMITED: &str = "Too many requests. Wait a minute and try again.";
const COLLAB_UNAVAILABLE: &str =
    "Co-editing is unavailable right now. Try again in a few seconds.";
const INACTIVE: &str = "This file is edited without a separate co-editing server.";
const NOT_FOUND: &str = "File not found.";
const SERVER_ERROR: &str = "Could not complete the action. Check the data and try again.";
const DEFAULT_NAME: &str = "Member";

/// session.ts / leases.ts `LEASE_TTL_MS` (B1's `LEASE_TTL`).
const LEASE_TTL_MS: f64 = crate::lease::LEASE_TTL.as_millis() as f64;
/// router.ts `streamOpens`.
const OPENS_PER_WINDOW: u32 = 60;
const OPENS_WINDOW: Duration = Duration::from_secs(60);
/// leases.ts health checks.
const HEALTH_EVERY: Duration = Duration::from_secs(2);
const HEALTH_TIMEOUT: Duration = Duration::from_secs(1);
const HEALTH_FAILURES: u32 = 3;

/// A collab node as `DESIGN_COLLAB_NODES` names it (config.ts `CollabNode`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Node {
    pub name: String,
    pub internal: String,
    pub public: String,
}

/// config.ts `collabNodes`: comma-separated `name=internal URL[|public URL]`; an entry that does not parse is left out, a
/// repeated name keeps its first entry.
pub fn parse_nodes(text: &str) -> Vec<Node> {
    let mut nodes: Vec<Node> = Vec::new();
    for entry in text.split(',').map(str::trim).filter(|e| !e.is_empty()) {
        let at = entry.find('=').unwrap_or(0);
        let name = &entry[..at];
        let rest = if at > 0 { &entry[at + 1..] } else { entry };
        let mut parts = rest.splitn(2, '|');
        let internal_text = parts.next().unwrap_or("");
        let public_text = parts
            .next()
            .filter(|p| !p.is_empty())
            .unwrap_or(internal_text);
        let internal = url_base(internal_text, &["http", "https"]);
        let public = url_base(public_text, &["ws", "wss", "http", "https"]);
        let name_ok = !name.is_empty()
            && name.len() <= 100
            && name
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b));
        match (name_ok, internal, public) {
            (true, Some(internal), Some(public)) => {
                if !nodes.iter().any(|n| n.name == name) {
                    nodes.push(Node {
                        name: name.to_owned(),
                        internal,
                        public,
                    });
                }
            }
            _ => tracing::error!(
                entry,
                "DESIGN_COLLAB_NODES: not name=http(s)://host:port[|ws(s)://public]; left out"
            ),
        }
    }
    nodes
}

/// A URL of one of `schemes` with a host, its trailing slashes removed (config.ts `httpUrl` / `socketBase`).
fn url_base(text: &str, schemes: &[&str]) -> Option<String> {
    let text = text.trim();
    let (scheme, rest) = text.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    if !schemes.contains(&scheme.as_str()) || rest.is_empty() || rest.starts_with('/') {
        return None;
    }
    Some(format!("{scheme}://{}", rest.trim_end_matches('/')))
}

/// nodes.ts `nodeFor`: rendezvous hashing — the node whose sha256(file + "\n" + name)'s first 8 bytes (big-endian) are
/// largest, the first such in order; over the healthy nodes, or all of them when none is.
pub fn node_for<'a>(
    nodes: &'a [Node],
    unhealthy: &HashSet<String>,
    file: &str,
) -> Option<&'a Node> {
    let healthy: Vec<&Node> = nodes
        .iter()
        .filter(|n| !unhealthy.contains(&n.name))
        .collect();
    let candidates: Vec<&Node> = if healthy.is_empty() {
        nodes.iter().collect()
    } else {
        healthy
    };
    let mut best: Option<(&Node, u64)> = None;
    for node in candidates {
        let digest = Sha256::digest(format!("{file}\n{}", node.name).as_bytes());
        let score = u64::from_be_bytes(digest[..8].try_into().expect("8 bytes"));
        if best.is_none_or(|(_, top)| score > top) {
            best = Some((node, score));
        }
    }
    best.map(|(node, _)| node)
}

/// switch.ts: `DESIGN_COLLAB` (legacy unless shadow or rust) and `DESIGN_COLLAB_ACCOUNTS` (`<id>=<mode>,…`, the id may
/// contain `=` before the last one; a later entry of an id replaces its mode in the earlier entry's place).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Switch {
    pub global: String,
    pub overrides: Vec<(String, String)>,
}

fn is_mode(mode: &str) -> bool {
    matches!(mode, "legacy" | "shadow" | "rust")
}

impl Switch {
    pub fn parse(global: &str, accounts: &str) -> Self {
        let global = global.trim();
        let mut overrides: Vec<(String, String)> = Vec::new();
        for entry in accounts.split(',').map(str::trim).filter(|e| !e.is_empty()) {
            let at = entry.rfind('=');
            let (id, mode) = match at {
                Some(at) if at > 0 => (entry[..at].trim(), entry[at + 1..].trim()),
                _ => ("", ""),
            };
            if !id.is_empty() && is_mode(mode) {
                match overrides.iter_mut().find(|(known, _)| known == id) {
                    Some(existing) => existing.1 = mode.to_owned(),
                    None => overrides.push((id.to_owned(), mode.to_owned())),
                }
            } else {
                tracing::error!(
                    entry,
                    "DESIGN_COLLAB_ACCOUNTS: not <id>=legacy|shadow|rust; left out"
                );
            }
        }
        Switch {
            global: if is_mode(global) { global } else { "legacy" }.to_owned(),
            overrides,
        }
    }
}

/// flag.ts: `ENABLE_DESIGN_TOOL=1`, and `DESIGN_TOOL_ACCOUNTS` (ids, or e-mails compared in lower case; empty: everyone).
#[derive(Debug, Clone)]
pub struct ToolSwitch {
    pub enabled: bool,
    pub accounts: Option<HashSet<String>>,
}

impl ToolSwitch {
    pub fn parse(enabled: &str, accounts: &str) -> Self {
        let entries: HashSet<String> = accounts
            .split(',')
            .map(str::trim)
            .filter(|e| !e.is_empty())
            .map(|e| {
                if e.contains('@') {
                    e.to_lowercase()
                } else {
                    e.to_owned()
                }
            })
            .collect();
        ToolSwitch {
            enabled: enabled == "1",
            accounts: (!entries.is_empty()).then_some(entries),
        }
    }

    fn available(&self, id: &str, email: Option<&str>) -> bool {
        match &self.accounts {
            None => true,
            Some(accounts) => {
                accounts.contains(id) || email.is_some_and(|e| accounts.contains(&e.to_lowercase()))
            }
        }
    }
}

/// express-rate-limit's memory store as router.ts uses it: per key a window that starts at its first hit and lasts
/// `OPENS_WINDOW`; every request counts; more than `OPENS_PER_WINDOW` in a window is refused.
#[derive(Default)]
struct Limiter {
    clients: Mutex<HashMap<String, (u32, Instant)>>,
}

impl Limiter {
    /// The hits of this window including this one, and when it resets.
    fn hit(&self, key: &str, now: Instant) -> (u32, Instant) {
        let mut clients = self.clients.lock();
        if clients.len() > 100_000 {
            clients.retain(|_, (_, reset)| *reset > now);
        }
        let client = clients
            .entry(key.to_owned())
            .or_insert((0, now + OPENS_WINDOW));
        if client.1 <= now {
            *client = (0, now + OPENS_WINDOW);
        }
        client.0 += 1;
        *client
    }

    /// Takes back a hit (a request api would have refused before its limiter: the session had ended).
    fn undo(&self, key: &str) {
        if let Some(client) = self.clients.lock().get_mut(key) {
            client.0 = client.0.saturating_sub(1);
        }
    }
}

/// Connections of this route, each preparing its statements once (crates/journal `Conn`).
struct Pool {
    conns: Vec<tokio::sync::Mutex<Conn>>,
    next: AtomicUsize,
}

impl Pool {
    fn new(url: &str, size: usize) -> Self {
        Pool {
            conns: (0..size.max(1))
                .map(|_| tokio::sync::Mutex::new(Conn::new(url)))
                .collect(),
            next: AtomicUsize::new(0),
        }
    }

    /// A free connection if one is, else the next one in turn when it frees.
    async fn get(&self) -> tokio::sync::MutexGuard<'_, Conn> {
        let start = self.next.fetch_add(1, Ordering::Relaxed);
        let n = self.conns.len();
        for k in 0..n {
            if let Ok(conn) = self.conns[(start + k) % n].try_lock() {
                return conn;
            }
        }
        self.conns[start % n].lock().await
    }
}

/// Health of the configured nodes as this node sees it (leases.ts `checkNode`, without expiring leases: api does that).
#[derive(Default)]
struct Health {
    failures: Mutex<HashMap<String, u32>>,
    unhealthy: Mutex<HashSet<String>>,
}

/// Everything the route needs; `None` on a node without a signing key (the route then answers 404).
pub struct Minting {
    key: TicketSigningKey,
    pool: Pool,
    nodes: Vec<Node>,
    health: Arc<Health>,
    switch: Switch,
    tool: ToolSwitch,
    cookie: String,
    origin: Option<String>,
    limiter: Limiter,
    /// Session hash → its account (fixed for a session's life): the common ask is one statement.
    accounts: Mutex<HashMap<String, String>>,
    /// api's base URL and the internal secret, for `collab-taken`.
    api: Option<(String, String)>,
}

pub struct MintingConfig {
    pub key: TicketSigningKey,
    pub pg_url: String,
    pub pool: usize,
    pub nodes: Vec<Node>,
    pub switch: Switch,
    pub tool: ToolSwitch,
    pub cookie: String,
    pub origin: Option<String>,
    pub api: Option<(String, String)>,
}

impl Minting {
    /// Starts the peers' health checks on the current runtime.
    pub fn start(config: MintingConfig) -> Arc<Self> {
        let minting = Arc::new(Minting {
            key: config.key,
            pool: Pool::new(&config.pg_url, config.pool),
            nodes: config.nodes,
            health: Arc::default(),
            switch: config.switch,
            tool: config.tool,
            cookie: config.cookie,
            origin: config.origin,
            limiter: Limiter::default(),
            accounts: Mutex::default(),
            api: config.api,
        });
        let nodes = minting.nodes.clone();
        let health = Arc::clone(&minting.health);
        if !nodes.is_empty() {
            tokio::spawn(async move {
                let mut every = tokio::time::interval(HEALTH_EVERY);
                every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    every.tick().await;
                    for node in &nodes {
                        check_node(&health, node).await;
                    }
                }
            });
        }
        minting
    }
}

async fn check_node(health: &Health, node: &Node) {
    // Only plain http is spoken on the private network (http.rs); an https internal URL is not checked here.
    if !node.internal.starts_with("http://") {
        return;
    }
    let ok = crate::http::get(&format!("{}/healthz", node.internal), "", HEALTH_TIMEOUT)
        .await
        .is_ok();
    if ok {
        health.failures.lock().remove(&node.name);
        health.unhealthy.lock().remove(&node.name);
        return;
    }
    let count = {
        let mut failures = health.failures.lock();
        let count = failures.entry(node.name.clone()).or_insert(0);
        *count += 1;
        *count
    };
    if count >= HEALTH_FAILURES {
        health.unhealthy.lock().insert(node.name.clone());
    }
}

/// JS `String.prototype.trim`'s white space (ECMAScript WhiteSpace and LineTerminator), not Rust's Unicode White_Space.
fn js_trim(text: &str) -> &str {
    const JS_SPACE: &[char] = &[
        '\t', '\n', '\u{B}', '\u{C}', '\r', ' ', '\u{A0}', '\u{1680}', '\u{2000}', '\u{2001}',
        '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}', '\u{2008}',
        '\u{2009}', '\u{200A}', '\u{2028}', '\u{2029}', '\u{202F}', '\u{205F}', '\u{3000}',
        '\u{FEFF}',
    ];
    text.trim_matches(JS_SPACE)
}

/// session.ts: `[...(name ?? '').trim()].slice(0, 80).join('') || 'Member'` (code points, as the spread counts them).
pub fn display_name(name: Option<&str>) -> String {
    let name: String = js_trim(name.unwrap_or("")).chars().take(80).collect();
    if name.is_empty() {
        DEFAULT_NAME.to_owned()
    } else {
        name
    }
}

/// decodeURIComponent, or None where it would throw (the cookie package then keeps the raw value).
fn percent_decode(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            let hex = std::str::from_utf8(bytes.get(i + 1..i + 3)?).ok()?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// cookie-parser's value of cookie `name` as auth.ts `sessionToken` takes it: the first pair of that name, trimmed, its
/// quotes removed, percent-decoded when it decodes; a `j:` JSON value is an object there, never a token.
pub fn session_token(headers: &HeaderMap, name: &str) -> Option<String> {
    for value in headers.get_all(header::COOKIE) {
        let Ok(text) = value.to_str() else { continue };
        for pair in text.split(';') {
            let Some((key, raw)) = pair.split_once('=') else {
                continue;
            };
            if key.trim() != name {
                continue;
            }
            let mut raw = raw.trim();
            if raw.len() >= 2 && raw.starts_with('"') && raw.ends_with('"') {
                raw = &raw[1..raw.len() - 1];
            }
            let value = if raw.contains('%') {
                percent_decode(raw).unwrap_or_else(|| raw.to_owned())
            } else {
                raw.to_owned()
            };
            // cookie-parser's JSON cookies: `j:` and JSON that parses replaces the value (a string stays a token).
            if let Some(json) = value.strip_prefix("j:")
                && let Ok(parsed) = serde_json::from_str::<Value>(json)
            {
                return parsed.as_str().map(str::to_owned);
            }
            return Some(value);
        }
    }
    None
}

fn request_id() -> String {
    let bytes: [u8; 16] = rand::random();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

/// An answer in the API's shape: JSON, `no-store`, the request's id.
fn answer(status: StatusCode, body: Value, id: &str, extra: &[(&'static str, String)]) -> Response {
    let mut response = (status, axum::Json(body)).into_response();
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json; charset=utf-8"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    if let Ok(value) = HeaderValue::from_str(id) {
        headers.insert("x-request-id", value);
    }
    for (name, value) in extra {
        if let Ok(value) = HeaderValue::from_str(value) {
            headers.insert(*name, value);
        }
    }
    response
}

/// session.ts / router.ts's design errors: `{...extra, error, code, requestId}`.
fn design_error(status: StatusCode, code: &str, message: &str, extra: Value, id: &str) -> Response {
    let mut body = match extra {
        Value::Object(map) => map,
        _ => serde_json::Map::new(),
    };
    body.insert("error".into(), message.into());
    body.insert("code".into(), code.into());
    body.insert("requestId".into(), id.into());
    answer(status, Value::Object(body), id, &[])
}

fn unavailable(id: &str) -> Response {
    design_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "design_unavailable",
        COLLAB_UNAVAILABLE,
        json!({"retryable": true}),
        id,
    )
}

fn server_error(error: &tokio_postgres::Error, id: &str) -> Response {
    tracing::error!(%error, "session: database");
    answer(
        StatusCode::INTERNAL_SERVER_ERROR,
        json!({"requestId": id, "code": "database_unavailable", "error": SERVER_ERROR}),
        id,
        &[],
    )
}

fn epoch_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |d| d.as_millis() as i64)
}

pub async fn serve(
    State(app): State<App>,
    Path(file): Path<String>,
    headers: HeaderMap,
) -> Response {
    let started = Instant::now();
    let id = request_id();
    let response = match &app.minting {
        None => answer(
            StatusCode::NOT_FOUND,
            json!({"error": "Route not found.", "code": "not_found"}),
            &id,
            &[],
        ),
        Some(minting) => session(minting, &file, &headers, &id).await,
    };
    metrics().session.record(started.elapsed());
    response
}

async fn session(m: &Minting, file: &str, headers: &HeaderMap, id: &str) -> Response {
    if !m.tool.enabled {
        return answer(
            StatusCode::NOT_FOUND,
            json!({"error": TOOL_UNAVAILABLE, "code": "design_unavailable"}),
            id,
            &[],
        );
    }
    let sign_in = || {
        answer(
            StatusCode::UNAUTHORIZED,
            json!({"error": SIGN_IN_REQUIRED, "code": "unauthorized"}),
            id,
            &[],
        )
    };
    let Some(token) = session_token(headers, &m.cookie) else {
        return sign_in();
    };
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let now_ms = epoch_ms();
    let mut conn = m.pool.get().await;
    // A session's account never changes (sessions.user_id), so a token seen before names its account without a read. Its
    // validity is still the statement's to check (no row: read below), and any other refusal reads it first, so api's
    // order holds: 401 before 409 / 429 / 404, and a 401 is never counted. Only with every account allowed: the rollout
    // list may name e-mails, which change.
    let cached = if m.tool.accounts.is_none() {
        m.accounts.lock().get(&hash).cloned()
    } else {
        None
    };
    let verified = cached.is_none();
    // flag.ts `designToolAvailable` (every account on the cached path, by its condition).
    let mut available = true;
    let user_id = match cached {
        Some(user_id) => user_id,
        None => {
            let user = match conn.query(USER, &[&hash, &now_ms]).await {
                Ok(rows) => rows.into_iter().next(),
                Err(error) => return server_error(&error, id),
            };
            let Some(user) = user else { return sign_in() };
            let user_id: String = user.get("id");
            let email: Option<String> = user.get("email");
            available = m.tool.available(&user_id, email.as_deref());
            let mut accounts = m.accounts.lock();
            if accounts.len() > 100_000 {
                accounts.clear();
            }
            accounts.insert(hash.clone(), user_id.clone());
            user_id
        }
    };
    let response = checked(
        m, &mut conn, file, &user_id, available, &hash, now_ms, headers, id,
    )
    .await;
    if verified || response.status() == StatusCode::OK {
        return response;
    }
    match conn.query(USER, &[&hash, &now_ms]).await {
        Ok(rows) if rows.is_empty() => {
            if response.headers().contains_key("ratelimit-limit") {
                m.limiter.undo(&user_id);
            }
            sign_in()
        }
        Ok(_) => response,
        Err(error) => server_error(&error, id),
    }
}

/// What follows api's session check: the account header, the rollout, the rate limit, then `openCollabSession`.
#[allow(clippy::too_many_arguments)]
async fn checked(
    m: &Minting,
    conn: &mut Conn,
    file: &str,
    user_id: &str,
    available: bool,
    hash: &str,
    now_ms: i64,
    headers: &HeaderMap,
    id: &str,
) -> Response {
    if let Some(named) = headers
        .get("x-forma-account")
        .and_then(|v| v.to_str().ok())
        .filter(|v| !v.is_empty())
        && named != user_id
    {
        return answer(
            StatusCode::CONFLICT,
            json!({"error": ACCOUNT_CHANGED, "code": "account_changed"}),
            id,
            &[],
        );
    }
    if !available {
        return answer(
            StatusCode::NOT_FOUND,
            json!({"error": TOOL_UNAVAILABLE, "code": "design_unavailable"}),
            id,
            &[],
        );
    }
    // RateLimit-* (express-rate-limit's draft-6 headers, `standardHeaders: true`) on every answer from here on.
    let now = Instant::now();
    let (hits, reset) = m.limiter.hit(user_id, now);
    let reset_seconds = reset
        .saturating_duration_since(now)
        .as_millis()
        .div_ceil(1000);
    let limits = [
        (
            "ratelimit-policy",
            format!("{OPENS_PER_WINDOW};w={}", OPENS_WINDOW.as_secs()),
        ),
        ("ratelimit-limit", OPENS_PER_WINDOW.to_string()),
        (
            "ratelimit-remaining",
            OPENS_PER_WINDOW.saturating_sub(hits).to_string(),
        ),
        ("ratelimit-reset", reset_seconds.to_string()),
    ];
    if hits > OPENS_PER_WINDOW {
        let mut extra = limits.to_vec();
        extra.push(("retry-after", reset_seconds.to_string()));
        return answer(
            StatusCode::TOO_MANY_REQUESTS,
            json!({"error": RATE_LIMITED, "code": "rate_limited", "requestId": id}),
            id,
            &extra,
        );
    }
    let mut response = mint_session(m, conn, file, user_id, hash, now_ms, headers, id).await;
    for (name, value) in limits {
        if let Ok(value) = HeaderValue::from_str(&value) {
            response.headers_mut().insert(name, value);
        }
    }
    response
}

/// session.ts `openCollabSession` after the route's checks.
#[allow(clippy::too_many_arguments)]
async fn mint_session(
    m: &Minting,
    conn: &mut Conn,
    file: &str,
    user_id: &str,
    hash: &str,
    now_ms: i64,
    headers: &HeaderMap,
    id: &str,
) -> Response {
    // Without a node nothing runs on collab (switch.ts): the file is on the legacy path.
    if m.nodes.is_empty() {
        return design_error(
            StatusCode::CONFLICT,
            "collab_inactive",
            INACTIVE,
            json!({"mode": "legacy"}),
            id,
        );
    }
    let target = {
        let unhealthy = m.health.unhealthy.lock().clone();
        match node_for(&m.nodes, &unhealthy, file) {
            Some(node) => node.clone(),
            None => return unavailable(id),
        }
    };
    let file_id_ok = file.len() == 36
        && file
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase() || b == b'-');
    if !file_id_ok {
        return design_error(
            StatusCode::NOT_FOUND,
            "not_found",
            NOT_FOUND,
            Value::Null,
            id,
        );
    }
    let ids: Vec<&str> = m.switch.overrides.iter().map(|(i, _)| i.as_str()).collect();
    let modes: Vec<&str> = m
        .switch
        .overrides
        .iter()
        .map(|(_, mode)| mode.as_str())
        .collect();
    let rows = conn
        .query(
            SESSION,
            &[
                &file,
                &user_id,
                &hash,
                &now_ms,
                &ids,
                &modes,
                &m.switch.global,
                &target.name,
                &LEASE_TTL_MS,
            ],
        )
        .await;
    let row = match rows {
        Ok(rows) => match rows.into_iter().next() {
            Some(row) => row,
            None => {
                return design_error(
                    StatusCode::NOT_FOUND,
                    "not_found",
                    NOT_FOUND,
                    Value::Null,
                    id,
                );
            }
        },
        Err(error) => return server_error(&error, id),
    };
    let file_id: String = row.get("id");
    let team: Option<String> = row.get("team_id");
    let trashed: bool = row.get("trashed");
    let role_text: Option<String> = row.get("role");
    let name = display_name(row.get::<_, Option<&str>>("name"));
    let mode: Option<String> = row.get("mode");
    if mode.as_deref() != Some("rust") {
        return design_error(
            StatusCode::CONFLICT,
            "collab_inactive",
            INACTIVE,
            json!({"mode": mode}),
            id,
        );
    }
    let taken_node: Option<String> = row.get("taken_node");
    let collab_node: Option<String> = row.get("collab_node");
    let live: bool = row.get("live");
    // Taken by this statement, or a live holder found; else (taken or released by another statement meanwhile) read again.
    let lease = if let Some(node) = taken_node {
        Some((
            node,
            true,
            row.get::<_, Option<i64>>("taken_version").unwrap_or(0),
        ))
    } else if let (Some(node), true) = (collab_node, live) {
        Some((node, false, row.get::<_, i64>("version")))
    } else {
        let mut found = None;
        for _ in 0..3 {
            let rows = match conn
                .query(TAKE_OR_FIND, &[&file_id, &target.name, &LEASE_TTL_MS])
                .await
            {
                Ok(rows) => rows,
                Err(error) => return server_error(&error, id),
            };
            let Some(row) = rows.into_iter().next() else {
                break;
            };
            let holder: Option<String> = row.get("collab_node");
            let taken: bool = row.get("taken");
            let live: bool = row.get("live");
            if !taken && (holder.is_none() || !live) {
                continue;
            }
            found = holder.map(|node| (node, taken, row.get::<_, i64>("version")));
            break;
        }
        found
    };
    let Some((holder, taken, version)) = lease else {
        return unavailable(id);
    };
    let Some(holder) = m.nodes.iter().find(|n| n.name == holder) else {
        return unavailable(id);
    };
    if taken && let Some((api, secret)) = &m.api {
        let url = format!("{api}/internal/design-files/{file_id}/collab-taken");
        let secret = secret.clone();
        tokio::spawn(async move {
            if let Err(error) = crate::http::get(&url, &secret, Duration::from_secs(5)).await {
                tracing::warn!(%error, "collab-taken: api not told");
            }
        });
    }
    let Some(role) = role_text.as_deref().and_then(Role::parse) else {
        tracing::error!(?role_text, "session: unknown role");
        return answer(
            StatusCode::INTERNAL_SERVER_ERROR,
            json!({"requestId": id, "error": SERVER_ERROR}),
            id,
            &[],
        );
    };
    let role = if !trashed || !role.can_edit() {
        role
    } else {
        Role::Viewer
    };
    let origin = m.origin.clone().or_else(|| {
        headers
            .get(header::ORIGIN)
            .and_then(|v| v.to_str().ok())
            .filter(|v| !v.is_empty())
            .map(str::to_owned)
    });
    let exp = (now_ms / 1000) as u64 + TICKET_TTL_SECONDS;
    let claims = Claims {
        file: file_id.clone(),
        user: user_id.to_owned(),
        name,
        role,
        team,
        origin,
        exp,
    };
    let ticket = mint(&m.key, &claims);
    metrics().tickets_total.inc();
    answer(
        StatusCode::OK,
        json!({
            "wsUrl": format!("{}/collab/{file_id}", holder.public),
            "ticket": ticket,
            "version": version,
            "node": holder.name,
            "expiresAt": exp * 1000,
        }),
        id,
        &[],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nodes_parse_as_config_ts() {
        let nodes = parse_nodes(
            " a=http://10.0.0.5:3410/|wss://a.example/ , bad , b=http://10.0.0.6:3410, a=http://x:1, c=ftp://x ",
        );
        assert_eq!(
            nodes,
            vec![
                Node {
                    name: "a".into(),
                    internal: "http://10.0.0.5:3410".into(),
                    public: "wss://a.example".into()
                },
                Node {
                    name: "b".into(),
                    internal: "http://10.0.0.6:3410".into(),
                    public: "http://10.0.0.6:3410".into()
                },
            ]
        );
    }

    #[test]
    fn rendezvous_matches_nodes_ts() {
        // Values from server/design/collab/nodes.ts for these inputs (sha256 of `file\nname`, first 8 bytes, largest).
        let nodes = parse_nodes("a=http://h:1,b=http://h:2,c=http://h:3");
        let mut seen = HashSet::new();
        for i in 0..200 {
            let file = format!("00000000-0000-0000-0000-{i:012}");
            let picked = node_for(&nodes, &HashSet::new(), &file).expect("a node");
            let best = nodes
                .iter()
                .max_by_key(|n| {
                    let d = Sha256::digest(format!("{file}\n{}", n.name).as_bytes());
                    u64::from_be_bytes(d[..8].try_into().unwrap())
                })
                .unwrap();
            assert_eq!(picked.name, best.name);
            seen.insert(picked.name.clone());
        }
        assert_eq!(seen.len(), 3, "every node gets files");
        let down: HashSet<String> = ["a".to_owned(), "b".to_owned()].into();
        assert_eq!(node_for(&nodes, &down, "f").unwrap().name, "c");
        let all: HashSet<String> = ["a", "b", "c"].iter().map(|s| s.to_string()).collect();
        assert!(
            node_for(&nodes, &all, "f").is_some(),
            "none healthy: all of them"
        );
    }

    #[test]
    fn switch_parses_as_switch_ts() {
        let switch = Switch::parse(" rust ", "t1=shadow, a=b=rust ,bad, x=nope, t1=legacy");
        assert_eq!(switch.global, "rust");
        assert_eq!(
            switch.overrides,
            vec![
                ("t1".to_owned(), "legacy".to_owned()),
                ("a=b".to_owned(), "rust".to_owned())
            ]
        );
        assert_eq!(Switch::parse("other", "").global, "legacy");
    }

    #[test]
    fn tool_switch_as_flag_ts() {
        let tool = ToolSwitch::parse("1", " u1 , Ann@Example.org ");
        assert!(tool.enabled);
        assert!(tool.available("u1", None));
        assert!(tool.available("u2", Some("ann@EXAMPLE.org")));
        assert!(!tool.available("u2", Some("bob@example.org")));
        assert!(ToolSwitch::parse("1", "").available("anyone", None));
        assert!(!ToolSwitch::parse("true", "").enabled);
    }

    #[test]
    fn names_trim_as_js() {
        assert_eq!(display_name(None), "Member");
        assert_eq!(display_name(Some(" \u{FEFF}\u{A0} ")), "Member");
        assert_eq!(
            display_name(Some("\u{85}x")),
            "\u{85}x",
            "NEL is not JS white space"
        );
        assert_eq!(display_name(Some("  Аня ")), "Аня");
        let long: String = "😀".repeat(100);
        assert_eq!(display_name(Some(&long)).chars().count(), 80);
    }

    #[test]
    fn cookies_as_cookie_parser() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("a=1; forma_session=\"ab%20cd\"; forma_session=second"),
        );
        assert_eq!(
            session_token(&headers, "forma_session").as_deref(),
            Some("ab cd")
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("forma_session=%E0%A4%A"),
        );
        assert_eq!(
            session_token(&headers, "forma_session").as_deref(),
            Some("%E0%A4%A")
        );
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("forma_session=j:{\"x\":1}"),
        );
        assert_eq!(session_token(&headers, "forma_session"), None);
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("forma_session=j:\"tok\""),
        );
        assert_eq!(
            session_token(&headers, "forma_session").as_deref(),
            Some("tok")
        );
        assert_eq!(session_token(&headers, "__Host-forma_session"), None);
    }

    #[test]
    fn limiter_counts_a_window_from_its_first_hit() {
        let limiter = Limiter::default();
        let start = Instant::now();
        for n in 1..=61 {
            assert_eq!(limiter.hit("u", start).0, n);
        }
        assert_eq!(limiter.hit("v", start).0, 1);
        assert_eq!(limiter.hit("u", start + OPENS_WINDOW).0, 1, "a new window");
    }
}
