import type {NodeId, SceneNode} from '../../../shared/design/types';
import {newId} from '../../../shared/design/defaults';
import {boardObjectOf, childPart, isConnector, isSticky, isTable} from '../../../shared/design/board/model';
import {fitSection, sortStickies, type SortKey} from '../../../shared/design/board/arrange';
import {STICKY_COLORS} from '../../../shared/design/board/palette';
import {TABLE_CELL} from '../../../shared/design/board/create';
import {addTableColumn, addTableRow, cellPosition, cellSpans, moveTableColumn, moveTableRow, removeTableColumn, removeTableRow, shownCell, tableCoverage, tableCsv, tableShape} from '../../../shared/design/board/table';
import {downloadBlob} from '../engine/commands/code';
import {registerCommand, runCommand, type Command, type CommandContext} from '../engine/commands';
import {BOARD_NAMES} from '../../../shared/design/board/names';
import type {MainMenuSection} from '../editor/chrome/commands';
import {editConnectorLabel} from './tools/move';
import {placeSticky} from './tools/place';
import {BOARD_TOOL_COMMANDS, boardActionFilter} from './actions';
import {IMPORT_CSV, installBoardPaste} from './paste';
import {TABLE_COMMANDS} from './table-commands';
import {SHAPE_NEXT} from './shape-next';
import {SECTION_UNWRAP, TEMPLATES_ON_NEW} from './section-commands';
import {MIND_COMMANDS} from './mind-map';
import {PUBLISH_TEMPLATE_COMMAND} from './team-templates';

// The board's own commands (docs/board.md §Commands): sorting stickies, fitting a section, a table's rows and columns, a sticky's
// author line, the next sticky (⌘↵). Registered while a board is open (`installBoardCommands`), so the design editor's quick actions
// and menus never list them. The board's main menu is the design editor's commands a board needs, plus these.

const selection = (ctx: CommandContext) => ctx.store.getState().selection;
const node = (ctx: CommandContext, id: NodeId | undefined): SceneNode | undefined => (id ? ctx.store.getState().doc.nodes[id] : undefined);
const get = (ctx: CommandContext) => (id: NodeId | null | undefined) => (id ? ctx.store.getState().doc.nodes[id] : undefined);
const selectedStickies = (ctx: CommandContext) => selection(ctx).filter(id => isSticky(node(ctx, id)));
const editable = (ctx: CommandContext) => !ctx.store.readOnly;

/** The table a command acts on, and the cell it starts from: the selected cell's text being edited, or the selected table. */
function tableTarget(ctx: CommandContext): {tableId: NodeId; row?: number; column?: number} | null {
  const state = ctx.store.getState();
  const anchor = state.editing?.id ?? state.selection[0];
  if (!anchor) return null;
  const cell = cellPosition(get(ctx), anchor);
  if (cell) return cell;
  const object = boardObjectOf(get(ctx), anchor);
  return object && isTable(object) && state.selection.length === 1 ? {tableId: object.id} : null;
}

function sortCommand(id: string, label: string, by: SortKey): Command {
  return {
    id, label, group: 'board',
    enabled: ctx => editable(ctx) && selectedStickies(ctx).length > 1,
    run: ctx => {
      const ids = selectedStickies(ctx);
      ctx.store.transact(label, tx => void sortStickies(tx, ids, by), {select: ids});
    },
  };
}

