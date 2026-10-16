import type {DesignDocument, NodeId, SceneNode, Vec} from '../../../../shared/design/types';
import {applyLinear, invert, unionRects, worldBox, worldMatrix, type Rect} from '../../../../shared/design/geometry';
import {isAutoLayout, isTurned, resizeUpdates} from '../../../../shared/design/constraints';
import {isInsideInstance} from '../../../../shared/design/tree';
import {isMacPlatform} from '../keyboard';
import {movableSelection} from '../selection';
import type {DesignStore} from '../store';
import type {Command, CommandContext} from './registry';

// "Position": alignment (⌥A ⌥H ⌥D ⌥W ⌥V ⌥S), distribution (⌃⌥H, ⌃⌥V), "Tidy up" (⌃⌥T)
// and "Round to pixels". The keys of the last three differ off a Mac (MAC below). As in Figma, several layers line up against the box around all of
// them and a single layer against its parent frame; layers that auto layout places are left alone.
// Boxes are read in page space (a turned layer by its bounding box) and moves are written in each
// layer's parent space, so layers in different parents line up on screen. The pure helpers below are
// also what the alignment row of the "Design" panel calls.

export type AlignMode = 'left' | 'center-h' | 'right' | 'top' | 'center-v' | 'bottom';
export type DistributeAxis = 'horizontal' | 'vertical';
export type NodeUpdates = Map<NodeId, Partial<SceneNode>>;

/** Layers alignment may move: the movable top-level selection, without layers inside instances and
 *  without the ones an auto-layout frame places. */
export function alignableIds(doc: DesignDocument, selection: readonly NodeId[]): NodeId[] {
  return movableSelection(doc, selection).filter(id => {
    const node = doc.nodes[id];
    const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
    if (isInsideInstance(doc, id)) return false;
    return !(isAutoLayout(parent) && node.layoutPositioning !== 'ABSOLUTE');
  });
}

/** The selection's flow children of grid auto-layout frames (null unless every selected layer is one): Figma aligns
 *  each in its own cells (help.figma.com "Use the grid auto layout flow"), which is their `gridChild` alignment. */
export function gridChildIds(doc: DesignDocument, selection: readonly NodeId[]): NodeId[] | null {
  if (!selection.length) return null;
  const ids = selection.filter(id => {
    const node = doc.nodes[id];
    const parent = node?.parentId ? doc.nodes[node.parentId] : undefined;
    return !!node && parent?.autoLayout?.layoutMode === 'GRID' && node.layoutPositioning !== 'ABSOLUTE' && !isInsideInstance(doc, id);
  });
  return ids.length === selection.length ? ids : null;
}

const CELL_ALIGN: Record<AlignMode, {field: 'horizontalAlign' | 'verticalAlign'; value: 'MIN' | 'CENTER' | 'MAX'}> = {
  'left': {field: 'horizontalAlign', value: 'MIN'}, 'center-h': {field: 'horizontalAlign', value: 'CENTER'}, 'right': {field: 'horizontalAlign', value: 'MAX'},
  'top': {field: 'verticalAlign', value: 'MIN'}, 'center-v': {field: 'verticalAlign', value: 'CENTER'}, 'bottom': {field: 'verticalAlign', value: 'MAX'},
};

/** Each grid child aligned in its cells: the alignment on its `gridChild` (the layout moves it). */
export function gridAlignUpdates(doc: DesignDocument, ids: readonly NodeId[], mode: AlignMode): NodeUpdates {
  const {field, value} = CELL_ALIGN[mode];
  const out: NodeUpdates = new Map();
  for (const id of ids) {
    const child = doc.nodes[id]?.gridChild ?? {};
    if (child[field] !== value) out.set(id, {gridChild: {...child, [field]: value}});
  }
  return out;
}

/** The box alignment lines up against: the bounds of several layers, or a single layer's parent
 *  (null on the page: there is nothing to align a lone layer to). */
export function alignReference(doc: DesignDocument, ids: readonly NodeId[]): Rect | null {
  if (!ids.length) return null;
  if (ids.length > 1) return unionRects(ids.map(id => worldBox(doc, id)));
  const parent = doc.nodes[doc.nodes[ids[0]]?.parentId ?? ''];
  if (!parent || parent.type === 'PAGE') return null;
  return worldBox(doc, parent.id);
}

/** Page-space moves that align each box in `rects` with `to`. */
export function alignDeltas(rects: readonly Rect[], to: Rect, mode: AlignMode): Vec[] {
  return rects.map(r => {
    switch (mode) {
      case 'left': return {x: to.x - r.x, y: 0};
      case 'center-h': return {x: to.x + to.width / 2 - (r.x + r.width / 2), y: 0};
      case 'right': return {x: to.x + to.width - (r.x + r.width), y: 0};
      case 'top': return {x: 0, y: to.y - r.y};
      case 'center-v': return {x: 0, y: to.y + to.height / 2 - (r.y + r.height / 2)};
      case 'bottom': return {x: 0, y: to.y + to.height - (r.y + r.height)};
    }
  });
}

