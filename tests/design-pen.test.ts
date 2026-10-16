import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {apply, worldMatrix} from '../shared/design/geometry';
import {pathToAnchors} from '../shared/design/paths';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode, Vec} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {registerCoreCommands} from '../src/design/engine/commands';
import {createDesignStore, currentViewport, type DesignStore} from '../src/design/engine/store';
import {createTool, registerCoreTools} from '../src/design/engine/tools';
import {pencilNetwork} from '../src/design/engine/tools/pencil';
import {NO_SNAP, type Tool, type ToolContext, type ToolKeyEvent, type ToolPointerEvent} from '../src/design/engine/tools/types';
import {pageToScreen, screenToPage} from '../src/design/engine/viewport';
import {editedVectorId, installVectorEditing, sessionOf} from '../src/design/engine/vector-edit/session';
import {constrain45, networkOfNode} from '../src/design/engine/vector-edit/model';

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const close = (a: number, b: number, message?: string, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, message ?? `${a} ≈ ${b}`);

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void = () => {}): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

/** A canvas without a DOM: the store's tool gets the events, switching as the canvas would. */
function harness(doc: DesignDocument, tool = 'pen') {
  registerCoreTools();
  registerCoreCommands();
  const store = createDesignStore({doc, measurer, tool});
  store.setViewport({x: 0, y: 0, zoom: 1});
  const messages: string[] = [];
  installVectorEditing(store, {notify: message => void messages.push(message)});
  const tools = new Map<string, Tool>();
  let active: Tool | null = null;
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
    snap: NO_SNAP,
    index: () => null,
    setCursor: () => {},
    requestOverlay: () => {},
    setOverlayItems: () => {},
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
  const toScreen = (p: Vec) => pageToScreen(currentViewport(store.getState()), p);
  const ev = (page: Vec, mods: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
    screen: toScreen(page), page, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false,
    pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0, ...mods,
  });
  const hover = (at: Vec, mods: Partial<ToolPointerEvent> = {}) => current().onPointerMove?.(ev(at, {...mods, buttons: 0}), ctx);
  const click = (at: Vec, mods: Partial<ToolPointerEvent> = {}) => {
    hover(at, mods);
    const tool = current();
    tool.onPointerDown?.(ev(at, mods), ctx);
    tool.onPointerUp?.(ev(at, {...mods, buttons: 0}), ctx);
  };
  const drag = (from: Vec, to: Vec, mods: Partial<ToolPointerEvent> | ((step: number) => Partial<ToolPointerEvent>) = {}) => {
    const at = (step: number) => (typeof mods === 'function' ? mods(step) : mods);
    hover(from, at(0));
    const tool = current();
    tool.onPointerDown?.(ev(from, at(0)), ctx);
    for (let i = 1; i <= 4; i++) tool.onPointerMove?.(ev({x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4}, at(i)), ctx);
    tool.onPointerUp?.(ev(to, {...at(4), buttons: 0}), ctx);
  };
  const dblclick = (at: Vec) => current().onDoubleClick?.(ev(at, {detail: 2}), ctx);
  const key = (code: string, mods: Partial<ToolKeyEvent> = {}) =>
    current().onKeyDown?.({type: 'keydown', code, key: code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false, ...mods}, ctx) === true;
  return {store, ctx, click, drag, dblclick, hover, key, current, messages};
}

/** The edited (or only) vector and its anchors in page space. */
function vectorOf(store: DesignStore, id?: NodeId) {
  const state = store.getState();
  const vid = id ?? editedVectorId(state) ?? Object.values(state.doc.nodes).find(n => n.type === 'VECTOR')!.id;
  const node = state.doc.nodes[vid];
  const world = worldMatrix(state.doc, vid);
  const subs = (node.vectorPaths ?? []).flatMap(path => pathToAnchors(path.commands));
  const page = (p: Vec | null) => (p ? apply(world, p) : null);
  return {node, subs: subs.map(sub => ({closed: sub.closed, anchors: sub.anchors.map(a => ({...apply(world, a), in: page(a.in), out: page(a.out), kind: a.kind}))}))};
}

