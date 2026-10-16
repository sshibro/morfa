import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {AutoLayout, DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {autoLayoutSpacing, drawSpacing, MIN_BAND_PX, type SpacingBand} from '../src/design/engine/spacing';

// "Code"'s auto layout spacing (src/design/engine/spacing.ts): padding and gap bands from a laid-out frame, and how they are
// drawn (thin bands left out, edges on device pixels, a label each).

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const r = (x: number, y: number, width: number, height: number) => ({x, y, width, height});
const layout = (mode: AutoLayout['layoutMode'], props: Partial<AutoLayout> = {}): AutoLayout => ({...defaultAutoLayout(mode), ...props});
const summary = (bands: SpacingBand[]) => bands.map(band => `${band.kind} ${band.axis}:${band.value}`);

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

test('a row: a band per side with padding, the gap across the content box; hidden and absolute children take none', () => {
  const doc = build(add => {
    add('FRAME', 'row', 'page', {x: 100, y: 50, width: 300, height: 100, autoLayout: layout('HORIZONTAL', {paddingTop: 10, paddingRight: 20, paddingBottom: 30, paddingLeft: 40, itemSpacing: 8})});
    add('RECTANGLE', 'a', 'row', {width: 50, height: 20});
    add('RECTANGLE', 'hidden', 'row', {width: 70, height: 20, visible: false});
    add('RECTANGLE', 'b', 'row', {width: 60, height: 40});
    add('RECTANGLE', 'pinned', 'row', {x: 250, y: 0, width: 10, height: 10, layoutPositioning: 'ABSOLUTE'});
  });
  assert.deepEqual([doc.nodes.a.x, doc.nodes.b.x], [40, 98], 'laid out: hidden is out of the flow');
  const bands = autoLayoutSpacing(doc, 'row');
  assert.deepEqual(summary(bands), ['padding y:10', 'padding y:30', 'padding x:40', 'padding x:20', 'gap x:8']);
  assert.deepEqual(bands.map(band => band.rect), [
    r(100, 50, 300, 10),
    r(100, 120, 300, 30),
    // Left and right stand between the top and bottom bands: no corner is covered twice.
    r(100, 60, 40, 60),
    r(380, 60, 20, 60),
    // From a's right edge to b's left, across the content box (inside the top and bottom padding).
    r(190, 60, 8, 60),
  ]);
});

test('a column: gaps run down, across the content box’s width; sides without padding have no band', () => {
  const doc = build(add => {
    add('FRAME', 'outer', 'page', {x: 1000, y: 0, width: 500, height: 500});
    add('FRAME', 'column', 'outer', {x: 20, y: 30, width: 120, height: 300, autoLayout: layout('VERTICAL', {paddingLeft: 12, itemSpacing: 16})});
    add('RECTANGLE', 'a', 'column', {width: 50, height: 40});
    add('RECTANGLE', 'b', 'column', {width: 50, height: 40});
    add('RECTANGLE', 'c', 'column', {width: 50, height: 40});
  });
  const bands = autoLayoutSpacing(doc, 'column');
  assert.deepEqual(summary(bands), ['padding x:12', 'gap y:16', 'gap y:16']);
  assert.deepEqual(bands.map(band => band.rect), [r(1020, 30, 12, 300), r(1032, 70, 108, 16), r(1032, 126, 108, 16)], 'in page space, through the outer frame');
});

test('SPACE_BETWEEN: the gaps are the distances it spread the children over', () => {
  const doc = build(add => {
    add('FRAME', 'bar', 'page', {width: 300, height: 40, autoLayout: layout('HORIZONTAL', {primaryAxisAlignItems: 'SPACE_BETWEEN', itemSpacing: 4})});
    for (const id of ['a', 'b', 'c']) add('RECTANGLE', id, 'bar', {width: 50, height: 40});
  });
  assert.deepEqual(summary(autoLayoutSpacing(doc, 'bar')), ['gap x:75', 'gap x:75']);
});

test('wrap: gaps within each row across the row, and the gap between rows across the content box', () => {
  const doc = build(add => {
    add('FRAME', 'grid', 'page', {width: 200, height: 200, autoLayout: layout('HORIZONTAL', {layoutWrap: 'WRAP', paddingTop: 10, paddingRight: 10, paddingBottom: 10, paddingLeft: 10, itemSpacing: 10, counterAxisSpacing: 20})});
    for (let i = 0; i < 5; i++) add('RECTANGLE', `t${i}`, 'grid', {width: 50, height: i === 1 ? 40 : 30});
  });
  assert.deepEqual([doc.nodes.t3.x, doc.nodes.t3.y], [10, 70], 'three to a row, the second row under the tallest');
  const gaps = autoLayoutSpacing(doc, 'grid').filter(band => band.kind === 'gap');
  assert.deepEqual(summary(gaps), ['gap x:10', 'gap x:10', 'gap y:20', 'gap x:10']);
  assert.deepEqual(gaps.map(band => band.rect), [r(60, 10, 10, 40), r(120, 10, 10, 40), r(10, 50, 180, 20), r(60, 70, 10, 30)]);
});

test('nothing for a frame without auto layout, a turned frame, or one inside a turned frame; overlapping children have no gap', () => {
  const doc = build(add => {
    add('FRAME', 'plain', 'page', {width: 100, height: 100});
    add('RECTANGLE', 'p', 'plain', {width: 10, height: 10});
    add('FRAME', 'turned', 'page', {x: 300, width: 100, height: 100, rotation: 30, autoLayout: layout('HORIZONTAL', {paddingLeft: 10})});
    add('FRAME', 'tilted', 'page', {x: 600, width: 300, height: 300, rotation: 15});
    add('FRAME', 'inner', 'tilted', {width: 100, height: 100, autoLayout: layout('HORIZONTAL', {paddingLeft: 10})});
    add('FRAME', 'tight', 'page', {y: 400, width: 200, height: 40, autoLayout: layout('HORIZONTAL', {itemSpacing: -10})});
    add('RECTANGLE', 'x', 'tight', {width: 50, height: 40});
    add('RECTANGLE', 'y', 'tight', {width: 50, height: 40});
  });
  for (const id of ['plain', 'turned', 'inner', 'p', 'missing']) assert.deepEqual(autoLayoutSpacing(doc, id), [], id);
  assert.deepEqual(autoLayoutSpacing(doc, 'tight'), [], 'negative spacing: the children overlap');
});

/** A 2D context that records the rectangles it is given and the labels' text. */
function recorder() {
  const rects: number[][] = [], texts: string[] = [];
  const ctx = new Proxy({} as Record<string | symbol, unknown>, {
    get(target, key) {
      if (key === 'rect') return (...args: number[]) => void rects.push(args);
      if (key === 'fillText') return (text: string) => void texts.push(text);
      if (key === 'measureText') return (text: string) => ({width: text.length * 6});
      if (key in target) return target[key];
      return () => {};
    },
    set(target, key, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {ctx, rects, texts};
}

test('drawing: bands on device pixels with their values; bands under 4 px on screen are left out', () => {
  const doc = build(add => {
    add('FRAME', 'row', 'page', {x: 0.3, y: 0, width: 200, height: 50, autoLayout: layout('HORIZONTAL', {paddingLeft: 3, paddingTop: 16, itemSpacing: 8})});
    add('RECTANGLE', 'a', 'row', {width: 40, height: 20});
    add('RECTANGLE', 'b', 'row', {width: 40, height: 20});
  });
  const bands = autoLayoutSpacing(doc, 'row');
  assert.deepEqual(summary(bands), ['padding y:16', 'padding x:3', 'gap x:8']);

  const at1 = recorder();
  drawSpacing(at1.ctx, bands, {x: 0, y: 0, zoom: 1}, 2);
  assert.deepEqual(at1.texts, ['16', '8'], `the 3 px padding is under ${MIN_BAND_PX} px at 100 %`);
  assert.ok(at1.rects.flat().every(value => Number.isInteger(value * 2)), 'every edge on a device pixel at 2×');
  assert.deepEqual(at1.rects[0], [0.5, 0, 200, 16]);

  const at2 = recorder();
  drawSpacing(at2.ctx, bands, {x: 0, y: 0, zoom: 2}, 1);
  assert.deepEqual(at2.texts, ['16', '3', '8'], 'zoomed in, the thin band shows');
  const at01 = recorder();
  drawSpacing(at01.ctx, bands, {x: 0, y: 0, zoom: 0.2}, 1);
  assert.deepEqual([at01.rects, at01.texts], [[], []], 'zoomed far out, nothing');
});
