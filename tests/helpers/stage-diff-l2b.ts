// The layout stage diff (the general oracle is tests/helpers/stage-diff.ts): the
// TypeScript stage and the Rust stage (crates/layout, through the `morfa-layout-stage` binary) run on the same document
// and dirty set, each on a fresh draft, and their written entries must be equal exactly — the same ids in the same
// order, every node deep-equal with numbers compared by `===` (bit-equal but for the sign of zero, which JSON drops).
// The counters (measured, arranged, textMeasured, textResized, fitted, rounds) must be equal too.
//
// Stages, as normalize.ts runs them: `sizing` (step 0), `textResize` (step 1, `autoResizeText`), `layout`
// (step 3: `LayoutEngine` with `trusted = !ancestry(dirty)`),
// `groupFit` (step 4), and `normalize` (steps 0–4 for a file without instances and variables, through the real
// `normalizeDetailed`). Plus the standalone entries `layoutFrame`, `groupFitUpdates` and `resizeUpdates` (their
// overlay drafts' entries).

import {spawn, spawnSync, type ChildProcessWithoutNullStreams} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {Draft, resizeNode, scaleUpdates} from '../../shared/design/constraints';
import type {Box} from '../../shared/design/constraints';
import {LayoutEngine, layoutSizingUpdates, sizingFixes} from '../../shared/design/layout';
import type {SizingAxis} from '../../shared/design/layout';
import type {LayoutSizing, Vec} from '../../shared/design/types';
import type {LayoutStats} from '../../shared/design/layout';
import {fitGroups} from '../../shared/design/group-fit';
import {ancestry, autoResizeText, emptyNormalizeStats, inFlow, normalizeDetailed} from '../../shared/design/normalize';
import {testMeasurer} from './design-big-files';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export type StageName = 'sizing' | 'textResize' | 'layout' | 'groupFit' | 'normalize';
export const STAGES: StageName[] = ['sizing', 'textResize', 'layout', 'groupFit', 'normalize'];

export type Counters = {measured: number; arranged: number; textMeasured: number; textResized: number; fitted: number; rounds: number};
export type StageResult = {written: [NodeId, SceneNode | null][]; returned: NodeId[] | null; counters: Counters | null};

const zero = (): Counters => ({measured: 0, arranged: 0, textMeasured: 0, textResized: 0, fitted: 0, rounds: 0});

// ── The TypeScript side ──────────────────────────────────────────────────────────────────────────

const entries = (draft: Draft): [NodeId, SceneNode | null][] => [...draft.written].map(id => [id, draft.get(id) ?? null]);

/** Runs one stage the way normalize.ts does, on a fresh table-mode draft over `doc`. */
export function tsStage(stage: StageName, doc: DesignDocument, dirty: readonly NodeId[], measurer: TextMeasurer = testMeasurer): StageResult {
  const counters = zero();
  if (stage === 'normalize') {
    const stats = emptyNormalizeStats();
    const result = normalizeDetailed(doc, new Set(dirty), {measurer, stats});
    return {written: [...result.changed].map(id => [id, result.doc.nodes[id] ?? null]), returned: null, counters: {...stats}};
  }
  const draft = new Draft(doc, {mode: 'table'});
  let returned: Set<NodeId>;
  switch (stage) {
    case 'sizing': {
      const fix = (target: SceneNode | undefined) => {
        if (!target) return;
        const fixes = sizingFixes(target, draft.get(target.parentId));
        if (fixes) draft.update(target.id, fixes);
      };
      returned = draft.collect(() => {
        for (const id of dirty) {
          const node = draft.get(id);
          if (!node) continue;
          fix(node);
          const children = node.children;
          if (children) for (let i = 0; i < children.length; i++) fix(draft.get(children[i]));
        }
      });
      break;
    }
    case 'textResize':
      returned = draft.collect(() => {
        for (const id of dirty) {
          const node = draft.get(id);
          if (node?.type === 'TEXT' && !inFlow(draft, node) && autoResizeText(draft, node, measurer)) counters.textResized++;
        }
      });
      break;
    case 'layout': {
      const p = ancestry(draft, dirty);
      const stats: LayoutStats = {measured: 0, arranged: 0, textMeasured: 0};
      const engine = new LayoutEngine(draft, measurer, {trusted: id => !p.has(id), stats});
      returned = draft.collect(() => engine.run(dirty));
      Object.assign(counters, stats);
      break;
    }
    case 'groupFit':
      returned = draft.collect(() => fitGroups(draft, dirty, counters));
      break;
  }
  return {written: entries(draft), returned: [...returned], counters};
}

