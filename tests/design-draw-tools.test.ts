import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode, Vec} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {createDesignStore, currentViewport, type DocumentChange} from '../src/design/engine/store';
import {SpatialIndex} from '../src/design/engine/render/spatial-index';
import {adoptable, dragLine, dragRect, lineFields, type DrawTool} from '../src/design/engine/tools/draw-common';
import {createFrameTool} from '../src/design/engine/tools/frame';
import {completeUpload, fitImageSize, imageNode, isImageFile, layerNameFromFile, looksLikeSvg, placedImageSize} from '../src/design/engine/tools/image';
import {createScaleTool, scaleFromHandle} from '../src/design/engine/tools/scale';
import {createSectionTool} from '../src/design/engine/tools/section';
import {createArrowTool, createEllipseTool, createLineTool, createRectangleTool} from '../src/design/engine/tools/shapes';
import {NO_SNAP, type SnapHook, type Tool, type ToolContext, type ToolPointerEvent} from '../src/design/engine/tools/types';
import {pageToScreen, screenToPage} from '../src/design/engine/viewport';
import {FRAME_PRESET_GROUPS, framePresetsVisible, insertPresetFrame, presetPlacement} from '../src/design/panels/frame-presets';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const r = (x: number, y: number, width: number, height: number) => ({x, y, width, height});
const close = (a: number, b: number, message?: string) => assert.ok(Math.abs(a - b) < 1e-6, message ?? `${a} ≈ ${b}`);

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void = () => {}): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

function harness(doc: DesignDocument, make: () => Tool, toolId: string, snap: SnapHook = NO_SNAP) {
  const store = createDesignStore({doc, measurer, tool: toolId});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const tool = make();
  const held = {shift: false, alt: false, mod: false};
  const ctx: ToolContext = {
    store,
    measurer,
    view: {
      viewport: () => currentViewport(store.getState()),
      size: () => ({width: 1000, height: 800}),
      screenToPage: p => screenToPage(currentViewport(store.getState()), p),
      pageToScreen: p => pageToScreen(currentViewport(store.getState()), p),
      setViewport: v => store.setViewport(v),
      pixel: () => 1 / currentViewport(store.getState()).zoom,
    },
    snap,
    index: () => null,
    setCursor: () => {},
    requestOverlay: () => {},
    setOverlayItems: () => {},
    enterEdit: () => {},
    setTool: id => store.setTool(id),
    modifiers: () => ({...held}),
  };
  const ev = (x: number, y: number, mods: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
    screen: {x, y}, page: {x, y}, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false,
    pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0, ...mods,
  });
  const drag = (from: Vec, to: Vec, mods: Partial<ToolPointerEvent> = {}) => {
    tool.onPointerDown!(ev(from.x, from.y, mods), ctx);
    for (let i = 1; i <= 4; i++) tool.onPointerMove!(ev(from.x + ((to.x - from.x) * i) / 4, from.y + ((to.y - from.y) * i) / 4, mods), ctx);
    tool.onPointerUp!(ev(to.x, to.y, {...mods, buttons: 0}), ctx);
  };
  const click = (x: number, y: number, mods: Partial<ToolPointerEvent> = {}) => {
    tool.onPointerDown!(ev(x, y, mods), ctx);
    tool.onPointerUp!(ev(x, y, {...mods, buttons: 0}), ctx);
  };
  const created = () => store.getState().selection[0];
  return {store, tool, ctx, ev, drag, click, created};
}

// ── Geometry ─────────────────────────────────────────────────────────────────────────────────────

test('a drag draws from the corner; Shift squares it, Alt grows it from the centre', () => {
  assert.deepEqual(dragRect({x: 10, y: 10}, {x: 60, y: 40}), r(10, 10, 50, 30));
  assert.deepEqual(dragRect({x: 60, y: 40}, {x: 10, y: 10}), r(10, 10, 50, 30), 'any direction');
  assert.deepEqual(dragRect({x: 10, y: 10}, {x: 60, y: 40}, {square: true}), r(10, 10, 50, 50), 'the longer side leads');
  assert.deepEqual(dragRect({x: 10, y: 10}, {x: -20, y: 30}, {square: true}), r(-20, 10, 30, 30), 'towards the lower left');
  assert.deepEqual(dragRect({x: 100, y: 100}, {x: 130, y: 120}, {fromCenter: true}), r(70, 80, 60, 40));
  assert.deepEqual(dragRect({x: 100, y: 100}, {x: 130, y: 120}, {fromCenter: true, square: true}), r(70, 70, 60, 60));
  assert.deepEqual(dragRect({x: 0, y: 0}, {x: 40, y: 100}, {ratio: 2}), r(0, 0, 200, 100), 'a picture keeps its proportions');
});

