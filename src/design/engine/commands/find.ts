import type {DesignDocument, NodeId, SceneNode, TextProps} from '../../../../shared/design/types';
import {isOverridden, propertyForField, setInstanceProperty} from '../../../../shared/design/components';
import {TYPE_NAMES} from '../../../../shared/design/defaults';
import {insertText} from '../../../../shared/design/text-edit';
import {DESIGN_FIELD_LIMITS} from '../../../../shared/design/document-limits';
import {isLetterOrDigit} from '../../../../shared/design/text-segment';
import type {Transaction} from '../../../../shared/design/transaction';
import type {DesignStore} from '../store';
import {autoName} from '../text-editor/session';
import {userUpdate} from '../user-edit';
import {applyDocument} from './components';
import {registerCommand, type Command} from './registry';

// "Find and replace" (⌘F): text in text layers and layer names, on the current page or every page.
// The search walks the tree in the layers panel's order (pages in order, the top-most layer first,
// parents before children), compares strings folded once per node object (an unchanged node keeps
// its folded copy between keystrokes, since documents are immutable), and runs in slices so a 20 000
// layer file never blocks typing. Replacing goes through the hand-edit door (`userUpdate`: styles of
// the range stay, copies inside instances record an override), and a text a component property drives
// changes that property on its instance (`setInstanceProperty`), as typing into it does.

export type FindScope = 'page' | 'all';
export type FindOptions = {
  caseSensitive: boolean;
  wholeWord: boolean;
  scope: FindScope;
  /** Look in what text layers say. */
  text: boolean;
  /** Look in layer names (a text layer's name only when its words do not match). */
  names: boolean;
};
export const DEFAULT_FIND_OPTIONS: FindOptions = {caseSensitive: false, wholeWord: false, scope: 'page', text: true, names: true};

/** One occurrence: a range of a text layer's characters, or a layer's name (the whole name). */
export type FindMatch = {id: NodeId; pageId: NodeId; field: 'text' | 'name'; start: number; end: number};

/** More matches than this are counted as "10 000+" and not kept (replace-all still finds every one). */
export const MAX_MATCHES = 10_000;

// ── Comparing ────────────────────────────────────────────────────────────────────────────────────

const NBSP = /[   ]/g;
const HAS_NBSP = /[   ]/;

/** The form strings are compared in, with every offset kept: non-breaking spaces read as spaces;
 *  without case sensitivity letters are lowercased and "ё" reads as "е" (as Russian search does). */
export function foldForSearch(text: string, caseSensitive: boolean): string {
  let out = HAS_NBSP.test(text) ? text.replace(NBSP, ' ') : text;
  if (caseSensitive) return out;
  const lower = out.toLowerCase();
  if (lower.length === out.length) out = lower;
  else {
    // A few letters lowercase into two code units (İ): fold one by one so offsets stay.
    let kept = '';
    for (const char of out) {
      const folded = char.toLowerCase();
      kept += folded.length === char.length ? folded : char;
    }
    out = kept;
  }
  return out.includes('ё') ? out.replace(/ё/g, 'е') : out;
}

const codeBefore = (text: string, i: number) => (i <= 0 ? -1 : i >= 2 && /[\udc00-\udfff]/.test(text[i - 1]) && /[\ud800-\udbff]/.test(text[i - 2]) ? text.codePointAt(i - 2)! : text.charCodeAt(i - 1));
const codeAt = (text: string, i: number) => (i >= text.length ? -1 : text.codePointAt(i)!);
const isWordChar = (cp: number) => cp === 0x5f || isLetterOrDigit(cp);

/** Start offsets of `needle` in `haystack` (both folded), left to right, not overlapping. */
export function occurrences(haystack: string, needle: string, wholeWord: boolean, limit = Infinity): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let at = haystack.indexOf(needle); at >= 0 && out.length < limit; ) {
    const end = at + needle.length;
    if (wholeWord && (isWordChar(codeBefore(haystack, at)) || isWordChar(codeAt(haystack, end)))) {
      at = haystack.indexOf(needle, at + 1);
      continue;
    }
    out.push(at);
    at = haystack.indexOf(needle, end);
  }
  return out;
}

