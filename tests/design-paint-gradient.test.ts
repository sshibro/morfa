import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {apply, invert} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import type {GradientPaint, ImagePaint, Matrix, Vec} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {gradientFrame, linearGradientPoints} from '../src/design/engine/render/gradient-math';
import {imagePlacement} from '../src/design/engine/render/image-math';
import {createDesignStore} from '../src/design/engine/store';
import {GRADIENT_TOOL, GradientEditTool, dragGradientHandle, handlesToLocal, paintEditSession, positionOnAxis, stopPoint} from '../src/design/engine/tools/gradient-edit';
import {cropTransformFor, imageRect, imageToLocal, moveImage, resizeImage, rotateCrop} from '../src/design/engine/tools/image-crop';
import {registerTool} from '../src/design/engine/tools/registry';
import type {ToolContext, ToolPointerEvent} from '../src/design/engine/tools/types';
import {convertPaint} from '../src/design/panels/design/paint/paints';

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const closeVec = (a: Vec, b: Vec, eps = 1e-6) => {
  close(a.x, b.x, eps);
  close(a.y, b.y, eps);
};
const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const dot = (a: Vec, b: Vec) => a.x * b.x + a.y * b.y;
const sub = (a: Vec, b: Vec) => ({x: a.x - b.x, y: a.y - b.y});

const linear = (): GradientPaint => convertPaint(solid({r: 1, g: 0, b: 0}), 'GRADIENT_LINEAR') as GradientPaint;
const radial = (): GradientPaint => convertPaint(solid({r: 1, g: 0, b: 0}), 'GRADIENT_RADIAL') as GradientPaint;

test('dragging the end of a linear gradient: the start stays, bands stay perpendicular on screen, the renderer ends there', () => {
  const paint = linear();
  const width = 200, height = 100;
  const handles = dragGradientHandle(paint, 1, {x: 60, y: -40}, width, height);
  const [p0, p1, p2] = handlesToLocal(handles, width, height);
  closeVec(p0, {x: 100, y: 0});
  closeVec(p1, {x: 160, y: 60});
  close(dot(sub(p1, p0), sub(p2, p0)), 0);
  // Parity with the renderer: the canvas gradient runs exactly from H0 to H1.
  const points = linearGradientPoints(handles, width, height);
  closeVec({x: points.x0, y: points.y0}, p0);
  closeVec({x: points.x1, y: points.y1}, p1);
});

test('dragging the start of a linear gradient moves only the start; Shift snaps to 45°', () => {
  const paint = linear();
  const moved = handlesToLocal(dragGradientHandle(paint, 0, {x: -30, y: 10}, 100, 100), 100, 100);
  closeVec(moved[0], {x: 20, y: 10});
  closeVec(moved[1], {x: 50, y: 100});
  const snapped = handlesToLocal(dragGradientHandle(paint, 1, {x: 33, y: -5}, 100, 100, {shift: true}), 100, 100);
  const axis = sub(snapped[1], snapped[0]);
  const angle = (Math.atan2(axis.y, axis.x) * 180) / Math.PI;
  close(Math.abs(angle % 45), 0, 1e-9);
});

test('radial handles: the centre carries the ellipse, the end turns it, the width handle only changes its other axis', () => {
  const paint = radial();
  const w = 100, h = 100;
  const moved = handlesToLocal(dragGradientHandle(paint, 0, {x: 10, y: 20}, w, h), w, h);
  closeVec(moved[0], {x: 60, y: 70});
  closeVec(moved[1], {x: 110, y: 70});
  closeVec(moved[2], {x: 60, y: 120});
  const turned = handlesToLocal(dragGradientHandle(paint, 1, {x: -50, y: 50}, w, h), w, h);
  closeVec(turned[1], {x: 50, y: 100});
  close(dot(sub(turned[1], turned[0]), sub(turned[2], turned[0])), 0);
  close(Math.hypot(...Object.values(sub(turned[2], turned[0])) as [number, number]), 50, 1e-9);
  const narrowed = handlesToLocal(dragGradientHandle(paint, 2, {x: 30, y: -30}, w, h), w, h);
  closeVec(narrowed[1], {x: 100, y: 50});
  closeVec(narrowed[2], {x: 50, y: 70});
  // The gradient frame the renderer uses gets exactly those axes.
  const frame = gradientFrame(dragGradientHandle(paint, 2, {x: 30, y: -30}, w, h), w, h);
  closeVec(frame.b, {x: 0, y: 20});
  assert.deepEqual(dragGradientHandle(linear(), 2, {x: 5, y: 5}, w, h), linear().gradientHandlePositions, 'a linear gradient has no width handle');
});

