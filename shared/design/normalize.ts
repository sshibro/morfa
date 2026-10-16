import type {DesignDocument, NodeId, SceneNode} from './types';
import type {FontSpec, TextMeasurer} from './text-layout';
import {measurementEpoch, textBoxSize} from './text-layout';
import {syncInstancesDetailed} from './components';
import {applyVariablesDetailed} from './variables';
import {apply, localMatrix} from './geometry';
import {Draft, isAutoLayout, sameValue} from './constraints';
import {LayoutEngine, sizingFixes} from './layout';
import type {LayoutStats} from './layout';
import {fitGroups} from './group-fit';
import {copyTable, forgetTable, type TableLog} from './table-cache';
import {EngineSkipped, EngineUnsupported, engineByDefault, engineFor, engineMemory, engineTs, firstDifference, inTypeScript, keepNormalized, shadowBeside, shadowFrameAt, shadowInReach, withEngine} from './engine-switch';
import type {MorfaDocHandle} from './engine-switch';

// The pass every committed change goes through before it is stored, drawn or saved:
//   0. sizing fields that no longer apply are corrected (FILL outside auto layout → FIXED, ...)
//   1. text auto-resize            (shared/design/text-layout.ts `textBoxSize`)
//   2. instance sync               (shared/design/components.ts `syncInstances`), then variables
//                                  (shared/design/variables.ts `applyVariables`)
//   3. auto layout, bottom-up measure then top-down arrange (shared/design/layout.ts)
//   4. GROUP / BOOLEAN_OPERATION boxes fit their children (shared/design/group-fit.ts)
// Steps 3–4 repeat while group fitting changes something a layout depends on (at most 3 rounds).
// A board's document (`doc.board`, docs/board.md) adds two steps; a design file never runs them: before 3, stickies fit
// their text and hand-resized notes and shapes keep their height as a least height; after 4, connectors whose
// ends moved run again and their groups fit (shared/design/board/normalize.ts). Those steps are installed where boards open
// (`installBoardNormalize`, called by shared/design/board/install.ts from the board editor's chunk), so a design file's code
// never carries them; a board normalized before they are installed stays valid, its stickies and connectors merely unfitted.
//
// `dirty` holds the ids a transaction touched: changed, created and moved nodes, and the parents
// of removed or moved ones. Only the chains through them are evaluated: a frame's layout is
// recomputed when a child changed, and its parent's when it hugs; everything off those chains is
// trusted to be laid out already (the document was normalized before the change). A document
// that never was (an import, a version from before a layout fix) is normalized whole by passing
// every id. Returns `doc` itself when nothing moved, and is idempotent.

export type NormalizeStats = LayoutStats & {textResized: number; fitted: number; rounds: number};
export type NormalizeContext = {
  measurer: TextMeasurer;
  /** Optional counters of the work done (tests and profiling). */
  stats?: NormalizeStats;
};

const MAX_ROUNDS = 3;
const ANCHOR = {LEFT: 0, CENTER: 0.5, RIGHT: 1, JUSTIFIED: 0} as const;

export const emptyNormalizeStats = (): NormalizeStats => ({measured: 0, arranged: 0, textMeasured: 0, textResized: 0, fitted: 0, rounds: 0});

/** Exported for the stage oracle (tests/helpers/stage-diff.ts), which runs each step alone. */
export const inFlow = (draft: Draft, node: SceneNode) => node.visible && node.layoutPositioning !== 'ABSOLUTE' && isAutoLayout(draft.get(node.parentId));

/** Resizes an auto-resizing text to its content. Auto-width text grows away from its alignment
 *  edge (centred text keeps its centre), as Figma does while typing. */
export function autoResizeText(draft: Draft, node: SceneNode, measurer: TextMeasurer): boolean {
  const mode = node.text?.textAutoResize;
  if (mode !== 'WIDTH_AND_HEIGHT' && mode !== 'HEIGHT') return false;
  const size = textBoxSize(node, measurer);
  if (sameValue(size.width, node.width) && sameValue(size.height, node.height)) return false;
  const anchor = mode === 'WIDTH_AND_HEIGHT' ? ANCHOR[node.text!.textAlignHorizontal] : 0;
  const fixed = apply(localMatrix(node), {x: node.width * anchor, y: 0});
  const moved = apply(localMatrix({...node, x: 0, y: 0, ...size}), {x: size.width * anchor, y: 0});
  return draft.update(node.id, {x: fixed.x - moved.x, y: fixed.y - moved.y, width: size.width, height: size.height});
}

