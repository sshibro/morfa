import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importSvg, parseColor, parseTransform, SVG_IMPORT_LIMITS, SVG_WARNINGS, type SvgNode} from '../shared/design/svg-import';
import {svgTreeFromElement, svgTreeFromString, type DomNodeLike} from '../src/design/import/svg-dom';
import {apply, localMatrix, multiply, worldMatrix} from '../shared/design/geometry';
import {pathsBounds, transformPaths} from '../shared/design/paths';
import {nodeGeometry} from '../shared/design/shapes';
import {createDocument} from '../shared/design/defaults';
import type {DesignDocument, GradientPaint, SceneNode, SolidPaint} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {validateDocument} from '../shared/design/schema';
import {createDesignStore} from '../src/design/engine/store';
import {insertSvg} from '../src/design/engine/tools/image';
import {budget} from './helpers/speed';

const near = (actual: number, expected: number, eps = 1e-6, label = '') =>
  assert.ok(Math.abs(actual - expected) <= eps, `${label} ${actual} ≉ ${expected} (±${eps})`);

// A tiny XML reader for test fixtures only (the product parses with DOMParser).
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
    if (source.startsWith('<!--', i)) { i = source.indexOf('-->', i) + 3; continue; }
    if (source.startsWith('<![CDATA[', i)) { const end = source.indexOf(']]>', i); top.children.push(source.slice(i + 9, end)); i = end + 3; continue; }
    if (source.startsWith('<?', i) || source.startsWith('<!', i)) { i = source.indexOf('>', i) + 1; continue; }
    if (source.startsWith('</', i)) { i = source.indexOf('>', i) + 1; stack.pop(); continue; }
    if (source[i] === '<') {
      tag.lastIndex = i;
      const m = tag.exec(source);
      if (!m) throw new Error('bad fixture at ' + i);
      const el: Xml = {name: m[1], attrs: [...m[2].matchAll(attr)].map(a => [a[1], decode(a[2] ?? a[3] ?? '')]), children: []};
      top.children.push(el);
      if (!m[3]) stack.push(el);
      i = tag.lastIndex;
      continue;
    }
    const next = source.indexOf('<', i);
    const text = source.slice(i, next < 0 ? source.length : next);
    if (text.trim() || stack.length > 1) top.children.push(decode(text));
    i = next < 0 ? source.length : next;
  }
  return root.children.find((c): c is Xml => typeof c !== 'string')!;
}
const local = (name: string) => name.includes(':') && !name.startsWith('xlink:') && !name.startsWith('xml:') ? name : name;
function toTree(xml: Xml): SvgNode {
  return {tag: xml.name, attrs: Object.fromEntries(xml.attrs.map(([k, v]) => [local(k), v])), children: xml.children.map(c => (typeof c === 'string' ? {tag: '#text', attrs: {}, children: [], text: c} : toTree(c)))};
}
function toDom(xml: Xml | string): DomNodeLike {
  if (typeof xml === 'string') return {nodeType: 3, nodeValue: xml, childNodes: []};
  const [prefix, name] = xml.name.includes(':') ? xml.name.split(':') : [null, xml.name];
  return {nodeType: 1, localName: name, namespaceURI: prefix ? 'urn:' + prefix : 'http://www.w3.org/2000/svg', attributes: xml.attrs.map(([n, value]) => ({name: n, value})), childNodes: xml.children.map(toDom)};
}

const svg = (source: string, options = {}) => importSvg(toTree(readXml(source)), options);
const byName = (nodes: SceneNode[], name: string) => nodes.find(n => n.name === name)!;
const children = (nodes: SceneNode[], id: string) => nodes.find(n => n.id === id)!.children!.map(c => nodes.find(n => n.id === c)!);

function documentOf(result: ReturnType<typeof importSvg>): DesignDocument {
  const doc = createDocument('page');
  for (const node of result.nodes) doc.nodes[node.id] = {...node, parentId: node.parentId ?? 'page'};
  doc.nodes.page.children = [result.rootId];
  return doc;
}
/** Page-space bounds of a node's own geometry. */
const drawn = (doc: DesignDocument, id: string) => pathsBounds(transformPaths(nodeGeometry(doc.nodes[id]), worldMatrix(doc, id)))!;

