import type {DesignDocument, LayoutSizing, NodeId, SceneNode} from '../../../../../shared/design/types';
import {canFill, canHug, effectiveSizing, layoutSizingUpdates, type SizingAxis} from '../../../../../shared/design/layout';
import {isAutoLayout, type NodeUpdates} from '../../../../../shared/design/constraints';
import {mixedOf, type Mixed} from '../shared/mixed';

// The "Fixed / Hug / Fill" dropdowns and the min/max limits of the "Position" section.
// Choices go through `layoutSizingUpdates` (shared/design/layout.ts), which keeps text resize
// modes in step and turns a hugging parent fixed when a child fills its main axis; this module only
// decides what to offer and folds a multi-selection into one set of updates.

export const SIZING_LABELS: Record<LayoutSizing, string> = {FIXED: 'Fixed', HUG: 'Hug', FILL: 'Fill'};
export const SIZING_MENU: Record<SizingAxis, Record<LayoutSizing, string>> = {
  horizontal: {FIXED: 'Fixed width', HUG: 'Hug contents', FILL: 'Fill container'},
  vertical: {FIXED: 'Fixed height', HUG: 'Hug contents', FILL: 'Fill container'},
};

export type SizingChoice = {value: Mixed<LayoutSizing>; hug: boolean; fill: boolean};

/** Whether the sizing row applies: auto-layout frames, their flow children and text. */
export function showsSizing(doc: DesignDocument, nodes: readonly SceneNode[]): boolean {
  return nodes.length > 0 && nodes.every(node => node.type === 'TEXT' || isAutoLayout(node) || canFill(node, doc.nodes[node.parentId ?? '']));
}

/** The dropdown of one axis: the current sizing of the selection and which options every node can take. */
export function sizingChoice(doc: DesignDocument, nodes: readonly SceneNode[], axis: SizingAxis): SizingChoice {
  return {
    value: mixedOf(nodes.map(node => effectiveSizing(node, doc.nodes[node.parentId ?? ''], axis))),
    hug: nodes.length > 0 && nodes.every(node => canHug(node)),
    fill: nodes.length > 0 && nodes.every(node => canFill(node, doc.nodes[node.parentId ?? ''], axis)),
  };
}

/** One choice applied to every node in turn (each sees the previous ones' changes), as one set of
 *  updates. A node that cannot take the option is left alone. */
export function selectionSizingUpdates(doc: DesignDocument, ids: readonly NodeId[], axis: SizingAxis, sizing: LayoutSizing): NodeUpdates {
  let current = doc;
  const merged: NodeUpdates = new Map();
  for (const id of ids) {
    const updates = layoutSizingUpdates(current, id, axis, sizing);
    if (!updates.size) continue;
    const nodes = {...current.nodes};
    for (const [nodeId, partial] of updates) {
      nodes[nodeId] = {...nodes[nodeId], ...partial} as SceneNode;
      merged.set(nodeId, {...merged.get(nodeId), ...partial});
    }
    current = {...current, nodes};
  }
  return merged;
}

export type LimitField = 'minWidth' | 'maxWidth' | 'minHeight' | 'maxHeight';
export const LIMIT_FIELDS: readonly LimitField[] = ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'];
export const LIMIT_LABELS: Record<LimitField, string> = {minWidth: 'Min width', maxWidth: 'Max width', minHeight: 'Min height', maxHeight: 'Max height'};
export const LIMIT_ADD: Record<LimitField, string> = {minWidth: 'Add min width', maxWidth: 'Add max width', minHeight: 'Add min height', maxHeight: 'Add max height'};
export const LIMIT_REMOVE: Record<LimitField, string> = {minWidth: 'Remove min width', maxWidth: 'Remove max width', minHeight: 'Remove min height', maxHeight: 'Remove max height'};
export const limitAxis = (field: LimitField): SizingAxis => (field === 'minWidth' || field === 'maxWidth' ? 'horizontal' : 'vertical');

/** Limits apply where layout sizes the node: auto-layout frames and flow children (Figma's rule). */
export function canLimit(doc: DesignDocument, node: SceneNode): boolean {
  return isAutoLayout(node) || canFill(node, doc.nodes[node.parentId ?? '']);
}

/** The limit's value across the selection: set on some only counts as mixed. */
export function limitValue(nodes: readonly SceneNode[], field: LimitField): Mixed<number> | undefined {
  const values = nodes.map(node => node[field] ?? null);
  if (values.every(value => value === null)) return undefined;
  if (values.some(value => value === null)) return 'mixed';
  return mixedOf(values as number[]);
}

/** A new limit starts at the node's current size on that axis. */
export const limitStart = (node: SceneNode, field: LimitField) => (limitAxis(field) === 'horizontal' ? node.width : node.height);
