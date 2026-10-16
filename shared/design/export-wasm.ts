import type {DesignDocument, NodeId} from './types';
import type {TextMeasurer} from './text-layout';
import type {Rect} from './geometry';
import type {SvgExportOptions, SvgPage} from './svg-export';
import {EngineUnsupported, engineWasmLoaded, shadowFor, shadowIsAt} from './engine-switch';

// The export as a wasm module of its own (crates/export-wasm, built by scripts/wasm-export-build.sh): the SVG
// exporter (shared/design/svg-export.ts) in Rust behind the switch's module `export`, and the direct vector PDF
// (shared/design/pdf-wasm.ts). Export is rarely used, so the editor's first load carries none of it.
//
// Loading: Node requires the CommonJS build on first use (server/design/wasm-export, or MORFA_WASM_EXPORT_PATH); a
// build that is missing throws, never a silent fallback. The browser installs the web build through
// src/design/engine/export-wasm.ts before an export when the switch runs `export` as wasm or both; until it has, a call
// throws EngineUnsupported, so the TypeScript answers and the switch counts a fallback.
//
// The document crosses as JSON once per call (`ExportDoc.fromJson`), or as the shadow document's S1 frame
// (`ExportDoc.fromFrame(MorfaDoc.encode())`). Text is measured by the caller's measurer, called back exactly as
// text-layout.ts calls it, except the fixed-width fake of the tests, which Rust has natively.

/** A document held by the export module. */
export interface ExportDocHandle {
  /** `{svg, bounds: [x, y, width, height]}`; `options` as JSON. `measurer` null: the fixed-width fake. */
  svg(ids: string[], options: string, measurer: TextMeasurer | null, pictures: ExportPictures | null): {svg: string; bounds: Float64Array};
  nodeCount(): number;
  free(): void;
}

/** Where pictures come from (svg-export.ts `imageData` / `imageHref`). */
export type ExportPictures = {data?: (ref: string) => string | undefined; href?: (ref: string) => string | undefined};

/** crates/export-wasm as wasm-bindgen exports it. */
export interface ExportWasm {
  installClock(): void;
  lastPanic(): string;
  exportVersion(): string;
  hasFonts(): boolean;
  /** Registers a face file (sfnt or woff2) under its CSS descriptors; its id, or -1. */
  addFace(family: string, weightMin: number, weightMax: number, italic: boolean, unicodeRange: string, bytes: Uint8Array): number;
  hasFamily(family: string): boolean;
  ExportDoc: {fromJson(json: string): ExportDocHandle; fromFrame(bytes: Uint8Array): ExportDocHandle};
}

// ── The module ──────────────────────────────────────────────────────────────────────────────────────────────────

type Runtime = {process?: {env?: Record<string, string | undefined>; versions?: {node?: string}; getBuiltinModule?: (name: string) => unknown}};
const runtime = globalThis as unknown as Runtime;

let installed: ExportWasm | null = null;
let settled = false;
let loadError: unknown = null;

/** Installs the export module (the browser loader after `init()`; tests may install a fake, or `null`). */
export function setExportWasm(module: ExportWasm | null): void {
  module?.installClock();
  installed = module;
  settled = true;
  loadError = null;
}

export const exportWasmLoaded = (): boolean => installed !== null;

function loadInNode(): ExportWasm | null {
  const getBuiltin = runtime.process?.getBuiltinModule;
  if (!runtime.process?.versions?.node || !getBuiltin) return null;
  const {createRequire} = getBuiltin('node:module') as {createRequire(from: string): (id: string) => unknown};
  const path = runtime.process.env?.MORFA_WASM_EXPORT_PATH ?? new URL('../../server/design/wasm-export/morfa_export_wasm.js', import.meta.url).pathname;
  return createRequire(import.meta.url)(path) as ExportWasm;
}

/** The export module: throws EngineUnsupported while the browser has not installed it, and a plain error when Node
 *  cannot load its build. */
export function exportWasm(): ExportWasm {
  if (installed) return installed;
  if (!settled) {
    settled = true;
    try {
      const module = loadInNode();
      module?.installClock();
      installed = module;
    } catch (error) {
      loadError = error;
    }
    if (installed) return installed;
  }
  if (loadError) {
    const why = loadError instanceof Error ? loadError.message : String(loadError);
    throw new Error(`export-wasm: the export module did not load (${why}); build it with scripts/wasm-export-build.sh`);
  }
  throw new EngineUnsupported('export-wasm: the export module is not loaded yet');
}

