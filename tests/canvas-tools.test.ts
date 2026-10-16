import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {worldBox} from '../shared/design/geometry';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {CANVAS_RESULT_CHARS} from '../shared/design/canvas-tools';
import {createDesignStore, type DesignStore} from '../src/design/engine/store';
import type {CanvasAliases} from '../src/design/canvas-tools/aliases';
import {fillWithPicture, insertPicture} from '../src/design/canvas-tools/document';
import {clipResult, runCanvasTool, type CanvasToolContext, type CanvasToolOutcome} from '../src/design/canvas-tools/executor';

// The canvas tools (src/design/canvas-tools) on a real store: create, update, delete and duplicate layers and add colour styles, each
// one step, refusals reported and never thrown. No network.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const font = (family: string) => (['inter', 'manrope'].includes(family.toLowerCase()) ? family[0]!.toUpperCase() + family.slice(1).toLowerCase() : null);

function build(recipe: (add: (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void) => void): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}
const textProps = (characters: string) => ({...defaultTextProps(characters)});
/** A page with a screen frame holding a title and a card (with a label), and a loose rectangle. */
const sampleDoc = () =>
  build(add => {
    add('FRAME', 'screen', 'page', {name: 'Screen', x: 0, y: 0, width: 400, height: 800});
    add('TEXT', 'title', 'screen', {name: 'Heading', x: 20, y: 20, width: 200, height: 30, text: textProps('Hello')});
    add('FRAME', 'card', 'screen', {name: 'Card', x: 20, y: 100, width: 300, height: 200});
    add('TEXT', 'label', 'card', {name: 'Label', x: 10, y: 10, width: 100, height: 20, text: textProps('Price')});
    add('RECTANGLE', 'box', 'page', {name: 'Square', x: 600, y: 0, width: 100, height: 100});
  });

/** Aliases «L1», «L2», ... given in order; an alias names a layer of the document for as long as the layer exists. */
function aliasesOf(): CanvasAliases {
  const byId = new Map<NodeId, string>();
  const byAlias = new Map<string, NodeId>();
  return {
    alias(id) {
      let alias = byId.get(id);
      if (!alias) {
        alias = `L${byId.size + 1}`;
        byId.set(id, alias);
        byAlias.set(alias, id);
      }
      return alias;
    },
    known: id => byId.get(id) ?? null,
    resolve: alias => byAlias.get(alias) ?? null,
  };
}

function context(store: DesignStore): CanvasToolContext & {aliases: CanvasAliases} {
  return {store, aliases: aliasesOf(), font, view: () => ({x: 0, y: 0, width: 1200, height: 800})};
}
const run = (name: string, input: unknown, ctx: CanvasToolContext): Promise<CanvasToolOutcome> => runCanvasTool({id: `call-${name}`, name, input}, ctx);

test('create_layers on the page: one undo step, every layer gets an alias, the result maps local ids and places the roots', async () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const ctx = context(store);
  const result = await run(
    'create_layers',
    {
      parent: null,
      layers: [
        {id: 'hero', type: 'FRAME', name: 'Hero', width: 600, height: 400, fill: '#FFFFFF', layout: {mode: 'VERTICAL', gap: 16, padding: {top: 24, right: 24, bottom: 24, left: 24}}},
        {id: 'h1', parent: 'hero', type: 'TEXT', name: 'Heading', width: 400, height: 40, text: {characters: 'Fresh coffee', fontSize: 40, fontWeight: 700}},
        {id: 'cta', parent: 'hero', type: 'RECTANGLE', name: 'Button', width: 160, height: 48, fill: '#0D99FF', cornerRadius: 12},
      ],
    },
    ctx,
  );
  assert.equal(result.result.ok, true, result.result.text);
  assert.equal(result.createdCount, 3);
  assert.equal(result.created.length, 1);
  assert.match(result.result.text, /Ids \(local→id\): hero→L\d+, h1→L\d+, cta→L\d+/);
  const state = store.getState();
  const hero = state.doc.nodes[result.created[0]!]!;
  assert.equal(hero.parentId, 'page');
  // Near the view's centre, beside what stands there (the screen frame, the square), never on top of it.
  for (const other of ['screen', 'box']) {
    const node = state.doc.nodes[other]!;
    const apart = hero.x >= node.x + node.width || hero.x + hero.width <= node.x || hero.y >= node.y + node.height || hero.y + hero.height <= node.y;
    assert.ok(apart, `${other} at ${node.x},${node.y} and the new frame at ${hero.x},${hero.y}`);
  }
  assert.equal(hero.children!.length, 2);
  for (const id of [hero.id, ...hero.children!]) assert.ok(ctx.aliases.known(id), id);
  assert.deepEqual(state.selection, [hero.id]);
  assert.equal(state.history.undo, 'New layers');
  store.undo();
  assert.equal(store.getState().doc.nodes[hero.id], undefined);
});

