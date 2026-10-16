import test from 'node:test';
import assert from 'node:assert/strict';
import {showcaseFile, measurer} from './design-codegen-fixture';
import {
  capFiles,
  codeFor,
  fileLink,
  fileOutline,
  layerTree,
  MAX_TREE_NODES,
  parseLink,
  targetOf,
  variablesAndStyles,
} from '../server/mcp/design-read';
import {ToolError} from '../server/mcp/errors';
import {createDocument, createNode} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';

// What the MCP tools say about a document (server/mcp/design-read.ts), on the code generator's own fixture: the outline, a layer tree,
// code in every format, the variables and styles, and the links an assistant is given or hands back.

const FILE = '0f8fad5b-d9cb-469f-a165-70867728950e';
const refusal = (code: string) => (error: unknown) => error instanceof ToolError && error.code === code;

test('should read a file and a layer from a Morfa link, as "Copy link to layer" writes it', () => {
  const link = fileLink('https://app.morfa.example', FILE, 'card');
  assert.equal(link, `https://app.morfa.example/#design/${FILE}?node=card`);
  assert.deepEqual(parseLink(link), {fileId: FILE, nodeId: 'card'});
  assert.deepEqual(parseLink(`https://app.morfa.example/#design/${FILE}`), {fileId: FILE});
  assert.deepEqual(targetOf({link, nodeId: 'name'}), {fileId: FILE, nodeId: 'name'}, 'a layer id beside a link wins');
  assert.deepEqual(targetOf({fileId: FILE}), {fileId: FILE});
  for (const link of ['https://app.morfa.example/#designs', 'not a link', 'https://app.morfa.example/#design/../etc'])
    assert.throws(() => targetOf({link}), refusal('invalid_input'), link);
  assert.throws(() => targetOf({}), refusal('invalid_input'));
  assert.throws(() => targetOf({fileId: "x' OR 1=1"}), refusal('invalid_input'));
});

test('should outline the pages with their top-level layers, top of the panel first', () => {
  const doc = showcaseFile();
  const outline = fileOutline(doc);
  assert.equal(outline.pages.length, 1);
  const [page] = outline.pages;
  assert.equal(page!.name, 'Home');
  // The card was added last, so it is on top.
  assert.equal(page!.layers[0]!.id, 'card');
  const card = page!.layers[0]!;
  assert.deepEqual(
    {name: card.name, type: card.type, width: card.width},
    {name: 'Product card', type: 'FRAME', width: 320},
  );
  assert.ok(card.layers > 4, 'how many layers the card holds');
  assert.ok(page!.layers.some(layer => layer.id === 'home'));
  assert.equal(outline.styles, 2);
  assert.equal(outline.variables, 3);
  assert.ok(outline.components >= 5);
  assert.throws(() => fileOutline(doc, 'nope'), refusal('not_found'));
});

test("should give a layer tree with text, components, styles and dev mode's CSS, cut at the depth asked", () => {
  const doc = showcaseFile();
  const {tree, shown, truncated} = layerTree(doc, 'card', {depth: 4, css: true});
  assert.equal(truncated, false);
  assert.equal(tree.name, 'Product card');
  assert.equal(tree.styles?.effect, 'Shadow/Card');
  assert.match(tree.css ?? '', /display: flex/);
  const children = tree.children!;
  assert.equal(children[0]!.id, 'badge', 'the top of the panel first');
  const name = children.find(layer => layer.id === 'name')!;
  assert.equal(name.text, 'Ethiopia Yirgacheffe');
  assert.equal(name.styles?.text, 'Headings/H2');
  const buy = children.find(layer => layer.id === 'buy')!;
  assert.equal(buy.component?.name, 'Size=Large, State=Normal');
  assert.ok(shown > children.length);

  const shallow = layerTree(doc, 'card', {depth: 0, css: false});
  assert.equal(shallow.shown, 1);
  assert.equal(shallow.tree.children, undefined);
  assert.equal(shallow.tree.more, children.length);
  assert.equal(shallow.tree.css, undefined);
  assert.throws(() => layerTree(doc, 'p', {depth: 1, css: false}), refusal('not_found'), 'a page is not a layer');
  assert.throws(() => layerTree(doc, '__proto__', {depth: 1, css: false}), refusal('not_found'));
});

