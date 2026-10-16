import {engineByDefault, engineFor} from '../../../shared/design/engine-switch';
import {whenIdle} from './engine-wasm';
import {geometryWasmLoaded, setGeometryWasm, type GeometryWasm} from '../../../shared/design/geometry-wasm';

// The browser's loader of lane L1's geometry module (crates/geometry-wasm, the web build of
// scripts/wasm-geometry-build.sh in src/design/wasm-geometry/). Lazy, like engine-wasm.ts and text-wasm.ts: a dynamic
// chunk the editor fetches only when the switch runs geometry as `wasm` or `both`, so the default editor ships none
// of it. Until it is installed, the geometry calls fall back to TypeScript (counted by the switch). The glob keeps
// the build working when the module was not built: the loader then throws, and the editor shows the error.

const builds = import.meta.glob<{default: (input?: unknown) => Promise<unknown>} & GeometryWasm>('../wasm-geometry/morfa_geometry_wasm.js');

let loading: Promise<void> | null = null;

/** Loads and installs the geometry module once; resolves at once when it is loaded already. */
export function loadGeometryWasm(): Promise<void> {
  if (geometryWasmLoaded()) return Promise.resolve();
  return (loading ??= (async () => {
    const load = builds['../wasm-geometry/morfa_geometry_wasm.js'];
    if (!load) throw new Error('geometry-wasm: src/design/wasm-geometry/morfa_geometry_wasm.js is missing; run scripts/wasm-geometry-build.sh');
    const module = await load();
    await module.default();
    setGeometryWasm(module);
  })().finally(() => {
    loading = null;
  }));
}

/** Loads the geometry module when the switch needs it (`?engine=geometry:both`, `__MORFA_ENGINE__`, or the editor's
 *  default); nothing otherwise. A default (not chosen) loads in the background once the open has settled
 *  (engine-wasm.ts `whenIdle`): the calls fall back to TypeScript until it is in, and the editor does not wait. */
export function loadGeometryWasmIfNeeded(): Promise<void> {
  if (engineFor('geometry') === 'ts') return Promise.resolve();
  if (!engineByDefault('geometry')) return loadGeometryWasm();
  whenIdle(() => void loadGeometryWasm().catch(error => console.warn('geometry-wasm: the module did not load; TypeScript answers', error)));
  return Promise.resolve();
}
