import './helpers/linux-platform';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {cardMeta, layerRole, layerShownOn, withCardMeta, withLayerShownOn, type CardMeta} from '../shared/design/marketplace/meta';
import {marketplaceSpec} from '../shared/design/marketplace/specs';
import type {LintReport} from '../shared/design/marketplace/lint';
import {createDesignStore, DEFAULT_UI, type EditorState} from '../src/design/engine/store';
import {runCommand, type CommandContext} from '../src/design/engine/commands';
import {installEditorCommands, resolveCommand} from '../src/design/editor/command-bridge';
import {FRAME_PRESET_GROUPS, insertPresetFrame} from '../src/design/panels/frame-presets';
import {fitCardFrame, hasMarketplaceAspect, makeCard, setCardMarketplace, setLayerRole, setLayerShownOn, unmakeCard} from '../src/design/marketplace/canvas/card-ops';
import {drawCardZones, zoneCorners} from '../src/design/marketplace/canvas/zones-overlay';
import {cardRenderDoc, cardSignature} from '../src/design/marketplace/canvas/card-doc';
import {newCardFileName} from '../src/design/marketplace/canvas/new-card';
import {tallyOf, verdictText} from '../src/design/marketplace/canvas/verdict';

// Card Canvas in the editor (docs/marketplaces.md §Card Canvas): the "Marketplaces" frames, making, refitting and moving a card,
// layer roles — each one undo step —, the badge zones on the overlay and the copy of a card Spec Lint renders.

installEditorCommands();

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const WB: CardMeta = {v: 1, marketplace: 'wb', slide: 'main', group: 'set'};

type Add = (type: SceneNode['type'], id: NodeId, parent: NodeId, props?: Partial<SceneNode>) => void;
function build(recipe: (add: Add) => void = () => {}): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  recipe((type, id, parent, props = {}) => tx.create(createNode(type, {id, ...props}), parent));
  return tx.commit({measurer}).doc;
}
const storeOf = (doc: DesignDocument) => {
  const store = createDesignStore({doc, measurer});
  store.setViewport({x: 0, y: 0, zoom: 1});
  return store;
};

test('"Marketplaces" frames: a preset inserts a card of that marketplace, named for its main photo, in one step', () => {
  const group = FRAME_PRESET_GROUPS.find(entry => entry.id === 'marketplace')!;
  assert.equal(group.label, 'Marketplaces');
  assert.deepEqual(group.presets.map(preset => [preset.name, preset.width, preset.height, preset.marketplace]), [
    ['Wildberries', 900, 1200, 'wb'], ['Ozon', 900, 1200, 'ozon'], ['Ozon fresh 1:1', 1200, 1200, 'ozon'], ['Yandex Market', 900, 1200, 'ym'],
  ]);
  const store = storeOf(build());
  const id = insertPresetFrame(store, group.presets[3], {x: 0, y: 0});
  const frame = store.getState().doc.nodes[id];
  assert.equal(frame.name, 'YM · Main photo');
  const meta = cardMeta(frame)!;
  assert.deepEqual([meta.marketplace, meta.slide, typeof meta.group], ['ym', 'main', 'string']);
  assert.equal(store.getState().history.undo, 'Card YM');
  // A second card is a set of its own.
  const other = insertPresetFrame(store, group.presets[0], {x: 0, y: 0});
  assert.notEqual(cardMeta(store.getState().doc.nodes[other])!.group, meta.group);
  store.undo();
  store.undo();
  assert.equal(store.getState().doc.nodes[id], undefined);
  // A plain preset stays a plain frame.
  const plain = insertPresetFrame(store, FRAME_PRESET_GROUPS[0].presets[0], {x: 0, y: 0});
  assert.equal(store.getState().doc.nodes[plain].pluginData, undefined);
});

