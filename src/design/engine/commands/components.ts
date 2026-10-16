import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import {newId} from '../../../../shared/design/defaults';
import {apply, invert, worldBox, worldMatrix} from '../../../../shared/design/geometry';
import type {Transaction} from '../../../../shared/design/transaction';
import {pageIdOf, topLevelSelection} from '../../../../shared/design/tree';
import {
  COMPONENT_ERROR_MESSAGES, DesignComponentError, createComponent, createInstance, detachInstance, goToMainComponent, instancesOfComponent, moveViolation,
  pushOverridesToMain, resetOverrides, wouldCreateCycle, type DesignEdit,
} from '../../../../shared/design/components';
import {addVariant, combineAsVariants} from '../../../../shared/design/variants';
import {DesignVariableError} from '../../../../shared/design/variables';
import {cloneSubtrees} from '../clipboard';
import {mainsAsInstances} from '../main-copies';
import type {DesignStore} from '../store';
import {userUpdate} from '../user-edit';
import type {Command, CommandContext} from './registry';
import {goToRemoteMain} from '../../libraries/remote-main';

// Components on the user's side (docs/design-tool.md §The document): "Create component" (⌥⌘K),
// "Combine as variants", "Detach instance" (⌥⌘B), "Reset all changes", "Go to main
// component", "Push changes to main component", "Restore main
// component", and the guards that keep layers inside instances and variant sets in place.
//
// The operations themselves are pure (shared/design/components.ts, variants.ts, variables.ts): they
// take a document and return the next one with the ids they touched. `runEdit` computes one inside a
// transaction and writes the difference with tx.create/move/update/remove (`applyDocument`), so
// normalization, undo and autosave see an ordinary change.

// ── Toasts and reveal ────────────────────────────────────────────────────────────────────────────

/** What the commands need from the open editor: the toast and "show these layers". DesignEditor
 *  connects its services once per store (`connectComponentCommands(store, services)`). */
export type ComponentCommandHost = {
  toast(message: string, kind?: 'info' | 'success' | 'error'): void;
  revealNodes(ids: readonly NodeId[]): void;
};

const hosts = new WeakMap<DesignStore, ComponentCommandHost>();

export function connectComponentCommands(store: DesignStore, host: ComponentCommandHost): () => void {
  hosts.set(store, host);
  return () => {
    if (hosts.get(store) === host) hosts.delete(store);
  };
}

export const isComponentHostConnected = (store: DesignStore) => hosts.has(store);

export function notify(store: DesignStore, message: string, kind: 'info' | 'success' | 'error' = 'error'): void {
  hosts.get(store)?.toast(message, kind);
}

function reveal(store: DesignStore, ids: readonly NodeId[]): void {
  hosts.get(store)?.revealNodes(ids);
}

/** The Russian message of a refused operation, or null for errors that are bugs (rethrown). */
export function editErrorMessage(error: unknown): string | null {
  if (error instanceof DesignComponentError || error instanceof DesignVariableError) return error.message;
  return null;
}

// ── Writing an operation's result through a transaction ─────────────────────────────────────────

const STRUCTURAL = new Set(['id', 'parentId', 'children']);
type Fields = Record<string, unknown>;

/** The fields of `next` that differ from `prev` (a removed field as undefined), structure aside. */
export function fieldChanges(prev: SceneNode, next: SceneNode): Partial<SceneNode> | null {
  const a = prev as unknown as Fields, b = next as unknown as Fields;
  const out: Fields = {};
  let any = false;
  for (const key in b) {
    if (STRUCTURAL.has(key) || a[key] === b[key]) continue;
    out[key] = b[key];
    any = true;
  }
  for (const key in a) {
    if (STRUCTURAL.has(key) || key in b || a[key] === undefined) continue;
    out[key] = undefined;
    any = true;
  }
  return any ? (out as Partial<SceneNode>) : null;
}

