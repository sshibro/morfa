import assert from 'node:assert/strict';
import {test} from 'node:test';
import {accountInitial, accountLabel} from '../src/design/files/account';

test('should show the name and its first letter when the account has a name', () => {
  const account = {id: 'a', name: 'anna Smith', email: 'anna@example.com'};
  assert.equal(accountLabel(account), 'anna Smith');
  assert.equal(accountInitial(account), 'A');
});

test('should show the address before the at sign when the account has no name', () => {
  const account = {id: 'a', name: null, email: 'dev@localhost'};
  assert.equal(accountLabel(account), 'dev');
  assert.equal(accountInitial(account), 'D');
});

test('should show a neutral label when the account is not read yet', () => {
  assert.equal(accountLabel(null), 'Account');
  assert.equal(accountInitial(null), '·');
});

test('should keep only the boards when the filter asks for boards', async () => {
  const {filterKind} = await import('../src/design/files/format');
  const files = [{id: '1', kind: 'board'}, {id: '2', kind: 'design'}, {id: '3'}];
  assert.deepEqual(filterKind(files, 'board').map(file => file.id), ['1']);
});

test('should count a file without a kind as a design file when the filter asks for designs', async () => {
  const {filterKind} = await import('../src/design/files/format');
  const files = [{id: '1', kind: 'board'}, {id: '2', kind: 'design'}, {id: '3'}];
  assert.deepEqual(filterKind(files, 'design').map(file => file.id), ['2', '3']);
  assert.equal(filterKind(files, 'all').length, 3);
});

const memory = () => {
  const data = new Map<string, string>();
  return {getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value)};
};

test('should sort the files last opened first when the sort is by viewing', async () => {
  const {sortFiles} = await import('../src/design/files/format');
  const {recordViewed, viewedTimes} = await import('../src/design/files/viewed');
  const store = memory();
  recordViewed('b', 100, store);
  recordViewed('a', 200, store);
  const file = (id: string, updatedAt: string) => ({id, name: id, updatedAt, createdAt: updatedAt});
  const files = [file('a', '2026-01-01'), file('b', '2026-01-02'), file('c', '2026-01-03'), file('d', '2026-01-04')];
  assert.deepEqual(sortFiles(files, 'viewed', viewedTimes(store)).map(entry => entry.id), ['a', 'b', 'd', 'c']);
});

test('should keep only the newest opened files when the list is full', async () => {
  const {recordViewed, viewedTimes, VIEWED_LIMIT} = await import('../src/design/files/viewed');
  const store = memory();
  for (let index = 0; index <= VIEWED_LIMIT; index++) recordViewed('f' + index, index, store);
  const times = viewedTimes(store);
  assert.equal(times.size, VIEWED_LIMIT);
  assert.ok(!times.has('f0'));
});

test('should sort the trash by when the files were deleted when the sort is by change', async () => {
  const {sortFiles} = await import('../src/design/files/format');
  const file = (id: string, updatedAt: string, trashedAt: string) => ({id, name: id, updatedAt, createdAt: updatedAt, trashedAt});
  const files = [file('old-change', '2026-01-01', '2026-02-02'), file('new-change', '2026-01-05', '2026-02-01')];
  assert.deepEqual(sortFiles(files, 'updated').map(entry => entry.id), ['old-change', 'new-change']);
});

test('should find projects by their name or their team name when the search has text', async () => {
  const {matchProjects} = await import('../src/design/files/search');
  const teams = [
    {id: 't1', name: 'North Studio', projects: [{id: 'p1', name: 'Coffee shop site'}, {id: 'p2', name: 'Logo'}]},
    {id: 't2', name: 'Marketing', projects: [{id: 'p3', name: 'North: banners'}]},
  ] as never;
  assert.deepEqual(matchProjects(teams, 'north').map(match => match.projectId), ['p3', 'p1', 'p2']);
  assert.deepEqual(matchProjects(teams, 'coffee').map(match => match.name), ['Coffee shop site']);
  assert.deepEqual(matchProjects(teams, '  '), []);
});
