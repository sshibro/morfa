import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid, BLACK} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode, Vec} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {hasVariableWidth} from '../shared/design/stroke-profile';
import {measurementGeometry, MEASUREMENT_COLOR} from '../shared/design/measurements';
import {ANNOTATION_COLORS} from '../shared/design/annotations';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import {documentTarget, mergeChange} from '../shared/design/merge';
import {checkPatchedDocument} from '../shared/design/schema';
import {createDesignStore, currentViewport} from '../src/design/engine/store';
import {findByShortcut, getCommand, listCommands} from '../src/design/engine/commands';
import {NO_SNAP, type Tool, type ToolContext, type ToolKeyEvent, type ToolPointerEvent} from '../src/design/engine/tools/types';
import {hasTool} from '../src/design/engine/tools/registry';
import {pageToScreen, screenToPage} from '../src/design/engine/viewport';
import {MoveTool} from '../src/design/engine/tools/move';
import {LassoTool, nodesInLoop} from '../src/design/engine/tools/lasso';
import {BrushTool, BRUSH_WEIGHT, brushProfile, rememberBrushProfile, smoothStroke} from '../src/design/engine/tools/brush';
import {pathUnder, textOnPathNode} from '../src/design/engine/tools/text-path';
import {hitHandle} from '../src/design/engine/tools/transform';
import {textPathHandle} from '../src/design/engine/overlay';
import {selectionBox} from '../src/design/engine/selection';
import {ANNOTATION_TOOL, annotationsState, MEASURE_TOOL} from '../src/design/annotations';
import {removeNote, saveNote} from '../src/design/annotations/edit';
import {createTool} from '../src/design/engine/tools';
import {installEditorCommands, shortcutString} from '../src/design/editor/command-bridge';
import {TOOL_GROUPS} from '../src/design/editor/chrome/tools';
import {shortcutRows} from '../src/design/editor/ShortcutsDialog';

// The tools added for Figma parity: "Text on path", "Annotation" (Y), "Measure" (⇧M), "Lasso" (Q) and "Brush" (B):
// each one's main flow on a store, the start handle of a text on a path, and their keys in the registry.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

installEditorCommands();

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

function harness(doc: DesignDocument, tool: Tool, toolId: string) {
  const store = createDesignStore({doc, measurer, tool: toolId});
  store.setViewport({x: 0, y: 0, zoom: 1});
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
    enterEdit: () => {},
    setTool: id => store.setTool(id),
    modifiers: () => ({shift: false, alt: false, mod: false}),
  };
  tool.activate?.(ctx);
  const ev = (x: number, y: number, mods: Partial<ToolPointerEvent> = {}): ToolPointerEvent => ({
    screen: {x, y}, page: {x, y}, button: 0, buttons: 1, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false,
    pointerId: 1, pointerType: 'mouse', pressure: 0.5, detail: 1, timeStamp: 0, ...mods,
  });
  const path = (points: Vec[], mods: Partial<ToolPointerEvent> = {}) => {
    tool.onPointerDown?.(ev(points[0].x, points[0].y, mods), ctx);
    for (const p of points.slice(1)) tool.onPointerMove?.(ev(p.x, p.y, mods), ctx);
    const last = points[points.length - 1];
    tool.onPointerUp?.(ev(last.x, last.y, {...mods, buttons: 0}), ctx);
  };
  const drag = (from: Vec, to: Vec, mods: Partial<ToolPointerEvent> = {}) =>
    path([0, 1, 2, 3, 4].map(i => ({x: from.x + ((to.x - from.x) * i) / 4, y: from.y + ((to.y - from.y) * i) / 4})), mods);
  const key = (code: string): ToolKeyEvent => ({type: 'keydown', code, key: code, shiftKey: false, altKey: false, metaKey: false, ctrlKey: false, mod: false, repeat: false});
  return {store, ctx, ev, path, drag, key};
}

const circle = (cx: number, cy: number, r: number, steps = 24): Vec[] =>
  Array.from({length: steps + 1}, (_, i) => ({x: cx + Math.cos((i / steps) * Math.PI * 2) * r, y: cy + Math.sin((i / steps) * Math.PI * 2) * r}));

