import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deflateSync, inflateSync} from 'node:zlib';
import {exportButtonLabel, exportFileName, formatConstraint, formatHasScale, formatLabel, groupPdfJobs, nextExportSetting, parseConstraint, planExport, safeSegment, settingsSummary, zipName} from '../src/design/panels/design/layout/export/files';
import {pageSize, pdfNumber, pdfText, splitAlpha, writePdf, type PdfPage} from '../src/design/panels/design/layout/export/pdf';
import {decodePng} from '../src/design/panels/design/layout/export/png';
import {layersLabel} from '../src/design/panels/design/shared/mixed';
import type {ExportSetting} from '../shared/design/types';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import {exportCommands, exportableIds} from '../src/design/engine/commands/export';
import {budget} from './helpers/speed';

const png1x: ExportSetting = {format: 'PNG', suffix: '', constraint: {type: 'SCALE', value: 1}};

// ── Settings and file names ────────────────────────────────────────────────────────────────────

test('the scale field reads 2x, 0.5x, 512w and 300h and prints them back', () => {
  assert.deepEqual(parseConstraint('2x'), {type: 'SCALE', value: 2});
  assert.deepEqual(parseConstraint('2'), {type: 'SCALE', value: 2});
  assert.deepEqual(parseConstraint(' 0,5 x '), {type: 'SCALE', value: 0.5});
  assert.deepEqual(parseConstraint('512w'), {type: 'WIDTH', value: 512});
  assert.deepEqual(parseConstraint('300 H'), {type: 'HEIGHT', value: 300});
  assert.equal(parseConstraint('0x'), null);
  assert.equal(parseConstraint('-2x'), null);
  assert.equal(parseConstraint('33x'), null, 'more than 32x is refused');
  assert.equal(parseConstraint('20000w'), null);
  assert.equal(parseConstraint('abc'), null);
  assert.equal(formatConstraint({type: 'SCALE', value: 0.5}), '0.5x');
  assert.equal(formatConstraint({type: 'SCALE', value: 2}), '2x');
  assert.equal(formatConstraint({type: 'WIDTH', value: 512}), '512w');
  assert.equal(formatConstraint({type: 'HEIGHT', value: 300}), '300h');
});

test('«+» adds PNG 1x, then 2x «@2x», 3x «@3x», 4x «@4x»', () => {
  const first = nextExportSetting([]);
  assert.deepEqual(first, png1x);
  const second = nextExportSetting([first]);
  assert.deepEqual(second, {format: 'PNG', suffix: '@2x', constraint: {type: 'SCALE', value: 2}});
  const third = nextExportSetting([first, second]);
  assert.deepEqual(third, {format: 'PNG', suffix: '@3x', constraint: {type: 'SCALE', value: 3}});
  const fifth = nextExportSetting([first, second, third, nextExportSetting([first, second, third])]);
  assert.deepEqual(fifth.constraint, {type: 'SCALE', value: 1}, 'after 4x it starts over at 1x');
  assert.equal(nextExportSetting([{format: 'JPG', suffix: '', constraint: {type: 'SCALE', value: 1}}]).format, 'JPG', 'the format of the last row carries over');
  assert.equal(nextExportSetting([{format: 'SVG', suffix: '', constraint: {type: 'SCALE', value: 1}}]).format, 'PNG', 'SVG has no scale, so a scaled copy is PNG');
  assert.equal(nextExportSetting([{format: 'PDF', suffix: '', constraint: {type: 'SCALE', value: 1}}]).format, 'PNG', 'nor has the vector PDF');
});

test('PDF: vector by default (no scale, plain «PDF»), raster where the server has no vector PDF', () => {
  assert.deepEqual([formatLabel('PDF'), formatLabel('PDF', 'raster'), formatLabel('PNG', 'raster')], ['PDF', 'PDF (raster)', 'PNG']);
  assert.deepEqual([formatHasScale('PDF'), formatHasScale('PDF', 'raster'), formatHasScale('SVG', 'raster'), formatHasScale('PNG')], [false, true, false, true]);
});

