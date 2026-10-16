//! The vector PDF written directly (lane L5; no Chromium, no `server/design/pdf/` print step): each page is the SVG
//! exporter's print flavour (`pdfPageSvg`: the very tree Chromium printed) drawn as PDF content (paint.rs), text as
//! real glyphs in embedded Type 3 subsets with Unicode maps (font.rs), pictures as their own JPEG bytes or lossless
//! PNG samples (image.rs), and only shadows and blurs as pixels (raster.rs). Page sizes follow `pdfPageSize`.

mod filter;
mod font;
mod image;
mod paint;
mod raster;
pub mod writer;

use std::collections::{BTreeSet, HashMap};
use std::fmt::Write as _;

use morfa_geometry::matrix::Rect;
use morfa_model::DesignDocument;
use morfa_text::measure::Measurer;

use crate::fonts::Fonts;
use crate::svg::{Exporter, Pictures, SvgOptions};
use paint::{Painter, Stream, write_links};
use writer::{Writer, n, text_string};

/// PDF_EXPORT_LIMITS of pdf-export.ts: Acrobat's page side and the raster resolution.
pub const PAGE_SIDE: f64 = 14_400.0;
pub const RASTER_DPI: f64 = 300.0;

/// The bytes of a picture the print flavour refers to by URL (an https: URL of `imageHref`); data: URLs are read
/// directly.
pub trait PdfPictures {
    fn bytes(&mut self, href: &str) -> Option<Vec<u8>>;
}

/// One page: what `pdfPagePlan` says it draws.
#[derive(Clone, Debug)]
pub struct PdfPage {
    pub ids: Vec<String>,
    pub crop: Option<Rect>,
}

/// What the PDF holds, for the caller's report and the benches.
#[derive(Clone, Debug, Default)]
pub struct PdfStats {
    pub pages: usize,
    pub shapes: usize,
    pub text_spans: usize,
    pub images: usize,
    pub rasters: usize,
    pub raster_pixels: u64,
    /// Families no face was registered for (drawn in the fallback family).
    pub missing_families: BTreeSet<String>,
    /// Each page's size in points.
    pub sizes: Vec<(f64, f64)>,
}

/// How the pages' text is measured: the caller's measurer (the editor's recorded widths, replayed), or the
/// module's own fonts (lane L3's shaper: the widths Chrome's canvas measures).
pub enum Measure<'m> {
    With(&'m mut dyn Measurer),
    Fonts,
}

/// `pdfPageSize(bounds)`: points (1 px = 1 pt), scaled down to fit the page limit.
pub fn page_size(bounds: Rect) -> (f64, f64, f64) {
    let width = bounds.width.max(1.0);
    let height = bounds.height.max(1.0);
    let scale = (PAGE_SIDE / width.max(height)).min(1.0);
    (width * scale, height * scale, scale)
}

/// The PDF of `pages`. `pictures` answers the exporter's `imageData`/`imageHref` (as the TypeScript passes them);
/// `bytes` the pictures' bytes by those URLs.
#[allow(clippy::too_many_arguments)]
pub fn write_pdf(
    doc: &DesignDocument,
    pages: &[PdfPage],
    title: &str,
    measure: Measure,
    pictures: &mut dyn Pictures,
    bytes: &mut dyn PdfPictures,
    fonts: &mut Fonts,
) -> (Vec<u8>, PdfStats) {
    let run = PdfRun::default();
    match write_pdf_with(doc, pages, title, measure, pictures, bytes, fonts, &run) {
        Ok(out) => out,
        Err(_) => unreachable!("no limits, no deadline"),
    }
}

/// How [`write_pdf_with`] runs: threads for the rasters, and the limits it stops at.
#[derive(Clone, Debug)]
pub struct PdfRun {
    /// Threads drawing rasters (1: each where it is met, as the wasm build does).
    pub threads: usize,
    /// PDF_EXPORT_LIMITS.rasterMegapixels / rasterMegapixelsTotal as pixels: of the pixels the rasters draw, at the
    /// resolution each blur needs (Chromium drew every one at 300 dpi; today's TypeScript check counts that).
    pub raster_pixels: f64,
    pub raster_pixels_total: f64,
    /// Checked between pages and between rasters.
    pub deadline: Option<std::time::Instant>,
}

impl Default for PdfRun {
    fn default() -> Self {
        PdfRun {
            threads: 1,
            raster_pixels: f64::INFINITY,
            raster_pixels_total: f64::INFINITY,
            deadline: None,
        }
    }
}

/// Why [`write_pdf_with`] stopped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PdfFailure {
    /// Shadows and blurs over PDF_EXPORT_LIMITS' raster pixels (`413 design_pdf_too_large`).
    RastersTooLarge,
    /// Past [`PdfRun::deadline`] (`504 design_pdf_timeout`).
    Timeout,
}

pub(crate) fn past_deadline(deadline: Option<std::time::Instant>) -> bool {
    #[cfg(not(target_arch = "wasm32"))]
    return deadline.is_some_and(|d| std::time::Instant::now() >= d);
    #[cfg(target_arch = "wasm32")]
    {
        let _ = deadline;
        false
    }
}

