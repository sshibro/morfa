import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {validateDocument} from '../shared/design/schema';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {copySelection, cutSelection, pasteData, registerCoreCommands, runCommand, type CommandContext} from '../src/design/engine/commands';
import {createDesignStore} from '../src/design/engine/store';

// A main component's copies are its instances in the file that holds it, as in Figma: ⌘D, ⌥-drag and paste
// (help.figma.com «Create and insert component instances»). A variant's copy stays a variant, a cut main pasted
// back is the main again, and a main pasted into itself stays an ordinary copy (no instance inside its own main).

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, name: id, ...props}), parent));
  return tx.commit({measurer}).doc;
}

/** «btn» (a main with «bg» and «slot», a frame), a set «set» with the variant «v1». */
function setup() {
  registerCoreCommands();
  const doc = build(add => {
    add('COMPONENT', 'btn', 'page', {name: 'Button', width: 120, height: 40});
    add('RECTANGLE', 'bg', 'btn', {width: 120, height: 40});
    add('FRAME', 'slot', 'btn', {x: 80, y: 0, width: 40, height: 40});
    add('COMPONENT_SET', 'set', 'page', {x: 0, y: 300, width: 200, height: 100});
    add('COMPONENT', 'v1', 'set', {name: 'Type=Primary', x: 20, y: 20, width: 80, height: 40});
  });
  const store = createDesignStore({doc, measurer});
  // The screen's centre is far from every layer: a paste with nothing selected lands on the page.
  store.setViewport({x: 5000, y: 5000, zoom: 1});
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  const run = (id: string) => assert.ok(runCommand(id, ctx), `${id} ran`);
  const node = (id: NodeId) => store.getState().doc.nodes[id];
  const selected = () => store.getState().selection.map(node);
  return {store, ctx, run, node, selected};
}

test('should give an instance of the main when a main component is duplicated with ⌘D', () => {
  const {store, run, selected} = setup();
  store.setSelection(['btn']);

  run('duplicate');

  const [copy] = selected();
  assert.equal(copy.type, 'INSTANCE');
  assert.equal(copy.componentId, 'btn');
  assert.equal(copy.children?.length, 2, 'the instance has its copies');
  assert.ok(copy.x >= 120, 'beside the main, as a frame on the canvas is duplicated');
  assert.ok(validateDocument(store.getState().doc).ok);
});

test('should keep a variant a variant when it is duplicated with ⌘D', () => {
  const {store, run, selected} = setup();
  store.setSelection(['v1']);

  run('duplicate');

  const [copy] = selected();
  assert.equal(copy.type, 'COMPONENT');
  assert.equal(copy.parentId, 'set');
});

test('should paste an instance of the main when a main component was copied in the same file', () => {
  const {store, ctx, selected} = setup();
  store.setSelection(['btn']);
  const text = copySelection(ctx)!;
  store.setSelection([]);

  pasteData(ctx, {text, html: null, files: []}, false);

  const [pasted] = selected();
  assert.equal(pasted.type, 'INSTANCE');
  assert.equal(pasted.componentId, 'btn');
  assert.ok(validateDocument(store.getState().doc).ok);
});

test('should paste the main itself back when the main was cut', () => {
  const {store, ctx, node, selected} = setup();
  store.setSelection(['btn']);
  const text = cutSelection(ctx)!;
  assert.equal(node('btn'), undefined);

  pasteData(ctx, {text, html: null, files: []}, false);

  const [pasted] = selected();
  assert.equal(pasted.type, 'COMPONENT');
  assert.equal(pasted.children?.length, 2);
});

test('should paste an ordinary copy when the main is pasted into a frame of its own', () => {
  const {store, ctx, selected} = setup();
  store.setSelection(['btn']);
  const text = copySelection(ctx)!;
  store.setSelection(['slot']);

  pasteData(ctx, {text, html: null, files: []}, false);

  const [pasted] = selected();
  assert.notEqual(pasted.type, 'INSTANCE', 'no instance inside its own main');
  assert.ok(validateDocument(store.getState().doc).ok);
});
