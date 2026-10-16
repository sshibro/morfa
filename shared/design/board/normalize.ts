import type {Matrix, NodeId, SceneNode, TextProps, Vec} from '../types';
import {IDENTITY, invert, localMatrix, multiply} from '../geometry';
import type {Draft} from '../constraints';
import type {TextMeasurer} from '../text-layout';
import {textBoxSize} from '../text-layout';
import {tableCache} from '../table-cache';
import {childPart, isConnector, isShapeWithText, isSticky, isTable} from './model';
import {cellSpans, tableCoverage} from './table';
import {TABLE_CELL} from './create';
import {commandBounds, endAtPoint, endOnObject, pathPointAt, routeConnector, transformCommands, translatePath, type EndObject, type ResolvedEnd} from './connectors';
import {boardShapeTextInsets} from './shapes';
import type {ConnectorEnd} from './types';

// "Board" in the normalization every change goes through (shared/design/normalize.ts, docs/board.md §Objects). Two steps, both
// a no-op in a file without board objects and costing what a change touched, never a walk of the file:
//   - before layout: a sticky's text takes the largest size that fits the note (FigJam's auto size); a sticky or a shape resized
//     by hand keeps that height as its least height and still grows with its text; a shape's text keeps to the figure's inside.
//   - after layout: every connector whose end is on something that moved (or on something removed) runs again from end to end.

// ── Stickies and shapes ──────────────────────────────────────────────────────────────────────────

/** A sticky's sizes at 240 px, largest first; a bigger note scales them. */
export const STICKY_SIZES = [24, 20, 18, 16, 14, 12, 10] as const;
export const STICKY_SIDE = 240;
export const STICKY_LINE_PERCENT = 125;

function fontSized(text: TextProps, size: number): TextProps {
  const runs = text.runs.some(run => run.style.fontSize !== undefined)
    ? text.runs.map(run => {
        if (run.style.fontSize === undefined) return run;
        const {fontSize: _drop, ...style} = run.style;
        return {...run, style};
      })
    : text.runs;
  return {...text, runs, style: {...text.style, fontSize: size, lineHeight: {unit: 'PERCENT', value: STICKY_LINE_PERCENT}}};
}

/** The size the sticky's text takes: the largest of the scale whose text fits `room` (the smallest when none does). */
export function stickyFontSize(textNode: SceneNode, room: {width: number; height: number}, scale: number, measurer: TextMeasurer): number {
  const text = textNode.text!;
  const sizes = STICKY_SIZES.map(size => Math.round(size * scale * 10) / 10);
  if (!text.characters.trim()) return sizes[0];
  const fits = (size: number) => {
    const probe = {width: Math.max(1, room.width), height: textNode.height, fills: textNode.fills, text: {...fontSized(text, size), textAutoResize: 'HEIGHT' as const}};
    return textBoxSize(probe, measurer).height <= room.height + 0.5;
  };
  for (const size of sizes) if (fits(size)) return size;
  return sizes[sizes.length - 1];
}

function fitSticky(draft: Draft, sticky: SceneNode, measurer: TextMeasurer): void {
  const text = childPart(id => draft.get(id), sticky, 'text');
  if (!text?.text) return;
  const layout = sticky.autoLayout;
  const padX = (layout?.paddingLeft ?? 0) + (layout?.paddingRight ?? 0), padY = (layout?.paddingTop ?? 0) + (layout?.paddingBottom ?? 0);
  const least = sticky.minHeight ?? sticky.height;
  const author = childPart(id => draft.get(id), sticky, 'author');
  const authorRoom = author?.visible ? author.height + (layout?.itemSpacing ?? 0) : 0;
  const wide = sticky.board?.kind === 'sticky' && sticky.board.wide;
  const scale = Math.max(0.25, Math.min(sticky.width / (wide ? 2 : 1), least) / STICKY_SIDE);
  const size = stickyFontSize(text, {width: sticky.width - padX, height: least - padY - authorRoom}, scale, measurer);
  const current = text.text;
  const lineOk = current.style.lineHeight.unit === 'PERCENT' && current.style.lineHeight.value === STICKY_LINE_PERCENT;
  if (current.style.fontSize !== size || !lineOk || current.runs.some(run => run.style.fontSize !== undefined)) draft.update(text.id, {text: fontSized(current, size)});
}

