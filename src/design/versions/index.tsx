import {lazy, Suspense, type ComponentType} from 'react';

// "Version history" as one of the editor's dialogs (EditorServices.openDialog): the id the file commands
// open, and a lazy entry so the history, its preview renderer and its styles load the first time it opens.

export const VERSIONS_DIALOG = 'versions';

export type VersionsDialogProps = {params: Record<string, unknown>; onClose: () => void};

const Panel = lazy(() => import('./VersionHistory').then(module => ({default: module.VersionHistoryDialog})));

/** `openDialog('versions')` shows the history; `openDialog('versions', {save: true})` opens it on the "Save version" form. */
export function VersionsDialog(props: VersionsDialogProps) {
  return (
    <Suspense fallback={null}>
      <Panel {...props} />
    </Suspense>
  );
}

/** Registers the dialog with the editor's registry (`registerEditorDialog` of src/design/editor/services.ts). */
export function registerVersionDialogs(register: (id: string, component: ComponentType<VersionsDialogProps>) => () => void): () => void {
  return register(VERSIONS_DIALOG, VersionsDialog);
}
