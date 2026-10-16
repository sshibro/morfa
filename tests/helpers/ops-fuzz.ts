// The both-mode patch-pair fuzz of the ops port: random documents, two people's
// concurrent edits made on the same base with real transactions, and every ported function run through the engine
// switch in `both` (shared/design/engine-switch.ts: the TypeScript and the Rust of crates/ops on the same inputs, the
// answers compared exactly by shared/design/ops-engine.ts `opsEqual`; a difference throws EngineDiffError).
//
//   npx tsx scripts/engine/ops-fuzz.ts [cases=10000] [seed=1]     (tests/design-ops-engine.test.ts runs a few hundred)
//
// Per case: `mergeChange` (with the full `before`, a partial one and none), `applyPatch` of the outcome, `invertPatch`
// (and that it restores the document), `composePatches` (and that it equals applying both in turn), `diffDocuments`,
// `rebaseLocal`, `applyDocumentChange`, `storedValues`, `checkPatchedDocument`, plus `textEdit` and `mergeList` on
// random inputs. Equality is exact: the same JSON text after the model's number format, key order included. The edits
// here keep the refusals and identity cases of the transaction (S2's `fuzzPatchPair`, tests/helpers/design-fuzz.ts,
// is the shared generator; tests/design-ops-engine.test.ts runs it through the switch too).

import assert from 'node:assert/strict';
import {createDocument, createNode, defaultAutoLayout, defaultTextProps, solid} from '../../shared/design/defaults';
import {applyPatch, composePatches, diffDocuments, invertPatch, type DocumentPatch} from '../../shared/design/patch';
import {documentTarget, mergeChange, mergeList, rebaseLocal, textEdit} from '../../shared/design/merge';
import {beginTransaction, type Transaction} from '../../shared/design/transaction';
import {validateDocument} from '../../shared/design/schema';
import {applyStyleToRange, insertText} from '../../shared/design/text-edit';
import {createInstance} from '../../shared/design/components';
import {applyDocumentChange, storedValues} from '../../server/design/apply';
import type {DesignDocument, NodeId, NodeType, SceneNode, Variable, VariableCollection} from '../../shared/design/types';
import {checkPatchedDocument} from '../../shared/design/ops-check';
import {engineCalls, engineFor, engineWasm} from '../../shared/design/engine-switch';
import {testMeasurer} from './design-big-files';

// ── Randomness ────────────────────────────────────────────────────────────────────────────────────

export type Rng = () => number;
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (rng: Rng, n: number) => Math.floor(rng() * n);
const pick = <T>(rng: Rng, list: readonly T[]): T => list[int(rng, list.length)];
const chance = (rng: Rng, p: number) => rng() < p;
// Cyrillic, an accent, an emoji: multi-byte text on purpose, so offsets are checked in more than one width.
const WORDS = ['a', 'b', 'Привет', 'мир', ' ', '\n', 'xyz', '😀', 'ok', 'é', '12'];
const words = (rng: Rng, n: number) => Array.from({length: n}, () => pick(rng, WORDS)).join('');
/** An offset moved off the middle of a surrogate pair (the editor's caret never stands there). */
const boundary = (text: string, at: number) => (at > 0 && at < text.length && /[\uDC00-\uDFFF]/.test(text[at]) ? at - 1 : at);

// ── Documents ─────────────────────────────────────────────────────────────────────────────────────

