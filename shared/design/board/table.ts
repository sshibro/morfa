import type {NodeId, SceneNode} from '../types';
import type {Transaction} from '../transaction';
import {childPart, partOf} from './model';
import {tableCellPieces, tableRowPieces, TABLE_CELL, type NewId} from './create';

// "Table" on a board (docs/board.md §Tables): rows and columns added and removed in place, one undo step each. A table is a
// vertical auto-layout frame of rows, each a horizontal frame of cells; a column is the cells at one index in every row.

type Get = (id: NodeId | null | undefined) => SceneNode | undefined;

export type TableShape = {rows: NodeId[]; columns: number};

export function tableShape(get: Get, tableId: NodeId): TableShape | null {
  const table = get(tableId);
  if (table?.board?.kind !== 'table') return null;
  const rows = (table.children ?? []).filter(id => partOf(get(id)) === 'row');
  const columns = Math.max(0, ...rows.map(id => get(id)?.children?.length ?? 0));
  return {rows, columns};
}

/** Where a layer sits in its table: the table, the row index and the column index (null outside a table). */
export function cellPosition(get: Get, id: NodeId): {tableId: NodeId; row: number; column: number} | null {
  let node = get(id);
  while (node && partOf(node) !== 'cell') {
    if (node.board?.kind === 'table' || !node.board) return null;
    node = get(node.parentId);
  }
  const row = get(node?.parentId);
  const table = get(row?.parentId);
  if (!node || !row || table?.board?.kind !== 'table') return null;
  return {tableId: table.id, row: table.children!.indexOf(row.id), column: row.children!.indexOf(node.id)};
}

/** Adds a row after `after` (or at the end; −1 puts it first), its cells as wide as the row next to it. */
export function addTableRow(tx: Transaction, tableId: NodeId, newId: NewId, after?: number): NodeId | null {
  const get: Get = id => (id ? tx.get(id) : undefined);
  const shape = tableShape(get, tableId);
  if (!shape) return null;
  const model = get(shape.rows[Math.max(0, Math.min(after ?? shape.rows.length - 1, shape.rows.length - 1))]);
  const widths = (model?.children ?? []).map(id => get(id)?.width ?? TABLE_CELL.width);
  const pieces = tableRowPieces(newId, tableId, [], widths.length ? widths : Array.from({length: Math.max(1, shape.columns)}, () => TABLE_CELL.width), false);
  const index = after === undefined ? undefined : after + 1;
  pieces.forEach((piece, i) => tx.create(piece.node, piece.parent, i === 0 ? index : undefined));
  return pieces[0].node.id;
}

/** Adds a column after `after` (or at the end; −1 puts it first): a cell in every row, as wide as the cells of the column next to it. */
export function addTableColumn(tx: Transaction, tableId: NodeId, newId: NewId, after?: number): void {
  const get: Get = id => (id ? tx.get(id) : undefined);
  const shape = tableShape(get, tableId);
  if (!shape) return;
  shape.rows.forEach((rowId, r) => {
    const row = get(rowId)!;
    const cells = row.children ?? [];
    const model = get(cells[Math.max(0, Math.min(after ?? cells.length - 1, cells.length - 1))]);
    const header = r === 0 && !!model && model.fills.some(paint => paint.type === 'SOLID' && paint.color.r < 0.96);
    const pieces = tableCellPieces(newId, rowId, '', model?.width ?? TABLE_CELL.width, header);
    pieces.forEach((piece, i) => tx.create(piece.node, piece.parent, i === 0 && after !== undefined ? after + 1 : undefined));
  });
}

/** Moves a row one place up or down (−1, +1); false at the edge. */
export function moveTableRow(tx: Transaction, tableId: NodeId, index: number, step: 1 | -1): boolean {
  const shape = tableShape(id => (id ? tx.get(id) : undefined), tableId);
  const to = index + step;
  if (!shape || !shape.rows[index] || to < 0 || to >= shape.rows.length) return false;
  tx.reorder(shape.rows[index], to);
  return true;
}