const sameIds = (a: readonly NodeId[] | undefined, b: readonly NodeId[] | undefined) =>
  a === b || ((a ?? []).length === (b ?? []).length && (a ?? []).every((id, i) => id === b![i]));

export type ApplyOptions = {
  /** Ids the operation reported (DesignEdit.changed); without them every node is compared. */
  changed?: Iterable<string>;
  /** Nodes edited by hand: their fields go through `userUpdate` (styles detach, copies record overrides). */
  tracked?: ReadonlySet<NodeId>;
};

/** Writes `after` (an operation's result computed from `tx.doc`) into the open transaction: new nodes
 *  are created parents first, moved ones moved, missing ones removed, then fields, children order and
 *  variable modes follow. Styles, pictures and variables are not touched by these operations. */
export function applyDocument(tx: Transaction, after: DesignDocument, options: ApplyOptions = {}): void {
  const before = tx.doc;
  if (before === after) return;
  if (before.styles !== after.styles || before.images !== after.images || before.variables !== after.variables || before.variableCollections !== after.variableCollections || before.pages !== after.pages) {
    throw new Error('applyDocument writes nodes and variable modes only');
  }
  const ids: Iterable<string> = options.changed ?? new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)]);
  const created: SceneNode[] = [];
  const kept: NodeId[] = [];
  const removed: NodeId[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const was = before.nodes[id], now = after.nodes[id];
    if (was === now) continue;
    if (!was && now) created.push(now);
    else if (was && !now) removed.push(id);
    else kept.push(id);
  }
  // 1. New nodes, parents before children.
  const depth = (id: NodeId) => {
    let d = 0;
    for (let node = after.nodes[id]; node?.parentId && d < 10_000; node = after.nodes[node.parentId]) d++;
    return d;
  };
  const depths = new Map(created.map(node => [node.id, depth(node.id)]));
  created.sort((a, b) => depths.get(a.id)! - depths.get(b.id)!);
  for (const node of created) {
    if (node.type === 'PAGE' || !node.parentId) throw new Error('applyDocument does not add pages');
    tx.create(node, node.parentId);
  }
  // 2. Moves (a node can only enter a parent that is not inside it at that moment).
  const insideOf = (ancestor: NodeId, id: NodeId) => {
    for (let node = tx.get(id), guard = 0; node && guard < 10_000; node = node.parentId ? tx.get(node.parentId) : undefined, guard++) {
      if (node.id === ancestor) return true;
    }
    return false;
  };
  let moving = kept.filter(id => before.nodes[id].parentId !== after.nodes[id].parentId);
  while (moving.length) {
    const blocked: NodeId[] = [];
    for (const id of moving) {
      const target = after.nodes[id].parentId!;
      if (insideOf(id, target)) blocked.push(id);
      else tx.move(id, target, undefined, {keepWorld: false});
    }
    if (blocked.length === moving.length) throw new Error('applyDocument: moves form a cycle');
    moving = blocked;
  }
  // 3. Removals (what survives has moved out already).
  for (const id of removed) tx.remove(id);
  // 4. Fields.
  for (const id of kept) {
    const current = tx.get(id);
    if (!current) continue;
    const partial = fieldChanges(current, after.nodes[id]);
    if (!partial) continue;
    if (options.tracked?.has(id)) userUpdate(tx, id, partial);
    else tx.update(id, partial);
  }
  // 5. Children order.
  const parents = new Set<NodeId>();
  for (const node of created) if (node.children?.length) parents.add(node.id);
  for (const id of kept) if (!sameIds(before.nodes[id].children, after.nodes[id].children)) parents.add(id);
  for (const id of parents) {
    const want = after.nodes[id]?.children ?? [];
    if (sameIds(tx.get(id)?.children, want)) continue;
    want.forEach((child, index) => tx.reorder(child, index));
  }
  // 6. Variable modes of nodes that exist.
  const modesBefore = before.variableModes ?? {}, modesAfter = after.variableModes ?? {};
  if (modesBefore !== modesAfter) {
    for (const id of new Set([...Object.keys(modesBefore), ...Object.keys(modesAfter)])) {
      if (modesBefore[id] === modesAfter[id] || !after.nodes[id]) continue;
      tx.setVariableModes(id, modesAfter[id] ?? null);
    }
  }
}

