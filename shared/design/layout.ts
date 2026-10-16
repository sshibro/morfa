import type {AutoLayout, DesignDocument, LayoutSizing, NodeId, SceneNode, TextAutoResize} from './types';
import type {TextMeasurer} from './text-layout';
import {layoutText} from './text-layout';
import {localMatrix, transformRect} from './geometry';
import {Draft, LAYOUT_EPSILON, constrainedBox, isAutoLayout, isTurned, resizeNode, sameValue} from './constraints';
import type {Box, NodeUpdates, ResizeHooks, Size} from './constraints';
import {engineTs, withEngine} from './engine-switch';
import {layoutEntries, requireFixedWidth, updatesFrom} from './layout-wasm';
import {DEFAULT_GRID, placeGridChildren, sizeGridTracks, spanExtent, trackOffsets} from './layout-grid';
import type {GridCell} from './layout-grid';

// Auto layout, as Figma does it (docs/design-tool.md §The document). A frame-like node with
// `autoLayout.layoutMode` HORIZONTAL or VERTICAL places its visible, non-absolute children in a
// row or a column: padding, item spacing or SPACE_BETWEEN, alignment on both axes (BASELINE for
// rows), wrapping into rows with their own spacing, and per-child sizing — FIXED keeps the size,
// HUG takes the content's size (auto-layout frames and text), FILL shares what is left on the
// main axis and stretches across the other — clamped by min/max with the remainder handed on.
//
// Widths are always resolved before heights, whatever the direction: a width never depends on a
// height, while a height can depend on the width (wrapping text, a column of such text). Every
// size is measured bottom-up on demand and memoised; `arrange` then writes sizes and positions
// top-down, descending only into children whose size changed or whose content changed.
//
// TEXT: `textAutoResize` decides whether a text hugs (WIDTH_AND_HEIGHT hugs both sides, HEIGHT the
// height), `layoutSizing*` = FILL decides that it fills; the other sizing fields mirror those
// (`textSizing`). The panel changes sizing through `layoutSizingUpdates`, which keeps both in step.

export {isAutoLayout};

export type SizingAxis = 'horizontal' | 'vertical';
/** 0: x, width, horizontal; 1: y, height, vertical. */
type Axis = 0 | 1;
type Pair = [number, number];
type Sides = [Pair, Pair];

const NO_SIDES: Sides = [[0, 0], [0, 0]];
const sizeOn = (size: Size, axis: Axis) => (axis ? size.height : size.width);
const sizingOn = (node: SceneNode, axis: Axis) => (axis ? node.layoutSizingVertical : node.layoutSizingHorizontal);
const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);
/** As `textBoxSize` rounds text sizes: up to whole hundredths of a pixel. */
const roundUp = (value: number) => Math.ceil(value * 100 - 1e-6) / 100 || 0;

/** HUG is offered for auto-layout frames and text only. */
export function canHug(node: SceneNode): boolean {
  return node.type === 'TEXT' || isAutoLayout(node);
}

/** FILL is offered for flow children of an auto-layout frame. A line has no height to fill, and a
 *  child turned off the axes takes its rotated bounds, which cannot be stretched to a size. */
export function canFill(node: SceneNode, parent: SceneNode | undefined, axis?: SizingAxis): boolean {
  if (!parent || !isAutoLayout(parent) || node.layoutPositioning === 'ABSOLUTE' || isTurned(node)) return false;
  return !(node.type === 'LINE' && axis === 'vertical');
}

/** A text's resize mode and sizing once its FILL choice is taken into account: filling the width
 *  turns an auto-width text into auto-height, filling the height makes it fixed. */
export function textSizing(node: SceneNode, parent: SceneNode | undefined): {textAutoResize: TextAutoResize; horizontal: LayoutSizing; vertical: LayoutSizing} {
  let mode = node.text?.textAutoResize ?? 'NONE';
  const fillH = node.layoutSizingHorizontal === 'FILL' && canFill(node, parent, 'horizontal');
  const fillV = node.layoutSizingVertical === 'FILL' && canFill(node, parent, 'vertical');
  if (fillV && (mode === 'WIDTH_AND_HEIGHT' || mode === 'HEIGHT')) mode = 'NONE';
  if (fillH && mode === 'WIDTH_AND_HEIGHT') mode = 'HEIGHT';
  return {
    textAutoResize: mode,
    horizontal: fillH ? 'FILL' : mode === 'WIDTH_AND_HEIGHT' ? 'HUG' : 'FIXED',
    vertical: fillV ? 'FILL' : mode === 'WIDTH_AND_HEIGHT' || mode === 'HEIGHT' ? 'HUG' : 'FIXED',
  };
}