/** The standalone entries, as overlay drafts (their `updates` are built from these entries). */
export function tsLayoutFrame(doc: DesignDocument, id: NodeId): StageResult {
  const draft = new Draft(doc, {mode: 'table'});
  const stats: LayoutStats = {measured: 0, arranged: 0, textMeasured: 0};
  new LayoutEngine(draft, testMeasurer, {stats}).run([id]);
  return {written: entries(draft), returned: null, counters: {...zero(), ...stats}};
}

/** `returned`: the ids removed, in `Draft.removed`'s order (what groupFitUpdates returns as `removed`). */
export function tsGroupFit(doc: DesignDocument, ids: NodeId[]): StageResult {
  const draft = new Draft(doc, {mode: 'table'});
  fitGroups(draft, ids);
  return {written: entries(draft), returned: [...draft.removed], counters: null};
}

export function tsResize(doc: DesignDocument, id: NodeId, box: Box): StageResult {
  const draft = new Draft(doc, {mode: 'table'});
  resizeNode(draft, id, box, 'hand');
  return {written: entries(draft), returned: null, counters: null};
}

/** `scaleUpdates` and `layoutSizingUpdates` are overlay drafts that return only `updates`: their entries are the base
 *  nodes with the updates merged, the ids in the order first updated. */
function fromUpdates(doc: DesignDocument, updates: Map<NodeId, Partial<SceneNode>>): StageResult {
  return {written: [...updates].map(([id, fields]) => [id, {...doc.nodes[id], ...fields} as SceneNode]), returned: null, counters: null};
}

export const tsScale = (doc: DesignDocument, ids: NodeId[], origin: Vec, sx: number, sy: number) => fromUpdates(doc, scaleUpdates(doc, ids, origin, sx, sy));
export const tsLayoutSizing = (doc: DesignDocument, id: NodeId, axis: SizingAxis, sizing: LayoutSizing) => fromUpdates(doc, layoutSizingUpdates(doc, id, axis, sizing));

// ── The Rust side ────────────────────────────────────────────────────────────────────────────────

export const targetDir = () => process.env.CARGO_TARGET_DIR ?? path.join(os.homedir(), '.cache', 'morfa-target', 'L2b');
export const binary = () => path.join(targetDir(), 'release', 'morfa-layout-stage');

/** Builds the binary (release) once per process. */
let built = false;
export function buildRust(): void {
  if (built) return;
  const run = spawnSync('cargo', ['build', '--release', '-p', 'morfa-layout', '--bin', 'morfa-layout-stage'], {cwd: repo, stdio: 'inherit', env: {...process.env, CARGO_TARGET_DIR: targetDir()}});
  if (run.status !== 0) throw new Error('cargo build of morfa-layout-stage failed');
  built = true;
}

/** The binary as a line-protocol server. Requests are answered in order. */
export class RustStages {
  private child: ChildProcessWithoutNullStreams;
  private buffer = '';
  private waiting: ((line: string) => void)[] = [];
  private tmp = path.join(os.tmpdir(), `l2b-stage-${process.pid}-${Math.random().toString(36).slice(2)}.json`);