export type EditOutcome = {doc: DesignDocument; changed?: ReadonlySet<string>};

export type RunEditOptions<T> = {
  /** Selection after the change. */
  select?: (result: T) => readonly NodeId[] | undefined;
  /** Nodes edited by hand (see ApplyOptions.tracked). */
  tracked?: ReadonlySet<NodeId>;
  /** Consecutive edits with the same key within a second make one undo step (typing). */
  coalesce?: string;
};

/** Runs a pure operation on the current document as one undo step. A refusal the operation explains
 *  (DesignComponentError, DesignVariableError) becomes a toast and the result is null. */
export function runEdit<T extends EditOutcome>(store: DesignStore, label: string, make: (doc: DesignDocument) => T, options: RunEditOptions<T> = {}): T | null {
  let result: T | null = null;
  try {
    store.transact(label, tx => {
      const out = make(tx.doc);
      result = out;
      applyDocument(tx, out.doc, {changed: out.changed, tracked: options.tracked});
      const select = options.select?.(out);
      return select ? {select} : undefined;
    }, {coalesce: options.coalesce});
  } catch (error) {
    const message = editErrorMessage(error);
    if (message === null) throw error;
    notify(store, message);
    return null;
  }
  return result;
}

/** Applies `op` to each id in turn, collecting what changed. Ids the operation refuses are skipped
 *  unless none succeeds (then the first refusal is thrown). */
export function chainEdits(doc: DesignDocument, ids: readonly NodeId[], op: (doc: DesignDocument, id: NodeId) => EditOutcome): EditOutcome {
  let current = doc;
  const changed = new Set<string>();
  let refusal: unknown = null, applied = 0;
  for (const id of ids) {
    try {
      const out = op(current, id);
      current = out.doc;
      if (out.changed) for (const each of out.changed) changed.add(each);
      applied++;
    } catch (error) {
      if (editErrorMessage(error) === null) throw error;
      refusal ??= error;
    }
  }
  if (!applied && refusal) throw refusal;
  return {doc: current, changed};
}

// ── What the selection holds ─────────────────────────────────────────────────────────────────────

const state = (ctx: CommandContext) => ctx.store.getState();
const nodeOf = (doc: DesignDocument, id: NodeId | null | undefined) => (id ? doc.nodes[id] : undefined);
const isSet = (node: SceneNode | undefined) => node?.type === 'COMPONENT_SET';
const isMain = (node: SceneNode | undefined) => node?.type === 'COMPONENT' && node.mainId === undefined;

/** Selected instances that are not copies inside another instance. */
export const topInstances = (doc: DesignDocument, ids: readonly NodeId[]) =>
  topLevelSelection(doc, ids).filter(id => doc.nodes[id]?.type === 'INSTANCE' && doc.nodes[id].mainId === undefined);

/** Selected instances, nested ones included. */
export const selectedInstances = (doc: DesignDocument, ids: readonly NodeId[]) => ids.filter(id => doc.nodes[id]?.type === 'INSTANCE');

/** Whether an instance or anything inside it carries an override (reset and push have work to do). */
export function hasOverrides(doc: DesignDocument, id: NodeId): boolean {
  const stack = [id];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    if (node.overrides?.length) return true;
    if (node.children) stack.push(...node.children);
  }
  return false;
}

/** The variant set a selected node stands for: itself, or the set of a selected variant. */
export function setOfSelection(doc: DesignDocument, ids: readonly NodeId[]): NodeId | null {
  if (ids.length !== 1) return null;
  const node = doc.nodes[ids[0]];
  if (isSet(node)) return node.id;
  const parent = nodeOf(doc, node?.parentId);
  return node?.type === 'COMPONENT' && isSet(parent) ? parent!.id : null;
}

