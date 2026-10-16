//! What a PDF cannot hold, as pixels: a filtered element (the print flavour's shadows, each a `use` of its content
//! through one shadow's filter, and a layer blur's whole layer) written as a stand-alone SVG — its content with text
//! as glyph paths and pictures as data: URLs, the definitions it refers to, the filter — and rasterised with resvg
//! (tiny-skia; lane L4's vello_cpu replaces it when it lands) at the PDF's raster resolution (300 dpi on the page,
//! PDF_EXPORT_LIMITS.rasterDpi). The image is placed over the filter region by the painter.

use std::collections::HashSet;
use std::sync::Arc;

use morfa_geometry::matrix::Rect;

use super::filter;
use super::image;
use super::paint::{Painter, elements};
use crate::svg::TEXT_INDEX;
use crate::xml::{Child, El, Val, el, write};

/// The largest raster of one element (PDF_EXPORT_LIMITS.rasterMegapixels) and side.
const MAX_PIXELS: f64 = 96e6;
const MAX_SIDE: f64 = 16_384.0;

/// Ids an element refers to (`url(#id)` values, `href="#id"`).
fn references(e: &El, out: &mut Vec<String>) {
    for (name, value) in &e.attrs.0 {
        let Some(Val::Str(v)) = value else { continue };
        if let Some(id) = v.strip_prefix("url(#").and_then(|r| r.strip_suffix(')')) {
            out.push(id.to_owned());
        } else if (*name == "href" || *name == "xlink:href") && v.starts_with('#') {
            out.push(v[1..].to_owned());
        }
    }
    for child in elements(e) {
        references(child, out);
    }
}

impl Painter<'_, '_> {
    /// A picture for resvg: a `morfa-picture:` name its job resolves to the bytes (no base64 per raster), made
    /// once per picture and page.
    fn inline_picture(&mut self, href: &str) -> Option<Picture> {
        if let Some(hit) = self.inline.get(href) {
            return hit.clone();
        }
        let next = self.inline.len();
        let picture = self.pictures.bytes(href).map(|bytes| Picture {
            name: format!("morfa-picture:{next}"),
            jpeg: bytes.starts_with(&[0xff, 0xd8]),
            bytes: Arc::new(bytes),
        });
        self.inline.insert(href.to_owned(), picture.clone());
        picture
    }

    /// The rectangle a JPEG `image` element draws (preserveAspectRatio applied), filled opaque; None for anything
    /// that may be transparent.
    fn opaque_picture_rect(&mut self, e: &El, href: &str) -> Option<El> {
        let placed = self.picture(href)?;
        if !placed.opaque {
            return None;
        }
        let num = |name: &str| match e.attrs.get(name) {
            Some(Val::Num(v)) => *v,
            _ => 0.0,
        };
        let (x, y, w, h) = (num("x"), num("y"), num("width"), num("height"));
        let aspect = match e.attrs.get("preserveAspectRatio") {
            Some(Val::Str(s)) => s.as_str(),
            _ => "xMidYMid meet",
        };
        let (iw, ih) = (placed.width as f64, placed.height as f64);
        let (dx, dy, dw, dh) = if aspect == "none" || aspect.ends_with("slice") {
            (x, y, w, h)
        } else {
            let s = (w / iw).min(h / ih);
            (
                x + (w - iw * s) / 2.0,
                y + (h - ih * s) / 2.0,
                iw * s,
                ih * s,
            )
        };
        let mut rect = el("rect", Default::default(), vec![]);
        for (name, value) in [("x", dx), ("y", dy), ("width", dw), ("height", dh)] {
            rect.attrs.set(name, Some(Val::Num(value)));
        }
        rect.attrs.set("fill", Some(Val::Str("#000".to_owned())));
        for name in ["transform", "opacity"] {
            if let Some(v) = e.attrs.get(name) {
                rect.attrs.set(name, Some(v.clone()));
            }
        }
        Some(rect)
    }

