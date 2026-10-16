// The text engine's modules and helpers (lane L3). The mode (`ts | wasm | both`) is the engine switch's
// (`shared/design/engine-switch.ts`, module 'text': MORFA_ENGINE_TEXT / MORFA_ENGINE / ?engine=); this
// module only holds what the switch does not: the two wasm builds of crates/text-wasm and
// crates/text-fonts-wasm (modules of their own, apart from `morfa-wasm`, so the editor's first load carries
// none of them), their lazy loading in Node, the code-unit helpers, and the glyph drawing mode.
//
// In the browser the host registers the builds with `setTextWasm`/`setTextFonts`
// (src/design/engine/text-wasm.ts loads them as dynamic chunks when the switch says so); in Node
// server/design/wasm-text and server/design/wasm-fonts are required on first use (scripts/wasm-text-build.sh).

import {engineFor, EngineUnsupported, withEngine} from './engine-switch';

/** The `text_*` exports of crates/text-wasm: layout, kept texts, carets, segmentation. */
export interface TextWasm {
  text_version(): string;
  text_layout(chars: Uint16Array, params: Float64Array, props: Float64Array, measurer: number, width: (...args: unknown[]) => number, metrics: (...args: unknown[]) => {ascent: number; descent: number}): Float64Array;
  text_put(id: number, chars: Uint16Array, props: Float64Array): void;
  text_drop(id: number): void;
  text_kept_texts(): number;
  text_layout_many(ids: Uint32Array, params: Float64Array, measurer: number, width: (...args: unknown[]) => number, metrics: (...args: unknown[]) => {ascent: number; descent: number}): Float64Array;
  text_forget(measurer: number): void;
  text_kept_layouts(): number;
  text_line_index_at(layout: number, offset: number, upstream: boolean): number | undefined;
  text_caret_at(layout: number, offset: number, upstream: boolean): Float64Array | undefined;
  text_offset_at(layout: number, x: number, y: number): Float64Array | undefined;
  text_selection_rects(layout: number, start: number, end: number): Float64Array | undefined;
  text_line_range(layout: number, offset: number, upstream: boolean): Float64Array | undefined;
  text_move_caret(layout: number, text: Uint16Array, offset: number, direction: number, goalX: number | undefined, upstream: boolean): Float64Array | undefined;
  text_grapheme_boundaries(text: Uint16Array, from: number, to: number): Uint32Array;
  text_next_grapheme_boundary(text: Uint16Array, offset: number): number;
  text_prev_grapheme_boundary(text: Uint16Array, offset: number): number;
  text_snap_to_grapheme(text: Uint16Array, offset: number, forward: boolean): number;
  text_word_at(text: Uint16Array, offset: number): Uint32Array;
  text_word_start_before(text: Uint16Array, offset: number): number;
  text_word_end_after(text: Uint16Array, offset: number): number;
  text_starts_word(text: Uint16Array, index: number): boolean;
  text_paragraph_at(text: Uint16Array, offset: number): Uint32Array;
  text_paragraph_ranges(text: Uint16Array): Uint32Array;
  text_can_break_between(prev: number, cp: number, next: number): boolean;
  text_can_break_after_spaces(next: number): boolean;
  text_is_letter_or_digit(cp: number): boolean;
  text_case_grapheme(grapheme: Uint16Array, mode: number, wordStart: boolean): Uint16Array;
  text_has_lowercase(grapheme: Uint16Array): boolean;
}

/** The `text_*` exports of crates/text-fonts-wasm: the font store, shaping and glyph outlines (loaded when the
 *  renderer first needs a loaded face). */
export interface TextFontsWasm {
  fonts_version(): string;
  text_add_face(family: string, weightMin: number, weightMax: number, italic: boolean, unicodeRange: string, bytes: Uint8Array): number;
  text_face_count(): number;
  text_has_family(family: string): boolean;
  text_width(family: string, weight: number, italic: boolean, size: number, text: Uint16Array): number;
  text_metrics(family: string, weight: number, italic: boolean, size: number): Float64Array;
  text_shape(family: string, weight: number, italic: boolean, size: number, text: Uint16Array): Float64Array;
  text_glyph_path(face: number, weight: number, glyph: number): Float32Array;
}

/** How the renderer draws glyphs: Canvas2D `fillText`, or the engine's outlines as `Path2D` (lane L3 T4). */
export type TextGlyphMode = 'canvas' | 'outline';

type Runtime = {process?: {env?: Record<string, string | undefined>; versions?: {node?: string}; getBuiltinModule?: (id: string) => unknown}};
const runtime = globalThis as Runtime;

