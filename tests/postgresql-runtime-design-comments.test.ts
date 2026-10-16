import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Server} from 'node:http';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {DESIGN_COMMENT_LIMITS} from '../shared/design/comments';

// "Morfa Design" comments (docs/design-tool.md §Teams "Comments") against the real PostgreSQL schema, through the whole app: every route
// under each role (owner, admin, editor, developer, viewer) and for a stranger, a personal file, the since-cursor, unread state, mentions,
// resolving, deleting, limits, the trash, the file browser's badge, erasure and the export.

type Account = {id: string; token: string};
type Answer = {status: number; data: any};
type Init = RequestInit & {json?: unknown};

const ROLES = ['owner', 'admin', 'editor', 'developer', 'viewer'] as const;
type Role = (typeof ROLES)[number];

test('"Morfa Design" comments: roles on every route, cursor, unread, mentions, resolve, delete, limits, trash, erasure and export', {timeout: 900000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const values: NodeJS.ProcessEnv = {
    ENABLE_DESIGN_TOOL: '1',
    ERASURE_LEDGER_PATH: path.join(f.dataDir, 'ledger', 'erasure.jsonl'),
    BACKUP_ENCRYPTION_KEY: 'ab'.repeat(32),
  };
  const saved = Object.fromEntries(['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN', ...Object.keys(values)].map(key => [key, process.env[key]]));
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const lifecycle = await import('../server/launch/lifecycle');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
  });

  async function account(label: string, name = 'Designer ' + label): Promise<Account> {
    const id = `comments:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute('INSERT INTO users(id,email,name,password) VALUES($1,$2,$3,$4)', [id, `${label}-${randomUUID()}@example.invalid`, name, '']);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token};
  }
  const cookie = (who: Account) => auth.authCookieName('session') + '=' + who.token;
  async function fetchAs(who: Account | null, url: string, init: Init = {}): Promise<Answer> {
    const {json, ...rest} = init;
    const headers: Record<string, string> = {...(who ? {cookie: cookie(who)} : {}), ...(json !== undefined ? {'content-type': 'application/json'} : {}), ...(rest.headers as Record<string, string>)};
    const response = await fetch(base + url, {...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const type = response.headers.get('content-type');
    const raw = Buffer.from(await response.arrayBuffer());
    return {status: response.status, data: type?.includes('json') ? JSON.parse(raw.toString('utf8')) : raw};
  }
  const files = (who: Account | null, suffix: string, init: Init = {}) => fetchAs(who, '/api/design-files' + suffix, init);
  const teams = (who: Account | null, suffix: string, init: Init = {}) => fetchAs(who, '/api/design-teams' + suffix, init);
  const ok = (answer: Answer, status = 200) => {
    assert.equal(answer.status, status, JSON.stringify(answer.data));
    return answer.data;
  };
  const refused = (answer: Answer, status: number, code?: string) => {
    assert.equal(answer.status, status, JSON.stringify(answer.data));
    if (code) assert.equal(answer.data.code, code);
  };

  // ── The cast: a team with one member of each role (made directly: seats are the teams test's subject), a stranger ──
  const people = {} as Record<Role, Account>;
  for (const role of ROLES) people[role] = await account(role);
  const outsider = await account('outsider');
  const teamId = ok(await teams(people.owner, '', {method: 'POST', json: {name: 'North Studio'}}), 201).team.id as string;
  for (const role of ROLES.slice(1))
    await db.execute("INSERT INTO design_team_members(team_id,user_id,role,joined_at) VALUES($1,$2,$3,clock_timestamp()-interval '1 day')", [teamId, people[role].id, role]);
  await db.execute("UPDATE design_team_members SET joined_at=clock_timestamp()-interval '1 day' WHERE team_id=$1", [teamId]);
  const fileId = ok(await files(people.owner, '', {method: 'POST', json: {teamId}}), 201).file.id as string;
  const personalId = ok(await files(people.owner, '', {method: 'POST', json: {}}), 201).file.id as string;
  const opened = ok(await files(people.owner, '/' + fileId));
  const pageId = opened.document.pages[0] as string;

  const comments = (who: Account | null, suffix = '', init: Init = {}, file = fileId) => files(who, `/${file}/comments${suffix}`, init);
  const anchor = (x = 40, y = 60) => ({pageId, x, y, nodeId: null, offset: null});
  const create = (who: Account, text: string, extra: Record<string, unknown> = {}, file = fileId) =>
    comments(who, '', {method: 'POST', json: {anchor: anchor(), text, mentions: [], ...extra}}, file);
  const reply = (who: Account, thread: string, text: string, mentions: unknown[] = []) =>
    comments(who, `/${thread}/replies`, {method: 'POST', json: {text, mentions}});

  await t.test('reading: every member lists the threads with their rights; a stranger, a signed-out visitor and a personal file of someone else get nothing', async () => {
    const expected: Record<Role, {resolveAny: boolean; deleteAny: boolean; mention: boolean}> = {
      owner: {resolveAny: true, deleteAny: true, mention: true},
      admin: {resolveAny: true, deleteAny: true, mention: true},
      editor: {resolveAny: true, deleteAny: false, mention: true},
      developer: {resolveAny: false, deleteAny: false, mention: true},
      viewer: {resolveAny: false, deleteAny: false, mention: true},
    };
    for (const role of ROLES) {
      const list = ok(await comments(people[role]));
      assert.deepEqual([list.threads, list.cursor, list.rights, list.you.id], [[], 0, expected[role], people[role].id], role);
    }
    refused(await comments(outsider), 404, 'not_found');
    refused(await comments(null), 401);
    refused(await comments(people.admin, '', {}, personalId), 404);
    assert.deepEqual(ok(await comments(people.owner, '', {}, personalId)).rights, {resolveAny: true, deleteAny: true, mention: false});
    refused(await comments(people.owner, '', {}, 'not-a-file'), 404);
    refused(await comments(people.owner, '?since=-1'), 400, 'invalid_request');
  });

  const threads = {} as Record<Role, string>;
  await t.test('commenting: every role pins a thread (viewers too), a stranger cannot; bad anchors, text and mentions are refused', async () => {
    for (const role of ROLES) {
      const thread = ok(await create(people[role], `Note from ${role}`), 201).thread;
      threads[role] = thread.id;
      assert.equal(thread.author.id, people[role].id);
      assert.equal(thread.author.name, 'Designer ' + role);
      assert.deepEqual(thread.anchor, anchor());
      assert.deepEqual([thread.comments.length, thread.comments[0].text, thread.unread, thread.resolvedAt], [1, `Note from ${role}`, 0, null]);
    }
    refused(await create(outsider, 'Foreign'), 404);
    // A pin on a layer keeps its offset; one on the canvas has none.
    const onLayer = ok(await comments(people.viewer, '', {method: 'POST', json: {anchor: {pageId, x: 10, y: 20, nodeId: '12:34', offset: {x: 3.5, y: -2}}, text: 'On a layer', mentions: []}}), 201).thread;
    assert.deepEqual(onLayer.anchor, {pageId, x: 10, y: 20, nodeId: '12:34', offset: {x: 3.5, y: -2}});
    ok(await comments(people.viewer, `/${onLayer.id}`, {method: 'DELETE'}));
    for (const [why, body] of [
      ['no anchor', {text: 'x', mentions: []}],
      ['a layer without its offset', {anchor: {...anchor(), nodeId: '1:2'}, text: 'x', mentions: []}],
      ['an offset without a layer', {anchor: {...anchor(), offset: {x: 1, y: 1}}, text: 'x', mentions: []}],
      ['a page id with markup', {anchor: {...anchor(), pageId: '<img>'}, text: 'x', mentions: []}],
      ['too far away', {anchor: {...anchor(), x: 2e9}, text: 'x', mentions: []}],
      ['empty text', {anchor: anchor(), text: '   ', mentions: []}],
      ['spaces around the text', {anchor: anchor(), text: ' x ', mentions: []}],
      ['a control character', {anchor: anchor(), text: 'a\u0007b', mentions: []}],
      ['a lone surrogate', {anchor: anchor(), text: 'a\ud800b', mentions: []}],
      // Cyrillic on purpose: the limit counts characters, not bytes.
      ['too long', {anchor: anchor(), text: 'я'.repeat(DESIGN_COMMENT_LIMITS.textLength + 1), mentions: []}],
      ['a mention outside the text', {anchor: anchor(), text: '@Ann', mentions: [{userId: people.editor.id, at: 2, length: 4}]}],
      ['a mention that is no "@"', {anchor: anchor(), text: 'Ann', mentions: [{userId: people.editor.id, at: 0, length: 3}]}],
      ['an unknown field', {anchor: anchor(), text: 'x', mentions: [], html: '<b>x</b>'}],
    ] as const)
      refused(await comments(people.editor, '', {method: 'POST', json: body}), 400, 'invalid_request');
    // Markup is kept as the plain text it is, never interpreted.
    const plain = ok(await create(people.editor, '<script>alert(1)</script> & "quotes"'), 201).thread;
    assert.equal(plain.comments[0].text, '<script>alert(1)</script> & "quotes"');
    ok(await comments(people.editor, `/${plain.id}`, {method: 'DELETE'}));
    // Cyrillic on purpose: the limit counts characters, not bytes.
    const longest = ok(await create(people.editor, 'я'.repeat(DESIGN_COMMENT_LIMITS.textLength)), 201).thread;
    ok(await comments(people.editor, `/${longest.id}`, {method: 'DELETE'}));
  });

  await t.test('mentions: members of the file\'s team only, validated by the server; none in a personal file', async () => {
    const text = 'Look here, @Developer';
    const mention = {userId: people.developer.id, at: 11, length: 10};
    const thread = ok(await reply(people.editor, threads.viewer, text, [mention]), 201).thread;
    assert.deepEqual(thread.comments.at(-1).mentions, [mention]);
    refused(await reply(people.editor, threads.viewer, 'Hello, @Other', [{userId: outsider.id, at: 7, length: 6}]), 400, 'invalid_request');
    refused(await reply(people.editor, threads.viewer, 'Hello, @Nobody', [{userId: 'comments:nobody', at: 7, length: 7}]), 400, 'invalid_request');
    const many = Array.from({length: DESIGN_COMMENT_LIMITS.mentions + 1}, (_, i) => ({userId: people.developer.id, at: i * 3, length: 2}));
    refused(await reply(people.editor, threads.viewer, '@a '.repeat(DESIGN_COMMENT_LIMITS.mentions + 1).trim(), many), 400, 'invalid_request');
    refused(await create(people.owner, '@Self', {mentions: [{userId: people.owner.id, at: 0, length: 5}]}, personalId), 400, 'invalid_request');
    ok(await create(people.owner, 'Note to self', {}, personalId), 201);
  });

  let cursor = 0;
  await t.test('the since-cursor: a reader gets every change after it, in order, and a cursor from the future starts over', async () => {
    const all = ok(await comments(people.viewer));
    assert.equal(all.threads.length, ROLES.length);
    assert.ok(all.threads.every((thread: {deleted?: boolean}) => !thread.deleted));
    cursor = all.cursor;
    assert.deepEqual(ok(await comments(people.viewer, `?since=${cursor}`)).threads, []);
    ok(await reply(people.developer, threads.editor, 'Agreed'), 201);
    const changes = ok(await comments(people.viewer, `?since=${cursor}`));
    assert.deepEqual(changes.threads.map((thread: {id: string}) => thread.id), [threads.editor]);
    assert.ok(changes.cursor > cursor);
    assert.deepEqual(changes.threads[0].comments.map((comment: {text: string}) => comment.text), ['Note from editor', 'Agreed']);
    assert.equal(ok(await comments(people.viewer, `?since=${changes.cursor + 1000}`)).threads.length, ROLES.length, 'a future cursor lists everything');
    cursor = changes.cursor;
  });

  await t.test('unread: others\' comments after what the reader read and after it joined; marking read; the browser\'s badge', async () => {
    const viewerList = ok(await comments(people.viewer));
    const editorThread = viewerList.threads.find((thread: {id: string}) => thread.id === threads.editor);
    assert.equal(editorThread.unread, 2, 'the editor\'s comment and the developer\'s reply');
    assert.equal(viewerList.threads.find((thread: {id: string}) => thread.id === threads.viewer).unread, 1, 'the editor\'s reply in the viewer\'s own thread');
    // The browser's card shows the count for the team's file.
    const listed = ok(await files(people.viewer, `?team=${teamId}`)).files.find((file: {id: string}) => file.id === fileId);
    assert.equal(listed.unreadComments, 6, 'every unread comment of others in open threads');
    ok(await comments(people.viewer, '/read', {method: 'POST', json: {threads: [threads.editor, threads.viewer]}}));
    const after = ok(await comments(people.viewer));
    assert.deepEqual(after.threads.filter((thread: {unread: number}) => thread.unread).map((thread: {id: string}) => thread.id).sort(), [threads.owner, threads.admin, threads.developer].sort());
    refused(await comments(people.viewer, '/read', {method: 'POST', json: {threads: ['x']}}), 400);
    refused(await comments(outsider, '/read', {method: 'POST', json: {threads: [threads.editor]}}), 404);
    // A member who joins later does not inherit the backlog.
    const late = await account('late');
    await db.execute("INSERT INTO design_team_members(team_id,user_id,role) VALUES($1,$2,'viewer')", [teamId, late.id]);
    assert.ok(ok(await comments(late)).threads.every((thread: {unread: number}) => thread.unread === 0));
    assert.equal(ok(await files(late, `?team=${teamId}`)).files.find((file: {id: string}) => file.id === fileId).unreadComments, undefined);
    await db.execute('DELETE FROM design_team_members WHERE user_id=$1', [late.id]);
  });

  await t.test('editing: only the author\'s own words, even for the owner; a reply to a missing thread is 404', async () => {
    const thread = ok(await comments(people.developer)).threads.find((each: {id: string}) => each.id === threads.developer);
    const first = thread.comments[0].id;
    const edited = ok(await comments(people.developer, `/${threads.developer}/messages/${first}`, {method: 'PATCH', json: {text: 'Fixed', mentions: []}})).thread;
    assert.equal(edited.comments[0].text, 'Fixed');
    assert.ok(edited.comments[0].editedAt);
    for (const role of ['owner', 'admin', 'editor', 'viewer'] as const)
      refused(await comments(people[role], `/${threads.developer}/messages/${first}`, {method: 'PATCH', json: {text: 'Foreign edit', mentions: []}}), 403, 'design_forbidden');
    refused(await comments(outsider, `/${threads.developer}/messages/${first}`, {method: 'PATCH', json: {text: 'x', mentions: []}}), 404);
    refused(await comments(people.developer, `/${threads.developer}/messages/${randomUUID()}`, {method: 'PATCH', json: {text: 'x', mentions: []}}), 404);
    refused(await reply(people.developer, randomUUID(), 'x'), 404);
    refused(await reply(people.developer, 'not-a-thread', 'x'), 404);
  });

  await t.test('resolving: the thread\'s author or an editor; reopening; a reply keeps it resolved', async () => {
    const resolve = (who: Account, thread: string, resolved = true) => comments(who, `/${thread}`, {method: 'PATCH', json: {resolved}});
    // A viewer and a developer resolve their own threads, not others'.
    const own = ok(await resolve(people.viewer, threads.viewer)).thread;
    assert.deepEqual([!!own.resolvedAt, own.resolvedBy], [true, {id: people.viewer.id, name: 'Designer viewer'}]);
    refused(await resolve(people.viewer, threads.editor), 403, 'design_forbidden');
    refused(await resolve(people.developer, threads.editor), 403, 'design_forbidden');
    refused(await resolve(outsider, threads.editor), 404);
    // Editors, admins and the owner resolve any.
    for (const role of ['editor', 'admin', 'owner'] as const) {
      assert.ok(ok(await resolve(people[role], threads.developer)).thread.resolvedAt, role);
      assert.equal(ok(await resolve(people[role], threads.developer, false)).thread.resolvedAt, null, role);
    }
    ok(await reply(people.developer, threads.viewer, 'One more'), 201);
    assert.ok(ok(await comments(people.viewer)).threads.find((thread: {id: string}) => thread.id === threads.viewer).resolvedAt, 'a reply keeps it resolved');
    const changes = ok(await comments(people.owner, `?since=${cursor}`));
    assert.ok(changes.threads.some((thread: {id: string}) => thread.id === threads.viewer), 'resolving is a change after the cursor');
    cursor = changes.cursor;
  });

  await t.test('deleting: own comments, any for the owner and admins; the first one takes the thread, which leaves a tombstone after the cursor', async () => {
    const thread = ok(await reply(people.developer, threads.admin, 'Developer reply'), 201).thread;
    const developerReply = thread.comments.at(-1).id;
    refused(await comments(people.editor, `/${threads.admin}/messages/${developerReply}`, {method: 'DELETE'}), 403, 'design_forbidden');
    refused(await comments(people.viewer, `/${threads.admin}/messages/${developerReply}`, {method: 'DELETE'}), 403, 'design_forbidden');
    const afterAdmin = ok(await comments(people.admin, `/${threads.admin}/messages/${developerReply}`, {method: 'DELETE'})).thread;
    assert.equal(afterAdmin.comments.length, 1, 'an admin removes anyone\'s reply');
    const own = ok(await reply(people.viewer, threads.admin, 'Mine'), 201).thread.comments.at(-1).id;
    assert.equal(ok(await comments(people.viewer, `/${threads.admin}/messages/${own}`, {method: 'DELETE'})).thread.comments.length, 1);
    // A whole thread: its author or a manager.
    refused(await comments(people.editor, `/${threads.developer}`, {method: 'DELETE'}), 403, 'design_forbidden');
    refused(await comments(people.viewer, `/${threads.developer}`, {method: 'DELETE'}), 403, 'design_forbidden');
    const gone = ok(await comments(people.developer, `/${threads.developer}`, {method: 'DELETE'})).thread;
    assert.deepEqual([gone.id, gone.deleted, gone.seq > cursor, Object.keys(gone).sort()], [threads.developer, true, true, ['deleted', 'id', 'seq']]);
    const first = ok(await comments(people.owner)).threads.find((each: {id: string}) => each.id === threads.editor).comments[0].id;
    assert.deepEqual(ok(await comments(people.owner, `/${threads.editor}/messages/${first}`, {method: 'DELETE'})).thread.deleted, true, 'the first comment takes the thread');
    const changes = ok(await comments(people.viewer, `?since=${cursor}`));
    assert.deepEqual(changes.threads.filter((each: {deleted?: boolean}) => each.deleted).map((each: {id: string}) => each.id).sort(), [threads.developer, threads.editor].sort());
    assert.ok(!ok(await comments(people.viewer)).threads.some((each: {id: string}) => each.id === threads.developer), 'a full list has no tombstones');
    refused(await reply(people.viewer, threads.developer, 'x'), 404);
    const stored = await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_comments WHERE thread_id=ANY($1::text[])', [[threads.developer, threads.editor]]);
    assert.equal(stored!.n, 0, 'a tombstone keeps no words');
    cursor = changes.cursor;
  });

  await t.test('every route × every role: list, create, reply, read, resolve, edit and delete others\' words, delete others\' threads', async () => {
    type Who = Role | 'outsider';
    const all: Who[] = [...ROLES, 'outsider'];
    const as = (who: Who) => (who === 'outsider' ? outsider : people[who]);
    // Someone else's thread and reply for each caller to try: the owner's own items are tried by the admin and vice versa.
    const target = async (who: Who) => {
      const author = who === 'owner' ? people.admin : people.owner;
      const thread = ok(await create(author, 'Foreign discussion for ' + who), 201).thread;
      const replied = ok(await reply(author, thread.id, 'Foreign reply'), 201).thread;
      return {thread: thread.id as string, first: thread.comments[0].id as string, reply: replied.comments.at(-1).id as string};
    };
    const expected: Record<Who, {resolve: number; deleteReply: number; deleteThread: number}> = {
      owner: {resolve: 200, deleteReply: 200, deleteThread: 200},
      admin: {resolve: 200, deleteReply: 200, deleteThread: 200},
      editor: {resolve: 200, deleteReply: 403, deleteThread: 403},
      developer: {resolve: 403, deleteReply: 403, deleteThread: 403},
      viewer: {resolve: 403, deleteReply: 403, deleteThread: 403},
      outsider: {resolve: 404, deleteReply: 404, deleteThread: 404},
    };
    for (const who of all) {
      const caller = as(who),
        member = who !== 'outsider';
      const items = await target(who);
      assert.equal((await comments(caller)).status, member ? 200 : 404, `${who} lists`);
      const own = await create(caller, 'Own from ' + who);
      assert.equal(own.status, member ? 201 : 404, `${who} creates`);
      assert.equal((await reply(caller, items.thread, 'Reply from ' + who)).status, member ? 201 : 404, `${who} replies`);
      assert.equal((await comments(caller, '/read', {method: 'POST', json: {threads: [items.thread]}})).status, member ? 200 : 404, `${who} marks read`);
      assert.equal((await comments(caller, `/${items.thread}`, {method: 'PATCH', json: {resolved: true}})).status, expected[who].resolve, `${who} resolves another's thread`);
      assert.equal(
        (await comments(caller, `/${items.thread}/messages/${items.first}`, {method: 'PATCH', json: {text: 'Edit', mentions: []}})).status,
        member ? 403 : 404,
        `${who} edits another's words`,
      );
      assert.equal((await comments(caller, `/${items.thread}/messages/${items.reply}`, {method: 'DELETE'})).status, expected[who].deleteReply, `${who} deletes another's reply`);
      assert.equal((await comments(caller, `/${items.thread}`, {method: 'DELETE'})).status, expected[who].deleteThread, `${who} deletes another's thread`);
      if (member) {
        // Everyone edits, resolves and deletes their own.
        const mine = own.data.thread;
        assert.equal((await comments(caller, `/${mine.id}/messages/${mine.comments[0].id}`, {method: 'PATCH', json: {text: 'Fixed it', mentions: []}})).status, 200, `${who} edits own`);
        assert.equal((await comments(caller, `/${mine.id}`, {method: 'PATCH', json: {resolved: true}})).status, 200, `${who} resolves own`);
        assert.equal((await comments(caller, `/${mine.id}`, {method: 'DELETE'})).status, 200, `${who} deletes own`);
      }
      if (expected[who].deleteThread !== 200) ok(await comments(who === 'owner' ? people.admin : people.owner, `/${items.thread}`, {method: 'DELETE'}));
    }
    cursor = ok(await comments(people.owner)).cursor;
  });

  await t.test('limits: threads and comments per file, comments per thread', async () => {
    const other = ok(await files(people.owner, '', {method: 'POST', json: {teamId}}), 201).file.id as string;
    await db.execute(
      `INSERT INTO design_comment_threads(id,file_id,page_id,x,y,author_id,seq)
       SELECT gen_random_uuid()::text,$1,$2,0,0,$3,g FROM generate_series(1,$4::int) g`,
      [other, pageId, people.owner.id, DESIGN_COMMENT_LIMITS.threadsPerFile],
    );
    refused(await create(people.editor, 'Another', {}, other), 409, 'design_comment_limit');
    const crowded = (await db.one<{id: string}>('SELECT id FROM design_comment_threads WHERE file_id=$1 ORDER BY seq LIMIT 1', [other]))!.id;
    await db.execute(
      `INSERT INTO design_comments(id,thread_id,author_id,body,seq) SELECT gen_random_uuid()::text,$1,$2,'x',g FROM generate_series(1,$3::int) g`,
      [crowded, people.owner.id, DESIGN_COMMENT_LIMITS.commentsPerThread],
    );
    refused(await files(people.editor, `/${other}/comments/${crowded}/replies`, {method: 'POST', json: {text: 'x', mentions: []}}), 409, 'design_comment_limit');
    await db.execute('DELETE FROM design_comment_threads WHERE file_id=$1', [other]);
  });

  await t.test('the trash: a trashed file\'s comments are read, not written', async () => {
    ok(await files(people.owner, '/' + fileId, {method: 'DELETE'}));
    assert.ok(ok(await comments(people.viewer)).threads.length > 0);
    refused(await create(people.editor, 'In the trash'), 404);
    refused(await reply(people.editor, threads.owner, 'In the trash'), 404);
    refused(await comments(people.owner, `/${threads.owner}`, {method: 'PATCH', json: {resolved: true}}), 404);
    ok(await files(people.owner, `/${fileId}/restore`, {method: 'POST'}));
    ok(await create(people.editor, 'After the trash'), 201);
  });

  await t.test('erasure: comments in the account\'s own files go with them; its comments elsewhere stay detached; its mentions and read state go; the export lists its words', async () => {
    const leaving = await account('leaving', 'Leaver');
    await db.execute('INSERT INTO design_team_members(team_id,user_id,role) VALUES($1,$2,$3)', [teamId, leaving.id, 'editor']);
    const elsewhere = ok(await create(leaving, 'My comment in a foreign team'), 201).thread;
    ok(await reply(leaving, threads.owner, 'Reply of the leaver'), 201);
    ok(await comments(leaving, `/${threads.owner}`, {method: 'PATCH', json: {resolved: true}}));
    ok(await reply(people.owner, threads.owner, 'Thanks, @Leaver', [{userId: leaving.id, at: 8, length: 7}]), 201);
    const ownFile = ok(await files(leaving, '', {method: 'POST', json: {}}), 201).file.id as string;
    const ownThread = ok(await create(leaving, 'To self', {}, ownFile), 201).thread.id as string;

    const {prepareExportMetadata} = await import('../server/launch/export-json');
    const {exportDesignAccount} = await import('../server/design/lifecycle');
    const chunks: string[] = [];
    await prepareExportMetadata({design: exportDesignAccount(leaving.id)})(db, async text => void chunks.push(text));
    const exported = JSON.parse('{' + chunks.join('') + '}').design.comments as {text: string; fileId: string; threadId: string; startsThread: boolean}[];
    assert.deepEqual(
      exported.map(row => [row.text, row.fileId, row.startsThread]).sort(),
      [['My comment in a foreign team', fileId, true], ['Reply of the leaver', fileId, false], ['To self', ownFile, true]].sort(),
    );
    assert.ok(!exported.some(row => row.text.startsWith('Thanks')), 'another person\'s words are theirs');

    await db.execute('UPDATE users SET deletion_requested_at=$1 WHERE id=$2', [new Date().toISOString().replace('T', ' ').slice(0, 19), leaving.id]);
    await lifecycle.launchMaintenance();
    assert.notEqual((await db.one<{erasure_completed_at: string | null}>('SELECT erasure_completed_at FROM users WHERE id=$1', [leaving.id]))!.erasure_completed_at, null);
    assert.equal(await db.one('SELECT id FROM design_comment_threads WHERE id=$1', [ownThread]), undefined, 'its own file\'s threads went with the file');
    const list = ok(await comments(people.viewer));
    const kept = list.threads.find((thread: {id: string}) => thread.id === elsewhere.id);
    assert.deepEqual([kept.author, kept.comments[0].author, kept.comments[0].text], [{id: null, name: 'Deleted account'}, {id: null, name: 'Deleted account'}, 'My comment in a foreign team']);
    const thanked = list.threads.find((thread: {id: string}) => thread.id === threads.owner);
    assert.deepEqual(thanked.resolvedBy, {id: null, name: 'Deleted account'});
    assert.deepEqual(thanked.comments.at(-1).mentions, [], 'the mention of it goes; the words stay its author\'s');
    for (const table of ['design_comment_mentions', 'design_comment_reads'])
      assert.equal(await db.one(`SELECT 1 FROM ${table} WHERE user_id=$1`, [leaving.id]), undefined, table);
    for (const table of ['design_comments', 'design_comment_threads'])
      assert.equal(await db.one(`SELECT 1 FROM ${table} WHERE author_id=$1`, [leaving.id]), undefined, table);
    // Nobody can edit a detached comment; a manager can still delete it.
    refused(await comments(people.editor, `/${elsewhere.id}`, {method: 'DELETE'}), 403);
    assert.equal(ok(await comments(people.admin, `/${elsewhere.id}`, {method: 'DELETE'})).thread.deleted, true);
  });

  await t.test('erasing the team\'s owner takes the team\'s files and every comment in them', async () => {
    await db.execute('UPDATE users SET deletion_requested_at=$1 WHERE id=$2', [new Date().toISOString().replace('T', ' ').slice(0, 19), people.owner.id]);
    await lifecycle.launchMaintenance();
    assert.equal(await db.one('SELECT id FROM design_files WHERE id=$1', [fileId]), undefined);
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_comment_threads WHERE file_id=ANY($1::text[])', [[fileId, personalId]]))!.n, 0);
    refused(await comments(people.viewer), 404);
  });
});
