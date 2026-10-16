import type {DesignDocument, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {newId} from '../../../../shared/design/defaults';
import {worldBox} from '../../../../shared/design/geometry';
import {wouldCreateCycle} from '../../../../shared/design/components';
import type {Transaction} from '../../../../shared/design/transaction';
import {sortByPaintOrder} from '../../../../shared/design/tree';
import {pastePayload, resolvePayload, type ClipboardPayload} from '../clipboard';
import {editableStructure} from '../selection';
import {detachForeignInstances, reportDetached} from './clipboard';
import {notify, structureRefusal} from './components';
import {registerCommand, type Command, type CommandContext} from './registry';
import {removeNodes} from './structure';

// "Paste to replace" (⇧⌘R), as in Figma: each selected layer gives way to a copy of what was
// copied, centred where the layer was and in its place among its siblings (inside an auto layout it
// takes the layer's slot in the flow). One undo step; the copies end up selected.

/** Where the copy for `id` goes: the layer's parent, just above it, centred on its box. */
export function replacementTarget(doc: DesignDocument, id: NodeId): {parentId: NodeId; index: number; centre: Vec} | null {
  const node = doc.nodes[id];
  const parentId = node?.parentId;
  if (!node || !parentId || !doc.nodes[parentId]) return null;
  const box = worldBox(doc, id);
  return {parentId, index: (doc.nodes[parentId].children ?? []).indexOf(id) + 1, centre: {x: box.x + box.width / 2, y: box.y + box.height / 2}};
}

/** Instances in the payload whose component the target parent is part of (a component inside itself). */
function makesCycle(doc: DesignDocument, payload: ClipboardPayload, parentId: NodeId): boolean {
  const stack = [...payload.roots];
  while (stack.length) {
    const node: SceneNode | undefined = payload.nodes[stack.pop()!];
    if (!node) continue;
    if (node.type === 'INSTANCE' && node.componentId && doc.nodes[node.componentId] && wouldCreateCycle(doc, node.componentId, parentId)) return true;
    if (node.children && node.type !== 'INSTANCE') stack.push(...node.children);
  }
  return false;
}

/** Replaces each of `ids` with a copy of the payload inside an open transaction; returns the new
 *  roots and how many layers were skipped (a copy would sit inside its own component). */
export function replaceWithPayload(tx: Transaction, ids: readonly NodeId[], payload: ClipboardPayload, makeId: () => NodeId = newId): {created: NodeId[]; skipped: number; detached: number} {
  const created: NodeId[] = [];
  const replaced: NodeId[] = [];
  let skipped = 0, detached = 0;
  for (const id of sortByPaintOrder(tx.doc, ids)) {
    const target = replacementTarget(tx.doc, id);
    if (!target) continue;
    if (makesCycle(tx.doc, payload, target.parentId)) {
      skipped++;
      continue;
    }
    const pasted = pastePayload(tx, payload, {parentId: target.parentId, index: target.index, mode: 'centre', centre: target.centre}, makeId);
    detached += detachForeignInstances(tx, payload, pasted);
    created.push(...pasted);
    replaced.push(id);
  }
  if (replaced.length) removeNodes(tx, replaced);
  return {created: created.filter(id => tx.get(id)), skipped, detached};
}

async function readClipboard(ctx: CommandContext): Promise<string | null> {
  try {
    if (ctx.clipboard) return await ctx.clipboard.readText();
    return (await globalThis.navigator?.clipboard?.readText()) ?? null;
  } catch {
    return null;
  }
}

export const PASTE_REPLACE_COMMANDS: Command[] = [
  {
    id: 'edit.paste-replace',
    label: 'Paste to replace',
    group: 'edit',
    shortcut: {code: 'KeyR', mod: true, shift: true},
    enabled: ctx => ctx.store.getState().selection.some(id => ctx.store.getState().doc.nodes[id]?.type !== 'PAGE'),
    run: async ctx => {
      const {store} = ctx;
      const refusal = structureRefusal(store.getState().doc, store.getState().selection, 'group');
      if (refusal) {
        notify(store, refusal);
        return;
      }
      // The system clipboard when the browser lets us read it, else the last copy made here.
      const payload = resolvePayload(await readClipboard(ctx));
      if (!payload) {
        notify(store, 'Nothing to paste: copy some layers first.');
        return;
      }
      const {doc, selection} = store.getState();
      const ids = editableStructure(doc, selection);
      if (!ids.length) return;
      let outcome = {created: [] as NodeId[], skipped: 0, detached: 0};
      store.transact('Paste to replace', tx => {
        outcome = replaceWithPayload(tx, ids, payload);
        return outcome.created.length ? {select: outcome.created} : undefined;
      });
      if (outcome.skipped) notify(store, 'A component cannot be pasted into itself');
      else reportDetached(store, outcome.detached);
    },
  },
];

let registered = false;
/** Idempotent. */
export function registerPasteReplaceCommands() {
  if (registered) return;
  registered = true;
  for (const command of PASTE_REPLACE_COMMANDS) registerCommand(command);
}
