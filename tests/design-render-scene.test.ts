import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';
import type {FontRegistry, ImageCache, Viewport} from '../src/design/engine/contracts';
import {createSceneRenderer} from '../src/design/engine/render/scene-renderer';
import {zoomAround} from '../src/design/engine/viewport';
import {FakeCanvas, type FakeContext, installFakeCanvas} from './helpers/fake-canvas';

// The tiled scene renderer driven frame by frame on a recording canvas (tests/helpers/fake-canvas.ts): what each
// frame composites onto the visible canvas, under a clock where painting a tile takes time, so a zoom leaves holes
// that other scales fill as in the browser.

const fonts: FontRegistry = {
  measurer: {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})},
  ensure: async () => {},
  isLoaded: () => true,
  families: () => [],
  cssFont: () => '12px sans-serif',
  onLoad: () => () => {},
};
const images: ImageCache = {get: () => null, size: () => null, whenReady: async () => {}, onChange: () => () => {}};

function rectangleDoc(): DesignDocument {
  const doc = createDocument('page');
  doc.nodes.r = createNode('RECTANGLE', {id: 'r', parentId: 'page', x: 0, y: 0, width: 600, height: 500});
  doc.nodes.page.children!.push('r');
  return doc;
}

test('zooming in close and out again composites about one screen of tiles per frame, not one per cached scale', () => {
  const {clock, uninstall} = installFakeCanvas();
  try {
    const size = {width: 1440, height: 900}, dpr = 2;
    const scene = new FakeCanvas(size.width * dpr, size.height * dpr);
    scene.paints = false;
    const ctx = scene.getContext() as FakeContext;
    const renderer = createSceneRenderer(scene as unknown as OffscreenCanvas, {fonts, images});
    const doc = rectangleDoc();
    // A tile takes 5 ms to paint: about two fit a frame's budget, so a new scale fills in over several frames.
    clock.paintMs = 5;
    const screenArea = scene.width * scene.height;
    let viewport: Viewport = {x: 300 - size.width / 2, y: 250 - size.height / 2, zoom: 1};
    const ratios: number[] = [];
    const frame = () => {
      ctx.drawn.area = 0;
      renderer.render({doc, pageId: 'page', viewport, size, dpr});
      ratios.push(ctx.drawn.area / screenArea);
      clock.ms += 16;
    };
    for (let k = 0; k < 40; k++) frame();
    const centre = {x: size.width / 2, y: size.height / 2};
    // A mouse wheel: notches of ×1.4, with a pause after every third, long enough for the zoom to settle.
    const zoom = (factor: number) => {
      for (let step = 0; step < 18; step++) {
        viewport = zoomAround(viewport, centre, viewport.zoom * factor);
        frame();
        if (step % 3 === 2) {
          clock.ms += 200;
          for (let k = 0; k < 4; k++) frame();
        }
      }
      for (let k = 0; k < 60; k++) frame();
    };
    zoom(1.4);
    assert.equal(viewport.zoom, 256);
    zoom(1 / 1.4);
    renderer.dispose();
    const worst = Math.max(...ratios);
    // Each frame draws the screen once with this scale's tiles, plus other scales only inside its holes.
    assert.ok(worst <= 2.05, `a frame composited ${worst.toFixed(1)} screens of tiles`);
  } finally {
    uninstall();
  }
});

test('a frame of the last options while a newer document waits keeps the changed ids for the next sync (no scan of every node)', () => {
  const {uninstall} = installFakeCanvas();
  try {
    const scene = new FakeCanvas(400, 400);
    scene.paints = false;
    const renderer = createSceneRenderer(scene as unknown as OffscreenCanvas, {fonts, images});
    const options = {pageId: 'page', viewport: {x: 0, y: 0, zoom: 1}, size: {width: 400, height: 400}, dpr: 1};
    const before = rectangleDoc();
    renderer.render({...options, doc: before});
    const after: DesignDocument = {...before, nodes: {...before.nodes, r: {...before.nodes.r, x: 10}}};
    renderer.documentChanged({doc: after, changed: new Set(['r'])});
    // Each sync's hint as it was passed (the renderer clears its id set once the index moved).
    const hints: ({from: unknown; ids: string[]} | undefined)[] = [];
    const index = renderer.index as unknown as {sync: (...args: unknown[]) => unknown};
    const sync = index.sync.bind(index);
    index.sync = (...args: unknown[]) => {
      const hint = args[3] as {from: unknown; ids: ReadonlySet<string>} | undefined;
      hints.push(hint && {from: hint.from, ids: [...hint.ids]});
      return sync(...args);
    };
    // The renderer's own loop paints the tiles still missing with the last options (the older document) first.
    renderer.render({...options, doc: before});
    renderer.render({...options, doc: after});
    const hint = hints.at(-1);
    assert.ok(hint, 'the sync to the newer document compares the reported ids');
    assert.equal(hint.from, before);
    assert.deepEqual(hint.ids, ['r']);
    assert.equal(renderer.index.document, after);
    renderer.dispose();
  } finally {
    uninstall();
  }
});

