import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid, BLACK} from '../shared/design/defaults';
import {worldBox, type Rect} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import {descendants, type SpatialIndex} from '../shared/design/tree';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import {boxIntersectsRect, hitsNode, hitTest, liftToSelectable, nodesInRect, pickAt} from '../src/design/engine/hit-test';
import {budget} from './helpers/speed';

const context = {measurer: {width: (text: string) => text.length * 8, metrics: () => ({ascent: 12, descent: 4})}};

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit(context).doc;
}

/** Every node whose world box meets the rect, in no particular order: what a real spatial index returns. */
function bruteIndex(doc: DesignDocument, pageId = 'page'): SpatialIndex & {queries: number} {
  const index = {
    queries: 0,
    query(rect: Rect) {
      index.queries++;
      const out = descendants(doc, pageId).filter(id => {
        const box = worldBox(doc, id);
        const pad = Math.max(doc.nodes[id].strokeWeight, 0);
        return box.x - pad <= rect.x + rect.width && rect.x <= box.x + box.width + pad && box.y - pad <= rect.y + rect.height && rect.y <= box.y + box.height + pad;
      });
      return out.sort(() => 0.5 - Math.random());
    },
  };
  return index;
}

/** Hit tests with and without an index and checks both agree. */
function hit(doc: DesignDocument, x: number, y: number, tolerance = 0): NodeId | null {
  const scan = hitTest(doc, 'page', {x, y}, {tolerance});
  const indexed = hitTest(doc, 'page', {x, y}, {tolerance, index: bruteIndex(doc)});
  assert.equal(indexed, scan, `index and scan disagree at ${x},${y}`);
  return scan;
}

const stroke = {strokes: [solid(BLACK)], strokeWeight: 4};

test('rotated rectangles are hit by their rotated outline', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 100, y: 100, width: 100, height: 20, rotation: 45}));
  // The box turns counter-clockwise about its top-left corner: (100, 100) → along (cos 45°, −sin 45°).
  assert.equal(hit(doc, 135, 75), 'r', 'inside the turned box');
  assert.equal(hit(doc, 190, 110), null, 'inside the unturned box but outside the turned one');
  assert.ok(hitsNode(doc, 'r', {x: 135, y: 75}));
});

test('ellipses are hit inside the curve, not in the corners of their box', () => {
  const doc = build(add => add('ELLIPSE', 'e', 'page', {x: 0, y: 0, width: 100, height: 60}));
  assert.equal(hit(doc, 50, 30), 'e');
  assert.equal(hit(doc, 3, 3), null);
  assert.equal(hit(doc, 99, 30), 'e');
});

test('flipped and nested transforms', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 200, y: 0, width: 200, height: 200, rotation: 90, flipX: true, clipsContent: false});
    add('POLYGON', 'tri', 'f', {x: 0, y: 0, width: 100, height: 100});
  });
  // The triangle's apex is at the top centre of its own box; find where the frame put it.
  const box = worldBox(doc, 'tri');
  assert.equal(pickAt(doc, 'page', {x: box.x + box.width / 2, y: box.y + box.height / 2}), 'tri');
  assert.equal(hit(doc, box.x + box.width / 2, box.y + box.height / 2), 'tri');
});

test('hollow shapes take clicks on their stroke only; stroke alignment counts', () => {
  const doc = build(add => {
    add('RECTANGLE', 'under', 'page', {x: 0, y: 0, width: 300, height: 300});
    add('RECTANGLE', 'hollow', 'page', {x: 50, y: 50, width: 100, height: 100, fills: [], ...stroke, strokeAlign: 'OUTSIDE'});
    add('RECTANGLE', 'ghost', 'page', {x: 200, y: 200, width: 50, height: 50, fills: []});
  });
  assert.equal(hit(doc, 100, 100), 'under', 'the middle of a hollow shape lets the click through');
  assert.equal(hit(doc, 47, 100), 'hollow', 'outside stroke');
  assert.equal(hit(doc, 53, 100), 'under', 'an outside stroke does not reach inside');
  assert.equal(hit(doc, 53, 100, 4), 'hollow', 'unless the tolerance does');
  assert.equal(hit(doc, 225, 225), 'ghost', 'a shape with neither fill nor stroke can still be picked');
});

