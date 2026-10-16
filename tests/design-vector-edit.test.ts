import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid} from '../shared/design/defaults';
import {apply, worldMatrix} from '../shared/design/geometry';
import {pathsBounds, pathToAnchors} from '../shared/design/paths';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, GradientPaint, NodeId, SceneNode, Vec} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {registerCoreCommands} from '../src/design/engine/commands';
import {createDesignStore, currentViewport, type DesignStore} from '../src/design/engine/store';
import {createTool, registerCoreTools} from '../src/design/engine/tools';
import {NO_SNAP, type Tool, type ToolContext, type ToolKeyEvent, type ToolPointerEvent} from '../src/design/engine/tools/types';
import {pageToScreen, screenToPage} from '../src/design/engine/viewport';
import {editedVectorId, enterVectorEdit, installVectorEditing, sessionOf, setSelectedKeys} from '../src/design/engine/vector-edit/session';
import {
  bendSegment, deleteAnchors, insertAnchor, keyOf, networkOf, networkOfNode, networkPaths, segmentCubic, toggleSmooth, vectorFields, type Network,
} from '../src/design/engine/vector-edit/model';
import {cubicPoint} from '../shared/design/paths';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const close = (a: number, b: number, message?: string, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, message ?? `${a} ≈ ${b}`);
const closeVec = (a: Vec, b: Vec, message?: string, eps = 1e-6) => {
  close(a.x, b.x, `${message ?? ''} x: ${a.x} ≈ ${b.x}`, eps);
  close(a.y, b.y, `${message ?? ''} y: ${a.y} ≈ ${b.y}`, eps);
};

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void = () => {}): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

const square = (size = 100) => [{windingRule: 'NONZERO' as const, commands: [{type: 'M' as const, x: 0, y: 0}, {type: 'L' as const, x: size, y: 0}, {type: 'L' as const, x: size, y: size}, {type: 'L' as const, x: 0, y: size}, {type: 'Z' as const}]}];

function harness(doc: DesignDocument, tool = 'move') {
  registerCoreTools();
  registerCoreCommands();
  const store = createDesignStore({doc, measurer, tool});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const messages: string[] = [];
  installVectorEditing(store, {notify: message => void messages.push(message)});
  const tools = new Map<string, Tool>();
  let active: Tool | null = null;
  const ctx: ToolContext = {
    store, measurer,
    view: {
      viewport: () => currentViewport(store.getState()),
      size: () => ({width: 1000, height: 800}),
      screenToPage: p => screenToPage(currentViewport(store.getState()), p),
      pageToScreen: p => pageToScreen(currentViewport(store.getState()), p),
      setViewport: v => store.setViewport(v),
      pixel: () => 1 / currentViewport(store.getState()).zoom,
    },
    snap: NO_SNAP, index: () => null, setCursor: () => {}, requestOverlay: () => {}, setOverlayItems: () => {},
    enterEdit: id => store.setEditing({kind: 'vector', id}),
    setTool: id => store.setTool(id),
    modifiers: () => ({shift: false, alt: false, mod: false}),
  };
  const current = (): Tool => {
    const id = store.getState().tool;
    let tool = tools.get(id);
    if (!tool) tools.set(id, tool = createTool(id)!);
    if (tool !== active) {
      active?.deactivate?.(ctx);
      active = tool;
      tool.activate?.(ctx);
    }
    return tool;
  };
  const ev = (page: Vec, mods: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
    screen: pageToScreen(currentViewport(store.getState()), page), page, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false,
    pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0, ...mods,
  });
  const click = (at: Vec, mods: Partial<ToolPointerEvent> = {}) => {
    const tool = current();
    tool.onPointerMove?.(ev(at, {...mods, buttons: 0}), ctx);
    tool.onPointerDown?.(ev(at, mods), ctx);
    tool.onPointerUp?.(ev(at, {...mods, buttons: 0}), ctx);
  };
  const drag = (from: Vec, to: Vec, mods: Partial<ToolPointerEvent> = {}) => {
    const tool = current();
    tool.onPointerMove?.(ev(from, {...mods, buttons: 0}), ctx);
    tool.onPointerDown?.(ev(from, mods), ctx);
    for (let i = 1; i <= 4; i++) tool.onPointerMove?.(ev({x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4}, mods), ctx);
    tool.onPointerUp?.(ev(to, {...mods, buttons: 0}), ctx);
  };
  const dblclick = (at: Vec) => current().onDoubleClick?.(ev(at, {detail: 2}), ctx);
  const key = (code: string, mods: Partial<ToolKeyEvent> = {}) =>
    current().onKeyDown?.({type: 'keydown', code, key: code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false, ...mods}, ctx) === true;
  const edit = (id: NodeId) => {
    store.setSelection([id]);
    store.setEditing({kind: 'vector', id});
    current();
  };
  return {store, ctx, click, drag, dblclick, key, edit, current, messages};
}

