import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {bootPostgresqlApp, migrationDatabase, type AppFixture} from './helpers/app-fixture';
import type {Database} from '../server/postgresql/client';
import type {AdminAccountRow, AdminDayPoint} from '../shared/admin-analytics';

// The operator's console (server/admin): what each screen reads, on the real schema, from accounts seeded in deliberately different
// states (active with files, a team owner and a member, closing, erased), with journal rows on known Moscow days and files, next to two
// accounts at a reserved `.invalid` address that are no one's. The clock is injected; the HTTP part (who may see the console) runs
// last, so its own requests never reach the numbers above it.

const DAY = 86_400_000,
  HOUR = 3_600_000;
/** 12:00 in Moscow on Saturday 10 October 2026. */
const NOW = new Date('2026-10-10T09:00:00.000Z');
const at = (days: number, hours = 0) => new Date(NOW.getTime() + days * DAY + hours * HOUR).toISOString();
/** The other shape the text timestamps take: 'YYYY-MM-DD HH24:MI:SS' UTC. */
const plain = (iso: string) => iso.slice(0, 19).replace('T', ' ');

const ACCOUNTS = {
  anna: 'acc-anna',
  boris: 'acc-boris',
  vera: 'acc-vera',
  grisha: 'acc-grisha',
  dina: 'acc-dina',
  egor: 'acc-egor',
  zhanna: 'acc-zhanna',
  zoya: 'acc-zoya',
  erased: 'acc-erased',
  gleb: 'acc-gleb',
  op: 'acc-op',
} as const;
const TEAM = randomUUID();
const F = Object.fromEntries(['F1', 'F2', 'F3', 'F4'].map(key => [key, randomUUID()]));
/** At a reserved `.invalid` address (server/admin/analytics/people.ts): the drain drill's, and one written in capitals. */
const RESERVED = {drill: 'drill-1', loud: 'drill-2'} as const;
const DRILL = {team: randomUUID(), file: randomUUID()};

let fixture: AppFixture;
let admin: {
  overview: typeof import('../server/admin/analytics/overview');
  accounts: typeof import('../server/admin/analytics/accounts');
  account: typeof import('../server/admin/analytics/account');
  usage: typeof import('../server/admin/analytics/usage');
};
const saved = Object.fromEntries(['MORFA_OPERATORS'].map(key => [key, process.env[key]]));
before(async () => {
  delete process.env.MORFA_OPERATORS;
  fixture = await bootPostgresqlApp();
  const owner = migrationDatabase(fixture);
  try {
    await seed(owner);
  } finally {
    await owner.close();
  }
  admin = {
    overview: await import('../server/admin/analytics/overview'),
    accounts: await import('../server/admin/analytics/accounts'),
    account: await import('../server/admin/analytics/account'),
    usage: await import('../server/admin/analytics/usage'),
  };
});
after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fixture?.close();
});

