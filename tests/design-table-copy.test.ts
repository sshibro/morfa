import {test} from 'node:test';
import assert from 'node:assert/strict';
import {continueCopy, copyDone, copyTable, startCopy} from '../shared/design/table-cache';
import {createDesignStore} from '../src/design/engine/store';
import {heavyPage, testMeasurer as measurer} from './helpers/design-big-files';
import type {DesignDocument} from '../shared/design/types';

// The editor's idle copy of the node table (src/design/engine/store.ts, lane K): made a slice at a time between frames
// and keystrokes, finished by an edit that comes before it is whole, and never used for another document.

test('a table copied a slice at a time equals copyTable: the same entries in the same key order, "__proto__" as data', () => {
  const from: Record<string, number> = {};
  for (let i = 0; i < 10_000; i++) from[`n${i}`] = i;
  Object.defineProperty(from, '__proto__', {value: -1, writable: true, enumerable: true, configurable: true});
  from.z = 42;
  const copy = startCopy(from);
  let slices = 0;
  while (!continueCopy(copy, () => true)) slices++;
  assert.ok(slices >= 4, `copied in ${slices + 1} slices`);
  assert.ok(copyDone(copy));
  assert.deepEqual(Object.keys(copy.table), Object.keys(copyTable(from)));
  assert.deepEqual(Object.keys(copy.table), Object.keys(from));
  assert.equal(Object.getPrototypeOf(copy.table), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(copy.table, '__proto__')?.value, -1);
  assert.equal(copy.table.z, 42);
});

/** A store whose idle work runs when the test says, with a deadline that allows one slice per call. */
function editor(doc: DesignDocument) {
  let idle: ((deadline?: {timeRemaining(): number}) => void) | null = null;
  const store = createDesignStore({doc, measurer, table: 'copy', idle: work => {
    idle = work;
    return () => void (idle = null);
  }});
  const slice = () => {
    const work = idle;
    idle = null;
    work?.({timeRemaining: () => 0});
    return !!idle;
  };
  return {store, slice};
}

test('the idle copy is made in slices; an edit before it is whole finishes it; documents before stay as they were', () => {
  const doc = heavyPage();
  const {store, slice} = editor(doc);
  // A few slices of the 20 041-entry table, not all of it.
  assert.ok(slice(), 'more to copy after one slice');
  assert.ok(slice());
  const first = store.getState().doc;
  const id = Object.keys(doc.nodes).find(key => doc.nodes[key].type === 'RECTANGLE')!;
  store.transact('Nudge', tx => tx.update(id, {x: 7}));
  const second = store.getState().doc;
  assert.notEqual(second.nodes, first.nodes);
  assert.equal(second.nodes[id].x, 7);
  assert.equal(first.nodes[id].x, doc.nodes[id].x, 'the earlier document is untouched');
  assert.deepEqual(Object.keys(second.nodes), Object.keys(first.nodes), 'every entry, in the same order');
  for (const key of Object.keys(first.nodes)) if (key !== id && !second.nodes[key]) assert.fail(`lost ${key}`);
  // A whole copy taken by the next edit; an undo after it writes into a copy of its own.
  while (slice());
  store.transact('Nudge', tx => tx.update(id, {x: 9}));
  const third = store.getState().doc;
  assert.equal(second.nodes[id].x, 7);
  assert.ok(store.undo());
  assert.equal(third.nodes[id].x, 9, 'undo wrote into a copy, not into the document it left');
  assert.equal(store.getState().doc.nodes[id].x, 7);
});

test("a gesture takes the copy in progress for its first frame; the next copy is of the gesture's document", () => {
  const doc = heavyPage();
  const {store, slice} = editor(doc);
  assert.ok(slice());
  const id = Object.keys(doc.nodes).find(key => doc.nodes[key].type === 'RECTANGLE')!;
  // A gesture takes the copy in progress (finished) for its first frame.
  const gesture = store.gesture('Drag');
  gesture.update(tx => tx.update(id, {x: 11}));
  gesture.update(tx => tx.update(id, {x: 12}));
  gesture.commit();
  const after = store.getState().doc;
  assert.equal(after.nodes[id].x, 12);
  assert.equal(doc.nodes[id].x, heavyPage().nodes[id].x);
  // The next copy is of the gesture's document.
  while (slice());
  store.transact('Nudge', tx => tx.update(id, {x: 13}));
  assert.equal(after.nodes[id].x, 12);
  assert.equal(store.getState().doc.nodes[id].x, 13);
});
