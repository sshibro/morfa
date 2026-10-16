import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, test} from 'node:test';
import {LIVE_AREA_TOLERANCE, booleanGeometry, booleanGeometryExact, combinePaths, combinePathsLive, flattenBoolean, liveAreaDifference} from '../shared/design/boolean';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {EngineDiffError, engineCallTable, firstDifference, resetEngineCalls, setEngine} from '../shared/design/engine-switch';
import {toVector} from '../shared/design/flatten';
import {localMatrix} from '../shared/design/geometry';
import {geometryWasm} from '../shared/design/geometry-wasm';
import {outlineStrokeNode} from '../shared/design/outline-stroke';
import {transformPaths} from '../shared/design/paths';
import {nodeGeometry} from '../shared/design/shapes';
import {exportSvg} from '../shared/design/svg-export';
import type {DesignDocument, NodeType, SceneNode, VectorPath} from '../shared/design/types';
import {testMeasurer} from './helpers/design-big-files';

// Booleans the editor draws live go through the Rust
// side's faster overlay (`combinePathsLive`), compared with TypeScript by area; anything written (flatten, outline
// stroke, SVG export) keeps polygon-clipping on both sides (`combinePaths`), the same bytes on every engine.
// Needs the nodejs build of the geometry module (scripts/wasm-geometry-build.sh).

const restore: (() => void)[] = [];
const use = (mode: 'ts' | 'wasm' | 'both') => restore.push(setEngine('geometry', mode));
beforeEach(() => resetEngineCalls());
afterEach(() => {
  while (restore.length) restore.pop()!();
  geometryWasm().debugFault('');
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` overlapping rotated shapes (rounded rectangles, ellipses and rings, stars, polygons) as nodes. */
function shapes(seed: number, count: number, parentId = 'page'): SceneNode[] {
  const r = mulberry32(seed);
  const types: NodeType[] = ['RECTANGLE', 'ELLIPSE', 'STAR', 'POLYGON'];
  return Array.from({length: count}, (_, k) => {
    const kind = Math.floor(r() * 4);
    return createNode(types[kind] as 'RECTANGLE', {
      id: `s${k}`, parentId, x: r() * 400, y: r() * 400, width: 20 + r() * 160, height: 20 + r() * 160, rotation: r() * 360 - 180,
      cornerRadius: kind === 0 ? r() * 30 : undefined, pointCount: kind >= 2 ? 3 + Math.floor(r() * 6) : undefined,
      arcData: kind === 1 && r() < 0.3 ? {startingAngle: 0, endingAngle: 2 * Math.PI, innerRadius: 0.5} : undefined,
    });
  });
}
const operandsOf = (nodes: SceneNode[]): VectorPath[][] => nodes.map(node => transformPaths(nodeGeometry(node), localMatrix(node)));

/** A page with one boolean of `count` shapes (fresh node objects, so no cache answers). */
function booleanDocument(count: number, operation: 'UNION' | 'SUBTRACT' = 'UNION'): DesignDocument {
  const doc = createDocument('page');
  const add = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  };
  add(createNode('BOOLEAN_OPERATION', {id: 'b', parentId: 'page', x: 0, y: 0, width: 600, height: 600, booleanOperation: operation, fills: [solid({r: 0, g: 0, b: 0})], strokes: [solid({r: 1, g: 0, b: 0})], strokeWeight: 2}));
  for (const node of shapes(3, count, 'b')) add(node);
  return doc;
}

const withoutIds = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, v) => (key === 'id' || key.endsWith('Id') || key === 'children' ? undefined : v)) ?? 'null');
const calls = (name: string) => engineCallTable()[`geometry.${name}`];

describe('live booleans by area, writes exact', () => {
  // New intersections sit on the overlay's grid (≈ 5e-7 of a unit here): the difference is a few grid steps along
  // the edges, ~1e-9 of the area on large unions and up to ~2e-8 on a small SUBTRACT; the switch allows 1e-6.
  test('live and exact answers cover the same area (to 1e-7) with other vertices', () => {
    use('wasm');
    for (const operation of ['UNION', 'SUBTRACT'] as const) {
      for (const count of [2, 12, 60]) {
        const operands = operandsOf(shapes(count * 7 + 1, count));
        const exact = combinePaths(operation, operands, 0.01);
        const live = combinePathsLive(operation, operands, 0.01);
        const d = liveAreaDifference(exact, live, 0.01);
        assert.ok(d.symmetric <= 1e-7 * d.boxArea, `${operation} of ${count}: symmetric difference ${d.symmetric} of a box of ${d.boxArea}`);
        assert.ok(Math.abs(d.areaA - d.areaB) <= 1e-7 * Math.abs(d.areaA), `${operation} of ${count}: areas ${d.areaA} vs ${d.areaB}`);
        if (count === 60) assert.notEqual(firstDifference(exact, live, 1e-9), null, 'the live answer has its own vertex lists');
      }
    }
  });

  test('both mode compares combinePathsLive by area and finds no difference', () => {
    use('both');
    combinePathsLive('UNION', operandsOf(shapes(11, 40)), 0.01);
    combinePathsLive('SUBTRACT', operandsOf(shapes(12, 20)), 0.01);
    assert.equal(calls('combinePathsLive')?.both, 2);
    assert.equal(calls('combinePathsLive')?.diffs ?? 0, 0);
  });

  test('fake green: a wrong live answer fails both mode', () => {
    use('both');
    geometryWasm().debugFault('geometry.combinePathsLive');
    // One vertex moved by a unit is far past 1e-6 of a 30 × 30 union's box.
    const small = operandsOf(shapes(5, 3)).map(paths => transformPaths(paths, [[0.1, 0, 0], [0, 0.1, 0]]));
    assert.throws(() => combinePathsLive('UNION', small, 0.01), (error: unknown) => error instanceof EngineDiffError && error.call === 'combinePathsLive');
  });

  test('drawing reads the live path; flatten, outline stroke and SVG export read the exact one', () => {
    use('wasm');
    // The SVG export's TypeScript side (the Rust export module computes booleans with the exact combine_paths too).
    restore.push(setEngine('export', 'ts'));
    booleanGeometry(booleanDocument(30), 'b');
    assert.equal(calls('combinePathsLive')?.wasm, 1);
    assert.equal(calls('combinePaths'), undefined);

    for (const write of [
      (doc: DesignDocument) => flattenBoolean(doc, 'b'),
      (doc: DesignDocument) => toVector(doc, ['b']),
      (doc: DesignDocument) => outlineStrokeNode(doc, 'b'),
      (doc: DesignDocument) => exportSvg(doc, ['b'], {measurer: testMeasurer}),
      (doc: DesignDocument) => booleanGeometryExact(doc, 'b'),
    ]) {
      resetEngineCalls();
      const wasm = write(booleanDocument(30));
      assert.equal(calls('combinePathsLive'), undefined, `${write}: no live call`);
      assert.ok(calls('combinePaths')?.wasm, `${write}: the exact call ran in wasm`);
      // TypeScript's polygon-clipping answer (to the switch's 1e-9: L1 notes V8's sin/cos may differ in the last
      // place on the Mac); new node ids differ per run, so they are left out.
      use('ts');
      const ts = write(booleanDocument(30));
      restore.pop()!();
      assert.equal(firstDifference(withoutIds(wasm), withoutIds(ts), 1e-9), null, `${write}: wasm writes TypeScript's answer`);
    }
  });

  test('the live check bound is 1e-6 of the box', () => assert.equal(LIVE_AREA_TOLERANCE, 1e-6));
});