/** The sizing layout applies to the node on `axis`: a HUG or FILL the node cannot have there
 *  (no auto layout, not in a flow, turned) counts as FIXED. */
export function effectiveSizing(node: SceneNode, parent: SceneNode | undefined, axis: SizingAxis): LayoutSizing {
  if (node.type === 'TEXT') return textSizing(node, parent)[axis];
  const sizing = axis === 'horizontal' ? node.layoutSizingHorizontal : node.layoutSizingVertical;
  if (sizing === 'FILL') return canFill(node, parent, axis) ? 'FILL' : 'FIXED';
  if (sizing === 'HUG') return canHug(node) ? 'HUG' : 'FIXED';
  return 'FIXED';
}

/** The fields that make the node's stored sizing match `effectiveSizing` (and, for text, its resize
 *  mode match `textSizing`), or null when they already do. Figma makes the same corrections, e.g.
 *  a FILL child taken out of auto layout becomes FIXED. */
export function sizingFixes(node: SceneNode, parent: SceneNode | undefined): Partial<SceneNode> | null {
  const patch: Partial<SceneNode> = {};
  let horizontal: LayoutSizing, vertical: LayoutSizing;
  if (node.type === 'TEXT' && node.text) {
    const sizing = textSizing(node, parent);
    if (sizing.textAutoResize !== node.text.textAutoResize) patch.text = {...node.text, textAutoResize: sizing.textAutoResize};
    ({horizontal, vertical} = sizing);
  } else {
    horizontal = effectiveSizing(node, parent, 'horizontal');
    vertical = effectiveSizing(node, parent, 'vertical');
  }
  if (horizontal !== node.layoutSizingHorizontal) patch.layoutSizingHorizontal = horizontal;
  if (vertical !== node.layoutSizingVertical) patch.layoutSizingVertical = vertical;
  return Object.keys(patch).length ? patch : null;
}

/** The updates for the panel's "Fixed / Hug contents / Fill container" choice on one axis. Text changes its
 *  resize mode with it; a child set to fill a parent's main axis turns a hugging parent fixed there,
 *  as Figma does (a parent cannot take its size from a child that takes its size from the parent).
 *  An option the node cannot have changes nothing. */
export function layoutSizingUpdates(doc: DesignDocument, id: NodeId, axis: SizingAxis, sizing: LayoutSizing): NodeUpdates {
  if (engineTs('normalize')) return layoutSizingUpdatesTs(doc, id, axis, sizing);
  return withEngine('normalize', 'layoutSizingUpdates', () => layoutSizingUpdatesTs(doc, id, axis, sizing), () => updatesFrom(doc, layoutEntries(doc).normalize_layout_sizing(id, axis === 'vertical', sizing)).updates, {inputs: {id, axis, sizing}});
}

function layoutSizingUpdatesTs(doc: DesignDocument, id: NodeId, axis: SizingAxis, sizing: LayoutSizing): NodeUpdates {
  const draft = new Draft(doc);
  const node = draft.get(id);
  if (!node) return draft.updates;
  const parent = draft.get(node.parentId);
  if ((sizing === 'HUG' && !canHug(node)) || (sizing === 'FILL' && !canFill(node, parent, axis))) return draft.updates;
  const patch: Partial<SceneNode> = axis === 'horizontal' ? {layoutSizingHorizontal: sizing} : {layoutSizingVertical: sizing};
  if (node.type === 'TEXT' && node.text) {
    let mode = node.text.textAutoResize;
    if (axis === 'horizontal') {
      if (sizing === 'HUG') {
        mode = 'WIDTH_AND_HEIGHT';
        if (node.layoutSizingVertical === 'FILL') patch.layoutSizingVertical = 'HUG';
      } else if (mode === 'WIDTH_AND_HEIGHT') mode = 'HEIGHT';
    } else if (sizing === 'HUG') {
      if (mode !== 'WIDTH_AND_HEIGHT') mode = 'HEIGHT';
    } else {
      if (mode === 'WIDTH_AND_HEIGHT' && node.layoutSizingHorizontal !== 'FILL') patch.layoutSizingHorizontal = 'FIXED';
      if (mode === 'WIDTH_AND_HEIGHT' || mode === 'HEIGHT') mode = 'NONE';
    }
    if (mode !== node.text.textAutoResize) patch.text = {...node.text, textAutoResize: mode};
    Object.assign(patch, sizingFixes({...node, ...patch}, parent));
  }
  draft.update(id, patch);
  if (sizing === 'FILL' && parent?.autoLayout && parent.autoLayout.layoutMode !== 'GRID') {
    const main: SizingAxis = parent.autoLayout.layoutMode === 'HORIZONTAL' ? 'horizontal' : 'vertical';
    if (axis === main && effectiveSizing(parent, draft.get(parent.parentId), axis) === 'HUG') {
      draft.update(parent.id, axis === 'horizontal' ? {layoutSizingHorizontal: 'FIXED'} : {layoutSizingVertical: 'FIXED'});
    }
  }
  return draft.updates;
}

