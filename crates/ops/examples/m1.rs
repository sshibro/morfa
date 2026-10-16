//! The server side of a save with this crate natively (TARGETS.md M1, the actor's work without the journal): per op,
//! the request text parsed, merged into the document as it is now (`before` copies), the patched document checked,
//! the stored change applied in place and written as the text the peers get.
//!
//!   npx tsx scripts/bench/ops.ts --dump /tmp/m1 && cargo run --release -p morfa-ops --example m1 -- /tmp/m1
//!
//! The saves are scripts/bench/ops.ts's: five editors each moving 20 layers of the 20 041-layer `heavyPage()`.
use morfa_ops::check::check_patched_document;
use morfa_ops::doc::Patched;
use morfa_ops::stored::StoredDocument;
use morfa_ops::{Value, apply_patch_mut};
use std::time::{Duration, Instant};

fn percentile(sorted: &[Duration], p: f64) -> Duration {
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss
    )]
    let at = ((sorted.len() as f64 * p) as usize).min(sorted.len() - 1);
    sorted[at]
}

fn main() {
    let dir = std::env::args()
        .nth(1)
        .expect("the directory scripts/bench/ops.ts --dump wrote");
    let text = std::fs::read_to_string(format!("{dir}/doc.json")).expect("doc.json");
    let saves = Value::from_json(
        &std::fs::read_to_string(format!("{dir}/saves.json")).expect("saves.json"),
    )
    .expect("JSON");
    let saves: Vec<String> = saves
        .as_array()
        .unwrap_or(&[])
        .iter()
        .filter_map(|text| text.as_str().map(str::to_owned))
        .collect();
    let mut waiting: Vec<String> = Vec::new();
    for run in 0..5 {
        let mut doc = Value::from_json(&text).expect("JSON");
        let mut times = Vec::with_capacity(saves.len());
        let (mut merge, mut check, mut apply) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);
        let mut bytes = 0usize;
        for save in &saves {
            let started = Instant::now();
            let change = Value::from_json(save).expect("a change");
            let t = Instant::now();
            let (stored, _adjusted) = morfa_ops::apply::merge_document_change(&doc, &change);
            merge += t.elapsed();
            let t = Instant::now();
            let invalid = check_patched_document(
                &doc,
                &Patched {
                    base: &doc,
                    patch: &stored,
                },
                &stored,
                None,
            );
            check += t.elapsed();
            assert!(
                invalid.is_none(),
                "a save the TypeScript stores is refused: {invalid:?}"
            );
            let t = Instant::now();
            apply_patch_mut(&mut doc, &stored);
            apply += t.elapsed();
            let frame = stored.to_json();
            if run == 0 && waiting.len() < 120 {
                waiting.push(frame.clone());
            }
            bytes += frame.len();
            times.push(started.elapsed());
        }
        times.sort();
        let total: Duration = times.iter().sum();
        // The file opened again with 120 changes waiting on its stored text (document-store.ts), whole and as a
        // StoredDocument; both must write the same text.
        let started = Instant::now();
        let mut whole = Value::from_json(&text).expect("JSON");
        for change in &waiting {
            apply_patch_mut(&mut whole, &Value::from_json(change).expect("a change"));
        }
        let whole_time = started.elapsed();
        let started = Instant::now();
        let mut stored = StoredDocument::from_json(&text).expect("JSON");
        for change in &waiting {
            stored.apply_patch(&Value::from_json(change).expect("a change"));
        }
        let stored_time = started.elapsed();
        assert_eq!(
            stored.to_json(),
            whole.to_json(),
            "the two documents differ"
        );
        println!(
            "  put together with {} waiting changes: whole {whole_time:?}, stored {stored_time:?}",
            waiting.len()
        );
        println!(
            "run {run}: {} ops, p50 {:?} p95 {:?} p99 {:?} max {:?}; total {:?} (merge {:?}, apply {:?}, check {:?}); {} bytes out",
            times.len(),
            percentile(&times, 0.5),
            percentile(&times, 0.95),
            percentile(&times, 0.99),
            times.last().copied().unwrap_or_default(),
            total,
            merge,
            apply,
            check,
            bytes
        );
    }
}
