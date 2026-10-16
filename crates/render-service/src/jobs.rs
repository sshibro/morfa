//! The job queue (docs/BACKEND.md §4): one worker thread per core, a bounded queue in front of them (a full queue
//! refuses with `429 design_pdf_busy`), each job with a deadline from its arrival (`504 design_pdf_timeout`). A
//! worker keeps its own fonts (the catalogue faces jobs named, registered once) and runs one job at a time; a PDF's
//! rasters spread over the cores no other job is using.

use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, mpsc};
use std::time::{Duration, Instant};

use morfa_export::pdf::PdfPictures;
use morfa_export::svg::Pictures;
use morfa_text::measure::{FixedMeasurer, Measurer};
use morfa_text::shape::ShapingMeasurer;
use tokio::sync::oneshot;

use crate::fonts::{FontFiles, WorkerFonts};
use crate::limits::Limits;
use crate::measure::ReplayMeasurer;
use crate::metrics::Metrics;
use crate::raster::Rasterizer;
use crate::request::{Header, Kind, MeasureIn, Refusal, Request};

/// A job's result.
#[derive(Debug)]
pub struct Output {
    pub body: Vec<u8>,
    pub content_type: &'static str,
    pub pages: usize,
    pub unmeasured: u64,
    pub missing_fonts: Vec<String>,
    pub rasters: usize,
    pub raster_pixels: u64,
    /// SVG: the exported area [x, y, width, height].
    pub bounds: Option<[f64; 4]>,
    pub millis: f64,
}

impl Output {
    pub fn new(body: Vec<u8>, content_type: &'static str) -> Output {
        Output {
            body,
            content_type,
            pages: 0,
            unmeasured: 0,
            missing_fonts: Vec::new(),
            rasters: 0,
            raster_pixels: 0,
            bounds: None,
            millis: 0.0,
        }
    }
}

/// The pictures of a job: the URL per ref the exporter writes ([`Hrefs`]), the bytes per URL the PDF embeds
/// ([`Bytes`]); two halves so the exporter and the PDF writer can hold each at once.
#[derive(Default)]
pub struct JobPictures {
    pub hrefs: Hrefs,
    pub bytes: Bytes,
}

#[derive(Default)]
pub struct Hrefs(HashMap<String, String>);

#[derive(Default)]
pub struct Bytes(HashMap<String, Vec<u8>>);

impl JobPictures {
    pub fn new(list: Vec<(crate::request::PictureIn, Vec<u8>)>) -> JobPictures {
        let mut out = JobPictures::default();
        for (picture, data) in list {
            out.hrefs.0.insert(picture.image_ref, picture.href.clone());
            out.bytes.0.insert(picture.href, data);
        }
        out
    }
}

impl Bytes {
    pub fn get(&self, href: &str) -> Option<&[u8]> {
        self.0.get(href).map(Vec::as_slice)
    }
}

impl Pictures for Hrefs {
    fn data(&mut self, _: &str) -> Option<String> {
        None
    }
    fn href(&mut self, image_ref: &str) -> Option<String> {
        self.0.get(image_ref).cloned()
    }
}

impl PdfPictures for Bytes {
    fn bytes(&mut self, href: &str) -> Option<Vec<u8>> {
        self.0.get(href).cloned()
    }
}

/// What a worker keeps between jobs.
pub struct Worker {
    /// Fonts for outlines, embedded subsets and the PDF's own measuring.
    pub fonts: WorkerFonts,
    /// A second store measuring an SVG whose text is outlined with `fonts` (both borrowed at once).
    pub shaping: Option<WorkerFonts>,
}

/// A job's context on its worker.
pub struct Ctx<'w> {
    pub header: &'w Header,
    pub pictures: &'w mut JobPictures,
    pub worker: &'w mut Worker,
    pub files: &'w FontFiles,
    pub limits: &'w Limits,
    pub deadline: Instant,
    /// Threads a PDF's rasters may use.
    pub threads: usize,
    pub rasterizer: &'w dyn Rasterizer,
}

impl Ctx<'_> {
    /// Runs `f` with the job's measurer (the table replayed, the fonts' shaper or the fixed fake), the pictures and
    /// the worker's fonts; returns its result and the replay's misses.
    pub fn with_measurer<R>(
        &mut self,
        f: impl FnOnce(&mut dyn Measurer, &mut Hrefs, &mut morfa_export::fonts::Fonts) -> R,
    ) -> (R, u64) {
        match self.header.measure {
            MeasureIn::Table => {
                let table = self
                    .header
                    .measurements
                    .as_ref()
                    .expect("checked by request::parse");
                let mut m = ReplayMeasurer::new(table);
                let out = f(
                    &mut m,
                    &mut self.pictures.hrefs,
                    &mut self.worker.fonts.fonts,
                );
                (out, m.misses)
            }
            MeasureIn::Fixed => (
                f(
                    &mut FixedMeasurer,
                    &mut self.pictures.hrefs,
                    &mut self.worker.fonts.fonts,
                ),
                0,
            ),
            MeasureIn::Fonts => {
                let shaping = self.worker.shaping.get_or_insert_with(WorkerFonts::default);
                shaping.ensure(&self.header.fonts, self.files);
                let mut m = ShapingMeasurer(&mut shaping.fonts.shaper);
                (
                    f(
                        &mut m,
                        &mut self.pictures.hrefs,
                        &mut self.worker.fonts.fonts,
                    ),
                    0,
                )
            }
        }
    }
}

