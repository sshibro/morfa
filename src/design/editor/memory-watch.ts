// The memory watch of an open big file (docs/decisions/big-files.md §5): keeps the estimate of memory-budget.ts current while the
// document, the pages and the renderer's tiles change, lets hidden pages go when the first warning is passed, holds the store's
// memory guard while the budget is full, and tells the indicator (chrome/MemoryIndicator.tsx) through a small external store.
// Nothing runs for a whole document (the switch off): `startMemoryWatch` returns at once and the indicator shows nothing.
import type {NodeId} from '../../../shared/design/types';
import type {DesignStore} from '../engine/store';
import type {DesignSceneRenderer} from '../engine/render';
import {engineMemory, engineWasmLoaded} from '../../../shared/design/engine-switch';
import {estimateMemory, evictionPlan, historyLayersOf, measuredHeapBytes, memoryBudget, memoryWarning, type MemoryEstimate, type MemoryLevel} from './memory-budget';

export type MemoryWatch = {
  /** The current estimate, null for a whole document. */
  estimate(): MemoryEstimate | null;
  subscribe(listener: () => void): () => void;
  /** Recounts now (tests; the watch itself recounts after changes and on a slow timer). */
  refresh(): void;
  stop(): void;
};

const watches = new WeakMap<DesignStore, MemoryWatch>();
const NONE: MemoryWatch = {estimate: () => null, subscribe: () => () => {}, refresh() {}, stop() {}};
const registry = new Set<() => void>();
const notifyRegistry = () => {
  for (const listener of [...registry]) listener();
};

/** The watch of a store (the indicator reads it); one that answers null when none runs. */
export const memoryWatchOf = (store: DesignStore): MemoryWatch => watches.get(store) ?? NONE;
/** Wakes `listener` when a watch starts or stops (the indicator may mount before the session's watch runs). */
export function subscribeMemoryWatches(listener: () => void): () => void {
  registry.add(listener);
  return () => void registry.delete(listener);
}

export type MemoryWatchOptions = {
  renderer?: () => DesignSceneRenderer | null;
  /** The undo and redo entries, for the history's share (the store's are private; the editor passes a reader). */
  history?: () => Iterable<{patch: {nodes?: object}; inverse: {nodes?: object}}>;
  budget?: number;
  /** Called once each time the level rises (the editor shows the warning). */
  onLevel?: (level: MemoryLevel, warning: string | null) => void;
  /** Recount this long after a change (ms); the slow timer runs at ten times it. */
  debounceMs?: number;
  now?: () => number;
  measured?: () => number | null;
  /** The wasm modules' memories (default: the engine's, when it is loaded, and the renderer's from its stats). */
  wasm?: () => number;
};

export function startMemoryWatch(store: DesignStore, options: MemoryWatchOptions = {}): MemoryWatch {
  if (!store.getState().pages) return NONE;
  const budget = options.budget ?? memoryBudget();
  const now = options.now ?? Date.now;
  const measured = options.measured ?? measuredHeapBytes;
  const wasm = options.wasm ?? (() => (engineWasmLoaded() ? engineMemory().buffer.byteLength : 0) + (options.renderer?.()?.stats().wasmBytes ?? 0));
  const debounce = options.debounceMs ?? 500;
  const listeners = new Set<() => void>();
  const lastViewed = new Map<NodeId, number>();
  let estimate: MemoryEstimate = estimateMemory({layers: 0, budget});
  let level: MemoryLevel = 'ok';
  let timer: ReturnType<typeof setTimeout> | null = null;
  let slow: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  lastViewed.set(store.getState().pageId, now());
  // The node count without a scan of the table: a scan of 500 000 keys takes a quarter of a second (the f500k hitch).
  // Every commit that changes the document names the ids it touched (`changed`), so the count moves by those alone. It moves
  // from the last published table (`base`): a gesture's frames are drawn from one scratch table written in place, and each
  // frame names every id that differs from the table the gesture started on. A commit that wrote the published table itself
  // (the store's in-place mode) leaves nothing to compare with: its patch event's inverse says which
  // entries existed before. A table the counter did not see, or a change it could not follow, is counted again whole.
  let base = store.getState().doc.nodes;
  let baseNodes = Object.keys(base).length;
  let table = base;
  let nodes = baseNodes;
  let stale = false;
  let inPlace = false;
  const offCount = store.onDocument(change => {
    const next = change.doc.nodes;
    if (inPlace) stale = true; // the last in-place commit never got its patch event
    if (next === base && change.source !== 'gesture') {
      if (change.changed.size) inPlace = true;
      return;
    }
    let count = baseNodes;
    for (const id of change.changed) count += (Object.hasOwn(next, id) ? 1 : 0) - (Object.hasOwn(base, id) ? 1 : 0);
    table = next;
    nodes = count;
    if (change.source !== 'gesture') {
      base = next;
      baseNodes = count;
    }
  });
  const offWritten = store.onPatch(event => {
    if (!inPlace) return;
    inPlace = false;
    const before = (event as {inverse?: {nodes?: Record<NodeId, unknown>}}).inverse?.nodes;
    if (!before || event.doc.nodes !== base) {
      stale = true;
      return;
    }
    let count = baseNodes;
    for (const id in event.patch.nodes) count += (Object.hasOwn(base, id) ? 1 : 0) - (before[id] ? 1 : 0);
    table = base;
    nodes = baseNodes = count;
  });

  const count = () => {
    const state = store.getState();
    if (stale || state.doc.nodes !== table) {
      stale = false;
      table = base = state.doc.nodes;
      nodes = baseNodes = Object.keys(table).length;
    }
    const layers = nodes - state.doc.pages.length;
    const tileBytes = options.renderer?.()?.stats().tileBytes ?? 0;
    const historyLayers = options.history ? historyLayersOf(options.history()) : 0;
    estimate = estimateMemory({layers: Math.max(0, layers), tileBytes, historyLayers, wasmBytes: wasm(), budget, measured: measured()});
    if (estimate.level !== level) {
      const rose = ['ok', 'warn', 'high', 'full'].indexOf(estimate.level) > ['ok', 'warn', 'high', 'full'].indexOf(level);
      level = estimate.level;
      if (rose) options.onLevel?.(level, memoryWarning(level));
    }
    store.setMemoryGuard(level === 'full' ? () => false : null);
    for (const listener of [...listeners]) listener();
    // Past the first warning: hidden pages go, least recently viewed first, until the estimate is back under half the budget.
    if (estimate.ratio >= 0.6) {
      const plan = evictionPlan(state, estimate, lastViewed, id => state.pages?.layers[id] ?? 0);
      let went = false;
      for (const id of plan) if (store.evictPage(id)) went = true;
      if (went) schedule();
    }
  };
  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      count();
    }, debounce);
  };
  const offDoc = store.subscribe(schedule, {slice: ['doc', 'pages', 'history']});
  const offPage = store.subscribe(() => {
    lastViewed.set(store.getState().pageId, now());
  }, {slice: 'page'});
  slow = setInterval(count, debounce * 10);
  (slow as unknown as {unref?: () => void}).unref?.();
  count();
  const watch: MemoryWatch = {
    estimate: () => estimate,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    refresh: count,
    stop() {
      stopped = true;
      offCount();
      offWritten();
      offDoc();
      offPage();
      if (timer) clearTimeout(timer);
      if (slow) clearInterval(slow);
      store.setMemoryGuard(null);
      if (watches.get(store) === watch) {
        watches.delete(store);
        notifyRegistry();
      }
    },
  };
  watches.set(store, watch);
  notifyRegistry();
  return watch;
}