/** The nodes and all their ancestors: what is not on these paths kept its measured size. */
export function ancestry(draft: Draft, ids: Iterable<NodeId>): Set<NodeId> {
  const path = new Set<NodeId>();
  for (const id of ids) {
    if (!draft.get(id)) path.add(id);
    for (let node = draft.get(id); node && !path.has(node.id); node = draft.get(node.parentId)) path.add(node.id);
  }
  return path;
}

export type NormalizeResult = {
  doc: DesignDocument;
  /** Every node id normalization wrote or deleted: a superset of the entries that differ from the
   *  input document (a transaction builds its patch from these instead of diffing the file). */
  changed: ReadonlySet<NodeId>;
};

export type NormalizeOptions = {
  /** `doc.nodes` is a private table the caller lets normalization write into in place (a
   *  transaction's own copy). No pass copies the node table then. */
  owned?: boolean;
  /** With `owned`: the table is a document's own, written in place: every pass logs the entry an id
   *  held before its first write here, so the commit's inverse and the view of the document before come from the log. */
  log?: TableLog;
  /** `doc.nodes` differs from `origin.nodes` only at `origin.changed`. Indexes cached for that table
   *  (instances by component, nodes by variable) are then carried over by looking at those ids
   *  instead of being rebuilt by a scan of the whole file. */
  origin?: {nodes: Readonly<Record<NodeId, SceneNode>>; changed: Iterable<NodeId>; doc?: DesignDocument};
};

const NOTHING: ReadonlySet<NodeId> = new Set();

/** "Board": the board's steps (shared/design/board/normalize.ts), plugged in by shared/design/board/install.ts. */
export type BoardNormalizeSteps = {
  /** Before layout: stickies, shapes with text and tables among the touched layers. */
  fit(draft: Draft, touched: Iterable<NodeId>, measurer: TextMeasurer): void;
  /** The draft's connectors (the origin's cached set adjusted by what changed since). */
  connectorsIn(draft: Draft, origin: BoardOrigin | undefined): ReadonlySet<NodeId>;
  /** After layout: connectors whose ends moved run again. */
  route(draft: Draft, moved: ReadonlySet<NodeId>, connectors: ReadonlySet<NodeId>, origin: BoardOrigin | undefined): void;
};
export type BoardOrigin = {nodes: Readonly<Record<NodeId, SceneNode>>; changed: Iterable<NodeId>};
let boardSteps: BoardNormalizeSteps | null = null;

/** Installs the board's normalization steps (once, where boards open). */
export function installBoardNormalize(steps: BoardNormalizeSteps): void {
  boardSteps = steps;
}

export function normalizeDocument(doc: DesignDocument, dirty: ReadonlySet<NodeId>, context: NormalizeContext): DesignDocument {
  return normalizeDetailed(doc, dirty, context).doc;
}

/** `normalizeDocument`, also returning the ids it wrote. Every pass works in one table: copied from
 *  `doc.nodes` on the first write, or `doc.nodes` itself when the caller says it `owned` it. So a
 *  change costs what it touches: no pass copies or compares the whole file. */
export function normalizeDetailed(doc: DesignDocument, dirty: ReadonlySet<NodeId>, context: NormalizeContext, options: NormalizeOptions = {}): NormalizeResult {
  if (!dirty.size) return {doc, changed: NOTHING};
  if (engineTs('normalize')) return normalizeTs(doc, dirty, context, options);
  // The engine switch (shared/design/engine-switch.ts, module 'normalize'): the whole pass as one call, every stage in
  // Rust (crates/layout/src/normalize.rs) or every stage in TypeScript, never a mix (the atomic flip).
  // What Rust reads is worked out first: in `both` the TypeScript runs first and may write `doc.nodes` in place.
  const input = wasmInput(doc, dirty, context, options);
  return withEngine<NormalizeAnswer>(
    'normalize',
    'normalizeDetailed',
    () => inTypeScript('normalize', () => normalizeTs(doc, dirty, context, options)),
    () => normalizeWasm(doc, input, options),
    {equal: sameNormalize, inputs: () => [...dirty]},
  );
}

