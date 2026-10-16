import type {NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {newId} from '../../../../shared/design/defaults';
import {createSticky, createStamp, createTable, STAMP_SIZE, TABLE_CELL, type BoardBuild} from '../../../../shared/design/board/create';
import {boardObjectOf, childPart, isShapeWithText, isSticky} from '../../../../shared/design/board/model';
import {stickyColor} from '../../../../shared/design/board/palette';
import {stampSpec} from '../../../../shared/design/board/art';
import type {Tool, ToolContext, ToolPointerEvent, ViewHelpers} from '../../engine/tools/types';
import {pickAt} from '../../engine/hit-test';
import type {EditorState} from '../../engine/store';
import {boardChoices} from '../state';
import {boardEmote} from '../meeting';
import {insertBuild, placement, roundRect} from './common';

// Tools that place an object with a click (docs/board.md §Tools): "Sticky" (S) puts a note where the pointer is and opens it for
// typing, "Table" a 3 × 3 table, "Stamp" (E) the chosen stamp (and stays for the next one). A ghost of the note or the stamp
// follows the pointer, as in FigJam.

let identity: {name: string} = {name: ''};
/** Who is at the board: the avatar stamp and a sticky's author line carry this name. */
export function setBoardIdentity(next: {name: string}) {
  identity = next;
}
export const boardIdentity = () => identity;

/** A sticky at `page` (its middle), as one undo step, opened for typing; returns its id. It carries the author's name at its foot
 *  (FigJam: "Your stickies automatically include your name at the bottom"); "Show author" hides it. */
export function placeSticky(ctx: Pick<ToolContext, 'store' | 'index' | 'enterEdit'>, page: Vec, options: {color?: string; text?: string; edit?: boolean; wide?: boolean} = {}): NodeId | null {
  const state = ctx.store.getState();
  const {parentId, local} = placement(state, page, ctx.index());
  const width = options.wide ? 480 : 240;
  const name = identity.name;
  const build = createSticky(newId, {x: Math.round(local.x - width / 2), y: Math.round(local.y - 120), color: options.color ?? boardChoices().stickyColor, text: options.text, author: name || undefined, showAuthor: !!name, wide: options.wide});
  const id = insertBuild(ctx.store, 'Sticky', build, parentId);
  if (id && options.edit !== false) {
    const text = childPart(nodeId => ctx.store.getState().doc.nodes[nodeId ?? ''], ctx.store.getState().doc.nodes[id], 'text');
    if (text) ctx.enterEdit(text.id, 'text');
  }
  return id;
}

abstract class ClickTool implements Tool {
  abstract readonly id: string;
  readonly cursor: string = 'crosshair';
  protected at: Vec | null = null;

  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
  }

  deactivate(ctx: ToolContext) {
    this.at = null;
    ctx.requestOverlay();
  }

  overlayHints() {
    return {hover: false, handles: false};
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    this.at = e.buttons ? null : e.page;
    ctx.requestOverlay();
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    this.place(e.page, ctx, e);
  }

  protected abstract place(page: Vec, ctx: ToolContext, e: ToolPointerEvent): void;
}

export class StickyTool extends ClickTool {
  readonly id = 'board-sticky';

  protected place(page: Vec, ctx: ToolContext) {
    this.at = null;
    placeSticky(ctx, page);
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    if (!this.at) return;
    const zoom = view.viewport().zoom;
    const centre = view.pageToScreen(this.at);
    const size = 240 * zoom;
    ctx2d.save();
    ctx2d.globalAlpha = 0.55;
    ctx2d.fillStyle = stickyColor(boardChoices().stickyColor).hex;
    roundRect(ctx2d, centre.x - size / 2, centre.y - size / 2, size, size, 2 * zoom);
    ctx2d.fill();
    ctx2d.restore();
  }
}

/** A table dragged out (FigJam: "Click and drag to create the number of columns and rows you need"): its corner and how many
 *  columns and rows the drag from `from` to `to` covers, at least one of each; a click (no drag) gives 3 × 3 at the pointer. */
export function draggedTable(from: Vec, to: Vec | null): {x: number; y: number; columns: number; rows: number} {
  if (!to || (Math.abs(to.x - from.x) < TABLE_CELL.width / 2 && Math.abs(to.y - from.y) < TABLE_CELL.height / 2)) return {x: from.x, y: from.y, columns: 3, rows: 3};
  const columns = Math.min(TABLE_MAX_COLUMNS, Math.max(1, Math.round(Math.abs(to.x - from.x) / TABLE_CELL.width)));
  const rows = Math.min(TABLE_MAX_ROWS, Math.max(1, Math.round(Math.abs(to.y - from.y) / TABLE_CELL.height)));
  return {x: to.x < from.x ? from.x - columns * TABLE_CELL.width : from.x, y: to.y < from.y ? from.y - rows * TABLE_CELL.height : from.y, columns, rows};
}
const TABLE_MAX_COLUMNS = 20, TABLE_MAX_ROWS = 50;

