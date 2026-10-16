import type {DesignDocument, NodeId, SceneNode} from './types';
import type {DocumentPatch} from './patch';
import {bigFilesEnabled} from './big-files';

// The engine switch. Every TypeScript module ported to Rust runs as
//   ts    the TypeScript only (Node's default; the editor's per module is `EDITOR_DEFAULTS`),
//   wasm  the Rust build (crates/wasm) only,
//   both  both, compared: any difference throws an EngineDiffError naming the module, the call, a digest of the
//         inputs and the first differing path; the TypeScript answer is returned. This is the differential oracle.
// Counters per module (`engineCalls`) let a test assert that the wasm side really ran: a switch that silently fell
// back to TypeScript would otherwise pass every test (fake green).
//
// Selection, first match wins: `setEngine` (tests); in Node `MORFA_ENGINE_<MODULE>` then `MORFA_ENGINE`, else `ts`
// (`MORFA_ENGINE=editor`: the editor's defaults); in the browser `globalThis.__MORFA_ENGINE__` (a mode, or {module:
// mode, '*': mode}) then `?engine=` in the address (`?engine=both` or `?engine=geometry:both,ops:wasm`), else
// `EDITOR_DEFAULTS`. An unknown value throws: a typo never means `ts`.
//
// The wasm module is crates/wasm built by scripts/wasm-build.sh. Node loads server/design/wasm on first use; the
// browser loads src/design/wasm lazily (src/design/engine/engine-wasm.ts `loadEngineWasm`) before the editor opens
// when any module is not `ts`. A module in `wasm`/`both` with no wasm loaded throws; it never falls back.
//
// The shadow document: one crates/wasm `MorfaDoc` kept equal to the document the modules are asked about.
// `followStore` feeds it from the editor store (every committed patch is applied at once, `replace` reloads; drag
// frames are applied when a module next reads them), and `shadowFor(doc)` brings it to any other document by
// comparing tables entry by entry (entries are immutable, so identity is equality). Module entry points then take
// an id and a few numbers, never scene subtrees.

export type EngineModule = 'geometry' | 'ops' | 'normalize' | 'text' | 'render' | 'export';
export const ENGINE_MODULES: readonly EngineModule[] = ['geometry', 'ops', 'normalize', 'text', 'render', 'export'];
export type EngineMode = 'ts' | 'wasm' | 'both';
const MODES: readonly EngineMode[] = ['ts', 'wasm', 'both'];

// ── Selection ───────────────────────────────────────────────────────────────────────────────────────────────────

type Env = Record<string, string | undefined>;
const runtime = globalThis as unknown as {
  process?: {env?: Env; versions?: {node?: string}; getBuiltinModule?: (name: string) => unknown; on?: (event: string, listener: () => void) => void};
  location?: {search?: string};
  __MORFA_ENGINE__?: string | Partial<Record<EngineModule | '*', string>>;
};
const nodeEnv = (): Env | undefined => (runtime.process?.versions?.node ? runtime.process.env : undefined);

/** What the editor runs when nothing chooses a module's mode. A module defaults to `wasm` only once the full
 *  suite in `both` shows 0 diffs and wasm is faster end to end on its bench rows;
 *  TypeScript stays its oracle. In the browser this is the fallback of every module; in Node
 *  (the server, tests, benches) every module stays `ts` unless asked, and `MORFA_ENGINE=editor` runs this table. */
export const EDITOR_DEFAULTS: Readonly<Record<EngineModule, EngineMode>> = {
  // Readers through the shadow (worldBox, worldMatrix), booleans and the outline stroke: 1.04–3.5× in Chromium at a
  // 2× CPU throttle, 1.2–7× in Node; localMatrix stays in TypeScript (geometry.ts).
  geometry: 'wasm',
  ops: 'ts',
  // The whole normalize pass (layout, constraints, group fit, text resize, instances, variants, variables) on the shadow
  // document's own nodes (crates/layout): 1.2–2.9× TypeScript in Chromium at a 2× CPU throttle on every bench
  // row over three consecutive runs, exact against the TypeScript pass (`both`: 0 diffs). By default it keeps to the
  // shadow's reach as geometry's readers do: never a load inside a commit; TypeScript answers until the idle preload is
  // in (normalize.ts `wasmInput`).
  normalize: 'wasm',
  text: 'ts',
  render: 'ts',
  export: 'ts',
};

const overrides = new Map<EngineModule | '*', EngineMode>();
/** Per module: whether its mode was chosen (setEngine, the environment, `?engine=`, `__MORFA_ENGINE__`) rather than
 *  taken from `EDITOR_DEFAULTS`. */
let chosen: Record<EngineModule, boolean> | null = null;
/** Resolved modes; `null` until read (and after `setEngine`). Hot paths read this array, not the environment. */
let resolved: Record<EngineModule, EngineMode> | null = null;

function parseMode(value: string, where: string): EngineMode {
  const mode = value.trim().toLowerCase();
  if ((MODES as readonly string[]).includes(mode)) return mode as EngineMode;
  throw new Error(`engine-switch: ${where} is '${value}'; expected ts, wasm or both`);
}

/** `both` or `geometry:both,ops:wasm` (the browser's ?engine=) as module → mode. */
function parseList(value: string, where: string): Partial<Record<EngineModule | '*', EngineMode>> {
  const out: Partial<Record<EngineModule | '*', EngineMode>> = {};
  for (const part of value.split(',').map(item => item.trim()).filter(Boolean)) {
    const colon = part.indexOf(':');
    if (colon < 0) {
      out['*'] = parseMode(part, where);
      continue;
    }
    const module = part.slice(0, colon).trim() as EngineModule;
    if (!ENGINE_MODULES.includes(module)) throw new Error(`engine-switch: ${where} names an unknown module '${module}'`);
    out[module] = parseMode(part.slice(colon + 1), where);
  }
  return out;
}

function resolve(): Record<EngineModule, EngineMode> {
  const env = nodeEnv();
  let browser: Partial<Record<EngineModule | '*', EngineMode>> = {};
  if (!env) {
    const global = runtime.__MORFA_ENGINE__;
    if (typeof global === 'string') browser = parseList(global, '__MORFA_ENGINE__');
    else if (global && typeof global === 'object')
      for (const [key, value] of Object.entries(global)) if (value) browser = {...browser, ...parseList(key === '*' ? value : `${key}:${value}`, '__MORFA_ENGINE__')};
    const query = runtime.location?.search ? new URLSearchParams(runtime.location.search).get('engine') : null;
    if (query) browser = {...parseList(query, '?engine='), ...browser};
  }
  const out = {} as Record<EngineModule, EngineMode>;
  chosen = {} as Record<EngineModule, boolean>;
  const editor = env?.MORFA_ENGINE?.trim().toLowerCase() === 'editor';
  for (const module of ENGINE_MODULES) {
    const name = `MORFA_ENGINE_${module.toUpperCase()}`;
    const forced = overrides.get(module) ?? overrides.get('*');
    const picked =
      forced ??
      (env?.[name]
        ? parseMode(env[name]!, name)
        : env?.MORFA_ENGINE && !editor
          ? parseMode(env.MORFA_ENGINE, 'MORFA_ENGINE')
          : (browser[module] ?? browser['*']));
    chosen[module] = picked !== undefined;
    out[module] = crash ? 'ts' : (picked ?? (env && !editor ? 'ts' : EDITOR_DEFAULTS[module]));
  }
  return out;
}

/** True when a module runs other than `ts` only because `EDITOR_DEFAULTS` says so (nobody chose it): the editor then
 *  loads the wasm in the background instead of waiting for it, and the module's calls let TypeScript answer until it
 *  is in (geometry's readers decline, `geometry-wasm.ts` falls back). */
export const engineByDefault = (module: EngineModule): boolean => {
  resolved ??= resolve();
  return !chosen![module] && resolved[module] !== 'ts';
};

/** The mode a module runs in. */
export const engineFor = (module: EngineModule): EngineMode => (resolved ??= resolve())[module];

/** True when some module needs the wasm build (the editor then loads it, and the store feeds the shadow). */
export const anyWasmEngine = (): boolean => ENGINE_MODULES.some(module => engineFor(module) !== 'ts');

/** Forces a module's mode (`'*'`: every module without its own); `null` returns it to the environment's choice.
 *  For tests and benches. Returns a function that puts the previous setting back. */
export function setEngine(module: EngineModule | '*', mode: EngineMode | null): () => void {
  const previous = overrides.get(module) ?? null;
  if (mode) overrides.set(module, parseMode(mode, `setEngine('${module}')`));
  else overrides.delete(module);
  resolved = null;
  return () => void setEngine(module, previous);
}

// ── Rust crashes ────────────────────────────────────────────────────────────────────────────────────────────────

/** The first Rust crash of this session, or null. A panic traps the module mid-call (`WebAssembly.RuntimeError`):
 *  the frames it stopped keep their share of the module's stack and whatever they had borrowed stays borrowed, so the
 *  shadow refuses every later call (wasm-bindgen's "recursive use of an object"), and each refused call leaks a little
 *  more stack until the module's memory is overwritten: a new document then traps too (after tens of thousands of
 *  refused patches, or under a thousand repeated panics, in Node). So after one crash every module runs as `ts` for the
 *  rest of the session whatever was chosen, the shadow is dropped without another call into it, nothing loads a new
 *  one, and the call that crashed is answered by its TypeScript in `wasm` mode (in `both` it throws: a test must see
 *  it). tests/design-engine-crash.test.ts. */