/// [`write_pdf`] with its rasters (shadows, blurs: most of a heavy file's time) drawn on `run.threads` threads (lane
/// B4's render service), stopping at the run's limits. The file is the same for any thread count but for object
/// numbers.
#[allow(clippy::too_many_arguments)]
pub fn write_pdf_with(
    doc: &DesignDocument,
    pages: &[PdfPage],
    title: &str,
    measure: Measure,
    pictures: &mut dyn Pictures,
    bytes: &mut dyn PdfPictures,
    fonts: &mut Fonts,
    run: &PdfRun,
) -> Result<(Vec<u8>, PdfStats), PdfFailure> {
    #[cfg(not(target_arch = "wasm32"))]
    if run.threads > 1 {
        return std::thread::scope(|scope| {
            let mut pool = raster::Pool::start(scope, run.threads, run.deadline);
            write_pages(
                doc, pages, title, measure, pictures, bytes, fonts, run, &mut pool,
            )
        });
    }
    let mut pool = raster::Pool::inline(run.deadline);
    write_pages(
        doc, pages, title, measure, pictures, bytes, fonts, run, &mut pool,
    )
}

#[allow(clippy::too_many_arguments)]
fn write_pages(
    doc: &DesignDocument,
    pages: &[PdfPage],
    title: &str,
    mut measure: Measure,
    pictures: &mut dyn Pictures,
    bytes: &mut dyn PdfPictures,
    fonts: &mut Fonts,
    run: &PdfRun,
    pool: &mut raster::Pool,
) -> Result<(Vec<u8>, PdfStats), PdfFailure> {
    let mut drawn = 0.0;
    let mut w = Writer::new();
    let catalog = w.alloc();
    let pages_id = w.alloc();
    let info = w.alloc();
    let mut font_set = font::FontSet::default();
    let mut images = HashMap::new();
    let mut gstates = HashMap::new();
    let mut stats = PdfStats::default();
    let mut kids = Vec::new();
    for plan in pages {
        if past_deadline(run.deadline) {
            return Err(PdfFailure::Timeout);
        }
        let options = SvgOptions {
            precision: None,
            id_prefix: Some(format!("p{}_", kids.len())),
            layer_ids: false,
            print: true,
            crop: plan.crop,
            outline_text: false,
        };
        let mut shaping;
        let measurer: &mut dyn Measurer = match &mut measure {
            Measure::With(m) => &mut **m,
            Measure::Fonts => {
                shaping = morfa_text::shape::ShapingMeasurer(&mut fonts.shaper);
                &mut shaping
            }
        };
        let mut exporter = Exporter::new(doc, &options, measurer, pictures);
        exporter.keep_text = true;
        let (root, bounds) = exporter.document_tree(&plan.ids);
        let texts = std::mem::take(&mut exporter.texts);
        drop(exporter);
        if !(bounds.width > 0.0 && bounds.height > 0.0) {
            continue;
        }
        let (width, height, scale) = page_size(bounds);
        let base = [[scale, 0.0, 0.0], [0.0, -scale, height]];
        let mut stream = Stream::new(false);
        let links = {
            let mut painter = Painter::new(
                &mut w,
                fonts,
                &mut font_set,
                bytes,
                &mut images,
                &mut gstates,
                &mut stats,
                &root,
                &texts,
                base,
                Rect::new(0.0, 0.0, bounds.width, bounds.height),
                RASTER_DPI / 72.0 * scale,
            );
            painter.page(&root, &mut stream);
            drawn += painter.raster_pixels;
            if painter.largest_pixels > run.raster_pixels || drawn > run.raster_pixels_total {
                return Err(PdfFailure::RastersTooLarge);
            }
            let jobs = std::mem::take(&mut painter.jobs);
            let links = std::mem::take(&mut painter.links);
            drop(painter);
            for (id, job) in jobs {
                pool.submit(&mut w, &mut stats, id, job);
            }
            pool.collect(&mut w, &mut stats, false);
            links
        };
        let annots = write_links(&mut w, &links);
        let content = w.alloc();
        let ops = format!(
            "{} 0 0 {} 0 {} cm\n{}",
            n(scale),
            n(-scale),
            n(height),
            stream.ops
        );
        w.stream(content, "", ops.as_bytes(), true);
        let page = w.alloc();
        let mut dict = format!(
            "<</Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 {} {}] /Resources {} /Contents {content} 0 R /Group <</S /Transparency /CS /DeviceRGB>>",
            n(width),
            n(height),
            stream.res.dict()
        );
        if !annots.is_empty() {
            dict.push_str(" /Annots [");
            for id in annots {
                let _ = write!(dict, "{id} 0 R ");
            }
            dict.push(']');
        }
        dict.push_str(">>");
        w.object(page, &dict);
        kids.push(page);
        stats.sizes.push((width, height));
    }
    pool.finish(&mut w, &mut stats)?;
    font_set.finish(&mut w, fonts);
    stats.pages = kids.len();
    let list: Vec<String> = kids.iter().map(|id| format!("{id} 0 R")).collect();
    w.object(
        pages_id,
        &format!(
            "<</Type /Pages /Kids [{}] /Count {}>>",
            list.join(" "),
            kids.len()
        ),
    );
    w.object(
        catalog,
        &format!("<</Type /Catalog /Pages {pages_id} 0 R>>"),
    );
    w.object(
        info,
        &format!("<</Title {} /Producer (Morfa)>>", text_string(title)),
    );
    Ok((w.finish(catalog, info), stats))
}
