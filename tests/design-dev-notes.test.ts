import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import {documentTarget, mergeChange} from '../shared/design/merge';
import {checkPatchedDocument, validateDocument} from '../shared/design/schema';
import type {Annotation, DesignDocument, Measurement, NodeId, SceneNode} from '../shared/design/types';
import {annotationColor, annotationPropertiesFor, annotationValue, ANNOTATION_CATEGORIES, newAnnotationId, pageAnnotations} from '../shared/design/annotations';
import {measurementGeometry, measurementText, nearestSide, newMeasurementId, offsetThrough, pageMeasurements, parallelSideNear} from '../shared/design/measurements';
import {recordOverrides} from '../shared/design/components';
import {normalizeDocument} from '../shared/design/normalize';
import type {TextMeasurer} from '../shared/design/text-layout';

const measurer: TextMeasurer = {width: (value, font) => value.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

// Dev annotations ("Annotation", Y) and measurements ("Measurement", ⇧M): stored on the layers and the page, merged entry by
// entry when two people pin notes at once, drawn from the layers as they are now.

const PAGE = 'page1';

function base(): DesignDocument {
  let doc = createDocument(PAGE);
  const add = (node: SceneNode) => {
    const parent = doc.nodes[node.parentId!];
    doc = {...doc, nodes: {...doc.nodes, [node.id]: node, [parent.id]: {...parent, children: [...(parent.children ?? []), node.id]}}};
  };
  add(createNode('FRAME', {id: 'F', parentId: PAGE, x: 100, y: 100, width: 300, height: 200}));
  add(createNode('RECTANGLE', {id: 'a', parentId: 'F', x: 10, y: 20, width: 50, height: 40}));
  add(createNode('RECTANGLE', {id: 'b', parentId: 'F', x: 100, y: 20, width: 60, height: 80}));
  add(createNode('TEXT', {id: 't', parentId: PAGE, x: 0, y: 0, width: 40, height: 20, text: defaultTextProps('Hi')}));
  return doc;
}

function edit(doc: DesignDocument, change: (nodes: Record<NodeId, SceneNode | null>) => void): {patch: DocumentPatch; before: DocumentPatch} {
  const nodes: Record<NodeId, SceneNode | null> = {};
  change(nodes);
  return {patch: {nodes}, before: {nodes: Object.fromEntries(Object.keys(nodes).map(id => [id, doc.nodes[id] ?? null]))}};
}

function land(current: DesignDocument, change: {patch: DocumentPatch; before: DocumentPatch}): DesignDocument {
  const merged = mergeChange(documentTarget(current), change.patch, change.before);
  const next = applyPatch(current, merged.patch);
  const checked = checkPatchedDocument(current, next, merged.patch);
  assert.ok(checked.ok, !checked.ok ? `${checked.error} at ${checked.path}` : '');
  assert.ok(validateDocument(JSON.parse(JSON.stringify(next))).ok);
  return next;
}

const note = (id: string, label: string, extra: Partial<Annotation> = {}): Annotation => ({id, label, ...extra});
const measure = (id: string, extra: Partial<Measurement> = {}): Measurement => ({
  id, start: {nodeId: 'a', side: 'RIGHT'}, end: {nodeId: 'b', side: 'LEFT'}, offset: {type: 'INNER', relative: 0.5}, ...extra,
});

test('two people pin notes on one layer at once: both notes stay', () => {
  const doc = base();
  const mine = edit(doc, nodes => (nodes.a = {...doc.nodes.a, annotations: [note('a1', 'Button')]}));
  const theirs = edit(doc, nodes => (nodes.a = {...doc.nodes.a, annotations: [note('x7', 'Padding 16')]}));
  const after = land(land(doc, theirs), mine);
  assert.deepEqual(after.nodes.a.annotations!.map(entry => entry.label).sort(), ['Button', 'Padding 16']);
});

test('two people pin a note and a measurement from the same file at once: the ids they make differ, so both stay', () => {
  const doc = base();
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) ids.add(newAnnotationId([]));
  assert.equal(ids.size, 200);
  const mineNote = note(newAnnotationId(doc.nodes.a.annotations), 'Mine');
  const theirNote = note(newAnnotationId(doc.nodes.a.annotations), 'Theirs');
  const mine = edit(doc, nodes => {
    nodes.a = {...doc.nodes.a, annotations: [mineNote]};
    nodes[PAGE] = {...doc.nodes[PAGE], measurements: [measure(newMeasurementId(doc.nodes[PAGE].measurements))]};
  });
  const theirs = edit(doc, nodes => {
    nodes.a = {...doc.nodes.a, annotations: [theirNote]};
    nodes[PAGE] = {...doc.nodes[PAGE], measurements: [measure(newMeasurementId(doc.nodes[PAGE].measurements), {end: {nodeId: 'b', side: 'RIGHT'}})]};
  });
  const after = land(land(doc, theirs), mine);
  assert.deepEqual(after.nodes.a.annotations!.map(entry => entry.label).sort(), ['Mine', 'Theirs']);
  assert.equal(after.nodes[PAGE].measurements!.length, 2);
});

