import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFontRegistry, internalFamily} from '../src/design/engine/fonts';
import {createQueryLocalFonts, fontData, installLocalFonts} from '../src/desktop/fonts';
import {desktopFontsReady} from '../src/desktop/host';
import type {DesktopFont} from '../src/desktop/ipc';

// Local fonts in the desktop app (src/desktop/fonts.ts): the shell's list behind `queryLocalFonts`, and the editor's
// registry drawing those faces from their bytes (src/design/engine/fonts.ts).

const FONTS: DesktopFont[] = [
  {id: 0, family: 'Graphik', fullName: 'Graphik', postscriptName: 'Graphik-Regular', style: 'Regular', weight: 400, italic: false, collection: false},
  {id: 1, family: 'Graphik', fullName: 'Graphik SemiBold Italic', postscriptName: 'Graphik-SemiboldItalic', style: 'SemiBold Italic', weight: 600, italic: true, collection: false},
  {id: 2, family: 'Helvetica Neue', fullName: 'Helvetica Neue', postscriptName: 'HelveticaNeue', style: 'Regular', weight: 400, italic: false, collection: true},
];

function fakeHost() {
  const reads: number[] = [];
  let lists = 0;
  return {
    reads,
    lists: () => lists,
    listFonts: async () => (lists++, FONTS),
    readFont: async (id: number) => (reads.push(id), new Uint8Array([id, 1, 2, 3]).buffer),
  };
}

test('queryLocalFonts answers the shell list like Chrome, once, with bytes for single-face files', async () => {
  const host = fakeHost();
  const query = createQueryLocalFonts(host);
  assert.equal(query.morfaDesktop, true);
  const all = await query();
  assert.deepEqual(all.map(font => [font.family, font.postscriptName, font.style]), FONTS.map(font => [font.family, font.postscriptName, font.style]));
  assert.deepEqual((await query({postscriptNames: ['HelveticaNeue']})).map(font => font.postscriptName), ['HelveticaNeue']);
  assert.equal(host.lists(), 1, 'the list is read once');
  assert.equal(typeof all[0].morfaBytes, 'function');
  assert.equal(all[2].morfaBytes, undefined, 'a face inside a collection draws through local()');
  const blob = await all[0].blob();
  assert.equal(blob.size, 4);
  await all[0].morfaBytes!();
  assert.deepEqual(host.reads, [0], 'one read per face');
});

test('a failed list or read is tried again next time', async () => {
  let fail = true;
  const query = createQueryLocalFonts({listFonts: async () => {
    if (fail) throw new Error('down');
    return FONTS;
  }, readFont: async () => new ArrayBuffer(1)});
  await assert.rejects(query());
  fail = false;
  assert.equal((await query()).length, 3);
  let reads = 0;
  const data = fontData({readFont: async () => {
    if (reads++ === 0) throw new Error('busy');
    return new ArrayBuffer(2);
  }}, FONTS[0]);
  await assert.rejects(data.morfaBytes!());
  assert.equal((await data.morfaBytes!()).byteLength, 2);
});

test('inside the app the shell’s list takes the place of a web view’s own queryLocalFonts', () => {
  const own: {queryLocalFonts?: unknown} = {queryLocalFonts: () => Promise.resolve([])};
  assert.equal(installLocalFonts(fakeHost(), own), true);
  assert.equal((own.queryLocalFonts as {morfaDesktop?: boolean}).morfaDesktop, true);
  const empty: {queryLocalFonts?: unknown} = {};
  assert.equal(installLocalFonts(fakeHost(), empty), true);
});

test('the editor registry lists local families and draws them from the shell’s bytes', async () => {
  const host = fakeHost();
  const added: {family: string; source: unknown; descriptors: unknown}[] = [];
  class FakeFontFace {
    constructor(readonly family: string, readonly source: unknown, readonly descriptors: unknown) {
      added.push({family, source, descriptors});
    }
    load() {
      return Promise.resolve(this);
    }
  }
  const scope = globalThis as {queryLocalFonts?: unknown; FontFace?: unknown; __MORFA_DESKTOP__?: unknown; __TAURI_INTERNALS__?: unknown};
  const previous = {query: scope.queryLocalFonts, face: scope.FontFace};
  scope.FontFace = FakeFontFace;
  // Inside the shell (a browser registers no waiter at all).
  scope.__MORFA_DESKTOP__ = {version: '0.1.0', platform: 'linux'};
  scope.__TAURI_INTERNALS__ = {};
  try {
    installLocalFonts(host, globalThis);
    const fontSet = {add() {}} as unknown as FontFaceSet;
    const fonts = createFontRegistry({fontSet});
    const changed: string[] = [];
    fonts.onLoad(family => changed.push(family));
    const before = fonts.measurer.revision;
    // The bridge says the shell is ready: the registry lists local fonts without a prompt.
    desktopFontsReady();
    await new Promise(resolve => setTimeout(resolve, 5));
    const graphik = fonts.families().find(font => font.family === 'Graphik');
    assert.deepEqual(graphik, {family: 'Graphik', weights: [400, 600], italic: true, source: 'local'});
    assert.ok(fonts.measurer.revision > before, 'layouts measured with the fallback are redone');
    assert.ok(changed.includes('Graphik') && changed.includes('Helvetica Neue'));

    await fonts.ensure({family: 'Graphik', weight: 700, italic: true, size: 16});
    assert.deepEqual(host.reads, [1], 'the nearest face (SemiBold Italic) is read');
    const face = added.at(-1)!;
    assert.equal(face.family, internalFamily('Graphik'));
    assert.ok(face.source instanceof ArrayBuffer, 'drawn from bytes, not local()');
    assert.deepEqual(face.descriptors, {weight: '600', style: 'italic'});
    assert.equal(fonts.isLoaded({family: 'Graphik', weight: 700, italic: true, size: 16}), true);

    await fonts.ensure({family: 'Helvetica Neue', weight: 400, italic: false, size: 16});
    assert.equal(added.at(-1)!.source, 'local("HelveticaNeue")', 'a collection face goes through local()');
  } finally {
    scope.queryLocalFonts = previous.query;
    scope.FontFace = previous.face;
    delete scope.__MORFA_DESKTOP__;
    delete scope.__TAURI_INTERNALS__;
  }
});
