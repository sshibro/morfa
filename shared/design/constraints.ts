import type {ConstraintType, Constraints, DesignDocument, Effect, GridTrackSize, NodeId, PathCommand, SceneNode, TextAutoResize, TextPathData, TextProps, TextRun, TextStyle, Vec, VectorPath} from './types';
import {FRAME_LIKE_TYPES} from './types';
import type {TextMeasurer} from './text-layout';
import {textBoxSize} from './text-layout';
import {IDENTITY, apply, invert, localMatrix, toRadians, transformRect, worldMatrix} from './geometry';
import {copyTable, type TableLog} from './table-cache';
import {engineTs, withEngine} from './engine-switch';
import {layoutEntries, updatesFrom} from './layout-wasm';

// Resizing a node and everything that follows from it, as Figma does: children of a plain
// container move and stretch by their constraints, groups and boolean operations scale their
// children, vectors scale their paths, text stops growing on the axis that was set by hand, and an
// auto-layout frame or child resized by hand stops hugging or filling on that axis. Flow children
// of an auto-layout frame are left alone: `normalizeDocument` lays the frame out again
// (shared/design/layout.ts), and the layout engine comes back here for whatever it resizes.
//
// `Draft` lives here because this is the lowest layer: resizing, layout, group fitting and
// normalizing all write into one working copy, and read each other's writes through it.

export type Box = {x: number; y: number; width: number; height: number};
export type Size = {width: number; height: number};
/** Field updates per node, as `tx.update(id, fields)` takes them (shallow merge). */
export type NodeUpdates = Map<NodeId, Partial<SceneNode>>;

/** Writes closer than this to the stored value are dropped. Without a tolerance, floating-point
 *  noise would turn every re-run of a pass into a change and normalizing would never settle. */
export const LAYOUT_EPSILON = 1e-6;

/** Equality for stored fields: numbers within `LAYOUT_EPSILON`, arrays and objects by value,
 *  a missing key the same as an undefined one. */
export function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= LAYOUT_EPSILON;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((value, i) => sameValue(value, b[i]));
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key in left) if (!sameValue(left[key], right[key])) return false;
  for (const key in right) if (!(key in left) && right[key] !== undefined) return false;
  return true;
}

/** How a `Draft` keeps its writes. 'overlay' (the default) keeps them beside the untouched base and
 *  copies the node table only in `toDocument()`: right for callers that want `updates` only (a
 *  resize preview on every pointer move must not copy a 20 000-node table). 'table' writes into one
 *  node table, copied from the base on the first write, or the base's own table when `owned`: right
 *  for normalization, which always ends in a document and hands that table to other passes. */
export type DraftOptions = {mode?: 'overlay' | 'table'; owned?: boolean
  /** Table mode with `owned`: the table is a document's own, written in place — every write logs the entry before it. */
  log?: TableLog;
};

/** A working copy of a document: reads see earlier writes, writes that change nothing are
 *  dropped, and the original stays untouched (unless the caller lends its own table with
 *  `{mode: 'table', owned: true}`). `updates` holds the fields `update` changed relative to `base`
 *  (overlay mode only; table mode reports `written` ids instead), `toDocument()` the result (`base`
 *  itself when nothing changed). */
export class Draft {
  readonly base: DesignDocument;
  readonly updates: NodeUpdates = new Map();
  private readonly nodes = new Map<NodeId, SceneNode>();
  private readonly gone = new Set<NodeId>();
  private readonly watchers: Set<NodeId>[] = [];
  /** Table mode: the table writes go to (null until the first write copies the base's), every id
   *  written or deleted in it, and the document the other tables come from. */
  private readonly tableMode: boolean;
  private readonly log: TableLog | undefined;
  private table: Record<NodeId, SceneNode> | null = null;
  private readonly writtenIds = new Set<NodeId>();
  private rest: DesignDocument;
  private view: DesignDocument | null = null;

  constructor(base: DesignDocument, options: DraftOptions = {}) {
    this.base = base;
    this.rest = base;
    this.tableMode = options.mode === 'table';
    if (this.tableMode && options.owned) this.table = base.nodes;
    this.log = this.tableMode && options.owned ? options.log : undefined;
  }