/** Whether "Create component" can make something of the selection (and it is not all components already). */
export function canCreateComponent(doc: DesignDocument, ids: readonly NodeId[], combine = false): boolean {
  const top = topLevelSelection(doc, ids);
  if (!top.length || top.every(id => doc.nodes[id]?.type === 'COMPONENT')) return false;
  try {
    createComponent(doc, top, () => 'probe', {combine: combine && top.length > 1});
    return true;
  } catch {
    return false;
  }
}

/** Components that "Combine as variants" takes: two or more mains outside sets, on one page. */
export function combinable(doc: DesignDocument, ids: readonly NodeId[]): NodeId[] {
  const top = topLevelSelection(doc, ids);
  if (top.length < 2) return [];
  if (!top.every(id => isMain(doc.nodes[id]) && !isSet(nodeOf(doc, doc.nodes[id].parentId)))) return [];
  return top;
}

// ── Actions (commands and panels call these) ─────────────────────────────────────────────────────

/** "Create component". Several layers become one component wrapping them (⌥⌘K, as in Figma), or one
 *  each with `multiple` ("Create multiple components"); layers in different parents always make one each. */
export function createComponentsFromSelection(store: DesignStore, multiple = false): NodeId[] | null {
  const {doc, selection} = store.getState();
  const top = topLevelSelection(doc, selection);
  if (!top.length) return null;
  const sameParent = top.every(id => doc.nodes[id]?.parentId === doc.nodes[top[0]]?.parentId);
  const combine = !multiple && top.length > 1 && sameParent;
  const result = runEdit(store, multiple || top.length > 1 && !combine ? 'Create components' : 'Create component', current => createComponent(current, top, newId, {combine}), {select: out => out.componentIds});
  return result?.componentIds ?? null;
}

export function combineSelectionAsVariants(store: DesignStore): NodeId | null {
  const {doc, selection} = store.getState();
  const ids = combinable(doc, selection);
  if (!ids.length) {
    notify(store, 'Select two or more main components');
    return null;
  }
  return runEdit(store, 'Combine as variants', current => combineAsVariants(current, ids, newId()), {select: out => [out.setId]})?.setId ?? null;
}

/** "Add variant": duplicates the selected variant (or the set's default one) into the set. */
export function addVariantToSet(store: DesignStore, setId: NodeId, from?: NodeId): NodeId | null {
  return runEdit(store, 'New variant', current => addVariant(current, setId, {from, newId}), {select: out => [out.id]})?.id ?? null;
}

export function detachSelectedInstances(store: DesignStore): void {
  const {doc, selection} = store.getState();
  const ids = topInstances(doc, selection);
  if (!ids.length) {
    if (selectedInstances(doc, selection).length) notify(store, COMPONENT_ERROR_MESSAGES.nested_instance);
    return;
  }
  runEdit(store, 'Detach instance', current => chainEdits(current, ids, (each, id) => detachInstance(each, id)), {select: () => selection});
}

export function resetSelectedInstances(store: DesignStore): void {
  const {doc, selection} = store.getState();
  const ids = selection.filter(id => (doc.nodes[id]?.type === 'INSTANCE' || doc.nodes[id]?.mainId !== undefined) && hasOverrides(doc, id));
  if (!ids.length) return;
  runEdit(store, 'Reset changes', current => chainEdits(current, ids, (each, id) => resetOverrides(each, id)));
}

/** "Go to main component": switches to its page, selects it and brings it into view. */
export function goToMain(store: DesignStore, id: NodeId): NodeId | null {
  const {doc} = store.getState();
  const target = goToMainComponent(doc, id);
  if (!target) {
    notify(store, 'The main component was deleted. You can restore it from the instance.');
    return null;
  }
  // A shared library's component lives in its own file (docs/design-tool.md §Teams): that file opens instead.
  if (goToRemoteMain(doc, target, message => notify(store, message))) return null;
  const page = pageIdOf(doc, target);
  if (page && page !== store.getState().pageId) store.setPage(page);
  store.setContext(null);
  store.setSelection([target]);
  reveal(store, [target]);
  return target;
}