    /// `e` as resvg reads it: text outlined, pictures inlined, the lane's own marker attributes dropped.
    fn standalone(&mut self, e: &El, alpha_only: bool) -> El {
        if e.attrs.get(TEXT_INDEX).is_some() {
            let spans = match e.attrs.get(TEXT_INDEX) {
                Some(Val::Num(i)) => self.texts.get(*i as usize).cloned().unwrap_or_default(),
                _ => Vec::new(),
            };
            let mut missing = None;
            let mut outlined = crate::svg::outline_text_el(self.fonts, e, &spans, 3, &mut missing);
            for name in [
                "transform",
                "opacity",
                "style",
                "clip-path",
                "mask",
                "filter",
            ] {
                if let Some(v) = e.attrs.get(name) {
                    outlined.attrs.set(name, Some(v.clone()));
                }
            }
            return outlined;
        }
        let mut out = El {
            tag: e.tag,
            attrs: e.attrs.clone(),
            children: Vec::new(),
        };
        out.attrs
            .0
            .retain(|(name, _)| !name.starts_with("data-l5-"));
        if e.tag == "image" {
            let href =
                ["xlink:href", "href"]
                    .into_iter()
                    .find_map(|name| match e.attrs.get(name) {
                        Some(Val::Str(h)) => Some((name, h.clone())),
                        _ => None,
                    });
            if let Some((name, href)) = href {
                // Through a filter that reads only the content's alpha (a shadow), an opaque picture (a JPEG) is its
                // drawn rectangle: no decode per shadow.
                if alpha_only {
                    if let Some(rect) = self.opaque_picture_rect(e, &href) {
                        return rect;
                    }
                }
                if !href.starts_with("data:") {
                    let picture = self.inline_picture(&href);
                    out.attrs
                        .set(name, picture.as_ref().map(|p| Val::Str(p.name.clone())));
                    if let Some(p) = picture {
                        if !self.raster_pictures.iter().any(|q| q.name == p.name) {
                            self.raster_pictures.push(p);
                        }
                    }
                }
            }
        }
        for child in &e.children {
            match child {
                Child::El(c) => {
                    let c = self.standalone(c, alpha_only);
                    out.children.push(Child::El(c));
                }
                Child::Text(t) => out.children.push(Child::Text(t.clone())),
            }
        }
        out
    }
}

/// Raster pixels per user unit for `filter`: a Gaussian blur's output is band-limited, so a blur of σ needs only a
/// few pixels per σ (4 here; the viewer interpolates the image). Where the filter also keeps a sharp edge — a shadow
/// knocked out of or cut to the content's own alpha (`hardAlpha`), or no blur at all — at least half the PDF's raster
/// resolution (150 dpi, the X4 comparison's) stays.
fn resolution(filter: &El, ppu: f64) -> (f64, Option<f64>) {
    let mut sigma = f64::INFINITY;
    let mut sharp = false;
    for p in elements(filter) {
        match p.tag {
            "feGaussianBlur" => {
                if let Some(Val::Num(s)) = p.attrs.get("stdDeviation") {
                    sigma = sigma.min(*s);
                }
            }
            "feComposite" => {
                sharp |= matches!(p.attrs.get("in2"), Some(Val::Str(s)) if s == "hardAlpha")
            }
            _ => {}
        }
    }
    if !(sigma > 0.0) || !sigma.is_finite() {
        return (ppu, None);
    }
    let low = (4.0 / sigma).min(ppu);
    let floor = (ppu / 2.0).max(low);
    (low, (sharp && floor > low).then_some(floor))
}

/// Whether the content drew opaque wherever it drew (its pixels either clear or solid but for an edge ring): then a
/// shadow knocked out of or cut to its alpha has that sharp edge under the opaque content, and needs no more pixels.
fn opaque(image: &filter::Image) -> bool {
    let (mut mid, mut solid) = (0usize, 0usize);
    for p in &image.px {
        if p[3] >= 0.94 {
            solid += 1;
        } else if p[3] > 0.06 {
            mid += 1;
        }
    }
    (mid as f64) <= 0.25 * ((mid + solid) as f64)
}

/// A picture a raster's SVG names (`morfa-picture:N`), its bytes shared by every raster of the page.
#[derive(Clone)]
pub(crate) struct Picture {
    name: String,
    jpeg: bool,
    bytes: Arc<Vec<u8>>,
}

