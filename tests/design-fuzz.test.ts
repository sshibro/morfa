import test from 'node:test';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import {normalizeDocument} from '../shared/design/normalize';
import {parsePathData} from '../shared/design/paths';
import {validateDocument, validatePatch} from '../shared/design/schema';
import type {DesignDocument} from '../shared/design/types';
import {testMeasurer} from './helpers/design-big-files';
import {
  FEATURES, NODE_TYPES, fuzzCommits, fuzzDocument, fuzzPatch, fuzzPatchPair, fuzzStats, mulberry32, patchPair, randomDocument, randomEdit, randomPathData,
  type FuzzStats,
} from './helpers/design-fuzz';

// The seeded document generator of tests/helpers/design-fuzz.ts: every document passes
// `validateDocument` and is settled, the set covers every node type and feature, a seed gives the same bytes in any call
// order, 20 000 nodes build in seconds, and the patch pairs for the merge tests apply to valid documents.

const SIZES = [60, 120, 300, 600, 1200];
const SEEDS = Array.from({length: 40}, (_, i) => i + 1);
const sizeOf = (seed: number) => SIZES[seed % SIZES.length];

const docs = new Map<number, {doc: DesignDocument; json: string}>();
const generated = (seed: number) => {
  let entry = docs.get(seed);
  if (!entry) {
    const doc = fuzzDocument(seed, {nodes: sizeOf(seed)});
    entry = {doc, json: JSON.stringify(doc)};
    docs.set(seed, entry);
  }
  return entry;
};

/** Valid, and nothing in it is an unknown key the validator would strip. */
function assertValid(doc: DesignDocument, label: string) {
  const json = JSON.stringify(doc);
  const result = validateDocument(JSON.parse(json));
  assert.ok(result.ok, `${label}: ${result.ok ? '' : `${result.error} at ${result.path}`}`);
  assert.ok(JSON.stringify(result.value) === json, `${label}: the validator dropped something`);
}

/** The first node (and fields) that differ, key order aside; null when the documents are equal. */
function firstDifference(a: DesignDocument, b: DesignDocument): string | null {
  for (const id of new Set([...Object.keys(a.nodes), ...Object.keys(b.nodes)])) {
    const x = a.nodes[id], y = b.nodes[id];
    if (isDeepStrictEqual(x, y)) continue;
    if (!x || !y) return `${id} ${x ? 'removed' : 'added'}`;
    const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(key => !isDeepStrictEqual((x as never)[key], (y as never)[key]));
    return `${id} (${x.type}) ${keys.map(key => `${key}: ${JSON.stringify((x as never)[key])} → ${JSON.stringify((y as never)[key])}`).join('; ')}`.slice(0, 600);
  }
  return isDeepStrictEqual({...a, nodes: null}, {...b, nodes: null}) ? null : 'tables';
}

test('every fuzz document passes validateDocument, holds about the asked node count and is settled', () => {
  for (const seed of SEEDS) {
    const {doc, json} = generated(seed);
    assertValid(doc, `seed ${seed}`);
    const count = Object.keys(doc.nodes).length;
    assert.ok(Math.abs(count - sizeOf(seed)) <= sizeOf(seed) * 0.15 + 20, `seed ${seed}: ${count} nodes for ${sizeOf(seed)}`);
    for (const id of Object.keys(doc.nodes)) assert.match(id, /^[A-Za-z]/, `seed ${seed}: id ${id}`);
    // Settled: normalizing again changes no value (it may write a node's keys in another order).
    const difference = firstDifference(doc, normalizeDocument(doc, new Set(Object.keys(doc.nodes)), {measurer: testMeasurer}));
    assert.equal(difference, null, `seed ${seed} is not settled`);
    assert.equal(JSON.stringify(doc), json, `seed ${seed}: normalizing changed the document in place`);
  }
});

