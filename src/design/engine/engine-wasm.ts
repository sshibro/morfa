import {ENGINE_MODULES, anyWasmEngine, engineByDefault, engineFor, engineWasmLoaded, setEngineWasm, type MorfaWasm} from '../../../shared/design/engine-switch';

// The browser's loader of the engine (crates/wasm, web build of scripts/wasm-build.sh in src/design/wasm/). Lazy:
// a dynamic chunk the editor fetches only when some module runs as `wasm` or `both` (shared/design/engine-switch.ts,
// `EDITOR_DEFAULTS` included), never in its first load (the designEditor budget counts initial JavaScript only). The glob keeps
// the build working when the wasm was not built: the loader then throws, and the editor shows the error.

const builds = import.meta.glob<{default: (input?: unknown) => Promise<unknown>} & MorfaWasm>('../wasm/morfa_wasm.js');

let loading: Promise<void> | null = null;

/** Loads and installs the wasm engine once; resolves at once when it is loaded already. */
export function loadEngineWasm(): Promise<void> {
  if (engineWasmLoaded()) return Promise.resolve();
  return (loading ??= (async () => {
    const load = builds['../wasm/morfa_wasm.js'];
    if (!load) throw new Error('engine-wasm: src/design/wasm/morfa_wasm.js is missing; run scripts/wasm-build.sh');
    const module = await load();
    await module.default();
    setEngineWasm(module);
  })().finally(() => {
    loading = null;
  }));
}

/** Loads the engine when the switch needs it (`?engine=both`, `__MORFA_ENGINE__`, or a module the editor runs as wasm
 *  by default); nothing otherwise. Chosen: the editor waits for it. Only by default (`EDITOR_DEFAULTS`): it loads in
 *  the background once the open has settled (`whenIdle`); until it is in, TypeScript answers (lane E1: a default never
 *  costs the open its download, nor delays the open's fonts). */
export function loadEngineWasmIfNeeded(): Promise<void> {
  if (!anyWasmEngine()) return Promise.resolve();
  if (ENGINE_MODULES.some(module => engineFor(module) !== 'ts' && !engineByDefault(module))) return loadEngineWasm();
  whenIdle(() => void loadEngineWasm().catch(error => console.warn('engine-wasm: the engine did not load; TypeScript answers', error)));
  return Promise.resolve();
}

/** How long after the editor asked a default's download waits before it looks for an idle moment: the open's own
 *  requests (the document, the first page's fonts, whose faces keep arriving after the first paint) go first. */
const SETTLE_MS = 2000;

/** Work for an idle moment once the open has settled: a default's download never competes with the open's requests
 *  (lane E1: the engine arriving with the fonts delayed their re-render into the user's first drag). */
export function whenIdle(run: () => void): void {
  setTimeout(() => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run(), {timeout: 3000});
    else run();
  }, SETTLE_MS);
}