// ── Rust ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What crates/wasm `MorfaDoc.normalize` sends: per written node `null` (removed), `{node}` (added) or the fields that
 *  changed (`{set, unset}`, merged over the node as it was; `same`: keys whose value is the one the entry of that id
 *  sent, shared as TypeScript's copies share their main's); a node that changed its box alone crosses as numbers
 *  instead (`normalized_boxes`). */
type WasmEntry = null | {node: SceneNode} | {set: Partial<SceneNode>; unset: string[]; same?: Record<string, NodeId>};
type WasmNormalize = {written: NodeId[]; nodes: Record<NodeId, SceneNode | null>; modes: Record<NodeId, Record<string, string> | null>};
type WasmInput = {
  handle: MorfaDocHandle;
  patch: string;
  /** Entries that changed a few fields of a node the shadow holds, as those fields (`shadowBeside`). */
  fields: string;
  /** The patch's node entries (the document's own objects). */
  sent: Readonly<Record<NodeId, SceneNode | null>>;
  dirty: string;
  node: (id: NodeId) => SceneNode | undefined;
  modesBefore: Readonly<Record<NodeId, Record<string, string>>>;
  /** The measurer as crates/wasm asks it, or null for the fixed-width fake (Rust's own). */
  measure: MeasurerFunction | null;
};
const NO_NUMBERS = new Float64Array(0);

/** `count` numbers `normalize` left (`MorfaDoc.normalized_numbers`), viewed in wasm memory: read before the next call. */
function numbers(handle: MorfaDocHandle, which: number, count: number): Float64Array {
  return count ? new Float64Array(engineMemory().buffer, handle.normalized_numbers(which), count) : NO_NUMBERS;
}

/** The fields `normalized_shares` names, by their bit in crates/wasm delta.rs `changed_fields`. */
const SHARED_FIELDS: Record<number, string> = {19: 'fills', 20: 'strokes', 27: 'effects', 68: 'text'};

/** In `both`, what the Rust pass wrote rides along with the TypeScript-shaped result for the comparison. */
type NormalizeAnswer = NormalizeResult & {wasm?: WasmNormalize; modesBefore?: WasmInput['modesBefore']};

/** The shadow and the patch Rust normalizes on (or why it cannot): with a transaction's `origin.doc`, the shadow stays
 *  at that committed base and the transaction's own writes cross as a patch of the ids it touched; otherwise the shadow
 *  is brought to `doc` itself (a copy of it when the pass may write the table in place afterwards). */
function wasmInput(doc: DesignDocument, dirty: ReadonlySet<NodeId>, context: NormalizeContext, options: NormalizeOptions): WasmInput | EngineUnsupported {
  try {
    // Rust measures with its own fixed-width fake when that is the measurer, else through the measurer itself (lane
    // E1): only one that keeps the TextMeasurer contract, a `revision` that changes whenever its answers would.
    const measure = fixedWidth(context.measurer) ? null : measurerFunction(context.measurer);
    if (measure === undefined) throw new EngineUnsupported('normalize in wasm measures with the fixed-width fake or a measurer with a revision');
    if (doc.board === true && boardSteps) throw new EngineUnsupported("a board's steps are TypeScript only");
    const mode = engineFor('normalize');
    if (context.stats && mode === 'wasm') throw new EngineUnsupported('the Rust pass does not count its work (NormalizeContext.stats)');
    // `both` is the oracle: for a followed store's document it compares only where the shadow already is (or a patch
    // away) and never loads it or compares the whole file for the call (the oracle's work would count as the edit's: a
    // keystroke enumerating the file); the store's patches bring the shadow along. `wasm` chosen (`?engine=`, the
    // environment) brings it wherever it must. `wasm` by default (EDITOR_DEFAULTS alone, lane N1) keeps to the shadow's
    // reach as geometry's readers do (`shadowInReach`): never a load or a comparison of the whole file inside a commit, and
    // TypeScript answers while the engine or the shadow is loading at idle or the shadow is more than a few ids behind
    // (counted as skipped). Where `shadowInReach` says yes the shadow is at the base or a patch away: `load` never loads.
    // Without a base, the shadow is brought to `doc` itself: a copy of it when the pass may write `doc.nodes` in place
    // (the shadow must not hold a document whose table changes under it).
    let base = options.origin?.doc ?? (options.owned ? {...doc} : doc);
    const changed = options.origin?.doc ? options.origin.changed : [];
    const byDefault = mode === 'wasm' && engineByDefault('normalize');
    if (byDefault && !shadowInReach(base)) {
      // A gesture's frame while the shadow stands at an earlier frame of it (brought there at idle): the writes cross
      // from that frame — they are the transaction's own, which the call sends anyway. Otherwise TypeScript answers.
      const frame = options.origin && options.origin.changed instanceof Set ? shadowFrameAt(base, options.origin.changed) : null;
      if (!frame) throw new EngineSkipped('the shadow is not near this document (loading at idle, or many ids behind)');
      base = frame;
    }
    const {handle, patch, fields, sent, node} = shadowBeside(doc, base, changed, {load: mode === 'wasm' ? true : 'unfollowed', fields: true});
    return {handle, patch, fields, sent, node, dirty: JSON.stringify([...dirty]), modesBefore: {...(doc.variableModes ?? {})}, measure};
  } catch (error) {
    if (error instanceof EngineUnsupported) return error;
    throw error;
  }
}

