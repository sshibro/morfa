import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {EXPORT_MAX_PIXELS, EXPORT_MAX_SIDE, ExportError, exportBounds, exportPixelSize, fontSpecsUnder} from '../src/design/engine/export-raster';
import {paintRootsInTurn, thumbnailContent} from '../src/design/engine/thumbnail';

function docWith(...nodes: Array<Partial<SceneNode> & {id: string; type: SceneNode['type']; parentId?: string}>): DesignDocument {
  const doc = createDocument('page');
  for (const {type, parentId = 'page', ...props} of nodes) {
    doc.nodes[props.id] = createNode(type, {...props, parentId});
    doc.nodes[parentId].children!.push(props.id);
  }
  return doc;
}

test('export size by scale, width or height', () => {
  const bounds = {x: 0, y: 0, width: 200, height: 100};
  assert.deepEqual(exportPixelSize(bounds, {type: 'SCALE', value: 2}), {width: 400, height: 200, scale: 2});
  assert.deepEqual(exportPixelSize(bounds, {type: 'WIDTH', value: 50}), {width: 50, height: 25, scale: 0.25});
  assert.deepEqual(exportPixelSize(bounds, {type: 'HEIGHT', value: 300}), {width: 600, height: 300, scale: 3});
  assert.deepEqual(exportPixelSize({x: 0, y: 0, width: 0.2, height: 0.2}, {type: 'SCALE', value: 1}), {width: 1, height: 1, scale: 1}, 'at least one pixel');
  assert.equal(exportPixelSize(bounds, {type: 'SCALE', value: -3}).scale, 1, 'nonsense scales fall back to 1×');
});

test('exports over the browser limits fail with a clear message', () => {
  assert.throws(() => exportPixelSize({x: 0, y: 0, width: 5000, height: 10}, {type: 'SCALE', value: 4}), (error: unknown) => {
    assert.ok(error instanceof ExportError);
    assert.equal(error.code, 'too_large');
    assert.match(error.message, /20,000 × 40 px/);
    assert.match(error.message, /16,384 px per side and 256 MP/);
    return true;
  });
  assert.throws(() => exportPixelSize({x: 0, y: 0, width: 16000, height: 16000}, {type: 'SCALE', value: 1.01}), ExportError);
  assert.ok(EXPORT_MAX_SIDE * EXPORT_MAX_SIDE > EXPORT_MAX_PIXELS, 'a full-size square also hits the area cap');
  assert.throws(() => exportPixelSize({x: 0, y: 0, width: 16500, height: 10}, {type: 'SCALE', value: 1}), ExportError);
  assert.throws(() => exportPixelSize({x: 0, y: 0, width: 0, height: 10}, {type: 'SCALE', value: 1}), (error: unknown) => error instanceof ExportError && error.code === 'empty' && /Nothing to export/.test(error.message));
});

test('frames export their box; other layers export everything they paint', () => {
  const doc = docWith(
    {id: 'f', type: 'FRAME', x: 10, y: 10, width: 100, height: 100, effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.5}, offset: {x: 0, y: 20}, radius: 10, spread: 0, visible: true, blendMode: 'NORMAL'}]},
    {id: 'child', type: 'RECTANGLE', parentId: 'f', x: 50, y: 50, width: 200, height: 200},
    {id: 'r', type: 'RECTANGLE', x: 300, y: 0, width: 50, height: 50, effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.5}, offset: {x: 0, y: 20}, radius: 0, spread: 0, visible: true, blendMode: 'NORMAL'}]},
  );
  assert.deepEqual(exportBounds(doc, ['f']), {x: 10, y: 10, width: 100, height: 100});
  assert.deepEqual(exportBounds(doc, ['r']), {x: 300, y: 0, width: 50, height: 70});
  assert.deepEqual(exportBounds(doc, ['f', 'r']), {x: 10, y: 0, width: 340, height: 110});
  assert.equal(exportBounds(doc, ['missing']), null);
});

test('every face the text under a root uses is waited for', () => {
  const text = defaultTextProps('Garden');
  text.runs = [{start: 0, end: 3, style: {fontWeight: 700}}, {start: 3, end: 6, style: {fontFamily: 'Roboto', italic: true}}];
  const doc = docWith({id: 'f', type: 'FRAME'}, {id: 't', type: 'TEXT', parentId: 'f', text});
  const specs = fontSpecsUnder(doc, 'f').map(s => `${s.family} ${s.weight}${s.italic ? 'i' : ''}`).sort();
  assert.deepEqual(specs, ['Inter 400', 'Inter 700', 'Roboto 400i']);
});

test('the thumbnail shows all top-level content, or the first frame when frames are spread thin', () => {
  const close = docWith({id: 'a', type: 'FRAME', x: 0, y: 0, width: 100, height: 100}, {id: 'b', type: 'FRAME', x: 120, y: 0, width: 100, height: 100});
  assert.deepEqual(thumbnailContent(close)?.ids, ['a', 'b']);
  const far = docWith({id: 'a', type: 'FRAME', x: 0, y: 0, width: 100, height: 100}, {id: 'b', type: 'FRAME', x: 5000, y: 5000, width: 100, height: 100});
  assert.deepEqual(thumbnailContent(far)?.ids, ['a']);
  assert.equal(thumbnailContent(createDocument('page')), null);
});

test('the card picture paints its roots one at a time and gives way between them', async () => {
  // A first page of 40 screens painted in one go held the editor for about 250 ms while the designer worked (2026-10-07).
  const log: string[] = [];
  let clock = 0;
  // Each root takes 5 ms here: two fit in a slice of 8 ms (the second starts at 5 ms), then the editor's turn.
  await paintRootsInTurn(ids => {
    log.push(`paint ${ids.join(',')}`);
    clock += 5;
  }, ['a', 'b', 'c', 'd', 'e'], async () => void log.push('pause'), 8, () => clock);
  assert.deepEqual(log, ['paint a', 'paint b', 'pause', 'paint c', 'paint d', 'pause', 'paint e']);
  // A root longer than the slice is painted whole, alone.
  log.length = 0;
  await paintRootsInTurn(ids => {
    log.push(`paint ${ids.join(',')}`);
    clock += 50;
  }, ['a', 'b'], async () => void log.push('pause'), 8, () => clock);
  assert.deepEqual(log, ['paint a', 'pause', 'paint b']);
  // With the real pause, work queued meanwhile (an input, a frame) runs between two roots.
  const order: string[] = [];
  let time = 0;
  const done = paintRootsInTurn(ids => {
    order.push(ids[0]);
    time += 10;
    if (ids[0] === 'a') setTimeout(() => order.push('input'), 0);
  }, ['a', 'b'], undefined, 8, () => time);
  await done;
  assert.deepEqual(order, ['a', 'input', 'b']);
});