/** Anchors of a node in page space. */
function pageAnchors(store: DesignStore, id: NodeId) {
  const {doc} = store.getState();
  const node = doc.nodes[id];
  const world = worldMatrix(doc, id);
  return networkOfNode(node).flatMap(path => path.subs).map(sub => ({
    closed: sub.closed,
    anchors: sub.anchors.map(a => ({...apply(world, a), in: a.in && apply(world, a.in), out: a.out && apply(world, a.out), kind: a.kind})),
  }));
}

const boxOf = (store: DesignStore, id: NodeId) => {
  const n = store.getState().doc.nodes[id];
  return [n.x, n.y, n.width, n.height];
};

// ── The model ────────────────────────────────────────────────────────────────────────────────────

test('re-fitting the box keeps every point where it was, rotated and flipped nodes too', () => {
  const node = createNode('VECTOR', {id: 'v', parentId: 'page', x: 40, y: 30, width: 100, height: 100, rotation: 30, flipX: true, vectorPaths: square()});
  const network = networkOfNode(node);
  // Move the top-right anchor out of the box.
  network[0].subs[0].anchors[1].x = 150;
  network[0].subs[0].anchors[1].y = -20;
  const fields = vectorFields(node, network)!;
  const placed = {...node, ...fields} as SceneNode;
  assert.deepEqual([fields.width, fields.height], [150, 120]);
  const local = pathsBounds(placed.vectorPaths![0].commands ? placed.vectorPaths! : [])!;
  assert.deepEqual([local.x, local.y], [0, 0], 'the paths start at the box corner');
  const before = (p: Vec) => apply(worldMatrixOf(node), p);
  const after = (p: Vec) => apply(worldMatrixOf(placed), p);
  const anchors = pathToAnchors(placed.vectorPaths![0].commands)[0].anchors;
  closeVec(after(anchors[0]), before({x: 0, y: 0}), 'untouched anchor');
  closeVec(after(anchors[1]), before({x: 150, y: -20}), 'moved anchor');
  closeVec(after(anchors[2]), before({x: 100, y: 100}), 'untouched anchor');
  assert.equal(fields.rotation, undefined, 'rotation stays');
});

function worldMatrixOf(node: SceneNode) {
  const doc = createDocument('page');
  doc.nodes[node.id] = {...node, parentId: 'page'};
  doc.nodes.page.children = [node.id];
  return worldMatrix(doc, node.id);
}

test('a shape is edited through its outline and becomes a VECTOR with the same id on the first edit', () => {
  const doc = build(add => add('RECTANGLE', 'r', 'page', {x: 10, y: 20, width: 100, height: 50, cornerRadius: 0}));
  const h = harness(doc);
  h.edit('r');
  assert.equal(h.store.getState().tool, 'vector-edit');
  assert.equal(h.store.getState().doc.nodes.r.type, 'RECTANGLE', 'entering alone converts nothing');
  // Drag the bottom-right corner 20 px right.
  h.drag({x: 110, y: 70}, {x: 130, y: 70});
  const node = h.store.getState().doc.nodes.r;
  assert.equal(node.type, 'VECTOR');
  assert.equal(node.cornerRadius, undefined);
  assert.deepEqual(boxOf(h.store, 'r'), [10, 20, 120, 50]);
  assert.deepEqual(pageAnchors(h.store, 'r')[0].anchors.map(a => [a.x, a.y]), [[10, 20], [110, 20], [130, 70], [10, 70]]);
  // One undo step brings the rectangle back.
  h.store.undo();
  assert.equal(h.store.getState().doc.nodes.r.type, 'RECTANGLE');
  assert.equal(h.store.getState().doc.nodes.r.cornerRadius, 0);
});