async function seed(db: Database) {
  const user = (
    id: string,
    name: string,
    email: string,
    created: string,
    fields: {verified?: 0 | 1; closing?: string; erased?: string} = {},
  ) =>
    db.execute(
      'INSERT INTO users(id,email,name,email_verified,created_at,deletion_requested_at,erasure_completed_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, email, name, fields.verified ?? 1, created, fields.closing ?? null, fields.erased ?? null],
    );
  // Anna and Zhanna keep Cyrillic names on purpose: the search test below looks them up in Cyrillic, in any case.
  await user(ACCOUNTS.anna, 'Анна Ильина', 'anna@example.test', '2026-09-15 10:00:00');
  await user(ACCOUNTS.boris, 'Boris Orlov', 'boris@example.test', '2026-08-20T10:00:00.000Z');
  await user(ACCOUNTS.vera, 'Vera Stone', 'vera@example.test', '2026-09-12 08:00:00');
  await user(ACCOUNTS.grisha, 'Gregory Grant', 'grisha@example.test', '2026-07-01 10:00:00');
  await user(ACCOUNTS.dina, 'Dina Rogers', 'dina@example.test', '2026-09-25 10:00:00');
  await user(ACCOUNTS.egor, 'George Usher', 'egor@example.test', '2026-06-01 10:00:00');
  await user(ACCOUNTS.zhanna, 'Жанна Зайцева', 'zhanna@example.test', '2026-10-01 09:00:00', {verified: 0});
  await user(ACCOUNTS.zoya, 'Zoe Drake', 'zoya@example.test', '2026-05-01 10:00:00', {closing: plain(at(-1))});
  // The tombstone server/launch/lifecycle.ts writes: an erased account, not a reserved address.
  await user(ACCOUNTS.erased, '', 'erased-acc-erased@invalid.local', '2026-04-01 10:00:00', {
    closing: plain(at(-2)),
    erased: plain(at(-1)),
  });
  await user(ACCOUNTS.gleb, 'Glen Member', 'gleb@example.test', '2026-10-05 12:00:00');
  await user(ACCOUNTS.op, 'Operator', 'owner@localhost', '2026-01-01 10:00:00', {verified: 0});
  await db.execute(
    "INSERT INTO design_teams(id,name,owner_id,created_at) VALUES($1,'Studio',$2,'2026-09-12T09:00:00Z')",
    [TEAM, ACCOUNTS.vera],
  );
  await db.execute(
    `INSERT INTO design_team_members(team_id,user_id,role,joined_at) VALUES($1,$2,'owner','2026-09-12T09:00:00Z'),($1,$3,'editor','2026-10-05T12:10:00Z')`,
    [TEAM, ACCOUNTS.vera, ACCOUNTS.gleb],
  );

  const journal: Array<[string, string, string]> = [
    [ACCOUNTS.anna, '2026-10-10T08:00:00.000Z', 'read'],
    [ACCOUNTS.anna, '2026-10-09T09:00:00.000Z', 'read'],
    [ACCOUNTS.anna, '2026-10-09T09:01:00.000Z', 'POST /api/design-files'],
    [ACCOUNTS.anna, '2026-10-07T09:00:00.000Z', 'read'],
    [ACCOUNTS.anna, '2026-10-05 09:00:00', 'read'],
    [ACCOUNTS.anna, '2026-09-16T09:00:00.000Z', 'read'],
    // 00:30 on 10 October in Moscow.
    [ACCOUNTS.boris, '2026-10-09T21:30:00.000Z', 'PATCH /api/design-files/:id'],
    [ACCOUNTS.boris, '2026-09-01T10:00:00.000Z', 'read'],
    [ACCOUNTS.zhanna, '2026-10-01T10:00:00.000Z', 'read'],
    [ACCOUNTS.zhanna, '2026-10-03T12:00:00.000Z', 'POST /api/design-comments'],
    [ACCOUNTS.gleb, '2026-10-05T12:30:00.000Z', 'read'],
    [ACCOUNTS.grisha, '2026-09-05T10:00:00.000Z', 'read'],
  ];
  for (const [userId, created, action] of journal)
    await db.execute('INSERT INTO admin_activity(id,user_id,action,created_at) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      userId,
      action,
      created,
    ]);

  const file = (
    id: string,
    userId: string,
    name: string,
    bytes: number,
    created: string,
    fields: {team?: string; trashed?: string} = {},
  ) =>
    db.execute(
      `INSERT INTO design_files(id,user_id,team_id,name,document,bytes,node_count,created_at,updated_at,trashed_at)
       VALUES($1,$2,$3,$4,'{}',$5,3,$6,$6,$7)`,
      [id, userId, fields.team ?? null, name, bytes, created, fields.trashed ?? null],
    );
  await file(F.F1, ACCOUNTS.anna, 'Landing page', 1000, at(-20));
  await file(F.F2, ACCOUNTS.anna, 'Draft', 500, at(-19), {trashed: at(-2)});
  await file(F.F3, ACCOUNTS.vera, 'Team mockup', 300, at(-27), {team: TEAM});
  await file(F.F4, ACCOUNTS.zhanna, 'My first', 200, at(-8, 2));
  await db.execute(
    "INSERT INTO design_file_versions(id,file_id,user_id,version,label,document,bytes,created_at) VALUES($1,$2,$3,1,'Version 1','{}',500,$4)",
    [randomUUID(), F.F1, ACCOUNTS.anna, at(-18)],
  );
  await db.execute(
    "INSERT INTO design_images(filename,user_id,file_id,kind,bytes,width,height) VALUES('picture-1.webp',$1,$2,'image',2000,10,10)",
    [ACCOUNTS.anna, F.F1],
  );
  const thread = randomUUID();
  await db.execute(
    "INSERT INTO design_comment_threads(id,file_id,page_id,x,y,author_id,seq) VALUES($1,$2,'page-1',0,0,$3,1)",
    [thread, F.F3, ACCOUNTS.gleb],
  );
  await db.execute(
    "INSERT INTO design_comments(id,thread_id,author_id,body,created_at,seq) VALUES($1,$2,$3,'Fix the spacing','2026-10-05T13:00:00Z',1)",
    [randomUUID(), thread, ACCOUNTS.gleb],
  );
  await db.execute(
    "INSERT INTO design_file_members(file_id,user_id,role,invited_by,created_at) VALUES($1,$2,'viewer',$3,'2026-10-06T10:00:00Z')",
    [F.F1, ACCOUNTS.gleb, ACCOUNTS.anna],
  );
  const session = (userId: string, expires: number, created: string) =>
    db.execute('INSERT INTO sessions(token,user_id,expires,created_at) VALUES($1,$2,$3,$4)', [
      randomBytes(32).toString('hex'),
      userId,
      expires,
      created,
    ]);
  await session(ACCOUNTS.anna, NOW.getTime() + DAY, plain(at(-1)));
  await session(ACCOUNTS.anna, NOW.getTime() - DAY, plain(at(-9)));

  // The drill's accounts: one signs up in the window, owns a team and makes a file in it, comes back the next day and today; the other
  // signed up in the window before, was active then and now, joined both teams and commented in Vera's. Every number of the tests below is what it would be without them (the storage, the disk's, holds their file).
  await user(RESERVED.drill, 'Editor 1', 'drill-1@drill.invalid', '2026-10-08 10:00:00');
  await user(RESERVED.loud, 'Editor 2', 'DRILL-2@DRILL.INVALID', '2026-09-01T10:00:00.000Z');
  await db.execute(
    "INSERT INTO design_teams(id,name,owner_id,created_at) VALUES($1,'Drill',$2,'2026-10-08T10:05:00Z')",
    [DRILL.team, RESERVED.drill],
  );
  await db.execute(
    `INSERT INTO design_team_members(team_id,user_id,role,joined_at) VALUES($1,$2,'owner','2026-10-08T10:05:00Z'),
       ($1,$3,'editor','2026-10-08T10:06:00Z'),($4,$3,'editor','2026-10-08T10:07:00Z')`,
    [DRILL.team, RESERVED.drill, RESERVED.loud, TEAM],
  );
  await file(DRILL.file, RESERVED.drill, 'Drill 1', 100, '2026-10-08T10:10:00.000Z', {team: DRILL.team});
  await db.execute(
    "INSERT INTO design_comments(id,thread_id,author_id,body,created_at,seq) VALUES($1,$2,$3,'Drill','2026-10-08T11:00:00Z',2)",
    [randomUUID(), thread, RESERVED.loud],
  );
  for (const [userId, created, action] of [
    [RESERVED.drill, '2026-10-08T10:10:00.000Z', 'POST /api/design-files'],
    [RESERVED.drill, '2026-10-09T10:00:00.000Z', 'GET /api/design-files/:id/session'],
    [RESERVED.drill, '2026-10-10T07:00:00.000Z', 'read'],
    [RESERVED.loud, '2026-09-02T10:00:00.000Z', 'read'],
    [RESERVED.loud, '2026-10-08T10:06:00.000Z', 'read'],
  ])
    await db.execute('INSERT INTO admin_activity(id,user_id,action,created_at) VALUES($1,$2,$3,$4)', [
      randomUUID(),
      userId,
      action,
      created,
    ]);
}