// Folded copies keyed by the objects they come from: a node for its name, a TextProps for its words.
const foldedNames = new WeakMap<SceneNode, string>();
const foldedTexts = new WeakMap<TextProps, string>();

function foldedName(node: SceneNode, caseSensitive: boolean): string {
  if (caseSensitive) return foldForSearch(node.name, true);
  let folded = foldedNames.get(node);
  if (folded === undefined) foldedNames.set(node, (folded = foldForSearch(node.name, false)));
  return folded;
}

function foldedText(text: TextProps, caseSensitive: boolean): string {
  if (caseSensitive) return foldForSearch(text.characters, true);
  let folded = foldedTexts.get(text);
  if (folded === undefined) foldedTexts.set(text, (folded = foldForSearch(text.characters, false)));
  return folded;
}

/** The pages a search covers, in panel order. */
export const scopePages = (doc: DesignDocument, pageId: NodeId, scope: FindScope): NodeId[] =>
  scope === 'page' ? (doc.nodes[pageId] ? [pageId] : []) : doc.pages.filter(id => doc.nodes[id]);

// ── Searching ────────────────────────────────────────────────────────────────────────────────────

/** A search that runs in steps (`step(n)` visits at most n layers). `matches` grows as it goes. */
export class FindSearch {
  readonly matches: FindMatch[] = [];
  /** Every match seen, also past MAX_MATCHES. */
  total = 0;
  done = false;
  private readonly needle: string;
  private readonly pages: NodeId[];
  private page = -1;
  private stack: NodeId[] = [];

  constructor(readonly doc: DesignDocument, query: string, readonly options: FindOptions, pageId: NodeId) {
    this.needle = foldForSearch(query, options.caseSensitive);
    this.pages = scopePages(doc, pageId, options.scope);
    if (!this.needle || (!options.text && !options.names)) this.done = true;
  }

  step(budget: number): boolean {
    const {doc, needle, options, matches} = this;
    for (let visited = 0; !this.done && visited < budget; visited++) {
      while (!this.stack.length) {
        if (++this.page >= this.pages.length) {
          this.done = true;
          return true;
        }
        this.stack.push(...(doc.nodes[this.pages[this.page]]?.children ?? []));
      }
      const id = this.stack.pop()!;
      const node = doc.nodes[id];
      if (!node) continue;
      if (node.children) for (const child of node.children) this.stack.push(child);
      const pageId = this.pages[this.page];
      let found = 0;
      if (options.text && node.type === 'TEXT' && node.text) {
        for (const start of occurrences(foldedText(node.text, options.caseSensitive), needle, options.wholeWord)) {
          found++;
          if (matches.length < MAX_MATCHES) matches.push({id, pageId, field: 'text', start, end: start + needle.length});
        }
      }
      if (!found && options.names && occurrences(foldedName(node, options.caseSensitive), needle, options.wholeWord, 1).length) {
        found = 1;
        if (matches.length < MAX_MATCHES) matches.push({id, pageId, field: 'name', start: 0, end: node.name.length});
      }
      this.total += found;
    }
    return this.done;
  }
}

/** Every match at once (tests, small files). */
export function findAll(doc: DesignDocument, query: string, options: FindOptions, pageId: NodeId): FindMatch[] {
  const search = new FindSearch(doc, query, options, pageId);
  while (!search.step(4096));
  return search.matches;
}

// ── Replacing ────────────────────────────────────────────────────────────────────────────────────

const TEXT_NAME = TYPE_NAMES.TEXT;

/** Writes new words into a text layer as a hand edit. A text a component property drives (inside an
 *  instance) changes that property instead; `bound` remembers properties already written in this
 *  transaction, so a second layer bound to the same one is not written twice. */