test('gradients stay put while the box re-fits', () => {
  const gradient: GradientPaint = {type: 'GRADIENT_LINEAR', opacity: 1, visible: true, blendMode: 'NORMAL', gradientStops: [{position: 0, color: {r: 1, g: 0, b: 0, a: 1}}, {position: 1, color: {r: 0, g: 0, b: 1, a: 1}}], gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}]};
  const doc = build(add => add('VECTOR', 'v', 'page', {x: 0, y: 0, width: 100, height: 100, vectorPaths: square(), fills: [gradient]}));
  const h = harness(doc);
  h.edit('v');
  h.drag({x: 100, y: 100}, {x: 200, y: 100});
  const node = h.store.getState().doc.nodes.v;
  const paint = node.fills[0] as GradientPaint;
  // The gradient ran from x = 0 to x = 100 in page space; in the 200-wide box that is 0 → 0.5.
  close(paint.gradientHandlePositions[1].x * node.width, 100);
});

test('bending a segment puts the curve through the dragged point; insert and delete keep the outline', () => {
  const network = networkOf(square());
  const bent = bendSegment(network, {p: 0, s: 0, a: 0}, 0.5, {x: 50, y: -40});
  const [a, b] = [bent[0].subs[0].anchors[0], bent[0].subs[0].anchors[1]];
  closeVec(cubicPoint(segmentCubic(a, b), 0.5), {x: 50, y: -40});
  // Corners stay corners: the neighbouring segments are untouched.
  assert.equal(bent[0].subs[0].anchors[0].in, null);
  const inserted = insertAnchor(bent, {p: 0, s: 0, a: 0}, 0.25)!;
  assert.equal(inserted.ref.a, 1);
  const before = networkPaths(bent)[0].commands, after = networkPaths(inserted.network)[0].commands;
  const sample = (commands: typeof before) => pathsBounds([{windingRule: 'NONZERO', commands}])!;
  assert.deepEqual(Object.values(sample(after)).map(v => Math.round(v * 1e6)), Object.values(sample(before)).map(v => Math.round(v * 1e6)));
  // Deleting a corner of the square keeps the triangle closed.
  const triangle = deleteAnchors(network, [{p: 0, s: 0, a: 2}]);
  assert.equal(triangle[0].subs[0].closed, true);
  assert.equal(triangle[0].subs[0].anchors.length, 3);
  // A path left with one anchor goes.
  assert.equal(deleteAnchors(networkOf([{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 0}]}]), [{p: 0, s: 0, a: 0}]).length, 0);
  // Double click: corner → mirrored handles along the neighbours, and back.
  const smooth = toggleSmooth(network, {p: 0, s: 0, a: 1});
  assert.equal(smooth[0].subs[0].anchors[1].kind, 'mirrored');
  assert.equal(toggleSmooth(smooth, {p: 0, s: 0, a: 1})[0].subs[0].anchors[1].kind, 'corner');
});

// ── The editor on the canvas ─────────────────────────────────────────────────────────────────────

