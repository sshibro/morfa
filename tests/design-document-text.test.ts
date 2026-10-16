import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import {DESIGN_TEMPLATES} from '../shared/design/templates';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {documentBytes, documentNodeCount, documentText} from '../server/design/document-text';
import {heavyPage, productFile, testMeasurer} from './helpers/design-big-files';
import {budget} from './helpers/speed';

// The stored text of a design document (server/design/document-text.ts, docs/design-tool.md §Performance): put together from the
// kept text of each entry, it must be byte for byte what JSON.stringify writes, and a save must serialize only the entries it wrote.

const same = (doc: DesignDocument, label: string) => {
  const expected = Buffer.from(JSON.stringify(doc));
  assert.ok(documentText(doc).equals(expected), `${label}: the text is JSON.stringify's`);
  assert.equal(documentBytes(doc), expected.length, `${label}: the size is JSON.stringify's`);
  assert.equal(documentNodeCount(doc), Object.keys(doc.nodes).length, `${label}: the layer count`);
};

test('the text of every starter template, the 20 000-layer page and a product file is JSON.stringify’s, before and after edits', () => {
  for (const template of DESIGN_TEMPLATES) same(template.build({measurer: testMeasurer}), template.id);
  const images = Object.fromEntries(Array.from({length: 60}, (_, k) => [`img${k + 1}`, {url: `/uploads/dz-${k + 1}.webp`, width: 2000, height: 1500}]));
  for (const [label, doc] of [['heavy', heavyPage()], ['product', productFile(images)]] as const) {
    same(doc, label);
    // Moves, a removal, a new layer, a page order and a new picture: changed and new entries are serialized, the rest reused.
    const ids = Object.keys(doc.nodes).filter(id => doc.nodes[id].type === 'RECTANGLE').slice(0, 5);
    let next = doc;
    for (const [k, id] of ids.entries()) {
      const patch: DocumentPatch = {nodes: {[id]: {...next.nodes[id], x: next.nodes[id].x + k, name: `Layer “${k}” 🎨`}}};
      next = applyPatch(next, patch);
      same(next, `${label} after edit ${k}`);
    }
    const page = next.pages[0];
    const added = createNode('RECTANGLE', {id: 'zz-new', parentId: page, name: 'New'});
    next = applyPatch(next, {
      nodes: {[ids[0]]: null, 'zz-new': added, [page]: {...next.nodes[page], children: [...next.nodes[page].children!.filter(id => id !== ids[0]), 'zz-new']}},
      images: {extra: {url: '/uploads/dz-extra.webp', width: 10, height: 10}},
      pages: [...next.pages].reverse(),
    });
    same(next, `${label} after structure`);
  }
});

test('edge cases of JSON: keys that look like numbers, escapes, lone surrogates, undefined and non-object values, empty tables', () => {
  const doc = createDocument('p');
  const node = (id: string, name: string): SceneNode => createNode('RECTANGLE', {id, parentId: 'p', name});
  const tricky = {
    ...doc,
    nodes: {
      ...doc.nodes,
      '10': node('10', 'number (café)'),
      '2': node('2', 'quotes " and \\ and \n'),
      'a"b': node('a"b', 'lone surrogate \ud800 and a pair 😀'),
      skip: undefined as unknown as SceneNode,
    },
    styles: {},
    images: {weird: null as never},
    variableModes: undefined,
    extra: [1, undefined, 'x'],
  } as unknown as DesignDocument;
  same(tricky, 'tricky');
  // One object under two keys is written with each key.
  const shared = {a: 'b'};
  same({...doc, variableModes: {one: shared, two: shared}} as DesignDocument, 'shared entry');
  // A document that is not a plain object is serialized whole.
  same(Object.assign(Object.create(null), doc) as DesignDocument, 'prototype-less');
});

test('a save serializes the entries it wrote, not the 20 000 it kept', () => {
  const doc = heavyPage();
  documentText(doc);
  const id = Object.keys(doc.nodes).find(key => doc.nodes[key].type === 'TEXT')!;
  const next = applyPatch(doc, {nodes: {[id]: {...doc.nodes[id], name: 'Another name'}}});
  const stringify = JSON.stringify;
  let calls = 0;
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => {
    calls++;
    return stringify(...args);
  }) as typeof JSON.stringify;
  try {
    documentBytes(next);
    documentText(next);
  } finally {
    JSON.stringify = stringify;
  }
  // The changed node (its key and value), and the document's own keys and small values (schema version, pages) twice.
  assert.ok(calls < 40, `${calls} calls to JSON.stringify for a one-layer change`);
  assert.ok(documentText(next).equals(Buffer.from(stringify(next))));
  // Time: the size and the layer count of the saved document are carried from the one it was made from (only the written entry is
  // measured), where a walk of 20 000 entries took ~8 ms and a count of the keys ~2.5 ms; the whole 16 MB text from kept pieces is
  // a copy, not a serialization (≈120 ms for JSON.stringify on the reference machine).
  let best = Infinity,
    whole = Infinity;
  for (let run = 0; run < 3; run++) {
    const after = applyPatch(next, {nodes: {[id]: {...next.nodes[id], x: run}}});
    let started = performance.now();
    documentBytes(after);
    documentNodeCount(after);
    best = Math.min(best, performance.now() - started);
    started = performance.now();
    documentText(after);
    whole = Math.min(whole, performance.now() - started);
  }
  assert.ok(best < budget(1), `the size and layer count of a one-layer save took ${best.toFixed(2)} ms`);
  assert.ok(whole < budget(60), `the text of a 20 000-layer document from kept pieces took ${whole.toFixed(1)} ms`);
});

test('the size and layer count follow removals, additions and replaced tables, as carried from save to save', () => {
  let doc = heavyPage();
  same(doc, 'start');
  const ids = Object.keys(doc.nodes).filter(key => doc.nodes[key].type === 'ELLIPSE').slice(0, 30);
  for (const [k, id] of ids.entries()) {
    const parent = doc.nodes[id].parentId!;
    const added = createNode('RECTANGLE', {id: `zz-${k}`, parentId: parent, name: `New “${k}” 🎨`});
    // A removal, an addition and an edit of the parent in one save; then an edit that writes a node with the same value.
    doc = applyPatch(doc, {nodes: {[id]: null, [`zz-${k}`]: added, [parent]: {...doc.nodes[parent], children: [...doc.nodes[parent].children!.filter(child => child !== id), `zz-${k}`]}}});
    doc = applyPatch(doc, {nodes: {[`zz-${k}`]: doc.nodes[`zz-${k}`]}});
    if (k % 10 === 9) same(doc, `after ${k + 1} saves`);
  }
  // A table made another way (no carried size) is measured afresh.
  same({...doc, nodes: {...doc.nodes}}, 'copied table');
});
