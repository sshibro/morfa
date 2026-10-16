import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DesignDocument, NodeId, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {setEngine} from '../shared/design/engine-switch';
import {applyPatch} from '../shared/design/patch';
import {templateById, type TemplateId} from '../shared/design/templates';
import {topLevelSelection} from '../shared/design/tree';
import {cssForLayers} from '../shared/design/codegen/css';
import {toReact} from '../shared/design/codegen/react';
import {collectTokens, suggestTokens} from '../shared/design/codegen/tokens';
import {fontFallback} from '../src/design/engine/commands/code';
import {boxModel, cssList, detectAssets, exportAssets, layoutRows, stylesUsed, typographyRows} from '../src/design/panels/code/inspect';
import {codeScope, scopeHolds} from '../src/design/panels/code/scope';
import {buttonFile, showcaseFile} from './design-codegen-fixture';

// "Code" keeps what it shows while nothing it reads changes (src/design/panels/code/scope.ts). That holds only if the scope
// lists every layer the generator and the sections read: each is run here on a recording document, for every kind of
// selection of the starter templates and the codegen fixtures, and must read nothing outside the selection's scope. The
// recording pass runs the TypeScript engine: in `both` the oracle hands a document it has not seen (the recording one) to
// the wasm side whole, which is the harness's read, not the tab's (the editor's shadow follows the store instead).

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.56, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function templateDoc(id: TemplateId): DesignDocument {
  let seq = 0;
  return templateById(id)!.build({measurer, newId: () => `n${(seq++).toString(36)}`});
}

/** The document with every read of a layer recorded, and every whole table read. */
function recording(doc: DesignDocument) {
  const layers = new Set<string>();
  const tables = new Set<string>();
  const nodes = new Proxy(doc.nodes, {
    get: (target, key, receiver) => (typeof key === 'string' && layers.add(key), Reflect.get(target, key, receiver)),
    has: (target, key) => (typeof key === 'string' && layers.add(key), Reflect.has(target, key)),
    ownKeys: target => (layers.add('(every layer)'), Reflect.ownKeys(target)),
  });
  const recorded = new Proxy(doc, {
    get: (target, key, receiver) => {
      if (key === 'nodes') return nodes;
      if (typeof key === 'string') tables.add(key);
      return Reflect.get(target, key, receiver);
    },
  });
  return {doc: recorded, layers, tables};
}

/** Selections a designer makes: each top-level layer, each component set, and some instances, texts and frames inside. */
function selections(doc: DesignDocument): NodeId[][] {
  const all = Object.values(doc.nodes);
  const top = doc.pages.flatMap(pageId => doc.nodes[pageId]?.children ?? []);
  const some = (type: SceneNode['type'], count: number) => all.filter(node => node.type === type && !top.includes(node.id)).slice(0, count).map(node => node.id);
  const picked = [...top, ...some('COMPONENT_SET', 20), ...some('INSTANCE', 6), ...some('TEXT', 4), ...some('FRAME', 4), ...some('COMPONENT', 3)];
  return [...new Set(picked)].map(id => [id]).concat(top.length > 1 ? [top.slice(0, 2)] : []);
}

const SOURCES: {name: string; doc: () => DesignDocument}[] = [
  ...(['ui-kit', 'mobile', 'site', 'presentation', 'social'] as TemplateId[]).map(id => ({name: id, doc: () => templateDoc(id)})),
  {name: 'fixture', doc: () => showcaseFile()},
  {name: 'buttons', doc: () => buttonFile().doc},
];

const READ_TABLES = new Set(['styles', 'images', 'variables', 'variableCollections', 'variableModes']);

for (const source of SOURCES) {
  test(`${source.name}: the code and every section read nothing outside the selection's scope`, () => {
    // Arrange: the token table is cached per document tables, as in the editor (it reads which layers bind a number
    // variable, a table-wide fact the scope's tables stand for).
    const doc = source.doc();
    collectTokens(doc, {fontFallback});
    const restore = setEngine('*', 'ts');
    try {
      readsOf(source.name, doc);
    } finally {
      restore();
    }
  });
}

