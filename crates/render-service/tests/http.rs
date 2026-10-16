//! The service over HTTP (router in process): the secret, health and metrics, SVG and PDF jobs on the `social`
//! starter template (tests/fixtures/social.json, written by shared/design/templates.ts with the tests' fixed-width
//! measurer), and the refusals of the brief: 413 design_pdf_too_large, 429 design_pdf_busy, 504 design_pdf_timeout,
//! 422 render_unsupported, 501 render_raster_unavailable (a build without the renderer).

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use morfa_model::DesignDocument;
use morfa_render_service::jobs::Ctx;
use morfa_render_service::raster::{Pixels, RasterAsk, Rasterizer};
use morfa_render_service::request::Refusal;
use morfa_render_service::request::encode;
use morfa_render_service::{Config, http::router, service, service_with};
use serde_json::{Value, json};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tower::ServiceExt;

const SECRET: &str = "test-secret-0123456789";

fn social() -> (String, Vec<String>) {
    let json = std::fs::read_to_string(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/tests/fixtures/social.json"
    ))
    .unwrap();
    let doc: Value = serde_json::from_str(&json).unwrap();
    let page = doc["pages"][0].as_str().unwrap();
    let frames = doc["nodes"][page]["children"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    (json, frames)
}

fn app(config: Config) -> axum::Router {
    router(service(Config {
        secret: Some(SECRET.into()),
        ..config
    }))
}

fn post(body: Vec<u8>, secret: Option<&str>) -> Request<Body> {
    let mut b = Request::post("/internal/render");
    if let Some(s) = secret {
        b = b.header("authorization", format!("Bearer {s}"));
    }
    b.body(Body::from(body)).unwrap()
}

async fn send(
    app: &axum::Router,
    req: Request<Body>,
) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let res = app.clone().oneshot(req).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let body = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, body)
}

fn code(body: &[u8]) -> String {
    serde_json::from_slice::<Value>(body).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned()
}

#[tokio::test]
async fn secret_health_metrics() {
    let app = app(Config::default());
    let (doc, frames) = social();
    let body = encode(
        &json!({"kind": "svg", "account": "a", "ids": frames}),
        &doc,
        &[],
    );
    let (status, _, out) = send(&app, post(body.clone(), None)).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::FORBIDDEN, "forbidden")
    );
    let (status, _, _) = send(&app, post(body, Some("test-secret-0123456780"))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _, out) = send(&app, Request::get("/healthz").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    let health: Value = serde_json::from_slice(&out).unwrap();
    assert_eq!(health["service"], "morfa-render");
    assert_eq!(health["raster"], true);
    let (status, _, out) = send(&app, Request::get("/metrics").body(Body::empty()).unwrap()).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        String::from_utf8(out)
            .unwrap()
            .contains("morfa_render_jobs_total{kind=\"pdf\",outcome=\"ok\"} 0")
    );
}

#[tokio::test]
async fn svg_and_pdf() {
    let app = app(Config::default());
    let (doc, frames) = social();
    let body = encode(
        &json!({"kind": "svg", "account": "a", "ids": frames, "measure": "fixed"}),
        &doc,
        &[],
    );
    let (status, headers, out) = send(&app, post(body, Some(SECRET))).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
    assert!(
        headers["content-type"]
            .to_str()
            .unwrap()
            .starts_with("image/svg+xml")
    );
    let svg = String::from_utf8(out).unwrap();
    assert!(svg.starts_with("<svg") && svg.ends_with("</svg>"));
    assert!(headers.contains_key("x-render-bounds"));

    let pages: Vec<Value> = frames.iter().map(|id| json!({"ids": [id]})).collect();
    let body = encode(
        &json!({"kind": "pdf", "account": "a", "pages": pages, "measure": "fixed", "title": "Соцсети"}),
        &doc,
        &[],
    );
    let (status, headers, out) = send(&app, post(body, Some(SECRET))).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
    assert_eq!(headers["content-type"], "application/pdf");
    assert_eq!(headers["x-render-pages"], frames.len().to_string().as_str());
    assert!(out.starts_with(b"%PDF-1.7") && out.ends_with(b"%%EOF\n"));
    let (_, _, metrics) = send(&app, Request::get("/metrics").body(Body::empty()).unwrap()).await;
    assert!(
        String::from_utf8(metrics)
            .unwrap()
            .contains("morfa_render_jobs_total{kind=\"pdf\",outcome=\"ok\"} 1")
    );
}

