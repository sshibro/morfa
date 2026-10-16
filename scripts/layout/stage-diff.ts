// The stage diff runner: every fixture of fixtures/documents (write them with
// `npx tsx scripts/fixtures/design-documents.ts`) and N seeded documents of tests/helpers/layout-fuzz-l2b.ts, each with
// M random dirty sets (the first is every id), through every stage on both sides (tests/helpers/stage-diff-l2b.ts),
// plus the standalone entries (layoutFrame of every auto-layout frame, groupFitUpdates, resizeUpdates by hand).
// Exit 1 on any difference; the first ones are printed with what reproduces them.
//
//   npx tsx scripts/layout/stage-diff.ts [--docs 5000] [--from 0] [--sets 200] [--seed 1] [--no-fixtures] [--fixtures-only]
//                                        [--stages layout,groupFit] [--max-fixture-sets 200] [--edits 10]
//                                        [--wasm]   the Rust side through the wasm build (V8's Math), without normalize
//                                        [--generator l2b|s2]  the documents: layout-fuzz-l2b.ts (default) or S2's design-fuzz.ts

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import {validateDocument} from '../../shared/design/schema';
import {isAutoLayout} from '../../shared/design/constraints';
import {isGroupLike} from '../../shared/design/group-fit';
import {dirtySets, layoutDocument, rng, withDeletion, withEdits} from '../../tests/helpers/layout-fuzz-l2b';
import {fuzzDocument, fuzzEdit} from '../../tests/helpers/design-fuzz';
import {RustStages, WasmStages, STAGES, compareResults, loneSurrogates, tsGroupFit, tsLayoutFrame, tsLayoutSizing, tsResize, tsScale, tsStage, type StageName, type StageResult} from '../../tests/helpers/stage-diff-l2b';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const option = (name: string, fallback: number) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const flag = (name: string) => args.includes(`--${name}`);
const DOCS = option('docs', 200);
const FROM = option('from', 0);
const SETS = option('sets', 200);
const SEED = option('seed', 1);
const FIXTURE_SETS = option('max-fixture-sets', SETS);
const EDITS = option('edits', 10);
const stagesArg = args.indexOf('--stages');
const WASM = flag('wasm');
/** `l2b`: tests/helpers/layout-fuzz-l2b.ts (layout-heavy, unsettled); `s2`: S2's design-fuzz.ts (every feature, settled). */
const GENERATOR = args.includes('--generator') ? args[args.indexOf('--generator') + 1] : 'l2b';
const S2_SIZES = [40, 80, 150, 300, 600];
const stages: StageName[] = (stagesArg >= 0 ? (args[stagesArg + 1].split(',') as StageName[]) : STAGES).filter(stage => !WASM || stage !== 'normalize');

type Failure = {where: string; what: string; difference: string};
const failures: Failure[] = [];
const counts = new Map<string, number>();
const count = (key: string, n = 1) => counts.set(key, (counts.get(key) ?? 0) + n);

const hasInstancesOrVariables = (doc: DesignDocument) =>
  Object.keys(doc.variables ?? {}).length > 0 || Object.values(doc.nodes).some(node => node.type === 'INSTANCE' || node.type === 'COMPONENT' || node.type === 'COMPONENT_SET' || node.boundVariables || node.componentPropertyReferences);

type Side = Pick<RustStages, 'load' | 'stage' | 'layoutFrame' | 'groupFit' | 'resize' | 'close'> & Partial<Pick<RustStages, 'scale' | 'layoutSizing'>>;

async function check(rust: Side, where: string, what: string, ts: () => StageResult, rs: () => Promise<StageResult>) {
  let tsResult: StageResult, rustResult: StageResult;
  try {
    tsResult = ts();
  } catch (error) {
    count('ts-throws');
    // A TypeScript throw is reported only when Rust does not throw too.
    try {
      await rs();
      failures.push({where, what, difference: `ts threw (${(error as Error).message}), rust did not`});
    } catch {
      /* both throw */
    }
    return;
  }
  try {
    rustResult = await rs();
  } catch (error) {
    failures.push({where, what, difference: `rust failed: ${(error as Error).message}`});
    return;
  }
  count(what.split(' ')[0]);
  count('entries', tsResult.written.length);
  const difference = compareResults(tsResult, rustResult);
  if (difference) failures.push({where, what, difference});
}