test('lines are hit within the tolerance', () => {
  const doc = build(add => add('LINE', 'l', 'page', {x: 0, y: 50, width: 200, height: 0, strokeWeight: 1}));
  assert.equal(hit(doc, 100, 50), 'l');
  assert.equal(hit(doc, 100, 53), null);
  assert.equal(hit(doc, 100, 53, 4), 'l');
  assert.equal(hit(doc, 210, 50, 4), null);
});

test('even-odd holes let clicks through; non-zero fills them', () => {
  const square = (s: number, o: number) => [{type: 'M' as const, x: o, y: o}, {type: 'L' as const, x: o + s, y: o}, {type: 'L' as const, x: o + s, y: o + s}, {type: 'L' as const, x: o, y: o + s}, {type: 'Z' as const}];
  const doc = build(add => {
    add('VECTOR', 'evenodd', 'page', {x: 0, y: 0, width: 100, height: 100, vectorPaths: [{windingRule: 'EVENODD', commands: [...square(100, 0), ...square(40, 30)]}]});
    add('VECTOR', 'nonzero', 'page', {x: 200, y: 0, width: 100, height: 100, vectorPaths: [{windingRule: 'NONZERO', commands: [...square(100, 0), ...square(40, 30)]}]});
  });
  assert.equal(hit(doc, 50, 50), null);
  assert.equal(hit(doc, 10, 10), 'evenodd');
  assert.equal(hit(doc, 250, 50), 'nonzero');
});

