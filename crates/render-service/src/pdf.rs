//! PDF jobs: lane L5's direct vector PDF (crates/export `write_pdf_with`: the print flavour as PDF operators, text
//! in embedded subsets, pictures as their own bytes, shadows and blurs rasterised), its rasters on the cores no
//! other job holds, stopped at PDF_EXPORT_LIMITS' raster pixels and at the job's deadline. TARGETS X4.

use morfa_export::pdf::{Measure, PdfFailure, PdfPage, PdfRun, write_pdf_with};
use morfa_model::DesignDocument;
use morfa_text::measure::FixedMeasurer;

use crate::jobs::{Ctx, Output, timeout};
use crate::measure::ReplayMeasurer;
use crate::request::{MeasureIn, Refusal};

pub fn run(doc: &DesignDocument, ctx: &mut Ctx) -> Result<Output, Refusal> {
    let header = ctx.header;
    let pages: Vec<PdfPage> = header
        .pages
        .iter()
        .map(|p| PdfPage {
            ids: p.ids.clone(),
            crop: p.crop.map(Into::into),
        })
        .collect();
    let title = {
        let t = header.title.trim();
        if t.is_empty() { "Export" } else { t }
    };
    let run = PdfRun {
        threads: ctx.threads,
        raster_pixels: ctx.limits.raster_megapixels * 1e6,
        raster_pixels_total: ctx.limits.raster_megapixels_total * 1e6,
        deadline: Some(ctx.deadline),
    };
    let mut replay =
        ReplayMeasurer::new(header.measurements.as_ref().unwrap_or(&Default::default()));
    let mut fixed = FixedMeasurer;
    let measure = match header.measure {
        MeasureIn::Table => Measure::With(&mut replay),
        MeasureIn::Fixed => Measure::With(&mut fixed),
        MeasureIn::Fonts => Measure::Fonts,
    };
    let written = write_pdf_with(
        doc,
        &pages,
        title,
        measure,
        &mut ctx.pictures.hrefs,
        &mut ctx.pictures.bytes,
        &mut ctx.worker.fonts.fonts,
        &run,
    );
    let (pdf, stats) = written.map_err(|failure| match failure {
        PdfFailure::Timeout => timeout(),
        PdfFailure::RastersTooLarge => Refusal::too_large(
            "Shadows and blurs cover too large an area for a PDF. Remove the shadow or blur from large layers or export fewer frames at a time.",
        ),
    })?;
    if stats.pages == 0 {
        return Err(Refusal::invalid(
            "Nothing to export: the layers have no visible content.",
        ));
    }
    let mut out = Output::new(pdf, "application/pdf");
    out.pages = stats.pages;
    out.unmeasured = replay.misses;
    out.missing_fonts = stats.missing_families.into_iter().collect();
    out.rasters = stats.rasters;
    out.raster_pixels = stats.raster_pixels;
    Ok(out)
}