export type EngineCrash = {module: EngineModule | 'shadow'; call: string; message: string};
let crash: EngineCrash | null = null;

export const engineCrash = (): EngineCrash | null => crash;

/** Forgets the crash (tests; `setEngineWasm` too: a module installed afresh is a new instance). */
export function clearEngineCrash(): void {
  crash = null;
  resolved = null;
}

/** Whether `error` (or its cause) is a trap of a wasm module, the stack overflow of one, or wasm-bindgen refusing an
 *  object a trap left borrowed (nothing else holds a borrow across calls). */
function isCrash(error: unknown): boolean {
  for (let each = error, depth = 0; each instanceof Error && depth < 4; each = each.cause, depth++) {
    if (each instanceof WebAssembly.RuntimeError) return true;
    if (each instanceof RangeError && each.message.includes('call stack')) return true;
    if (each.message.includes('recursive use of an object')) return true;
  }
  return false;
}

/** Records a crash (the first one's module, call and panic message) and turns the engine off for the session. */
function crashed(module: EngineCrash['module'], call: string, error: unknown): void {
  if (!crash) {
    let panic = '';
    try {
      panic = wasmModule?.last_panic?.() ?? '';
    } catch {
      // The panic hook's own cell may be what broke.
    }
    crash = {module, call, message: panic || (error instanceof Error ? error.message : String(error))};
    console.error(`engine-switch: the Rust engine crashed in ${module}.${call} (${crash.message}); TypeScript answers from now on`, error);
  }
  resolved = null;
  preloading?.cancel();
  preloading = null;
  // Dropped, not freed: freeing it would be one more call into the trapped module.
  shadow = null;
}

// ── Counters ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Calls per module since the last reset. In `both` a call counts once in `ts`, once in `wasm` and once in `both`.
 *  `fallback`: wasm said it cannot represent the input (EngineUnsupported) and TypeScript answered alone. `skipped`:
 *  `both` declined to compare a call it could have run (EngineSkipped: the oracle's work would be the edit's). */
export type EngineCalls = {ts: number; wasm: number; both: number; fallback: number; diffs: number; skipped: number};
const zero = (): EngineCalls => ({ts: 0, wasm: 0, both: 0, fallback: 0, diffs: 0, skipped: 0});
const counters = Object.fromEntries(ENGINE_MODULES.map(module => [module, zero()])) as Record<EngineModule, EngineCalls>;
/** Per call: module → call name → counts (two lookups of interned strings: a `module.call` key built per call would be
 *  a string concatenation and a hash on the hot path). */
const perCall = new Map<EngineModule, Map<string, EngineCalls>>();
function callCounts(module: EngineModule, call: string): EngineCalls {
  let calls = perCall.get(module);
  if (!calls) perCall.set(module, (calls = new Map()));
  let counts = calls.get(call);
  if (!counts) calls.set(call, (counts = zero()));
  return counts;
}

export const engineCalls = (module: EngineModule): EngineCalls => ({...counters[module]});
/** Counts per `module.call`, for reports. */
export const engineCallTable = (): Record<string, EngineCalls> =>
  Object.fromEntries([...perCall].flatMap(([module, calls]) => [...calls].map(([call, counts]) => [`${module}.${call}`, {...counts}])));
export function resetEngineCalls(module?: EngineModule): void {
  for (const each of module ? [module] : ENGINE_MODULES) {
    Object.assign(counters[each], zero());
    perCall.delete(each);
  }
}

/** Throws unless the module's wasm side answered at least once and never fell back: the fake-green guard a test
 *  runs after exercising a module in `wasm` or `both`. */
export function assertWasmRan(module: EngineModule, options: {allowFallback?: boolean} = {}): EngineCalls {
  const counts = engineCalls(module);
  if (engineFor(module) === 'ts') throw new Error(`engine-switch: ${module} runs as ts; the wasm side cannot have run`);
  if (!counts.wasm) throw new Error(`engine-switch: ${module} made no wasm call (${JSON.stringify(counts)})`);
  if (counts.fallback && !options.allowFallback) throw new Error(`engine-switch: ${module} fell back to TypeScript ${counts.fallback} times`);
  return counts;
}

// ── Comparison ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Numeric tolerance per module: |a − b| ≤ tol · max(1, |a|, |b|). 0 is exact (Object.is, so −0 ≠ 0; NaN = NaN). */
const tolerances: Record<EngineModule, number> = {geometry: 1e-9, ops: 0, normalize: 0, text: 0, render: 0, export: 0};
export const engineTolerance = (module: EngineModule): number => tolerances[module];
/** Changes a module's tolerance (a lane that needs it says why in its STATUS). Returns the restore function. */
export function setEngineTolerance(module: EngineModule, tolerance: number): () => void {
  const previous = tolerances[module];
  tolerances[module] = tolerance;
  return () => void (tolerances[module] = previous);
}

const sameNumber = (a: number, b: number, tolerance: number) =>
  Object.is(a, b) || (Number.isNaN(a) && Number.isNaN(b)) || (tolerance > 0 && Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b)));

const isIndexed = (value: unknown): value is ArrayLike<unknown> => Array.isArray(value) || (ArrayBuffer.isView(value) && !(value instanceof DataView));
const label = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? `.${key}` : `[${JSON.stringify(key)}]`);

/** The first path where `a` and `b` differ (`''` for the roots themselves, `.width`, `[2][0]`, `.nodes["1:2"].x`),
 *  or null when they are equal. Objects compare by their keys with a defined value (absent = undefined, as JSON
 *  sees them), in any order; arrays and typed arrays element by element; Maps by key; numbers with `tolerance`. */
export function firstDifference(a: unknown, b: unknown, tolerance = 0, path = ''): string | null {
  const found = differenceIn(a, b, tolerance);
  return found === null ? null : path + found;
}

/** `firstDifference`'s walk: the path below `a`/`b`, built only on the way back from a difference. */
function differenceIn(a: unknown, b: unknown, tolerance: number): string | null {
  if (typeof a === 'number' && typeof b === 'number') return sameNumber(a, b, tolerance) ? null : '';
  if (a === b) return null;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return '';
  if (isIndexed(a) || isIndexed(b)) {
    if (!isIndexed(a) || !isIndexed(b)) return '';
    if (a.length !== b.length) return '.length';
    for (let i = 0; i < a.length; i++) {
      const found = differenceIn(a[i], b[i], tolerance);
      if (found !== null) return `[${i}]${found}`;
    }
    return null;
  }
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map) || !(b instanceof Map)) return '';
    if (a.size !== b.size) return '.size';
    for (const [key, value] of a) {
      if (!b.has(key)) return `.get(${JSON.stringify(key)})`;
      const found = differenceIn(value, b.get(key), tolerance);
      if (found !== null) return `.get(${JSON.stringify(key)})${found}`;
    }
    return null;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set) || !(b instanceof Set) || a.size !== b.size) return '';
    for (const value of a) if (!b.has(value)) return `.has(${JSON.stringify(value)})`;
    return null;
  }
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  for (const key in left) {
    if (left[key] === undefined || !Object.hasOwn(left, key)) continue;
    const found = differenceIn(left[key], right[key], tolerance);
    if (found !== null) return `${label(key)}${found}`;
  }
  for (const key in right) if (right[key] !== undefined && left[key] === undefined && Object.hasOwn(right, key)) return label(key);
  return null;
}

/** The value at a path `firstDifference` returned (for error messages). */
export function valueAt(root: unknown, path: string): unknown {
  let value = root;
  for (const [, dot, bracket, call] of path.matchAll(/\.([A-Za-z_$][\w$]*)|\[("(?:[^"\\]|\\.)*"|\d+)\]|\.get\(("(?:[^"\\]|\\.)*")\)/g)) {
    if (value === null || value === undefined) return undefined;
    if (call !== undefined) value = (value as Map<unknown, unknown>).get(JSON.parse(call));
    else value = (value as Record<string, unknown>)[dot ?? (bracket!.startsWith('"') ? JSON.parse(bracket!) : bracket!)];
  }
  return value;
}

/** A short digest of a call's inputs (FNV-1a of their JSON, at most 1 MB of it), so a diff can be found again. */
export function digestOf(inputs: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(inputs, (_, value) => (ArrayBuffer.isView(value) ? Array.from(value as unknown as ArrayLike<number>) : value instanceof Map ? [...value] : value)) ?? 'undefined';
  } catch {
    text = String(inputs);
  }
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length && i < 1 << 20; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
  return `${(hash >>> 0).toString(16).padStart(8, '0')}/${text.length}`;
}

const show = (value: unknown) => {
  try {
    const text = JSON.stringify(value, (_, inner) => (ArrayBuffer.isView(inner) ? Array.from(inner as unknown as ArrayLike<number>) : inner));
    return text === undefined ? String(value) : text.length > 200 ? `${text.slice(0, 200)}…` : text;
  } catch {
    return String(value);
  }
};