/// One filtered element ready to rasterise without the painter: its content as a stand-alone SVG (the root's size
/// and view box are added per draw), the filter, the region and resolutions. `Send`, so rasters run on other threads.
pub(crate) struct RasterJob {
    /// The `<defs>…</defs><g>…</g>` of the stand-alone SVG.
    inner: String,
    filter: El,
    /// The pictures the SVG names.
    pictures: Vec<Picture>,
    region: Rect,
    low: f64,
    floor: Option<f64>,
}

/// The content through `filter` over `region` (user space), at `ppu` pixels per user unit, as a job: the
/// painter's part (the stand-alone SVG of the content and the resolutions); [`RasterJob::run`] draws it.
pub(crate) fn prepare(
    painter: &mut Painter,
    content: &[&El],
    filter: &El,
    region: Rect,
    ppu: f64,
) -> Option<RasterJob> {
    let (low, floor) = resolution(filter, ppu);
    // A filter that never reads SourceGraphic (the shadows) sees only the content's alpha.
    let alpha_only = !elements(filter).any(|p| {
        ["in", "in2"]
            .iter()
            .any(|n| matches!(p.attrs.get(n), Some(Val::Str(s)) if s == "SourceGraphic"))
    });
    // Definitions the content and the filter refer to, transitively.
    let filter_id = match filter.attrs.get("id") {
        Some(Val::Str(id)) => id.clone(),
        _ => return None,
    };
    painter.raster_pictures.clear();
    let mut wanted = vec![filter_id.clone()];
    for e in content {
        references(e, &mut wanted);
    }
    let mut seen = HashSet::new();
    let mut defs = Vec::new();
    while let Some(id) = wanted.pop() {
        if !seen.insert(id.clone()) {
            continue;
        }
        let Some(&def) = painter.ids.get(id.as_str()) else {
            continue;
        };
        references(def, &mut wanted);
        defs.push(def);
    }
    let defs = el(
        "defs",
        Default::default(),
        defs.iter()
            .map(|d| painter.standalone(d, alpha_only))
            .collect(),
    );
    let body: Vec<El> = content
        .iter()
        .map(|e| painter.standalone(e, alpha_only))
        .collect();
    // The content alone: the filter runs in Rust afterwards (filter.rs).
    let body = el("g", Default::default(), body);
    let mut inner = String::new();
    write(&defs, 6, &mut inner);
    write(&body, 6, &mut inner);
    Some(RasterJob {
        inner,
        filter: filter.clone(),
        pictures: std::mem::take(&mut painter.raster_pictures),
        region,
        low,
        floor,
    })
}

impl RasterJob {
    /// The pixels the first draw takes (the size limits applied): what the job costs.
    pub(crate) fn pixels(&self) -> f64 {
        let scale = self.low.max(1e-3);
        let (pw, ph) = (
            (self.region.width * scale).ceil(),
            (self.region.height * scale).ceil(),
        );
        (pw * ph).min(MAX_PIXELS)
    }

    /// Rasterises and filters: straight RGBA and its size.
    pub(crate) fn run(&self) -> Option<(Vec<u8>, u32, u32)> {
        let (mut source, mut scale) = self.draw(self.low)?;
        if let Some(floor) = self.floor {
            if !opaque(&source) {
                (source, scale) = self.draw(floor)?;
            }
        }
        let filtered = filter::run(&self.filter, source, scale);
        let (pw, ph) = (filtered.w as u32, filtered.h as u32);
        let mut rgba = Vec::with_capacity((pw * ph * 4) as usize);
        for p in &filtered.px {
            let a = p[3].clamp(0.0, 1.0);
            let un = |c: f32| {
                if a > 0.0 {
                    ((c / a).clamp(0.0, 1.0) * 255.0).round() as u8
                } else {
                    0
                }
            };
            rgba.extend_from_slice(&[un(p[0]), un(p[1]), un(p[2]), (a * 255.0).round() as u8]);
        }
        Some((rgba, pw, ph))
    }