  get(id: NodeId | null | undefined): SceneNode | undefined {
    if (id == null) return undefined;
    // Table mode deletes from the table itself: one lookup, no overlay.
    if (this.tableMode) return (this.table ?? this.base.nodes)[id];
    if (this.gone.has(id)) return undefined;
    return this.nodes.get(id) ?? this.base.nodes[id];
  }

  /** Merges `patch` into the node. Returns whether anything changed. */
  update(id: NodeId, patch: Partial<SceneNode>): boolean {
    const node = this.get(id);
    if (!node) return false;
    let changes: Record<string, unknown> | null = null;
    for (const key in patch) {
      const value = (patch as Record<string, unknown>)[key];
      if (!sameValue((node as unknown as Record<string, unknown>)[key], value)) (changes ??= {})[key] = value;
    }
    if (!changes) return false;
    const next = {...node, ...changes} as SceneNode;
    if (this.tableMode) this.writable(id)[id] = next;
    else this.nodes.set(id, next);
    // Table mode feeds a document, never `updates`: no merged copy of the fields per write.
    if (!this.tableMode) this.updates.set(id, {...this.updates.get(id), ...changes} as Partial<SceneNode>);
    this.touch(id);
    return true;
  }

  /** Removes the node and its subtree, and takes it out of its parent's children. */
  remove(id: NodeId): void {
    const node = this.get(id);
    if (!node) return;
    const parent = this.get(node.parentId);
    if (parent?.children) this.update(parent.id, {children: parent.children.filter(child => child !== id)});
    const drop = (nodeId: NodeId) => {
      for (const child of this.get(nodeId)?.children ?? []) drop(child);
      this.gone.add(nodeId);
      if (this.tableMode) {
        this.log?.deleting(nodeId);
        delete this.writable(nodeId)[nodeId];
      }
      else this.nodes.delete(nodeId);
      this.updates.delete(nodeId);
      this.touch(nodeId);
    };
    drop(id);
  }

  get removed(): ReadonlySet<NodeId> {
    return this.gone;
  }

  get changed(): boolean {
    if (this.tableMode) return this.writtenIds.size > 0 || this.rest !== this.base;
    return this.nodes.size > 0 || this.gone.size > 0;
  }

  /** Table mode: every id written or deleted so far (passes and the patch are built from these). */
  get written(): ReadonlySet<NodeId> {
    return this.writtenIds;
  }

  /** Table mode: whether the draft writes into a table of its own (copied or lent) rather than
   *  still reading the base's. Passes handed `doc` may then write into `doc.nodes` in place. */
  get ownsTable(): boolean {
    return this.table !== null;
  }

  /** Table mode: the document as it stands, for passes that take a document (instances, variables).
   *  It shares the draft's table: a pass writes into it only when `ownsTable` says it may, and
   *  reports what it changed through `adopt`. */
  get doc(): DesignDocument {
    if (!this.tableMode) return this.toDocument();
    const nodes = this.table ?? this.base.nodes;
    if (nodes === this.base.nodes && this.rest === this.base) return this.base;
    if (!this.view || this.view.nodes !== nodes) this.view = {...this.rest, nodes};
    return this.view;
  }

  /** Table mode: continues from `doc`, the result of a pass run on `this.doc` that changed (wrote or
   *  deleted) the nodes `changed`, either in the draft's own table or, when the draft had none
   *  yet, in a fresh copy that becomes the draft's. Other tables (variable modes) are taken over. */
  adopt(doc: DesignDocument, changed: Iterable<NodeId>): void {
    if (!this.tableMode) throw new Error('Draft.adopt needs table mode');
    if (doc.nodes !== (this.table ?? this.base.nodes)) {
      if (this.table) throw new Error('A pass copied a table the draft owns');
      this.table = doc.nodes;
    }
    if (doc !== this.view && doc !== this.rest && differsBesideNodes(doc, this.rest)) {
      // Only `nodes` of `rest` is never read: the draft's table stands in for it.
      this.rest = doc;
      this.view = null;
    }
    for (const id of changed) {
      this.writtenIds.add(id);
      if (!(id in this.table!)) this.gone.add(id);
      this.updates.delete(id);
      this.touch(id);
    }
  }