  constructor() {
    buildRust();
    this.child = spawn(binary(), [], {stdio: ['pipe', 'pipe', 'pipe']});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let at;
      while ((at = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at + 1);
        this.waiting.shift()?.(line);
      }
    });
    this.child.stderr.on('data', chunk => process.stderr.write(chunk));
    this.child.on('exit', code => {
      for (const resolve of this.waiting.splice(0)) resolve(JSON.stringify({ok: false, error: `morfa-layout-stage exited (${code})`}));
    });
  }

  private ask(request: unknown): Promise<any> {
    return new Promise(resolve => {
      this.waiting.push(line => resolve(JSON.parse(line)));
      this.child.stdin.write(`${JSON.stringify(request)}\n`);
    });
  }

  async load(doc: DesignDocument): Promise<void> {
    fs.writeFileSync(this.tmp, JSON.stringify(doc));
    const answer = await this.ask({cmd: 'load', path: this.tmp});
    if (!answer.ok) throw new Error(`load: ${answer.error}`);
  }

  async run(request: Record<string, unknown>): Promise<StageResult> {
    const answer = await this.ask(request);
    if (!answer.ok) throw new Error(`${request.cmd}: ${answer.error}`);
    return {written: answer.written, returned: answer.returned, counters: answer.counters};
  }

  stage = (stage: StageName, dirty: readonly NodeId[]) => this.run(stage === 'normalize' ? {cmd: 'normalize', dirty} : {cmd: 'stage', stage, dirty});
  layoutFrame = (id: NodeId) => this.run({cmd: 'layoutFrame', id});
  groupFit = (ids: NodeId[]) => this.run({cmd: 'groupFit', ids});
  resize = (id: NodeId, box: Box) => this.run({cmd: 'resize', id, box: [box.x, box.y, box.width, box.height]});
  scale = (ids: NodeId[], origin: Vec, sx: number, sy: number) => this.run({cmd: 'scale', ids, origin: [origin.x, origin.y], sx, sy});
  layoutSizing = (id: NodeId, axis: SizingAxis, sizing: LayoutSizing) => this.run({cmd: 'layoutSizing', id, axis, sizing});

  async time(stage: StageName, dirty: readonly NodeId[], runs: number): Promise<number[]> {
    const answer = await this.ask({cmd: 'time', stage, dirty, runs});
    if (!answer.ok) throw new Error(`time: ${answer.error}`);
    return answer.ns;
  }

  close(): void {
    this.child.stdin.end();
    fs.rmSync(this.tmp, {force: true});
  }
}

/** The same stages through the wasm build (crates/layout/wasm-l2b, `wasm-pack build … --target nodejs --out-dir pkg`):
 *  sine and cosine come from V8's Math there, as in the browser. */
export class WasmStages {
  private handle: number | null = null;
  constructor(private readonly mod: WasmModule = loadWasm()) {}

  async load(doc: DesignDocument): Promise<void> {
    if (this.handle !== null) this.mod.l2b_drop(this.handle);
    this.handle = this.mod.l2b_load(JSON.stringify(doc));
  }

  /** The wasm entries carry no counters or returned ids: the binary checks those. */
  private result(json: string): StageResult {
    return {written: JSON.parse(json), returned: null, counters: null};
  }

  stage = async (stage: StageName, dirty: readonly NodeId[]): Promise<StageResult> => {
    if (stage === 'normalize') throw new Error('normalize runs through the binary only');
    return this.result(this.mod.l2b_stage(this.handle!, stage, dirty.join('\n'), true));
  };
  layoutFrame = async (id: NodeId) => this.result(this.mod.l2b_layout_frame(this.handle!, id, true));
  groupFit = async (ids: NodeId[]) => this.result(this.mod.l2b_group_fit(this.handle!, ids.join('\n'), true));
  resize = async (id: NodeId, box: Box) => this.result(this.mod.l2b_resize(this.handle!, id, box.x, box.y, box.width, box.height, true));

  close(): void {
    if (this.handle !== null) this.mod.l2b_drop(this.handle);
  }
}

export type WasmModule = {
  l2b_load(json: string): number;
  l2b_drop(handle: number): void;
  l2b_apply_patch(handle: number, json: string): void;
  l2b_stage(handle: number, stage: string, dirty: string, serialize: boolean): string;
  l2b_layout_frame(handle: number, id: string, serialize: boolean): string;
  l2b_group_fit(handle: number, ids: string, serialize: boolean): string;
  l2b_resize(handle: number, id: string, x: number, y: number, width: number, height: number, serialize: boolean): string;
  l2b_layout_counters(): Float64Array;
};

