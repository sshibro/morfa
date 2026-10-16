import {test} from 'node:test';
import assert from 'node:assert/strict';
import {editedAgo, formatBytes, matchesSearch, plural, relativeTime, sortFiles} from '../src/design/files/format';

const now = Date.parse('2026-10-06T12:00:00Z');
const ago = (seconds: number) => new Date(now - seconds * 1000).toISOString();

test('times read as English relative phrases', () => {
  assert.equal(relativeTime(ago(10), now), 'just now');
  assert.equal(relativeTime(ago(5 * 60), now), '5 min ago');
  assert.equal(editedAgo(ago(5 * 60), now), 'Modified 5 min ago');
  assert.equal(relativeTime(ago(3 * 3600), now), '3 hr ago');
  assert.equal(relativeTime(ago(24 * 3600), now), 'yesterday');
  assert.equal(relativeTime(ago(3 * 24 * 3600), now), '3 days ago');
  assert.equal(relativeTime(ago(9 * 24 * 3600), now), 'last week');
  assert.equal(relativeTime(ago(400 * 24 * 3600), now), 'last year');
  assert.equal(relativeTime('not a date', now), '');
});

test('sizes and counts print the English way', () => {
  assert.equal(formatBytes(0), '0\u00a0B');
  assert.equal(formatBytes(512 * 1024), '512 KB');
  assert.equal(formatBytes(120 * 1024 * 1024), '120 MB');
  assert.equal(formatBytes(1.2 * 1024 ** 3), '1.2 GB');
  assert.equal(formatBytes(1024 ** 3), '1 GB');
  assert.equal(formatBytes(1023.8 * 1024 * 1024), '1 GB', 'rounds up into the next unit');
  assert.equal(plural(11, 'file', 'files'), 'files');
  assert.equal(plural(1, 'file', 'files'), 'file');
});

test('files sort by change, name (English order, numbers by value) or creation; search folds case', () => {
  const files = [
    {name: 'Landing 10', updatedAt: ago(60), createdAt: ago(9000)},
    {name: 'apple', updatedAt: ago(10), createdAt: ago(100)},
    {name: 'Landing 2', updatedAt: ago(3600), createdAt: ago(50)},
  ];
  assert.deepEqual(sortFiles(files, 'updated').map(file => file.name), ['apple', 'Landing 10', 'Landing 2']);
  assert.deepEqual(sortFiles(files, 'name').map(file => file.name), ['apple', 'Landing 2', 'Landing 10']);
  assert.deepEqual(sortFiles(files, 'created').map(file => file.name), ['Landing 2', 'apple', 'Landing 10']);
  assert.ok(matchesSearch('Apple on the site', 'APPL'));
  assert.ok(matchesSearch('Landing', '  LAN '));
  assert.ok(!matchesSearch('Landing', 'banner'));
});
