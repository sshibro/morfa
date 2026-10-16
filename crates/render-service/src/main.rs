//! `morfa-render`: the render/export service (lane B4, docs/BACKEND.md §4).
//!
//!   morfa-render                       serve (environment below)
//!   morfa-render job <request> [out]   run one request file (the MRR1 body) on this machine and print its timing
//!                                      (benches, B5's closing runs); `--runs N` repeats it, `--threads N` sets the
//!                                      raster threads (default: every core)
//!
//! Environment:
//!   MORFA_RENDER_ADDR              listen address (127.0.0.1:3440)
//!   MORFA_RENDER_INTERNAL_SECRET   bearer secret of /internal/render (the api's DESIGN_RENDER_SECRET); unset: refused
//!   MORFA_RENDER_FONTS_DIR         the catalogue font files (the api's public/fonts)
//!   MORFA_RENDER_WORKERS           worker threads (one per core)
//!   MORFA_RENDER_QUEUE             jobs waiting beyond the running ones (16)
//!   MORFA_RENDER_TIMEOUT_MS        the longest a job may take from its arrival (60000)
//!   MORFA_RENDER_BODY_BYTES        the largest request (512 MiB)
//!   RUST_LOG                       tracing filter (info)

use std::time::{Duration, Instant};

use morfa_render_service::fonts::FontFiles;
use morfa_render_service::jobs::{Worker, execute};
use morfa_render_service::{Config, fonts::WorkerFonts, request, vello::Vello};

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

fn fail(message: &str) -> ! {
    eprintln!("morfa-render: {message}");
    std::process::exit(2)
}

fn number<T: std::str::FromStr>(name: &str) -> Option<T> {
    env(name).map(|v| {
        v.parse()
            .unwrap_or_else(|_| fail(&format!("{name}={v} is not a number")))
    })
}

fn config() -> Config {
    let mut config = Config::default();
    if let Some(n) = number::<usize>("MORFA_RENDER_WORKERS") {
        config.workers = n.max(1);
    }
    config.fonts_dir = env("MORFA_RENDER_FONTS_DIR").map(Into::into);
    config.secret = env("MORFA_RENDER_INTERNAL_SECRET");
    if config.secret.as_ref().is_some_and(|s| s.len() < 16) {
        fail("MORFA_RENDER_INTERNAL_SECRET must have at least 16 characters");
    }
    if let Some(n) = number::<usize>("MORFA_RENDER_QUEUE") {
        config.limits.queue = n;
    }
    if let Some(ms) = number::<u64>("MORFA_RENDER_TIMEOUT_MS") {
        config.limits.timeout = Duration::from_millis(ms.clamp(1, 600_000));
    }
    if let Some(n) = number::<usize>("MORFA_RENDER_BODY_BYTES") {
        config.limits.body_bytes = n;
    }
    config
}

fn job(args: &[String]) {
    let mut path = None;
    let mut out = None;
    let mut runs = 1usize;
    let config = config();
    let mut threads = config.workers;
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--runs" => runs = it.next().and_then(|v| v.parse().ok()).unwrap_or(1),
            "--threads" => threads = it.next().and_then(|v| v.parse().ok()).unwrap_or(1),
            _ if path.is_none() => path = Some(a.clone()),
            _ => out = Some(a.clone()),
        }
    }
    let path = path.unwrap_or_else(|| fail("job: name a request file"));
    let body = std::fs::read(&path).unwrap_or_else(|e| fail(&format!("{path}: {e}")));
    let files = FontFiles::new(config.fonts_dir.clone());
    let mut worker = Worker {
        fonts: WorkerFonts::default(),
        shaping: None,
    };
    let mut times = Vec::new();
    for run in 0..runs {
        let started = Instant::now();
        let request = request::parse(&body, &config.limits)
            .unwrap_or_else(|r| fail(&format!("{} {}: {}", r.status, r.code, r.message)));
        let output = execute(
            request,
            &mut worker,
            &files,
            &config.limits,
            started + config.limits.timeout,
            threads,
            &Vello,
        )
        .unwrap_or_else(|r| fail(&format!("{} {}: {}", r.status, r.code, r.message)));
        let ms = started.elapsed().as_secs_f64() * 1e3;
        times.push(ms);
        println!(
            "run {run}: {ms:.1} ms, {} bytes, {} pages, {} rasters ({:.1} MP), {} unmeasured, missing fonts {:?}",
            output.body.len(),
            output.pages,
            output.rasters,
            output.raster_pixels as f64 / 1e6,
            output.unmeasured,
            output.missing_fonts
        );
        if run == 0
            && let Some(out) = &out
        {
            std::fs::write(out, &output.body).unwrap_or_else(|e| fail(&format!("{out}: {e}")));
        }
    }
    times.sort_by(f64::total_cmp);
    println!(
        "median {:.1} ms, p95 {:.1} ms over {runs} run(s), {threads} raster threads",
        times[times.len() / 2],
        times[((times.len() as f64 * 0.95).ceil() as usize).clamp(1, times.len()) - 1]
    );
}

#[tokio::main]
async fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().map(String::as_str) == Some("job") {
        return job(&args[1..]);
    }
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with_writer(std::io::stderr)
        .init();
    let config = config();
    if config.secret.is_none() {
        tracing::warn!("MORFA_RENDER_INTERNAL_SECRET is unset: every job is refused (403)");
    }
    if config.fonts_dir.is_none() {
        tracing::warn!("MORFA_RENDER_FONTS_DIR is unset: text is drawn in no face (shapes only)");
    }
    let addr = env("MORFA_RENDER_ADDR").unwrap_or_else(|| "127.0.0.1:3440".to_owned());
    let workers = config.workers;
    let app = morfa_render_service::service(config);
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| fail(&format!("{addr}: {e}")));
    let bound = listener.local_addr().map_or(addr, |a| a.to_string());
    tracing::info!(workers, "morfa-render listening on {bound}");
    axum::serve(listener, morfa_render_service::http::router(app))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .unwrap_or_else(|e| fail(&format!("serve: {e}")));
}
