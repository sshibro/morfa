//! Times `merge_change` natively (profiling aid): `cargo run --release --example merge -- doc.json saves.json`, where
//! `saves.json` is a JSON array of `{patch, before}` texts (scripts/bench/ops.ts writes the same saves).
use morfa_ops::{DocumentTarget, Value, merge_change};

fn main() {
    let mut args = std::env::args().skip(1);
    let doc = Value::from_json(
        &std::fs::read_to_string(args.next().expect("a document")).expect("readable"),
    )
    .expect("JSON");
    let saves =
        Value::from_json(&std::fs::read_to_string(args.next().expect("saves")).expect("readable"))
            .expect("JSON");
    let saves: Vec<Value> = saves
        .as_array()
        .unwrap_or(&[])
        .iter()
        .map(|text| Value::from_json(text.as_str().unwrap_or("null")).expect("JSON"))
        .collect();
    for _ in 0..3 {
        let started = std::time::Instant::now();
        let mut parse = std::time::Duration::ZERO;
        for save in &saves {
            let t = std::time::Instant::now();
            let patch =
                Value::from_json(&save.get("patch").expect("patch").to_json()).expect("JSON");
            let mut before = morfa_ops::Object::new();
            before.insert("nodes", save.get("before").cloned().unwrap_or_default());
            let before = Value::object(before);
            parse += t.elapsed();
            let outcome = merge_change(&DocumentTarget(&doc), &patch, Some(&before));
            std::hint::black_box(outcome.patch.to_json());
        }
        println!(
            "{} merges: {:?} ({:?} of it parsing)",
            saves.len(),
            started.elapsed(),
            parse
        );
    }
}