test('a plain frame becomes a card, moves to another marketplace and back to a frame, each one undo step', () => {
  const store = storeOf(build(add => add('FRAME', 'f', 'page', {name: 'Cover', width: 900, height: 1200})));
  makeCard(store, 'f', 'ozon');
  assert.equal(cardMeta(store.getState().doc.nodes.f)!.marketplace, 'ozon');
  assert.equal(store.getState().doc.nodes.f.name, 'Cover', 'a name of the user\'s own is kept');
  store.transact('Name', tx => tx.update('f', {name: 'Ozon · Main photo'}));
  setCardMarketplace(store, 'f', 'wb');
  assert.deepEqual([cardMeta(store.getState().doc.nodes.f)!.marketplace, store.getState().doc.nodes.f.name], ['wb', 'WB · Main photo']);
  store.undo();
  assert.deepEqual([cardMeta(store.getState().doc.nodes.f)!.marketplace, store.getState().doc.nodes.f.name], ['ozon', 'Ozon · Main photo']);
  unmakeCard(store, 'f');
  assert.equal(cardMeta(store.getState().doc.nodes.f), null);
  assert.equal(store.getState().doc.nodes.f.pluginData, undefined, 'no empty pluginData left behind');
});

test('proportions: 3:4 within 1 %, Ozon also square; "Fit" scales the content in and centres it on the new room', () => {
  assert.ok(hasMarketplaceAspect({width: 900, height: 1200}, 'wb'));
  assert.ok(hasMarketplaceAspect({width: 1500, height: 2000}, 'ym'));
  assert.ok(hasMarketplaceAspect({width: 1200, height: 1200}, 'ozon'));
  assert.ok(!hasMarketplaceAspect({width: 1200, height: 1200}, 'wb'));
  assert.ok(!hasMarketplaceAspect({width: 0, height: 1200}, 'wb'));
  const store = storeOf(build(add => {
    add('FRAME', 'f', 'page', {x: 50, y: 60, width: 1080, height: 1080});
    add('RECTANGLE', 'r', 'f', {x: 108, y: 108, width: 216, height: 216});
  }));
  fitCardFrame(store, 'f', 'wb');
  const doc = store.getState().doc;
  assert.deepEqual([doc.nodes.f.x, doc.nodes.f.y, doc.nodes.f.width, doc.nodes.f.height], [50, 60, 900, 1200]);
  // 1080 → 900 is ×5/6; then 150 px of new room above and below.
  assert.deepEqual([doc.nodes.r.x, doc.nodes.r.y, doc.nodes.r.width, doc.nodes.r.height], [90, 90 + 150, 180, 180]);
  assert.equal(store.getState().history.undo, 'Fit to 900 × 1200');
  store.undo();
  assert.deepEqual([store.getState().doc.nodes.f.width, store.getState().doc.nodes.r.x], [1080, 108]);
});

test('layer roles: "Product" locks the layer and leaving it unlocks; "Show on" drops the key when all are on', () => {
  const store = storeOf(build(add => {
    add('FRAME', 'card', 'page', {width: 900, height: 1200, pluginData: withCardMeta(undefined, WB)});
    add('RECTANGLE', 'photo', 'card', {width: 500, height: 600});
  }));
  setLayerRole(store, 'photo', 'product');
  let node = store.getState().doc.nodes.photo;
  assert.deepEqual([layerRole(node), node.locked], ['product', true]);
  assert.equal(store.getState().history.undo, 'Role: product');
  setLayerRole(store, 'photo', 'logo');
  node = store.getState().doc.nodes.photo;
  assert.deepEqual([layerRole(node), node.locked], ['logo', false]);
  setLayerRole(store, 'photo', null);
  assert.equal(store.getState().doc.nodes.photo.pluginData, undefined);
  store.undo();
  assert.equal(layerRole(store.getState().doc.nodes.photo), 'logo');
  setLayerShownOn(store, 'photo', ['ozon', 'ym']);
  assert.deepEqual(layerShownOn(store.getState().doc.nodes.photo), ['ozon', 'ym']);
  setLayerShownOn(store, 'photo', ['ozon', 'ym', 'wb']);
  assert.equal(layerShownOn(store.getState().doc.nodes.photo), null);
  assert.equal(store.getState().doc.nodes.photo.pluginData?.['morfa.mp.show'], undefined);
});

