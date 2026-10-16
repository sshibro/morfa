import type {NodeId, SceneNode} from '../../../../shared/design/types';
import {FLATTEN_REASONS, toVector} from '../../../../shared/design/flatten';
import {outlineStrokeNode} from '../../../../shared/design/outline-stroke';
import {editableStructure} from '../selection';
import type {DesignStore} from '../store';
import {editedVectorId, notify} from '../vector-edit/session';
import type {Command} from './registry';
import {removeNodes} from './structure';

// The vector commands: the pen and pencil tools (P, ⇧P), "Flatten" (⌘E: shapes, booleans, groups
// and frames of them become one VECTOR, shared/design/flatten.ts) and "Outline stroke" (⌥⌘O, as in Figma: a
// stroke becomes a filled vector, shared/design/outline-stroke.ts). Text has no glyph outlines
// here, so both leave it as it is and say so.

export const VECTOR_MESSAGES = {
  outlineText: 'Text cannot be converted to outlines: the letter outlines are unavailable',
  outlineNothing: 'The selected layers have no visible stroke',
} as const;

/** The reason shared/design/flatten.ts gives for skipped text: compared with the skipped entries, so it is taken from there. */
const TEXT_REASON: string = FLATTEN_REASONS.text;

/** "Flatten": one VECTOR in place of the selection. Text inside a flattened group is kept, moved
 *  out above the vector. Returns the vector's id, or null with a message. */
export function flattenSelection(store: DesignStore): NodeId | null {
  const {doc, selection} = store.getState();
  const ids = editableStructure(doc, selection);
  if (!ids.length) return null;
  if (ids.length === 1 && doc.nodes[ids[0]].type === 'VECTOR') return ids[0];
  const result = toVector(doc, ids);
  const reasons = [...new Set(result.skipped.map(each => each.reason))];
  if ('error' in result) {
    // "Nothing to flatten" because it was all text says so.
    notify(store, reasons.includes(TEXT_REASON) ? TEXT_REASON : result.error);
    return null;
  }
  const roots = new Set(result.remove);
  // Text inside a flattened group would go with it: it moves out and stays a text.
  const rescued = result.skipped.filter(each => each.reason === TEXT_REASON && !roots.has(each.id) && doc.nodes[each.id]).map(each => each.id);
  store.transact('Flatten', tx => {
    const formerParents = new Set<NodeId>();
    for (const id of result.remove) if (tx.get(id)?.parentId) formerParents.add(tx.get(id)!.parentId!);
    for (const id of rescued) tx.move(id, result.parentId);
    for (const id of result.remove) tx.remove(id);
    tx.create(result.node, result.parentId, result.index);
    rescued.forEach((id, k) => tx.reorder(id, result.index + 1 + k));
    const empty = [...formerParents].filter(id => {
      const node = tx.get(id);
      return id !== result.parentId && !!node && (node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION') && !node.children?.length;
    });
    if (empty.length) removeNodes(tx, empty);
  }, {select: [result.node.id]});
  if (reasons.length) notify(store, reasons.includes(TEXT_REASON) ? TEXT_REASON : reasons.join('. '));
  return result.node.id;
}

/** "Outline stroke" for every selected layer with a visible stroke. Returns the new layers. */
export function outlineStrokeSelection(store: DesignStore): NodeId[] {
  const {doc, selection} = store.getState();
  const ids = editableStructure(doc, selection);
  if (!ids.length) return [];
  const texts = ids.filter(id => doc.nodes[id].type === 'TEXT');
  const created: NodeId[] = [];
  const untouched: NodeId[] = [];
  store.transact('Outline stroke', tx => {
    for (const id of ids) {
      if (doc.nodes[id].type === 'TEXT') {
        untouched.push(id);
        continue;
      }
      const outcome = outlineStrokeNode(tx.doc, id);
      if (!outcome) {
        untouched.push(id);
        continue;
      }
      tx.remove(id);
      const [root, ...rest] = outcome.nodes;
      tx.create(root, outcome.parentId, outcome.index);
      for (const node of rest) tx.create(node, node.parentId!);
      created.push(outcome.rootId);
    }
    return created.length ? {select: [...created, ...untouched]} : undefined;
  });
  if (texts.length) notify(store, VECTOR_MESSAGES.outlineText);
  else if (!created.length) notify(store, VECTOR_MESSAGES.outlineNothing);
  return created;
}

const hasOutline = (node: SceneNode | undefined) => !!node && node.type !== 'TEXT' && node.type !== 'SLICE';

export const VECTOR_COMMANDS: Command[] = [
  {id: 'tool-pen', label: 'Pen', group: 'tools', shortcut: {code: 'KeyP'}, run: ctx => ctx.store.setTool('pen')},
  {id: 'tool-pencil', label: 'Pencil', group: 'tools', shortcut: {code: 'KeyP', shift: true}, run: ctx => ctx.store.setTool('pencil')},
  {
    id: 'object.flatten',
    label: 'Flatten',
    group: 'boolean',
    shortcut: {code: 'KeyE', mod: true},
    // Text alone stays enabled so the command can say why nothing happens.
    enabled: ctx => !editedVectorId(ctx.store.getState()) && editableStructure(ctx.store.getState().doc, ctx.store.getState().selection).length > 0,
    run: ctx => void flattenSelection(ctx.store),
  },
  {
    id: 'object.outline-stroke',
    label: 'Outline stroke',
    group: 'vector',
    shortcut: {code: 'KeyO', mod: true, alt: true},
    enabled: ctx => {
      const {doc, selection} = ctx.store.getState();
      return !editedVectorId(ctx.store.getState()) && editableStructure(doc, selection).some(id => hasOutline(doc.nodes[id]) || doc.nodes[id].type === 'TEXT');
    },
    run: ctx => void outlineStrokeSelection(ctx.store),
  },
];