/** `both` mode found the two engines disagree. */
export class EngineDiffError extends Error {
  constructor(
    readonly module: EngineModule,
    readonly call: string,
    readonly path: string,
    readonly inputsDigest: string,
    readonly ts: unknown,
    readonly wasm: unknown,
  ) {
    super(`engine diff: ${module}.${call} at ${path || '(the result)'}: ts ${show(valueAt(ts, path))}, wasm ${show(valueAt(wasm, path))} (inputs ${inputsDigest})`);
    this.name = 'EngineDiffError';
  }
}

/** Thrown by a wasm adapter for an input the Rust side cannot represent yet: the call goes to TypeScript and counts
 *  as a `fallback`, which `assertWasmRan` refuses unless allowed. Never for a wrong answer. */
export class EngineUnsupported extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'EngineUnsupported';
  }
}

/** Thrown by a wasm adapter for a call it declines though wasm could run it (normalize.ts: bringing the shadow to a
 *  followed store's document would load or compare the whole file; in `both` the oracle's work would count as the
 *  edit's, by default in `wasm` the commit would pay the load). TypeScript answers; counted as `skipped`, not
 *  `fallback`, in `both` and `wasm` alike (in `wasm` it happens only while a module runs by default and the shadow is
 *  not in yet or out of reach). */
export class EngineSkipped extends EngineUnsupported {
  constructor(reason: string) {
    super(reason);
    this.name = 'EngineSkipped';
  }
}

export type EngineCallOptions<T> = {
  /** Replaces the module's comparison: the differing path (`''` for the whole result), or null when equal. */
  equal?: (ts: T, wasm: T) => string | null;
  /** The call's inputs, for the diff's digest: a value, or `lazyInputs(() => …)` worked out only on a diff. */
  inputs?: unknown;
};

/** Inputs worked out only when a diff needs their digest. (A wrapper, not a bare arrow in the options literal: tsx's
 *  keepNames names every arrow written as an object property, a defineProperty per call on hot paths.) */
export class LazyInputs {
  constructor(readonly make: () => unknown) {}
}
export const lazyInputs = (make: () => unknown): LazyInputs => new LazyInputs(make);

/** True (and counted as a TypeScript call) when the module runs as `ts`: hot functions check this first and call
 *  their TypeScript body directly, so the default mode costs one array read and one increment. */
export function engineTs(module: EngineModule): boolean {
  if ((resolved ??= resolve())[module] !== 'ts') return false;
  counters[module].ts++;
  return true;
}

/** Runs one call of a ported module in the module's mode. `wasm` gets nothing: it reads `engineWasm()` (or a lane's
 *  own build while it has one) and `shadowFor(doc)` itself. */
export function withEngine<T>(module: EngineModule, call: string, ts: () => T, wasm: () => T, options?: EngineCallOptions<T>): T {
  const mode = (resolved ??= resolve())[module];
  const total = counters[module];
  if (mode === 'ts') {
    total.ts++;
    return ts();
  }
  const each = callCounts(module, call);
  if (mode === 'wasm') {
    try {
      const answer = wasm();
      total.wasm++, each.wasm++;
      return answer;
    } catch (error) {
      if (isCrash(error)) {
        crashed(module, call, error);
        total.fallback++, each.fallback++, total.ts++, each.ts++;
        return ts();
      }
      if (!(error instanceof EngineUnsupported)) throw error;
      // A decline (the shadow out of reach while a module runs by default) is counted as `skipped`, as `engineDeclined`
      // counts geometry's; a fallback is a call the wasm side could not take.
      if (error instanceof EngineSkipped) total.skipped++, each.skipped++;
      else total.fallback++, each.fallback++;
      total.ts++, each.ts++;
      return ts();
    }
  }
  const expected = ts();
  total.ts++, each.ts++;
  let actual: T;
  try {
    actual = wasm();
  } catch (error) {
    if (isCrash(error)) crashed(module, call, error);
    if (!(error instanceof EngineUnsupported)) throw error;
    if (error instanceof EngineSkipped) total.skipped++, each.skipped++;
    else total.fallback++, each.fallback++;
    return expected;
  }
  total.wasm++, each.wasm++, total.both++, each.both++;
  const path = options?.equal ? options.equal(expected, actual) : firstDifference(expected, actual, tolerances[module]);
  if (path !== null) {
    total.diffs++, each.diffs++;
    const inputs = options?.inputs instanceof LazyInputs ? options.inputs.make() : options?.inputs;
    throw new EngineDiffError(module, call, path, digestOf(inputs), expected, actual);
  }
  return expected;
}

/** A call the module's wasm side declines without trying (its document is out of the shadow's reach, `shadowNear`):
 *  TypeScript answers, counted as `skipped` (and `ts`), in `wasm` and `both` alike. */
export function engineDeclined<T>(module: EngineModule, call: string, ts: () => T): T {
  engineDeclinedCount(module, call);
  return ts();
}

/** `engineDeclined`'s counting alone, for a reader that then calls its TypeScript itself (no closure per call). */
export function engineDeclinedCount(module: EngineModule, call: string): void {
  const total = counters[module];
  const each = callCounts(module, call);
  total.ts++, each.ts++, total.skipped++, each.skipped++;
}

/** Runs `run` with `module` held at TypeScript: the calls a ported unit makes inside its own TypeScript body (normalize's
 *  stages inside `normalizeDetailed`) belong to that one call, which the switch already ran, compared or fell back as a
 *  whole. Inner calls count as `ts`. */
export function inTypeScript<T>(module: EngineModule, run: () => T): T {
  const modes = (resolved ??= resolve());
  const mode = modes[module];
  if (mode === 'ts') return run();
  modes[module] = 'ts';
  try {
    return run();
  } finally {
    // A setEngine inside `run` resolved the modes again: nothing to put back then.
    if (resolved === modes) modes[module] = mode;
  }
}

/** `withEngine` as a function with the TypeScript function's own signature (how L1's hooks wrap whole modules). */
export function engineFunction<A extends unknown[], R>(module: EngineModule, call: string, ts: (...args: A) => R, wasm: (...args: A) => R, options?: {equal?: (ts: R, wasm: R) => string | null}): (...args: A) => R {
  return (...args: A) => withEngine(module, call, () => ts(...args), () => wasm(...args), {equal: options?.equal, inputs: args});
}

// ── The wasm module ─────────────────────────────────────────────────────────────────────────────────────────────

/** crates/wasm's MorfaDoc (the shadow document). Module entry points are its `<module>_<call>` methods. */
export interface MorfaDocHandle {
  load(json: string): void;
  load_part(json: string): void;
  apply_patch(json: string): void;
  /** `apply_patch` that answers the change's store journal entry (`MRFJ` bytes): what a writer of such rows produces. This and
   *  `replay_entry` are in the server's build only (crates/wasm feature `server`). */
  commit_entry(json: string): Uint8Array;
  /** Replays one store journal entry (an `MRFJ` row of design_file_changes) on this document, as crates/checkpoint loads. */
  replay_entry(bytes: Uint8Array): void;
  version(): number;
  node(id: NodeId): SceneNode | undefined;
  pages(): string[];
  to_json(): string;
  encode(): Uint8Array;
  stats(): {nodes: number; ids: number; atoms: number; version: number; memoryBytes: number};
  free(): void;
  /** Lane W, BIG.md stage B (crates/wasm src/parts.rs; read through shared/design/parts.ts): one past the highest node slot. */
  part_slots(): number;
  /** The nodes in slots `[start, start + count)` as `{nodes}` JSON; `shared`: heavy values as indexes into `values`. */
  part_json(start: number, count: number, shared: boolean): string;
  /** export-raster.ts `fontSpecsUnder(doc, root)` (every page's when `root` is absent) as JSON. */
  font_specs(root?: string): string;
  /** The document as `to_json()` writes it, with `"nodes": {}` (lane W, BIG.md stage B). */
  tables_json(): string;
  geometry_world_box(id: NodeId): Float64Array;
  geometry_world_matrix(id: NodeId): Float64Array;
  /** `geometry_world_box` into the scratch buffer. */
  geometry_world_box_into(id: NodeId): void;
  /** `geometry_world_matrix` into the scratch buffer (`[a, c, e, b, d, f]`). */
  geometry_world_matrix_into(id: NodeId): void;
  /** One normalize stage alone (tests/helpers/stage-diff.ts): `{reported, written, nodes}` as JSON. */
  normalize_stage(name: string, dirty: string): string;
  /** normalize.ts `normalizeDetailed` in Rust on the shadow with `patch` (a DocumentPatch's JSON, from `shadowBeside`)
   *  laid over it, the shadow itself unchanged: `{written, nodes, modes}` as JSON. `dirty` is a JSON array of ids.
   *  `measure`: the editor's measurer (normalize.ts `measurerFunction`) instead of the fixed-width fake. */
  normalize(patch: string, fields: string, dirty: string, keep: boolean, measure?: (text: string | null, font: string) => number | number[], measurer?: number, revision?: number): string;
  /** Where (bytes into wasm memory) the numbers of the last `normalize` are: `which` 0 its box changes (five per node:
   *  `index × 16 + mask` (bits x 1, y 2, width 4, height 8), x, y, width, height), 1 its shared values (three per
   *  value: the node's place in `written`, the field's bit (19 fills, 20 strokes, 27 effects, 68 text), the sender's
   *  place in `written` then `from`). How many: the output's `numbers`. */
  normalized_numbers(which: number): number;
  /** `apply_patch` with the node entries `ids` (a JSON array) left out of `json`: the shadow takes them from the last
   *  `normalize(…, keep)`, whose final nodes they are. */
  apply_patch_with(json: string, ids: string): void;
  /** Lane L2b's standalone entries (shared/design/layout-wasm.ts): the entries their draft wrote as JSON,
   *  `[[id, node | null], …]`; group fit `{entries, removed}`. Lists of ids cross as JSON arrays. */
  normalize_layout_frame(id: NodeId): string;
  normalize_layout_sizing(id: NodeId, vertical: boolean, sizing: string): string;
  normalize_resize(id: NodeId, x: number, y: number, width: number, height: number): string;
  normalize_scale(ids: string, ox: number, oy: number, sx: number, sy: number): string;
  normalize_group_fit(ids: string): string;
}