export const BOARD_COMMANDS: Command[] = [
  // "New board": the file menu's "New file" makes a board while a board is open (DesignEditor's host).
  {id: 'board.new', label: BOARD_NAMES.create, group: 'file', run: ctx => void runCommand('file.new', ctx)},
  sortCommand('board.sort-color', 'Sort stickies by color', 'color'),
  sortCommand('board.sort-author', 'Sort stickies by author', 'author'),
  {
    id: 'board.section-fit', label: 'Fit section to contents', group: 'board',
    enabled: ctx => editable(ctx) && selection(ctx).length === 1 && node(ctx, selection(ctx)[0])?.type === 'SECTION' && !!node(ctx, selection(ctx)[0])?.children?.length,
    run: ctx => {
      const id = selection(ctx)[0];
      ctx.store.transact('Fit section', tx => void fitSection(tx, id));
    },
  },
  {
    id: 'board.sticky-author', label: 'Show author', group: 'board',
    enabled: ctx => editable(ctx) && selectedStickies(ctx).length > 0,
    checked: ctx => selectedStickies(ctx).some(id => childPart(get(ctx), node(ctx, id), 'author')?.visible),
    run: ctx => {
      const ids = selectedStickies(ctx);
      const show = !ids.some(id => childPart(get(ctx), node(ctx, id), 'author')?.visible);
      ctx.store.transact(show ? 'Show author' : 'Hide author', tx => {
        for (const id of ids) {
          const author = childPart(nodeId => (nodeId ? tx.get(nodeId) : undefined), tx.get(id), 'author');
          if (author && (!show || author.text?.characters)) tx.update(author.id, {visible: show});
        }
      });
    },
  },
  {
    id: 'board.sticky-next', label: 'Next sticky nearby', group: 'board', shortcut: {code: 'Enter', mod: true},
    enabled: ctx => editable(ctx) && !!stickyOf(ctx),
    run: ctx => {
      const sticky = stickyOf(ctx)!;
      if (!ctx.enterEdit) return;
      ctx.store.setEditing(null);
      const box = worldCorner(ctx, sticky);
      const fill = sticky.fills.find(paint => paint.type === 'SOLID');
      const color = fill?.type === 'SOLID' ? colorId(fill.color) : undefined;
      placeSticky({store: ctx.store, index: () => ctx.index?.() ?? null, enterEdit: ctx.enterEdit}, {x: box.x + sticky.width * 1.5 + 24, y: box.y + sticky.height / 2}, {color, wide: sticky.board?.kind === 'sticky' && sticky.board.wide});
    },
  },
  {
    id: 'board.connector-label', label: 'Connector label', group: 'board',
    enabled: ctx => editable(ctx) && selection(ctx).length === 1 && isConnector(node(ctx, selection(ctx)[0])),
    run: ctx => {
      if (ctx.enterEdit) editConnectorLabel({store: ctx.store, enterEdit: ctx.enterEdit}, selection(ctx)[0]);
    },
  },
  {
    id: 'board.table-row-add', label: 'Add row below', group: 'board',
    enabled: ctx => editable(ctx) && !!tableTarget(ctx),
    run: ctx => {
      const target = tableTarget(ctx)!;
      ctx.store.transact('Add row', tx => void addTableRow(tx, target.tableId, newId, target.row));
    },
  },
  {
    id: 'board.table-column-add', label: 'Add column to the right', group: 'board',
    enabled: ctx => editable(ctx) && !!tableTarget(ctx),
    run: ctx => {
      const target = tableTarget(ctx)!;
      ctx.store.transact('Add column', tx => addTableColumn(tx, target.tableId, newId, target.column));
    },
  },
  {
    id: 'board.table-row-remove', label: 'Delete row', group: 'board',
    enabled: ctx => {
      const target = editable(ctx) ? tableTarget(ctx) : null;
      return !!target && (tableShape(get(ctx), target.tableId)?.rows.length ?? 0) > 1;
    },
    run: ctx => {
      const target = tableTarget(ctx)!;
      const row = target.row ?? (tableShape(get(ctx), target.tableId)?.rows.length ?? 1) - 1;
      ctx.store.setEditing(null);
      ctx.store.transact('Delete row', tx => void removeTableRow(tx, target.tableId, row), {select: [target.tableId]});
    },
  },
  {
    id: 'board.table-column-remove', label: 'Delete column', group: 'board',
    enabled: ctx => {
      const target = editable(ctx) ? tableTarget(ctx) : null;
      return !!target && (tableShape(get(ctx), target.tableId)?.columns ?? 0) > 1;
    },
    run: ctx => {
      const target = tableTarget(ctx)!;
      const column = target.column ?? (tableShape(get(ctx), target.tableId)?.columns ?? 1) - 1;
      ctx.store.setEditing(null);
      ctx.store.transact('Delete column', tx => void removeTableColumn(tx, target.tableId, column), {select: [target.tableId]});
    },
  },
  // FigJam's row and column menu (help.figma.com "Tables in FigJam"): add above or to the left, move up, down, left or right.
  {
    id: 'board.table-row-above', label: 'Add row above', group: 'board',
    enabled: ctx => editable(ctx) && tableTarget(ctx)?.row !== undefined,
    run: ctx => {
      const target = tableTarget(ctx)!;
      ctx.store.transact('Add row', tx => void addTableRow(tx, target.tableId, newId, target.row! - 1));
    },
  },
  {
    id: 'board.table-column-left', label: 'Add column to the left', group: 'board',
    enabled: ctx => editable(ctx) && tableTarget(ctx)?.column !== undefined,
    run: ctx => {
      const target = tableTarget(ctx)!;
      ctx.store.transact('Add column', tx => addTableColumn(tx, target.tableId, newId, target.column! - 1));
    },
  },
  mergeCommand('board.table-merge-right', 'Merge with the cell to the right', 'cols'),
  mergeCommand('board.table-merge-down', 'Merge with the cell below', 'rows'),
  {
    id: 'board.table-unmerge', label: 'Unmerge cells', group: 'board',
    enabled: ctx => {
      const cell = editable(ctx) ? targetCell(ctx) : null;
      return !!cell && (cellSpans(cell.node).cols > 1 || cellSpans(cell.node).rows > 1);
    },
    run: ctx => {
      const cell = targetCell(ctx)!;
      // The merged cell goes back to its own column's width (its neighbours keep theirs).
      const width = columnWidth(ctx, cell.tableId, cell.column, cell.node.id);
      ctx.store.transact('Unmerge cells', tx => {
        const node = tx.get(cell.node.id);
        if (node?.board?.kind !== 'part') return;
        const {colSpan: _c, rowSpan: _r, ...meta} = node.board;
        tx.update(node.id, {board: meta, width, layoutSizingVertical: 'FILL'});
      });
    },
  },
  tableMove('board.table-row-up', 'Move row up', 'row', -1),
  tableMove('board.table-row-down', 'Move row down', 'row', 1),
  tableMove('board.table-column-back', 'Move column left', 'column', -1),
  tableMove('board.table-column-forward', 'Move column right', 'column', 1),
  {
    // FigJam exports a table as a CSV file ("Tables in FigJam": "export your FigJam tables as images, PDFs, or CSV files").
    id: 'board.table-export-csv', label: 'Export table as CSV', group: 'board',
    enabled: ctx => !!tableTarget(ctx),
    run: ctx => {
      const target = tableTarget(ctx)!;
      const name = (node(ctx, target.tableId)?.name || 'Table').replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Table';
      downloadBlob(new Blob(['\uFEFF' + tableCsv(get(ctx), target.tableId)], {type: 'text/csv;charset=utf-8'}), name + '.csv');
    },
  },
];

