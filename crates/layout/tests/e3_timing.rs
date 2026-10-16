//! Native stage timings of a TARGETS E3 commit: `MORFA_E3_DIR` holds the dumped files (doc.json; patch-2.json, fields-2.json, dirty-2.json). Without it the test passes doing nothing. Run with
//! `cargo test --release -p morfa-layout --test e3_timing -- --nocapture`.

use std::sync::Arc;
use std::time::Instant;

use morfa_layout::instances::sync::InstanceIndex;
use morfa_layout::instances::variables::VariableUsage;
use morfa_layout::normalize::{Indexes, Pipeline, STAGES, run_stage_with};
use morfa_model::draft::Ctx;
use morfa_model::store::Document;
use morfa_model::store::draft::{SlotSet, Working};
use morfa_model::{from_json, patch_from_json};

struct Kept {
    instances: Option<InstanceIndex>,
}

impl Indexes for Kept {
    fn instances(&mut self, draft: &Working) -> Option<&InstanceIndex> {
        if self.instances.is_none() {
            self.instances = Some(InstanceIndex::build(draft));
        }
        self.instances.as_ref()
    }
    fn usage(&mut self, _draft: &Working) -> Option<&VariableUsage> {
        None
    }
}

fn ms(duration: std::time::Duration) -> f64 {
    duration.as_secs_f64() * 1000.0
}

#[test]
fn e3_stage_timings() {
    let Ok(dir) = std::env::var("MORFA_E3_DIR") else {
        return;
    };
    let read = |name: &str| std::fs::read_to_string(format!("{dir}/{name}")).expect(name);
    let model = from_json(&read("doc.json")).expect("doc");
    let doc = Arc::new(Document::from_model(&model));
    let patch = patch_from_json(&read("patch-2.json")).expect("patch");
    let fields = read("fields-2.json");
    let dirty: Vec<String> = serde_json::from_str(&read("dirty-2.json")).expect("dirty");
    let ctx = Ctx::default();
    let fresh = || {
        let mut working = Working::new(Arc::clone(&doc));
        working.lay_over(&patch);
        if !fields.is_empty() {
            for (id, fields) in morfa_model::json::node_fields_from_json(&fields).expect("fields") {
                working.lay_over_fields(&id, fields).expect("fields");
            }
        }
        working
    };
    eprintln!(
        "e3: {} nodes, patch {} chars, fields {} chars, dirty {:?}",
        doc.len(),
        read("patch-2.json").len(),
        fields.len(),
        dirty
    );

    // Stage by stage in the pipeline's order, the dirty set widened as it goes (indexes kept, as the shadow keeps them).
    let mut kept = Kept { instances: None };
    let mut working = fresh();
    let started = Instant::now();
    let mut touched = working.slot_set(dirty.iter());
    eprintln!("  slot_set: {:.3} ms", ms(started.elapsed()));
    let _ = kept.instances(&working);
    for name in STAGES {
        let started = Instant::now();
        let reported =
            run_stage_with(name, &mut working, &touched, &ctx, Some(&mut kept)).expect("stage");
        let took = started.elapsed();
        touched.extend(reported.iter());
        eprintln!(
            "  {name:>11}: {:.3} ms, reported {}, written so far {}",
            ms(took),
            reported.len(),
            working.written().len()
        );
    }

    // The whole pipeline, cold then warm (the identity cache of the instance step filled by the first run).
    let pipeline = Pipeline::new();
    for round in 0..4 {
        let mut working = fresh();
        let dirty = working.slot_set(dirty.iter());
        let started = Instant::now();
        let written = pipeline.run(&mut working, &dirty, &ctx, Some(&mut kept));
        let ran = started.elapsed();
        let started = Instant::now();
        let (entry, _slots) = working.into_entry_and_slots();
        let entered = started.elapsed();
        let mut shadow = (*doc).clone();
        let started = Instant::now();
        shadow.replay(&entry).expect("replay");
        let replayed = started.elapsed();
        eprintln!(
            "  pipeline round {round}: run {:.3} ms ({} written, derived {}), into_entry {:.3} ms ({} entry nodes), replay {:.3} ms",
            ms(ran),
            written.len(),
            pipeline.derived_len(),
            ms(entered),
            entry.nodes.len(),
            ms(replayed)
        );
    }
    let _ = SlotSet::new();
}
