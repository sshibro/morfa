import {readFileSync} from 'node:fs';
import path from 'node:path';
import {anyWasmEngine, ENGINE_MODULES, engineFor, engineWasm, type EngineMode, type EngineModule} from '../../shared/design/engine-switch';
import {codeUnits, textFontsModule, textWasm, type TextFontsWasm} from '../../shared/design/text-engine';
import type {FontSpec, TextMeasurer} from '../../shared/design/text-layout';
import {fontFamilies, type FontFamily} from '../../shared/fonts';

// The server's side of the Rust engine. The server loads the very build the browser uses,
// crates/wasm as server/design/wasm (scripts/wasm-build.sh, `--target nodejs`), through the engine switch
// (shared/design/engine-switch.ts `engineWasm`): there is no loader here, only the check at start that what the
// environment asks for (MORFA_ENGINE, MORFA_ENGINE_<MODULE>) is there, so a process that would fail its first save
// refuses to start instead. The save path (server/design/apply.ts, document-store.ts, files.ts) already calls the
// switched functions: with MORFA_ENGINE_OPS=wasm the merge, the patches and the patched-document check run in Rust;
// `both` runs both and throws on any difference.
//
// Documents stay JavaScript objects on the server: the ops calls read the entries they need by id through their
// lookup (shared/design/ops-engine.ts), so nothing is held in wasm per document.
//
// DESIGN_SERVER_LAYOUT=1: after a merge the server lays out what it combined (server/design/apply.ts `layOutChange`),
// measuring text with crates/text's shaper over the catalogue's own font files (`serverMeasurer`).

export type ServerEngines = {modes: Record<EngineModule, EngineMode>; wasm: string | null; text: boolean; layout: boolean};

/** Whether the server lays out merged saves itself (docs/design-tool.md "Co-editing", Layout). */
export const serverLayoutOn = (): boolean => process.env.DESIGN_SERVER_LAYOUT === '1';

let started: ServerEngines | null = null;

/** Loads what the environment asks for, once per process, and says what runs where. Throws when a module set to
 *  `wasm`/`both` has no build to load (never a TypeScript fallback). */
export function startServerEngines(): ServerEngines {
  if (started) return started;
  const modes = Object.fromEntries(ENGINE_MODULES.map(module => [module, engineFor(module)])) as Record<EngineModule, EngineMode>;
  const wasm = anyWasmEngine() ? engineWasm().version() : null;
  const layout = serverLayoutOn();
  // The text module (crates/text-wasm) and the shaper (crates/text-fonts-wasm) are separate builds.
  const text = modes.text !== 'ts' || layout;
  if (modes.text !== 'ts') textWasm();
  if (layout && !textFontsModule()) throw Error('DESIGN_SERVER_LAYOUT=1 needs the text modules: build them with scripts/wasm-text-build.sh');
  started = {modes, wasm, text, layout};
  return started;
}

// ── The measurer ─────────────────────────────────────────────────────────────────────────────────

/** Where the catalogue's font files are (scripts/copy-fonts.ts puts them there). DESIGN_FONTS_DIR overrides. */
const fontsDir = () => path.resolve(process.env.DESIGN_FONTS_DIR ?? 'public/fonts');

const SUBSETS = [
  ['cyrillic', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'],
  ['latin', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
] as const;

/** Every face file of a family as the editor registers them (src/design/engine/fonts.ts `faceSources`): weight range,
 *  style and subset. The shaper's store picks the face per call as CSS font matching does. */
function familyFaces(font: FontFamily): {file: string; min: number; max: number; italic: boolean; unicodeRange: string}[] {
  if (font.files)
    return font.files.map(file => {
      const [min, max = min] = String(file.weight).split(/\s+/).map(Number);
      return {file: `${font.dir}/${file.name}`, min, max, italic: file.style === 'italic', unicodeRange: file.unicodeRange ?? ''};
    });
  if (font.variable) {
    const [min, max] = font.weights;
    return SUBSETS.map(([subset, unicodeRange]) => ({file: `${font.dir}/${font.dir}-${subset}-wght-normal.woff2`, min, max, italic: false, unicodeRange}));
  }
  return font.weights.flatMap(w => SUBSETS.map(([subset, unicodeRange]) => ({file: `${font.dir}/${font.dir}-${subset}-${w}-normal.woff2`, min: w, max: w, italic: false, unicodeRange})));
}

const catalogue = new Map<string, FontFamily>();
for (const font of Object.values(fontFamilies)) if (!catalogue.has(font.family)) catalogue.set(font.family, font);

/** A TextMeasurer whose widths and metrics come from crates/text's shaper (harfrust over the catalogue's files,
 *  Chrome-rounded, lane L3), the faces a family needs read from disk on its first use. `misses` counts calls about a
 *  family the server does not have (a designer's local font): the caller then leaves the layout to the editor. */
export type ServerMeasurer = TextMeasurer & {readonly misses: number};

let shared: ServerMeasurer | null = null;

export function serverMeasurer(): ServerMeasurer {
  if (shared) return shared;
  const module = textFontsModule();
  if (!module) throw Error('the server measurer needs crates/text-fonts-wasm: build it with scripts/wasm-text-build.sh');
  const fonts: TextFontsWasm = module;
  const loaded = new Map<string, boolean>();
  let misses = 0;
  const have = (family: string): boolean => {
    let known = loaded.get(family);
    if (known !== undefined) return known;
    const font = catalogue.get(family);
    known = false;
    if (font) {
      try {
        for (const face of familyFaces(font))
          fonts.text_add_face(font.family, face.min, face.max, face.italic, face.unicodeRange, readFileSync(path.join(fontsDir(), face.file)));
        known = fonts.text_has_family(font.family);
      } catch {
        known = false;
      }
    }
    loaded.set(family, known);
    return known;
  };
  // A miss still answers (the layout must finish): half an em per code unit, the tests' fake.
  const measurer: ServerMeasurer = {
    width(text: string, font: FontSpec) {
      if (have(font.family)) {
        const width = fonts.text_width(font.family, font.weight, font.italic, font.size, codeUnits(text));
        if (!Number.isNaN(width)) return width;
      }
      misses++;
      return text.length * font.size * 0.5;
    },
    metrics(font: FontSpec) {
      if (have(font.family)) {
        const m = fonts.text_metrics(font.family, font.weight, font.italic, font.size);
        if (m.length) return {ascent: m[0], descent: m[1]};
      }
      misses++;
      return {ascent: font.size * 0.8, descent: font.size * 0.2};
    },
    get misses() {
      return misses;
    },
  };
  shared = measurer;
  return measurer;
}
