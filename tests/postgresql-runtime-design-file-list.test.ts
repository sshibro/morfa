import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {DESIGN_LIMITS} from '../shared/design/limits';

// Lane A7 (TARGETS A1): the file browser's list is written by PostgreSQL (server/design/files.ts `listDesignFiles`). Its text must be
// byte for byte what the Node path wrote before: JSON.stringify of `summary(row)` over the rows the pools' parsers read, the unread
// counts of `unreadDesignComments`, the usage and the limits. Names with every character class JSON escapes, timestamps with every
// count of fraction digits, thumbnails, boards, projects, the trash and unread comments are compared here.

test('the file list written by PostgreSQL equals the Node summaries byte for byte', {timeout: 300000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const auth = await import('../server/auth');
  const files = await import('../server/design/files');
  const {unreadDesignComments} = await import('../server/design/comments');
  const {designStorageUsed, teamStorageUsed} = await import('../server/design/images');

  async function account(label: string) {
    const id = `list:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, actor: Object.freeze({ownerId: id, sessionHash: auth.digest(token)})};
  }
  const owner = await account('owner'),
    member = await account('member');
  const teamId = randomUUID(),
    projectId = randomUUID();
  await db.execute("INSERT INTO design_teams(id,name,owner_id) VALUES($1,'Team',$2)", [teamId, owner.id]);
  await db.execute("INSERT INTO design_team_members(team_id,user_id,role,joined_at) VALUES($1,$2,'owner','2025-01-01 00:00:00+00')", [teamId, owner.id]);
  // The member joined in the middle: comments before it count as read.
  await db.execute("INSERT INTO design_team_members(team_id,user_id,role,joined_at) VALUES($1,$2,'editor','2026-03-01 12:00:00.5+00')", [teamId, member.id]);
  await db.execute("INSERT INTO design_projects(id,team_id,name) VALUES($1,$2,'Project')", [projectId, teamId]);

  const names = [
    'Untitled',
    'quote " backslash \\ slash / <script>',
    'controls \u0001\u0008\u0009\n\u000b\u000c\r\u001f\u007f',
    'line sep   para   nbsp ',
    'emoji 😀 é 中文 ёЁ',
    "apostrophe ' and `tick`",
  ];
  const fractions = ['', '.1', '.12', '.123', '.1234', '.12345', '.123456', '.000001', '.100000', '.999999', '.01'];
  const made: string[] = [];
  let k = 0;
  for (const scope of ['personal', 'team'] as const)
    for (const name of names)
      for (const kind of ['design', 'board'])
        for (const trashed of [false, true]) {
          const id = randomUUID(),
            fraction = fractions[k % fractions.length],
            day = String(1 + (k % 28)).padStart(2, '0');
          k++;
          await db.execute(
            `INSERT INTO design_files(id,user_id,team_id,project_id,name,document,bytes,node_count,thumbnail_filename,kind,created_at,updated_at,trashed_at)
             VALUES($1,$2,$3,$4,$5,'{}',2,0,$6,$7,$8,$9,$10)`,
            [
              id,
              owner.id,
              scope === 'team' ? teamId : null,
              scope === 'team' && k % 3 === 0 ? projectId : null,
              name,
              k % 2 ? `thumb_${k}.webp` : null,
              kind,
              `2026-02-${day} 10:11:12${fraction}+00`,
              // Equal updated_at on some rows: the id breaks the tie.
              `2026-04-${String(1 + (k % 5)).padStart(2, '0')} 08:00:00${fractions[(k * 7) % fractions.length]}+00`,
              trashed ? `2026-05-01 00:00:00${fraction}+00` : null,
            ],
          );
          made.push(id);
        }
  // Pictures for the storage sums.
  await db.execute("INSERT INTO design_images(filename,user_id,kind,bytes,width,height) VALUES('p1.webp',$1,'image',1234,10,10)", [owner.id]);
  await db.execute("INSERT INTO design_images(filename,user_id,team_id,kind,bytes,width,height) VALUES('p2.webp',$1,$2,'thumbnail',4321,10,10)", [owner.id, teamId]);
  // Comment threads on the team's files: open, resolved, deleted; before and after the member joined; some read.
  const teamFiles = (await db.many<{id: string}>('SELECT id FROM design_files WHERE team_id=$1 ORDER BY id', [teamId])).map(row => row.id);
  let seq = 0;
  for (const [i, fileId] of teamFiles.entries()) {
    if (i % 2) continue;
    for (const state of ['open', 'resolved', 'deleted', 'open-read'] as const) {
      const threadId = randomUUID();
      seq++;
      await db.execute(
        `INSERT INTO design_comment_threads(id,file_id,page_id,x,y,author_id,resolved_at,resolved_by,deleted_at,seq) VALUES($1,$2,'page',1,2,$3,$4,$5,$6,$7)`,
        [threadId, fileId, state === 'deleted' ? null : owner.id, state === 'resolved' ? '2026-06-01 00:00:00+00' : null, state === 'resolved' ? owner.id : null, state === 'deleted' ? '2026-06-01 00:00:00+00' : null, seq],
      );
      for (const [j, at] of ['2026-02-01 00:00:00+00', '2026-03-01 12:00:00.4+00', '2026-03-01 12:00:00.6+00', '2026-07-01 00:00:00.123456+00'].entries())
        await db.execute('INSERT INTO design_comments(id,thread_id,author_id,body,created_at,seq) VALUES($1,$2,$3,$4,$5,$6)', [
          randomUUID(),
          threadId,
          j === 3 ? member.id : owner.id,
          'text',
          at,
          j + 1,
        ]);
      if (state === 'open-read') {
        await db.execute('INSERT INTO design_comment_reads(thread_id,user_id,read_seq) VALUES($1,$2,2),($1,$3,3)', [threadId, owner.id, member.id]);
      }
    }
  }

  /** The list as the Node code wrote it before lane A7. */
  async function oracle(who: {id: string}, trash: boolean, where: {teamId?: string; projectId?: string}) {
    const team = where.teamId !== undefined;
    const filter = team ? 'team_id=$1' : 'user_id=$1 AND team_id IS NULL';
    const rows = await db.many<any>(
      `SELECT id,name,version,created_at,updated_at,thumbnail_filename,trashed_at,team_id,project_id,kind FROM design_files WHERE ${filter} AND (trashed_at IS NOT NULL)=$2
         AND ($3::text IS NULL OR project_id=$3) ORDER BY updated_at DESC,id`,
      [team ? where.teamId : who.id, trash, where.projectId ?? null],
    );
    const active =
      !trash && where.projectId === undefined
        ? rows.length
        : (await db.one<{n: number}>(`SELECT count(*) AS n FROM design_files WHERE ${filter} AND trashed_at IS NULL`, [team ? where.teamId : who.id]))!.n;
    const joined = team ? ((await db.one<{joined_at: string}>('SELECT joined_at FROM design_team_members WHERE team_id=$1 AND user_id=$2', [where.teamId, who.id]))?.joined_at ?? null) : null;
    const unread = trash ? new Map<string, number>() : await unreadDesignComments(db, who.id, rows.map(row => row.id), joined);
    return JSON.stringify({
      files: rows.map(row => (unread.get(row.id) ? {...files.summary(row), unreadComments: unread.get(row.id)} : files.summary(row))),
      usage: {files: active, storageBytes: team ? await teamStorageUsed(db, where.teamId!) : await designStorageUsed(db, who.id)},
      limits: DESIGN_LIMITS,
    });
  }

  let compared = 0;
  for (const who of [owner, member])
    for (const trash of [false, true])
      for (const where of [{}, {teamId}, {teamId, projectId}] as {teamId?: string; projectId?: string}[]) {
        if (who === member && where.teamId === undefined) continue;
        const text = await files.listDesignFiles(who.actor, trash, where);
        const expected = await oracle(who, trash, where);
        assert.equal(text, expected, `${who === owner ? 'owner' : 'member'} trash=${trash} ${JSON.stringify(where)}`);
        compared += (JSON.parse(text).files as unknown[]).length;
      }
  // Every file was listed somewhere, unread counts appeared, and an empty list is `[]`.
  assert.ok(compared >= made.length, `${compared} summaries compared`);
  assert.match(await files.listDesignFiles(owner.actor, false, {teamId}), /"unreadComments":\d+/);
  const lonely = await account('lonely');
  assert.equal(await files.listDesignFiles(lonely.actor, false), await oracle(lonely, false, {}));
  assert.match(await files.listDesignFiles(lonely.actor, false), /^\{"files":\[\],/);

  // The refusals of designRead + requireTeamRole + teamProject, in that order.
  const refusal = (promise: Promise<unknown>, status: number, message?: RegExp) =>
    assert.rejects(promise, (error: any) => error.status === status && (!message || message.test(error.message)));
  await refusal(files.listDesignFiles(lonely.actor, false, {teamId}), 404, /Team/);
  await refusal(files.listDesignFiles(lonely.actor, false, {teamId: 'not-a-team'}), 404, /Team/);
  await refusal(files.listDesignFiles(lonely.actor, false, {teamId, projectId}), 404, /Team/);
  await refusal(files.listDesignFiles(member.actor, false, {teamId, projectId: randomUUID()}), 404, /Project/);
  await refusal(files.listDesignFiles(member.actor, false, {teamId, projectId: 'bad id'}), 404, /Project/);
  const otherTeam = randomUUID(),
    otherProject = randomUUID();
  await db.execute("INSERT INTO design_teams(id,name,owner_id) VALUES($1,'Foreign',$2)", [otherTeam, lonely.id]);
  await db.execute("INSERT INTO design_projects(id,team_id,name) VALUES($1,$2,'Foreign')", [otherProject, otherTeam]);
  await refusal(files.listDesignFiles(member.actor, false, {teamId, projectId: otherProject}), 404, /Project/);
  await db.execute('UPDATE design_projects SET deleted_at=clock_timestamp() WHERE id=$1', [projectId]);
  await refusal(files.listDesignFiles(member.actor, false, {teamId, projectId}), 404, /Project/);
  await db.execute('UPDATE design_teams SET deleted_at=clock_timestamp() WHERE id=$1', [teamId]);
  await refusal(files.listDesignFiles(owner.actor, false, {teamId}), 404, /Team/);
  // A session that expired, ended or belongs to another account; an account being erased.
  await refusal(files.listDesignFiles({ownerId: owner.id, sessionHash: lonely.actor.sessionHash}, false), 401);
  await db.execute('UPDATE sessions SET expires=$1 WHERE user_id=$2', [Date.now() - 1, member.id]);
  await refusal(files.listDesignFiles(member.actor, false), 401);
  await db.execute('UPDATE users SET deletion_requested_at=clock_timestamp() WHERE id=$1', [lonely.id]);
  await refusal(files.listDesignFiles(lonely.actor, false), 401);
});
