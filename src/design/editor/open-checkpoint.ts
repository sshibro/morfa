import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {PART_NODES, readPart, type PartSource} from '../../../shared/design/parts';

// The open of a big file from its checkpoint: the document is decoded in wasm
// (`MorfaDoc.decode_from`) and crosses to the store part by part (`part_json`), never as one text. The parts are read
// in slices that keep the main thread answering: each slice is sized to a time budget, measured as it goes (a part of 2 000
// nodes is ~18 ms on a laptop and ~60 ms in the cloud container at 2×), and the loader yields between slices.

/** A decoded document as the loader reads it: its parts and its head (everything but `nodes`). */
export interface CheckpointSource extends PartSource {
  /** The document without `nodes` as JSON (lane W: `MorfaDoc.tables_json`). */
  tables_json(): string;
}

export type PartLoadOptions = {
  /** Main-thread time one slice may take before the loader yields (ms). */
  budgetMs?: number;
  /** Nodes in the first part; later parts follow the budget. */
  first?: number;
  /** Bounds of a part's size whatever the budget says. */
  min?: number;
  max?: number;
  signal?: AbortSignal;
  /** How the loader gives the main thread back between slices (tests pass their own). */
  yieldNow?: () => Promise<void>;
  now?: () => number;
  onProgress?: (done: number, of: number) => void;
};

export type PartLoadStats = {parts: number; slices: number; nodes: number; largest: number; smallest: number; ms: number};

const nextTask = () => new Promise<void>(resolve => setTimeout(resolve, 0));

/** The whole document from `source`: its head, and every node from its parts in slot order (the file's key order). */
export async function documentFromParts(source: CheckpointSource, options: PartLoadOptions = {}): Promise<{doc: DesignDocument; stats: PartLoadStats}> {
  const budget = options.budgetMs ?? 8;
  const min = options.min ?? 100;
  const max = options.max ?? 20_000;
  const now = options.now ?? (() => performance.now());
  const yieldNow = options.yieldNow ?? nextTask;
  const started = now();
  const head = JSON.parse(source.tables_json()) as Omit<DesignDocument, 'nodes'> & {nodes?: unknown};
  const nodes: Record<NodeId, SceneNode> = {};
  const slots = source.part_slots();
  const stats: PartLoadStats = {parts: 0, slices: 0, nodes: 0, largest: 0, smallest: Infinity, ms: 0};
  let count = Math.max(min, Math.min(max, options.first ?? Math.round(PART_NODES / 2)));
  let start = 0;
  while (start < slots) {
    options.signal?.throwIfAborted();
    const slice = now();
    stats.slices++;
    // Parts until the slice's budget is spent; the next part's size follows the time per slot measured so far.
    do {
      const size = Math.min(count, slots - start);
      const before = now();
      const part = readPart(source.part_json(start, size, true));
      for (const id in part) {
        nodes[id] = part[id];
        stats.nodes++;
      }
      const spent = now() - before;
      start += size;
      stats.parts++;
      stats.largest = Math.max(stats.largest, size);
      stats.smallest = Math.min(stats.smallest, size);
      // A part should take about half a slice: two fit, and one slow part never takes much more than the budget.
      if (spent > 0) count = Math.max(min, Math.min(max, Math.round((size * budget) / 2 / spent)));
    } while (start < slots && now() - slice < budget);
    options.onProgress?.(start, slots);
    if (start < slots) await yieldNow();
  }
  stats.ms = now() - started;
  return {doc: {...head, nodes} as DesignDocument, stats};
}
