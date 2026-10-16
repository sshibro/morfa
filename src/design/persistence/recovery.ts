import type {ImageAsset, NodeId, SceneNode, Style, Variable, VariableCollection} from '../../../shared/design/types';
import type {PatchIssue} from '../../../shared/design/schema';
import {isContainer, type Transaction} from '../../../shared/design/transaction';
import type {DesignStore} from '../engine/store';
import {entryId, type SavedLookup} from './patch-guard';

// The editor's side of a refused save (autosave.ts `recover`): each refused entry goes back to the value the server
// has, as one change without an undo step, and the user is told which and why. A layer the server never had is
// taken away with what it holds, except layers that were saved elsewhere before (they move back out first, so
// nothing stored is lost); a layer the server has gets its stored properties back and, if it moved, its place.

/** What was put back, for the message. */
export type Reverted = {
  kind: 'layer' | 'style' | 'image' | 'variable' | 'collection' | 'modes' | 'pages';
  name: string;
  /** The server never had it: it is gone from the file now. */
  removed: boolean;
  error: string;
};
export type RevertResult = {ok: boolean; reverted: Reverted[]};

export const RECOVERY_LABEL = 'Revert unsaveable change';
const STRUCTURAL = new Set(['id', 'parentId', 'children']);

/** Puts every refused entry back as `saved` has it (one transaction, no undo step). `ok` is false when an entry could
 *  not be put back (a refused deletion, a layer that changed kind): autosave then stops instead of looping. */
export function revertRefused(store: DesignStore, issues: readonly PatchIssue[], saved: SavedLookup): RevertResult {
  const reverted: Reverted[] = [];
  let ok = true;
  const seen = new Set<string>();
  try {
    store.transact(
      RECOVERY_LABEL,
      tx => {
        for (const issue of issues) {
          const id = entryId(issue);
          if (seen.has(id)) continue;
          seen.add(id);
          let done: Reverted | null = null;
          try {
            done = revertOne(tx, issue, saved);
          } catch {
            done = null;
          }
          if (done) reverted.push(done);
          else ok = false;
        }
      },
      {history: false},
    );
  } catch {
    ok = false;
  }
  return {ok, reverted};
}

function revertOne(tx: Transaction, issue: PatchIssue, saved: SavedLookup): Reverted | null {
  const {table, key, error} = issue;
  if (table === 'pages') {
    const order = saved.pages();
    const current = tx.doc.pages;
    if (!order || order.length !== current.length || order.some(id => !current.includes(id))) return null;
    tx.setPages(order);
    return {kind: 'pages', name: '', removed: false, error};
  }
  if (key === null) return null;
  const before = saved.entry(table, key);
  if (before === undefined) return null;
  switch (table) {
    case 'nodes':
      return revertNode(tx, key, (before as SceneNode | null) ?? undefined, saved, error);
    case 'styles': {
      const current = tx.doc.styles[key];
      if (before) tx.setStyle(before as Style);
      else tx.removeStyle(key);
      return {kind: 'style', name: ((before as Style | null) ?? current)?.name ?? key, removed: !before, error};
    }
    case 'images': {
      const current = tx.doc.images[key];
      if (before) tx.setImage(key, before as ImageAsset);
      else tx.removeImage(key);
      return {kind: 'image', name: ((before as ImageAsset | null) ?? current)?.name ?? '', removed: !before, error};
    }
    case 'variableCollections': {
      const current = tx.doc.variableCollections[key];
      if (before) tx.setVariableCollection(before as VariableCollection);
      else tx.removeVariableCollection(key);
      return {kind: 'collection', name: ((before as VariableCollection | null) ?? current)?.name ?? key, removed: !before, error};
    }
    case 'variables': {
      const current = tx.doc.variables[key];
      if (before) tx.setVariable(before as Variable);
      else tx.removeVariable(key);
      return {kind: 'variable', name: ((before as Variable | null) ?? current)?.name ?? key, removed: !before, error};
    }
    case 'variableModes': {
      const node = tx.get(key);
      if (before && !node) return null;
      tx.setVariableModes(key, (before as Record<string, string> | null) ?? null);
      return {kind: 'modes', name: node?.name ?? '', removed: false, error};
    }
  }
  return null;
}

function revertNode(tx: Transaction, id: NodeId, before: SceneNode | undefined, saved: SavedLookup, error: string): Reverted | null {
  const current = tx.get(id);
  if (!current) return before ? null : {kind: 'layer', name: '', removed: true, error};
  if (!before) {
    rescueStored(tx, id, saved);
    tx.remove(id);
    return {kind: 'layer', name: current.name, removed: true, error};
  }
  if (isContainer(before) !== isContainer(current) || (before.type === 'PAGE') !== (current.type === 'PAGE')) return null;
  // Its stored properties: every one it has now and the server's copy has not goes, every stored one comes back.
  const partial: Record<string, unknown> = {};
  for (const field of Object.keys(current)) if (!STRUCTURAL.has(field) && !Object.hasOwn(before, field)) partial[field] = undefined;
  for (const [field, value] of Object.entries(before)) if (!STRUCTURAL.has(field)) partial[field] = value;
  tx.update(id, partial as Partial<SceneNode>);
  // Its place: the stored position is in the stored parent's space.
  const parentId = before.parentId;
  if (parentId && current.parentId !== parentId && fitsUnder(tx, parentId, id)) {
    const index = saved.node(parentId)?.children?.indexOf(id) ?? -1;
    tx.move(id, parentId, index >= 0 ? index : undefined, {keepWorld: false});
  }
  return {kind: 'layer', name: before.name, removed: false, error};
}

