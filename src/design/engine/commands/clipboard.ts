import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {detachInstance} from '../../../../shared/design/components';
import {isDropTarget, isInsideInstance, sortByPaintOrder} from '../../../../shared/design/tree';
import type {Transaction} from '../../../../shared/design/transaction';
import {buildClipboardPayload, choosePasteTarget, pastePayload, resolvePayload, setInternalClipboard, type ClipboardPayload} from '../clipboard';
import {currentViewport, type DesignStore} from '../store';
import {editableStructure} from '../selection';
import {viewportCenter, visiblePageRect} from '../viewport';
import {applyDocument, notify} from './components';
import type {Command, CommandContext} from './registry';
import {removeNodes} from './structure';

// Copy, Cut, Paste, Paste in place. From the keyboard these run inside the
// browser's own clipboard events (CanvasView.tsx), which read and write the system clipboard
// without a permission prompt; from a menu they go through `navigator.clipboard`.

/** What other content a paste can carry (pictures, SVG, plain text) and who handles it. Handlers
 *  run after the engine found no copied layers; the first that returns true wins. */
export type PasteData = {text: string | null; html: string | null; files: readonly File[]};
export type PasteHandler = (data: PasteData, ctx: CommandContext, options: {inPlace: boolean}) => boolean;

const pasteHandlers: PasteHandler[] = [];

export function registerPasteHandler(handler: PasteHandler): () => void {
  pasteHandlers.push(handler);
  return () => {
    const at = pasteHandlers.indexOf(handler);
    if (at >= 0) pasteHandlers.splice(at, 1);
  };
}

const navigatorClipboard = {
  writeText: async (text: string) => {
    await globalThis.navigator?.clipboard?.writeText(text);
  },
  readText: async () => {
    try {
      return (await globalThis.navigator?.clipboard?.readText()) ?? null;
    } catch {
      return null;
    }
  },
};

/** Copies the selection; returns the clipboard text (null when nothing is selected). */
export function copySelection(ctx: CommandContext): string | null {
  const {doc, selection} = ctx.store.getState();
  const payload = buildClipboardPayload(doc, selection);
  return payload ? setInternalClipboard(payload) : null;
}

export function cutSelection(ctx: CommandContext): string | null {
  const text = copySelection(ctx);
  if (text === null) return null;
  const {doc, selection} = ctx.store.getState();
  const ids = editableStructure(doc, selection);
  if (ids.length) ctx.store.transact('Cut', tx => removeNodes(tx, ids), {select: []});
  return text;
}

/** Pastes clipboard content: copied layers (from this or another file) or, through the registered
 *  handlers, anything else. `data.text` null means the system clipboard was unreadable. */
export function pasteData(ctx: CommandContext, data: PasteData, inPlace: boolean): NodeId[] | null {
  const payload = resolvePayload(data.text);
  if (!payload) {
    for (const handler of pasteHandlers) if (handler(data, ctx, {inPlace})) return [];
    return null;
  }
  const state = ctx.store.getState();
  const size = ctx.canvasSize();
  const viewport = currentViewport(state);
  const view = {center: viewportCenter(viewport, size), visible: visiblePageRect(viewport, size), index: ctx.index?.() ?? null};
  // Several frames selected: a copy goes into each, as Figma pastes into several frames at once. Copied from several
  // frames, the copies go out in the frames' order: the first frame's layers into the first, and so on, round again.
  const frames = sortByPaintOrder(state.doc, pasteFrames(state.doc, state.selection, payload));
  if (frames.length > 1) {
    const parts = payloadsByParent(payload);
    let created: NodeId[] = [];
    let detached = 0;
    ctx.store.transact(inPlace ? 'Paste in place' : 'Paste', tx => {
      for (const [k, frame] of frames.entries()) {
        const part = parts[k % parts.length];
        const pasted = pastePayload(tx, part, choosePasteTarget(state.doc, state.pageId, [frame], part, view, inPlace));
        detached += detachForeignInstances(tx, payload, pasted);
        created = [...created, ...pasted];
      }
      return {select: created};
    });
    reportDetached(ctx.store, detached);
    return created;
  }
  const target = choosePasteTarget(state.doc, state.pageId, state.selection, payload, view, inPlace);
  let created: NodeId[] = [];
  let detached = 0;
  ctx.store.transact(inPlace ? 'Paste in place' : 'Paste', tx => {
    created = pastePayload(tx, payload, target);
    detached = detachForeignInstances(tx, payload, created);
    return {select: created};
  });
  reportDetached(ctx.store, detached);
  return created;
}