/** The component "Select all instances" works on for a single selected layer: a main component or a set itself, or the
 *  main of a selected instance (not one deleted). Null otherwise. */
export function instancesSource(doc: DesignDocument, ids: readonly NodeId[]): NodeId | null {
  if (ids.length !== 1) return null;
  const node = doc.nodes[ids[0]];
  if (isMain(node) || isSet(node)) return node!.id;
  if (node?.type === 'INSTANCE' && node.componentId && doc.nodes[node.componentId]) return node.componentId;
  return null;
}

/** The instances of a component (of every variant of a set) that are not copies inside other instances, page by page. */
export function instancesByPage(doc: DesignDocument, componentId: NodeId): Map<NodeId, NodeId[]> {
  const source = doc.nodes[componentId];
  const mains = isSet(source) ? source!.children ?? [] : [componentId];
  const out = new Map<NodeId, NodeId[]>();
  for (const main of mains) {
    for (const id of instancesOfComponent(doc, main)) {
      if (doc.nodes[id]?.mainId !== undefined) continue;
      const page = pageIdOf(doc, id);
      if (!page || !doc.pages.includes(page)) continue;
      const list = out.get(page);
      if (list) list.push(id);
      else out.set(page, [id]);
    }
  }
  return out;
}

/** "Select all instances": selects the component's instances on this page, as Figma does; when this page has none,
 *  the first page that has some opens with them selected. */
export function selectAllInstances(store: DesignStore, componentId: NodeId): NodeId[] {
  const {doc, pageId} = store.getState();
  const byPage = instancesByPage(doc, componentId);
  const page = byPage.has(pageId) ? pageId : doc.pages.find(id => byPage.has(id));
  if (!page) {
    notify(store, 'This component has no instances yet');
    return [];
  }
  const ids = byPage.get(page)!;
  if (page !== pageId) store.setPage(page);
  store.setContext(null);
  store.setSelection(ids);
  reveal(store, ids);
  return ids;
}

export function pushSelectedToMain(store: DesignStore): void {
  const {doc, selection} = store.getState();
  const ids = topInstances(doc, selection).filter(id => hasOverrides(doc, id));
  if (!ids.length) return;
  const result = runEdit(store, 'Push changes to main component', current => chainEdits(current, ids, (each, id) => pushOverridesToMain(each, id)));
  if (result) notify(store, 'Changes pushed to the main component', 'success');
}

/** An instance whose main component was deleted. */
export const isOrphan = (doc: DesignDocument, id: NodeId) => {
  const node = doc.nodes[id];
  return node?.type === 'INSTANCE' && node.mainId === undefined && !!node.componentId && !doc.nodes[node.componentId];
};

/** "Restore main component": rebuilds a deleted main from one of its instances, under the old
 *  ids, so every instance of it links up again. It stands to the right of the instance on the page.
 *  Minimal: property definitions come back from the instance's values (BOOLEAN, TEXT, INSTANCE_SWAP),
 *  a variant comes back as a lone component, and the copies' overrides become the main's values. */
