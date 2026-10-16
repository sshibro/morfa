import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {pageIdOf} from '../../../../shared/design/tree';
import type {DesignStore} from '../store';
import {notify} from './components';
import {registerCommand, type ClipboardAccess, type Command} from './registry';

// "Copy link to layer" (⌘L): `<app>/#design/<file>?node=<layer>`, a link for the designer's own
// bookmarks and notes (one user, nobody else can open the file). Opening such a link (or pasting it
// into the address bar while the file is open) selects the layer, switches to its page and brings it
// into view. The app's router reads only the file id before `?` (navigation.ts `designIdFromHash`),
// so the query rides along untouched and is read here, inside the design chunk.

const NODE_PARAM = 'node';
/** "Copy link to this version" (the version history's menu): `#design/<file>?version=<id>` opens the file with that
 *  version shown, as Figma's version links do. */
const VERSION_PARAM = 'version';

/** The link to a layer (or, with a page id, to the page). */
export function nodeLink(base: {origin: string; pathname: string}, fileId: string, nodeId: NodeId): string {
  return `${base.origin}${base.pathname}#design/${encodeURIComponent(fileId)}?${NODE_PARAM}=${encodeURIComponent(nodeId)}`;
}

const decode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return '';
  }
};

/** A parameter of a `#design/<file>?…` hash of this file, or null. */
function linkedParam(hash: string, fileId: string, param: string): string | null {
  if (!hash.startsWith('#design/')) return null;
  const rest = hash.slice('#design/'.length);
  const at = rest.indexOf('?');
  if (at < 0 || decode(rest.slice(0, at)) !== fileId) return null;
  const id = new URLSearchParams(rest.slice(at + 1)).get(param);
  return id ? id : null;
}

/** The layer id a `#design/<file>?node=<id>` hash names for this file, or null. */
export const linkedNodeId = (hash: string, fileId: string): NodeId | null => linkedParam(hash, fileId, NODE_PARAM);

/** The link to a version of the file. */
export function versionLink(base: {origin: string; pathname: string}, fileId: string, versionId: string): string {
  return `${base.origin}${base.pathname}#design/${encodeURIComponent(fileId)}?${VERSION_PARAM}=${encodeURIComponent(versionId)}`;
}

/** The version id a `#design/<file>?version=<id>` hash names for this file, or null. */
export const linkedVersionId = (hash: string, fileId: string): string | null => linkedParam(hash, fileId, VERSION_PARAM);

/** Opens the version a link names, when the file opens with it and when it is pasted into the address bar while the file
 *  is open (`open` shows the history with that version). Returns the undo. */
export function followVersionLinks(options: {fileId: string; open(versionId: string): void; location?: Pick<Location, 'hash'>; target?: EventTarget}): () => void {
  const where = options.location ?? globalThis.location;
  const target = options.target ?? globalThis.window;
  let last: string | null = null;
  const follow = () => {
    const id = linkedVersionId(where.hash, options.fileId);
    if (!id || id === last) return;
    last = id;
    options.open(id);
  };
  follow();
  const onHash = () => {
    last = null;
    follow();
  };
  target?.addEventListener('hashchange', onHash);
  return () => target?.removeEventListener('hashchange', onHash);
}

/** Selects a layer the way a deep pick does (its parent becomes the entered context), on its page. */
export function selectNode(store: DesignStore, id: NodeId): boolean {
  const {doc, pageId} = store.getState();
  const node = doc.nodes[id];
  if (!node) return false;
  const page = node.type === 'PAGE' ? id : pageIdOf(doc, id);
  if (!page) return false;
  if (page !== pageId) store.setPage(page);
  if (node.type === 'PAGE') {
    store.setSelection([]);
    store.setContext(null);
    return true;
  }
  store.setSelection([id]);
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  store.setContext(parent && parent.type !== 'PAGE' && parent.type !== 'SECTION' ? parent.id : null);
  return true;
}

/** The layer "Copy link" links to: the last selected one, or the page with nothing selected. */
export function linkTarget(doc: DesignDocument, pageId: NodeId, selection: readonly NodeId[]): NodeId {
  const last = selection.at(-1);
  return last && doc.nodes[last] ? last : pageId;
}

// ── The open file ────────────────────────────────────────────────────────────────────────────────

export type LinkHost = {
  fileId: string;
  toast(message: string, kind?: 'success' | 'error'): void;
};

