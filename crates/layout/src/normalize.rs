//! The normalize orchestrator on the store path: `normalizeDocument` of `shared/design/normalize.ts` over a
//! [`Working`]. The stages and their order are the TypeScript's (sizing → text →
//! instances → variables → text again on what they wrote → rounds of layout + group fit).

use std::cell::RefCell;

use morfa_model::draft::Ctx;
use morfa_model::store::draft::{SlotSet, Stage, Working};

use crate::instances::stage::{ApplyVariables, InstanceSync, sync_with, variables_with};
use crate::instances::sync::{Derived, InstanceIndex};
use crate::instances::variables::VariableUsage;
use crate::stages::{AutoLayoutStage, GroupFitStage, Noop, SizingFixesStage, TextResizeStage};

/// The TS steps in order (rounds of `layout` + `groupFit` repeat, at most [`MAX_ROUNDS`]).
pub const STAGES: [&str; 6] = [
    "sizing",
    "textResize",
    "instances",
    "variables",
    "layout",
    "groupFit",
];

/// normalize.ts `MAX_ROUNDS`.
pub const MAX_ROUNDS: usize = 3;

/// The TS name of a step under any of its names (L2b's lane-local names).
pub fn canonical(name: &str) -> &str {
    match name {
        "sizing-fixes" => "sizing",
        "text-resize" => "textResize",
        "sync" => "instances",
        "auto-layout" => "layout",
        "group-fit" => "groupFit",
        other => other,
    }
}

/// Indexes a long-lived document keeps for the instance and variable steps (the shadow document's, crates/wasm), as
/// TypeScript keeps them per node table (table-cache.ts). Asked at the step, each answers for the draft as it stands
/// then, or `None`: the step builds its own by a scan of the draft.
pub trait Indexes {
    /// component → instances, in table order.
    fn instances(&mut self, draft: &Working) -> Option<&InstanceIndex>;
    /// variable → bound nodes, in table order.
    fn usage(&mut self, draft: &Working) -> Option<&VariableUsage>;
}

/// A new instance of the store-path stage of this name (the TypeScript step names and L2b's aliases), `None` for an
/// unknown name.
pub fn stage(name: &str) -> Option<Box<dyn Stage>> {
    match canonical(name) {
        "noop" => Some(Box::new(Noop)),
        "sizing" => Some(Box::new(SizingFixesStage)),
        "textResize" => Some(Box::new(TextResizeStage::default())),
        "instances" => Some(Box::new(InstanceSync)),
        "variables" => Some(Box::new(ApplyVariables)),
        "layout" => Some(Box::new(AutoLayoutStage::default())),
        "groupFit" => Some(Box::new(GroupFitStage::default())),
        _ => None,
    }
}

/// Runs one stage alone on `draft` (the stage oracle), with kept indexes for the instance and variable steps when
/// given. The ids it reports.
pub fn run_stage_with(
    name: &str,
    draft: &mut Working,
    dirty: &SlotSet,
    ctx: &Ctx,
    indexes: Option<&mut dyn Indexes>,
) -> Result<SlotSet, String> {
    let name = canonical(name);
    let stage = stage(name).ok_or_else(|| {
        format!(
            "stage '{name}' is not ported to the store yet (crates/layout/src/store/normalize.rs)"
        )
    })?;
    Ok(match (stage.name(), indexes) {
        ("instances", Some(indexes)) => {
            let index = if dirty.is_empty() {
                None
            } else {
                indexes.instances(draft)
            };
            sync_with(draft, dirty, index, None)
        }
        ("variables", Some(indexes)) => {
            let usage = if dirty.is_empty() || draft.variables().is_empty() {
                None
            } else {
                indexes.usage(draft)
            };
            variables_with(draft, dirty, usage)
        }
        _ => stage.run(draft, dirty, ctx),
    })
}

