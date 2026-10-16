import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {layoutText, type TextMeasurer} from '../shared/design/text-layout';
import {exportSvg, exportSvgPage} from '../shared/design/svg-export';
import {
  PDF_EXPORT_LIMITS,
  effectRasters,
  pdfPagePlan,
  pdfPageSize,
  pdfPageSvg,
  rasterMegapixels,
  readMeasurements,
  readingOrder,
  recordMeasurements,
  replayMeasurements,
  textFamilies,
} from '../shared/design/pdf-export';
import {setPageSizes, pageBoxes} from '../server/design/pdf/page-boxes';
import {catalogueFamily, familyFaces, fontFaceCss, isCatalogueFontFile} from '../server/design/pdf/fonts';
import {budget} from './helpers/speed';

// Vector PDF export (docs/design-tool.md §Export): the measurements the editor records and the server replays, the
// pages and their order, the exporter's print flavour, the fonts the server serves and the exact page boxes.

/** A measurer with kerning-like quirks: a word's width is not the sum of its letters. */
const canvas: TextMeasurer = {
  width: (text, font) => [...text].reduce((sum, ch, i) => sum + font.size * (0.42 + ((ch.codePointAt(0)! * 7 + i) % 13) / 40), 0) * (font.weight >= 600 ? 1.06 : 1),
  metrics: font => ({ascent: font.size * 0.93, descent: font.size * 0.24}),
};

function documentWith(nodes: SceneNode[]): DesignDocument {
  const doc = createDocument('page');
  for (const node of structuredClone(nodes)) {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  }
  return doc;
}

function textNode(id: string, parentId: string, characters: string, extra: Partial<SceneNode> = {}): SceneNode {
  const node = createNode('TEXT', {id, parentId, x: 10, y: 10, width: 180, height: 120, ...extra});
  node.text = {...defaultTextProps(characters), textAutoResize: 'HEIGHT', listTypes: ['UNORDERED', 'NONE', 'ORDERED']};
  node.text.runs = [{start: 0, end: 6, style: {fontWeight: 700, fontFamily: 'Montserrat'}}];
  return node;
}

const sample = () => documentWith([
  createNode('FRAME', {id: 'a', parentId: 'page', x: 0, y: 0, width: 200, height: 300}),
  textNode('t1', 'a', 'Hello, this is a long paragraph of text that wraps onto several lines.\nSecond paragraph\nThird — with a soft hy­phen and a list'),
  createNode('FRAME', {id: 'b', parentId: 'page', x: 240, y: 0, width: 120, height: 80}),
  textNode('t2', 'b', 'Short'),
]);

test('replayed measurements give the server the editor\'s exact lines', () => {
  const doc = sample();
  const recorder = recordMeasurements(canvas);
  const editor = ['a', 'b'].map((id, index) => pdfPageSvg(doc, pdfPagePlan(doc, id)!, index, {measurer: recorder.measurer}).svg);
  // Through JSON, as the request carries it.
  const table = readMeasurements(JSON.parse(JSON.stringify(recorder.table())))!;
  assert.ok(table.widths.length > 10 && table.fonts.length >= 2);
  const replay = replayMeasurements(table);
  const server = ['a', 'b'].map((id, index) => pdfPageSvg(doc, pdfPagePlan(doc, id)!, index, {measurer: replay}).svg);
  assert.deepEqual(server, editor, 'the same SVG, byte for byte');
  assert.equal(replay.misses, 0);
  const lines = (measurer: TextMeasurer) => layoutText(doc.nodes.t1, measurer).lines.map(line => [line.baseline, line.runs.map(run => [run.text, run.x])]);
  assert.deepEqual(lines(replayMeasurements(table)), lines(canvas));
});

