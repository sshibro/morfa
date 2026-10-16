//! The checkpoint bytes of a bench file (what `GET /checkpoint` serves and
//! `MorfaDoc.decode` reads), for scripts/bench/parts.ts:
//!   cargo run --release -p morfa-wasm --example checkpoint -- fixtures/bench/f500k.json fixtures/bench/f500k.mrfa

use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let [input, output] = args.as_slice() else {
        eprintln!("usage: checkpoint <in.json> <out.mrfa>");
        std::process::exit(2);
    };
    let started = Instant::now();
    let json = std::fs::read_to_string(input).expect("the bench file");
    let model = morfa_model::from_json(&json).expect("a valid document");
    drop(json);
    let doc = morfa_model::store::Document::from_model(&model);
    drop(model);
    let bytes = morfa_model::codec::encode(&doc);
    std::fs::write(output, &bytes).expect("written");
    println!(
        "{output}: {} nodes, {} bytes, {:.1} s",
        doc.len(),
        bytes.len(),
        started.elapsed().as_secs_f64()
    );
}