/** The x/y change that moves a node by `delta` on screen (page space). Empty when it does not move. */
export function moveBy(doc: DesignDocument, id: NodeId, delta: Vec): Partial<SceneNode> {
  const node = doc.nodes[id];
  if (!node || (Math.abs(delta.x) < 1e-9 && Math.abs(delta.y) < 1e-9)) return {};
  const local = applyLinear(invert(worldMatrix(doc, node.parentId!)), delta);
  const out: Partial<SceneNode> = {};
  if (Math.abs(local.x) > 1e-9) out.x = node.x + local.x;
  if (Math.abs(local.y) > 1e-9) out.y = node.y + local.y;
  return out;
}

function movesFor(doc: DesignDocument, ids: readonly NodeId[], deltas: readonly Vec[]): NodeUpdates {
  const out: NodeUpdates = new Map();
  ids.forEach((id, i) => {
    const change = moveBy(doc, id, deltas[i]);
    if (Object.keys(change).length) out.set(id, change);
  });
  return out;
}

export function alignUpdates(doc: DesignDocument, selection: readonly NodeId[], mode: AlignMode): NodeUpdates {
  const ids = alignableIds(doc, selection);
  const to = alignReference(doc, ids);
  if (!to) return new Map();
  return movesFor(doc, ids, alignDeltas(ids.map(id => worldBox(doc, id)), to, mode));
}

/** Page-space moves that make the gaps between the boxes equal along `axis`, the outermost ones staying. */
export function distributeDeltas(rects: readonly Rect[], axis: DistributeAxis): Vec[] {
  const out: Vec[] = rects.map(() => ({x: 0, y: 0}));
  if (rects.length < 3) return out;
  const h = axis === 'horizontal';
  const lo = (r: Rect) => (h ? r.x : r.y), size = (r: Rect) => (h ? r.width : r.height);
  const order = rects.map((_, i) => i).sort((a, b) => lo(rects[a]) - lo(rects[b]) || a - b);
  const start = Math.min(...rects.map(lo)), end = Math.max(...rects.map(r => lo(r) + size(r)));
  const gap = (end - start - rects.reduce((sum, r) => sum + size(r), 0)) / (rects.length - 1);
  let at = start;
  for (const i of order) {
    const d = at - lo(rects[i]);
    out[i] = h ? {x: d, y: 0} : {x: 0, y: d};
    at += size(rects[i]) + gap;
  }
  return out;
}

