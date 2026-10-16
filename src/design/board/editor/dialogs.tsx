import {lazy, Suspense, useEffect, useRef, type ComponentType} from 'react';
import {getEditorDialog, registerEditorDialog, type EditorDialogProps} from '../../editor/services';
import {EXPORT_DIALOG_ID} from '../../engine/commands/export';
import {listedCommands} from '../../editor/command-bridge';
import {ShortcutsDialog, shortcutRows, type ShortcutRow} from '../../editor/ShortcutsDialog';
import {isBoardAction} from '../commands';
import {setTemplatePublisher} from '../team-templates';

// The design editor's dialogs a board answers with its own while it is open (docs/board.md §Export, §Tools and keys): "Export…"
// exports the board or the selection as one picture, and "Keyboard shortcuts" lists the board's keys, not the design tools' (S is a
// sticky here, never "Slice").

const PublishTemplate = lazy(() => import('./PublishTemplate').then(module => ({default: module.PublishTemplateDialog})));
const ExportBoard = lazy(() => import('./ExportBoard').then(module => ({default: module.BoardExportDialog})));
const SHORTCUTS_DIALOG_ID = 'shortcuts';

/** The board's keys: its tools and commands and the design editor's commands its menu offers, with the keys that are not commands. */
export function boardShortcutRows(): ShortcutRow[] {
  const commands = listedCommands().filter(command => isBoardAction(command.id));
  return shortcutRows(commands).map(row => (row.id.startsWith('board.tool-') ? {...row, group: 'Tools'} : row.id.startsWith('board.') ? {...row, group: 'Object'} : row));
}

const BoardShortcuts = (props: EditorDialogProps) => <ShortcutsDialog {...props} rows={boardShortcutRows} />;

/** Puts the board's dialogs in place of the design editor's while mounted, and the design editor's back after. */
function useDialogOverride(id: string, component: ComponentType<EditorDialogProps>) {
  useEffect(() => {
    const previous = getEditorDialog(id);
    const off = registerEditorDialog(id, component);
    return () => {
      off();
      if (previous && !getEditorDialog(id)) registerEditorDialog(id, previous);
    };
  }, [id, component]);
}

export const PUBLISH_TEMPLATE_DIALOG_ID = 'board-template-publish';

export function useBoardDialogs(fileName: string, openDialog?: (id: string) => void) {
  const nameRef = useRef(fileName);
  nameRef.current = fileName;
  const exportRef = useRef(({params, onClose}: EditorDialogProps) => (
    <Suspense fallback={null}><ExportBoard params={params} onClose={onClose} name={() => nameRef.current} /></Suspense>
  ));
  useDialogOverride(EXPORT_DIALOG_ID, exportRef.current);
  useDialogOverride(SHORTCUTS_DIALOG_ID, BoardShortcuts);
  // "Publish as template…" (team-templates.ts): the dialog and its command, while the board is open.
  const publishRef = useRef(({params, onClose}: EditorDialogProps) => (
    <Suspense fallback={null}><PublishTemplate params={params} onClose={onClose} name={() => nameRef.current} /></Suspense>
  ));
  useDialogOverride(PUBLISH_TEMPLATE_DIALOG_ID, publishRef.current);
  useEffect(() => setTemplatePublisher(openDialog ? () => openDialog(PUBLISH_TEMPLATE_DIALOG_ID) : null), [openDialog]);
}
