import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, solid, BLACK} from '../shared/design/defaults';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import type {DesignDocument, NodeType, SceneNode} from '../shared/design/types';
import {DESIGN_BIG_FILE_CAPS, DESIGN_DOCUMENT_CAPS} from '../shared/design/limits';
import {bigFilesEnabled, documentCaps, setBigFiles} from '../shared/design/big-files';
import {DESIGN_FIELD_LIMITS} from '../shared/design/document-limits';
import {checkPatchedDocument, designDocumentSchema, documentImageFiles, isSafeDesignUrl, patchIssues, validateDocument, validatePatch} from '../shared/design/schema';
import {budget} from './helpers/speed';

// shared/design/schema.ts: what a stored "Morfa Design" document may contain (docs/design-tool.md §The document).

const clone = <T>(value: T): T => structuredClone(value);

/** A page with a frame holding a rectangle, a text and a group of one ellipse. */
function sample(): DesignDocument {
  const doc = createDocument('page');
  const add = (type: NodeType, id: string, parentId: string, props: Partial<SceneNode> = {}) => {
    doc.nodes[id] = createNode(type, {id, parentId, ...props});
    doc.nodes[parentId].children!.push(id);
    return doc.nodes[id];
  };
  add('FRAME', 'frame', 'page', {width: 375, height: 812, name: 'Main screen'});
  add('RECTANGLE', 'rect', 'frame', {fills: [{type: 'IMAGE', imageRef: 'dz-1', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  const text = add('TEXT', 'text', 'frame');
  text.text!.characters = 'Hello, design';
  text.text!.runs = [{start: 0, end: 6, style: {fontWeight: 700}, fills: [solid(BLACK)]}];
  add('GROUP', 'group', 'frame');
  add('ELLIPSE', 'ellipse', 'group');
  doc.images['dz-1'] = {url: '/uploads/dz-1.webp', width: 1200, height: 800, name: 'Photo.jpg'};
  doc.nodes.frame.reactions = [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'https://foo.test', openInNewTab: true}]}];
  return doc;
}

function refused(doc: unknown, pattern?: RegExp) {
  const result = validateDocument(doc);
  assert.equal(result.ok, false, 'expected the document to be refused');
  if (!result.ok) {
    assert.match(result.error, /[a-z]/i, 'the message is English: ' + result.error);
    if (pattern) assert.match(result.path, pattern, result.path + ': ' + result.error);
  }
  return result;
}

test('a well-formed document passes and comes back as the same value', () => {
  const doc = sample();
  const result = validateDocument(doc);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && result.value, doc);
  assert.equal(designDocumentSchema.safeParse(sample()).success, true, 'zod agrees');
  assert.deepEqual(documentImageFiles(doc), ['dz-1.webp']);
});

test('an SVG export setting keeps "Include id attribute"; anything but a boolean there is refused', () => {
  const doc = sample();
  doc.nodes.rect.exportSettings = [{format: 'SVG', suffix: '', constraint: {type: 'SCALE', value: 1}, svgIdAttribute: true}];
  const result = validateDocument(doc);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && result.value.nodes.rect.exportSettings[0].svgIdAttribute, true);
  const bad = sample();
  (bad.nodes.rect as {exportSettings: unknown[]}).exportSettings = [{format: 'SVG', suffix: '', constraint: {type: 'SCALE', value: 1}, svgIdAttribute: 'yes'}];
  assert.equal(validateDocument(bad).ok, false);
  assert.equal(designDocumentSchema.safeParse(bad).success, false, 'zod agrees');
});

test('"Constrain proportions" is stored on the layer and survives validation and patches', () => {
  const doc = sample();
  doc.nodes.rect.constrainProportions = true;
  const result = validateDocument(doc);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.ok && result.value.nodes.rect.constrainProportions, true);
  const patch: DocumentPatch = {nodes: {rect: {...doc.nodes.rect, constrainProportions: true}}};
  assert.equal(validatePatch(patch).ok, true);
  assert.equal(validateDocument({...sample(), nodes: {...sample().nodes, rect: {...sample().nodes.rect, constrainProportions: 'yes' as never}}}).ok, false);
});

test('unknown keys are dropped, as zod would strip them', () => {
  const doc = sample() as DesignDocument & {extra?: string};
  doc.extra = 'x';
  (doc.nodes.rect as SceneNode & {secret?: string}).secret = 'y';
  const result = validateDocument(doc);
  assert.equal(result.ok, true);
  assert.equal('extra' in doc, false);
  assert.equal('secret' in doc.nodes.rect, false);
});