export function writeCharacters(tx: Transaction, id: NodeId, next: TextProps, bound: Set<string> = new Set()): boolean {
  const node = tx.get(id);
  if (!node?.text || node.text.characters === next.characters) return false;
  // Words past what a stored file holds are not written: the server would refuse the autosave patch, and every
  // later one with it (a short word replaced by a long one everywhere grows a long text many times over).
  if (next.characters.length > DESIGN_FIELD_LIMITS.characters) return false;
  const binding = propertyForField(tx.doc, id, 'characters');
  if (binding) {
    if (next.characters.length > DESIGN_FIELD_LIMITS.description) return false;
    const key = `${binding.instanceId}\u0000${binding.key}`;
    if (bound.has(key)) return false;
    bound.add(key);
    const result = setInstanceProperty(tx.doc, binding.instanceId, binding.key, next.characters);
    applyDocument(tx, result.doc, {changed: result.changed});
    return true;
  }
  const patch: Partial<SceneNode> = {text: next};
  // A text layer named after its words keeps following them (Figma's naming), unless it was renamed.
  if (node.mainId === undefined && (node.name === TEXT_NAME || node.name === autoName(node.text.characters))) patch.name = autoName(next.characters);
  userUpdate(tx, id, patch);
  return true;
}

/** `text` with each range (ascending, not overlapping) replaced; the new words take each range's style. */
export function replaceRanges(text: TextProps, starts: readonly number[], length: number, replacement: string): TextProps {
  let next = text;
  for (let i = starts.length - 1; i >= 0; i--) next = insertText(next, starts[i], starts[i] + length, replacement);
  return next;
}

/** Whether `match` still stands where it was found (the document may have changed since). */
export function matchHolds(doc: DesignDocument, match: FindMatch, query: string, options: FindOptions): boolean {
  const node = doc.nodes[match.id];
  if (match.field !== 'text' || !node?.text) return false;
  const needle = foldForSearch(query, options.caseSensitive);
  if (!needle || match.end - match.start !== needle.length) return false;
  const hay = foldedText(node.text, options.caseSensitive);
  if (hay.slice(match.start, match.end) !== needle) return false;
  return !options.wholeWord || (!isWordChar(codeBefore(hay, match.start)) && !isWordChar(codeAt(hay, match.end)));
}

/** "Replace": one occurrence, inside an open transaction. False when it no longer stands there. */
export function replaceMatch(tx: Transaction, match: FindMatch, query: string, replacement: string, options: FindOptions): boolean {
  if (!matchHolds(tx.doc, match, query, options)) return false;
  const text = tx.get(match.id)!.text!;
  return writeCharacters(tx, match.id, insertText(text, match.start, match.end, replacement));
}

/** "Replace all" inside an open transaction: every occurrence in the text layers of the scope.
 *  A copy inside an instance that still shows its main's words is left to follow the main when the
 *  main is replaced in the same pass (writing it would freeze an override). */
export function replaceAllIn(tx: Transaction, pageId: NodeId, query: string, replacement: string, options: FindOptions): {occurrences: number; layers: number} {
  const doc = tx.doc;
  const needle = foldForSearch(query, options.caseSensitive);
  const found = new Map<NodeId, number[]>();
  if (needle) {
    for (const page of scopePages(doc, pageId, options.scope)) {
      const stack = [...(doc.nodes[page]?.children ?? [])];
      while (stack.length) {
        const node = doc.nodes[stack.pop()!];
        if (!node) continue;
        if (node.children) stack.push(...node.children);
        if (node.type !== 'TEXT' || !node.text) continue;
        const starts = occurrences(foldedText(node.text, options.caseSensitive), needle, options.wholeWord);
        if (starts.length) found.set(node.id, starts);
      }
    }
  }
  const bound = new Set<string>();
  let count = 0, layers = 0;
  for (const [id, starts] of found) {
    const node = doc.nodes[id];
    const main = node.mainId ? doc.nodes[node.mainId] : undefined;
    const follows = main?.text && found.has(main.id) && !isOverridden(node, 'text.characters') && main.text.characters === node.text!.characters
      && !propertyForField(doc, id, 'characters');
    if (follows) {
      count += starts.length;
      continue;
    }
    if (writeCharacters(tx, id, replaceRanges(tx.get(id)!.text!, starts, needle.length, replacement), bound)) {
      count += starts.length;
      layers++;
    }
  }
  return {occurrences: count, layers};
}