/** Runs what the tab computes for each selection of `doc` on a recording copy; every read must be in the scope. */
function readsOf(name: string, doc: DesignDocument) {
  for (const ids of selections(doc)) {
    const scope = codeScope(doc, ids);
    assert.ok(scope, `a scope for ${ids}`);
    const {doc: watched, layers, tables} = recording(doc);

    // Act: what the tab computes for this selection.
    const top = topLevelSelection(watched, ids).filter(id => watched.nodes[id] && watched.nodes[id].type !== 'PAGE');
    for (const styling of ['css-modules', 'tailwind', 'inline'] as const) toReact(watched, top, {styling, measurer, fontFallback});
    cssForLayers(watched, top, {fontFallback});
    const tokens = suggestTokens(collectTokens(watched, {fontFallback}));
    const node = top.length === 1 ? watched.nodes[top[0]] : undefined;
    if (node) {
      boxModel(watched, node);
      layoutRows(node);
      typographyRows(node, tokens);
      cssList(watched, node.id, {fontFallback});
    }
    stylesUsed(watched, top, tokens);
    detectAssets(watched, top, {measurer});
    exportAssets(watched, top);

    // Assert
    const outside = [...layers].filter(id => !scope.nodes.has(id) && !scope.kinds.has(id));
    assert.deepEqual(outside, [], `${name} [${ids}] (${ids.map(id => doc.nodes[id]?.name).join(', ')}) reads outside its scope: ${outside.map(id => `${id} ${doc.nodes[id]?.type} «${doc.nodes[id]?.name}»`).join('; ')}`);
    assert.deepEqual([...tables].filter(table => !READ_TABLES.has(table) && table !== 'pages' && table !== 'schemaVersion'), [], `${name} [${ids}]`);
  }
}

test('the scope holds through a change elsewhere and breaks on one inside, on its parent, a sibling, a component it uses or a table', () => {
  // Arrange: the UI kit's login example (an input, a checkbox, a button: instances of three sets).
  const doc = templateDoc('ui-kit');
  const form = Object.values(doc.nodes).find(node => node.name === 'Example: sign in')!;
  const scope = codeScope(doc, [form.id])!;
  const edit = (id: NodeId, partial: Partial<SceneNode>) => applyPatch(doc, {nodes: {[id]: {...doc.nodes[id], ...partial}}});
  const find = (test: (node: SceneNode) => boolean) => Object.values(doc.nodes).find(test)!;
  const inside = find(node => node.type === 'TEXT' && node.parentId !== null && scope.nodes.has(node.id) && isInside(doc, node.id, form.id));
  const set = find(node => node.type === 'COMPONENT_SET' && node.name === 'Checkbox');
  const variantLayer = find(node => node.type === 'TEXT' && isInside(doc, node.id, set.id));
  const elsewhere = find(node => node.type === 'TEXT' && !scope.nodes.has(node.id));
  const sibling = doc.nodes[form.parentId!].children!.find(id => id !== form.id)!;

  // Act + Assert
  assert.equal(scopeHolds(scope, doc), true);
  assert.equal(scopeHolds(scope, edit(elsewhere.id, {x: elsewhere.x + 10})), true, 'a layer the tab does not read');
  assert.equal(scopeHolds(scope, edit(inside.id, {x: inside.x + 10})), false, 'a layer inside the selection');
  assert.equal(scopeHolds(scope, edit(form.parentId!, {name: 'Other'})), false, 'its parent');
  assert.equal(scopeHolds(scope, edit(sibling, {layoutSizingVertical: 'FIXED'})), false, 'a sibling');
  assert.equal(scopeHolds(scope, edit(variantLayer.id, {opacity: 0.5})), false, 'a layer of a component an instance uses');
  assert.equal(scopeHolds(scope, {...doc, styles: {...doc.styles}}), false, 'the styles');
  assert.equal(scopeHolds(scope, {...doc, variables: {...doc.variables}}), false, 'the variables');
  // A layer added to the page elsewhere changes the page, which the tab reads only for being a page.
  const page = doc.nodes[doc.pages[0]];
  assert.equal(scopeHolds(scope, applyPatch(doc, {nodes: {[page.id]: {...page, children: [...page.children!]}}})), true);
});

function isInside(doc: DesignDocument, id: NodeId, ancestor: NodeId): boolean {
  for (let node: SceneNode | undefined = doc.nodes[id]; node; node = node.parentId ? doc.nodes[node.parentId] : undefined) if (node.id === ancestor) return true;
  return false;
}