test('lines: Shift keeps 45° steps, Alt grows both ways; LINE fields', () => {
  const snapped = dragLine({x: 0, y: 0}, {x: 100, y: 8}, {square: true});
  assert.deepEqual(snapped.to, {x: 100, y: 0}, 'flat, ending under the pointer');
  const diagonal = dragLine({x: 0, y: 0}, {x: 50, y: 45}, {square: true});
  close(diagonal.to.x, diagonal.to.y, '45°');
  assert.deepEqual(dragLine({x: 50, y: 50}, {x: 60, y: 50}, {fromCenter: true}), {from: {x: 40, y: 50}, to: {x: 60, y: 50}});
  const up = lineFields({x: 0, y: 100}, {x: 100, y: 0});
  close(up.width, Math.hypot(100, 100));
  assert.equal(up.rotation, 45, 'rising to the right turns counter-clockwise');
  assert.equal(up.height, 0);
});

// ── The tools ────────────────────────────────────────────────────────────────────────────────────

test('drawing snaps to what is around; Control suspends it, ⌘ does not (Figma)', () => {
  const draw = (mods: Partial<ToolPointerEvent>) => {
    // Every point snaps to the nearest multiple of 50.
    const snap: SnapHook = {...NO_SNAP, snapPoint: point => ({x: Math.round(point.x / 50) * 50, y: Math.round(point.y / 50) * 50, guides: []})};
    const {store, drag, created} = harness(build(), createRectangleTool, 'rectangle', snap);
    drag({x: 12, y: 13}, {x: 108, y: 91}, mods);
    const node = store.getState().doc.nodes[created()];
    return [node.x, node.y, node.width, node.height];
  };
  assert.deepEqual(draw({}), [0, 0, 100, 100]);
  assert.deepEqual(draw({mod: true, metaKey: true}), [0, 0, 100, 100], '⌘ still snaps');
  assert.deepEqual(draw({ctrlKey: true}), [12, 13, 96, 78], 'Control: whole pixels only');
});

test('rectangle: drag draws, names, selects, one undo step, back to Move', () => {
  const doc = build(add => add('RECTANGLE', 'old', 'page', {name: 'Rectangle 1', x: 500, y: 500}));
  const {store, drag, created} = harness(doc, createRectangleTool, 'rectangle');
  drag({x: 10.4, y: 20}, {x: 110, y: 70.6});
  const id = created();
  const node = store.getState().doc.nodes[id];
  assert.equal(node.type, 'RECTANGLE');
  assert.equal(node.name, 'Rectangle 2');
  assert.deepEqual([node.x, node.y, node.width, node.height], [10, 20, 100, 51], 'whole pixels');
  assert.equal(node.parentId, 'page');
  assert.equal(store.getState().tool, 'move');
  assert.equal(store.getState().history.undo, 'Rectangle');
  store.undo();
  assert.equal(store.getState().doc.nodes[id], undefined);
});

test('a click makes 100 × 100 from the corner, or around the pointer with Alt', () => {
  const {store, click, created} = harness(build(), createEllipseTool, 'ellipse');
  click(30, 40);
  const node = store.getState().doc.nodes[created()];
  assert.deepEqual([node.type, node.x, node.y, node.width, node.height], ['ELLIPSE', 30, 40, 100, 100]);
  const again = harness(build(), createRectangleTool, 'rectangle');
  again.click(200, 200, {altKey: true});
  const centred = again.store.getState().doc.nodes[again.created()];
  assert.deepEqual([centred.x, centred.y], [150, 150]);
});

test('new layers go into the frame under the pointer, in its space', () => {
  const doc = build(add => add('FRAME', 'f', 'page', {x: 100, y: 100, width: 400, height: 400}));
  const {store, drag, created} = harness(doc, createRectangleTool, 'rectangle');
  drag({x: 150, y: 160}, {x: 250, y: 260});
  const node = store.getState().doc.nodes[created()];
  assert.equal(node.parentId, 'f');
  assert.deepEqual([node.x, node.y, node.width, node.height], [50, 60, 100, 100]);
  assert.equal(node.name, 'Rectangle 1');
  // A second one on the canvas, outside the frame: numbered after the first, wherever it is (Figma).
  const next = harness(store.getState().doc, createRectangleTool, 'rectangle');
  next.drag({x: 600, y: 160}, {x: 700, y: 260});
  const second = next.store.getState().doc.nodes[next.created()];
  assert.deepEqual([second.parentId, second.name], ['page', 'Rectangle 2']);
});

