import type {CommandLookup, MainMenuSection} from '../design/editor/chrome/commands';

// What the desktop app (desktop/, docs/desktop.md) plugs into the web app. This file is all the main bundle carries:
// a few empty hooks. In a browser nothing ever fills them; in the desktop app the lazily loaded bridge
// (src/desktop/bridge.ts) does, and the places below call them instead of the browser's own way.

export type DesktopHost = {
  /** "Save to computer": the native save dialog (src/design/persistence/portable.ts `saveBlob`). */
  saveFile?: (blob: Blob, filename: string) => Promise<void>;
  /** "Open file from computer…": the native open dialog (src/design/engine/commands/file.ts `pickFile`). */
  pickFile?: (accept: string) => Promise<File | null>;
  /** A file in its own window instead of a browser tab (file.ts `openInNewTab`). */
  openWindow?: (hash: string) => void;
};

export const desktopHost: DesktopHost = {};

/** The editor's main menu as the editor sees it: sections of command ids and the live command lookup. */
export type EditorMenuSource = {
  sections: readonly MainMenuSection[];
  lookup: CommandLookup;
  /** Commands that work through the browser's clipboard events (copy, cut, paste). */
  clipboard?: (id: string) => 'copy' | 'cut' | 'paste' | undefined;
};

let menuSource: EditorMenuSource | null = null;
const menuListeners = new Set<(source: EditorMenuSource | null) => void>();

/** The editor publishes its menu while it is open (DesignEditor.tsx); the returned function withdraws it. */
export function publishEditorMenu(source: EditorMenuSource): () => void {
  menuSource = source;
  for (const listener of [...menuListeners]) listener(source);
  return () => {
    if (menuSource !== source) return;
    menuSource = null;
    for (const listener of [...menuListeners]) listener(null);
  };
}

/** The bridge follows the editor's menu: called now with the current one, then on every change. */
export function watchEditorMenu(listener: (source: EditorMenuSource | null) => void): () => void {
  menuListeners.add(listener);
  listener(menuSource);
  return () => menuListeners.delete(listener);
}

let fontsReady = false;
const fontWaiters = new Set<() => void>();

/** Runs `load` once the desktop app can list local fonts without asking (now, or when the bridge starts); never
 *  in a browser. The editor's font registry uses it to show local fonts like Figma's desktop app. */
export function whenDesktopFonts(load: () => void): () => void {
  // A browser keeps no waiter (each would hold its registry for the page's lifetime).
  if (!fontsReady && !desktopMarker()) return () => {};
  if (fontsReady) {
    load();
    return () => {};
  }
  fontWaiters.add(load);
  return () => fontWaiters.delete(load);
}

/** The bridge: local fonts can be listed now. */
export function desktopFontsReady() {
  fontsReady = true;
  for (const load of [...fontWaiters]) load();
  fontWaiters.clear();
}

/** Marks set by the desktop shell before the page runs (desktop/src-tauri/src/shell.rs `marker_script`). */
export type DesktopMarker = {version: string; platform: string};

export const desktopMarker = (scope: object = globalThis): DesktopMarker | undefined => {
  const marker = (scope as {__MORFA_DESKTOP__?: DesktopMarker}).__MORFA_DESKTOP__;
  // Tauri's own IPC must be there too: the marker alone (a page that sets it itself) loads nothing useful.
  return marker && typeof marker === 'object' && (scope as {__TAURI_INTERNALS__?: unknown}).__TAURI_INTERNALS__ ? marker : undefined;
};

/** Loads the bridge in the desktop app; in a browser it does nothing and loads nothing. */
export function startDesktop(scope: object = globalThis): Promise<unknown> | undefined {
  if (!desktopMarker(scope)) return undefined;
  return import('./bridge').then(bridge => bridge.startBridge(), error => console.error('Morfa desktop bridge:', error));
}
