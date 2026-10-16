// Lane L1: seeded random documents for the geometry differential harness (diff.ts), until S2's design-fuzz.ts
// lands. Every node type, every outline parameter (radii per corner, smoothing, arcs and rings, polygon and star
// corners), vector paths from random SVG path data (relative and absolute, H/V/S/T/A, several subpaths, open
// and closed), strokes (weights, aligns, caps, joins, dashes, markers, per-side weights), booleans of shapes and
// nested booleans, groups, clipping frames, masks, hidden and locked layers, rotations and flips.

import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../../shared/design/defaults';
import type {BooleanOperation, DesignDocument, NodeId, NodeType, PathCommand, SceneNode, StrokeMarker} from '../../shared/design/types';

export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = ReturnType<typeof mulberry32>;
const pick = <T,>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)];
const range = (r: Rng, lo: number, hi: number) => lo + r() * (hi - lo);
const chance = (r: Rng, p: number) => r() < p;
/** A coordinate: mostly ordinary, sometimes grid-snapped (coincident edges), sometimes large or tiny. */
function coordOf(r: Rng, scale: number, wild = true): number {
  const k = r();
  if (k < 0.3) return Math.round(range(r, -scale, scale) / 10) * 10;
  if (k < 0.31) return wild ? range(r, -1e5, 1e5) : range(r, -scale, scale);
  if (k < 0.35) return range(r, -scale, scale);
  if (k < 0.4) return range(r, -1, 1) * 1e-3;
  return range(r, -scale, scale);
}
let wildDefault = true;
/** Off: no coordinate far out (±1e5) anywhere, for checks too slow in TS on 10⁵-px dashed strokes. */
export const setWild = (on: boolean) => { wildDefault = on; };
const coord = (r: Rng, scale: number) => coordOf(r, scale, wildDefault);
const num = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(3));

/** Random SVG path data: the full grammar, relative and absolute. `wild`: some coordinates far out (±1e5). */
export function randomPathData(r: Rng, scale = 200, wild = wildDefault): string {
  const coord = (rr: Rng, s: number) => coordOf(rr, s, wild);
  const parts: string[] = [];
  const subpaths = 1 + Math.floor(r() * 3);
  for (let s = 0; s < subpaths; s++) {
    parts.push(`${chance(r, 0.3) ? 'm' : 'M'}${num(coord(r, scale))} ${num(coord(r, scale))}`);
    const count = 1 + Math.floor(r() * 8);
    for (let k = 0; k < count; k++) {
      const rel = chance(r, 0.4);
      const c = (l: string) => (rel ? l.toLowerCase() : l);
      const p = () => `${num(coord(r, rel ? scale / 3 : scale))} ${num(coord(r, rel ? scale / 3 : scale))}`;
      switch (pick(r, ['L', 'H', 'V', 'C', 'S', 'Q', 'T', 'A', 'L', 'C'] as const)) {
        case 'L': parts.push(`${c('L')}${p()}`); break;
        case 'H': parts.push(`${c('H')}${num(coord(r, scale))}`); break;
        case 'V': parts.push(`${c('V')}${num(coord(r, scale))}`); break;
        case 'C': parts.push(`${c('C')}${p()} ${p()} ${p()}`); break;
        case 'S': parts.push(`${c('S')}${p()} ${p()}`); break;
        case 'Q': parts.push(`${c('Q')}${p()} ${p()}`); break;
        case 'T': parts.push(`${c('T')}${p()}`); break;
        case 'A': parts.push(`${c('A')}${num(range(r, 0, scale / 2))} ${num(range(r, 0, scale / 2))} ${num(range(r, -180, 180))} ${chance(r, 0.5) ? 1 : 0} ${chance(r, 0.5) ? 1 : 0} ${p()}`); break;
      }
    }
    if (chance(r, 0.6)) parts.push(chance(r, 0.5) ? 'Z' : 'z');
  }
  return parts.join(chance(r, 0.5) ? ' ' : '');
}