/** crates/wasm as wasm-bindgen exports it (scripts/wasm-build.sh). Lanes' entry points are added here with theirs. */
export interface MorfaWasm {
  version(): string;
  /** The big-files switch of the model crate (crates/model limits.rs; shared/design/big-files.ts): set at install. */
  set_big_files?(on: boolean): void;
  /** `decode_from`: `decode` reading the bytes in chunks from JavaScript (lane W, BIG.md stage B): no copy of the whole
   *  checkpoint in wasm memory. */
  MorfaDoc: {new (json: string): MorfaDocHandle; decode(bytes: Uint8Array): MorfaDocHandle; decode_from(bytes: Uint8Array): MorfaDocHandle};
  debug_fault(name: string): void;
  /** The last Rust panic's message (crates/wasm fault.rs; optional: test fakes leave it out). */
  last_panic?(): string;
  geometry_local_matrix(x: number, y: number, width: number, height: number, rotation: number, flipX: boolean, flipY: boolean): Float64Array;
  /** `geometry_local_matrix` into the scratch buffer. */
  geometry_local_matrix_into(x: number, y: number, width: number, height: number, rotation: number, flipX: boolean, flipY: boolean): void;
  scratch_ptr(): number;
  scratch_memory(): WebAssembly.Memory;
  /** One ops call (lane L2a, crates/wasm src/ops.rs) by the TypeScript function's name: `input` is `{pool, args}`,
   *  `lookup` reads the documents left in JavaScript (shared/design/ops-engine.ts `CallContext`). */
  ops_call(name: string, input: string, lookup: unknown): string;
  /** transaction.ts `boxOrigin` into the scratch buffer: `[x, y]`. */
  ops_box_origin_into(cx: number, cy: number, width: number, height: number, rotation: number): void;
  /** transaction.ts `placementFor` into the scratch buffer: `[x, y, rotation, flipX, flipY]` (flags 0/1). */
  ops_placement_for_into(a: number, c: number, e: number, b: number, d: number, f: number, width: number | undefined, height: number | undefined, preferFlipX: boolean, preferFlipY: boolean): void;
  /** transaction.ts `placementChanges` into the scratch buffer: `[mask]` (x 1, y 2, rotation 4, flipX 8, flipY 16). */
  ops_placement_changes_into(x: number | undefined, y: number | undefined, rotation: number | undefined, flipX: boolean, flipY: boolean, toX: number, toY: number, toRotation: number, toFlipX: boolean, toFlipY: boolean): void;
  /** A document held in wasm from its stored text (the server's way and the benches'). */
  OpsDocument: new (json: string) => OpsDocumentHandle;
  /** A transaction whose draft stays in JavaScript (shared/design/ops-transaction.ts `MirrorTransaction`). */
  OpsTransaction: new (lookup: unknown) => OpsTransactionHandle;
}

export interface OpsDocumentHandle {
  applyPatch(patch: string): void;
  mergeChange(change: string, before?: string): string;
  applyDocumentChange(change: string): string;
  toJson(): string;
  nodeCount(): number;
  free(): void;
}

export interface OpsTransactionHandle {
  op(name: string, input: string): string;
  free(): void;
}

let wasmModule: MorfaWasm | null = null;
let wasmLoadError: unknown = null;

/** Installs the wasm module (the browser loader does this after `init()`; tests may install a fake or `null`). */
export function setEngineWasm(module: MorfaWasm | null): void {
  wasmModule = module;
  module?.set_big_files?.(bigFilesEnabled());
  scratchView = null;
  wasmLoadError = null;
  shadow?.dispose();
  shadow = null;
  clearEngineCrash();
}

/** In Node the CommonJS build is loaded on first use, synchronously (process.getBuiltinModule keeps bundlers from
 *  seeing a Node import). */
function loadInNode(): MorfaWasm | null {
  const getBuiltin = runtime.process?.getBuiltinModule;
  if (!runtime.process?.versions?.node || !getBuiltin) return null;
  const {createRequire} = getBuiltin('node:module') as {createRequire(from: string): (id: string) => unknown};
  const path = runtime.process.env?.MORFA_WASM_PATH ?? new URL('../../server/design/wasm/morfa_wasm.js', import.meta.url).pathname;
  return createRequire(import.meta.url)(path) as MorfaWasm;
}

/** The loaded wasm module; throws when none can be loaded (never a silent TypeScript fallback). */
export function engineWasm(): MorfaWasm {
  if (wasmModule) return wasmModule;
  if (!wasmLoadError) {
    try {
      wasmModule = loadInNode();
      wasmModule?.set_big_files?.(bigFilesEnabled());
    } catch (error) {
      wasmLoadError = error;
    }
  }
  if (wasmModule) return wasmModule;
  const why = wasmLoadError instanceof Error ? `: ${wasmLoadError.message}` : '';
  throw new Error(
    `engine-switch: the wasm engine is not loaded${why}. In Node build it with scripts/wasm-build.sh; in the browser await loadEngineWasm() (src/design/engine/engine-wasm.ts) first.`,
  );
}

export const engineWasmLoaded = (): boolean => wasmModule !== null;

let scratchView: Float64Array | null = null;
let scratchMemory: WebAssembly.Memory | null = null;

let memoryOf: {module: MorfaWasm; memory: WebAssembly.Memory} | null = null;

/** The wasm module's memory (the object stays; its `buffer` is replaced when the memory grows: view it per read). */
export function engineMemory(): WebAssembly.Memory {
  const wasm = engineWasm();
  if (memoryOf?.module !== wasm) memoryOf = {module: wasm, memory: wasm.scratch_memory()};
  return memoryOf.memory;
}

/** The wasm scratch buffer (256 numbers) that `*_into` entry points write their result into: read it right after the
 *  call (the next call overwrites it). The view is made again when the wasm memory grows (its buffer is replaced). */
export function engineScratch(): Float64Array {
  const wasm = engineWasm();
  if (!scratchView || scratchView.buffer !== scratchMemory?.buffer) {
    scratchMemory = wasm.scratch_memory();
    scratchView = new Float64Array(scratchMemory.buffer, wasm.scratch_ptr(), 256);
  }
  return scratchView;
}

// ── The shadow document ─────────────────────────────────────────────────────────────────────────────────────────

type Table = 'styles' | 'images' | 'variableCollections' | 'variables' | 'variableModes';
const TABLES: readonly Table[] = ['styles', 'images', 'variableCollections', 'variables', 'variableModes'];

/** Timings and counts of the shadow's upkeep, for benches and STATUS. */
export type ShadowStats = {loads: number; patches: number; fullDiffs: number; entries: number; loadMs: number; patchMs: number; diffMs: number};
const shadowStatsZero = (): ShadowStats => ({loads: 0, patches: 0, fullDiffs: 0, entries: 0, loadMs: 0, patchMs: 0, diffMs: 0});
let stats = shadowStatsZero();
export const shadowStats = (): ShadowStats => ({...stats});
export const resetShadowStats = () => void (stats = shadowStatsZero());

const now = () => performance.now();

class Shadow {
  /** The document the shadow equals. */
  doc: DesignDocument;
  /** `shadowFor` already noted the followers at `doc` (their hints cleared): the next read of `doc` returns at once.
   *  Any change of `doc` clears it. */
  settled = false;
  /** What was sent, entry by entry (the shadow's own copy: a drag's scratch table changes under its document). */
  private nodes = new Map<NodeId, SceneNode>();
  private pages: readonly NodeId[] = [];
  private tables = new Map<Table, {source: unknown; entries: Map<string, unknown>}>();
  /** The last few documents the shadow was brought from, each with the node ids changed since: how a document it
   *  passed through is reached again without comparing the file (`reach`). Cleared by a load. */
  private passed: {from: DesignDocument; ids: Set<NodeId>}[] = [];
  /** The last `normalize(…, keep)`: the document the shadow was at, and each final node object that call returned or
   *  was sent, by id. A patch from there carrying those very objects lets the shadow take its own copies. */
  pending: {at: DesignDocument; objects: Map<object, NodeId>} | null = null;

  /** `sent`: the node objects the handle was loaded with, when they were sent over time (`preload`): the document's
   *  table may have been written in place meanwhile, so the table as it is now is not what the
   *  handle holds — this map is, and the follower's changed ids bring the rest. */
  constructor(
    readonly handle: MorfaDocHandle,
    doc: DesignDocument,
    sent?: Map<NodeId, SceneNode>,
  ) {
    this.doc = doc;
    this.remember(doc, sent);
  }

