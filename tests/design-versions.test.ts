import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {DesignVersionSummary} from '../shared/design/api';
import {createDocument} from '../shared/design/defaults';
import {
  autosaveWord, createVersionCache, dayTitle, decodeVersionLabel, encodeVersionLabel, groupVersions, historyNote, LABEL_SEPARATOR, momentPhrase, previewTitle, restoredMessage,
  restoreVersion, RestoreError, VERSION_LABEL_MAX, versionConflict, type RestoreDeps, type RestoreStep,
} from '../src/design/versions/model';

const TZ = 'Europe/Moscow';
// 6 October 2026, 15:00 in Moscow.
const NOW = Date.parse('2026-10-06T12:00:00Z');
const at = (iso: string) => new Date(Date.parse(iso)).toISOString();
let seq = 0;
const version = (iso: string, label: string | null = null): DesignVersionSummary => ({id: `v${++seq}`, version: seq, label, createdAt: at(iso)});

test('a label carries a name and an optional description within the server limit', () => {
  assert.equal(encodeVersionLabel('  Before  client edits '), 'Before client edits');
  assert.equal(encodeVersionLabel('Final', 'Approved\nby Anna'), `Final${LABEL_SEPARATOR}Approved by Anna`);
  assert.equal(encodeVersionLabel('   '), null);
  assert.equal(encodeVersionLabel('Name', '   '), 'Name');
  const long = encodeVersionLabel('x'.repeat(80), 'o'.repeat(200))!;
  assert.equal([...long].length, VERSION_LABEL_MAX);
  assert.equal(long.split(LABEL_SEPARATOR)[0].length, 60);
  // The separator a user might paste never splits the name.
  assert.equal(decodeVersionLabel(encodeVersionLabel(`One${LABEL_SEPARATOR}two`)!)!.name, 'One two');
  assert.deepEqual(decodeVersionLabel(`Final${LABEL_SEPARATOR}Approved`), {name: 'Final', description: 'Approved'});
  assert.deepEqual(decodeVersionLabel('Old name'), {name: 'Old name', description: ''});
  assert.equal(decodeVersionLabel(null), null);
});

test('days read as "Today", "Yesterday", a date, and a date with the year', () => {
  const clock = {now: NOW, timeZone: TZ};
  assert.equal(dayTitle(Date.parse('2026-10-06T05:00:00Z'), clock), 'Today');
  // 23:30 on 5 October in Moscow is 20:30 UTC: yesterday there, whatever the machine's zone.
  assert.equal(dayTitle(Date.parse('2026-10-05T20:30:00Z'), clock), 'Yesterday');
  assert.equal(dayTitle(Date.parse('2026-10-05T21:30:00Z'), clock), 'Today');
  assert.equal(dayTitle(Date.parse('2026-10-03T09:00:00Z'), clock), 'October 3');
  assert.match(dayTitle(Date.parse('2025-12-31T09:00:00Z'), clock), /^December 31, 2025/);
  assert.equal(momentPhrase('2026-10-06T11:05:00Z', clock), 'today at 14:05');
  assert.equal(momentPhrase('2026-10-03T15:00:00Z', clock), 'October 3 at 18:00');
  assert.equal(previewTitle({label: null, createdAt: '2026-10-06T11:05:00Z'}, clock), 'You are viewing the version, saved today at 14:05');
  assert.equal(previewTitle({label: null, createdAt: '2026-10-03T15:00:00Z'}, clock), 'You are viewing the version from October 3, 18:00');
  assert.equal(previewTitle({label: `Final${LABEL_SEPARATOR}For the client`, createdAt: '2026-10-03T15:00:00Z'}, clock), 'You are viewing the version "Final" from October 3, 18:00');
  assert.equal(previewTitle({label: 'Final', createdAt: '2026-10-05T15:00:00Z'}, clock), 'You are viewing the version "Final", saved yesterday at 18:00');
  assert.equal(restoredMessage({label: null, createdAt: '2026-10-06T11:05:00Z'}, clock), 'Restored the version saved today at 14:05. The previous state of the file is saved in the history.');
  assert.equal(restoredMessage({label: 'Final', createdAt: '2026-10-03T15:00:00Z'}, clock), 'Restored version "Final". The previous state of the file is saved in the history.');
  assert.equal(restoredMessage({label: null, createdAt: '2026-10-03T15:00:00Z'}, clock), 'Restored the version from October 3, 18:00. The previous state of the file is saved in the history.');
});

test('the list groups by day, names named versions and folds long runs of autosaves', () => {
  seq = 0;
  const versions = [
    version('2026-10-06T11:40:00Z'),
    version('2026-10-06T11:20:00Z', `Before edits${LABEL_SEPARATOR}Sent to the client`),
    version('2026-10-06T10:50:00Z'),
    version('2026-10-06T10:30:00Z'),
    version('2026-10-06T10:10:00Z'),
    version('2026-10-06T09:50:00Z'),
    version('2026-10-05T15:00:00Z'),
    version('2026-10-01T15:00:00Z', 'First draft'),
  ].reverse();
  const days = groupVersions(versions, {now: NOW, timeZone: TZ});
  assert.deepEqual(days.map(day => day.title), ['Today', 'Yesterday', 'October 1']);
  const today = days[0].rows;
  assert.deepEqual(today.map(row => (row.kind === 'version' ? `${row.title} ${row.time}` : `+${row.count}`)), [
    'Autosave 14:40', 'Before edits 14:20', 'Autosave 13:50', '+3',
  ]);
  const named = today[1];
  assert.ok(named.kind === 'version' && named.named && named.description === 'Sent to the client');
  const more = today[3];
  assert.ok(more.kind === 'more');
  const expanded = groupVersions(versions, {now: NOW, timeZone: TZ, expanded: new Set([more.key])});
  assert.equal(expanded[0].rows.length, 6);
  assert.ok(expanded[0].rows.every(row => row.kind === 'version'));
  // Runs never cross a day or a named version; two autosaves stay unfolded.
  assert.deepEqual(days[1].rows.map(row => row.kind), ['version']);
  assert.deepEqual(groupVersions([], {now: NOW, timeZone: TZ}), []);
});

