import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createSaveIndicator, SAVING_DELAY_MS} from '../src/design/editor/chrome/save-indicator';
import type {SaveState} from '../src/design/editor/chrome/FileTitle';

// src/design/editor/chrome/save-indicator.ts: the title keeps "Saved" steady through quick saves (the raw state flipped
// on every edit and flickered) and says "Saving…" only for a slow save or a retry; trouble shows at once.

function clock() {
  let now = 0;
  const pending = new Map<number, {at: number; run: () => void}>();
  let next = 1;
  return {
    timers: {
      setTimeout: (run: () => void, ms: number) => {
        const id = next++;
        pending.set(id, {at: now + ms, run});
        return id;
      },
      clearTimeout: (handle: unknown) => void pending.delete(handle as number),
    },
    advance(ms: number) {
      now += ms;
      for (const [id, entry] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (entry.at > now) continue;
        pending.delete(id);
        entry.run();
      }
    },
  };
}

function indicator(initial: SaveState = 'saved') {
  const time = clock();
  const shown: SaveState[] = [];
  const it = createSaveIndicator(initial, {onChange: state => shown.push(state), timers: time.timers});
  return {it, shown, time};
}

test('quick saves keep "Saved" steady: nothing changes on the title while each takes under the delay', () => {
  const {it, shown, time} = indicator();
  for (let edit = 0; edit < 20; edit++) {
    it.set('saving');
    time.advance(900);
    it.set('saved');
    time.advance(400);
  }
  assert.deepEqual(shown, []);
  assert.equal(it.shown, 'saved');
});

test('a save still running after the delay says "Saving…", then "Saved" the moment it lands', () => {
  const {it, shown, time} = indicator();
  it.set('saving');
  time.advance(SAVING_DELAY_MS - 1);
  assert.equal(it.shown, 'saved');
  it.set('saving');
  time.advance(1);
  assert.equal(it.shown, 'saving', 'a repeated «saving» does not restart the wait');
  it.set('saved');
  assert.deepEqual(shown, ['saving', 'saved']);
});

test('no connection, a stopped save and a retry show at once; a save after trouble says so at once too', () => {
  const {it, shown, time} = indicator();
  it.set('offline');
  assert.equal(it.shown, 'offline');
  it.set('saving');
  assert.equal(it.shown, 'saving', 'back online: the retry is said at once');
  it.set('saved');
  it.set('saving', true);
  assert.equal(it.shown, 'saving', 'a retry after a failed request');
  it.set('saved');
  it.set('saving');
  it.set('unsaved');
  assert.equal(it.shown, 'unsaved');
  time.advance(SAVING_DELAY_MS * 2);
  assert.equal(it.shown, 'unsaved', 'a pending wait never overrides trouble');
  assert.deepEqual(shown, ['offline', 'saving', 'saved', 'saving', 'saved', 'unsaved']);
  const readOnly = indicator('readonly');
  assert.equal(readOnly.it.shown, 'readonly');
});
