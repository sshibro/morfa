import type {TextProps} from '../../../../shared/design/types';
import {deleteRange, insertText, setListType, type RunOverride} from '../../../../shared/design/text-edit';
import {moveCaret, type Affinity, type CaretDirection, type TextLayout} from '../../../../shared/design/text-layout';
import {nextGraphemeBoundary, paragraphAt, paragraphRanges, prevGraphemeBoundary, wordAt} from '../../../../shared/design/text-segment';
import {DESIGN_FIELD_LIMITS} from '../../../../shared/design/document-limits';

// The pure part of the in-canvas text editor: which key does what, where the caret and the
// selection go, what an edit does to the text and its runs, how a composition (IME) previews, and
// how typing bursts become undo steps. No DOM, no store: the session (session.ts) feeds it events
// and writes what it returns, and node tests drive it with a fake measurer.

/** The editor's selection in UTF-16 offsets of `characters`. `focus` is where the caret blinks;
 *  `goalX` keeps the column of ↑/↓ runs; `affinity` says which line an offset at a soft wrap is on. */
export type TextSelection = {anchor: number; focus: number; affinity: Affinity; goalX?: number};

export const caretAt = (offset: number, affinity: Affinity = 'downstream'): TextSelection => ({anchor: offset, focus: offset, affinity});
export const isCollapsed = (selection: TextSelection) => selection.anchor === selection.focus;
export const selectionRange = (selection: TextSelection) => ({start: Math.min(selection.anchor, selection.focus), end: Math.max(selection.anchor, selection.focus)});

/** Offsets clamped to a text of `length` (after undo or an edit made elsewhere). */
export function clampSelection(selection: TextSelection, length: number): TextSelection {
  const anchor = Math.max(0, Math.min(length, selection.anchor)), focus = Math.max(0, Math.min(length, selection.focus));
  return anchor === selection.anchor && focus === selection.focus ? selection : {anchor, focus, affinity: 'downstream'};
}

// ── Keys ───────────────────────────────────────────────────────────────────────────────────────

export type EditorKey = {key: string; code: string; shiftKey: boolean; altKey: boolean; metaKey: boolean; ctrlKey: boolean};

export type MoveTarget = CaretDirection | 'paragraphStart' | 'paragraphEnd';
export type DeleteUnit = 'char' | 'word' | 'line';

export type EditorAction =
  | {type: 'move'; to: MoveTarget; extend: boolean}
  | {type: 'delete'; direction: 'backward' | 'forward'; unit: DeleteUnit}
  | {type: 'insert'; text: string}
  | {type: 'selectAll'}
  | {type: 'undo'}
  | {type: 'redo'}
  | {type: 'exit'};

/** A line break inside a paragraph (⇧Enter): the layout breaks the line, lists and paragraph
 *  spacing do not see a new paragraph. */
export const LINE_SEPARATOR = '\u2028';

/** What a key press does in the editor, following each platform's text conventions: on macOS ⌥
 *  moves by words and ⌘ by lines, elsewhere Ctrl moves by words and Home/End by lines. Keys the
 *  editor does not own (⌘B, ⌘+…) return null and go on to the command registry. */
