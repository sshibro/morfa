import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createUploadQueue, isBusy} from '../src/design/engine/upload-queue';

// src/design/engine/upload-queue.ts: the editor's picture uploads go a few at a time and wait out the server's "busy"
// answers, so six pictures dropped together all arrive (the server takes three per account at once).

/** A server with `places` places per account: a fourth request at once is refused as busy, like server/design/router.ts. */
function server(places: number) {
  let open = 0, most = 0, refused = 0;
  const stored: string[] = [];
  const upload = async (name: string) => {
    if (open >= places) {
      refused++;
      throw Object.assign(new Error('Wait for the image upload to finish.'), {status: 429, details: {code: 'rate_limited', retryable: true}});
    }
    open++;
    most = Math.max(most, open);
    await new Promise(resolve => setTimeout(resolve, 5));
    open--;
    stored.push(name);
    return name;
  };
  return {upload, stored, get most() {return most;}, get refused() {return refused;}};
}

test('six pictures dropped at once are all stored, never more than the queue’s places in flight', async () => {
  const api = server(3);
  const queue = createUploadQueue({sleep: () => Promise.resolve()});
  const names = ['a.png', 'b.jpg', 'c.webp', 'd.gif', 'e.avif', 'f.png'];
  const results = await Promise.all(names.map(name => queue(() => api.upload(name))));
  assert.deepEqual(results, names);
  assert.deepEqual([...api.stored].sort(), [...names].sort());
  assert.ok(api.most <= 2, `at most two at once, saw ${api.most}`);
  assert.equal(api.refused, 0);
});

test('a "busy" answer is tried again after a wait; other refusals are not', async () => {
  const waits: number[] = [];
  const queue = createUploadQueue({limit: 1, delays: [10, 20], retries: 3, sleep: async ms => {waits.push(ms);}});
  let calls = 0;
  const flaky = await queue(async () => {
    if (++calls < 3) throw Object.assign(new Error('busy'), {status: 429});
    return 'stored';
  });
  assert.equal(flaky, 'stored');
  assert.deepEqual(waits, [10, 20]);

  // The plan's storage is full (413): said at once, no retry.
  let full = 0;
  await assert.rejects(queue(async () => {
    full++;
    throw Object.assign(new Error('Out of space'), {status: 413, details: {code: 'design_storage_limit'}});
  }), /Out of space/);
  assert.equal(full, 1);

  // Still busy after every retry: the last refusal is the answer, and the place is given back.
  await assert.rejects(queue(async () => {throw Object.assign(new Error('busy'), {status: 429});}), /busy/);
  assert.equal(await queue(async () => 'next'), 'next');
  assert.equal(isBusy({status: 429}), true);
  assert.equal(isBusy(new TypeError('Failed to fetch')), false);
});