#[tokio::test]
async fn refusals() {
    let app = app(Config::default());
    let (doc, frames) = social();
    // 51 pages.
    let pages: Vec<Value> = (0..51).map(|_| json!({"ids": [frames[0]]})).collect();
    let body = encode(
        &json!({"kind": "pdf", "account": "a", "pages": pages}),
        &doc,
        &[],
    );
    let (status, _, out) = send(&app, post(body, Some(SECRET))).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, "design_pdf_too_large")
    );
    // A document the model refuses: the api prints it with Chromium.
    let body = encode(
        &json!({"kind": "svg", "account": "a", "ids": ["x"]}),
        "{\"nodes\": 5}",
        &[],
    );
    let (status, _, out) = send(&app, post(body, Some(SECRET))).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::UNPROCESSABLE_ENTITY, "render_unsupported")
    );
    // A build without lane L4's renderer refuses raster jobs (tests/raster.rs has the renderer's own).
    let unavailable = router(service_with(
        Config {
            secret: Some(SECRET.into()),
            ..Config::default()
        },
        Arc::new(morfa_render_service::raster::Unavailable),
    ));
    let body = encode(
        &json!({"kind": "thumbnail", "account": "a", "ids": frames}),
        &doc,
        &[],
    );
    let (status, _, out) = send(&unavailable, post(body, Some(SECRET))).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::NOT_IMPLEMENTED, "render_raster_unavailable")
    );
    // Malformed.
    let (status, _, out) = send(&app, post(b"MRR1".to_vec(), Some(SECRET))).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::BAD_REQUEST, "invalid_request")
    );
}

#[tokio::test]
async fn timeout_and_busy() {
    // A deadline already gone: 504 at the worker.
    let app = app(Config::default());
    let (doc, frames) = social();
    let pages: Vec<Value> = frames.iter().map(|id| json!({"ids": [id]})).collect();
    let body = encode(
        &json!({"kind": "pdf", "account": "t", "pages": pages, "measure": "fixed", "timeoutMs": 0}),
        &doc,
        &[],
    );
    let (status, _, out) = send(&app, post(body, Some(SECRET))).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::GATEWAY_TIMEOUT, "design_pdf_timeout")
    );

    // One worker and one place in the queue: a job running, one waiting, the third (another account) refused.
    let (release, gate) = std::sync::mpsc::channel::<()>();
    let (entered, started) = std::sync::mpsc::channel::<()>();
    let mut config = Config {
        workers: 1,
        secret: Some(SECRET.into()),
        ..Config::default()
    };
    config.limits.queue = 1;
    let app = router(service_with(
        config,
        Arc::new(Blocking {
            gate: Mutex::new(gate),
            entered: Mutex::new(entered),
        }),
    ));
    let held = encode(
        &json!({"kind": "png", "account": "a", "ids": frames, "measure": "fixed"}),
        &doc,
        &[],
    );
    let first = tokio::spawn({
        let app = app.clone();
        async move { send(&app, post(held, Some(SECRET))).await }
    });
    let waited = tokio::task::spawn_blocking(move || started.recv_timeout(Duration::from_secs(30)));
    assert!(
        waited.await.unwrap().is_ok(),
        "the first job never reached the renderer"
    );
    let queued = encode(
        &json!({"kind": "svg", "account": "b", "ids": frames, "measure": "fixed"}),
        &doc,
        &[],
    );
    let second = tokio::spawn({
        let app = app.clone();
        async move { send(&app, post(queued, Some(SECRET))).await }
    });
    // Once /metrics counts it waiting, the queue is full.
    let mut waiting = false;
    for _ in 0..3000 {
        let (_, _, metrics) =
            send(&app, Request::get("/metrics").body(Body::empty()).unwrap()).await;
        if String::from_utf8(metrics)
            .unwrap()
            .contains("morfa_render_queued 1\n")
        {
            waiting = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    assert!(waiting, "the second job never reached the queue");
    let body = encode(
        &json!({"kind": "svg", "account": "c", "ids": frames, "measure": "fixed"}),
        &doc,
        &[],
    );
    let (status, _, out) = send(&app, post(body, Some(SECRET))).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::TOO_MANY_REQUESTS, "design_pdf_busy")
    );
    release.send(()).unwrap();
    let (status, headers, out) = first.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
    assert_eq!(headers["content-type"], "image/png");
    assert!(out.starts_with(b"\x89PNG"));
    let (status, _, out) = second.await.unwrap();
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
}

/// Holds its worker until released (a 2×2 picture then).
struct Blocking {
    gate: Mutex<std::sync::mpsc::Receiver<()>>,
    entered: Mutex<std::sync::mpsc::Sender<()>>,
}

impl Rasterizer for Blocking {
    fn render(&self, _: &DesignDocument, _: &RasterAsk, _: &mut Ctx) -> Result<Pixels, Refusal> {
        self.entered.lock().unwrap().send(()).unwrap();
        self.gate.lock().unwrap().recv().unwrap();
        Ok(Pixels {
            width: 2,
            height: 2,
            rgba: vec![255; 16],
        })
    }
}
