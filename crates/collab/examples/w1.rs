//! W1 on a dev box: encode / decode of a 20-layer move op (with and without `before`), JSON codec.
use morfa_model::{DocumentPatch, Map, from_json_validated};
use morfa_protocol::{ClientMsg, Op, Wire};
use std::time::Instant;

fn main() {
    if std::env::args().nth(1).as_deref() == Some("apply") {
        apply_bench();
        return;
    }
    let seed = std::process::Command::new(std::env::current_exe().unwrap().with_file_name("load"))
        .args(["seed", "20"])
        .output()
        .expect("examples/load built");
    let doc = from_json_validated(std::str::from_utf8(&seed.stdout).unwrap()).unwrap();
    let decode_only = std::env::args().nth(1).as_deref() == Some("decode");
    let mut nodes = Map::default();
    let mut before = Map::default();
    for (id, node) in doc.nodes.iter().filter(|(id, _)| id.starts_with('r')) {
        before.insert(id.clone(), Some(node.clone()));
        let mut moved = node.clone();
        moved.x += 10.0;
        nodes.insert(id.clone(), Some(moved));
    }
    if decode_only {
        // `w1 decode <json|bin> <n>`: only the op's decode, n times (for a profiler).
        let wire = match std::env::args().nth(2).as_deref() {
            Some("bin") => Wire::Binary,
            _ => Wire::Json,
        };
        let n: usize = std::env::args()
            .nth(3)
            .map_or(20_000, |n| n.parse().unwrap());
        let msg = ClientMsg::Op(Box::new(Op {
            seq: 1,
            base_version: 7,
            patch: DocumentPatch {
                nodes: Some(nodes),
                ..Default::default()
            },
            before: None,
            before_tables: None,
            fields: None,
        }));
        let frame = wire.codec().encode_client(&msg);
        let t = Instant::now();
        for _ in 0..n {
            std::hint::black_box(wire.codec().decode_client(&frame.bytes).unwrap());
        }
        println!(
            "W1 {} decode: {:.1} µs",
            wire.name(),
            t.elapsed().as_secs_f64() * 1e6 / n as f64
        );
        return;
    }
    // The co-editing merge of crates/ops on the same op (the target's entries converted from the typed model).
    {
        use morfa_ops::{MergeTarget, Value};
        struct Target<'a>(&'a morfa_model::DesignDocument);
        impl MergeTarget for Target<'_> {
            fn pages(&self) -> Value {
                Value::from_serialize(&self.0.pages).unwrap()
            }
            fn node(&self, id: &str) -> Option<Value> {
                self.0
                    .nodes
                    .get(id)
                    .map(|n| Value::from_serialize(n).unwrap())
            }
            fn entry(&self, table: &str, key: &str) -> Option<Value> {
                (table == "nodes").then(|| self.node(key)).flatten()
            }
        }
        let patch = DocumentPatch {
            nodes: Some(nodes.clone()),
            ..Default::default()
        };
        let patch_json = morfa_model::to_json(&patch);
        let before_json = morfa_model::to_json(&DocumentPatch {
            nodes: Some(before.clone()),
            ..Default::default()
        });
        let n = 500;
        let t = Instant::now();
        for _ in 0..n {
            let change = Value::from_json(&patch_json).unwrap();
            let base = Value::from_json(&before_json).unwrap();
            let out = morfa_ops::merge_change(&Target(&doc), &change, Some(&base));
            assert!(!out.adjusted);
        }
        println!(
            "merge of 20 layers: {:.1} µs",
            t.elapsed().as_secs_f64() * 1e6 / n as f64
        );
        let t = Instant::now();
        for _ in 0..n {
            std::hint::black_box(Value::from_json(&patch_json).unwrap());
        }
        println!(
            "  of which one patch from JSON: {:.1} µs",
            t.elapsed().as_secs_f64() * 1e6 / n as f64
        );
    }
    for wire in [Wire::Json, Wire::Binary] {
        let codec = wire.codec();
        for with_before in [false, true] {
            let msg = ClientMsg::Op(Box::new(Op {
                seq: 1,
                base_version: 7,
                patch: DocumentPatch {
                    nodes: Some(nodes.clone()),
                    ..Default::default()
                },
                before: with_before.then(|| before.clone().into()),
                before_tables: None,
                fields: None,
            }));
            let n = 2000;
            let t = Instant::now();
            let mut frame = None;
            for _ in 0..n {
                frame = Some(codec.encode_client(&msg));
            }
            let encode = t.elapsed().as_secs_f64() * 1e6 / n as f64;
            let frame = frame.unwrap();
            let t = Instant::now();
            for _ in 0..n {
                std::hint::black_box(codec.decode_client(&frame.bytes).unwrap());
            }
            let decode = t.elapsed().as_secs_f64() * 1e6 / n as f64;
            println!(
                "W1 {} {} before: {} bytes, encode {encode:.1} µs, decode {decode:.1} µs",
                wire.name(),
                if with_before { "with" } else { "without" },
                frame.bytes.len()
            );
            // The receivers' side: the change frame of the same patch.
            let change = morfa_protocol::ServerMsg::Change(morfa_protocol::Change {
                version: 8,
                by: Some("c".into()),
                client: None,
                seq: Some(1),
                user: "u".into(),
                patch: std::sync::Arc::new(DocumentPatch {
                    nodes: Some(nodes.clone()),
                    ..Default::default()
                }),
                fields: None,
            });
            let frame = codec.encode_server(&change);
            let t = Instant::now();
            for _ in 0..n {
                std::hint::black_box(codec.decode_server(&frame.bytes).unwrap());
            }
            if !with_before {
                println!(
                    "   change frame {} bytes, decode {:.1} µs",
                    frame.bytes.len(),
                    t.elapsed().as_secs_f64() * 1e6 / n as f64
                );
            }
        }
    }
    fields_bench(&nodes, &before);
}