async function documentRun(rust: Side, where: string, doc: DesignDocument, sets: string[][], standalone: boolean) {
  await rust.load(doc);
  for (let s = 0; s < sets.length; s++) {
    for (const stage of stages) {
      if (stage === 'normalize' && hasInstancesOrVariables(doc)) continue;
      await check(rust, where, `${stage} set ${s}`, () => tsStage(stage, doc, sets[s]), () => rust.stage(stage, sets[s]));
    }
    if (failures.length > 20) return;
  }
  if (!standalone) return;
  const r = rng(sets.length * 31 + where.length);
  const ids = Object.keys(doc.nodes);
  for (const id of ids) {
    const node = doc.nodes[id];
    if (isAutoLayout(node) || isAutoLayout(doc.nodes[node.parentId ?? ''])) await check(rust, where, `layoutFrame ${id}`, () => tsLayoutFrame(doc, id), () => rust.layoutFrame(id));
  }
  const groups = ids.filter(id => isGroupLike(doc.nodes[id]));
  for (const id of groups.slice(0, 20)) {
    const ids2 = [id, ...(doc.nodes[id].children ?? []).slice(0, 2)];
    await check(rust, where, `groupFit ${ids2}`, () => tsGroupFit(doc, ids2), () => rust.groupFit(ids2));
  }
  for (let k = 0; k < Math.min(20, ids.length); k++) {
    const id = r.pick(ids);
    const node = doc.nodes[id];
    const box = {x: node.x + r.int(40) - 20, y: node.y + r.int(40) - 20, width: Math.max(0, node.width + r.int(200) - 100 + (r.chance(0.5) ? 0.5 : 0)), height: Math.max(0, node.height + r.int(200) - 100)};
    await check(rust, where, `resize ${id} ${JSON.stringify(box)}`, () => tsResize(doc, id, box), () => rust.resize(id, box));
  }
  if (rust.scale && rust.layoutSizing) {
    for (let k = 0; k < Math.min(10, ids.length); k++) {
      const picked = [r.pick(ids), ...(r.chance(0.3) ? [r.pick(ids), r.pick(ids)] : [])];
      const origin = {x: r.int(400) - 100, y: r.int(400) - 100};
      const [sx, sy] = r.chance(0.5) ? [0.5 + r.int(30) / 10, 0.5 + r.int(30) / 10] : [1.5, 1.5];
      await check(rust, where, `scale ${picked} ${JSON.stringify(origin)} ${sx} ${sy}`, () => tsScale(doc, picked, origin, sx, sy), () => rust.scale!(picked, origin, sx, sy));
    }
    for (let k = 0; k < Math.min(15, ids.length); k++) {
      const id = r.pick(ids);
      const axis = r.chance(0.5) ? 'horizontal' : 'vertical';
      const sizing = r.pick(['FIXED', 'HUG', 'FILL'] as const);
      await check(rust, where, `layoutSizing ${id} ${axis} ${sizing}`, () => tsLayoutSizing(doc, id, axis, sizing), () => rust.layoutSizing!(id, axis, sizing));
    }
  }
}