test('one edits a note while another removes a different one; a removal wins over an edit', () => {
  let doc = base();
  doc = {...doc, nodes: {...doc.nodes, a: {...doc.nodes.a, annotations: [note('a1', 'One'), note('a2', 'Two')]}}};
  const mine = edit(doc, nodes => (nodes.a = {...doc.nodes.a, annotations: [note('a1', 'One, fixed'), note('a2', 'Two')]}));
  const theirs = edit(doc, nodes => (nodes.a = {...doc.nodes.a, annotations: [note('a1', 'One')]}));
  assert.deepEqual(land(land(doc, theirs), mine).nodes.a.annotations, [note('a1', 'One, fixed')]);
  const removeEdited = edit(doc, nodes => (nodes.a = {...doc.nodes.a, annotations: [note('a2', 'Two')]}));
  assert.deepEqual(land(land(doc, mine), removeEdited).nodes.a.annotations, [note('a2', 'Two')]);
});

test('measurements merge the same way on the page', () => {
  const doc = base();
  const mine = edit(doc, nodes => (nodes[PAGE] = {...doc.nodes[PAGE], measurements: [measure('m1')]}));
  const theirs = edit(doc, nodes => (nodes[PAGE] = {...doc.nodes[PAGE], measurements: [measure('m9', {start: {nodeId: 'a', side: 'TOP'}, end: {nodeId: 'a', side: 'BOTTOM'}})]}));
  const after = land(land(doc, theirs), mine);
  assert.deepEqual(after.nodes[PAGE].measurements!.map(m => m.id).sort(), ['m1', 'm9']);
});

test('the schema: measurements live on pages, notes not on pages, ids once per list', () => {
  const doc = base();
  const bad = (patch: Partial<SceneNode>, id: string) => validateDocument(JSON.parse(JSON.stringify({...doc, nodes: {...doc.nodes, [id]: {...doc.nodes[id], ...patch}}}))).ok;
  assert.equal(bad({measurements: [measure('m1')]}, 'a'), false);
  assert.equal(bad({annotations: [note('a1', 'x')]}, PAGE), false);
  assert.equal(bad({annotations: [note('a1', 'x'), note('a1', 'y')]}, 'a'), false);
  assert.equal(bad({annotations: [note('a1', 'x', {categoryId: 'development', properties: [{type: 'width'}]})]}, 'a'), true);
});

test('a measurement follows its layers', () => {
  const doc = base();
  // a: x 110..160, b: x 200..260 on the page; both at y 120.
  const geometry = measurementGeometry(doc, PAGE, measure('m1'))!;
  assert.equal(geometry.value, 40);
  assert.deepEqual(geometry.from, {x: 160, y: 140});
  assert.deepEqual(geometry.to, {x: 200, y: 140});
  assert.equal(measurementText({}, geometry.value), '40');
  assert.equal(measurementText({freeText: ' Gap '}, geometry.value), 'Gap');
  const moved = {...doc, nodes: {...doc.nodes, b: {...doc.nodes.b, x: 130}}};
  assert.equal(measurementGeometry(moved, PAGE, measure('m1'))!.value, 70);
  // A removed layer: nothing to draw.
  const {b: _gone, ...rest} = doc.nodes;
  assert.equal(measurementGeometry({...doc, nodes: rest}, PAGE, measure('m1')), null);
  // Not parallel: refused.
  assert.equal(measurementGeometry(doc, PAGE, measure('m2', {end: {nodeId: 'b', side: 'TOP'}})), null);
});

test('a layer\'s own size, measured outside it, gets extension lines', () => {
  const doc = base();
  const own = measure('m3', {start: {nodeId: 'a', side: 'LEFT'}, end: {nodeId: 'a', side: 'RIGHT'}, offset: {type: 'OUTER', fixed: 12}});
  const geometry = measurementGeometry(doc, PAGE, own)!;
  assert.equal(geometry.value, 50);
  assert.equal(geometry.from.y, 120 - 12);
  assert.equal(geometry.extensions.length, 2);
  const page = {...doc, nodes: {...doc.nodes, [PAGE]: {...doc.nodes[PAGE], measurements: [own, measure('m4', {start: {nodeId: 'zz', side: 'LEFT'}})]}}};
  assert.equal(pageMeasurements(page, PAGE).length, 1);
});

