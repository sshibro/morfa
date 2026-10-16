import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {LIBRARY_PAGE_ID} from '../../../shared/design/types';
import type {TextMeasurer} from '../../../shared/design/text-layout';
import {normalizeDetailed, type NormalizeContext} from '../../../shared/design/normalize';
import {applyPatch, composePatches, diffDocuments, invertPatch, isEmptyPatch, type DocumentPatch} from '../../../shared/design/patch';
import {beginTransaction, createScratch, scratchOf, sealScratch, type TableMode, type Transaction, type TransactionResult, type TransactionScratch} from '../../../shared/design/transaction';
import {continueCopy, copyDone, snapshotDocument, startCopy, type TableCopy} from '../../../shared/design/table-cache';
import {isContainerNode, pageIdOf} from '../../../shared/design/tree';
import {isResidentNode, loadedPagesOf, pageOfEntry, pageSlice, skeletonOf, type DesignPageSlice} from '../../../shared/design/pages';
import {followStore} from '../../../shared/design/engine-switch';
import type {Viewport} from './contracts';

// The editor's state: the document and everything around it that is not saved (page, selection,
// hover, tool, viewports, panels' toggles). Framework-agnostic; React reads it through
// useDesignStore.ts. Documents only change through `transact` and `gesture` (shared/design/
// transaction.ts), so every change has a patch for autosave and an inverse for undo.
//
// Heavy files stay smooth because nothing here is proportional to the file on a drag frame: a
// gesture reuses one node table (TransactionScratch), selection pruning only looks up ids, and
// listeners subscribe to the slices they read, so a viewport pan never wakes a panel.

export type EditorUI = {
  /** "Outline mode" (⌘Y). */
  outlines: boolean;
  /** Layout grids of frames (⌃G). */
  layoutGrids: boolean;
  /** "Marketplace badge zones": where a marketplace's badges, price and favourite icon cover a card frame
   *  (src/design/marketplace/canvas/zones-overlay.ts). Never in exports. */
  cardZones: boolean;
  rulers: boolean;
  /** The pixel grid shown at high zoom. */
  pixelGrid: boolean;
  /** Positions and sizes land on whole pixels while dragging. */
  snapToPixel: boolean;
  /** Panels and toolbar shown (⌘\ hides them). */
  showUI: boolean;
  /** "Minimize UI" (⇧\, Figma's Minimize UI): the side panels fold into floating bars over the canvas. */
  minimizeUI: boolean;
  /** "Multiplayer cursors" (⌥⌘\\, Figma's Multiplayer cursors): other people's cursors on the canvas; their selections stay. */
  multiplayerCursors: boolean;
  /** "Pixel preview": the scene is drawn at 1× and magnified without smoothing. */
  pixelPreview: boolean;
  /** The editor is in "Code" (Figma's Dev Mode; the editor sets it with the mode, it is never saved): the canvas is inspected,
   *  not edited. A click and the hover reach the deepest layer, nothing is dragged, resized or opened for editing
   *  (tools/move.ts), and the canvas aids measure to the hovered layer and show auto layout's spacing (editor/Rulers.tsx). */
  devMode: boolean;
};

export const DEFAULT_UI: EditorUI = {outlines: false, layoutGrids: true, cardZones: true, rulers: false, pixelGrid: true, snapToPixel: true, showUI: true, minimizeUI: false, pixelPreview: false, devMode: false, multiplayerCursors: true};
export const DEFAULT_VIEWPORT: Viewport = {x: 0, y: 0, zoom: 1};

export type EditingState = {kind: 'text' | 'vector' | 'gradient'; id: NodeId} | null;

export type EditorState = {
  readonly doc: DesignDocument;
  readonly pageId: NodeId;
  /** Ids on the current page, in the order they were selected. */
  readonly selection: readonly NodeId[];
  readonly hoverId: NodeId | null;
  /** Id of the active tool (tools/registry.ts). */
  readonly tool: string;
  /** Each page keeps its own viewport; a page not visited yet has none. */
  readonly viewports: Readonly<Record<NodeId, Viewport>>;
  readonly editing: EditingState;
  /** The group or frame the user entered with a double click: clicks pick its children. */
  readonly context: NodeId | null;
  readonly ui: EditorUI;
  /** Nodes a gesture is changing right now (empty otherwise): the renderer redraws only these, with
   *  their subtrees, on each frame of a drag. */
  readonly live: ReadonlySet<NodeId>;
  /** Labels of the steps undo and redo would take, null when there is none. */
  readonly history: {readonly undo: string | null; readonly redo: string | null};
  /** Pages loaded on demand (big files, docs/decisions/big-files.md §4): which pages' layers the document holds and which
   *  are being fetched; null when the whole document is here (the switch off). */
  readonly pages: PagesState | null;
};

export type PagesState = {
  readonly loaded: ReadonlySet<NodeId>;
  readonly loading: ReadonlySet<NodeId>;
  /** Layers per page as the server counted them when the file was opened (unloaded pages have no layers to count here). */
  readonly layers: Readonly<Record<NodeId, number>>;
};

/** Parts of the state a listener can subscribe to. */
export type StoreSlice = 'doc' | 'page' | 'selection' | 'hover' | 'tool' | 'viewport' | 'editing' | 'context' | 'ui' | 'live' | 'history' | 'pages';
const SLICE_BITS: Record<StoreSlice, number> = {doc: 1, page: 2, selection: 4, hover: 8, tool: 16, viewport: 32, editing: 64, context: 128, ui: 256, live: 512, history: 1024, pages: 2048};
const ALL_SLICES = 4095;

/** 'remote': a change that came from the server (another person's edit, or the server's version of ours): it never
 *  enters the undo history and autosave does not send it back (src/design/realtime). 'page': a page's layers arrived
 *  from the server or were let go (big files): the server's own state, like 'remote', never an edit. */
export type PatchSource = 'edit' | 'undo' | 'redo' | 'replace' | 'remote' | 'page';
/** Why the store refused an edit: the file is read-only, the memory budget is full (big files), or the editor is in "Code"
 *  (Dev Mode reads the design: only annotations and measurements change there). */
export type RefusalReason = 'readOnly' | 'memory' | 'devMode';
/** A change of the document as a patch, with the inverse that leads back: the previous document's values at every entry
 *  the patch names live here (the store's table may be written in place, so a document kept from before is not one). */
export type PatchEvent = {patch: DocumentPatch; inverse: DocumentPatch; source: PatchSource; doc: DesignDocument; label?: string};
/** Every change of `state.doc`, with the ids that differ from the previous one (so a renderer can
 *  invalidate only those). 'gesture' is a frame of a drag; when the drag ends an 'edit' carries every
 *  node it changed. */
