//! `/internal/*` handlers (docs/BACKEND.md §2 "Permissions", §7 "Migration"): api's pushes and the shadow path.
//!
//! **Shadow** (`DESIGN_COLLAB=shadow`): Node stays authoritative; after each accepted `PATCH` it posts the same
//! body here plus `file`, the `version` it stored and the `stored` patch. collab applies the op to its own copy
//! with its own engine and answers the document hash (schema.json `x-documentHash`), which Node compares with
//! its own. An op collab's engine refuses (a merge it cannot do yet) is applied as `stored` and answered with
//! `"fallback": true`, so the copy stays comparable. The first post of a file must carry `document` (the seed,
//! at `version`); until then the answer is 404 `shadow_unseeded`.
//!
//! `appliedOn` (the version Node applied the op on): several api processes forward the same file, each keeping
//! its own idea of where the copy is, and one's seed moves the copy under the other. An op whose `appliedOn` is not
//! the copy's version is not applied: 409 `shadow_stale` with the copy's `version`, and api seeds again.
//!
//! Body: `{"t":"op","seq":0,"baseVersion":N,"patch":{…},"before"?:{…},"beforeTables"?:{…},
//!         "file":"…","version":N+1,"appliedOn"?:N,"stored"?:{…},"document"?:{…},"hash"?:true}`.

use crate::actor::ActorMsg;
use crate::engine::{DocEngine, OpInput, OpsEngine, document_hash};
use crate::router::{App, valid_file_id};
use axum::Json;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use morfa_model::{from_json, patch_from_json};
use morfa_protocol::{ByeReason, ClientMsg, Codec, Copies, JsonCodec, Role, ServerMsg, Version};
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use serde_json::value::RawValue;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::oneshot;

fn authorized(app: &App, headers: &HeaderMap) -> bool {
    let Some(secret) = app.shared.config.internal_secret.as_deref() else {
        return false;
    };
    let Some(given) = headers
        .get(header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    // Constant time in the secret's length.
    given.len() == secret.len()
        && given
            .bytes()
            .zip(secret.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

fn error(status: StatusCode, code: &str) -> Response {
    (status, Json(json!({"code": code}))).into_response()
}

macro_rules! guard {
    ($app:expr, $headers:expr) => {
        if !authorized(&$app, &$headers) {
            return error(StatusCode::FORBIDDEN, "forbidden");
        }
    };
}

#[derive(Deserialize)]
pub struct AclPush {
    file: String,
    user: String,
    role: Option<Role>,
}

pub async fn acl(
    State(app): State<App>,
    headers: HeaderMap,
    Json(push): Json<AclPush>,
) -> Response {
    guard!(app, headers);
    if let Some(actor) = app.docs.get(&push.file) {
        let _ = actor
            .send(ActorMsg::Acl {
                user: push.user,
                role: push.role,
            })
            .await;
        return Json(json!({"open": true})).into_response();
    }
    Json(json!({"open": false})).into_response()
}

#[derive(Deserialize)]
pub struct FilePush {
    file: String,
    name: Option<String>,
    close: Option<ByeReason>,
}

pub async fn file(
    State(app): State<App>,
    headers: HeaderMap,
    Json(push): Json<FilePush>,
) -> Response {
    guard!(app, headers);
    if let Some(actor) = app.docs.get(&push.file) {
        let _ = actor
            .send(ActorMsg::File {
                name: push.name,
                close: push.close,
            })
            .await;
        return Json(json!({"open": true})).into_response();
    }
    Json(json!({"open": false})).into_response()
}

#[derive(Deserialize)]
struct ReplaceBody<'a> {
    file: String,
    user: String,
    /// The version the whole document was made on: refused (409 `version_conflict`) when the actor moved past
    /// it. Absent: replaced whatever the actor is at.
    #[serde(rename = "baseVersion", default)]
    base_version: Option<Version>,
    #[serde(borrow)]
    document: &'a RawValue,
}

/// Why a replace did not land.
#[derive(Debug)]
pub enum ReplaceError {
    /// The actor is at this version, not the one the document was made on.
    Conflict(Version),
    /// The journal did not store it (or the actor stopped first).
    Failed(String),
}

/// `{open, version}` once the new version is committed to the journal; 409 `version_conflict` (with
/// `currentVersion`) when the actor moved past `baseVersion`; 503 when the commit failed.
pub async fn replace(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    guard!(app, headers);
    let Ok(request) = serde_json::from_slice::<ReplaceBody>(&body) else {
        return error(StatusCode::BAD_REQUEST, "bad_message");
    };
    let document = match morfa_model::from_json_validated(request.document.get()) {
        Ok(document) => document,
        Err(invalid) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"code": "design_document_invalid", "path": invalid.path, "message": invalid.message})),
            )
                .into_response();
        }
    };
    let Some(actor) = app.docs.get(&request.file) else {
        return Json(json!({"open": false})).into_response();
    };
    let (reply, answer) = oneshot::channel();
    let sent = actor
        .send(ActorMsg::Replace {
            document: Box::new(document),
            user: request.user,
            base_version: request.base_version,
            reply,
        })
        .await;
    if sent.is_err() {
        // The actor stopped between the lookup and the send: no node holds the file any more.
        return Json(json!({"open": false})).into_response();
    }
    match answer.await {
        Ok(Ok(version)) => Json(json!({"open": true, "version": version})).into_response(),
        Ok(Err(ReplaceError::Conflict(current))) => (
            StatusCode::CONFLICT,
            Json(json!({"code": "version_conflict", "currentVersion": current})),
        )
            .into_response(),
        Ok(Err(ReplaceError::Failed(_))) | Err(_) => {
            error(StatusCode::SERVICE_UNAVAILABLE, "design_unavailable")
        }
    }
}