// ── Lasso ────────────────────────────────────────────────────────────────────────────────────────

test('the lasso selects what its loop touches, a frame on the canvas only when it holds it whole; Shift adds', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 40, height: 40});
    add('RECTANGLE', 'b', 'page', {x: 200, y: 0, width: 40, height: 40});
    add('FRAME', 'F', 'page', {x: 0, y: 200, width: 300, height: 200});
  });
  // A loop round "a" that also crosses the frame's corner: the frame is not held whole, so only "a".
  assert.deepEqual(nodesInLoop(doc, 'page', circle(20, 60, 160)), ['a']);
  // A loop round the whole frame takes it.
  assert.ok(nodesInLoop(doc, 'page', circle(150, 300, 220)).includes('F'));
  const {store, path} = harness(doc, new LassoTool(), 'lasso');
  path(circle(20, 20, 35));
  assert.deepEqual(store.getState().selection, ['a']);
  path(circle(220, 20, 35), {shiftKey: true});
  assert.deepEqual(store.getState().selection, ['a', 'b']);
  // A click without a drag picks the layer under it; on nothing it clears.
  path([{x: 210, y: 10}]);
  assert.deepEqual(store.getState().selection, ['b']);
  path([{x: 600, y: 600}]);
  assert.deepEqual(store.getState().selection, []);
});

// ── Brush ────────────────────────────────────────────────────────────────────────────────────────

test('the brush smooths a stroke into one vector with the remembered width profile, ignoring pressure', () => {
  const jitter = Array.from({length: 40}, (_, i) => ({x: i * 5, y: i % 2 ? 3 : -3}));
  const smooth = smoothStroke(jitter);
  assert.deepEqual(smooth[0], jitter[0]);
  assert.deepEqual(smooth[smooth.length - 1], jitter[jitter.length - 1]);
  const spread = (points: Vec[]) => Math.max(...points.slice(5, -5).map(p => Math.abs(p.y)));
  assert.ok(spread(smooth) < spread(jitter) / 2, 'the jitter is taken out');

  assert.equal(brushProfile().widthProfile, 'MIRRORED_TAPER');
  const {store, path} = harness(build(() => {}), new BrushTool(), 'brush');
  path(jitter.map(p => ({x: p.x + 100, y: p.y + 100})), {pointerType: 'pen', pressure: 0.9});
  const id = store.getState().selection[0];
  const node = store.getState().doc.nodes[id];
  assert.equal(node.type, 'VECTOR');
  assert.equal(node.name, 'Brush');
  assert.equal(node.strokeWeight, BRUSH_WEIGHT);
  assert.deepEqual(node.variableWidthStrokeProperties, {widthProfile: 'MIRRORED_TAPER'}, 'a pen\'s pressure does not change it');
  assert.ok(hasVariableWidth(node));
  assert.ok(node.height < 10, `smoothed: ${node.height}`);
  store.undo();
  assert.equal(store.getState().doc.nodes[id], undefined, 'one undo step');

  // A preset picked in "Stroke" is what the next stroke takes; "Uniform" is not remembered.
  rememberBrushProfile({widthProfile: 'WEDGE'});
  rememberBrushProfile({widthProfile: 'UNIFORM'});
  path([{x: 0, y: 300}, {x: 50, y: 310}, {x: 100, y: 300}]);
  assert.deepEqual(store.getState().doc.nodes[store.getState().selection[0]].variableWidthStrokeProperties, {widthProfile: 'WEDGE'});
  rememberBrushProfile({widthProfile: 'MIRRORED_TAPER'});
});

// ── Text on path ─────────────────────────────────────────────────────────────────────────────