function fitShapeText(draft: Draft, shape: SceneNode): void {
  if (shape.board?.kind !== 'shape' || !shape.autoLayout) return;
  const insets = boardShapeTextInsets(shape.board.shape);
  const least = shape.minHeight ?? shape.height;
  const padding = {
    paddingTop: Math.round(least * insets.top),
    paddingBottom: Math.round(least * insets.bottom),
    paddingLeft: Math.round(shape.width * insets.left),
    paddingRight: Math.round(shape.width * insets.right),
  };
  const layout = shape.autoLayout;
  if (layout.paddingTop !== padding.paddingTop || layout.paddingBottom !== padding.paddingBottom || layout.paddingLeft !== padding.paddingLeft || layout.paddingRight !== padding.paddingRight)
    draft.update(shape.id, {autoLayout: {...layout, ...padding}});
}

/** A table's rows take the height of their tallest cell (at least the cell's least height), and its cells fill the row: an
 *  auto-layout row of filling cells has nothing to size by, so the height is measured here. */
function fitTable(draft: Draft, table: SceneNode, measurer: TextMeasurer): void {
  const get = (id: NodeId | null | undefined) => (id ? draft.get(id) : undefined);
  const covered = tableCoverage(get, table.id);
  const rowIds = (table.children ?? []).filter(id => get(id)?.board?.kind === 'part');
  // Merged cells first (FigJam's "Merge cells"): covered cells leave the flow or keep the place invisibly, a merged cell takes the
  // width of its columns. A column's width is its first cell's that is neither merged nor covered.
  const columnWidths: number[] = [];
  rowIds.forEach(rowId => (get(rowId)?.children ?? []).forEach((cellId, c) => {
    const cell = get(cellId);
    if (columnWidths[c] === undefined && cell && !covered.has(cellId) && cell.opacity === 1 && cellSpans(cell).cols === 1) columnWidths[c] = cell.width;
  }));
  const spanWidth = (from: number, cols: number) => {
    let width = 0;
    for (let c = from; c < from + cols; c++) width += columnWidths[c] ?? TABLE_CELL.width;
    return width;
  };
  const tall: {cellId: NodeId; row: number; rows: number}[] = [];
  rowIds.forEach((rowId, r) => (get(rowId)?.children ?? []).forEach((cellId, c) => {
    const cell = get(cellId);
    if (!cell) return;
    const cover = covered.get(cellId);
    if (cover) {
      const anchor = get(cover.anchor);
      const anchorAt = anchor ? (get(anchor.parentId)?.children ?? []).indexOf(anchor.id) : c;
      const patch: Partial<SceneNode> = cover.role === 'hidden' ? {visible: false} : {visible: true, opacity: 0, width: spanWidth(anchorAt, cellSpans(anchor).cols)};
      if (Object.entries(patch).some(([key, value]) => cell[key as keyof SceneNode] !== value)) draft.update(cellId, patch);
      return;
    }
    const {cols, rows} = cellSpans(cell);
    const patch: Partial<SceneNode> = {};
    if (!cell.visible) patch.visible = true;
    // A spacer set free by an unmerge: seen again, as wide as its column.
    if (cell.opacity !== 1) {
      patch.opacity = 1;
      if (cols === 1 && columnWidths[c] !== undefined) patch.width = columnWidths[c];
    }
    if (cols > 1 && cell.width !== spanWidth(c, cols)) patch.width = spanWidth(c, cols);
    if (Object.keys(patch).length) draft.update(cellId, patch);
    if (rows > 1) tall.push({cellId, row: r, rows});
  }));
  const tallIds = new Set(tall.map(entry => entry.cellId));
  const heights: number[] = [];
  for (const rowId of rowIds) {
    const row = draft.get(rowId);
    if (!row || row.board?.kind !== 'part' || row.board.part !== 'row') continue;
    let height = 0;
    for (const cellId of row.children ?? []) {
      const cell = draft.get(cellId);
      // A spacer and a cell merged downwards do not size their row.
      if (!cell?.visible || covered.has(cellId) || tallIds.has(cellId)) continue;
      const layout = cell.autoLayout;
      const padX = (layout?.paddingLeft ?? 0) + (layout?.paddingRight ?? 0), padY = (layout?.paddingTop ?? 0) + (layout?.paddingBottom ?? 0);
      let content = 0;
      for (const childId of cell.children ?? []) {
        const child = draft.get(childId);
        if (!child?.visible) continue;
        content += child.text ? textBoxSize({...child, width: Math.max(1, cell.width - padX), text: {...child.text, textAutoResize: 'HEIGHT'}}, measurer).height : child.height;
      }
      height = Math.max(height, cell.minHeight ?? 0, content + padY);
      if (cell.layoutSizingVertical !== 'FILL') draft.update(cellId, {layoutSizingVertical: 'FILL'});
    }
    if (height <= 0) height = row.height;
    heights.push(height);
    if (row.height !== height || row.layoutSizingVertical !== 'FIXED') draft.update(rowId, {height, layoutSizingVertical: 'FIXED'});
  }
  // A cell merged downwards is as tall as its rows, reaching over the spacers below it.
  for (const {cellId, row, rows} of tall) {
    let height = 0;
    for (let r = row; r < Math.min(heights.length, row + rows); r++) height += heights[r];
    const cell = draft.get(cellId)!;
    if (cell.height !== height || cell.layoutSizingVertical !== 'FIXED') draft.update(cellId, {height, layoutSizingVertical: 'FIXED'});
  }
}