const sum = (points: AdminDayPoint[]) => points.reduce((total, point) => total + point.value, 0);
const point = (points: AdminDayPoint[], day: string) => points.find(p => p.day === day)?.value;
const query = (fields: Partial<import('../server/admin/analytics/accounts').AccountsQuery> = {}) => ({
  q: '',
  segment: 'all' as const,
  sort: 'created' as const,
  order: 'desc' as const,
  page: 1,
  ...fields,
});
const ids = (rows: AdminAccountRow[]) => rows.map(row => row.id);

test('the overview: accounts, the journal and its funnel, cohorts and alerts', async () => {
  const o = await admin.overview.adminOverview(fixture.db, '30d', NOW);
  assert.deepEqual(o.window, {
    period: '30d',
    from: '2026-09-10T09:00:00.000Z',
    to: '2026-10-10T09:00:00.000Z',
    previousFrom: '2026-08-11T09:00:00.000Z',
    days: 30,
  });
  assert.equal(o.generatedAt, NOW.toISOString());
  // The erased account is not live now; at `from` it still was.
  assert.deepEqual(o.kpis.accounts, {value: 10, previous: 6});
  assert.deepEqual(o.kpis.newAccounts, {value: 5, previous: 1});
  assert.deepEqual(o.kpis.activeAccounts, {value: 4, previous: 2});

  // Dense series: every Moscow day the window touches (the partial 10 September to today), zeros included.
  for (const series of Object.values(o.series)) {
    assert.equal(series.length, 31);
    assert.equal(series[0].day, '2026-09-10');
    assert.equal(series.at(-1)!.day, '2026-10-10');
  }
  assert.equal(sum(o.series.signups), 5);
  // 21:30 UTC on 9 October is 10 October in Moscow; 09:00 UTC in the plain text shape is 12:00 in Moscow on 5 October.
  assert.equal(point(o.series.active, '2026-10-10'), 2);
  assert.equal(point(o.series.active, '2026-10-09'), 1);
  assert.equal(point(o.series.active, '2026-10-05'), 2);
  assert.equal(sum(o.series.active), 9);

  // Signed up in the window: Anna, Vera, Dina, Zhanna, Glen. Files: Anna, Vera (the team's), Zhanna; back on a later day: Anna, Zhanna.
  assert.deepEqual(o.funnel, [
    {key: 'signed_up', label: 'Signed up', value: 5},
    {key: 'made_file', label: 'Created a file', value: 3},
    {key: 'came_back', label: 'Came back', value: 2},
  ]);
  assert.deepEqual(o.stickiness, {dau: 2, wau: 4, mau: 4});
  // Whole weeks before the one of 5 October; 10 August's had nobody, so the list starts with Boris's week.
  assert.deepEqual(o.cohorts, [
    {week: '2026-08-17', size: 1, active: [0, 0, 1, 0, 0, 0, 0]},
    {week: '2026-08-24', size: 0, active: [0, 0, 0, 0, 0, 0]},
    {week: '2026-08-31', size: 0, active: [0, 0, 0, 0, 0]},
    {week: '2026-09-07', size: 1, active: [0, 0, 0, 0]},
    {week: '2026-09-14', size: 1, active: [1, 0, 0]},
    {week: '2026-09-21', size: 1, active: [0, 0]},
    {week: '2026-09-28', size: 1, active: [1]},
  ]);
  assert.equal(o.heatmap.length, 7);
  assert.ok(o.heatmap.every(row => row.length === 24));
  assert.equal(
    o.heatmap.flat().reduce((a, b) => a + b, 0),
    10,
    'every journal row of the window',
  );
  assert.equal(o.heatmap[5][0], 1, 'Saturday 00:30 in Moscow');
  assert.equal(o.heatmap[5][11], 1, 'Saturday 11:00 in Moscow');
  assert.deepEqual(o.alerts, [{kind: 'closing', tone: 'info', count: 1}]);
  const calm = await admin.overview.adminOverview(fixture.db, '7d', NOW);
  assert.equal(calm.series.signups.length, 8);
  assert.deepEqual(calm.kpis.newAccounts, {value: 1, previous: 1}, 'Glen; Zhanna the week before');
});