export type DocumentChange = {doc: DesignDocument; changed: ReadonlySet<NodeId>; pagesChanged: boolean; source: 'edit' | 'gesture' | 'undo' | 'redo' | 'replace' | 'remote' | 'page'};
/** Re-bases one undo or redo step on a document others changed since it was recorded: `step` would take `expected` (the
 *  values the step left, or found) back to its own values; the answer is the patch to apply to `doc` instead. */
export type HistoryRebase = (doc: DesignDocument, step: DocumentPatch, expected: DocumentPatch) => DocumentPatch;

export type Recipe = (tx: Transaction) => void | {select?: readonly NodeId[]};
export type TransactOptions = {
  /** Selection after the change (a recipe may return `{select}` instead). */
  select?: readonly NodeId[];
  /** Consecutive transactions with the same key within a second make one undo step (arrow nudges). */
  coalesce?: string;
  /** False: no undo step (the engine's own corrections, such as text re-measured once its font has
   *  loaded). The change is still drawn and saved (`onPatch`). Default true. */
  history?: boolean;
  /** An annotation or a measurement: the one change "Code" (`ui.devMode`) allows, and undoes. */
  annotation?: boolean;
};

export interface Gesture {
  readonly label: string;
  /** False after commit or cancel; later calls do nothing. */
  readonly active: boolean;
  /** Re-runs `recipe` from the document the gesture started on and shows the result. */
  update(recipe: Recipe): void;
  /** Keeps the last update as one undo step. Returns null when nothing changed. */
  commit(): TransactionResult | null;
  /** Puts the document and the selection back as they were. */
  cancel(): void;
}

export type HistoryEntry = {
  label: string;
  patch: DocumentPatch;
  inverse: DocumentPatch;
  selectionBefore: readonly NodeId[];
  selectionAfter: readonly NodeId[];
  pageBefore: NodeId;
  pageAfter: NodeId;
  time: number;
  coalesce?: string;
  /** An annotation or a measurement: "Code" undoes it (and nothing else). */
  annotation?: boolean;
  /** The count of remote changes when the step was last applied: a later one re-bases it (Figma's undo). */
  epoch?: number;
};

export interface DesignStore {
  getState(): EditorState;
  /** Calls `listener` after changes to the given slices (all of them by default). */
  subscribe(listener: () => void, options?: {slice?: StoreSlice | readonly StoreSlice[]}): () => void;
  /** Calls `listener` when the selected value changes (by `isEqual`, Object.is by default). */
  select<T>(selector: (state: EditorState) => T, listener: (value: T, previous: T) => void, options?: {isEqual?: (a: T, b: T) => boolean; slice?: StoreSlice | readonly StoreSlice[]}): () => void;
  readonly measurer: TextMeasurer;
  /** How commits get their node table (`DesignStoreOptions.table`). */
  readonly table: TableMode;
  transact(label: string, recipe: Recipe, options?: TransactOptions): TransactionResult;
  gesture(label: string, options?: {annotation?: boolean}): Gesture;
  undo(): boolean;
  redo(): boolean;
  canUndo(): boolean;
  canRedo(): boolean;
  setUI(partial: Partial<EditorUI>): void;
  setSelection(ids: readonly NodeId[]): void;
  setHover(id: NodeId | null): void;
  setTool(id: string): void;
  setViewport(viewport: Viewport, pageId?: NodeId): void;
  setEditing(editing: EditingState): void;
  setContext(id: NodeId | null): void;
  setPage(id: NodeId): void;
  /** Big files: fetches a page's layers if the store does not hold them (resolves at once when it does, or when the whole
   *  document is here). `setPage` on an unloaded page calls this and switches when the page arrives. */
  ensurePage(id: NodeId): Promise<void>;
  /** Every listed page, for a search or an export over the whole file. */
  ensureAllPages(): Promise<void>;
  /** Fetches a page the store holds again (a subtree moved into it from a page the store does not hold). */
  refreshPage(id: NodeId): Promise<void>;
  /** Lets a hidden page's layers go (the memory budget): never the current page, a loading one, or one the history or an
   *  unsaved change refers to. Returns whether it went. */
  evictPage(id: NodeId): boolean;
  /** The pages undo and redo steps would switch to: never evicted while the history holds them. */
  pagesInHistory(): Set<NodeId>;
  /** The editor session tells the store how to ask whether a change waits to be saved (eviction). */
  setDirtyCheck?: (check: () => boolean) => void;
  /** Swaps the whole document (version restore, a reload after a conflict). History is cleared
   *  unless `keepHistory`. */
  replaceDocument(doc: DesignDocument, options?: {keepHistory?: boolean}): void;
  /** Committed changes, for autosave. */
  onPatch(listener: (event: PatchEvent) => void): () => void;
  onDocument(listener: (change: DocumentChange) => void): () => void;
  /** A file opened read-only (a team's developer or viewer: docs/design-tool.md §Teams): no edit, gesture, undo, editing mode or drawing
   *  tool takes effect. The engine's own corrections (`history: false`) still apply locally; nothing is saved. */
  readonly readOnly: boolean;
  /** An edit was refused because the file is read-only (its label), so the editor can say why nothing happened. */
  onRefused(listener: (label: string, reason: RefusalReason) => void): () => void;
  /** Big files (the memory budget): while `guard` answers false, edits that would grow the document are refused with the
   *  reason 'memory' (a paste, a duplicate, a new layer); edits that only change or remove layers still go through. */
  setMemoryGuard(guard: (() => boolean) | null): void;
  /** Co-editing (src/design/realtime): a change from the server, applied without an undo step and not saved back.
   *  `make` computes it from the state at the moment it applies: while a gesture runs it waits for the gesture's end
   *  (the drag is never interrupted), and changes apply in the order they were handed in. */
  applyRemote(make: (state: EditorState) => DocumentPatch | null): void;
  /** Remote changes waiting for a gesture to end. */
  remotePending(): number;
  /** Runs after the waiting remote changes have applied (now, when none wait). */
  afterRemote(run: () => void): void;
  /** Undo and redo after remote changes revert only this person's own fields (set by the realtime module). */
  setHistoryRebase(rebase: HistoryRebase | null): void;
  /** Where the document's last change came from (the text editor keeps its caret through a remote edit). */
  changeSource(): DocumentChange['source'] | null;
  /** Rewrites the node entries the undo and redo steps hold (`update` returns the node, changed or the same object), for
   *  a change history must treat as always there, applied with `history: false`: a picture's upload finishing, so one
   *  undo takes the picture away and a redo brings it back with its image rather than an empty placeholder. */
  amendHistory(update: (node: SceneNode) => SceneNode): void;
}

