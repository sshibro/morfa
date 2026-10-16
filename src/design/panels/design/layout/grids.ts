import type {DesignDocument, LayoutGrid, RGB, RGBA} from '../../../../../shared/design/types';
import {defaultStyleName} from '../../../../../shared/design/styles';
import {nextNumberedName} from '../../../../../shared/design/tree';

// Layout grid values for "Layout grid": Figma's defaults (a 10 px grid in 10 % red; 5 stretched
// columns or rows with a 20 px gutter), the row summaries, switching kinds, and hex colours. Pure.

export const GRID_RED: RGBA = {r: 1, g: 0, b: 0, a: 0.1};
/** Columns and rows are tinted 10 % red as well, like Figma. */
export const defaultGrid = (): LayoutGrid => ({pattern: 'GRID', sectionSize: 10, visible: true, color: {...GRID_RED}});

export const GRID_ALIGNMENT_LABELS = {
  COLUMNS: {STRETCH: 'Stretch', MIN: 'Left', CENTER: 'Center', MAX: 'Right'},
  ROWS: {STRETCH: 'Stretch', MIN: 'Top', CENTER: 'Center', MAX: 'Bottom'},
} as const;

/** "Grid (10 px)", "Columns (12)", "Rows (Auto)". */
export function gridSummary(grid: LayoutGrid): string {
  if (grid.pattern === 'GRID') return `Grid (${formatPx(grid.sectionSize)} px)`;
  const count = grid.count > 0 && Number.isFinite(grid.count) ? String(grid.count) : 'Auto';
  return `${grid.pattern === 'COLUMNS' ? 'Columns' : 'Rows'} (${count})`;
}

const formatPx = (value: number) => String(Math.round(value * 100) / 100);

/** The grid as another kind, keeping its colour and visibility (and the column values when
 *  switching between columns and rows). */
export function gridWithPattern(grid: LayoutGrid, pattern: LayoutGrid['pattern']): LayoutGrid {
  if (grid.pattern === pattern) return grid;
  const {visible, color} = grid;
  if (pattern === 'GRID') return {pattern, sectionSize: 10, visible, color};
  if (grid.pattern !== 'GRID') return {...grid, pattern};
  return {pattern, alignment: 'STRETCH', count: 5, gutterSize: 20, offset: 0, sectionSize: 60, visible, color};
}

/** "FF0000" (no #, upper case). */
export function hexOf(color: RGB): string {
  return [color.r, color.g, color.b].map(value => Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** Reads "#F00", "ff0000", "F00F" (the alpha is ignored here; the opacity field has it). */
export function parseHex(text: string): RGB | null {
  let hex = text.trim().replace(/^#/, '');
  if (/^[0-9a-f]{3,4}$/i.test(hex)) hex = hex.slice(0, 3).split('').map(char => char + char).join('');
  if (/^[0-9a-f]{8}$/i.test(hex)) hex = hex.slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  const channel = (at: number) => parseInt(hex.slice(at, at + 2), 16) / 255;
  return {r: channel(0), g: channel(2), b: channel(4)};
}

/** "Grid 1", "Grid 2"... among the file's grid styles. */
export function nextGridStyleName(doc: DesignDocument): string {
  return nextNumberedName(defaultStyleName('GRID'), Object.values(doc.styles).filter(style => style.type === 'GRID').map(style => style.name));
}