// ── Measuring helpers ──────────────────────────────────────────────────────────────────────────

type Limits = {min: Pair; max: Pair};

function limitsOf(node: SceneNode): Limits {
  const min: Pair = [Math.max(0, node.minWidth ?? 0), Math.max(0, node.minHeight ?? 0)];
  // A maximum below the minimum loses, as in CSS.
  const max: Pair = [Math.max(min[0], node.maxWidth ?? Infinity), Math.max(min[1], node.maxHeight ?? Infinity)];
  return {min, max};
}

const clampTo = (value: number, limits: Limits, axis: Axis) => Math.min(limits.max[axis], Math.max(limits.min[axis], value));

/** Stroke widths on each side of the box that lie inside it (`inside`) or stick out of it. */
function strokeSides(node: SceneNode, part: 'inside' | 'outside'): Sides {
  if (!node.strokes.some(paint => paint.visible)) return NO_SIDES;
  const share = node.strokeAlign === 'CENTER' ? 0.5 : (node.strokeAlign === 'INSIDE') === (part === 'inside') ? 1 : 0;
  if (!share) return NO_SIDES;
  const w = node.individualStrokeWeights ?? {top: node.strokeWeight, right: node.strokeWeight, bottom: node.strokeWeight, left: node.strokeWeight};
  return [[w.left * share, w.right * share], [w.top * share, w.bottom * share]];
}

/** Padding, plus the frame's own inside stroke when strokes are included in layout (Figma's
 *  "border-box"). */
function paddingOf(node: SceneNode, layout: AutoLayout): Sides {
  const inset = layout.strokesIncludedInLayout ? strokeSides(node, 'inside') : NO_SIDES;
  return [[layout.paddingLeft + inset[0][0], layout.paddingRight + inset[0][1]], [layout.paddingTop + inset[1][0], layout.paddingBottom + inset[1][1]]];
}

function alignOffset(align: string, free: number): number {
  return align === 'CENTER' ? free / 2 : align === 'MAX' ? free : 0;
}

/** FILL children on one line of the main axis: each gets its basis plus an equal share of `free`,
 *  clamped by its limits; whatever a clamped child cannot take is shared by the rest (the
 *  freezing loop of CSS flexbox). */
function distribute(items: readonly {basis: number; limits: Limits}[], axis: Axis, free: number): number[] {
  const sizes = items.map(item => item.basis);
  const frozen = items.map(() => false);
  let remaining = free;
  for (let pass = 0; pass <= items.length; pass++) {
    const open = items.map((_, i) => i).filter(i => !frozen[i]);
    if (!open.length) break;
    const share = remaining / open.length;
    let violation = 0;
    for (const i of open) {
      const target = items[i].basis + share;
      sizes[i] = clampTo(target, items[i].limits, axis);
      violation += sizes[i] - target;
    }
    if (Math.abs(violation) <= LAYOUT_EPSILON) break;
    for (const i of open) {
      const target = items[i].basis + share;
      if (violation > 0 ? sizes[i] > target + LAYOUT_EPSILON : sizes[i] < target - LAYOUT_EPSILON) {
        frozen[i] = true;
        remaining -= sizes[i] - items[i].basis;
      }
    }
  }
  return sizes;
}

// ── The engine ─────────────────────────────────────────────────────────────────────────────────

type Item = {
  node: SceneNode;
  sizing: [LayoutSizing, LayoutSizing];
  limits: Limits;
  /** Stroke that counts in the flow, before and after the box on each axis. */
  out: Sides;
  /** Turned children are sized up front and take their rotated bounds (`bounds`) in the flow. */
  turned: boolean;
  bounds: Box | null;
  size: Pair;
  /** FILL on the main axis: what the free space is added to. */
  basis: number;
  /** Top-left of the footprint (box plus counted stroke) in the frame. */
  pos: Pair;
  /** BASELINE: from the footprint's top to the first baseline. */
  ascent: number;
};

type ContainerLayout = {width: number; height: number; boxes: Map<NodeId, Box>};

