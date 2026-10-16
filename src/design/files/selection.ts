// The file browser's selection (docs/figma-parity-shell.md, "Several files selected"), as Figma's: a click selects one file,
// ⌘/Ctrl-click adds or removes one, Shift-click selects the run from the last clicked file, ⌘A selects every file shown.
// `anchor` is the file the next Shift-click runs from; `focus` is the last one clicked (the keyboard's place).

export type FileSelection = {readonly ids: readonly string[]; readonly anchor: string | null; readonly focus: string | null};

export type SelectHow = 'only' | 'toggle' | 'range';

export const NO_SELECTION: FileSelection = {ids: [], anchor: null, focus: null};

export const selectOnly = (id: string): FileSelection => ({ids: [id], anchor: id, focus: id});

/** One click with its modifiers, against the files in the order shown. */
export function selectFile(selection: FileSelection, id: string, how: SelectHow, order: readonly string[]): FileSelection {
  if (how === 'only') return selectOnly(id);
  if (how === 'toggle') {
    const ids = selection.ids.includes(id) ? selection.ids.filter(entry => entry !== id) : [...selection.ids, id];
    return {ids, anchor: id, focus: id};
  }
  const anchor = selection.anchor && order.includes(selection.anchor) ? selection.anchor : id;
  const from = order.indexOf(anchor);
  const to = order.indexOf(id);
  if (to < 0) return selection;
  const run = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  return {ids: run, anchor, focus: id};
}

export const selectAll = (order: readonly string[]): FileSelection =>
  order.length ? {ids: [...order], anchor: order[0], focus: order[order.length - 1]} : NO_SELECTION;

/** Keeps only the files still shown (after a filter, a search, a move or the trash). */
export function keepShown(selection: FileSelection, order: readonly string[]): FileSelection {
  const ids = selection.ids.filter(id => order.includes(id));
  if (ids.length === selection.ids.length) return selection;
  const keep = (id: string | null) => (id && order.includes(id) ? id : null);
  return ids.length ? {ids, anchor: keep(selection.anchor), focus: keep(selection.focus)} : NO_SELECTION;
}