export class TableTool extends ClickTool {
  readonly id = 'board-table';
  private from: Vec | null = null;
  private to: Vec | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    this.from = e.page;
    this.to = null;
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    if (this.from && e.buttons) {
      this.to = e.page;
      ctx.requestOverlay();
      return;
    }
    super.onPointerMove(e, ctx);
  }

  deactivate(ctx: ToolContext) {
    this.from = this.to = null;
    super.deactivate(ctx);
  }

  protected place(page: Vec, ctx: ToolContext) {
    const size = draggedTable(this.from ?? page, this.to);
    this.at = this.from = this.to = null;
    const state = ctx.store.getState();
    const {parentId, local} = placement(state, {x: size.x, y: size.y}, ctx.index());
    insertBuild(ctx.store, 'Table', createTable(newId, {x: Math.round(local.x), y: Math.round(local.y), rows: size.rows, columns: size.columns, header: true}), parentId);
    ctx.setTool('move');
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const size = this.from ? draggedTable(this.from, this.to) : this.at ? {...this.at, columns: 3, rows: 3} : null;
    if (!size) return;
    const zoom = view.viewport().zoom;
    const at = view.pageToScreen({x: size.x, y: size.y});
    const w = TABLE_CELL.width * zoom, h = TABLE_CELL.height * zoom;
    ctx2d.save();
    ctx2d.strokeStyle = 'rgba(30, 30, 30, 0.45)';
    ctx2d.lineWidth = 1;
    for (let r = 0; r <= size.rows; r++) {
      ctx2d.beginPath();
      ctx2d.moveTo(at.x, at.y + r * h);
      ctx2d.lineTo(at.x + size.columns * w, at.y + r * h);
      ctx2d.stroke();
    }
    for (let c = 0; c <= size.columns; c++) {
      ctx2d.beginPath();
      ctx2d.moveTo(at.x + c * w, at.y);
      ctx2d.lineTo(at.x + c * w, at.y + size.rows * h);
      ctx2d.stroke();
    }
    ctx2d.restore();
  }
}

/** The sticky or shape with text under `page` that a stamp placed there attaches to, or null. */
export function stampHolderAt(state: EditorState, page: Vec, ctx: Pick<ToolContext, 'view' | 'index'>): SceneNode | null {
  const picked = pickAt(state.doc, state.pageId, page, {tolerance: 0, index: ctx.index()});
  const object = picked ? boardObjectOf(id => (id ? state.doc.nodes[id] : undefined), picked) : null;
  return object && (isSticky(object) || isShapeWithText(object)) && !object.locked ? object : null;
}

/** The meeting's emote for a stamp (a stamp without its own emote bursts a heart). */
const STAMP_EMOTES: Partial<Record<string, string>> = {heart: 'heart', like: 'like', dislike: 'dislike', fire: 'fire', star: 'party', 'plus-one': 'like', check: 'like'};

/** Hold and wiggle grows a stamp (FigJam): every 10 px the pointer travels while held adds 1 px, up to three times the size. */
export const STAMP_MAX_SIZE = STAMP_SIZE * 3;
export const grownStampSize = (wiggle: number) => Math.round(Math.min(STAMP_MAX_SIZE, STAMP_SIZE + Math.max(0, wiggle) / 10));

export class StampTool extends ClickTool {
  readonly id = 'board-stamp';

  /** Where the press began (the stamp lands there), the screen point last seen and how far the pointer has wiggled since. */
  private press: {page: Vec; last: Vec; wiggle: number} | null = null;

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0 || e.shiftKey) return;
    this.press = {page: e.page, last: e.screen, wiggle: 0};
    this.at = e.page;
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    if (!this.press || !e.buttons) {
      this.press = null;
      super.onPointerMove(e, ctx);
      return;
    }
    this.press.wiggle += Math.hypot(e.screen.x - this.press.last.x, e.screen.y - this.press.last.y);
    this.press.last = e.screen;
    ctx.requestOverlay();
  }

  deactivate(ctx: ToolContext) {
    this.press = null;
    super.deactivate(ctx);
  }

  private size() {
    return this.press ? grownStampSize(this.press.wiggle) : STAMP_SIZE;
  }

  protected place(page: Vec, ctx: ToolContext, e?: ToolPointerEvent) {
    // ⇧-click bursts the stamp as an emote for everyone here instead of placing it (FigJam), while a meeting runs.
    if (e?.shiftKey && boardEmote(page, STAMP_EMOTES[boardChoices().stamp] ?? 'heart')) return;
    const size = this.size();
    if (this.press) page = this.press.page;
    this.press = null;
    const state = ctx.store.getState();
    // On a sticky or a shape the stamp is attached: it moves with the object (FigJam: "Attached stamps move with the object when
    // it's repositioned"), placed absolutely inside it so its layout never moves it.
    const holder = stampHolderAt(state, page, ctx);
    const {parentId, local} = holder ? {parentId: holder.id, local: apply(invert(worldMatrix(state.doc, holder.id)), page)} : placement(state, page, ctx.index());
    const stamp = boardChoices().stamp;
    const build = createStamp(newId, {x: Math.round(local.x - size / 2), y: Math.round(local.y - size / 2), stamp, by: identity.name || undefined, size});
    const placed: BoardBuild = holder ? {...build, pieces: build.pieces.map((piece, k) => (k ? piece : {...piece, node: {...piece.node, layoutPositioning: 'ABSOLUTE'}}))} : build;
    // A stamp stays a stamp: the tool remains for the next one, nothing is selected (FigJam).
    insertBuild(ctx.store, 'Stamp', placed, parentId, {select: false});
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    if (!this.at) return;
    const zoom = view.viewport().zoom;
    const centre = view.pageToScreen(this.at);
    const radius = (this.size() / 2) * zoom;
    ctx2d.save();
    ctx2d.globalAlpha = 0.5;
    ctx2d.fillStyle = stampSpec(boardChoices().stamp).color;
    ctx2d.beginPath();
    ctx2d.arc(centre.x, centre.y, radius, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.restore();
  }
}

export const createStickyTool = () => new StickyTool();
export const createTableTool = () => new TableTool();
export const createStampTool = () => new StampTool();