test('PDF settings of one export become one multi-page file per suffix; other files keep their paths', () => {
  const pdf = (suffix = '') => ({format: 'PDF' as const, suffix, constraint: {type: 'SCALE' as const, value: 1}});
  const jobs = planExport([
    {node: {id: 'a', name: 'Cover'}, settings: [png1x, pdf()]},
    {node: {id: 'b', name: 'Spread'}, settings: [pdf(), pdf('-print'), pdf()]},
    {node: {id: 'c', name: 'Export'}, settings: [{format: 'PDF', suffix: '', constraint: {type: 'SCALE', value: 1}}, {...png1x}]},
  ]);
  const {pdf: groups, other} = groupPdfJobs(jobs, 'Page 1');
  assert.deepEqual(other.map(job => job.path), ['Cover.png', 'Export.png']);
  assert.deepEqual(groups.map(group => [group.path, group.jobs.map(job => job.nodeId)]), [
    ['Page 1.pdf', ['a', 'b', 'c']],
    ['Spread-print.pdf', ['b']],
  ], 'one file per suffix, a layer once in it; a single layer keeps its own name');
  const clash = groupPdfJobs(planExport([
    {node: {id: 'a', name: 'Page 1s'}, settings: [pdf()]},
    {node: {id: 'b', name: 'B'}, settings: [pdf('s')]},
    {node: {id: 'c', name: 'C'}, settings: [pdf('s')]},
  ]), 'Page 1');
  assert.deepEqual(clash.pdf.map(group => group.path), ['Page 1s.pdf', 'Page 1s (2).pdf'], 'names stay unique');
});

test('file names: suffix, extension, folders from "/", unsafe characters, duplicates', () => {
  assert.equal(exportFileName('Button', png1x), 'Button.png');
  assert.equal(exportFileName('Button', {format: 'PNG', suffix: '@2x'}), 'Button@2x.png');
  assert.equal(exportFileName('Icons/Arrow', {format: 'SVG', suffix: ''}), 'Icons/Arrow.svg');
  assert.equal(exportFileName(' Icons / Arrow ', {format: 'PDF', suffix: '-print'}), 'Icons/Arrow-print.pdf');
  assert.equal(exportFileName('a:b*c?"d"<e>|f\\g', {format: 'JPG', suffix: ''}), 'a_b_c__d__e__f_g.jpg');
  assert.equal(exportFileName('', {format: 'WEBP', suffix: ''}), 'Untitled.webp');
  assert.equal(exportFileName('///', {format: 'PNG', suffix: ''}), 'Untitled.png');
  assert.equal(exportFileName('..', {format: 'PNG', suffix: ''}), 'Untitled.png');
  assert.equal(exportFileName('../../etc/passwd', {format: 'PNG', suffix: ''}), 'etc/passwd.png', 'no climbing out of the zip');
  assert.equal(safeSegment('CON'), '_CON');
  assert.equal(safeSegment('x'.repeat(300)).length, 120);
  const jobs = planExport([
    {node: {id: '1', name: 'Button'}, settings: [png1x, {format: 'PNG', suffix: '@2x', constraint: {type: 'SCALE', value: 2}}]},
    {node: {id: '2', name: 'button'}, settings: [png1x, png1x]},
  ]);
  assert.deepEqual(jobs.map(job => job.path), ['Button.png', 'Button@2x.png', 'button (2).png', 'button (3).png']);
  assert.deepEqual(jobs.map(job => job.nodeId), ['1', '1', '2', '2']);
  assert.equal(zipName('Icons/Set'), 'Set.zip');
  assert.equal(zipName(''), 'Export.zip');
  const pdf2x = {format: 'PDF', suffix: '@2x', constraint: {type: 'SCALE', value: 2}} as const;
  assert.equal(settingsSummary([png1x, {format: 'SVG', suffix: '', constraint: {type: 'SCALE', value: 1}}, pdf2x]), 'PNG 1x, SVG, PDF "@2x"', 'the vector PDF has no scale');
  assert.equal(settingsSummary([pdf2x], 'raster'), 'PDF 2x "@2x"', 'the raster PDF where the server has none');
  assert.equal(settingsSummary([{format: 'SVG', suffix: '', constraint: {type: 'SCALE', value: 1}, svgIdAttribute: true}]), 'SVG with id');
  assert.equal(exportButtonLabel(['Button'], layersLabel), 'Export Button');
  assert.equal(exportButtonLabel(['a', 'b', 'c'], layersLabel), 'Export 3 layers');
});

// ── PDF writer ─────────────────────────────────────────────────────────────────────────────────

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

