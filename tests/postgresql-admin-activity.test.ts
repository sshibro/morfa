import {after, before, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {bootPostgresqlDatabase, migrationDatabase} from './helpers/app-fixture';

// The activity journal the operator's console reads (server/admin/telemetry.ts): an action is recorded at most once a minute per
// account and action, rows past the retention go with the maintenance pass, and the safety cap reads the table's size estimate, never
// a count.

const DAY = 86_400_000;
let fixture: Awaited<ReturnType<typeof bootPostgresqlDatabase>>;
let telemetry: typeof import('../server/admin/telemetry');
before(async () => {
  fixture = await bootPostgresqlDatabase();
  telemetry = await import('../server/admin/telemetry');
  await owner(db =>
    db.execute(`INSERT INTO users(id,email,name,email_verified,deletion_requested_at) VALUES
      ('acc-a','a@example.test','A',1,NULL),('acc-b','b@example.test','B',1,NULL),('acc-closing','c@example.test','C',1,'2026-10-01 10:00:00')`),
  );
});
after(async () => {
  telemetry?.resetActivityJournal();
  await fixture?.close();
});
beforeEach(async () => {
  telemetry.resetActivityJournal();
  await owner(db => db.execute('TRUNCATE admin_activity'));
});

/** The migration role: for what the runtime may not do (ANALYZE) and for rows written as of another time. */
async function owner<T>(work: (db: ReturnType<typeof migrationDatabase>) => Promise<T>): Promise<T> {
  const db = migrationDatabase(fixture);
  try {
    return await work(db);
  } finally {
    await db.close();
  }
}
const rows = async (userId?: string) =>
  fixture.db.many<{user_id: string; action: string; created_at: string}>(
    `SELECT user_id,action,created_at FROM admin_activity ${userId ? 'WHERE user_id=$1' : ''} ORDER BY user_id,action,created_at`,
    userId ? [userId] : [],
  );
const record = async (accountId: string, action: string) => {
  await telemetry.recordActivity(accountId, action);
  await telemetry.drainTelemetry();
};
const row = (userId: string, action: string, createdAt: string) =>
  owner(db =>
    db.execute('INSERT INTO admin_activity(id,user_id,action,created_at) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      userId,
      action,
      createdAt,
    ]),
  );

test('each action is recorded at most once a minute per account and action, an autosave’s PUTs included', async () => {
  const save = 'PUT /api/design-files/:id';
  for (let i = 0; i < 3; i++) {
    await record('acc-a', 'read');
    await record('acc-a', save);
  }
  await record('acc-a', 'POST /api/design-files');
  await record('acc-b', save);
  assert.deepEqual(
    (await rows()).map(r => [r.user_id, r.action]),
    [
      ['acc-a', 'POST /api/design-files'],
      ['acc-a', save],
      ['acc-a', 'read'],
      ['acc-b', save],
    ],
  );
  // Another process (nothing remembered here) finds the minute's row in the journal itself.
  telemetry.resetActivityJournal();
  await record('acc-a', save);
  assert.equal((await rows('acc-a')).filter(r => r.action === save).length, 1);
  // A row older than a minute does not hold the next one back.
  await owner(db =>
    db.execute("UPDATE admin_activity SET created_at=$1 WHERE user_id='acc-b'", [
      new Date(Date.now() - 2 * 60_000).toISOString(),
    ]),
  );
  telemetry.resetActivityJournal();
  await record('acc-b', save);
  assert.equal((await rows('acc-b')).length, 2);
  // A closing account is no one to record.
  await record('acc-closing', 'read');
  assert.deepEqual(await rows('acc-closing'), []);
});

test('the maintenance pass deletes the rows past the retention, in batches, and keeps the rest', async () => {
  const now = new Date('2026-10-10T09:00:00.000Z');
  const at = (days: number) => new Date(now.getTime() - days * DAY).toISOString();
  await row('acc-a', 'read', at(401));
  await row('acc-a', 'read', at(401).slice(0, 19).replace('T', ' '));
  // The cutoff's own day (400 days before) stays whole, in either text shape.
  await row('acc-a', 'read', at(400).slice(0, 10) + ' 00:00:01');
  await row('acc-a', 'read', at(10));
  await row('acc-b', 'read', at(399));
  // More old rows than one batch deletes.
  await owner(db =>
    db.execute(`INSERT INTO admin_activity(id,user_id,action,created_at)
      SELECT gen_random_uuid()::text,'acc-b','read',to_char(timestamp '2024-01-01'+(g||' minutes')::interval,'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
      FROM generate_series(1,60000) g`),
  );
  assert.equal(telemetry.ACTIVITY_RETENTION_DAYS, 400);
  assert.equal(await telemetry.pruneActivity(now), 60_002);
  assert.deepEqual(
    (await rows()).map(r => [r.user_id, r.created_at.slice(0, 10)]),
    [
      ['acc-a', at(400).slice(0, 10)],
      ['acc-a', at(10).slice(0, 10)],
      ['acc-b', at(399).slice(0, 10)],
    ],
  );
  assert.equal(await telemetry.pruneActivity(now), 0, 'nothing more to do');
  // The worker's hourly maintenance pass runs it as of now.
  await owner(db => db.execute('TRUNCATE admin_activity'));
  const recent = new Date(Date.now() - DAY).toISOString();
  await row('acc-a', 'read', new Date(Date.now() - 500 * DAY).toISOString());
  await row('acc-a', 'read', recent);
  const {launchMaintenance} = await import('../server/launch/lifecycle');
  await launchMaintenance();
  assert.deepEqual(
    (await rows('acc-a')).map(r => r.created_at),
    [recent],
  );
});

test('past the safety cap new rows are dropped, judged by the size estimate, and taken again once under it', async () => {
  for (let i = 0; i < 10; i++)
    await row('acc-b', `GET old ${i}`, new Date(Date.now() - (i + 2) * 60_000).toISOString());
  // The estimate is the planner's (autovacuum keeps it); here ANALYZE stands in for it.
  await owner(db => db.execute('ANALYZE admin_activity'));
  telemetry.resetActivityJournal(5);
  await record('acc-a', 'POST /api/design-files');
  assert.deepEqual(await rows('acc-a'), [], 'over the cap: dropped, the request unaffected');
  telemetry.resetActivityJournal();
  await record('acc-a', 'POST /api/design-files');
  assert.equal((await rows('acc-a')).length, 1);
});