test('a question the table cannot answer is counted and estimated, never thrown', () => {
  const replay = replayMeasurements({fonts: [['Inter', 400, 0, 16, 15, 4]], widths: [[0, 'Yes', 20]]});
  assert.equal(replay.width('Yes', {family: 'Inter', weight: 400, italic: false, size: 16}), 20);
  assert.equal(replay.width('', {family: 'Inter', weight: 400, italic: false, size: 16}), 0);
  assert.ok(replay.width('No', {family: 'Inter', weight: 400, italic: false, size: 16}) > 0);
  assert.deepEqual(replay.metrics({family: 'Inter', weight: 700, italic: false, size: 16}), {ascent: 0, descent: 0});
  assert.equal(replay.misses, 2);
});

test('a measurement table from a request: shape, sizes and references are checked', () => {
  const font = ['Inter', 400, 0, 16, 15, 4];
  assert.ok(readMeasurements({fonts: [font], widths: [[0, 'a', 1]]}));
  assert.ok(readMeasurements({fonts: [['Inter', 400, 0, 16, null, null]], widths: []}), 'metrics never asked');
  for (const bad of [
    null, 'x', {fonts: [], widths: {}}, {fonts: [font], widths: [[1, 'a', 1]]}, {fonts: [font], widths: [[0, 'a', Infinity]]},
    {fonts: [['Inter', 400, true, 16, 1, 1]], widths: []}, {fonts: [[1, 400, 0, 16, 1, 1]], widths: []}, {fonts: [font], widths: [[0, 'a']]},
    {fonts: [font], widths: [[0.5, 'a', 1]]}, {fonts: [font], widths: [[0, 'x'.repeat(PDF_EXPORT_LIMITS.textLength + 1), 1]]},
  ]) assert.equal(readMeasurements(bad), null, JSON.stringify(bad)?.slice(0, 60));
  const many = {fonts: [font], widths: Array.from({length: PDF_EXPORT_LIMITS.widths + 1}, (_, i) => [0, 'w' + i, 1])};
  assert.equal(readMeasurements(many), null);
  const full = {fonts: [font], widths: Array.from({length: PDF_EXPORT_LIMITS.widths}, (_, i) => [0, 'word' + i, 1.5])};
  const started = performance.now();
  assert.ok(readMeasurements(full));
  assert.ok(performance.now() - started < budget(150), 'the largest table is read in well under a frame of work');
});

test('pages read like a page of text: rows from the top, each from the left', () => {
  const doc = documentWith([
    createNode('FRAME', {id: 'r2a', parentId: 'page', x: 0, y: 500, width: 100, height: 100}),
    createNode('FRAME', {id: 'r1c', parentId: 'page', x: 400, y: 10, width: 100, height: 300}),
    createNode('FRAME', {id: 'r1a', parentId: 'page', x: 0, y: 0, width: 100, height: 200}),
    createNode('FRAME', {id: 'r1b', parentId: 'page', x: 200, y: 40, width: 100, height: 100}),
    createNode('FRAME', {id: 'r2b', parentId: 'page', x: 300, y: 480, width: 100, height: 100}),
  ]);
  assert.deepEqual(readingOrder(doc, ['r2a', 'r1c', 'r1a', 'r2b', 'r1b', 'gone']), ['r1a', 'r1b', 'r1c', 'r2a', 'r2b']);
});

test('page sizes: 1 px = 1 pt, scaled down only past Acrobat\'s 200-inch limit', () => {
  assert.deepEqual(pdfPageSize({x: 5, y: 5, width: 375.5, height: 812.25}), {width: 375.5, height: 812.25, scale: 1});
  const tall = pdfPageSize({x: 0, y: 0, width: 1440, height: 28_800});
  assert.deepEqual([tall.width, tall.height, tall.scale], [720, 14_400, 0.5]);
  assert.deepEqual(pdfPageSize({x: 0, y: 0, width: 0, height: 0}), {width: 1, height: 1, scale: 1});
});