test('pixel preview draws the shape being dragged as the same magnified 1× picture as the tiles, not sharper', () => {
  const {uninstall} = installFakeCanvas();
  try {
    const size = {width: 200, height: 150}, dpr = 2;
    const doc = createDocument('page');
    doc.nodes.r = createNode('RECTANGLE', {id: 'r', parentId: 'page', x: 20, y: 20, width: 30, height: 20});
    doc.nodes.page.children!.push('r');
    const viewport: Viewport = {x: 10, y: 10, zoom: 4};
    const liveDraw = (pixelPreview: boolean) => {
      const scene = new FakeCanvas(size.width * dpr, size.height * dpr);
      const ctx = scene.getContext() as FakeContext & {imageSmoothingEnabled: boolean};
      const layers: {source: number[]; dest: number[]; smoothing: boolean}[] = [];
      const drawImage = ctx.drawImage.bind(ctx);
      ctx.drawImage = (source: {width: number; height: number}, ...rest: number[]) => {
        if (rest.length === 8) layers.push({source: rest.slice(0, 4), dest: rest.slice(4), smoothing: ctx.imageSmoothingEnabled});
        drawImage(source, ...rest);
      };
      const renderer = createSceneRenderer(scene as unknown as OffscreenCanvas, {fonts, images});
      renderer.render({doc, pageId: 'page', viewport, size, dpr, pixelPreview, live: new Set(['r'])});
      renderer.dispose();
      return layers.at(-1)!;
    };
    // 8 device px per page px; the page origin falls at -80, -80.
    const pixel = liveDraw(true);
    assert.deepEqual(pixel.source, [0, 0, 30, 20], 'painted at 1×, like the tiles under it');
    assert.deepEqual(pixel.dest, [80, 80, 240, 160], 'magnified onto the tiles\' pixel grid');
    assert.equal(pixel.smoothing, false);
    const sharp = liveDraw(false);
    assert.deepEqual(sharp.source, [0, 0, 240, 160]);
    assert.deepEqual(sharp.dest, [80, 80, 240, 160]);
  } finally {
    uninstall();
  }
});

test('after a zoom stops, the view sharpens at the new scale by itself: frames keep coming until every tile is rasterized', () => {
  const {clock, uninstall} = installFakeCanvas();
  const g = globalThis as {requestAnimationFrame?: unknown; cancelAnimationFrame?: unknown};
  const saved = {request: g.requestAnimationFrame, cancel: g.cancelAnimationFrame};
  const queued = new Map<number, () => void>();
  let handles = 0;
  g.requestAnimationFrame = (callback: () => void) => (queued.set(++handles, callback), handles);
  g.cancelAnimationFrame = (handle: number) => queued.delete(handle);
  try {
    const size = {width: 1440, height: 900}, dpr = 2;
    const scene = new FakeCanvas(size.width * dpr, size.height * dpr);
    scene.paints = false;
    const renderer = createSceneRenderer(scene as unknown as OffscreenCanvas, {fonts, images});
    // A page full of layers (an imported design system): a tile takes 12 ms, more than a frame's budget.
    const doc = createDocument('page');
    for (let k = 0; k < 600; k++) {
      const id = `r${k}`;
      doc.nodes[id] = createNode('RECTANGLE', {id, parentId: 'page', x: (k % 30) * 40, y: Math.floor(k / 30) * 40, width: 30, height: 30});
      doc.nodes.page.children!.push(id);
    }
    clock.paintMs = 12;
    let viewport: Viewport = {x: 0, y: 0, zoom: 1};
    const options = () => ({doc, pageId: 'page', viewport, size, dpr});
    /** The browser's next frame: what the renderer asked for, nothing else (nobody moves the pointer). */
    const nextFrame = () => {
      clock.ms += 16;
      const due = [...queued.values()];
      queued.clear();
      for (const callback of due) callback();
      return due.length;
    };
    renderer.render(options());
    for (let k = 0; k < 400 && nextFrame(); k++);
    assert.equal(renderer.stats().complete, true, 'the first view finishes');
    // A wheel zoom to 800% around the middle, frame by frame; then the hand leaves the wheel.
    const centre = {x: size.width / 2, y: size.height / 2};
    for (let step = 0; step < 6; step++) {
      viewport = zoomAround(viewport, centre, viewport.zoom * 1.415);
      renderer.render(options());
      nextFrame();
    }
    assert.ok(viewport.zoom > 7.9 && viewport.zoom < 8.1);
    let frames = 0;
    while (frames < 2000 && nextFrame()) frames++;
    const stats = renderer.stats();
    assert.equal(stats.pending, 0, `${stats.pending} tiles still waiting after ${frames} frames`);
    assert.equal(stats.level, viewport.zoom * dpr, 'drawn at the screen\'s own scale, not a stretched one');
    assert.equal(stats.complete, true);
    renderer.dispose();
  } finally {
    g.requestAnimationFrame = saved.request;
    g.cancelAnimationFrame = saved.cancel;
    uninstall();
  }
});