async function main() {
  const rust: Side = WASM ? new WasmStages() : new RustStages();
  const started = Date.now();
  if (!flag('no-fixtures')) {
    const dir = path.join(repo, 'fixtures', 'documents');
    const index = path.join(dir, 'index.json');
    if (!fs.existsSync(index)) throw new Error('no fixtures: run npx tsx scripts/fixtures/design-documents.ts first');
    const entries: {name: string; file: string; nodes: number}[] = JSON.parse(fs.readFileSync(index, 'utf8')).fixtures ?? JSON.parse(fs.readFileSync(index, 'utf8'));
    for (const entry of entries) {
      const doc: DesignDocument = JSON.parse(fs.readFileSync(path.join(dir, entry.file), 'utf8'));
      const sets = dirtySets(doc, entry.name.length + SEED, FIXTURE_SETS);
      const before = failures.length;
      const t = Date.now();
      await documentRun(rust, `fixture ${entry.name}`, doc, sets, entry.nodes <= 5000);
      // Edited copies: a transaction's few edits, then its dirty ids with some random others.
      for (let e = 0; e < EDITS; e++) {
        const edited = withEdits(doc, SEED * 1000 + e);
        const editSets = [edited.dirty, ...dirtySets(edited.doc, e, 4).slice(1).map(set => [...edited.dirty, ...set])];
        await documentRun(rust, `fixture ${entry.name} edit ${e} [${edited.dirty}]`, edited.doc, editSets, false);
      }
      console.log(`fixture ${entry.name} (${entry.nodes} layers, ${sets.length} sets): ${failures.length === before ? 'equal' : `${failures.length - before} differences`} in ${Date.now() - t} ms`);
    }
  }
  if (!flag('fixtures-only')) {
    let invalid = 0;
    for (let d = FROM; d < DOCS; d++) {
      const seed = SEED * 1_000_003 + d;
      const doc = GENERATOR === 's2' ? fuzzDocument(seed, {nodes: S2_SIZES[d % S2_SIZES.length]}) : layoutDocument(seed);
      const valid = validateDocument(doc);
      if (!valid.ok) {
        invalid++;
        if (invalid <= 3) console.log(`fuzz ${seed}: invalid document (${JSON.stringify(valid).slice(0, 300)})`);
        continue;
      }
      await documentRun(rust, `fuzz seed ${seed}`, doc, dirtySets(doc, seed, SETS), d % 10 === 0);
      if (GENERATOR === 's2' && d % 2 === 1) {
        // One person's committed edit (S2's generator): its patch's ids are the dirty set.
        const edited = fuzzEdit(doc, seed);
        const dirty = Object.keys(edited.patch.nodes ?? {});
        await documentRun(rust, `fuzz seed ${seed} fuzzEdit`, edited.doc, [dirty, ...dirtySets(edited.doc, seed + 2, 4).slice(1).map(set => [...dirty, ...set])], false);
      }
      if (d % 2 === 0) {
        const edited = withEdits(doc, seed);
        await documentRun(rust, `fuzz seed ${seed} edit [${edited.dirty}]`, edited.doc, [edited.dirty, ...dirtySets(edited.doc, seed, 5).slice(1).map(set => [...edited.dirty, ...set])], false);
      }
      // A deletion: the removed node and its former parent are dirty (normalize sees tables mid-transaction).
      const deleted = d % 5 === 0 ? withDeletion(doc, seed) : null;
      if (deleted) {
        const sets = dirtySets(deleted.doc, seed + 1, Math.max(1, SETS / 10)).map((set, i) => (i === 0 ? set : [...deleted.dirty, ...set]));
        sets.push(deleted.dirty);
        await documentRun(rust, `fuzz seed ${seed} deletion ${deleted.dirty[0]}`, deleted.doc, sets, false);
      }
      if ((d + 1) % 100 === 0) console.log(`fuzz ${d + 1}/${DOCS}: ${failures.length} differences, ${((Date.now() - started) / 1000).toFixed(0)} s`);
      if (failures.length > 20) break;
    }
    if (invalid) console.log(`fuzz: ${invalid} of ${DOCS} generated documents were invalid and skipped`);
  }
  rust.close();
  console.log(`\nchecked: ${[...counts].map(([k, v]) => `${k} ${v}`).join(', ')}; ${((Date.now() - started) / 1000).toFixed(1)} s`);
  if (loneSurrogates.count) console.log(`strings equal only after toWellFormed() (a lone surrogate, S1's documented difference): ${loneSurrogates.count}, e.g. ${loneSurrogates.example}`);
  if (failures.length) {
    console.log(`\n${failures.length} differences; the first:`);
    for (const f of failures.slice(0, 10)) console.log(`  ${f.where} · ${f.what}: ${f.difference}`);
    process.exit(1);
  }
  console.log('stage diff: every entry equal');
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