test('each structural invariant is checked, with an English message and a path', () => {
  const cases: [string, (doc: DesignDocument) => void, RegExp][] = [
    ['missing parent', doc => (doc.nodes.rect.parentId = 'nowhere'), /nodes\.(rect|frame)/],
    ['child not listed by its parent', doc => doc.nodes.frame.children!.splice(0, 1), /nodes\.rect\.parentId/],
    ['child listed twice', doc => doc.nodes.frame.children!.push('rect'), /nodes\./],
    ['children list names a node of another parent', doc => doc.nodes.group.children!.push('rect'), /nodes\./],
    ['nested page', doc => (doc.nodes.page.parentId = 'frame'), /nodes\.page/],
    ['page missing from pages', doc => (doc.pages = ['frame']), /pages\.0/],
    ['page repeated', doc => doc.pages.push('page'), /pages\.1/],
    ['unlisted page node', doc => (doc.nodes.page2 = createNode('PAGE', {id: 'page2'})), /nodes\.page2/],
    ['leaf with children', doc => (doc.nodes.rect.children = []), /nodes\.rect\.children/],
    ['container without children', doc => delete doc.nodes.group.children, /nodes\./],
    ['empty group', doc => {
      doc.nodes.group.children = [];
      delete doc.nodes.ellipse;
    }, /nodes\.group\.children/],
    ['key differs from id', doc => (doc.nodes.rect.id = 'other'), /nodes\.rect/],
    ['text without text', doc => delete doc.nodes.text.text, /nodes\.text\.text/],
    ['text on a rectangle', doc => (doc.nodes.rect.text = clone(doc.nodes.text.text)), /nodes\.rect\.text/],
    ['overlapping runs', doc => doc.nodes.text.text!.runs.push({start: 3, end: 8, style: {}}), /nodes\.text\.text\.runs\.1/],
    ['run outside the text', doc => (doc.nodes.text.text!.runs = [{start: 0, end: 99, style: {}}]), /nodes\.text\.text\.runs\.0/],
    ['empty run', doc => (doc.nodes.text.text!.runs = [{start: 2, end: 2, style: {}}]), /runs\.0/],
    ['style key differs from id', doc => (doc.styles.s1 = {id: 's2', type: 'FILL', name: 'Brand', description: '', paints: []}), /styles\.s1/],
    ['negative size', doc => (doc.nodes.rect.width = -1), /nodes\.rect\.width/],
    ['opacity above 1', doc => (doc.nodes.rect.opacity = 1.5), /nodes\.rect\.opacity/],
    ['unknown node type', doc => ((doc.nodes.rect as {type: string}).type = 'WIDGET'), /nodes\.rect\.type/],
    ['unknown blend mode', doc => ((doc.nodes.rect as {blendMode: string}).blendMode = 'GLOW'), /nodes\.rect\.blendMode/],
    ['schema version', doc => ((doc as {schemaVersion: number}).schemaVersion = 2), /schemaVersion/],
    ['no pages', doc => (doc.pages = []), /pages/],
  ];
  const wrong: string[] = [];
  for (const [name, change, path] of cases) {
    const doc = sample();
    change(doc);
    const result = validateDocument(doc);
    if (result.ok) wrong.push(name + ': accepted');
    else if (!/[a-z]/i.test(result.error) || !path.test(result.path)) wrong.push(`${name}: ${result.path} — ${result.error}`);
  }
  assert.deepEqual(wrong, []);
});

test('a cycle unreachable from any page is refused', () => {
  const doc = sample();
  doc.nodes.a = createNode('FRAME', {id: 'a', parentId: 'b', children: ['b']});
  doc.nodes.b = createNode('FRAME', {id: 'b', parentId: 'a', children: ['a']});
  refused(doc, /nodes\.(a|b)/);
});

test('nesting deeper than the limit is refused without recursion', () => {
  const doc = sample();
  let parent = 'frame';
  for (let i = 0; i < DESIGN_FIELD_LIMITS.depth + 5; i++) {
    const id = 'deep' + i;
    doc.nodes[id] = createNode('FRAME', {id, parentId: parent});
    doc.nodes[parent].children!.push(id);
    parent = id;
  }
  refused(doc, /nodes\.deep/);
});

