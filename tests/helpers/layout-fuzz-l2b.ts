// Lane L2b's document generator for the layout stage diff (tests/helpers/stage-diff-l2b.ts): seeded documents
// built to reach every branch of shared/design/layout.ts, constraints.ts, group-fit.ts and normalize.ts's
// autoResizeText — nested auto layout (both directions, wrap, SPACE_BETWEEN, BASELINE, padding, negative and fractional
// spacing, strokes in layout), FIXED/HUG/FILL children with min/max (null, crossing), absolute and hidden children,
// turned and flipped layers, groups and boolean operations (nested, empty, rotated), sections, vectors with paths,
// text in every resize mode and alignment with runs, line heights, lists, truncation and text on a path, constraints
// of every kind. Every document passes `validateDocument`. Lane-local until S2's design-fuzz.ts lands.

import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../../shared/design/defaults';
import type {AutoLayout, ConstraintType, DesignDocument, GridChild, GridLayout, GridTrackSize, LayoutSizing, NodeId, NodeType, Paint, PathCommand, SceneNode, TextProps} from '../../shared/design/types';

/** mulberry32: the same stream on every run for a seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T,>(values: readonly T[]): T => values[int(values.length)];
  const chance = (p: number) => next() < p;
  return {next, int, pick, chance};
}
export type Rng = ReturnType<typeof rng>;

// 'ёж' stays Cyrillic on purpose: one non-Latin word in the mix.
const WORDS = ['Button', 'Heading', 'cards', 'Text', 'a', 'Learn more', 'price $990', '—', 'long-word-without-breaks', 'ёж', 'OK', '12:30', 'emoji 🙂', 'hello world'];
const SIZINGS: LayoutSizing[] = ['FIXED', 'HUG', 'FILL'];
const CONSTRAINTS: ConstraintType[] = ['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'];

function num(r: Rng, scale: number, fractional = true): number {
  const value = r.next() * scale;
  if (r.chance(0.15)) return 0;
  return fractional && r.chance(0.5) ? Math.round(value * 1000) / 1000 : Math.round(value);
}

function rotation(r: Rng): number {
  if (r.chance(0.75)) return 0;
  if (r.chance(0.5)) return r.pick([90, 180, 270, -90, 45, -30, 0.005, 179.995, 360]);
  return Math.round((r.next() * 720 - 360) * 100) / 100;
}

function strokes(r: Rng): Paint[] {
  if (r.chance(0.6)) return [];
  const paint = solid({r: 0, g: 0, b: 0});
  if (r.chance(0.3)) paint.visible = false;
  return r.chance(0.2) ? [paint, solid({r: 1, g: 0, b: 0})] : [paint];
}

function autoLayout(r: Rng): AutoLayout {
  const layout = defaultAutoLayout(r.pick(['HORIZONTAL', 'VERTICAL', 'HORIZONTAL', 'VERTICAL', 'NONE', 'GRID'] as const));
  layout.layoutWrap = r.chance(0.3) ? 'WRAP' : 'NO_WRAP';
  layout.primaryAxisAlignItems = r.pick(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN'] as const);
  layout.counterAxisAlignItems = r.pick(['MIN', 'CENTER', 'MAX', 'BASELINE'] as const);
  layout.counterAxisAlignContent = r.pick(['AUTO', 'SPACE_BETWEEN'] as const);
  layout.paddingLeft = num(r, 24);
  layout.paddingRight = num(r, 24);
  layout.paddingTop = num(r, 24);
  layout.paddingBottom = num(r, 24);
  layout.itemSpacing = r.chance(0.1) ? -num(r, 10) : num(r, 20);
  layout.counterAxisSpacing = num(r, 16);
  layout.strokesIncludedInLayout = r.chance(0.3);
  return layout;
}

function gridTrack(r: Rng): GridTrackSize {
  const type = r.pick(['FIXED', 'FLEX', 'FLEX', 'HUG'] as const);
  if (type === 'FIXED') return r.chance(0.2) ? {type} : {type, value: num(r, 120)};
  if (type === 'FLEX') return r.chance(0.5) ? {type} : {type, value: r.pick([1, 2, 3, 0.5, 0])};
  return {type};
}

/** Grid auto layout's frame settings (lane N1 step 11): both placement modes, auto rows, every track type, sizes
 *  arrays that are shorter or longer than the counts (co-editing leaves them so). */