// ── A running search with a current match ────────────────────────────────────────────────────────

export type FindSnapshot = {
  query: string;
  matches: readonly FindMatch[];
  /** Every match, also past MAX_MATCHES. */
  total: number;
  /** Matches in text (what "Replace" can change). */
  textMatches: number;
  done: boolean;
  /** Index into `matches`; −1 before the first jump. */
  current: number;
};

/** Runs `work` later (the next macrotask); returns its cancel. */
export type Scheduler = (work: () => void) => () => void;
const nextTask: Scheduler = work => {
  const timer = setTimeout(work, 0);
  return () => clearTimeout(timer);
};

/** How long one slice of a search may run before the page gets the thread back. */
const SLICE_MS = 8;
const STEP_NODES = 512;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type CurrentKey = {id: NodeId; field: FindMatch['field']; ordinal: number};

/** The bar's search: restarts when the query, the options, the document or the page change, keeps
 *  its place (the same occurrence of the same layer) across restarts, and steps through matches. */
export class FindSession {
  private search: FindSearch | null = null;
  private searchedPage: NodeId | null = null;
  private cancel: (() => void) | null = null;
  private query = '';
  private options: FindOptions = DEFAULT_FIND_OPTIONS;
  private textCount = 0;
  private current = -1;
  private key: CurrentKey | null = null;
  /** After a replacement: the index to land on once the new results are in. */
  private want: number | null = null;
  private snap: FindSnapshot = {query: '', matches: [], total: 0, textMatches: 0, done: true, current: -1};
  private readonly listeners = new Set<() => void>();

  constructor(private readonly store: DesignStore, private readonly hooks: {schedule?: Scheduler; onLand?: (match: FindMatch) => void} = {}) {}

  snapshot = (): FindSnapshot => this.snap;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };

  /** Starts a search (the first slice runs now, so small files answer at once). */
  run(query: string, options: FindOptions) {
    const changedQuery = query !== this.query || options !== this.options;
    this.query = query;
    this.options = options;
    if (changedQuery) {
      this.key = null;
      this.want = null;
    }
    this.restart();
  }

  /** The document or the page changed: search again, keeping the place (nothing to do when the
   *  search already ran on this document and page). */
  refresh() {
    const {doc, pageId} = this.store.getState();
    if (this.search && this.search.doc === doc && (this.options.scope === 'all' || this.searchedPage === pageId)) return;
    this.restart();
  }

  /** After a replacement at `index`: land on what takes its place. */
  landAt(index: number) {
    this.want = index;
    this.key = null;
    this.restart();
  }

  /** Jumps by `delta` (1 next, −1 previous); the first jump starts on the current page. Returns the match. */
  go(delta: 1 | -1): FindMatch | null {
    const {matches} = this.search ?? {matches: [] as FindMatch[]};
    if (!matches.length) return null;
    let index: number;
    if (this.current < 0) {
      const pageId = this.store.getState().pageId;
      const onPage = delta > 0 ? matches.findIndex(match => match.pageId === pageId) : findLastIndex(matches, match => match.pageId === pageId);
      index = onPage >= 0 ? onPage : delta > 0 ? 0 : matches.length - 1;
    } else {
      index = (this.current + delta + matches.length) % matches.length;
    }
    this.setCurrent(index);
    return matches[index];
  }

  /** Makes the match at `index` the current one and returns it. */
  select(index: number): FindMatch | null {
    const match = this.search?.matches[index];
    if (!match) return null;
    this.setCurrent(index);
    return match;
  }

  /** The match at the current position, if any. */
  currentMatch(): FindMatch | null {
    return this.current >= 0 ? this.search?.matches[this.current] ?? null : null;
  }

  dispose() {
    this.cancel?.();
    this.cancel = null;
    this.listeners.clear();
  }

  private setCurrent(index: number) {
    const matches = this.search?.matches ?? [];
    this.current = index;
    const match = matches[index];
    this.key = match ? {id: match.id, field: match.field, ordinal: ordinalOf(matches, index)} : null;
    this.emit();
  }

  private restart() {
    this.cancel?.();
    this.cancel = null;
    const {doc, pageId} = this.store.getState();
    this.search = new FindSearch(doc, this.query, this.options, pageId);
    this.searchedPage = pageId;
    this.textCount = 0;
    this.current = -1;
    this.slice();
  }

  private slice = () => {
    const search = this.search;
    if (!search) return;
    const before = search.matches.length;
    const started = now();
    while (!search.step(STEP_NODES) && now() - started < SLICE_MS);
    for (let i = before; i < search.matches.length; i++) if (search.matches[i].field === 'text') this.textCount++;
    if (search.done) {
      this.cancel = null;
      this.settle();
    } else {
      this.cancel = (this.hooks.schedule ?? nextTask)(this.slice);
    }
    this.emit();
  };

  /** Puts the current position back once the results are complete. */
  private settle() {
    const matches = this.search!.matches;
    if (this.want !== null) {
      const want = this.want;
      this.want = null;
      if (matches.length) {
        this.setCurrent(Math.min(want, matches.length - 1));
        this.hooks.onLand?.(matches[this.current]);
      }
      return;
    }
    if (!this.key) return;
    const {id, field, ordinal} = this.key;
    let seen = -1, last = -1;
    for (let i = 0; i < matches.length; i++) {
      if (matches[i].id !== id || matches[i].field !== field) continue;
      last = i;
      if (++seen === ordinal) break;
    }
    if (last >= 0) this.setCurrent(last);
    else this.key = null;
  }

  private emit() {
    const search = this.search;
    this.snap = {
      query: this.query,
      matches: search?.matches ?? [],
      total: search?.total ?? 0,
      textMatches: this.textCount,
      done: search?.done ?? true,
      current: this.current,
    };
    for (const listener of [...this.listeners]) listener();
  }
}