test('usage: the product, its adoption and storage', async () => {
  const u = await admin.usage.adminUsage(fixture.db, '30d', NOW);
  assert.deepEqual(u.kpis.filesCreated, {value: 4, previous: 0});
  assert.deepEqual(u.kpis.comments, {value: 1, previous: 0});
  assert.deepEqual(u.kpis.teamsCreated, {value: 1, previous: 0});
  assert.equal(sum(u.product.filesCreated), 4);
  assert.equal(sum(u.product.versions), 1);
  assert.equal(point(u.product.comments, '2026-10-05'), 1);
  // Active in the window: the month payer, Boris, Zhanna, Glen.
  assert.deepEqual(
    u.product.adoption.map(a => [a.key, a.label, a.accounts, a.share]),
    [
      ['comments', 'Comments', 1, 0.25],
      ['teams', 'Teams', 1, 0.25],
      ['sharing', 'Sharing', 2, 0.5],
      ['libraries', 'Libraries', 0, 0],
      ['meetings', 'Meetings', 0, 0],
      ['versions', 'Versions', 1, 0.25],
    ],
  );
  assert.deepEqual(
    u.product.topActions.map(a => [a.key, a.value]),
    [
      ['PATCH /api/design-files/:id', 1],
      ['POST /api/design-comments', 1],
      ['POST /api/design-files', 1],
    ],
  );
  // The disk's, whoever made it: the drill's file is on it.
  assert.deepEqual(u.storage, {files: 5, documentBytes: 2600, pictures: 1, pictureBytes: 2000, versions: 1});
});