/** Parses the cross-reference table and checks every offset lands on its object, as a reader does. */
function readPdf(bytes: Uint8Array) {
  const text = latin1(bytes);
  assert.ok(text.startsWith('%PDF-1.4\n'), 'PDF 1.4 header');
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  const startxref = Number(/startxref\n(\d+)\n%%EOF\s*$/.exec(text)?.[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref', 'startxref points at the table');
  const head = /^xref\n0 (\d+)\n/.exec(text.slice(startxref));
  assert.ok(head);
  const count = Number(head[1]);
  const tableStart = startxref + head[0].length;
  const entries: number[] = [];
  for (let i = 0; i < count; i++) {
    const entry = text.slice(tableStart + i * 20, tableStart + (i + 1) * 20);
    assert.match(entry, /^\d{10} \d{5} [nf] \n$/, `entry ${i} is 20 bytes`);
    entries.push(Number(entry.slice(0, 10)));
  }
  assert.equal(entries[0], 0);
  const objects = new Map<number, string>();
  for (let id = 1; id < count; id++) {
    const at = entries[id];
    assert.equal(text.slice(at, at + `${id} 0 obj`.length), `${id} 0 obj`, `object ${id} is where the table says`);
    const end = text.indexOf('\nendobj', at);
    objects.set(id, text.slice(at, end));
  }
  const trailer = /trailer\n<<(.*?)>>/s.exec(text)?.[1] ?? '';
  assert.match(trailer, new RegExp(`/Size ${count}\\b`));
  assert.match(trailer, /\/Root 1 0 R/);
  const stream = (id: number) => {
    const body = objects.get(id)!;
    const length = Number(/\/Length (\d+)/.exec(body)?.[1]);
    const start = body.indexOf('stream\n') + 7;
    const raw = Buffer.from(body.slice(start, start + length), 'latin1');
    assert.equal(body.slice(start + length, start + length + 10), '\nendstream', `object ${id}'s /Length is exact`);
    return raw;
  };
  return {text, count, objects, stream};
}

function gradient(width: number, height: number, alpha: (x: number, y: number) => number): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    rgba.set([x * 20, y * 30, 200, alpha(x, y)], i);
  }
  return rgba;
}

test('the PDF writer makes a parseable PDF 1.4: offsets, lengths, pages, pixels and alpha', async () => {
  const pages: PdfPage[] = [
    {width: 120, height: 80, image: {width: 6, height: 4, rgba: gradient(6, 4, x => (x === 0 ? 0 : 255))}},
    {width: 30.5, height: 20, image: {width: 3, height: 2, rgba: gradient(3, 2, () => 255)}},
  ];
  // The title and the pdfText sample stay Cyrillic on purpose: non-Latin PDF strings are written as UTF-16BE hex.
  const bytes = await writePdf(pages, {title: 'Главная — десктоп'});
  const pdf = readPdf(bytes);
  assert.match(pdf.objects.get(1)!, /\/Type \/Catalog \/Pages 2 0 R/);
  assert.match(pdf.objects.get(2)!, /\/Count 2/);
  assert.match(pdf.objects.get(3)!, new RegExp(`/Title ${pdfText('Главная — десктоп').replace(/[<>]/g, '\\$&')}`));
  const pageObjects = [...pdf.objects.entries()].filter(([, body]) => body.includes('/Type /Page '));
  assert.equal(pageObjects.length, 2);
  assert.match(pageObjects[0][1], /\/MediaBox \[0 0 120 80\]/);
  assert.match(pageObjects[1][1], /\/MediaBox \[0 0 30\.5 20\]/);
  // First page: an RGB picture with a soft mask, drawn over the whole page.
  const imageId = Number(/\/Im0 (\d+) 0 R/.exec(pageObjects[0][1])![1]);
  const contentsId = Number(/\/Contents (\d+) 0 R/.exec(pageObjects[0][1])![1]);
  assert.equal(pdf.stream(contentsId).toString('latin1'), 'q 120 0 0 80 0 0 cm /Im0 Do Q');
  const image = pdf.objects.get(imageId)!;
  assert.match(image, /\/Subtype \/Image \/Width 6 \/Height 4 \/ColorSpace \/DeviceRGB \/BitsPerComponent 8 \/Filter \/FlateDecode/);
  const rgb = inflateSync(pdf.stream(imageId));
  assert.equal(rgb.length, 6 * 4 * 3);
  assert.deepEqual([...rgb.subarray(3, 6)], [20, 0, 200], 'the second pixel in RGB order');
  const maskId = Number(/\/SMask (\d+) 0 R/.exec(image)![1]);
  assert.match(pdf.objects.get(maskId)!, /\/ColorSpace \/DeviceGray/);
  const alpha = inflateSync(pdf.stream(maskId));
  assert.deepEqual([...alpha.subarray(0, 6)], [0, 255, 255, 255, 255, 255]);
  // Second page: opaque, so no soft mask.
  const secondImage = pdf.objects.get(Number(/\/Im0 (\d+) 0 R/.exec(pageObjects[1][1])![1]))!;
  assert.doesNotMatch(secondImage, /SMask/);
});