test('instance copies follow `${instanceId};${mainId}` and live under their instance', () => {
  const valid = () => {
    const doc = sample();
    doc.nodes.inst = createNode('INSTANCE', {id: 'inst', parentId: 'frame', componentId: 'comp'});
    doc.nodes.frame.children!.push('inst');
    doc.nodes['inst;child'] = createNode('RECTANGLE', {id: 'inst;child', parentId: 'inst', mainId: 'child'});
    doc.nodes.inst.children!.push('inst;child');
    // A nested instance and its own copy: the outer instance's id prefixes both.
    doc.nodes['inst;nested'] = createNode('INSTANCE', {id: 'inst;nested', parentId: 'inst', mainId: 'nested', componentId: 'other'});
    doc.nodes.inst.children!.push('inst;nested');
    doc.nodes['inst;nested;leaf'] = createNode('TEXT', {id: 'inst;nested;leaf', parentId: 'inst;nested', mainId: 'leaf'});
    doc.nodes['inst;nested'].children!.push('inst;nested;leaf');
    return doc;
  };
  assert.equal(validateDocument(valid()).ok, true, JSON.stringify(validateDocument(valid())));
  const wrongId = valid();
  wrongId.nodes['inst;child'].mainId = 'someone-else';
  refused(wrongId, /inst;child\.mainId/);
  const noMain = valid();
  delete noMain.nodes['inst;child'].mainId;
  refused(noMain, /inst;child\.mainId/);
  const outside = sample();
  outside.nodes['x;y'] = createNode('RECTANGLE', {id: 'x;y', parentId: 'frame', mainId: 'y'});
  outside.nodes.frame.children!.push('x;y');
  refused(outside, /mainId/);
});

test('prototype links and text hyperlinks are http(s) or mailto only', () => {
  // A Cyrillic path is kept on purpose: a non-ASCII URL is still a safe one.
  for (const url of ['https://foo.test/путь?q=1', 'http://example.com', 'mailto:hi@foo.test']) assert.equal(isSafeDesignUrl(url), true, url);
  for (const url of ['javascript:alert(1)', ' javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>', 'vbscript:x', '/relative', 'file:///etc/passwd', 'https://' + 'a'.repeat(3000)])
    assert.equal(isSafeDesignUrl(url), false, url);
  const action = sample();
  action.nodes.frame.reactions = [{trigger: {type: 'ON_CLICK'}, actions: [{type: 'URL', url: 'javascript:alert(document.cookie)', openInNewTab: true}]}];
  refused(action, /reactions\.0\.actions\.0\.url/);
  const link = sample();
  link.nodes.text.text!.style.hyperlink = {type: 'URL', url: 'javascript:void(0)'};
  refused(link, /hyperlink\.url/);
  const run = sample();
  run.nodes.text.text!.runs[0].style.hyperlink = {type: 'URL', url: 'data:text/html;base64,PHNjcmlwdD4='};
  refused(run, /runs\.0\.style\.hyperlink/);
});

test('pictures are same-origin /uploads files only', () => {
  for (const url of ['https://evil.example/x.png', '//evil.example/x.png', '/uploads/../users.db', '/uploads/..', '/uploads/a/b.png', 'data:image/png;base64,AAAA', '/uploads/x.png?y', '/s/site/assets/x.png', '/uploads/']) {
    const doc = sample();
    doc.images['dz-1'].url = url;
    refused(doc, /images\.dz-1\.url/);
  }
  const ok = sample();
  ok.images['dz-1'].url = '/uploads/0b5c7f3e-1d2a-4c55-9b8e-2f7a1c3d4e5f.webp';
  assert.equal(validateDocument(ok).ok, true);
});

test('hostile strings: lengths are capped, markup is only text, __proto__ never becomes a key', () => {
  const markup = sample();
  markup.nodes.rect.name = '<img src=x onerror=alert(1)> 🪴 \u0000‮';
  assert.equal(validateDocument(markup).ok, true, 'a name is plain text; nothing renders it as HTML');
  const long = sample();
  long.nodes.rect.name = 'a'.repeat(DESIGN_FIELD_LIMITS.name + 1);
  refused(long, /nodes\.rect\.name/);
  const characters = sample();
  characters.nodes.text.text!.characters = 'a'.repeat(DESIGN_FIELD_LIMITS.characters + 1);
  refused(characters, /nodes\.text\.text\.characters/);
  const proto = JSON.parse(JSON.stringify(sample()).replace('"rect":{', '"__proto__":{').replaceAll('"rect"', '"__proto__"'));
  refused(proto);
  assert.equal(({} as {polluted?: unknown}).polluted, undefined);
  const pluginData = sample();
  pluginData.nodes.rect.pluginData = JSON.parse('{"__proto__":{"polluted":true}}');
  refused(pluginData, /pluginData/);
  assert.equal(({} as {polluted?: unknown}).polluted, undefined);
  const badId = sample();
  badId.nodes['bad id'] = createNode('RECTANGLE', {id: 'bad id', parentId: 'frame'});
  badId.nodes.frame.children!.push('bad id');
  refused(badId);
  for (const value of [NaN, Infinity, -Infinity, 1e10]) {
    const doc = sample();
    doc.nodes.rect.x = value;
    refused(doc, /nodes\.rect\.x/);
  }
});