test('a slice prints what its page shows inside it, and only the layers that reach it', () => {
  const doc = documentWith([
    createNode('FRAME', {id: 'f', parentId: 'page', x: 0, y: 0, width: 400, height: 400}),
    createNode('RECTANGLE', {id: 'far', parentId: 'page', x: 2000, y: 2000, width: 50, height: 50}),
    createNode('SLICE', {id: 's', parentId: 'f', x: 50, y: 60, width: 100, height: 80}),
  ]);
  const plan = pdfPagePlan(doc, 's')!;
  assert.deepEqual(plan, {id: 's', ids: ['f'], crop: {x: 50, y: 60, width: 100, height: 80}});
  const page = pdfPageSvg(doc, plan, 0, {measurer: canvas});
  assert.deepEqual(page.bounds, {x: 50, y: 60, width: 100, height: 80});
  assert.match(page.svg, /^<svg width="100" height="80" viewBox="0 0 100 80"/);
  assert.match(page.svg, /translate\(-50 -60\)/);
  assert.equal(pdfPagePlan(doc, 'page'), null, 'a page is not a frame');
  assert.equal(pdfPagePlan(doc, 'nope'), null);
  for (const inherited of ['__proto__', 'constructor', 'toString']) assert.equal(pdfPagePlan(doc, inherited), null, inherited);
});

test('print flavour: pictures clipped, not patterned (tiles stay patterns); ids carry the page; only https hrefs', () => {
  const doc = documentWith([createNode('FRAME', {id: 'f', parentId: 'page', width: 300, height: 200})]);
  doc.images.photo = {url: '/uploads/dz-photo.webp', width: 800, height: 600};
  const fill = (scaleMode: 'FILL' | 'FIT' | 'CROP' | 'TILE') => ({type: 'IMAGE' as const, imageRef: 'photo', scaleMode, opacity: 0.5, visible: true, blendMode: 'MULTIPLY' as const, ...(scaleMode === 'CROP' ? {imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]] as [[number, number, number], [number, number, number]]} : {})});
  for (const mode of ['FILL', 'FIT', 'CROP'] as const) {
    doc.nodes.f = {...doc.nodes.f, fills: [fill(mode)]};
    const svg = exportSvg(doc, ['f'], {measurer: canvas, print: true, idPrefix: 'p3_', imageHref: ref => `https://pdf.morfa.invalid/pictures/${ref}`});
    assert.doesNotMatch(svg, /<pattern/, mode);
    assert.match(svg, /<g clip-path="url\(#p3_clip0\)" opacity="0.5" style="mix-blend-mode:multiply"><image [^>]*xlink:href="https:\/\/pdf\.morfa\.invalid\/pictures\/photo"/, mode);
    assert.match(svg, /<clipPath id="p3_clip0">/);
  }
  doc.nodes.f = {...doc.nodes.f, fills: [fill('TILE')]};
  assert.match(exportSvg(doc, ['f'], {measurer: canvas, print: true, imageHref: () => 'https://pdf.morfa.invalid/pictures/0'}), /<pattern id="pattern0"/);
  doc.nodes.f = {...doc.nodes.f, fills: [fill('FILL')]};
  for (const href of ['http://example.com/a.png', 'javascript:alert(1)', 'https://pdf.morfa.invalid/a?x=1', 'https://pdf.morfa.invalid/a"b', '/uploads/x.png']) {
    const svg = exportSvg(doc, ['f'], {measurer: canvas, print: true, imageHref: () => href});
    assert.doesNotMatch(svg, /<image/, href);
    assert.match(svg, /fill="#d9d9d9"/, 'an unusable picture is the neutral grey');
  }
  assert.doesNotMatch(exportSvg(doc, ['f'], {measurer: canvas, idPrefix: '"><script>', print: true}), /script/, 'an unsafe prefix is ignored');
});

