//! `morfa-render` (lane B4, docs/BACKEND.md §4): the render/export service. Jobs over HTTP from api
//! (`POST /internal/render`): SVG (lane L5's exporter, byte-equal to the TypeScript), the vector PDF without a
//! browser (L5's direct writer: text as embedded subsets, shadows and blurs rasterised on the free cores), and
//! raster (PNG/JPG/WebP, thumbnails) through [`raster::Rasterizer`]: lane L4's CPU renderer ([`vello`], vello_cpu). A bounded queue,
//! one worker per core, today's limits (50 pages, 96/240 MP, ten a minute and two at a time per account). No
//! outbound network: the api sends the document, its pictures and the faces to read.

// `!(x > 0.0)` keeps NaN out, as the TypeScript's tests do.
#![allow(clippy::neg_cmp_op_on_partial_ord)]

pub mod fonts;
pub mod http;
pub mod jobs;
pub mod limits;
pub mod measure;
pub mod metrics;
pub mod pdf;
pub mod raster;
pub mod request;
pub mod svg;
pub mod vello;

use std::path::PathBuf;
use std::sync::Arc;

/// This crate's name, as the gate's smoke test reads it.
pub const CRATE: &str = env!("CARGO_PKG_NAME");

/// Everything `main` reads from the environment.
#[derive(Clone, Debug)]
pub struct Config {
    pub workers: usize,
    pub fonts_dir: Option<PathBuf>,
    pub secret: Option<String>,
    pub limits: limits::Limits,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            workers: std::thread::available_parallelism().map_or(1, |n| n.get()),
            fonts_dir: None,
            secret: None,
            limits: limits::Limits::default(),
        }
    }
}

/// The service with its workers started, lane L4's vello_cpu renderer behind its raster jobs.
pub fn service(config: Config) -> http::App {
    service_with(config, Arc::new(vello::Vello))
}

/// The service with `rasterizer` behind its raster jobs.
pub fn service_with(config: Config, rasterizer: Arc<dyn raster::Rasterizer>) -> http::App {
    let raster = rasterizer.available();
    let limits = Arc::new(config.limits);
    let metrics = Arc::new(metrics::Metrics::default());
    let files = Arc::new(fonts::FontFiles::new(config.fonts_dir));
    let queue = jobs::Queue::start(
        config.workers,
        limits.clone(),
        files,
        metrics.clone(),
        rasterizer,
    );
    Arc::new(http::Service {
        limits,
        queue,
        accounts: Arc::default(),
        metrics,
        secret: config.secret,
        raster,
    })
}

#[cfg(test)]
mod tests {
    #[test]
    fn names_itself() {
        assert_eq!(super::CRATE, "morfa-render-service");
    }
}
