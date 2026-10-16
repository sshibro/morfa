import type {DesignDocument} from '../../../shared/design/types';
import {applyPatch, type DocumentPatch} from '../../../shared/design/patch';
import type {DesignStore} from '../engine/store';

// The open editor streams its document to the player tab, so the player shows what the designer
// sees, unsaved changes included, and follows edits live. A same-origin BroadcastChannel per file:
// the player says hello, one editor answers with its document and then sends every committed
// patch in order. A player nobody answers reads the saved file instead (Player.tsx).

type Hello = {type: 'hello'; id: string};
type Snapshot = {type: 'doc'; to: string; from: string; seq: number; doc: DesignDocument};
type Patch = {type: 'patch'; from: string; seq: number; patch: DocumentPatch};
type Message = Hello | Snapshot | Patch;

const channelName = (fileId: string) => `morfa-design-player:${fileId}`;
const randomId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const isMessage = (value: unknown): value is Message => !!value && typeof value === 'object' && typeof (value as {type?: unknown}).type === 'string';

/** Editor side: answers players of `fileId` and streams the store's patches to them. `live` says the
 *  editor still shows this store; once it does not, the feed closes instead of answering. */
export function connectPlayerFeed(fileId: string, store: DesignStore, live: () => boolean = () => true): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(channelName(fileId));
  const id = randomId();
  let seq = 0;
  let listening = false;
  let off: (() => void) | null = null;
  const close = () => {
    off?.();
    off = null;
    channel.close();
  };
  channel.onmessage = event => {
    const message = event.data;
    if (!isMessage(message) || message.type !== 'hello' || typeof message.id !== 'string') return;
    if (!live()) return close();
    listening = true;
    channel.postMessage({type: 'doc', to: message.id, from: id, seq, doc: store.getState().doc} satisfies Snapshot);
  };
  off = store.onPatch(event => {
    seq++;
    if (!listening) return;
    if (!live()) return close();
    channel.postMessage({type: 'patch', from: id, seq, patch: event.patch} satisfies Patch);
  });
  return close;
}

let active: {store: DesignStore; close: () => void; editor: Element | null} | null = null;

/** Connects the open editor's store to its players once (▶, "Run", the "Prototype" tab call it).
 *  The feed lives while `editor` (the editor's root element) is in the page: leaving the file, or
 *  opening it again in a new session, retires it, so a player never gets a closed editor's copy. */
export function ensurePlayerFeed(fileId: string, store: DesignStore, editor: Element | null): void {
  if (active && active.store === store && (!active.editor || active.editor.isConnected)) return;
  active?.close();
  const element = editor;
  active = {store, editor: element, close: connectPlayerFeed(fileId, store, () => !element || element.isConnected)};
}

/** Player side: calls `onDocument` with the editor's document and again after each of its edits.
 *  Follows one editor tab (the first to answer); asks again if it ever misses a patch. */
export function subscribeEditorFeed(fileId: string, onDocument: (doc: DesignDocument) => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const channel = new BroadcastChannel(channelName(fileId));
  const id = randomId();
  let source: string | null = null;
  let seq = -1;
  let doc: DesignDocument | null = null;
  const hello = () => channel.postMessage({type: 'hello', id} satisfies Hello);
  channel.onmessage = event => {
    const message = event.data;
    if (!isMessage(message)) return;
    if (message.type === 'doc') {
      if (message.to !== id || (source && message.from !== source) || !message.doc || !Array.isArray(message.doc.pages)) return;
      source = message.from;
      seq = message.seq;
      doc = message.doc;
      onDocument(doc);
    } else if (message.type === 'patch' && doc && message.from === source) {
      if (message.seq === seq + 1) {
        seq = message.seq;
        doc = applyPatch(doc, message.patch);
        onDocument(doc);
      } else if (message.seq > seq + 1) hello();
    }
  };
  hello();
  return () => channel.close();
}
