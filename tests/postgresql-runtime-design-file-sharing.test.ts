import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Server} from 'node:http';
import sharp from 'sharp';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';

// Sharing one file, Figma's way (docs/design-tool.md §Teams, "File access"), against the real PostgreSQL schema through the whole
// app: the file's link, the people it was shared with (guest rows; nothing creates them any more, so the tests insert them), guests'
// roles and what they may not do, "Shared with me", "Leave", a team file's guests, pictures, the trash, and collab's roles.

type Account = {id: string; token: string; email: string};
type Answer = {status: number; data: any};
type Init = RequestInit & {json?: unknown};

test('"Morfa" sharing one file: the link, guests, "Shared with me", pictures, a team file', {timeout: 600000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const keys = ['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN', 'ERASURE_LEDGER_PATH', 'BACKUP_ENCRYPTION_KEY'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {ENABLE_DESIGN_TOOL: '1', ERASURE_LEDGER_PATH: path.join(f.dataDir, 'ledger', 'erasure.jsonl'), BACKUP_ENCRYPTION_KEY: 'ab'.repeat(32)});
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const {rolesIn} = await import('../server/design/collab/acl-push');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
  });

  async function account(name: string, email = `${randomUUID()}@example.invalid`): Promise<Account> {
    const id = `share:${randomUUID()}`,
      token = randomUUID();
    await db.execute('INSERT INTO users(id,email,name,password) VALUES($1,$2,$3,$4)', [id, email, name, '']);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token, email};
  }
  async function call(who: Account, url: string, init: Init = {}): Promise<Answer> {
    const {json, ...rest} = init;
    const headers: Record<string, string> = {
      cookie: auth.authCookieName('session') + '=' + who.token,
      origin: 'http://127.0.0.1:5400',
      ...(json !== undefined ? {'content-type': 'application/json'} : {}),
    };
    const response = await fetch(base + url, {...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const type = response.headers.get('content-type');
    return {status: response.status, data: type?.includes('json') ? await response.json() : Buffer.from(await response.arrayBuffer())};
  }
  const ok = (answer: Answer, status = 200) => {
    assert.equal(answer.status, status, JSON.stringify(answer.data));
    return answer.data;
  };
  const files = (who: Account, suffix: string, init: Init = {}) => call(who, '/api/design-files' + suffix, init);
  /** Nothing creates a guest any more (the invites by address are gone): the row is written as the older invites wrote it. */
  const addGuest = (file: string, who: Account, role: 'editor' | 'viewer', invitedBy: Account | null = null) =>
    db.execute(
      `INSERT INTO design_file_members(file_id,user_id,role,invited_by) VALUES($1,$2,$3,$4)
       ON CONFLICT(file_id,user_id) DO UPDATE SET role=EXCLUDED.role,invited_by=EXCLUDED.invited_by`,
      [file, who.id, role, invitedBy?.id ?? null],
    );
  const newFile = async (who: Account, name: string, teamId?: string) =>
    (ok(await files(who, '', {method: 'POST', json: {name, ...(teamId ? {teamId} : {})}}), 201) as {file: {id: string}}).file.id;
  const shared = async (who: Account) => (ok(await files(who, '?shared=1')) as {files: any[]}).files;

  const anna = await account('Anna Smith', 'anna@example.ru');
  const boris = await account('Boris', 'boris@example.ru');
  const fileId = await newFile(anna, 'Landing page');

  await t.test('a guest edits but does not delete, move or copy the file; a guest who may edit shares in turn', async () => {
    await addGuest(fileId, boris, 'editor', anna);
    const sharing = ok(await files(anna, `/${fileId}/sharing`));
    assert.deepEqual(sharing.owner, {userId: anna.id, name: 'Anna Smith', you: true}, 'a person carries no address');
    assert.deepEqual(sharing.guests.map((guest: any) => [guest.name, guest.role, 'email' in guest]), [['Boris', 'editor', false]]);
    assert.equal(sharing.link, 'none');
    assert.equal('invites' in sharing, false, 'the invites by address are gone');
    const opened = ok(await files(boris, '/' + fileId));
    assert.deepEqual(opened.access, {role: 'editor', canEdit: true, team: null, guest: true});
    assert.deepEqual((await shared(boris)).map(file => [file.id, file.name, file.role, file.from, 'pending' in file, file.teamId]), [[fileId, 'Landing page', 'editor', 'Anna Smith', false, null]]);
    ok(await files(boris, '/' + fileId, {method: 'PATCH', json: {name: 'Coffee shop landing'}}));
    for (const [method, suffix] of [['DELETE', ''], ['POST', '/duplicate'], ['POST', '/move']] as const) {
      const refused = await files(boris, `/${fileId}${suffix}`, {method, ...(suffix === '/move' ? {json: {teamId: null}} : {})});
      assert.equal(refused.status, 403, `${method} ${suffix}`);
    }
    // Not in his own files, nor a second time on the owner's list.
    assert.equal((ok(await files(boris, '')) as {files: any[]}).files.length, 0);
    // A guest who may edit may change the sharing in turn.
    assert.equal(ok(await files(boris, `/${fileId}/sharing`, {method: 'PATCH', json: {link: 'none'}})).link, 'none');
    // A viewer guest does not.
    const vera = await account('Vera', 'vera@example.ru');
    await addGuest(fileId, vera, 'viewer', boris);
    assert.deepEqual(ok(await files(vera, '/' + fileId)).access, {role: 'viewer', canEdit: false, team: null, guest: true});
    assert.equal((await files(vera, `/${fileId}/sharing`, {method: 'PATCH', json: {link: 'view'}})).status, 403);
    const seen = ok(await files(vera, `/${fileId}/sharing`));
    assert.equal(seen.canShare, false);
    assert.ok(seen.guests.every((guest: any) => !('email' in guest)) && !('email' in seen.owner));
    assert.equal((await files(vera, '/' + fileId, {method: 'PATCH', json: {name: 'x'}})).status, 403);
  });

  await t.test('guests: a role changes at once, a viewer guest sees the file, a stranger does not', async () => {
    const gena = await account('Gene', 'gena@example.ru');
    await addGuest(fileId, gena, 'viewer', anna);
    assert.deepEqual(ok(await files(gena, '/' + fileId)).access, {role: 'viewer', canEdit: false, team: null, guest: true});
    assert.deepEqual((await shared(gena)).map(file => [file.id, file.thumbnailUrl]), [[fileId, null]]);
    const lev = await account('Leo', 'lev@example.ru');
    assert.equal((await files(lev, '/' + fileId)).status, 404, 'not shared yet');
    await addGuest(fileId, lev, 'viewer', anna);
    assert.equal(ok(await files(lev, '/' + fileId)).access.role, 'viewer');
    ok(await files(anna, `/${fileId}/sharing/guests/${encodeURIComponent(lev.id)}`, {method: 'PATCH', json: {role: 'editor'}}));
    assert.equal(ok(await files(lev, '/' + fileId)).access.role, 'editor');
    const mila = await account('Mila', 'mila@example.ru');
    assert.equal((await files(mila, `/${fileId}/sharing`)).status, 404);
    assert.deepEqual(await shared(mila), []);
  });

  await t.test('the link: anyone signed in may view or edit; closing it takes the file back; roles change; guests are removed or leave', async () => {
    const zoya = await account('Zoe');
    assert.equal((await files(zoya, '/' + fileId)).status, 404);
    assert.equal(ok(await files(anna, `/${fileId}/sharing`, {method: 'PATCH', json: {link: 'view'}})).link, 'view');
    assert.deepEqual(ok(await files(zoya, '/' + fileId)).access, {role: 'viewer', canEdit: false, team: null, guest: true});
    assert.deepEqual((await shared(zoya)).map(file => [file.id, file.role]), [[fileId, 'viewer']], 'kept in "Shared with me" once opened');
    // Who came by the link is not a guest row of their own.
    assert.equal(ok(await files(anna, `/${fileId}/sharing`)).guests.some((guest: any) => guest.userId === zoya.id), false);
    ok(await files(anna, `/${fileId}/sharing`, {method: 'PATCH', json: {link: 'edit'}}));
    assert.equal(ok(await files(zoya, '/' + fileId)).access.role, 'editor');
    // A viewer guest gets the link's higher role while it is open.
    const vera = (await db.one<{id: string}>("SELECT id FROM users WHERE email='vera@example.ru'"))!;
    assert.equal((await rolesIn(fileId, [vera.id, zoya.id, anna.id, randomUUID()])).get(vera.id), 'editor');
    ok(await files(anna, `/${fileId}/sharing`, {method: 'PATCH', json: {link: 'none'}}));
    assert.equal((await files(zoya, '/' + fileId)).status, 404);
    assert.deepEqual(await shared(zoya), []);
    const roles = await rolesIn(fileId, [vera.id, zoya.id, anna.id]);
    assert.deepEqual([roles.get(vera.id), roles.get(zoya.id), roles.get(anna.id)], ['viewer', null, 'owner'], 'collab sees the same rule');
    // Boris (editor guest) is made a viewer, then removed; Vera leaves by herself.
    assert.equal(ok(await files(anna, `/${fileId}/sharing/guests/${encodeURIComponent(boris.id)}`, {method: 'PATCH', json: {role: 'viewer'}})).guests.find((guest: any) => guest.userId === boris.id).role, 'viewer');
    assert.equal(ok(await files(boris, '/' + fileId)).access.canEdit, false);
    ok(await files(anna, `/${fileId}/sharing/guests/${encodeURIComponent(boris.id)}`, {method: 'DELETE'}));
    assert.equal((await files(boris, '/' + fileId)).status, 404);
    const veraSession = randomUUID();
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(veraSession), vera.id, Date.now() + 3_600_000]);
    const veraAccount = {id: vera.id, token: veraSession, email: 'vera@example.ru'};
    assert.deepEqual(ok(await files(veraAccount, `/${fileId}/sharing/guests/${encodeURIComponent(vera.id)}`, {method: 'DELETE'})), {ok: true});
    assert.equal((await files(veraAccount, '/' + fileId)).status, 404);
    // A viewer cannot remove others; nobody but sharers changes the link.
    const gena = (await db.one<{id: string}>("SELECT id FROM users WHERE email='gena@example.ru'"))!;
    const genaSession = randomUUID();
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(genaSession), gena.id, Date.now() + 3_600_000]);
    const genaAccount = {id: gena.id, token: genaSession, email: 'gena@example.ru'};
    const lev = (await db.one<{id: string}>("SELECT id FROM users WHERE email='lev@example.ru'"))!;
    assert.equal((await files(genaAccount, `/${fileId}/sharing/guests/${encodeURIComponent(lev.id)}`, {method: 'DELETE'})).status, 403);
    assert.equal((await files(genaAccount, `/${fileId}/sharing`, {method: 'PATCH', json: {link: 'edit'}})).status, 403);
  });

  await t.test('pictures of a shared file reach its guests; in the trash it is the owner’s again', async () => {
    const lev = (await db.one<{id: string}>("SELECT id FROM users WHERE email='lev@example.ru'"))!;
    const levSession = randomUUID();
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(levSession), lev.id, Date.now() + 3_600_000]);
    const levAccount = {id: lev.id, token: levSession, email: 'lev@example.ru'};
    const outsider = await account('Stranger');
    // Lev (an editor guest) uploads into Anna's file: the picture is the file's, counted against Anna's storage, and Lev sees it at once.
    const form = new FormData();
    const png = await sharp({create: {width: 8, height: 8, channels: 4, background: {r: 200, g: 40, b: 90, alpha: 1}}}).png().toBuffer();
    form.append('file', new Blob([new Uint8Array(png)], {type: 'image/png'}), 'Photo.png');
    const uploaded = ok(await files(levAccount, `/${fileId}/images`, {method: 'POST', body: form}));
    const filename = String(uploaded.asset.url).slice('/uploads/'.length);
    assert.equal((await db.one<{user_id: string}>('SELECT user_id FROM design_images WHERE filename=$1', [filename]))!.user_id, anna.id);
    for (const [who, status] of [[levAccount, 200], [anna, 200], [outsider, 404]] as const)
      assert.equal((await call(who, '/uploads/' + filename)).status, status);
    // In the trash: the guests lose it (the owner still opens it there).
    ok(await files(anna, '/' + fileId, {method: 'DELETE'}));
    assert.equal((await files(levAccount, '/' + fileId)).status, 404);
    assert.equal((await call(levAccount, '/uploads/' + filename)).status, 404);
    assert.deepEqual(await shared(levAccount), []);
    ok(await files(anna, `/${fileId}/restore`, {method: 'POST'}));
    assert.equal((await files(levAccount, '/' + fileId)).status, 200);
  });

  await t.test('a team file shared outside the team: guests see the team row, not its members; a deleted team takes it back', async () => {
    const teamId = (ok(await call(anna, '/api/design-teams', {method: 'POST', json: {name: 'Studio'}}), 201) as {team: {id: string}}).team.id;
    const teamFile = await newFile(anna, 'Team file', teamId);
    const kira = await account('Kira', 'kira@example.ru');
    await addGuest(teamFile, kira, 'viewer', anna);
    const opened = ok(await files(kira, '/' + teamFile));
    assert.deepEqual(opened.access, {role: 'viewer', canEdit: false, team: null, guest: true});
    const seen = ok(await files(kira, `/${teamFile}/sharing`));
    assert.deepEqual([seen.owner, seen.team], [null, {id: teamId, name: 'Studio', members: 1}]);
    assert.equal((await call(kira, `/api/design-teams/${teamId}/members`)).status, 404, 'not a member of the team');
    assert.deepEqual((await shared(kira)).map(file => [file.from, file.teamId]), [['Studio', null]]);
    // Comments: a guest comments, but mentions nobody (the mentions are of the team's people, whom a guest does not see).
    assert.equal(ok(await files(kira, `/${teamFile}/comments`)).rights.mention, false);
    assert.equal(ok(await files(anna, `/${teamFile}/comments`)).rights.mention, true);
    const anchor = {pageId: opened.document.pages[0], x: 10, y: 10, nodeId: null, offset: null};
    const mentioning = await files(kira, `/${teamFile}/comments`, {method: 'POST', json: {anchor, text: '@Anna look', mentions: [{userId: anna.id, at: 0, length: 5}]}});
    assert.deepEqual([mentioning.status, mentioning.data.code], [400, 'invalid_request']);
    ok(await files(kira, `/${teamFile}/comments`, {method: 'POST', json: {anchor, text: 'Look', mentions: []}}), 201);
    ok(await call(anna, `/api/design-teams/${teamId}`, {method: 'DELETE'}));
    assert.equal((await files(kira, '/' + teamFile)).status, 404);
  });

  await t.test('collab’s /session statement (api and the Rust nodes run sql/session.sql) is THE rule: a guest’s role, none once taken back', async () => {
    const {fileRoleJoins} = await import('../server/design/file-access');
    const {readFileSync} = await import('node:fs');
    const text = readFileSync(new URL('../server/design/collab/sql/session.sql', import.meta.url), 'utf8');
    const squash = (sql: string) => sql.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
    assert.ok(squash(text).includes(squash(fileRoleJoins('f', 'u.id'))), 'session.sql holds fileRoleJoins(f, u.id) word for word');
    // The statement as /session runs it (legacy mode: no lease is taken), for each person.
    const role = async (who: Account, file: string) =>
      (await db.one<{role: string}>(text, [file, who.id, auth.digest(who.token), Date.now(), [], [], 'legacy', 'node-test', 1000]))?.role ?? null;
    const owner = await account('Nika'),
      guest = await account('Oleg', `oleg-${randomUUID()}@example.ru`),
      visitor = await account('Passer-by');
    const file = await newFile(owner, 'For the session');
    assert.equal(await role(owner, file), 'owner');
    assert.equal(await role(guest, file), null);
    await addGuest(file, guest, 'viewer', owner);
    ok(await files(guest, '/' + file));
    assert.equal(await role(guest, file), 'viewer');
    ok(await files(owner, `/${file}/sharing`, {method: 'PATCH', json: {link: 'edit'}}));
    assert.deepEqual([await role(guest, file), await role(visitor, file)], ['editor', 'editor'], 'the link’s higher role');
    ok(await files(owner, `/${file}/sharing`, {method: 'PATCH', json: {link: 'none'}}));
    ok(await files(owner, `/${file}/sharing/guests/${encodeURIComponent(guest.id)}`, {method: 'DELETE'}));
    assert.deepEqual([await role(guest, file), await role(visitor, file), await role(owner, file)], [null, null, 'owner']);
  });

  await t.test('taking access back reaches collab at once (ACL push): a removed guest, and the link’s visitors when it closes', async () => {
    const {createServer} = await import('node:http');
    const {aclPushesIdle} = await import('../server/design/collab/acl-push');
    // A stand-in collab node that records the pushes (POST /internal/acl).
    const pushes: {file: string; user: string; role: string | null}[] = [];
    const node = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => (body += chunk));
      req.on('end', () => {
        if (req.url === '/internal/acl') pushes.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end('{"open":true}');
      });
    });
    await new Promise<void>(resolve => node.listen(0, '127.0.0.1', () => resolve()));
    const saved = {nodes: process.env.DESIGN_COLLAB_NODES, secret: process.env.DESIGN_COLLAB_INTERNAL_SECRET};
    process.env.DESIGN_COLLAB_NODES = `fake=http://127.0.0.1:${(node.address() as {port: number}).port}`;
    process.env.DESIGN_COLLAB_INTERNAL_SECRET = 'a-test-secret-of-thirty-two-char';
    try {
      const owner = await account('Rita'),
        guest = await account('Seva', `seva-${randomUUID()}@example.ru`),
        visitor = await account('Taya');
      const file = await newFile(owner, 'Open');
      await addGuest(file, guest, 'editor', owner);
      ok(await files(guest, '/' + file));
      ok(await files(owner, `/${file}/sharing`, {method: 'PATCH', json: {link: 'view'}}));
      ok(await files(visitor, '/' + file));
      // A collab node holds the file: each change below pushes the roles of whoever may have it open.
      await db.execute("UPDATE design_files SET collab_node='fake',lease_until=clock_timestamp()+interval '1 hour' WHERE id=$1", [file]);
      const pushed = async (change: () => Promise<unknown>) => {
        pushes.length = 0;
        await change();
        await aclPushesIdle();
        return new Map(pushes.filter(push => push.file === file).map(push => [push.user, push.role]));
      };
      let roles = await pushed(async () => ok(await files(owner, `/${file}/sharing`, {method: 'PATCH', json: {link: 'none'}})));
      assert.ok(roles.has(visitor.id), 'the visitor who had it by the link is told');
      assert.deepEqual([roles.get(visitor.id), roles.get(guest.id), roles.get(owner.id)], [null, 'editor', 'owner']);
      roles = await pushed(async () => ok(await files(owner, `/${file}/sharing/guests/${encodeURIComponent(guest.id)}`, {method: 'PATCH', json: {role: 'viewer'}})));
      assert.equal(roles.get(guest.id), 'viewer');
      roles = await pushed(async () => ok(await files(owner, `/${file}/sharing/guests/${encodeURIComponent(guest.id)}`, {method: 'DELETE'})));
      assert.ok(roles.has(guest.id), 'the removed guest is told');
      assert.equal(roles.get(guest.id), null);
      await db.execute('UPDATE design_files SET collab_node=NULL,lease_until=NULL WHERE id=$1', [file]);
    } finally {
      for (const [key, value] of [['DESIGN_COLLAB_NODES', saved.nodes], ['DESIGN_COLLAB_INTERNAL_SECRET', saved.secret]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await new Promise<void>(resolve => node.close(() => resolve()));
    }
  });

  await t.test('a guest given editing edits, one given viewing does not; the link’s editing is for anyone signed in', async () => {
    const {GUEST_READ_ONLY} = await import('../server/design/file-access');
    const owner = await account('Yana');
    const file = await newFile(owner, 'Mockup');
    const editor = await account('Faina', `${randomUUID()}@example.ru`),
      viewer = await account('Vika', `${randomUUID()}@example.ru`);
    await addGuest(file, editor, 'editor', owner);
    await addGuest(file, viewer, 'viewer', owner);
    const access = async (who: Account, id = file) => ok(await files(who, '/' + id)).access;
    const rename = (who: Account) => files(who, '/' + file, {method: 'PATCH', json: {name: 'Mockup'}});
    const EDITS = {role: 'editor', canEdit: true, team: null, guest: true};
    assert.deepEqual(await access(editor), EDITS);
    assert.deepEqual(await access(viewer), {role: 'viewer', canEdit: false, team: null, guest: true});
    ok(await rename(editor));
    const refused = await rename(viewer);
    assert.deepEqual([refused.status, refused.data.code, refused.data.error], [403, 'design_forbidden', GUEST_READ_ONLY]);
    // "Shared with me" and collab say the same.
    assert.equal((await shared(editor)).find(item => item.id === file)?.role, 'editor');
    const roles = await rolesIn(file, [editor.id, viewer.id]);
    assert.deepEqual([roles.get(editor.id), roles.get(viewer.id)], ['editor', 'viewer']);

    // The link's editing: for whoever opens it, and a viewer guest is given the link's higher role.
    ok(await files(owner, `/${file}/sharing`, {method: 'PATCH', json: {link: 'edit'}}));
    const visitor = await account('Passer-by 2');
    assert.deepEqual(await access(visitor), EDITS);
    assert.deepEqual(await access(viewer), EDITS);
    ok(await files(owner, `/${file}/sharing`, {method: 'PATCH', json: {link: 'none'}}));

    // A team's people are not concerned: a team's editor edits its files; the owner, their own file.
    const teamId = (ok(await call(owner, '/api/design-teams', {method: 'POST', json: {name: 'Yana\'s Studio'}}), 201) as {team: {id: string}}).team.id;
    const team = {id: teamId, name: 'Yana\'s Studio'};
    const teamFile = await newFile(owner, 'Team mockup', teamId);
    const join = async (role: string) => {
      const link = ok(await call(owner, `/api/design-teams/${teamId}/invites`, {method: 'POST', json: {role, days: 1, maxUses: 1}}), 201);
      const member = await account(`Member (${role})`);
      ok(await call(member, `/api/design-teams/invites/${link.token}/accept`, {method: 'POST'}));
      return member;
    };
    const member = await join('editor');
    assert.deepEqual(await access(member, teamFile), {role: 'editor', canEdit: true, team});
    ok(await files(member, '/' + teamFile, {method: 'PATCH', json: {name: 'Team mockup'}}));
    assert.deepEqual(await access(owner), {role: 'owner', canEdit: true, team: null});
    ok(await rename(owner));
    // A team's viewer who is a guest given editing too has the higher of the two.
    const both = await join('viewer');
    await db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'editor')", [teamFile, both.id]);
    assert.deepEqual(await access(both, teamFile), {role: 'editor', canEdit: true, team});
  });

  await t.test('who may change the sharing, and what is refused', async () => {
    const outsider = await account('Outsider');
    assert.equal((await files(outsider, `/${fileId}/sharing`, {method: 'PATCH', json: {link: 'view'}})).status, 404);
    assert.equal((await files(anna, `/${fileId}/sharing`, {method: 'PATCH', json: {link: 'public'}})).status, 400);
    assert.equal((await files(anna, `/${fileId}/sharing/guests/nobody`, {method: 'PATCH', json: {role: 'viewer'}})).status, 404);
    assert.equal((await files(anna, `/${fileId}/sharing/guests/${boris.id}`, {method: 'PATCH', json: {role: 'owner'}})).status, 400);
  });
});
