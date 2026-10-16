//! Runs the T1 bake-off over every self-hosted font (public/fonts/**/*.woff2, decoded to TTF with the
//! woff2 crate and kept under output/L3/fonts for the browser checks) and prints the tables for
//! docs/decisions/text-shaper.md. Usage: bakeoff <repository root> [--quick]

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Instant;

use morfa_text_bakeoff::{Candidate, cluster_starts, hr::Hr, pen_positions, rb::Rb, sw::Sw};

/// Cyrillic, Latin, mixed scripts, kerning pairs, ligatures, combining marks, emoji fallback,
/// Russian typography and the spaces the layout meets.
const CORPUS: &[&str] = &[
    "Съешь же ещё этих мягких французских булок, да выпей чаю.",
    "Широкая электрификация южных губерний даст мощный толчок подъёму сельского хозяйства.",
    "The quick brown fox jumps over the lazy dog.",
    "Sphinx of black quartz, judge my vow.",
    "Figma-класс редактор Morfa: 20 041 nodes, 60 fps",
    "iPhone 15 Pro — обзор и цена в ₽",
    "АТ",
    "Ту",
    "AV",
    "To",
    "ГА",
    "Ya",
    "Wa",
    "LT",
    "ДУ",
    "Ьт",
    "Ау",
    "ТА",
    "АУ",
    "Ту́",
    "fi",
    "ffl",
    "fl",
    "ffi",
    "office",
    "affluent",
    "fjord",
    "Th",
    "е\u{301}",
    "и\u{306}",
    "o\u{308}",
    "a\u{300}\u{301}",
    "й",
    "ё",
    "Ё",
    "👍🏽",
    "🇷🇺",
    "👨\u{200d}👩\u{200d}👧",
    "Текст 😀 ещё",
    "☺︎",
    "✓",
    "№ 12 345,67 ₽",
    "«ёлочки» — тире",
    "2-3 x/y",
    "северо-запад",
    "д’Артаньян",
    "don't",
    " ",
    "\u{a0}",
    "\t",
    "a b",
    "a\u{a0}b",
    "ПРОПИСНЫЕ БУКВЫ",
    "SMALL CAPS TEXT",
    "123 456 789 0",
    "WWW.MORFA.RU",
    "www.morfa.ru",
];

/// A whole weight range of a variable face is tested at these weights (those inside the range).
const WEIGHTS: &[f32] = &[300.0, 400.0, 500.0, 700.0, 900.0];

#[derive(Default)]
struct Tally {
    clusters: usize,
    failures: usize,
    /// Largest deviation seen, in 1/64 em.
    worst_64: f32,
    /// Shaping time, nanoseconds, over `timed_clusters`.
    nanos: u128,
    timed_clusters: usize,
    outline_mismatch: usize,
}

/// `--dump-json <root> <out.json>`: every face × weight × corpus string with each candidate's total advance in
/// font units, as one JSON array, for chrome-measure.mjs to measure the same in Chrome.
fn dump_json(root: &Path, out: &Path) {
    let mut rows: Vec<String> = Vec::new();
    for path in list_woff2(root) {
        let data = std::fs::read(&path).unwrap();
        let Some((ttf, _)) = woff2_to_ttf(&data) else {
            continue;
        };
        let rel = path
            .strip_prefix(root)
            .unwrap()
            .to_string_lossy()
            .replace('\\', "/");
        for wght in weights_of(&ttf) {
            let (Some(mut rb), Some(mut hr), Some(mut sw)) = (
                Rb::new(&ttf, wght),
                Hr::new(&ttf, wght),
                Sw::new(&ttf, wght),
            ) else {
                continue;
            };
            let upem = rb.upem();
            let face = rustybuzz::ttf_parser::Face::parse(&ttf, 0).unwrap();
            for text in CORPUS {
                // Chrome falls back to another font for characters this face lacks: only fully covered strings compare.
                let covered = text.chars().all(|c| face.glyph_index(c).is_some());
                let total =
                    |c: &mut dyn Candidate| c.shape(text).iter().map(|k| k.advance).sum::<f32>();
                let (a, b, c) = (total(&mut rb), total(&mut hr), total(&mut sw));
                let escaped = text
                    .replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('\t', "\\t");
                rows.push(format!(
                    "{{\"file\":\"{}\",\"covered\":{},\"wght\":{},\"upem\":{},\"text\":\"{}\",\"rb\":{:.1},\"hr\":{:.1},\"sw\":{:.1}}}",
                    rel,
                    covered,
                    wght.unwrap_or(0.0),
                    upem,
                    escaped,
                    a,
                    b,
                    c
                ));
            }
        }
    }
    std::fs::write(out, format!("[\n{}\n]\n", rows.join(",\n"))).unwrap();
    eprintln!("dump-json: {} rows → {}", rows.len(), out.display());
}