export function actionForKey(event: EditorKey, mac: boolean): EditorAction | null {
  const {key, code, shiftKey: shift, altKey: alt, metaKey: meta, ctrlKey: ctrl} = event;
  const mod = mac ? meta : ctrl;
  const word = mac ? alt && !meta && !ctrl : ctrl && !alt && !meta;
  const plain = !alt && !meta && !ctrl;
  const named = code || key;

  if (key === 'Escape' || code === 'Escape') return plain ? {type: 'exit'} : null;
  if (mod && !alt && (code === 'KeyZ' || (!code && key.toLowerCase() === 'z'))) return {type: shift ? 'redo' : 'undo'};
  if (!mac && ctrl && !alt && !shift && code === 'KeyY') return {type: 'redo'};
  if (mod && !alt && !shift && code === 'KeyA') return {type: 'selectAll'};
  // Emacs keys every macOS text field honours.
  if (mac && ctrl && !meta && !alt) {
    if (code === 'KeyA') return {type: 'move', to: 'paragraphStart', extend: shift};
    if (code === 'KeyE') return {type: 'move', to: 'paragraphEnd', extend: shift};
  }

  switch (named) {
    case 'ArrowLeft':
    case 'ArrowRight': {
      const right = named === 'ArrowRight';
      if (mac && meta && !alt && !ctrl) return {type: 'move', to: right ? 'lineEnd' : 'lineStart', extend: shift};
      if (word) return {type: 'move', to: right ? 'wordRight' : 'wordLeft', extend: shift};
      if (!plain) return null;
      return {type: 'move', to: right ? 'right' : 'left', extend: shift};
    }
    case 'ArrowUp':
    case 'ArrowDown': {
      const down = named === 'ArrowDown';
      if (mac && meta && !alt && !ctrl) return {type: 'move', to: down ? 'docEnd' : 'docStart', extend: shift};
      if (word) return {type: 'move', to: down ? 'paragraphEnd' : 'paragraphStart', extend: shift};
      if (!plain) return null;
      return {type: 'move', to: down ? 'down' : 'up', extend: shift};
    }
    case 'Home':
    case 'End': {
      const end = named === 'End';
      if (mod && !alt) return {type: 'move', to: end ? 'docEnd' : 'docStart', extend: shift};
      if (!plain) return null;
      return {type: 'move', to: end ? 'lineEnd' : 'lineStart', extend: shift};
    }
    case 'PageUp':
    case 'PageDown':
      return plain ? {type: 'move', to: named === 'PageDown' ? 'docEnd' : 'docStart', extend: shift} : null;
    case 'Backspace':
    case 'Delete': {
      const direction = named === 'Backspace' ? 'backward' : 'forward';
      if (mac && meta && !alt && !ctrl) return {type: 'delete', direction, unit: 'line'};
      if (word) return {type: 'delete', direction, unit: 'word'};
      if (alt || meta || ctrl) return null;
      return {type: 'delete', direction, unit: 'char'};
    }
    case 'Enter':
    case 'NumpadEnter':
      if (alt || meta || ctrl) return null;
      return {type: 'insert', text: shift ? LINE_SEPARATOR : '\n'};
    case 'Tab':
      return plain && !shift ? {type: 'insert', text: '\t'} : null;
  }
  return null;
}

// ── Caret movement ─────────────────────────────────────────────────────────────────────────────

/** Where `to` takes the selection. Without `extend`, ←/→ over a selection collapse it to its
 *  start or end and ↑/↓ start from that edge, as text fields do. */
export function moveSelection(characters: string, layout: TextLayout, selection: TextSelection, to: MoveTarget, extend: boolean): TextSelection {
  const {start, end} = selectionRange(selection);
  if (!extend && start !== end) {
    if (to === 'left') return caretAt(start);
    if (to === 'right') return caretAt(end);
  }
  const from = extend || start === end ? selection.focus : to === 'up' || to === 'wordLeft' || to === 'lineStart' || to === 'paragraphStart' || to === 'docStart' ? start : end;
  let offset: number, affinity: Affinity = 'downstream', goalX: number | undefined;
  if (to === 'paragraphStart' || to === 'paragraphEnd') {
    const paragraph = paragraphAt(characters, from);
    // Pressed again at the edge, it goes on to the next paragraph's edge (macOS ⌥↑/⌥↓).
    if (to === 'paragraphStart') offset = from === paragraph.start && from > 0 ? paragraphAt(characters, from - 1).start : paragraph.start;
    else offset = from === paragraph.end && from < characters.length ? paragraphAt(characters, from + 1).end : paragraph.end;
  } else {
    const keepGoal = to === 'up' || to === 'down';
    const moved = moveCaret(layout, characters, from, to, keepGoal ? selection.goalX : undefined, selection.affinity);
    offset = moved.offset;
    affinity = moved.affinity;
    goalX = moved.goalX;
  }
  return extend ? {anchor: selection.anchor, focus: offset, affinity, goalX} : {anchor: offset, focus: offset, affinity, goalX};
}

/** The word around `offset` (double click), or the whitespace run the caret stands in. */
export function wordSelection(characters: string, offset: number): TextSelection {
  const word = wordAt(characters, offset);
  return {anchor: word.start, focus: word.end, affinity: 'downstream'};
}