test('a text on a path takes the shape\'s outline nearest the click, its box and its place above it', () => {
  const doc = build(add => {
    add('FRAME', 'F', 'page', {x: 0, y: 0, width: 400, height: 400});
    add('ELLIPSE', 'e', 'F', {x: 100, y: 100, width: 200, height: 100, rotation: 0});
    add('RECTANGLE', 'r', 'F', {x: 10, y: 10, width: 50, height: 50});
  });
  assert.equal(pathUnder(doc.nodes.F, {x: 0, y: 0}), null, 'a frame is a box, not a path');
  const made = textOnPathNode(doc, doc.nodes.e, {x: 300, y: 150})!;
  assert.ok(made);
  assert.equal(made.parentId, 'F');
  assert.equal(made.index, doc.nodes.F.children!.indexOf('e') + 1);
  const node = made.node;
  assert.equal(node.type, 'TEXT');
  assert.deepEqual([node.x, node.y, node.width, node.height], [100, 100, 200, 100]);
  assert.equal(node.textPath!.side, 'LEFT');
  assert.equal(node.text!.textAlignVertical, 'BOTTOM', 'the text stands on the path');
  // The click at the ellipse's right end: the start of its outline (Figma's ellipses start at 3 o'clock).
  assert.ok(node.textPath!.startOffset < 0.02 || node.textPath!.startOffset > 0.98, `start ${node.textPath!.startOffset}`);
  const bottom = textOnPathNode(doc, doc.nodes.e, {x: 200, y: 200})!;
  assert.ok(Math.abs(bottom.node.textPath!.startOffset - 0.25) < 0.02, `a quarter round: ${bottom.node.textPath!.startOffset}`);
});

test('the start handle of a selected text on a path moves where the text starts, in one undo step', () => {
  const doc = build(add => {
    add('LINE', 'l', 'page', {x: 100, y: 100, width: 200, height: 0});
  });
  const made = textOnPathNode(doc, doc.nodes.l, {x: 100, y: 100})!;
  const tx = beginTransaction(doc);
  tx.create({...made.node, id: 't', text: {...made.node.text!, characters: 'Hello'}}, made.parentId, made.index);
  const withText = tx.commit({measurer}).doc;
  assert.equal(withText.nodes.t.textPath!.startOffset, 0);
  const {store, ctx, drag} = harness(withText, new MoveTool(), 'move');
  store.setSelection(['t']);
  const box = selectionBox(store.getState().doc, ['t'])!;
  const handle = textPathHandle(store.getState().doc, box, ctx.view.viewport())!;
  assert.deepEqual({x: Math.round(handle.at.x), y: Math.round(handle.at.y)}, {x: 100, y: 100});
  assert.deepEqual(hitHandle(store.getState().doc, box, {x: 101, y: 101}, ctx.view.viewport()), {kind: 'path-start'});
  drag({x: 100, y: 100}, {x: 200, y: 140});
  assert.equal(store.getState().doc.nodes.t.textPath!.startOffset, 0.5);
  assert.deepEqual([store.getState().doc.nodes.t.x, store.getState().doc.nodes.t.y], [100, 100], 'the layer stays');
  store.undo();
  assert.equal(store.getState().doc.nodes.t.textPath!.startOffset, 0);
  // A locked text has no handle.
  const locked = {...store.getState().doc, nodes: {...store.getState().doc.nodes, t: {...store.getState().doc.nodes.t, locked: true}}};
  assert.equal(textPathHandle(locked, box, ctx.view.viewport()), null);
});