  /** Runs `work` and returns the ids it changed or removed. */
  collect(work: () => void): Set<NodeId> {
    const ids = new Set<NodeId>();
    this.watchers.push(ids);
    try {
      work();
    } finally {
      this.watchers.splice(this.watchers.indexOf(ids), 1);
    }
    return ids;
  }

  toDocument(): DesignDocument {
    if (!this.changed) return this.base;
    if (this.tableMode) return {...this.rest, nodes: this.table ?? this.base.nodes};
    const nodes = copyTable(this.base.nodes);
    for (const [id, node] of this.nodes) nodes[id] = node;
    for (const id of this.gone) delete nodes[id];
    return {...this.base, nodes};
  }

  /** Table mode: the table to write `id` into, copying the base's on the first write. The id is
   *  recorded before the write, so a pass that throws halfway still reports what it touched. */
  private writable(id: NodeId): Record<NodeId, SceneNode> {
    if (!this.table) this.table = copyTable(this.base.nodes);
    this.writtenIds.add(id);
    this.log?.touch(id);
    return this.table;
  }

  private touch(id: NodeId) {
    for (const ids of this.watchers) ids.add(id);
  }
}

/** Whether two documents differ in a table other than `nodes` (by identity). */
function differsBesideNodes(a: DesignDocument, b: DesignDocument): boolean {
  const left = a as unknown as Record<string, unknown>, right = b as unknown as Record<string, unknown>;
  for (const key in left) if (key !== 'nodes' && left[key] !== right[key]) return true;
  for (const key in right) if (key !== 'nodes' && !(key in left)) return true;
  return false;
}

/** A frame-like node whose children are placed by auto layout. */
export function isAutoLayout(node: SceneNode | undefined): boolean {
  return !!node && FRAME_LIKE_TYPES.includes(node.type) && !!node.autoLayout && node.autoLayout.layoutMode !== 'NONE';
}

/** Turned off its parent's axes (anything but a multiple of 180°): its width no longer runs along
 *  the parent's x, so it cannot fill and takes its rotated bounding box in a flow. */
export function isTurned(node: Pick<SceneNode, 'rotation'>): boolean {
  const turn = (((node.rotation || 0) % 180) + 180) % 180;
  return turn > 0.01 && turn < 179.99;
}

/** The node's box in its parent's space, as an axis-aligned rectangle (rotation and flips applied). */
export function boundsOf(node: Pick<SceneNode, 'x' | 'y' | 'width' | 'height' | 'rotation' | 'flipX' | 'flipY'>): Box {
  if (!node.rotation) return {x: node.x, y: node.y, width: node.width, height: node.height};
  return transformRect(localMatrix(node), {x: 0, y: 0, width: node.width, height: node.height});
}

const ratio = (after: number, before: number, fallback = 1) => (before > LAYOUT_EPSILON ? after / before : fallback);

/** The node's own size after its bounding box is stretched by `kx`, `ky`. Exact for multiples of
 *  90°; in between, each side keeps its direction and takes the length its direction stretches to
 *  (a turned box under a non-uniform scale would otherwise need a skew, which nodes cannot hold). */
function stretchedSize(node: SceneNode, kx: number, ky: number): Size {
  if (kx === 1 && ky === 1) return {width: node.width, height: node.height};
  const radians = toRadians(node.rotation || 0);
  const cos = Math.abs(Math.cos(radians)), sin = Math.abs(Math.sin(radians));
  return {width: node.width * Math.hypot(kx * cos, ky * sin), height: node.height * Math.hypot(kx * sin, ky * cos)};
}

