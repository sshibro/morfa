//! Raster jobs through the service with lane L4's renderer (`vello::Vello`, crates/render on vello_cpu): PNG, JPEG,
//! WebP and thumbnails of the `social` starter template's frames (tests/fixtures/social.json), the size cap and the
//! refusals, and text drawn with real glyphs when the job names the catalogue faces (public/fonts, `npm run fonts`).

use axum::body::Body;
use axum::http::{Request, StatusCode};
use http_body_util::BodyExt;
use morfa_render_service::request::encode;
use morfa_render_service::{Config, http::router, service};
use serde_json::{Value, json};
use std::path::PathBuf;
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

fn fonts_dir() -> Option<PathBuf> {
    let dir = PathBuf::from(concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/fonts"));
    dir.join("manrope/manrope-cyrillic-wght-normal.woff2")
        .exists()
        .then_some(dir)
}

fn app(fonts: Option<PathBuf>) -> axum::Router {
    router(service(Config {
        secret: Some(SECRET.into()),
        fonts_dir: fonts,
        workers: 1,
        ..Config::default()
    }))
}

fn post(body: Vec<u8>) -> Request<Body> {
    Request::post("/internal/render")
        .header("authorization", format!("Bearer {SECRET}"))
        .body(Body::from(body))
        .unwrap()
}

async fn send(app: &axum::Router, body: Vec<u8>) -> (StatusCode, axum::http::HeaderMap, Vec<u8>) {
    let res = app.clone().oneshot(post(body)).await.unwrap();
    let status = res.status();
    let headers = res.headers().clone();
    let out = res.into_body().collect().await.unwrap().to_bytes().to_vec();
    (status, headers, out)
}

fn header<'h>(headers: &'h axum::http::HeaderMap, name: &str) -> &'h str {
    headers.get(name).map(|v| v.to_str().unwrap()).unwrap_or("")
}

/// A PNG's size and the share of its pixels that are not fully transparent.
fn png_info(bytes: &[u8]) -> (u32, u32, f64, Vec<u8>) {
    let decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    let mut reader = decoder.read_info().unwrap();
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).unwrap();
    assert_eq!(info.color_type, png::ColorType::Rgba);
    let data = &buf[..info.buffer_size()];
    let opaque = data
        .as_chunks::<4>()
        .0
        .iter()
        .filter(|px| px[3] > 0)
        .count();
    (
        info.width,
        info.height,
        opaque as f64 / (info.width as f64 * info.height as f64),
        data.to_vec(),
    )
}

#[tokio::test]
async fn png_at_scale_jpeg_webp_and_thumbnail() {
    let app = app(None);
    let (doc, frames) = social();
    // The first frame (1080 × 1080) at scale 2.
    let body = encode(
        &json!({"kind": "png", "account": "r", "ids": [frames[0]], "scale": 2}),
        &doc,
        &[],
    );
    let (status, headers, out) = send(&app, body).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
    assert_eq!(header(&headers, "content-type"), "image/png");
    assert_eq!(header(&headers, "x-render-rasters"), "1");
    let (w, h, filled, _) = png_info(&out);
    // The frame's own box at scale 2, plus whatever its effects reach.
    assert!(
        (2160..2400).contains(&w) && (2160..2400).contains(&h),
        "{w}×{h}"
    );
    assert_eq!(
        header(&headers, "x-render-raster-pixels"),
        (w as u64 * h as u64).to_string()
    );
    assert!(
        filled > 0.5,
        "the frame paints most of its box ({filled:.2})"
    );

    // JPEG: opaque (white behind), 4:4:4, the header's quality.
    let body = encode(
        &json!({"kind": "jpeg", "account": "r", "ids": [frames[0]], "scale": 0.5, "quality": 80}),
        &doc,
        &[],
    );
    let (status, headers, out) = send(&app, body).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
    assert_eq!(header(&headers, "content-type"), "image/jpeg");
    assert_eq!(&out[..2], &[0xFF, 0xD8]);

    // WebP (lossless).
    let body = encode(
        &json!({"kind": "webp", "account": "r", "ids": [frames[0]], "scale": 0.25}),
        &doc,
        &[],
    );
    let (status, headers, out) = send(&app, body).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
    assert_eq!(header(&headers, "content-type"), "image/webp");
    assert_eq!(&out[..4], b"RIFF");
    assert_eq!(&out[8..12], b"WEBP");

    // A thumbnail of every frame together: the longest side 512.
    let body = encode(
        &json!({"kind": "thumbnail", "account": "r", "ids": frames}),
        &doc,
        &[],
    );
    let (status, headers, out) = send(&app, body).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
    assert_eq!(header(&headers, "content-type"), "image/png");
    let (w, h, filled, _) = png_info(&out);
    assert_eq!(w.max(h), 512, "{w}×{h}");
    assert!(filled > 0.1, "{filled:.2}");

    // A whole page.
    let doc_value: Value = serde_json::from_str(&doc).unwrap();
    let page = doc_value["pages"][0].as_str().unwrap();
    let body = encode(
        &json!({"kind": "png", "account": "r", "ids": [page], "scale": 0.1}),
        &doc,
        &[],
    );
    let (status, _, out) = send(&app, body).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&out));
    let (w, h, _, _) = png_info(&out);
    assert!(w > 100 && h > 50, "{w}×{h}");
}

