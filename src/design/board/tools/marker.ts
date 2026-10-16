import type {NodeId, PathCommand, Vec} from '../../../../shared/design/types';
import {apply, invert, worldMatrix} from '../../../../shared/design/geometry';
import {newId} from '../../../../shared/design/defaults';
import {fitCubics} from '../../../../shared/design/paths';
import {createStroke, createWashi, insertPieces, type BoardBuild} from '../../../../shared/design/board/create';
import {boardObjectOf, isStroke} from '../../../../shared/design/board/model';
import {hitsNode} from '../../engine/hit-test';
import type {EditorState, Gesture} from '../../engine/store';
import type {Tool, ToolContext, ToolPointerEvent, ViewHelpers} from '../../engine/tools/types';
import {boardChoices, STROKE_WEIGHTS, type MarkerKind} from '../state';
import {placement} from './common';
import {stampHolderAt} from './place';

// "Marker" (M), "Highlighter" (⇧M), "Washi tape" (W) and "Eraser" (⇧⌫): the marker tray's tools (docs/board.md §Marker). A
// marker or highlighter stroke is drawn live on the overlay and becomes one smooth vector when the button goes up (a few cubics fit
// to the samples, round ends); the highlighter multiplies under what it crosses, so text stays readable. Washi tape runs straight
// from the press to the release. The eraser takes away the strokes it passes over (only strokes: stickies and shapes stay), as one
// undo step. The tool stays for the next stroke, as in FigJam.

const SAMPLE_PX = 1.5;
const FIT_PX = 1.2;
const ERASER_PX = 10;

/** Cubic path commands through samples (page or parent space), smoothed within `tolerance`. */
export function strokeCommands(points: readonly Vec[], tolerance: number): PathCommand[] {
  if (points.length === 1) return [{type: 'M', x: points[0].x, y: points[0].y}, {type: 'L', x: points[0].x + 0.01, y: points[0].y}];
  const cubics = fitCubics(points, tolerance);
  if (!cubics.length) return [{type: 'M', x: points[0].x, y: points[0].y}, {type: 'L', x: points[points.length - 1].x, y: points[points.length - 1].y}];
  const commands: PathCommand[] = [{type: 'M', x: cubics[0][0].x, y: cubics[0][0].y}];
  for (const [, c1, c2, p] of cubics) commands.push({type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: p.x, y: p.y});
  return commands;
}


/** The sticky or shape with text a highlight lies on: the one under where it began, holding every point of it; else null. */
export function highlightHolder(state: EditorState, points: Vec[], ctx: Pick<ToolContext, 'view' | 'index'>) {
  const holder = stampHolderAt(state, points[0], ctx);
  if (!holder) return null;
  const toHolder = invert(worldMatrix(state.doc, holder.id));
  const inside = points.every(point => {
    const at = apply(toHolder, point);
    return at.x >= 0 && at.y >= 0 && at.x <= holder.width && at.y <= holder.height;
  });
  return inside ? holder : null;
}

export class MarkerTool implements Tool {
  readonly id = 'board-marker';
  private points: Vec[] | null = null;
  private lastScreen: Vec | null = null;
  private erasing: {gesture: Gesture; ids: Set<NodeId>} | null = null;
  private pointer: Vec | null = null;

  get cursor() {
    return boardChoices().marker === 'eraser' ? 'cell' : 'crosshair';
  }

  private kind(): MarkerKind {
    return boardChoices().marker;
  }

  busy() {
    return !!this.points || !!this.erasing;
  }

  overlayHints() {
    return {hover: false, handles: false, sizeBadge: false};
  }

  activate(ctx: ToolContext) {
    ctx.store.setHover(null);
    ctx.setCursor(this.cursor);
  }

  deactivate(ctx: ToolContext) {
    this.points = null;
    this.erasing?.gesture.cancel();
    this.erasing = null;
    this.pointer = null;
    ctx.requestOverlay();
  }