/** The board object a touched layer belongs to, when it is one these steps fit. */
function fitted(draft: Draft, id: NodeId): SceneNode | null {
  let node = draft.get(id);
  for (let depth = 0; node?.board && depth < 4; depth++) {
    if (isSticky(node) || isShapeWithText(node) || isTable(node)) return node;
    if (node.board.kind !== 'part') return null;
    node = draft.get(node.parentId);
  }
  return null;
}

/** Stickies, shapes with text and tables among `touched` (or owning a touched layer): hand-resized heights become least heights,
 *  sticky text fits its note, shape text keeps inside its figure, table rows take their tallest cell. Run before layout. */
export function fitBoardObjects(draft: Draft, touched: Iterable<NodeId>, measurer: TextMeasurer): void {
  let owners: Set<NodeId> | null = null;
  for (const id of touched) {
    if (!draft.get(id)?.board) continue;
    const owner = fitted(draft, id);
    if (owner) (owners ??= new Set()).add(owner.id);
  }
  if (!owners) return;
  for (const id of owners) {
    let node = draft.get(id);
    if (!node) continue;
    if (isTable(node)) {
      fitTable(draft, node, measurer);
      continue;
    }
    // Resized by hand (the handles fix the height): that height is the note's least height, and it still grows with its text.
    if (node.layoutSizingVertical === 'FIXED' && node.autoLayout?.layoutMode === 'VERTICAL') {
      draft.update(id, {layoutSizingVertical: 'HUG', minHeight: node.height});
      node = draft.get(id)!;
    }
    if (isSticky(node)) fitSticky(draft, node, measurer);
    else fitShapeText(draft, node);
  }
}

// ── Connectors ───────────────────────────────────────────────────────────────────────────────────

const EMPTY: ReadonlySet<NodeId> = new Set();

/** Connector ids of a node table, cached by the table and carried over through changes that leave them (table-cache.ts). */
const connectorIndexes = tableCache<ReadonlySet<NodeId>>((previous, before, after, changed) => {
  let next: Set<NodeId> | null = null;
  for (const id of changed) {
    const was = isConnector(before[id]), is = isConnector(after[id]);
    if (was === is) continue;
    next ??= new Set(previous);
    if (is) next.add(id);
    else next.delete(id);
  }
  return next ?? previous;
});

function scanConnectors(nodes: Readonly<Record<NodeId, SceneNode>>): ReadonlySet<NodeId> {
  let found: Set<NodeId> | null = null;
  for (const id in nodes) if (isConnector(nodes[id])) (found ??= new Set()).add(id);
  return found ?? EMPTY;
}

/** Every connector of a published (never again written) node table. */
export function connectorsOf(nodes: Readonly<Record<NodeId, SceneNode>>): ReadonlySet<NodeId> {
  let index = connectorIndexes.get(nodes);
  if (!index) connectorIndexes.set(nodes, (index = scanConnectors(nodes)));
  return index;
}

export type ConnectorOrigin = {nodes: Readonly<Record<NodeId, SceneNode>>; changed: Iterable<NodeId>};