const CONTAINERS: NodeType[] = ['FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'BOOLEAN_OPERATION'];
const LEAVES: NodeType[] = ['RECTANGLE', 'ELLIPSE', 'TEXT', 'LINE', 'STAR'];
const CONTEXT = {measurer: testMeasurer};

const isCopy = (node: SceneNode | undefined) => node?.mainId !== undefined;
/** Containers a new layer may go into: not instances or their copies, not the library page. */
function holders(doc: DesignDocument): NodeId[] {
  return Object.values(doc.nodes)
    .filter(node => node.children && node.type !== 'INSTANCE' && node.type !== 'COMPONENT_SET' && !isCopy(node) && node.id !== 'morfa:library')
    .map(node => node.id);
}
const layers = (doc: DesignDocument) => Object.values(doc.nodes).filter(node => node.type !== 'PAGE').map(node => node.id);

function leaf(rng: Rng, id: string): SceneNode {
  const type = pick(rng, LEAVES);
  const node = createNode(type, {id, x: int(rng, 400), y: int(rng, 400), width: 10 + int(rng, 100), height: 10 + int(rng, 100), rotation: chance(rng, 0.2) ? int(rng, 360) - 180 : 0});
  if (type === 'TEXT') {
    let text = defaultTextProps(words(rng, 1 + int(rng, 6)));
    if (chance(rng, 0.5) && text.characters.length > 1) text = applyStyleToRange(text, 0, boundary(text.characters, int(rng, text.characters.length) + 1), {fontWeight: 700});
    if (chance(rng, 0.2)) text = {...text, listTypes: ['UNORDERED']};
    node.text = text;
  }
  if (chance(rng, 0.3)) node.pluginData = {k1: 'v' + int(rng, 3), k2: 'w'};
  if (chance(rng, 0.2)) node.annotations = [{id: 'an' + int(rng, 3), label: words(rng, 2)}];
  if (chance(rng, 0.15)) node.flipX = true;
  return node;
}

let counter = 0;
const fresh = (prefix: string) => `${prefix}${++counter}`;

/** A small random document: two or three pages, frames, groups, texts, a component with instances, styles, variables. */
export function randomDocument(rng: Rng): DesignDocument {
  let doc = createDocument('p0');
  const tx = beginTransaction(doc);
  for (let p = 1; p < 2 + int(rng, 2); p++) tx.addPage(createNode('PAGE', {id: 'p' + p}));
  const count = 6 + int(rng, 20);
  for (let i = 0; i < count; i++) {
    const parent = pick(rng, holders(tx.doc).filter(id => tx.doc.nodes[id].type !== 'GROUP' && tx.doc.nodes[id].type !== 'BOOLEAN_OPERATION'));
    if (chance(rng, 0.35)) {
      const type = pick(rng, CONTAINERS);
      const id = fresh(type[0].toLowerCase());
      const node = createNode(type, {id, x: int(rng, 300), y: int(rng, 300), width: 50 + int(rng, 200), height: 50 + int(rng, 200)});
      if (type === 'FRAME' && chance(rng, 0.4)) node.autoLayout = {...defaultAutoLayout(chance(rng, 0.5) ? 'HORIZONTAL' : 'VERTICAL'), itemSpacing: int(rng, 20)};
      if (type === 'BOOLEAN_OPERATION') node.booleanOperation = 'UNION';
      tx.create(node, parent);
      // Groups and booleans hold at least one layer.
      tx.create(leaf(rng, fresh('l')), id);
      if (chance(rng, 0.5)) tx.create(leaf(rng, fresh('l')), id);
    } else tx.create(leaf(rng, fresh('l')), parent);
  }
  tx.setStyle({id: 'S:1', type: 'FILL', name: 'Brand/Primary', description: '', paints: [solid({r: 1, g: 0, b: 0})]});
  if (chance(rng, 0.5)) tx.setStyle({id: 'S:2', type: 'FILL', name: 'Other', description: 'd', paints: [solid({r: 0, g: 0, b: 1})]});
  const collection: VariableCollection = {id: 'C:1', name: 'Colors', modes: [{modeId: 'm1', name: 'Light'}, {modeId: 'm2', name: 'Dark'}], defaultModeId: 'm1', variableIds: []};
  tx.setVariableCollection(collection);
  for (let v = 0; v < 1 + int(rng, 3); v++) tx.setVariable({id: 'V:' + v, name: 'v' + v, collectionId: 'C:1', type: 'FLOAT', valuesByMode: {m1: v, m2: v * 2}, description: ''} as Variable);
  const some = layers(tx.doc);
  if (some.length && chance(rng, 0.5)) tx.setVariableModes(pick(rng, some), {'C:1': 'm2'});
  doc = tx.commit(CONTEXT).doc;
  // A component and instances of it (their copies carry `instance;main` ids and `mainId`).
  const component = Object.values(doc.nodes).find(node => node.type === 'COMPONENT' && node.children?.length);
  if (component) {
    for (let k = 0; k < 1 + int(rng, 2); k++) {
      const parents = holders(doc).filter(id => {
        const node = doc.nodes[id];
        return node.type !== 'GROUP' && node.type !== 'BOOLEAN_OPERATION' && node.type !== 'COMPONENT' && !insideComponent(doc, id, component.id);
      });
      if (!parents.length) break;
      try {
        doc = createInstance(doc, component.id, {parentId: pick(rng, parents), newId: fresh('i')}).doc;
      } catch {
        break;
      }
    }
  }
  return doc;
}

function insideComponent(doc: DesignDocument, id: NodeId, componentId: NodeId): boolean {
  for (let node: SceneNode | undefined = doc.nodes[id]; node; node = node.parentId ? doc.nodes[node.parentId] : undefined) if (node.id === componentId) return true;
  return false;
}

// ── Edits ─────────────────────────────────────────────────────────────────────────────────────────

type Edit = (tx: Transaction, rng: Rng) => void;

const someLayer = (tx: Transaction, rng: Rng, filter: (node: SceneNode) => boolean = () => true) => {
  const list = Object.values(tx.doc.nodes).filter(node => node.type !== 'PAGE' && filter(node));
  return list.length ? pick(rng, list) : undefined;
};

const EDITS: Edit[] = [
  // Fields.
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (node) tx.update(node.id, {x: node.x + int(rng, 50) - 25, y: node.y + int(rng, 30)});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (node) tx.update(node.id, {name: words(rng, 2), opacity: pick(rng, [0.5, 1, 0.25])});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (node) tx.update(node.id, {fills: [solid({r: rng(), g: rng(), b: rng()})], fillStyleId: chance(rng, 0.3) ? 'S:1' : undefined});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (node) tx.update(node.id, {rotation: int(rng, 360) - 180, flipY: chance(rng, 0.3) ? true : undefined});
  },
  // Records merged one level deeper.
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (!node) return;
    const data = {...(node.pluginData ?? {})};
    if (chance(rng, 0.3)) delete data[pick(rng, ['k1', 'k2', 'k3'])];
    else data[pick(rng, ['k1', 'k2', 'k3'])] = words(rng, 1);
    tx.update(node.id, {pluginData: data});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (node) tx.update(node.id, {boundVariables: {...(node.boundVariables ?? {}), [pick(rng, ['opacity', 'width', 'x'])]: {type: 'VARIABLE_ALIAS', id: 'V:0'}}});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (node) tx.update(node.id, {constraints: {...node.constraints, [pick(rng, ['horizontal', 'vertical'])]: pick(rng, ['MIN', 'MAX', 'CENTER', 'STRETCH', 'SCALE'])}});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng, node => node.type === 'FRAME');
    if (node) tx.update(node.id, {autoLayout: {...(node.autoLayout ?? defaultAutoLayout('HORIZONTAL')), [pick(rng, ['itemSpacing', 'paddingLeft', 'paddingTop'])]: int(rng, 24)}});
  },
  // Entry lists and sets.
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (!node) return;
    let list = [...(node.annotations ?? [])];
    const roll = rng();
    if (roll < 0.4) list.push({id: 'an' + int(rng, 5), label: words(rng, 1)});
    else if (roll < 0.7 && list.length) list = list.filter((_, i) => i !== int(rng, list.length));
    else if (list.length) list = list.map((entry, i) => (i === 0 ? {...entry, label: words(rng, 2)} : entry));
    if (chance(rng, 0.2)) list.reverse();
    const unique = list.filter((entry, i) => list.findIndex(other => other.id === entry.id) === i);
    tx.update(node.id, {annotations: unique.length ? unique : undefined});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng, node => node.mainId !== undefined);
    if (!node) return;
    const overrides = new Set(node.overrides ?? []);
    const field = pick(rng, ['fills', 'name', 'opacity', 'x']);
    if (overrides.has(field) && chance(rng, 0.5)) overrides.delete(field);
    else overrides.add(field);
    tx.update(node.id, {overrides: [...overrides], ...(field === 'name' ? {name: words(rng, 1)} : {})});
  },
  // Text.
  (tx, rng) => {
    const node = someLayer(tx, rng, node => node.type === 'TEXT' && !!node.text);
    if (!node) return;
    const text = node.text!;
    const length = text.characters.length;
    const start = boundary(text.characters, int(rng, length + 1)), end = boundary(text.characters, Math.min(length, start + int(rng, 3)));
    tx.update(node.id, {text: insertText(text, start, chance(rng, 0.6) ? start : Math.max(start, end), chance(rng, 0.2) ? '' : words(rng, 1 + int(rng, 2)))});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng, node => node.type === 'TEXT' && !!node.text && node.text.characters.length > 1);
    if (!node) return;
    const length = node.text!.characters.length;
    const start = boundary(node.text!.characters, int(rng, length - 1));
    const end = boundary(node.text!.characters, start + 1 + int(rng, length - start));
    tx.update(node.id, {text: applyStyleToRange(node.text!, start, Math.max(start + 1, end), {fontSize: pick(rng, [12, 18, 24])})});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng, node => node.type === 'TEXT' && !!node.text);
    if (node) tx.update(node.id, {text: {...node.text!, textAlignHorizontal: pick(rng, ['LEFT', 'CENTER', 'RIGHT'])}});
  },
  // Structure.
  (tx, rng) => {
    const parent = pick(rng, holders(tx.doc));
    tx.create(leaf(rng, fresh('n')), parent, chance(rng, 0.5) ? int(rng, 3) : undefined);
  },
  (tx, rng) => {
    const node = someLayer(tx, rng, node => !isCopy(node));
    if (node) tx.remove(node.id);
  },
  (tx, rng) => {
    const node = someLayer(tx, rng, node => !isCopy(node));
    if (!node) return;
    const target = pick(rng, holders(tx.doc));
    tx.move(node.id, target, chance(rng, 0.5) ? int(rng, 4) : undefined, {keepWorld: chance(rng, 0.8)});
  },
  (tx, rng) => {
    const node = someLayer(tx, rng, node => !isCopy(node));
    if (node) tx.reorder(node.id, int(rng, 5));
  },
  // Pages.
  (tx, rng) => {
    const pages = [...tx.doc.pages];
    for (let i = pages.length - 1; i > 0; i--) {
      const j = int(rng, i + 1);
      [pages[i], pages[j]] = [pages[j], pages[i]];
    }
    tx.setPages(pages);
  },
  (tx, rng) => {
    if (chance(rng, 0.5)) tx.addPage(createNode('PAGE', {id: fresh('P')}), int(rng, 3));
    else tx.removePage(pick(rng, tx.doc.pages));
  },
  // Tables.
  (tx, rng) => {
    if (chance(rng, 0.7)) tx.setStyle({id: pick(rng, ['S:1', 'S:2', 'S:3']), type: 'FILL', name: words(rng, 2), description: chance(rng, 0.5) ? '' : 'x', paints: [solid({r: rng(), g: 0, b: 0})]});
    else tx.removeStyle(pick(rng, ['S:1', 'S:2']));
  },
  (tx, rng) => {
    const id = 'V:' + int(rng, 4);
    const roll = rng();
    if (roll < 0.15) tx.removeVariable(id);
    else {
      const current = tx.doc.variables[id];
      const valuesByMode = {...(current?.valuesByMode ?? {m1: 0, m2: 0}), [pick(rng, ['m1', 'm2'])]: int(rng, 100)};
      tx.setVariable({id, name: current?.name ?? 'v', collectionId: 'C:1', type: 'FLOAT', valuesByMode, description: chance(rng, 0.2) ? 'changed' : (current?.description ?? '')} as Variable);
    }
  },
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (node) tx.setVariableModes(node.id, chance(rng, 0.2) ? null : {'C:1': pick(rng, ['m1', 'm2'])});
  },
  // The rarer tables, and the transaction's own edge cases (with ops in `both` the switch runs every
  // transaction on the TypeScript and on the Rust, refusals included: they must refuse alike).
  (tx, rng) => {
    const ref = pick(rng, ['img:1', 'img:2']);
    if (chance(rng, 0.7)) tx.setImage(ref, {url: `/uploads/${ref}.png`, width: 10 + int(rng, 5), height: 10});
    else tx.removeImage(ref);
  },
  (tx, rng) => {
    const roll = rng();
    if (roll < 0.4) {
      const current = tx.doc.variableCollections['C:2'];
      tx.setVariableCollection({id: 'C:2', name: words(rng, 1), modes: [{modeId: 'k1', name: 'One'}], defaultModeId: 'k1', variableIds: current?.variableIds ?? []});
    } else if (roll < 0.7 && tx.doc.variableCollections['C:2']) {
      tx.setVariable({id: 'V:' + int(rng, 4), name: 'w', collectionId: 'C:2', type: 'FLOAT', valuesByMode: {k1: int(rng, 9)}, description: ''} as Variable);
    } else tx.removeVariableCollection(pick(rng, ['C:1', 'C:2']));
  },
  (tx, rng) => {
    if (chance(rng, 0.6)) tx.addLibraryPage();
    else tx.remove('morfa:library');
  },
  (tx, rng) => {
    // The very objects the node holds (nothing changes), a key set to undefined, a read of a parent whose child left.
    const node = someLayer(tx, rng);
    if (!node) return;
    const roll = rng();
    if (roll < 0.35) tx.update(node.id, {fills: node.fills, strokes: node.strokes, x: node.x});
    // (Only optional fields go: a document without a required one is not a valid file.)
    else if (roll < 0.7) tx.update(node.id, {name: node.name, fillStyleId: undefined, flipX: chance(rng, 0.5) ? undefined : node.flipX, locked: chance(rng, 0.5)});
    else {
      tx.remove(node.id);
      const parent = node.parentId ? tx.get(node.parentId) : undefined;
      if (parent?.children?.includes(node.id)) throw new Error('a removed child is still listed');
    }
  },
  (tx, rng) => {
    const node = someLayer(tx, rng);
    if (!node) return;
    const child = node.children?.length ? node.children[int(rng, node.children.length)] : undefined;
    switch (int(rng, 9)) {
      case 0: return tx.update(node.id, {parentId: 'elsewhere'});
      case 1: return child ? tx.move(node.id, child) : tx.move(node.id, node.id);
      case 2: return tx.create(leaf(rng, node.id), pick(rng, holders(tx.doc)));
      case 3: return tx.update('missing', {x: 1});
      case 4: return tx.removePage(node.id);
      case 5: return tx.update(node.id, {type: pick(rng, ['PAGE', 'FRAME', 'RECTANGLE', 'GROUP'] as const)});
      case 6: return tx.setVariable({id: 'V:9', name: 'x', collectionId: 'C:none', type: 'FLOAT', valuesByMode: {}, description: ''} as Variable);
      case 7: return tx.setPages([...tx.doc.pages, 'nope']);
      default: return tx.create(leaf(rng, fresh('n')), node.children ? node.id : (node.parentId ?? 'missing'), chance(rng, 0.3) ? -1 : int(rng, 9));
    }
  },
];

