import {createContext, useContext, type ComponentType} from 'react';
import type {DesignDocument, ImageAsset, ImageRef, NodeId} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';
import type {DesignFontRegistry} from '../engine/fonts';
import type {DesignImageCache} from '../engine/images';
import type {DesignSceneRenderer} from '../engine/render';
import type {CanvasController} from './CanvasView';

// What every part of an open editor shares: the store, fonts, pictures and the renderer of the file,
// plus the few side effects panels need (uploads, toasts, dialogs). `DesignEditor` creates one per open
// file and provides it; panels, tools and dialogs read it with `useEditorServices()`.

export type EditorServices = {
  fileId: string;
  store: DesignStore;
  fonts: DesignFontRegistry;
  images: DesignImageCache;
  /** The canvas renderer once the canvas is mounted (thumbnails and the player paint with `paintNodeTree`). */
  renderer(): DesignSceneRenderer | null;
  /** Uploads a picture into this file (POST /api/design-files/:id/images) and registers it in the
   *  document with `tx.setImage` as its own undo step; resolves to the ref to put in an IMAGE paint. */
  uploadImage(image: Blob, name?: string): Promise<{ref: ImageRef; asset: ImageAsset}>;
  toast(message: string, kind?: 'success' | 'error'): void;
  /** Scrolls and zooms the canvas so the nodes are in view (layers panel, "Go to main component"). */
  revealNodes(ids: readonly NodeId[]): void;
  /** Opens one of the editor's dialogs by id (export, versions, shortcuts...). */
  openDialog(id: string, params?: Record<string, unknown>): void;
  /** The canvas once mounted: view helpers (viewport, screen ↔ page) and the command context. */
  canvas?(): CanvasController | null;
  /** The file's autosave, for features that write the whole document on the server (version restore). */
  persistence?: EditorPersistence;
  /** The file is open read-only (a team's developer or viewer: docs/design-tool.md §Teams): the store refuses edits and nothing is
   *  saved; features hide what would only be refused. */
  readOnly?: boolean;
};

/** What `DesignEditor` exposes of its autosave. */
export type EditorPersistence = {
  /** The server version the editor's copy is based on. */
  version(): number;
  /** Sends everything typed so far; rejects when it could not be stored. */
  flush(): Promise<void>;
  /** The server now holds `doc` at `version` (a restored version): the editor shows it without saving
   *  it back, and autosave continues from that version. Clears undo history. */
  adopt(doc: DesignDocument, version: number): void;
};

export const EditorServicesContext = createContext<EditorServices | null>(null);

export function useEditorServices(): EditorServices {
  const services = useContext(EditorServicesContext);
  if (!services) throw Error('useEditorServices outside an open design file');
  return services;
}

// ── Plug-in points ───────────────────────────────────────────────────────────────────────────────
// Features register here from their own modules (one import line in DesignEditor.tsx), so the
// editor shows a dialog or a panel the day the feature lands and nothing before.

/** A dialog opened with `openDialog(id, params)`; rendered inside the services provider. */
export type EditorDialogProps = {params: Record<string, unknown>; onClose: () => void};
const dialogs = new Map<string, ComponentType<EditorDialogProps>>();

export function registerEditorDialog(id: string, component: ComponentType<EditorDialogProps>): () => void {
  dialogs.set(id, component);
  return () => {
    if (dialogs.get(id) === component) dialogs.delete(id);
  };
}
export const getEditorDialog = (id: string) => dialogs.get(id);

/** Panel slots a feature can fill: the left panel's pages, layers and assets, the right panel's
 *  "Prototype" and "Code" tabs. Until one is registered the editor shows its own minimal version. */
export type EditorPanelSlot = 'pages' | 'layers' | 'assets' | 'prototype' | 'code';
const panels = new Map<EditorPanelSlot, ComponentType>();

export function registerEditorPanel(slot: EditorPanelSlot, component: ComponentType): () => void {
  panels.set(slot, component);
  return () => {
    if (panels.get(slot) === component) panels.delete(slot);
  };
}
export const getEditorPanel = (slot: EditorPanelSlot) => panels.get(slot);

