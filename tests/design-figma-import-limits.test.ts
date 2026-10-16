import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {figmaKit, NUXT_LIKE} from './helpers/figma-kit';
import {FigmaImportError, figmaPagesOver, importFigmaFile, measureFigmaImport, planFigmaParts, type FigmaFile} from '../shared/design/figma-import';
import {DESIGN_DOCUMENT_CAPS} from '../shared/design/limits';
import {setBigFiles, tooLargeMessage} from '../shared/design/big-files';
import {validateDocument} from '../shared/design/schema';
import {createDocument, createNode} from '../shared/design/defaults';
import {readFigmaFile, runFigmaImport, type RunDeps} from '../src/design/import/figma/run-import';

// The limits a Figma import can hit, with
// a generated kit shaped like Nuxt UI v4 (tests/helpers/figma-kit.ts): which cap stops it, the message naming the file's number against
// the cap, and a large kit brought in parts that each fit. The link is the only way in (there is no .fig reader); the server's own
// checks of the saved document name the same numbers.

const MB = 1024 * 1024;
const caps = DESIGN_DOCUMENT_CAPS;
// The fixed caps, whatever DESIGN_BIG_FILES says: the gate may run with big files on.
before(() => setBigFiles(false));
after(() => setBigFiles(null));
const notes = (items: {key: string; message: string}[]) => Object.fromEntries(items.filter(item => /^cap-|images-too-big/.test(item.key)).map(item => [item.key, item.message]));
const digits = (text: string) => text.replace(/[\s\u00a0,]/g, '');

// Half a Nuxt-like kit: 30 component pages of 120 variants and their examples, 36 000 layers, 10 MB of Figma JSON.
const half = figmaKit({...NUXT_LIKE, pages: 30});
const chosenOf = (kit: {layersByPage: Map<string, number>}) => [...kit.layersByPage.values()].reduce((a, b) => a + b, 0);

test('the binding cap of a UI kit is the 20 MB of JSON, long before 50 000 layers: the note says how much came in of how much', () => {
  const result = importFigmaFile(half.file);
  const chosen = chosenOf(half);
  assert.equal(result.layers.chosen, chosen);
  assert.ok(chosen < caps.nodes, 'fewer layers than the layer cap');
  assert.deepEqual(result.limits.map(hit => [hit.limit, hit.cap]), [['bytes', caps.bytes]]);
  assert.ok(result.limits[0]!.value > caps.bytes, 'the first, uncut attempt is what is reported');
  assert.ok(result.bytes <= caps.bytes);
  assert.ok(validateDocument(JSON.parse(JSON.stringify(result.doc))).ok);
  const message = digits(notes(result.report.items)['cap-bytes']!);
  assert.match(message, /largerthan20MB/);
  assert.ok(message.includes(`${result.layers.imported}of${chosen}layerswereimported`), message);
  // A mapped layer is far larger than its Figma JSON: Figma's own counts do not say what fits.
  assert.ok(result.bytes / result.layers.imported > 2 * (JSON.stringify(half.file).length / chosen));
});

test('the layer cap and the page cap name the chosen pages\' numbers', () => {
  const kit = figmaKit({...NUXT_LIKE, pages: 8, variants: 30, docFrames: 1, instancesPerFrame: 5});
  const chosen = chosenOf(kit);
  const byLayers = importFigmaFile(kit.file, {caps: {nodes: 400}});
  assert.deepEqual(byLayers.limits, [{limit: 'nodes', value: chosen, cap: 400}]);
  assert.ok(digits(notes(byLayers.report.items)['cap-nodes']!).includes(`Thechosenpageshave${chosen}layersandaMorfafilecanholdatmost400`));
  const byPages = importFigmaFile(kit.file, {caps: {pages: 4}});
  assert.deepEqual(byPages.limits, [{limit: 'pages', value: 9, cap: 4}]);
  assert.match(notes(byPages.report.items)['cap-pages']!, /^9 pages are chosen, and a Morfa file can hold at most 4/);
  assert.equal(byPages.doc.pages.length, 3);
});

test('a file not even part of which fits says how big it is', () => {
  const kit = figmaKit({...NUXT_LIKE, pages: 2, variants: 40});
  assert.throws(
    // Smaller than the pages themselves: nothing fits however few layers it takes.
    () => importFigmaFile(kit.file, {caps: {bytes: 300}}),
    (error: unknown) =>
      error instanceof FigmaImportError &&
      error.limit?.limit === 'bytes' &&
      error.limit.cap === 300 &&
      error.limit.value > 300 &&
      /^Even part of the chosen pages is [\d.]+ MB, and a Morfa file can be at most 0 MB\. Choose fewer pages\.$/.test(error.message),
  );
});