/** A measurer as crates/wasm's `normalize` asks it (`JsMeasurer`): `call(text, font)` → width, `call(null, font)` →
 *  `[ascent, descent]`, the font as `family \0 weight \0 italic \0 size`; `id` names the measurer and `epoch()` its
 *  revision as text-layout.ts counts it (a new one drops the layouts Rust kept for it). */
type MeasurerFunction = {id: number; call: (text: string | null, font: string) => number | number[]; epoch: () => number};
const measurerFunctions = new WeakMap<TextMeasurer, MeasurerFunction>();
let measurerIds = 0;

/** The measurer's function for Rust, or undefined for one without a `revision` (its answers may change unannounced:
 *  layouts Rust keeps could then differ from the TypeScript's). */
function measurerFunction(measurer: TextMeasurer): MeasurerFunction | undefined {
  if (typeof measurer.revision !== 'number') return undefined;
  let known = measurerFunctions.get(measurer);
  if (!known) {
    const fonts = new Map<string, FontSpec>();
    const fontOf = (key: string) => {
      let font = fonts.get(key);
      if (!font) {
        const [family, weight, italic, size] = key.split('\0');
        fonts.set(key, (font = {family, weight: Number(weight), italic: italic === '1', size: Number(size)}));
      }
      return font;
    };
    known = {
      id: ++measurerIds,
      call: (text, key) => {
        const font = fontOf(key);
        if (text !== null) return measurer.width(text, font);
        const metrics = measurer.metrics(font);
        return [metrics.ascent, metrics.descent];
      },
      epoch: () => measurementEpoch(measurer),
    };
    measurerFunctions.set(measurer, known);
  }
  return known;
}

/** Whether `measurer` is the fixed-width fake (`testMeasurer`: every UTF-16 unit half an em, ascent 0.8, descent 0.2),
 *  asked on every call: a measurer that loads fonts changes its answers (no real font sets "W" and "i" both half an em
 *  wide, but a measurer waiting for its font may). */
function fixedWidth(measurer: TextMeasurer): boolean {
  try {
    const font = {family: 'Inter', weight: 400, italic: false, size: 10};
    const metrics = measurer.metrics(font);
    return measurer.width('W', font) === 5 && measurer.width('i', font) === 5 && metrics.ascent === 8 && metrics.descent === 2;
  } catch {
    return false;
  }
}