/** The box whose bounding box is `target`, for a node whose bounding box is now `current`. */
export function boxForBounds(node: SceneNode, target: Box, current: Box = boundsOf(node), fallback: Vec = {x: 1, y: 1}): Box {
  const size = stretchedSize(node, ratio(target.width, current.width, fallback.x), ratio(target.height, current.height, fallback.y));
  if (!node.rotation) return {x: target.x, y: target.y, ...size};
  const zero = transformRect(localMatrix({...node, x: 0, y: 0, ...size}), {x: 0, y: 0, ...size});
  return {x: target.x - zero.x, y: target.y - zero.y, ...size};
}

function follow(type: ConstraintType, start: number, size: number, before: number, after: number): [number, number] {
  const delta = after - before;
  switch (type) {
    case 'MAX': return [start + delta, size];
    case 'CENTER': return [start + delta / 2, size];
    case 'STRETCH': return [start, Math.max(0, size + delta)];
    case 'SCALE': {
      const k = ratio(after, before);
      return [start * k, size * k];
    }
    default: return [start, size];
  }
}

/** Where a child goes when its parent's box changes from `before` to `after`, by Figma's
 *  constraints applied to the child's bounding box: MIN keeps the left/top margin, MAX the
 *  right/bottom one, CENTER the offset from the centre, STRETCH both margins, SCALE the proportions. */
export function constrainedBox(child: SceneNode, before: Size, after: Size, constraints: Constraints = child.constraints): Box {
  const bounds = boundsOf(child);
  const [x, width] = follow(constraints.horizontal, bounds.x, bounds.width, before.width, after.width);
  const [y, height] = follow(constraints.vertical, bounds.y, bounds.height, before.height, after.height);
  return boxForBounds(child, {x, y, width, height}, bounds);
}

const SCALE: Constraints = {horizontal: 'SCALE', vertical: 'SCALE'};

function scaleCommand(command: PathCommand, sx: number, sy: number): PathCommand {
  switch (command.type) {
    case 'M': case 'L': return {...command, x: command.x * sx, y: command.y * sy};
    case 'Q': return {...command, x1: command.x1 * sx, y1: command.y1 * sy, x: command.x * sx, y: command.y * sy};
    case 'C': return {...command, x1: command.x1 * sx, y1: command.y1 * sy, x2: command.x2 * sx, y2: command.y2 * sy, x: command.x * sx, y: command.y * sy};
    default: return command;
  }
}

export const scalePaths = (paths: readonly VectorPath[], sx: number, sy: number): VectorPath[] =>
  paths.map(path => ({...path, commands: path.commands.map(command => scaleCommand(command, sx, sy))}));

/** A text's path ("Text on path") scaled with its layer, as a VECTOR's paths are. */
export const scaleTextPath = (path: TextPathData, sx: number, sy: number): TextPathData => ({...path, commands: path.commands.map(command => scaleCommand(command, sx, sy))});

/** Figma's switch when a text box is resized: an auto-width text dragged sideways keeps an
 *  automatic height; any other change of a measured side makes the box fixed. */
export function textModeAfterResize(mode: TextAutoResize, widthChanged: boolean, heightChanged: boolean): TextAutoResize {
  if (mode === 'WIDTH_AND_HEIGHT') return heightChanged ? 'NONE' : widthChanged ? 'HEIGHT' : mode;
  if (mode === 'HEIGHT' && heightChanged) return 'NONE';
  return mode;
}

/** How `resizeNode` was reached: by the user (`hand`), by following a resized parent (`follow`),
 *  or by auto layout assigning the size (`layout`, which keeps every sizing field as it is). */
export type ResizeMode = 'hand' | 'follow' | 'layout';
export type ResizeHooks = {
  /** Given, an automatic-height text gets its new height at once (layout needs it in the same pass). */
  measurer?: TextMeasurer;
  /** An auto-layout frame changed size; its flow children wait for the layout engine. */
  onFrameResized?: (id: NodeId) => void;
};

/** Sets the node's box (in its parent's space, before rotation) and applies what follows from it
 *  to the node's sizing fields and its descendants. */