/** The paragraph around `offset` with its line break (triple click), as browsers select it. */
export function paragraphSelection(characters: string, offset: number): TextSelection {
  const paragraph = paragraphAt(characters, offset);
  const end = paragraph.end < characters.length ? paragraph.end + 1 : paragraph.end;
  return {anchor: paragraph.start, focus: end, affinity: 'downstream'};
}

/** A drag that began with a double or triple click grows by whole words or paragraphs: the
 *  selection spans the unit under the press and the unit under the pointer. */
export function extendByUnit(characters: string, origin: TextSelection, offset: number, unit: 'char' | 'word' | 'paragraph'): TextSelection {
  if (unit === 'char') return {anchor: origin.anchor, focus: offset, affinity: 'downstream'};
  const here = unit === 'word' ? wordSelection(characters, offset) : paragraphSelection(characters, offset);
  const a = selectionRange(origin), b = selectionRange(here);
  return offset < a.start ? {anchor: a.end, focus: b.start, affinity: 'downstream'} : {anchor: a.start, focus: Math.max(a.end, b.end), affinity: 'downstream'};
}

// ── Edits ──────────────────────────────────────────────────────────────────────────────────────

/** What kind of change an edit is, for grouping undo steps. */
export type EditKind = 'type' | 'delete' | 'other';
export type EditResult = {text: TextProps; selection: TextSelection; kind: EditKind};

/** Text a paste or a drop may insert: line endings become "\n", control characters other than tab
 *  and line breaks go. */
export function cleanPlainText(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
}

/** Characters a text node may hold (shared/design/document-limits.ts). */
export const MAX_CHARACTERS = DESIGN_FIELD_LIMITS.characters;

const listTypeAt = (text: TextProps, offset: number) => text.listTypes?.[paragraphAt(text.characters, offset).index] ?? 'NONE';

/** Types `inserted` over the selection. The new characters take `pending` (the caret style a ⌘B
 *  with nothing selected left) or else the style the text module picks for that spot. Enter in an
 *  empty list item ends the list instead of adding an item, as every editor with lists does.
 *  Null when the text would grow past the document's limit. */
export function insertAt(text: TextProps, selection: TextSelection, inserted: string, pending?: RunOverride | null): EditResult | null {
  const {start, end} = selectionRange(selection);
  if (inserted === '\n' && start === end) {
    const paragraph = paragraphAt(text.characters, start);
    if (paragraph.start === paragraph.end && listTypeAt(text, start) !== 'NONE') {
      return {text: setListType(text, start, start, 'NONE'), selection: caretAt(start), kind: 'other'};
    }
  }
  if (text.characters.length - (end - start) + inserted.length > MAX_CHARACTERS) return null;
  const next = insertText(text, start, end, inserted, pending === undefined ? undefined : pending);
  return {text: next, selection: caretAt(start + inserted.length), kind: 'type'};
}

/** Backspace and Delete. Over a selection they remove it; at a caret they remove a grapheme, a
 *  word or up to the line's edge. Backspace at the start of a list item first takes its marker off. */
export function deleteAt(text: TextProps, layout: TextLayout, selection: TextSelection, direction: 'backward' | 'forward', unit: DeleteUnit): EditResult | null {
  const chars = text.characters;
  let {start, end} = selectionRange(selection);
  if (start === end) {
    const at = start;
    if (direction === 'backward') {
      const paragraph = paragraphAt(chars, at);
      if (unit === 'char' && at === paragraph.start && listTypeAt(text, at) !== 'NONE') {
        return {text: setListType(text, at, at, 'NONE'), selection: caretAt(at), kind: 'other'};
      }
      // ⌘⌫ removes up to the line's start; at the start it joins the line to the one above.
      const lineStart = unit === 'line' ? moveCaret(layout, chars, at, 'lineStart', undefined, selection.affinity).offset : at;
      start = unit === 'char' || (unit === 'line' && lineStart === at) ? prevGraphemeBoundary(chars, at)
        : unit === 'word' ? moveCaret(layout, chars, at, 'wordLeft').offset : lineStart;
    } else {
      const lineEnd = unit === 'line' ? moveCaret(layout, chars, at, 'lineEnd', undefined, selection.affinity).offset : at;
      end = unit === 'char' || (unit === 'line' && lineEnd === at) ? nextGraphemeBoundary(chars, at)
        : unit === 'word' ? moveCaret(layout, chars, at, 'wordRight').offset : lineEnd;
    }
  }
  if (start === end) return null;
  return {text: deleteRange(text, start, end), selection: caretAt(start), kind: 'delete'};
}