/// Protocol 2 (lane W): the server's cost of the field-level form of the same change (the diff against the op's undo
/// and its encoding), next to the whole change's encoding, on both wires.
fn fields_bench(
    nodes: &Map<Option<morfa_model::SceneNode>>,
    before: &Map<Option<morfa_model::SceneNode>>,
) {
    use morfa_protocol::{Change, ServerMsg};
    let change = Change {
        version: 8,
        by: Some("c".into()),
        client: Some(morfa_protocol::ClientId::new("tab")),
        seq: Some(1),
        user: "u".into(),
        patch: std::sync::Arc::new(DocumentPatch {
            nodes: Some(nodes.clone()),
            ..Default::default()
        }),
        fields: None,
    };
    let undo = DocumentPatch {
        nodes: Some(before.clone()),
        ..Default::default()
    };
    let n = 5000;
    let t = Instant::now();
    for _ in 0..n {
        std::hint::black_box(change.with_fields(&undo).unwrap());
    }
    let diff = t.elapsed().as_secs_f64() * 1e6 / n as f64;
    let fields = change.with_fields(&undo).unwrap();
    for wire in [Wire::Json, Wire::Binary] {
        let codec = wire.codec();
        let whole_msg = ServerMsg::Change(change.clone());
        let fields_msg = ServerMsg::Change(fields.clone());
        let time = |msg: &ServerMsg| {
            let t = Instant::now();
            for _ in 0..n {
                std::hint::black_box(codec.encode_server(msg));
            }
            t.elapsed().as_secs_f64() * 1e6 / n as f64
        };
        let (whole_us, fields_us) = (time(&whole_msg), time(&fields_msg));
        println!(
            "W1 {} change: whole {} bytes, encode {whole_us:.1} µs; fields {} bytes, diff {diff:.1} µs + encode {fields_us:.1} µs",
            wire.name(),
            codec.encode_server(&whole_msg).len(),
            codec.encode_server(&fields_msg).len(),
        );
    }
}

/// The engine's apply of a 20-layer move on `f20k` (heavyPage-shaped), on the current version: `w1 apply`.
#[allow(dead_code)]
fn apply_bench() {
    use morfa_collab::engine::{DocEngine, OpInput, OpsEngine};
    let seed = std::process::Command::new(std::env::current_exe().unwrap().with_file_name("load"))
        .args(["seed", "19200"])
        .output()
        .expect("examples/load built");
    let doc = morfa_model::from_json(std::str::from_utf8(&seed.stdout).unwrap()).unwrap();
    let ids: Vec<String> = (0..20).map(|i| format!("r{i}")).collect();
    let mut engine = OpsEngine::new(doc, 0);
    let n = 2000;
    let t = Instant::now();
    for k in 0..n {
        let current = engine.document();
        let mut nodes = Map::default();
        let mut before = Map::default();
        for id in &ids {
            let node = current.nodes[id].clone();
            before.insert(id.clone(), Some(node.clone()));
            let mut moved = node;
            moved.x += if k % 2 == 0 { 1.0 } else { -1.0 };
            nodes.insert(id.clone(), Some(moved));
        }
        drop(current);
        let patch = DocumentPatch {
            nodes: Some(nodes),
            ..Default::default()
        };
        let input = OpInput {
            base_version: engine.version(),
            patch: &patch,
            before: Some(&before),
            before_tables: None,
        };
        engine.apply(&input).expect("applies");
    }
    println!(
        "apply of a 20-layer move on f20k: {:.1} µs",
        t.elapsed().as_secs_f64() * 1e6 / n as f64
    );
}