test('the accounts list: segments and their counts, search, sorts and the rows', async () => {
  const all = await admin.accounts.adminAccounts(fixture.db, query(), NOW);
  assert.deepEqual(all.counts, {active: 9, closing: 1, all: 10});
  assert.deepEqual([all.total, all.page, all.pageSize], [10, 1, 50]);
  assert.deepEqual(ids(all.rows), [
    ACCOUNTS.gleb,
    ACCOUNTS.zhanna,
    ACCOUNTS.dina,
    ACCOUNTS.anna,
    ACCOUNTS.vera,
    ACCOUNTS.boris,
    ACCOUNTS.grisha,
    ACCOUNTS.egor,
    ACCOUNTS.zoya,
    ACCOUNTS.op,
  ]);
  assert.ok(!ids(all.rows).includes(ACCOUNTS.erased), 'an erased account is never listed');
  const row = (id: string) => all.rows.find(r => r.id === id)!;
  assert.deepEqual(row(ACCOUNTS.anna), {
    id: ACCOUNTS.anna,
    name: 'Анна Ильина',
    email: 'anna@example.test',
    emailVerified: true,
    createdAt: '2026-09-15T10:00:00.000Z',
    lastActiveAt: '2026-10-10T08:00:00.000Z',
    segment: 'active',
    activeDays30d: 5,
    activity30d: row(ACCOUNTS.anna).activity30d,
    files: 1,
    storageBytes: 4000,
    teams: 0,
  });
  const sparkline = row(ACCOUNTS.anna).activity30d;
  assert.equal(sparkline.length, 30);
  assert.equal(
    sparkline.reduce((a, b) => a + b, 0),
    6,
  );
  assert.deepEqual(sparkline.slice(-6), [1, 0, 1, 0, 2, 1], '5 to 10 October');
  assert.deepEqual([row(ACCOUNTS.vera).teams, row(ACCOUNTS.vera).files], [1, 1]);
  assert.equal(row(ACCOUNTS.zoya).segment, 'closing');
  assert.deepEqual(
    [row(ACCOUNTS.zhanna).segment, row(ACCOUNTS.zhanna).emailVerified, row(ACCOUNTS.zhanna).lastActiveAt],
    ['active', false, '2026-10-03T12:00:00.000Z'],
  );
  assert.equal(row(ACCOUNTS.op).lastActiveAt, null);

  // The search: the name, the e-mail or the id, any case, Cyrillic included; % and _ are themselves.
  const search = async (q: string, fields: Parameters<typeof query>[0] = {}) =>
    admin.accounts.adminAccounts(fixture.db, query({q, ...fields}), NOW);
  const anna = await search('анна');
  assert.deepEqual(ids(anna.rows), [ACCOUNTS.zhanna, ACCOUNTS.anna], '"Анна" and "Жанна" (Cyrillic search, any case)');
  assert.deepEqual(anna.counts, {active: 2, closing: 0, all: 2});
  assert.deepEqual(ids((await search('АННА')).rows), ids(anna.rows));
  assert.deepEqual(ids((await search('BORIS@')).rows), [ACCOUNTS.boris]);
  assert.deepEqual(ids((await search('ACC-G', {order: 'asc'})).rows), [ACCOUNTS.grisha, ACCOUNTS.gleb]);
  for (const literal of ['%', '_', '\\'])
    assert.deepEqual([(await search(literal)).total, (await search(literal)).counts.all], [0, 0], literal);
  const annaActive = await search('анна', {segment: 'active'});
  assert.deepEqual([ids(annaActive.rows), annaActive.total], [[ACCOUNTS.zhanna, ACCOUNTS.anna], 2]);
  const annaClosing = await search('анна', {segment: 'closing'});
  assert.deepEqual([ids(annaClosing.rows), annaClosing.total, annaClosing.counts.all], [[], 0, 2]);

  const list = async (fields: Parameters<typeof query>[0]) =>
    ids((await admin.accounts.adminAccounts(fixture.db, query(fields), NOW)).rows);
  assert.deepEqual(await list({segment: 'active', order: 'asc'}), [
    ACCOUNTS.op,
    ACCOUNTS.egor,
    ACCOUNTS.grisha,
    ACCOUNTS.boris,
    ACCOUNTS.vera,
    ACCOUNTS.anna,
    ACCOUNTS.dina,
    ACCOUNTS.zhanna,
    ACCOUNTS.gleb,
  ]);
  assert.deepEqual(await list({segment: 'closing'}), [ACCOUNTS.zoya]);
  // Never active: last in either order, by id in the same direction.
  assert.deepEqual(await list({sort: 'active'}), [
    ACCOUNTS.anna,
    ACCOUNTS.boris,
    ACCOUNTS.gleb,
    ACCOUNTS.zhanna,
    ACCOUNTS.grisha,
    ACCOUNTS.zoya,
    ACCOUNTS.vera,
    ACCOUNTS.op,
    ACCOUNTS.egor,
    ACCOUNTS.dina,
  ]);
  assert.deepEqual(await list({sort: 'active', order: 'asc'}), [
    ACCOUNTS.grisha,
    ACCOUNTS.zhanna,
    ACCOUNTS.gleb,
    ACCOUNTS.boris,
    ACCOUNTS.anna,
    ACCOUNTS.dina,
    ACCOUNTS.egor,
    ACCOUNTS.op,
    ACCOUNTS.vera,
    ACCOUNTS.zoya,
  ]);
  assert.deepEqual((await list({sort: 'storage'})).slice(0, 4), [
    ACCOUNTS.anna,
    ACCOUNTS.vera,
    ACCOUNTS.zhanna,
    ACCOUNTS.zoya, // the rest hold nothing: by id, descending
  ]);
  assert.deepEqual((await list({sort: 'files'})).slice(0, 3), [ACCOUNTS.zhanna, ACCOUNTS.vera, ACCOUNTS.anna]);
  assert.deepEqual(await list({page: 2}), []);
});

