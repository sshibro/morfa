import type {RGB} from '../types';

// "Board": the colours a board offers (docs/board.md §Look). Named swatches, as FigJam's: the trays and the context toolbar show
// them in this order, and the AI and the templates pick by name. Values are document colours, the same in both editor themes.

export type BoardColor = {id: string; label: string; hex: string};

const swatch = (id: string, label: string, hex: string): BoardColor => ({id, label, hex});

/** Sticky notes: soft paper colours. Yellow is the default. */
export const STICKY_COLORS: readonly BoardColor[] = [
  swatch('yellow', 'Yellow', '#FFE380'),
  swatch('orange', 'Orange', '#FFC27A'),
  swatch('red', 'Red', '#FFA99F'),
  swatch('pink', 'Pink', '#FFB3DE'),
  swatch('violet', 'Violet', '#D6C2FF'),
  swatch('blue', 'Blue', '#A8DAFF'),
  swatch('teal', 'Teal', '#96E8DA'),
  swatch('green', 'Green', '#B6EFBF'),
  swatch('grey', 'Gray', '#E6E6E6'),
  swatch('white', 'White', '#FFFFFF'),
];

/** Shapes, stamps and connectors: the stronger colours, then the soft ones. */
export const SHAPE_COLORS: readonly BoardColor[] = [
  swatch('white', 'White', '#FFFFFF'),
  swatch('grey-light', 'Light gray', '#E6E6E6'),
  swatch('grey', 'Gray', '#B3B3B3'),
  swatch('black', 'Black', '#1E1E1E'),
  swatch('red', 'Red', '#F24822'),
  swatch('orange', 'Orange', '#FFA629'),
  swatch('yellow', 'Yellow', '#FFCD29'),
  swatch('green', 'Green', '#14AE5C'),
  swatch('teal', 'Teal', '#1BC4B0'),
  swatch('blue', 'Blue', '#0D99FF'),
  swatch('violet', 'Violet', '#9747FF'),
  swatch('pink', 'Pink', '#FF24BD'),
  swatch('red-light', 'Light red', '#FFC7C2'),
  swatch('orange-light', 'Light orange', '#FFE0C2'),
  swatch('yellow-light', 'Light yellow', '#FFF1C2'),
  swatch('green-light', 'Light green', '#CFF7D3'),
  swatch('teal-light', 'Light teal', '#C6F5EC'),
  swatch('blue-light', 'Light blue', '#BDE3FF'),
  swatch('violet-light', 'Light violet', '#E4CCFF'),
  swatch('pink-light', 'Light pink', '#FFC2EC'),
];

/** The marker tray's colours (the rainbow after them picks any colour). */
export const MARKER_COLORS: readonly BoardColor[] = [
  swatch('black', 'Black', '#1E1E1E'),
  swatch('red', 'Red', '#F24822'),
  swatch('orange', 'Orange', '#FFA629'),
  swatch('yellow', 'Yellow', '#FFCD29'),
  swatch('green', 'Green', '#14AE5C'),
  swatch('blue', 'Blue', '#0D99FF'),
  swatch('violet', 'Violet', '#9747FF'),
  swatch('white', 'White', '#FFFFFF'),
];

/** Highlighter colours: bright, multiplied under what they cross. */
export const HIGHLIGHTER_COLORS: readonly BoardColor[] = [
  swatch('yellow', 'Yellow', '#FFE14D'),
  swatch('green', 'Green', '#8CF0A0'),
  swatch('blue', 'Blue', '#8CD3FF'),
  swatch('pink', 'Pink', '#FF9EDB'),
  swatch('orange', 'Orange', '#FFB86B'),
  swatch('violet', 'Violet', '#C9A6FF'),
];

/** Washi tape: a colour with lighter stripes. */
export const WASHI_COLORS: readonly BoardColor[] = [
  swatch('violet', 'Violet', '#B48CFF'),
  swatch('pink', 'Pink', '#FF99CF'),
  swatch('yellow', 'Yellow', '#FFD64D'),
  swatch('green', 'Green', '#7FDC9A'),
  swatch('blue', 'Light blue', '#7CC4FF'),
  swatch('orange', 'Orange', '#FFAA66'),
];

/** Sections: a light fill and its chip's stronger colour. */
export type SectionColor = BoardColor & {chip: string};
export const SECTION_COLORS: readonly SectionColor[] = [
  {...swatch('grey', 'Gray', '#EAEAEA'), chip: '#757575'},
  {...swatch('red', 'Red', '#FFE8E5'), chip: '#E0442B'},
  {...swatch('orange', 'Orange', '#FFEEDB'), chip: '#E07A00'},
  {...swatch('yellow', 'Yellow', '#FFF6D6'), chip: '#B88A00'},
  {...swatch('green', 'Green', '#E3F7E6'), chip: '#178A47'},
  {...swatch('teal', 'Teal', '#DDF7F2'), chip: '#108A7C'},
  {...swatch('blue', 'Blue', '#E0F1FF'), chip: '#0A7CD1'},
  {...swatch('violet', 'Violet', '#EFE5FF'), chip: '#7B39E0'},
  {...swatch('pink', 'Pink', '#FFE5F5'), chip: '#D12A9B'},
];

/** Opacity of a board section's border: its chip colour, light (FigJam's board picture: a thin line a shade deeper than the fill). */
export const SECTION_BORDER_OPACITY = 0.35;

/** The chip colour of a section's fill, or null for a fill outside the palette. */
export const sectionChipOf = (fillHex: string): string | null =>
  SECTION_COLORS.find(color => color.hex.toUpperCase() === fillHex.toUpperCase())?.chip ?? null;

export function hexToRgb(value: string): RGB {
  const clean = value.replace('#', '');
  const n = parseInt(clean.length === 3 ? clean.split('').map(c => c + c).join('') : clean, 16);
  return {r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255};
}

export function rgbToHex(color: RGB): string {
  const part = (value: number) => Math.round(Math.max(0, Math.min(1, value)) * 255).toString(16).padStart(2, '0').toUpperCase();
  return '#' + part(color.r) + part(color.g) + part(color.b);
}

/** The swatch a colour is (exactly, by its hex), or null for a colour picked elsewhere. */
export function swatchOf(colors: readonly BoardColor[], color: RGB | null | undefined): BoardColor | null {
  if (!color) return null;
  const hex = rgbToHex(color);
  return colors.find(entry => entry.hex.toUpperCase() === hex) ?? null;
}

export const stickyColor = (id: string): BoardColor => STICKY_COLORS.find(entry => entry.id === id) ?? STICKY_COLORS[0];

/** Text on a fill: dark on light colours, white on dark ones. */
export function inkOn(fill: RGB): string {
  const luminance = 0.2126 * fill.r + 0.7152 * fill.g + 0.0722 * fill.b;
  return luminance < 0.5 ? '#FFFFFF' : '#1E1E1E';
}