test('edges near a point, the parallel edge to end on, and the offset through a point', () => {
  const box = {x: 0, y: 0, width: 100, height: 50};
  assert.equal(nearestSide(box, {x: 98, y: 20}, 4), 'RIGHT');
  assert.equal(nearestSide(box, {x: 50, y: -3}, 4), 'TOP');
  assert.equal(nearestSide(box, {x: 50, y: 25}, 4), null);
  assert.equal(parallelSideNear(box, 'LEFT', {x: 90, y: 0}), 'RIGHT');
  const doc = base();
  assert.deepEqual(offsetThrough(doc, {nodeId: 'a', side: 'RIGHT'}, {x: 0, y: 130}), {type: 'INNER', relative: 0.25});
  assert.deepEqual(offsetThrough(doc, {nodeId: 'a', side: 'RIGHT'}, {x: 0, y: 100}), {type: 'OUTER', fixed: 20});
  assert.deepEqual(offsetThrough(doc, {nodeId: 'a', side: 'RIGHT'}, {x: 0, y: 170}), {type: 'OUTER', fixed: -10});
  const taken = [measure('m1')];
  const fresh = newMeasurementId(taken);
  assert.ok(fresh !== 'm1' && validateDocument(JSON.parse(JSON.stringify({...doc, nodes: {...doc.nodes, [PAGE]: {...doc.nodes[PAGE], measurements: [...taken, measure(fresh)]}}}))).ok);
});

test('annotation values are read live from the layer', () => {
  const doc = base();
  const text = doc.nodes.t;
  assert.equal(annotationValue(doc, doc.nodes.a, 'width'), '50px');
  assert.equal(annotationValue(doc, text, 'fontFamily'), text.text!.style.fontFamily);
  assert.ok(annotationPropertiesFor(text).some(entry => entry.type === 'fontSize'));
  assert.ok(!annotationPropertiesFor(doc.nodes.a).some(entry => entry.type === 'fontSize'));
  assert.ok(annotationPropertiesFor(doc.nodes.F).some(entry => entry.type === 'layoutMode'));
  assert.equal(annotationColor({categoryId: 'development'}), '#0D99FF');
  assert.equal(ANNOTATION_CATEGORIES.length, 4);
  assert.ok(!['a1', 'a3'].includes(newAnnotationId([note('a1', ''), note('a3', '')])));
  const annotated = {...doc, nodes: {...doc.nodes, b: {...doc.nodes.b, annotations: [note('a1', 'B')]}, a: {...doc.nodes.a, annotations: [note('a1', 'A')]}}};
  assert.deepEqual(pageAnnotations(annotated, PAGE).map(entry => entry.annotation.label), ['A', 'B']);
});

test('a note on a main component shows on its instances, and one added to an instance stays', () => {
  let doc = base();
  doc = {...doc, nodes: {...doc.nodes,
    C: createNode('COMPONENT', {id: 'C', parentId: PAGE, width: 50, height: 50, children: [], annotations: [note('a1', 'Main')]}),
    I: createNode('INSTANCE', {id: 'I', parentId: PAGE, componentId: 'C', width: 50, height: 50, children: []}),
    [PAGE]: {...doc.nodes[PAGE], children: [...doc.nodes[PAGE].children!, 'C', 'I']}}};
  doc = normalizeDocument(doc, new Set(['C', 'I']), {measurer});
  assert.deepEqual(doc.nodes.I.annotations, [note('a1', 'Main')]);
  // A note added on the instance is its override: the next sync keeps it.
  const tracked = recordOverrides(doc, new Map([['I', {annotations: [note('a1', 'Main'), note('a2', 'Only here')]}]]), {direct: new Set(['I'])});
  const nodes = {...doc.nodes};
  for (const [id, partial] of tracked) nodes[id] = {...nodes[id], ...partial};
  doc = normalizeDocument({...doc, nodes}, new Set(tracked.keys()), {measurer});
  doc = normalizeDocument({...doc, nodes: {...doc.nodes, C: {...doc.nodes.C, name: 'Button'}}}, new Set(['C']), {measurer});
  assert.deepEqual(doc.nodes.I.annotations!.map(entry => entry.label), ['Main', 'Only here']);
});