function normalizeWasm(doc: DesignDocument, input: WasmInput | EngineUnsupported, options: NormalizeOptions): NormalizeAnswer {
  if (input instanceof EngineUnsupported) throw input;
  let text: string;
  // In `wasm` the shadow keeps the final nodes for the commit that follows (both returns TypeScript's objects).
  const keep = engineFor('normalize') === 'wasm';
  keepNormalized(input.handle, null);
  try {
    const measure = input.measure;
    text = measure ? input.handle.normalize(input.patch, input.fields, input.dirty, keep, measure.call, measure.id, measure.epoch()) : input.handle.normalize(input.patch, input.fields, input.dirty, keep);
  } catch (error) {
    // A transaction's entry the model refuses (a test's partial node; the store's own documents always parse).
    if (error instanceof Error && error.message.startsWith('MorfaDoc.normalize: patch:')) throw new EngineUnsupported(error.message);
    throw error;
  }
  // A string the model cannot hold (a lone UTF-16 surrogate reads as U+FFFD) stays in TypeScript.
  if (text.includes('\uFFFD') || text.includes('\\ufffd')) throw new EngineUnsupported('a written string holds U+FFFD (a lone surrogate the model cannot hold)');
  const sent = JSON.parse(text) as {written: NodeId[]; from: NodeId[]; nodes: Record<NodeId, WasmEntry>; numbers: [number, number]; modes: WasmNormalize['modes']};
  // A sender's value: a written node's as written, else the patch's node as JavaScript holds it.
  const sender = (id: NodeId, key: string) => ((entries[id] ?? input.node(id)) as unknown as Record<string, unknown>)[key];
  const entries: Record<NodeId, SceneNode | null> = {};
  let shared: NodeId[] | null = null;
  for (const id in sent.nodes) {
    const entry = sent.nodes[id];
    if (!entry) entries[id] = null;
    else if ('node' in entry) entries[id] = entry.node;
    else {
      const before = input.node(id);
      if (!before) throw new Error(`normalize: Rust changed fields of ${id}, which the document does not hold`);
      // As TypeScript's `{...node, ...changes}`: kept keys stay where they were, new ones follow.
      const next = {...before, ...entry.set} as Record<string, unknown>;
      for (const key of entry.unset) delete next[key];
      entries[id] = next as unknown as SceneNode;
      if (entry.same) (shared ??= []).push(id);
    }
  }
  // Keys the node already had (Rust shares no other), so the order stays.
  if (shared)
    for (const id of shared) {
      const same = (sent.nodes[id] as {same: Record<string, NodeId>}).same;
      const next = entries[id] as unknown as Record<string, unknown>;
      for (const key in same) next[key] = sender(same[key], key);
    }
  // Nodes that changed only values an earlier entry sent: [node, field, sender] by place in `written`.
  const shares = numbers(input.handle, 1, sent.numbers[1]);
  for (let at = 0; at < shares.length; at += 3) {
    const id = sent.written[shares[at]];
    const key = SHARED_FIELDS[shares[at + 1]];
    const before = input.node(id);
    if (!before || !key) throw new Error(`normalize: Rust shared a value into ${id}, which the document does not hold`);
    const next = (entries[id] ?? {...before}) as unknown as Record<string, unknown>;
    const from = shares[at + 2];
    next[key] = sender(from < sent.written.length ? sent.written[from] : sent.from[from - sent.written.length], key);
    entries[id] = next as unknown as SceneNode;
  }
  // Box changes: into the entries for `both`'s comparison, else straight into the table below (most of a reflow).
  const both = engineFor('normalize') === 'both';
  const boxes = numbers(input.handle, 0, sent.numbers[0]);
  const boxed: SceneNode[] = [];
  for (let at = 0; at < boxes.length; at += 5) {
    const id = sent.written[Math.floor(boxes[at] / 16)];
    const mask = boxes[at] % 16;
    // In `wasm` nothing wrote `doc.nodes` since the patch was made: its node is the one Rust started from.
    const before = both ? input.node(id) : doc.nodes[id];
    if (!before) throw new Error(`normalize: Rust changed the box of ${id}, which the document does not hold`);
    const next = {...before};
    if (mask & 1) next.x = boxes[at + 1];
    if (mask & 2) next.y = boxes[at + 2];
    if (mask & 4) next.width = boxes[at + 3];
    if (mask & 8) next.height = boxes[at + 4];
    if (both) entries[id] = next;
    else boxed.push(next);
  }
  const result: WasmNormalize = {written: sent.written, nodes: entries, modes: sent.modes};
  const changed = new Set(result.written);
  // `both` returns the TypeScript's document: this one only has to compare.
  if (both) return {doc: {...doc, nodes: result.nodes as Record<NodeId, SceneNode>, variableModes: result.modes as Record<NodeId, Record<string, string>>}, changed, wasm: result, modesBefore: input.modesBefore};
  const modeIds = Object.keys(result.modes);
  const objects = new Map<object, NodeId>();
  for (const id in input.sent) if (input.sent[id]) objects.set(input.sent[id]!, id);
  if (!changed.size && !modeIds.length) {
    keepNormalized(input.handle, objects);
    return {doc, changed};
  }
  // As the TypeScript pass: into `doc.nodes` itself when the caller lends it, else into a copy.
  if (options.owned) forgetTable(doc.nodes);
  const nodes = options.owned ? doc.nodes : copyTable(doc.nodes);
  const log = options.owned ? options.log : undefined;
  for (const node of boxed) log?.touch(node.id), (nodes[node.id] = node), objects.set(node, node.id);
  for (const id of result.written) {
    if (!(id in entries)) continue;
    const node = entries[id];
    if (node) log?.touch(id), (nodes[id] = node), objects.set(node, id);
    else log?.deleting(id), delete nodes[id];
  }
  keepNormalized(input.handle, objects);
  const out: DesignDocument = {...doc, nodes};
  if (modeIds.length) {
    const modes = {...(doc.variableModes ?? {})};
    for (const id of modeIds) {
      const value = result.modes[id];
      if (value) modes[id] = value;
      else delete modes[id];
    }
    if (Object.keys(modes).length) out.variableModes = modes;
    else delete out.variableModes;
  }
  return {doc: out, changed};
}

