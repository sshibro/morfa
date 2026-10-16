import {fontFamilies, type FontFamily} from '../fonts';
import type {ExportWasm} from './export-wasm';

// The catalogue fonts as faces (docs/design-tool.md §Export): the files of a family (shared/fonts.ts) with the CSS
// descriptors the editor registers them under (src/design/engine/fonts.ts), for the vector PDF (the server's own
// files, public/fonts) and for the export module's outline text and embedded fonts (lane L5, crates/export-wasm).

/** The editor's two subsets of every family (src/design/engine/fonts.ts, shared/fonts.ts). */
export const FONT_SUBSETS = [
  ['cyrillic', 'U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116'],
  ['latin', 'U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+2074, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD'],
] as const;

let byName: Map<string, FontFamily> | null = null;
/** A catalogue family by the name documents use ("Inter"), or undefined (a font from the designer's computer). */
export function catalogueFamily(name: string): FontFamily | undefined {
  if (!byName) {
    byName = new Map();
    for (const font of Object.values(fontFamilies)) if (!byName.has(font.family)) byName.set(font.family, font);
  }
  return byName.get(name);
}

export type CatalogueFace = {file: string; weight: string; style: 'normal' | 'italic'; unicodeRange?: string};

/** The files of a family as @font-face sources: each with its weight (a range for a variable face), style and range. */
export function familyFaces(font: FontFamily): CatalogueFace[] {
  if (font.files) return font.files.map(file => ({file: `${font.dir}/${file.name}`, weight: String(file.weight), style: file.style === 'italic' ? 'italic' : 'normal', unicodeRange: file.unicodeRange}));
  if (font.variable) return FONT_SUBSETS.map(([subset, unicodeRange]) => ({file: `${font.dir}/${font.dir}-${subset}-wght-normal.woff2`, weight: `${font.weights[0]} ${font.weights[1]}`, style: 'normal' as const, unicodeRange}));
  return font.weights.flatMap(weight => FONT_SUBSETS.map(([subset, unicodeRange]) => ({file: `${font.dir}/${font.dir}-${subset}-${weight}-normal.woff2`, weight: String(weight), style: 'normal' as const, unicodeRange})));
}

const registered = new WeakMap<ExportWasm, Set<string>>();

/** Registers the catalogue faces of `families` with the export module, reading each file with `read` (a path below
 *  the fonts root → its bytes, or null). Families outside the catalogue are returned as missing. */
export function registerExportFonts(module: ExportWasm, families: Iterable<string>, read: (file: string) => Uint8Array | null): {missing: string[]} {
  let done = registered.get(module);
  if (!done) registered.set(module, (done = new Set()));
  const missing: string[] = [];
  for (const name of families) {
    if (done.has(name)) continue;
    const font = catalogueFamily(name);
    if (!font) {
      missing.push(name);
      continue;
    }
    for (const face of familyFaces(font)) {
      const bytes = read(face.file);
      if (!bytes) continue;
      const [low, high = low] = face.weight.split(' ').map(Number);
      module.addFace(font.family, low, high, face.style === 'italic', face.unicodeRange ?? '', bytes);
    }
    done.add(name);
  }
  return {missing};
}
