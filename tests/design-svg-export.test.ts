import {test} from 'node:test';
import assert from 'node:assert/strict';
import {escapeXmlAttribute, escapeXmlText, exportSvg} from '../shared/design/svg-export';
import {importSvg, type SvgNode} from '../shared/design/svg-import';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {worldMatrix} from '../shared/design/geometry';
import {pathsBounds, transformPaths} from '../shared/design/paths';
import {nodeGeometry} from '../shared/design/shapes';
import type {DesignDocument, GradientPaint, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';

const near = (actual: number, expected: number, eps = 1e-3, label = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≉ ${expected} (±${eps})`);

const measurer: TextMeasurer = {
  width: (text, font) => text.length * font.size * 0.5,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

function documentWith(source: SceneNode[]): DesignDocument {
  const doc = createDocument('page');
  for (const node of structuredClone(source)) {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  }
  return doc;
}
const svgOf = (nodes: SceneNode[], ids: string[], options = {}) => exportSvg(documentWith(nodes), ids, {measurer, ...options});

// A tiny XML reader for the round trip (the product parses with DOMParser).
type Xml = {name: string; attrs: [string, string][]; children: (Xml | string)[]};
function readXml(source: string): Xml {
  const root: Xml = {name: '#document', attrs: [], children: []};
  const stack = [root];
  const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ({amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"} as Record<string, string>)[e.toLowerCase()]);
  const tag = /<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/y;
  const attr = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let i = 0;
  while (i < source.length) {
    const top = stack[stack.length - 1];
    if (source.startsWith('</', i)) { i = source.indexOf('>', i) + 1; stack.pop(); continue; }
    if (source[i] === '<') {
      tag.lastIndex = i;
      const m = tag.exec(source);
      if (!m) throw new Error('not well-formed at ' + i + ': ' + source.slice(i, i + 40));
      const el: Xml = {name: m[1], attrs: [...m[2].matchAll(attr)].map(a => [a[1], decode(a[2] ?? a[3] ?? '')]), children: []};
      top.children.push(el);
      if (!m[3]) stack.push(el);
      i = tag.lastIndex;
      continue;
    }
    const next = source.indexOf('<', i);
    top.children.push(decode(source.slice(i, next < 0 ? source.length : next)));
    i = next < 0 ? source.length : next;
  }
  assert.equal(stack.length, 1, 'unclosed elements');
  return root.children[0] as Xml;
}
const toTree = (xml: Xml): SvgNode => ({tag: xml.name, attrs: Object.fromEntries(xml.attrs), children: xml.children.map(c => (typeof c === 'string' ? {tag: '#text', attrs: {}, children: [], text: c} : toTree(c)))});
const findAll = (xml: Xml, name: string): Xml[] => [...(xml.name === name ? [xml] : []), ...xml.children.flatMap(c => (typeof c === 'string' ? [] : findAll(c, name)))];
const attrOf = (xml: Xml, name: string) => xml.attrs.find(([k]) => k === name)?.[1];

test('escaping: no markup can come in through names or text', () => {
  assert.equal(escapeXmlText('<a> & "b"'), '&lt;a&gt; &amp; "b"');
  assert.equal(escapeXmlAttribute(`"'<\n`), '&quot;&#39;&lt;&#10;');
  assert.equal(escapeXmlText('a\u0000b￾c\uD800d'), 'abcd');
  const text = createNode('TEXT', {id: 't', parentId: 'page', name: '<script>alert(1)</script>', width: 200, height: 20, text: {...defaultTextProps('</text><script>x()</script> & "q"'), style: {...defaultTextProps().style, fontFamily: 'Evil"/><script>'}}});
  const rect = createNode('RECTANGLE', {id: 'r', parentId: 'page', name: '"/><script>alert(1)</script>'});
  const out = svgOf([text, rect], ['t', 'r']);
  assert.equal(out.includes('<script'), false);
  assert.equal(out.includes('alert'), false); // layer names are never written
  const xml = readXml(out);
  const span = findAll(xml, 'tspan')[0];
  assert.equal(span.children[0], '</text><script>x()</script> & "q"');
  assert.ok(attrOf(findAll(xml, 'text')[0], 'font-family')!.includes('Evil'));
});