test('one account in full; an unknown or erased one is null', async () => {
  const detail = (await admin.account.adminAccount(fixture.db, ACCOUNTS.anna, NOW))!;
  assert.equal(detail.account.id, ACCOUNTS.anna);
  assert.equal(detail.account.deletionRequestedAt, null);
  assert.deepEqual(detail.account.sessions, {active: 1, lastSignInAt: at(-1)});
  assert.deepEqual(detail.files, {
    count: 1,
    trashed: 1,
    storageBytes: 4000,
    versions: 1,
    recent: [{id: F.F1, name: 'Landing page', updatedAt: at(-20), bytes: 1000, nodeCount: 3, team: false}],
  });
  assert.deepEqual(detail.teams, []);
  assert.equal(detail.activity.daily.length, 90);
  assert.equal(sum(detail.activity.daily), 6);
  assert.deepEqual(
    detail.activity.recent.map(r => r.at),
    [
      '2026-10-10T08:00:00.000Z',
      '2026-10-09T09:01:00.000Z',
      '2026-10-09T09:00:00.000Z',
      '2026-10-07T09:00:00.000Z',
      '2026-10-05T09:00:00.000Z',
      '2026-09-16T09:00:00.000Z',
    ],
  );
  assert.deepEqual(detail.activity.topActions, [
    {key: 'POST /api/design-files', label: 'POST /api/design-files', value: 1},
  ]);
  assert.deepEqual(detail.collaboration, {comments: 0, sharedFiles: 1, meetings: 0});

  const vera = (await admin.account.adminAccount(fixture.db, ACCOUNTS.vera, NOW))!;
  assert.deepEqual(vera.teams, [{id: TEAM, name: 'Studio', role: 'owner', members: 2}]);
  assert.equal(vera.files.recent[0].team, true);
  const gleb = (await admin.account.adminAccount(fixture.db, ACCOUNTS.gleb, NOW))!;
  assert.deepEqual(gleb.teams, [{id: TEAM, name: 'Studio', role: 'editor', members: 2}]);
  assert.equal(gleb.collaboration.comments, 1);
  const zoya = (await admin.account.adminAccount(fixture.db, ACCOUNTS.zoya, NOW))!;
  assert.deepEqual([zoya.account.segment, zoya.account.deletionRequestedAt], ['closing', at(-1)]);

  assert.equal(await admin.account.adminAccount(fixture.db, ACCOUNTS.erased, NOW), null);
  assert.equal(await admin.account.adminAccount(fixture.db, 'acc-nobody', NOW), null);
});

