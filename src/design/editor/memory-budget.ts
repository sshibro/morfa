// The memory budget of a big file (docs/decisions/big-files.md §5, docs/TARGETS.md §9): Figma limits a file to 2 GB per browser
// tab, warns at 60 % and 75 %, and loads pages on demand. Morfa, with the big-files switch on, keeps an estimate of what the open
// file costs the tab — the layers the store holds, the renderer's tiles, the undo history — against a budget, shows it under the
// file name (chrome/MemoryIndicator.tsx), lets hidden pages go when the estimate passes the first warning, and refuses edits that
// would grow the document when the budget is full. The estimate is deterministic (tests); the browser's own number is shown
// beside it where Chromium gives one. Pure functions here; `startMemoryWatch` (memory-watch.ts) runs them for a session.
import type {NodeId} from '../../../shared/design/types';
import type {EditorState} from '../engine/store';

const GiB = 1024 * 1024 * 1024;
/** Figma's limit per tab. */
export const MEMORY_BUDGET_BYTES = 2 * GiB;
/** The first warning: hidden pages are let go from here. */
export const MEMORY_WARN_AT = 0.6;
/** The second warning. */
export const MEMORY_HIGH_AT = 0.75;
/** Eviction stops once the estimate is back under this share of the budget. */
export const MEMORY_EVICT_TO = 0.5;
/** What one layer costs the JS heap as the editor holds it: f500k's 500 000 layers leave 892 MB of heap after garbage
 *  collection, about 1 800 B a layer; f100k's 162–195 MB for 100 201 agree.
 *  (W's shared values, BIG stage B, bring it to about 1 100 once they are the open path.) The wasm shadows are counted apart,
 *  from their memories (`MemoryEstimate.wasm`). */
export const BYTES_PER_LAYER = 1_800;
/** An undo step's patch: whole nodes, both ways (patch and inverse), per layer it touched. */
export const BYTES_PER_HISTORY_LAYER = 2 * BYTES_PER_LAYER;

export type MemoryLevel = 'ok' | 'warn' | 'high' | 'full';

export type MemoryEstimate = {
  budget: number;
  /** Layers the store holds (every page it loaded, the skeleton's components included). */
  layers: number;
  document: number;
  tiles: number;
  history: number;
  /** The wasm modules' memories: the engine's shadow document and the renderer's (its document, pictures and sprites). */
  wasm: number;
  total: number;
  /** total / budget. */
  ratio: number;
  level: MemoryLevel;
  /** The browser's own number for the tab's JS heap when it gives one (Chromium's performance.memory), else null. */
  measured: number | null;
};

/** The budget on this device: 2 GiB, or a quarter of a small device's memory (`navigator.deviceMemory`, GB, Chromium only). */
export function memoryBudget(deviceMemoryGb: number | undefined = typeof navigator !== 'undefined' ? (navigator as {deviceMemory?: number}).deviceMemory : undefined): number {
  if (!deviceMemoryGb || !(deviceMemoryGb > 0) || deviceMemoryGb >= 8) return MEMORY_BUDGET_BYTES;
  return Math.min(MEMORY_BUDGET_BYTES, Math.max(GiB / 2, (deviceMemoryGb / 4) * GiB));
}

export function memoryLevel(ratio: number): MemoryLevel {
  return ratio >= 1 ? 'full' : ratio >= MEMORY_HIGH_AT ? 'high' : ratio >= MEMORY_WARN_AT ? 'warn' : 'ok';
}

export function estimateMemory(input: {layers: number; historyLayers?: number; tileBytes?: number; wasmBytes?: number; budget?: number; measured?: number | null}): MemoryEstimate {
  const budget = input.budget ?? MEMORY_BUDGET_BYTES;
  const document = input.layers * BYTES_PER_LAYER;
  const history = (input.historyLayers ?? 0) * BYTES_PER_HISTORY_LAYER;
  const tiles = input.tileBytes ?? 0;
  const wasm = input.wasmBytes ?? 0;
  const total = document + tiles + history + wasm;
  const ratio = budget > 0 ? total / budget : 0;
  return {budget, layers: input.layers, document, tiles, history, wasm, total, ratio, level: memoryLevel(ratio), measured: input.measured ?? null};
}