export type LayoutStats = {measured: number; arranged: number; textMeasured: number};
export type LayoutOptions = {
  /** Nodes whose stored size can be trusted as their measured size at that size (nothing in their
   *  subtree changed since the document was last normalized). Default: none. */
  trusted?: (id: NodeId) => boolean;
  stats?: LayoutStats;
};

/** Each child's box in the frame: the node's origin sits where its rotated or flipped box puts its footprint at `pos`. */
function boxesOf(items: readonly Item[]): Map<NodeId, Box> {
  const boxes = new Map<NodeId, Box>();
  for (const item of items) {
    const [width, height] = item.size;
    const {node: child} = item;
    const zero = child.rotation ? transformRect(localMatrix({...child, x: 0, y: 0, width, height}), {x: 0, y: 0, width, height}) : {x: 0, y: 0};
    boxes.set(child.id, {x: item.pos[0] + item.out[0][0] - zero.x, y: item.pos[1] + item.out[1][0] - zero.y, width, height});
  }
  return boxes;
}

function footprint(item: Item, axis: Axis): number {
  if (item.bounds) return sizeOn(item.bounds, axis) + item.out[axis][0] + item.out[axis][1];
  return item.size[axis] + item.out[axis][0] + item.out[axis][1];
}

function breakLines(items: Item[], axis: Axis, inner: number, gap: number): Item[][] {
  const lines: Item[][] = [];
  let line: Item[] = [], used = 0;
  for (const item of items) {
    const extent = footprint(item, axis);
    if (line.length && used + gap + extent > inner + LAYOUT_EPSILON) {
      lines.push(line);
      line = [];
      used = 0;
    }
    used += (line.length ? gap : 0) + extent;
    line.push(item);
  }
  lines.push(line);
  return lines;
}

/** Lays out auto-layout frames in a draft. `run(dirty)` finds, for each changed node, the outermost
 *  frame whose layout it can affect (up through hugging frames) and lays out those chains;
 *  frames resized on the way (filled children, constraint-stretched descendants) follow. */
export class LayoutEngine {
  private readonly memo = new Map<string, ContainerLayout>();
  private readonly textMemo = new Map<string, Size>();
  private readonly arranged = new Set<NodeId>();
  private readonly pending = new Set<NodeId>();
  private readonly trusted: (id: NodeId) => boolean;
  private readonly stats: LayoutStats;
  private readonly hooks: ResizeHooks;

  constructor(private readonly draft: Draft, private readonly measurer: TextMeasurer, options: LayoutOptions = {}) {
    this.trusted = options.trusted ?? (() => false);
    this.stats = options.stats ?? {measured: 0, arranged: 0, textMeasured: 0};
    this.hooks = {measurer, onFrameResized: id => this.pending.add(id)};
  }

  run(dirty: Iterable<NodeId>): void {
    const roots = new Set<NodeId>();
    for (const id of dirty) {
      const root = this.rootFor(id);
      if (root) roots.add(root);
    }
    const depth = new Map<NodeId, number>();
    for (const id of roots) depth.set(id, this.depthOf(id));
    for (const id of [...roots].sort((a, b) => depth.get(a)! - depth.get(b)!)) if (!this.arranged.has(id)) this.layoutRoot(id);
    this.flush();
  }

  /** The outermost auto-layout frame whose layout a change to `id` can affect. */
  rootFor(id: NodeId): NodeId | null {
    const node = this.draft.get(id);
    if (!node) return null;
    const parent = this.draft.get(node.parentId);
    let top = isAutoLayout(parent) ? parent! : isAutoLayout(node) ? node : null;
    if (!top) return null;
    for (;;) {
      const up = this.draft.get(top.parentId);
      if (!up || !isAutoLayout(up) || top.layoutPositioning === 'ABSOLUTE' || !top.visible) break;
      if (effectiveSizing(top, up, 'horizontal') !== 'HUG' && effectiveSizing(top, up, 'vertical') !== 'HUG') break;
      top = up;
    }
    return top.id;
  }

  /** Lays out a frame whose own size is not given by a parent's layout: hugging sides take the
   *  content's size, the others keep theirs. Its position stays. */
  layoutRoot(id: NodeId): void {
    const node = this.draft.get(id);
    if (!node || !isAutoLayout(node)) return;
    // Measured afresh: a root's stored size may be what a constraint just gave it, not its content.
    this.arrange(id, this.container(node));
  }

  private depthOf(id: NodeId): number {
    let depth = 0;
    for (let node = this.draft.get(id); node?.parentId; node = this.draft.get(node.parentId)) depth++;
    return depth;
  }

  private flush(): void {
    while (this.pending.size) {
      const [id] = this.pending;
      this.pending.delete(id);
      this.layoutRoot(id);
    }
  }