/** The draft's connectors: the origin's (cached) adjusted by what changed since. Without an origin the draft's own input stands in
 *  for it (it is published unless the caller lent its table to be written in place: only then is the table scanned). */
export function connectorsIn(draft: Draft, origin: ConnectorOrigin | undefined): ReadonlySet<NodeId> {
  if (!origin) {
    if (!draft.ownsTable) return connectorsOf(draft.doc.nodes);
    if (draft.doc.nodes === draft.base.nodes) return scanConnectors(draft.doc.nodes);
    origin = {nodes: draft.base.nodes, changed: []};
  }
  const base = connectorsOf(origin.nodes);
  let ids: Set<NodeId> | null = null;
  const consider = (id: NodeId) => {
    const is = isConnector(draft.get(id));
    if (is === (ids ?? base).has(id)) return;
    ids ??= new Set(base);
    if (is) ids.add(id);
    else ids.delete(id);
  };
  for (const id of origin.changed) consider(id);
  for (const id of draft.written) consider(id);
  return ids ?? base;
}

/** Local box → page space through the draft (a node's world matrix as the draft has it now). */
function draftWorld(draft: Draft, id: NodeId | null | undefined): Matrix {
  const chain: SceneNode[] = [];
  for (let node = draft.get(id); node && node.type !== 'PAGE'; node = draft.get(node.parentId)) chain.push(node);
  let m = IDENTITY;
  for (let i = chain.length - 1; i >= 0; i--) m = multiply(m, localMatrix(chain[i]));
  return m;
}

/** The node or one of its ancestors is among `ids`. */
function touchedChain(draft: Draft, id: NodeId | null | undefined, ids: ReadonlySet<NodeId>): boolean {
  for (let node = draft.get(id), depth = 0; node && depth < 64; node = draft.get(node.parentId), depth++) {
    if (ids.has(node.id)) return true;
    if (node.type === 'PAGE') return false;
  }
  return false;
}

const isAttached = (end: ConnectorEnd): end is Extract<ConnectorEnd, {node: NodeId}> => 'node' in end;

/** Whether the connector must run again: it, a layer of it or an ancestor changed, or an end's object (or its ancestor) did, or an
 *  end's object is gone. */
function needsRoute(draft: Draft, connector: SceneNode, moved: ReadonlySet<NodeId>): boolean {
  const meta = connector.board;
  if (meta?.kind !== 'connector') return false;
  if (touchedChain(draft, connector.id, moved)) return true;
  for (const child of connector.children ?? []) if (moved.has(child)) return true;
  for (const end of [meta.start, meta.end]) {
    if (!isAttached(end)) continue;
    if (!draft.get(end.node) || touchedChain(draft, end.node, moved)) return true;
  }
  return false;
}

