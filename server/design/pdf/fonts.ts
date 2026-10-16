import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {allFontFiles} from '../../../shared/fonts';
import {catalogueFamily, familyFaces} from '../../../shared/design/export-fonts';

export {catalogueFamily, familyFaces};

// Fonts of the vector PDF (docs/design-tool.md §Export): the catalogue families the editor draws with
// (shared/fonts.ts), served to the renderer from the server's own files (public/fonts, the same files
// /fonts serves) and nothing else. The faces are declared under the families' own names, which hide
// any installed font of the same name; Chromium loads only the faces the text uses and embeds subsets
// of them (a static face as a TrueType font, a variable family's instance as a Type 3 font of outlines,
// with its Unicode map either way, so the text stays selectable and searchable).

let files: Set<string> | null = null;
/** Paths below the fonts root ("inter/inter-latin-wght-normal.woff2") the renderer may load. */
export const isCatalogueFontFile = (relative: string) => (files ??= new Set(allFontFiles())).has(relative);

const quote = (value: string) => `"${value.replace(/["\\]/g, '\\$&').replace(/[\u0000-\u001f\u007f]/g, '')}"`;

/** @font-face rules for the catalogue families among `names`, loading from `base`. `font-display: block`: the
 *  PDF waits for its faces (the renderer also waits for document.fonts) instead of printing a fallback. */
export function fontFaceCss(names: Iterable<string>, base: string): {css: string; missing: string[]} {
  const rules: string[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const font = catalogueFamily(name);
    if (!font) {
      if (!missing.includes(name)) missing.push(name);
      continue;
    }
    if (seen.has(font.family)) continue;
    seen.add(font.family);
    for (const face of familyFaces(font)) {
      if (!isCatalogueFontFile(face.file)) continue;
      rules.push(`@font-face{font-family:${quote(font.family)};font-style:${face.style};font-weight:${face.weight};font-display:block;src:url(${quote(`${base}/${face.file}`)}) format("woff2")${face.unicodeRange ? `;unicode-range:${face.unicodeRange}` : ''}}`);
    }
  }
  return {css: rules.join('\n'), missing};
}

const FONT_ROOT = path.resolve('public/fonts');

/** A catalogue font file's bytes, or null for anything else. */
export async function readCatalogueFont(relative: string): Promise<Buffer | null> {
  if (!isCatalogueFontFile(relative)) return null;
  const file = path.resolve(FONT_ROOT, relative);
  if (!file.startsWith(FONT_ROOT + path.sep)) return null;
  return fs.readFile(file).catch(() => null);
}

/** `readCatalogueFont`, synchronously (the export module registers faces in one go). */
export function readCatalogueFontSync(relative: string): Buffer | null {
  if (!isCatalogueFontFile(relative)) return null;
  const file = path.resolve(FONT_ROOT, relative);
  if (!file.startsWith(FONT_ROOT + path.sep)) return null;
  try {
    return readFileSync(file);
  } catch {
    return null;
  }
}