test('shapes: rect, circle and paths; bounds include the stroke', () => {
  const rect = createNode('RECTANGLE', {id: 'r', parentId: 'page', x: 10, y: 20, width: 100, height: 50, cornerRadius: 8, strokes: [solid({r: 1, g: 0, b: 0})], strokeWeight: 2, strokeAlign: 'CENTER'});
  const out = svgOf([rect], ['r']);
  const xml = readXml(out);
  assert.equal(attrOf(xml, 'width'), '102');
  assert.equal(attrOf(xml, 'height'), '52');
  assert.equal(attrOf(xml, 'viewBox'), '0 0 102 52');
  const rects = findAll(xml, 'rect');
  assert.equal(rects.length, 2);
  assert.equal(attrOf(rects[0], 'fill'), '#d9d9d9');
  assert.equal(attrOf(rects[0], 'rx'), '8');
  assert.equal(attrOf(findAll(xml, 'g')[0], 'transform'), 'translate(1 1)');
  // A single element takes the transform itself.
  const plain = readXml(svgOf([createNode('RECTANGLE', {id: 'p', parentId: 'page', x: 5, y: 5})], ['p']));
  assert.equal(findAll(plain, 'g').length, 0);
  assert.equal(attrOf(rects[1], 'stroke'), '#ff0000');
  assert.equal(attrOf(rects[1], 'stroke-width'), '2');
  const circle = readXml(svgOf([createNode('ELLIPSE', {id: 'e', parentId: 'page', width: 40, height: 40})], ['e']));
  assert.equal(findAll(circle, 'circle').length, 1);
  const star = readXml(svgOf([createNode('STAR', {id: 's', parentId: 'page'})], ['s']));
  assert.ok(attrOf(findAll(star, 'path')[0], 'd')!.startsWith('M50 0L'));
  const smooth = readXml(svgOf([createNode('RECTANGLE', {id: 'q', parentId: 'page', cornerRadius: 20, cornerSmoothing: 0.6})], ['q']));
  assert.equal(findAll(smooth, 'path').length, 1);
});

test('strokes by alignment, dashes, caps and joins', () => {
  const red = solid({r: 1, g: 0, b: 0});
  const inside = readXml(svgOf([createNode('RECTANGLE', {id: 'r', parentId: 'page', fills: [], strokes: [red], strokeWeight: 4, strokeAlign: 'INSIDE'})], ['r']));
  assert.equal(attrOf(inside, 'width'), '100');
  assert.equal(findAll(inside, 'clipPath').length, 1);
  assert.equal(attrOf(findAll(inside, 'rect').find(r => attrOf(r, 'stroke'))!, 'stroke-width'), '8');
  const outside = readXml(svgOf([createNode('ELLIPSE', {id: 'e', parentId: 'page', fills: [], strokes: [red], strokeWeight: 4, strokeAlign: 'OUTSIDE'})], ['e']));
  assert.equal(attrOf(outside, 'width'), '108');
  assert.equal(findAll(outside, 'mask').length, 1);
  const line = readXml(svgOf([createNode('LINE', {id: 'l', parentId: 'page', width: 50, strokeWeight: 3, strokeCap: 'ROUND', strokeJoin: 'BEVEL', dashPattern: [4, 2]})], ['l']));
  const path = findAll(line, 'path')[0];
  assert.equal(attrOf(path, 'stroke-linecap'), 'round');
  assert.equal(attrOf(path, 'stroke-linejoin'), 'bevel');
  assert.equal(attrOf(path, 'stroke-dasharray'), '4 2');
  assert.equal(attrOf(path, 'fill'), 'none');
  // Markers and per-side weights are written as outlined strokes.
  const arrow = readXml(svgOf([createNode('LINE', {id: 'a', parentId: 'page', width: 50, strokeWeight: 2, strokeEndMarker: 'TRIANGLE_ARROW'})], ['a']));
  const outlined = findAll(arrow, 'path')[0];
  assert.equal(attrOf(outlined, 'fill'), '#000000');
  assert.equal(attrOf(outlined, 'stroke'), undefined);
  const sides = readXml(svgOf([createNode('RECTANGLE', {id: 's', parentId: 'page', fills: [], strokes: [red], individualStrokeWeights: {top: 4, right: 0, bottom: 0, left: 0}})], ['s']));
  assert.equal(attrOf(findAll(sides, 'path')[0], 'fill'), '#ff0000');
});