test('create_layers: an IMAGE is a grey placeholder rectangle', async () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const result = await run('create_layers', {parent: null, layers: [{id: 'photo', type: 'IMAGE', name: 'Photo', width: 200, height: 100, image: {description: 'Coffee beans'}}]}, context(store));
  assert.equal(result.result.ok, true, result.result.text);
  const photo = store.getState().doc.nodes[result.created[0]!]!;
  assert.equal(photo.type, 'RECTANGLE');
  assert.equal(photo.fills[0]!.type, 'SOLID');
});

test('create_layers into a frame by alias; a layer that is not a frame or no longer exists is an error the caller reads', async () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const ctx = context(store);
  const card = ctx.aliases.alias('card'), label = ctx.aliases.alias('label');
  const inside = await run('create_layers', {parent: card, layers: [{id: 'badge', type: 'ELLIPSE', name: 'Badge', x: 200, y: 10, width: 24, height: 24, fill: '#FF0000'}]}, ctx);
  assert.equal(inside.result.ok, true, inside.result.text);
  assert.equal(store.getState().doc.nodes[inside.created[0]!]!.parentId, 'card');
  const notFrame = await run('create_layers', {parent: label, layers: [{id: 'x', type: 'RECTANGLE', width: 1, height: 1}]}, ctx);
  assert.equal(notFrame.result.ok, false);
  assert.match(notFrame.result.text, /cannot hold layers/);
  const gone = await run('create_layers', {parent: 'L77', layers: [{id: 'x', type: 'RECTANGLE', width: 1, height: 1}]}, ctx);
  assert.equal(gone.result.ok, false);
  assert.match(gone.result.text, /read the layers with morfa_get_layers/);
});