/** The selected frames a paste goes into, one copy each (none of them copied themselves, none inside an instance). */
function pasteFrames(doc: DesignDocument, selection: readonly NodeId[], payload: ClipboardPayload): NodeId[] {
  const frames = selection.filter(id => isDropTarget(doc.nodes[id]) && !payload.roots.includes(id) && !isInsideInstance(doc, id));
  return frames.length === selection.length ? frames : [];
}

/** The payload split by the frame its layers were copied from (in the frames' layer order); one part when they shared one. */
function payloadsByParent(payload: ClipboardPayload): ClipboardPayload[] {
  const groups = new Map<string, NodeId[]>();
  for (const root of payload.roots) {
    const key = payload.nodes[root]?.parentId ?? '';
    groups.set(key, [...(groups.get(key) ?? []), root]);
  }
  return groups.size < 2 ? [payload] : [...groups.values()].map(roots => ({...payload, roots}));
}

/** Says why pasted instances became frames (`detachForeignInstances`). */
export function reportDetached(store: DesignStore, count: number): void {
  if (!count) return;
  notify(store, count === 1
    ? 'The main component of this instance stayed in another file, so the instance was pasted as a frame. To keep the copies updating, publish the component to a library and connect the library here.'
    : 'The main components of these instances stayed in another file, so the instances were pasted as frames. To keep the copies updating, publish the components to a library and connect the library here.', 'info');
}

/** Pasted instances whose main component was in the file they were copied from but is not in this one (another file's
 *  copy) become frames that look the same, outermost first, so nothing claims its main was deleted. An instance that had
 *  already lost its main where it was copied stays such an instance (it can be restored). Returns how many became frames. */
export function detachForeignInstances(tx: Transaction, payload: ClipboardPayload, roots: readonly NodeId[]): number {
  const mains = new Set(payload.mains ?? []);
  if (!mains.size) return 0;
  let count = 0;
  for (let guard = 0; guard < 10_000; guard++) {
    const doc = tx.doc;
    const foreign = firstForeign(doc, roots, mains);
    if (!foreign) break;
    const out = detachInstance(doc, foreign);
    applyDocument(tx, out.doc, {changed: out.changed});
    count++;
  }
  return count;
}

function firstForeign(doc: DesignDocument, roots: readonly NodeId[], mains: ReadonlySet<NodeId>): NodeId | null {
  const stack = [...roots].reverse();
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    if (node.type === 'INSTANCE' && node.mainId === undefined && node.componentId && !doc.nodes[node.componentId] && mains.has(node.componentId)) return node.id;
    if (node.children) for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return null;
}

async function pasteFromMenu(ctx: CommandContext, inPlace: boolean) {
  const text = await (ctx.clipboard ?? navigatorClipboard).readText();
  pasteData(ctx, {text, html: null, files: []}, inPlace);
}

const hasSelection = (ctx: CommandContext) => ctx.store.getState().selection.length > 0;

export const CLIPBOARD_COMMANDS: Command[] = [
  {
    id: 'copy',
    label: 'Copy',
    group: 'edit',
    shortcut: {code: 'KeyC', mod: true},
    clipboardEvent: 'copy',
    enabled: hasSelection,
    run: async ctx => {
      const text = copySelection(ctx);
      if (text !== null) await (ctx.clipboard ?? navigatorClipboard).writeText(text);
    },
  },
  {
    id: 'cut',
    label: 'Cut',
    group: 'edit',
    shortcut: {code: 'KeyX', mod: true},
    clipboardEvent: 'cut',
    enabled: hasSelection,
    run: async ctx => {
      const text = cutSelection(ctx);
      if (text !== null) await (ctx.clipboard ?? navigatorClipboard).writeText(text);
    },
  },
  {
    id: 'paste',
    label: 'Paste',
    group: 'edit',
    shortcut: {code: 'KeyV', mod: true},
    clipboardEvent: 'paste',
    run: ctx => pasteFromMenu(ctx, false),
  },
  {
    id: 'paste-in-place',
    label: 'Paste in place',
    group: 'edit',
    shortcut: {code: 'KeyV', mod: true, shift: true},
    clipboardEvent: 'paste',
    run: ctx => pasteFromMenu(ctx, true),
  },
];