test('Shift and Alt pressed during the drag change it, Space moves it, Esc cancels', () => {
  const h = harness(build(), createRectangleTool, 'rectangle');
  const tool = h.tool as DrawTool;
  tool.onPointerDown(h.ev(0, 0), h.ctx);
  tool.onPointerMove(h.ev(50, 20), h.ctx);
  tool.onPointerMove(h.ev(50, 20, {shiftKey: true}), h.ctx);
  let node = h.store.getState().doc.nodes[h.created()];
  assert.deepEqual([node.width, node.height], [50, 50]);
  tool.setSpace(true);
  tool.onPointerMove(h.ev(80, 30, {shiftKey: true}), h.ctx);
  node = h.store.getState().doc.nodes[h.created()];
  assert.deepEqual([node.x, node.y, node.width, node.height], [30, 10, 50, 50], 'Space moves the shape with the pointer');
  tool.setSpace(false);
  tool.onPointerMove(h.ev(130, 30), h.ctx);
  node = h.store.getState().doc.nodes[h.created()];
  assert.deepEqual([node.x, node.y, node.width, node.height], [30, 10, 100, 20]);
  assert.ok(tool.onKeyDown({type: 'keydown', code: 'Escape', key: 'Escape', shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false}, h.ctx));
  assert.equal(Object.values(h.store.getState().doc.nodes).filter(n => n.type === 'RECTANGLE').length, 0, 'nothing drawn');
  assert.equal(h.store.getState().history.undo, null);
});

test('lines and arrows: ends where dragged, an arrowhead at the end', () => {
  const line = harness(build(), createLineTool, 'line');
  line.drag({x: 0, y: 100}, {x: 100, y: 0});
  const node = line.store.getState().doc.nodes[line.created()];
  assert.equal(node.type, 'LINE');
  close(node.width, Math.hypot(100, 100));
  assert.equal(node.rotation, 45);
  assert.deepEqual([node.x, node.y], [0, 100]);
  const arrow = harness(build(), createArrowTool, 'arrow');
  arrow.drag({x: 0, y: 0}, {x: 100, y: 6}, {shiftKey: true});
  const head = arrow.store.getState().doc.nodes[arrow.created()];
  assert.equal(head.strokeEndMarker, 'LINE_ARROW');
  assert.equal(head.rotation, 0, 'Shift: flat');
  assert.equal(head.name, 'Arrow 1');
  arrow.store.setTool('arrow');
  arrow.click(0, 300);
  const clicked = arrow.store.getState().doc.nodes[arrow.created()];
  assert.deepEqual([clicked.width, clicked.rotation], [100, 0]);
});

test('a frame drawn around layers takes in the ones it encloses', () => {
  const doc = build(add => {
    add('RECTANGLE', 'inside', 'page', {x: 20, y: 20, width: 40, height: 40});
    add('ELLIPSE', 'also', 'page', {x: 100, y: 30, width: 20, height: 20});
    add('RECTANGLE', 'across', 'page', {x: 150, y: 150, width: 100, height: 100});
    add('RECTANGLE', 'hidden', 'page', {x: 30, y: 100, width: 10, height: 10, visible: false});
  });
  const {store, drag, created} = harness(doc, createFrameTool, 'frame');
  drag({x: 0, y: 0}, {x: 200, y: 200});
  const next = store.getState().doc;
  const frame = next.nodes[created()];
  assert.equal(frame.type, 'FRAME');
  assert.deepEqual(frame.children, ['inside', 'also']);
  assert.equal(next.nodes.across.parentId, 'page', 'partly outside: stays');
  assert.equal(next.nodes.hidden.parentId, 'page');
  assert.deepEqual([worldBox(next, 'inside').x, worldBox(next, 'inside').y], [20, 20], 'adopted layers keep their place');
  store.undo();
  assert.equal(store.getState().doc.nodes.inside.parentId, 'page', 'one undo step');
  assert.deepEqual(adoptable(doc, 'page', r(0, 0, 0, 0), 'FRAME'), [], 'a frame with no size adopts nothing');
});

test('sections live on the canvas and take in frames; frames never take sections', () => {
  const doc = build(add => {
    add('FRAME', 'f', 'page', {x: 0, y: 0, width: 300, height: 300});
    add('SECTION', 's', 'page', {x: 400, y: 0, width: 100, height: 100});
  });
  const section = harness(doc, createSectionTool, 'section');
  section.drag({x: 50, y: 50}, {x: 120, y: 120});
  assert.equal(section.store.getState().doc.nodes[section.created()].parentId, 'page', 'drawn over a frame, still on the canvas');
  const around = harness(doc, createSectionTool, 'section');
  around.drag({x: -20, y: -20}, {x: 320, y: 320});
  assert.deepEqual(around.store.getState().doc.nodes[around.created()].children, ['f']);
  assert.deepEqual(adoptable(doc, 'page', r(350, -10, 200, 200), 'FRAME'), []);
});