#[tokio::test]
async fn refusals() {
    let app = app(None);
    let (doc, frames) = social();
    let code = |out: &[u8]| -> String {
        serde_json::from_slice::<Value>(out)
            .ok()
            .and_then(|v| v["code"].as_str().map(str::to_owned))
            .unwrap_or_default()
    };
    // Over the 96 MP cap: refused before any pixel is drawn.
    let body = encode(
        &json!({"kind": "png", "account": "r", "ids": [frames[0]], "scale": 12}),
        &doc,
        &[],
    );
    let (status, _, out) = send(&app, body).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::PAYLOAD_TOO_LARGE, "design_pdf_too_large")
    );
    // An unknown layer.
    let body = encode(
        &json!({"kind": "png", "account": "r", "ids": ["nowhere"]}),
        &doc,
        &[],
    );
    let (status, _, out) = send(&app, body).await;
    assert_eq!(
        (status, code(&out).as_str()),
        (StatusCode::BAD_REQUEST, "invalid_request")
    );
}

#[tokio::test]
async fn text_gets_glyphs_from_the_named_faces() {
    let Some(dir) = fonts_dir() else {
        eprintln!("skipped: public/fonts is empty (npm run fonts)");
        return;
    };
    let (doc, frames) = social();
    // The third frame (1280 × 720): four texts in Manrope and Playfair Display.
    let frame = &frames[2];
    let without = app(None);
    let body = encode(
        &json!({"kind": "png", "account": "r", "ids": [frame], "scale": 1}),
        &doc,
        &[],
    );
    let (status, _, plain) = send(&without, body).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&plain)
    );

    let with = app(Some(dir));
    let faces = json!([
        {"family": "Manrope", "weight": [200, 800], "file": "manrope/manrope-cyrillic-wght-normal.woff2", "unicodeRange": "U+0400-045F"},
        {"family": "Manrope", "weight": [200, 800], "file": "manrope/manrope-latin-wght-normal.woff2"},
        {"family": "Playfair Display", "weight": [400, 900], "file": "playfair-display/playfair-display-cyrillic-wght-normal.woff2", "unicodeRange": "U+0400-045F"},
        {"family": "Playfair Display", "weight": [400, 900], "file": "playfair-display/playfair-display-latin-wght-normal.woff2"}
    ]);
    let body = encode(
        &json!({"kind": "png", "account": "r", "ids": [frame], "scale": 1, "fonts": faces, "measure": "fonts"}),
        &doc,
        &[],
    );
    let (status, _, lettered) = send(&with, body).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "{}",
        String::from_utf8_lossy(&lettered)
    );
    // MORFA_RASTER_DUMP=<dir> keeps both pictures for a look.
    if let Ok(dir) = std::env::var("MORFA_RASTER_DUMP") {
        std::fs::write(format!("{dir}/social-frame3-plain.png"), &plain).unwrap();
        std::fs::write(format!("{dir}/social-frame3-glyphs.png"), &lettered).unwrap();
    }
    let (w1, h1, _, a) = png_info(&plain);
    let (w2, h2, _, b) = png_info(&lettered);
    assert_eq!((w1, h1), (w2, h2));
    let changed = a
        .as_chunks::<4>()
        .0
        .iter()
        .zip(b.as_chunks::<4>().0)
        .filter(|(x, y)| x != y)
        .count();
    // Four texts of a 1280 × 720 frame: thousands of pixels become glyphs.
    assert!(changed > 2_000, "{changed} pixels changed by the glyphs");
}