test('update_layers: fields map onto the layer as one hand edit; unknown aliases and wrong types are per-item problems, the rest apply', async () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const ctx = context(store);
  const [screen, title, card, box] = ['screen', 'title', 'card', 'box'].map(id => ctx.aliases.alias(id));
  const before = store.getState().history.undo;
  const result = await run(
    'update_layers',
    {
      updates: [
        {id: box, fill: '#112233', cornerRadius: 8, name: 'Plate', width: 120, opacity: 0.5},
        {id: title, text: {characters: 'Welcome', fontSize: 24, fontWeight: 600, color: '#FF0000', align: 'CENTER', lineHeight: 32}},
        {id: card, layout: {mode: 'HORIZONTAL', gap: 12, padding: {top: 8, right: 8, bottom: 8, left: 8}}, sizing: {horizontal: 'FIXED', vertical: 'HUG'}},
        {id: box, parent: screen},
        {id: title, cornerRadius: 4},
        {id: 'L99', name: 'No such layer'},
      ],
    },
    ctx,
  );
  assert.equal(result.result.ok, true, result.result.text);
  assert.match(result.result.text, /L99: no such layer/);
  assert.match(result.result.text, /a TEXT has no corner radius/);
  const doc = store.getState().doc;
  const rect = doc.nodes.box!;
  assert.equal(rect.name, 'Plate');
  assert.equal(rect.cornerRadius, 8);
  assert.equal(rect.width, 120);
  assert.equal(rect.opacity, 0.5);
  assert.equal(rect.parentId, 'screen');
  assert.equal(rect.fills[0]!.type === 'SOLID' && Math.round(rect.fills[0]!.color.r * 255), 0x11);
  const text = doc.nodes.title!;
  assert.equal(text.text!.characters, 'Welcome');
  assert.equal(text.text!.style.fontSize, 24);
  assert.equal(text.text!.style.fontWeight, 600);
  assert.deepEqual(text.text!.style.lineHeight, {unit: 'PIXELS', value: 32});
  assert.equal(text.text!.textAlignHorizontal, 'CENTER');
  assert.equal(text.fills[0]!.type === 'SOLID' && text.fills[0]!.color.r, 1);
  const frame = doc.nodes.card!;
  assert.equal(frame.autoLayout?.layoutMode, 'HORIZONTAL');
  assert.equal(frame.autoLayout?.itemSpacing, 12);
  assert.equal(frame.layoutSizingVertical, 'HUG');
  // One undo step takes all of it back.
  assert.equal(store.getState().history.undo, 'Change layers');
  store.undo();
  assert.equal(store.getState().history.undo, before);
  assert.equal(store.getState().doc.nodes.box!.parentId, 'page');
  assert.equal(store.getState().doc.nodes.title!.text!.characters, 'Hello');
});

test('update_layers: moving a frame into itself, filling without a layout parent and removing auto layout are handled', async () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const ctx = context(store);
  const [screen, card, box] = ['screen', 'card', 'box'].map(id => ctx.aliases.alias(id));
  const result = await run('update_layers', {updates: [{id: screen, parent: card}, {id: box, sizing: {horizontal: 'FILL', vertical: 'FIXED'}}]}, ctx);
  assert.equal(result.result.ok, false);
  assert.match(result.result.text, /cannot move into itself/);
  assert.match(result.result.text, /cannot FILL horizontally/);
  await run('update_layers', {updates: [{id: card, layout: {mode: 'VERTICAL'}}]}, ctx);
  assert.equal(store.getState().doc.nodes.card!.autoLayout?.layoutMode, 'VERTICAL');
  await run('update_layers', {updates: [{id: card, layout: null}]}, ctx);
  assert.equal(store.getState().doc.nodes.card!.autoLayout?.layoutMode, 'NONE');
});

test('update_layers: parent null puts a layer on its page where it is on screen', async () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const ctx = context(store);
  const box = ctx.aliases.alias('box');
  const before = worldBox(store.getState().doc, 'box');
  await run('update_layers', {updates: [{id: box, parent: ctx.aliases.alias('card')}]}, ctx);
  assert.equal(store.getState().doc.nodes.box!.parentId, 'card');
  const result = await run('update_layers', {updates: [{id: box, parent: null}]}, ctx);
  assert.equal(result.result.ok, true, result.result.text);
  assert.equal(store.getState().doc.nodes.box!.parentId, 'page');
  const after = worldBox(store.getState().doc, 'box');
  assert.deepEqual([after.x, after.y], [before.x, before.y]);
});

