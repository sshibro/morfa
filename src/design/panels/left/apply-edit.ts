import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import type {Transaction} from '../../../../shared/design/transaction';
import type {DesignStore, TransactOptions} from '../../engine/store';

// The shared operations (createInstance, the variables API…) return a whole new document plus the ids
// they changed. The store only changes through transactions (normalization, history, autosave), so
// this writes such a result into one: the changed entries of every table, nodes created parents
// first at their place among their siblings, removed subtrees removed, field edits merged.

export type DocumentEdit = {doc: DesignDocument; changed: ReadonlySet<string>};

const STRUCTURE = new Set(['id', 'parentId', 'children']);

/** The fields that turn `was` into `now` (a key `now` lacks is removed with `undefined`). */
function fieldsOf(now: SceneNode, was: SceneNode): Partial<SceneNode> {
  const out: Record<string, unknown> = {};
  const before = was as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(now)) if (!STRUCTURE.has(key) && before[key] !== value) out[key] = value;
  for (const key of Object.keys(was)) if (!STRUCTURE.has(key) && !(key in now)) out[key] = undefined;
  return out as Partial<SceneNode>;
}

/** Writes the difference between `before` and `edit.doc` (limited to `edit.changed`) into `tx`. */
export function writeEdit(tx: Transaction, before: DesignDocument, edit: DocumentEdit): void {
  const after = edit.doc;
  const keys = [...edit.changed];
  // Every "was" is read before the first `tx.*`: `before` may be the store's document, whose table the transaction
  // writes in place — a read after a write would see the new entry.
  const wasOf = new Map<string, SceneNode | undefined>();
  for (const key of keys) wasOf.set(key, before.nodes[key]);

  for (const key of keys) {
    if (before.variableCollections[key] === after.variableCollections[key]) continue;
    const collection = after.variableCollections[key];
    if (collection) tx.setVariableCollection(collection);
  }
  for (const key of keys) {
    if (before.variables[key] === after.variables[key]) continue;
    const variable = after.variables[key];
    if (variable) tx.setVariable(variable);
    else if (before.variables[key]) tx.removeVariable(key);
  }
  for (const key of keys) {
    if (before.variableCollections[key] && !after.variableCollections[key]) tx.removeVariableCollection(key);
  }
  for (const key of keys) {
    if (before.styles[key] === after.styles[key]) continue;
    if (after.styles[key]) tx.setStyle(after.styles[key]);
    else if (before.styles[key]) tx.removeStyle(key);
  }

  // Nodes: created ones parents first (depth order), then edits, then removals.
  const created: SceneNode[] = [];
  const updated: SceneNode[] = [];
  const removed: NodeId[] = [];
  for (const key of keys) {
    const was = wasOf.get(key), now = after.nodes[key];
    if (was === now) continue;
    if (!was && now) created.push(now);
    else if (was && now) updated.push(now);
    else if (was && !now) removed.push(key);
  }
  const depth = (node: SceneNode) => {
    let d = 0;
    for (let up = node.parentId ? after.nodes[node.parentId] : undefined; up; up = up.parentId ? after.nodes[up.parentId] : undefined) d++;
    return d;
  };
  created.sort((a, b) => depth(a) - depth(b));
  const createdIds = new Set(created.map(node => node.id));
  for (const node of created) {
    const siblings = after.nodes[node.parentId!]?.children ?? [];
    // Place it above the closest sibling below it that already exists, so the final order matches.
    let index = 0;
    const at = siblings.indexOf(node.id);
    for (let i = at - 1; i >= 0; i--) {
      if (createdIds.has(siblings[i]) && !tx.get(siblings[i])) continue;
      const list = tx.get(node.parentId!)?.children ?? [];
      index = list.indexOf(siblings[i]) + 1;
      break;
    }
    tx.create(node, node.parentId!, index);
  }
  for (const node of updated) {
    const was = wasOf.get(node.id)!;
    if (was.parentId !== node.parentId && node.parentId && tx.get(node.parentId)) {
      tx.move(node.id, node.parentId, (after.nodes[node.parentId]?.children ?? []).indexOf(node.id), {keepWorld: false});
    }
    const fields = fieldsOf(node, was);
    if (Object.keys(fields).length) tx.update(node.id, fields);
  }
  for (const id of removed) tx.remove(id);

  for (const key of keys) {
    const was = before.variableModes?.[key], now = after.variableModes?.[key];
    if (was === now) continue;
    if (now) tx.setVariableModes(key, now);
    else if (was && tx.get(key)) tx.setVariableModes(key, null);
  }
}

/** Commits an operation's result as one undo step. */
export function commitEdit(store: DesignStore, label: string, before: DesignDocument, edit: DocumentEdit, options?: TransactOptions) {
  return store.transact(label, tx => writeEdit(tx, before, edit), options);
}
