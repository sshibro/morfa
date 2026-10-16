//! A drag frame with this crate's transaction natively: 50 layers of two groups moved in one transaction on the
//! 20 041-layer `heavyPage()`, committed (patch and inverse from the keys written; normalization is not ported yet, so
//! this is the transaction's own cost).
//!
//!   npx tsx scripts/bench/ops.ts --dump /tmp/m1 && cargo run --release -p morfa-ops --example drag -- /tmp/m1
use morfa_ops::{Str, Transaction, Value};
use std::time::{Duration, Instant};

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("the directory scripts/bench/ops.ts --dump wrote");
    let doc =
        Value::from_json(&std::fs::read_to_string(format!("{dir}/doc.json")).expect("doc.json"))
            .expect("JSON");
    let nodes = doc.get("nodes").and_then(Value::as_object).expect("nodes");
    let groups: Vec<&Value> = nodes
        .values()
        .filter(|node| node.get("type").and_then(Value::as_str) == Some("GROUP"))
        .take(2)
        .collect();
    let ids: Vec<Str> = groups
        .iter()
        .flat_map(|group| {
            group
                .get("children")
                .and_then(Value::as_array)
                .unwrap_or(&[])
                .iter()
                .take(25)
        })
        .filter_map(|id| id.as_str().map(Str::from))
        .collect();
    let starts: Vec<(f64, f64)> = ids
        .iter()
        .map(|id| {
            let node = nodes.get(id).expect("a layer");
            (
                node.get("x").and_then(Value::as_f64).unwrap_or(0.0),
                node.get("y").and_then(Value::as_f64).unwrap_or(0.0),
            )
        })
        .collect();
    let frame = |tx: &mut Transaction<&Value>, k: f64| {
        for (id, (x, y)) in ids.iter().zip(&starts) {
            let partial = [
                (Str::from("x"), Some(Value::Number(x + k * 2.0))),
                (Str::from("y"), Some(Value::Number(y + k))),
            ];
            tx.update(id, &partial).expect("an update");
        }
    };
    let report = |name: &str, mut times: Vec<Duration>| {
        times.sort();
        println!(
            "{name}: p50 {:?} p95 {:?}",
            times[times.len() / 2],
            times[times.len() * 95 / 100]
        );
    };
    for _ in 0..3 {
        // The transaction and its patch and inverse.
        let mut times = Vec::new();
        for k in 1..=200 {
            let started = Instant::now();
            let mut tx = Transaction::new(&doc);
            frame(&mut tx, f64::from(k));
            std::hint::black_box(tx.commit().expect("a commit"));
            times.push(started.elapsed());
        }
        report("50-layer frame, patch + inverse", times);
        // A gesture's held copy (the scratch table's part): the previous frame undone, this one written, in place.
        let mut held = doc.clone();
        let mut undo: Option<Value> = None;
        let mut times = Vec::new();
        for k in 1..=200 {
            let started = Instant::now();
            let mut tx = Transaction::new(&doc);
            frame(&mut tx, f64::from(k));
            let result = tx.commit().expect("a commit");
            if let Some(undo) = undo.take() {
                morfa_ops::apply_patch_mut(&mut held, &undo);
            }
            morfa_ops::apply_patch_mut(&mut held, &result.patch);
            undo = Some(result.inverse);
            times.push(started.elapsed());
        }
        report("  … and written into the gesture's held document", times);
    }
}
