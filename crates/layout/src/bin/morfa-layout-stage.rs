//! The Rust side of the lane-local stage diff (`tests/helpers/stage-diff-l2b.ts`): one document is
//! loaded, then stages run on fresh working copies over it, each request a line of JSON on stdin and each
//! answer a line on stdout.
//!
//! ```text
//! {"cmd":"load","path":"doc.json"}                      → {"ok":true,"nodes":N}
//! {"cmd":"load","json":"{…}"}                           → the same, the document inline
//! {"cmd":"stage","stage":"layout","dirty":[ids]}   → {"ok":true,"written":[[id,node|null]…],"returned":[ids],"counters":{…}}
//! {"cmd":"normalize","dirty":[ids]}                     → normalize without instances and variables (steps 0, 1, 3, 4)
//! {"cmd":"layoutFrame","id":id}                         → `layoutFrame` (overlay, nothing trusted)
//! {"cmd":"groupFit","ids":[ids]}                        → `groupFitUpdates` (`returned`: the ids removed, in order)
//! {"cmd":"resize","id":id,"box":[x,y,w,h]}              → `resizeUpdates`
//! {"cmd":"scale","ids":[ids],"origin":[x,y],"sx":k,"sy":k} → `scaleUpdates`
//! {"cmd":"layoutSizing","id":id,"axis":"horizontal","sizing":"FILL"} → `layoutSizingUpdates`
//! {"cmd":"time","stage":…,"dirty":[ids],"runs":n}       → {"ok":true,"ns":[…]}: each run on a fresh working copy
//! ```
//! Stages (crates/layout/src/normalize.rs's names): `sizing`, `textResize`, `layout`, `groupFit`. Text is measured with the
//! fixed-width fake (`testMeasurer`). The document is held as the engine holds it (`store::Document`, lane N1); the
//! stages read its nodes by slot and the answers convert only what was written.

use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::time::Instant;

use indexmap::IndexSet;
use morfa_layout::auto_layout::{SizingAxis, set_layout_sizing};
use morfa_layout::constraints::{resize_by_hand, scale_by_tool};
use morfa_layout::geom::Rect;
use morfa_layout::geom::Vec2;
use morfa_layout::group_fit::fit_groups_removing;
use morfa_layout::text::TextMeasure;
use morfa_layout::{
    AutoLayoutStage, GroupFitStage, LayoutCounters, SizingFixesStage, TextResizeStage, auto_layout,
};
use morfa_model::draft::{Ctx, FixedWidthMeasurer};
use morfa_model::store::draft::{SlotSet, Stage, Working};
use morfa_model::store::{Document, Id};
use morfa_model::types::LayoutSizing;
use morfa_model::{from_json, to_json};
use serde_json::{Value, json};