test('scale tool: proportional about the opposite side, strokes and radii included', () => {
  const box = {matrix: [[1, 0, 10], [0, 1, 20]] as [[number, number, number], [number, number, number]], width: 100, height: 50, nodeId: 'a'};
  const right = scaleFromHandle(box, {hx: 1, hy: 0}, {x: 100, y: 25}, {x: 150, y: 25}, false);
  assert.equal(right.factor, 1.5);
  assert.deepEqual(right.origin, {x: 10, y: 45}, 'the left edge’s middle stays');
  const centred = scaleFromHandle(box, {hx: 1, hy: 1}, {x: 100, y: 50}, {x: 125, y: 50}, true);
  assert.equal(centred.factor, 1.5);
  assert.deepEqual(centred.origin, {x: 60, y: 45});
  const doc = build(add => add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 100, height: 50, strokeWeight: 2, cornerRadius: 8}));
  const h = harness(doc, createScaleTool, 'scale');
  h.store.setSelection(['a']);
  h.drag({x: 100, y: 50}, {x: 200, y: 50});
  const node = h.store.getState().doc.nodes.a;
  assert.deepEqual([node.x, node.y, node.width, node.height, node.strokeWeight, node.cornerRadius], [0, 0, 200, 100, 4, 16]);
  h.drag({x: 50, y: 50}, {x: 60, y: 60});
  assert.deepEqual([h.store.getState().doc.nodes.a.x, h.store.getState().doc.nodes.a.y], [10, 10], 'away from the handles it moves like "Move"');
});

test('the spatial index follows a drawn shape through a gesture that reuses its node table', () => {
  // The store lends a drag one node table frame after frame, so consecutive documents share it.
  const store = createDesignStore({doc: build(), measurer, tool: 'rectangle'});
  const index = new SpatialIndex();
  index.sync(store.getState().doc, 'page', measurer);
  store.onDocument((change: DocumentChange) => void index.sync(change.doc, 'page', measurer, {from: index.document!, ids: change.changed}));
  const h = harness(store.getState().doc, createRectangleTool, 'rectangle');
  const gesture = store.gesture('Rectangle');
  for (const width of [10, 60, 120]) {
    gesture.update(tx => tx.create(createNode('RECTANGLE', {id: 'new', x: 0, y: 0, width, height: 20}), 'page'));
    assert.equal(index.bounds('new')?.width, width, `${width} px wide on that frame`);
  }
  gesture.commit();
  assert.equal(index.bounds('new')?.width, 120);
  void h;
});

// ── Frame sizes and pictures ─────────────────────────────────────────────────────────────────────

test('frame presets: every group filled, placed right of the last frame, shown with the frame tool', () => {
  assert.deepEqual(FRAME_PRESET_GROUPS.map(group => group.label), ['Phone', 'Tablet', 'Desktop', 'Presentation', 'Watch', 'Social', 'Marketplaces', 'Paper']);
  const phone = FRAME_PRESET_GROUPS[0].presets[0];
  assert.deepEqual([phone.name, phone.width, phone.height], ['iPhone 16', 393, 852]);
  assert.ok(FRAME_PRESET_GROUPS.flatMap(group => group.presets).some(preset => preset.name === 'A4' && preset.width === 595 && preset.height === 842));
  assert.ok(framePresetsVisible({tool: 'frame'}) && !framePresetsVisible({tool: 'move'}));
  const empty = build();
  assert.deepEqual(presetPlacement(empty, 'page', {width: 400, height: 300}, {x: 500, y: 500}), {x: 300, y: 350}, 'centred in the view');
  const doc = build(add => {
    add('FRAME', 'a', 'page', {x: 0, y: 0, width: 393, height: 852});
    add('RECTANGLE', 'blocker', 'page', {x: 500, y: 100, width: 50, height: 50});
  });
  assert.deepEqual(presetPlacement(doc, 'page', {width: 393, height: 852}, {x: 0, y: 0}), {x: 650, y: 0}, 'past what it would cover');
  const store = createDesignStore({doc, measurer, tool: 'frame'});
  const id = insertPresetFrame(store, phone, {x: 0, y: 0});
  const frame = store.getState().doc.nodes[id];
  assert.deepEqual([frame.name, frame.x, frame.width, frame.height], ['iPhone 16', 650, 393, 852]);
  assert.deepEqual(store.getState().selection, [id]);
  assert.equal(store.getState().tool, 'move');
});