function findLastIndex<T>(list: readonly T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i--) if (test(list[i])) return i;
  return -1;
}

/** Which occurrence of its layer and field the match at `index` is. */
function ordinalOf(matches: readonly FindMatch[], index: number): number {
  const {id, field} = matches[index];
  let ordinal = 0;
  for (let i = index - 1; i >= 0 && matches[i].id === id; i--) if (matches[i].field === field) ordinal++;
  return ordinal;
}

// ── The bar's state (one per open file) ─────────────────────────────────────────────────────────

export type FindBarState = {
  open: boolean;
  /** Bumped by every ⌘F: the bar focuses and selects its field. */
  focus: number;
  query: string;
  replacement: string;
  showReplace: boolean;
  options: FindOptions;
};

export type FindBar = {
  get(): FindBarState;
  set(partial: Partial<FindBarState>): void;
  subscribe(listener: () => void): () => void;
};

const bars = new WeakMap<DesignStore, FindBar>();

/** The find bar of a file's store (created on first use). */
export function findBar(store: DesignStore): FindBar {
  let bar = bars.get(store);
  if (bar) return bar;
  let state: FindBarState = {open: false, focus: 0, query: '', replacement: '', showReplace: true, options: DEFAULT_FIND_OPTIONS};
  const listeners = new Set<() => void>();
  bar = {
    get: () => state,
    set(partial) {
      state = {...state, ...partial};
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
  };
  bars.set(store, bar);
  return bar;
}

export const openFind = (store: DesignStore) => {
  const bar = findBar(store);
  bar.set({open: true, focus: bar.get().focus + 1});
};

export const FIND_COMMANDS: Command[] = [
  {id: 'edit.find', label: 'Find and replace…', group: 'edit', shortcut: {code: 'KeyF', mod: true}, run: ctx => openFind(ctx.store)},
];

let registered = false;
/** Idempotent. */
export function registerFindCommands() {
  if (registered) return;
  registered = true;
  for (const command of FIND_COMMANDS) registerCommand(command);
}
