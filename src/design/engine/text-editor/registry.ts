import type {NodeId, Paint, SceneNode, TextStyle} from '../../../../shared/design/types';
import type {RunOverride} from '../../../../shared/design/text-edit';
import type {FontRegistry, ImageCache} from '../contracts';
import type {DesignStore} from '../store';

// Who is editing which text, per store. The text tool opens a session and registers it here; the
// text commands and the "Text" section read it (the selection range, the caret style) without
// importing the session or the DOM. The services the editor draws with live here too, set once
// per open file by `installTextEditing`.

export type TextEditorDeps = {
  fonts: FontRegistry;
  images: ImageCache;
  /** The element the hidden input field lives in: the canvas container (`.dz-canvas`) by default. */
  host?: () => HTMLElement | null;
  /** Tells the user why an edit was refused (a text over the document's size limit). */
  toast?: (message: string, kind?: 'success' | 'error') => void;
};

/** What the rest of the editor may know about a text being edited. */
export interface ActiveTextEdit {
  readonly id: NodeId;
  /** The selection, start ≤ end. */
  range(): {start: number; end: number};
  /** The style typing at the caret will use when it differs from the text's (after ⌘B with
   *  nothing selected, or a font picked in the panel); undefined when there is none. */
  pendingStyle(): RunOverride | null | undefined;
  setPendingStyle(style: RunOverride | null | undefined): void;
  /** Gives the keyboard back to the text (after a panel button took it). */
  focus(): void;
  /** An element standing at the caret (the hidden input field), for what opens beside it. */
  anchor?(): Element | null;
  /** A text just placed that has no characters yet is not in the history: formatting it changes
   *  that placeholder (and returns true) rather than committing an empty layer. */
  amendNew?(make: (node: SceneNode) => Partial<SceneNode> | null): boolean;
}

export type TextEditingSnapshot = {id: NodeId; start: number; end: number; pending: RunOverride | null | undefined; version: number} | null;

const deps = new WeakMap<DesignStore, TextEditorDeps>();
const sessions = new WeakMap<DesignStore, ActiveTextEdit>();
const snapshots = new WeakMap<DesignStore, TextEditingSnapshot>();
const listeners = new WeakMap<DesignStore, Set<() => void>>();
let version = 0;

export const setTextEditorDeps = (store: DesignStore, value: TextEditorDeps | null) => (value ? deps.set(store, value) : deps.delete(store));
export const textEditorDeps = (store: DesignStore): TextEditorDeps | undefined => deps.get(store);

export const activeTextEdit = (store: DesignStore): ActiveTextEdit | null => sessions.get(store) ?? null;

export function setActiveTextEdit(store: DesignStore, session: ActiveTextEdit | null): void {
  if (session) sessions.set(store, session);
  else sessions.delete(store);
  notifyTextEditing(store);
}

/** Tells the subscribers (the panel) that the selection or the caret style moved. */
export function notifyTextEditing(store: DesignStore): void {
  const session = sessions.get(store);
  if (session) {
    const {start, end} = session.range();
    snapshots.set(store, {id: session.id, start, end, pending: session.pendingStyle(), version: ++version});
  } else snapshots.set(store, null);
  for (const listener of [...(listeners.get(store) ?? [])]) listener();
}

/** The text being edited and its selection, stable between changes (useSyncExternalStore). */
export const textEditingSnapshot = (store: DesignStore): TextEditingSnapshot => snapshots.get(store) ?? null;

export function subscribeTextEditing(store: DesignStore, listener: () => void): () => void {
  let set = listeners.get(store);
  if (!set) listeners.set(store, (set = new Set()));
  set.add(listener);
  return () => void set!.delete(listener);
}

// ── The style new texts start with ─────────────────────────────────────────────────────────────

/** Figma starts a new text in the font, size, weight and colour last used. */
export type RememberedTextStyle = {style: TextStyle; fills: Paint[]};
const remembered = new WeakMap<DesignStore, RememberedTextStyle>();

export const lastTextStyle = (store: DesignStore): RememberedTextStyle | undefined => remembered.get(store);

export function rememberTextStyle(store: DesignStore, style: TextStyle, fills: Paint[]): void {
  // The link stays with the text it was made in.
  const {hyperlink: _link, ...rest} = style;
  void _link;
  remembered.set(store, {style: rest, fills});
}