/** The cell being typed in (the merged cell when it is covered), with its table and place. */
function targetCell(ctx: CommandContext): {tableId: NodeId; row: number; column: number; node: SceneNode} | null {
  const target = tableTarget(ctx);
  if (!target || target.row === undefined || target.column === undefined) return null;
  const rowId = node(ctx, target.tableId)?.children?.[target.row];
  const cellId = node(ctx, rowId ?? '')?.children?.[target.column];
  if (!cellId) return null;
  const shown = shownCell(get(ctx), cellId);
  const at = cellPosition(get(ctx), shown);
  return at ? {...at, node: node(ctx, shown)!} : null;
}

/** A column's width: its first cell's that is neither merged nor covered, not counting `except`. */
function columnWidth(ctx: CommandContext, tableId: NodeId, column: number, except: NodeId): number {
  const covered = tableCoverage(get(ctx), tableId);
  for (const rowId of node(ctx, tableId)?.children ?? []) {
    const cell = node(ctx, node(ctx, rowId)?.children?.[column] ?? '');
    if (cell && cell.id !== except && !covered.has(cell.id) && cellSpans(cell).cols === 1) return cell.width;
  }
  return TABLE_CELL.width;
}

/** Merges the cell being typed in with the next one to the right or below (FigJam's "Merge cells" on two adjacent cells). */
function mergeCommand(id: string, label: string, axis: 'cols' | 'rows'): Command {
  const reach = (ctx: CommandContext) => {
    const cell = editable(ctx) ? targetCell(ctx) : null;
    if (!cell) return null;
    const shape = tableShape(get(ctx), cell.tableId);
    const spans = cellSpans(cell.node);
    const next = axis === 'cols' ? cell.column + spans.cols : cell.row + spans.rows;
    const limit = axis === 'cols' ? shape?.columns ?? 0 : shape?.rows.length ?? 0;
    return next < limit ? {cell, spans} : null;
  };
  return {
    id, label, group: 'board', enabled: ctx => !!reach(ctx),
    run: ctx => {
      const {cell, spans} = reach(ctx)!;
      ctx.store.setEditing(null);
      ctx.store.transact(label, tx => {
        const meta = tx.get(cell.node.id)?.board;
        if (meta?.kind !== 'part') return;
        tx.update(cell.node.id, {board: {...meta, colSpan: axis === 'cols' ? spans.cols + 1 : spans.cols, rowSpan: axis === 'rows' ? spans.rows + 1 : spans.rows}});
      }, {select: [cell.tableId]});
    },
  };
}

/** Moves the row or column being typed in one place; typing stays in the same cell. */
function tableMove(id: string, label: string, axis: 'row' | 'column', step: 1 | -1): Command {
  const at = (ctx: CommandContext) => {
    const target = editable(ctx) ? tableTarget(ctx) : null;
    const index = axis === 'row' ? target?.row : target?.column;
    if (!target || index === undefined) return null;
    const shape = tableShape(get(ctx), target.tableId);
    const count = axis === 'row' ? shape?.rows.length ?? 0 : shape?.columns ?? 0;
    return index + step >= 0 && index + step < count ? {tableId: target.tableId, index} : null;
  };
  return {
    id, label, group: 'board', enabled: ctx => !!at(ctx),
    run: ctx => {
      const target = at(ctx)!;
      ctx.store.transact(label, tx => void (axis === 'row' ? moveTableRow : moveTableColumn)(tx, target.tableId, target.index, step));
    },
  };
}

