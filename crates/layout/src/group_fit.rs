//! GROUP and BOOLEAN_OPERATION boxes fit their children (`shared/design/group-fit.ts`) on store nodes: the twin of
//! `crate::group_fit`.

use indexmap::IndexSet;
use morfa_model::draft::same_f64;
use morfa_model::store::draft::Working;
use morfa_model::store::{Id, Node};
use morfa_model::types::NodeType;
use rustc_hash::FxHashMap;

use crate::constraints::{bounds_of, truthy};
use crate::geom;
use crate::placement;

#[inline]
pub fn is_group_like(node: Option<&Node>) -> bool {
    node.is_some_and(|node| matches!(node.kind, NodeType::Group | NodeType::BooleanOperation))
}

/// Refits one group to its children. Returns whether its box changed.
fn fit_group(draft: &mut Working, id: Id) -> bool {
    let Some(group) = draft.node(id) else {
        return false;
    };
    let children: Vec<(Id, f64, f64)> = group
        .children()
        .iter()
        .filter_map(|child| draft.node(*child))
        .map(|child| (child.id, child.x, child.y))
        .collect();
    let union = geom::union_rects(
        group
            .children()
            .iter()
            .filter_map(|child| draft.node(*child))
            .map(|child| bounds_of(&placement(child))),
    );
    let Some(union) = union else {
        return false;
    };
    if same_f64(union.x, 0.0)
        && same_f64(union.y, 0.0)
        && same_f64(union.width, group.width)
        && same_f64(union.height, group.height)
    {
        return false;
    }
    // The new box must map its local origin where the old box mapped (union.x, union.y); rotation and flips stay, so
    // only the translation is solved for (flips turn about the new centre).
    let placement = placement(group);
    let target = geom::multiply(
        &geom::local_matrix(&placement),
        &geom::translation(union.x, union.y),
    );
    let zero = geom::local_matrix(&placement.with_box(0.0, 0.0, union.width, union.height));
    let (x, y) = (target[0][2] - zero[0][2], target[1][2] - zero[1][2]);
    draft.update_box(id, Some(x), Some(y), Some(union.width), Some(union.height));
    if truthy(union.x) || truthy(union.y) {
        for (child, x, y) in children {
            let (nx, ny) = (x - union.x, y - union.y);
            if draft
                .node(child)
                .is_some_and(|child| !same_f64(child.x, nx) || !same_f64(child.y, ny))
            {
                draft.update_box(child, Some(nx), Some(ny), None, None);
            }
        }
    }
    true
}

/// `fitGroups`: refits every group that contains one of `ids` (or is one), innermost first, removing empty ones.
/// `ids` may name removed nodes; their former parents must be listed too. Returns the number of groups visited
/// (`stats.fitted`).
pub fn fit_groups(draft: &mut Working, ids: impl IntoIterator<Item = Id>) -> u64 {
    fit_groups_removing(draft, ids, &mut IndexSet::new())
}

/// [`fit_groups`], also listing what it removed in the order TS's `Draft.removed` lists it (its `gone` set): for
/// each emptied group, the ids in its children list (none of which exists) and then the group.
pub fn fit_groups_removing(
    draft: &mut Working,
    ids: impl IntoIterator<Item = Id>,
    removed: &mut IndexSet<Id>,
) -> u64 {
    let mut groups: IndexSet<Id> = IndexSet::new();
    for id in ids {
        let mut node = draft.node(id);
        if node.is_some_and(|node| !is_group_like(Some(node))) {
            node = node
                .and_then(|node| node.parent)
                .and_then(|id| draft.node(id));
        }
        while let Some(current) = node {
            if !is_group_like(Some(current)) || groups.contains(&current.id) {
                break;
            }
            groups.insert(current.id);
            node = current.parent.and_then(|id| draft.node(id));
        }
    }
    if groups.is_empty() {
        return 0;
    }
    let mut depth: FxHashMap<Id, usize> = FxHashMap::default();
    depth.reserve(groups.len());
    for &id in &groups {
        depth.insert(id, super::depth_of(draft, id));
    }
    let mut ordered: Vec<Id> = groups.iter().copied().collect();
    ordered.sort_by(|a, b| depth[b].cmp(&depth[a]));
    let mut fitted = 0;
    for id in ordered {
        let Some(group) = draft.node(id) else {
            continue;
        };
        fitted += 1;
        let empty = !group.children().iter().any(|child| draft.contains(*child));
        if empty {
            for child in group.children() {
                removed.insert(*child);
            }
            removed.insert(id);
            draft.remove(id);
        } else {
            fit_group(draft, id);
        }
    }
    fitted
}

/// `groupFitUpdates`: the groups around `ids` refitted in `draft`, and the ids removed in `Draft.removed`'s order.
pub fn group_fit_in(draft: &mut Working, ids: &[Id]) -> Vec<Id> {
    let mut removed = IndexSet::new();
    fit_groups_removing(draft, ids.iter().copied(), &mut removed);
    removed.into_iter().collect()
}
