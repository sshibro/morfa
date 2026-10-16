import {fontKinds} from '../../../shared/fonts';
import type {FontFamilyInfo} from '../engine/contracts';

// The rows of the font picker (FontPicker.tsx), worked out without React so node tests cover the
// grouping and the search: recently used first, then the catalogue by kind (sans serif, serif,
// display, handwriting, monospace), then the computer's own fonts.

export type LocalFontsState = 'unsupported' | 'idle' | 'loading' | 'loaded' | 'denied';

export type FontRow =
  | {type: 'heading'; label: string}
  | {type: 'font'; family: string; info: FontFamilyInfo; group: string}
  | {type: 'local'; state: LocalFontsState}
  | {type: 'empty'};

const OTHER = 'Other';

/** Case-insensitive match (Cyrillic ё counts as е) of every word of the query, anywhere in the name. */
export function matchesFont(family: string, query: string): boolean {
  const norm = (value: string) => value.toLowerCase().replace(/\u0451/g, '\u0435');
  const name = norm(family);
  return norm(query).split(/\s+/).filter(Boolean).every(word => name.includes(word));
}

export function fontRows(families: readonly FontFamilyInfo[], query: string, recent: readonly string[], local: LocalFontsState): FontRow[] {
  const q = query.trim();
  const shown = families.filter(info => !q || matchesFont(info.family, q));
  const byName = new Map(shown.map(info => [info.family, info]));
  const rows: FontRow[] = [];
  const recentRows = recent.map(name => byName.get(name)).filter((info): info is FontFamilyInfo => !!info);
  if (recentRows.length) {
    rows.push({type: 'heading', label: 'Recent'});
    for (const info of recentRows) rows.push({type: 'font', family: info.family, info, group: 'recent'});
  }
  const catalogue = shown.filter(info => info.source === 'catalog');
  const kinds = [...fontKinds.map(kind => ({id: kind.id as string, label: kind.label})), {id: '', label: OTHER}];
  for (const kind of kinds) {
    const list = catalogue.filter(info => (kind.id ? info.kind === kind.id : !fontKinds.some(each => each.id === info.kind)));
    if (!list.length) continue;
    rows.push({type: 'heading', label: kind.label});
    for (const info of list) rows.push({type: 'font', family: info.family, info, group: kind.id || 'other'});
  }
  const locals = shown.filter(info => info.source === 'local');
  if (locals.length || !q) {
    rows.push({type: 'heading', label: 'Local fonts'});
    for (const info of locals) rows.push({type: 'font', family: info.family, info, group: 'local'});
    if (local !== 'loaded' || !locals.length) rows.push({type: 'local', state: local});
  }
  if (!rows.some(row => row.type === 'font')) rows.unshift({type: 'empty'});
  return rows;
}

const RECENT_KEY = 'dz-recent-fonts';
const RECENT_MAX = 6;

/** Families picked lately, newest first (per browser; an unavailable storage gives none). */
export function readRecentFonts(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberRecentFont(family: string): void {
  try {
    const next = [family, ...readRecentFonts().filter(name => name !== family)].slice(0, RECENT_MAX);
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Private mode or blocked storage: the list just stays as it was.
  }
}

/** Weight names as fonts call their faces (Figma shows the same names). */
const WEIGHT_NAMES: Record<number, string> = {100: 'Thin', 200: 'Extra Light', 300: 'Light', 400: 'Regular', 500: 'Medium', 600: 'Semi Bold', 700: 'Bold', 800: 'Extra Bold', 900: 'Black', 1000: 'Extra Black'};

export function faceName(weight: number, italic: boolean): string {
  const base = WEIGHT_NAMES[weight] ?? String(weight);
  if (!italic) return base;
  return weight === 400 ? 'Italic' : `${base} Italic`;
}

/** The faces a family offers for the "Style" select: every weight, and each slanted where the
 *  family has italics. Values are `${weight}` or `${weight}i`. */
export function faceOptions(info: Pick<FontFamilyInfo, 'weights' | 'italic'> | undefined, current?: {weight: number; italic: boolean}): {value: string; label: string}[] {
  const weights = [...new Set(info?.weights.length ? info.weights : [400, 700])].sort((a, b) => a - b);
  const options: {value: string; label: string}[] = [];
  for (const weight of weights) {
    options.push({value: `${weight}`, label: faceName(weight, false)});
    if (info?.italic) options.push({value: `${weight}i`, label: faceName(weight, true)});
  }
  // A face the text uses that the family does not list (an imported file) stays visible.
  if (current && !options.some(option => option.value === `${current.weight}${current.italic ? 'i' : ''}`)) {
    options.push({value: `${current.weight}${current.italic ? 'i' : ''}`, label: faceName(current.weight, current.italic)});
  }
  return options;
}