  // ── Measuring ──

  /** The node's size, with the given sides forced. An unforced side takes the node's own choice:
   *  its content for HUG, its stored size (clamped) otherwise. */
  measure(node: SceneNode, forcedWidth?: number, forcedHeight?: number): Size {
    if (this.trusted(node.id) && (forcedWidth === undefined || sameValue(forcedWidth, node.width)) && (forcedHeight === undefined || sameValue(forcedHeight, node.height))) {
      return {width: node.width, height: node.height};
    }
    if (isAutoLayout(node)) {
      const layout = this.container(node, forcedWidth, forcedHeight);
      return {width: layout.width, height: layout.height};
    }
    if (node.type === 'TEXT' && node.text) return this.measureText(node, forcedWidth, forcedHeight);
    const limits = limitsOf(node);
    return {width: forcedWidth ?? clampTo(node.width, limits, 0), height: forcedHeight ?? clampTo(node.height, limits, 1)};
  }

  /** The text's unwrapped size (`width` null) or its height at `width`, rounded up as
   *  `textBoxSize` rounds. Laid out from the node's own text object, so the text module's cache
   *  serves the canvas and this pass alike. */
  private textSize(node: SceneNode, width: number | null): Size {
    const key = `${node.id}|${width ?? ''}`;
    let size = this.textMemo.get(key);
    if (!size) {
      this.stats.textMeasured++;
      const layout = layoutText(node, this.measurer, width);
      size = {width: width ?? roundUp(layout.naturalWidth), height: roundUp(layout.height)};
      this.textMemo.set(key, size);
    }
    return size;
  }

  /** A text's size. Hugging the width takes the unwrapped width up to the maximum, past which the
   *  text wraps (Figma's max-width text); hugging the height measures at the resolved width. */
  private measureText(node: SceneNode, forcedWidth?: number, forcedHeight?: number, hugWidth = false): Size {
    const sizing = textSizing(node, this.draft.get(node.parentId));
    const limits = limitsOf(node);
    let width: number, height: number | undefined;
    if (forcedWidth !== undefined) width = forcedWidth;
    else if (hugWidth || sizing.horizontal === 'HUG') {
      const natural = this.textSize(node, null);
      width = clampTo(natural.width, limits, 0);
      if (sameValue(width, natural.width) && sizing.vertical === 'HUG') height = natural.height;
    } else width = clampTo(node.width, limits, 0);
    if (forcedHeight !== undefined) height = forcedHeight;
    else if (sizing.vertical === 'HUG') height = clampTo(height ?? this.textSize(node, width).height, limits, 1);
    else height = clampTo(node.height, limits, 1);
    return {width, height};
  }

  /** First baseline from the node's top, for BASELINE alignment; null when it has no text. */
  private baselineOf(node: SceneNode, width: number, height: number): number | null {
    if (isTurned(node)) return null;
    if (node.type === 'TEXT' && node.text) {
      const mode = textSizing(node, this.draft.get(node.parentId)).textAutoResize;
      // The stored text object keeps the text module's cache; only a mode layout is about to
      // correct (vertical alignment in a box that becomes fixed) needs a copy.
      const text = mode === node.text.textAutoResize ? node.text : {...node.text, textAutoResize: mode};
      return layoutText({...node, width, height, text}, this.measurer, mode === 'WIDTH_AND_HEIGHT' ? null : width).lines[0]?.baseline ?? null;
    }
    if (!isAutoLayout(node)) return null;
    // A frame's baseline is its first flow child's that has one, as in CSS.
    const {boxes} = this.container(node, width, height);
    for (const id of node.children ?? []) {
      const box = boxes.get(id), child = this.draft.get(id);
      const own = box && child ? this.baselineOf(child, box.width, box.height) : null;
      if (box && own !== null) return box.y + own;
    }
    return null;
  }

  private itemsOf(node: SceneNode, layout: AutoLayout): Item[] {
    const items: Item[] = [];
    for (const id of node.children ?? []) {
      const child = this.draft.get(id);
      if (!child || !child.visible || child.layoutPositioning === 'ABSOLUTE') continue;
      const item: Item = {
        node: child,
        sizing: [effectiveSizing(child, node, 'horizontal'), effectiveSizing(child, node, 'vertical')],
        limits: limitsOf(child),
        out: layout.strokesIncludedInLayout ? strokeSides(child, 'outside') : NO_SIDES,
        turned: isTurned(child),
        bounds: null,
        size: [child.width, child.height],
        basis: 0,
        pos: [0, 0],
        ascent: 0,
      };
      if (item.turned) {
        // Sized up front from its own content; the flow only sees its rotated bounds.
        const {width, height} = this.measure(child);
        item.size = [width, height];
        item.bounds = transformRect(localMatrix({...child, x: 0, y: 0, width, height}), {x: 0, y: 0, width, height});
        const o = Math.max(item.out[0][0], item.out[0][1], item.out[1][0], item.out[1][1]);
        item.out = [[o, o], [o, o]];
      }
      items.push(item);
    }
    return items;
  }