fn keys_of(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|ids| {
            ids.iter()
                .filter_map(|id| id.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn written_json(draft: &Working) -> String {
    let mut out = String::from("[");
    for (i, (id, node)) in draft.changes().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push('[');
        out.push_str(&serde_json::to_string(draft.key(id)).unwrap());
        out.push(',');
        match node {
            Some(node) => out.push_str(&to_json(&draft.model_of(node))),
            None => out.push_str("null"),
        }
        out.push(']');
    }
    out.push(']');
    out
}

fn counters_json(c: LayoutCounters, rounds: u64) -> Value {
    json!({"measured": c.measured, "arranged": c.arranged, "textMeasured": c.text_measured, "textResized": c.text_resized, "fitted": c.fitted, "rounds": rounds})
}

fn answer(draft: &Working, returned: Option<&[Id]>, counters: Value) -> String {
    let returned = returned
        .map(|ids| {
            serde_json::to_string(&ids.iter().map(|&id| draft.key(id)).collect::<Vec<_>>()).unwrap()
        })
        .unwrap_or_else(|| "null".into());
    format!(
        "{{\"ok\":true,\"written\":{},\"returned\":{},\"counters\":{}}}",
        written_json(draft),
        returned,
        counters
    )
}

fn stage(name: &str) -> Option<Box<dyn StageWithCounters>> {
    Some(match name {
        "sizing" => Box::new(SizingFixesStage),
        "textResize" => Box::new(TextResizeStage::default()),
        "layout" => Box::new(AutoLayoutStage::default()),
        "groupFit" => Box::new(GroupFitStage::default()),
        _ => return None,
    })
}

trait StageWithCounters: Stage {
    fn counters(&self) -> LayoutCounters;
}
impl StageWithCounters for SizingFixesStage {
    fn counters(&self) -> LayoutCounters {
        LayoutCounters::default()
    }
}
impl StageWithCounters for TextResizeStage {
    fn counters(&self) -> LayoutCounters {
        self.kept.counters()
    }
}
impl StageWithCounters for AutoLayoutStage {
    fn counters(&self) -> LayoutCounters {
        self.kept.counters()
    }
}
impl StageWithCounters for GroupFitStage {
    fn counters(&self) -> LayoutCounters {
        self.kept.counters()
    }
}

/// normalize.ts `normalizeInto` for a design file without instances and variables: steps 0, 1, 3, 4.
fn normalize(draft: &mut Working, dirty: &SlotSet, ctx: &Ctx) -> (LayoutCounters, u64) {
    if dirty.is_empty() {
        return (LayoutCounters::default(), 0);
    }
    let mut touched = dirty.clone();
    let corrected = SizingFixesStage.run(draft, dirty, ctx);
    touched.extend(corrected.iter());
    let text = TextResizeStage::default();
    text.run(draft, &touched, ctx);
    let layout = AutoLayoutStage::default();
    let groups = GroupFitStage::default();
    let mut rounds = 0;
    let mut round = touched;
    for _ in 0..3 {
        rounds += 1;
        let laid_out = layout.run(draft, &round, ctx);
        let mut both = round.clone();
        both.extend(laid_out.iter());
        let fitted = groups.run(draft, &both, ctx);
        if fitted.is_empty() {
            break;
        }
        round = fitted;
    }
    let mut counters = text.kept.counters();
    counters.add(layout.kept.counters());
    counters.add(groups.kept.counters());
    (counters, rounds)
}

fn handle(line: &str, doc: &mut Option<Arc<Document>>, ctx: &Ctx) -> Result<String, String> {
    let request: Value = serde_json::from_str(line).map_err(|e| format!("bad request: {e}"))?;
    let cmd = request["cmd"].as_str().unwrap_or("");
    if cmd == "load" {
        let text = match request["path"].as_str() {
            Some(path) => std::fs::read_to_string(path).map_err(|e| e.to_string())?,
            None => request["json"]
                .as_str()
                .ok_or("load needs path or json")?
                .to_owned(),
        };
        let loaded = from_json(&text).map_err(|e| format!("{e:?}"))?;
        let nodes = loaded.nodes.len();
        *doc = Some(Arc::new(Document::from_model(&loaded)));
        return Ok(format!("{{\"ok\":true,\"nodes\":{nodes}}}"));
    }
    let base = doc.as_ref().ok_or("no document loaded")?;
    let mut draft = Working::new(Arc::clone(base));
    let out = match cmd {
        "stage" => {
            let name = request["stage"].as_str().unwrap_or("");
            let stage = stage(name).ok_or_else(|| format!("unknown stage {name}"))?;
            let dirty = draft.slot_set(keys_of(&request["dirty"]));
            let returned = stage.run(&mut draft, &dirty, ctx);
            answer(
                &draft,
                Some(returned.as_slice()),
                counters_json(stage.counters(), 0),
            )
        }
        "normalize" => {
            let dirty = draft.slot_set(keys_of(&request["dirty"]));
            let (counters, rounds) = normalize(&mut draft, &dirty, ctx);
            answer(&draft, None, counters_json(counters, rounds))
        }
        "layoutFrame" => {
            let id = draft.intern_id(request["id"].as_str().unwrap_or(""));
            let stats = auto_layout::layout_frame(&mut draft, id, TextMeasure::new(&*ctx.measurer));
            let counters = LayoutCounters {
                measured: stats.measured,
                arranged: stats.arranged,
                text_measured: stats.text_measured,
                ..Default::default()
            };
            answer(&draft, None, counters_json(counters, 0))
        }
        "groupFit" => {
            let ids: Vec<Id> = keys_of(&request["ids"])
                .iter()
                .map(|key| draft.intern_id(key))
                .collect();
            let mut removed = IndexSet::new();
            fit_groups_removing(&mut draft, ids, &mut removed);
            let removed: Vec<Id> = removed.into_iter().collect();
            answer(&draft, Some(&removed), Value::Null)
        }
        "resize" => {
            let id = draft.intern_id(request["id"].as_str().unwrap_or(""));
            let b: Vec<f64> = request["box"]
                .as_array()
                .map(|v| v.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            if b.len() != 4 {
                return Err("resize needs box [x,y,w,h]".into());
            }
            resize_by_hand(&mut draft, id, Rect::new(b[0], b[1], b[2], b[3]));
            answer(&draft, None, Value::Null)
        }
        "scale" => {
            // A list, not a set: an id listed twice is scaled twice, as in the TypeScript.
            let ids: Vec<Id> = keys_of(&request["ids"])
                .iter()
                .map(|key| draft.intern_id(key))
                .collect();
            let o: Vec<f64> = request["origin"]
                .as_array()
                .map(|v| v.iter().filter_map(Value::as_f64).collect())
                .unwrap_or_default();
            let (sx, sy) = (
                request["sx"].as_f64().unwrap_or(1.0),
                request["sy"].as_f64().unwrap_or(1.0),
            );
            let origin = Vec2 {
                x: o.first().copied().unwrap_or(0.0),
                y: o.get(1).copied().unwrap_or(0.0),
            };
            scale_by_tool(&mut draft, &ids, origin, sx, sy);
            answer(&draft, None, Value::Null)
        }
        "layoutSizing" => {
            let id = draft.intern_id(request["id"].as_str().unwrap_or(""));
            let axis = if request["axis"] == "vertical" {
                SizingAxis::Vertical
            } else {
                SizingAxis::Horizontal
            };
            let sizing = match request["sizing"].as_str() {
                Some("HUG") => LayoutSizing::Hug,
                Some("FILL") => LayoutSizing::Fill,
                _ => LayoutSizing::Fixed,
            };
            set_layout_sizing(&mut draft, id, axis, sizing);
            answer(&draft, None, Value::Null)
        }
        "time" => {
            let name = request["stage"].as_str().unwrap_or("");
            let keys = keys_of(&request["dirty"]);
            let runs = request["runs"].as_u64().unwrap_or(10);
            let mut ns = Vec::new();
            // One stage for every run: its text cache is kept, as an editor keeps its stages.
            let kept = stage(name);
            for run in 0..runs {
                let mut draft = Working::new(Arc::clone(base));
                let dirty = draft.slot_set(&keys);
                let start = Instant::now();
                // The first run warms the caches; a profiler collects `timed_run` only after it
                // (valgrind --tool=callgrind --collect-atstart=no --toggle-collect='*timed_run*').
                if run == 0 {
                    one_run(name, kept.as_deref(), &mut draft, &dirty, ctx);
                } else {
                    timed_run(name, kept.as_deref(), &mut draft, &dirty, ctx);
                }
                ns.push(start.elapsed().as_nanos() as u64);
            }
            json!({"ok": true, "ns": ns}).to_string()
        }
        _ => return Err(format!("unknown command {cmd}")),
    };
    Ok(out)
}

fn one_run(
    name: &str,
    stage: Option<&dyn StageWithCounters>,
    draft: &mut Working,
    dirty: &SlotSet,
    ctx: &Ctx,
) {
    if name == "normalize" {
        normalize(draft, dirty, ctx);
    } else if let Some(stage) = stage {
        stage.run(draft, dirty, ctx);
    }
}

#[inline(never)]
fn timed_run(
    name: &str,
    stage: Option<&dyn StageWithCounters>,
    draft: &mut Working,
    dirty: &SlotSet,
    ctx: &Ctx,
) {
    one_run(name, stage, draft, dirty, ctx);
}

fn main() {
    let ctx = Ctx {
        measurer: Box::new(FixedWidthMeasurer),
    };
    let mut doc: Option<Arc<Document>> = None;
    let stdin = io::stdin();
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let out = match handle(&line, &mut doc, &ctx) {
            Ok(out) => out,
            Err(error) => json!({"ok": false, "error": error}).to_string(),
        };
        writeln!(stdout, "{out}").unwrap();
        stdout.flush().unwrap();
    }
}