test('print flavour: shadows are their own layers drawn from the content; content stays outside every filter', () => {
  const card = createNode('RECTANGLE', {id: 'c', parentId: 'page', x: 10, y: 10, width: 100, height: 60, fills: [solid({r: 1, g: 1, b: 1})], opacity: 0.8});
  card.effects = [
    {type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.3}, offset: {x: 0, y: 4}, radius: 12, spread: 2, blendMode: 'MULTIPLY', showShadowBehindNode: false},
    {type: 'INNER_SHADOW', visible: true, color: {r: 1, g: 0, b: 0, a: 0.5}, offset: {x: 2, y: 2}, radius: 4, spread: 0, blendMode: 'NORMAL'},
    {type: 'DROP_SHADOW', visible: false, color: {r: 0, g: 0, b: 0, a: 1}, offset: {x: 0, y: 0}, radius: 1, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: false},
  ];
  const doc = documentWith([card]);
  const svg = exportSvg(doc, ['c'], {measurer: canvas, print: true});
  assert.match(svg, /<g transform="translate\(14 10\)" opacity="0.8"><use href="#content0" filter="url\(#filter0\)" style="mix-blend-mode:multiply"\/><g id="content0"><rect [^>]*fill="#ffffff"\/><\/g><use href="#content0" filter="url\(#filter1\)"\/><\/g>/);
  assert.match(svg, /<filter id="filter0"[^>]*><feColorMatrix in="SourceAlpha"[^>]*\/><feMorphology radius="2" operator="dilate" in="SourceAlpha"\/><feOffset dy="4"\/><feGaussianBlur stdDeviation="6"\/>/);
  assert.match(svg, /<filter id="filter1"[^>]*>.*<feComposite in2="hardAlpha" operator="arithmetic" k2="-1" k3="1"\/>/);
  assert.doesNotMatch(svg, /SourceGraphic/, 'no filter draws the content');
  // A layer blur blurs the whole layer, as Figma's PDFs do: one filter around everything.
  doc.nodes.c = {...doc.nodes.c, effects: [...card.effects, {type: 'LAYER_BLUR', visible: true, radius: 6}]};
  const blurred = exportSvg(doc, ['c'], {measurer: canvas, print: true});
  assert.doesNotMatch(blurred, /<use /);
  assert.match(blurred, /SourceGraphic/);
  // The SVG export itself is unchanged.
  assert.doesNotMatch(exportSvg(documentWith([card]), ['c'], {measurer: canvas}), /<use /);
});

test('a family whose name has a word that is not an identifier is quoted, so it is not dropped', () => {
  const node = textNode('t', 'page', 'Text');
  node.text!.style = {...node.text!.style, fontFamily: 'Exo 2'};
  node.text!.runs = [];
  assert.match(exportSvg(documentWith([node]), ['t'], {measurer: canvas}), /font-family="&#39;Exo 2&#39;, sans-serif"/);
  node.text!.style = {...node.text!.style, fontFamily: 'Playfair Display'};
  assert.match(exportSvg(documentWith([node]), ['t'], {measurer: canvas}), /font-family="Playfair Display, sans-serif"/);
});

test('the page plan tells the server which families and which rasters a page needs', () => {
  const doc = sample();
  assert.deepEqual([...textFamilies(doc, ['a'])].sort(), ['Inter', 'Montserrat']);
  doc.nodes.t2 = {...doc.nodes.t2, visible: false};
  assert.deepEqual([...textFamilies(doc, ['b'])], [], 'hidden text needs no font');
  const shadowed = createNode('RECTANGLE', {id: 's', parentId: 'a', x: 0, y: 0, width: 100, height: 100});
  shadowed.effects = [
    {type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.3}, offset: {x: 0, y: 0}, radius: 10, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: false},
    {type: 'INNER_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.3}, offset: {x: 0, y: 0}, radius: 2, spread: 0, blendMode: 'NORMAL'},
  ];
  doc.nodes.s = shadowed;
  doc.nodes.a = {...doc.nodes.a, children: [...doc.nodes.a.children!, 's']};
  const page = {x: 0, y: 0, width: 200, height: 300};
  const areas = effectRasters(doc, pdfPagePlan(doc, 'a')!, page, canvas);
  assert.equal(areas.length, 2, 'a raster per shadow');
  assert.ok(areas.every(area => area > 100 * 100 && area <= 200 * 300), JSON.stringify(areas));
  assert.ok(Math.abs(rasterMegapixels(72 * 72) - 0.09) < 1e-9, 'a square inch at 300 dpi is 90 000 pixels');
});