  /** FIXED or HUG size of a child on one axis. Heights are asked after widths, at the width found. */
  private itemSize(item: Item, axis: Axis): number {
    if (item.sizing[axis] === 'FIXED') return clampTo(sizeOn(item.node, axis), item.limits, axis);
    return sizeOn(axis ? this.measure(item.node, item.size[0]) : this.measure(item.node), axis);
  }

  /** In a frame that hugs its main axis there is no space to share: a filling child starts from its
   *  content (text) or its stored size, and only a min/max of the frame changes it. */
  private fillBasis(item: Item, axis: Axis): number {
    const {node} = item;
    if (node.type === 'TEXT' && node.text) {
      return axis ? clampTo(this.textSize(node, item.size[0]).height, item.limits, 1) : this.measureText(node, undefined, undefined, true).width;
    }
    return clampTo(sizeOn(node, axis), item.limits, axis);
  }

  /** Sizes and places the children of an auto-layout frame; sides not forced follow the frame's
   *  own sizing. Memoised per forced size. */
  private container(node: SceneNode, forcedWidth?: number, forcedHeight?: number): ContainerLayout {
    const key = `${node.id}|${forcedWidth ?? ''}|${forcedHeight ?? ''}`;
    const cached = this.memo.get(key);
    if (cached) return cached;
    this.stats.measured++;

    const layout = node.autoLayout!;
    const main: Axis = layout.layoutMode === 'HORIZONTAL' ? 0 : 1, cross: Axis = main ? 0 : 1;
    const parent = this.draft.get(node.parentId);
    const limits = limitsOf(node);
    const forced = [forcedWidth, forcedHeight];
    const fixed = ([0, 1] as const).map(axis => forced[axis] ?? (effectiveSizing(node, parent, axis ? 'vertical' : 'horizontal') === 'HUG' ? undefined : clampTo(sizeOn(node, axis), limits, axis)));
    const pad = paddingOf(node, layout);
    const items = this.itemsOf(node, layout);
    if (layout.layoutMode === 'GRID') {
      // Whether the frame hugs an axis decides how its FLEX tracks size, forced or not: `arrange` lays a hugging frame
      // out again at the size the free pass found, and the tracks must not change under it.
      const hugs = ([0, 1] as const).map(axis => effectiveSizing(node, parent, axis ? 'vertical' : 'horizontal') === 'HUG');
      const result = this.gridContainer(node, fixed, hugs, limits, pad, items);
      this.memo.set(key, result);
      return result;
    }
    const wrap = main === 0 && layout.layoutWrap === 'WRAP' && fixed[0] !== undefined;
    const spaceBetween = layout.primaryAxisAlignItems === 'SPACE_BETWEEN';
    const baseline = main === 0 && layout.counterAxisAlignItems === 'BASELINE';
    const size: Pair = [0, 0];
    const hugMain = fixed[main] === undefined, hugCross = fixed[cross] === undefined;
    const padMain = pad[main][0] + pad[main][1], padCross = pad[cross][0] + pad[cross][1];
    const crossGap = wrap ? layout.counterAxisSpacing : 0;
    let lines: Item[][] = [items];
    const lineSizes: number[] = [], lineAscents: number[] = [];

    const resolveMain = () => {
      for (const item of items) {
        if (item.turned) continue;
        if (item.sizing[main] !== 'FILL') item.size[main] = this.itemSize(item, main);
        else if (hugMain) item.size[main] = item.basis = this.fillBasis(item, main);
        // Fixed frame: FILL starts from nothing (Figma's equal shares); wrapping breaks at the min.
        else item.size[main] = wrap ? item.limits.min[main] : (item.basis = 0);
      }
      if (wrap) lines = breakLines(items, main, fixed[main]! - padMain, layout.itemSpacing);
      const extent = (line: Item[]) => (line.length ? sum(line.map(item => footprint(item, main))) + layout.itemSpacing * (line.length - 1) : 0);
      size[main] = hugMain ? clampTo(Math.max(0, padMain + extent(items)), limits, main) : fixed[main]!;
      const inner = size[main] - padMain;
      for (const line of lines) {
        const fills = line.filter(item => !item.turned && item.sizing[main] === 'FILL');
        if (!fills.length) continue;
        if (!hugMain) for (const item of fills) item.basis = 0;
        const gap = spaceBetween && !hugMain ? 0 : layout.itemSpacing;
        let used = gap * (line.length - 1);
        for (const item of line) used += fills.includes(item) ? item.basis + item.out[main][0] + item.out[main][1] : footprint(item, main);
        const sizes = distribute(fills, main, inner - used);
        fills.forEach((item, i) => { item.size[main] = sizes[i]; });
      }
    };

    const resolveCross = () => {
      for (const item of items) if (!item.turned && item.sizing[cross] !== 'FILL') item.size[cross] = this.itemSize(item, cross);
      for (const line of lines) {
        let extent = 0, ascent = 0, descent = 0, sized = false;
        for (const item of line) {
          if (!item.turned && item.sizing[cross] === 'FILL') continue;
          sized = true;
          const foot = footprint(item, cross);
          if (baseline) {
            const own = item.turned ? null : this.baselineOf(item.node, item.size[0], item.size[1]);
            item.ascent = item.out[1][0] + (own ?? (item.turned ? sizeOn(item.bounds!, 1) : item.size[1]));
            ascent = Math.max(ascent, item.ascent);
            descent = Math.max(descent, foot - item.ascent);
          } else extent = Math.max(extent, foot);
        }
        if (baseline && sized) extent = ascent + descent;
        // Only filling children: a hugging frame has nothing else to size by, so they keep theirs.
        if (!sized) for (const item of line) extent = Math.max(extent, clampTo(sizeOn(item.node, cross), item.limits, cross) + item.out[cross][0] + item.out[cross][1]);
        lineSizes.push(extent);
        lineAscents.push(ascent);
      }
      const block = sum(lineSizes) + crossGap * (lines.length - 1);
      size[cross] = hugCross ? clampTo(padCross + block, limits, cross) : fixed[cross]!;
      if (!wrap) lineSizes[0] = size[cross] - padCross;
      lines.forEach((line, l) => {
        for (const item of line) {
          if (item.turned || item.sizing[cross] !== 'FILL') continue;
          item.size[cross] = clampTo(lineSizes[l] - item.out[cross][0] - item.out[cross][1], item.limits, cross);
        }
      });
    };

    // Widths first: a height may depend on a width, never the reverse.
    if (main === 0) {
      resolveMain();
      resolveCross();
    } else {
      resolveCross();
      resolveMain();
    }

    // Positions.
    const innerMain = size[main] - padMain, innerCross = size[cross] - padCross;
    let lineStart = pad[cross][0], lineGap = crossGap;
    if (wrap) {
      const free = innerCross - sum(lineSizes) - crossGap * (lines.length - 1);
      if (layout.counterAxisAlignContent === 'SPACE_BETWEEN' && !hugCross) lineGap = lines.length > 1 ? (innerCross - sum(lineSizes)) / (lines.length - 1) : 0;
      else lineStart += alignOffset(layout.counterAxisAlignItems, free);
    }
    lines.forEach((line, l) => {
      const extents = line.map(item => footprint(item, main));
      let gap = layout.itemSpacing, start = 0;
      if (spaceBetween && !hugMain) gap = line.length > 1 ? (innerMain - sum(extents)) / (line.length - 1) : 0;
      else start = alignOffset(layout.primaryAxisAlignItems, innerMain - sum(extents) - gap * (line.length - 1));
      let cursor = pad[main][0] + start;
      line.forEach((item, i) => {
        item.pos[main] = cursor;
        cursor += extents[i] + gap;
        const filling = !item.turned && item.sizing[cross] === 'FILL';
        const offset = filling ? 0 : baseline ? lineAscents[l] - item.ascent : alignOffset(layout.counterAxisAlignItems, lineSizes[l] - footprint(item, cross));
        item.pos[cross] = lineStart + offset;
      });
      lineStart += lineSizes[l] + lineGap;
    });

    const result: ContainerLayout = {width: size[0], height: size[1], boxes: boxesOf(items)};
    this.memo.set(key, result);
    return result;
  }