export function distributeUpdates(doc: DesignDocument, selection: readonly NodeId[], axis: DistributeAxis): NodeUpdates {
  const ids = alignableIds(doc, selection);
  if (ids.length < 3) return new Map();
  return movesFor(doc, ids, distributeDeltas(ids.map(id => worldBox(doc, id)), axis));
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

const TIDY_SPACING = 10;

/** "Tidy up" (Figma's Tidy up): the boxes read as rows (by where their centres fall) and laid out
 *  as a grid from the top-left of their bounds, each column as wide as its widest box, each row as
 *  tall as its tallest, with the typical gaps they had (rounded; overlaps ignored). Returns each box's
 *  new top-left corner. */
export function tidyUpPositions(rects: readonly Rect[]): Vec[] {
  if (rects.length < 2) return rects.map(r => ({x: r.x, y: r.y}));
  const rows: {top: number; bottom: number; items: number[]}[] = [];
  const byCentre = rects.map((_, i) => i).sort((a, b) => rects[a].y + rects[a].height / 2 - (rects[b].y + rects[b].height / 2) || rects[a].x - rects[b].x);
  for (const i of byCentre) {
    const r = rects[i];
    const cy = r.y + r.height / 2;
    const row = rows.find(each => cy >= each.top && cy <= each.bottom);
    if (row) {
      row.items.push(i);
      row.top = Math.min(row.top, r.y);
      row.bottom = Math.max(row.bottom, r.y + r.height);
    } else {
      rows.push({top: r.y, bottom: r.y + r.height, items: [i]});
    }
  }
  rows.sort((a, b) => a.top - b.top);
  for (const row of rows) row.items.sort((a, b) => rects[a].x - rects[b].x || a - b);
  const columns = Math.max(...rows.map(row => row.items.length));
  const colWidth = Array.from({length: columns}, (_, c) => Math.max(0, ...rows.map(row => (row.items[c] === undefined ? 0 : rects[row.items[c]].width))));
  const rowHeight = rows.map(row => Math.max(...row.items.map(i => rects[i].height)));
  const across: number[] = [];
  for (const row of rows) {
    for (let k = 1; k < row.items.length; k++) {
      const a = rects[row.items[k - 1]], b = rects[row.items[k]];
      across.push(b.x - (a.x + a.width));
    }
  }
  const down: number[] = [];
  for (let k = 1; k < rows.length; k++) down.push(rows[k].top - rows[k - 1].bottom);
  // Overlapping neighbours say nothing about the spacing meant; with no gap at all, Figma's 10.
  const gapsX = across.filter(gap => gap >= 0), gapsY = down.filter(gap => gap >= 0);
  const gapX = Math.round(gapsX.length ? median(gapsX) : gapsY.length ? median(gapsY) : TIDY_SPACING);
  const gapY = Math.round(gapsY.length ? median(gapsY) : gapX);
  const left = Math.min(...rects.map(r => r.x)), top = Math.min(...rects.map(r => r.y));
  const out: Vec[] = rects.map(r => ({x: r.x, y: r.y}));
  let y = top;
  rows.forEach((row, r) => {
    let x = left;
    row.items.forEach((i, c) => {
      out[i] = {x, y};
      x += colWidth[c] + gapX;
    });
    y += rowHeight[r] + gapY;
  });
  return out;
}

export function tidyUpUpdates(doc: DesignDocument, selection: readonly NodeId[]): NodeUpdates {
  const ids = alignableIds(doc, selection);
  if (ids.length < 2) return new Map();
  const rects = ids.map(id => worldBox(doc, id));
  const positions = tidyUpPositions(rects);
  return movesFor(doc, ids, positions.map((p, i) => ({x: p.x - rects[i].x, y: p.y - rects[i].y})));
}

/** "Round to pixels": whole-pixel positions and sizes (a turned layer keeps its size), children
 *  following their constraints. */
export function roundToPixelsUpdates(doc: DesignDocument, selection: readonly NodeId[]): NodeUpdates {
  const out: NodeUpdates = new Map();
  for (const id of movableSelection(doc, selection)) {
    const node = doc.nodes[id];
    if (isInsideInstance(doc, id)) continue;
    if (isTurned(node) || node.type === 'LINE') {
      const change: Partial<SceneNode> = {};
      if (node.x !== Math.round(node.x)) change.x = Math.round(node.x);
      if (node.y !== Math.round(node.y)) change.y = Math.round(node.y);
      if (node.type === 'LINE' && node.width !== Math.round(node.width)) change.width = Math.round(node.width);
      if (Object.keys(change).length) out.set(id, {...out.get(id), ...change});
      continue;
    }
    const box = {x: Math.round(node.x), y: Math.round(node.y), width: Math.max(0, Math.round(node.width)), height: Math.max(0, Math.round(node.height))};
    if (box.x === node.x && box.y === node.y && box.width === node.width && box.height === node.height) continue;
    for (const [target, partial] of resizeUpdates(doc, id, box)) out.set(target, {...out.get(target), ...partial});
  }
  return out;
}
/** ⇧ with an alignment button (Figma's, help.figma.com "Edit objects on the canvas in bulk"): each layer against its own
 *  parent frame, however many are selected; layers on the page itself stay where they are. */
export function alignToParentsUpdates(doc: DesignDocument, selection: readonly NodeId[], mode: AlignMode): NodeUpdates {
  const out: NodeUpdates = new Map();
  for (const id of alignableIds(doc, selection)) {
    const to = alignReference(doc, [id]);
    if (!to) continue;
    const change = moveBy(doc, id, alignDeltas([worldBox(doc, id)], to, mode)[0]);
    if (Object.keys(change).length) out.set(id, change);
  }
  return out;
}

// ── Running them ─────────────────────────────────────────────────────────────────────────────────

function apply(store: DesignStore, label: string, updates: NodeUpdates) {
  if (!updates.size) return;
  store.transact(label, tx => {
    for (const [id, partial] of updates) tx.update(id, partial);
  });
}

export const ALIGN_LABELS: Record<AlignMode, string> = {
  'left': 'Align left',
  'center-h': 'Align horizontal centers',
  'right': 'Align right',
  'top': 'Align top',
  'center-v': 'Align vertical centers',
  'bottom': 'Align bottom',
};

export function alignSelection(store: DesignStore, mode: AlignMode) {
  const {doc, selection} = store.getState();
  const cells = gridChildIds(doc, selection);
  apply(store, 'Align', cells ? gridAlignUpdates(doc, cells, mode) : alignUpdates(doc, selection, mode));
}
export function alignToParents(store: DesignStore, mode: AlignMode) {
  const {doc, selection} = store.getState();
  const cells = gridChildIds(doc, selection);
  apply(store, 'Align', cells ? gridAlignUpdates(doc, cells, mode) : alignToParentsUpdates(doc, selection, mode));
}
export const distributeSelection = (store: DesignStore, axis: DistributeAxis) =>
  apply(store, 'Distribute', distributeUpdates(store.getState().doc, store.getState().selection, axis));
export const tidyUpSelection = (store: DesignStore) => apply(store, 'Tidy up', tidyUpUpdates(store.getState().doc, store.getState().selection));
export const roundSelectionToPixels = (store: DesignStore) =>
  apply(store, 'Round to pixels', roundToPixelsUpdates(store.getState().doc, store.getState().selection));

/** Whether alignment does anything for the selection (several layers, or one inside a frame). */
/** Whether `alignReference` has a box, without measuring one (the panel asks on every change). */
export function canAlign(doc: DesignDocument, selection: readonly NodeId[]): boolean {
  if (gridChildIds(doc, selection)) return true;
  const ids = alignableIds(doc, selection);
  if (ids.length > 1) return true;
  const parent = ids.length ? doc.nodes[doc.nodes[ids[0]]?.parentId ?? ''] : undefined;
  return !!parent && parent.type !== 'PAGE';
}
export const canDistribute = (doc: DesignDocument, selection: readonly NodeId[]) => alignableIds(doc, selection).length >= 3;
export const canTidyUp = (doc: DesignDocument, selection: readonly NodeId[]) => alignableIds(doc, selection).length >= 2;

/** `canAlign`, `canDistribute` and `canTidyUp` at once, finding the alignable layers once (the panel's
 *  alignment row asks after every change). */
export function alignAvailability(doc: DesignDocument, selection: readonly NodeId[]): {align: boolean; distribute: boolean; tidy: boolean} {
  const ids = alignableIds(doc, selection);
  const parent = ids.length === 1 ? doc.nodes[doc.nodes[ids[0]]?.parentId ?? ''] : undefined;
  return {align: !!gridChildIds(doc, selection) || ids.length > 1 || (!!parent && parent.type !== 'PAGE'), distribute: ids.length >= 3, tidy: ids.length >= 2};
}

const state = (ctx: CommandContext) => ctx.store.getState();

/** Figma's keys on each platform: ⌃⌥H, ⌃⌥V, ⌃⌥T on a Mac; off a Mac Ctrl stands for ⌘, so they are
 *  Alt+Shift+H, Alt+Shift+V (Ctrl+Alt+V is "Paste properties") and Ctrl+Alt+Shift+T (Ctrl+Alt+T is the
 *  text's "Align center"). */
const MAC = isMacPlatform();

const ALIGN_KEYS: [AlignMode, string][] = [['left', 'KeyA'], ['center-h', 'KeyH'], ['right', 'KeyD'], ['top', 'KeyW'], ['center-v', 'KeyV'], ['bottom', 'KeyS']];

export const ALIGN_COMMANDS: Command[] = [
  ...ALIGN_KEYS.map(([mode, code]): Command => ({
    id: `arrange.align-${mode}`,
    label: ALIGN_LABELS[mode],
    group: 'arrange',
    shortcut: {code, alt: true},
    enabled: ctx => canAlign(state(ctx).doc, state(ctx).selection),
    run: ctx => alignSelection(ctx.store, mode),
  })),
  {id: 'arrange.distribute-h', label: 'Distribute horizontal spacing', group: 'arrange', shortcut: MAC ? {code: 'KeyH', alt: true, ctrl: true} : {code: 'KeyH', alt: true, shift: true}, enabled: ctx => canDistribute(state(ctx).doc, state(ctx).selection), run: ctx => distributeSelection(ctx.store, 'horizontal')},
  {id: 'arrange.distribute-v', label: 'Distribute vertical spacing', group: 'arrange', shortcut: MAC ? {code: 'KeyV', alt: true, ctrl: true} : {code: 'KeyV', alt: true, shift: true}, enabled: ctx => canDistribute(state(ctx).doc, state(ctx).selection), run: ctx => distributeSelection(ctx.store, 'vertical')},
  {id: 'arrange.tidy-up', label: 'Tidy up', group: 'arrange', shortcut: MAC ? {code: 'KeyT', alt: true, ctrl: true} : {code: 'KeyT', alt: true, ctrl: true, shift: true}, enabled: ctx => canTidyUp(state(ctx).doc, state(ctx).selection), run: ctx => tidyUpSelection(ctx.store)},
  {id: 'arrange.round-to-pixels', label: 'Round to pixels', group: 'arrange', enabled: ctx => movableSelection(state(ctx).doc, state(ctx).selection).length > 0, run: ctx => roundSelectionToPixels(ctx.store)},
];