test('clipping frames, masks, hidden and locked layers', () => {
  const doc = build(add => {
    add('RECTANGLE', 'floor', 'page', {x: -1000, y: -1000, width: 3000, height: 3000});
    add('FRAME', 'clip', 'page', {x: 0, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'spill', 'clip', {x: 50, y: 50, width: 200, height: 20});
    add('FRAME', 'open', 'page', {x: 300, y: 0, width: 100, height: 100, clipsContent: false});
    add('RECTANGLE', 'out', 'open', {x: 50, y: 50, width: 200, height: 20});
    add('GROUP', 'masked', 'page', {x: 0, y: 300, width: 200, height: 200});
    add('ELLIPSE', 'mask', 'masked', {x: 0, y: 0, width: 100, height: 100, isMask: true});
    add('RECTANGLE', 'photo', 'masked', {x: 0, y: 0, width: 200, height: 200});
    add('RECTANGLE', 'hidden', 'page', {x: 600, y: 0, width: 50, height: 50, visible: false});
    add('RECTANGLE', 'locked', 'page', {x: 700, y: 0, width: 50, height: 50, locked: true});
  });
  assert.equal(hit(doc, 60, 60), 'spill');
  assert.equal(hit(doc, 200, 60), 'floor', 'outside the clipping frame the child is cut off');
  assert.equal(hit(doc, 500, 60), 'out', 'a frame without clipping shows its child outside');
  assert.equal(hit(doc, 50, 350), 'photo', 'inside the mask');
  assert.equal(hit(doc, 150, 450), 'floor', 'outside the mask');
  assert.equal(hit(doc, 5, 305), 'floor', 'the mask circle, not its box');
  assert.equal(hit(doc, 625, 25), 'floor');
  assert.equal(hit(doc, 725, 25), 'floor');
});

test('boolean operations hit their result and lift as one', () => {
  const doc = build(add => {
    add('BOOLEAN_OPERATION', 'b', 'page', {booleanOperation: 'SUBTRACT', x: 0, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'base', 'b', {x: 0, y: 0, width: 100, height: 100}); // children of groups and booleans are in their local space
    add('RECTANGLE', 'hole', 'b', {x: 25, y: 25, width: 50, height: 50});
  });
  assert.equal(hit(doc, 50, 50), null, 'the subtracted area is empty');
  assert.equal(hit(doc, 10, 10), 'base');
  assert.equal(pickAt(doc, 'page', {x: 10, y: 10}), 'b');
  assert.equal(pickAt(doc, 'page', {x: 10, y: 10}, {deep: true}), 'base');
});

test('Figma selection rules: frames on the canvas let clicks reach their children, groups and nested frames do not', () => {
  const doc = build(add => {
    add('FRAME', 'top', 'page', {x: 0, y: 0, width: 500, height: 500});
    add('RECTANGLE', 'direct', 'top', {x: 10, y: 10, width: 50, height: 50});
    add('GROUP', 'group', 'top', {x: 100, y: 100, width: 100, height: 100});
    add('RECTANGLE', 'grouped', 'group', {x: 0, y: 0, width: 100, height: 100});
    add('FRAME', 'nested', 'top', {x: 300, y: 300, width: 100, height: 100});
    add('RECTANGLE', 'deep', 'nested', {x: 10, y: 10, width: 30, height: 30});
    add('INSTANCE', 'inst', 'page', {x: 600, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'inst;m', 'inst', {mainId: 'm', x: 0, y: 0, width: 100, height: 100});
    add('SECTION', 'sec', 'page', {x: 0, y: 600, width: 600, height: 600});
    add('FRAME', 'secFrame', 'sec', {x: 10, y: 10, width: 300, height: 300});
    add('RECTANGLE', 'secRect', 'secFrame', {x: 10, y: 10, width: 50, height: 50});
    add('RECTANGLE', 'loose', 'page', {x: 1000, y: 0, width: 50, height: 50});
  });
  const pick = (x: number, y: number, options = {}) => pickAt(doc, 'page', {x, y}, options);
  assert.equal(pick(20, 20), 'direct');
  assert.equal(pick(150, 150), 'group');
  assert.equal(pick(320, 320), 'nested');
  assert.equal(pick(250, 50), 'top', 'empty frame area selects the frame');
  assert.equal(pick(650, 50), 'inst');
  assert.equal(pick(30, 630), 'secRect', 'sections are like the canvas');
  assert.equal(pick(250, 850), 'secFrame');
  assert.equal(pick(400, 1000), 'sec');
  assert.equal(pick(1020, 20), 'loose');
  assert.equal(pick(2000, 2000), null);
  assert.equal(pick(150, 150, {deep: true}), 'grouped');
  assert.equal(pick(320, 320, {deep: true}), 'deep');
  assert.equal(pick(650, 50, {deep: true}), 'inst;m');
  assert.equal(pick(150, 150, {context: 'group'}), 'grouped', 'inside an entered group its children are picked');
  assert.equal(pick(650, 50, {context: 'inst'}), 'inst;m');
  assert.equal(pick(20, 20, {context: 'group'}), 'direct', 'a click outside the context picks as if there were none');
  assert.equal(liftToSelectable(doc, 'deep', 'nested'), 'deep');
  const index = bruteIndex(doc);
  for (const [x, y] of [[20, 20], [150, 150], [320, 320], [250, 50], [650, 50], [30, 630], [400, 1000]]) {
    assert.equal(pickAt(doc, 'page', {x, y}, {index}), pick(x, y));
  }
});

test('scan and index agree everywhere on a crowded page', () => {
  const doc = build(add => {
    add('FRAME', 'a', 'page', {x: 0, y: 0, width: 400, height: 300, rotation: 10});
    add('ELLIPSE', 'a1', 'a', {x: 20, y: 20, width: 120, height: 80});
    add('GROUP', 'a2', 'a', {x: 100, y: 100, width: 200, height: 100, rotation: -30});
    add('STAR', 'a21', 'a2', {x: 100, y: 100, width: 100, height: 100});
    add('RECTANGLE', 'a22', 'a2', {x: 180, y: 120, width: 100, height: 60, fills: [], ...stroke});
    add('TEXT', 'a3', 'a', {x: 250, y: 20, width: 120, height: 40});
    add('FRAME', 'b', 'page', {x: 300, y: 150, width: 300, height: 300, flipY: true, clipsContent: false});
    add('RECTANGLE', 'b1', 'b', {x: -50, y: -50, width: 120, height: 120, rotation: 20});
    add('LINE', 'b2', 'b', {x: 0, y: 150, width: 300, height: 0, ...stroke});
    add('RECTANGLE', 'b3', 'b', {x: 150, y: 150, width: 100, height: 100, locked: true});
  });
  const index = bruteIndex(doc);
  for (let x = -60; x <= 640; x += 13) {
    for (let y = -60; y <= 480; y += 13) {
      for (const tolerance of [0, 3]) {
        const scan = hitTest(doc, 'page', {x, y}, {tolerance});
        assert.equal(hitTest(doc, 'page', {x, y}, {tolerance, index}), scan, `at ${x},${y} ±${tolerance}`);
      }
    }
  }
});

test('marquee: touched layers of the scope; frames on the canvas whole or through their children', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 400, height: 400});
    add('RECTANGLE', 'f1', 'f', {x: 10, y: 10, width: 50, height: 50});
    add('RECTANGLE', 'f2', 'f', {x: 300, y: 300, width: 50, height: 50});
    add('RECTANGLE', 'f3', 'f', {x: 100, y: 10, width: 50, height: 50, locked: true});
    add('RECTANGLE', 'outside', 'f', {x: 420, y: 10, width: 50, height: 50});
    add('RECTANGLE', 'r', 'page', {x: 500, y: 0, width: 50, height: 50});
    add('RECTANGLE', 'turned', 'page', {x: 700, y: 100, width: 100, height: 10, rotation: 45});
    add('RECTANGLE', 'hidden', 'page', {x: 520, y: 20, width: 10, height: 10, visible: false});
  });
  const index = bruteIndex(doc);
  const marquee = (rect: Rect, options = {}) => {
    const scan = nodesInRect(doc, 'page', rect, options);
    assert.deepEqual(nodesInRect(doc, 'page', rect, {...options, index}), scan, `index and scan disagree for ${JSON.stringify(rect)}`);
    return scan;
  };
  assert.deepEqual(marquee({x: -10, y: -10, width: 600, height: 100}), ['f1', 'r'], 'a partly covered frame gives its touched children');
  assert.deepEqual(marquee({x: -10, y: -10, width: 600, height: 600}), ['f', 'r'], 'a covered frame is taken whole');
  assert.deepEqual(marquee({x: 0, y: 0, width: 500, height: 500}, {scope: 'f'}), ['f1', 'f2'], 'inside a frame its children, never what its clip hides');
  assert.deepEqual(marquee({x: 690, y: 0, width: 30, height: 30}), [], 'the corner of a turned box’s bounds is not the box');
  assert.deepEqual(marquee({x: 700, y: 90, width: 20, height: 20}), ['turned']);
  assert.ok(boxIntersectsRect([[1, 0, 0], [0, 1, 0]], 10, 0, {x: 5, y: 0, width: 1, height: 1}), 'a box with no height still meets a rect');
});