export const wasmPackage = () => path.join(repo, 'crates', 'layout', 'wasm-l2b', 'pkg', 'morfa_layout_wasm_l2b.js');

/** Builds (if missing) and loads the lane's wasm package. */
export function loadWasm(): WasmModule {
  if (!fs.existsSync(wasmPackage())) {
    const run = spawnSync('wasm-pack', ['build', 'crates/layout/wasm-l2b', '--release', '--target', 'nodejs', '--out-dir', 'pkg'], {cwd: repo, stdio: 'inherit'});
    if (run.status !== 0) throw new Error('wasm-pack build of crates/layout/wasm-l2b failed');
  }
  return createRequire(import.meta.url)(wasmPackage()) as WasmModule;
}

// ── Comparing ────────────────────────────────────────────────────────────────────────────────────

/** Strings that differ only by a lone UTF-16 surrogate, which a Rust string cannot hold (the model reads it as U+FFFD). Counted, compared after `toWellFormed()`. */
export const loneSurrogates = {count: 0, example: ''};

/** The first difference between two JSON values (undefined keys dropped, numbers by `===`), or null. */
export function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  if (typeof a === 'number' && typeof b === 'number') {
    if (a === b || (Number.isNaN(a) && Number.isNaN(b))) return null;
    return `${at}: ${a} ≠ ${b} (Δ ${Math.abs(a - b)})`;
  }
  if (a === b) return null;
  if (typeof a === 'string' && typeof b === 'string' && (a as string & {toWellFormed(): string}).toWellFormed() === (b as string & {toWellFormed(): string}).toWellFormed()) {
    loneSurrogates.count++;
    loneSurrogates.example ||= at;
    return null;
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return `${at}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${at}: array vs object`;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return `${at}: length ${a.length} ≠ ${other.length}`;
    for (let i = 0; i < a.length; i++) {
      const d = firstDifference(a[i], other[i], `${at}[${i}]`);
      if (d) return d;
    }
    return null;
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left).filter(k => left[k] !== undefined), ...Object.keys(right).filter(k => right[k] !== undefined)]);
  for (const key of keys) {
    const d = firstDifference(left[key], right[key], `${at}.${key}`);
    if (d) return d;
  }
  return null;
}

/** The largest |Δ| over all numbers of two JSON values of the same shape (for the 1e-9 report). */
export function largestDelta(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a === b ? 0 : Math.abs(a - b);
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return 0;
  let worst = 0;
  for (const key of Object.keys(a as object)) worst = Math.max(worst, largestDelta((a as any)[key], (b as any)[key]));
  return worst;
}

/** Compares two results: null when equal, else the first difference. */
export function compareResults(ts: StageResult, rust: StageResult): string | null {
  const tsIds = ts.written.map(([id]) => id), rustIds = rust.written.map(([id]) => id);
  if (tsIds.join('\u0000') !== rustIds.join('\u0000')) {
    const missing = tsIds.filter(id => !rustIds.includes(id)), extra = rustIds.filter(id => !tsIds.includes(id));
    return `written ids differ: ts ${tsIds.length}, rust ${rustIds.length}; only ts [${missing.slice(0, 5)}], only rust [${extra.slice(0, 5)}]${missing.length || extra.length ? '' : ' (order)'}`;
  }
  // The TypeScript's nodes go through JSON as the Rust's do (undefined keys dropped).
  for (let i = 0; i < ts.written.length; i++) {
    const d = firstDifference(JSON.parse(JSON.stringify(ts.written[i][1])), rust.written[i][1], tsIds[i]);
    if (d) return d;
  }
  if (ts.returned && rust.returned && ts.returned.join('\u0000') !== rust.returned.join('\u0000')) return `returned ids differ: ts [${ts.returned.slice(0, 8)}] rust [${rust.returned.slice(0, 8)}]`;
  if (ts.counters && rust.counters) {
    for (const key of Object.keys(ts.counters) as (keyof Counters)[]) {
      if (ts.counters[key] !== rust.counters[key]) return `counter ${key}: ts ${ts.counters[key]} rust ${rust.counters[key]}`;
    }
  }
  return null;
}