let glyphMode: TextGlyphMode = runtime.process?.versions?.node && runtime.process.env?.MORFA_TEXT_GLYPHS === 'outline' ? 'outline' : 'canvas';
export const textGlyphMode = (): TextGlyphMode => glyphMode;
export function setTextGlyphMode(next: TextGlyphMode): void {
  glyphMode = next;
}

let wasm: TextWasm | null | undefined;
let fonts: TextFontsWasm | null | undefined;
let loadError: unknown = null;

/** Registers the loaded layout module (the browser loader after `await init()`, a test); `null` unloads it. */
export function setTextWasm(module: TextWasm | null): void {
  wasm = module;
  loadError = null;
}

/** Registers the loaded fonts module; without it the layout measures with the canvas as before. */
export function setTextFonts(module: TextFontsWasm | null): void {
  fonts = module;
}

/** In Node the CommonJS builds load on first use (process.getBuiltinModule keeps bundlers from seeing it). */
function loadInNode(): void {
  const proc = runtime.process;
  if (!proc?.versions?.node || typeof proc.getBuiltinModule !== 'function') {
    wasm = null;
    return;
  }
  const {createRequire} = proc.getBuiltinModule('node:module') as {createRequire: (url: string) => (id: string) => unknown};
  const require = createRequire(import.meta.url);
  wasm = require(proc.env?.MORFA_TEXT_WASM_PATH ?? '../../server/design/wasm-text') as TextWasm;
  try {
    fonts ??= require(proc.env?.MORFA_TEXT_FONTS_WASM_PATH ?? '../../server/design/wasm-fonts') as TextFontsWasm;
  } catch {
    fonts ??= null;
  }
}

/** The layout module; throws when the switch wants wasm and none is loaded (never a silent TypeScript answer). */
export function textWasm(): TextWasm {
  if (wasm) return wasm;
  if (wasm === undefined && !loadError) {
    try {
      loadInNode();
    } catch (error) {
      loadError = error;
    }
  }
  if (wasm) return wasm;
  const why = loadError instanceof Error ? `: ${loadError.message}` : '';
  throw new Error(`text-engine: the text wasm module is not loaded${why}. In Node build it with scripts/wasm-text-build.sh; in the browser await loadTextWasm() (src/design/engine/text-wasm.ts) first.`);
}

/** The fonts module when the text module runs as `wasm` and it is loaded; null otherwise. Never under `both`
 *  (its TypeScript side measures with the canvas, so the wasm side must too) nor under `ts`. */
export function textFonts(): TextFontsWasm | null {
  if (engineFor('text') !== 'wasm') return null;
  if (wasm === undefined && !loadError) {
    try {
      loadInNode();
    } catch (error) {
      loadError = error;
    }
  }
  return fonts ?? null;
}

/** The fonts module whatever the text module's mode, loaded on first use in Node (lane L6: the server's measurer
 *  shapes with it, server/design/wasm-engine.ts); null when it is not built. Additive: `textFonts()` keeps its rule. */
export function textFontsModule(): TextFontsWasm | null {
  if (fonts) return fonts;
  if (wasm === undefined && !loadError) {
    try {
      loadInNode();
    } catch (error) {
      loadError = error;
    }
  }
  return fonts ?? null;
}

/** The last few texts converted, so the segment calls of one keystroke convert a long text once. */
const unitCache = new Map<string, Uint16Array>();
const UNIT_CACHE_SIZE = 8;

/** UTF-16 code units of a string, as the Rust side reads text. */
export function codeUnits(text: string): Uint16Array {
  const hit = unitCache.get(text);
  if (hit) return hit;
  const out = new Uint16Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  if (text.length > 64) {
    if (unitCache.size >= UNIT_CACHE_SIZE) unitCache.delete(unitCache.keys().next().value!);
    unitCache.set(text, out);
  }
  return out;
}

/** A string from code units (`String.fromCharCode` in chunks, so long texts do not overflow the stack). */
export function fromCodeUnits(units: Uint16Array): string {
  let out = '';
  for (let i = 0; i < units.length; i += 8192) out += String.fromCharCode.apply(null, Array.from(units.subarray(i, i + 8192)));
  return out;
}

/** One call of the text module through the switch: `withEngine('text', …)` with the TypeScript body and the wasm
 *  body given the module; a wasm answer of `undefined` (a layout the wasm side no longer holds) is
 *  `EngineUnsupported`, so the switch counts the fallback and TypeScript answers. */
export function viaEngine<T>(what: string, ts: () => T, wasm: (mod: TextWasm) => T | undefined): T {
  return withEngine('text', what, ts, () => {
    const answer = wasm(textWasm());
    if (answer === undefined) throw new EngineUnsupported(`text.${what}: not held by the wasm side`);
    return answer;
  });
}