test('dragging an anchor re-bases the box; nothing else moves; one undo step', () => {
  const doc = build(add => add('VECTOR', 'v', 'page', {x: 100, y: 100, width: 100, height: 100, vectorPaths: square()}));
  const h = harness(doc);
  h.edit('v');
  h.drag({x: 100, y: 100}, {x: 60, y: 80});
  assert.deepEqual(boxOf(h.store, 'v'), [60, 80, 140, 120]);
  assert.deepEqual(pageAnchors(h.store, 'v')[0].anchors.map(a => [a.x, a.y]), [[60, 80], [200, 100], [200, 200], [100, 200]]);
  assert.deepEqual([...sessionOf(h.store).selected], ['0.0.0']);
  h.store.undo();
  assert.deepEqual(boxOf(h.store, 'v'), [100, 100, 100, 100]);
  assert.equal(editedVectorId(h.store.getState()), 'v', 'undo stays in the editor');
});

test('Shift-click and the marquee select anchors; arrows nudge them as one undo step; Backspace deletes', () => {
  const doc = build(add => add('VECTOR', 'v', 'page', {x: 0, y: 0, width: 100, height: 100, vectorPaths: square()}));
  const h = harness(doc);
  h.edit('v');
  h.click({x: 0, y: 0});
  h.click({x: 100, y: 0}, {shiftKey: true});
  assert.deepEqual([...sessionOf(h.store).selected].sort(), ['0.0.0', '0.0.1']);
  // A marquee around the bottom edge (it starts outside the shape).
  h.drag({x: -20, y: 80}, {x: 120, y: 120});
  assert.deepEqual([...sessionOf(h.store).selected].sort(), ['0.0.2', '0.0.3']);
  h.key('ArrowDown');
  h.key('ArrowDown', {shiftKey: true});
  assert.deepEqual(boxOf(h.store, 'v'), [0, 0, 100, 111]);
  h.store.undo();
  assert.deepEqual(boxOf(h.store, 'v'), [0, 0, 100, 100], 'the burst undoes at once');
  h.key('Backspace');
  const sub = pageAnchors(h.store, 'v')[0];
  assert.equal(sub.anchors.length, 2);
  assert.equal(sub.closed, true);
  // Deleting every anchor removes the vector and closes the editor.
  h.key('KeyA', {mod: true});
  h.key('Delete');
  assert.equal(h.store.getState().doc.nodes.v, undefined);
  assert.equal(editedVectorId(h.store.getState()), null);
  assert.equal(h.store.getState().tool, 'move');
});

test('handles: mirrored ones follow, Alt breaks the mirror; ⌘-drag pulls handles out of a corner; dragging a segment bends it', () => {
  const doc = build(add => add('VECTOR', 'v', 'page', {x: 0, y: 0, width: 100, height: 100, vectorPaths: square()}));
  const h = harness(doc);
  h.edit('v');
  // ⌘-drag on the top-right corner: mirrored handles.
  h.drag({x: 100, y: 0}, {x: 130, y: 0}, {mod: true});
  let anchor = pageAnchors(h.store, 'v')[0].anchors[1];
  assert.equal(anchor.kind, 'mirrored');
  closeVec(anchor.out!, {x: 130, y: 0});
  closeVec(anchor.in!, {x: 70, y: 0});
  // Its handles show (it is selected): drag the out handle down; the in handle mirrors.
  h.drag({x: 130, y: 0}, {x: 100, y: 30});
  anchor = pageAnchors(h.store, 'v')[0].anchors[1];
  closeVec(anchor.out!, {x: 100, y: 30});
  closeVec(anchor.in!, {x: 100, y: -30});
  // Alt: only the dragged handle moves.
  h.drag({x: 100, y: 30}, {x: 120, y: 30}, {altKey: true});
  anchor = pageAnchors(h.store, 'v')[0].anchors[1];
  closeVec(anchor.out!, {x: 120, y: 30});
  closeVec(anchor.in!, {x: 100, y: -30});
  assert.equal(anchor.kind, 'corner');
  // The bottom edge, dragged down from its middle, bends through the pointer.
  setSelectedKeys(h.store, []);
  h.drag({x: 50, y: 100}, {x: 50, y: 140});
  const node = h.store.getState().doc.nodes.v;
  const sub = networkOfNode(node)[0].subs[0];
  const world = worldMatrix(h.store.getState().doc, 'v');
  closeVec(apply(world, cubicPoint(segmentCubic(sub.anchors[2], sub.anchors[3]), 0.5)), {x: 50, y: 140}, 'bent through the pointer', 1e-3);
});

