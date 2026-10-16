//! The service's HTTP face (axum): `POST /internal/render` (api → service, `Authorization: Bearer <secret>`),
//! `GET /healthz`, `GET /metrics`. Answers are the output's bytes with `X-Render-*` headers, or
//! `{"code", "error"}` with the status of the api's vocabulary (shared/design/api.ts): 400 invalid_request,
//! 403 forbidden, 413 design_pdf_too_large, 422 render_unsupported (the api falls back to Chromium), 429
//! design_pdf_busy / rate_limited, 501 render_raster_unavailable, 504 design_pdf_timeout.

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Bytes;
use axum::extract::{DefaultBodyLimit, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use serde_json::json;

use crate::jobs::{Queue, busy, timeout};
use crate::limits::{Accounts, Limits};
use crate::metrics::Metrics;
use crate::request::{self, Refusal};

pub struct Service {
    pub limits: Arc<Limits>,
    pub queue: Queue,
    pub accounts: Arc<Accounts>,
    pub metrics: Arc<Metrics>,
    /// The bearer secret of /internal/render; unset: every job is refused (403).
    pub secret: Option<String>,
    /// Raster jobs have a renderer (lane L4's).
    pub raster: bool,
}

pub type App = Arc<Service>;

pub fn router(app: App) -> Router {
    let body = app.limits.body_bytes;
    Router::new()
        .route("/internal/render", post(render))
        .route("/healthz", get(healthz))
        .route("/metrics", get(metrics))
        .layer(DefaultBodyLimit::max(body))
        .with_state(app)
}

fn authorized(app: &Service, headers: &HeaderMap) -> bool {
    let Some(secret) = app.secret.as_deref() else {
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

fn refuse(refusal: Refusal) -> Response {
    let status = StatusCode::from_u16(refusal.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (
        status,
        axum::Json(json!({"code": refusal.code, "error": refusal.message})),
    )
        .into_response()
}

async fn render(State(app): State<App>, headers: HeaderMap, body: Bytes) -> Response {
    if !authorized(&app, &headers) {
        return refuse(Refusal::new(403, "forbidden", "forbidden"));
    }
    let arrived = Instant::now();
    let request = match request::parse(&body, &app.limits) {
        Ok(r) => r,
        Err(refusal) => {
            app.metrics
                .refused_limits
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return refuse(refusal);
        }
    };
    drop(body);
    let slot = match app
        .accounts
        .admit(&request.header.account, &app.limits, arrived)
    {
        Ok(slot) => slot,
        Err(refusal) => {
            app.metrics
                .refused_busy
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return refuse(refusal);
        }
    };
    let allowed = request
        .header
        .timeout_ms
        .map(Duration::from_millis)
        .unwrap_or(app.limits.timeout)
        .min(app.limits.timeout);
    let deadline = arrived + allowed;
    let receive = match app.queue.submit(request, deadline, &app.metrics) {
        Ok(r) => r,
        Err(_) => {
            app.metrics
                .refused_busy
                .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return refuse(busy());
        }
    };
    // A job past its deadline stops at its next page or raster; the answer does not wait for that.
    let waited =
        tokio::time::timeout_at((deadline + Duration::from_millis(250)).into(), receive).await;
    drop(slot);
    let output = match waited {
        Err(_) => return refuse(timeout()),
        Ok(Err(_)) => return refuse(Refusal::new(500, "render_failed", "the worker stopped")),
        Ok(Ok(Err(refusal))) => return refuse(refusal),
        Ok(Ok(Ok(output))) => output,
    };
    let mut response = (StatusCode::OK, output.body).into_response();
    let h = response.headers_mut();
    h.insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(output.content_type),
    );
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    let mut set = |name: &'static str, value: String| {
        if let Ok(v) = HeaderValue::from_str(&value) {
            h.insert(name, v);
        }
    };
    set("x-render-pages", output.pages.to_string());
    set("x-render-unmeasured", output.unmeasured.to_string());
    set("x-render-rasters", output.rasters.to_string());
    set("x-render-raster-pixels", output.raster_pixels.to_string());
    set("x-render-ms", format!("{:.1}", output.millis));
    set(
        "x-render-missing-fonts",
        serde_json::to_string(&output.missing_fonts).unwrap_or_default(),
    );
    if let Some(b) = output.bounds {
        set(
            "x-render-bounds",
            format!("{},{},{},{}", b[0], b[1], b[2], b[3]),
        );
    }
    response
}

async fn healthz(State(app): State<App>) -> Response {
    axum::Json(json!({
        "ok": true,
        "service": "morfa-render",
        "version": env!("CARGO_PKG_VERSION"),
        "workers": app.queue.workers,
        "running": app.queue.running(),
        "raster": app.raster,
    }))
    .into_response()
}

async fn metrics(State(app): State<App>) -> Response {
    (
        [(header::CONTENT_TYPE, "text/plain; version=0.0.4")],
        app.metrics.render(app.queue.running(), app.queue.workers),
    )
        .into_response()
}