test('should stop a layer tree at its size and say so', () => {
  let doc: DesignDocument = createDocument('p', 'Page');
  const frame = createNode('FRAME', {id: 'big', parentId: 'p', name: 'Many', width: 100, height: 100});
  const nodes: DesignDocument['nodes'] = {...doc.nodes, big: {...frame, children: []}};
  for (let i = 0; i < MAX_TREE_NODES + 50; i++) {
    nodes[`r${i}`] = createNode('RECTANGLE', {id: `r${i}`, parentId: 'big', name: `r${i}`, width: 1, height: 1});
    nodes.big!.children!.push(`r${i}`);
  }
  nodes.p = {...nodes.p!, children: ['big']};
  doc = {...doc, nodes};
  const {tree, shown, truncated} = layerTree(doc, 'big', {depth: 3, css: false});
  assert.equal(truncated, true);
  assert.equal(shown, MAX_TREE_NODES);
  assert.equal(tree.children!.length, MAX_TREE_NODES - 1);
  assert.equal(tree.more, 51);
});

test("should write code in every format with the Code tab's writers", () => {
  const doc = showcaseFile();
  const react = codeFor(doc, 'card', 'react', measurer);
  assert.match(react.files[0]!.path, /\.tsx$/, "the frame's component comes first");
  assert.ok(react.files.some(file => file.path.endsWith('.module.css')));
  assert.ok(react.assets.length >= 1, 'the photo is named as an asset');
  const tailwind = codeFor(doc, 'card', 'react-tailwind', measurer);
  assert.match(tailwind.files[0]!.contents, /className="[^"]*\bflex\b/);
  const inline = codeFor(doc, 'card', 'react-inline', measurer);
  assert.match(inline.files[0]!.contents, /style=\{/);
  const css = codeFor(doc, 'card', 'css', measurer);
  assert.match(css.files[0]!.contents, /^\/\* Product card \*\/\n\.layer \{\n {2}/);
  const svg = codeFor(doc, 'card', 'svg', measurer);
  assert.match(svg.files[0]!.contents, /^<svg[\s>]/);
  const tokens = codeFor(doc, undefined, 'tokens');
  assert.deepEqual(
    tokens.files.map(file => file.path),
    ['src/tokens.css', 'src/theme.css'],
  );
  assert.match(tokens.files[0]!.contents, /--/);
  assert.throws(() => codeFor(doc, undefined, 'react'), refusal('invalid_input'));
  assert.throws(() => codeFor(doc, 'missing', 'css'), refusal('not_found'));
});

test('should keep code answers to their size, naming the files left out', () => {
  const files = [
    {path: 'a.tsx', contents: 'a'.repeat(60)},
    {path: 'b.css', contents: 'b'.repeat(60)},
    {path: 'c.tsx', contents: 'c'.repeat(30)},
  ];
  assert.deepEqual(capFiles(files, 100), {files: [files[0], files[2]], omitted: ['b.css']});
});

test('should list variables per mode and styles by type', () => {
  const {collections, styles} = variablesAndStyles(showcaseFile());
  assert.equal(collections.length, 1);
  assert.deepEqual(collections[0]!.modes, ['Light', 'Dark']);
  const bg = collections[0]!.variables.find(variable => variable.name === 'Surface/Card')!;
  assert.equal(bg.type, 'COLOR');
  assert.deepEqual(Object.keys(bg.values), ['Light', 'Dark']);
  assert.match(String(bg.values['Light']), /^#fff/i);
  const gap = collections[0]!.variables.find(variable => variable.name === 'spacing/m')!;
  assert.equal(gap.values['Dark'], 16);
  const h2 = styles.find(style => style.name === 'Headings/H2') as {type: string; fontSize?: number};
  assert.deepEqual([h2.type, h2.fontSize], ['TEXT', 24]);
  assert.deepEqual(
    styles.find(style => style.name === 'Shadow/Card'),
    {id: 'card', name: 'Shadow/Card', type: 'EFFECT', effects: ['DROP_SHADOW']},
  );
});