    /// The content (unfiltered) over the region at `scale` pixels per user unit (lowered to the size limits),
    /// premultiplied; and the scale it was drawn at.
    fn draw(&self, scale: f64) -> Option<(filter::Image, f64)> {
        let region = self.region;
        let mut scale = scale.max(1e-3);
        let mut pw = (region.width * scale).ceil();
        let mut ph = (region.height * scale).ceil();
        let shrink = (MAX_PIXELS / (pw * ph))
            .sqrt()
            .min(MAX_SIDE / pw)
            .min(MAX_SIDE / ph);
        if shrink < 1.0 {
            scale *= shrink;
            pw = (region.width * scale).ceil();
            ph = (region.height * scale).ceil();
        }
        if !(pw >= 1.0 && ph >= 1.0) {
            return None;
        }
        let mut root = el("svg", Default::default(), vec![]);
        for (name, value) in [
            ("xmlns", "http://www.w3.org/2000/svg".to_owned()),
            ("xmlns:xlink", "http://www.w3.org/1999/xlink".to_owned()),
            ("width", format!("{pw}")),
            ("height", format!("{ph}")),
            (
                "viewBox",
                format!(
                    "{} {} {} {}",
                    region.x, region.y, region.width, region.height
                ),
            ),
            ("preserveAspectRatio", "none".to_owned()),
        ] {
            root.attrs.set(name, Some(Val::Str(value)));
        }
        let mut svg = String::new();
        write(&root, 6, &mut svg);
        // `<svg …/>` (no children yet) → `<svg …>inner</svg>`.
        let open = svg.strip_suffix("/>").unwrap_or(&svg);
        let svg = format!("{open}>{}</svg>", self.inner);
        let mut options = resvg::usvg::Options::default();
        let pictures = &self.pictures;
        options.image_href_resolver.resolve_string = Box::new(move |href, _| {
            use resvg::usvg::ImageKind;
            let p = pictures.iter().find(|p| p.name == href)?;
            Some(if p.jpeg {
                ImageKind::JPEG(p.bytes.clone())
            } else {
                ImageKind::PNG(p.bytes.clone())
            })
        });
        let tree = resvg::usvg::Tree::from_str(&svg, &options).ok()?;
        let (pw, ph) = (pw as u32, ph as u32);
        let mut pixmap = resvg::tiny_skia::Pixmap::new(pw, ph)?;
        resvg::render(
            &tree,
            resvg::tiny_skia::Transform::default(),
            &mut pixmap.as_mut(),
        );
        let source = filter::Image {
            w: pw as usize,
            h: ph as usize,
            px: pixmap
                .pixels()
                .iter()
                .map(|p| {
                    [
                        p.red() as f32 / 255.0,
                        p.green() as f32 / 255.0,
                        p.blue() as f32 / 255.0,
                        p.alpha() as f32 / 255.0,
                    ]
                })
                .collect(),
        };
        Some((source, scale))
    }
}

/// A raster's result: encoded with its pixel count, nothing drawn, or skipped past the deadline.
enum Done {
    Drawn(image::EncodedRgba, u64),
    Empty,
    Late,
}

fn work(job: &RasterJob) -> Done {
    match job.run() {
        Some((rgba, pw, ph)) => Done::Drawn(
            image::encode_rgba(&rgba, pw, ph, true),
            pw as u64 * ph as u64,
        ),
        None => Done::Empty,
    }
}

/// Rasters drawn while the pages are painted: the painter queues each with the image object its content already
/// names, threads draw and encode them, and the writer writes the results after the last page in queue order (the
/// file is the same whatever thread finishes first, and the same as with one thread but for where the images sit). A raster that draws nothing becomes a clear 1×1 image, which shows as nothing,
/// as the immediate path does. Without threads (wasm, `threads` 1) a job is drawn when queued.
pub(crate) struct Pool {
    send: Option<std::sync::mpsc::Sender<(usize, RasterJob)>>,
    done: std::sync::mpsc::Receiver<(usize, Done)>,
    ids: Vec<u32>,
    waiting: std::collections::BTreeMap<usize, Done>,
    written: usize,
    late: bool,
    deadline: Option<std::time::Instant>,
}

