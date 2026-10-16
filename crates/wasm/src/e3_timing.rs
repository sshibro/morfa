//! Native timings of the whole Rust side of a TARGETS E3 commit: `MorfaDoc::normalize` and the
//! commit's `apply_patch_with`, alternating the two dumped commits in `MORFA_E3_DIR`.
//! Without the variable the test passes doing nothing. `cargo test --release -p morfa-wasm e3_native -- --nocapture`.

use std::time::Instant;

use crate::doc::MorfaDoc;

#[test]
fn e3_native_timings() {
    let Ok(dir) = std::env::var("MORFA_E3_DIR") else {
        return;
    };
    let read = |name: &str| std::fs::read_to_string(format!("{dir}/{name}")).expect(name);
    let Ok(mut doc) = MorfaDoc::new(&read("doc.json")) else {
        panic!("doc.json")
    };
    let inputs: Vec<[String; 5]> = [2, 3]
        .iter()
        .map(|k| {
            [
                read(&format!("patch-{k}.json")),
                read(&format!("fields-{k}.json")),
                read(&format!("dirty-{k}.json")),
                read(&format!("commit-patch-{k}.json")),
                read(&format!("kept-ids-{k}.json")),
            ]
        })
        .collect();
    for round in 0..12 {
        let [patch, fields, dirty, commit, kept] = &inputs[round % 2];
        let started = Instant::now();
        let Ok(out) = doc.normalize(patch, fields, dirty, true, None, 0, 0.0) else {
            panic!("normalize")
        };
        let normalized = started.elapsed();
        let started = Instant::now();
        if doc.apply_patch_with(commit, kept).is_err() {
            panic!("apply_patch_with");
        }
        let applied = started.elapsed();
        let numbers = out
            .rsplit("\"numbers\":")
            .next()
            .and_then(|rest| rest.split(']').next())
            .unwrap_or("");
        eprintln!(
            "  round {round:>2}: normalize {:.3} ms ({} chars out, numbers {numbers}]), apply_patch_with {:.3} ms ({} + {} chars in)",
            normalized.as_secs_f64() * 1000.0,
            out.len(),
            applied.as_secs_f64() * 1000.0,
            commit.len(),
            kept.len()
        );
    }
}