function gridLayout(r: Rng): GridLayout {
  const columnCount = 1 + r.int(4), rowCount = 1 + r.int(3);
  const tracks = (count: number) => Array.from({length: r.chance(0.2) ? count + r.int(2) - 1 : count}, () => gridTrack(r));
  return {
    rowCount, columnCount,
    rowGap: r.chance(0.5) ? 0 : num(r, 16), columnGap: r.chance(0.5) ? 0 : num(r, 16),
    rowSizes: tracks(rowCount), columnSizes: tracks(columnCount),
    autoTracks: r.chance(0.4) ? 'ROWS' : 'NONE',
    itemsPositioning: r.chance(0.4) ? 'MANUAL' : 'ROW_AUTO_FLOW',
  };
}

/** A child's cell, spans and alignment; sometimes out of range or overlapping (the layout must cope). */
function gridChild(r: Rng): GridChild {
  const child: GridChild = {};
  if (r.chance(0.5)) {
    child.rowAnchorIndex = r.int(4);
    child.columnAnchorIndex = r.chance(0.1) ? 7 : r.int(4);
  }
  if (r.chance(0.3)) child.rowSpan = 1 + r.int(3);
  if (r.chance(0.3)) child.columnSpan = 1 + r.int(3);
  if (r.chance(0.5)) child.horizontalAlign = r.pick(['MIN', 'CENTER', 'MAX', 'AUTO'] as const);
  if (r.chance(0.5)) child.verticalAlign = r.pick(['MIN', 'CENTER', 'MAX', 'AUTO'] as const);
  return child;
}

function text(r: Rng): TextProps {
  const words = Array.from({length: 1 + r.int(8)}, () => r.pick(WORDS));
  let characters = words.join(r.chance(0.2) ? '\n' : ' ');
  if (r.chance(0.05)) characters = '';
  const props = defaultTextProps(characters);
  props.textAutoResize = r.pick(['WIDTH_AND_HEIGHT', 'HEIGHT', 'NONE', 'TRUNCATE'] as const);
  props.textAlignHorizontal = r.pick(['LEFT', 'CENTER', 'RIGHT', 'JUSTIFIED'] as const);
  props.textAlignVertical = r.pick(['TOP', 'CENTER', 'BOTTOM'] as const);
  props.style.fontSize = r.pick([12, 14, 16, 13.5, 24, 1]);
  if (r.chance(0.3)) props.style.lineHeight = r.chance(0.5) ? {unit: 'PIXELS', value: num(r, 40) + 1} : {unit: 'PERCENT', value: 80 + r.int(100)};
  if (r.chance(0.2)) props.style.letterSpacing = r.chance(0.5) ? {unit: 'PIXELS', value: num(r, 4)} : {unit: 'PERCENT', value: r.int(20) - 5};
  if (r.chance(0.1)) props.style.textCase = r.pick(['UPPER', 'LOWER', 'TITLE', 'SMALL_CAPS'] as const);
  props.paragraphSpacing = r.chance(0.2) ? num(r, 12) : 0;
  props.paragraphIndent = r.chance(0.1) ? num(r, 12) : 0;
  if (r.chance(0.15) && characters.length > 2) {
    const start = r.int(characters.length - 1);
    const end = start + 1 + r.int(characters.length - start - 1);
    props.runs = [{start, end, style: {fontSize: r.pick([10, 20, 32]), ...(r.chance(0.5) ? {fontWeight: 700} : {})}}];
  }
  if (r.chance(0.1)) props.listTypes = [r.pick(['ORDERED', 'UNORDERED', 'NONE'] as const)];
  if (r.chance(0.1)) props.maxLines = r.chance(0.3) ? null : 1 + r.int(3);
  return props;
}

function paths(r: Rng, width: number, height: number): PathCommand[] {
  const point = () => ({x: Math.round(r.next() * width * 100) / 100, y: Math.round(r.next() * height * 100) / 100});
  const commands: PathCommand[] = [{type: 'M', ...point()}, {type: 'L', ...point()}];
  if (r.chance(0.5)) {
    const [a, b, c] = [point(), point(), point()];
    commands.push({type: 'C', x1: a.x, y1: a.y, x2: b.x, y2: b.y, x: c.x, y: c.y});
  }
  if (r.chance(0.5)) {
    const [a, c] = [point(), point()];
    commands.push({type: 'Q', x1: a.x, y1: a.y, x: c.x, y: c.y});
  }
  commands.push({type: 'Z'});
  return commands;
}