/// `--probe <ttf> <wght|0> <text>…`: every candidate's total advance of each text, in font units.
fn probe(args: &[String]) {
    let data = std::fs::read(&args[0]).expect("read ttf");
    let wght: f32 = args[1].parse().unwrap_or(0.0);
    let wght = (wght > 0.0).then_some(wght);
    let mut candidates: Vec<Box<dyn Candidate>> = vec![
        Box::new(Rb::new(&data, wght).unwrap()),
        Box::new(Hr::new(&data, wght).unwrap()),
        Box::new(Sw::new(&data, wght).unwrap()),
    ];
    println!("upem {}", candidates[0].upem());
    for text in &args[2..] {
        let cells: Vec<String> = candidates
            .iter_mut()
            .map(|c| {
                let clusters = c.shape(text);
                let total: f32 = clusters.iter().map(|k| k.advance).sum();
                format!(
                    "{} {:.0} [{}]",
                    c.name(),
                    total,
                    clusters
                        .iter()
                        .map(|k| format!("{:.0}", k.advance))
                        .collect::<Vec<_>>()
                        .join(" ")
                )
            })
            .collect();
        println!("{:?}: {}", text, cells.join(" | "));
    }
}

/// `woff2-patched` first; `wuff` (pure Rust, brotli-decompressor) for what it rejects. Returns the crate that worked.
fn woff2_to_ttf(data: &[u8]) -> Option<(Vec<u8>, &'static str)> {
    let mut buf: &[u8] = data;
    if let Ok(ttf) = woff2_patched::decode::convert_woff2_to_ttf(&mut buf) {
        return Some((ttf, "woff2-patched"));
    }
    wuff::decompress_woff2(data).ok().map(|ttf| (ttf, "wuff"))
}

/// Failures worth reading: the first few per candidate, with the text, face and pen positions.
struct Failure {
    file: String,
    wght: Option<f32>,
    text: String,
    reference: Vec<f32>,
    candidate: Vec<f32>,
    upem: f32,
}

fn list_woff2(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let fonts = root.join("public/fonts");
    let Ok(dirs) = std::fs::read_dir(&fonts) else {
        return out;
    };
    for dir in dirs.flatten() {
        let Ok(files) = std::fs::read_dir(dir.path()) else {
            continue;
        };
        for file in files.flatten() {
            let path = file.path();
            if path.extension().is_some_and(|e| e == "woff2") {
                out.push(path);
            }
        }
    }
    out.sort();
    out
}

fn weights_of(data: &[u8]) -> Vec<Option<f32>> {
    let Some(face) = rustybuzz::ttf_parser::Face::parse(data, 0).ok() else {
        return vec![None];
    };
    let wght = face
        .variation_axes()
        .into_iter()
        .find(|a| a.tag == rustybuzz::ttf_parser::Tag::from_bytes(b"wght"));
    match wght {
        Some(axis) => WEIGHTS
            .iter()
            .copied()
            .filter(|w| *w >= axis.min_value && *w <= axis.max_value)
            .map(Some)
            .collect(),
        None => vec![None],
    }
}

