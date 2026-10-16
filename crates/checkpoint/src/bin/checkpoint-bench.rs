//! `checkpoint-bench`: the numbers behind the checkpoint format (TARGETS §3b, W4/W5, S1/S3) on a document file.
//!
//! ```text
//! checkpoint-bench <file.json> [copies=1] [runs=3]
//! ```
//!
//! `CHECKPOINT_BENCH_DUMP=<dir>` also writes each uncompressed payload there (for trying other compressors).
//! `copies` > 1 repeats every page and layer of the file under new ids (f20k × 5 ≈ f100k). Prints, for JSON and the
//! model's binary codec: payload and compressed bytes, encode (payload + zstd) and decode (zstd + payload →
//! store document) times, min of `runs`. Build with `--release`; the server builds at opt-level 3.

use morfa_checkpoint::format::{self, Format};
use morfa_model::store::Document;
use morfa_model::{DesignDocument, from_json};
use sha2::Digest;
use std::time::{Duration, Instant};

fn replicate(doc: &mut DesignDocument, copies: usize) {
    let originals: Vec<_> = doc.nodes.values().cloned().collect();
    let pages = doc.pages.clone();
    for k in 1..copies {
        let rename = |id: &str| format!("{id}~{k}");
        for node in &originals {
            let mut copy = node.clone();
            copy.id = rename(&node.id);
            copy.parent_id = node.parent_id.as_deref().map(rename);
            copy.children = node
                .children
                .as_ref()
                .map(|children| children.iter().map(|c| rename(c)).collect());
            doc.nodes.insert(copy.id.clone(), copy);
        }
        doc.pages.extend(pages.iter().map(|page| rename(page)));
    }
}

fn best<T>(runs: usize, mut work: impl FnMut() -> T) -> (Duration, T) {
    let mut best = Duration::MAX;
    let mut last = None;
    for _ in 0..runs.max(1) {
        let started = Instant::now();
        let value = work();
        best = best.min(started.elapsed());
        last = Some(value);
    }
    (best, last.expect("ran once"))
}

fn ms(d: Duration) -> f64 {
    d.as_secs_f64() * 1000.0
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let path = args
        .first()
        .expect("usage: checkpoint-bench <file.json> [copies] [runs]");
    let copies: usize = args.get(1).map_or(1, |n| n.parse().expect("copies"));
    let runs: usize = args.get(2).map_or(3, |n| n.parse().expect("runs"));
    let text = std::fs::read_to_string(path).expect("read the file");
    let mut model = from_json(&text).expect("a document");
    replicate(&mut model, copies);
    let doc = Document::from_model(&model);
    let json_text = morfa_model::to_json(&model);
    println!(
        "document: {} layers, JSON {:.1} MB",
        doc.len(),
        json_text.len() as f64 / 1e6
    );
    // The JSON path as the server has it today: parse into the model, then the store.
    let (parse, _) = best(runs, || {
        Document::from_model(&from_json(&json_text).unwrap())
    });
    println!("  serde_json → model → store: {:.0} ms", ms(parse));
    for format in [Format::Json, Format::Bin] {
        let (payload_time, payload) = best(runs, || format::payload(&doc, format));
        if let Ok(dir) = std::env::var("CHECKPOINT_BENCH_DUMP") {
            std::fs::write(format!("{dir}/payload.{}", format.name()), &payload).expect("dump");
        }
        let (encode, object) = best(runs, || format::encode(&doc, 1, format));
        let (open, (header, raw)) = best(runs, || format::open(&object).unwrap());
        let (decode_payload, _) = best(runs, || format::decode_payload(&header, &raw).unwrap());
        let (decode, (_, back)) = best(runs, || format::decode(&object).unwrap());
        assert_eq!(back.len(), doc.len());
        let (hash, _) = best(runs, || sha2::Sha256::digest(&raw));
        let (hash_object, _) = best(runs, || sha2::Sha256::digest(&object));
        println!(
            "  {:4}: sha256 of the payload {:.0} ms, of the object {:.1} ms",
            format.name(),
            ms(hash),
            ms(hash_object)
        );
        println!(
            "  {:4}: payload {:6.1} MB → {:7.0} KB zstd · encode {:4.0} ms (payload {:4.0}) · decode {:4.0} ms (unzstd+hash {:3.0}, payload {:4.0})",
            format.name(),
            payload.len() as f64 / 1e6,
            object.len() as f64 / 1e3,
            ms(encode),
            ms(payload_time),
            ms(decode),
            ms(open),
            ms(decode_payload),
        );
    }
}