export function restoreMainComponent(doc: DesignDocument, instanceId: NodeId): DesignEdit & {id: NodeId} {
  const instance = doc.nodes[instanceId];
  if (!isOrphan(doc, instanceId)) throw new DesignComponentError('not_instance', 'The main component of this instance is in place');
  const mainId = instance.componentId!;
  const pageId = pageIdOf(doc, instanceId)!;
  const box = worldBox(doc, instanceId);
  const nodes = {...doc.nodes};
  const changed = new Set<NodeId>();
  const put = (node: SceneNode) => {
    nodes[node.id] = node;
    changed.add(node.id);
  };
  const strip = (node: SceneNode): SceneNode => {
    const copy = {...node};
    delete copy.mainId;
    delete copy.overrides;
    return copy;
  };
  const definitions: Record<string, NonNullable<SceneNode['componentPropertyDefinitions']>[string]> = {};
  for (const [key, value] of Object.entries(instance.componentProperties ?? {})) {
    if (!key.includes('#')) continue;
    definitions[key] = typeof value === 'boolean' ? {type: 'BOOLEAN', defaultValue: value} : doc.nodes[value]?.type === 'COMPONENT' ? {type: 'INSTANCE_SWAP', defaultValue: value} : {type: 'TEXT', defaultValue: value};
  }
  const main: SceneNode = {
    ...strip(instance), id: mainId, type: 'COMPONENT', parentId: pageId, x: box.x + box.width + 40, y: box.y, rotation: 0, flipX: false, flipY: false,
    name: instance.name, description: '', componentPropertyDefinitions: definitions, children: [],
    constraints: {horizontal: 'MIN', vertical: 'MIN'}, layoutPositioning: 'AUTO', layoutSizingHorizontal: 'FIXED', layoutSizingVertical: 'FIXED',
  };
  delete main.componentId;
  delete main.componentProperties;
  delete main.componentPropertyReferences;
  // Copies of the instance's own layers come back under the ids they mirror; nested instances come
  // back as instances (their copies are re-made by the sync that follows).
  const rebuild = (copy: SceneNode, parentId: NodeId): NodeId | null => {
    const id = copy.mainId;
    if (!id || nodes[id]) return null;
    const node: SceneNode = {...strip(copy), id, parentId};
    if (copy.type === 'INSTANCE') {
      node.children = [];
      delete node.componentPropertyReferences;
    } else if (copy.children) {
      node.children = copy.children.map(child => (doc.nodes[child] ? rebuild(doc.nodes[child], id) : null)).filter((child): child is NodeId => child !== null);
    }
    put(node);
    return id;
  };
  main.children = (instance.children ?? []).map(child => (doc.nodes[child] ? rebuild(doc.nodes[child], mainId) : null)).filter((child): child is NodeId => child !== null);
  put(main);
  const page = nodes[pageId];
  put({...page, children: [...(page.children ?? []), mainId]});
  return {doc: {...doc, nodes}, changed, id: mainId};
}

export function restoreMainOf(store: DesignStore, instanceId: NodeId): NodeId | null {
  const result = runEdit(store, 'Restore component', current => restoreMainComponent(current, instanceId), {select: out => [out.id]});
  if (result) reveal(store, [result.id]);
  return result?.id ?? null;
}

/** Places an instance of a component (a set gives its default variant): under `parentId` at (x, y) in
 *  its space, or by default to the right of the main on its page. */
export function insertInstance(store: DesignStore, componentId: NodeId, at?: {parentId: NodeId; x: number; y: number; index?: number}): NodeId | null {
  const {doc} = store.getState();
  const main = doc.nodes[componentId];
  if (!main) return null;
  let place = at;
  if (!place) {
    const anchor = isSet(nodeOf(doc, main.parentId)) ? main.parentId! : componentId;
    const box = worldBox(doc, anchor);
    const parentId = doc.nodes[anchor].parentId!;
    const local = doc.nodes[parentId]?.type === 'PAGE' ? {x: box.x + box.width + 40, y: box.y} : apply(invert(worldMatrix(doc, parentId)), {x: box.x + box.width + 40, y: box.y});
    place = {parentId, x: Math.round(local.x), y: Math.round(local.y)};
  }
  const target = place;
  return runEdit(store, 'New instance', current => createInstance(current, componentId, {...target, newId}), {select: out => [out.id]})?.id ?? null;
}

// ── Alt-drag of a main, and drops the move tool may make ─────────────────────────────────────────

/** The copies an Alt-drag (or Alt-duplicate) makes: a main component (not a variant) gives an
 *  instance of itself, as in Figma; every other layer an ordinary copy (clipboard.ts cloneSubtrees).
 *  Same shape as `cloneSubtrees`: nodes to create in order, and old → new ids for the roots. */