  /** The GRID half of `container` (layout-grid.ts holds the pure parts): the children's
   *  cells, then per axis — widths before heights — each child's own size, the track sizes, the frame's size on a hugged
   *  axis, and the FILL children's sizes from their cells; then positions in the cells. */
  private gridContainer(node: SceneNode, fixed: readonly (number | undefined)[], hugs: readonly boolean[], limits: Limits, pad: Sides, items: Item[]): ContainerLayout {
    const grid = node.grid ?? DEFAULT_GRID;
    const placement = placeGridChildren(grid, items.map(item => item.node));
    const cells = items.map(item => placement.cells.get(item.node.id)!);
    const counts = [placement.columns, placement.rows], gaps = [grid.columnGap, grid.rowGap], specs = [grid.columnSizes, grid.rowSizes];
    const cellOn = (cell: GridCell, axis: Axis): [number, number] => (axis ? [cell.row, cell.rowSpan] : [cell.column, cell.columnSpan]);
    const size: Pair = [0, 0];
    const tracks: number[][] = [[], []];
    for (const axis of [0, 1] as const) {
      const padSum = pad[axis][0] + pad[axis][1];
      for (const item of items) {
        if (item.turned) continue;
        item.size[axis] = item.sizing[axis] === 'FILL' ? this.fillBasis(item, axis) : this.itemSize(item, axis);
      }
      const inner = hugs[axis] || fixed[axis] === undefined ? undefined : fixed[axis]! - padSum;
      const sizes = sizeGridTracks(specs[axis], counts[axis], gaps[axis], inner, items, item => cellOn(cells[items.indexOf(item)], axis), item => footprint(item, axis));
      tracks[axis] = sizes;
      size[axis] = fixed[axis] ?? clampTo(padSum + sum(sizes) + gaps[axis] * (counts[axis] - 1), limits, axis);
      const offsets = trackOffsets(sizes, gaps[axis], pad[axis][0]);
      items.forEach((item, i) => {
        const [start, span] = cellOn(cells[i], axis);
        const extent = spanExtent(offsets, sizes, start, span);
        const filling = !item.turned && item.sizing[axis] === 'FILL';
        if (filling) item.size[axis] = clampTo(extent - item.out[axis][0] - item.out[axis][1], item.limits, axis);
        const align = filling ? 'MIN' : ((axis ? item.node.gridChild?.verticalAlign : item.node.gridChild?.horizontalAlign) ?? 'AUTO');
        item.pos[axis] = offsets[start] + alignOffset(align === 'AUTO' ? 'MIN' : align, extent - footprint(item, axis));
      });
    }
    return {width: size[0], height: size[1], boxes: boxesOf(items)};
  }

