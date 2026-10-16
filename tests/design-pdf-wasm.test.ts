import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import {pdfPagePlan, pdfPageSize, pdfPageSvg} from '../shared/design/pdf-export';
import {exportPdfWasm} from '../shared/design/pdf-wasm';
import {exportWasm} from '../shared/design/export-wasm';
import {registerExportFonts} from '../shared/design/export-fonts';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {testMeasurer} from './helpers/design-big-files';

// Lane L5's direct vector PDF (crates/export, DESIGN_PDF_ENGINE=wasm): structure checks that need no viewer. The
// rendering against Chromium's PDF is scripts/export/pdf-check.ts (MuPDF, pdf.js, SSIM).

const fontsRoot = path.resolve('public/fonts');
const haveFonts = fs.existsSync(path.join(fontsRoot, 'inter'));
const read = (file: string) => {
  try {
    return fs.readFileSync(path.join(fontsRoot, file));
  } catch {
    return null;
  }
};

function documentWith(nodes: (Partial<SceneNode> & {id: string})[]): DesignDocument {
  const doc = createDocument('page');
  for (const partial of nodes) {
    const node = createNode(partial.type!, partial) as SceneNode;
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  }
  return doc;
}

const latin1 = (pdf: Uint8Array) => Buffer.from(pdf).toString('latin1');

/** Every stream's bytes, inflated where Flate-compressed. */
function streams(pdf: Uint8Array): string[] {
  const text = latin1(pdf);
  const out: string[] = [];
  const re = /<<([^]*?)>>\nstream\n/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const length = Number(/\/Length (\d+)/.exec(m[1])?.[1]);
    const start = m.index + m[0].length;
    const data = Buffer.from(pdf.subarray(start, start + length));
    out.push(m[1].includes('/FlateDecode') ? inflateSync(data).toString('latin1') : data.toString('latin1'));
  }
  return out;
}

test('pages are pdfPageSize, text is embedded Type 3 glyphs with a Unicode map, links are annotations', {skip: !haveFonts && 'npm run fonts first'}, () => {
  const doc = documentWith([
    {type: 'FRAME', id: 'f', parentId: 'page', x: 0, y: 0, width: 300, height: 200, fills: [solid({r: 1, g: 1, b: 1})]},
    {type: 'FRAME', id: 'g', parentId: 'page', x: 400, y: 0, width: 20_000, height: 100, fills: [solid({r: 0.2, g: 0.3, b: 0.9})]},
    {
      type: 'TEXT',
      id: 't',
      parentId: 'f',
      x: 10,
      y: 10,
      width: 280,
      height: 40,
      fills: [solid({r: 0, g: 0, b: 0})],
      text: {...defaultTextProps(), characters: 'Привет, PDF', textAutoResize: 'NONE', style: {...defaultTextProps().style, fontFamily: 'Inter', fontSize: 20, hyperlink: {type: 'URL', url: 'https://example.com/a'}}},
    },
  ]);
  registerExportFonts(exportWasm(), ['Inter'], read);
  const plans = ['f', 'g'].map(id => pdfPagePlan(doc, id)!);
  const {pdf, stats} = exportPdfWasm(doc, plans, {measurer: testMeasurer, title: 'Test'});
  const text = latin1(pdf);
  assert.ok(text.startsWith('%PDF-1.7'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.equal(stats.pages, 2);
  plans.forEach((plan, index) => {
    const expected = pdfPageSize(pdfPageSvg(doc, plan, index, {measurer: testMeasurer}).bounds);
    assert.ok(Math.abs(stats.sizes[index][0] - expected.width) < 1e-6 && Math.abs(stats.sizes[index][1] - expected.height) < 1e-6, `page ${index}`);
  });
  // The 20 000 px frame is scaled to Acrobat's 14 400 pt.
  assert.ok(Math.abs(stats.sizes[1][0] - 14_400) < 1e-6);
  assert.match(text, /\/Subtype \/Type3/);
  assert.match(text, /\/Subtype \/Link [^]*?\/URI \(https:\/\/example\.com\/a\)/);
  // One map per Type 3 font (the Cyrillic and Latin faces are fonts of their own).
  const unicode = streams(pdf).filter(s => s.includes('beginbfchar')).join('\n') || undefined;
  assert.ok(unicode, 'a ToUnicode map');
  // The text ("Hello, PDF" in Russian) is Cyrillic on purpose: the Unicode map must cover the Cyrillic face too.
  for (const c of 'ПриветPDF') assert.ok(unicode!.includes(c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')), `maps ${c}`);
  assert.ok(streams(pdf).some(s => / Tf\n/.test(s) && /TJ/.test(s)), 'text shown with TJ');
  assert.deepEqual(stats.missingFamilies, []);
});

test('a family without faces is drawn in Inter and reported', {skip: !haveFonts && 'npm run fonts first'}, () => {
  const doc = documentWith([
    {type: 'FRAME', id: 'f', parentId: 'page', width: 200, height: 100},
    {type: 'TEXT', id: 't', parentId: 'f', width: 180, height: 30, fills: [solid({r: 0, g: 0, b: 0})], text: {...defaultTextProps(), characters: 'Font', style: {...defaultTextProps().style, fontFamily: 'No such font'}}},
  ]);
  registerExportFonts(exportWasm(), ['Inter'], read);
  const {stats} = exportPdfWasm(doc, [pdfPagePlan(doc, 'f')!], {measurer: testMeasurer});
  assert.deepEqual(stats.missingFamilies, ['No such font']);
  assert.equal(stats.textSpans, 1);
});

test('pictures embed their own bytes; shadows rasterise and nothing else does', {skip: !haveFonts && 'npm run fonts first'}, () => {
  // A 1×1 PNG and a drop shadow.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const doc = documentWith([
    {type: 'FRAME', id: 'f', parentId: 'page', width: 200, height: 100, fills: [solid({r: 1, g: 1, b: 1})]},
    {type: 'RECTANGLE', id: 'r', parentId: 'f', x: 10, y: 10, width: 80, height: 60, fills: [{type: 'IMAGE', imageRef: 'pic', scaleMode: 'FILL', visible: true, opacity: 1, blendMode: 'NORMAL'}]},
    {type: 'RECTANGLE', id: 's', parentId: 'f', x: 110, y: 10, width: 60, height: 60, fills: [solid({r: 1, g: 0, b: 0})], effects: [{type: 'DROP_SHADOW', color: {r: 0, g: 0, b: 0, a: 0.4}, offset: {x: 2, y: 4}, radius: 8, spread: 0, visible: true, blendMode: 'NORMAL'}]},
  ]);
  doc.images.pic = {url: '/uploads/pic.png', width: 1, height: 1};
  registerExportFonts(exportWasm(), ['Inter'], read);
  const {pdf, stats} = exportPdfWasm(doc, [pdfPagePlan(doc, 'f')!], {
    measurer: testMeasurer,
    imageHref: ref => (ref === 'pic' ? 'https://pdf.l5.invalid/p/0' : undefined),
    bytes: href => (href === 'https://pdf.l5.invalid/p/0' ? png : undefined),
  });
  assert.equal(stats.images, 1);
  assert.equal(stats.rasters, 1);
  assert.ok(latin1(pdf).includes('/Subtype /Image'));
});