export function resizeNode(draft: Draft, id: NodeId, box: Box, mode: ResizeMode, hooks: ResizeHooks = {}): void {
  const node = draft.get(id);
  if (!node || node.type === 'PAGE') return;
  const width = Math.max(0, box.width);
  const height = node.type === 'LINE' ? 0 : Math.max(0, box.height);
  const widthChanged = !sameValue(width, node.width), heightChanged = !sameValue(height, node.height);
  const patch: Partial<SceneNode> = {x: box.x, y: box.y, width, height};
  if (mode === 'hand') Object.assign(patch, handSizing(node, widthChanged, heightChanged));
  if (node.type === 'TEXT' && node.text && mode !== 'layout') Object.assign(patch, textResize(node, node.text, patch, width, widthChanged, heightChanged, hooks.measurer));
  if (node.vectorPaths?.length && (widthChanged || heightChanged)) patch.vectorPaths = scalePaths(node.vectorPaths, ratio(width, node.width), ratio(height, node.height));
  if (node.textPath && (widthChanged || heightChanged)) patch.textPath = scaleTextPath(node.textPath, ratio(width, node.width), ratio(height, node.height));
  draft.update(id, patch);
  if (!widthChanged && !heightChanged) return;

  const before = {width: node.width, height: node.height}, after = {width, height};
  const children = node.children ?? [];
  if (node.type === 'GROUP' || node.type === 'BOOLEAN_OPERATION') {
    for (const childId of children) {
      const child = draft.get(childId);
      if (child) resizeNode(draft, childId, constrainedBox(child, before, after, SCALE), 'follow', hooks);
    }
  } else if (node.type === 'SECTION') {
    // A section is a canvas region: dragging its left or top edge leaves what is inside in place.
    const dx = box.x - node.x, dy = box.y - node.y;
    if (dx || dy) for (const childId of children) {
      const child = draft.get(childId);
      if (child) draft.update(childId, {x: child.x - dx, y: child.y - dy});
    }
  } else if (children.length) {
    const flow = isAutoLayout(node);
    for (const childId of children) {
      const child = draft.get(childId);
      if (!child || (flow && child.layoutPositioning !== 'ABSOLUTE')) continue;
      resizeNode(draft, childId, constrainedBox(child, before, after), 'follow', hooks);
    }
  }
  if (isAutoLayout(node) && mode !== 'layout') hooks.onFrameResized?.(id);
}

/** A side the user set stops hugging (auto-layout frames) or filling (auto-layout children). */
function handSizing(node: SceneNode, widthChanged: boolean, heightChanged: boolean): Partial<SceneNode> {
  const patch: Partial<SceneNode> = {};
  if (widthChanged && node.layoutSizingHorizontal !== 'FIXED') patch.layoutSizingHorizontal = 'FIXED';
  if (heightChanged && node.layoutSizingVertical !== 'FIXED') patch.layoutSizingVertical = 'FIXED';
  return patch;
}

function textResize(node: SceneNode, text: TextProps, patch: Partial<SceneNode>, width: number, widthChanged: boolean, heightChanged: boolean, measurer?: TextMeasurer): Partial<SceneNode> {
  const mode = textModeAfterResize(text.textAutoResize, widthChanged, heightChanged);
  const fillH = (patch.layoutSizingHorizontal ?? node.layoutSizingHorizontal) === 'FILL';
  const fillV = (patch.layoutSizingVertical ?? node.layoutSizingVertical) === 'FILL';
  const out: Partial<SceneNode> = {
    layoutSizingHorizontal: fillH ? 'FILL' : mode === 'WIDTH_AND_HEIGHT' ? 'HUG' : 'FIXED',
    layoutSizingVertical: fillV ? 'FILL' : mode === 'WIDTH_AND_HEIGHT' || mode === 'HEIGHT' ? 'HUG' : 'FIXED',
  };
  const nextText = mode === text.textAutoResize ? text : {...text, textAutoResize: mode};
  if (nextText !== text) out.text = nextText;
  if (measurer && mode === 'HEIGHT' && widthChanged) out.height = textBoxSize({...node, width, text: nextText}, measurer).height;
  return out;
}

