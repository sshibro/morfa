//! The L2b steps as [`Stage`]s of the store path (the twins of the stages in `crate::lib`): sizing fixes, text
//! auto-resize, layout and group fitting, with the counters and the text cache kept between runs.

use std::sync::{Arc, Mutex, MutexGuard};

use morfa_model::draft::Ctx;
use morfa_model::store::Id;
use morfa_model::store::draft::{SlotSet, Stage, Working};

use crate::LayoutCounters;
use crate::auto_layout::{LayoutEngine, LayoutMemo, sizing_fixes};
use crate::text::{TextCache, TextMeasure};
use crate::{group_fit, parent_flow, text_resize};

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// What a stage keeps between runs: its counters and, for the stages that measure text, the text cache (shared by
/// the stages made with [`Kept::sharing_text`]: text resize and layout of one pipeline read the same layouts).
pub struct Kept {
    counters: Mutex<LayoutCounters>,
    text: Arc<Mutex<Option<TextCache>>>,
    /// The layout stage's settled roots (lane N1 step 9); empty for the other stages.
    layout: Mutex<LayoutMemo>,
}

impl std::fmt::Debug for Kept {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Kept")
            .field("counters", &self.counters())
            .finish_non_exhaustive()
    }
}

impl Default for Kept {
    fn default() -> Self {
        Self::new()
    }
}

impl Kept {
    pub fn new() -> Self {
        Self {
            counters: Mutex::new(LayoutCounters::ZERO),
            text: Arc::new(Mutex::new(None)),
            layout: Mutex::default(),
        }
    }

    /// New counters over the same text cache as `self`.
    pub fn sharing_text(&self) -> Self {
        Self {
            counters: Mutex::new(LayoutCounters::ZERO),
            text: Arc::clone(&self.text),
            layout: Mutex::default(),
        }
    }

    /// The counters summed over every run so far.
    pub fn counters(&self) -> LayoutCounters {
        *lock(&self.counters)
    }

    pub fn reset_counters(&self) {
        *lock(&self.counters) = LayoutCounters::ZERO;
    }

    /// Drops the text layouts and widths kept (fonts changed: text-layout.ts `forgetMeasurements`), and the settled
    /// roots (measured text is part of a layout).
    pub fn forget_text(&self) {
        *lock(&self.text) = None;
        self.forget_layout();
    }

    /// Drops the settled roots the layout stage remembers (the document was replaced).
    pub fn forget_layout(&self) {
        lock(&self.layout).clear();
    }

    /// How many roots the layout stage remembers as settled (tests).
    pub fn settled_roots(&self) -> usize {
        lock(&self.layout).len()
    }

    fn add(&self, by: LayoutCounters) {
        lock(&self.counters).add(by);
    }
}

/// Step 0 (`sizing`): `sizingFixes` for each dirty node, then each of its children (each read after the writes
/// before it).
#[derive(Debug, Default)]
pub struct SizingFixesStage;

impl SizingFixesStage {
    fn fix(draft: &mut Working, id: Id) {
        let Some(node) = draft.node(id) else {
            return;
        };
        if let Some(fixes) = sizing_fixes(node, parent_flow(draft, node)) {
            draft.update(id, |node| fixes.apply(node));
        }
    }
}

impl Stage for SizingFixesStage {
    fn name(&self) -> &'static str {
        "sizing"
    }

    fn run(&self, draft: &mut Working, dirty: &SlotSet, _ctx: &Ctx) -> SlotSet {
        draft.collect(|draft| {
            for id in dirty {
                let Some(node) = draft.node(id) else {
                    continue;
                };
                let children = node.children.clone();
                Self::fix(draft, id);
                for child in children.iter().flat_map(|children| children.iter()) {
                    Self::fix(draft, *child);
                }
            }
        })
    }
}

/// Step 1 (`textResize`): every dirty TEXT that sizes itself and is not in a flow takes its content's size.
#[derive(Debug, Default)]
pub struct TextResizeStage {
    pub kept: Kept,
}

impl Stage for TextResizeStage {
    fn name(&self) -> &'static str {
        "textResize"
    }

    fn run(&self, draft: &mut Working, dirty: &SlotSet, ctx: &Ctx) -> SlotSet {
        let mut cache = lock(&self.kept.text);
        let mut text =
            TextMeasure::with_cache(&*ctx.measurer, cache.get_or_insert_with(TextCache::new));
        let mut resized = 0;
        let written = draft.collect(|draft| {
            resized = text_resize::resize_texts(draft, dirty, &mut text);
        });
        self.kept.add(LayoutCounters {
            text_resized: resized,
            ..LayoutCounters::ZERO
        });
        written
    }
}

/// Step 3 (`layout`): lays out the auto-layout chains through the dirty ids. Returns the ids it wrote.
#[derive(Debug, Default)]
pub struct AutoLayoutStage {
    pub kept: Kept,
}

impl Stage for AutoLayoutStage {
    fn name(&self) -> &'static str {
        "layout"
    }

    fn run(&self, draft: &mut Working, dirty: &SlotSet, ctx: &Ctx) -> SlotSet {
        let mut cache = lock(&self.kept.text);
        let text =
            TextMeasure::with_cache(&*ctx.measurer, cache.get_or_insert_with(TextCache::new));
        let mut engine = LayoutEngine::trusting_off_paths(text, dirty);
        let mut memo = lock(&self.kept.layout);
        let written = draft.collect(|draft| engine.run_with(draft, dirty, Some(&mut memo)));
        drop(memo);
        self.kept.add(LayoutCounters {
            measured: engine.stats.measured,
            arranged: engine.stats.arranged,
            text_measured: engine.stats.text_measured,
            ..LayoutCounters::ZERO
        });
        written
    }
}

/// Step 4 (`groupFit`): the groups around the dirty ids fit their children; empty ones are removed.
#[derive(Debug, Default)]
pub struct GroupFitStage {
    pub kept: Kept,
}

impl Stage for GroupFitStage {
    fn name(&self) -> &'static str {
        "groupFit"
    }

    fn run(&self, draft: &mut Working, dirty: &SlotSet, _ctx: &Ctx) -> SlotSet {
        let mut fitted = 0;
        let written = draft.collect(|draft| fitted = group_fit::fit_groups(draft, dirty));
        self.kept.add(LayoutCounters {
            fitted,
            ..LayoutCounters::ZERO
        });
        written
    }
}

/// Writes nothing: the harness's own check.
#[derive(Debug, Default)]
pub struct Noop;

impl Stage for Noop {
    fn name(&self) -> &'static str {
        "noop"
    }

    fn run(&self, _draft: &mut Working, _dirty: &SlotSet, _ctx: &Ctx) -> SlotSet {
        SlotSet::new()
    }
}
