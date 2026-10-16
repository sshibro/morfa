import {engineFor} from '../../../shared/design/engine-switch';
import {setTextFonts, setTextWasm, type TextFontsWasm, type TextWasm} from '../../../shared/design/text-engine';

// The browser's loader of the text engine (lane L3): crates/text-wasm and crates/text-fonts-wasm, the web builds of
// scripts/wasm-text-build.sh in src/design/wasm-text/ and src/design/wasm-fonts/. Lazy, like engine-wasm.ts for the
// main module: dynamic chunks the editor fetches only when the text module runs as `wasm` or `both`
// (shared/design/engine-switch.ts), so the default editor ships none of it. The globs keep the build working when
// the wasm was not built: the loader then throws, and the editor shows the error.

type Build<T> = {default: (input?: unknown) => Promise<unknown>} & T;
const textBuilds = import.meta.glob<Build<TextWasm>>('../wasm-text/morfa_text_wasm.js');
const fontBuilds = import.meta.glob<Build<TextFontsWasm>>('../wasm-fonts/morfa_text_fonts_wasm.js');

let loading: Promise<void> | null = null;
let loaded = false;

/** Loads and installs both text modules once (the fonts module is optional: without it the layout measures with
 *  the canvas); resolves at once when they are loaded already. */
export function loadTextWasm(): Promise<void> {
  if (loaded) return Promise.resolve();
  return (loading ??= (async () => {
    const load = textBuilds['../wasm-text/morfa_text_wasm.js'];
    if (!load) throw new Error('text-wasm: src/design/wasm-text/morfa_text_wasm.js is missing; run scripts/wasm-text-build.sh');
    const module = await load();
    await module.default();
    setTextWasm(module);
    const loadFonts = fontBuilds['../wasm-fonts/morfa_text_fonts_wasm.js'];
    if (loadFonts) {
      const fonts = await loadFonts();
      await fonts.default();
      setTextFonts(fonts);
    }
    loaded = true;
  })().finally(() => {
    loading = null;
  }));
}

/** Loads the text engine when the switch needs it; nothing otherwise. */
export const loadTextWasmIfNeeded = (): Promise<void> => (engineFor('text') !== 'ts' ? loadTextWasm() : Promise.resolve());