test('a text on a path survives co-editing: one person moves its start while another types, and undo walks back', () => {
  const doc = build(add => add('LINE', 'l', 'page', {x: 0, y: 0, width: 300, height: 0}));
  const made = textOnPathNode(doc, doc.nodes.l, {x: 0, y: 0})!;
  const tx = beginTransaction(doc);
  tx.create({...made.node, id: 't', text: {...made.node.text!, characters: 'Hello'}}, made.parentId, made.index);
  const base = tx.commit({measurer}).doc;
  const t = base.nodes.t;
  const change = (node: SceneNode): {patch: DocumentPatch; before: DocumentPatch} => ({patch: {nodes: {t: node}}, before: {nodes: {t}}});
  const land = (current: DesignDocument, edit: {patch: DocumentPatch; before: DocumentPatch}) => {
    const merged = mergeChange(documentTarget(current), edit.patch, edit.before);
    const next = applyPatch(current, merged.patch);
    assert.ok(checkPatchedDocument(current, next, merged.patch).ok);
    return next;
  };
  const moved = change({...t, textPath: {...t.textPath!, startOffset: 0.5}});
  const typed = change({...t, text: {...t.text!, characters: 'Hello, world'}});
  const after = land(land(base, moved), typed);
  assert.equal(after.nodes.t.textPath!.startOffset, 0.5);
  assert.equal(after.nodes.t.text!.characters, 'Hello, world');
  assert.deepEqual(after.nodes.t.textPath!.commands, t.textPath!.commands);

  // In the editor: the side and the start are one undo step each.
  const store = createDesignStore({doc: base, measurer});
  store.transact('Text side', tr => tr.update('t', {textPath: {...t.textPath!, side: 'RIGHT'}}));
  store.transact('Text start', tr => tr.update('t', {textPath: {...store.getState().doc.nodes.t.textPath!, startOffset: 0.3}}));
  store.undo();
  assert.deepEqual([store.getState().doc.nodes.t.textPath!.side, store.getState().doc.nodes.t.textPath!.startOffset], ['RIGHT', 0]);
  store.undo();
  assert.equal(store.getState().doc.nodes.t.textPath!.side, 'LEFT');
});

// ── Measure ────────────────────────────────────────────────────────────────────────────────────

test('a measurement dragged between two edges is pinned on the page, follows the layers, and Delete removes it', () => {
  const doc = build(add => {
    add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 100, height: 100});
    add('RECTANGLE', 'b', 'page', {x: 160, y: 20, width: 60, height: 60});
  });
  const tool = createTool(MEASURE_TOOL)!;
  const {store, drag, ctx, key} = harness(doc, tool, MEASURE_TOOL);
  drag({x: 97, y: 50}, {x: 163, y: 50});
  const pinned = store.getState().doc.nodes.page.measurements!;
  assert.equal(pinned.length, 1);
  assert.deepEqual([pinned[0].start, pinned[0].end], [{nodeId: 'a', side: 'RIGHT'}, {nodeId: 'b', side: 'LEFT'}]);
  assert.equal(measurementGeometry(store.getState().doc, 'page', pinned[0])!.value, 60);
  assert.equal(annotationsState(store).get().selectedMeasurement, pinned[0].id);
  // It stays live: "b" moves, the distance follows.
  store.transact('move', t => t.update('b', {x: 200}));
  assert.equal(measurementGeometry(store.getState().doc, 'page', store.getState().doc.nodes.page.measurements![0])!.value, 100);
  assert.ok(tool.onKeyDown!(key('Delete'), ctx));
  assert.equal(store.getState().doc.nodes.page.measurements, undefined);
  store.undo();
  assert.equal(store.getState().doc.nodes.page.measurements!.length, 1, 'Delete is one undo step');
  // A drag that ends on nothing pins nothing; a drag across one layer measures its width.
  drag({x: 3, y: 30}, {x: 500, y: 500});
  assert.equal(store.getState().doc.nodes.page.measurements!.length, 1);
  drag({x: 3, y: 30}, {x: 96, y: 30});
  const own = store.getState().doc.nodes.page.measurements![1];
  assert.deepEqual([own.start, own.end], [{nodeId: 'a', side: 'LEFT'}, {nodeId: 'a', side: 'RIGHT'}]);
  assert.equal(measurementGeometry(store.getState().doc, 'page', own)!.value, 100);
  assert.notEqual(own.id, pinned[0].id);
  assert.equal(MEASUREMENT_COLOR, ANNOTATION_COLORS.pink, 'one pink for the canvas lines and the "Code" list');
});

// ── Annotation ────────────────────────────────────────────────────────────────────────────────────

