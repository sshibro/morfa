import {lazy, Suspense, useEffect, useSyncExternalStore} from 'react';
import {registerCommand} from '../engine/commands/registry';
import {registerEditorDialog, type EditorDialogProps, type EditorServices} from '../editor/services';
import type {ShowToast} from '../ui/Toast';
import {setLibraryEditor} from './remote-main';

// Shared libraries in the editor (docs/design-tool.md §Teams, "Shared libraries"): the part the editor's first load carries. It
// registers "Libraries…" and "Publish library…" (File menu, quick actions), the three dialogs as lazy chunks, the update
// count the assets panel shows, and the open file's editor for "Go to main component" (remote-main.ts). The session, the
// dialogs and the assets panel's library sections load with the file (src/design/libraries/session.ts and the dialogs). Its
// stylesheet (styles/libraries.css) is imported by DesignEditor, so node tests can load this module.

export const LIBRARIES_DIALOG = 'libraries';
export const PUBLISH_DIALOG = 'library-publish';
export const UPDATES_DIALOG = 'library-updates';

let count = 0;
const badgeListeners = new Set<() => void>();
/** How many library updates the open file is behind on (the assets panel's dot). */
export const libraryBadge = {
  get: () => count,
  set(next: number) {
    if (next === count) return;
    count = next;
    for (const listener of [...badgeListeners]) listener();
  },
  subscribe(listener: () => void) {
    badgeListeners.add(listener);
    return () => void badgeListeners.delete(listener);
  },
};
export const useLibraryUpdateCount = () => useSyncExternalStore(libraryBadge.subscribe, libraryBadge.get, () => 0);

const LibrariesDialog = lazy(() => import('./LibrariesDialog'));
const PublishDialog = lazy(() => import('./PublishDialog'));
const UpdatesDialog = lazy(() => import('./UpdatesDialog'));
/** The assets panel's library sections (one per enabled library). */
export const LibraryAssets = lazy(() => import('./LibraryAssets'));
/** Module-level (never written inside the hook): the bundler's preload keeps the function that first asked for a chunk. */
const loadSession = () => import('./session');

type Host = {services: EditorServices; canEdit: boolean};
export type LibraryHostOptions = {canEdit: boolean; teamName: string | null; showToast: ShowToast};
let host: Host | null = null;
let registered = false;

/** Registers the commands and dialogs once (DesignEditor's feature imports). Without an open file the commands are disabled. */
export function registerLibraries(): void {
  if (registered) return;
  registered = true;
  const lazyDialog = (Component: typeof LibrariesDialog) => (props: EditorDialogProps) => (
    <Suspense fallback={null}><Component {...props} /></Suspense>
  );
  registerEditorDialog(LIBRARIES_DIALOG, lazyDialog(LibrariesDialog));
  registerEditorDialog(PUBLISH_DIALOG, lazyDialog(PublishDialog));
  registerEditorDialog(UPDATES_DIALOG, lazyDialog(UpdatesDialog));
  registerCommand({
    id: 'file.libraries',
    label: 'Libraries…',
    group: 'file',
    enabled: () => !!host,
    run: () => host?.services.openDialog(LIBRARIES_DIALOG),
  });
  registerCommand({
    id: 'file.publish-library',
    label: 'Publish library…',
    group: 'file',
    enabled: () => !!host?.canEdit,
    run: () => host?.services.openDialog(PUBLISH_DIALOG),
  });
}

/** The open file's libraries: its session starts (lazily) when the file opens and stops when it closes. */
export function useLibraryHost(services: EditorServices, {canEdit, teamName, showToast}: LibraryHostOptions): void {
  useEffect(() => {
    const current: Host = {services, canEdit};
    host = current;
    setLibraryEditor(services);
    let stop: (() => void) | null = null;
    let cancelled = false;
    void loadSession().then(module => {
      if (!cancelled) stop = module.startLibrarySession(services, {canEdit, teamName, showToast});
    });
    return () => {
      cancelled = true;
      stop?.();
      if (host === current) host = null;
      setLibraryEditor(null, services);
    };
  }, [services, canEdit, teamName, showToast]);
}
