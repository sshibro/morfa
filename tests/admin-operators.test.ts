import test from 'node:test';
import assert from 'node:assert/strict';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {OperatorCandidate} from '../server/admin/operators';
import {addDays, adminWindow, dense, lastDays, slices, weekOf, windowDays} from '../server/admin/analytics/window';

// Who opens the operator's console (server/admin/operators.ts) and how its reports cut time into Moscow days (server/admin/analytics/
// window.ts), without a database: the operator module's gate reads the session through server/auth, whose pool is lazy, so a
// placeholder address is never connected to.
process.env.MORFA_DATABASE_URL ||= 'postgresql://morfa_runtime:unused@127.0.0.1:5999/morfa?sslmode=disable';
process.env.DATA_DIR ||= path.join(tmpdir(), 'morfa-admin-operators');
const {isOperator, operatorsNamed} = await import('../server/admin/operators');

const account = (fields: Partial<OperatorCandidate> = {}): OperatorCandidate => ({
  id: 'acc-1',
  email: 'Owner@Example.com',
  email_verified: 1,
  deletion_requested_at: null,
  erasure_completed_at: null,
  ...fields,
});

test('MORFA_OPERATORS names operators by id, or by the address of the account', () => {
  const production = (list: string) => ({MORFA_OPERATORS: list, NODE_ENV: 'production'});
  assert.equal(isOperator(account(), production('acc-1')), true);
  assert.equal(
    isOperator(account(), production(' other , OWNER@example.COM ')),
    true,
    'an address in any case, trimmed',
  );
  assert.equal(
    isOperator(account({email_verified: 0}), production('owner@example.com')),
    false,
    'an unproven address names nobody',
  );
  assert.equal(isOperator(account({email_verified: 0}), production('acc-1')), true, 'an id needs no proven address');
  assert.equal(isOperator(account(), production('acc-2,someone@example.com')), false);
  assert.equal(isOperator(account(), production('')), false, 'empty: nobody');
  assert.equal(isOperator(account(), {NODE_ENV: 'production'}), false, 'unset: nobody');
  assert.equal(isOperator(null, production('acc-1')), false, 'signed out');
  assert.deepEqual(
    [operatorsNamed({MORFA_OPERATORS: ' , '}), operatorsNamed({}), operatorsNamed({MORFA_OPERATORS: 'acc-1'})],
    [false, false, true],
  );
});

test('an operator signs in by typing the name their address is made from', () => {
  // Name sign-in makes every account with its name's address (shared/sign-in.ts nameAddress), own to it (email_verified=1).
  const owner = account({id: 'name-1', email: 'owner@name.invalid', email_verified: 1});
  for (const NODE_ENV of ['development', 'test', 'production'])
    assert.equal(isOperator(owner, {MORFA_OPERATORS: 'Owner@Name.Invalid', NODE_ENV}), true, NODE_ENV);
  assert.equal(isOperator(owner, {MORFA_OPERATORS: 'someone@name.invalid', NODE_ENV: 'production'}), false);
});

test('an account that is closing or erased is never an operator', () => {
  const env = {MORFA_OPERATORS: 'acc-1,owner@example.com', NODE_ENV: 'production'};
  assert.equal(isOperator(account({deletion_requested_at: '2026-10-09 10:00:00'}), env), false);
  assert.equal(
    isOperator(
      account({deletion_requested_at: '2026-10-09 10:00:00', erasure_completed_at: '2026-10-10 10:00:00'}),
      env,
    ),
    false,
  );
});

test('a window is [now - days, now); its series has a point per Moscow day it touches, «the last N days» exactly N', () => {
  // 12:00 in Moscow on Saturday 10 October.
  const now = new Date('2026-10-10T09:00:00.000Z');
  const window = adminWindow('7d', now);
  assert.deepEqual(window, {
    period: '7d',
    from: '2026-10-03T09:00:00.000Z',
    to: '2026-10-10T09:00:00.000Z',
    previousFrom: '2026-09-26T09:00:00.000Z',
    days: 7,
  });
  assert.deepEqual(windowDays(window), daysFrom('2026-10-03', 8), 'the partial first day and today: 8 Moscow days');
  // At Moscow midnight the window ends where a day begins: that day is not in it.
  const midnight = adminWindow('7d', new Date('2026-10-09T21:00:00.000Z'));
  assert.deepEqual(windowDays(midnight), daysFrom('2026-10-03', 7));
  // 23:30 UTC on 9 October is already 10 October in Moscow.
  assert.deepEqual(lastDays(new Date('2026-10-09T23:30:00.000Z'), 3), ['2026-10-08', '2026-10-09', '2026-10-10']);
  assert.equal(lastDays(now, 30).length, 30);
  assert.equal(lastDays(now, 30)[0], '2026-09-11');
  assert.equal(weekOf('2026-10-10'), '2026-10-05', 'a Saturday is in the week of the Monday before');
  assert.equal(weekOf('2026-10-05'), '2026-10-05');
  assert.equal(weekOf('2026-10-11'), '2026-10-05', 'Sunday ends the week');
  assert.deepEqual(dense(['2026-10-01', '2026-10-02'], [{day: '2026-10-02', value: '7'}]), [
    {day: '2026-10-01', value: 0},
    {day: '2026-10-02', value: 7},
  ]);
});

test('slices keep the fixed keys in order with zeros, then the rest largest first, labelled', () => {
  assert.deepEqual(
    slices(
      [
        {key: 'b', value: 2},
        {key: 'x', value: 5},
        {key: 'y', value: 0},
        {key: 'z', value: 9},
      ],
      {a: 'A', b: 'B'},
      ['a', 'b'],
    ),
    [
      {key: 'a', label: 'A', value: 0},
      {key: 'b', label: 'B', value: 2},
      {key: 'z', label: 'z', value: 9},
      {key: 'x', label: 'x', value: 5},
    ],
  );
});

function daysFrom(first: string, count: number) {
  return Array.from({length: count}, (_, i) => addDays(first, i));
}