/** Runs `call` on the module; a Rust panic is reported with its message, a refusal of the input (`unsupported: …`,
 *  a document the model cannot represent) becomes EngineUnsupported. */
export function exportCall<T>(call: string, run: (module: ExportWasm) => T): T {
  const module = exportWasm();
  try {
    return run(module);
  } catch (error) {
    if (error instanceof WebAssembly.RuntimeError) {
      const panic = module.lastPanic();
      throw new Error(`export-wasm ${call}: Rust panic: ${panic || error.message}`, {cause: error});
    }
    if (error instanceof Error && error.message.startsWith('unsupported: ')) throw new EngineUnsupported(`export-wasm ${call}: ${error.message.slice(13)}`);
    throw error;
  }
}

// ── Inputs ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether `measurer` is the fixed-width fake (`testMeasurer`: every UTF-16 unit half an em, ascent 0.8, descent 0.2),
 *  asked on every call (normalize.ts's probe): Rust measures it natively instead of calling back. */
export function fixedWidthMeasurer(measurer: TextMeasurer): boolean {
  try {
    const font = {family: 'Inter', weight: 400, italic: false, size: 10};
    const metrics = measurer.metrics(font);
    return measurer.width('W', font) === 5 && measurer.width('i', font) === 5 && measurer.width('Wi', font) === 10 && metrics.ascent === 8 && metrics.descent === 2;
  } catch {
    return false;
  }
}

/** How documents reached the module (benches and STATUS). */
export const exportTransfers = {frames: 0, json: 0};

/** The document in the export module, for one call: the shadow document's frame (S1's codec, `MorfaDoc.encode`)
 *  when the shadow is at this document already (the editor, whose store it follows), else its JSON. */
export function exportDocument(module: ExportWasm, doc: DesignDocument): ExportDocHandle {
  if (engineWasmLoaded() && shadowIsAt(doc)) {
    exportTransfers.frames++;
    return module.ExportDoc.fromFrame(shadowFor(doc).encode());
  }
  exportTransfers.json++;
  return module.ExportDoc.fromJson(JSON.stringify(ownTables(doc)));
}

/** `doc` with every table's entries as own properties: a caller may lay a few entries over a document's table through
 *  its prototype (codegen's `Object.create(doc.nodes)`), which JSON.stringify would drop. */
function ownTables(doc: DesignDocument): DesignDocument {
  let out: DesignDocument | null = null;
  for (const key of ['nodes', 'styles', 'images', 'variableCollections', 'variables', 'variableModes'] as const) {
    const table = doc[key] as Record<string, unknown> | undefined;
    if (!table || typeof table !== 'object') continue;
    const proto = Object.getPrototypeOf(table);
    if (proto === Object.prototype || proto === null) continue;
    const flat: Record<string, unknown> = {};
    for (const id in table) flat[id] = table[id];
    out ??= {...doc};
    (out as unknown as Record<string, unknown>)[key] = flat;
  }
  return out ?? doc;
}

export type ExportSvgInput = {
  measurer: TextMeasurer | null;
  pictures: ExportPictures | null;
  options: string;
};

export function svgInput(options: SvgExportOptions): ExportSvgInput {
  const {precision, idPrefix, layerIds, print, crop, outlineText} = options;
  return {
    measurer: fixedWidthMeasurer(options.measurer) ? null : options.measurer,
    pictures: options.imageData || options.imageHref ? {data: options.imageData, href: options.imageHref} : null,
    options: JSON.stringify({precision, idPrefix, layerIds, print, crop, outlineText}),
  };
}

const rect = (b: Float64Array): Rect => ({x: b[0], y: b[1], width: b[2], height: b[3]});

/** `exportSvgPage` in Rust. */
export function exportSvgPageWasm(doc: DesignDocument, ids: readonly NodeId[], options: SvgExportOptions): SvgPage {
  return exportCall('exportSvgPage', module => {
    const input = svgInput(options);
    const handle = exportDocument(module, doc);
    try {
      const out = handle.svg([...ids], input.options, input.measurer, input.pictures);
      return {svg: out.svg, bounds: rect(out.bounds)};
    } finally {
      handle.free();
    }
  });
}
