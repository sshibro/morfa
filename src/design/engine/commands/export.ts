import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import type {Command} from './registry';
import {registerCommand} from './registry';

// "Export…" (⇧⌘E) and "Export selection…" from the main menu: both open the export dialog
// (src/design/editor/ExportDialog.tsx) — the page's layers that have export settings, or the
// selection (a selected layer without settings exports as PNG 1x). Commands cannot reach the editor's
// services, so the editor passes how to open the dialog:
//
//   registerExportCommands(scope => services.openDialog(EXPORT_DIALOG_ID, {scope}));

export type ExportScope = 'page' | 'selection';
export const EXPORT_DIALOG_ID = 'export';

export function exportCommands(open: (scope: ExportScope) => void): Command[] {
  return [
    {id: 'file.export', label: 'Export…', group: 'file', shortcut: {code: 'KeyE', mod: true, shift: true}, run: () => open('page')},
    {id: 'file.export-selection', label: 'Export selection…', group: 'file',
      enabled: ctx => ctx.store.getState().selection.length > 0, run: () => open('selection')},
  ];
}

/** Registers both commands; returns their removal. */
export function registerExportCommands(open: (scope: ExportScope) => void): () => void {
  const removals = exportCommands(open).map(command => registerCommand(command));
  return () => removals.forEach(remove => remove());
}

/** The layers the dialog lists: on the page, every layer with export settings in layers-panel
 *  order (top first); for the selection, the selected layers. */
export function exportableIds(doc: DesignDocument, pageId: NodeId, scope: ExportScope, selection: readonly NodeId[]): NodeId[] {
  if (scope === 'selection') return selection.filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
  const out: NodeId[] = [];
  const visit = (parentId: NodeId) => {
    const children = doc.nodes[parentId]?.children ?? [];
    for (let i = children.length - 1; i >= 0; i--) {
      const node = doc.nodes[children[i]];
      if (!node) continue;
      if (node.exportSettings.length) out.push(node.id);
      if (node.children?.length) visit(node.id);
    }
  };
  visit(pageId);
  return out;
}
