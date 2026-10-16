import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertStageEqual, type StageName} from './helpers/stage-diff';
import {dirtySets, layoutDocument, withDeletion, withEdits} from './helpers/layout-fuzz-l2b';
import {fuzzDocument, fuzzEdit} from './helpers/design-fuzz';
import {validateDocument} from '../shared/design/schema';
import type {DesignDocument} from '../shared/design/types';

// Lane L2b's stages through S2's oracle (tests/helpers/stage-diff.ts): normalize.ts's steps 0, 1, 3 and 4 run alone in
// TypeScript and in Rust (the shadow's `normalize_stage`, crates/layout/src/normalize.rs), on layout-heavy documents
// (tests/helpers/layout-fuzz-l2b.ts: nested auto layout, wrap, baseline, min/max, turned and flipped layers, groups,
// text in every mode) with edits and deletions, and on S2's design-fuzz.ts documents. Equal means the same written ids
// in the same order, the same reported ids and every node deep-equal with numbers compared exactly. The lane's full run
// (5 000 documents × 200 dirty sets per generator) is scripts/layout/stage-diff.ts.

const STAGES: StageName[] = ['sizing', 'textResize', 'layout', 'groupFit'];

function check(doc: DesignDocument, sets: readonly string[][], label: string): number {
  let compared = 0;
  for (const dirty of sets) {
    for (const stage of STAGES) {
      assertStageEqual(stage, doc, new Set(dirty), {order: true});
      compared++;
    }
  }
  assert.ok(compared > 0, label);
  return compared;
}

test('the layout stages equal the TypeScript on layout-heavy documents, edited and with deletions', () => {
  let compared = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const doc = layoutDocument(seed);
    if (!validateDocument(doc).ok) continue;
    compared += check(doc, dirtySets(doc, seed, 6), `seed ${seed}`);
    const edited = withEdits(doc, seed);
    compared += check(edited.doc, [edited.dirty], `seed ${seed} edited`);
    const deleted = withDeletion(doc, seed);
    if (deleted) compared += check(deleted.doc, [deleted.dirty], `seed ${seed} deletion`);
  }
  assert.ok(compared > 300, `${compared} stage runs compared`);
});

test('the layout stages equal the TypeScript on design-fuzz.ts documents and their edits', () => {
  for (let seed = 1; seed <= 6; seed++) {
    const doc = fuzzDocument(seed, {nodes: 120});
    check(doc, dirtySets(doc, seed, 4), `fuzz ${seed}`);
    const edited = fuzzEdit(doc, seed);
    check(edited.doc, [Object.keys(edited.patch.nodes ?? {})], `fuzz ${seed} edited`);
  }
});