test('the set covers every node type and every feature', () => {
  const total: Record<string, number> = {};
  const types: Record<string, number> = {};
  for (const seed of SEEDS) {
    const stats = fuzzStats(generated(seed).doc);
    for (const [type, n] of Object.entries(stats.types)) types[type] = (types[type] ?? 0) + n;
    for (const [key, value] of Object.entries(stats)) if (typeof value === 'number') total[key] = (total[key] ?? 0) + value;
    // Every document of 300 nodes or more carries the headline features itself.
    if (sizeOf(seed) >= 300)
      for (const key of ['instancesWithOverrides', 'componentSets', 'aliases', 'textRuns', 'masks', 'booleans', 'nestedAutoLayout', 'boundNodes'] as const)
        assert.ok(stats[key] > 0, `seed ${seed}: no ${key}`);
  }
  for (const type of NODE_TYPES) assert.ok(types[type] > 0, `no ${type} in the set`);
  const features: (keyof FuzzStats)[] = [
    'autoLayout', 'nestedAutoLayout', 'instancesWithOverrides', 'overriddenCopies', 'instanceProperties', 'nestedInstances', 'componentSets', 'componentProperties',
    'aliases', 'boundNodes', 'boundPaints', 'variableModes', 'textRuns', 'masks', 'booleans', 'nestedBooleans', 'rotated', 'flipped', 'effects', 'gradients', 'images', 'styled',
  ];
  for (const feature of features) assert.ok(total[feature] > 0, `no ${feature} in the set`);
  assert.ok(total.instancesWithOverrides >= 40 && total.componentSets >= 20 && total.masks >= 40, JSON.stringify(total));
});

test('the same seed gives the same bytes in any call order; different seeds differ', () => {
  for (const seed of [...SEEDS].reverse().slice(0, 12)) assert.ok(JSON.stringify(fuzzDocument(seed, {nodes: sizeOf(seed)})) === generated(seed).json, `seed ${seed}: other bytes`);
  const jsons = new Set(SEEDS.map(seed => generated(seed).json));
  assert.equal(jsons.size, SEEDS.length);
  assert.notEqual(JSON.stringify(fuzzDocument(1, {nodes: 300})), JSON.stringify(fuzzDocument(2, {nodes: 300})));
  // Ids carry a seed-derived prefix: two seeds' documents share no layer ids.
  const a = Object.keys(fuzzDocument(3, {nodes: 100}).nodes), b = new Set(Object.keys(fuzzDocument(4, {nodes: 100}).nodes));
  assert.ok(a.every(id => !b.has(id)));
  const r1 = mulberry32(42), r2 = mulberry32(42);
  for (let i = 0; i < 100; i++) assert.equal(r1(), r2());
});

test('features switch off', () => {
  const doc = fuzzDocument(5, {nodes: 200, pages: 3, features: {components: false, variables: false, masks: false, booleans: false}});
  assertValid(doc, 'no components');
  const stats = fuzzStats(doc);
  assert.equal(doc.pages.length, 3);
  assert.equal(stats.types.INSTANCE ?? 0, 0);
  assert.equal(stats.types.COMPONENT ?? 0, 0);
  assert.equal(stats.types.BOOLEAN_OPERATION ?? 0, 0);
  assert.equal(stats.masks, 0);
  assert.equal(Object.keys(doc.variables).length, 0);
  assert.equal(stats.boundNodes + stats.boundPaints, 0);
  const off = Object.fromEntries(FEATURES.map(feature => [feature, false]));
  assertValid(fuzzDocument(6, {nodes: 150, features: off}), 'every feature off');
});

test('20 000 nodes build and validate in seconds', () => {
  const started = performance.now();
  const doc = fuzzDocument(2024, {nodes: 20_000});
  const built = performance.now() - started;
  const count = Object.keys(doc.nodes).length;
  assert.ok(count >= 19_000 && count <= 22_000, `${count} nodes`);
  assert.ok(built < 15_000, `built in ${built.toFixed(0)} ms`);
  const result = validateDocument(doc);
  assert.ok(result.ok, result.ok ? '' : `${result.error} at ${result.path}`);
  const stats = fuzzStats(doc);
  for (const type of NODE_TYPES) assert.ok((stats.types[type] ?? 0) > 0, `no ${type}`);
  assert.ok(stats.instancesWithOverrides > 100 && stats.types.INSTANCE! > 500, JSON.stringify(stats));
});