/** Big files: the pages the opened document holds and where the others come from. */
export type PartialOptions = {
  loaded: Iterable<NodeId>;
  layers?: Readonly<Record<NodeId, number>>;
  load: (pageId: NodeId) => Promise<DesignPageSlice>;
  /** Whether an unsaved change waits (eviction never drops a page with one); default: none. */
  dirty?: () => boolean;
};

export type DesignStoreOptions = {
  /** Big files (docs/decisions/big-files.md §4): the document is a skeleton plus `loaded` pages; absent: the whole document. */
  partial?: PartialOptions;
  doc: DesignDocument;
  pageId?: NodeId;
  measurer: TextMeasurer;
  tool?: string;
  ui?: Partial<EditorUI>;
  /** Undo steps kept. Default 200. */
  historyLimit?: number;
  /** How commits get their node table (docs/decisions/in-place-table.md): `in-place` writes the
   *  document's own table and keeps the previous values in the patch's inverse; `copy` makes a table per commit (the
   *  idle copy spares the input path when it is ready). Default: `MORFA_TABLE` (Node), `__MORFA_TABLE__` or `?table=`
   *  (the browser), else `in-place`. */
  table?: TableMode;
  /** Runs work when the editor is idle; returns a cancel function. Default: requestIdleCallback
   *  (a short timer outside browsers). Tests pass their own to control when it runs. `deadline` (as
   *  requestIdleCallback's) says how long the work may take; without one it runs to the end. */
  idle?: (work: (deadline?: {timeRemaining(): number}) => void) => () => void;
  /** The engine's shadow document catches up with commits at idle (`idle`) instead of on each commit
   *  (shared/design/engine-switch.ts `followStore`'s `defer`). Default: in the browser (where `requestIdleCallback`
   *  exists); Node's tests keep the shadow on every commit, which the both-mode oracle checks patch by patch. */
  deferShadow?: boolean;
  /** The file opens read-only (see DesignStore.readOnly). */
  readOnly?: boolean;
};

/** The table mode the environment asks for when a store is made without one: `MORFA_TABLE` in Node, `__MORFA_TABLE__`
 *  or `?table=` in the browser; `in-place` otherwise (the editor's default; `beginTransaction`'s
 *  own default stays `copy`). An unknown value throws (a typo never means a mode). */
export function configuredTableMode(): TableMode {
  const host = globalThis as {process?: {env?: Record<string, string | undefined>; versions?: {node?: string}}; __MORFA_TABLE__?: string; location?: {search?: string}};
  const value = host.process?.versions?.node
    ? host.process.env?.MORFA_TABLE
    : (host.__MORFA_TABLE__ ?? (host.location?.search ? new URLSearchParams(host.location.search).get('table') ?? undefined : undefined));
  if (value === undefined || value === '') return 'in-place';
  if (value === 'copy' || value === 'in-place') return value;
  throw new Error(`table mode: unknown value '${value}' (copy | in-place)`);
}

/** `requestIdleCallback`, or a short timer that never keeps a process alive. */
function whenIdle(work: (deadline?: {timeRemaining(): number}) => void): () => void {
  if (typeof requestIdleCallback === 'function') {
    const handle = requestIdleCallback(work, {timeout: 1000});
    return () => cancelIdleCallback(handle);
  }
  const timer = setTimeout(work, 30) as unknown as {unref?: () => void};
  timer.unref?.();
  return () => clearTimeout(timer as unknown as ReturnType<typeof setTimeout>);
}

type Deadline = {timeRemaining(): number};
type Scheduler = {postTask(task: () => void, options: {priority: 'background'; signal: AbortSignal}): Promise<unknown>};
/** How long one slice of background work may hold the thread. */
const SLICE_MS = 4;

/** Background work in slices: a `scheduler.postTask` task of background priority (it runs after input and frames
 *  whenever the thread is free, where requestIdleCallback waits for an idle period after a frame and gets one short
 *  period a frame while the editor draws), with a deadline of one slice; `whenIdle` where there is no scheduler. */
function whenFree(work: (deadline?: Deadline) => void): () => void {
  const scheduler = (globalThis as {scheduler?: Partial<Scheduler>}).scheduler;
  if (typeof scheduler?.postTask !== 'function') return whenIdle(work);
  const controller = new AbortController();
  scheduler.postTask(() => {
    const until = performance.now() + SLICE_MS;
    work({timeRemaining: () => until - performance.now()});
  }, {priority: 'background', signal: controller.signal}).catch(() => {});
  return () => controller.abort();
}

/** The tools a read-only file keeps: selecting, looking around, commenting, voting and emotes (none of them is the document:
 *  src/design/comments, src/design/meeting). */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set(['move', 'hand', 'comment', 'meeting-vote', 'meeting-emote']);

const EMPTY_LIVE: ReadonlySet<NodeId> = new Set();
const NO_HISTORY = {undo: null, redo: null} as const;
const COALESCE_MS = 1000;

export const currentViewport = (state: EditorState): Viewport => state.viewports[state.pageId] ?? DEFAULT_VIEWPORT;

const maskOf = (slice: StoreSlice | readonly StoreSlice[] | undefined) =>
  slice === undefined ? ALL_SLICES : typeof slice === 'string' ? SLICE_BITS[slice] : slice.reduce((mask, each) => mask | SLICE_BITS[each], 0);

function changedSlices(a: EditorState, b: EditorState): number {
  let mask = 0;
  if (a.doc !== b.doc) mask |= SLICE_BITS.doc;
  if (a.pageId !== b.pageId) mask |= SLICE_BITS.page;
  if (a.selection !== b.selection) mask |= SLICE_BITS.selection;
  if (a.hoverId !== b.hoverId) mask |= SLICE_BITS.hover;
  if (a.tool !== b.tool) mask |= SLICE_BITS.tool;
  if (a.viewports !== b.viewports) mask |= SLICE_BITS.viewport;
  if (a.editing !== b.editing) mask |= SLICE_BITS.editing;
  if (a.context !== b.context) mask |= SLICE_BITS.context;
  if (a.ui !== b.ui) mask |= SLICE_BITS.ui;
  if (a.live !== b.live) mask |= SLICE_BITS.live;
  if (a.history !== b.history) mask |= SLICE_BITS.history;
  if (a.pages !== b.pages) mask |= SLICE_BITS.pages;
  return mask;
}

