// The font families the editing tools offer: the catalogue's (shared/fonts.ts), each once.
import {fontFamilies} from '../../shared/fonts';

let families: string[] | null = null;
/** The families of the font catalogue the design tool offers, each once: the only ones the editing tools may use. */
export function catalogueFontFamilies(): string[] {
  families ??= [...new Set(Object.values(fontFamilies).map(font => font.family))].sort((a, b) => a.localeCompare(b));
  return families;
}

/** The catalogue's spelling of a family, or null. */
let spellings: Map<string, string> | null = null;
export const fontOf = (family: string): string | null => {
  spellings ??= new Map(catalogueFontFamilies().map(name => [name.toLowerCase(), name]));
  return spellings.get(family.trim().toLowerCase()) ?? null;
};
