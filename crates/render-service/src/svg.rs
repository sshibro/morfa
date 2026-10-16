//! SVG jobs: `exportSvgPage` of lane L5's crates/export (byte-equal to svg-export.ts), outline text with the
//! catalogue faces when asked. TARGETS X3.

use morfa_export::svg::{SvgOptions, export_svg_page_checked, export_svg_page_outlined};
use morfa_model::DesignDocument;

use crate::jobs::{Ctx, Output};
use crate::request::Refusal;

pub fn run(doc: &DesignDocument, ctx: &mut Ctx) -> Result<Output, Refusal> {
    let o = &ctx.header.svg;
    let options = SvgOptions {
        precision: o.precision,
        id_prefix: o.id_prefix.clone(),
        layer_ids: o.layer_ids,
        print: o.print,
        crop: o.crop.map(Into::into),
        outline_text: o.outline_text,
    };
    let ids = ctx.header.ids.clone();
    let (page, unmeasured) = ctx.with_measurer(|measurer, pictures, fonts| {
        if options.outline_text {
            export_svg_page_outlined(doc, &ids, &options, measurer, pictures, fonts)
        } else {
            export_svg_page_checked(doc, &ids, &options, measurer, pictures)
        }
    });
    let page = page.map_err(|why| Refusal::new(422, "render_unsupported", why.0))?;
    let mut out = Output::new(page.svg.into_bytes(), "image/svg+xml; charset=utf-8");
    out.pages = 1;
    out.unmeasured = unmeasured;
    out.bounds = Some([
        page.bounds.x,
        page.bounds.y,
        page.bounds.width,
        page.bounds.height,
    ]);
    Ok(out)
}