/** Whether `parentId` exists, holds layers and is not inside `id` (moving there would make a cycle). */
function fitsUnder(tx: Transaction, parentId: NodeId, id: NodeId): boolean {
  const parent = tx.get(parentId);
  if (!parent || !isContainer(parent)) return false;
  for (let at: SceneNode | undefined = parent, steps = 0; at && steps < 1000; at = at.parentId ? tx.get(at.parentId) : undefined, steps++) if (at.id === id) return false;
  return true;
}

/** Before a new layer goes: layers inside it that the server has (they were moved in after they were saved) move
 *  back to their stored parent, or beside the layer, where they stay on screen. */
function rescueStored(tx: Transaction, rootId: NodeId, saved: SavedLookup) {
  const root = tx.get(rootId);
  const queue = [...(root?.children ?? [])];
  for (let at = 0; at < queue.length; at++) {
    const childId = queue[at];
    const child = tx.get(childId);
    if (!child) continue;
    const stored = saved.node(childId);
    if (!stored) {
      queue.push(...(child.children ?? []));
      continue;
    }
    const targets = [stored.parentId, root!.parentId].filter((target): target is NodeId => !!target && target !== rootId);
    const target = targets.find(candidate => fitsUnder(tx, candidate, rootId) && fitsUnder(tx, candidate, childId));
    if (target) tx.move(childId, target, undefined, {keepWorld: true});
  }
}

// ── Messages ─────────────────────────────────────────────────────────────────────────────────────

const quoted = (name: string) => `"${name.length > 40 ? name.slice(0, 39).trimEnd() + '…' : name}"`;
const sentence = (text: string) => {
  const trimmed = text.trim().replace(/\.+$/, '');
  return trimmed ? trimmed[0].toLowerCase() + trimmed.slice(1) : 'invalid value';
};

/** What one put-back entry is (as in: could not save layer "Button"). */
export function entryLabel(entry: Pick<Reverted, 'kind' | 'name'>): string {
  const name = entry.name.trim();
  switch (entry.kind) {
    case 'layer':
      return name ? `layer ${quoted(name)}` : 'layer';
    case 'style':
      return name ? `style ${quoted(name)}` : 'style';
    case 'image':
      return name ? `image ${quoted(name)}` : 'image';
    case 'variable':
      return name ? `variable ${quoted(name)}` : 'variable';
    case 'collection':
      return name ? `variable collection ${quoted(name)}` : 'variable collection';
    case 'modes':
      return name ? `variable modes of layer ${quoted(name)}` : 'variable modes';
    case 'pages':
      return 'page order';
  }
}

/** "Could not save layer "Button": the link must start with http://, https:// or mailto:. Change
 *  reverted." — or, for several, how many, the first two and the first reason. */
export function recoveryMessage(reverted: readonly Reverted[]): string {
  if (!reverted.length) return 'Could not save the change. It was reverted.';
  if (reverted.length === 1) return `Could not save ${entryLabel(reverted[0])}: ${sentence(reverted[0].error)}. The change was reverted.`;
  const count = reverted.length;
  const named = reverted.slice(0, 2).map(entryLabel).join(', ');
  const rest = count > 2 ? ` and ${count - 2} more` : '';
  return `Could not save ${count} changes (${named}${rest}): ${sentence(reverted[0].error)}. The changes were reverted.`;
}

/** The sentence under "Saving stopped": what was refused, when it is known. */
export function stoppedMessage(issues: readonly PatchIssue[], nameOf: (issue: PatchIssue) => Pick<Reverted, 'kind' | 'name'> | null, serverMessage: string | null): string {
  const first = issues[0];
  const label = first ? nameOf(first) : null;
  if (first && label) return `Could not save ${entryLabel(label)}: ${sentence(first.error)}.`;
  if (first) return `The change cannot be saved: ${sentence(first.error)}.`;
  if (serverMessage) return serverMessage.trim().replace(/\.?$/, '.');
  return 'The server did not accept the latest changes.';
}

/** The label of an entry as it is in the document now (for the stop message). */
export function describeEntry(store: DesignStore, issue: PatchIssue): Pick<Reverted, 'kind' | 'name'> | null {
  const doc = store.getState().doc;
  const key = issue.key;
  switch (issue.table) {
    case 'pages':
      return {kind: 'pages', name: ''};
    case 'nodes':
      return key === null ? null : {kind: 'layer', name: doc.nodes[key]?.name ?? ''};
    case 'styles':
      return key === null ? null : {kind: 'style', name: doc.styles[key]?.name ?? ''};
    case 'images':
      return key === null ? null : {kind: 'image', name: doc.images[key]?.name ?? ''};
    case 'variables':
      return key === null ? null : {kind: 'variable', name: doc.variables[key]?.name ?? ''};
    case 'variableCollections':
      return key === null ? null : {kind: 'collection', name: doc.variableCollections[key]?.name ?? ''};
    case 'variableModes':
      return key === null ? null : {kind: 'modes', name: doc.nodes[key]?.name ?? ''};
  }
}