  private remember(doc: DesignDocument, sent?: Map<NodeId, SceneNode>) {
    this.passed = [];
    this.pending = null;
    this.doc = doc;
    this.settled = false;
    this.nodes = sent ?? new Map(Object.entries(doc.nodes));
    this.pages = doc.pages;
    this.tables.clear();
    for (const table of TABLES) {
      const source = doc[table] as Record<string, unknown> | undefined;
      this.tables.set(table, {source, entries: new Map(source ? Object.entries(source) : [])});
    }
  }

  load(doc: DesignDocument) {
    const started = now();
    try {
      unsupportedOnError('load', () => loadParts(doc, skeleton => this.handle.load(skeleton), part => this.handle.load_part(part)));
    } catch (error) {
      // A part refused halfway leaves the wasm side holding part of the document: drop this shadow altogether.
      if (shadow === this) shadow = null;
      this.dispose();
      throw error;
    }
    this.remember(doc);
    stats.loads++;
    stats.loadMs += now() - started;
  }

  /** Brings the shadow to `doc`. `changed`: every node id that can differ from the shadow's document (a store's
   *  change events); without it every entry is compared. */
  sync(doc: DesignDocument, changed?: Iterable<NodeId>) {
    if (doc === this.doc) return;
    if (doc.schemaVersion !== this.doc.schemaVersion || doc.board !== this.doc.board) return this.load(doc);
    const patch = this.diff(doc, changed);
    if (patch) this.apply(doc, patch);
    else this.load(doc);
  }

  /** The patch that takes the shadow to `doc` (see `sync`), or null when `doc` is a different document altogether
   *  (loading it is cheaper). */
  diff(doc: DesignDocument, changed?: Iterable<NodeId>): DocumentPatch | null {
    const started = now();
    const patch: DocumentPatch = {};
    const nodes: Record<NodeId, SceneNode | null> = {};
    let count = 0;
    const visit = (id: NodeId) => {
      const value = Object.hasOwn(doc.nodes, id) ? doc.nodes[id] : undefined;
      if (value === this.nodes.get(id)) return;
      nodes[id] = value ?? null;
      count++;
    };
    if (changed) for (const id of changed) visit(id);
    else {
      stats.fullDiffs++;
      const ids = Object.keys(doc.nodes);
      for (const id of ids) visit(id);
      // Removed nodes: the mirror holds ids the new table lacks.
      if (this.nodes.size + count > ids.length) for (const id of this.nodes.keys()) if (!Object.hasOwn(doc.nodes, id)) (nodes[id] = null), count++;
      // A different document altogether: loading is cheaper than a patch of most of it.
      if (count > 64 && count > ids.length / 2) {
        stats.diffMs += now() - started;
        return null;
      }
    }
    if (count) patch.nodes = nodes;
    if (doc.pages !== this.pages && (doc.pages.length !== this.pages.length || doc.pages.some((id, i) => id !== this.pages[i]))) patch.pages = [...doc.pages];
    for (const table of TABLES) {
      const source = doc[table] as Record<string, Record<string, string> | unknown> | undefined;
      const known = this.tables.get(table)!;
      if (source === known.source) continue;
      const changes: Record<string, unknown> = {};
      let any = false;
      for (const [key, value] of Object.entries(source ?? {})) if (known.entries.get(key) !== value) (changes[key] = value), (any = true);
      for (const key of known.entries.keys()) if (!source || !Object.hasOwn(source, key)) (changes[key] = null), (any = true);
      // A table that appears empty (`variableModes: {}`) has no entries to send; the shadow reads it as absent.
      if (any) (patch as Record<Table, unknown>)[table] = changes;
    }
    stats.diffMs += now() - started;
    return patch;
  }

  /** Applies a patch that takes the shadow to `doc`. */
  apply(doc: DesignDocument, patch: DocumentPatch) {
    const started = now();
    const empty = !patch.nodes && !patch.pages && TABLES.every(table => !patch[table]);
    const pending = this.pending?.at === this.doc ? this.pending.objects : null;
    this.pending = null;
    if (!empty) {
      // Entries that are a normalize's own results cross as their ids (the shadow kept them), the rest as JSON.
      let kept: NodeId[] | null = null;
      let rest: DocumentPatch = patch;
      if (pending && patch.nodes) {
        const nodes: Record<NodeId, SceneNode | null> = {};
        for (const id in patch.nodes) {
          const value = patch.nodes[id];
          if (value && pending.get(value) === id) (kept ??= []).push(id);
          else nodes[id] = value;
        }
        if (kept) rest = {...patch, nodes};
      }
      if (kept) unsupportedOnError('apply_patch', () => this.handle.apply_patch_with(JSON.stringify(rest), JSON.stringify(kept)));
      else unsupportedOnError('apply_patch', () => this.handle.apply_patch(JSON.stringify(patch)));
      stats.patches++;
    }
    const ids = Object.keys(patch.nodes ?? {});
    for (const id of ids) {
      const value = patch.nodes![id];
      if (value) this.nodes.set(id, value);
      else this.nodes.delete(id);
      stats.entries++;
    }
    if (doc !== this.doc) {
      for (const each of this.passed) for (const id of ids) each.ids.add(id);
      this.passed.push({from: this.doc, ids: new Set(ids)});
      if (this.passed.length > PASSED) this.passed.shift();
      this.settled = false;
    }
    if (patch.pages) this.pages = doc.pages;
    for (const table of TABLES) {
      const known = this.tables.get(table)!;
      const changes = patch[table] as Record<string, unknown> | undefined;
      for (const [key, value] of Object.entries(changes ?? {})) {
        if (value === null) known.entries.delete(key);
        else known.entries.set(key, value);
      }
      known.source = doc[table];
    }
    this.doc = doc;
    if (!empty) stats.patchMs += now() - started;
  }

  /** The node as the shadow holds it (the object sent). */
  entry(id: NodeId): SceneNode | undefined {
    return this.nodes.get(id);
  }

  /** The node ids where the shadow can differ from `doc`, a document it was brought from lately; null when it was
   *  not (the tables and pages are compared whole by `diff` anyway). */
  reach(doc: DesignDocument): ReadonlySet<NodeId> | null {
    if (doc === this.doc) return new Set();
    for (let i = this.passed.length - 1; i >= 0; i--) if (this.passed[i].from === doc) return this.passed[i].ids;
    return null;
  }

  dispose() {
    this.handle.free();
  }
}

/** How many documents back `Shadow.reach` looks. */
const PASSED = 8;

let shadow: Shadow | null = null;

/** Node entries per part when a document is loaded (see MorfaDoc.load_part): about 1.5 MB of JSON for typical layers. */
const LOAD_PART = 2000;

/** Sends a document as its skeleton (every table but the nodes) and then its nodes in parts. */
function loadParts(doc: DesignDocument, skeleton: (json: string) => void, part: (json: string) => void) {
  const ids = Object.keys(doc.nodes);
  skeleton(JSON.stringify(ids.length > LOAD_PART ? {...doc, nodes: {}} : doc));
  if (ids.length <= LOAD_PART) return;
  for (let start = 0; start < ids.length; start += LOAD_PART) {
    const nodes: Record<NodeId, SceneNode> = {};
    for (const id of ids.slice(start, start + LOAD_PART)) nodes[id] = doc.nodes[id];
    part(JSON.stringify({nodes}));
  }
}

/** The model refuses documents the TypeScript tolerates (tests' partial nodes): the shadow cannot hold them, so the
 *  call falls back and counts as one (`assertWasmRan` refuses fallbacks). The shadow is left as it was. */