test('pen: clicks add corner anchors in a tight box, the first click opens the editor', () => {
  const h = harness(build());
  h.click({x: 100, y: 100});
  const id = editedVectorId(h.store.getState());
  assert.ok(id, 'the first click makes a vector and opens the editor');
  assert.equal(h.store.getState().tool, 'pen');
  assert.deepEqual(h.store.getState().selection, [id]);
  h.click({x: 200, y: 100});
  h.click({x: 200, y: 160});
  const {node, subs} = vectorOf(h.store);
  assert.equal(node.type, 'VECTOR');
  assert.deepEqual([node.x, node.y, node.width, node.height], [100, 100, 100, 60]);
  assert.deepEqual(subs.length, 1);
  assert.equal(subs[0].closed, false);
  assert.deepEqual(subs[0].anchors.map(a => [a.x, a.y, a.kind]), [[100, 100, 'corner'], [200, 100, 'corner'], [200, 160, 'corner']]);
  // Figma's pen defaults: a 1 px black stroke, no fill while the path is open.
  assert.equal(node.fills.length, 0);
  assert.equal(node.strokes.length, 1);
  assert.equal(node.strokeWeight, 1);
  // Paths are in the node's own space.
  assert.deepEqual(node.vectorPaths![0].commands[0], {type: 'M', x: 0, y: 0});
  // One undo step per anchor.
  h.store.undo();
  assert.equal(vectorOf(h.store).subs[0].anchors.length, 2);
  h.store.redo();
  assert.equal(vectorOf(h.store).subs[0].anchors.length, 3);
});

test('pen: a drag makes a smooth anchor with mirrored handles; Alt breaks the mirror; Shift keeps 45°', () => {
  const h = harness(build());
  h.click({x: 0, y: 0});
  h.drag({x: 100, y: 0}, {x: 140, y: 20});
  // The leading handle has no segment yet: the pen keeps it for the next anchor.
  assert.deepEqual(sessionOf(h.store).drawing?.lead, {x: 40, y: 20});
  // Alt from the second step on: the trailing handle stays where it was then, the leading one goes on alone.
  h.drag({x: 200, y: 0}, {x: 240, y: 40}, step => ({altKey: step >= 2}));
  let anchors = vectorOf(h.store).subs[0].anchors;
  const smooth = anchors[1];
  assert.equal(smooth.kind, 'mirrored');
  close(smooth.out!.x, 140);
  close(smooth.out!.y, 20);
  close(smooth.in!.x, 60);
  close(smooth.in!.y, -20);
  assert.deepEqual(sessionOf(h.store).drawing?.lead, {x: 40, y: 40}, 'the leading handle went on alone');
  // Shift: the anchor lands on the 45° ray from the previous one.
  h.click({x: 300, y: 13}, {shiftKey: true});
  anchors = vectorOf(h.store).subs[0].anchors;
  close(anchors[3].x, 300);
  close(anchors[3].y, 0, 'horizontal from (200, 0)');
  const broken = anchors[2];
  close(broken.out!.x, 240);
  close(broken.out!.y, 40);
  close(broken.in!.x, 180, 'the trailing handle froze at the mirror of the half-way drag');
  close(broken.in!.y, -20);
  assert.equal(broken.kind, 'smooth', 'on one line, no longer of equal length');
  const diagonal = constrain45({x: 0, y: 0}, {x: 10, y: 12});
  close(diagonal.x, diagonal.y);
});

test('pen: an undo drops the lead handle the pen was keeping', () => {
  const h = harness(build());
  h.click({x: 0, y: 0});
  h.drag({x: 100, y: 0}, {x: 140, y: 20});
  h.drag({x: 200, y: 0}, {x: 240, y: 0});
  h.store.undo();
  h.click({x: 200, y: 100});
  const anchors = vectorOf(h.store).subs[0].anchors;
  assert.equal(anchors.length, 3);
  // The undone drag's handle does not shape the new segment.
  assert.equal(anchors[1].out, null);
});

test('pen: clicking the first anchor closes the path and gives it the default fill', () => {
  const h = harness(build());
  h.click({x: 0, y: 0});
  h.click({x: 100, y: 0});
  h.click({x: 50, y: 80});
  h.click({x: 1, y: 1});
  const {node, subs} = vectorOf(h.store);
  assert.equal(subs[0].closed, true);
  assert.equal(subs[0].anchors.length, 3, 'closing adds no anchor');
  assert.equal(node.fills.length, 1, 'a closed pen path is filled');
  assert.equal(sessionOf(h.store).drawing, null, 'the pen stops drawing that path');
  // The next click starts a new path in the same vector.
  h.click({x: 300, y: 300});
  assert.equal(vectorOf(h.store).subs.length, 2);
});

test('pen: Backspace takes the last anchor back; Enter finishes and leaves the editor', () => {
  const h = harness(build());
  h.click({x: 0, y: 0});
  h.click({x: 100, y: 0});
  h.click({x: 100, y: 100});
  assert.ok(h.key('Backspace'));
  assert.equal(vectorOf(h.store).subs[0].anchors.length, 2);
  const id = editedVectorId(h.store.getState())!;
  assert.ok(h.key('Enter'));
  assert.equal(editedVectorId(h.store.getState()), null);
  assert.equal(h.store.getState().tool, 'move');
  assert.deepEqual(h.store.getState().selection, [id]);
  const {node, subs} = vectorOf(h.store, id);
  assert.equal(subs[0].closed, false);
  assert.deepEqual([node.width, node.height], [100, 0]);
});

