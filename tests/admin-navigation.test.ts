import {test} from 'node:test';
import assert from 'node:assert/strict';
import {isAdminHash, navigationFromUrl, navigationUrl, normalizeNavigation} from '../src/navigation';
import {accountHash, adminHash, accountsHash, parseAdminHash, periodHash, supportHash} from '../src/admin/route';
import {dayLabel, delta, plural, pct} from '../src/admin/format';

// The operator's console addresses (#admin…, src/admin/route.ts) and how the shell's navigation treats them (src/navigation.ts):
// only an operator's address opens the console; for anyone else every #admin… is the file browser, as before.

const here = {pathname: '/', search: ''};

test('admin hashes are recognised, and only those', () => {
  for (const hash of ['#admin', '#admin/accounts', '#admin/accounts/acc_1', '#admin?period=90d', '#admin/support/thr_1?filter=all']) assert.equal(isAdminHash(hash), true, hash);
  for (const hash of ['#administrator', '#designs', '#design/abc', '', '#']) assert.equal(isAdminHash(hash), false, hash);
});

test('an admin address opens the console for an operator and the file browser for anyone else', () => {
  assert.deepEqual(navigationFromUrl({hash: '#admin/usage?period=90d'}, {admin: true}), {kind: 'admin', route: 'admin/usage?period=90d'});
  assert.deepEqual(navigationFromUrl({hash: '#admin/usage?period=90d'}), {kind: 'workspace', view: 'designs'});
  assert.deepEqual(navigationFromUrl({hash: '#admin'}, {admin: false}), {kind: 'workspace', view: 'designs'});
  // A file still wins over everything.
  assert.deepEqual(navigationFromUrl({hash: '#design/f1'}, {admin: true}), {kind: 'design', fileId: 'f1'});
});

test('an admin request without a route goes to the overview, and keeps its route otherwise', () => {
  assert.deepEqual(normalizeNavigation({kind: 'admin'}), {kind: 'admin', route: 'admin'});
  assert.equal(navigationUrl({kind: 'admin'}, here), '/#admin');
  assert.equal(navigationUrl({kind: 'admin', route: 'admin/accounts?segment=closing'}, here), '/#admin/accounts?segment=closing');
  // Something that is not a console route is not smuggled in.
  assert.equal(navigationUrl({kind: 'admin', route: 'designs'}, here), '/#admin');
});

test('console routes read and write the hash, defaults left out', () => {
  assert.deepEqual(parseAdminHash('#admin'), {section: 'overview', period: '30d'});
  assert.deepEqual(parseAdminHash('#admin/usage?period=365d'), {section: 'usage', period: '365d'});
  assert.deepEqual(parseAdminHash('#admin/usage?period=bogus'), {section: 'usage', period: '30d'});
  assert.deepEqual(parseAdminHash('#admin/nowhere'), {section: 'overview', period: '30d'});
  assert.deepEqual(parseAdminHash('#admin/accounts?q=anna&segment=closing&sort=files&order=asc&page=3'), {
    section: 'accounts',
    list: {q: 'anna', segment: 'closing', sort: 'files', order: 'asc', page: 3},
  });
  assert.deepEqual(parseAdminHash('#admin/accounts?segment=vip&sort=x&page=-2'), {section: 'accounts', list: {q: '', segment: 'all', sort: 'created', order: 'desc', page: 1}});
  assert.deepEqual(parseAdminHash('#admin/accounts/acc%2F1'), {section: 'account', id: 'acc/1'});
  assert.deepEqual(parseAdminHash('#admin/support/thr_9?filter=closed&q=vk'), {section: 'support', support: {filter: 'closed', q: 'vk', thread: 'thr_9'}});
  assert.deepEqual(parseAdminHash('#admin/support?filter=nope'), {section: 'support', support: {filter: 'waiting', q: '', thread: null}});

  assert.equal(periodHash('overview', '30d'), '#admin');
  assert.equal(periodHash('usage', '90d'), '#admin/usage?period=90d');
  assert.equal(accountsHash(), '#admin/accounts');
  assert.equal(accountsHash({segment: 'closing', page: 2}), '#admin/accounts?segment=closing&page=2');
  assert.equal(accountHash('acc/1'), '#admin/accounts/acc%2F1');
  assert.equal(supportHash(), '#admin/support');
  assert.equal(supportHash({thread: 'thr_1', filter: 'all'}), '#admin/support/thr_1?filter=all');
  for (const hash of ['#admin/accounts?q=a+b&segment=active&sort=storage&order=asc&page=4', '#admin/usage?period=7d', '#admin/support/t1?filter=open&q=x']) {
    assert.equal(adminHash(parseAdminHash(hash)), hash);
  }
});

test('numbers are written English style', () => {
  assert.equal(pct(0.031), '3.1%');
  assert.equal(pct(0.42), '42%');
  assert.equal(plural(1, 'day', 'days'), 'day');
  assert.equal(plural(3, 'day', 'days'), 'days');
  assert.equal(plural(12, 'day', 'days'), 'days');
  assert.equal(plural(142, 'day', 'days'), 'days');
  // A short month is written "Aug", with a no-break space before the day.
  assert.equal(dayLabel('2026-08-10'), 'Aug 10');
  assert.deepEqual(delta({value: 112, previous: 100}), {text: '+12%', direction: 'up', tone: 'good'});
  assert.deepEqual(delta({value: 90, previous: 100}, {upIsGood: false}), {text: '−10%', direction: 'down', tone: 'good'});
  assert.equal(delta({value: 5, previous: null}), null);
  assert.deepEqual(delta({value: 2871, previous: 100}), {text: '×29', direction: 'up', tone: 'good'});
  assert.deepEqual(delta({value: 0.95, previous: 0.92}, {points: true}), {text: '+3 pp', direction: 'up', tone: 'good'});
});