function unsupportedOnError<T>(entry: string, run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (isCrash(error)) crashed('shadow', entry, error);
    throw new EngineUnsupported(`shadow ${entry}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function shadowOf(doc: DesignDocument): Shadow {
  if (crash) throw new EngineUnsupported('the Rust engine crashed earlier in this session');
  if (shadow) return shadow;
  const started = now();
  const Doc = engineWasm().MorfaDoc;
  let handle: MorfaDocHandle | null = null;
  unsupportedOnError('new', () =>
    loadParts(
      doc,
      skeleton => void (handle = new Doc(skeleton)),
      part => handle!.load_part(part),
    ),
  );
  shadow = new Shadow(handle!, doc);
  stats.loads++;
  stats.loadMs += now() - started;
  return shadow;
}

/** Followed stores: per store, the node ids changed since the shadow last matched one of its documents. */
type Follower = {base: DesignDocument; doc: DesignDocument; changed: Set<NodeId>; deferred?: boolean};
const followers = new Set<Follower>();
const MAX_FOLLOWERS = 8;

// Documents still being written in place (a transaction's draft: its table and its own nodes change after a module
// has read them). The shadow never follows one: a call about it falls back to TypeScript (counted). Table views of
// other drafts that a module call can reach must be marked the same way.
const inFlight = new WeakSet<object>();
export const markInFlight = (doc: DesignDocument): void => void inFlight.add(doc);
export const markSettled = (doc: DesignDocument): void => void inFlight.delete(doc);

// Copies of a followed store's document that stand in for it (the ops oracle's mirror beside a transaction that writes
// the document's own table): no follower holds them, so a call that would otherwise bring the shadow
// to such a copy (a load or a comparison of the whole file) is skipped as it is for the document itself.
const standIns = new WeakSet<object>();
export const markStandIn = (doc: DesignDocument): void => void standIns.add(doc);

/** The shadow document, equal to `doc`. Module adapters call it and then an entry point by id. Throws
 *  EngineUnsupported for a document inside an open transaction.
 *
 *  `near` (the readers of an editor: geometry): while a store is followed, the shadow is brought to `doc` only when
 *  that costs the ids changed since (the store's document, or one the shadow passed through lately) — never a load
 *  or a comparison of the whole file inside a call, and never before the shadow's first load has finished. Otherwise
 *  EngineSkipped: TypeScript answers (counted as skipped in `both`, as a fallback in `wasm`). Applies while a store is
 *  followed at idle (`shadowNear`); otherwise (Node's tests, benches, the server) `near` changes nothing. */
export function shadowFor(doc: DesignDocument, options: {near?: boolean} = {}): MorfaDocHandle {
  if (inFlight.has(doc)) throw new EngineUnsupported('the document is inside an open transaction; the shadow follows committed documents');
  if (layered(doc)) throw new EngineUnsupported('the document lays entries over its tables through a prototype');
  if (options.near && !shadowNear(doc)) throw new EngineSkipped('the shadow is not near this document (a load or a comparison of the whole file)');
  const target = shadowOf(doc);
  // Already there (a reader's every call after the first): nothing to send, nothing to note.
  if (target.doc === doc && target.settled) return target.handle;
  if (target.doc !== doc) {
    let follower: Follower | undefined;
    for (const each of followers) if (each.doc === doc && each.base === target.doc) follower = each;
    const passed = follower ? null : target.reach(doc);
    target.sync(doc, follower?.changed ?? passed ?? undefined);
  }
  for (const each of followers) if (each.doc === doc) (each.base = doc), each.changed.clear();
  target.settled = true;
  return target.handle;
}

/** `shadowFor(doc)` when `shadowNear(doc)`, else null (the reader lets TypeScript answer): one check on a hot path. */
export function shadowIfNear(doc: DesignDocument): MorfaDocHandle | null {
  if (shadow && shadow.doc === doc && shadow.settled && !inFlight.has(doc)) return shadow.handle;
  if (!shadowNear(doc)) return null;
  try {
    return shadowFor(doc);
  } catch (error) {
    // Bringing the shadow here crashed the engine: TypeScript answers this read and every later one.
    if (crash && error instanceof EngineUnsupported) return null;
    throw error;
  }
}

/** The shadow for a reader of one node of `doc` (its chain: the node and its ancestors), or null (TypeScript answers):
 *  `shadowIfNear(doc)`, or — when `doc` is out of reach as a whole (a drag frame of many layers) — the shadow as it
 *  stands, if it is at a followed store's earlier document and none of the ids changed since lies on the node's chain:
 *  those entries are the very objects the shadow was sent (documents are immutable), so its answer is `doc`'s. */
export function shadowForChain(doc: DesignDocument, id: NodeId): MorfaDocHandle | null {
  const handle = shadowIfNear(doc);
  if (handle || !shadow || preloading || inFlight.has(doc)) return handle;
  for (const each of followers) if (each.doc === doc && each.base === shadow.doc) return chainUntouched(doc, id, each.changed) ? shadow.handle : null;
  return null;
}

/** Whether no id of `changed` lies on `id`'s chain in `doc` (the node, then its parents up to the page). */
function chainUntouched(doc: DesignDocument, id: NodeId, changed: ReadonlySet<NodeId>): boolean {
  if (changed.has(id)) return false;
  for (let node = doc.nodes[id]; node && node.type !== 'PAGE'; node = node.parentId ? doc.nodes[node.parentId] : (undefined as never)) {
    if (!node.parentId) return true;
    if (changed.has(node.parentId)) return false;
  }
  return true;
}

/** A reader's own catch around its `wasm` fast path (outside `withEngine`): a Rust crash is recorded and counted as a
 *  fallback, and the reader answers in TypeScript; anything else is thrown again. */
export function engineCrashed(module: EngineModule, call: string, error: unknown): void {
  if (!isCrash(error)) throw error;
  crashed(module, call, error);
  counters[module].fallback++;
  callCounts(module, call).fallback++;
}

/** Counts one wasm call a reader made itself (its `wasm` mode's fast path, outside `withEngine`). */
export function engineCounted(module: EngineModule, call: string): void {
  counters[module].wasm++;
  callCounts(module, call).wasm++;
}

/** Whether `shadowFor(doc, {near: true})` would answer: never for a document inside an open transaction; while a store
 *  is followed at idle (`followStore`'s `defer`: the editor in the browser), only when the shadow is loaded and a few
 *  ids away from `doc` (see `shadowFor`). A reader checks this
 *  first and lets TypeScript answer otherwise (`engineDeclined`): no exception per call on a hot path. */
export function shadowNear(doc: DesignDocument): boolean {
  // The last document found out of reach, while nothing moved: a drag frame's 200 reads ask once.
  if (doc === far.doc && far.at === shadow?.doc && far.preloading === preloading) return false;
  const near = nearNow(doc);
  if (!near) (far.doc = doc), (far.at = shadow?.doc), (far.preloading = preloading);
  return near;
}

/** Whether the shadow is loaded, not loading, and at `doc` or within `NEAR_IDS` of it (a followed store's hints, or a
 *  document it passed through lately): what a module running by default (`engineByDefault`: normalize, lane N1) asks
 *  before a call, in Node as in the browser — never a load or a comparison of the whole file inside a commit. Unlike
 *  `shadowNear`, Node's tests get no free pass: a store's first commit declines (TypeScript answers, counted as skipped)
 *  and its eager follower brings the shadow along afterwards, so the next commit is in reach. */
export function shadowInReach(doc: DesignDocument): boolean {
  if (inFlight.has(doc) || layered(doc)) return false;
  if (!shadow || preloading) return false;
  if (shadow.doc === doc) return true;
  for (const each of followers) if (each.doc === doc && each.base === shadow.doc) return each.changed.size <= NEAR_IDS;
  const ids = shadow.reach(doc);
  return ids !== null && ids.size <= NEAR_IDS;
}

/** For a transaction over `base` whose writes so far are `changed` (a gesture's frames, each a transaction over the
 *  committed document): the document the shadow stands at when that is an earlier frame of the same gesture (the
 *  idle catch-up brought it there), so the call can cross its writes from that frame instead of from `base` — every
 *  id the shadow changed since `base` is one the transaction wrote, so nothing beyond the call's own input crosses.
 *  Null when the shadow is elsewhere (a reader then declines). */
export function shadowFrameAt(base: DesignDocument, changed: ReadonlySet<NodeId>): DesignDocument | null {
  if (!shadow || preloading || inFlight.has(shadow.doc)) return null;
  const ids = shadow.reach(base);
  if (!ids || !ids.size) return null;
  for (const id of ids) if (!changed.has(id)) return null;
  return shadow.doc;
}

/** `shadowNear`'s last "no": the document, and where the shadow and its loading were then. */
const far: {doc: DesignDocument | null; at: DesignDocument | undefined; preloading: unknown} = {doc: null, at: undefined, preloading: null};

function nearNow(doc: DesignDocument): boolean {
  if (inFlight.has(doc) || layered(doc)) return false;
  // In the browser the module may still be loading (the editor loads it in the background when only the defaults
  // ask for it): TypeScript answers until it is in.
  const node = !!runtime.process?.versions?.node;
  if (!wasmModule && !node) return false;
  // Without a store followed at idle: anything goes in Node (tests, benches); the browser reads only a followed
  // store's shadow (a page without an editor never loads one inside a call).
  if (!deferred) return node;
  if (!shadow || preloading) return false;
  if (shadow.doc === doc) return true;
  // A few ids away; more (a drag frame of many layers) would cost the call more than TypeScript's answer: the shadow
  // catches up at the next idle instead.
  for (const each of followers) if (each.doc === doc && each.base === shadow.doc) return each.changed.size <= NEAR_IDS;
  const ids = shadow.reach(doc);
  return ids !== null && ids.size <= NEAR_IDS;
}

/** Whether a table of `doc` holds entries through its prototype (codegen's `Object.create(doc.nodes)` lays a few
 *  nodes over a document's table): the shadow reads own keys only, so it never follows such a document (it would hold
 *  it without those entries, and a reader or the export that trusts it would answer for a different document). */
function layered(doc: DesignDocument): boolean {
  for (const table of [doc.nodes, doc.styles, doc.images, doc.variableCollections, doc.variables, doc.variableModes] as unknown[]) {
    if (!table || typeof table !== 'object') continue;
    const proto = Object.getPrototypeOf(table);
    if (proto !== Object.prototype && proto !== null) return true;
  }
  return false;
}

/** At most this many changed ids are sent inside a reader's call (`shadowNear`); about 15 µs of patch each. */
const NEAR_IDS = 16;

/** Whether a followed store holds `doc` and the shadow is at it already or a patch away (its changes since): never a load
 *  or a comparison of the file. Lane L5's export reads the shadow's frame then. Only a store's documents: they are never
 *  written in place, so the shadow at one by identity holds it (lane E1: a bare document a reader brought the shadow to
 *  may since have been written in place by its owner, as tests do). */
export function shadowIsAt(doc: DesignDocument): boolean {
  if (!shadow || inFlight.has(doc) || layered(doc)) return false;
  const at = shadow.doc;
  for (const each of followers) if (each.doc === doc && (at === doc || each.base === at)) return true;
  return false;
}

/** The shadow at `base` (a committed document, brought there as `shadowFor` does) and the patch from it to `doc`, a
 *  document that differs from `base` at most at the node ids `changed` and in its other tables, as JSON: what a call
 *  about a document the shadow must not follow (a transaction's draft before it commits, normalize.ts) sends with its
 *  ids. The shadow does not move to `doc`. EngineUnsupported when `doc` is a different kind of document. */
/** The keys a patch entry may cross as alone (crates/model `NODE_FIELD_KEYS`): each required on a node or refusing
 *  `null`, so a value that differs is set as it is. */
const FIELD_KEYS = new Set(['x', 'y', 'width', 'height', 'rotation', 'opacity', 'visible', 'name', 'text', 'fills', 'strokes', 'effects']);

/** Two texts that differ in `characters` alone (a string), every other key the same value. */
function sameButCharacters(before: Record<string, unknown> | undefined, after: Record<string, unknown>): boolean {
  if (!before || typeof after.characters !== 'string') return false;
  for (const key in after) if (key !== 'characters' && after[key] !== before[key]) return false;
  for (const key in before) if (after[key] === undefined && before[key] !== undefined) return false;
  return true;
}

/** The fields `next` changed over `prev` when they are only `FIELD_KEYS` set to a value (no key added or removed),
 *  else null. */
function fieldChanges(prev: SceneNode, next: SceneNode): Record<string, unknown> | null {
  const before = prev as unknown as Record<string, unknown>, after = next as unknown as Record<string, unknown>;
  let set: Record<string, unknown> | null = null;
  for (const key in after) {
    const value = after[key];
    if (value === before[key]) continue;
    if (value === undefined || value === null || !FIELD_KEYS.has(key) || !Object.hasOwn(before, key)) return null;
    // A keystroke: a text whose other keys are the same values crosses as its characters.
    if (key === 'text' && sameButCharacters(before[key] as Record<string, unknown>, value as Record<string, unknown>)) (set ??= {})['text.characters'] = (value as {characters: string}).characters;
    else (set ??= {})[key] = value;
  }
  if (!set) return null;
  for (const key in before) if (after[key] === undefined && before[key] !== undefined) return null;
  return set;
}

export function shadowBeside(
  doc: DesignDocument,
  base: DesignDocument,
  changed: Iterable<NodeId>,
  options: {load?: boolean | 'unfollowed'; fields?: boolean} = {},
): {handle: MorfaDocHandle; patch: string; fields: string; sent: Readonly<Record<NodeId, SceneNode | null>>; node: (id: NodeId) => SceneNode | undefined} {
  if (doc.schemaVersion !== base.schemaVersion || doc.board !== base.board) throw new EngineUnsupported('the document and its base differ in kind');
  if (layered(base) || layered(doc)) throw new EngineUnsupported('the document lays entries over its tables through a prototype');
  if (inFlight.has(base)) throw new EngineUnsupported('the base is inside an open transaction');
  // Where the shadow is now and the ids it differs from `base` at: a document it passed through lately, or a
  // followed store's document with the ids changed since.
  let target = shadow;
  let extra = target?.reach(base) ?? null;
  if (target && !extra) {
    const follower = [...followers].find(each => each.doc === base && each.base === target!.doc);
    if (follower) extra = follower.changed;
  }
  if (!target || !extra) {
    // Bringing the shadow here takes a load or a comparison of the whole file.
    // `unfollowed`: only for a document no followed store holds (a store's own patches bring the shadow to its documents).
    const refused = options.load === false || (options.load === 'unfollowed' && (standIns.has(base) || [...followers].some(each => each.doc === base || each.base === base)));
    if (refused) throw new (options.load === 'unfollowed' ? EngineSkipped : EngineUnsupported)('the shadow is not near this document (a load or a comparison of the whole file)');
    shadowFor(base);
    target = shadow!;
    extra = new Set();
  }
  const ids = extra.size ? new Set([...changed, ...extra]) : changed;
  const patch = doc === target.doc ? {} : target.diff(doc, ids)!;
  const sent = patch.nodes ?? {};
  const shadowAt = target;
  // `doc`'s node as it was when the patch was made: the patch's entry, else the shadow's (`doc.nodes` itself may be
  // written in place afterwards).
  const node = (id: NodeId) => (Object.hasOwn(sent, id) ? (sent[id] ?? undefined) : shadowAt.entry(id));
  // `fields`: an entry that changed a few fields of a node the shadow holds crosses as those fields (MorfaDoc.normalize).
  let fields = '';
  if (options.fields && patch.nodes) {
    let changes: Record<NodeId, Record<string, unknown>> | null = null;
    let rest: Record<NodeId, SceneNode | null> | null = null;
    for (const id in patch.nodes) {
      const next = patch.nodes[id], prev = shadowAt.entry(id);
      const set = next && prev ? fieldChanges(prev, next) : null;
      if (set) (changes ??= {})[id] = set;
      else (rest ??= {})[id] = next;
    }
    if (changes) {
      fields = JSON.stringify(changes);
      const others: DocumentPatch = {...patch};
      if (rest) others.nodes = rest;
      else delete others.nodes;
      return {handle: target.handle, patch: JSON.stringify(others), fields, sent, node};
    }
  }
  return {handle: target.handle, patch: JSON.stringify(patch), fields, sent, node};
}

/** After `normalize(…, keep)` on the shadow `handle`: the final node objects that call returned or was sent, by id
 *  (`null`: none kept). The commit that carries them next applies them without JSON (`Shadow.apply`). */
export function keepNormalized(handle: MorfaDocHandle, objects: Map<object, NodeId> | null): void {
  if (!shadow || shadow.handle !== handle) return;
  shadow.pending = objects && {at: shadow.doc, objects};
}

/** Drops the shadow (the next call loads it again). */
export function resetShadow(): void {
  preloading?.cancel();
  preloading = null;
  shadow?.dispose();
  shadow = null;
}

/** A shadow decoded elsewhere becomes the shadow, equal to `doc` (lane W, BIG.md stage B: the open from a checkpoint
 *  builds `doc` from `handle`'s parts, so nothing is loaded again and no idle preload follows). `doc` must be the very
 *  object the store holds: the shadow's reach goes by the identity of documents and nodes. The handle is new from
 *  `MorfaDoc.decode`: no pending normalize, no kept indexes, as after `load`. The previous shadow is dropped; followers
 *  at `doc` count their changes from it. */
export function adoptShadow(handle: MorfaDocHandle, doc: DesignDocument): void {
  // Never inside a commit (lane N1): a document still being written is not one the shadow can stand at.
  if (inFlight.has(doc) || layered(doc)) throw new EngineUnsupported('adoptShadow: the document is inside an open transaction');
  preloading?.cancel();
  preloading = null;
  if (shadow && shadow.handle !== handle) shadow.dispose();
  shadow = new Shadow(handle, doc);
  stats.loads++;
  for (const follower of followers)
    if (follower.doc === doc) {
      follower.base = doc;
      follower.changed.clear();
    }
}

/** What the store gives the shadow: src/design/engine/store.ts `DesignStore`'s change events. */
export type FollowedStore = {
  getState(): {doc: DesignDocument};
  onPatch(listener: (event: {patch: DocumentPatch; source: string; doc: DesignDocument}) => void): () => void;
  onDocument(listener: (change: {doc: DesignDocument; changed: ReadonlySet<NodeId>; source: string}) => void): () => void;
};

/** A scheduler of idle work (the store's `idle`): runs `work` later, returns its cancel function. */
export type IdleScheduler = (work: () => void) => () => void;

/** Set while a deferred follower loads the shadow part by part (`preload`): reads that must not load refuse until it
 *  is done. */
let preloading: {cancel: () => void} | null = null;
/** Followers with `defer` (the editor in the browser): while there is one, readers keep to the shadow's reach. */
let deferred = 0;

/** Keeps the shadow equal to the store's document: each committed patch is applied at once (`replace` loads the
 *  document), drag frames when a module next reads them. Does nothing while every module is `ts` (no shadow, no
 *  wasm), unless `force`. Returns the unsubscribe function.
 *
 *  `defer` (the editor in the browser, lane E1): nothing crosses on a commit. The store's changes are only noted (the
 *  ids, as for drag frames) and the shadow catches up when a module next reads it or when the editor is next idle,
 *  in one patch for every commit since: the commit costs what it costs in `ts`. With `defer`, a store whose document
 *  the shadow does not hold yet has it loaded at idle, a part (`PRELOAD_PART` nodes) per idle callback, instead of inside the
 *  first call that reads it. */
export function followStore(store: FollowedStore, options: {force?: boolean; defer?: IdleScheduler} = {}): () => void {
  if (!options.force && !anyWasmEngine()) return () => {};
  const start = store.getState().doc;
  const follower: Follower = {base: start, doc: start, changed: new Set(), deferred: !!options.defer};
  followers.add(follower);
  // Tests make hundreds of stores: only the newest few keep their change hints (the others' documents are reached
  // by a full comparison, which is just slower).
  if (followers.size > MAX_FOLLOWERS) {
    const oldest = followers.values().next().value!;
    followers.delete(oldest);
    if (oldest.deferred) deferred--;
  }
  const offDocument = store.onDocument(change => {
    follower.doc = change.doc;
    for (const id of change.changed) follower.changed.add(id);
  });
  const defer = options.defer;
  if (defer) deferred++;
  let cancel: (() => void) | null = null;
  /** At idle: the shadow brought to the store's document (one patch for everything since), or loaded there. */
  const catchUp = () => {
    cancel = null;
    if (!followers.has(follower) || preloading || crash) return;
    // In the browser the module may still be loading: look again at the next idle.
    if (!wasmModule && !runtime.process?.versions?.node) return schedule();
    try {
      engineWasm();
      const far = !shadow || (shadow.doc !== follower.doc && follower.base !== shadow.doc && !shadow.reach(follower.doc));
      // A page loaded on demand (big files: thousands of layers in one change) would cross in one long task: the shadow
      // is loaded again in idle-sized parts instead.
      if (far || follower.changed.size > PRELOAD_PART * 4) preload(follower, defer!);
      else shadowFor(follower.doc);
    } catch (error) {
      // A document the model refuses: the reads that need it fall back, counted, as they would have.
      if (!(error instanceof EngineUnsupported)) throw error;
    }
  };
  const schedule = () => void (cancel ??= defer!(catchUp));
  const offPatch = store.onPatch(event => {
    if (crash) return;
    if (defer) {
      if (event.source === 'replace') {
        // Another document altogether: the follower's hints no longer lead from the shadow to it.
        follower.base = REPLACED;
        follower.doc = event.doc;
        follower.changed.clear();
      } else if (heldByShadow(follower, event)) {
        // A commit whose normalize ran in wasm (lane N1): the shadow holds this patch's final nodes as a journal entry
        // (`pending`), so applying the patch now costs that replay and the JSON of the few entries the transaction
        // wrote itself — less than the catch-up it saves, and what keeps the next commit in the shadow's reach when
        // no idle comes between commits (a key held down, a drag of the properties panel, a value stepped).
        try {
          shadow!.apply(event.doc, event.patch);
          follower.base = event.doc;
          follower.changed.clear();
          return;
        } catch (error) {
          if (!(error instanceof EngineUnsupported)) throw error;
        }
      }
      schedule();
      return;
    }
    try {
      const target = shadowOf(event.doc);
      if (event.source === 'replace') {
        if (target.doc !== event.doc) target.load(event.doc);
      } else if (target.doc === follower.base && follower.doc === event.doc && sameKeys(follower.changed, event.patch)) {
        // The shadow at the document before this patch: the patch is exact, send it as it is.
        target.apply(event.doc, event.patch);
      } else shadowFor(event.doc);
    } catch (error) {
      // The engine crashed while the shadow followed this patch: nothing follows from now on.
      if (!(crash && error instanceof EngineUnsupported)) throw error;
    }
    follower.base = follower.doc = event.doc;
    follower.changed.clear();
  });
  if (defer) schedule();
  return () => {
    if (defer && followers.has(follower)) deferred--;
    followers.delete(follower);
    cancel?.();
    offDocument();
    offPatch();
  };
}

/** Node entries per idle callback of `preload`: ≈ 10 ms of the laptop's main thread each (a part of `LOAD_PART`
 *  would be a long task the user's next input waits on). */
const PRELOAD_PART = 500;

/** A document no follower's hints lead from (after `replace`). */
const REPLACED = {} as DesignDocument;

/** Loads the follower's document into a new shadow at idle, its skeleton and then a part per idle callback; changes
 *  made meanwhile are noted by the follower and sent once the last part is in. Replaces the current shadow only then. */
function preload(follower: Follower, defer: IdleScheduler) {
  const doc = follower.doc;
  const ids = Object.keys(doc.nodes);
  let handle: MorfaDocHandle | null = null;
  let next = 0;
  let spent = 0;
  const fail = () => {
    if (!crash) handle?.free();
    preloading = null;
  };
  // What each part sent, as objects: the table may be written in place between two idle callbacks, so
  // the shadow remembers what the handle holds, not what the table shows when the last part is in.
  const sent = new Map<NodeId, SceneNode>();
  const step = () => {
    const t0 = now();
    try {
      if (!handle) {
        const whole = ids.length <= PRELOAD_PART;
        if (whole) for (const id of ids) sent.set(id, doc.nodes[id]);
        handle = new (engineWasm().MorfaDoc)(JSON.stringify(whole ? doc : {...doc, nodes: {}}));
      } else {
        const nodes: Record<NodeId, SceneNode> = {};
        for (const id of ids.slice(next, next + PRELOAD_PART)) {
          const node = doc.nodes[id];
          // An id removed meanwhile is not sent; the follower's changed ids cover it.
          if (!node) continue;
          nodes[id] = node;
          sent.set(id, node);
        }
        next += PRELOAD_PART;
        handle.load_part(JSON.stringify({nodes}));
      }
    } catch (error) {
      if (isCrash(error)) crashed('shadow', 'preload', error);
      return fail();
    }
    spent += now() - t0;
    if (ids.length > PRELOAD_PART && next < ids.length) {
      preloading = {cancel: defer(step)};
      return;
    }
    preloading = null;
    shadow?.dispose();
    shadow = new Shadow(handle, doc, sent);
    stats.loads++;
    stats.loadMs += spent;
    // The follower's changes since `doc` lead the shadow on from here; what happened meanwhile is sent at the next idle.
    if (!followers.has(follower)) return;
    if (follower.base !== REPLACED) follower.base = doc;
    if (follower.doc !== doc)
      defer(() => {
        if (!followers.has(follower) || preloading || shadow?.doc === follower.doc) return;
        try {
          shadowFor(follower.doc);
        } catch (error) {
          if (!(error instanceof EngineUnsupported)) throw error;
        }
      });
  };
  // The follower's hints count from `doc` on.
  follower.base = doc;
  follower.changed.clear();
  follower.doc = doc;
  preloading = {cancel: defer(step)};
}

/** Whether the shadow stands at the document before `event`'s patch and holds the patch's final nodes as the result of
 *  the normalize that produced them (`Shadow.pending`), with at most `NEAR_IDS` node entries to send as JSON (what the
 *  transaction wrote itself, which the normalize did not return): the patch can then be applied inside the commit at
 *  the cost of a reader's catch-up. */
function heldByShadow(follower: Follower, event: {patch: DocumentPatch; doc: DesignDocument}): boolean {
  if (!shadow || preloading || shadow.doc !== follower.base || follower.doc !== event.doc) return false;
  const pending = shadow.pending;
  if (!pending || pending.at !== shadow.doc || !sameKeys(follower.changed, event.patch)) return false;
  let json = 0, entries = 0;
  for (const id in event.patch.nodes) {
    const value = event.patch.nodes[id];
    if (!value || pending.objects.get(value) !== id) json++;
    // The replay itself is bounded too (a change of thousands of layers goes the idle way, in parts).
    if (json > NEAR_IDS || ++entries > PRELOAD_PART) return false;
  }
  return true;
}

/** True when the store's change events since the base name exactly the patch's nodes (no drag frame in between). */
function sameKeys(changed: ReadonlySet<NodeId>, patch: DocumentPatch): boolean {
  const keys = Object.keys(patch.nodes ?? {});
  return keys.length === changed.size && keys.every(id => changed.has(id));
}

// ── Browser report ──────────────────────────────────────────────────────────────────────────────────────────────

// In the browser the counters are one call away for a test or a person at the console (lane E1: the e2e spec
// design-engine.spec.ts reads them to prove which engine answered): `__MORFA_ENGINE_REPORT__()`.
if (!nodeEnv() && typeof window !== 'undefined')
  (globalThis as {__MORFA_ENGINE_REPORT__?: () => unknown}).__MORFA_ENGINE_REPORT__ = () => ({
    modes: (resolved ??= resolve()),
    byDefault: Object.fromEntries(ENGINE_MODULES.map(module => [module, engineByDefault(module)])),
    wasm: wasmModule !== null,
    crash,
    shadow: shadow ? {nodes: shadow.handle.stats().nodes, loads: stats.loads, patches: stats.patches} : null,
    modules: Object.fromEntries(ENGINE_MODULES.map(module => [module, {...counters[module]}])),
    calls: engineCallTable(),
  });

// ── Exit report ─────────────────────────────────────────────────────────────────────────────────────────────────

// MORFA_ENGINE_REPORT=<file>: each Node process appends one JSON line of its counters at exit (the gate's both-mode
// run sums them to show every module's wasm calls); MORFA_ENGINE_REPORT=1 prints them to stderr.
const report = nodeEnv()?.MORFA_ENGINE_REPORT;
if (report && runtime.process?.on) {
  runtime.process.on('exit', () => {
    const line = JSON.stringify({pid: (runtime.process as {pid?: number}).pid, modes: resolve(), modules: counters, calls: engineCallTable(), shadow: stats});
    if (report === '1') console.error(`engine-switch: ${line}`);
    else (runtime.process!.getBuiltinModule!('node:fs') as {appendFileSync(path: string, text: string): void}).appendFileSync(report, `${line}\n`);
  });
}