const touched = (patch: DocumentPatch) => new Set(Object.keys(patch.nodes ?? {}));

test('fuzzPatchPair: two concurrent patches, each valid when applied alone, overlapping and disjoint', () => {
  let overlapping = 0, disjoint = 0;
  const seen = {creates: 0, removes: 0, pages: 0, styles: 0, variables: 0, modes: 0, images: 0, overrides: 0};
  for (const seed of SEEDS) {
    const {doc} = generated(seed);
    const pair = fuzzPatchPair(doc, seed);
    for (const [name, patch, after] of [['a', pair.a, pair.docA], ['b', pair.b, pair.docB]] as const) {
      assert.ok(validatePatch(structuredClone(patch)).ok, `seed ${seed} ${name}: patch shape`);
      const applied = applyPatch(doc, patch);
      assertValid(applied, `seed ${seed} patch ${name}`);
      assert.equal(firstDifference(applied, after), null, `seed ${seed} ${name}: docA/docB`);
      for (const [id, node] of Object.entries(patch.nodes ?? {})) {
        if (node === null) seen.removes++;
        else if (!doc.nodes[id]) seen.creates++;
        else if (node.mainId !== undefined && JSON.stringify(node.overrides) !== JSON.stringify(doc.nodes[id].overrides)) seen.overrides++;
      }
      if (patch.pages) seen.pages++;
      if (patch.styles) seen.styles++;
      if (patch.variables) seen.variables++;
      if (patch.variableModes) seen.modes++;
      if (patch.images) seen.images++;
    }
    const a = touched(pair.a), b = touched(pair.b);
    if ([...a].some(id => b.has(id))) overlapping++;
    if ([...a].some(id => !b.has(id)) && [...b].some(id => !a.has(id))) disjoint++;
    assert.ok(JSON.stringify(fuzzPatchPair(doc, seed).b) === JSON.stringify(pair.b), `seed ${seed}: patches differ between calls`);
  }
  assert.ok(overlapping >= 5 && disjoint >= 20, `overlapping ${overlapping}, disjoint ${disjoint}`);
  for (const [kind, n] of Object.entries(seen)) assert.ok(n > 0, `no ${kind} in the patches`);
});

test('stand-in aliases: randomPathData, randomDocument, randomEdit, patchPair, fuzzCommits', () => {
  const r = mulberry32(9);
  for (let i = 0; i < 50; i++) assert.ok(parsePathData(randomPathData(r)).length > 0);
  const geometry = randomDocument(11, parsePathData);
  assertValid(geometry, 'randomDocument(seed, parse)');
  assert.ok(Object.values(geometry.nodes).some(node => node.type === 'VECTOR' && node.vectorPaths!.some(path => path.commands.length > 0)));
  assert.ok(JSON.stringify(randomDocument(11, parsePathData)) === JSON.stringify(geometry));
  const base = randomDocument(mulberry32(12));
  assertValid(base, 'randomDocument(rng)');
  const edit = randomEdit(base, mulberry32(13));
  assertValid(applyPatch(base, edit.patch), 'randomEdit');
  const {theirs, ours} = patchPair(base, mulberry32(14));
  assertValid(applyPatch(base, theirs.patch), 'patchPair theirs');
  assertValid(applyPatch(base, ours.patch), 'patchPair ours');
  assertValid(applyPatch(base, fuzzPatch(base, 15)), 'fuzzPatch');
  let doc = base;
  for (const step of fuzzCommits(base, 40, 3)) {
    doc = applyPatch(doc, step.patch);
    assert.equal(firstDifference(doc, step.doc), null, `commit ${step.step}`);
  }
  assertValid(doc, 'after 40 commits');
});