const sameList = (a: readonly NodeId[], b: readonly NodeId[]) => a === b || (a.length === b.length && a.every((id, i) => id === b[i]));
const keysOf = (patch: DocumentPatch): Set<NodeId> => new Set(Object.keys(patch.nodes ?? {}));

export function createDesignStore(options: DesignStoreOptions): DesignStore {
  const {measurer} = options;
  const context: NormalizeContext = {measurer};
  const historyLimit = options.historyLimit ?? 200;
  const firstPage = options.pageId && options.doc.nodes[options.pageId]?.type === 'PAGE' ? options.pageId : options.doc.pages[0];

  const partial = options.partial ?? null;
  let state: EditorState = {
    doc: options.doc,
    pageId: firstPage,
    selection: [],
    hoverId: null,
    tool: options.readOnly && options.tool && !READ_ONLY_TOOLS.has(options.tool) ? 'move' : options.tool ?? 'move',
    viewports: {},
    editing: null,
    context: null,
    ui: {...DEFAULT_UI, ...options.ui},
    live: EMPTY_LIVE,
    history: NO_HISTORY,
    pages: partial ? {loaded: new Set(partial.loaded), loading: EMPTY_LIVE, layers: partial.layers ?? {}} : null,
  };
  const undoStack: HistoryEntry[] = [];
  const redoStack: HistoryEntry[] = [];
  const pageSelections = new Map<NodeId, readonly NodeId[]>();
  type Entry = {listener: () => void; mask: number};
  let listeners: Entry[] = [];
  const patchListeners = new Set<(event: PatchEvent) => void>();
  const documentListeners = new Set<(change: DocumentChange) => void>();
  const refusedListeners = new Set<(label: string, reason: RefusalReason) => void>();
  const readOnly = options.readOnly === true;
  const refuse = (label: string, reason: RefusalReason = 'readOnly') => {
    for (const listener of [...refusedListeners]) listener(label, reason);
  };
  /** "Code" (Dev Mode) reads the design: a change there is refused unless it is an annotation or a measurement. */
  const inspecting = (change: {annotation?: boolean}) => state.ui.devMode && !change.annotation;
  /** Big files: answers false while the memory budget is full (memory-watch.ts). */
  let memoryGuard: (() => boolean) | null = null;
  /** Whether a committed change adds layers (the budget refuses those, and only those, when it is full): an entry the
   *  inverse takes back to none. (The document before is no witness: in place its table already holds the change.) */
  const grows = (patch: DocumentPatch, inverse: DocumentPatch): boolean => {
    if (!patch.nodes) return false;
    for (const [id, node] of Object.entries(patch.nodes)) if (node && inverse.nodes?.[id] === null) return true;
    return false;
  };
  const tableMode: TableMode = options.table ?? configuredTableMode();
  const inPlace = tableMode === 'in-place';
  // In place the store writes its document's own table: it takes a table of its own at the start (once, O(layers)), so
  // the caller's object stays what it was (tests build one document for several stores; an opener may keep its copy).
  if (inPlace) state = {...state, doc: snapshotDocument(state.doc)};
  /** The table `applyPatch` writes a patch's nodes into: in place the document's own; else the idle copy when it is ready. */
  const tableFor = (doc: DesignDocument, patch: DocumentPatch): Record<NodeId, SceneNode> | undefined => (inPlace ? doc.nodes : patch.nodes ? takeSpare(doc)?.table ?? undefined : undefined);
  let active: (Gesture & {finish(): void}) | null = null;
  /** Big files: the page `setPage` was asked for while its layers load. */
  let wantedPage: NodeId | null = null;
  // Co-editing: remote changes waiting for a gesture's end, how many have applied (history steps re-base after one),
  // the step re-baser the realtime module sets, and the source of the last document change.
  const deferredRemote: ((state: EditorState) => DocumentPatch | null)[] = [];
  const remoteWaiters: (() => void)[] = [];
  /** Page slices that arrived while a gesture ran: installed once it ends (`flushRemote`), as remote changes are. */
  const deferredPages: (() => void)[] = [];
  let remoteEpoch = 0;
  let historyRebase: HistoryRebase | null = null;
  let lastSource: DocumentChange['source'] | null = null;

  // An edit has to copy the node table before it writes (published documents never change), and
  // copying 100 000 entries takes tens of milliseconds the user would wait on every keystroke, nudge,
  // undo and at the start of every drag. So the copy is made ahead of time, when the editor is idle: a
  // private copy of the current document's table, which the next edit takes and writes into. It is
  // made a slice at a time in background tasks (input and frames go first and never wait behind more
  // than a slice, but for the one enumeration of the keys), and an edit that comes before it is whole
  // finishes it. A published table never changes, so
  // the copy equals it for as long as that document is current; it is taken at most once and only while
  // its document is still the current one.
  const idle = options.idle ?? whenIdle;
  const free = options.idle ?? whenFree;
  let spare: {base: DesignDocument; copy: TableCopy<SceneNode>} | null = null;
  let cancelSpare: (() => void) | null = null;
  function prepareSpare() {
    // In place there is no copy to make ahead.
    if (inPlace || cancelSpare || active || (spare?.base === state.doc && copyDone(spare.copy))) return;
    cancelSpare = free(deadline => {
      cancelSpare = null;
      // A drag's frames share a table that keeps changing: only a settled document is copied.
      if (active) return;
      if (spare?.base !== state.doc) spare = {base: state.doc, copy: startCopy(state.doc.nodes)};
      if (!continueCopy(spare.copy, deadline ? () => deadline.timeRemaining() < 1 : undefined)) prepareSpare();
    });
  }
  function takeSpare(doc: DesignDocument): TransactionScratch | undefined {
    const taken = spare;
    spare = null;
    if (taken?.base !== doc) return undefined;
    // What is left of it, now: never more than the copy an edit made before.
    continueCopy(taken.copy);
    return scratchOf(doc, taken.copy.table);
  }


  const historyLabels = () => {
    const undo = undoStack.at(-1)?.label ?? null, redo = redoStack.at(-1)?.label ?? null;
    return state.history.undo === undo && state.history.redo === redo ? state.history : {undo, redo};
  };

  /** Keeps page, selection, hover, context and editing pointing at nodes that exist on the page.
   *  `full` re-checks which page each selected node is on (a page switch, undo); otherwise only
   *  existence is checked, which is all a drag frame can change. */
  function reconcile(next: EditorState, full: boolean): EditorState {
    const {doc} = next;
    let pageId = next.pageId;
    if (doc.nodes[pageId]?.type !== 'PAGE') {
      pageId = doc.pages[0];
      full = true;
    }
    const onPage = full
      ? (id: NodeId) => id !== pageId && !!doc.nodes[id] && pageIdOf(doc, id) === pageId
      : (id: NodeId) => id !== pageId && !!doc.nodes[id];
    let selection = next.selection;
    if (selection.some(id => !onPage(id))) selection = selection.filter(onPage);
    const hoverId = next.hoverId && onPage(next.hoverId) ? next.hoverId : null;
    const contextId = next.context && onPage(next.context) && isContainerNode(doc.nodes[next.context]) ? next.context : null;
    const editing = next.editing && onPage(next.editing.id) ? next.editing : null;
    if (pageId === next.pageId && selection === next.selection && hoverId === next.hoverId && contextId === next.context && editing === next.editing) return next;
    return {...next, pageId, selection, hoverId, context: contextId, editing};
  }

  function commit(next: EditorState, change?: Omit<DocumentChange, 'doc'>) {
    const previous = state;
    if (next === previous) return;
    state = next;
    // Also when the document stays: a drag's end keeps the last frame's document, now settled.
    prepareSpare();
    if (change) lastSource = change.source;
    if (change && documentListeners.size) {
      const event = {...change, doc: next.doc};
      for (const listener of [...documentListeners]) listener(event);
    }
    const mask = changedSlices(previous, next);
    if (!mask) return;
    for (const entry of listeners) if (entry.mask & mask) entry.listener();
  }

  function emitPatch(event: PatchEvent) {
    for (const listener of [...patchListeners]) listener(event);
  }

  function push(entry: HistoryEntry): void {
    const last = undoStack.at(-1);
    if (entry.coalesce && last?.coalesce === entry.coalesce && !redoStack.length && entry.time - last.time < COALESCE_MS) {
      last.patch = composePatches(last.patch, entry.patch);
      last.inverse = composePatches(entry.inverse, last.inverse);
      last.selectionAfter = entry.selectionAfter;
      last.pageAfter = entry.pageAfter;
      last.time = entry.time;
      return;
    }
    undoStack.push(entry);
    if (undoStack.length > historyLimit) undoStack.splice(0, undoStack.length - historyLimit);
    redoStack.length = 0;
  }

  const finishGesture = () => active?.finish();

  function transact(label: string, recipe: Recipe, options: TransactOptions = {}): TransactionResult {
    finishGesture();
    if ((readOnly || inspecting(options)) && options.history !== false) {
      // Nothing changes: the recipe never runs, and the caller gets an empty change of the current document.
      refuse(label, readOnly ? 'readOnly' : 'devMode');
      return beginTransaction(state.doc).commit(context);
    }
    const before = state;
    const scratch = takeSpare(before.doc);
    const tx = beginTransaction(before.doc, {scratch, table: tableMode});
    let out: ReturnType<Recipe>;
    let result: TransactionResult;
    try {
      out = recipe(tx);
      result = tx.commit(context);
    } catch (error) {
      // A recipe that threw: in place the document's table has its entries back before anyone reads it again.
      tx.abort();
      throw error;
    }
    // The copy is now the new document's table (or dropped): no one writes into it again.
    if (scratch) sealScratch(scratch, result.doc);
    prepareSpare();
    const select = (out && out.select) ?? options.select;
    if (isEmptyPatch(result.patch)) {
      if (select) setSelection(select);
      return result;
    }
    if (memoryGuard && !memoryGuard() && grows(result.patch, result.inverse)) {
      // The budget is full: a change that adds layers is dropped (the document stays), the rest go through. In place
      // the table already holds it: the inverse takes it out again.
      if (inPlace) applyPatch(result.doc, result.inverse, result.doc.nodes);
      refuse(label, 'memory');
      return beginTransaction(before.doc).commit(context);
    }
    const next = reconcile({...before, doc: result.doc, selection: select ? dedupe(select) : before.selection}, true);
    if (options.history !== false) push({label, patch: result.patch, inverse: result.inverse, selectionBefore: before.selection, selectionAfter: next.selection, pageBefore: before.pageId, pageAfter: next.pageId, time: Date.now(), coalesce: options.coalesce, annotation: options.annotation, epoch: remoteEpoch});
    commit({...next, history: historyLabels()}, {changed: keysOf(result.patch), pagesChanged: !!result.patch.pages, source: 'edit'});
    emitPatch({patch: result.patch, inverse: result.inverse, source: 'edit', doc: result.doc, label});
    return result;
  }

  function gesture(label: string, options: {annotation?: boolean} = {}): Gesture {
    finishGesture();
    if (readOnly || inspecting(options)) {
      refuse(label, readOnly ? 'readOnly' : 'devMode');
      return {label, active: false, update() {}, commit: () => null, cancel() {}};
    }
    const base = state.doc, baseSelection = state.selection, basePage = state.pageId;
    // A gesture's frames share one copy of the table whatever the store's table mode: between two frames the shown
    // document is the last frame's while the tool computes the next frame from the base, which stays as it is. The idle
    // copy spares the first frame its copy (in `copy` mode; in place there is none to spare).
    const scratch = takeSpare(base) ?? createScratch(base);
    let result: TransactionResult | null = null;
    /** Ids that differ between the shown document and the base. */
    let shown = new Set<NodeId>();
    let isActive = true;
    const close = () => {
      isActive = false;
      if (active === handle) active = null;
    };
    /** Remote changes that waited for this gesture apply once its own change is in (after its patch event). */
    const settle = () => {
      if (!active) flushRemote();
    };
    const handle: Gesture & {finish(): void} = {
      label,
      get active() {
        return isActive;
      },
      update(recipe) {
        if (!isActive) return;
        const tx = beginTransaction(base, {scratch});
        let out: ReturnType<Recipe>;
        try {
          out = recipe(tx);
          result = tx.commit(context);
        } catch (error) {
          // The shared table is half-written: show the base until the next update succeeds.
          tx.abort();
          result = null;
          const changed = shown;
          shown = new Set();
          commit(reconcile({...state, doc: base, selection: baseSelection, live: EMPTY_LIVE}, false), {changed, pagesChanged: false, source: 'gesture'});
          throw error;
        }
        const now = keysOf(result.patch);
        const changed = new Set([...shown, ...now]);
        shown = now;
        const live = new Set<NodeId>();
        // A page is never live: a layer created by the gesture changes its page's children, and a live
        // page would hide everything on it from the live layer (drawing a new shape, ⌥-dragging a copy).
        for (const id of now) if (result.doc.nodes[id] && result.doc.nodes[id].type !== 'PAGE') live.add(id);
        const select = out && out.select;
        const selection = select ? (sameList(select, state.selection) ? state.selection : dedupe(select)) : baseSelection;
        commit(reconcile({...state, doc: result.doc, selection, live}, false), {changed, pagesChanged: !!result.patch.pages, source: 'gesture'});
      },
      commit() {
        if (!isActive) return null;
        close();
        if (!result || isEmptyPatch(result.patch)) {
          if (state.doc !== base || state.live.size) commit(reconcile({...state, doc: base, selection: baseSelection, live: EMPTY_LIVE}, false), {changed: shown, pagesChanged: false, source: 'gesture'});
          settle();
          return null;
        }
        if (memoryGuard && !memoryGuard() && grows(result.patch, result.inverse)) {
          refuse(label, 'memory');
          commit(reconcile({...state, doc: base, selection: baseSelection, live: EMPTY_LIVE}, false), {changed: shown, pagesChanged: false, source: 'gesture'});
          settle();
          return null;
        }
        // The last frame's table is kept: no frame writes into it again.
        sealScratch(scratch, result.doc);
        const next = reconcile({...state, live: EMPTY_LIVE}, true);
        push({label, patch: result.patch, inverse: result.inverse, selectionBefore: baseSelection, selectionAfter: next.selection, pageBefore: basePage, pageAfter: next.pageId, time: Date.now(), annotation: options.annotation, epoch: remoteEpoch});
        commit({...next, history: historyLabels()}, {changed: keysOf(result.patch), pagesChanged: !!result.patch.pages, source: 'edit'});
        emitPatch({patch: result.patch, inverse: result.inverse, source: 'edit', doc: state.doc, label});
        settle();
        return result;
      },
      cancel() {
        if (!isActive) return;
        close();
        commit(reconcile({...state, doc: base, selection: baseSelection, live: EMPTY_LIVE}, false), {changed: shown, pagesChanged: false, source: 'gesture'});
        settle();
      },
      finish() {
        handle.commit();
      },
    };
    active = handle;
    return handle;
  }

  function travel(direction: 'undo' | 'redo'): boolean {
    finishGesture();
    if (readOnly) return false;
    const from = direction === 'undo' ? undoStack : redoStack;
    const to = direction === 'undo' ? redoStack : undoStack;
    const peek = from.at(-1);
    if (!peek) return false;
    if (inspecting(peek)) {
      // "Code" undoes its own notes, not the design's edits.
      refuse(peek.label, 'devMode');
      return false;
    }
    // A step on a page the store let go (big files): the page comes back first, then the step applies on top of the
    // server's state of it (its whole nodes make the result exact).
    const target = direction === 'undo' ? peek.pageBefore : peek.pageAfter;
    if (state.pages && !state.pages.loaded.has(target) && state.doc.nodes[target]?.type === 'PAGE') {
      void ensurePage(target).then(() => {
        if (from.at(-1) === peek) travel(direction);
      });
      return true;
    }
    const entry = from.pop();
    if (!entry) return false;
    to.push(entry);
    let patch = direction === 'undo' ? entry.inverse : entry.patch;
    if (historyRebase && (entry.epoch ?? 0) !== remoteEpoch) {
      // Others changed the file since this step: only the fields the step itself changed go back, and the step
      // the other way restores what the document holds now (Figma: an undo rewrites the redo at the time it runs).
      let merged = historyRebase(state.doc, patch, direction === 'undo' ? entry.patch : entry.inverse);
      // The combination was never laid out (a frame both people changed): layout runs on it as part of the step.
      if (merged.nodes) {
        const combined = applyPatch(state.doc, merged);
        const laid = normalizeDetailed(combined, new Set(Object.keys(merged.nodes).filter(id => combined.nodes[id])), context);
        if (laid.doc !== combined) {
          const extra: Record<NodeId, SceneNode | null> = {};
          for (const id of laid.changed) if (laid.doc.nodes[id] !== combined.nodes[id]) extra[id] = laid.doc.nodes[id] ?? null;
          merged = composePatches(merged, {nodes: extra});
        }
      }
      const restore = invertPatch(state.doc, merged);
      if (direction === 'undo') {
        entry.inverse = merged;
        entry.patch = restore;
      } else {
        entry.patch = merged;
        entry.inverse = restore;
      }
      patch = merged;
    }
    entry.epoch = remoteEpoch;
    // The event's inverse is what the document holds now at the patch's entries (others may have changed them since the
    // step was recorded: the entry's other patch is not it), taken before the apply — in place the table then holds the step.
    const inverse = invertPatch(state.doc, patch);
    const doc = applyPatch(state.doc, patch, tableFor(state.doc, patch));
    const pageId = direction === 'undo' ? entry.pageBefore : entry.pageAfter;
    const selection = direction === 'undo' ? entry.selectionBefore : entry.selectionAfter;
    let next: EditorState = {...state, doc, selection};
    if (pageId !== state.pageId && doc.nodes[pageId]?.type === 'PAGE') {
      pageSelections.set(state.pageId, state.selection);
      next = {...next, pageId, hoverId: null, context: null, editing: null};
    }
    next = reconcile(next, true);
    commit({...next, history: historyLabels()}, {changed: keysOf(patch), pagesChanged: !!patch.pages, source: direction});
    emitPatch({patch, inverse, source: direction, doc, label: entry.label});
    return true;
  }

  function setSelection(ids: readonly NodeId[]) {
    const next = dedupe(ids);
    if (sameList(next, state.selection)) return;
    commit(reconcile({...state, selection: next}, true));
  }

  function runRemote(make: (state: EditorState) => DocumentPatch | null) {
    let patch = make(state);
    let refresh: Set<NodeId> | null = null;
    if (patch && state.pages) ({patch, refresh} = trimRemote(patch));
    if (patch && !isEmptyPatch(patch)) {
      // The idle copy of the node table takes the change (or, in place, the document's own): no 20 000-entry copy while
      // others type. The inverse is taken before the apply: afterwards the table holds the change.
      const inverse = invertPatch(state.doc, patch);
      const doc = applyPatch(state.doc, patch, tableFor(state.doc, patch));
      remoteEpoch++;
      const next = reconcile({...state, doc}, true);
      commit(next, {changed: keysOf(patch), pagesChanged: !!patch.pages, source: 'remote'});
      emitPatch({patch, inverse, source: 'remote', doc});
    }
    // After the change is in (and counted), so the fetch does not see it as one that landed during the fetch.
    if (refresh) for (const page of refresh) if (!loads.has(page)) void fetchPage(page);
  }
  function flushRemote() {
    while (!active && deferredRemote.length) runRemote(deferredRemote.shift()!);
    while (!active && deferredPages.length) deferredPages.shift()!();
    if (active) return;
    while (remoteWaiters.length) remoteWaiters.shift()!();
  }

  // ── Pages on demand (big files) ──
  const loads = new Map<NodeId, Promise<void>>();
  const setPages = (pages: PagesState) => commit({...state, pages});
  const withLoading = (id: NodeId, on: boolean) => {
    const pages = state.pages!;
    if (pages.loading.has(id) === on) return;
    const loading = new Set(pages.loading);
    if (on) loading.add(id);
    else loading.delete(id);
    setPages({...pages, loading});
  };
  /** Puts a page's layers into the document as the server's own state (never an edit): the slice replaces what the store
   *  held of the page, so a refresh is exact. */
  function installPage(id: NodeId, slice: DesignPageSlice) {
    // A gesture's frames write a table of their own from the gesture's base: a page installed now would be lost with the
    // base when the gesture commits or cancels. It waits, as a remote change does.
    if (active) {
      deferredPages.push(() => {
        if (state.pages && state.doc.nodes[id]?.type === 'PAGE') installPage(id, slice);
      });
      return;
    }
    const pages = state.pages!;
    const before = pageSlice(state.doc, id);
    const nodes: Record<NodeId, SceneNode | null> = {};
    for (const key of Object.keys(before)) if (!Object.hasOwn(slice.nodes, key)) nodes[key] = null;
    for (const [key, node] of Object.entries(slice.nodes)) if (state.doc.nodes[key] !== node) nodes[key] = node;
    const loaded = new Set(pages.loaded);
    loaded.add(id);
    const layers = {...pages.layers, [id]: Object.keys(slice.nodes).length};
    if (!Object.keys(nodes).length) {
      setPages({...pages, loaded, layers});
      return;
    }
    const patch: DocumentPatch = {nodes};
    const inverse = invertPatch(state.doc, patch);
    const doc = applyPatch(state.doc, patch, tableFor(state.doc, patch));
    const next = reconcile({...state, doc, pages: {...pages, loaded, layers}}, true);
    commit(next, {changed: keysOf(patch), pagesChanged: false, source: 'page'});
    emitPatch({patch, inverse, source: 'page', doc});
  }
  /** Fetches a page; a remote change that lands while the fetch runs means the slice may predate it: fetched again (at most
   *  three times) so no change is lost between the slice's version and the store's. */
  function fetchPage(id: NodeId): Promise<void> {
    const running = loads.get(id);
    if (running) return running;
    const load = (async () => {
      withLoading(id, true);
      try {
        for (let attempt = 0; ; attempt++) {
          const epoch = remoteEpoch;
          const slice = await partial!.load(id);
          if (!state.pages || state.doc.nodes[id]?.type !== 'PAGE') return;
          if (remoteEpoch === epoch || attempt >= 2) {
            installPage(id, slice);
            return;
          }
        }
      } finally {
        loads.delete(id);
        if (state.pages) withLoading(id, false);
      }
    })();
    loads.set(id, load);
    return load;
  }
  function ensurePage(id: NodeId): Promise<void> {
    if (!state.pages || state.pages.loaded.has(id) || state.doc.nodes[id]?.type !== 'PAGE' || id === LIBRARY_PAGE_ID) return Promise.resolve();
    return fetchPage(id);
  }
  /** Drops the entries of pages the store does not hold (their page will come whole when it is shown), keeps the skeleton's
   *  (page nodes, components, tables) and the loaded pages'. A subtree root moved into a loaded page from one the store does
   *  not hold arrives without its descendants: that page is fetched again. */
  function trimRemote(patch: DocumentPatch): {patch: DocumentPatch; refresh: Set<NodeId> | null} {
    const pages = state.pages!;
    if (!patch.nodes) return {patch, refresh: null};
    const {doc} = state;
    const read = (id: NodeId): SceneNode | null | undefined => (patch.nodes && Object.hasOwn(patch.nodes, id) ? patch.nodes[id] : doc.nodes[id]);
    let nodes: Record<NodeId, SceneNode | null> | null = null;
    const refresh = new Set<NodeId>();
    for (const [id, node] of Object.entries(patch.nodes)) {
      let keep: boolean;
      if (node === null) keep = Object.hasOwn(doc.nodes, id);
      else if (node.type === 'PAGE') keep = true;
      else {
        const page = pageOfEntry(read, id);
        keep = page === 'resident' || (page !== null && pages.loaded.has(page));
        if (keep && page !== 'resident' && node.children?.some(child => !read(child))) refresh.add(page as NodeId);
      }
      if (!keep && !nodes) nodes = {...patch.nodes};
      if (!keep) delete nodes![id];
    }
    return {patch: nodes ? {...patch, nodes} : patch, refresh: refresh.size ? refresh : null};
  }
  function pagesInHistory(): Set<NodeId> {
    const out = new Set<NodeId>();
    for (const entry of undoStack) out.add(entry.pageBefore).add(entry.pageAfter);
    for (const entry of redoStack) out.add(entry.pageBefore).add(entry.pageAfter);
    return out;
  }
  function evictPage(id: NodeId): boolean {
    const pages = state.pages;
    if (!pages || !pages.loaded.has(id) || pages.loading.has(id) || id === state.pageId || id === LIBRARY_PAGE_ID || active) return false;
    if (partial?.dirty?.() || pagesInHistory().has(id)) return false;
    finishGesture();
    const nodes: Record<NodeId, SceneNode | null> = {};
    for (const [key, node] of Object.entries(pageSlice(state.doc, id))) if (!isResidentNode(node) && pageOfEntry(k => state.doc.nodes[k], key) !== 'resident') nodes[key] = null;
    const loaded = new Set(pages.loaded);
    loaded.delete(id);
    if (!Object.keys(nodes).length) {
      setPages({...pages, loaded});
      return true;
    }
    const patch: DocumentPatch = {nodes};
    const inverse = invertPatch(state.doc, patch);
    const doc = applyPatch(state.doc, patch, tableFor(state.doc, patch));
    pageSelections.delete(id);
    const next = reconcile({...state, doc, pages: {...pages, loaded}}, true);
    commit(next, {changed: keysOf(patch), pagesChanged: false, source: 'page'});
    emitPatch({patch, inverse, source: 'page', doc});
    return true;
  }

  const store: DesignStore = {
    getState: () => state,
    subscribe(listener, options = {}) {
      const entry: Entry = {listener, mask: maskOf(options.slice)};
      listeners = [...listeners, entry];
      return () => {
        listeners = listeners.filter(each => each !== entry);
      };
    },
    select(selector, listener, options = {}) {
      const isEqual = options.isEqual ?? Object.is;
      let value = selector(state);
      return store.subscribe(() => {
        const next = selector(state);
        if (isEqual(value, next)) return;
        const previous = value;
        value = next;
        listener(next, previous);
      }, {slice: options.slice});
    },
    measurer,
    table: tableMode,
    transact,
    gesture,
    undo: () => travel('undo'),
    redo: () => travel('redo'),
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    amendHistory(update) {
      // Patches are shared (autosave may still hold one): changed ones are copied, never written into.
      const amend = (patch: DocumentPatch): DocumentPatch => {
        if (!patch.nodes) return patch;
        let nodes: DocumentPatch['nodes'] | null = null;
        for (const [id, node] of Object.entries(patch.nodes)) {
          if (!node) continue;
          const next = update(node);
          if (next === node) continue;
          nodes ??= {...patch.nodes};
          nodes[id] = next;
        }
        return nodes ? {...patch, nodes} : patch;
      };
      for (const entry of [...undoStack, ...redoStack]) {
        entry.patch = amend(entry.patch);
        entry.inverse = amend(entry.inverse);
      }
    },
    setUI(partial) {
      const keys = Object.keys(partial) as (keyof EditorUI)[];
      if (keys.every(key => state.ui[key] === partial[key])) return;
      commit({...state, ui: {...state.ui, ...partial}});
    },
    setSelection,
    setHover(id) {
      if (id === state.hoverId) return;
      commit(reconcile({...state, hoverId: id}, false));
    },
    setTool(id) {
      if (id === state.tool) return;
      if (readOnly && !READ_ONLY_TOOLS.has(id)) {
        refuse('Tool');
        return;
      }
      commit({...state, tool: id});
    },
    setViewport(viewport, pageId = state.pageId) {
      const current = state.viewports[pageId];
      if (current && current.x === viewport.x && current.y === viewport.y && current.zoom === viewport.zoom) return;
      commit({...state, viewports: {...state.viewports, [pageId]: {x: viewport.x, y: viewport.y, zoom: viewport.zoom}}});
    },
    setEditing(editing) {
      if (readOnly && editing) {
        refuse('Editing');
        return;
      }
      if (editing === state.editing || (editing && state.editing && editing.id === state.editing.id && editing.kind === state.editing.kind)) return;
      commit(reconcile({...state, editing}, false));
    },
    setContext(id) {
      if (id === state.context) return;
      commit(reconcile({...state, context: id}, true));
    },
    setPage(id) {
      // The hidden page of library copies (shared/design/libraries.ts) is never shown.
      if (id === state.pageId || state.doc.nodes[id]?.type !== 'PAGE' || id === LIBRARY_PAGE_ID) return;
      if (state.pages && !state.pages.loaded.has(id)) {
        // Big files: the page's layers come first; the switch follows when they are here (unless another page was chosen).
        wantedPage = id;
        void ensurePage(id).then(() => {
          if (wantedPage === id && state.pages?.loaded.has(id)) store.setPage(id);
        });
        return;
      }
      wantedPage = null;
      finishGesture();
      pageSelections.set(state.pageId, state.selection);
      commit(reconcile({...state, pageId: id, selection: pageSelections.get(id) ?? [], hoverId: null, context: null, editing: null}, true));
    },
    replaceDocument(doc, options = {}) {
      // A drag started on a document that is going away ends without a history step.
      active?.cancel();
      let pages = state.pages;
      if (pages) {
        // Big files: the store keeps the pages it held (the current one included); a whole document from the server is cut
        // down to them, a partial one brings what it has.
        const keep = new Set(pages.loaded);
        keep.add(state.pageId);
        doc = skeletonOf(doc, keep);
        const loaded = loadedPagesOf(doc);
        for (const id of [...loaded]) if (!keep.has(id)) loaded.delete(id);
        pages = {...pages, loaded};
      }
      // Another document of its own (a reload, the server's copy): entries compared by identity, as always. A document
      // sharing this one's table (written in place) would show no change here — none hands the store one.
      const patch = diffDocuments(state.doc, doc);
      const inverse = invertPatch(state.doc, patch);
      if (!options.keepHistory) {
        undoStack.length = 0;
        redoStack.length = 0;
      }
      const next = reconcile({...state, doc, live: EMPTY_LIVE, pages}, true);
      commit({...next, history: historyLabels()}, {changed: keysOf(patch), pagesChanged: !!patch.pages, source: 'replace'});
      emitPatch({patch, inverse, source: 'replace', doc, label: undefined});
    },
    onPatch(listener) {
      patchListeners.add(listener);
      return () => void patchListeners.delete(listener);
    },
    onDocument(listener) {
      documentListeners.add(listener);
      return () => void documentListeners.delete(listener);
    },
    readOnly,
    onRefused(listener) {
      refusedListeners.add(listener);
      return () => void refusedListeners.delete(listener);
    },
    setMemoryGuard(guard) {
      memoryGuard = guard;
    },
    applyRemote(make) {
      deferredRemote.push(make);
      flushRemote();
    },
    remotePending: () => deferredRemote.length,
    afterRemote(run) {
      remoteWaiters.push(run);
      flushRemote();
    },
    setHistoryRebase(rebase) {
      historyRebase = rebase;
    },
    changeSource: () => lastSource,
    ensurePage,
    async ensureAllPages() {
      if (!state.pages) return;
      await Promise.all(state.doc.pages.map(id => ensurePage(id)));
    },
    refreshPage(id) {
      if (!state.pages || state.doc.nodes[id]?.type !== 'PAGE') return Promise.resolve();
      return fetchPage(id);
    },
    evictPage,
    pagesInHistory,
  };
  prepareSpare();
  // The engine's shadow document follows this store's changes when some module runs in wasm (engine-switch.ts).
  followStore(store, {defer: (options.deferShadow ?? typeof requestIdleCallback === 'function') ? idle : undefined});
  return store;
}

function dedupe(ids: readonly NodeId[]): NodeId[] {
  return ids.length < 2 ? [...ids] : [...new Set(ids)];
}