// ── Badge zones ──────────────────────────────────────────────────────────────────────────────────

/** A 2D context that records what is drawn. */
function recorder() {
  const calls: {name: string; args: unknown[]}[] = [];
  const target: Record<string, unknown> = {measureText: (text: string) => ({width: text.length * 6})};
  const ctx = new Proxy(target, {
    get: (object, key: string) => (key in object ? object[key] : (...args: unknown[]) => void calls.push({name: key, args})),
    set: (object, key: string, value) => {
      object[key] = value;
      calls.push({name: `set ${key}`, args: [value]});
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {ctx, calls, count: (name: string) => calls.filter(call => call.name === name).length, texts: () => calls.filter(call => call.name === 'fillText').map(call => call.args[0])};
}

function zonesScene(selection: NodeId[], zoom: number, cardZones = true) {
  const doc = build(add => {
    add('FRAME', 'wb', 'page', {x: 0, y: 0, width: 900, height: 1200, pluginData: withCardMeta(undefined, WB)});
    add('FRAME', 'ym', 'page', {x: 1000, y: 0, width: 900, height: 1200, pluginData: withCardMeta(undefined, {v: 1, marketplace: 'ym'})});
    add('FRAME', 'far', 'page', {x: 90_000, y: 0, width: 900, height: 1200, pluginData: withCardMeta(undefined, WB)});
    add('FRAME', 'plain', 'page', {x: 0, y: 2000, width: 900, height: 1200});
    add('TEXT', 'title', 'wb', {text: defaultTextProps('Title')});
  });
  const state = {doc, pageId: 'page', selection, ui: {...DEFAULT_UI, cardZones}} as unknown as EditorState;
  return {state, viewport: {x: 0, y: 0, zoom}, size: {width: 2000, height: 1500}};
}

test('badge zones: every card on screen gets its marketplace\'s zones; labels only on the selected card at a legible zoom', () => {
  const wbZones = marketplaceSpec('wb').safeZones.length, ymZones = marketplaceSpec('ym').safeZones.length;
  const plain = recorder();
  drawCardZones(plain.ctx, zonesScene([], 1));
  assert.equal(plain.count('fill'), wbZones + ymZones, 'the far card is off screen, the plain frame has none');
  assert.equal(plain.count('stroke'), wbZones + ymZones);
  assert.deepEqual(plain.texts(), []);
  // A layer of the WB card selected: its zones are named; YM's are not.
  const selected = recorder();
  drawCardZones(selected.ctx, zonesScene(['title'], 1));
  assert.deepEqual(selected.texts(), marketplaceSpec('wb').safeZones.map(zone => zone.label));
  // Zoomed out, the zones are too small to name.
  const small = recorder();
  drawCardZones(small.ctx, zonesScene(['wb'], 0.1));
  assert.deepEqual(small.texts(), []);
  assert.ok(small.count('fill') > 0);
  // "View ▸ Marketplace badge zones" off: nothing.
  const off = recorder();
  drawCardZones(off.ctx, zonesScene(['wb'], 1, false));
  assert.equal(off.calls.length, 0);
  // Zones follow the frame: WB's favourite zone is the top-right 17 % × 11 %.
  const favourite = marketplaceSpec('wb').safeZones.find(zone => zone.id === 'favourite')!;
  const corners = zoneCorners([[0.5, 0, 10], [0, 0.5, 20]], {width: 900, height: 1200}, favourite);
  assert.ok(Math.abs(corners[0].x - (10 + 0.83 * 450)) < 1e-6 && Math.abs(corners[2].y - (20 + 0.11 * 600)) < 1e-6);
});

test('"View ▸ Marketplace badge zones" toggles the overlay', () => {
  const store = storeOf(build());
  const ctx: CommandContext = {store, canvasSize: () => ({width: 1000, height: 800})};
  assert.equal(store.getState().ui.cardZones, true);
  assert.ok(runCommand(resolveCommand('view.card-zones')?.id ?? 'view.card-zones', ctx));
  assert.equal(store.getState().ui.cardZones, false);
});

// ── What Spec Lint renders and when it re-checks ─────────────────────────────────────────────────

test('the card copy Spec Lint renders: the card and its ancestors only, hidden layers for the marketplace, texts on request', () => {
  const doc = build(add => {
    add('SECTION', 'section', 'page', {width: 2000, height: 2000});
    add('FRAME', 'card', 'section', {width: 900, height: 1200, pluginData: withCardMeta(undefined, WB)});
    add('TEXT', 'title', 'card', {text: defaultTextProps('Title')});
    add('RECTANGLE', 'logo', 'card', {pluginData: withLayerShownOn(undefined, ['ozon'])});
    add('RECTANGLE', 'elsewhere', 'page');
  });
  const withText = cardRenderDoc(doc, 'card', 'wb', false);
  assert.deepEqual(Object.keys(withText.nodes).sort(), ['card', 'logo', 'page', 'section', 'title']);
  assert.equal(withText.nodes.logo.visible, false);
  assert.equal(withText.nodes.title, doc.nodes.title, 'unchanged layers are shared, not copied');
  const withoutText = cardRenderDoc(doc, 'card', 'ozon', true);
  assert.deepEqual([withoutText.nodes.title.visible, withoutText.nodes.logo.visible], [false, true]);
  assert.equal(doc.nodes.title.visible, true, 'the document is untouched');
});

test('a card is re-checked when its own layers change, not for an edit elsewhere in the file', () => {
  const store = storeOf(build(add => {
    add('FRAME', 'card', 'page', {width: 900, height: 1200, pluginData: withCardMeta(undefined, WB)});
    add('TEXT', 'title', 'card', {text: defaultTextProps('Title')});
    add('RECTANGLE', 'elsewhere', 'page', {x: 2000});
  }));
  const before = cardSignature(store.getState().doc, 'card');
  store.transact('Shift', tx => tx.update('elsewhere', {x: 2100}));
  const same = cardSignature(store.getState().doc, 'card');
  assert.ok(before.length === same.length && before.every((value, i) => value === same[i]));
  store.transact('Shift', tx => tx.update('title', {x: 10}));
  const after = cardSignature(store.getState().doc, 'card');
  assert.ok(!before.every((value, i) => value === after[i]));
});

test('the verdict in words and the new file\'s name', () => {
  const checks = (statuses: string[]) => ({checks: statuses.map(status => ({status}))}) as unknown as Pick<LintReport, 'checks'>;
  assert.deepEqual(tallyOf(checks(['pass', 'fail', 'fail', 'warn', 'pending'])), {fail: 2, warn: 1, pending: 1});
  const report = (statuses: string[], status: LintReport['status']): LintReport => ({...checks(statuses), marketplace: 'wb', rulesVersion: '', status});
  assert.equal(verdictText(report(['fail', 'fail', 'warn'], 'fail'), false), '2 errors, 1 remark');
  assert.equal(verdictText(report(['warn', 'warn', 'warn', 'warn', 'warn'], 'warn'), false), '5 remarks');
  assert.equal(verdictText(report(['pass'], 'pass'), false), 'passes');
  assert.equal(verdictText(report(['pending'], 'pending'), true), 'checking');
  assert.equal(newCardFileName({marketplace: 'ym', set: 'single'}), 'YM card');
  assert.equal(newCardFileName({marketplace: 'ozon', set: 'kit'}), 'Ozon cards');
});
