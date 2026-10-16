//! Replays a case the shadow harness dumped (crates/collab/harness/shadow.ts, `SHADOW_DUMP=<file>`) through
//! `OpsEngine` and prints where its document differs from Node's.
//!
//!     cargo run --release -p morfa-collab --example shadow_case -- <case.json>

use morfa_collab::engine::{DocEngine, OpInput, OpsEngine};
use morfa_model::{from_json, patch_from_json, to_json};
use serde_json::Value;

fn sorted(value: Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<(String, Value)> = map.into_iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            Value::Object(entries.into_iter().map(|(k, v)| (k, sorted(v))).collect())
        }
        Value::Array(items) => Value::Array(items.into_iter().map(sorted).collect()),
        other => other,
    }
}

fn diff(path: &str, a: &Value, b: &Value) {
    match (a, b) {
        (Value::Object(x), Value::Object(y)) => {
            for key in x.keys().chain(y.keys().filter(|k| !x.contains_key(*k))) {
                match (x.get(key), y.get(key)) {
                    (Some(p), Some(q)) => diff(&format!("{path}.{key}"), p, q),
                    (p, q) => println!("{path}.{key}: engine {p:?} / node {q:?}"),
                }
            }
        }
        _ if a != b => println!("{path}: engine {a} / node {b}"),
        _ => {}
    }
}

fn main() {
    let path = std::env::args().nth(1).expect("case.json");
    let case: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let mut engine = OpsEngine::new(from_json(&case["base"].to_string()).unwrap(), 0);
    for (n, op) in case["ops"].as_array().unwrap().iter().enumerate() {
        let patch = patch_from_json(&op["patch"].to_string()).unwrap();
        let before = patch_from_json(&serde_json::json!({"nodes": op["before"]}).to_string())
            .unwrap()
            .nodes;
        let tables = op
            .get("beforeTables")
            .filter(|t| !t.is_null())
            .map(|t| patch_from_json(&t.to_string()).unwrap());
        let input = OpInput {
            base_version: 0,
            patch: &patch,
            before: before.as_ref(),
            before_tables: tables.as_ref(),
        };
        match engine.apply(&input) {
            Ok(applied) => println!(
                "op {}: version {}, adjusted {}, stored {}",
                n + 1,
                applied.version,
                applied.adjusted,
                to_json(&*applied.stored)
            ),
            Err(refusal) => println!("op {}: refused {refusal:?}", n + 1),
        }
    }
    let engine_doc = sorted(serde_json::from_str(&to_json(&*engine.document())).unwrap());
    let node_doc = sorted(case["node"].clone());
    println!("node stored {}", case["stored"]);
    diff("doc", &engine_doc, &node_doc);
}
