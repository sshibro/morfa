import {test} from 'node:test';
import assert from 'node:assert/strict';
import {engineWasm, engineFor} from '../shared/design/engine-switch';
import {noteCheckpointBytes, renderWasm, renderWasmAvailable} from '../shared/design/render-engine';
import {RenderShadow} from '../src/design/engine/render/gpu/render-shadow';
import type {ImageCache} from '../src/design/engine/contracts';
import {FIXTURES} from '../scripts/goldens/fixtures';

// The renderer's document from the engine shadow's bytes (crates/render-wasm `RenderDoc.decode` / `load_bytes`, S1's
// binary codec; the big-file path of src/design/engine/render/gpu/render-shadow.ts): the same pages, areas and bounds
// as the JSON load, and a document loaded over an existing one replaces it whole.

test('RenderDoc from the engine shadow\'s bytes equals the JSON load', t => {
  if (engineFor('render') === 'ts' || !renderWasmAvailable()) {
    t.diagnostic('skipped: render module in ts mode or no renderer build');
    return;
  }
  const {RenderDoc} = renderWasm();
  const fixture = FIXTURES.find(f => f.name === 'template-mobile')!;
  const document = fixture.build();
  const json = JSON.stringify(document);
  const engine = new (engineWasm().MorfaDoc)(json);
  const bytes = engine.encode();
  engine.free();
  const fromJson = new RenderDoc(json);
  const fromBytes = RenderDoc.decode(bytes);
  const other = new RenderDoc(JSON.stringify(FIXTURES.find(f => f.name === 'template-social')!.build()));
  other.load_bytes(bytes);
  try {
    assert.ok(bytes.length < json.length, `the codec is denser than JSON: ${bytes.length} vs ${json.length}`);
    for (const doc of [fromBytes, other]) {
      assert.deepEqual(doc.pages(), fromJson.pages());
      for (const page of document.pages) {
        assert.deepEqual(Array.from(doc.page_area(page)), Array.from(fromJson.page_area(page)), `page area of ${page}`);
        for (const id of document.nodes[page].children ?? []) assert.deepEqual(Array.from(doc.bounds(page, id)), Array.from(fromJson.bounds(page, id)), `bounds of ${id}`);
      }
    }
  } finally {
    fromJson.free();
    fromBytes.free();
    other.free();
  }
});

test('the renderer\'s shadow loads the bytes a document was opened from as they are, and only that document', t => {
  if (engineFor('render') === 'ts' || !renderWasmAvailable()) {
    t.diagnostic('skipped: render module in ts mode or no renderer build');
    return;
  }
  const document = FIXTURES.find(f => f.name === 'template-mobile')!.build();
  const json = JSON.stringify(document);
  const engine = new (engineWasm().MorfaDoc)(json);
  const bytes = engine.encode();
  engine.free();
  noteCheckpointBytes(document, bytes);
  const images: ImageCache = {get: () => null, size: () => null, whenReady: async () => {}, onChange: () => () => {}};
  const opened = new RenderShadow(renderWasm(), images);
  const reference = new RenderShadow(renderWasm(), images);
  try {
    opened.sync(document);
    assert.equal(opened.lastLoad, 'checkpoint', 'the fetched bytes went in');
    reference.sync(JSON.parse(json));
    assert.equal(reference.lastLoad, 'json', 'another document (equal, not the one opened) loads the usual way');
    for (const page of document.pages) {
      assert.deepEqual(Array.from(opened.doc.page_area(page)), Array.from(reference.doc.page_area(page)), `page area of ${page}`);
      for (const id of document.nodes[page].children ?? []) assert.deepEqual(Array.from(opened.doc.bounds(page, id)), Array.from(reference.doc.bounds(page, id)), `bounds of ${id}`);
    }
  } finally {
    opened.dispose();
    reference.dispose();
  }
});
