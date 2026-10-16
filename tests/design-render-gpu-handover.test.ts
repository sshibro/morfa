import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setEngine} from '../shared/design/engine-switch';
import {setRenderWasm, type RenderWasm, type RenderWasmGpu} from '../shared/design/render-engine';
import type {FontRegistry, ImageCache} from '../src/design/engine/contracts';
import {createSwitchingSceneRenderer} from '../src/design/engine/render/scene-renderer';

// The editor's switching scene renderer hands the GPU renderer (lane L4) a canvas no 2d context was ever taken on
// (lane K, 2026-10-10): Canvas2D draws on the scene canvas from the first frame, and a canvas that gave a 2d context
// never gives a webgpu one, so on a machine with a GPU `?engine=render:wasm` never left Canvas2D («GpuRenderer.create:
// canvas.getContext() returned null»). No WebGPU adapter exists in the cloud containers: the canvases here are
// stand-ins that keep the browser's rule, and the renderer wasm a stub whose `GpuRenderer.create` asks for webgpu.

const fonts: FontRegistry = {
  measurer: {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})},
  ensure: async () => {},
  isLoaded: () => true,
  families: () => [],
  cssFont: () => '12px sans-serif',
  onLoad: () => () => {},
};
const images: ImageCache = {get: () => null, size: () => null, whenReady: async () => {}, onChange: () => () => {}};

/** A canvas element with the one rule that matters: the first context kind it gives is the only one it ever gives. */
class StandInCanvas {
  width = 300;
  height = 150;
  className = '';
  style: Record<string, string> & {cssText: string} = {cssText: ''};
  readonly attributes = new Map<string, string>();
  context: string | null = null;
  parent: StandInParent | null = null;
  constructor(readonly ownerDocument: {createElement(tag: string): StandInCanvas}) {}
  getContext(kind: string): object | null {
    if (this.context && this.context !== kind) return null;
    this.context = kind;
    return kind === '2d' ? {canvas: this} : {kind};
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  before(node: StandInCanvas) {
    this.parent!.insertBefore(node, this);
  }
  insertAdjacentElement(where: string, node: StandInCanvas) {
    assert.equal(where, 'afterend');
    // As the DOM: a canvas outside the document has no place to put a neighbour in.
    if (!this.parent) return null;
    const at = this.parent.children.indexOf(this) + 1;
    node.parent = this.parent;
    this.parent.children.splice(at, 0, node);
    return node;
  }
  remove() {
    this.parent?.removeChild(this);
  }
}

class StandInParent {
  readonly children: StandInCanvas[] = [];
  append(node: StandInCanvas) {
    node.parent = this;
    this.children.push(node);
  }
  insertBefore(node: StandInCanvas, ref: StandInCanvas) {
    node.parent = this;
    this.children.splice(this.children.indexOf(ref), 0, node);
  }
  removeChild(node: StandInCanvas) {
    this.children.splice(this.children.indexOf(node), 1);
    node.parent = null;
  }
}

function standIns() {
  const made: StandInCanvas[] = [];
  const document = {createElement: () => {
    const canvas = new StandInCanvas(document);
    made.push(canvas);
    return canvas;
  }};
  const parent = new StandInParent();
  const scene = new StandInCanvas(document);
  scene.className = 'dz-canvas__scene';
  scene.style.cssText = 'position: absolute; left: 0px; top: 0px; display: block;';
  scene.style.display = 'block';
  scene.setAttribute('aria-hidden', 'true');
  parent.append(scene);
  return {scene, parent, made};
}

/** The renderer wasm as far as the hand-over goes: `GpuRenderer.create` takes the canvas's webgpu context, as
 *  crates/render-wasm does, and fails as Chromium does when the canvas already gave a 2d one. */
function stubWasm(handed: StandInCanvas[]): RenderWasm {
  const gpu = {capacity: () => 64, resize() {}, free() {}, memory_bytes: () => 0} as unknown as RenderWasmGpu;
  return {
    version: () => 'stub',
    RenderDoc: class {
      static decode() {
        return {} as never;
      }
      free() {}
    } as unknown as RenderWasm['RenderDoc'],
    GpuRenderer: {
      async create(canvas: HTMLCanvasElement) {
        const standIn = canvas as unknown as StandInCanvas;
        handed.push(standIn);
        if (!standIn.getContext('webgpu')) throw new Error('canvas.getContext() returned null; webgpu not available or canvas already in use');
        return gpu;
      },
    },
  };
}

test('the GPU renderer gets a canvas of its own, takes the scene canvas\'s place in the document and gives it back', async () => {
  const restoreEngine = setEngine('render', 'wasm');
  const handed: StandInCanvas[] = [];
  setRenderWasm(stubWasm(handed));
  try {
    const {scene, parent} = standIns();
    const renderer = createSwitchingSceneRenderer(scene as unknown as HTMLCanvasElement, {fonts, images});
    assert.equal(scene.context, '2d', 'Canvas2D draws on the scene canvas from the first frame');
    await renderer.whenReady;
    assert.equal(handed.length, 1);
    assert.notEqual(handed[0], scene, 'the GPU path is not handed the scene canvas');
    assert.equal(handed[0].context, 'webgpu', 'the canvas it got gave a webgpu context');
    assert.equal(renderer.engine(), 'gpu', `the GPU renderer took over (reason: ${renderer.reason()})`);
    // In the scene canvas's place: just before it, with its class, style and aria-hidden, the GPU renderer's titles canvas
    // next to it (in the document: the GPU canvas was there when the GPU renderer was made); the scene canvas hidden.
    const labels = parent.children[1];
    assert.deepEqual(parent.children, [handed[0], labels, scene]);
    assert.equal(labels.className, 'dz-canvas__labels');
    assert.equal(handed[0].className, 'dz-canvas__scene');
    assert.equal(handed[0].getAttribute('aria-hidden'), 'true');
    assert.equal(handed[0].style.display, 'block');
    assert.equal(scene.style.display, 'none');
    renderer.dispose();
    assert.deepEqual(parent.children, [scene], 'dispose takes the GPU canvas and its titles out');
    assert.equal(scene.style.display, 'block', 'and shows the scene canvas again');
  } finally {
    setRenderWasm(null);
    restoreEngine();
  }
});

test('without the GPU path the scene canvas stays Canvas2D\'s and nothing is added to the document', async () => {
  const restoreEngine = setEngine('render', 'wasm');
  const handed: StandInCanvas[] = [];
  const wasm = stubWasm(handed);
  setRenderWasm({...wasm, GpuRenderer: {create: async () => Promise.reject(new Error('no adapter'))}});
  try {
    const {scene, parent} = standIns();
    const renderer = createSwitchingSceneRenderer(scene as unknown as HTMLCanvasElement, {fonts, images});
    await renderer.whenReady;
    assert.equal(renderer.engine(), 'canvas2d');
    assert.equal(renderer.reason(), 'no adapter');
    assert.deepEqual(parent.children, [scene]);
    assert.equal(scene.style.display, 'block');
    renderer.dispose();
  } finally {
    setRenderWasm(null);
    restoreEngine();
  }
  // The render module on `ts` (the default): no second canvas is even made.
  const {scene, made} = standIns();
  const renderer = createSwitchingSceneRenderer(scene as unknown as HTMLCanvasElement, {fonts, images});
  await renderer.whenReady;
  assert.equal(renderer.engine(), 'canvas2d');
  assert.equal(made.length, 0);
  renderer.dispose();
});