/** The layers of one history step (whole nodes both ways), from its node counts. */
export const historyLayersOf = (entries: Iterable<{patch: {nodes?: object}; inverse: {nodes?: object}}>): number => {
  let layers = 0;
  for (const entry of entries) layers += Object.keys(entry.patch.nodes ?? {}).length + Object.keys(entry.inverse.nodes ?? {}).length;
  return layers / 2;
};

/** The browser's number for the tab's JS heap (Chromium's `performance.memory`), null elsewhere. */
export function measuredHeapBytes(perf: unknown = typeof performance !== 'undefined' ? performance : undefined): number | null {
  const memory = (perf as {memory?: {usedJSHeapSize?: number}} | undefined)?.memory;
  return memory && typeof memory.usedJSHeapSize === 'number' ? memory.usedJSHeapSize : null;
}

/**
 * The pages to let go, least recently viewed first, until the estimate is back under `MEMORY_EVICT_TO`: never the current page
 * or a loading one (the store refuses those and the pages in the history or with unsaved changes by itself). `lastViewed` is
 * when each page was last shown (a page never shown ranks first).
 */
export function evictionPlan(state: Pick<EditorState, 'pages' | 'pageId'>, estimate: MemoryEstimate, lastViewed: ReadonlyMap<NodeId, number>, layersOf: (pageId: NodeId) => number): NodeId[] {
  const pages = state.pages;
  if (!pages || estimate.ratio < MEMORY_WARN_AT) return [];
  const candidates = [...pages.loaded].filter(id => id !== state.pageId && !pages.loading.has(id)).sort((a, b) => (lastViewed.get(a) ?? 0) - (lastViewed.get(b) ?? 0));
  const plan: NodeId[] = [];
  let total = estimate.total;
  for (const id of candidates) {
    if (total <= estimate.budget * MEMORY_EVICT_TO) break;
    plan.push(id);
    total -= layersOf(id) * BYTES_PER_LAYER;
  }
  return plan;
}

const GB_LABEL = (bytes: number) => (bytes / GiB).toLocaleString('en-US', {maximumFractionDigits: 1});
const MB_LABEL = (bytes: number) => Math.round(bytes / (1024 * 1024)).toLocaleString('en-US');
export const memoryAmount = (bytes: number): string => (bytes >= GiB / 2 ? `${GB_LABEL(bytes)} GB` : `${MB_LABEL(bytes)} MB`);

/** "File memory: 38%". */
export const memoryLabel = (estimate: MemoryEstimate): string => `File memory: ${Math.min(999, Math.round(estimate.ratio * 100))}%`;

/** The tooltip: what is counted and the browser's own number. */
export function memoryDetails(estimate: MemoryEstimate, pages: {loaded: number; total: number} | null): string {
  const lines = [`Estimate: ${memoryAmount(estimate.total)} of ${memoryAmount(estimate.budget)} — ${estimate.layers.toLocaleString('en-US')} layers in memory` + (pages ? `, pages loaded ${pages.loaded} of ${pages.total}` : '')];
  if (estimate.tiles) lines.push(`Canvas cache: ${memoryAmount(estimate.tiles)}`);
  if (estimate.history) lines.push(`Edit history: ${memoryAmount(estimate.history)}`);
  if (estimate.wasm) lines.push(`Engine and rendering (wasm): ${memoryAmount(estimate.wasm)}`);
  if (estimate.measured !== null) lines.push(`Browser: ${memoryAmount(estimate.measured)} used by the tab`);
  return lines.join('\n');
}

/** The warning for a level, null when there is none (Figma's words, in Russian). */
export function memoryWarning(level: MemoryLevel): string | null {
  switch (level) {
    case 'warn':
      return 'This file uses a lot of memory: hidden pages are unloaded. Split the file if it keeps growing.';
    case 'high':
      return "This file has almost used up the tab's memory. Close extra pages or split the file.";
    case 'full':
      return 'The tab is out of memory: changes that grow the file are not applied. Split the file.';
    default:
      return null;
  }
}
