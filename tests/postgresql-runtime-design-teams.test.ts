import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import type {Server} from 'node:http';
import sharp from 'sharp';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createNode} from '../shared/design/defaults';
import type {DesignDocument} from '../shared/design/types';
import {DESIGN_LIMITS} from '../shared/design/limits';

// "Morfa Design" teams, step 1 (docs/design-tool.md §Teams) against the real PostgreSQL schema, through the whole app: teams and their
// members, invite links, projects, every file route under each role, moving files, picture serving, deletion and erasure.

type Account = {id: string; token: string};
type Answer = {status: number; data: any; type: string | null};
type Init = RequestInit & {json?: unknown};

const png = (width: number, height: number, r = 200) =>
  sharp({create: {width, height, channels: 4, background: {r, g: 40, b: 90, alpha: 1}}}).png().toBuffer();

test('"Morfa Design" teams: roles on every route, invites, projects, moves, deletion and erasure', {timeout: 900000}, async t => {
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
  const {sweepDesignTrash} = await import('../server/design/lifecycle');
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
    const id = `design:${label}:${randomUUID()}`,
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
    return {status: response.status, data: type?.includes('json') ? JSON.parse(raw.toString('utf8')) : raw, type};
  }
  const files = (who: Account | null, suffix: string, init: Init = {}) => fetchAs(who, '/api/design-files' + suffix, init);
  const teams = (who: Account | null, suffix: string, init: Init = {}) => fetchAs(who, '/api/design-teams' + suffix, init);
  const ok = (answer: Answer, status = 200) => {
    assert.equal(answer.status, status, JSON.stringify(answer.data));
    return answer.data;
  };
  const upload = async (who: Account, id: string, data: Buffer) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], {type: 'image/png'}), 'Photo.png');
    return files(who, `/${id}/images`, {method: 'POST', body: form});
  };
  const open = async (who: Account, id: string) => ok(await files(who, '/' + id)) as {file: any; access: any; document: DesignDocument};
  const addRectangle = (doc: DesignDocument, id: string, picture?: {ref: string; asset: {url: string; width: number; height: number}}) => {
    const pageId = doc.pages[0],
      page = doc.nodes[pageId];
    const rect = createNode('RECTANGLE', {id, parentId: pageId, x: 10, y: 10, width: 200, height: 100});
    if (picture) rect.fills = [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}];
    return {nodes: {[id]: rect, [pageId]: {...page, children: [...page.children!, id]}}, ...(picture ? {images: {[picture.ref]: picture.asset}} : {})};
  };
  const invite = async (who: Account, teamId: string, role: string, extra: Record<string, unknown> = {}) =>
    ok(await teams(who, `/${teamId}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1, ...extra}}), 201) as {invite: any; token: string};
  const accept = (who: Account, token: string) => teams(who, `/invites/${token}/accept`, {method: 'POST'});

  // ── The cast ─────────────────────────────────────────────────────────────────────────────────
  const owner = await account('owner'),
    admin = await account('admin'),
    editor = await account('editor'),
    developer = await account('developer'),
    viewer = await account('viewer', ''),
    outsider = await account('outsider');
  let teamId = '';

  await t.test('a team: created by its owner, listed with the caller\'s role, renamed by a manager only', async () => {
    assert.equal((await teams(null, '')).status, 401);
    assert.equal(ok(await teams(owner, '', {method: 'POST', json: {name: '   '}}), 400).code, 'invalid_request');
    const created = ok(await teams(owner, '', {method: 'POST', json: {name: '  Studio\u0000 North  '}}), 201).team;
    teamId = created.id;
    assert.equal(created.name, 'Studio  North');
    assert.equal(created.role, 'owner');
    assert.deepEqual(created.projects, []);
    assert.deepEqual(ok(await teams(owner, '')).teams.map((team: {id: string}) => team.id), [teamId]);
    assert.deepEqual(ok(await teams(outsider, '')).teams, []);
    assert.equal((await teams(outsider, `/${teamId}`, {method: 'PATCH', json: {name: 'Foreign'}})).status, 404);
    assert.equal(ok(await teams(owner, `/${teamId}`, {method: 'PATCH', json: {name: 'North Studio'}})).team.name, 'North Studio');
    assert.equal((await teams(owner, '/not-a-team/members')).status, 404);
  });

  await t.test('invite links: role, expiry and uses; preview, idempotent accept, used up, revoked, expired, unknown; managers only', async () => {
    const adminLink = await invite(owner, teamId, 'admin');
    assert.match(adminLink.token, /^[A-Za-z0-9_-]{43}$/);
    assert.deepEqual([adminLink.invite.role, adminLink.invite.maxUses, adminLink.invite.uses, adminLink.invite.state], ['admin', 1, 0, 'active']);
    const stored = (await db.one<{token: string}>('SELECT token FROM design_team_invites WHERE id=$1', [adminLink.invite.id]))!.token;
    assert.notEqual(stored, adminLink.token, 'only a hash is kept');
    assert.match(stored, /^[0-9a-f]{64}$/);
    const preview = ok(await teams(admin, `/invites/${adminLink.token}`));
    assert.deepEqual(preview, {team: {id: teamId, name: 'North Studio'}, role: 'admin', expiresAt: adminLink.invite.expiresAt, invitedBy: 'Designer owner', member: null});
    assert.deepEqual(ok(await accept(admin, adminLink.token)), {team: {id: teamId, name: 'North Studio'}, role: 'admin', joined: true});
    assert.deepEqual(ok(await accept(admin, adminLink.token)), {team: {id: teamId, name: 'North Studio'}, role: 'admin', joined: false}, 'a member is answered again');
    assert.equal(ok(await teams(admin, `/invites/${adminLink.token}`)).member, 'admin');
    const usedUp = await accept(outsider, adminLink.token);
    assert.deepEqual([usedUp.status, usedUp.data.code], [410, 'design_invite_expired'], 'a single-use link is spent');
    assert.equal((await teams(outsider, `/invites/${adminLink.token}`)).status, 410);
    // Admins invite below themselves; the owner alone hands out "Admin".
    assert.equal((await teams(admin, `/${teamId}/invites`, {method: 'POST', json: {role: 'admin', days: 7, maxUses: 1}})).data.code, 'design_forbidden');
    const developerLink = await invite(admin, teamId, 'developer', {maxUses: 2, days: 30});
    ok(await accept(developer, developerLink.token));
    const viewerLink = await invite(owner, teamId, 'viewer');
    ok(await accept(viewer, viewerLink.token));
    // A member below admin sees no links and makes none; a stranger sees nothing.
    assert.equal((await teams(viewer, `/${teamId}/invites`)).status, 403);
    assert.equal((await teams(viewer, `/${teamId}/invites`, {method: 'POST', json: {role: 'viewer', days: 7, maxUses: 1}})).status, 403);
    assert.equal((await teams(outsider, `/${teamId}/invites`)).status, 404);
    // Bounds.
    for (const body of [{role: 'owner', days: 7, maxUses: 1}, {role: 'viewer', days: 31, maxUses: 1}, {role: 'viewer', days: 0, maxUses: 1}, {role: 'viewer', days: 7, maxUses: 101}, {role: 'viewer', days: 7, maxUses: 1, extra: 1}])
      assert.equal((await teams(owner, `/${teamId}/invites`, {method: 'POST', json: body})).status, 400, JSON.stringify(body));
    // Revoked and expired links stop at once; an unknown or malformed token is 404.
    const revoked = await invite(owner, teamId, 'viewer');
    const listed = ok(await teams(owner, `/${teamId}/invites/${revoked.invite.id}`, {method: 'DELETE'})).invites;
    assert.equal(listed.find((item: {id: string}) => item.id === revoked.invite.id).state, 'revoked');
    assert.equal((await accept(outsider, revoked.token)).status, 410);
    const expired = await invite(owner, teamId, 'viewer');
    await db.execute("UPDATE design_team_invites SET created_at=created_at-interval '8 days',expires_at=expires_at-interval '8 days' WHERE id=$1", [expired.invite.id]);
    assert.equal((await accept(outsider, expired.token)).status, 410);
    assert.equal(ok(await teams(owner, `/${teamId}/invites`)).invites.find((item: {id: string}) => item.id === expired.invite.id).state, 'expired');
    assert.equal((await accept(outsider, 'x'.repeat(43))).data.code, 'design_invite_invalid');
    assert.equal((await accept(outsider, 'short')).status, 404);
    assert.equal((await teams(owner, `/${teamId}/invites/${randomUUID()}`, {method: 'DELETE'})).status, 404);
    // Nobody joined by the refused attempts.
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_team_members WHERE team_id=$1', [teamId]))!.n, 4);
    // The token never reaches the activity journal.
    await new Promise(resolve => setTimeout(resolve, 200));
    const journal = await db.many<{action: string}>("SELECT action FROM admin_activity WHERE action LIKE '%design-teams/invites%'");
    for (const row of journal) {
      assert.match(row.action, /design-teams\/invites\/:token/);
      assert.doesNotMatch(row.action, /[A-Za-z0-9_-]{43}/);
    }
  });

  await t.test('members: names for everyone, no e-mails; roles below the actor only', async () => {
    const byOwner = ok(await teams(owner, `/${teamId}/members`));
    assert.deepEqual(byOwner.members.map((m: {role: string}) => m.role), ['owner', 'admin', 'developer', 'viewer']);
    assert.ok(byOwner.members.every((m: object) => !('email' in m)), 'a member carries no address');
    assert.equal(byOwner.members.find((m: {role: string}) => m.role === 'viewer').name, 'Member', 'a nameless account is "Member"');
    const byViewer = ok(await teams(viewer, `/${teamId}/members`));
    assert.ok(byViewer.members.every((m: object) => !('email' in m)));
    assert.equal(byViewer.members.find((m: {you: boolean}) => m.you).name, 'Member');
    assert.equal((await teams(outsider, `/${teamId}/members`)).status, 404);
    // Any number of editors: the editor's link works at once.
    const editorLink = await invite(owner, teamId, 'editor');
    assert.equal(ok(await accept(editor, editorLink.token)).role, 'editor');
    // An admin changes roles below itself only; nobody changes their own; the owner's role moves only by a handover.
    assert.equal((await teams(admin, `/${teamId}/members/${viewer.id}`, {method: 'PATCH', json: {role: 'admin'}})).status, 403);
    assert.equal((await teams(admin, `/${teamId}/members/${owner.id}`, {method: 'PATCH', json: {role: 'viewer'}})).status, 403);
    assert.equal((await teams(admin, `/${teamId}/members/${admin.id}`, {method: 'PATCH', json: {role: 'viewer'}})).status, 400);
    assert.equal((await teams(viewer, `/${teamId}/members/${developer.id}`, {method: 'PATCH', json: {role: 'viewer'}})).status, 403);
    assert.equal((await teams(owner, `/${teamId}/members/${outsider.id}`, {method: 'PATCH', json: {role: 'viewer'}})).status, 404);
    assert.equal((await teams(owner, `/${teamId}/members/${viewer.id}`, {method: 'PATCH', json: {role: 'boss'}})).status, 400);
    // The owner makes the admin a developer.
    ok(await teams(owner, `/${teamId}/members/${admin.id}`, {method: 'PATCH', json: {role: 'developer'}}));
  });

  let fileId = '';
  let projectId = '';
  await t.test('projects and team files: managers make projects, editors make files, the list is the team\'s', async () => {
    assert.equal((await teams(editor, `/${teamId}/projects`, {method: 'POST', json: {name: 'Website'}})).status, 403);
    const project = ok(await teams(owner, `/${teamId}/projects`, {method: 'POST', json: {name: 'Website'}}), 201).project;
    projectId = project.id;
    assert.equal(ok(await teams(owner, `/${teamId}/projects/${projectId}`, {method: 'PATCH', json: {name: 'Coffee shop website'}})).project.name, 'Coffee shop website');
    assert.deepEqual(ok(await teams(viewer, '')).teams[0].projects.map((p: {name: string}) => p.name), ['Coffee shop website']);
    assert.equal((await files(viewer, '', {method: 'POST', json: {teamId}})).data.code, 'design_forbidden', 'a viewer makes no files');
    assert.equal((await files(outsider, '', {method: 'POST', json: {teamId}})).status, 404);
    assert.equal((await files(editor, '', {method: 'POST', json: {teamId, projectId: randomUUID()}})).status, 404);
    assert.equal((await files(editor, '', {method: 'POST', json: {projectId}})).status, 400, 'a project needs its team');
    const created = ok(await files(editor, '', {method: 'POST', json: {teamId, projectId, name: 'Home'}}), 201).file;
    fileId = created.id;
    assert.deepEqual([created.teamId, created.projectId], [teamId, projectId]);
    const row = (await db.one<{user_id: string}>('SELECT user_id FROM design_files WHERE id=$1', [fileId]))!;
    assert.equal(row.user_id, owner.id, 'a team file is held by the team\'s owner');
    const listed = ok(await files(viewer, `?team=${teamId}`));
    assert.deepEqual(listed.files.map((file: {id: string}) => file.id), [fileId]);
    assert.deepEqual(listed.usage, {files: 1, storageBytes: 0});
    assert.equal(ok(await files(viewer, `?team=${teamId}&project=${projectId}`)).files.length, 1);
    assert.equal((await files(outsider, `?team=${teamId}`)).status, 404);
    assert.equal((await files(viewer, `?project=${projectId}`)).status, 400);
    assert.deepEqual(ok(await files(owner, '')).files, [], 'the owner\'s personal files do not show team files');
    assert.deepEqual(ok(await files(owner, '')).usage, {files: 0, storageBytes: 0});
  });

  await t.test('every file route under each role: view for members, edit for editors, admin for managers, 404 for strangers', async () => {
    const opened = await open(editor, fileId);
    assert.deepEqual(opened.access, {role: 'editor', canEdit: true, team: {id: teamId, name: 'North Studio'}});
    const picture = ok(await upload(editor, fileId, await png(40, 40)));
    assert.equal(ok(await files(editor, `/${fileId}/document`, {method: 'PATCH', json: {baseVersion: 1, patch: addRectangle(opened.document, 'r1', picture)}})).version, 2);
    const version = ok(await files(editor, `/${fileId}/versions`, {method: 'POST', json: {label: 'v1'}}), 201).version;
    const document = (await open(owner, fileId)).document;
    const routes: [string, string, Init, 'view' | 'edit' | 'admin'][] = [
      ['open', '/' + fileId, {}, 'view'],
      ['versions', `/${fileId}/versions`, {}, 'view'],
      ['version', `/${fileId}/versions/${version.id}`, {}, 'view'],
      ['patch', `/${fileId}/document`, {method: 'PATCH', json: {baseVersion: 1, patch: {}}}, 'edit'],
      ['put', `/${fileId}/document`, {method: 'PUT', json: {baseVersion: 1, document}}, 'edit'],
      ['rename', '/' + fileId, {method: 'PATCH', json: {name: 'Mine'}}, 'edit'],
      ['duplicate', `/${fileId}/duplicate`, {method: 'POST'}, 'edit'],
      ['thumbnail', `/${fileId}/thumbnail`, {method: 'PUT', body: new Uint8Array(await png(10, 10)), headers: {'content-type': 'image/png'}}, 'edit'],
      ['name version', `/${fileId}/versions`, {method: 'POST', json: {label: 'foreign'}}, 'edit'],
      ['restore version', `/${fileId}/versions/${version.id}/restore`, {method: 'POST', json: {baseVersion: 1}}, 'edit'],
      ['move', `/${fileId}/move`, {method: 'POST', json: {teamId, projectId: null}}, 'edit'],
      ['restore', `/${fileId}/restore`, {method: 'POST'}, 'admin'],
      ['trash', '/' + fileId, {method: 'DELETE'}, 'admin'],
      ['erase', `/${fileId}?permanent=1`, {method: 'DELETE'}, 'admin'],
    ];
    for (const [who, label] of [[outsider, 'outsider'], [viewer, 'viewer'], [developer, 'developer']] as const) {
      for (const [name, suffix, init, need] of routes) {
        const answer = await files(who, suffix, init);
        const expected = label === 'outsider' ? 404 : need === 'view' ? 200 : 403;
        assert.equal(answer.status, expected, `${label} ${name}: ${JSON.stringify(answer.data).slice(0, 200)}`);
        if (expected === 403) assert.equal(answer.data.code, 'design_forbidden', `${label} ${name}`);
      }
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(await png(10, 10))], {type: 'image/png'}), 'x.png');
      assert.equal((await files(who, `/${fileId}/images`, {method: 'POST', body: form})).status, label === 'outsider' ? 404 : 403, `${label} upload`);
    }
    // An editor edits but neither trashes nor erases; a manager does.
    assert.equal((await files(editor, '/' + fileId, {method: 'DELETE'})).data.code, 'design_forbidden');
    assert.equal(ok(await files(editor, '/' + fileId, {method: 'PATCH', json: {name: 'Home page'}})).file.name, 'Home page');
    assert.equal((await open(viewer, fileId)).access.canEdit, false);
    assert.equal((await open(developer, fileId)).access.role, 'developer');
    // Pictures and thumbnails of a team file reach its members and nobody else.
    for (const who of [owner, admin, editor, developer, viewer]) assert.equal((await fetchAs(who, picture.asset.url)).status, 200);
    assert.equal((await fetchAs(outsider, picture.asset.url)).status, 404);
    const usage = ok(await files(viewer, `?team=${teamId}`)).usage;
    assert.ok(usage.storageBytes > 0, 'the team counts its pictures');
    assert.deepEqual(ok(await files(owner, '')).usage.storageBytes, 0, 'not the owner\'s personal storage');
    // A member's personal picture never enters a team file.
    const personal = ok(await files(editor, '', {method: 'POST', json: {name: 'Personal'}}), 201).file;
    const mine = ok(await upload(editor, personal.id, await png(20, 20, 10)));
    const now = await open(editor, fileId);
    const refused = await files(editor, `/${fileId}/document`, {method: 'PATCH', json: {baseVersion: now.file.version, patch: addRectangle(now.document, 'r2', mine)}});
    assert.deepEqual([refused.status, refused.data.code], [403, 'design_document_invalid']);
    // Managers trash and restore; the trash lists the team's.
    ok(await files(owner, '/' + fileId, {method: 'DELETE'}));
    assert.deepEqual(ok(await files(viewer, `?team=${teamId}&trash=1`)).files.map((file: {id: string}) => file.id), [fileId]);
    assert.equal(ok(await files(owner, `/${fileId}/restore`, {method: 'POST'})).file.trashedAt, null);
  });

  await t.test('promotion: a viewer made editor edits; removal and leaving end access; the owner cannot leave', async () => {
    ok(await teams(owner, `/${teamId}/members/${editor.id}`, {method: 'PATCH', json: {role: 'viewer'}}));
    ok(await teams(owner, `/${teamId}/members/${viewer.id}`, {method: 'PATCH', json: {role: 'editor'}}));
    const opened = await open(viewer, fileId);
    assert.equal(opened.access.canEdit, true);
    assert.equal(ok(await files(viewer, `/${fileId}/document`, {method: 'PATCH', json: {baseVersion: opened.file.version, patch: addRectangle(opened.document, 'v1')}})).version, opened.file.version + 1);
    assert.equal((await files(editor, `/${fileId}/document`, {method: 'PATCH', json: {baseVersion: 1, patch: {}}})).data.code, 'design_forbidden', 'demoted: read-only');
    ok(await teams(owner, `/${teamId}/members/${developer.id}`, {method: 'DELETE'}));
    assert.equal((await files(developer, '/' + fileId)).status, 404);
    assert.deepEqual(ok(await teams(developer, '')).teams, []);
    ok(await teams(editor, `/${teamId}/leave`, {method: 'POST'}));
    assert.equal((await files(editor, '/' + fileId)).status, 404);
    assert.equal(ok(await files(editor, '')).files.length, 1, 'their personal file stays');
    assert.equal((await teams(owner, `/${teamId}/leave`, {method: 'POST'})).status, 409);
    assert.equal((await teams(owner, `/${teamId}/members/${owner.id}`, {method: 'DELETE'})).status, 400);
  });

  await t.test('moving files: personal → team copies shared pictures, team → personal by managers only, projects by editors', async () => {
    // Two personal files of the owner share one picture; one of them moves into the team.
    const a = ok(await files(owner, '', {method: 'POST', json: {name: 'Cover'}}), 201).file,
      b = ok(await files(owner, '', {method: 'POST', json: {name: 'Banner'}}), 201).file;
    const shared = ok(await upload(owner, a.id, await png(30, 30, 50)));
    const only = ok(await upload(owner, a.id, await png(30, 30, 90)));
    let docA = (await open(owner, a.id)).document;
    ok(await files(owner, `/${a.id}/document`, {method: 'PATCH', json: {baseVersion: 1, patch: addRectangle(docA, 's1', shared)}}));
    docA = (await open(owner, a.id)).document;
    ok(await files(owner, `/${a.id}/document`, {method: 'PATCH', json: {baseVersion: 2, patch: addRectangle(docA, 'o1', only)}}));
    const docB = (await open(owner, b.id)).document;
    ok(await files(owner, `/${b.id}/document`, {method: 'PATCH', json: {baseVersion: 1, patch: addRectangle(docB, 's1', shared)}}));
    // A viewer of the team cannot pull a personal file in; another account's file is 404.
    assert.equal((await files(viewer, `/${a.id}/move`, {method: 'POST', json: {teamId}})).status, 404);
    const moved = ok(await files(owner, `/${a.id}/move`, {method: 'POST', json: {teamId, projectId}})).file;
    assert.deepEqual([moved.teamId, moved.projectId], [teamId, projectId]);
    const inTeam = await open(viewer, a.id);
    const urls = Object.values(inTeam.document.images).map(asset => asset.url).sort();
    assert.ok(urls.includes(only.asset.url), 'a picture only this file used moved with it');
    assert.ok(!urls.includes(shared.asset.url), 'a shared one was copied');
    for (const url of urls) assert.equal((await fetchAs(viewer, url)).status, 200, url);
    assert.equal((await fetchAs(owner, shared.asset.url)).status, 200, 'the original stays for the other file');
    assert.equal((await fetchAs(viewer, shared.asset.url)).status, 404);
    assert.deepEqual(ok(await files(owner, '')).files.map((file: {id: string}) => file.id), [b.id]);
    // Between projects: an editor (viewer was promoted); back to personal: managers only.
    ok(await files(viewer, `/${a.id}/move`, {method: 'POST', json: {teamId, projectId: null}}));
    assert.equal((await files(viewer, `/${a.id}/move`, {method: 'POST', json: {teamId: null}})).data.code, 'design_forbidden');
    const back = ok(await files(owner, `/${a.id}/move`, {method: 'POST', json: {teamId: null}})).file;
    assert.deepEqual([back.teamId, back.projectId], [null, null]);
    assert.equal((await files(viewer, '/' + a.id)).status, 404);
    for (const url of urls) assert.equal((await fetchAs(owner, url)).status, 200);
  });

  await t.test('the room for documents: a file moved in by an admin and a team handed over count for the account that will hold them', async () => {
    // An admin of another account's team moves a personal file in: the team's owner will hold it.
    const host = await account('host'),
      mover = await account('mover');
    const hosted = ok(await teams(host, '', {method: 'POST', json: {name: 'Foreign team'}}), 201).team.id;
    ok(await accept(mover, (await invite(host, hosted, 'admin')).token));
    const mine = ok(await files(mover, '', {method: 'POST', json: {name: 'Admin draft'}}), 201).file;
    assert.ok((await db.many('SELECT id FROM design_files WHERE team_id=$1', [teamId])).length > 0);
    process.env.DESIGN_ACCOUNT_DOCUMENT_BYTES = '1';
    try {
      const refused = await files(mover, `/${mine.id}/move`, {method: 'POST', json: {teamId: hosted}});
      assert.deepEqual([refused.status, refused.data.code], [413, 'design_documents_limit']);
      assert.equal((await open(mover, mine.id)).file.teamId, null, 'the file stays personal');
      const handover = await teams(owner, `/${teamId}/members/${viewer.id}`, {method: 'PATCH', json: {role: 'owner'}});
      assert.deepEqual([handover.status, handover.data.code], [413, 'design_documents_limit']);
      assert.match(handover.data.error, /new owner/);
      assert.equal((await db.one<{owner_id: string}>('SELECT owner_id FROM design_teams WHERE id=$1', [teamId]))!.owner_id, owner.id);
      assert.deepEqual(await db.many('SELECT DISTINCT user_id FROM design_files WHERE team_id=$1', [teamId]), [{user_id: owner.id}]);
    } finally {
      delete process.env.DESIGN_ACCOUNT_DOCUMENT_BYTES;
    }
    ok(await files(mover, `/${mine.id}/move`, {method: 'POST', json: {teamId: hosted}}));
    assert.deepEqual(await db.one('SELECT user_id,team_id FROM design_files WHERE id=$1', [mine.id]), {user_id: host.id, team_id: hosted});
  });

  await t.test('handing over: the new owner holds the files and pays; the former owner becomes an admin', async () => {
    assert.equal((await teams(admin, `/${teamId}/members/${viewer.id}`, {method: 'PATCH', json: {role: 'owner'}})).status, 403);
    // Seats: owner and viewer (an editor now) are the two; the handover keeps the count.
    const members = ok(await teams(owner, `/${teamId}/members/${viewer.id}`, {method: 'PATCH', json: {role: 'owner'}}));
    assert.deepEqual(
      members.members.filter((m: {userId: string}) => [owner.id, viewer.id].includes(m.userId)).map((m: {userId: string; role: string}) => [m.userId === owner.id ? 'former' : 'new', m.role]).sort(),
      [['former', 'admin'], ['new', 'owner']],
    );
    assert.equal((await db.one<{owner_id: string}>('SELECT owner_id FROM design_teams WHERE id=$1', [teamId]))!.owner_id, viewer.id);
    assert.deepEqual(await db.many('SELECT DISTINCT user_id FROM design_files WHERE team_id=$1', [teamId]), [{user_id: viewer.id}]);
    assert.deepEqual(await db.many('SELECT DISTINCT user_id FROM design_images WHERE team_id=$1', [teamId]), [{user_id: viewer.id}]);
    assert.equal((await open(owner, fileId)).access.role, 'admin');
    assert.equal(ok(await teams(viewer, '')).teams[0].role, 'owner');
  });

  await t.test('deleting a team: the owner only; its files go to the trash and out of reach, then the sweep erases them and the team', async () => {
    assert.equal((await teams(owner, `/${teamId}`, {method: 'DELETE'})).status, 403, 'an admin does not delete the team');
    ok(await teams(viewer, `/${teamId}`, {method: 'DELETE'}));
    for (const who of [owner, viewer, admin]) {
      assert.equal((await files(who, '/' + fileId)).status, 404);
      assert.deepEqual(ok(await teams(who, '')).teams, []);
    }
    assert.ok((await db.one<{trashed_at: string | null}>('SELECT trashed_at FROM design_files WHERE id=$1', [fileId]))!.trashed_at);
    await db.execute('UPDATE design_files SET trashed_at=clock_timestamp()-make_interval(days=>$2::int) WHERE team_id=$1', [teamId, DESIGN_LIMITS.trashDays + 1]);
    await sweepDesignTrash();
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_files WHERE team_id=$1', [teamId]))!.n, 0);
    assert.equal(await db.one('SELECT id FROM design_teams WHERE id=$1', [teamId]), undefined, 'the team goes once its files are erased');
  });

  await t.test('erasure: the teams an account owns go with their files; its memberships elsewhere go; the export lists its teams', async () => {
    const leaving = await account('leaving'),
      staying = await account('staying');
    const owned = ok(await teams(leaving, '', {method: 'POST', json: {name: 'Leaving'}}), 201).team.id;
    const other = ok(await teams(staying, '', {method: 'POST', json: {name: 'Staying'}}), 201).team.id;
    ok(await accept(staying, (await invite(leaving, owned, 'viewer')).token));
    ok(await accept(leaving, (await invite(staying, other, 'editor')).token));
    const teamFile = ok(await files(leaving, '', {method: 'POST', json: {teamId: owned}}), 201).file;
    const picture = ok(await upload(leaving, teamFile.id, await png(16, 16)));
    const stayingFile = ok(await files(leaving, '', {method: 'POST', json: {teamId: other}}), 201).file;
    const uploads = path.join(f.dataDir, 'uploads');
    await mkdir(uploads, {recursive: true});
    const filename = picture.asset.url.slice('/uploads/'.length);
    assert.ok(existsSync(path.join(uploads, filename)));
    const {prepareExportMetadata} = await import('../server/launch/export-json');
    const {exportDesignAccount} = await import('../server/design/lifecycle');
    const chunks: string[] = [];
    await prepareExportMetadata({design: exportDesignAccount(leaving.id)})(db, async text => void chunks.push(text));
    const exported = JSON.parse('{' + chunks.join('') + '}').design;
    assert.deepEqual(exported.teams.map((team: {name: string; role: string; owner: boolean}) => [team.name, team.role, team.owner]).sort(), [['Leaving', 'owner', true], ['Staying', 'editor', false]]);
    assert.equal(exported.files.find((file: {id: string}) => file.id === teamFile.id).teamId, owned);
    await db.execute('UPDATE users SET deletion_requested_at=$1 WHERE id=$2', [new Date().toISOString().replace('T', ' ').slice(0, 19), leaving.id]);
    await lifecycle.launchMaintenance();
    assert.notEqual((await db.one<{erasure_completed_at: string | null}>('SELECT erasure_completed_at FROM users WHERE id=$1', [leaving.id]))!.erasure_completed_at, null);
    assert.equal(await db.one('SELECT id FROM design_teams WHERE id=$1', [owned]), undefined, 'the team it owned is gone');
    assert.equal(await db.one('SELECT id FROM design_files WHERE id=$1', [teamFile.id]), undefined);
    assert.equal(existsSync(path.join(uploads, filename)), false, 'with its picture files');
    assert.equal(await db.one('SELECT 1 FROM design_team_members WHERE user_id=$1', [leaving.id]), undefined, 'and its memberships');
    assert.ok(await db.one('SELECT id FROM design_files WHERE id=$1', [stayingFile.id]), 'a file it made in another team stays with that team');
    assert.equal(ok(await teams(staying, '')).teams.length, 1);
  });
});