export function altDragClones(doc: DesignDocument, ids: readonly NodeId[], makeId: () => NodeId = newId): {nodes: SceneNode[]; ids: Map<NodeId, NodeId>} {
  return mainsAsInstances(doc, doc.nodes, ids, cloneSubtrees(doc.nodes, ids, makeId));
}

/** Whether the move tool may drop `id` (as it is in `doc`, the drag's start) into `targetParentId`.
 *  `asInstance`: the dragged layer is an Alt-drag copy that becomes an instance of `id`. */
export function dropAllowed(doc: DesignDocument, id: NodeId, targetParentId: NodeId, asInstance = false): boolean {
  if (asInstance && isMain(doc.nodes[id])) {
    const target = doc.nodes[targetParentId];
    return !!target && target.type !== 'INSTANCE' && target.mainId === undefined && target.type !== 'COMPONENT_SET' && !wouldCreateCycle(doc, id, targetParentId);
  }
  return moveViolation(doc, [id], targetParentId) === null;
}

// ── Guards for the structural commands ───────────────────────────────────────────────────────────

const REFUSALS = {
  delete: 'A layer of an instance cannot be deleted — hide it instead',
  group: 'Layers inside an instance cannot be changed this way — detach the instance',
  order: 'The layer order of an instance is set by the main component',
  duplicate: 'A layer of an instance cannot be duplicated',
} as const;
type GuardKind = keyof typeof REFUSALS;

const GUARDED: Readonly<Record<string, GuardKind>> = {
  delete: 'delete', group: 'group', 'frame-selection': 'group', duplicate: 'duplicate',
  'bring-forward': 'order', 'send-backward': 'order', 'bring-to-front': 'order', 'send-to-back': 'order',
  // Operations that wrap or replace layers (commands/boolean.ts, mask.ts, vector.ts).
  'object.boolean-union': 'group', 'object.boolean-subtract': 'group', 'object.boolean-intersect': 'group', 'object.boolean-exclude': 'group',
  'object.mask': 'group', 'object.flatten': 'group',
};

/** Why a structural command cannot act on the selection, or null. Refused when every selected layer
 *  sits inside an instance (the toast says what to do instead); grouping or wrapping variants of a set
 *  is refused because a set holds only components. */
export function structureRefusal(doc: DesignDocument, selection: readonly NodeId[], kind: GuardKind): string | null {
  const top = topLevelSelection(doc, selection).filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
  if (!top.length) return null;
  if (top.every(id => doc.nodes[id].mainId !== undefined)) return REFUSALS[kind];
  if (kind === 'group' && top.some(id => isSet(nodeOf(doc, doc.nodes[id].parentId)))) return COMPONENT_ERROR_MESSAGES.set_child;
  return null;
}

/** Wraps a core command (delete, group, wrap in frame, reorder, duplicate, booleans, mask, flatten) so
 *  that, where it cannot act on layers inside an instance, it says why instead of doing nothing. Other
 *  commands pass unchanged. */
export function guardStructure(command: Command): Command {
  const kind = GUARDED[command.id];
  if (!kind) return command;
  const refusal = (ctx: CommandContext) => structureRefusal(state(ctx).doc, state(ctx).selection, kind);
  return {
    ...command,
    enabled: ctx => (command.enabled ? command.enabled(ctx) : true) || refusal(ctx) !== null,
    run: ctx => {
      const message = refusal(ctx);
      if (message) {
        notify(ctx.store, message);
        return;
      }
      return command.run(ctx);
    },
  };
}

// ── Commands ─────────────────────────────────────────────────────────────────────────────────────

const selectionOf = (ctx: CommandContext) => state(ctx).selection;
const single = (ctx: CommandContext) => (selectionOf(ctx).length === 1 ? selectionOf(ctx)[0] : null);