/** Runs one connector again: its ends (an end whose object is gone stays where it was, free), its line and its label. */
function reroute(draft: Draft, connector: SceneNode, origin: ConnectorOrigin | undefined): void {
  const meta = connector.board;
  if (meta?.kind !== 'connector') return;
  const line = childPart(id => draft.get(id), connector, 'line');
  if (!line) return;
  // A connector is never turned: its line carries the direction.
  if (connector.rotation || connector.flipX || connector.flipY) draft.update(connector.id, {rotation: 0, flipX: false, flipY: false});
  const parentWorld = draftWorld(draft, connector.parentId);
  const toParent = invert(parentWorld);
  let {start, end} = meta;
  let points = meta.points;

  // Dragged by itself: its free ends go with it, and an end on an object that did not move with it comes off that object.
  const before = origin?.nodes[connector.id];
  const self = draft.get(connector.id)!;
  if (before && before.parentId === self.parentId && (before.x !== self.x || before.y !== self.y)) {
    const dx = self.x - before.x, dy = self.y - before.y;
    const lineBefore = origin!.nodes[line.id];
    const shift = (value: ConnectorEnd, which: 'start' | 'end'): ConnectorEnd => {
      if (!isAttached(value)) return {x: value.x + dx, y: value.y + dy};
      const object = draft.get(value.node), objectBefore = origin!.nodes[value.node];
      if (object && objectBefore && objectBefore.x + dx === object.x && objectBefore.y + dy === object.y) return value;
      // Where the end was, moved with the connector, in the parent's space.
      const path = lineBefore?.vectorPaths?.[0]?.commands;
      const point = path && path.length ? endPoint(path, which) : null;
      if (!point || !lineBefore) return {x: before.x + dx, y: before.y + dy};
      return {x: before.x + lineBefore.x + point.x + dx, y: before.y + lineBefore.y + point.y + dy};
    };
    start = shift(start, 'start');
    end = shift(end, 'end');
    // Its waypoints go with it too.
    if (points?.length) points = points.map(p => ({x: p.x + dx, y: p.y + dy}));
  }

  // Free ends in page space first: an end on an object turns toward the other end.
  const freePage = (value: ConnectorEnd): Vec | null => (isAttached(value) ? null : apply2(parentWorld, value));
  const objectOf = (value: ConnectorEnd): EndObject | null => {
    if (!isAttached(value)) return null;
    const node = draft.get(value.node);
    return node ? {node, world: draftWorld(draft, value.node)} : null;
  };
  // An end whose object is gone stays where the line ended, free.
  const keep = (value: ConnectorEnd, which: 'start' | 'end'): ConnectorEnd => {
    if (!isAttached(value) || draft.get(value.node)) return value;
    const path = line.vectorPaths?.[0]?.commands;
    const point = path && path.length ? endPoint(path, which) : {x: 0, y: 0};
    return {x: connector.x + line.x + point.x, y: connector.y + line.y + point.y};
  };
  start = keep(start, 'start');
  end = keep(end, 'end');

  const startObject = objectOf(start), endObject = objectOf(end);
  const reference = (value: ConnectorEnd, object: EndObject | null): Vec =>
    object ? apply2(object.world, {x: object.node.width / 2, y: object.node.height / 2}) : freePage(value)!;
  const resolve = (value: ConnectorEnd, object: EndObject | null, toward: Vec): ResolvedEnd =>
    object && isAttached(value)
      ? 'magnet' in value ? endOnObject(object, value.magnet, toward) : endAtPoint(object, value.at)
      : {point: freePage(value)!, normal: null, side: null};
  // Waypoints in page space; an end on an object turns toward its nearest waypoint instead of the other end.
  const waypoints = (points ?? []).map(p => apply2(parentWorld, p));
  const startEnd = resolve(start, startObject, waypoints[0] ?? reference(end, endObject));
  const endEnd = resolve(end, endObject, waypoints[waypoints.length - 1] ?? startEnd.point);
  const page = routeConnector(startEnd, endEnd, meta.line, waypoints);
  const local = transformCommands(page, toParent);
  const box = commandBounds(local);
  const group = draft.get(connector.id)!;
  draft.update(line.id, {
    x: box.x - group.x,
    y: box.y - group.y,
    width: box.width,
    height: box.height,
    rotation: 0,
    vectorPaths: [{windingRule: 'NONZERO', commands: translatePath(local, -box.x, -box.y)}],
  });
  const label = childPart(id => draft.get(id), group, 'label');
  if (label) {
    const middle = pathPointAt(local, meta.labelAt ?? 0.5);
    draft.update(label.id, {x: middle.x - group.x - label.width / 2, y: middle.y - group.y - label.height / 2, rotation: 0});
  }
  if (start !== meta.start || end !== meta.end || points !== meta.points) draft.update(connector.id, {board: {...meta, start, end, ...(points ? {points} : {})}});
}

const apply2 = (m: Matrix, p: Vec): Vec => ({x: m[0][0] * p.x + m[0][1] * p.y + m[0][2], y: m[1][0] * p.x + m[1][1] * p.y + m[1][2]});

function endPoint(commands: readonly {type: string; x?: number; y?: number}[], which: 'start' | 'end'): Vec {
  const list = which === 'start' ? commands : [...commands].reverse();
  for (const command of list) if (command.x !== undefined && command.y !== undefined) return {x: command.x, y: command.y};
  return {x: 0, y: 0};
}

/** Connectors whose ends moved run again (after layout). `moved`: every id the change and normalization touched so far. */
export function routeConnectors(draft: Draft, moved: ReadonlySet<NodeId>, connectors: ReadonlySet<NodeId>, origin?: ConnectorOrigin): void {
  for (const id of connectors) {
    const connector = draft.get(id);
    if (connector && needsRoute(draft, connector, moved)) reroute(draft, connector, origin);
  }
}