const plain = (value: unknown) => (value === undefined ? null : JSON.parse(JSON.stringify(value)));

/** The first difference of a TypeScript value and one built from what Rust sent: compared as they are first, and only
 *  on a difference again as JSON (−0 crosses as 0, an undefined field as absent). */
function differs(ts: unknown, wasm: unknown, path: string): string | null {
  if (firstDifference(ts ?? null, wasm ?? null, 0, path) === null) return null;
  return firstDifference(plain(ts), plain(wasm), 0, path);
}

/** Both passes agree: the same ids written, the same entries and variable modes after. */
function sameNormalize(ts: NormalizeAnswer, wasm: NormalizeAnswer): string | null {
  const result = wasm.wasm!;
  const ids = firstDifference([...ts.changed].sort(), [...result.written].sort(), 0, '.changed');
  if (ids !== null) return ids;
  for (const id of ts.changed) {
    const path = differs(ts.doc.nodes[id], result.nodes[id], `.doc.nodes[${JSON.stringify(id)}]`);
    if (path !== null) return path;
  }
  // Variable modes: the entries Rust wrote, and every entry the TypeScript replaced (its table is a copy of the one
  // before the call, entry objects shared, when it changed nothing there).
  const before = wasm.modesBefore!;
  const after = ts.doc.variableModes ?? {};
  const touched = new Set(Object.keys(result.modes));
  for (const id in after) if (after[id] !== before[id]) touched.add(id);
  for (const id in before) if (!(id in after)) touched.add(id);
  for (const id of touched) {
    const path = differs(after[id], id in result.modes ? result.modes[id] : before[id], `.doc.variableModes[${JSON.stringify(id)}]`);
    if (path !== null) return path;
  }
  return null;
}

function normalizeTs(doc: DesignDocument, dirty: ReadonlySet<NodeId>, context: NormalizeContext, options: NormalizeOptions): NormalizeResult {
  // Indexes derived from a table about to be written in place would go stale.
  if (options.owned) forgetTable(doc.nodes);
  const draft = new Draft(doc, {mode: 'table', owned: options.owned, log: options.log});
  try {
    normalizeInto(draft, dirty, context, options);
  } finally {
    // What a pass derived from the working table mid-way (the table kept changing after) is dropped.
    if (draft.ownsTable) forgetTable(draft.doc.nodes);
  }
  return {doc: draft.toDocument(), changed: draft.written};
}