const stops: GradientPaint['gradientStops'] = [{position: 0, color: {r: 1, g: 0, b: 0, a: 1}}, {position: 1, color: {r: 0, g: 0, b: 1, a: 0.5}}];
const gradient = (type: GradientPaint['type']): GradientPaint => ({type, opacity: 1, visible: true, blendMode: 'NORMAL', gradientStops: stops, gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}]});

test('gradients: linear and radial in the handle frame, diamond exact, angular as wedges', () => {
  const linear = readXml(svgOf([createNode('RECTANGLE', {id: 'r', parentId: 'page', width: 200, height: 100, fills: [gradient('GRADIENT_LINEAR')]})], ['r']));
  const g = findAll(linear, 'linearGradient')[0];
  assert.equal(attrOf(g, 'gradientUnits'), 'userSpaceOnUse');
  // H0 = (0, 50), axis to (200, 50), width handle doubled: (0, 100) → matrix(200 0 0 100 0 50).
  assert.equal(attrOf(g, 'gradientTransform'), 'matrix(200 0 0 100 0 50)');
  assert.deepEqual(findAll(g, 'stop').map(s => [attrOf(s, 'offset'), attrOf(s, 'stop-color'), attrOf(s, 'stop-opacity')]), [['0', '#ff0000', undefined], ['1', '#0000ff', '0.5']]);
  assert.equal(attrOf(findAll(linear, 'rect')[0], 'fill'), `url(#${attrOf(g, 'id')})`);
  const radial = readXml(svgOf([createNode('ELLIPSE', {id: 'e', parentId: 'page', fills: [{...gradient('GRADIENT_RADIAL'), gradientHandlePositions: [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}]}]})], ['e']));
  assert.equal(attrOf(findAll(radial, 'radialGradient')[0], 'gradientTransform'), 'matrix(50 0 0 50 50 50)');
  const diamond = readXml(svgOf([createNode('RECTANGLE', {id: 'd', parentId: 'page', fills: [gradient('GRADIENT_DIAMOND')]})], ['d']));
  assert.equal(findAll(diamond, 'linearGradient').length, 4);
  assert.equal(findAll(diamond, 'clipPath').length, 1);
  const angular = readXml(svgOf([createNode('RECTANGLE', {id: 'a', parentId: 'page', fills: [gradient('GRADIENT_ANGULAR')]})], ['a']));
  assert.equal(findAll(angular, 'path').length, 120);
  assert.equal(findAll(angular, 'clipPath').length, 1);
});

test('image fills embed the picture when given, grey otherwise', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const node = createNode('RECTANGLE', {id: 'i', parentId: 'page', width: 40, height: 20, fills: [{type: 'IMAGE', imageRef: 'ref1', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]});
  const withData = readXml(svgOf([node], ['i'], {imageData: (ref: string) => (ref === 'ref1' ? png : undefined)}));
  const image = findAll(withData, 'image')[0];
  assert.equal(attrOf(image, 'xlink:href'), png);
  assert.equal(attrOf(image, 'preserveAspectRatio'), 'xMidYMid slice');
  assert.equal(findAll(withData, 'pattern').length, 1);
  const without = readXml(svgOf([node], ['i']));
  assert.equal(attrOf(findAll(without, 'rect')[0], 'fill'), '#d9d9d9');
  const hostile = readXml(svgOf([node], ['i'], {imageData: () => 'javascript:alert(1)'}));
  assert.equal(findAll(hostile, 'image').length, 0);
});