/** Where the caret goes after the text changed under the editor (undo, redo): to the end of what
 *  differs, found from the common prefix and suffix of the old and new characters. */
export function selectionAfterChange(before: string, after: string, fallback: TextSelection): TextSelection {
  if (before === after) return clampSelection(fallback, after.length);
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  return caretAt(Math.max(prefix, after.length - suffix));
}

/** Where the selection goes when someone else edited the text (co-editing): it stays on the same characters. Offsets
 *  before the edit stay, offsets after it shift by its length change, offsets inside it go to its end. */
export function selectionThroughEdit(before: string, after: string, selection: TextSelection): TextSelection {
  if (before === after) return selection;
  let prefix = 0;
  const max = Math.min(before.length, after.length);
  while (prefix < max && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)) suffix++;
  const end = before.length - suffix, delta = after.length - before.length;
  const map = (offset: number) => (offset <= prefix ? offset : offset >= end ? offset + delta : after.length - suffix);
  return clampSelection({...selection, anchor: map(selection.anchor), focus: map(selection.focus), goalX: undefined}, after.length);
}

// ── Composition (IME) ──────────────────────────────────────────────────────────────────────────

/** A composition in progress: the text before it began (the selection already removed) and where
 *  the composed characters go. While it runs the editor shows `base` with the draft inserted. */
export type Composition = {base: TextProps; start: number};

/** A composition starts: a selection it replaces goes first. */
export function beginComposition(text: TextProps, selection: TextSelection): {composition: Composition; text: TextProps; selection: TextSelection} {
  const {start, end} = selectionRange(selection);
  const base = start === end ? text : deleteRange(text, start, end);
  return {composition: {base, start}, text: base, selection: caretAt(start)};
}

/** The text with the draft `data` of a composition, the range to underline and the caret after it. */
export function composeText(composition: Composition, data: string, pending?: RunOverride | null): {text: TextProps; range: {start: number; end: number}; selection: TextSelection} {
  const {base, start} = composition;
  const room = Math.max(0, MAX_CHARACTERS - base.characters.length);
  const draft = data.length > room ? data.slice(0, room) : data;
  const text = draft ? insertText(base, start, start, draft, pending === undefined ? undefined : pending) : base;
  return {text, range: {start, end: start + draft.length}, selection: caretAt(start + draft.length)};
}

// ── Undo steps ─────────────────────────────────────────────────────────────────────────────────

/** Typing bursts, numbered: edits of one burst share an undo step (the store also splits a step
 *  after a second of quiet). A burst ends when the kind of edit changes, when the caret is moved,
 *  after anything but typing or deleting, and at word boundaries: "Hello world" undoes as "world",
 *  then "Hello ". */
export type Burst = {serial: number; kind: EditKind; afterSpace: boolean};

const WHITESPACE = /[\s\u2028]/;

export function nextBurst(previous: Burst | null, kind: EditKind, inserted = '', lastSerial = previous?.serial ?? 0): Burst {
  const lastIsSpace = inserted.length > 0 && WHITESPACE.test(inserted[inserted.length - 1]);
  const firstIsSpace = inserted.length > 0 && WHITESPACE.test(inserted[0]);
  const continues = !!previous && kind !== 'other' && previous.kind === kind && !(kind === 'type' && previous.afterSpace && !firstIsSpace);
  return {serial: continues ? previous!.serial : Math.max(lastSerial, previous?.serial ?? 0) + 1, kind, afterSpace: kind === 'type' && lastIsSpace};
}

/** Paragraph indexes the selection touches (list commands and the panel's list control). */
export function paragraphsOf(characters: string, start: number, end: number): number[] {
  const first = paragraphAt(characters, start).index;
  let last = paragraphAt(characters, end).index;
  if (end > start && characters[end - 1] === '\n') last = Math.max(first, last - 1);
  const out: number[] = [];
  for (let i = first; i <= last; i++) out.push(i);
  return out;
}

export const paragraphCount = (characters: string) => paragraphRanges(characters).length;