const MARKERS: StrokeMarker[] = ['NONE', 'NONE', 'NONE', 'LINE_ARROW', 'TRIANGLE_ARROW', 'REVERSED_TRIANGLE', 'CIRCLE', 'DIAMOND', 'ROUND', 'SQUARE'];

function strokeProps(r: Rng): Partial<SceneNode> {
  if (chance(r, 0.35)) return {};
  const props: Partial<SceneNode> = {
    strokes: [solid({r: 0, g: 0, b: 0})],
    strokeWeight: pick(r, [0.5, 1, 2, 4, 8, 13.5, 30]),
    strokeAlign: pick(r, ['CENTER', 'INSIDE', 'OUTSIDE'] as const),
    strokeCap: pick(r, ['NONE', 'ROUND', 'SQUARE'] as const),
    strokeJoin: pick(r, ['MITER', 'BEVEL', 'ROUND'] as const),
    strokeMiterLimit: pick(r, [1, 2, 4, 10]),
    dashPattern: chance(r, 0.3) ? Array.from({length: 1 + Math.floor(r() * 4)}, () => pick(r, [0, 1, 3, 5, 10, 20])) : [],
  };
  return props;
}

function shapeNode(r: Rng, id: NodeId, parentId: NodeId, scale: number): SceneNode {
  const type = pick(r, ['RECTANGLE', 'RECTANGLE', 'ELLIPSE', 'ELLIPSE', 'POLYGON', 'STAR', 'LINE', 'VECTOR', 'VECTOR'] as NodeType[]);
  const width = chance(r, 0.05) ? 0 : Math.abs(range(r, 1, scale));
  const height = type === 'LINE' ? 0 : chance(r, 0.05) ? 0 : Math.abs(range(r, 1, scale));
  const props: Partial<SceneNode> & {id: NodeId} = {
    id, parentId, x: coord(r, scale), y: coord(r, scale), width, height,
    rotation: chance(r, 0.4) ? pick(r, [0, 90, -90, 180, 45, range(r, -180, 180)]) : 0,
    ...(chance(r, 0.15) ? {flipX: true} : {}), ...(chance(r, 0.15) ? {flipY: true} : {}),
    visible: !chance(r, 0.05), locked: chance(r, 0.05),
    fills: chance(r, 0.2) ? [] : [solid({r: 0.5, g: 0.5, b: 0.5})],
    ...strokeProps(r),
  };
  switch (type) {
    case 'RECTANGLE':
      if (chance(r, 0.5)) props.cornerRadius = pick(r, [0, 4, 10, range(r, 0, scale)]);
      if (chance(r, 0.3)) props.rectangleCornerRadii = [0, 1, 2, 3].map(() => pick(r, [0, 5, 20, range(r, 0, scale)])) as [number, number, number, number];
      if (chance(r, 0.3)) props.cornerSmoothing = pick(r, [0.6, 1, range(r, 0, 1)]);
      if (chance(r, 0.15)) props.individualStrokeWeights = {top: pick(r, [0, 1, 4]), right: pick(r, [0, 2, 8]), bottom: pick(r, [1, 3]), left: pick(r, [0, 6])};
      break;
    case 'ELLIPSE':
      if (chance(r, 0.4)) {
        const start = range(r, -Math.PI, Math.PI);
        props.arcData = {startingAngle: start, endingAngle: start + pick(r, [Math.PI / 2, Math.PI, range(r, -2 * Math.PI, 2 * Math.PI), 2 * Math.PI]), innerRadius: pick(r, [0, 0.5, range(r, 0, 1)])};
      }
      break;
    case 'POLYGON':
      props.pointCount = pick(r, [3, 5, 6, 12]);
      if (chance(r, 0.4)) props.cornerRadius = pick(r, [2, 10, range(r, 0, scale)]);
      break;
    case 'STAR':
      props.pointCount = pick(r, [3, 5, 8]);
      props.innerRadius = pick(r, [0.382, 0.2, 0.8, range(r, 0, 1)]);
      if (chance(r, 0.4)) props.cornerRadius = pick(r, [2, 10, range(r, 0, scale)]);
      break;
    case 'LINE':
    case 'VECTOR':
      props.strokeStartMarker = pick(r, MARKERS);
      props.strokeEndMarker = pick(r, MARKERS);
      if (type === 'VECTOR') {
        props.vectorPaths = [{windingRule: chance(r, 0.4) ? 'EVENODD' : 'NONZERO', commands: []}];
        // Not a model field (the type check refuses it); kept on the node as the lane's seeds were recorded with it.
        (props as Record<string, unknown>).vectorPathData = randomPathData(r, scale);
      }
      break;
  }
  return createNode(type, props);
}