test('the page picker\'s data: each page measured as the file stores it, a kit planned in parts that each import whole', () => {
  const measure = measureFigmaImport(half.file);
  assert.equal(measure.pages.length, 31);
  assert.ok(measure.bytes > caps.bytes);
  assert.deepEqual(figmaPagesOver(measure, measure.pages.map(page => page.id)).map(hit => hit.limit), ['bytes']);
  const sum = measure.pages.reduce((total, page) => total + page.bytes, 0);
  assert.ok(Math.abs(sum - measure.bytes) / measure.bytes < 0.01, 'the pages\' shares add up to the file');
  const parts = planFigmaParts(half.file);
  assert.ok(parts.length >= 2);
  assert.deepEqual(parts.flatMap(part => part.pageIds), measure.pages.map(page => page.id), 'every page once, in the file\'s order');
  for (const part of parts) {
    assert.ok(part.fits, JSON.stringify(part));
    assert.deepEqual(figmaPagesOver(measure, part.pageIds), []);
    const imported = importFigmaFile(half.file, {pageIds: part.pageIds});
    assert.deepEqual(imported.limits, [], 'a part comes in whole');
    assert.equal(imported.layers.imported, part.layers);
    assert.ok(validateDocument(JSON.parse(JSON.stringify(imported.doc))).ok);
  }
});

test('a part needing components from pages it leaves out measures them too', () => {
  // Page 1's examples are instances of page 0's variants: page 1 alone lifts them onto "Components".
  const kit = figmaKit({...NUXT_LIKE, pages: 2, variants: 20, docFrames: 1, instancesPerFrame: 4, pictures: 0, borrow: true});
  const second = kit.file.document!.children![2]!;
  const alone = measureFigmaImport(kit.file, {pageIds: [second.id]});
  assert.ok(alone.lifted.layers > 0, 'components lifted from the page left out');
  assert.equal(alone.layers, alone.pages[0]!.layers + alone.lifted.layers);
  const [part] = planFigmaParts(kit.file, {pageIds: [second.id]});
  assert.equal(part!.layers, alone.layers, 'a part is measured with what it lifts');
});

test('the server\'s refusals name the file\'s number: its size, its layers', () => {
  assert.equal(tooLargeMessage(caps, Math.round(27.4 * MB)), 'The file is 27.4 MB, the limit is 20 MB. Split it into several files.');
  // Layers spread over frames, as a kit's are: the document's own count.
  const doc = createDocument('page', 'Page');
  for (let frame = 0; frame * 1000 < caps.nodes; frame++) {
    const frameId = 'f' + frame;
    doc.nodes[frameId] = createNode('FRAME', {id: frameId, parentId: 'page'});
    doc.nodes.page.children!.push(frameId);
    for (let k = 0; k < 1000; k++) {
      doc.nodes[`${frameId}r${k}`] = createNode('RECTANGLE', {id: `${frameId}r${k}`, parentId: frameId});
      doc.nodes[frameId].children!.push(`${frameId}r${k}`);
    }
  }
  const layers = Object.keys(doc.nodes).length;
  const checked = validateDocument(doc);
  assert.equal(checked.ok, false);
  assert.equal(digits(checked.ok ? '' : checked.error), digits(`The file has ${layers} layers, the limit is ${caps.nodes}.`));
  // A single container over the cap: its own count.
  const flat = createDocument('page', 'Page');
  flat.nodes.page.children = Array.from({length: caps.nodes + 1}, (_, k) => 'x' + k);
  const refused = validateDocument(flat);
  assert.match(digits(refused.ok ? '' : refused.error), new RegExp(`^${caps.nodes + 1}layersthelimitis${caps.nodes}\\.$`));
});

test('a picture over the upload cap that cannot be made smaller is named in the report, not lumped with the others', async () => {
  const kit = figmaKit({...NUXT_LIKE, pages: 1, variants: 4, docFrames: 0, pictures: 3});
  const ref = (k: number) => 'a'.repeat(39) + k;
  let uploads = 0;
  const deps: RunDeps = {
    client: {
      file: async () => structuredClone(kit.file),
      nodes: async () => ({nodes: {}}),
      imageFills: async () => Object.fromEntries([0, 1, 2].map(k => [ref(k), `https://figma.example/${ref(k)}`])),
    },
    // Picture 0 is over the cap and cannot be shrunk; picture 1 the server refuses as too big (its megapixels); picture 2 is fine.
    download: async url => (url.endsWith(ref(0)) ? new Blob([new Uint8Array(caps.imageBytes + 1)]) : new Blob([url.endsWith(ref(1)) ? 'large' : 'png'])),
    shrink: async () => null,
    createFile: async () => ({file: {id: 'f', name: 'Kit', version: 1, createdAt: '', updatedAt: '', thumbnailUrl: null, trashedAt: null}}),
    uploadImage: async (_file, picture) => {
      if (picture.size === 'large'.length) throw Object.assign(new Error('The image is too large'), {status: 413, details: {code: 'design_document_too_large'}});
      uploads++;
      return {ref: 'dz-' + uploads, asset: {url: `/uploads/dz-${uploads}.png`, width: 4, height: 4}};
    },
    replaceDocument: async () => ({version: 2, updatedAt: ''}),
    eraseFile: async () => undefined,
    sleep: async () => undefined,
    yieldToUi: async () => undefined,
  };
  const read = await readFigmaFile('KEY', deps, undefined, () => undefined);
  const outcome = await runFigmaImport(read, read.pages.map(page => page.id), deps, undefined, () => undefined);
  const item = outcome.report.items.find(entry => entry.key === 'images-too-big');
  assert.ok(item, JSON.stringify(outcome.report.items.map(entry => entry.key)));
  assert.equal(item.count, 2);
  assert.match(item.message, /^Images larger than 20 MB or \d+ megapixels/);
  assert.equal(outcome.imagesCopied, 1);
  assert.ok(!outcome.report.items.some(entry => entry.key === 'images-missing'), 'nothing else was missing');
});
