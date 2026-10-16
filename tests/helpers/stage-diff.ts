import {applyVariablesDetailed} from '../../shared/design/variables';
import {syncInstancesDetailed} from '../../shared/design/components';
import {Draft} from '../../shared/design/constraints';
import {firstDifference, shadowFor, valueAt} from '../../shared/design/engine-switch';
import {fitGroups} from '../../shared/design/group-fit';
import {LayoutEngine, sizingFixes} from '../../shared/design/layout';
import {ancestry, autoResizeText, inFlow, normalizeDetailed} from '../../shared/design/normalize';
import type {TextMeasurer} from '../../shared/design/text-layout';
import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {testMeasurer} from './design-big-files';

// The stage oracle for the layout, instance and variable stages: one step of `normalizeDocument` (shared/design/normalize.ts,
// lines 128–216) run alone in TypeScript and in Rust on the same document and dirty set, and the results compared. Both
// sides measure text with the fixed-width fake (`testMeasurer` / `FixedWidthMeasurer`), so normalize never waits on text.
//
// The Rust side runs on the engine's shadow document (`shadowFor(doc).normalize_stage`, crates/wasm/src/normalize.rs), on
// the store's own nodes (lane N1); the stages it knows are crates/layout/src/normalize.rs `stage()`. A stage Rust does
// not have is an error, never a pass.
// A lane still on its own wasm build passes `rust` instead.
//
//   const diff = stageDiff('layout', doc, new Set(['frame1']));
//   assert.equal(diff.path, null, diff.message);

/** The steps of normalize.ts, by the names crates/layout/src/normalize.rs uses; `normalize` is all of them in order
 *  (`normalizeDetailed` against the Rust orchestrator); `noop` checks the harness itself. */
export type StageName = 'sizing' | 'textResize' | 'instances' | 'variables' | 'layout' | 'groupFit' | 'normalize' | 'noop';
export const STAGE_ORDER: readonly StageName[] = ['sizing', 'textResize', 'instances', 'variables', 'layout', 'groupFit'];
/** L2b's lane-local names (tests/helpers/stage-diff-l2b.ts) for the same steps. */
export const STAGE_ALIASES: Readonly<Record<string, StageName>> = {'sizing-fixes': 'sizing', 'text-resize': 'textResize', 'auto-layout': 'layout', 'group-fit': 'groupFit', sync: 'instances'};
const stageName = (name: string): StageName => STAGE_ALIASES[name] ?? (name as StageName);

/** What one stage did: the ids it returned to the stages after it, the ids it wrote or removed (in order), their
 *  values, and the variableModes entries it wrote (L2c's variables stage). */
export type StageResult = {reported: NodeId[]; written: NodeId[]; nodes: Record<NodeId, SceneNode | null>; modes: Record<NodeId, Record<string, string> | null>};

type TsStage = (draft: Draft, dirty: ReadonlySet<NodeId>, measurer: TextMeasurer) => Iterable<NodeId>;

/** Each step exactly as normalizeInto runs it, alone. */
export const TS_STAGES: Record<Exclude<StageName, 'normalize'>, TsStage> = {
  // 0: sizing corrections of the dirty nodes and their children.
  sizing: (draft, dirty) =>
    draft.collect(() => {
      const fix = (target: SceneNode | undefined) => {
        if (!target) return;
        const fixes = sizingFixes(target, draft.get(target.parentId));
        if (fixes) draft.update(target.id, fixes);
      };
      for (const id of dirty) {
        const node = draft.get(id);
        if (!node) continue;
        fix(node);
        const children = node.children;
        if (children) for (let i = 0; i < children.length; i++) fix(draft.get(children[i]));
      }
    }),
  // 1: text that sizes itself, out of an auto layout flow.
  textResize: (draft, dirty, measurer) =>
    draft.collect(() => {
      for (const id of dirty) {
        const node = draft.get(id);
        if (node?.type === 'TEXT' && !inFlow(draft, node)) autoResizeText(draft, node, measurer);
      }
    }),
  // 2: instances copy their main components (the former parents of removed copies are reported too).
  instances: (draft, dirty) => {
    const synced = syncInstancesDetailed(draft.doc, dirty, {owned: draft.ownsTable});
    if (synced.changed.size) draft.adopt(synced.doc, synced.changed);
    return new Set([...synced.changed, ...(synced.formerParents ?? [])]);
  },
  // 2: bound fields take their variables' values.
  variables: (draft, dirty) => {
    const resolved = applyVariablesDetailed(draft.doc, dirty, {owned: draft.ownsTable});
    if (resolved.changed.size) draft.adopt(resolved.doc, resolved.changed);
    return resolved.changed;
  },
  // 3: auto layout of the dirty chains (everything off them trusted).
  layout: (draft, dirty, measurer) => {
    const path = ancestry(draft, dirty);
    const engine = new LayoutEngine(draft, measurer, {trusted: id => !path.has(id)});
    return draft.collect(() => engine.run(dirty));
  },
  // 4: groups and booleans fit their children.
  groupFit: (draft, dirty) => draft.collect(() => fitGroups(draft, dirty)),
  noop: () => [],
};