test('a placed picture is one undo step; a copy made while it uploads gets the picture too', async () => {
  const store = createDesignStore({doc: build(), measurer});
  let finish: (ref: string) => void = () => {};
  const services = {
    upload: () => new Promise<{ref: string}>(resolve => (finish = ref => {
      // As the editor's service does: the picture's record, with no undo step of its own.
      store.transact('Image', tx => tx.setImage(ref, {url: `/uploads/${ref}.png`, width: 64, height: 48, name: 'pic'}), {history: false});
      resolve({ref});
    })),
    toast: () => {},
  };
  store.transact('Paste image', tx => tx.create(imageNode('pic', 'pic', r(0, 0, 64, 48)), 'page'), {select: ['pic']});
  const uploading = completeUpload(store, services as never, 'pic', new Blob(), 'pic');
  // ⌘D while the upload runs (the copy shares the waiting fill, as cloneSubtrees copies it).
  const original = store.getState().doc.nodes.pic;
  store.transact('Duplicate', tx => tx.create({...original, id: 'copy', x: 100}, 'page'));
  finish('dz-ref');
  assert.equal(await uploading, true);
  const refOf = (id: string) => {
    const paint = store.getState().doc.nodes[id]?.fills[0];
    return paint?.type === 'IMAGE' ? paint.imageRef : undefined;
  };
  assert.equal(refOf('pic'), 'dz-ref');
  assert.equal(refOf('copy'), 'dz-ref', 'the copy made during the upload shows the picture');
  assert.equal(store.getState().history.undo, 'Duplicate', 'the upload adds no undo step');
  store.undo();
  store.undo();
  assert.equal(store.getState().doc.nodes.pic, undefined, 'two actions, two undos: the picture is gone');
  store.redo();
  assert.equal(refOf('pic'), 'dz-ref', 'redo brings the picture back with its image, not an empty placeholder');
  store.redo();
  assert.equal(refOf('copy'), 'dz-ref');

  // The placed layer's fill edited before the upload lands (its opacity): it still gets the picture, in history too.
  let land: (ref: string) => void = () => {};
  const slow = {upload: () => new Promise<{ref: string}>(resolve => (land = ref => resolve({ref}))), toast: () => {}};
  store.transact('Paste image', tx => tx.create(imageNode('second', 'second', r(0, 200, 64, 48)), 'page'));
  const second = completeUpload(store, slow as never, 'second', new Blob(), 'second');
  const paint = store.getState().doc.nodes.second.fills[0];
  store.transact('Opacity', tx => tx.update('second', {fills: [{...paint, opacity: 0.5}]}));
  land('dz-second');
  assert.equal(await second, true);
  assert.equal(refOf('second'), 'dz-second');
  store.undo();
  store.redo();
  assert.equal(refOf('second'), 'dz-second', 'redo of the opacity edit keeps the picture');
});

test('pictures: placed at their natural size (Figma caps a side at 4096), names from files, SVG recognised', () => {
  assert.deepEqual(fitImageSize(400, 300, {width: 800, height: 600}), {width: 400, height: 300});
  assert.deepEqual(fitImageSize(4000, 3000, {width: 800, height: 600}), {width: 800, height: 600});
  assert.deepEqual(fitImageSize(1000, 3000, {width: 800, height: 600}), {width: 200, height: 600});
  assert.deepEqual(placedImageSize(393, 852), {width: 393, height: 852}, 'a phone screenshot keeps its pixels, whatever the zoom');
  assert.deepEqual(placedImageSize(8192, 2048), {width: 4096, height: 1024});
  assert.deepEqual(placedImageSize(3000, 5000), {width: 2458, height: 4096});
  assert.equal(layerNameFromFile('Photo from the sea.JPEG'), 'Photo from the sea');
  assert.equal(layerNameFromFile('.png'), 'Image');
  assert.ok(isImageFile({name: 'a.webp', type: 'image/webp'}) && isImageFile({name: 'icon.svg', type: ''}) && !isImageFile({name: 'doc.pdf', type: 'application/pdf'}));
  assert.ok(looksLikeSvg('  <svg xmlns="http://www.w3.org/2000/svg"></svg>'));
  assert.ok(looksLikeSvg('<?xml version="1.0"?>\n<svg viewBox="0 0 1 1"/>'));
  assert.ok(!looksLikeSvg('<div>svg</div>') && !looksLikeSvg('just text'));
});