/** One person's edit of `base`: a few random operations in one transaction (normalized as the editor would). */
export function randomEdit(base: DesignDocument, rng: Rng): {doc: DesignDocument; patch: DocumentPatch} {
  const tx = beginTransaction(base);
  const steps = 1 + int(rng, 4);
  for (let i = 0; i < steps; i++) {
    try {
      pick(rng, EDITS)(tx, rng);
    } catch (error) {
      if ((error as Error).name !== 'TransactionError') throw error;
    }
  }
  const result = tx.commit(CONTEXT);
  return {doc: result.doc, patch: result.patch};
}

/** `fuzzPatchPair(doc)` of the brief: two concurrent changes of one document. */
export function patchPair(base: DesignDocument, rng: Rng) {
  return {theirs: randomEdit(base, rng), ours: randomEdit(base, rng)};
}

// ── The differential run ──────────────────────────────────────────────────────────────────────────

/** Documents compared as sets of entries (key order of a table may change when an entry goes and comes back; an
 *  empty `variableModes` table, which applyPatch creates for a removal, is no table). */
const sorted = (value: unknown): unknown => {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'pages' in value) {
    const doc = {...(value as Record<string, unknown>)};
    if (doc.variableModes && !Object.keys(doc.variableModes as object).length) delete doc.variableModes;
    return sortedKeys(doc);
  }
  return sortedKeys(value);
};
const sortedKeys = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortedKeys)
    : value !== null && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => [key, sortedKeys((value as Record<string, unknown>)[key])]))
      : value;

