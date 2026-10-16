import {engineFor} from '../../../shared/design/engine-switch';
import {exportWasmLoaded, setExportWasm, type ExportWasm} from '../../../shared/design/export-wasm';

// The browser's loader of lane L5's export module (crates/export-wasm, the web build of scripts/wasm-export-build.sh in
// src/design/wasm-export/). Lazy, like geometry-wasm.ts: a dynamic chunk fetched only when something is exported with
// the switch's module `export` at `wasm` or `both`, so the editor's first load ships none of it. Until it is installed,
// export calls fall back to TypeScript (counted by the switch).

const builds = import.meta.glob<{default: (input?: unknown) => Promise<unknown>} & ExportWasm>('../wasm-export/morfa_export_wasm.js');

let loading: Promise<void> | null = null;

/** Loads and installs the export module once; resolves at once when it is loaded already. */
export function loadExportWasm(): Promise<void> {
  if (exportWasmLoaded()) return Promise.resolve();
  return (loading ??= (async () => {
    const load = builds['../wasm-export/morfa_export_wasm.js'];
    if (!load) throw new Error('export-wasm: src/design/wasm-export/morfa_export_wasm.js is missing; run scripts/wasm-export-build.sh');
    const module = await load();
    await module.default();
    setExportWasm(module);
  })().finally(() => {
    loading = null;
  }));
}

/** Loads the export module when the switch runs `export` in Rust (`?engine=export:wasm`); nothing otherwise. Awaited by
 *  the export panel before an SVG or PDF export. */
export const loadExportWasmIfNeeded = (): Promise<void> => (engineFor('export') !== 'ts' ? loadExportWasm() : Promise.resolve());