test('the annotation tool opens a note on the layer clicked; a note is saved, edited, emptied away, each one undo step', () => {
  const doc = build(add => add('RECTANGLE', 'a', 'page', {x: 0, y: 0, width: 100, height: 100, fills: [solid(BLACK)]}));
  const tool = createTool(ANNOTATION_TOOL)!;
  const {store, path, ctx, key} = harness(doc, tool, ANNOTATION_TOOL);
  path([{x: 50, y: 50}]);
  assert.deepEqual(store.getState().selection, ['a']);
  assert.deepEqual(annotationsState(store).get().editing, {nodeId: 'a', annotationId: null});
  assert.ok(tool.onKeyDown!(key('Escape'), ctx), 'Escape closes the note first');
  assert.equal(annotationsState(store).get().editing, null);
  assert.equal(tool.onKeyDown!(key('Escape'), ctx), false, 'then leaves the tool to the editor');

  assert.equal(saveNote(store, 'a', null, {label: '   ', categoryId: undefined, properties: []}), null, 'an empty note is never made');
  assert.equal(store.getState().doc.nodes.a.annotations, undefined);
  const id = saveNote(store, 'a', null, {label: 'Button "Buy"\n', categoryId: 'development', properties: ['width', 'fills']})!;
  assert.deepEqual(store.getState().doc.nodes.a.annotations, [{id, label: 'Button "Buy"', categoryId: 'development', properties: [{type: 'width'}, {type: 'fills'}]}]);
  saveNote(store, 'a', id, {label: 'Button', categoryId: undefined, properties: []});
  assert.deepEqual(store.getState().doc.nodes.a.annotations, [{id, label: 'Button'}]);
  const second = saveNote(store, 'a', null, {label: 'Padding 16', categoryId: 'content', properties: []})!;
  assert.notEqual(second, id);
  removeNote(store, 'a', id);
  assert.deepEqual(store.getState().doc.nodes.a.annotations!.map(note => note.id), [second]);
  saveNote(store, 'a', second, {label: '', categoryId: 'content', properties: []});
  assert.equal(store.getState().doc.nodes.a.annotations, undefined, 'emptied: removed');
  store.undo();
  store.undo();
  assert.deepEqual(store.getState().doc.nodes.a.annotations!.map(note => note.label), ['Button', 'Padding 16']);
});

// ── Keys ─────────────────────────────────────────────────────────────────────────────────────────

test('the new tools are registered with Figma\'s keys, listed in "Keyboard shortcuts", and collide with nothing', () => {
  for (const tool of ['text-path', 'annotation', 'measure', 'lasso', 'brush']) assert.ok(hasTool(tool), tool);
  const expected: [string, string][] = [['tool-annotation', 'KeyY'], ['tool-measure', 'Shift+KeyM'], ['tool-lasso', 'KeyQ'], ['tool-brush', 'KeyB'], ['view.annotations', 'Shift+KeyY']];
  for (const mac of [true, false]) {
    for (const [id, shortcut] of expected) {
      const command = getCommand(id)!;
      assert.ok(command, id);
      assert.equal(shortcutString(command.shortcut!), shortcut, id);
      const shift = shortcut.startsWith('Shift+');
      const code = shortcut.replace('Shift+', '');
      assert.equal(findByShortcut({code, shiftKey: shift, altKey: false, metaKey: false, ctrlKey: false}, mac)?.id, id, `${shortcut} on ${mac ? 'Mac' : 'PC'}`);
    }
    const seen = new Map<string, string>();
    for (const command of listCommands({includeHidden: true})) for (const shortcut of [command.shortcut, ...(command.alternates ?? [])]) {
      if (!shortcut) continue;
      const name = `${shortcut.code}|${!!shortcut.shift}|${!!shortcut.alt}|${!!shortcut.mod}|${!!shortcut.ctrl}`;
      assert.ok(!seen.has(name) || seen.get(name) === command.id, `${name}: ${seen.get(name)} and ${command.id}`);
      seen.set(name, command.id);
    }
  }
  assert.ok(getCommand('tool-text-path'), '"Text on path" is in quick actions without a key, as in Figma');
  const rows = shortcutRows();
  for (const [id] of expected) assert.ok(rows.some(row => row.id === id && row.group === (id.startsWith('tool-') ? 'Tools' : 'View')), id);
  // Figma's groups: Text holds "Text on path"; Comment holds "Annotation" and "Measure".
  assert.deepEqual(TOOL_GROUPS.find(group => group.id === 'text')!.tools, ['text', 'text-path']);
  assert.deepEqual(TOOL_GROUPS.find(group => group.id === 'comment')!.tools, ['comment', 'annotation', 'measure']);
});