test('an account at a reserved .invalid address, in either letter case, is no one: in no count, list or page', async () => {
  const reserved: string[] = Object.values(RESERVED);
  // Their rows are there, so their absence below is the rule's.
  assert.equal(
    (await fixture.db.one<{n: number}>('SELECT count(*)::int AS n FROM admin_activity WHERE user_id=ANY($1::text[])', [
      reserved,
    ]))!.n,
    5,
  );
  // Without the rule: 12 accounts (7 at `from`), 6 new (2 before), 6 active (3 before), DAU 3, WAU 6, a funnel of 6 → 4 → 3.
  const o = await admin.overview.adminOverview(fixture.db, '30d', NOW);
  assert.deepEqual(
    [o.kpis.accounts, o.kpis.newAccounts, o.kpis.activeAccounts, o.stickiness],
    [
      {value: 10, previous: 6},
      {value: 5, previous: 1},
      {value: 4, previous: 2},
      {dau: 2, wau: 4, mau: 4},
    ],
  );
  assert.deepEqual(
    o.funnel.map(step => step.value),
    [5, 3, 2],
  );
  assert.equal(o.cohorts.find(c => c.week === '2026-08-31')!.size, 0, 'the capitals signed up on 1 September');
  assert.equal(
    o.heatmap.flat().reduce((a, b) => a + b, 0),
    10,
  );
  const u = await admin.usage.adminUsage(fixture.db, '30d', NOW);
  assert.deepEqual(
    [u.kpis.teamsCreated, u.kpis.filesCreated, u.kpis.comments],
    [
      {value: 1, previous: 0},
      {value: 4, previous: 0},
      {value: 1, previous: 0},
    ],
  );
  assert.deepEqual([point(u.product.filesCreated, '2026-10-08'), point(u.product.comments, '2026-10-08')], [0, 0]);
  assert.deepEqual(
    u.product.adoption.find(a => a.key === 'teams'),
    {key: 'teams', label: 'Teams', accounts: 1, share: 0.25},
  );
  assert.equal(
    u.product.topActions.some(a => a.key.startsWith('GET ')),
    false,
  );
  // The accounts list, its counts and its search by name, address or id; their page; the members of Vera's team.
  const all = await admin.accounts.adminAccounts(fixture.db, query(), NOW);
  assert.deepEqual([all.total, all.counts.all, ids(all.rows).filter(id => reserved.includes(id))], [10, 10, []]);
  for (const q of ['drill', 'DRILL.INVALID', 'Editor']) {
    const found = await admin.accounts.adminAccounts(fixture.db, query({q}), NOW);
    assert.deepEqual([found.rows, found.total, found.counts.all], [[], 0, 0], q);
  }
  for (const id of reserved) assert.equal(await admin.account.adminAccount(fixture.db, id, NOW), null, id);
  const vera = (await admin.account.adminAccount(fixture.db, ACCOUNTS.vera, NOW))!;
  assert.deepEqual([vera.teams.map(t => t.members), vera.account.teams], [[2], 1], 'Studio: Vera and Glen');
});

test('the accounts list pages by 50 without losing or repeating a row', async () => {
  const owner = migrationDatabase(fixture);
  try {
    for (let i = 0; i < 45; i++)
      await owner.execute(
        "INSERT INTO users(id,email,name,email_verified,created_at) VALUES($1,$2,$3,1,'2026-01-02 10:00:00')",
        [`bulk-${String(i).padStart(2, '0')}`, `bulk-${i}@example.test`, `User ${i}`],
      );
  } finally {
    await owner.close();
  }
  const page = async (n: number) => admin.accounts.adminAccounts(fixture.db, query({page: n}), NOW);
  const [first, second, third] = [await page(1), await page(2), await page(3)];
  assert.deepEqual([first.rows.length, second.rows.length, third.rows.length], [50, 5, 0]);
  assert.deepEqual([first.total, second.total, first.counts.active], [55, 55, 54]);
  const seen = new Set([...ids(first.rows), ...ids(second.rows)]);
  assert.equal(seen.size, 55);
  // Same created_at: the id breaks the tie, the same way on every page.
  assert.deepEqual(ids(first.rows).slice(9, 12), ['bulk-44', 'bulk-43', 'bulk-42']);
  assert.equal(second.rows.at(-1)!.id, ACCOUNTS.op);
});

