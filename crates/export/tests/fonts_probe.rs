//! Probes of the fonts the exporters draw with (needs `npm run fonts`; skipped without the files).
#![cfg(feature = "fonts")]

use morfa_export::fonts::Fonts;
use morfa_text::types::FontSpec;

fn inter() -> Option<Fonts> {
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/fonts/inter/");
    let latin = std::fs::read(format!("{root}inter-latin-wght-normal.woff2")).ok()?;
    let cyrillic = std::fs::read(format!("{root}inter-cyrillic-wght-normal.woff2")).ok()?;
    let mut fonts = Fonts::new();
    fonts.add_face(
        "Inter",
        100.0,
        900.0,
        false,
        "U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116",
        &cyrillic,
    )?;
    fonts.add_face("Inter", 100.0, 900.0, false, "U+0000-00FF", &latin)?;
    Some(fonts)
}

#[test]
fn advances_at_the_default_weight() {
    let Some(mut fonts) = inter() else { return };
    for weight in [100.0, 400.0, 900.0] {
        let spec = FontSpec {
            family: "Inter".into(),
            weight,
            italic: false,
            size: 2048.0,
        };
        let placed = fonts
            .place(
                &"ВВ".encode_utf16().collect::<Vec<_>>(),
                &spec,
                0.0,
                0.0,
                0.0,
            )
            .unwrap();
        let g = placed.glyphs[0];
        println!(
            "weight {weight}: shaped advance {} units, skrifa {}",
            placed.glyphs[1].x - g.x,
            fonts.advance_units(g.face, weight, g.id)
        );
    }
}

/// Times the PDF of a dumped document (`L5_PDF_PROBE=<doc.json>`, ids in `<doc>.ids`); prints the stages.
#[cfg(feature = "pdf")]
#[test]
fn pdf_probe() {
    use morfa_export::pdf::{Measure, PdfPage, write_pdf};
    use morfa_export::svg::NoPictures;
    struct NoBytes;
    impl morfa_export::pdf::PdfPictures for NoBytes {
        fn bytes(&mut self, _: &str) -> Option<Vec<u8>> {
            None
        }
    }
    let Ok(path) = std::env::var("L5_PDF_PROBE") else {
        return;
    };
    let doc = morfa_model::from_json(&std::fs::read_to_string(&path).unwrap()).unwrap();
    let ids = std::fs::read_to_string(path.replace(".json", ".ids")).unwrap();
    let mut fonts = inter().unwrap();
    let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../../public/fonts/");
    for dir in std::fs::read_dir(root).unwrap() {
        let dir = dir.unwrap().path();
        for file in std::fs::read_dir(&dir).unwrap() {
            let file = file.unwrap().path();
            if file.extension().is_some_and(|e| e == "woff2")
                && file.to_string_lossy().contains("wght")
            {
                let family = dir.file_name().unwrap().to_string_lossy().to_string();
                let _ = fonts.add_face(
                    &family,
                    100.0,
                    900.0,
                    false,
                    "",
                    &std::fs::read(&file).unwrap(),
                );
            }
        }
    }
    for id in ids.lines() {
        let svg_started = std::time::Instant::now();
        let options = morfa_export::svg::SvgOptions {
            print: true,
            ..Default::default()
        };
        let svg = morfa_export::svg::export_svg(
            &doc,
            &[id.to_owned()],
            &options,
            &mut morfa_text::measure::FixedMeasurer,
            &mut NoPictures,
        );
        println!(
            "svg {id}: {} bytes in {:?}",
            svg.len(),
            svg_started.elapsed()
        );
        let pages = vec![PdfPage {
            ids: vec![id.to_owned()],
            crop: None,
        }];
        let started = std::time::Instant::now();
        let (pdf, stats) = write_pdf(
            &doc,
            &pages,
            "probe",
            Measure::With(&mut morfa_text::measure::FixedMeasurer),
            &mut NoPictures,
            &mut NoBytes,
            &mut fonts,
        );
        println!(
            "pdf {id}: {} bytes in {:?}: rasters {} ({} px), shapes {}, spans {}",
            pdf.len(),
            started.elapsed(),
            stats.rasters,
            stats.raster_pixels,
            stats.shapes,
            stats.text_spans
        );
    }
}
