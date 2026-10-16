import type {DesignDocument, Variable, VariableCollection, VariableId} from '../../../../shared/design/types';
import {newId} from '../../../../shared/design/defaults';
import {addVariableMode, createVariable, renameVariable, setVariableValue, type VariableEdit} from '../../../../shared/design/variables';

// The variables table's own operations, as Figma's table has them ("Create and manage variables", «Modes for
// variables»): built from the shared variable operations (shared/design/variables.ts), each a VariableEdit for one undo
// step, plus reorders, which only change a collection's order of modes or variables.

/** Runs edits one after another on the document each returns; the result changes what any of them changed. */
export function chain(doc: DesignDocument, ...steps: ((doc: DesignDocument) => VariableEdit)[]): VariableEdit {
  let current = doc;
  const changed = new Set<string>();
  for (const step of steps) {
    const edit = step(current);
    current = edit.doc;
    edit.changed.forEach(key => changed.add(key));
  }
  return {doc: current, changed};
}

/** "<name> copy", or "<name> copy 2" and on when that is taken. */
export function copyName(name: string, taken: readonly string[]): string {
  const base = `${name} copy`;
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

const withCollection = (doc: DesignDocument, collection: VariableCollection): VariableEdit =>
  ({doc: {...doc, variableCollections: {...doc.variableCollections, [collection.id]: collection}}, changed: new Set([collection.id])});

/** Moves `items` (in their current order) so they stand before `before` (null: at the end; one of the moving items: the
 *  first item after it that stays). */
export function moveItems<T>(list: readonly T[], items: readonly T[], before: T | null): T[] {
  const moving = list.filter(item => items.includes(item));
  if (!moving.length) return [...list];
  const rest = list.filter(item => !items.includes(item));
  let anchor = before;
  if (anchor !== null && items.includes(anchor)) anchor = list.slice(list.indexOf(anchor) + 1).find(item => !items.includes(item)) ?? null;
  const index = anchor === null ? -1 : rest.indexOf(anchor);
  const at = index < 0 ? rest.length : index;
  return [...rest.slice(0, at), ...moving, ...rest.slice(at)];
}

/** A mode moved to stand before another (null: last), as a drag of its head does. */
export function reorderMode(doc: DesignDocument, collectionId: string, modeId: string, beforeModeId: string | null): VariableEdit {
  const collection = doc.variableCollections[collectionId];
  const mode = collection?.modes.find(each => each.modeId === modeId);
  const before = beforeModeId ? collection.modes.find(each => each.modeId === beforeModeId) ?? null : null;
  if (!collection || !mode) return {doc, changed: new Set()};
  return withCollection(doc, {...collection, modes: moveItems(collection.modes, [mode], before)});
}

/** Variables moved, in their order, to stand before another (null: last) in their collection. */
export function reorderVariables(doc: DesignDocument, collectionId: string, ids: readonly VariableId[], beforeId: VariableId | null): VariableEdit {
  const collection = doc.variableCollections[collectionId];
  if (!collection) return {doc, changed: new Set()};
  return withCollection(doc, {...collection, variableIds: moveItems(collection.variableIds, ids, beforeId)});
}

/** A copy of a mode right after it, named "<name> copy", with the same values. */
export function duplicateMode(doc: DesignDocument, collectionId: string, modeId: string, newModeId = newId()): VariableEdit {
  const collection = doc.variableCollections[collectionId];
  const mode = collection?.modes.find(each => each.modeId === modeId);
  if (!collection || !mode) return {doc, changed: new Set()};
  const name = copyName(mode.name, collection.modes.map(each => each.name));
  const next = collection.modes[collection.modes.indexOf(mode) + 1];
  return chain(doc,
    d => addVariableMode(d, collectionId, {modeId: newModeId, name}, modeId),
    d => reorderMode(d, collectionId, newModeId, next?.modeId ?? null));
}

const groupOf = (name: string) => {
  const parts = name.split('/').map(part => part.trim()).filter(Boolean);
  return {path: parts.slice(0, -1), leaf: parts.at(-1) ?? name};
};

/** A copy of each variable right after it, "<name> copy", with every mode's value (aliases kept). */
export function duplicateVariables(doc: DesignDocument, ids: readonly VariableId[], makeId: () => string = newId): VariableEdit & {ids: VariableId[]} {
  const made: VariableId[] = [];
  const steps: ((doc: DesignDocument) => VariableEdit)[] = [];
  for (const id of ids) {
    const variable = doc.variables[id];
    if (!variable) continue;
    const copy = makeId();
    made.push(copy);
    steps.push(d => {
      const names = (d.variableCollections[variable.collectionId]?.variableIds ?? []).map(each => d.variables[each]?.name ?? '');
      const {path, leaf} = groupOf(variable.name);
      const name = [...path, copyName(leaf, names.filter(each => groupOf(each).path.join('/') === path.join('/')).map(each => groupOf(each).leaf))].join('/');
      return createVariable(d, {id: copy, name, collectionId: variable.collectionId, type: variable.type, description: variable.description});
    });
    for (const [modeId, value] of Object.entries(variable.valuesByMode)) steps.push(d => setVariableValue(d, copy, modeId, value));
    // Right after the original: before what followed it in the table as it was.
    const order = doc.variableCollections[variable.collectionId]?.variableIds ?? [];
    const after = order[order.indexOf(id) + 1] ?? null;
    steps.push(d => reorderVariables(d, variable.collectionId, [copy], after));
  }
  return {...chain(doc, ...steps), ids: made};
}

/** Variables put into a group: their names take `path` before their last part ("Colors/Background" into "Theme" → "Theme/Background"). */
export function moveToGroup(doc: DesignDocument, ids: readonly VariableId[], path: string): VariableEdit {
  const prefix = path.split('/').map(part => part.trim()).filter(Boolean);
  return chain(doc, ...ids.filter(id => doc.variables[id]).map(id => (d: DesignDocument) => {
    const name = [...prefix, groupOf(d.variables[id].name).leaf].join('/');
    return name === d.variables[id].name ? {doc: d, changed: new Set<string>()} : renameVariable(d, id, name);
  }));
}

/** A group's new name: every variable under `path` (and its sub-groups) takes `next` in its place. */
export function renameGroup(doc: DesignDocument, collectionId: string, path: string, next: string): VariableEdit {
  const from = path.split('/').map(part => part.trim()).filter(Boolean);
  const to = next.split('/').map(part => part.trim()).filter(Boolean);
  const ids = doc.variableCollections[collectionId]?.variableIds ?? [];
  return chain(doc, ...ids.filter(id => {
    const parts = groupOf(doc.variables[id]?.name ?? '').path;
    return from.every((part, i) => parts[i] === part);
  }).map(id => (d: DesignDocument) => {
    const {path: parts, leaf} = groupOf(d.variables[id].name);
    return renameVariable(d, id, [...to, ...parts.slice(from.length), leaf].join('/'));
  }));
}

export type TableRow =
  | {kind: 'group'; path: string; parents: string; name: string; depth: number; count: number}
  | {kind: 'variable'; variable: Variable; depth: number};

/** The table's rows: a section head for each group (its parents greyed, its own name strong), then its variables;
 *  folded groups hide what is under them; a search keeps the variables whose name matches and their groups. */
export function tableRows(doc: Pick<DesignDocument, 'variables'>, collection: VariableCollection, folded: ReadonlySet<string> = new Set(), query = ''): TableRow[] {
  const needle = query.trim().toLocaleLowerCase('en');
  const variables = collection.variableIds.map(id => doc.variables[id]).filter((variable): variable is Variable => !!variable)
    .filter(variable => !needle || variable.name.toLocaleLowerCase('en').includes(needle));
  // Groups in the order their first variable comes; ungrouped variables first, as Figma lists them.
  const order: string[] = [];
  const byPath = new Map<string, Variable[]>();
  for (const variable of variables) {
    const path = groupOf(variable.name).path.join('/');
    if (!byPath.has(path)) {
      byPath.set(path, []);
      order.push(path);
    }
    byPath.get(path)!.push(variable);
  }
  order.sort((a, b) => (a === '' ? -1 : b === '' ? 1 : 0));
  const rows: TableRow[] = [];
  const shown = new Set<string>();
  for (const path of order) {
    const parts = path ? path.split('/') : [];
    // Each level of the path gets its head once (a group with only sub-groups still shows).
    for (let i = 0; i < parts.length; i++) {
      const sub = parts.slice(0, i + 1).join('/');
      if (shown.has(sub)) continue;
      shown.add(sub);
      if (parts.slice(0, i).some((_, k) => folded.has(parts.slice(0, k + 1).join('/')))) continue;
      const count = variables.filter(variable => (groupOf(variable.name).path.join('/') + '/').startsWith(sub + '/')).length;
      rows.push({kind: 'group', path: sub, parents: parts.slice(0, i).join(' / '), name: parts[i], depth: i, count});
    }
    if (parts.some((_, k) => folded.has(parts.slice(0, k + 1).join('/')))) continue;
    for (const variable of byPath.get(path)!) rows.push({kind: 'variable', variable, depth: parts.length});
  }
  return rows;
}

/** The selection after a click on a row: alone, ⌘/Ctrl toggles it, ⇧ takes the range from the anchor. */
export function clickSelect(order: readonly VariableId[], selected: readonly VariableId[], anchor: VariableId | null, id: VariableId, modifiers: {toggle: boolean; range: boolean}): VariableId[] {
  if (modifiers.range && anchor && order.includes(anchor)) {
    const [a, b] = [order.indexOf(anchor), order.indexOf(id)].sort((x, y) => x - y);
    const range = order.slice(a, b + 1);
    return modifiers.toggle ? [...new Set([...selected, ...range])] : range;
  }
  if (modifiers.toggle) return selected.includes(id) ? selected.filter(each => each !== id) : [...selected, id];
  return [id];
}