/** Moves a column one place left or right (−1, +1): its cell in every row; false at the edge. */
export function moveTableColumn(tx: Transaction, tableId: NodeId, index: number, step: 1 | -1): boolean {
  const get: Get = id => (id ? tx.get(id) : undefined);
  const shape = tableShape(get, tableId);
  const to = index + step;
  if (!shape || index < 0 || to < 0 || to >= shape.columns) return false;
  for (const rowId of shape.rows) {
    const cell = get(rowId)?.children?.[index];
    if (cell) tx.reorder(cell, to);
  }
  return true;
}

/** Removes a row (the last row stays: remove the table instead). */
export function removeTableRow(tx: Transaction, tableId: NodeId, index: number): boolean {
  const shape = tableShape(id => (id ? tx.get(id) : undefined), tableId);
  if (!shape || shape.rows.length <= 1 || !shape.rows[index]) return false;
  tx.remove(shape.rows[index]);
  return true;
}

/** Removes a column (the last column stays). */
export function removeTableColumn(tx: Transaction, tableId: NodeId, index: number): boolean {
  const get: Get = id => (id ? tx.get(id) : undefined);
  const shape = tableShape(get, tableId);
  if (!shape || shape.columns <= 1) return false;
  for (const rowId of shape.rows) {
    const cell = get(rowId)?.children?.[index];
    if (cell) tx.remove(cell);
  }
  return true;
}

/** Rows as a CSV file (RFC 4180: a cell with a comma, a quote or a line break in quotes, quotes doubled; CRLF line ends). */
export function csvText(rows: readonly (readonly string[])[]): string {
  const cell = (value: string) => (/[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** A table's texts as a CSV file. */
export const tableCsv = (get: Get, tableId: NodeId): string => csvText(tableTexts(get, tableId));

/** The texts of a table, row by row (copying a table as text, the AI). */
export function tableTexts(get: Get, tableId: NodeId): string[][] {
  const shape = tableShape(get, tableId);
  if (!shape) return [];
  return shape.rows.map(rowId => (get(rowId)?.children ?? []).map(cellId => childPart(get, get(cellId), 'text')?.text?.characters ?? ''));
}

// ── Merged cells (FigJam's "Merge cells"; lane G's `colSpan` / `rowSpan` on a cell) ────────────────

/** A cell's spans, 1 × 1 when it has none. */
export function cellSpans(cell: SceneNode | undefined): {cols: number; rows: number} {
  const meta = cell?.board?.kind === 'part' ? cell.board : null;
  return {cols: Math.max(1, meta?.colSpan ?? 1), rows: Math.max(1, meta?.rowSpan ?? 1)};
}

/** What a merged cell covers. In its own row the cells after it leave the flow (`hidden`); in each row below, the first covered
 *  cell keeps the place as an invisible spacer as wide as the merged cell (`spacer`) and the rest leave the flow. Covered cells
 *  point at the merged cell (`anchor`). Spans reaching past the table's edge are cut at it; a cell inside another merge is covered,
 *  never an anchor itself. */
export type CellCover = {anchor: NodeId; role: 'hidden' | 'spacer'};

export function tableCoverage(get: Get, tableId: NodeId): Map<NodeId, CellCover> {
  const covered = new Map<NodeId, CellCover>();
  const shape = tableShape(get, tableId);
  if (!shape) return covered;
  const grid = shape.rows.map(rowId => get(rowId)?.children ?? []);
  grid.forEach((cells, r) => cells.forEach((cellId, c) => {
    if (covered.has(cellId)) return;
    const {cols, rows} = cellSpans(get(cellId));
    if (cols === 1 && rows === 1) return;
    for (let dr = 0; dr < rows && r + dr < grid.length; dr++) {
      for (let dc = 0; dc < cols && c + dc < grid[r + dr].length; dc++) {
        if (!dr && !dc) continue;
        const id = grid[r + dr][c + dc];
        if (!covered.has(id)) covered.set(id, {anchor: cellId, role: dr > 0 && dc === 0 ? 'spacer' : 'hidden'});
      }
    }
  }));
  return covered;
}

/** The cell that shows for `cellId`: itself, or the merged cell covering it. */
export function shownCell(get: Get, cellId: NodeId): NodeId {
  const at = cellPosition(get, cellId);
  return (at && tableCoverage(get, at.tableId).get(cellId)?.anchor) ?? cellId;
}