test('double click on an anchor switches corner and smooth; Enter and Esc leave the editor', () => {
  const doc = build(add => add('VECTOR', 'v', 'page', {x: 0, y: 0, width: 100, height: 100, vectorPaths: square()}));
  const h = harness(doc);
  h.edit('v');
  h.click({x: 100, y: 0});
  h.dblclick({x: 100, y: 0});
  assert.equal(pageAnchors(h.store, 'v')[0].anchors[1].kind, 'mirrored');
  h.click({x: 100, y: 0});
  h.dblclick({x: 100, y: 0});
  assert.equal(pageAnchors(h.store, 'v')[0].anchors[1].kind, 'corner');
  assert.ok(h.key('Enter'));
  assert.equal(editedVectorId(h.store.getState()), null);
  assert.equal(h.store.getState().tool, 'move');
  assert.deepEqual(h.store.getState().selection, ['v']);
  h.edit('v');
  assert.ok(h.key('Escape'));
  assert.equal(editedVectorId(h.store.getState()), null);
});

test('the editor keeps the store consistent: other tools, other selections and refusals', () => {
  const doc = build(add => {
    add('VECTOR', 'v', 'page', {x: 0, y: 0, width: 100, height: 100, vectorPaths: square()});
    add('RECTANGLE', 'r', 'page', {x: 200, y: 0});
    add('RECTANGLE', 'a', 'page', {x: 0, y: 200});
    add('BOOLEAN_OPERATION', 'b', 'page', {x: 400, y: 0});
    add('RECTANGLE', 'b1', 'b', {x: 0, y: 0});
  });
  const h = harness(doc);
  h.edit('v');
  h.store.setTool('rectangle');
  assert.equal(editedVectorId(h.store.getState()), null, 'another tool leaves the editor');
  h.store.setTool('move');
  h.edit('v');
  h.store.setSelection(['r']);
  assert.equal(editedVectorId(h.store.getState()), null, 'another selection leaves the editor');
  // The bar's tools stay inside.
  h.edit('v');
  h.store.setTool('vector-bend');
  h.store.setTool('pen');
  h.store.setTool('vector-edit');
  assert.equal(editedVectorId(h.store.getState()), 'v');
  assert.ok(h.key('KeyP'));
  assert.equal(h.store.getState().tool, 'pen');
  assert.ok(h.key('KeyV'));
  assert.equal(h.store.getState().tool, 'vector-edit');
  h.key('Escape');
  // A boolean is refused with a reason.
  h.store.setSelection(['b']);
  h.store.setEditing({kind: 'vector', id: 'b'});
  assert.equal(editedVectorId(h.store.getState()), null);
  assert.match(h.messages.at(-1) ?? '', /flatten it first/);
  assert.equal(enterVectorEdit(h.store, 'b'), false);
});

test('anchors of a closed shape: the editor shows only the handles next to the selection', () => {
  const doc = build(add => add('ELLIPSE', 'e', 'page', {x: 0, y: 0, width: 100, height: 100, fills: [solid({r: 1, g: 0, b: 0})]}));
  const h = harness(doc);
  h.edit('e');
  const network: Network = networkOfNode(h.store.getState().doc.nodes.e);
  assert.equal(network[0].subs[0].anchors.length, 4);
  // Click the right-most anchor of the circle, then drag its out handle: the circle stays smooth.
  h.click({x: 100, y: 50});
  assert.deepEqual([...sessionOf(h.store).selected], [keyOf({p: 0, s: 0, a: 0})]);
  const anchor = network[0].subs[0].anchors[0];
  h.drag(anchor.out!, {x: anchor.out!.x + 10, y: anchor.out!.y});
  const after = pageAnchors(h.store, 'e')[0].anchors[0];
  assert.equal(h.store.getState().doc.nodes.e.type, 'VECTOR');
  assert.notEqual(after.kind, 'corner');
});