test('colours and transforms parse like a browser', () => {
  assert.deepEqual(parseColor('#f00'), {r: 1, g: 0, b: 0, a: 1});
  assert.deepEqual(parseColor('#ff000080')?.a.toFixed(3), '0.502');
  assert.deepEqual(parseColor('rgb(255 0 0 / 50%)'), {r: 1, g: 0, b: 0, a: 0.5});
  assert.deepEqual(parseColor('rgba(0, 255, 0, 0.25)'), {r: 0, g: 1, b: 0, a: 0.25});
  const hsl = parseColor('hsl(240, 100%, 50%)')!;
  near(hsl.b, 1); near(hsl.r, 0);
  assert.deepEqual(parseColor('RebeccaPurple'), {r: 0x66 / 255, g: 0x33 / 255, b: 0x99 / 255, a: 1});
  assert.equal(parseColor('not-a-colour'), null);
  assert.deepEqual(parseTransform('translate(10) scale(2)'), [[2, 0, 10], [0, 2, 0]]);
  const r = parseTransform('rotate(90 10 10)')!;
  const p = apply(r, {x: 20, y: 10});
  near(p.x, 10); near(p.y, 20);
  assert.equal(parseTransform('translate(10) garbage'), null);
  assert.deepEqual(parseTransform('matrix(1,0,0,1,5,6)'), [[1, 0, 5], [0, 1, 6]]);
});

const LUCIDE = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-circle-arrow-right">
  <circle cx="12" cy="12" r="10"/>
  <path d="M8 12h8"/>
  <path d="m12 16 4-4-4-4"/>
  <rect width="18" height="18" x="3" y="3" rx="2"/>
  <line x1="2" x2="22" y1="2" y2="22"/>
  <polyline points="4 4 8 8 4 12"/>