/** Field updates (node and descendants) that resize `id` to `box`, in its parent's space. */
export function resizeUpdates(doc: DesignDocument, id: NodeId, box: Box): NodeUpdates {
  if (engineTs('normalize')) return resizeUpdatesTs(doc, id, box);
  return withEngine('normalize', 'resizeUpdates', () => resizeUpdatesTs(doc, id, box), () => updatesFrom(doc, layoutEntries(doc).normalize_resize(id, box.x, box.y, box.width, box.height)).updates, {inputs: {id, box}});
}

function resizeUpdatesTs(doc: DesignDocument, id: NodeId, box: Box): NodeUpdates {
  const draft = new Draft(doc);
  resizeNode(draft, id, box, 'hand');
  return draft.updates;
}

// ── The Scale tool (K) ─────────────────────────────────────────────────────────────────────────

function scaleTextStyle<T extends Partial<TextStyle>>(style: T, k: number): T {
  const next = {...style};
  if (style.fontSize !== undefined) next.fontSize = style.fontSize * k;
  if (style.lineHeight?.unit === 'PIXELS') next.lineHeight = {unit: 'PIXELS', value: style.lineHeight.value * k};
  if (style.letterSpacing?.unit === 'PIXELS') next.letterSpacing = {unit: 'PIXELS', value: style.letterSpacing.value * k};
  return next;
}

function scaleText(text: TextProps, k: number): TextProps {
  return {
    ...text,
    style: scaleTextStyle(text.style, k),
    // A scaled range no longer matches its text style, so it is detached (the values stay).
    runs: text.runs.map(run => {
      const next: TextRun = {...run, style: scaleTextStyle(run.style, k)};
      delete next.textStyleId;
      return next;
    }),
    paragraphSpacing: text.paragraphSpacing * k,
    paragraphIndent: text.paragraphIndent * k,
  };
}

/** Everything that has a length on the node, scaled: strokes, radii, dashes, effects, type,
 *  auto-layout spacing, grids, limits and paths. Styles whose values no longer match are detached. */
function scaledFields(node: SceneNode, fx: number, fy: number): Partial<SceneNode> {
  const k = Math.sqrt(fx * fy);
  const patch: Partial<SceneNode> = {strokeWeight: node.strokeWeight * k};
  const sides = node.individualStrokeWeights;
  if (sides) patch.individualStrokeWeights = {top: sides.top * fy, right: sides.right * fx, bottom: sides.bottom * fy, left: sides.left * fx};
  if (node.cornerRadius !== undefined) patch.cornerRadius = node.cornerRadius * k;
  if (node.rectangleCornerRadii) patch.rectangleCornerRadii = node.rectangleCornerRadii.map(radius => radius * k) as [number, number, number, number];
  if (node.dashPattern.length) patch.dashPattern = node.dashPattern.map(dash => dash * k);
  if (node.effects.length) {
    patch.effects = node.effects.map((effect): Effect => effect.type === 'DROP_SHADOW' || effect.type === 'INNER_SHADOW'
      ? {...effect, offset: {x: effect.offset.x * fx, y: effect.offset.y * fy}, radius: effect.radius * k, spread: effect.spread * k}
      : {...effect, radius: effect.radius * k});
    if (node.effectStyleId) patch.effectStyleId = undefined;
  }
  if (node.text) {
    patch.text = scaleText(node.text, k);
    if (node.textStyleId) patch.textStyleId = undefined;
  }
  const layout = node.autoLayout;
  if (layout) {
    const horizontal = layout.layoutMode !== 'VERTICAL';
    patch.autoLayout = {
      ...layout,
      paddingLeft: layout.paddingLeft * fx, paddingRight: layout.paddingRight * fx,
      paddingTop: layout.paddingTop * fy, paddingBottom: layout.paddingBottom * fy,
      itemSpacing: layout.itemSpacing * (horizontal ? fx : fy),
      counterAxisSpacing: layout.counterAxisSpacing * (horizontal ? fy : fx),
    };
  }
  if (node.grid) {
    const scaledTrack = (track: GridTrackSize, f: number): GridTrackSize => (track.type === 'FIXED' && track.value !== undefined ? {...track, value: track.value * f} : track);
    patch.grid = {...node.grid, rowGap: node.grid.rowGap * fy, columnGap: node.grid.columnGap * fx, rowSizes: node.grid.rowSizes.map(track => scaledTrack(track, fy)), columnSizes: node.grid.columnSizes.map(track => scaledTrack(track, fx))};
  }
  if (node.layoutGrids?.length) {
    patch.layoutGrids = node.layoutGrids.map(grid => {
      if (grid.pattern === 'GRID') return {...grid, sectionSize: grid.sectionSize * k};
      const f = grid.pattern === 'COLUMNS' ? fx : fy;
      return {...grid, sectionSize: grid.sectionSize * f, gutterSize: grid.gutterSize * f, offset: grid.offset * f};
    });
    if (node.gridStyleId) patch.gridStyleId = undefined;
  }
  if (node.minWidth != null) patch.minWidth = node.minWidth * fx;
  if (node.maxWidth != null) patch.maxWidth = node.maxWidth * fx;
  if (node.minHeight != null) patch.minHeight = node.minHeight * fy;
  if (node.maxHeight != null) patch.maxHeight = node.maxHeight * fy;
  if (node.vectorPaths?.length) patch.vectorPaths = scalePaths(node.vectorPaths, fx, fy);
  if (node.textPath) patch.textPath = scaleTextPath(node.textPath, fx, fy);
  return patch;
}