test('PDF helpers: numbers, text strings, page size limit, alpha split', () => {
  assert.equal(pdfNumber(12), '12');
  assert.equal(pdfNumber(12.3456789), '12.3457');
  assert.equal(pdfNumber(-0.00001), '0');
  assert.equal(pdfNumber(Number.NaN), '0');
  assert.equal(pdfText('Аб'), '<FEFF04100431>');
  assert.deepEqual(pageSize(28_800, 7_200), {width: 14_400, height: 3_600});
  assert.deepEqual(pageSize(0, 10), {width: 1, height: 10});
  const split = splitAlpha({width: 1, height: 1, rgba: new Uint8Array([1, 2, 3, 255])});
  assert.deepEqual([...split.rgb], [1, 2, 3]);
  assert.equal(split.alpha, null);
  assert.throws(() => splitAlpha({width: 2, height: 2, rgba: new Uint8Array(4)}));
});

// ── PNG decoding (the PDF reads the raster exporter's pixels back exactly) ─────────────────────

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function encodePng(width: number, height: number, rgba: Uint8Array, filter: number): Uint8Array {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = filter;
    for (let x = 0; x < stride; x++) {
      const value = rgba[y * stride + x];
      const left = x >= 4 ? rgba[y * stride + x - 4] : 0;
      const up = y > 0 ? rgba[(y - 1) * stride + x] : 0;
      const corner = y > 0 && x >= 4 ? rgba[(y - 1) * stride + x - 4] : 0;
      const p = left + up - corner;
      const paeth = Math.abs(p - left) <= Math.abs(p - up) && Math.abs(p - left) <= Math.abs(p - corner) ? left : Math.abs(p - up) <= Math.abs(p - corner) ? up : corner;
      const predicted = [0, left, up, (left + up) >> 1, paeth][filter];
      raw[y * (stride + 1) + 1 + x] = (value - predicted) & 0xff;
    }
  }
  const chunk = (type: string, body: Uint8Array) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(body.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG pixels decode exactly under every row filter', () => {
  const rgba = gradient(5, 3, (x, y) => (x * 37 + y * 11) % 256);
  for (const filter of [0, 1, 2, 3, 4]) {
    const decoded = decodePng(encodePng(5, 3, rgba, filter));
    assert.ok(decoded, `filter ${filter}`);
    assert.equal(decoded.width, 5);
    assert.equal(decoded.height, 3);
    assert.deepEqual([...decoded.rgba], [...rgba], `filter ${filter} round-trips`);
  }
  assert.equal(decodePng(new Uint8Array([1, 2, 3])), null);
  const broken = encodePng(5, 3, rgba, 0);
  broken[broken.length - 20] ^= 0xff;
  assert.doesNotThrow(() => decodePng(broken));
});

test('a 2000 × 2000 page is written within a few seconds', async () => {
  const side = 2000;
  const rgba = new Uint8Array(side * side * 4).fill(200);
  const started = performance.now();
  const bytes = await writePdf([{width: side, height: side, image: {width: side, height: side, rgba}}]);
  assert.ok(performance.now() - started < budget(3000), 'writes fast enough for a large frame');
  readPdf(bytes);
});

// ── The export dialog's list and commands ──────────────────────────────────────────────────────

test('the dialog lists the page\'s layers with settings in layers-panel order, or the selection', () => {
  const tx = beginTransaction(createDocument('page'));
  const add = (id: string, parent: string, settings: ExportSetting[] = [], type: 'FRAME' | 'RECTANGLE' | 'SLICE' = 'RECTANGLE') =>
    tx.create(createNode(type, {id, exportSettings: settings}), parent);
  add('bottom', 'page', [png1x], 'FRAME');
  add('inner', 'bottom', [png1x]);
  add('plain', 'page');
  add('slice', 'page', [png1x], 'SLICE');
  const doc = tx.commit({measurer: {width: () => 0, metrics: () => ({ascent: 0, descent: 0})}}).doc;
  assert.deepEqual(exportableIds(doc, 'page', 'page', []), ['slice', 'bottom', 'inner']);
  assert.deepEqual(exportableIds(doc, 'page', 'selection', ['plain', 'missing', 'page']), ['plain']);
  const opened: string[] = [];
  const [all, selection] = exportCommands(scope => opened.push(scope));
  assert.equal(all.id, 'file.export');
  assert.deepEqual(all.shortcut, {code: 'KeyE', mod: true, shift: true});
  assert.equal(selection.id, 'file.export-selection');
  void all.run({} as never);
  void selection.run({} as never);
  assert.deepEqual(opened, ['page', 'selection']);
});