test('opacity, blend modes and effects as filters', () => {
  const node = createNode('RECTANGLE', {id: 'r', parentId: 'page', opacity: 0.5, blendMode: 'MULTIPLY', effects: [
    {type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y: 4}, radius: 8, spread: 2, visible: true, blendMode: 'NORMAL'},
    {type: 'INNER_SHADOW', color: {r: 1, g: 1, b: 1, a: 1}, offset: {x: 1, y: 1}, radius: 0, spread: 0, visible: true, blendMode: 'NORMAL'},
    {type: 'LAYER_BLUR', radius: 6, visible: true},
    {type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 1}, offset: {x: 0, y: 0}, radius: 100, spread: 0, visible: false, blendMode: 'NORMAL'},
  ]});
  const xml = readXml(svgOf([node], ['r']));
  const g = findAll(xml, 'g')[0];
  assert.equal(attrOf(g, 'opacity'), '0.5');
  assert.equal(attrOf(g, 'style'), 'mix-blend-mode:multiply');
  const filter = findAll(xml, 'filter')[0];
  assert.equal(attrOf(g, 'filter'), `url(#${attrOf(filter, 'id')})`);
  assert.deepEqual(findAll(filter, 'feGaussianBlur').map(b => attrOf(b, 'stdDeviation')), ['4', '3']);
  assert.equal(attrOf(findAll(filter, 'feOffset')[0], 'dy'), '4');
  assert.equal(attrOf(findAll(filter, 'feMorphology')[0], 'operator'), 'dilate');
  assert.ok(findAll(filter, 'feComposite').some(c => attrOf(c, 'operator') === 'arithmetic'));
  // The export grows by the visible shadow (offset 4, blur 8, spread 2) and the blur.
  near(Number(attrOf(xml, 'height')), 100 + 6 + 14);
});

test('masks, clipped frames and groups', () => {
  const nodes = [
    createNode('FRAME', {id: 'f', parentId: 'page', width: 50, height: 50, cornerRadius: 10}),
    createNode('RECTANGLE', {id: 'inside', parentId: 'f', x: 30, y: 30, width: 100, height: 100}),
    createNode('GROUP', {id: 'g', parentId: 'page', x: 200, width: 60, height: 60}),
    createNode('ELLIPSE', {id: 'm', parentId: 'g', width: 60, height: 60, isMask: true, maskType: 'VECTOR'}),
    createNode('RECTANGLE', {id: 'masked', parentId: 'g', width: 60, height: 60}),
    createNode('GROUP', {id: 'g2', parentId: 'page', x: 300, width: 60, height: 60}),
    createNode('RECTANGLE', {id: 'm2', parentId: 'g2', width: 60, height: 60, isMask: true, maskType: 'ALPHA'}),
    createNode('RECTANGLE', {id: 'masked2', parentId: 'g2', width: 60, height: 60}),
  ];
  const frame = readXml(svgOf(nodes, ['f']));
  assert.equal(attrOf(frame, 'width'), '50'); // the frame clips its child
  const clip = findAll(frame, 'clipPath')[0];
  assert.equal(attrOf(findAll(clip, 'rect')[0], 'rx'), '10');
  const vector = readXml(svgOf(nodes, ['g']));
  const clipPath = findAll(vector, 'clipPath')[0];
  assert.equal(findAll(clipPath, 'circle').length, 1);
  assert.ok(findAll(vector, 'g').some(g => attrOf(g, 'clip-path') === `url(#${attrOf(clipPath, 'id')})`));
  assert.equal(findAll(vector, 'circle').length, 1); // the mask is not drawn itself
  const alpha = readXml(svgOf(nodes, ['g2']));
  const mask = findAll(alpha, 'mask')[0];
  assert.equal(attrOf(mask, 'style'), 'mask-type:alpha');
});

