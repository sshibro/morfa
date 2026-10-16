import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {frameTitleAt, isDarkGround, titleBoxes, titleFieldPlacement, titleGround, TITLE_FIELD} from '../src/design/engine/frame-titles';

// src/design/engine/frame-titles.ts: the titles above top-level frames and the chips of sections are
// handles of their layer (click selects, double click renames), placed where render/overlays.ts draws them.

function add(doc: DesignDocument, type: SceneNode['type'], props: Partial<SceneNode> & {id: string}, parentId = 'page'): DesignDocument {
  const node = createNode(type, {...props, parentId});
  const parent = doc.nodes[parentId];
  return {...doc, nodes: {...doc.nodes, [node.id]: node, [parentId]: {...parent, children: [...(parent.children ?? []), node.id]}}};
}

/** A frame "Screen" at (0, 0) 200 × 100 seen at 100 % with the page origin 20 px from the canvas corner. */
function setup() {
  let doc = createDocument('page');
  doc = add(doc, 'FRAME', {id: 'f', name: 'Screen', x: 0, y: 0, width: 200, height: 100});
  doc = add(doc, 'RECTANGLE', {id: 'r', x: 10, y: 10, width: 20, height: 20}, 'f');
  doc = add(doc, 'FRAME', {id: 'inner', name: 'Nested', x: 40, y: 40, width: 100, height: 40}, 'f');
  return doc;
}
const viewport = {x: -20, y: -40, zoom: 1};

test('a click above a top-level frame, on its title, finds the frame; inside it and past the text finds nothing', () => {
  const doc = setup();
  assert.equal(frameTitleAt(doc, 'page', {x: 25, y: 32}, viewport), 'f');
  assert.equal(frameTitleAt(doc, 'page', {x: 21, y: 21}, viewport), 'f', 'up to 20 px above the edge');
  assert.equal(frameTitleAt(doc, 'page', {x: 25, y: 45}, viewport), null, 'inside the frame the layers take the click');
  assert.equal(frameTitleAt(doc, 'page', {x: 25, y: 10}, viewport), null, 'too far above');
  assert.equal(frameTitleAt(doc, 'page', {x: 200, y: 32}, viewport), null, 'beyond the title text');
  assert.equal(frameTitleAt(doc, 'page', {x: 15, y: 32}, viewport), null, 'left of the frame');
  // Nested frames have no title.
  assert.deepEqual(titleBoxes(doc, 'page', viewport).map(box => box.id), ['f']);
});

test('titles follow zoom and rotation, and vanish where they are not drawn (tiny, hidden, locked)', () => {
  let doc = setup();
  // At 5 % the frame is 10 px wide: no title is drawn, none is hit.
  assert.equal(frameTitleAt(doc, 'page', {x: 1, y: -2}, {x: 0, y: 0, zoom: 0.05}), null);
  // At 200 % the title starts at the frame's corner on screen.
  assert.equal(frameTitleAt(doc, 'page', {x: 45, y: 70}, {x: -20, y: -40, zoom: 2}), 'f');
  // Turned 90° counter-clockwise, the top edge runs upwards from the bottom-left corner and the title
  // sits to its left.
  doc = {...doc, nodes: {...doc.nodes, f: {...doc.nodes.f, rotation: 90, x: 0, y: 200}}};
  const [box] = titleBoxes(doc, 'page', {x: 0, y: 0, zoom: 1});
  assert.ok(Math.abs(box.along.x) < 1e-9 && Math.abs(box.along.y + 1) < 1e-9, 'along the turned edge');
  assert.equal(frameTitleAt(doc, 'page', {x: -10, y: 190}, {x: 0, y: 0, zoom: 1}), 'f');
  assert.equal(frameTitleAt(doc, 'page', {x: 10, y: 190}, {x: 0, y: 0, zoom: 1}), null);
  const locked = {...setup(), nodes: {...setup().nodes, f: {...setup().nodes.f, locked: true}}};
  assert.equal(frameTitleAt(locked, 'page', {x: 25, y: 32}, viewport), null, 'a locked frame cannot be picked');
  const hidden = {...setup(), nodes: {...setup().nodes, f: {...setup().nodes.f, visible: false}}};
  assert.equal(frameTitleAt(hidden, 'page', {x: 25, y: 32}, viewport), null);
});