/// The six stages of one normalize, kept between calls by a long-lived document (the shadow, crates/wasm): text resize
/// and layout share one text cache, and the instance step keeps its identity cache ([`Derived`]).
pub struct Pipeline {
    sizing: SizingFixesStage,
    text: TextResizeStage,
    layout: AutoLayoutStage,
    group_fit: GroupFitStage,
    derived: RefCell<Derived>,
}

impl Default for Pipeline {
    fn default() -> Self {
        Self::new()
    }
}

impl std::fmt::Debug for Pipeline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pipeline").finish_non_exhaustive()
    }
}

impl Pipeline {
    pub fn new() -> Self {
        let text = TextResizeStage::default();
        let layout = AutoLayoutStage {
            kept: text.kept.sharing_text(),
        };
        Self {
            sizing: SizingFixesStage,
            text,
            layout,
            group_fit: GroupFitStage::default(),
            derived: RefCell::new(Derived::default()),
        }
    }

    /// Drops the text layouts and widths kept (fonts changed), and the layout stage's settled roots with them.
    pub fn forget_text(&self) {
        self.text.kept.forget_text();
        self.layout.kept.forget_layout();
    }

    /// Drops the identity cache of the instance step and the layout stage's settled roots (the document was
    /// replaced).
    pub fn forget_derived(&self) {
        self.derived.borrow_mut().clear();
        self.layout.kept.forget_layout();
    }

    /// How many roots the layout stage remembers as settled (tests).
    pub fn settled_roots(&self) -> usize {
        self.layout.kept.settled_roots()
    }

    /// How many copies the identity cache knows (tests).
    pub fn derived_len(&self) -> usize {
        self.derived.borrow().len()
    }

    /// How many top-level instances the instance step knows up to date (tests).
    pub fn derived_roots(&self) -> usize {
        self.derived.borrow().roots_len()
    }

    /// normalize.ts `normalizeInto`: every stage in order, then layout and group fitting in rounds until groups stop
    /// moving. Every id written.
    pub fn run(
        &self,
        draft: &mut Working,
        dirty: &SlotSet,
        ctx: &Ctx,
        mut indexes: Option<&mut dyn Indexes>,
    ) -> SlotSet {
        let mut touched = dirty.clone();
        for stage in [&self.sizing as &dyn Stage, &self.text] {
            let reported = stage.run(draft, &touched, ctx);
            touched.extend(reported.iter());
        }
        // Text is sized again only where instances and variables wrote (and the former parents of removed copies), as
        // normalize.ts's `again`: a text they did not touch keeps what step 1 decided, even if its parent's flow
        // changed.
        let mut again = SlotSet::new();
        let synced = {
            let index = match indexes.as_deref_mut() {
                Some(indexes) if !touched.is_empty() => indexes.instances(draft),
                _ => None,
            };
            let mut derived = self.derived.borrow_mut();
            sync_with(draft, &touched, index, Some(&mut derived))
        };
        again.extend(synced.iter());
        touched.extend(synced.iter());
        let resolved = {
            let usage = match indexes {
                Some(indexes) if !touched.is_empty() && !draft.variables().is_empty() => {
                    indexes.usage(draft)
                }
                _ => None,
            };
            variables_with(draft, &touched, usage)
        };
        again.extend(resolved.iter());
        touched.extend(resolved.iter());
        self.text.run(draft, &again, ctx);
        let mut round = touched;
        for _ in 0..MAX_ROUNDS {
            let laid_out = self.layout.run(draft, &round, ctx);
            let mut fit_input = round.clone();
            fit_input.extend(laid_out.iter());
            let fitted = self.group_fit.run(draft, &fit_input, ctx);
            if fitted.is_empty() {
                break;
            }
            round = fitted;
        }
        draft.written().collect()
    }
}

/// `normalizeDetailed` on a fresh pipeline (tests and the stage oracle). Every id written.
pub fn normalize(draft: &mut Working, dirty: &SlotSet, ctx: &Ctx) -> SlotSet {
    Pipeline::new().run(draft, dirty, ctx, None)
}