  // ── Writing ──

  /** Gives the frame `size`, places its children, and lays out the children whose size changed or
   *  whose content changed. Absolute children follow their constraints when the frame resizes. */
  private arrange(id: NodeId, size: Size): void {
    const node = this.draft.get(id);
    if (!node) return;
    this.arranged.add(id);
    this.stats.arranged++;
    const before = {width: node.width, height: node.height};
    const layout = this.container(node, size.width, size.height);
    this.draft.update(id, {width: layout.width, height: layout.height});
    const resized = !sameValue(before.width, layout.width) || !sameValue(before.height, layout.height);
    for (const childId of node.children ?? []) {
      const child = this.draft.get(childId);
      if (!child) continue;
      const fixes = sizingFixes(child, node);
      if (fixes) this.draft.update(childId, fixes);
      const box = layout.boxes.get(childId);
      if (box) this.place(child, box);
      else if (resized && child.layoutPositioning === 'ABSOLUTE') resizeNode(this.draft, childId, constrainedBox(child, before, layout), 'follow', this.hooks);
    }
  }

  private place(child: SceneNode, box: Box): void {
    const resized = !sameValue(child.width, box.width) || !sameValue(child.height, box.height);
    if (!isAutoLayout(child)) {
      resizeNode(this.draft, child.id, box, 'layout', this.hooks);
      return;
    }
    this.draft.update(child.id, {x: box.x, y: box.y});
    if (resized || !this.trusted(child.id)) this.arrange(child.id, box);
  }
}

/** Lays out the auto-layout chain `id` belongs to (the frame itself, its auto-layout parent, and up
 *  through hugging frames), measuring everything afresh. Returns the field updates. */
export function layoutFrame(doc: DesignDocument, id: NodeId, measurer: TextMeasurer): NodeUpdates {
  if (engineTs('normalize')) return layoutFrameTs(doc, id, measurer);
  return withEngine('normalize', 'layoutFrame', () => layoutFrameTs(doc, id, measurer), () => {
    requireFixedWidth(measurer);
    return updatesFrom(doc, layoutEntries(doc).normalize_layout_frame(id)).updates;
  }, {inputs: {id}});
}

function layoutFrameTs(doc: DesignDocument, id: NodeId, measurer: TextMeasurer): NodeUpdates {
  const draft = new Draft(doc);
  new LayoutEngine(draft, measurer).run([id]);
  return draft.updates;
}
