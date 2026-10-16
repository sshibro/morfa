import {engineFor} from '../../../shared/design/engine-switch';
import {renderWasmLoaded, setRenderWasm, type RenderWasm} from '../../../shared/design/render-engine';

// The browser's loader of the renderer (lane L4): crates/render-wasm, the web build of scripts/wasm-render-build.sh
// in src/design/wasm-render/ (vello on WebGPU). Lazy, like engine-wasm.ts and text-wasm.ts: a dynamic chunk the
// editor fetches only when the render module runs as `wasm` or `both` and the browser has WebGPU; the default editor
// ships none of it and draws with Canvas2D (the engine for browsers without WebGPU too). The glob keeps the build
// working when the wasm was not built: the loader then throws, and the switch falls back to Canvas2D (counted).

type Build = {default: (input?: unknown) => Promise<unknown>} & RenderWasm;
const builds = import.meta.glob<Build>('../wasm-render/morfa_render_wasm.js');

let loading: Promise<void> | null = null;
let failure: Error | null = null;

/** True when this browser exposes WebGPU (the renderer's engine; Canvas2D stays otherwise). */
export const webGpuAvailable = (): boolean => typeof navigator !== 'undefined' && !!(navigator as {gpu?: unknown}).gpu;

/** Loads and installs the renderer module once; resolves at once when it is loaded already. */
export function loadRenderWasm(): Promise<void> {
  if (renderWasmLoaded()) return Promise.resolve();
  return (loading ??= (async () => {
    const load = builds['../wasm-render/morfa_render_wasm.js'];
    if (!load) throw new Error('render-wasm: src/design/wasm-render/morfa_render_wasm.js is missing; run scripts/wasm-render-build.sh');
    const module = await load();
    await module.default();
    setRenderWasm(module);
    failure = null;
  })().catch(error => {
    failure = error instanceof Error ? error : new Error(String(error));
    throw failure;
  }).finally(() => {
    loading = null;
  }));
}

/** Loads the renderer when the switch needs it and WebGPU is there; nothing otherwise (a load failure is kept for
 *  the switch's fallback and never thrown at the editor). */
export const loadRenderWasmIfNeeded = (): Promise<void> =>
  engineFor('render') !== 'ts' && webGpuAvailable() ? loadRenderWasm().catch(() => undefined) : Promise.resolve();

/** Why the last load failed, for the fallback's message. */
export const renderWasmFailure = (): Error | null => failure;
