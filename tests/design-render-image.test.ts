import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apply} from '../shared/design/geometry';
import {applyImageFilters, drawnScale, filtersKey, imagePlacement, luminanceToAlpha, mipLevel, neutralFilters, quarterTurns} from '../src/design/engine/render/image-math';
import {ByteLru, createImageCache, imageRefsUnder, isAllowedImageUrl} from '../src/design/engine/images';
import {installFakeCanvas} from './helpers/fake-canvas';
import {createDocument, createNode} from '../shared/design/defaults';

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≠ ${b}`);
const corners = (m: ReturnType<typeof imagePlacement>['matrix'], w: number, h: number) => [apply(m, {x: 0, y: 0}), apply(m, {x: w, y: h})];

test('FILL covers the box and centres the overflow', () => {
  const {matrix, repeat} = imagePlacement({scaleMode: 'FILL'}, 200, 100, 400, 400);
  assert.equal(repeat, false);
  const [a, b] = corners(matrix, 400, 400);
  close(a.x, 0); close(b.x, 200);
  close(a.y, -50); close(b.y, 150);
});

test('FIT shows the whole image inside the box, centred', () => {
  const [a, b] = corners(imagePlacement({scaleMode: 'FIT'}, 200, 100, 400, 400).matrix, 400, 400);
  close(a.x, 50); close(b.x, 150);
  close(a.y, 0); close(b.y, 100);
});

test('quarter turns rotate the image before fitting it', () => {
  assert.equal(quarterTurns(450), 1);
  assert.equal(quarterTurns(-90), 3);
  // A 400×100 image turned 90° is 100×400: FIT in a 100×400 box fills it exactly.
  const {matrix} = imagePlacement({scaleMode: 'FIT', rotation: 90}, 100, 400, 400, 100);
  const points = [apply(matrix, {x: 0, y: 0}), apply(matrix, {x: 400, y: 0}), apply(matrix, {x: 400, y: 100}), apply(matrix, {x: 0, y: 100})];
  close(Math.min(...points.map(p => p.x)), 0); close(Math.max(...points.map(p => p.x)), 100);
  close(Math.min(...points.map(p => p.y)), 0); close(Math.max(...points.map(p => p.y)), 400);
  // Clockwise on screen: the image's top-left corner lands at the box's top-right.
  close(points[0].x, 100); close(points[0].y, 0);
});

test('CROP maps the node unit box through the inverse of imageTransform', () => {
  // The node shows the middle half of the image.
  const {matrix} = imagePlacement({scaleMode: 'CROP', imageTransform: [[0.5, 0, 0.25], [0, 0.5, 0.25]]}, 100, 100, 1000, 1000);
  const [a, b] = corners(matrix, 1000, 1000);
  close(a.x, -50); close(b.x, 150);
  const middle = apply(matrix, {x: 250, y: 250});
  close(middle.x, 0); close(middle.y, 0);
});

test('TILE repeats the natural size times the scaling factor from the top-left', () => {
  const placement = imagePlacement({scaleMode: 'TILE', scalingFactor: 0.5}, 300, 300, 100, 60);
  assert.equal(placement.repeat, true);
  const [a, b] = corners(placement.matrix, 100, 60);
  close(a.x, 0); close(a.y, 0); close(b.x, 50); close(b.y, 30);
  close(drawnScale(placement, 2), 1);
});

test('mip levels halve once the drawing is half the size or less', () => {
  assert.equal(mipLevel(1, 4000, 3000), 0);
  assert.equal(mipLevel(0.6, 4000, 3000), 0);
  assert.equal(mipLevel(0.5, 4000, 3000), 0);
  assert.equal(mipLevel(0.4, 4000, 3000), 1);
  assert.equal(mipLevel(0.1, 4000, 3000), 3);
  assert.equal(mipLevel(0.0001, 8, 8), 2, 'never below a couple of pixels');
});

test('neutral filters leave pixels alone; saturation −1 greys; keys are stable', () => {
  assert.ok(neutralFilters(undefined));
  assert.ok(neutralFilters({exposure: 0, contrast: 0}));
  assert.equal(neutralFilters({tint: 0.1}), false);
  const pixels = new Uint8ClampedArray([200, 100, 50, 255, 10, 20, 30, 128]);
  const copy = new Uint8ClampedArray(pixels);
  applyImageFilters(copy, {});
  for (let i = 0; i < pixels.length; i++) assert.ok(Math.abs(copy[i] - pixels[i]) <= 1, `channel ${i}`);
  const grey = new Uint8ClampedArray(pixels);
  applyImageFilters(grey, {saturation: -1});
  assert.ok(Math.abs(grey[0] - grey[1]) <= 1 && Math.abs(grey[1] - grey[2]) <= 1);
  assert.equal(grey[3], 255, 'alpha untouched');
  const brighter = new Uint8ClampedArray(pixels);
  applyImageFilters(brighter, {exposure: 0.5});
  assert.ok(brighter[1] > pixels[1]);
  assert.equal(filtersKey({exposure: 0.5}), filtersKey({exposure: 0.5, contrast: 0}));
});

test('luminance masks turn brightness into alpha', () => {
  const pixels = new Uint8ClampedArray([255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 128]);
  luminanceToAlpha(pixels);
  assert.equal(pixels[3], 255);
  assert.equal(pixels[7], 0);
  assert.ok(Math.abs(pixels[11] - 128) <= 1);
});

test('pictures load only from the app origin, blob: of this origin and inline images', () => {
  const origin = 'https://app.foo.test';
  assert.ok(isAllowedImageUrl('/uploads/a.png', origin));
  assert.ok(isAllowedImageUrl('https://app.foo.test/uploads/a.png', origin));
  assert.ok(isAllowedImageUrl(`blob:${origin}/123`, origin));
  assert.ok(isAllowedImageUrl('data:image/png;base64,AAAA', origin));
  assert.equal(isAllowedImageUrl('//evil.example/a.png', origin), false);
  assert.equal(isAllowedImageUrl('https://evil.example/a.png', origin), false);
  assert.equal(isAllowedImageUrl('data:text/html;base64,AAAA', origin), false);
  assert.equal(isAllowedImageUrl('blob:https://evil.example/1', origin), false);
  assert.equal(isAllowedImageUrl('javascript:alert(1)', origin), false);
});

test('the decoded-picture cache drops the least recently used over its byte budget', () => {
  const evicted: string[] = [];
  const lru = new ByteLru<string, number>(100, key => evicted.push(key));
  lru.set('a', 1, 40);
  lru.set('b', 2, 40);
  lru.get('a');
  lru.set('c', 3, 40);
  assert.deepEqual(evicted, ['b']);
  assert.equal(lru.bytes, 80);
  lru.resize('a', 90);
  assert.deepEqual(evicted, ['b', 'c'], 'growing an entry evicts others, never itself');
  assert.equal(lru.size, 1);
});

test('over its budget the cache first lets entries shrink, oldest first, and evicts only what is still over', () => {
  const evicted: string[] = [];
  const sizes = new Map([['a', 10], ['b', 30]]);
  const lru = new ByteLru<string, string>(100, key => evicted.push(key), key => sizes.get(key) ?? null);
  lru.set('a', 'a', 50);
  lru.set('b', 'b', 40);
  lru.set('c', 'c', 30);
  assert.deepEqual(evicted, [], 'a shrank to 10: 10 + 40 + 30 fits');
  assert.equal(lru.bytes, 80);
  lru.set('d', 'd', 60);
  assert.deepEqual(evicted, ['a', 'b'], 'b shrank to 30 and that was not enough: then the oldest go');
  assert.equal(lru.bytes, 90);
});

test('sixty large pictures seen zoomed out fit the cache: full-size decodes give way, mips stay, nothing is fetched twice', async () => {
  const {clock, uninstall} = installFakeCanvas();
  try {
    const loads: string[] = [];
    let release: (() => void)[] = [];
    const load = (url: string) => {
      loads.push(url);
      return new Promise<ImageBitmap>(resolve => release.push(() => resolve({width: 2000, height: 1000, close() {}} as ImageBitmap)));
    };
    // Pictures arrive a few at a time; the canvas draws what arrived before the next ones land.
    const settle = async (draw: () => void) => {
      // Bounded: a cache that drops pictures it still draws would fetch them again forever.
      for (let batch = 0; release.length && batch < 100; batch++) {
        for (const done of release.splice(0, 6)) done();
        await new Promise(resolve => setTimeout(resolve, 0));
        draw();
      }
    };
    // 8 MB per full decode, 2 MB of mips: the full sizes of sixty need 480 MB, the mips 160.
    const images = createImageCache({budgetBytes: 256 * 1024 * 1024, load});
    const doc = createDocument('page');
    for (let k = 0; k < 60; k++) doc.images[`p${k}`] = {url: `/uploads/p${k}.jpg`, width: 2000, height: 1000};
    const drawAll = (scale: number) => Array.from({length: 60}, (_, k) => images.source(`p${k}`, doc, scale));
    for (let round = 0; round < 3; round++) {
      drawAll(0.1);
      await settle(() => drawAll(0.1));
      clock.ms += 5000;
    }
    const zoomedOut = drawAll(0.1);
    assert.ok(zoomedOut.every(found => found && found.factor === 8 && !found.interim), 'every picture draws its mip');
    assert.equal(loads.length, 60, 'each picture fetched once');
    // Zoomed in on one: its full size comes back, its mip stands in meanwhile.
    const interim = images.source('p0', doc, 1)!;
    assert.equal(interim.factor, 2);
    assert.equal(interim.interim, true);
    assert.equal(images.status('p0', doc), 'loading', 'tiles that drew the stand-in draw again when it is back');
    await settle(() => {});
    assert.equal(images.status('p0', doc), 'ready');
    const full = images.source('p0', doc, 1)!;
    assert.equal(full.factor, 1);
    assert.equal(full.interim, undefined);
    assert.equal(loads.length, 61);
    images.dispose();
  } finally {
    uninstall();
  }
});

test('every picture under a root is found: fills, strokes and text run fills', () => {
  const doc = createDocument('page');
  const image = (ref: string) => ({type: 'IMAGE' as const, imageRef: ref, scaleMode: 'FILL' as const, opacity: 1, visible: true, blendMode: 'NORMAL' as const});
  doc.nodes.f = createNode('FRAME', {id: 'f', parentId: 'page', fills: [image('a')], children: ['r', 't']});
  doc.nodes.r = createNode('RECTANGLE', {id: 'r', parentId: 'f', strokes: [image('b')], fills: [{...image('hidden'), visible: false}]});
  doc.nodes.t = createNode('TEXT', {id: 't', parentId: 'f'});
  doc.nodes.t.text!.runs = [{start: 0, end: 0, style: {}, fills: [image('c')]}];
  doc.nodes.page.children = ['f'];
  assert.deepEqual([...imageRefsUnder(doc, 'f')].sort(), ['a', 'b', 'c']);
});