test('delete_layers and duplicate_layers: one step each, copies beside their originals with aliases for known children', async () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const ctx = context(store);
  const [screen, title, box] = ['screen', 'title', 'box'].map(id => ctx.aliases.alias(id));
  const copies = await run('duplicate_layers', {ids: [screen]}, ctx);
  assert.equal(copies.result.ok, true, copies.result.text);
  const copy = store.getState().doc.nodes[copies.created[0]!]!;
  assert.equal(copy.parentId, 'page');
  assert.ok(copy.x >= 400 + 100, `the copy stands right of the original: ${copy.x}`);
  assert.match(copies.result.text, new RegExp(`${screen}→L\\d+ at x=`));
  assert.match(copies.result.text, new RegExp(`Copies of layers inside them: ${title}→L\\d+`));
  assert.equal(store.getState().history.undo, 'Duplicate');
  const inner = await run('duplicate_layers', {ids: [title]}, ctx);
  const innerCopy = store.getState().doc.nodes[inner.created[0]!]!;
  assert.equal(innerCopy.parentId, 'screen');
  assert.equal(store.getState().doc.nodes.screen!.children!.indexOf(innerCopy.id), store.getState().doc.nodes.screen!.children!.indexOf('title') + 1);

  const removed = await run('delete_layers', {ids: [box, title, 'L500']}, ctx);
  assert.equal(removed.result.ok, true);
  assert.match(removed.result.text, /Deleted 2 layers/);
  assert.match(removed.result.text, /L500: no such layer/);
  assert.equal(store.getState().doc.nodes.box, undefined);
  assert.equal(store.getState().history.undo, 'Delete');
  // An alias of a deleted layer stays taken and now names nothing.
  const again = await run('update_layers', {updates: [{id: box, name: 'x'}]}, ctx);
  assert.equal(again.result.ok, false);
});

test('add_color_styles saves «group/name» styles in one step; a refused store and a failed check keep the document unchanged', async () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const ctx = context(store);
  const palette = await run('add_color_styles', {group: 'Coffee shop', colors: [{name: 'Primary', color: '#6B4226'}, {name: 'Surface', color: '#FFF8F0'}]}, ctx);
  assert.equal(palette.result.ok, true);
  assert.deepEqual(Object.values(store.getState().doc.styles).map(style => style.name).sort(), ['Coffee shop/Primary', 'Coffee shop/Surface']);
  assert.equal(store.getState().history.undo, 'Palette');

  const readOnly = createDesignStore({doc: sampleDoc(), measurer, readOnly: true});
  const refused = await run('create_layers', {parent: null, layers: [{id: 'a', type: 'RECTANGLE', width: 10, height: 10}]}, context(readOnly));
  assert.equal(refused.result.ok, false);
  assert.match(refused.result.text, /read-only/);
  // A call that fails the check is refused before it touches anything.
  const bad = await run('update_layers', {updates: [{id: 'L1', fill: 'red'}]}, ctx);
  assert.equal(bad.result.ok, false);
  assert.match(bad.result.text, /check refused/);
  const unknown = await run('inspect_canvas', {}, ctx);
  assert.equal(unknown.result.ok, false);
  assert.match(unknown.result.text, /There is no tool/);
});

test('a result longer than the cap is cut with a note', () => {
  const long = 'x'.repeat(CANVAS_RESULT_CHARS + 500);
  const clipped = clipResult(long);
  assert.equal(clipped.length, CANVAS_RESULT_CHARS);
  assert.match(clipped, /cut: the result was longer/);
  assert.equal(clipResult('short'), 'short');
});

test('a picture goes into a layer\'s image fill or becomes a new layer beside the others, in one step each', () => {
  const store = createDesignStore({doc: sampleDoc(), measurer});
  const picture = {ref: 'pic1', asset: {url: '/uploads/pic1.png', width: 2048, height: 1024}};
  assert.equal(fillWithPicture(store, 'box', picture), true);
  const filled = store.getState().doc;
  assert.deepEqual(filled.images.pic1, picture.asset);
  assert.ok(filled.nodes.box!.fills.some(paint => paint.type === 'IMAGE' && paint.imageRef === 'pic1'));
  assert.equal(fillWithPicture(store, 'nope', picture), false);
  const id = insertPicture(store, picture, {x: 500, y: 400}, {width: 1024, height: 1024}, 'Photo');
  const layer = store.getState().doc.nodes[id]!;
  assert.deepEqual([layer.name, layer.parentId, layer.width, layer.height], ['Photo', 'page', 1024, 512], 'its own proportions, within the box');
});