/** One document of roughly `size` layers (seeded). */
export function layoutDocument(seed: number, size = 10 + (seed % 60)): DesignDocument {
  const r = rng(seed * 7919 + 17);
  const doc = createDocument('page');
  let n = 0;
  const containers: NodeId[] = ['page'];
  const depth = new Map<NodeId, number>([['page', 0]]);
  const add = (type: NodeType, parentId: NodeId) => {
    const id = `n${++n}`;
    const width = type === 'TEXT' ? num(r, 200) : num(r, 400);
    const height = type === 'LINE' ? 0 : type === 'TEXT' ? num(r, 60) : num(r, 300);
    const props: Partial<SceneNode> & {id: NodeId} = {
      id,
      parentId,
      x: Math.round((r.next() * 600 - 100) * 100) / 100,
      y: Math.round((r.next() * 600 - 100) * 100) / 100,
      width,
      height,
      rotation: rotation(r),
      visible: !r.chance(0.08),
      strokes: strokes(r),
      strokeWeight: r.pick([1, 2, 0.5, 4, 0]),
      strokeAlign: r.pick(['INSIDE', 'CENTER', 'OUTSIDE'] as const),
      constraints: {horizontal: r.pick(CONSTRAINTS), vertical: r.pick(CONSTRAINTS)},
      layoutPositioning: r.chance(0.1) ? 'ABSOLUTE' : 'AUTO',
      layoutSizingHorizontal: r.pick(SIZINGS),
      layoutSizingVertical: r.pick(SIZINGS),
    };
    if (r.chance(0.1)) props.flipX = true;
    if (r.chance(0.1)) props.flipY = true;
    if (r.chance(0.15)) props.individualStrokeWeights = {top: num(r, 4), right: num(r, 4), bottom: num(r, 4), left: num(r, 4)};
    if (r.chance(0.2)) props.minWidth = r.chance(0.2) ? null : num(r, 200);
    if (r.chance(0.2)) props.maxWidth = r.chance(0.2) ? null : num(r, 300);
    if (r.chance(0.2)) props.minHeight = r.chance(0.2) ? null : num(r, 150);
    if (r.chance(0.2)) props.maxHeight = r.chance(0.2) ? null : num(r, 200);
    if (type === 'TEXT') {
      props.text = text(r);
      if (r.chance(0.05)) props.textPath = {commands: paths(r, Math.max(width, 10), Math.max(height, 10)), startOffset: 0, side: 'LEFT'};
    }
    if (type === 'VECTOR') props.vectorPaths = r.chance(0.2) ? [] : [{windingRule: 'NONZERO', commands: paths(r, width, height)}];
    if (type === 'FRAME' || type === 'COMPONENT') {
      props.autoLayout = autoLayout(r);
      if (props.autoLayout.layoutMode === 'GRID' && !r.chance(0.1)) props.grid = gridLayout(r);
    }
    if (doc.nodes[parentId].autoLayout?.layoutMode === 'GRID' ? r.chance(0.7) : r.chance(0.05)) props.gridChild = gridChild(r);
    const node = createNode(type, props);
    doc.nodes[id] = node;
    doc.nodes[parentId].children!.push(id);
    if (node.children) {
      containers.push(id);
      depth.set(id, depth.get(parentId)! + 1);
    }
    return id;
  };
  const types: NodeType[] = ['FRAME', 'FRAME', 'FRAME', 'TEXT', 'TEXT', 'TEXT', 'RECTANGLE', 'RECTANGLE', 'ELLIPSE', 'LINE', 'VECTOR', 'GROUP', 'BOOLEAN_OPERATION', 'SECTION', 'STAR'];
  for (let i = 0; i < size; i++) {
    const open = containers.filter(id => depth.get(id)! < 6 && (doc.nodes[id].type !== 'SECTION' || r.chance(0.5)));
    // Recent containers first: deep trees.
    const parent = r.chance(0.6) ? open[Math.max(0, open.length - 1 - r.int(3))] : r.pick(open);
    let type = r.pick(types);
    if (parent === 'page' && r.chance(0.5)) type = 'FRAME';
    const id = add(type, parent);
    // Groups never start empty (a document with an empty group is invalid): they are made around layers.
    if (type === 'GROUP' || type === 'BOOLEAN_OPERATION') {
      for (let k = 1 + r.int(3); k > 0; k--) {
        const inner = add(r.pick(['RECTANGLE', 'TEXT', 'ELLIPSE', 'FRAME', 'GROUP'] as const), id);
        if (doc.nodes[inner].type === 'GROUP') add(r.pick(['RECTANGLE', 'TEXT'] as const), inner);
      }
    }
  }
  return doc;
}

/** The document a transaction leaves after deleting a subtree: the node and its descendants gone, its parent's
 *  children list without it (a group may be left empty: group fitting removes it). Returns the dirty ids the
 *  transaction reports: the removed node and its former parent. Not validated: normalize sees such tables mid-way. */
