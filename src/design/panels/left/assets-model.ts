import type {DesignDocument, Paint, RGBA, Style, Variable, VariableCollection} from '../../../../shared/design/types';
import {cssColor} from '../../ui/ColorSwatch';
import {faceName} from '../../ui/font-rows';

// The pure part of the assets panel and the variables dialog: how styles preview and summarize,
// how variables group by "/" in their names, how colours read and write as hex.

/** A CSS background for a paint list: the top-most visible paint (solid or gradient); null for a picture. */
export function paintBackground(paints: readonly Paint[] | undefined): string | null {
  const paint = [...(paints ?? [])].reverse().find(each => each.visible !== false);
  if (!paint) return null;
  if (paint.type === 'SOLID') {
    const color = cssColor(paint.color, paint.opacity);
    return `linear-gradient(${color}, ${color})`;
  }
  if (paint.type === 'IMAGE') return null;
  const stops = paint.gradientStops.map(stop => `${cssColor(stop.color, paint.opacity)} ${Math.round(stop.position * 100)}%`).join(', ');
  if (paint.type === 'GRADIENT_LINEAR') {
    const [a, b] = paint.gradientHandlePositions;
    const angle = Math.round((Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI + 90);
    return `linear-gradient(${angle}deg, ${stops})`;
  }
  if (paint.type === 'GRADIENT_ANGULAR') return `conic-gradient(${stops})`;
  return `radial-gradient(${stops})`;
}

const decimal = (value: number) => String(Math.round(value * 100) / 100);

/** "40/48 · Inter Bold": what a text style sets, shown beside its name. */
export function textStyleSummary(style: Style): string {
  const text = style.text;
  if (!text) return '';
  const line = text.lineHeight.unit === 'AUTO' ? 'Auto' : text.lineHeight.unit === 'PIXELS' ? decimal(text.lineHeight.value) : `${decimal(text.lineHeight.value)}%`;
  // Face names as the "Style" select and the font picker print them ("Semi Bold", "Bold Italic").
  return `${decimal(text.fontSize)}/${line} · ${text.fontFamily} ${faceName(Math.round(text.fontWeight / 100) * 100, !!text.italic)}`;
}

const plural = (n: number, one: string, other: string) => (n === 1 ? one : other);

/** "2 collections · 9 variables". */
export function variablesSummary(doc: Pick<DesignDocument, 'variableCollections' | 'variables'>): string {
  const collections = Object.keys(doc.variableCollections).length;
  const variables = Object.keys(doc.variables).length;
  if (!collections) return 'No variables yet.';
  return `${collections} ${plural(collections, 'collection', 'collections')} · ${variables} ${plural(variables, 'variable', 'variables')}`;
}

/** Variables of a collection grouped by the folders in their names (ungrouped first), in the collection's order. */
export function variableGroups(doc: Pick<DesignDocument, 'variables'>, collection: VariableCollection): {path: string; variables: Variable[]}[] {
  const groups: {path: string; variables: Variable[]}[] = [];
  const byPath = new Map<string, Variable[]>();
  for (const id of collection.variableIds) {
    const variable = doc.variables[id];
    if (!variable) continue;
    const path = variable.name.split('/').map(part => part.trim()).filter(Boolean).slice(0, -1).join(' / ');
    let list = byPath.get(path);
    if (!list) {
      byPath.set(path, (list = []));
      groups.push({path, variables: list});
    }
    list.push(variable);
  }
  return groups.sort((a, b) => (a.path === '' ? -1 : b.path === '' ? 1 : 0));
}

/** The name without its folders. */
export const leafName = (name: string) => name.split('/').map(part => part.trim()).filter(Boolean).pop() ?? name;

const hex2 = (value: number) => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0').toUpperCase();
export const colorHex = (color: {r: number; g: number; b: number}) => hex2(color.r) + hex2(color.g) + hex2(color.b);

/** "FF8800", "#f80", "FF880080" → a colour (with alpha for 8 digits); null when it is not a colour. */
export function parseHex(text: string): RGBA | null {
  let hex = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3}$/i.test(hex)) hex = [...hex].map(char => char + char).join('');
  if (!/^([0-9a-f]{6}|[0-9a-f]{8})$/i.test(hex)) return null;
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return {r: channel(0), g: channel(2), b: channel(4), a: hex.length === 8 ? channel(6) : 1};
}