test('caps: pages, nodes and path commands', () => {
  // The fixed caps (big files off); the big-file caps have their own witness below and in crates/model/tests/big_files.rs.
  setBigFiles(false);
  try {
    fixedCaps();
  } finally {
    setBigFiles(null);
  }
});
function fixedCaps() {
  const pages = sample();
  for (let i = 0; i < DESIGN_DOCUMENT_CAPS.pages; i++) {
    const id = 'p' + i;
    pages.nodes[id] = createNode('PAGE', {id});
    pages.pages.push(id);
  }
  refused(pages, /pages/);
  const vector = sample();
  vector.nodes.vec = createNode('VECTOR', {id: 'vec', parentId: 'frame'});
  vector.nodes.frame.children!.push('vec');
  const half = Array.from({length: DESIGN_FIELD_LIMITS.pathCommands / 2 + 1}, (_, i) => ({type: 'L' as const, x: i, y: i}));
  vector.nodes.vec.vectorPaths = [{windingRule: 'NONZERO', commands: half}, {windingRule: 'EVENODD', commands: half}];
  refused(vector, /nodes\.vec\.vectorPaths/);
  const nodes = createDocument('page');
  for (let i = 0; i < DESIGN_DOCUMENT_CAPS.nodes; i++) {
    const id = 'r' + i;
    nodes.nodes[id] = createNode('RECTANGLE', {id, parentId: 'page'});
    nodes.nodes.page.children!.push(id);
  }
  refused(nodes, /^nodes$/);
}

test('a 20 000-node document of about 20 MB validates within its time budget', () => {
  const doc = createDocument('page');
  for (let f = 0; f < 200; f++) {
    const frameId = 'f' + f;
    doc.nodes[frameId] = createNode('FRAME', {id: frameId, parentId: 'page', x: f * 500, width: 400, height: 800});
    doc.nodes.page.children!.push(frameId);
    for (let c = 0; c < 99; c++) {
      const id = `n${f}_${c}`,
        type: NodeType = c % 3 === 0 ? 'TEXT' : c % 3 === 1 ? 'RECTANGLE' : 'VECTOR';
      const node = createNode(type, {id, parentId: frameId, x: c, y: c * 8, width: 100, height: 20});
      if (node.text) node.text.characters = 'Sample text ' + c;
      if (type === 'VECTOR') node.vectorPaths = [{windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}, {type: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6}, {type: 'Z'}]}];
      node.effects = [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.2}, offset: {x: 0, y: 2}, radius: 4, spread: 0, visible: true, blendMode: 'NORMAL'}];
      doc.nodes[id] = node;
      doc.nodes[frameId].children!.push(id);
    }
  }
  const text = JSON.stringify(doc);
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const value = JSON.parse(text);
    const started = performance.now();
    assert.equal(validateDocument(value).ok, true);
    best = Math.min(best, performance.now() - started);
  }
  // 300 ms is the target on an idle machine (about 200 ms measured); the bound leaves room for a busy CI runner.
  assert.ok(best < budget(1500), `validation took ${best.toFixed(0)} ms for ${(text.length / 1e6).toFixed(1)} MB`);
});

