import type {WasmWire} from './ws';

// The browser's loader of the binary wire's WASM (crates/wasm `decode_frame`/`encode_frame`, the web build in
// src/design/wasm/): the engine's own build, fetched once whether the engine or the socket asks first. Registered by
// realtime/index.tsx with `setWasmWire` (pick.ts); the decode worker bundles its own copy (decode-worker.ts). The glob
// keeps the build working without the wasm: the loader then answers null and the socket speaks JSON.

type WasmBuild = {default: (input?: unknown) => Promise<unknown>} & WasmWire;

const builds = import.meta.glob<WasmBuild>('../../wasm/morfa_wasm.js');

let loading: Promise<WasmWire | null> | null = null;

export function loadWasmWire(): Promise<WasmWire | null> {
  return (loading ??= (async () => {
    const load = builds['../../wasm/morfa_wasm.js'];
    if (!load) return null;
    const build = await load();
    // wasm-bindgen's init: once per realm, later calls return the instance it has.
    await build.default();
    return typeof build.decode_frame === 'function' && typeof build.encode_frame === 'function' ? build : null;
  })().catch(() => {
    loading = null;
    return null;
  }));
}