test('stops sit on the axis and a point projects back to its position', () => {
  const handles = linear().gradientHandlePositions;
  closeVec(stopPoint(handles, 200, 100, 0.25), {x: 100, y: 25});
  close(positionOnAxis(handles, 200, 100, {x: 30, y: 75}), 0.75);
  close(positionOnAxis(handles, 200, 100, {x: 30, y: 400}), 1);
});

// ── The tool, driven like the canvas drives it ───────────────────────────────────────────────────

function toolSetup() {
  const tx = beginTransaction(createDocument('page'));
  const paint: GradientPaint = {...linear(), gradientStops: [{position: 0, color: {r: 1, g: 0, b: 0, a: 1}}, {position: 0.5, color: {r: 0, g: 1, b: 0, a: 1}}, {position: 1, color: {r: 0, g: 0, b: 1, a: 1}}]};
  tx.create(createNode('RECTANGLE', {id: 'r', x: 100, y: 100, width: 200, height: 100, fills: [paint]}), 'page');
  const store = createDesignStore({doc: tx.commit({measurer}).doc, measurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  store.setSelection(['r']);
  registerTool('move', () => new GradientEditTool());
  let overlayRequests = 0;
  const ctx: ToolContext = {
    store, measurer,
    view: {viewport: () => ({x: 0, y: 0, zoom: 1}), size: () => ({width: 1000, height: 800}), screenToPage: p => p, pageToScreen: p => p, setViewport: () => {}, pixel: () => 1},
    snap: {snapMove: () => ({dx: 0, dy: 0, guides: []})},
    index: () => null, setCursor: () => {}, requestOverlay: () => void overlayRequests++, setOverlayItems: () => {}, enterEdit: () => {}, setTool: id => store.setTool(id), modifiers: () => ({shift: false, alt: false, mod: false}),
  };
  const event = (x: number, y: number, extra: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
    screen: {x, y}, page: {x, y}, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0, ...extra,
  });
  return {store, ctx, event, paint, overlays: () => overlayRequests};
}

test('the gradient tool drags handles as one undo step and never touches the stops', () => {
  const {store, ctx, event, paint} = toolSetup();
  paintEditSession.start(store, {nodeId: 'r', field: 'fills', index: 0, kind: 'gradient', stop: 0});
  assert.equal(store.getState().tool, GRADIENT_TOOL);
  assert.deepEqual(store.getState().editing, {kind: 'gradient', id: 'r'});
  const tool = new GradientEditTool();
  tool.activate(ctx);
  // H1 (bottom centre) is at page (200, 200).
  tool.onPointerDown(event(200, 200), ctx);
  tool.onPointerMove(event(240, 180), ctx);
  tool.onPointerMove(event(260, 170), ctx);
  tool.onPointerUp(event(260, 170), ctx);
  const after = store.getState().doc.nodes.r.fills[0] as GradientPaint;
  closeVec(after.gradientHandlePositions[1], {x: 0.8, y: 0.7});
  assert.deepEqual(after.gradientStops, paint.gradientStops, 'stops are kept');
  assert.equal(store.getState().history.undo, 'Gradient');
  store.undo();
  assert.deepEqual((store.getState().doc.nodes.r.fills[0] as GradientPaint).gradientHandlePositions, paint.gradientHandlePositions, 'one undo restores the drag');
  paintEditSession.end();
  assert.equal(store.getState().tool, 'move');
  assert.equal(store.getState().editing, null);
});

test('a press on the gradient line adds a stop and drags it; Backspace removes the selected stop, not the layer', () => {
  const {store, ctx, event} = toolSetup();
  paintEditSession.start(store, {nodeId: 'r', field: 'fills', index: 0, kind: 'gradient', stop: 0});
  const tool = new GradientEditTool();
  tool.activate(ctx);
  // The axis runs from (200, 100) to (200, 200); press at 30 %, drag to 25 %.
  tool.onPointerDown(event(200, 130), ctx);
  tool.onPointerMove(event(201, 125), ctx);
  tool.onPointerUp(event(201, 125), ctx);
  let fill = store.getState().doc.nodes.r.fills[0] as GradientPaint;
  assert.equal(fill.gradientStops.length, 4);
  close(fill.gradientStops[3].position, 0.25);
  assert.equal(paintEditSession.get()?.stop, 3);
  assert.equal(store.getState().history.undo, 'Gradient stop');
  const used = tool.onKeyDown({type: 'keydown', code: 'Backspace', key: 'Backspace', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false}, ctx);
  assert.equal(used, true);
  fill = store.getState().doc.nodes.r.fills[0] as GradientPaint;
  assert.equal(fill.gradientStops.length, 3);
  assert.ok(store.getState().doc.nodes.r, 'the layer stays');
  // Escape ends gradient editing.
  tool.onKeyDown({type: 'keydown', code: 'Escape', key: 'Escape', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false}, ctx);
  assert.equal(paintEditSession.get(), null);
  assert.equal(store.getState().tool, 'move');
});

// ── Cropping ─────────────────────────────────────────────────────────────────────────────────────

const picture = (partial: Partial<ImagePaint> = {}): ImagePaint => ({type: 'IMAGE', imageRef: 'img', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL', ...partial});

function sameMatrix(a: Matrix, b: Matrix, eps = 1e-9) {
  for (let i = 0; i < 2; i++) for (let j = 0; j < 3; j++) close(a[i][j], b[i][j], eps);
}

test('entering crop keeps the picture where FILL, FIT and a quarter turn showed it', () => {
  for (const paint of [picture(), picture({scaleMode: 'FIT'}), picture({rotation: 90})]) {
    const transform = cropTransformFor(paint, 360, 180, 600, 400);
    sameMatrix(imagePlacement({scaleMode: 'CROP', imageTransform: transform}, 360, 180, 600, 400).matrix, imagePlacement(paint, 360, 180, 600, 400).matrix);
  }
  // FILL of a 3:2 picture in a 2:1 box: full width, 30 px cut above and below.
  sameMatrix(cropTransformFor(picture(), 360, 180, 600, 400), [[1, 0, 0], [0, 0.75, 0.125]]);
  const existing: Matrix = [[0.5, 0, 0.1], [0, 0.5, 0.2]];
  assert.equal(cropTransformFor(picture({scaleMode: 'CROP', imageTransform: existing}), 100, 100, 10, 10), existing);
});

test('moving and resizing the picture inside the layer', () => {
  const start = cropTransformFor(picture(), 360, 180, 600, 400);
  const r0 = imageRect(start, 360, 180);
  closeVec(r0, {x: 0, y: -30});
  close(r0.width, 360); close(r0.height, 240);
  const moved = moveImage(start, {x: -40, y: 10}, 360, 180);
  const r1 = imageRect(moved, 360, 180);
  closeVec(r1, {x: -40, y: -20});
  close(r1.width, 360);
  // The bottom-right corner, dragged out: the top-left stays, proportions stay.
  const grown = resizeImage(moved, {hx: 1, hy: 1}, {x: 400, y: 300}, 360, 180);
  const r2 = imageRect(grown, 360, 180);
  closeVec(r2, {x: -40, y: -20});
  close(r2.width / r2.height, 1.5);
  close(r2.width, Math.max(440, 320 * 1.5));
  // Shift frees the proportions; an edge stretches one axis.
  const free = imageRect(resizeImage(moved, {hx: 1, hy: 1}, {x: 400, y: 300}, 360, 180, {free: true}), 360, 180);
  close(free.width, 440); close(free.height, 320);
  const edge = imageRect(resizeImage(moved, {hx: -1, hy: 0}, {x: -100, y: 0}, 360, 180), 360, 180);
  close(edge.x, -100); close(edge.width, 420); close(edge.height, 240);
  // Never inside out.
  const tiny = imageRect(resizeImage(moved, {hx: 1, hy: 0}, {x: -500, y: 0}, 360, 180), 360, 180);
  close(tiny.width, 1);
  // The renderer draws the picture exactly in that rectangle.
  const placed = imagePlacement({scaleMode: 'CROP', imageTransform: grown}, 360, 180, 600, 400).matrix;
  closeVec(apply(placed, {x: 0, y: 0}), {x: r2.x, y: r2.y});
  closeVec(apply(placed, {x: 600, y: 400}), {x: r2.x + r2.width, y: r2.y + r2.height});
});

test('a crop turned four quarter turns is where it started', () => {
  const start = cropTransformFor(picture(), 360, 180, 600, 400);
  let turned = start;
  for (let i = 0; i < 4; i++) turned = rotateCrop(turned, 360, 180);
  sameMatrix(turned, start);
  const quarter = imageRect(rotateCrop(start, 360, 180), 360, 180);
  close(quarter.width, 240); close(quarter.height, 360);
  const m = imageToLocal(start, 360, 180);
  closeVec(apply(invert(m), {x: 0, y: -30}), {x: 0, y: 0});
});