test('25 000 layers side by side in one frame validate in linear time, whole and as one patch', () => {
  // Each layer's place in its parent's list used to be found by scanning the list: 25 000 siblings (18 MB, one free
  // account's request) blocked the server's event loop for about 10 s on create or replace and 7 s on a patch.
  const doc = createDocument('page');
  for (let i = 0; i < 25_000; i++) {
    const id = 'n' + i;
    doc.nodes[id] = createNode('RECTANGLE', {id, parentId: 'page', x: i});
    doc.nodes.page.children!.push(id);
  }
  const text = JSON.stringify(doc);
  let whole = Infinity;
  for (let run = 0; run < 3; run++) {
    const value = JSON.parse(text);
    const started = performance.now();
    assert.equal(validateDocument(value).ok, true);
    whole = Math.min(whole, performance.now() - started);
  }
  assert.ok(whole < budget(1500), `validation took ${whole.toFixed(0)} ms`);
  const before = JSON.parse(text) as DesignDocument;
  const patch: DocumentPatch = {nodes: Object.fromEntries(before.nodes.page.children!.map(id => [id, {...before.nodes[id], y: 1}]))};
  const after = applyPatch(before, patch);
  const started = performance.now();
  assert.equal(checkPatchedDocument(before, after, patch).ok, true);
  const patched = performance.now() - started;
  assert.ok(patched < budget(1500), `the patch check took ${patched.toFixed(0)} ms`);
  // The faster check refuses what it refused before.
  const twice = {...after, nodes: {...after.nodes, page: {...after.nodes.page, children: [...after.nodes.page.children!, 'n7']}}};
  assert.equal(checkPatchedDocument(before, twice, {nodes: {...patch.nodes, page: twice.nodes.page}}).ok, false);
});

test('the fast checks agree with zod on refusals', () => {
  const mutations: ((doc: DesignDocument) => void)[] = [
    doc => ((doc.nodes.rect as {visible: unknown}).visible = 'yes'),
    doc => ((doc.nodes.rect.fills[0] as {scaleMode: string}).scaleMode = 'STRETCH'),
    doc => (doc.nodes.rect.dashPattern = [-1]),
    doc => ((doc.nodes.rect as {rotation: unknown}).rotation = null),
    doc => ((doc.nodes.text.text!.style as {fontSize: unknown}).fontSize = '12'),
    doc => (doc.nodes.frame.reactions[0].actions = Array.from({length: DESIGN_FIELD_LIMITS.actions + 1}, () => ({type: 'BACK' as const}))),
    doc => ((doc.nodes.rect.fills[0] as {rotation: number}).rotation = 45),
    doc => (doc.variables.v = {id: 'v', name: 'Color', collectionId: 'c', type: 'COLOR', valuesByMode: {m: {r: 2, g: 0, b: 0, a: 1}}, description: ''}),
  ];
  for (const mutate of mutations) {
    const a = sample(),
      b = sample();
    mutate(a);
    mutate(b);
    assert.equal(validateDocument(a).ok, false, mutate.toString());
    assert.equal(designDocumentSchema.safeParse(b).success, false, mutate.toString());
  }
});