test('fonts: catalogue families only, every face a file the server has; others are named as missing', () => {
  assert.equal(catalogueFamily('Inter')?.dir, 'inter');
  assert.equal(catalogueFamily('Comic Sans MS'), undefined);
  const {css, missing} = fontFaceCss(['Inter', 'Montserrat', 'Comic Sans MS', 'Inter'], 'https://pdf.morfa.invalid/fonts');
  assert.deepEqual(missing, ['Comic Sans MS']);
  assert.equal((css.match(/font-family:"Inter"/g) ?? []).length, 2, 'two subsets of the variable family');
  assert.match(css, /font-weight:100 900;font-display:block;src:url\("https:\/\/pdf\.morfa\.invalid\/fonts\/inter\/inter-cyrillic-wght-normal\.woff2"\) format\("woff2"\);unicode-range:U\+0301/);
  for (const name of ['Inter', 'Montserrat', 'Cormorant Garamond', 'PT Serif', 'Unbounded', 'Golos Text']) {
    const font = catalogueFamily(name);
    if (!font) continue;
    for (const face of familyFaces(font)) assert.ok(isCatalogueFontFile(face.file), `${name}: ${face.file}`);
  }
  assert.equal(isCatalogueFontFile('../../etc/passwd'), false);
  assert.equal(isCatalogueFontFile('inter/../../server/app.ts'), false);
});

// ── Page boxes ─────────────────────────────────────────────────────────────────────────────────

/** A PDF shaped like Chromium's (Skia's writer): classic xref, a page tree with a nested node. */
function skiaLikePdf(boxes: number[][]): Buffer {
  const objects: string[] = [];
  const pageIds = boxes.map((_, i) => 4 + i);
  objects[1] = '<</Creator (Chromium)\n/Producer (Skia/PDF m141)>>';
  objects[2] = `<</Type /Pages\n/Count ${boxes.length}\n/Kids [3 0 R]>>`;
  objects[3] = `<</Type /Pages\n/Count ${boxes.length}\n/Parent 2 0 R\n/Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}]>>`;
  boxes.forEach((box, i) => {
    objects[4 + i] = `<</Type /Page\n/Resources <<>>\n/MediaBox [${box.join(' ')}]\n/Contents ${4 + boxes.length + i} 0 R\n/Parent 3 0 R>>`;
    objects[4 + boxes.length + i] = '<</Filter /FlateDecode\n/Length 4>> stream\nx\u009c\u0003\u0000\nendstream';
  });
  const catalog = objects.length;
  objects[catalog] = '<</Type /Catalog\n/Pages 2 0 R>>';
  let out = '%PDF-1.4\n%Óëéá\n';
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<</Size ${objects.length}\n/Root ${catalog} 0 R\n/Info 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('page boxes: each page cut to its frame from the top-left corner, the cross-reference table rebuilt', () => {
  const pdf = skiaLikePdf([[0, 0, 601, 400.08], [0, 0, 376.08, 813.12]]);
  const fixed = setPageSizes(pdf, [{width: 600, height: 400}, {width: 375.5, height: 812.25}])!;
  assert.ok(fixed);
  assert.deepEqual(pageBoxes(fixed), [[0, 0.08, 600, 400.08], [0, 0.87, 375.5, 813.12]]);
  // Every offset in the new table points at its object.
  const text = fixed.toString('latin1');
  const start = Number(/startxref\n(\d+)/.exec(text)![1]);
  assert.ok(text.startsWith('xref\n0 ', start));
  const entries = text.slice(start).split('\n').slice(2).filter(line => / 00000 n $/.test(line));
  entries.forEach((line, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, Number(line.slice(0, 10))), `object ${i + 1}`));
  assert.match(text, /trailer\n<<\/Size \d+\n\/Root \d+ 0 R\n\/Info 1 0 R>>/);
});