export function withDeletion(doc: DesignDocument, seed: number): {doc: DesignDocument; dirty: string[]} | null {
  const r = rng(seed * 31337 + 5);
  const ids = Object.keys(doc.nodes).filter(id => doc.nodes[id].parentId);
  if (!ids.length) return null;
  // Prefer a group's only child, so empty groups occur.
  const lone = ids.filter(id => {
    const parent = doc.nodes[doc.nodes[id].parentId!];
    return (parent.type === 'GROUP' || parent.type === 'BOOLEAN_OPERATION') && parent.children!.length === 1;
  });
  const id = lone.length && r.chance(0.7) ? r.pick(lone) : r.pick(ids);
  const nodes = {...doc.nodes};
  const drop = (nodeId: string) => {
    for (const child of nodes[nodeId]?.children ?? []) drop(child);
    delete nodes[nodeId];
  };
  const parentId = doc.nodes[id].parentId!;
  drop(id);
  nodes[parentId] = {...nodes[parentId], children: nodes[parentId].children!.filter(child => child !== id)};
  return {doc: {...doc, nodes}, dirty: [id, parentId]};
}

/** The document after a transaction edited a few layers (moved, resized, resized by sizing, retyped, relaid): the
 *  edited ids are the dirty set, as a transaction reports them. Each node is replaced, never mutated. */
export function withEdits(doc: DesignDocument, seed: number, count = 1 + (seed % 4)): {doc: DesignDocument; dirty: string[]} {
  const r = rng(seed * 7727 + 11);
  const ids = Object.keys(doc.nodes).filter(id => doc.nodes[id].type !== 'PAGE');
  const nodes = {...doc.nodes};
  const dirty: string[] = [];
  for (let k = 0; k < count && ids.length; k++) {
    const id = r.pick(ids);
    const node = {...nodes[id]};
    switch (r.int(7)) {
      case 0: node.x += r.int(50) - 25; node.y += (r.int(50) - 25) / 4; break;
      case 1: node.width = Math.max(0, node.width + r.int(120) - 60 + 0.25); if (node.type !== 'LINE') node.height = Math.max(0, node.height + r.int(80) - 40); break;
      case 2: node.layoutSizingHorizontal = r.pick(SIZINGS); node.layoutSizingVertical = r.pick(SIZINGS); break;
      case 3: if (node.text) node.text = {...node.text, characters: node.text.characters + r.pick([' more', 'x', '\nsecond line', ''])}; else node.visible = !node.visible; break;
      case 4: if (node.autoLayout) node.autoLayout = {...node.autoLayout, itemSpacing: node.autoLayout.itemSpacing + r.int(9) - 4, paddingLeft: node.autoLayout.paddingLeft + r.int(5)}; else node.rotation = r.pick([0, 90, 15]); break;
      case 5:
        if (node.grid && r.chance(0.6)) node.grid = {...node.grid, columnCount: 1 + r.int(4), rowGap: node.grid.rowGap + r.int(5), columnSizes: node.grid.columnSizes.length ? node.grid.columnSizes.slice(1) : [{type: 'FIXED', value: 40}]};
        else if (node.gridChild && r.chance(0.6)) node.gridChild = {...node.gridChild, columnSpan: 1 + r.int(3), rowAnchorIndex: r.int(3), columnAnchorIndex: r.int(3)};
        else node.layoutPositioning = node.layoutPositioning === 'ABSOLUTE' ? 'AUTO' : 'ABSOLUTE';
        break;
      default: if (node.text) node.text = {...node.text, textAutoResize: r.pick(['WIDTH_AND_HEIGHT', 'HEIGHT', 'NONE', 'TRUNCATE'] as const)}; else node.minWidth = r.chance(0.5) ? null : r.int(200);
    }
    nodes[id] = node;
    dirty.push(id);
  }
  return {doc: {...doc, nodes}, dirty};
}

/** Random dirty sets for a document: one to a handful of ids, sometimes everything, sometimes an id that is gone. */
export function dirtySets(doc: DesignDocument, seed: number, count: number): string[][] {
  const r = rng(seed * 104729 + 3);
  const ids = Object.keys(doc.nodes);
  const sets: string[][] = [];
  for (let i = 0; i < count; i++) {
    if (i === 0) {
      sets.push(ids);
      continue;
    }
    const set = new Set<string>();
    for (let k = 1 + r.int(r.chance(0.2) ? 12 : 4); k > 0; k--) set.add(r.pick(ids));
    if (r.chance(0.05)) set.add('gone');
    sets.push([...set]);
  }
  return sets;
}
