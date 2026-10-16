import {newId} from '../../../shared/design/defaults';
import {createSticky, createTable, insertPieces, TABLE_CELL, type BoardBuild} from '../../../shared/design/board/create';
import type {Command, CommandContext} from '../engine/commands';
import {pickFile} from '../engine/commands/file';
import {registerPasteHandler, type PasteData} from '../engine/commands/clipboard';
import {currentViewport} from '../engine/store';
import {viewportCenter} from '../engine/viewport';
import {boardIdentity} from './tools/place';
import {mermaidBuilds, parseMermaid} from './mermaid';
import {linkCardsReady, linkOf, placeLinkCard} from './link-card';

// Plain text pasted on a board (docs/board.md §Objects; FigJam's, from memory): a line becomes a sticky, several lines a sticky each
// in a grid, cells copied from a spreadsheet (tab-separated rows) a table. Centred in the view, one undo step, selected. A copy of
// board objects is the editor's own payload and never reaches here.

export const PASTE_MAX_STICKIES = 100;
export const PASTE_MAX_ROWS = 50;
export const PASTE_MAX_COLUMNS = 20;
const LINE_MAX = 2000;
const STICKY = 240;
const GAP = 24;

export type PastePlan = {kind: 'stickies'; lines: string[]} | {kind: 'table'; cells: string[][]};

/** What a pasted text makes on a board, or null for nothing (blank text). */
export function pastePlan(text: string): PastePlan | null {
  const rows = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.replace(/\s+$/, ''));
  while (rows.length && !rows[rows.length - 1]) rows.pop();
  if (rows.some(row => row.includes('\t')) && rows.length > 1) {
    const cells = rows.slice(0, PASTE_MAX_ROWS).map(row => row.split('\t').slice(0, PASTE_MAX_COLUMNS).map(cell => cell.trim().slice(0, LINE_MAX)));
    const columns = Math.max(...cells.map(row => row.length));
    if (columns > 1) return {kind: 'table', cells: cells.map(row => [...row, ...Array<string>(columns - row.length).fill('')])};
  }
  // A list's bullets and numbers stay off the notes ("- idea", "1. idea").
  const lines = rows.map(row => row.trim().replace(/^(?:[-*•–]|\d+[.)])\s+/, '').slice(0, LINE_MAX)).filter(Boolean).slice(0, PASTE_MAX_STICKIES);
  return lines.length ? {kind: 'stickies', lines} : null;
}

/** Top-left corners of `count` notes in a near-square grid centred on `centre`. */
export function stickyGrid(count: number, centre: {x: number; y: number}): {x: number; y: number}[] {
  const columns = Math.ceil(Math.sqrt(count)), rows = Math.ceil(count / columns);
  const width = columns * STICKY + (columns - 1) * GAP, height = rows * STICKY + (rows - 1) * GAP;
  const left = Math.round(centre.x - width / 2), top = Math.round(centre.y - height / 2);
  return Array.from({length: count}, (_, k) => ({x: left + (k % columns) * (STICKY + GAP), y: top + Math.floor(k / columns) * (STICKY + GAP)}));
}

function builds(plan: PastePlan, centre: {x: number; y: number}): BoardBuild[] {
  if (plan.kind === 'table') {
    const columns = plan.cells[0].length;
    const x = Math.round(centre.x - (columns * TABLE_CELL.width) / 2), y = Math.round(centre.y - (plan.cells.length * TABLE_CELL.height) / 2);
    return [createTable(newId, {x, y, rows: plan.cells.length, columns, cells: plan.cells})];
  }
  const author = boardIdentity().name || undefined;
  return stickyGrid(plan.lines.length, centre).map((at, k) => createSticky(newId, {...at, text: plan.lines[k], author, showAuthor: !!author}));
}

/** The rows of a CSV file (RFC 4180: quoted cells may hold the separator, quotes doubled, line breaks); the separator is a comma,
 *  or a semicolon when the first line has more of them (a spreadsheet saved with Russian settings). */
export function parseCsv(text: string): string[][] {
  const source = text.replace(/^\uFEFF/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const separator = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [], cell = '', quoted = false;
  for (let k = 0; k < source.length; k++) {
    const ch = source[k];
    if (quoted) {
      if (ch === '"' && source[k + 1] === '"') (cell += '"'), k++;
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"' && !cell) quoted = true;
    else if (ch === separator) row.push(cell), (cell = '');
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[k + 1] === '\n') k++;
      row.push(cell), rows.push(row), (row = []), (cell = '');
    } else cell += ch;
  }
  if (cell || row.length) row.push(cell), rows.push(row);
  while (rows.length && rows[rows.length - 1].every(value => !value.trim())) rows.pop();
  return rows;
}

/** A table for a CSV file's rows, within the paste's limits; null for an empty file. */
export function csvPlan(text: string): PastePlan | null {
  const rows = parseCsv(text).slice(0, PASTE_MAX_ROWS).map(row => row.slice(0, PASTE_MAX_COLUMNS).map(cell => cell.trim().slice(0, LINE_MAX)));
  if (!rows.length) return null;
  const columns = Math.max(...rows.map(row => row.length));
  return {kind: 'table', cells: rows.map(row => [...row, ...Array<string>(columns - row.length).fill('')])};
}

/** Puts what a plan makes in the middle of the view, as one undo step, selected. */
function placePlan(plan: PastePlan, ctx: CommandContext, label: string) {
  const state = ctx.store.getState();
  const made = builds(plan, viewportCenter(currentViewport(state), ctx.canvasSize()));
  ctx.store.transact(label, tx => {
    for (const build of made) insertPieces(tx, build, state.pageId);
  }, {select: made.map(build => build.id)});
}

export const IMPORT_CSV: Command = {
  id: 'board.import-csv', label: 'Import table from CSV…', group: 'board',
  enabled: ctx => !ctx.store.readOnly,
  run: async ctx => {
    const file = await pickFile('.csv,text/csv');
    if (!file || ctx.store.readOnly) return;
    const plan = csvPlan(await file.text());
    if (plan) placePlan(plan, ctx, 'Import table');
  },
};

export function pasteOnBoard(data: PasteData, ctx: CommandContext): boolean {
  if (ctx.store.readOnly || data.files.length || !data.text) return false;
  // One web address becomes a link card once its preview arrives (link-card.ts).
  const link = linkOf(data.text);
  if (link && linkCardsReady()) {
    void placeLinkCard(ctx.store, link, viewportCenter(currentViewport(ctx.store.getState()), ctx.canvasSize()));
    return true;
  }
  // A Mermaid flowchart becomes a diagram (mermaid.ts).
  const chart = parseMermaid(data.text);
  if (chart) {
    const state = ctx.store.getState();
    const made = mermaidBuilds(newId, chart, viewportCenter(currentViewport(state), ctx.canvasSize()));
    ctx.store.transact('Paste diagram', tx => {
      for (const build of made) insertPieces(tx, build, state.pageId);
    }, {select: made.map(build => build.id)});
    return true;
  }
  const plan = pastePlan(data.text);
  if (!plan) return false;
  placePlan(plan, ctx, plan.kind === 'table' ? 'Paste table' : 'Paste stickies');
  return true;
}

export const installBoardPaste = (): (() => void) => registerPasteHandler(pasteOnBoard);