function normalizeInto(draft: Draft, dirty: ReadonlySet<NodeId>, context: NormalizeContext, options: NormalizeOptions): void {
  const {measurer} = context;
  const stats = context.stats ?? emptyNormalizeStats();
  const touched = new Set(dirty);

  // 0–1: sizing corrections, then text that sizes itself (text in a flow is measured by layout).
  const fix = (target: SceneNode | undefined) => {
    if (!target) return;
    const fixes = sizingFixes(target, draft.get(target.parentId));
    if (fixes) draft.update(target.id, fixes);
  };
  const corrected = draft.collect(() => {
    for (const id of dirty) {
      const node = draft.get(id);
      if (!node) continue;
      // The node, then its children (each read after the writes before it).
      fix(node);
      const children = node.children;
      if (children) for (let i = 0; i < children.length; i++) fix(draft.get(children[i]));
    }
  });
  for (const id of corrected) touched.add(id);
  for (const id of touched) {
    const node = draft.get(id);
    if (node?.type === 'TEXT' && !inFlow(draft, node) && autoResizeText(draft, node, measurer)) stats.textResized++;
  }

  // 2: instances copy their main components, then bound fields take their variables' values.
  // Neither step can measure, so text they changed (an overridden copy, a TEXT property, a bound
  // string) is auto-resized again here; text in a flow is measured by layout below. Both write
  // into the draft's table when it has one, and report the ids they wrote or deleted (with the
  // former parents of deleted copies), which join the dirty set as before.
  const origin = options.origin && {nodes: options.origin.nodes, changed: union(options.origin.changed, draft.written)};
  const again = new Set<NodeId>();
  const synced = syncInstancesDetailed(draft.doc, touched, {owned: draft.ownsTable, origin, log: options.log});
  if (synced.changed.size) {
    draft.adopt(synced.doc, synced.changed);
    for (const id of synced.changed) again.add(id);
    for (const id of synced.formerParents ?? []) again.add(id);
    for (const id of again) touched.add(id);
  }
  const resolved = applyVariablesDetailed(draft.doc, touched, {owned: draft.ownsTable, origin, log: options.log});
  if (resolved.changed.size) {
    draft.adopt(resolved.doc, resolved.changed);
    for (const id of resolved.changed) {
      touched.add(id);
      again.add(id);
    }
  }
  for (const id of again) {
    const node = draft.get(id);
    if (node?.type === 'TEXT' && !inFlow(draft, node) && autoResizeText(draft, node, measurer)) stats.textResized++;
  }

  // 2½ (boards): stickies, shapes with text and tables among the touched layers. A design file never gets here.
  const steps = draft.base.board === true ? boardSteps : null;
  const board = !!steps;
  if (steps) for (const id of draft.collect(() => steps.fit(draft, touched, measurer))) touched.add(id);

  // 3–4: layout of the affected chains, then group fitting, until groups stop moving. A board with connectors also
  // keeps every id that moved, for step 5.
  const boardOrigin = board && options.origin ? {nodes: options.origin.nodes, changed: options.origin.changed} : undefined;
  const connectors = steps ? steps.connectorsIn(draft, boardOrigin) : null;
  const moved = connectors?.size ? new Set(touched) : null;
  let round: Set<NodeId> = touched;
  for (let pass = 0; pass < MAX_ROUNDS; pass++) {
    stats.rounds++;
    const path = ancestry(draft, round);
    const engine = new LayoutEngine(draft, measurer, {trusted: id => !path.has(id), stats});
    const laidOut = draft.collect(() => engine.run(round));
    const fitted = draft.collect(() => fitGroups(draft, [...round, ...laidOut], stats));
    if (moved) {
      for (const id of laidOut) moved.add(id);
      for (const id of fitted) moved.add(id);
    }
    if (!fitted.size) break;
    round = fitted;
  }

  // 5 (boards): connectors whose ends moved, then the groups they are.
  if (moved && steps) {
    const routed = draft.collect(() => steps.route(draft, moved, connectors!, boardOrigin));
    if (routed.size) fitGroups(draft, routed, stats);
  }
}

/** The ids of both, each once, without copying either; iterable again and again (one walk per
 *  index carried over), and it sees ids added to `b` after it was made. */
function union(a: Iterable<NodeId>, b: ReadonlySet<NodeId>): Iterable<NodeId> {
  return {
    *[Symbol.iterator]() {
      const seen = new Set<NodeId>();
      for (const id of a) {
        seen.add(id);
        yield id;
      }
      for (const id of b) if (!seen.has(id)) yield id;
    },
  };
}