test('page boxes: a file of another shape, or another page count, is left alone', () => {
  const pdf = skiaLikePdf([[0, 0, 100, 100]]);
  assert.equal(setPageSizes(pdf, [{width: 50, height: 50}, {width: 50, height: 50}]), null);
  assert.equal(setPageSizes(Buffer.from('not a pdf'), [{width: 1, height: 1}]), null);
  const incremental = Buffer.from(pdf.toString('latin1').replace('/Info 1 0 R>>', '/Info 1 0 R\n/Prev 10>>'), 'latin1');
  assert.equal(setPageSizes(incremental, [{width: 50, height: 50}]), null);
  // Never grows a page beyond what Chromium printed.
  assert.deepEqual(pageBoxes(setPageSizes(pdf, [{width: 150, height: 120}])!), [[0, 0, 100, 100]]);
});

test('page boxes: garbage, a lying cross-reference table and a huge file are refused quickly', () => {
  const started = performance.now();
  const noise = Buffer.alloc(8 * 1024 * 1024);
  for (let i = 0; i < noise.length; i++) noise[i] = (i * 2654435761) >>> 24;
  assert.equal(setPageSizes(noise, [{width: 1, height: 1}]), null);
  const pdf = skiaLikePdf([[0, 0, 100, 100]]);
  const lying = Buffer.from(pdf.toString('latin1').replace(/startxref\n\d+/, 'startxref\n9999999'), 'latin1');
  assert.equal(setPageSizes(lying, [{width: 1, height: 1}]), null);
  const shifted = Buffer.from(pdf.toString('latin1').replace(/0000000015 00000 n/, '0000000016 00000 n'), 'latin1');
  assert.equal(setPageSizes(shifted, [{width: 1, height: 1}]), null, 'an offset that does not start its object');
  const looping = Buffer.from(pdf.toString('latin1').replace('/Kids [3 0 R]', '/Kids [2 0 R]'), 'latin1');
  assert.equal(setPageSizes(looping, [{width: 1, height: 1}]), null, 'a page tree that points at itself');
  const padded = Buffer.concat([Buffer.from('%PDF-1.4\n' + 'x'.repeat(4 * 1024 * 1024)), pdf.subarray(9)]);
  assert.equal(setPageSizes(padded, [{width: 1, height: 1}]), null);
  assert.ok(performance.now() - started < budget(400), `${Math.round(performance.now() - started)} ms`);
});

test('print flavour: text in a gradient is the gradient clipped to its glyphs; solid runs stay plain text', () => {
  const node = textNode('t', 'page', 'Gradient and color');
  node.text!.runs = [{start: 13, end: 18, style: {}, fills: [solid({r: 1, g: 0, b: 0})]}];
  node.text!.listTypes = [];
  node.fills = [{type: 'GRADIENT_LINEAR', opacity: 1, visible: true, blendMode: 'NORMAL', gradientStops: [{position: 0, color: {r: 0, g: 0, b: 1, a: 1}}, {position: 1, color: {r: 1, g: 0, b: 1, a: 1}}], gradientHandlePositions: [{x: 0, y: 0.5}, {x: 1, y: 0.5}, {x: 0, y: 1}]}];
  const doc = documentWith([node]);
  const print = exportSvg(doc, ['t'], {measurer: canvas, print: true});
  assert.match(print, /<clipPath id="clip0"><text xml:space="preserve" font-family="Inter, sans-serif" font-size="16"><tspan[^>]*>Gradient and <\/tspan><\/text><\/clipPath>/);
  assert.match(print, /<g clip-path="url\(#clip0\)"><rect [^>]*fill="url\(#paint_linear0\)"\/><\/g>/);
  assert.match(print, /<text xml:space="preserve" fill="none"[^>]*><tspan [^>]*fill="#ff0000">color<\/tspan><\/text>/);
  // The SVG export keeps the gradient on the text itself.
  assert.match(exportSvg(doc, ['t'], {measurer: canvas}), /<text xml:space="preserve" fill="url\(#paint_linear0\)"/);
});