test('only an operator sees the console: everyone else gets the API’s plain 404, and /api/config names no admin', async () => {
  const {authCookieName, digest} = await import('../server/auth');
  const {forgetAdminReports} = await import('../server/admin/router');
  const owner = migrationDatabase(fixture);
  const tokens: Record<string, string> = {};
  try {
    for (const id of [ACCOUNTS.op, ACCOUNTS.gleb, ACCOUNTS.anna]) {
      tokens[id] = randomBytes(32).toString('hex');
      await owner.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [
        digest(tokens[id]),
        id,
        Date.now() + HOUR,
      ]);
    }
  } finally {
    await owner.close();
  }
  const call = async (path: string, token?: string, init: RequestInit = {}) => {
    const response = await fetch(fixture.base + path, {
      ...init,
      headers: {
        ...(token ? {cookie: `${authCookieName('session')}=${token}`} : {}),
        ...(init.headers as Record<string, string>),
      },
    });
    const text = await response.text();
    return {status: response.status, body: text ? JSON.parse(text) : null};
  };
  const op = tokens[ACCOUNTS.op],
    gleb = tokens[ACCOUNTS.gleb];
  const unknown = {status: 404, body: {error: 'Route not found.'}};
  delete process.env.MORFA_OPERATORS;
  assert.deepEqual(await call('/api/admin/overview', op), unknown, 'unset: nobody');

  process.env.MORFA_OPERATORS = 'someone@example.test, OWNER@localhost';
  forgetAdminReports();
  for (const path of [
    '/api/admin/overview',
    '/api/admin/accounts',
    `/api/admin/accounts/${ACCOUNTS.anna}`,
    '/api/admin/usage',
    '/api/admin/nothing',
  ]) {
    assert.deepEqual(await call(path, gleb), unknown, `${path}: another account`);
    assert.deepEqual(await call(path), unknown, `${path}: signed out`);
  }
  assert.deepEqual(await call('/api/no-such-route', gleb), unknown, 'the same answer as any unknown route');

  // The test environment is not production: an unproven owner@localhost counts.
  const overview = await call('/api/admin/overview', op);
  assert.equal(overview.status, 200);
  assert.equal(overview.body.window.period, '30d');
  assert.equal(overview.body.funnel.length, 3);
  for (const period of ['7d', '90d', '365d'])
    assert.equal((await call(`/api/admin/overview?period=${period}`, op)).body.window.period, period);
  assert.equal((await call('/api/admin/usage?period=365d', op)).status, 200);
  const accounts = await call('/api/admin/accounts?q=%D0%B0%D0%BD%D0%BD%D0%B0&sort=storage&order=asc&page=1', op);
  assert.equal(accounts.status, 200);
  assert.deepEqual(
    accounts.body.rows.map((row: AdminAccountRow) => row.id),
    [ACCOUNTS.zhanna, ACCOUNTS.anna],
  );
  const one = await call(`/api/admin/accounts/${ACCOUNTS.anna}`, op);
  assert.deepEqual([one.status, one.body.account.id], [200, ACCOUNTS.anna]);
  for (const id of [ACCOUNTS.erased, ...Object.values(RESERVED)])
    assert.deepEqual(
      await call(`/api/admin/accounts/${id}`, op),
      {status: 404, body: {error: 'Account not found.', code: 'not_found'}},
      id,
    );
  for (const path of [
    '/api/admin/overview?period=1d',
    '/api/admin/usage?period=',
    '/api/admin/accounts?page=0',
    '/api/admin/accounts?sort=name',
    '/api/admin/accounts?segment=vip',
    '/api/admin/accounts?segment=paying',
    '/api/admin/accounts?sort=paid',
    '/api/admin/accounts?order=up',
  ]) {
    const answer = await call(path, op);
    assert.deepEqual([answer.status, answer.body.code], [400, 'invalid_request'], path);
  }
  assert.deepEqual(await call('/api/admin/overview', op, {method: 'POST'}), unknown, 'GET only');
  // The support chat's side of the console (server/support) answers its own paths behind the same gate.
  assert.deepEqual(await call('/api/admin/support/unread', op), {status: 200, body: {waiting: 0}});
  assert.deepEqual(await call('/api/admin/support/unread', gleb), unknown);
  const changed = await call('/api/admin/overview', op, {headers: {'x-forma-account': ACCOUNTS.gleb}});
  assert.deepEqual([changed.status, changed.body.code], [409, 'account_changed']);
  // The operator's reading is nobody's activity (and a refused request is never anyone's).
  await fixture.drain();
  assert.equal(
    (await fixture.db.one<{n: number}>('SELECT count(*)::int AS n FROM admin_activity WHERE user_id=$1', [
      ACCOUNTS.op,
    ]))!.n,
    0,
  );

  assert.equal((await call('/api/config', op)).body.admin, true);
  assert.equal('admin' in (await call('/api/config', gleb)).body, false);
  assert.equal('admin' in (await call('/api/config')).body, false);
  // By id too; an address someone else proved names nobody else.
  process.env.MORFA_OPERATORS = ACCOUNTS.gleb;
  assert.equal((await call('/api/admin/accounts', gleb)).status, 200);
  assert.deepEqual(await call('/api/admin/accounts', op), unknown);
  process.env.MORFA_OPERATORS = 'anna@example.test';
  assert.equal((await call('/api/admin/usage', tokens[ACCOUNTS.anna])).status, 200, 'a proven address');
  assert.equal((await call('/api/config', tokens[ACCOUNTS.anna])).body.admin, true);
  delete process.env.MORFA_OPERATORS;
  assert.equal('admin' in (await call('/api/config', tokens[ACCOUNTS.anna])).body, false, 'unset: nobody');
  await fixture.drain();
});
