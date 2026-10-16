import type {NodeId, SceneNode} from '../../../shared/design/types';
import {newId} from '../../../shared/design/defaults';
import {childPart, isTable} from '../../../shared/design/board/model';
import {createSticky, insertPieces} from '../../../shared/design/board/create';
import {cellPosition, tableCoverage, tableShape, tableTexts} from '../../../shared/design/board/table';
import type {Command, CommandContext} from '../engine/commands';
import {boardIdentity} from './tools/place';

// A table's keys and quick actions (help.figma.com "Tables in FigJam"): Tab and ⇧Tab move to the next and the previous cell while
// typing in one; "Convert to stickies" turns the selected table into a sticky per filled cell, laid out as the table was.

const STICKY = 240;
const GAP = 24;

const lookup = (ctx: CommandContext) => (id: NodeId | null | undefined): SceneNode | undefined => (id ? ctx.store.getState().doc.nodes[id] : undefined);

/** The text of the cell `step` cells after (or before) the one being typed in, reading row by row; null at either end. */
export function neighbourCellText(get: (id: NodeId | null | undefined) => SceneNode | undefined, editing: NodeId, step: 1 | -1): NodeId | null {
  const at = cellPosition(get, editing);
  if (!at) return null;
  const shape = tableShape(get, at.tableId);
  if (!shape || !shape.columns) return null;
  // Covered cells of a merge are passed over: the merged cell shows for them.
  const covered = tableCoverage(get, at.tableId);
  for (let index = at.row * shape.columns + at.column + step; index >= 0 && index < shape.rows.length * shape.columns; index += step) {
    const row = get(shape.rows[Math.floor(index / shape.columns)]);
    const cell = get(row?.children?.[index % shape.columns]);
    if (cell && covered.has(cell.id)) continue;
    return childPart(get, cell, 'text')?.id ?? null;
  }
  return null;
}

/** Moves typing to the neighbouring cell; true when the editor is in a table cell (the key is the table's then, even at an end). */
export function stepCell(ctx: CommandContext, step: 1 | -1): boolean {
  const editing = ctx.store.getState().editing;
  if (editing?.kind !== 'text' || !cellPosition(lookup(ctx), editing.id)) return false;
  const next = neighbourCellText(lookup(ctx), editing.id, step);
  if (next && ctx.enterEdit) {
    ctx.store.setEditing(null);
    ctx.enterEdit(next, 'text');
  }
  return true;
}

const selectedTable = (ctx: CommandContext): SceneNode | null => {
  const {selection} = ctx.store.getState();
  const node = selection.length === 1 ? lookup(ctx)(selection[0]) : undefined;
  return node && isTable(node) ? node : null;
};

export const TABLE_COMMANDS: Command[] = [
  {
    id: 'board.table-to-stickies', label: 'Convert table to stickies', group: 'board',
    enabled: ctx => !ctx.store.readOnly && !!selectedTable(ctx) && tableTexts(lookup(ctx), selectedTable(ctx)!.id).flat().some(Boolean),
    run: ctx => {
      const table = selectedTable(ctx)!;
      const parent = table.parentId ?? ctx.store.getState().pageId;
      const author = boardIdentity().name || undefined;
      const builds = tableTexts(lookup(ctx), table.id).flatMap((row, r) => row.flatMap((text, c) => (text.trim()
        ? [createSticky(newId, {x: Math.round(table.x + c * (STICKY + GAP)), y: Math.round(table.y + r * (STICKY + GAP)), text, author, showAuthor: !!author})]
        : [])));
      ctx.store.transact('Table to stickies', tx => {
        for (const build of builds) insertPieces(tx, build, parent);
        tx.remove(table.id);
      }, {select: builds.map(build => build.id)});
    },
  },
];