  onPointerDown(e: ToolPointerEvent, ctx: ToolContext) {
    if (e.button !== 0) return;
    ctx.setCursor(this.cursor);
    if (this.kind() === 'eraser') {
      this.erasing = {gesture: ctx.store.gesture('Eraser'), ids: new Set()};
      this.erase(e, ctx);
      return;
    }
    this.points = [e.page];
    this.lastScreen = e.screen;
    ctx.requestOverlay();
  }

  onPointerMove(e: ToolPointerEvent, ctx: ToolContext) {
    this.pointer = e.page;
    if (this.erasing) {
      this.erase(e, ctx);
      ctx.requestOverlay();
      return;
    }
    if (!this.points || !this.lastScreen) {
      if (this.kind() === 'eraser') ctx.requestOverlay();
      return;
    }
    if (Math.hypot(e.screen.x - this.lastScreen.x, e.screen.y - this.lastScreen.y) < SAMPLE_PX) return;
    // Washi tape runs straight; so does a marker or highlighter stroke while ⇧ is held (help.figma.com "Doodle and highlight in
    // FigJam with drawing tools": "hold Shift to draw a straight line").
    if (this.kind() === 'washi' || e.shiftKey) this.points = [this.points[0], e.page];
    else this.points.push(e.page);
    this.lastScreen = e.screen;
    ctx.requestOverlay();
  }

  private erase(e: ToolPointerEvent, ctx: ToolContext) {
    const erasing = this.erasing!;
    const state = ctx.store.getState();
    const tolerance = ERASER_PX * ctx.view.pixel();
    const reach = {x: e.page.x - tolerance, y: e.page.y - tolerance, width: tolerance * 2, height: tolerance * 2};
    const index = ctx.index();
    const candidates = index ? index.query(reach) : Object.keys(state.doc.nodes);
    let added = false;
    for (const id of candidates) {
      const object = boardObjectOf(nodeId => (nodeId ? state.doc.nodes[nodeId] : undefined), id);
      if (!object || !isStroke(object) || object.locked || erasing.ids.has(object.id)) continue;
      const parts = object.children?.length ? [id] : [object.id];
      if (!parts.some(part => hitsNode(state.doc, part, e.page, tolerance))) continue;
      erasing.ids.add(object.id);
      added = true;
    }
    if (!added) return;
    const ids = [...erasing.ids];
    erasing.gesture.update(tx => {
      for (const id of ids) tx.remove(id);
    });
  }

  onPointerUp(e: ToolPointerEvent, ctx: ToolContext) {
    if (this.erasing) {
      const erasing = this.erasing;
      this.erasing = null;
      if (erasing.ids.size) erasing.gesture.commit();
      else erasing.gesture.cancel();
      ctx.requestOverlay();
      return;
    }
    const points = this.points;
    this.points = null;
    this.lastScreen = null;
    if (!points) return;
    const kind = this.kind();
    if (kind !== 'washi' && (points[points.length - 1].x !== e.page.x || points[points.length - 1].y !== e.page.y)) points.push(e.page);
    if (kind === 'washi') points[1] = e.page;
    ctx.requestOverlay();
    const state = ctx.store.getState();
    // A highlight drawn over a sticky or a shape with text sticks to it and moves with it (help.figma.com "Doodle and highlight in
    // FigJam with drawing tools"), placed absolutely inside it as a stamp is; one that leaves the object stays on the board.
    const holder = kind === 'highlighter' ? highlightHolder(state, points, ctx) : null;
    const {parentId} = holder ? {parentId: holder.id} : placement(state, points[0], ctx.index());
    const toParent = parentId === state.pageId ? null : invert(worldMatrix(state.doc, parentId));
    const local = toParent ? points.map(p => apply(toParent, p)) : points;
    const choices = boardChoices();
    if (kind === 'washi') {
      const [from, to] = [local[0], local[local.length - 1]];
      if (Math.hypot(to.x - from.x, to.y - from.y) < 4) return;
      const picture = choices.washiImage ? state.doc.images[choices.washiImage] : undefined;
      const image = picture && choices.washiImage ? {ref: choices.washiImage, height: picture.height} : undefined;
      const build = createWashi(newId, {from, to, color: choices.colors.washi, width: STROKE_WEIGHTS.washi[choices.thick ? 1 : 0], image});
      ctx.store.transact('Washi tape', tx => insertPieces(tx, build, parentId));
      return;
    }
    if (kind === 'eraser') return;
    const weight = STROKE_WEIGHTS[kind][choices.thick ? 1 : 0];
    const commands = strokeCommands(local, FIT_PX * ctx.view.pixel());
    const stroke = createStroke(newId, {tool: kind, commands, color: kind === 'highlighter' ? choices.colors.highlighter : choices.colors.marker, weight});
    const build: BoardBuild = holder ? {...stroke, pieces: stroke.pieces.map((piece, k) => (k ? piece : {...piece, node: {...piece.node, layoutPositioning: 'ABSOLUTE'}}))} : stroke;
    // Strokes are not selected: the next one follows straight away.
    ctx.store.transact(kind === 'highlighter' ? 'Highlighter' : 'Marker', tx => insertPieces(tx, build, parentId));
  }