/** The sticky ⌘↵ follows: the one whose text is being typed, or the one selected. */
function stickyOf(ctx: CommandContext): SceneNode | null {
  const state = ctx.store.getState();
  const id = state.editing?.id ?? (state.selection.length === 1 ? state.selection[0] : undefined);
  const object = id ? boardObjectOf(get(ctx), id) : null;
  return object && isSticky(object) ? object : null;
}

function worldCorner(ctx: CommandContext, sticky: SceneNode) {
  let x = sticky.x, y = sticky.y;
  for (let up = node(ctx, sticky.parentId ?? undefined); up && up.type !== 'PAGE'; up = node(ctx, up.parentId ?? undefined)) {
    x += up.x;
    y += up.y;
  }
  return {x, y};
}

function colorId(color: {r: number; g: number; b: number}): string | undefined {
  const hex = '#' + [color.r, color.g, color.b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  return STICKY_HEX.get(hex);
}
const STICKY_HEX = new Map(STICKY_COLORS.map(color => [color.hex.toUpperCase(), color.id]));

export function installBoardCommands(): () => void {
  const undo = [...BOARD_COMMANDS, SHAPE_NEXT, SECTION_UNWRAP, TEMPLATES_ON_NEW, PUBLISH_TEMPLATE_COMMAND, IMPORT_CSV, ...MIND_COMMANDS, ...TABLE_COMMANDS, ...BOARD_TOOL_COMMANDS].map(command => registerCommand(command));
  undo.push(installBoardPaste());
  return () => undo.forEach(off => off());
}

/** The board's main menu: what a board does from the design editor's commands, then its own. */
export const BOARD_MENU: MainMenuSection[] = [
  {id: 'file', label: 'File', items: [
    'board.new', 'file.duplicate', 'file.rename', '-',
    'board.template-publish', '-',
    'file.place-image', 'board.import-csv', 'file.open-portable', 'file.save-portable', '-',
    'file.save-version', 'file.versions', '-',
    'file.export', 'file.export-selection', '-',
    'file.trash',
  ]},
  {id: 'edit', label: 'Edit', items: [
    'edit.undo', 'edit.redo', '-',
    'edit.copy', 'edit.cut', 'edit.paste', 'edit.paste-over', 'edit.duplicate', 'edit.delete', '-',
    {label: 'Copy as', items: ['edit.copy-text', 'edit.copy-png', 'edit.copy-link']}, '-',
    'edit.select-all', 'edit.select-none', 'edit.select-inverse', 'edit.select-matching', '-',
    'edit.find',
  ]},
  {id: 'view', label: 'View', items: [
    'view.toggle-ui', '-',
    'view.zoom-in', 'view.zoom-out', 'view.zoom-100', 'view.zoom-fit', 'view.zoom-selection', '-',
    'view.page-previous', 'view.page-next', '-',
    'board.templates-on-new',
  ]},
  {id: 'object', label: 'Object', items: [
    'object.group', 'object.ungroup', '-',
    'board.sort-color', 'board.sort-author', 'arrange.tidy-up', 'board.section-fit', 'board.section-unwrap', '-',
    'board.sticky-author', 'board.sticky-next', 'board.shape-next', 'board.connector-label', '-',
    'board.mind-map', 'board.mind-child', 'board.mind-sibling', '-',
    {label: 'Table', items: ['board.table-row-above', 'board.table-row-add', 'board.table-column-left', 'board.table-column-add', '-', 'board.table-row-up', 'board.table-row-down', 'board.table-column-back', 'board.table-column-forward', '-', 'board.table-merge-right', 'board.table-merge-down', 'board.table-unmerge', '-', 'board.table-row-remove', 'board.table-column-remove', '-', 'board.table-to-stickies', 'board.table-export-csv']}, '-',
    'object.lock', 'object.hide', '-',
    'object.bring-to-front', 'object.bring-forward', 'object.send-backward', 'object.send-to-back', '-',
    'object.flip-horizontal', 'object.flip-vertical', 'object.rotate-90-cw', 'object.rotate-90-ccw',
  ]},
  {id: 'arrange', label: 'Arrange', items: [
    'arrange.align-left', 'arrange.align-center-h', 'arrange.align-right', '-',
    'arrange.align-top', 'arrange.align-center-v', 'arrange.align-bottom', '-',
    'arrange.distribute-h', 'arrange.distribute-v', 'arrange.tidy-up',
  ]},
  {id: 'help', label: 'Help', items: ['help.shortcuts', 'help.guide', '-', 'help.support']},
];

/** "Actions" on a board lists these only (actions.ts). */
export const isBoardAction = boardActionFilter(BOARD_MENU);
