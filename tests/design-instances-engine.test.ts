import assert from 'node:assert/strict';
import {test} from 'node:test';
import {syncInstances} from '../shared/design/components';
import {applyAllVariables, applyVariables} from '../shared/design/variables';
import {assertWasmRan, engineCalls, resetEngineCalls, setEngine} from '../shared/design/engine-switch';
import {fuzzDocument, mutate, Rng} from './helpers/l2c-fuzz';

// Lane L2c: the instance and variable stages in Rust (crates/layout/src/instances) behind the engine switch, checked
// against the TypeScript in `both` mode: every component command that builds the fuzzed documents (createComponent,
// createInstance, combineAsVariants, properties, swaps, overrides) syncs through both engines, then random edits are
// synced and their variables applied. Any disagreement throws an EngineDiffError; the counters prove Rust ran.

test('instance sync and variables agree with TypeScript in both mode, and Rust ran', () => {
  const restore = setEngine('normalize', 'both');
  resetEngineCalls('normalize');
  try {
    for (let seed = 1; seed <= 12; seed++) {
      const doc = fuzzDocument(seed, seed % 3 ? 'small' : 'medium');
      const rng = new Rng(seed);
      for (let k = 0; k < 15; k++) {
        const {doc: edited, dirty} = mutate(doc, rng);
        const synced = syncInstances(edited, dirty);
        applyVariables(synced, dirty);
      }
      applyAllVariables(doc);
    }
    const calls = engineCalls('normalize');
    assertWasmRan('normalize');
    assert.equal(calls.diffs, 0);
    assert.ok(calls.wasm > 200, `wasm calls: ${calls.wasm}`);
  } finally {
    restore();
  }
});