test('plurals and the history note', () => {
  assert.deepEqual([1, 2, 5, 11, 21].map(autosaveWord), [
    'autosave', 'autosaves', 'autosaves', 'autosaves', 'autosaves',
  ]);
  assert.equal(historyNote().title, 'History for the last year.');
  assert.equal(historyNote({historyDays: 21}).title, 'History for the last 21 days.');
  assert.equal(historyNote({historyDays: 1}).title, 'History for the last 1 day.');
});

// ── Restore flow ──

const doc = createDocument('page');
function deps(options: {flushFails?: boolean; answers: (number | {conflict: number | null} | Error)[]; base?: number}) {
  const log: string[] = [];
  const steps: RestoreStep[] = [];
  const answers = [...options.answers];
  let base = options.base ?? 7;
  const value: RestoreDeps = {
    async flush() {
      log.push('flush');
      if (options.flushFails) throw new Error('No connection to the server.');
      base += 1;
    },
    baseVersion: () => base,
    async document() {
      log.push('document');
      return doc;
    },
    async restore(at) {
      log.push(`restore@${at}`);
      const answer = answers.shift()!;
      if (typeof answer === 'number') return {version: answer, updatedAt: '2026-10-06T12:00:00Z'};
      if (answer instanceof Error) throw answer;
      throw Object.assign(new Error('The file was changed.'), {status: 409, details: {code: 'version_conflict', ...(answer.conflict === null ? {} : {currentVersion: answer.conflict})}});
    },
    adopt(next, at) {
      log.push(`adopt@${at}`);
      assert.equal(next, doc);
    },
    onStep: step => void steps.push(step),
  };
  return {value, log, steps};
}

test('restore stores pending edits, then restores on top of the version they made', async () => {
  const run = deps({answers: [9]});
  const result = await restoreVersion(run.value);
  assert.deepEqual(result, {version: 9, doc, retried: false});
  assert.deepEqual(run.log, ['flush', 'document', 'restore@8', 'adopt@9']);
  assert.deepEqual(run.steps, ['saving', 'loading', 'restoring', 'done']);
});

test('a conflict with the current version is retried once on top of it', async () => {
  const run = deps({answers: [{conflict: 12}, 13]});
  const result = await restoreVersion(run.value);
  assert.equal(result.retried, true);
  assert.deepEqual(run.log, ['flush', 'document', 'restore@8', 'restore@12', 'adopt@13']);
});

test('a second conflict, or one without a version, stops without adopting anything', async () => {
  for (const answers of [[{conflict: 12}, {conflict: 14}], [{conflict: null}]]) {
    const run = deps({answers});
    await assert.rejects(restoreVersion(run.value), (error: unknown) => error instanceof RestoreError && error.reason === 'conflict' && /another tab/.test(error.message));
    assert.ok(!run.log.some(entry => entry.startsWith('adopt')));
  }
});

test('unsaved edits that cannot be stored stop the restore before it reaches the server', async () => {
  const run = deps({flushFails: true, answers: [9]});
  await assert.rejects(restoreVersion(run.value), (error: unknown) => error instanceof RestoreError && error.reason === 'unsaved' && /The version was not restored/.test(error.message));
  assert.deepEqual(run.log, ['flush']);
});

test('any other failure is reported with the server message', async () => {
  const run = deps({answers: [new Error('The file is larger than 20 MB.')]});
  await assert.rejects(restoreVersion(run.value), (error: unknown) => error instanceof RestoreError && error.reason === 'failed' && error.message === 'The file is larger than 20 MB.');
  assert.deepEqual(versionConflict({status: 409, details: {code: 'version_conflict', currentVersion: 3}}), {conflict: true, currentVersion: 3});
  assert.deepEqual(versionConflict({status: 409, details: {code: 'design_file_limit'}}), {conflict: false, currentVersion: null});
  assert.deepEqual(versionConflict(null), {conflict: false, currentVersion: null});
});

test('the version cache reads each version once, keeps the last few and forgets failures', async () => {
  const reads: string[] = [];
  let fail = true;
  const cache = createVersionCache(async id => {
    reads.push(id);
    if (id === 'bad' && fail) throw new Error('no connection');
    return doc;
  }, 2);
  await cache.get('a');
  await cache.get('a');
  await cache.get('b');
  await cache.get('c');
  assert.equal(cache.has('a'), false);
  await assert.rejects(cache.get('bad'));
  await new Promise(resolve => setTimeout(resolve, 0));
  fail = false;
  await cache.get('bad');
  assert.deepEqual(reads, ['a', 'b', 'c', 'bad', 'bad']);
});