impl Pool {
    /// Starts `threads` drawing threads in `scope`.
    #[cfg(not(target_arch = "wasm32"))]
    pub(crate) fn start<'s>(
        scope: &'s std::thread::Scope<'s, '_>,
        threads: usize,
        deadline: Option<std::time::Instant>,
    ) -> Pool {
        let (send, jobs) = std::sync::mpsc::channel::<(usize, RasterJob)>();
        let (sent, done) = std::sync::mpsc::channel();
        let jobs = std::sync::Arc::new(std::sync::Mutex::new(jobs));
        for _ in 0..threads.max(1) {
            let (jobs, sent) = (jobs.clone(), sent.clone());
            scope.spawn(move || {
                loop {
                    let next = jobs.lock().unwrap_or_else(|p| p.into_inner()).recv();
                    let Ok((at, job)) = next else { break };
                    let out = if super::past_deadline(deadline) {
                        Done::Late
                    } else {
                        work(&job)
                    };
                    if sent.send((at, out)).is_err() {
                        break;
                    }
                }
            });
        }
        Pool {
            send: Some(send),
            done,
            ids: Vec::new(),
            waiting: Default::default(),
            written: 0,
            late: false,
            deadline,
        }
    }

    /// No threads: each job is drawn when queued.
    pub(crate) fn inline(deadline: Option<std::time::Instant>) -> Pool {
        let (_, done) = std::sync::mpsc::channel();
        Pool {
            send: None,
            done,
            ids: Vec::new(),
            waiting: Default::default(),
            written: 0,
            late: false,
            deadline,
        }
    }

    pub(crate) fn submit(
        &mut self,
        w: &mut super::writer::Writer,
        stats: &mut super::PdfStats,
        id: u32,
        job: RasterJob,
    ) {
        let at = self.ids.len();
        self.ids.push(id);
        let job = match &self.send {
            Some(send) => match send.send((at, job)) {
                Ok(()) => return,
                // The threads are gone (one panicked): draw it here.
                Err(std::sync::mpsc::SendError((_, job))) => job,
            },
            None => job,
        };
        let out = if super::past_deadline(self.deadline) {
            Done::Late
        } else {
            work(&job)
        };
        self.waiting.insert(at, out);
        self.flush(w, stats);
    }

    /// Writes the results that are ready, in queue order; `wait` blocks until every queued job is written.
    pub(crate) fn collect(
        &mut self,
        w: &mut super::writer::Writer,
        stats: &mut super::PdfStats,
        wait: bool,
    ) {
        if wait {
            self.send = None;
            while self.written + self.waiting.len() < self.ids.len() {
                match self.done.recv() {
                    Ok((at, out)) => {
                        self.waiting.insert(at, out);
                    }
                    Err(_) => break,
                }
            }
            self.flush(w, stats);
        } else {
            // Results are only taken off the channel here: written at the end, in queue order, so the file's bytes
            // do not depend on which thread finished when.
            while let Ok((at, out)) = self.done.try_recv() {
                self.waiting.insert(at, out);
            }
        }
    }

    fn flush(&mut self, w: &mut super::writer::Writer, stats: &mut super::PdfStats) {
        while let Some(out) = self.waiting.remove(&self.written) {
            let id = self.ids[self.written];
            let encoded = match out {
                Done::Drawn(encoded, pixels) => {
                    stats.rasters += 1;
                    stats.raster_pixels += pixels;
                    encoded
                }
                Done::Empty => image::encode_rgba(&[0, 0, 0, 0], 1, 1, false),
                Done::Late => {
                    self.late = true;
                    image::encode_rgba(&[0, 0, 0, 0], 1, 1, false)
                }
            };
            image::write_encoded_rgba(w, id, encoded);
            self.written += 1;
        }
    }

    /// Waits for every job; Err when one was skipped past the deadline.
    pub(crate) fn finish(
        &mut self,
        w: &mut super::writer::Writer,
        stats: &mut super::PdfStats,
    ) -> Result<(), super::PdfFailure> {
        self.collect(w, stats, true);
        if self.late || self.written < self.ids.len() {
            Err(super::PdfFailure::Timeout)
        } else {
            Ok(())
        }
    }
}