function scaleNode(draft: Draft, id: NodeId, box: Box, fallbackX: number, fallbackY: number): void {
  const node = draft.get(id);
  if (!node || node.type === 'PAGE') return;
  const fx = ratio(box.width, node.width, fallbackX), fy = ratio(box.height, node.height, fallbackY);
  for (const childId of node.children ?? []) {
    const child = draft.get(childId);
    if (!child) continue;
    const bounds = boundsOf(child);
    const target = {x: bounds.x * fx, y: bounds.y * fy, width: bounds.width * fx, height: bounds.height * fy};
    scaleNode(draft, childId, boxForBounds(child, target, bounds, {x: fx, y: fy}), fx, fy);
  }
  draft.update(id, {...box, height: node.type === 'LINE' ? 0 : box.height, ...scaledFields(node, fx, fy)});
}

/** The Scale tool (K): scales the nodes about `origin` (page space) by `sx`, `sy` (> 0), with
 *  everything inside them — sizes, positions, stroke weights, radii, type, effects, spacing. Nodes
 *  whose ancestor is also listed are scaled with that ancestor. */
export function scaleUpdates(doc: DesignDocument, ids: readonly NodeId[], origin: Vec, sx: number, sy: number): NodeUpdates {
  if (engineTs('normalize')) return scaleUpdatesTs(doc, ids, origin, sx, sy);
  return withEngine('normalize', 'scaleUpdates', () => scaleUpdatesTs(doc, ids, origin, sx, sy), () => updatesFrom(doc, layoutEntries(doc).normalize_scale(JSON.stringify(ids), origin.x, origin.y, sx, sy)).updates, {inputs: {ids, origin, sx, sy}});
}

function scaleUpdatesTs(doc: DesignDocument, ids: readonly NodeId[], origin: Vec, sx: number, sy: number): NodeUpdates {
  const draft = new Draft(doc);
  const kx = Math.abs(sx) || 1, ky = Math.abs(sy) || 1;
  const listed = new Set(ids);
  for (const id of ids) {
    const node = doc.nodes[id];
    if (!node || node.type === 'PAGE') continue;
    let nested = false;
    for (let up = node.parentId ? doc.nodes[node.parentId] : undefined; up && !nested; up = up.parentId ? doc.nodes[up.parentId] : undefined) nested = listed.has(up.id);
    if (nested) continue;
    const toParent = node.parentId ? invert(worldMatrix(doc, node.parentId)) : IDENTITY;
    const o = apply(toParent, origin);
    const bounds = boundsOf(node);
    const target = {x: o.x + (bounds.x - o.x) * kx, y: o.y + (bounds.y - o.y) * ky, width: bounds.width * kx, height: bounds.height * ky};
    scaleNode(draft, id, boxForBounds(node, target, bounds, {x: kx, y: ky}), kx, ky);
  }
  return draft.updates;
}
