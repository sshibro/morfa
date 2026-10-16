//! `morfa-layout`: the layout stages of normalization (lane L2b: auto layout, constraints, group fit, text
//! auto-resize; lane L2c: instances, variants, variables), on the store's own nodes (lane N1).
//!
//! Each stage is a [`Stage`] of `crates/model` over a [`Working`] (the shadow document's working copy), the Rust twin
//! of one step of `normalizeInto` (`shared/design/normalize.ts`), and writes exactly the entries the TypeScript writes
//! (numbers bit-equal with the fixed-width fake measurer). The stages read [`Node`]s by [`Id`] and write fields; a
//! node is never converted to the JSON model on the way. The orchestrator (`normalize.rs`, the coordinator's) owns the
//! order and the layout/group-fit rounds:
//!
//! 0. [`SizingFixesStage`]: sizing fields that no longer apply are corrected (the dirty nodes and their children).
//! 1. [`TextResizeStage`]: text that sizes itself, outside a flow (run again after instances and variables on the ids
//!    they wrote).
//! 2. `instances::stage::InstanceSync`, `instances::stage::ApplyVariables`: copies take their mains, bound fields
//!    their variables' values.
//! 3. [`AutoLayoutStage`]: the auto-layout chains through the dirty ids; everything off the changed paths is trusted
//!    to be laid out already.
//! 4. [`GroupFitStage`]: groups around the dirty ids fit their children (normalize passes it the round's ids and what
//!    layout wrote).

use morfa_model::store::draft::Working;
use morfa_model::store::{Id, Node, Prop};
use morfa_model::types::{LayoutMode, TextAutoResize};

pub mod auto_layout;
pub mod constraints;
pub mod geom;
pub mod group_fit;
pub mod instances;
pub mod math;
pub mod normalize;
pub mod stages;
pub mod text;
pub mod text_resize;

pub use morfa_model::store::draft::Stage;
pub use stages::{AutoLayoutStage, GroupFitStage, Kept, SizingFixesStage, TextResizeStage};

use crate::geom::Placement;

/// This crate's name, as the gate's smoke test reads it.
pub const CRATE: &str = env!("CARGO_PKG_NAME");

/// The counters of `NormalizeStats` the layout stages keep (tests and profiling).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LayoutCounters {
    /// Container layouts computed (memo misses).
    pub measured: u64,
    /// Frames arranged (written).
    pub arranged: u64,
    /// Text sizes measured by layout (memo misses).
    pub text_measured: u64,
    /// Texts resized by the text auto-resize stage.
    pub text_resized: u64,
    /// Groups visited by group fitting.
    pub fitted: u64,
}

impl LayoutCounters {
    pub const ZERO: Self = Self {
        measured: 0,
        arranged: 0,
        text_measured: 0,
        text_resized: 0,
        fitted: 0,
    };

    pub fn add(&mut self, other: LayoutCounters) {
        self.measured += other.measured;
        self.arranged += other.arranged;
        self.text_measured += other.text_measured;
        self.text_resized += other.text_resized;
        self.fitted += other.fitted;
    }
}

/// A frame-like node whose children are placed by auto layout (`isAutoLayout`).
#[inline]
pub fn is_auto_layout(node: Option<&Node>) -> bool {
    node.is_some_and(|node| {
        node.kind.is_frame_like()
            && node
                .props
                .auto_layout()
                .is_some_and(|layout| layout.layout_mode != LayoutMode::None)
    })
}

/// Whether the node is a flow child of an auto-layout frame (its parent's `isAutoLayout`).
#[inline]
pub fn parent_flow(draft: &Working, node: &Node) -> bool {
    is_auto_layout(node.parent.and_then(|id| draft.node(id)))
}

/// What `localMatrix` and `boundsOf` read of a node.
#[inline]
pub fn placement(node: &Node) -> Placement {
    Placement {
        x: node.x,
        y: node.y,
        width: node.width,
        height: node.height,
        rotation: node.rotation,
        flip_x: node.props.flip_x() == Some(&true),
        flip_y: node.props.flip_y() == Some(&true),
    }
}

/// `node.text.textAutoResize = mode` on a stored node: its text (shared with the version it came from) is copied
/// once and the copy takes the mode. Nothing for a node without text.
pub fn set_text_auto_resize(node: &mut Node, mode: TextAutoResize) {
    if let Some(text) = node.props.text() {
        if text.text_auto_resize == mode {
            return;
        }
        let mut text = std::sync::Arc::clone(text);
        std::sync::Arc::make_mut(&mut text).text_auto_resize = mode;
        node.props.set(Prop::Text(text));
    }
}

/// `node.parentId` as the draft resolves it.
#[inline]
pub fn parent_of<'d>(draft: &'d Working, node: &Node) -> Option<&'d Node> {
    node.parent.and_then(|id| draft.node(id))
}

/// How deep a node sits (the number of ancestors).
pub fn depth_of(draft: &Working, id: Id) -> usize {
    let mut depth = 0;
    let mut node = draft.node(id);
    while let Some(current) = node {
        let Some(parent) = current.parent else {
            break;
        };
        depth += 1;
        node = draft.node(parent);
    }
    depth
}

#[cfg(test)]
mod tests {
    #[test]
    fn names_itself() {
        assert_eq!(super::CRATE, "morfa-layout");
    }
}
