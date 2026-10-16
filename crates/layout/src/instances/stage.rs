//! The instance and variable steps as [`Stage`]s of the store path (normalize.ts step 2): sync, then variables, each
//! writing straight into the [`Working`].

use morfa_model::draft::Ctx;
use morfa_model::store::draft::{SlotSet, Stage, Working};

use super::sync::{Derived, InstanceIndex, sync_draft};
use super::variables::{VariableUsage, apply_variables_in};

/// `syncInstancesDetailed` as a stage (no kept index, no identity cache: the oracle's fresh run).
#[derive(Clone, Copy, Debug, Default)]
pub struct InstanceSync;

impl Stage for InstanceSync {
    fn name(&self) -> &'static str {
        "instances"
    }

    fn run(&self, draft: &mut Working, dirty: &SlotSet, _ctx: &Ctx) -> SlotSet {
        sync_with(draft, dirty, None, None)
    }
}

/// The instance step with what a long-lived document keeps: the ids written and the former parents of removed copies.
pub fn sync_with(
    draft: &mut Working,
    dirty: &SlotSet,
    index: Option<&InstanceIndex>,
    derived: Option<&mut Derived>,
) -> SlotSet {
    let synced = sync_draft(draft, dirty, index, derived);
    let mut out = synced.changed;
    out.extend(synced.former_parents.iter());
    out
}

/// `applyVariablesDetailed` as a stage.
#[derive(Clone, Copy, Debug, Default)]
pub struct ApplyVariables;

impl Stage for ApplyVariables {
    fn name(&self) -> &'static str {
        "variables"
    }

    fn run(&self, draft: &mut Working, dirty: &SlotSet, _ctx: &Ctx) -> SlotSet {
        apply_variables_in(draft, dirty, None)
    }
}

/// The variable step with the kept usage.
pub fn variables_with(
    draft: &mut Working,
    dirty: &SlotSet,
    usage: Option<&VariableUsage>,
) -> SlotSet {
    apply_variables_in(draft, dirty, usage)
}