/** Comparisons made so far: the switch's `both` calls of ops, and the held-document checks here. */
let held = 0;
export const fuzzComparisons = () => engineCalls('ops').both + held;

/** One case. Run with ops in `both` (setEngine('ops', 'both')): every call below compares the two engines. */
export function runCase(rng: Rng, seed: number) {
  if (engineFor('ops') !== 'both') throw new Error('ops fuzz: run it with the ops engine in both mode');
  const base = randomDocument(rng);
  if (!validateDocument(base).ok) return 'invalid-base';
  const {theirs, ours} = patchPair(base, rng);
  const target = theirs.doc;
  const change = ours.patch;
  const full = invertPatch(base, change);
  const befores: (DocumentPatch | undefined)[] = [full, undefined];
  // A partial before: some entries without a copy (taken whole, as the last writer's).
  const partial: DocumentPatch = {...full, nodes: Object.fromEntries(Object.entries(full.nodes ?? {}).filter(() => rng() < 0.6))};
  befores.push(partial);
  for (const before of befores) {
    const outcome = mergeChange(documentTarget(target), change, before);
    const next = applyPatch(target, outcome.patch);
    // The same on a document held in wasm from its stored text (crates/ops/src/stored.rs: entries kept as slices).
    const doc = new (engineWasm().OpsDocument)(JSON.stringify(target));
    doc.applyPatch(JSON.stringify(outcome.patch));
    held++;
    const heldText = doc.toJson();
    doc.free();
    assert.equal(heldText, JSON.stringify(next), `OpsDocument.applyPatch differs from applyPatch (seed ${seed})`);
    checkPatchedDocument(target, next, outcome.patch);
    const applied = applyDocumentChange(target, {patch: change, before: before?.nodes, beforeTables: before ? {...before, nodes: undefined} : undefined});
    storedValues(applied.doc, change, applied.stored);
  }
  // invertPatch ∘ applyPatch restores; composePatches equals applying in turn.
  for (const [doc, patch] of [[target, change], [base, theirs.patch], [base, change]] as const) {
    const inverse = invertPatch(doc, patch);
    const restored = applyPatch(applyPatch(doc, patch), inverse);
    assert.deepEqual(sorted(restored), sorted(doc), `invertPatch ∘ applyPatch does not restore (seed ${seed})`);
  }
  const composed = composePatches(theirs.patch, change);
  const inTurn = applyPatch(applyPatch(base, theirs.patch), change);
  assert.deepEqual(sorted(applyPatch(base, composed)), sorted(inTurn), `composePatches differs from applying in turn (seed ${seed})`);
  diffDocuments(base, target);
  // An editor's unsaved change rebased over the other's: the server's copy is `base`, the editor holds base + ours.
  rebaseLocal({doc: ours.doc, local: change, server: full}, theirs.patch);
  // Text and lists on random inputs.
  const a = words(rng, int(rng, 6)), b = chance(rng, 0.5) ? a : words(rng, int(rng, 6));
  textEdit(a, b);
  const ids = Array.from({length: 8}, (_, i) => 'x' + i);
  const shuffle = (list: string[]) => list.filter(() => rng() < 0.8).sort(() => rng() - 0.5);
  const [list, baseList, oursList] = [shuffle(ids), shuffle(ids), shuffle(ids)];
  const kept = ids.filter(() => rng() < 0.8);
  mergeList(list, baseList, oursList, id => kept.includes(id));
  return 'ok';
}