test('pen: a lone click leaves nothing behind; Backspace on the only anchor removes the vector', () => {
  const h = harness(build());
  h.click({x: 10, y: 10});
  assert.ok(h.key('Escape'));
  assert.equal(Object.values(h.store.getState().doc.nodes).filter(n => n.type === 'VECTOR').length, 0, 'a vector of one point is dropped on exit');
  h.store.setTool('pen');
  h.click({x: 10, y: 10});
  assert.ok(h.key('Backspace'));
  assert.equal(Object.values(h.store.getState().doc.nodes).filter(n => n.type === 'VECTOR').length, 0);
});

test('pen: clicking an end of an open vector continues it, from either end', () => {
  const doc = build(add => add('VECTOR', 'v', 'page', {x: 50, y: 50, width: 100, height: 0, fills: [], vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 100, y: 0}]}]}));
  const h = harness(doc);
  h.store.setSelection(['v']);
  // The end at (150, 50).
  h.click({x: 151, y: 51});
  assert.equal(editedVectorId(h.store.getState()), 'v');
  h.click({x: 150, y: 150});
  let anchors = vectorOf(h.store, 'v').subs[0].anchors;
  assert.deepEqual(anchors.map(a => [a.x, a.y]), [[50, 50], [150, 50], [150, 150]]);
  h.key('Enter');
  // The start at (50, 50): new anchors go before it.
  h.store.setTool('pen');
  h.click({x: 50, y: 50});
  h.click({x: 50, y: 150});
  anchors = vectorOf(h.store, 'v').subs[0].anchors;
  assert.deepEqual(anchors.map(a => [a.x, a.y]), [[50, 150], [50, 50], [150, 50], [150, 150]]);
  assert.equal(vectorOf(h.store, 'v').subs.length, 1);
});

test('pen inside the editor: a click on a segment adds an anchor without changing the shape; on an anchor removes it', () => {
  const doc = build(add => add('VECTOR', 'v', 'page', {x: 0, y: 0, width: 100, height: 100, vectorPaths: [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 100, y: 0}, {type: 'L', x: 100, y: 100}, {type: 'Z'}]}]}));
  const h = harness(doc, 'move');
  h.store.setSelection(['v']);
  h.store.setEditing({kind: 'vector', id: 'v'});
  assert.equal(h.store.getState().tool, 'vector-edit', 'editing opens the editor tool');
  h.store.setTool('pen');
  h.click({x: 50, y: 0});
  let subs = vectorOf(h.store, 'v').subs;
  assert.equal(subs[0].anchors.length, 4);
  assert.deepEqual(subs[0].anchors.map(a => [a.x, a.y]), [[0, 0], [50, 0], [100, 0], [100, 100]]);
  const {node} = vectorOf(h.store, 'v');
  assert.deepEqual([node.x, node.y, node.width, node.height], [0, 0, 100, 100]);
  h.click({x: 50, y: 0});
  subs = vectorOf(h.store, 'v').subs;
  assert.equal(subs[0].anchors.length, 3);
});

test('pencil: samples become a few smooth cubics within the tolerance', () => {
  const points: Vec[] = [];
  for (let i = 0; i <= 60; i++) {
    const t = (i / 60) * Math.PI;
    points.push({x: 100 + Math.cos(Math.PI - t) * 80, y: 100 - Math.sin(t) * 80});
  }
  const network = pencilNetwork(points, 0.5)!;
  const anchors = network[0].subs[0].anchors;
  assert.ok(anchors.length >= 2 && anchors.length <= 5, `${anchors.length} anchors for a half circle`);
  for (const inner of anchors.slice(1, -1)) assert.notEqual(inner.kind, 'corner', 'inner anchors are smooth');
  const h = harness(build(), 'pencil');
  h.drag({x: 0, y: 0}, {x: 120, y: 40});
  const vector = Object.values(h.store.getState().doc.nodes).find(n => n.type === 'VECTOR')!;
  assert.equal(vector.strokeWeight, 2);
  assert.equal(vector.fills.length, 0);
  assert.equal(vector.strokeCap, 'ROUND');
  assert.deepEqual(h.store.getState().selection, [vector.id]);
  assert.equal(h.store.getState().tool, 'pencil', 'the pencil stays for the next stroke');
  close(vector.x, 0);
  close(vector.y, 0);
  close(vector.width, 120);
  close(vector.height, 40);
  assert.equal(networkOfNode(vector)[0].subs[0].closed, false);
});