#[derive(Deserialize)]
pub struct NoticePush {
    file: String,
    kind: String,
    #[serde(default)]
    revision: Option<u64>,
    #[serde(default)]
    user: Option<String>,
}

/// `POST /internal/notice` `{file, kind: "comments"}` | `{file, kind: "meeting", revision, user?}`: a file-class
/// event for the file's sockets, as the SSE stream sends it (`comments {}`, `meeting {revision, user?}`; a
/// meeting notice with `user` reaches only that person's sockets).
pub async fn notice(
    State(app): State<App>,
    headers: HeaderMap,
    Json(push): Json<NoticePush>,
) -> Response {
    guard!(app, headers);
    let (msg, only) = match (push.kind.as_str(), push.revision) {
        ("comments", _) => (ServerMsg::Comments {}, None),
        ("meeting", Some(revision)) => (
            ServerMsg::Meeting {
                revision,
                user: push.user.clone(),
            },
            push.user,
        ),
        _ => return error(StatusCode::BAD_REQUEST, "bad_message"),
    };
    if let Some(actor) = app.docs.get(&push.file)
        && actor
            .send(ActorMsg::Notice {
                msg: Box::new(msg),
                only,
            })
            .await
            .is_ok()
    {
        return Json(json!({"open": true})).into_response();
    }
    Json(json!({"open": false})).into_response()
}

pub async fn doc(State(app): State<App>, headers: HeaderMap, Path(file): Path<String>) -> Response {
    guard!(app, headers);
    let Some(actor) = app.docs.get(&file) else {
        return error(StatusCode::NOT_FOUND, "not_open");
    };
    let (reply, answer) = oneshot::channel();
    if actor.send(ActorMsg::Inspect { reply }).await.is_err() {
        return error(StatusCode::NOT_FOUND, "not_open");
    }
    let Ok(inspect) = answer.await else {
        return error(StatusCode::NOT_FOUND, "not_open");
    };
    let document = inspect.document;
    let hash = tokio::task::spawn_blocking(move || document_hash(&document))
        .await
        .unwrap_or_default();
    Json(json!({
        "version": inspect.version,
        "committed": inspect.committed,
        "hash": hash,
        "nodes": inspect.stats.nodes,
        "conns": inspect.conns,
        "tail": inspect.tail,
    }))
    .into_response()
}

/// The shadow copies, one engine per file.
#[derive(Default)]
pub struct Shadow {
    files: Mutex<HashMap<String, Arc<Mutex<OpsEngine>>>>,
}

#[derive(Deserialize)]
struct ShadowExtra<'a> {
    file: String,
    version: Version,
    #[serde(rename = "appliedOn", default)]
    applied_on: Option<Version>,
    #[serde(borrow, default)]
    stored: Option<&'a RawValue>,
    #[serde(borrow, default)]
    document: Option<&'a RawValue>,
    #[serde(default = "yes")]
    hash: bool,
}

fn yes() -> bool {
    true
}