/** A random document; `parsePathData` fills vector paths so both engines read the same commands. */
export function randomDocument(seed: number, parse: (d: string) => PathCommand[]): DesignDocument {
  const r = mulberry32(seed);
  const doc = createDocument('page');
  let n = 0;
  const scale = pick(r, [50, 200, 1000]);
  const add = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    doc.nodes[node.parentId!].children!.push(node.id);
    const d = (node as {vectorPathData?: string}).vectorPathData;
    if (d !== undefined) {
      delete (node as {vectorPathData?: string}).vectorPathData;
      node.vectorPaths = [{windingRule: node.vectorPaths![0].windingRule, commands: parse(d)}];
    }
    return node.id;
  };
  const fill = (parentId: NodeId, depth: number, count: number) => {
    for (let k = 0; k < count; k++) {
      const kind = r();
      const id = `n${++n}`;
      const base = {id, parentId, x: coord(r, scale), y: coord(r, scale), width: Math.abs(range(r, 10, scale)), height: Math.abs(range(r, 10, scale)),
        rotation: chance(r, 0.3) ? range(r, -180, 180) : 0, visible: !chance(r, 0.05), locked: chance(r, 0.04)};
      if (depth < 3 && kind < 0.15) {
        add(createNode('FRAME', {...base, clipsContent: chance(r, 0.7), ...strokeProps(r),
          ...(chance(r, 0.15) ? {autoLayout: {...defaultAutoLayout(pick(r, ['HORIZONTAL', 'VERTICAL'] as const)), itemReverseZIndex: chance(r, 0.5)}} : {})}));
        fill(id, depth + 1, 1 + Math.floor(r() * 4));
      } else if (depth < 3 && kind < 0.25) {
        add(createNode('GROUP', {...base}));
        fill(id, depth + 1, 1 + Math.floor(r() * 4));
      } else if (depth < 3 && kind < 0.37) {
        add(createNode('BOOLEAN_OPERATION', {...base, booleanOperation: pick(r, ['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'] as BooleanOperation[]), ...strokeProps(r)}));
        const operands = 2 + Math.floor(r() * 3);
        for (let j = 0; j < operands; j++) {
          if (depth < 2 && chance(r, 0.15)) {
            const inner = `n${++n}`;
            add(createNode('BOOLEAN_OPERATION', {id: inner, parentId: id, x: coord(r, scale / 4), y: coord(r, scale / 4), width: 10, height: 10, booleanOperation: pick(r, ['UNION', 'SUBTRACT'] as BooleanOperation[])}));
            for (let q = 0; q < 2; q++) add(shapeNode(r, `n${++n}`, inner, scale / 2));
          } else add(shapeNode(r, `n${++n}`, id, scale / 2));
        }
      } else if (kind < 0.42) {
        // Cyrillic on purpose: multi-byte text with a hard line break.
        add(createNode('TEXT', {...base, text: defaultTextProps('Текст\nвторая')}));
      } else if (kind < 0.45) {
        add(createNode('SECTION', {...base}));
        fill(id, depth + 1, 1 + Math.floor(r() * 2));
      } else if (kind < 0.47) {
        add(createNode('SLICE', {...base}));
      } else {
        const shape = shapeNode(r, id, parentId, scale);
        if (chance(r, 0.06)) shape.isMask = true;
        add(shape);
      }
    }
  };
  fill('page', 0, 3 + Math.floor(r() * 10));
  return doc;
}