test('"Add layer ids": each layer named by its id, unique, safe, never clashing with a definition', () => {
  // The layer names "Кнопка основная" and "2 круг" are Cyrillic on purpose: Unicode letters stay in the ids, a leading digit gets an underscore.
  // Arrange: a clipped frame (a clipPath definition) named like a definition, a repeated name, markup and a digit first.
  const nodes = [
    createNode('FRAME', {id: 'f', parentId: 'page', name: 'clip0', width: 100, height: 60, cornerRadius: 8, fills: [solid({r: 1, g: 1, b: 1})]}),
    createNode('RECTANGLE', {id: 'a', parentId: 'f', name: 'Кнопка основная', width: 40, height: 20, fills: [solid({r: 0, g: 0, b: 1})]}),
    createNode('RECTANGLE', {id: 'b', parentId: 'f', name: 'Кнопка основная', x: 50, width: 40, height: 20, fills: [solid({r: 0, g: 0, b: 1})]}),
    createNode('ELLIPSE', {id: 'c', parentId: 'f', name: '"/><script>alert(1)</script>', y: 30, width: 20, height: 20, fills: [solid({r: 1, g: 0, b: 0})]}),
    createNode('ELLIPSE', {id: 'd', parentId: 'f', name: '2 круг', x: 30, y: 30, width: 20, height: 20, fills: [solid({r: 1, g: 0, b: 0})]}),
  ];

  // Act
  const plain = svgOf(nodes, ['f']);
  const named = svgOf(nodes, ['f'], {layerIds: true});

  // Assert: without the option nothing changes; with it every layer has its id, in document order.
  assert.equal(plain.includes('Кнопка'), false);
  const xml = readXml(named);
  const ids = [...named.matchAll(/ id="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length, `unique: ${ids.join(' ')}`);
  for (const id of ['clip0', 'Кнопка_основная', 'Кнопка_основная_2', 'scriptalert1script', '_2_круг']) assert.ok(ids.includes(id), `${id} in ${ids.join(' ')}`);
  assert.equal(named.includes('<script'), false);
  const clip = findAll(xml, 'clipPath')[0];
  assert.notEqual(attrOf(clip, 'id'), 'clip0', 'the definition steps aside for the layer');
  assert.ok(findAll(xml, 'g').some(g => attrOf(g, 'clip-path') === `url(#${attrOf(clip, 'id')})`));
  assert.equal(attrOf(findAll(xml, 'circle').find(c => attrOf(c, 'id') === '_2_круг')!, 'fill'), '#ff0000');
});

test('text: one tspan per run at its laid-out position', () => {
  const text = createNode('TEXT', {id: 't', parentId: 'page', x: 5, y: 5, width: 120, height: 40, fills: [solid({r: 0.2, g: 0.2, b: 0.2})], text: {
    ...defaultTextProps('Hello\nworld'),
    style: {...defaultTextProps().style, fontFamily: 'Open Sans', fontSize: 20, fontWeight: 700, italic: true, letterSpacing: {unit: 'PERCENT', value: 10}, textDecoration: 'UNDERLINE', textCase: 'UPPER'},
  }});
  const xml = readXml(svgOf([text], ['t']));
  const t = findAll(xml, 'text')[0];
  assert.equal(attrOf(t, 'font-family'), 'Open Sans, sans-serif');
  assert.equal(attrOf(t, 'font-weight'), '700');
  assert.equal(attrOf(t, 'font-style'), 'italic');
  assert.equal(attrOf(t, 'letter-spacing'), '2');
  assert.equal(attrOf(t, 'text-decoration'), 'underline');
  assert.equal(attrOf(t, 'fill'), '#333333');
  assert.equal(attrOf(t, 'xml:space'), 'preserve');
  const spans = findAll(t, 'tspan');
  assert.deepEqual(spans.map(s => s.children[0]), ['HELLO', 'WORLD']);
  assert.deepEqual(spans.map(s => attrOf(s, 'y')), ['16', '36']);
});

test('deterministic output', () => {
  const nodes = [createNode('RECTANGLE', {id: 'r', parentId: 'page', fills: [gradient('GRADIENT_LINEAR')], effects: [{type: 'LAYER_BLUR', radius: 2, visible: true}]})];
  assert.equal(svgOf(nodes, ['r']), svgOf(nodes, ['r']));
  assert.equal(svgOf([], ['missing']), '<svg width="0" height="0" viewBox="0 0 0 0" fill="none" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"/>');
});

test('round trip: export, import, the same shapes in the same places', () => {
  const nodes = [
    createNode('RECTANGLE', {id: 'r', parentId: 'page', x: 10, y: 20, width: 100, height: 50, cornerRadius: 8}),
    createNode('ELLIPSE', {id: 'e', parentId: 'page', x: 150, y: 10, width: 60, height: 40}),
    createNode('STAR', {id: 's', parentId: 'page', x: 20, y: 100, width: 80, height: 80}),
    createNode('RECTANGLE', {id: 'turned', parentId: 'page', x: 150, y: 100, width: 40, height: 20, rotation: 35}),
    createNode('GROUP', {id: 'g', parentId: 'page', x: 250, y: 50, width: 30, height: 30}),
    createNode('VECTOR', {id: 'v', parentId: 'g', width: 30, height: 30, vectorPaths: [{windingRule: 'EVENODD', commands: [{type: 'M', x: 0, y: 0}, {type: 'C', x1: 30, y1: 0, x2: 30, y2: 30, x: 0, y: 30}, {type: 'Z'}]}]}),
  ];
  const doc = documentWith(nodes);
  const ids = ['r', 'e', 's', 'turned', 'g'];
  const out = exportSvg(doc, ids, {measurer});
  const imported = importSvg(toTree(readXml(out)));
  const frame = imported.nodes[0];
  const original = (id: string) => pathsBounds(transformPaths(nodeGeometry(doc.nodes[id]), worldMatrix(doc, id)))!;
  const all = ['r', 'e', 's', 'turned', 'v'].map(original);
  const origin = {x: Math.min(...all.map(b => b.x)), y: Math.min(...all.map(b => b.y))};
  near(frame.width, Math.max(...all.map(b => b.x + b.width)) - origin.x);
  near(frame.height, Math.max(...all.map(b => b.y + b.height)) - origin.y);
  // Every imported shape, in page space, sits where its original was.
  const importedDoc = createDocument('p2');
  for (const node of imported.nodes) importedDoc.nodes[node.id] = {...node, parentId: node.parentId ?? 'p2'};
  importedDoc.nodes.p2.children = [frame.id];
  const shapes = imported.nodes.filter(n => n.type !== 'FRAME' && n.type !== 'GROUP');
  assert.equal(shapes.length, 5);
  const importedBounds = shapes.map(n => pathsBounds(transformPaths(nodeGeometry(n), worldMatrix(importedDoc, n.id)))!);
  all.forEach((b, k) => {
    near(importedBounds[k].x + origin.x, b.x, 2e-3, `x of ${ids[k] ?? 'v'}`);
    near(importedBounds[k].y + origin.y, b.y, 2e-3, `y of ${ids[k] ?? 'v'}`);
    near(importedBounds[k].width, b.width, 2e-3);
    near(importedBounds[k].height, b.height, 2e-3);
  });
  assert.deepEqual(shapes.map(n => n.type), ['RECTANGLE', 'ELLIPSE', 'VECTOR', 'RECTANGLE', 'VECTOR']);
  assert.equal(shapes[0].cornerRadius, 8);
  near(shapes[3].rotation, 35, 1e-3); // matrices are written with six decimals
  assert.equal(shapes[4].vectorPaths![0].windingRule, 'EVENODD');
});