fn compare(
    reference: &mut dyn Candidate,
    candidate: &mut dyn Candidate,
    tally: &mut Tally,
    quick: bool,
    file: &str,
    wght: Option<f32>,
    failures: &mut Vec<Failure>,
) {
    let upem = reference.upem() as f32;
    let tolerance = upem / 64.0;
    for text in CORPUS {
        let base = reference.shape(text);
        let other = candidate.shape(text);
        let starts = cluster_starts(&base);
        let a = pen_positions(&base, &starts, text.len() as u32);
        let b = pen_positions(&other, &starts, text.len() as u32);
        tally.clusters += starts.len();
        let mut failed = false;
        for (x, y) in a.iter().zip(&b) {
            let diff = (x - y).abs();
            let in_64 = diff / upem * 64.0;
            if in_64 > tally.worst_64 {
                tally.worst_64 = in_64;
            }
            if diff > tolerance {
                tally.failures += 1;
                failed = true;
            }
        }
        if failed && failures.len() < 60 {
            failures.push(Failure {
                file: file.to_string(),
                wght,
                text: text.to_string(),
                reference: a.clone(),
                candidate: b.clone(),
                upem,
            });
        }
        let (a, b) = (reference.outline_bbox(text), candidate.outline_bbox(text));
        if a.iter().zip(&b).any(|(x, y)| (x - y).abs() > 1.0) {
            tally.outline_mismatch += 1;
        }
    }
    // Time: the whole corpus, a few rounds, best of them.
    let rounds = if quick { 3 } else { 7 };
    let mut best = u128::MAX;
    let mut clusters = 0;
    for _ in 0..rounds {
        let start = Instant::now();
        clusters = 0;
        for text in CORPUS {
            clusters += candidate.shape(text).len();
        }
        best = best.min(start.elapsed().as_nanos());
    }
    tally.nanos += best;
    tally.timed_clusters += clusters;
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).is_some_and(|a| a == "--probe") {
        return probe(&args[2..]);
    }
    if args.get(1).is_some_and(|a| a == "--dump-json") {
        return dump_json(&PathBuf::from(&args[2]), &PathBuf::from(&args[3]));
    }
    let root = PathBuf::from(args.get(1).map(String::as_str).unwrap_or("."));
    let quick = args.iter().any(|a| a == "--quick");
    let out_fonts = root.join("output/L3/fonts");
    let files = list_woff2(&root);
    eprintln!(
        "bakeoff: {} woff2 files under {}",
        files.len(),
        root.join("public/fonts").display()
    );

    let mut per_family: BTreeMap<String, [Tally; 3]> = BTreeMap::new();
    let mut totals: [Tally; 3] = Default::default();
    let mut decoded = 0usize;
    let mut decode_nanos = 0u128;
    let mut ttf_bytes = 0usize;
    let mut woff2_bytes = 0usize;
    let mut parse_nanos = [0u128; 3];
    let mut faces = 0usize;
    let mut failures: [Vec<Failure>; 3] = Default::default();

    for path in &files {
        let data = std::fs::read(path).expect("read woff2");
        let start = Instant::now();
        let Some((ttf, decoder)) = woff2_to_ttf(&data) else {
            eprintln!("  decode failed: {}", path.display());
            continue;
        };
        if decoder != "woff2-patched" {
            eprintln!("  {} decoded by {}", path.display(), decoder);
        }
        decode_nanos += start.elapsed().as_nanos();
        decoded += 1;
        woff2_bytes += data.len();
        ttf_bytes += ttf.len();
        let family = path
            .parent()
            .and_then(|p| p.file_name())
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let target = out_fonts
            .join(&family)
            .join(path.with_extension("ttf").file_name().unwrap());
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::write(&target, &ttf).unwrap();

        for wght in weights_of(&ttf) {
            faces += 1;
            let t = Instant::now();
            let Some(mut reference) = Rb::new(&ttf, wght) else {
                continue;
            };
            parse_nanos[0] += t.elapsed().as_nanos();
            let t = Instant::now();
            let Some(mut hr) = Hr::new(&ttf, wght) else {
                continue;
            };
            parse_nanos[1] += t.elapsed().as_nanos();
            let t = Instant::now();
            let Some(mut sw) = Sw::new(&ttf, wght) else {
                continue;
            };
            parse_nanos[2] += t.elapsed().as_nanos();
            let entry = per_family.entry(family.clone()).or_default();
            // The reference against itself times rustybuzz and proves the harness (0 failures expected).
            let mut self_ref = Rb::new(&ttf, wght).unwrap();
            let file = format!("{}/{}", family, path.file_name().unwrap().to_string_lossy());
            compare(
                &mut reference,
                &mut self_ref,
                &mut entry[0],
                quick,
                &file,
                wght,
                &mut failures[0],
            );
            compare(
                &mut reference,
                &mut hr,
                &mut entry[1],
                quick,
                &file,
                wght,
                &mut failures[1],
            );
            compare(
                &mut reference,
                &mut sw,
                &mut entry[2],
                quick,
                &file,
                wght,
                &mut failures[2],
            );
        }
    }
    for tallies in per_family.values() {
        for (i, t) in tallies.iter().enumerate() {
            totals[i].clusters += t.clusters;
            totals[i].failures += t.failures;
            totals[i].worst_64 = totals[i].worst_64.max(t.worst_64);
            totals[i].nanos += t.nanos;
            totals[i].timed_clusters += t.timed_clusters;
            totals[i].outline_mismatch += t.outline_mismatch;
        }
    }

    let names = [
        "rustybuzz+ttf-parser (reference)",
        "harfrust+skrifa",
        "swash",
    ];
    println!("## Decoding (woff2 crate `woff2-patched` 0.4, native arm64)\n");
    println!("| Files | Decoded | woff2 bytes | TTF bytes | Decode ms total | ms per file |");
    println!("|---|---|---|---|---|---|");
    println!(
        "| {} | {} | {} | {} | {:.1} | {:.2} |",
        files.len(),
        decoded,
        woff2_bytes,
        ttf_bytes,
        decode_nanos as f64 / 1e6,
        decode_nanos as f64 / 1e6 / decoded.max(1) as f64
    );
    println!(
        "\n## T1 totals over {} faces ({} files × weights), corpus of {} strings\n",
        faces,
        decoded,
        CORPUS.len()
    );
    println!(
        "| Candidate | Clusters compared | Failures (> 1/64 em) | Worst (1/64 em) | Outline bbox mismatches (> 1 unit) | ns per cluster (best of rounds) | Parse ms per face |"
    );
    println!("|---|---|---|---|---|---|---|");
    for (i, name) in names.iter().enumerate() {
        let t = &totals[i];
        println!(
            "| {} | {} | {} | {:.3} | {} | {:.0} | {:.3} |",
            name,
            t.clusters,
            t.failures,
            t.worst_64,
            t.outline_mismatch,
            t.nanos as f64 / t.timed_clusters.max(1) as f64,
            parse_nanos[i] as f64 / 1e6 / faces.max(1) as f64
        );
    }
    println!("\n## Per family (failures / clusters; worst in 1/64 em; ns per cluster)\n");
    println!("| Family | rustybuzz (self) | harfrust+skrifa | swash |");
    println!("|---|---|---|---|");
    for (family, tallies) in &per_family {
        let cell = |t: &Tally| {
            format!(
                "{}/{} · {:.2} · {:.0} ns",
                t.failures,
                t.clusters,
                t.worst_64,
                t.nanos as f64 / t.timed_clusters.max(1) as f64
            )
        };
        println!(
            "| {} | {} | {} | {} |",
            family,
            cell(&tallies[0]),
            cell(&tallies[1]),
            cell(&tallies[2])
        );
    }
    if args.iter().any(|a| a == "--verbose") {
        for (i, list) in failures.iter().enumerate() {
            println!("\n## First failures: {}\n", names[i]);
            for f in list.iter().take(40) {
                let diffs: Vec<String> = f
                    .reference
                    .iter()
                    .zip(&f.candidate)
                    .map(|(a, b)| format!("{:.0}/{:.0}", a, b))
                    .collect();
                println!(
                    "- {} wght={:?} upem={} {:?}: ref/cand pen = {}",
                    f.file,
                    f.wght,
                    f.upem,
                    f.text,
                    diffs.join(" ")
                );
            }
        }
    }
}