test('a patch is checked on the nodes it touches', () => {
  const doc = sample();
  const ok = (patch: DocumentPatch) => {
    const shape = validatePatch(clone(patch));
    assert.equal(shape.ok, true, JSON.stringify(shape));
    return checkPatchedDocument(doc, applyPatch(doc, patch), patch);
  };
  // Move the rectangle into the group: three nodes change together.
  const moved: DocumentPatch = {
    nodes: {
      rect: {...doc.nodes.rect, parentId: 'group'},
      group: {...doc.nodes.group, children: ['ellipse', 'rect']},
      frame: {...doc.nodes.frame, children: doc.nodes.frame.children!.filter(id => id !== 'rect')},
    },
  };
  assert.equal(ok(moved).ok, true, JSON.stringify(ok(moved)));
  // A new page with its order.
  assert.equal(ok({nodes: {p2: createNode('PAGE', {id: 'p2', name: 'Page 2'})}, pages: ['page', 'p2']}).ok, true);
  // Removing a subtree with its parent's list.
  assert.equal(ok({nodes: {group: null, ellipse: null, frame: {...doc.nodes.frame, children: ['rect', 'text']}}}).ok, true);

  const broken: [string, DocumentPatch][] = [
    ['new node its parent does not list', {nodes: {r2: createNode('RECTANGLE', {id: 'r2', parentId: 'frame'})}}],
    ['removed node still listed', {nodes: {rect: null}}],
    ['removed parent leaves children', {nodes: {group: null, frame: {...doc.nodes.frame, children: ['rect', 'text']}}}],
    ['moved without leaving the old parent', {nodes: {rect: {...doc.nodes.rect, parentId: 'group'}, group: {...doc.nodes.group, children: ['ellipse', 'rect']}}}],
    ['a cycle', {nodes: {frame: {...doc.nodes.frame, parentId: 'group'}, group: {...doc.nodes.group, children: ['ellipse', 'frame']}, page: {...doc.nodes.page, children: []}}}],
    ['page not in the order', {nodes: {p2: createNode('PAGE', {id: 'p2'})}}],
    ['removed page still in the order', {nodes: {page: null}}],
    ['dropped child', {nodes: {frame: {...doc.nodes.frame, children: ['rect']}}}],
  ];
  for (const [name, patch] of broken) {
    const result = checkPatchedDocument(doc, applyPatch(doc, patch), patch);
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.match(result.error, /[a-z]/i, name);
  }
  // What the full check refuses, a patch cannot store either: a page that stops being a page while it stays
  // in the order, and instance copies left outside their instance when it changes type or a layer above
  // them moves out of it.
  const pages = sample();
  pages.nodes.p2 = createNode('PAGE', {id: 'p2', name: 'Page 2'});
  pages.pages.push('p2');
  const withInstance = sample();
  withInstance.nodes.inst = createNode('INSTANCE', {id: 'inst', parentId: 'frame', componentId: 'comp'});
  withInstance.nodes.frame.children!.push('inst');
  withInstance.nodes.holder = createNode('FRAME', {id: 'holder', parentId: 'inst'});
  withInstance.nodes.inst.children!.push('holder');
  withInstance.nodes['inst;leaf'] = createNode('RECTANGLE', {id: 'inst;leaf', parentId: 'holder', mainId: 'leaf'});
  withInstance.nodes.holder.children!.push('inst;leaf');
  assert.equal(validateDocument(clone(withInstance)).ok, true);
  const smuggled: [string, DesignDocument, DocumentPatch][] = [
    ['a page turned into a frame stays in the order', pages, {nodes: {p2: {...createNode('FRAME', {id: 'p2', parentId: 'page'})}, page: {...pages.nodes.page, children: [...pages.nodes.page.children!, 'p2']}}}],
    ['an instance turned into a frame keeps its copies', withInstance, {nodes: {inst: {...withInstance.nodes.inst, type: 'FRAME', componentId: undefined}}}],
    ['a layer moved out of an instance takes copies with it', withInstance, {nodes: {holder: {...withInstance.nodes.holder, parentId: 'page'}, inst: {...withInstance.nodes.inst, children: []}, page: {...withInstance.nodes.page, children: [...withInstance.nodes.page.children!, 'holder']}}}],
  ];
  for (const [name, before, patch] of smuggled) {
    assert.equal(validatePatch(clone(patch)).ok, true, name);
    assert.equal(validateDocument(clone(applyPatch(before, patch))).ok, false, name + ': the full check refuses the result');
    const result = checkPatchedDocument(before, applyPatch(before, patch), patch);
    assert.equal(result.ok, false, name);
    if (!result.ok) assert.match(result.error, /[a-z]/i, name);
  }

  const shape = validatePatch({nodes: {rect: {...doc.nodes.rect, opacity: 7}}});
  assert.equal(shape.ok, false);
  assert.equal(validatePatch({images: {x: {url: 'https://evil.example/x.png', width: 1, height: 1}}}).ok, false);
  assert.equal(validatePatch({nodes: JSON.parse('{"__proto__":null}')}).ok, false);
});

test('the big-files switch moves the caps (shared/design/big-files.ts)', () => {
  const nodes = createDocument('page');
  for (let i = 0; i < DESIGN_DOCUMENT_CAPS.nodes; i++) {
    const id = 'r' + i;
    nodes.nodes[id] = createNode('RECTANGLE', {id, parentId: 'page'});
    nodes.nodes.page.children!.push(id);
  }
  const removals = {nodes: Object.fromEntries(Array.from({length: DESIGN_DOCUMENT_CAPS.nodes + 1}, (_, i) => ['n' + i, null]))};
  try {
    setBigFiles(false);
    assert.deepEqual(documentCaps(), DESIGN_DOCUMENT_CAPS);
    refused(nodes, /^nodes$/);
    assert.equal(validatePatch(structuredClone(removals)).ok, false, 'a patch past the cap');
    assert.equal(patchIssues(removals).length, 1);
    setBigFiles(true);
    assert.deepEqual(documentCaps(), DESIGN_BIG_FILE_CAPS);
    const accepted = validateDocument(structuredClone(nodes));
    assert.equal(accepted.ok, true, 'accepted with the switch on');
    assert.equal(validatePatch(structuredClone(removals)).ok, true);
    assert.equal(patchIssues(removals).length, 0);
    assert.equal(checkPatchedDocument(nodes, nodes, {nodes: {r0: nodes.nodes.r0}}).ok, true);
  } finally {
    setBigFiles(null);
  }
  assert.equal(bigFilesEnabled(), process.env.DESIGN_BIG_FILES === '1');
});