</svg>`;

test('a lucide icon: a 24 px frame of stroked shapes in currentColor', () => {
  const result = svg(LUCIDE, {color: {r: 0, g: 0.5, b: 1}});
  const [frame] = result.nodes;
  assert.equal(frame.type, 'FRAME');
  assert.equal(frame.id, result.rootId);
  assert.equal(frame.width, 24);
  assert.equal(frame.clipsContent, true);
  assert.deepEqual(frame.fills, []);
  const shapes = children(result.nodes, frame.id);
  assert.deepEqual(shapes.map(s => s.type), ['ELLIPSE', 'VECTOR', 'VECTOR', 'RECTANGLE', 'VECTOR', 'VECTOR']);
  for (const shape of shapes) {
    assert.deepEqual(shape.fills, [], shape.type);
    assert.equal(shape.strokeWeight, 2);
    assert.equal(shape.strokeCap, 'ROUND');
    assert.equal(shape.strokeJoin, 'ROUND');
    assert.equal(shape.strokeAlign, 'CENTER');
    assert.deepEqual((shape.strokes[0] as SolidPaint).color, {r: 0, g: 0.5, b: 1});
  }
  assert.deepEqual([shapes[0].x, shapes[0].y, shapes[0].width, shapes[0].height], [2, 2, 20, 20]);
  assert.deepEqual([shapes[3].x, shapes[3].y, shapes[3].width, shapes[3].height, shapes[3].cornerRadius], [3, 3, 18, 18, 2]);
  assert.deepEqual([shapes[1].x, shapes[1].y, shapes[1].width, shapes[1].height], [8, 12, 8, 0]);
  assert.deepEqual([shapes[2].x, shapes[2].y, shapes[2].width, shapes[2].height], [12, 8, 4, 8]);
  assert.equal(result.warnings.length, 0);
  // Without a colour, currentColor is black.
  assert.deepEqual((svg(LUCIDE).nodes[1].strokes[0] as SolidPaint).color, {r: 0, g: 0, b: 0});
});

test('viewBox scales content and strokes; preserveAspectRatio centres it', () => {
  const result = svg(`<svg width="48" height="48" viewBox="0 0 24 24"><rect x="2" y="2" width="10" height="10" stroke="#000" stroke-width="1"/></svg>`);
  const rect = result.nodes[1];
  assert.deepEqual([rect.x, rect.y, rect.width, rect.height, rect.strokeWeight], [4, 4, 20, 20, 2]);
  assert.deepEqual((rect.fills[0] as SolidPaint).color, {r: 0, g: 0, b: 0}); // default fill is black
  const wide = svg(`<svg width="200" height="100" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>`).nodes[1];
  assert.deepEqual([wide.x, wide.y, wide.width, wide.height], [50, 0, 100, 100]);
  const stretched = svg(`<svg width="200" height="100" viewBox="0 0 10 10" preserveAspectRatio="none"><rect width="10" height="10"/></svg>`).nodes[1];
  assert.deepEqual([stretched.x, stretched.width, stretched.height], [0, 200, 100]);
  const noSize = svg(`<svg viewBox="0 0 30 20"/>`).nodes[0];
  assert.deepEqual([noSize.width, noSize.height], [30, 20]);
});

test('transforms: rotation stays on the node, skew is baked into the path', () => {
  const result = svg(`<svg width="200" height="200">
    <rect id="turned" width="10" height="20" transform="translate(50 50) rotate(30)"/>
    <rect id="skewed" width="10" height="10" transform="translate(100 0) skewX(45)"/>
    <circle id="oval" cx="10" cy="10" r="5" transform="scale(2 1)"/>
    <path id="mirror" d="M0 0L10 0L10 5Z" transform="translate(150 150) scale(-1 1)"/>
  </svg>`);
  const doc = documentOf(result);
  const turned = byName(result.nodes, 'turned');
  assert.equal(turned.type, 'RECTANGLE');
  near(turned.rotation, -30); // SVG turns clockwise, the panel counts counter-clockwise
  assert.deepEqual([turned.width, turned.height], [10, 20]); // float noise is cleaned off
  const corner = apply(localMatrix(turned), {x: 0, y: 0}), far = apply(localMatrix(turned), {x: 10, y: 20});
  const expected = apply(parseTransform('translate(50 50) rotate(30)')!, {x: 10, y: 20});
  near(corner.x, 50); near(corner.y, 50); near(far.x, expected.x); near(far.y, expected.y);
  const skewed = byName(result.nodes, 'skewed');
  assert.equal(skewed.type, 'VECTOR');
  const sb = drawn(doc, skewed.id);
  near(sb.x, 100); near(sb.width, 20); near(sb.height, 10);
  const oval = byName(result.nodes, 'oval');
  assert.equal(oval.type, 'ELLIPSE');
  assert.deepEqual([oval.x, oval.y, oval.width, oval.height], [10, 5, 20, 10]);
  const mirror = drawn(doc, byName(result.nodes, 'mirror').id);
  near(mirror.x, 140); near(mirror.width, 10); near(mirror.y, 150);
});

test('gradients: bounding-box and user-space units, transforms, inherited stops', () => {
  const result = svg(`<svg width="100" height="100">
    <defs>
      <linearGradient id="base"><stop offset="0" stop-color="red"/><stop offset="100%" stop-color="blue" stop-opacity="0.5"/></linearGradient>
      <linearGradient id="diag" href="#base" x1="0" y1="0" x2="1" y2="1"/>
      <linearGradient id="user" xlink:href="#base" gradientUnits="userSpaceOnUse" x1="10" y1="0" x2="60" y2="0"/>
      <radialGradient id="glow"><stop offset="0.2" style="stop-color: #fff"/><stop offset="1" class="dark"/></radialGradient>
      <style>.dark { stop-color: #000 }</style>
    </defs>
    <rect id="a" x="10" y="10" width="50" height="20" fill="url(#base)"/>
    <rect id="b" x="10" y="10" width="50" height="20" fill="url(#diag)"/>
    <rect id="c" x="10" y="10" width="50" height="20" fill="url(#user)" fill-opacity="0.5"/>
    <circle id="d" cx="50" cy="50" r="20" fill="url(#glow)"/>
    <rect id="e" width="10" height="10" fill="url(#missing) green"/>
  </svg>`);
  const paint = (name: string) => byName(result.nodes, name).fills[0] as GradientPaint;
  const a = paint('a');
  assert.equal(a.type, 'GRADIENT_LINEAR');
  assert.deepEqual(a.gradientHandlePositions.slice(0, 2), [{x: 0, y: 0}, {x: 1, y: 0}]);
  assert.deepEqual(a.gradientStops.map(s => [s.position, s.color.r, s.color.b, s.color.a]), [[0, 1, 0, 1], [1, 0, 1, 0.5]]);
  const b = paint('b');
  assert.deepEqual(b.gradientHandlePositions.slice(0, 2), [{x: 0, y: 0}, {x: 1, y: 1}]);
  assert.equal(b.gradientStops.length, 2);
  const c = paint('c');
  near(c.gradientHandlePositions[0].x, 0); near(c.gradientHandlePositions[1].x, 1); // 10..60 over a box 10..60
  near(c.opacity, 0.5);
  const d = paint('d');
  assert.equal(d.type, 'GRADIENT_RADIAL');
  assert.deepEqual(d.gradientHandlePositions, [{x: 0.5, y: 0.5}, {x: 1, y: 0.5}, {x: 0.5, y: 1}]);
  assert.deepEqual(d.gradientStops.map(s => [s.position, s.color.r]), [[0.2, 1], [1, 0]]);
  assert.deepEqual((byName(result.nodes, 'e').fills[0] as SolidPaint).color, {r: 0, g: 128 / 255, b: 0});
});

test('a rotated gradient lands where the browser draws it', () => {
  const result = svg(`<svg width="100" height="100">
    <linearGradient id="g" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="100" y2="0" gradientTransform="rotate(90 50 50)"><stop offset="0"/><stop offset="1" stop-color="#fff"/></linearGradient>
    <rect id="r" width="100" height="50" fill="url(#g)"/>
  </svg>`);
  const handles = (byName(result.nodes, 'r').fills[0] as GradientPaint).gradientHandlePositions;
  // rotate(90 about 50,50) sends (0,0) → (100,0) and (100,0) → (100,100); in a 100×50 box: (1,0) → (1,2).
  near(handles[0].x, 1); near(handles[0].y, 0); near(handles[1].x, 1); near(handles[1].y, 2);
});

test('the cascade: presentation attributes < stylesheet by specificity < style attribute < !important', () => {
  const result = svg(`<svg width="10" height="10">
    <style><![CDATA[
      rect { fill: blue }
      .warn { fill: orange; stroke: black }
      #exact.warn { fill: rgb(0, 128, 0) }
      .loud { fill: purple !important }
      @media print { rect { fill: pink } }
      g > rect { fill: yellow }
    ]]></style>
    <rect id="tag" fill="red" width="1" height="1"/>
    <rect id="cls" class="warn" width="1" height="1"/>
    <rect id="exact" class="warn" width="1" height="1"/>
    <rect id="inline" class="warn" style="fill: #123456; opacity: 0.5" width="1" height="1"/>
    <rect id="important" class="loud" style="fill: red" width="1" height="1"/>
    <g fill="#00ff00" fill-rule="evenodd" opacity="0.4"><path id="inherits" d="M0 0H5V5Z"/></g>
  </svg>`);
  const color = (name: string) => (byName(result.nodes, name).fills[0] as SolidPaint).color;
  assert.deepEqual(color('tag'), {r: 0, g: 0, b: 1});
  assert.deepEqual(color('cls'), {r: 1, g: 165 / 255, b: 0});
  assert.equal(byName(result.nodes, 'cls').strokes.length, 1);
  assert.deepEqual(color('exact'), {r: 0, g: 128 / 255, b: 0});
  assert.deepEqual(color('inline'), {r: 0x12 / 255, g: 0x34 / 255, b: 0x56 / 255});
  assert.equal(byName(result.nodes, 'inline').opacity, 0.5);
  assert.deepEqual(color('important'), {r: 128 / 255, g: 0, b: 128 / 255});
  const inherits = byName(result.nodes, 'inherits');
  assert.deepEqual(color('inherits'), {r: 0, g: 1, b: 0});
  assert.equal(inherits.vectorPaths![0].windingRule, 'EVENODD');
  assert.equal(inherits.opacity, 1); // opacity is not inherited: it is the group's
  assert.ok(result.warnings.includes(SVG_WARNINGS.css));
});

test('groups take their children’s box; use copies; symbols scale', () => {
  const result = svg(`<svg width="100" height="100">
    <defs><path id="dot" d="M0 0H4V4H0Z"/><symbol id="sym" viewBox="0 0 10 10"><rect width="10" height="10"/></symbol></defs>
    <g id="group" transform="translate(10 20)"><rect id="inner" x="5" y="5" width="10" height="10"/></g>
    <use id="copy" href="#dot" x="30" y="30"/>
    <use xlink:href="#dot" x="40" y="40" opacity="0.5"/>
    <use id="symbol" href="#sym" x="60" y="60" width="20" height="20"/>
  </svg>`);
  const doc = documentOf(result);
  const group = byName(result.nodes, 'group');
  assert.equal(group.type, 'GROUP');
  assert.deepEqual([group.x, group.y, group.width, group.height], [15, 25, 10, 10]);
  const inner = byName(result.nodes, 'inner');
  assert.deepEqual([inner.x, inner.y], [0, 0]);
  assert.deepEqual(drawn(doc, inner.id), {x: 15, y: 25, width: 10, height: 10});
  const copy = byName(result.nodes, 'copy');
  assert.equal(copy.type, 'VECTOR');
  assert.deepEqual(drawn(doc, copy.id), {x: 30, y: 30, width: 4, height: 4});
  const faded = result.nodes.find(n => n.type === 'GROUP' && n.opacity === 0.5)!;
  assert.ok(faded);
  const symbolRect = result.nodes.find(n => n.type === 'RECTANGLE' && n.width === 20)!;
  assert.deepEqual(drawn(doc, symbolRect.id), {x: 60, y: 60, width: 20, height: 20});
});

test('clip paths become vector masks; masks become luminance masks', () => {
  const result = svg(`<svg width="100" height="100">
    <clipPath id="clip"><circle cx="50" cy="50" r="25"/></clipPath>
    <mask id="fade"><rect width="100" height="100" fill="white"/></mask>
    <rect id="clipped" width="100" height="100" fill="red" clip-path="url(#clip)"/>
    <rect id="masked" width="100" height="100" fill="blue" mask="url(#fade)"/>
    <rect id="hidden" width="100" height="100" clip-path="url(#empty)"/>
    <clipPath id="empty"/>
  </svg>`);
  const [clipGroup, maskGroup] = children(result.nodes, result.rootId);
  assert.equal(clipGroup.type, 'GROUP');
  const [mask, clipped] = children(result.nodes, clipGroup.id);
  assert.equal(mask.isMask, true);
  assert.equal(mask.maskType, 'VECTOR');
  assert.equal(mask.type, 'VECTOR');
  assert.equal(clipped.name, 'clipped');
  const doc = documentOf(result);
  const mb = drawn(doc, mask.id);
  near(mb.x, 25); near(mb.width, 50);
  const [lum, masked] = children(result.nodes, maskGroup.id);
  assert.equal(lum.isMask, true);
  assert.equal(lum.maskType, 'LUMINANCE');
  assert.equal(masked.name, 'masked');
  assert.equal(children(result.nodes, result.rootId).length, 2); // an empty clip hides its element
});

const measurer: TextMeasurer = {
  width: (text, font) => text.length * font.size * 0.5,
  metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2}),
};

test('text: runs, lines, anchors and the baseline', () => {
  const result = svg(`<svg width="200" height="100">
    <text id="hello" x="10" y="40" font-family="'Open Sans', sans-serif" font-size="20" font-weight="bold" fill="#333">
      Hello   <tspan fill="red" font-style="italic">world</tspan>
    </text>
    <text id="lines" x="100" y="20" text-anchor="middle" font-size="10"><tspan x="100" dy="0">One</tspan><tspan x="100" dy="12">Two</tspan></text>
  </svg>`, {measurer});
  const hello = byName(result.nodes, 'hello');
  assert.equal(hello.type, 'TEXT');
  assert.equal(hello.text!.characters, 'Hello world');
  assert.equal(hello.text!.style.fontFamily, 'Open Sans');
  assert.equal(hello.text!.style.fontWeight, 700);
  assert.equal(hello.text!.style.fontSize, 20);
  assert.deepEqual(hello.text!.runs.map(r => [r.start, r.end, r.style.italic, (r.fills?.[0] as SolidPaint).color.r]), [[6, 11, true, 1]]);
  near(hello.x, 10);
  near(hello.y, 40 - 16); // baseline minus the ascent
  near(hello.width, 11 * 10);
  const lines = byName(result.nodes, 'lines');
  assert.equal(lines.text!.characters, 'One\nTwo');
  assert.deepEqual(lines.text!.style.lineHeight, {unit: 'PIXELS', value: 12});
  assert.equal(lines.text!.textAlignHorizontal, 'CENTER');
  near(lines.x + lines.width / 2, 100);
});

test('images: data URLs wait for upload, remote and SVG pictures are skipped', () => {
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const result = svg(`<svg width="100" height="100">
    <image href="${png}" x="10" y="10" width="30" height="20" preserveAspectRatio="xMidYMid slice"/>
    <image href="https://example.com/a.png" width="10" height="10"/>
    <image href="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" width="10" height="10"/>
    <image href="${png}"/>
  </svg>`);
  assert.equal(result.images.length, 1);
  const node = result.nodes.find(n => n.id === result.images[0].nodeId)!;
  assert.equal(node.type, 'RECTANGLE');
  assert.deepEqual([node.x, node.y, node.width, node.height], [10, 10, 30, 20]);
  assert.deepEqual(node.fills.map(f => [f.type, (f as {imageRef: string}).imageRef, (f as {scaleMode: string}).scaleMode]), [['IMAGE', '', 'FILL']]);
  assert.equal(result.images[0].mimeType, 'image/png');
  assert.ok(result.warnings.includes(SVG_WARNINGS.remoteImage));
  assert.ok(result.warnings.includes(SVG_WARNINGS.imageType));
  assert.ok(result.warnings.includes(SVG_WARNINGS.imageSize));
});

test('hostile input: deep nesting, use cycles and fan-out, huge paths, external references', () => {
  const el = (tag: string, attrs: Record<string, string> = {}, kids: SvgNode[] = []): SvgNode => ({tag, attrs, children: kids});
  let deep = el('rect', {width: '1', height: '1'});
  for (let k = 0; k < 10_000; k++) deep = el('g', {}, [deep]);
  let start = performance.now();
  const nested = importSvg(el('svg', {width: '10', height: '10'}, [deep]));
  assert.ok(performance.now() - start < budget(1000));
  assert.ok(nested.nodes.length <= SVG_IMPORT_LIMITS.depth + 2);

  start = performance.now();
  const cycle = importSvg(el('svg', {}, [el('g', {id: 'a'}, [el('use', {href: '#b'}), el('rect', {width: '1', height: '1'})]), el('g', {id: 'b'}, [el('use', {href: '#a'})])]));
  assert.ok(cycle.warnings.includes(SVG_WARNINGS.useCycle));
  assert.ok(cycle.nodes.length < 20);

  // Ten levels of ten uses each would be 10^10 copies.
  const defs: SvgNode[] = [el('rect', {id: 'l0', width: '1', height: '1'})];
  for (let level = 1; level <= 10; level++) defs.push(el('g', {id: 'l' + level}, Array.from({length: 10}, () => el('use', {href: '#l' + (level - 1)}))));
  start = performance.now();
  const bomb = importSvg(el('svg', {}, [el('defs', {}, defs), el('use', {href: '#l10'})]));
  const elapsed = performance.now() - start;
  assert.ok(elapsed < SVG_IMPORT_LIMITS.timeMs + budget(500), `${elapsed} ms`);
  assert.ok(bomb.nodes.length <= SVG_IMPORT_LIMITS.nodes + 1, `${bomb.nodes.length} nodes`);
  assert.ok(bomb.warnings.includes(SVG_WARNINGS.useDepth) || bomb.warnings.includes(SVG_WARNINGS.tooMany));

  start = performance.now();
  const huge = importSvg(el('svg', {}, [el('path', {d: 'M0 0' + ' L1 1'.repeat(250_000)})]));
  assert.ok(performance.now() - start < 2000);
  assert.ok(huge.nodes[1].vectorPaths![0].commands.length <= 200_000);

  const external = svg(`<svg width="10" height="10">
    <style>@import url(https://example.com/x.css); rect { fill: url(https://example.com/p.svg#x) red }</style>
    <use href="https://example.com/sprite.svg#icon"/>
    <rect width="5" height="5"/>
  </svg>`);
  assert.ok(external.warnings.includes(SVG_WARNINGS.externalUse));
  assert.deepEqual((external.nodes[1].fills[0] as SolidPaint).color, {r: 1, g: 0, b: 0});

  const many = importSvg(el('svg', {}, Array.from({length: 25_000}, () => el('rect', {width: '1', height: '1'}))));
  assert.ok(many.nodes.length <= SVG_IMPORT_LIMITS.nodes);
  assert.ok(many.warnings.includes(SVG_WARNINGS.tooMany));
  assert.throws(() => importSvg(el('g')));
});

test('the DOM adapter copies only what is safe, within limits', () => {
  const xml = readXml(`<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)">
    <script>alert(1)</script>
    <foreignObject><div>html</div></foreignObject>
    <sodipodi:namedview id="x"/>
    <a href="javascript:alert(1)"><rect width="1" height="1" onclick="x()"/></a>
    <use href="https://example.com/a.svg#b"/>
    <use href="#local"/>
    <image href="data:image/png;base64,AAAA"/>
    <text>hi</text>
  </svg>`);
  const {tree} = svgTreeFromElement(toDom(xml));
  assert.equal('onload' in tree.attrs, false);
  assert.deepEqual(tree.children.map(c => c.tag), ['a', 'use', 'use', 'image', 'text']);
  assert.deepEqual(tree.children[0].attrs, {});
  assert.deepEqual(tree.children[0].children[0].attrs, {width: '1', height: '1'});
  assert.deepEqual(tree.children[1].attrs, {});
  assert.deepEqual(tree.children[2].attrs, {href: '#local'});
  assert.equal(tree.children[3].attrs.href, 'data:image/png;base64,AAAA');
  assert.equal(tree.children[4].children[0].text, 'hi');
  // Depth and element limits.
  let deep: DomNodeLike = {nodeType: 1, localName: 'rect', namespaceURI: 'http://www.w3.org/2000/svg', attributes: [], childNodes: []};
  for (let k = 0; k < 200; k++) deep = {nodeType: 1, localName: 'g', namespaceURI: 'http://www.w3.org/2000/svg', attributes: [], childNodes: [deep]};
  const limited = svgTreeFromElement({nodeType: 1, localName: 'svg', namespaceURI: 'http://www.w3.org/2000/svg', attributes: [], childNodes: [deep]});
  let depth = 0;
  for (let node = limited.tree; node.children.length; node = node.children[0]) depth++;
  assert.equal(depth, SVG_IMPORT_LIMITS.depth);
  assert.equal(limited.warnings.length, 1);
  const wide = svgTreeFromElement({nodeType: 1, localName: 'svg', namespaceURI: null, attributes: [], childNodes: Array.from({length: 30_000}, () => ({nodeType: 1, localName: 'rect', namespaceURI: null, attributes: [], childNodes: []}))});
  assert.equal(wide.tree.children.length, SVG_IMPORT_LIMITS.elements - 1);
  // The string entry point: size, entities, parser errors, wrong roots.
  const fakeParse = (root: DomNodeLike | null, errors = 0) => () => ({documentElement: root, getElementsByTagName: () => ({length: errors})});
  assert.deepEqual(svgTreeFromString('x'.repeat(SVG_IMPORT_LIMITS.inputBytes + 1), fakeParse(null)), {error: 'too_large'});
  assert.deepEqual(svgTreeFromString('<!DOCTYPE svg [<!ENTITY a "aaaa">]><svg/>', fakeParse(null)), {error: 'entities'});
  assert.deepEqual(svgTreeFromString('<svg', fakeParse(toDom(xml), 1)), {error: 'parse'});
  assert.deepEqual(svgTreeFromString('<html/>', fakeParse({nodeType: 1, localName: 'html', namespaceURI: 'http://www.w3.org/1999/xhtml', attributes: [], childNodes: []})), {error: 'not_svg'});
  const ok = svgTreeFromString('<svg/>', fakeParse(toDom(xml)));
  assert.ok('tree' in ok);
  void multiply;
});

test('a pasted SVG becomes only layers the server stores: over a limit it is cut or refused, never left to wedge autosave', () => {
  // An SVG copied from anywhere used to give layers the schema refuses (a path of 200 000 commands, 300 gradient
  // stops, 150 000 characters, a coordinate past 10⁹); the server refused the autosave patch, and autosave carries a
  // refused patch into every later one, so nothing after the paste was saved.
  const L = {pathCommands: 100_000, gradientStops: 100, characters: 100_000};
  const long = svg(`<svg width="10" height="10"><path d="M0 0${' L1 1'.repeat(150_000)}"/></svg>`);
  assert.equal(long.nodes[1].vectorPaths![0].commands.length, L.pathCommands);
  assert.ok(long.warnings.includes(SVG_WARNINGS.tooMany));
  const stops = Array.from({length: 300}, (_, i) => `<stop offset="${i / 300}" stop-color="red"/>`).join('');
  const gradient = svg(`<svg width="10" height="10"><defs><linearGradient id="g">${stops}</linearGradient></defs><rect width="5" height="5" fill="url(#g)"/></svg>`);
  assert.equal((gradient.nodes[1].fills[0] as GradientPaint).gradientStops.length, L.gradientStops);
  const text = svg(`<svg width="10" height="10"><text>${'a'.repeat(150_000)}</text></svg>`, {measurer});
  assert.equal(text.nodes[1].text!.characters.length, L.characters);
  for (const result of [long, gradient, text]) assert.equal(validateDocument(JSON.parse(JSON.stringify(documentOf(result)))).ok, true);

  // What cannot be cut is refused with a message and nothing is inserted.
  const previous = (globalThis as {DOMParser?: unknown}).DOMParser;
  (globalThis as {DOMParser?: unknown}).DOMParser = class {
    parseFromString(source: string) {
      return {documentElement: toDom(readXml(source)), getElementsByTagName: () => ({length: 0})};
    }
  };
  try {
    const store = createDesignStore({doc: createDocument('page'), measurer});
    const toasts: [string, string | undefined][] = [];
    const services = {upload: () => Promise.reject(new Error('no uploads')), toast: (message: string, kind?: 'success' | 'error') => void toasts.push([message, kind])};
    assert.equal(insertSvg(store, '<svg width="10" height="10"><rect x="1e12" width="5" height="5"/></svg>', {x: 0, y: 0}, {services}), null);
    assert.deepEqual(store.getState().doc.nodes.page.children, []);
    assert.equal(toasts[0][1], 'error');
    assert.match(toasts[0][0], /^Could not paste SVG: /);
    const root = insertSvg(store, '<svg width="10" height="10"><rect width="5" height="5"/></svg>', {x: 0, y: 0}, {services});
    assert.ok(root && store.getState().doc.nodes[root]);
  } finally {
    (globalThis as {DOMParser?: unknown}).DOMParser = previous;
  }
});
