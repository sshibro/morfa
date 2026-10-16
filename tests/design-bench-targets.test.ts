import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {renderTargetsMarkdown} from '../scripts/bench/targets-md';
import {ROOT, formatActual, loadTargets, metricState, parseOnly, rowState} from '../scripts/bench/lib/targets';
import {Histogram} from '../scripts/bench/lib/histogram';
import {percentile, spread} from '../scripts/bench/lib/stats';
import {difference, parsePrometheus, quantile} from '../scripts/bench/lib/prometheus';
import {pageFile, STANDARD_FILES} from '../scripts/bench/gen-file';
import {heavyPage} from './helpers/design-big-files';
import {mergeRuns} from '../scripts/bench/targets';

// The bench harness of lane B0 (scripts/bench): one source for the numbers of docs/TARGETS.md, how a row is judged, the
// histograms the server and loadgen share, and the bench files' determinism.

const targets = loadTargets();
const row = (id: string) => targets.rows.find(r => r.id === id)!;

test('targets.json writes the tables of docs/TARGETS.md byte for byte', () => {
  const file = readFileSync(path.join(ROOT, 'docs/TARGETS.md'), 'utf8');
  assert.equal(renderTargetsMarkdown(file, targets), file);
});

test('targets.json holds every row of TARGETS.md once, with machine-readable metrics', () => {
  const ids = targets.rows.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 63);
  for (const r of targets.rows) assert.ok(r.metrics.length > 0, r.id);
});

test('a metric is green at its target, yellow up to its ceiling, red past it', () => {
  const fps = row('C1').metrics[0], p99 = row('C1').metrics[1];
  assert.equal(metricState(fps, 60), 'green');
  assert.equal(metricState(fps, 57), 'yellow');
  assert.equal(metricState(fps, 54), 'red');
  assert.equal(metricState(p99, 16.7), 'green');
  assert.equal(metricState(p99, 25), 'yellow');
  assert.equal(metricState(p99, 26), 'red');
  assert.equal(metricState(p99, undefined), 'n.a.');
  assert.equal(metricState(p99, Infinity), 'red', 'a thing that never happened is past every ceiling');
});

test('a row is its worst measured metric; n.a. when nothing was measured; rule rows pass or fail', () => {
  assert.equal(rowState(row('C1'), {id: 'C1', values: {fps: 60, frameP99: 30}}), 'red');
  assert.equal(rowState(row('C1'), {id: 'C1', values: {fps: 58}}), 'yellow');
  assert.equal(rowState(row('C1'), {id: 'C1', na: 'renderer'}), 'n.a.');
  assert.equal(rowState(row('M9'), {id: 'M9', pass: false}), 'red');
  assert.equal(rowState(row('D3'), {id: 'D3', pass: true}), 'green');
  assert.equal(formatActual(row('C1'), {id: 'C1', values: {fps: 59.5, frameP99: 18.25}}), '59.5 fps / 18.3 ms');
});

test('--only takes section letters and row ids', () => {
  assert.deepEqual(parseOnly('M1,M1b', targets.rows).map(r => r.id), ['M1', 'M1b']);
  assert.equal(parseOnly('C', targets.rows).length, 12);
  assert.equal(parseOnly(undefined, targets.rows).length, 63);
});

test('runs merge to the median of each metric and keep their spread', () => {
  const merged = mergeRuns(row('C1'), [{id: 'C1', values: {fps: 58, frameP99: 17}}, {id: 'C1', values: {fps: 60, frameP99: 16}}, {id: 'C1', values: {fps: 59, frameP99: 20}}]);
  assert.deepEqual(merged.values, {fps: 59, frameP99: 17});
  assert.ok(Math.abs(merged.spread.frameP99 - 4 / 17) < 1e-9);
  // Nearest-rank median of two runs is the lower one.
  assert.equal(spread([10, 12]), 2 / 10);
});

test('the log-bucket histogram reads percentiles within 1 %', () => {
  const histogram = new Histogram();
  const values: number[] = [];
  for (let i = 1; i <= 2000; i++) {
    histogram.record(i / 10);
    values.push(i / 10);
  }
  for (const p of [50, 95, 99]) {
    const exact = percentile(values, p);
    assert.ok(Math.abs(histogram.percentile(p) - exact) / exact < 0.011, `p${p}`);
  }
  const copy = Histogram.from(JSON.parse(JSON.stringify(histogram.toJSON())));
  assert.equal(copy.percentile(95), histogram.percentile(95));
});

test('Prometheus histograms are differenced between scrapes and interpolated', () => {
  const text = (a: number, b: number, c: number) => `# TYPE x histogram\nx_bucket{le="0.001"} ${a}\nx_bucket{le="0.01"} ${b}\nx_bucket{le="+Inf"} ${c}\nx_count ${c}\nx_sum 1\n`;
  const before = parsePrometheus(text(10, 10, 10)).histograms.get('x')!;
  const after = parsePrometheus(text(10, 110, 110)).histograms.get('x')!;
  const window = difference(after, before);
  assert.equal(window.count, 100);
  assert.ok(Math.abs(quantile(window, 50) - 0.0055) < 1e-9);
});

test('gen-file: f20k with seed 0 is tests/helpers/design-big-files.ts heavyPage byte for byte; another seed differs', () => {
  assert.equal(STANDARD_FILES.f20k.layers, 20_041);
  assert.equal(JSON.stringify(pageFile(20_041, 0)), JSON.stringify(heavyPage()));
  const seeded = pageFile(2_000, 7);
  assert.equal(JSON.stringify(pageFile(2_000, 7)), JSON.stringify(seeded));
  assert.notEqual(JSON.stringify(seeded), JSON.stringify(pageFile(2_000, 0)));
  assert.equal(Object.keys(seeded.nodes).length, 2_005);
});