test('hit testing a 20 000-node page stays interactive; the index skips the walk', () => {
  const doc = build(add => {
    for (let f = 0; f < 100; f++) {
      add('FRAME', `f${f}`, 'page', {x: (f % 10) * 1100, y: Math.floor(f / 10) * 1100, width: 1000, height: 1000});
      for (let i = 0; i < 199; i++) add(i % 2 ? 'ELLIPSE' : 'RECTANGLE', `n${f}-${i}`, `f${f}`, {x: (i % 14) * 70, y: Math.floor(i / 14) * 70, width: 60, height: 60});
    }
  });
  assert.equal(Object.keys(doc.nodes).length, 20_001);
  const started = performance.now();
  for (let i = 0; i < 20; i++) hitTest(doc, 'page', {x: 5000 + i, y: 5000 + i});
  const scan = (performance.now() - started) / 20;
  assert.ok(scan < budget(25), `scan ${scan.toFixed(2)} ms`);
  // A cheap grid index over the boxes, as the renderer would keep.
  const cells = new Map<string, NodeId[]>();
  for (const id of descendants(doc, 'page')) {
    const box = worldBox(doc, id);
    for (let cx = Math.floor(box.x / 500); cx <= Math.floor((box.x + box.width) / 500); cx++) {
      for (let cy = Math.floor(box.y / 500); cy <= Math.floor((box.y + box.height) / 500); cy++) {
        const key = `${cx}:${cy}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key)!.push(id);
      }
    }
  }
  const grid: SpatialIndex = {query: rect => new Set(cells.get(`${Math.floor(rect.x / 500)}:${Math.floor(rect.y / 500)}`) ?? [])};
  const indexedStart = performance.now();
  let found: NodeId | null = null;
  for (let i = 0; i < 200; i++) found = hitTest(doc, 'page', {x: 5530 + (i % 5), y: 5530}, {index: grid});
  const indexed = (performance.now() - indexedStart) / 200;
  assert.equal(found, hitTest(doc, 'page', {x: 5534, y: 5530}));
  assert.ok(indexed < budget(2), `indexed ${indexed.toFixed(3)} ms`);
});