  onPointerCancel(ctx: ToolContext) {
    this.points = null;
    this.erasing?.gesture.cancel();
    this.erasing = null;
    ctx.requestOverlay();
  }

  drawOverlay(ctx2d: CanvasRenderingContext2D, view: ViewHelpers) {
    const zoom = view.viewport().zoom;
    const choices = boardChoices();
    const kind = this.kind();
    if (kind === 'eraser') {
      if (!this.pointer) return;
      const at = view.pageToScreen(this.pointer);
      ctx2d.save();
      ctx2d.beginPath();
      ctx2d.arc(at.x, at.y, ERASER_PX, 0, Math.PI * 2);
      ctx2d.fillStyle = 'rgba(255, 140, 170, 0.25)';
      ctx2d.strokeStyle = 'rgba(214, 51, 108, 0.8)';
      ctx2d.lineWidth = 1.5;
      ctx2d.fill();
      ctx2d.stroke();
      ctx2d.restore();
      return;
    }
    const points = this.points;
    if (!points || points.length < 2) return;
    ctx2d.save();
    if (kind === 'washi') {
      const a = view.pageToScreen(points[0]), b = view.pageToScreen(points[1]);
      ctx2d.strokeStyle = choices.colors.washi;
      ctx2d.globalAlpha = 0.85;
      ctx2d.lineWidth = STROKE_WEIGHTS.washi[choices.thick ? 1 : 0] * zoom;
      ctx2d.lineCap = 'butt';
      ctx2d.beginPath();
      ctx2d.moveTo(a.x, a.y);
      ctx2d.lineTo(b.x, b.y);
      ctx2d.stroke();
      ctx2d.restore();
      return;
    }
    ctx2d.beginPath();
    points.forEach((point, i) => {
      const p = view.pageToScreen(point);
      if (i) ctx2d.lineTo(p.x, p.y);
      else ctx2d.moveTo(p.x, p.y);
    });
    const highlighter = kind === 'highlighter';
    ctx2d.strokeStyle = highlighter ? choices.colors.highlighter : choices.colors.marker;
    if (highlighter) {
      ctx2d.globalAlpha = 0.8;
      ctx2d.globalCompositeOperation = 'multiply';
    }
    ctx2d.lineWidth = Math.max(1, STROKE_WEIGHTS[kind][choices.thick ? 1 : 0] * zoom);
    ctx2d.lineCap = 'round';
    ctx2d.lineJoin = 'round';
    ctx2d.stroke();
    ctx2d.restore();
  }
}

export const createMarkerTool = () => new MarkerTool();