/// Applies one shadow op; the answer's JSON and status.
pub fn shadow_apply(shadow: &Shadow, body: &[u8]) -> (StatusCode, serde_json::Value) {
    let Ok(extra) = serde_json::from_slice::<ShadowExtra>(body) else {
        return (StatusCode::BAD_REQUEST, json!({"code": "bad_message"}));
    };
    if !valid_file_id(&extra.file) {
        return (StatusCode::BAD_REQUEST, json!({"code": "bad_message"}));
    }
    let mut op = match JsonCodec.decode_client(body) {
        Ok(ClientMsg::Op(op)) => op,
        Ok(_) => return (StatusCode::BAD_REQUEST, json!({"code": "bad_message"})),
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                json!({"code": e.code, "path": e.path, "message": e.message}),
            );
        }
    };
    // The Node path reads `before` whatever the op's version: so does the comparison.
    if let Some(copies) = &mut op.before
        && let Err(e) = copies.read(op.seq)
    {
        return (
            StatusCode::BAD_REQUEST,
            json!({"code": e.code, "path": e.path, "message": e.message}),
        );
    }
    let engine = {
        let mut files = shadow.files.lock();
        if let Some(raw) = extra.document {
            let document = match from_json(raw.get()) {
                Ok(document) => document,
                Err(e) => {
                    return (
                        StatusCode::BAD_REQUEST,
                        json!({"code": "design_document_invalid", "path": e.path, "message": e.message}),
                    );
                }
            };
            // The seed is the document the op was made on.
            let engine = Arc::new(Mutex::new(OpsEngine::new(document, op.base_version)));
            files.insert(extra.file.clone(), Arc::clone(&engine));
            engine
        } else {
            match files.get(&extra.file) {
                Some(engine) => Arc::clone(engine),
                None => return (StatusCode::NOT_FOUND, json!({"code": "shadow_unseeded"})),
            }
        }
    };
    let mut engine = engine.lock();
    if extra.document.is_none()
        && let Some(applied_on) = extra.applied_on
        && applied_on != engine.version()
    {
        return (
            StatusCode::CONFLICT,
            json!({"code": "shadow_stale", "version": engine.version()}),
        );
    }
    let input = OpInput {
        base_version: op.base_version,
        patch: &op.patch,
        before: op.before.as_ref().and_then(Copies::as_read),
        before_tables: op.before_tables.as_ref(),
    };
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| engine.apply(&input)));
    let mut fallback = false;
    let mut refusal = serde_json::Value::Null;
    match result {
        Ok(Ok(_)) => {}
        Ok(Err(refused)) => {
            refusal =
                json!({"code": refused.code, "path": refused.path, "message": refused.message});
            fallback = true;
        }
        Err(_) => {
            refusal = json!({"code": "panic"});
            fallback = true;
        }
    }
    if fallback {
        // Keep the copy comparable: write what Node stored.
        let stored = match extra.stored.map(|raw| patch_from_json(raw.get())) {
            Some(Ok(stored)) => stored,
            _ => {
                return (
                    StatusCode::CONFLICT,
                    json!({"code": "shadow_diverged", "refused": refusal}),
                );
            }
        };
        engine.apply_stored(&stored, extra.version);
    }
    // Node's version is the order; follow it (a skipped Node version is a change made through api).
    engine.set_version(extra.version);
    let hash = extra.hash.then(|| document_hash(engine.doc()));
    (
        StatusCode::OK,
        json!({"version": engine.version(), "hash": hash, "applied": !fallback, "fallback": fallback, "refused": refusal}),
    )
}

/// `GET /internal/shadow-doc/:file`: the shadow copy itself, `{version, document}` (a mismatch then names the
/// exact path where the copies differ). 404 `shadow_unseeded` for a file without a copy.
pub async fn shadow_doc(
    State(app): State<App>,
    headers: HeaderMap,
    Path(file): Path<String>,
) -> Response {
    guard!(app, headers);
    let Some(engine) = app.shadow.files.lock().get(&file).map(Arc::clone) else {
        return error(StatusCode::NOT_FOUND, "shadow_unseeded");
    };
    let text = tokio::task::spawn_blocking(move || {
        let engine = engine.lock();
        format!(
            "{{\"version\":{},\"document\":{}}}",
            engine.version(),
            morfa_model::to_json(engine.doc())
        )
    })
    .await;
    match text {
        Ok(text) => ([(header::CONTENT_TYPE, "application/json")], text).into_response(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "panic"),
    }
}

pub async fn shadow_op(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    guard!(app, headers);
    let shadow = Arc::clone(&app.shadow);
    match tokio::task::spawn_blocking(move || shadow_apply(&shadow, &body)).await {
        Ok((status, answer)) => (status, Json(answer)).into_response(),
        Err(_) => error(StatusCode::INTERNAL_SERVER_ERROR, "panic"),
    }
}