test('print flavour: text hyperlinks stay links (http, https and mailto only)', () => {
  const node = textNode('t', 'page', 'Site and mail and script');
  node.text!.listTypes = [];
  node.text!.runs = [
    {start: 0, end: 4, style: {hyperlink: {type: 'URL', url: 'https://foo.test/dizain/?a=1&b=2'}}},
    {start: 9, end: 13, style: {hyperlink: {type: 'URL', url: 'mailto:hi@foo.test'}}},
    {start: 18, end: 24, style: {hyperlink: {type: 'URL', url: 'javascript:alert(1)'}}},
  ];
  const doc = documentWith([node]);
  const print = exportSvg(doc, ['t'], {measurer: canvas, print: true});
  assert.match(print, /<a href="https:\/\/foo\.test\/dizain\/\?a=1&amp;b=2"><tspan [^>]*>Site<\/tspan><\/a>/);
  assert.match(print, /<a href="mailto:hi@foo\.test"><tspan [^>]*>mail<\/tspan><\/a>/);
  assert.doesNotMatch(print, /javascript/);
  assert.doesNotMatch(exportSvg(doc, ['t'], {measurer: canvas}), /<a /, 'the SVG export writes no links');
});

test('list markers sit where the layout puts them, in the marker\'s own face', () => {
  const doc = documentWith([textNode('t', 'page', 'One\nTwo', {x: 0, y: 0})]);
  doc.nodes.t.text!.runs = [];
  doc.nodes.t.text!.listTypes = ['ORDERED', 'ORDERED'];
  const lines = layoutText(doc.nodes.t, canvas).lines;
  const svg = exportSvg(doc, ['t'], {measurer: canvas});
  for (const line of lines) {
    assert.ok(line.marker);
    assert.ok(svg.includes(`<tspan x="${Math.round(line.marker.x * 1000) / 1000}" y="${Math.round(line.baseline * 1000) / 1000}">${line.marker.text}</tspan>`), `${line.marker.text} at ${line.marker.x}: ${svg}`);
  }
});

test('a clipping frame holds its fill inside the clip, so children blend with it as on the canvas', () => {
  const doc = documentWith([
    createNode('FRAME', {id: 'f', parentId: 'page', width: 200, height: 100, fills: [solid({r: 0.96, g: 0.96, b: 0.96})]}),
    createNode('ELLIPSE', {id: 'e', parentId: 'f', x: 10, y: 10, width: 50, height: 50, blendMode: 'DIFFERENCE', fills: [solid({r: 0, g: 0.6, b: 0.3})]}),
  ]);
  assert.match(exportSvg(doc, ['f'], {measurer: canvas}), /<g clip-path="url\(#clip0\)"><rect width="200" height="100" fill="#f5f5f5"\/><circle [^>]*style="mix-blend-mode:difference"[^>]*\/><\/g>/);
  // A fill that blends itself still blends with what is under the frame.
  doc.nodes.f = {...doc.nodes.f, fills: [{...solid({r: 1, g: 0, b: 0}), blendMode: 'MULTIPLY'}]};
  assert.match(exportSvg(doc, ['f'], {measurer: canvas}), /<rect width="200" height="100" fill="#ff0000" style="mix-blend-mode:multiply"\/><g clip-path="url\(#clip0\)"><circle/);
});