test('a section is picked by its name chip inside its corner; the top-most title wins', () => {
  let doc = createDocument('page');
  doc = add(doc, 'SECTION', {id: 's', name: 'Header', x: 0, y: 0, width: 400, height: 300});
  assert.equal(frameTitleAt(doc, 'page', {x: 15, y: 15}, {x: 0, y: 0, zoom: 1}), 's');
  assert.equal(frameTitleAt(doc, 'page', {x: 15, y: -5}, {x: 0, y: 0, zoom: 1}), null, 'nothing above a section');
  // Two frames whose titles overlap: the later (upper) one is picked.
  doc = add(doc, 'FRAME', {id: 'a', name: 'First', x: 500, y: 0, width: 200, height: 100});
  doc = add(doc, 'FRAME', {id: 'b', name: 'Second', x: 500, y: 0, width: 200, height: 100});
  assert.equal(frameTitleAt(doc, 'page', {x: 505, y: -8}, {x: 0, y: 0, zoom: 1}), 'b');
});

test('the rename field stands on the name it replaces: after a component’s icon, on the baseline, a chip in its chip’s place', () => {
  let doc = createDocument('page');
  doc = add(doc, 'FRAME', {id: 'f', name: 'Screen', x: 0, y: 0, width: 200, height: 100});
  doc = add(doc, 'COMPONENT', {id: 'c', name: 'Button', x: 300, y: 0, width: 200, height: 100});
  doc = add(doc, 'SECTION', {id: 's', name: 'Header', x: 0, y: 300, width: 400, height: 300});
  const boxes = Object.fromEntries(titleBoxes(doc, 'page', {x: 0, y: 0, zoom: 1}).map(box => [box.id, box]));
  assert.deepEqual([boxes.f.tone, boxes.c.tone, boxes.s.tone], ['frame', 'component', 'section']);
  // A frame's name starts at its corner, a component's 11 px in (render/overlays.ts: the icon, then 4 px).
  assert.deepEqual([boxes.f.textX, boxes.c.textX], [0, 11]);
  // The field's text sits inside 4 px of padding, on the name's baseline 6 px above the edge (13 px down an 18 px
  // field), and the field ends 1 px above the edge so its ring never covers it.
  assert.deepEqual(titleFieldPlacement(boxes.f), {x: -4, y: -19, padding: 4, height: TITLE_FIELD.height});
  assert.deepEqual(titleFieldPlacement(boxes.c), {x: 7, y: -19, padding: 4, height: 18});
  assert.equal(-19 + TITLE_FIELD.baseline, -6);
  // A section's field is its chip: 6 px in, 20 px tall, the text 6 px inside it.
  assert.deepEqual(titleFieldPlacement(boxes.s), {x: 0, y: 6, padding: 6, height: 20});
});

test('the rename field follows the canvas under it, not the theme: the page, or a section’s own fill', () => {
  const light = {r: 0.96, g: 0.96, b: 0.96}, dark = {r: 0.12, g: 0.12, b: 0.12};
  const frame = createNode('FRAME', {id: 'f'});
  assert.equal(titleGround(frame, light), 'light');
  assert.equal(titleGround(frame, dark), 'dark');
  const section = createNode('SECTION', {id: 's', fills: [solid({r: 0.1, g: 0.1, b: 0.3})]});
  assert.equal(titleGround(section, light), 'dark', 'a dark section on a light page');
  assert.equal(titleGround({...section, fills: []}, light), 'light', 'a section without a fill shows the page');
  assert.equal(isDarkGround({r: 0.5, g: 0.5, b: 0.5}), false);
});
