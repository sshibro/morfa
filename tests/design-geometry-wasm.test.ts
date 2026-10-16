import assert from 'node:assert/strict';
import {afterEach, beforeEach, describe, test} from 'node:test';
import type {MultiPolygon} from 'polygon-clipping';
import {areaToPaths, combineAreas, combinePaths, fillArea} from '../shared/design/boolean';
import {EngineDiffError, assertWasmRan, engineCallTable, engineCalls, engineTolerance, firstDifference, resetEngineCalls, setEngine} from '../shared/design/engine-switch';
import {geometryWasm, setGeometryWasm} from '../shared/design/geometry-wasm';
import {dashPolylines, polygonsToSmoothPaths, strokeArea, type StrokeStyle} from '../shared/design/outline-stroke';
import {ellipsePaths, rectanglePath} from '../shared/design/shapes';
import type {VectorPath} from '../shared/design/types';

// Lane L1's geometry module (crates/geometry-wasm) behind the engine switch: booleans and the outline stroke in
// `wasm` and `both`, the counters, a wrong module caught (fake green) and the fallback while the browser has not
// installed the module. Needs the nodejs build (scripts/wasm-geometry-build.sh).

const restore: (() => void)[] = [];
const use = (mode: 'ts' | 'wasm' | 'both') => restore.push(setEngine('geometry', mode));
beforeEach(() => resetEngineCalls());
afterEach(() => {
  while (restore.length) restore.pop()!();
  geometryWasm().debugFault('');
});

const moved = (paths: VectorPath[], dx: number, dy: number): VectorPath[] =>
  paths.map(path => ({...path, commands: path.commands.map(c => (c.type === 'Z' ? c : c.type === 'C' ? {...c, x1: c.x1 + dx, y1: c.y1 + dy, x2: c.x2 + dx, y2: c.y2 + dy, x: c.x + dx, y: c.y + dy} : c.type === 'Q' ? {...c, x1: c.x1 + dx, y1: c.y1 + dy, x: c.x + dx, y: c.y + dy} : {...c, x: c.x + dx, y: c.y + dy}))}));
const square: VectorPath[] = [{windingRule: 'NONZERO', commands: rectanglePath(100, 100, [12, 0, 30, 4])}];
const circle: VectorPath[] = moved(ellipsePaths(90, 90), 50, 40);
const style: StrokeStyle = {weight: 6, align: 'CENTER', cap: 'ROUND', join: 'MITER', miterLimit: 4, dashPattern: [14, 6]};

/** Every wired entry once, with curves, holes and dashes. */
function exercise() {
  const operations = ['UNION', 'SUBTRACT', 'INTERSECT', 'EXCLUDE'] as const;
  const paths = operations.map(operation => combinePaths(operation, [square, circle], 0.01));
  const area: MultiPolygon = fillArea([...square, ...circle], 0.02);
  const combined = combineAreas('SUBTRACT', [fillArea(square, 0.02), fillArea(circle, 0.02)]);
  const back = areaToPaths(combined);
  const stroke = strokeArea([...circle, {windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'C', x1: 40, y1: -30, x2: 80, y2: 60, x: 120, y: 10}]}], style, {endMarker: 'TRIANGLE_ARROW'});
  const smooth = polygonsToSmoothPaths(stroke, 0.02);
  const dashed = dashPolylines([{points: [{x: 0, y: 0}, {x: 100, y: 0}, {x: 100, y: 80}], closed: false}], [10, 5, 2]);
  return {paths, area, combined, back, stroke, smooth, dashed};
}

describe('booleans and outline stroke through the geometry module', () => {
  test('both mode compares every entry and finds no difference', () => {
    use('both');
    exercise();
    const calls = assertWasmRan('geometry');
    assert.equal(calls.diffs, 0);
    const table = engineCallTable();
    for (const call of ['fillArea', 'combineAreas', 'areaToPaths', 'combinePaths', 'strokeArea', 'polygonsToSmoothPaths', 'dashPolylines'])
      assert.ok(table[`geometry.${call}`]?.both, `geometry.${call} compared: ${JSON.stringify(table[`geometry.${call}`])}`);
  });

  // Within the switch's geometry tolerance, not to the bit: lane L1 matched V8's sin/cos bit for bit in its Linux
  // container, while Node 22 on the arm64 Mac differs in the last place for some arguments (round caps and joins).
  test('wasm mode answers alone, the same answers as TypeScript', () => {
    use('wasm');
    const wasm = exercise();
    const counts = engineCalls('geometry');
    assert.equal(counts.ts, 0, JSON.stringify(counts));
    assert.ok(counts.wasm >= 10);
    use('ts');
    assert.equal(firstDifference(exercise(), wasm, engineTolerance('geometry')), null);
  });

  test('a TypeScript body calls the module once: combinePaths does not compare its inner combineAreas', () => {
    use('both');
    combinePaths('UNION', [square, circle], 0.01);
    const table = engineCallTable();
    assert.equal(table['geometry.combinePaths']?.both, 1);
    assert.equal(table['geometry.combineAreas'], undefined);
  });

  test('fake green: a wrong boolean fails both mode with the path', () => {
    use('both');
    geometryWasm().debugFault('geometry.combinePaths');
    assert.throws(
      () => combinePaths('UNION', [square, circle], 0.01),
      (error: unknown) => error instanceof EngineDiffError && error.module === 'geometry' && error.call === 'combinePaths' && error.path === '[0].commands[0].x',
    );
    assert.equal(engineCalls('geometry').diffs, 1);
  });

  test('fake green: a wrong stroke area fails both mode', () => {
    use('both');
    geometryWasm().debugFault('geometry.strokeArea');
    assert.throws(() => strokeArea(circle, style), (error: unknown) => error instanceof EngineDiffError && error.call === 'strokeArea' && error.path === '[0][0][0][0]');
  });

  test('before the module is installed the calls fall back to TypeScript, counted, and never block', () => {
    use('wasm');
    const module = geometryWasm();
    setGeometryWasm(null);
    try {
      const answer = combinePaths('SUBTRACT', [square, circle], 0.01);
      assert.equal(engineCalls('geometry').fallback, 1);
      assert.throws(() => assertWasmRan('geometry'), /made no wasm call/);
      setGeometryWasm(module);
      assert.equal(firstDifference(combinePaths('SUBTRACT', [square, circle], 0.01), answer, engineTolerance('geometry')), null);
      assert.throws(() => assertWasmRan('geometry'), /fell back to TypeScript 1 times/);
    } finally {
      setGeometryWasm(module);
    }
  });

  test('a value the module has no code for falls back instead of guessing', () => {
    use('wasm');
    const odd = {...style, join: 'SPIKY' as never};
    strokeArea(circle, odd);
    assert.equal(engineCalls('geometry').fallback, 1);
  });
});
