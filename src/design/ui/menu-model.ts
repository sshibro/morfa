import type {ReactNode} from 'react';

// Menus are data: the main menu, context menus, dropdowns and the toolbar's flyouts all render a
// MenuItem[] through one component (Menu.tsx). Keyboard movement and type-ahead are pure functions
// here so node tests cover them.

export type MenuAction = {
  type?: 'item';
  id: string;
  label: string;
  icon?: ReactNode;
  /** A shortcut string (shortcuts.ts), printed in the right-hand column. */
  shortcut?: string;
  disabled?: boolean;
  /** Present (true or false) on checkable items: the menu keeps a column for the check mark. */
  checked?: boolean;
  /** Radio-like choice (a dropdown's options): announced as menuitemradio. */
  radio?: boolean;
  danger?: boolean;
  /** A hint shown under the label in the secondary colour. */
  description?: string;
  onSelect: () => void;
};
export type MenuSubmenu = {type: 'submenu'; id: string; label: string; icon?: ReactNode; disabled?: boolean; items: MenuItem[]};
export type MenuSeparator = {type: 'separator'};
export type MenuLabel = {type: 'label'; label: string};
export type MenuItem = MenuAction | MenuSubmenu | MenuSeparator | MenuLabel;

export const isInteractive = (item: MenuItem | undefined): item is MenuAction | MenuSubmenu =>
  !!item && (item.type === undefined || item.type === 'item' || item.type === 'submenu') && !item.disabled;

/** The next interactive index from `from` in direction `step`, wrapping around; -1 if there is none. */
export function moveIndex(items: readonly MenuItem[], from: number, step: 1 | -1): number {
  const count = items.length;
  if (!count) return -1;
  for (let offset = 1; offset <= count; offset++) {
    const index = (((from + step * offset) % count) + count) % count;
    if (isInteractive(items[index])) return index;
  }
  return -1;
}

export const firstIndex = (items: readonly MenuItem[]) => moveIndex(items, -1, 1);
export const lastIndex = (items: readonly MenuItem[]) => moveIndex(items, items.length, -1);

/**
 * Type-ahead: the next interactive item after `from` whose label starts with `query`
 * (case-insensitive, ё folded to е), wrapping; a query of one repeated letter cycles through
 * items starting with that letter, as native menus do.
 */
export function typeaheadIndex(items: readonly MenuItem[], from: number, query: string): number {
  const fold = (text: string) => text.toLocaleLowerCase('en').replace(/\u0451/g, '\u0435');
  let needle = fold(query);
  if (!needle) return -1;
  const repeated = needle.length > 1 && [...needle].every(char => char === needle[0]);
  if (repeated) needle = needle[0];
  const count = items.length;
  // A fresh single-letter search starts after the current item; a longer query may match it.
  const start = needle.length === 1 ? 1 : 0;
  for (let offset = start; offset < count + start; offset++) {
    const index = (((from + offset) % count) + count) % count;
    const item = items[index];
    if (isInteractive(item) && fold(item.label).startsWith(needle)) return index;
  }
  return -1;
}

/** Drops leading, trailing and doubled separators (items hidden by a registry leave gaps). */
export function tidySeparators(items: MenuItem[]): MenuItem[] {
  const result: MenuItem[] = [];
  for (const item of items) {
    if (item.type === 'separator' && (!result.length || result[result.length - 1].type === 'separator')) continue;
    result.push(item);
  }
  while (result.length && result[result.length - 1].type === 'separator') result.pop();
  return result;
}