/** The variableModes entries that differ between two documents (null: removed). */
function modesWritten(before: DesignDocument, after: DesignDocument): StageResult['modes'] {
  const out: StageResult['modes'] = {};
  const a = before.variableModes ?? {}, b = after.variableModes ?? {};
  if (a === b) return out;
  for (const id of Object.keys(b)) if (a[id] !== b[id]) out[id] = b[id];
  for (const id of Object.keys(a)) if (!Object.hasOwn(b, id)) out[id] = null;
  return out;
}

/** Runs the TypeScript step on a table-mode draft of `doc` (`normalize`: `normalizeDetailed`); `doc` is not changed. */
export function runTsStage(stage: StageName | string, doc: DesignDocument, dirty: ReadonlySet<NodeId>, measurer: TextMeasurer = testMeasurer): StageResult {
  const name = stageName(stage);
  if (name === 'normalize') {
    const result = normalizeDetailed(doc, dirty, {measurer});
    const written = [...result.changed];
    return {reported: written, written, nodes: Object.fromEntries(written.map(id => [id, result.doc.nodes[id] ?? null])), modes: modesWritten(doc, result.doc)};
  }
  const draft = new Draft(doc, {mode: 'table'});
  const reported = [...TS_STAGES[name](draft, dirty, measurer)];
  const written = [...draft.written];
  const nodes: Record<NodeId, SceneNode | null> = {};
  for (const id of written) nodes[id] = draft.get(id) ?? null;
  return {reported, written, nodes, modes: modesWritten(doc, draft.doc)};
}

/** Runs the Rust step on the shadow document brought to `doc`. */
export function runRustStage(stage: StageName | string, doc: DesignDocument, dirty: ReadonlySet<NodeId>): StageResult {
  return JSON.parse(shadowFor(doc).normalize_stage(stageName(stage), JSON.stringify([...dirty]))) as StageResult;
}

export type StageDiffOptions = {
  /** Numbers within this relative tolerance are equal (default 0: the stages are exact with the fake measurer). */
  tolerance?: number;
  /** Compare the order of `written` and `reported` too (default: as sets). */
  order?: boolean;
  /** The Rust side, for a lane on its own wasm build until its stage is in crates/wasm. */
  rust?: (name: StageName, doc: DesignDocument, dirty: ReadonlySet<NodeId>) => Omit<StageResult, 'modes'> & Partial<Pick<StageResult, 'modes'>>;
  measurer?: TextMeasurer;
};

export type StageDiff = {ts: StageResult; rust: StageResult; path: string | null; message: string};

const sorted = (ids: readonly NodeId[]) => [...new Set(ids)].sort();
// The values compared: plain JSON on both sides (Rust's come from JSON; the TypeScript's may hold undefined keys), with
// every lone UTF-16 surrogate as U+FFFD (Rust strings cannot hold one: S1's one documented difference).
const wellFormed = (_: string, value: unknown) => (typeof value === 'string' ? (value as string & {toWellFormed(): string}).toWellFormed() : value);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value ?? {}), wellFormed) as Record<NodeId, unknown>;

/** Runs the step both ways and finds the first difference: in the written values, then the written ids, then the
 *  reported ids. `path` null means equal. */
export function stageDiff(stage: StageName | string, doc: DesignDocument, dirty: ReadonlySet<NodeId>, options: StageDiffOptions = {}): StageDiff {
  const name = stageName(stage);
  const ts = runTsStage(name, doc, dirty, options.measurer);
  const answer = options.rust ? options.rust(name, doc, dirty) : runRustStage(stageName(stage), doc, dirty);
  const rust: StageResult = {...answer, modes: answer.modes ?? {}};
  const tolerance = options.tolerance ?? 0;
  const ids = (list: readonly NodeId[]) => (options.order ? [...list] : sorted(list));
  const path =
    firstDifference(plain(ts.nodes), plain(rust.nodes), tolerance, '.nodes') ??
    firstDifference(plain(ts.modes), plain(rust.modes), 0, '.modes') ??
    firstDifference(ids(ts.written), ids(rust.written), 0, '.written') ??
    firstDifference(ids(ts.reported), ids(rust.reported), 0, '.reported');
  const at = (result: StageResult) => {
    const root = {nodes: plain(result.nodes), modes: plain(result.modes), written: ids(result.written), reported: ids(result.reported)};
    return JSON.stringify(valueAt(root, path ?? ''))?.slice(0, 300) ?? 'undefined';
  };
  const label = stageName(stage);
  const message = path === null ? `stage ${label}: equal` : `stage ${label} differs at ${path} (dirty ${JSON.stringify([...dirty]).slice(0, 120)})\n  ts:   ${at(ts)}\n  rust: ${at(rust)}`;
  return {ts, rust, path, message};
}

/** Throws with the diff when the step's two engines disagree. */
export function assertStageEqual(name: StageName | string, doc: DesignDocument, dirty: ReadonlySet<NodeId>, options?: StageDiffOptions): StageDiff {
  const diff = stageDiff(name, doc, dirty, options);
  if (diff.path !== null) throw new Error(diff.message);
  return diff;
}