/// Runs one parsed job on this thread (the workers, the CLI and the tests).
pub fn execute(
    request: Request,
    worker: &mut Worker,
    files: &FontFiles,
    limits: &Limits,
    deadline: Instant,
    threads: usize,
    rasterizer: &dyn Rasterizer,
) -> Result<Output, Refusal> {
    let started = Instant::now();
    let Request {
        header,
        document,
        pictures,
    } = request;
    let doc = morfa_model::from_json(&document)
        .map_err(|e| Refusal::new(422, "render_unsupported", format!("model: {e}")))?;
    drop(document);
    let unreadable = worker.fonts.ensure(&header.fonts, files);
    if !unreadable.is_empty() {
        tracing::warn!(files = ?unreadable, "faces the job named could not be read");
    }
    let mut pictures = JobPictures::new(pictures);
    let mut ctx = Ctx {
        header: &header,
        pictures: &mut pictures,
        worker,
        files,
        limits,
        deadline,
        threads,
        rasterizer,
    };
    let mut out = match header.kind {
        Kind::Pdf => crate::pdf::run(&doc, &mut ctx),
        Kind::Svg => crate::svg::run(&doc, &mut ctx),
        Kind::Png | Kind::Jpeg | Kind::Webp | Kind::Thumbnail => crate::raster::run(&doc, &mut ctx),
    }?;
    out.millis = started.elapsed().as_secs_f64() * 1e3;
    Ok(out)
}

struct Queued {
    request: Request,
    deadline: Instant,
    reply: oneshot::Sender<Result<Output, Refusal>>,
}

/// The bounded queue and its workers.
pub struct Queue {
    send: mpsc::SyncSender<Queued>,
    busy: Arc<AtomicUsize>,
    pub workers: usize,
}

impl Queue {
    pub fn start(
        workers: usize,
        limits: Arc<Limits>,
        files: Arc<FontFiles>,
        metrics: Arc<Metrics>,
        rasterizer: Arc<dyn Rasterizer>,
    ) -> Queue {
        let workers = workers.max(1);
        let (send, receive) = mpsc::sync_channel::<Queued>(limits.queue);
        let receive = Arc::new(Mutex::new(receive));
        let busy = Arc::new(AtomicUsize::new(0));
        for index in 0..workers {
            let receive = receive.clone();
            let (limits, files, metrics, rasterizer, busy) = (
                limits.clone(),
                files.clone(),
                metrics.clone(),
                rasterizer.clone(),
                busy.clone(),
            );
            std::thread::Builder::new()
                .name(format!("render-{index}"))
                .spawn(move || {
                    let mut worker = Worker {
                        fonts: WorkerFonts::default(),
                        shaping: None,
                    };
                    loop {
                        let job = {
                            let guard = receive.lock().unwrap_or_else(|p| p.into_inner());
                            guard.recv()
                        };
                        let Ok(job) = job else { break };
                        metrics.queued.fetch_sub(1, Ordering::Relaxed);
                        if job.reply.is_closed() {
                            continue;
                        }
                        let kind = job.request.header.kind;
                        let waited = Instant::now();
                        if waited >= job.deadline {
                            metrics.finish(kind, Duration::ZERO, Some("design_pdf_timeout"));
                            let _ = job.reply.send(Err(timeout()));
                            continue;
                        }
                        let running = busy.fetch_add(1, Ordering::Relaxed) + 1;
                        // The cores no other job holds draw this job's rasters.
                        let threads = (workers / running).max(1);
                        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                            execute(
                                job.request,
                                &mut worker,
                                &files,
                                &limits,
                                job.deadline,
                                threads,
                                rasterizer.as_ref(),
                            )
                        }))
                        .unwrap_or_else(|_| {
                            // A panic may leave the fonts half-registered: start this worker's afresh.
                            worker = Worker {
                                fonts: WorkerFonts::default(),
                                shaping: None,
                            };
                            Err(Refusal::new(500, "render_failed", "the renderer failed"))
                        });
                        busy.fetch_sub(1, Ordering::Relaxed);
                        metrics.finish(
                            kind,
                            waited.elapsed(),
                            result.as_ref().err().map(|r| r.code),
                        );
                        let _ = job.reply.send(result);
                    }
                })
                .expect("worker thread");
        }
        Queue {
            send,
            busy,
            workers,
        }
    }

    /// Queues a job; refuses at once when the queue is full.
    pub fn submit(
        &self,
        request: Request,
        deadline: Instant,
        metrics: &Metrics,
    ) -> Result<oneshot::Receiver<Result<Output, Refusal>>, Refusal> {
        let (reply, receive) = oneshot::channel();
        metrics.queued.fetch_add(1, Ordering::Relaxed);
        match self.send.try_send(Queued {
            request,
            deadline,
            reply,
        }) {
            Ok(()) => Ok(receive),
            Err(_) => {
                metrics.queued.fetch_sub(1, Ordering::Relaxed);
                Err(busy())
            }
        }
    }

    pub fn running(&self) -> usize {
        self.busy.load(Ordering::Relaxed)
    }
}

pub fn busy() -> Refusal {
    Refusal::new(
        429,
        "design_pdf_busy",
        "The server is building other PDFs right now. Try again in a few seconds.",
    )
}

pub fn timeout() -> Refusal {
    Refusal::new(
        504,
        "design_pdf_timeout",
        "The PDF took too long to build. Export fewer frames at a time or simplify shadows and blurs.",
    )
}