const hosts = new WeakMap<DesignStore, LinkHost>();

export function connectLinks(store: DesignStore, host: LinkHost): () => void {
  hosts.set(store, host);
  return () => {
    if (hosts.get(store) === host) hosts.delete(store);
  };
}

const nextFrame = (work: () => void): number =>
  globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(work) : (setTimeout(work, 16) as unknown as number);
const cancelFrame = (frame: number) => {
  if (globalThis.cancelAnimationFrame) globalThis.cancelAnimationFrame(frame);
  else clearTimeout(frame);
};

/** Honours `?node=` now and whenever the hash changes while the file is open: selects the layer and
 *  calls `reveal` (switch page, scroll and zoom). A layer that is gone says so. */
export function followNodeLinks(options: {store: DesignStore; fileId: string; reveal(id: NodeId): void; toast(message: string): void; location?: Pick<Location, 'hash'>; target?: EventTarget}): () => void {
  const where = options.location ?? globalThis.location;
  const target = options.target ?? globalThis.window;
  let frame = 0;
  let last: string | null = null;
  const follow = () => {
    const id = linkedNodeId(where.hash, options.fileId);
    if (!id || id === last) return;
    last = id;
    if (!selectNode(options.store, id)) {
      options.toast('The linked layer was not found: it may have been deleted.');
      return;
    }
    // After the canvas has measured itself (the first open fits the page first).
    cancelFrame(frame);
    frame = nextFrame(() => options.reveal(id));
  };
  follow();
  const onHash = () => {
    last = null;
    follow();
  };
  target?.addEventListener('hashchange', onHash);
  return () => {
    target?.removeEventListener('hashchange', onHash);
    cancelFrame(frame);
  };
}

/** The layer of the open file a pasted or typed address names (a "Copy link to layer" link), when it is still there. */
export function layerOfLink(store: DesignStore, value: string): NodeId | null {
  const host = hosts.get(store);
  if (!host) return null;
  let hash: string;
  try {
    hash = new URL(value.trim()).hash;
  } catch {
    return null;
  }
  const id = linkedNodeId(hash, host.fileId);
  const node = id ? store.getState().doc.nodes[id] : undefined;
  return node && node.type !== 'PAGE' ? node.id : null;
}

/** The address of a layer of the open file, as "Copy link to layer" copies it; null outside an open file. */
export function layerLink(store: DesignStore, id: NodeId): string | null {
  const host = hosts.get(store);
  return host ? nodeLink(globalThis.location, host.fileId, id) : null;
}

/** Whether the store is an open file's, whose links can be copied. */
export const canCopyLinks = (store: DesignStore) => hosts.has(store);

async function writeLink(clipboard: ClipboardAccess | undefined, text: string): Promise<boolean> {
  try {
    if (clipboard) await clipboard.writeText(text);
    else await globalThis.navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const LINK_COMMANDS: Command[] = [
  {
    id: 'edit.copy-link',
    label: 'Copy link to layer',
    group: 'edit',
    shortcut: {code: 'KeyL', mod: true},
    enabled: ctx => hosts.has(ctx.store),
    run: async ctx => {
      const host = hosts.get(ctx.store);
      if (!host) return;
      const {doc, pageId, selection} = ctx.store.getState();
      const link = nodeLink(globalThis.location, host.fileId, linkTarget(doc, pageId, selection));
      if (await writeLink(ctx.clipboard, link)) host.toast(selection.length ? 'Link to layer copied' : 'Link to page copied', 'success');
      else notify(ctx.store, CLIPBOARD_REFUSED);
    },
  },
];

const CLIPBOARD_REFUSED = 'The browser did not grant access to the clipboard. Allow it for this site and try again.';

/** "Copy link to page" (the page's menu, as in Figma): the link that opens the file on that page. */
export async function copyPageLink(store: DesignStore, pageId: NodeId, clipboard?: ClipboardAccess): Promise<boolean> {
  const host = hosts.get(store);
  if (!host) return false;
  const copied = await writeLink(clipboard, nodeLink(globalThis.location, host.fileId, pageId));
  if (copied) host.toast('Link to page copied', 'success');
  else notify(store, CLIPBOARD_REFUSED);
  return copied;
}

let registered = false;
/** Idempotent. */
export function registerLinkCommands() {
  if (registered) return;
  registered = true;
  for (const command of LINK_COMMANDS) registerCommand(command);
}