export const COMPONENT_COMMANDS: Command[] = [
  {
    id: 'object.create-component',
    label: 'Create component',
    group: 'component',
    shortcut: {code: 'KeyK', mod: true, alt: true},
    enabled: ctx => canCreateComponent(state(ctx).doc, selectionOf(ctx), true) || canCreateComponent(state(ctx).doc, selectionOf(ctx)),
    run: ctx => void createComponentsFromSelection(ctx.store),
  },
  {
    id: 'object.create-multiple-components',
    label: 'Create multiple components',
    group: 'component',
    enabled: ctx => topLevelSelection(state(ctx).doc, selectionOf(ctx)).length > 1 && canCreateComponent(state(ctx).doc, selectionOf(ctx)),
    run: ctx => void createComponentsFromSelection(ctx.store, true),
  },
  {
    id: 'object.combine-variants',
    label: 'Combine as variants',
    group: 'component',
    enabled: ctx => combinable(state(ctx).doc, selectionOf(ctx)).length > 1,
    run: ctx => void combineSelectionAsVariants(ctx.store),
  },
  {
    id: 'object.add-variant',
    label: 'Add variant',
    group: 'component',
    enabled: ctx => setOfSelection(state(ctx).doc, selectionOf(ctx)) !== null,
    run: ctx => {
      const {doc, selection} = state(ctx);
      const setId = setOfSelection(doc, selection);
      if (setId) addVariantToSet(ctx.store, setId, selection[0] !== setId ? selection[0] : undefined);
    },
  },
  {
    id: 'object.detach-instance',
    label: 'Detach instance',
    group: 'component',
    shortcut: {code: 'KeyB', mod: true, alt: true},
    enabled: ctx => selectedInstances(state(ctx).doc, selectionOf(ctx)).length > 0,
    run: ctx => detachSelectedInstances(ctx.store),
  },
  {
    id: 'object.reset-instance',
    label: 'Reset all changes',
    group: 'component',
    enabled: ctx => selectionOf(ctx).some(id => {
      const node = state(ctx).doc.nodes[id];
      return !!node && (node.type === 'INSTANCE' || node.mainId !== undefined) && hasOverrides(state(ctx).doc, id);
    }),
    run: ctx => resetSelectedInstances(ctx.store),
  },
  {
    id: 'object.go-to-main',
    label: 'Go to main component',
    group: 'component',
    enabled: ctx => {
      const id = single(ctx);
      const node = id ? state(ctx).doc.nodes[id] : undefined;
      return !!node && (node.type === 'INSTANCE' || node.mainId !== undefined) && goToMainComponent(state(ctx).doc, id!) !== null;
    },
    run: ctx => {
      const id = single(ctx);
      if (id) goToMain(ctx.store, id);
    },
  },
  {
    id: 'object.push-to-main',
    label: 'Push changes to main component',
    group: 'component',
    enabled: ctx => topInstances(state(ctx).doc, selectionOf(ctx)).some(id => hasOverrides(state(ctx).doc, id) && !isOrphan(state(ctx).doc, id)),
    run: ctx => pushSelectedToMain(ctx.store),
  },
  {
    id: 'object.select-instances',
    label: 'Select all instances',
    group: 'component',
    enabled: ctx => {
      const source = instancesSource(state(ctx).doc, selectionOf(ctx));
      return !!source && instancesByPage(state(ctx).doc, source).size > 0;
    },
    run: ctx => {
      const source = instancesSource(state(ctx).doc, selectionOf(ctx));
      if (source) selectAllInstances(ctx.store, source);
    },
  },
  {
    id: 'object.restore-component',
    label: 'Restore main component',
    group: 'component',
    enabled: ctx => {
      const id = single(ctx);
      return !!id && isOrphan(state(ctx).doc, id);
    },
    run: ctx => {
      const id = single(ctx);
      if (id) restoreMainOf(ctx.store, id);
    },
  },
  {
    id: 'object.create-instance',
    label: 'Create instance',
    group: 'component',
    enabled: ctx => {
      const node = nodeOf(state(ctx).doc, single(ctx));
      return isMain(node) || isSet(node);
    },
    run: ctx => {
      const id = single(ctx);
      if (id) insertInstance(ctx.store, id);
    },
  },
];
