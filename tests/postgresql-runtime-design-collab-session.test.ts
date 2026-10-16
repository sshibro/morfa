import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument} from './helpers/collab-app';
import {openSocket} from './helpers/collab-socket';
import type {SceneNode} from '../shared/design/types';

// The api as the control plane of the collab service (docs/BACKEND.md §2, §5, §7, §11): socket tickets,
// /session with the lease, ACL pushes (TARGETS A4), PATCH refused and PUT forwarded as a replace while a node holds the file,
// renames and the trash on the socket, collab's ACL re-validation route, and the store reading what collab wrote (its journal
// rows and checkpoints). Against the real `morfa-collab` binary on the same PostgreSQL database.

test('collab session: tickets, leases, ACL pushes, writes and checkpoints', {timeout: 300_000}, async t => {
  const c = await collabApp(t, {collab: true, env: {DESIGN_DOCUMENT_DELTA_BYTES: '0'}});
  const {db, files, teams, ok, until, collab} = c;
  const owner = await c.account('owner', 'Anna');
  const editor = await c.account('editor', 'Boris');
  const outsider = await c.account('outsider');
  const keys = await import('../server/design/collab/tickets');
  const reconcile = await import('../server/design/collab/reconcile');
  const store = await import('../server/design/document-store');

  const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
  const invite = ok(await teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role: 'editor', days: 7, maxUses: 1}}), 201);
  ok(await teams(editor, `/invites/${invite.token}/accept`, {method: 'POST'}));
  const doc = smallDocument();
  const node = (id: string) => doc.nodes[id] as SceneNode;
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Mockup', document: doc, teamId}}), 201).file.id as string;
  const holder = async () => (await db.one<{collab_node: string | null; fence: number; live: boolean}>(
    'SELECT collab_node,fence,COALESCE(lease_until>=clock_timestamp(),false) AS live FROM design_files WHERE id=$1', [id]))!;

  await t.test('legacy: /session is 409 collab_inactive and /api/config says legacy', async () => {
    const answer = await files(owner, `/${id}/session`);
    assert.equal(answer.status, 409);
    assert.equal(answer.data.code, 'collab_inactive');
    assert.equal(answer.data.mode, 'legacy');
    assert.equal(ok(await c.fetchAs(owner, '/api/config')).designCollab, 'legacy');
    assert.deepEqual(ok(await files(owner, `/${id}/collab`)), {designCollab: 'legacy'});
  });

  await t.test('the file says its own mode: the team’s, whatever the member’s account says', async () => {
    // Only the team moves: the editor's own account stays legacy, its view of the team's file is rust.
    process.env.DESIGN_COLLAB_ACCOUNTS = `${teamId}=rust`;
    try {
      assert.equal(ok(await c.fetchAs(editor, '/api/config')).designCollab, 'legacy');
      assert.deepEqual(ok(await files(editor, `/${id}/collab`)), {designCollab: 'rust'});
      assert.equal((await files(outsider, `/${id}/collab`)).status, 404, 'a stranger learns nothing');
      // The editor's personal file follows the editor's account.
      const own = ok(await files(editor, '', {method: 'POST', json: {name: 'Own', document: doc}}), 201).file.id as string;
      assert.deepEqual(ok(await files(editor, `/${own}/collab`)), {designCollab: 'legacy'});
      ok(await files(editor, `/${own}?permanent=1`, {method: 'DELETE'}));
    } finally {
      process.env.DESIGN_COLLAB_ACCOUNTS = '';
    }
  });

  // The team (and so every member's view of its files) moves to collab.
  process.env.DESIGN_COLLAB_ACCOUNTS = `${teamId}=rust,${owner.id}=rust,${editor.id}=rust`;
  let first: {wsUrl: string; ticket: string; version: number; node: string};

  await t.test('rust: /session takes the lease for the node and mints a ticket collab accepts', async () => {
    assert.equal(ok(await c.fetchAs(owner, '/api/config')).designCollab, 'rust');
    assert.equal((await files(outsider, `/${id}/session`)).status, 404, 'a stranger gets nothing');
    const before = await holder();
    first = ok(await files(owner, `/${id}/session`));
    assert.equal(first.node, collab!.node);
    assert.equal(first.wsUrl, `${collab!.url}/collab/${id}`);
    assert.equal(first.version, 1);
    const taken = await holder();
    assert.equal(taken.collab_node, collab!.node);
    assert.equal(taken.live, true);
    assert.equal(Number(taken.fence), Number(before.fence) + 1, 'a new owner moves the fence up');
    const publicKey = keys.publicKeyFrom(keys.ticketPublicKey(keys.ticketKey(collab!.apiEnv.DESIGN_COLLAB_TICKET_KEY)!));
    const claims = keys.readTicket(publicKey, first.ticket)!;
    assert.deepEqual({file: claims.file, user: claims.user, role: claims.role, team: claims.team, name: claims.name}, {file: id, user: owner.id, role: 'owner', team: teamId, name: 'Anna'});
    assert.ok(claims.exp * 1000 - Date.now() <= 60_000 && claims.exp * 1000 - Date.now() > 50_000, 'valid 60 s');
    // A second session finds the holder: no new owner.
    const again = ok(await files(editor, `/${id}/session`));
    assert.equal(again.node, collab!.node);
    assert.equal(Number((await holder()).fence), Number(taken.fence));
  });

  await t.test('the socket opens with the ticket; ops are journaled under the lease and the api reads them', async () => {
    const socket = await openSocket(first, {clientId: 'owner-tab-1'});
    assert.equal(socket.welcome.version, 1);
    assert.equal(socket.welcome.role, 'owner');
    socket.send({t: 'op', seq: 1, baseVersion: 1, patch: {nodes: {a: {...node('a'), x: 111}}}, before: {a: node('a')}});
    const ack = await socket.next('ack');
    assert.equal(ack.version, 2);
    const row = await db.one<{fence: number | null; client_id: string; client_seq: number; patch: string | null}>(
      'SELECT fence,client_id,client_seq,patch FROM design_file_changes WHERE file_id=$1 AND version=2', [id]);
    assert.equal(row!.client_id, 'owner-tab-1');
    assert.ok(Number(row!.fence) > 0, 'written under the lease fence');
    const opened = ok(await files(owner, `/${id}`));
    assert.equal(opened.file.version, 2);
    assert.equal(opened.document.nodes.a.x, 111, 'GET /:id reads the journal collab wrote');
    socket.close();
  });

  await t.test('while the node holds the file PATCH is 409 collab_active with the session URL', async () => {
    const refused = await files(owner, `/${id}/document`, {method: 'PATCH', json: {baseVersion: 2, patch: {nodes: {b: {...node('b'), x: 5}}}, before: {b: node('b')}}});
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, 'collab_active');
    assert.equal(refused.data.sessionUrl, `/api/design-files/${id}/session`);
  });

  await t.test('PUT lands at the actor as a replace: a new version there and in the journal, every socket reloads', async () => {
    const session = ok(await files(owner, `/${id}/session`));
    const socket = await openSocket(session, {clientId: 'owner-tab-2'});
    const replaced = {...doc, nodes: {...doc.nodes, c: {...node('c'), name: 'Restored'}}};
    const answer = ok(await files(owner, `/${id}/document`, {method: 'PUT', json: {baseVersion: 2, document: replaced}}));
    assert.equal(answer.version, 3);
    assert.equal((await socket.next('bye')).reason, 'replaced');
    const inspected = await collab!.internal('GET', `/internal/doc/${id}`);
    assert.equal(inspected.body.version, 3, 'the actor is at the new version');
    const row = await until(() => db.one<{op: Buffer | null; patch: string | null}>('SELECT op,patch FROM design_file_changes WHERE file_id=$1 AND version=3', [id]), 5_000, 'the replace row');
    assert.equal(row.patch, null);
    assert.equal(row.op!.subarray(0, 4).toString(), 'MRFC', 'the journal holds the document as an inline checkpoint');
    const opened = ok(await files(owner, `/${id}`));
    assert.equal(opened.file.version, 3);
    assert.equal(opened.document.nodes.c.name, 'Restored');
    assert.equal(opened.document.nodes.a.x, node('a').x, 'the replace is the whole document');
  });

  await t.test('a PUT made on a version the actor moved past is 409 version_conflict from the node', async () => {
    const client = await import('../server/design/collab/client');
    const version = ok(await files(owner, `/${id}`)).file.version as number;
    const holderNode = (await holder()).collab_node!;
    const answer = await client.replaceAtNode(holderNode, id, owner.id, JSON.stringify(doc), version - 1);
    assert.deepEqual({status: answer.status, code: answer.code, currentVersion: answer.currentVersion}, {status: 409, code: 'version_conflict', currentVersion: version});
    const writes = await import('../server/design/collab/writes');
    await assert.rejects(writes.forwardReplace(id, owner.id, () => JSON.stringify(doc), version - 1), (error: {status?: number; code?: string}) => error.status === 409 && error.code === 'version_conflict');
    assert.equal((await collab!.internal('GET', `/internal/doc/${id}`)).body.version, version, 'nothing replaced');
  });

  await t.test('a document over 2 MiB lands at the node too (it reads a whole document at the cap)', async () => {
    const session = ok(await files(owner, `/${id}/session`));
    const socket = await openSocket(session, {clientId: 'owner-tab-big-node'});
    const big = {...doc, nodes: {...doc.nodes}};
    const frame = {...(doc.nodes.F as SceneNode), children: [...(doc.nodes.F as SceneNode).children!]};
    for (let i = 0; i < 6_000; i++) {
      big.nodes['big' + i] = {...node('a'), id: 'big' + i, name: 'Rectangle number ' + i, parentId: 'F', x: i % 100, y: Math.floor(i / 100)};
      frame.children!.push('big' + i);
    }
    big.nodes.F = frame;
    assert.ok(Buffer.byteLength(JSON.stringify(big)) > 2 * 1024 * 1024);
    const version = ok(await files(owner, `/${id}`)).file.version as number;
    const answer = ok(await files(owner, `/${id}/document`, {method: 'PUT', json: {baseVersion: version, document: big}}));
    assert.equal(answer.version, version + 1);
    assert.equal((await socket.next('bye')).reason, 'replaced');
    assert.equal((await collab!.internal('GET', `/internal/doc/${id}`)).body.version, version + 1, 'the node replaced it');
    assert.equal(Object.keys(ok(await files(owner, `/${id}`)).document.nodes).length, Object.keys(big.nodes).length);
    ok(await files(owner, `/${id}/document`, {method: 'PUT', json: {baseVersion: version + 1, document: doc}}));
  });

  await t.test('a document over what an older node reads in one request goes the long way: the node lets go, api writes it', async () => {
    // A node built before lane B1's third pass reads 2 MiB (DESIGN_COLLAB_BODY_LIMIT says so).
    process.env.DESIGN_COLLAB_BODY_LIMIT = String(2 * 1024 * 1024);
    t.after(() => void delete process.env.DESIGN_COLLAB_BODY_LIMIT);
    const session = ok(await files(owner, `/${id}/session`));
    const socket = await openSocket(session, {clientId: 'owner-tab-big'});
    const big = {...doc, nodes: {...doc.nodes}};
    const frame = {...(doc.nodes.F as SceneNode), children: [...(doc.nodes.F as SceneNode).children!]};
    for (let i = 0; i < 6_000; i++) {
      big.nodes['big' + i] = {...node('a'), id: 'big' + i, name: 'Rectangle number ' + i, parentId: 'F', x: i % 100, y: Math.floor(i / 100)};
      frame.children!.push('big' + i);
    }
    big.nodes.F = frame;
    assert.ok(Buffer.byteLength(JSON.stringify(big)) > 2 * 1024 * 1024);
    const version = ok(await files(owner, `/${id}`)).file.version as number;
    const answer = ok(await files(owner, `/${id}/document`, {method: 'PUT', json: {baseVersion: version, document: big}}));
    assert.equal(answer.version, version + 1);
    assert.equal((await socket.next('bye')).reason, 'replaced');
    const opened = ok(await files(owner, `/${id}`));
    assert.equal(Object.keys(opened.document.nodes).length, Object.keys(big.nodes).length);
    // The next socket finds a node that loads it.
    const again = await openSocket(ok(await files(owner, `/${id}/session`)), {clientId: 'owner-tab-big-2'});
    assert.equal(again.welcome.version, version + 1);
    again.close();
    // Back to the small document for what follows.
    ok(await files(owner, `/${id}/document`, {method: 'PUT', json: {baseVersion: version + 1, document: doc}}));
    delete process.env.DESIGN_COLLAB_BODY_LIMIT;
  });

  await t.test('comments and meeting changes reach the sockets as on the SSE stream', async () => {
    const notices = await import('../server/design/collab/notices');
    const ownerSocket = await openSocket(ok(await files(owner, `/${id}/session`)), {clientId: 'owner-notices'});
    const editorSocket = await openSocket(ok(await files(editor, `/${id}/session`)), {clientId: 'editor-notices'});
    const pageId = doc.pages[0];
    ok(await files(owner, `/${id}/comments`, {method: 'POST', json: {anchor: {pageId, x: 10, y: 20, nodeId: null, offset: null}, text: 'Fix the spacing', mentions: []}}), 201);
    for (const socket of [ownerSocket, editorSocket]) assert.deepEqual(await socket.next('comments', undefined, 2_000), {t: 'comments'});
    notices.collabMeetingChanged(id, {revision: 3});
    notices.collabMeetingChanged(id, {revision: 4, user: editor.id});
    await notices.noticesIdle();
    assert.deepEqual(await editorSocket.next('meeting', message => message.revision === 4, 2_000), {t: 'meeting', revision: 4, user: editor.id});
    assert.deepEqual(await ownerSocket.next('meeting', undefined, 2_000), {t: 'meeting', revision: 3});
    // The owner hears nothing of the editor's own votes.
    ownerSocket.send({t: 'ping'});
    await ownerSocket.next('pong', undefined, 2_000);
    assert.ok(!ownerSocket.messages.some(message => message.t === 'meeting' && message.revision === 4));
    ownerSocket.close();
    editorSocket.close();
  });

  await t.test('ACL pushes: a demoted editor gets access {viewer}, a removed one is cut off within 2 s (A4)', async () => {
    const session = ok(await files(editor, `/${id}/session`));
    const socket = await openSocket(session, {clientId: 'editor-tab-1'});
    assert.equal(socket.welcome.role, 'editor');
    ok(await teams(owner, `/${teamId}/members/${encodeURIComponent(editor.id)}`, {method: 'PATCH', json: {role: 'viewer'}}));
    const access = await socket.next('access', undefined, 2_000);
    assert.deepEqual({role: access.role, canEdit: access.canEdit}, {role: 'viewer', canEdit: false});
    const started = performance.now();
    ok(await teams(owner, `/${teamId}/members/${encodeURIComponent(editor.id)}`, {method: 'DELETE'}));
    const bye = await socket.next('bye', undefined, 2_000);
    assert.equal(bye.reason, 'access');
    const closedAt = await socket.ended(2_000);
    assert.ok(closedAt - started <= 2_000, `closed after ${(closedAt - started).toFixed(0)} ms`);
    assert.equal((await files(editor, `/${id}/session`)).status, 404, 'no new ticket either');
  });

  await t.test('a guest of the file (shared outside the team): a ticket with the guest role; a new role and taking it back reach the socket (A4)', async () => {
    const guest = await c.account('guest', 'Guest');
    assert.equal((await files(guest, `/${id}/session`)).status, 404);
    await db.execute("INSERT INTO design_file_members(file_id,user_id,role,invited_by) VALUES($1,$2,'editor',$3)", [id, guest.id, owner.id]);
    const session = ok(await files(guest, `/${id}/session`));
    const publicKey = keys.publicKeyFrom(keys.ticketPublicKey(keys.ticketKey(collab!.apiEnv.DESIGN_COLLAB_TICKET_KEY)!));
    assert.equal(keys.readTicket(publicKey, session.ticket)!.role, 'editor');
    const socket = await openSocket(session, {clientId: 'guest-tab-1'});
    assert.equal(socket.welcome.role, 'editor');
    ok(await files(owner, `/${id}/sharing/guests/${encodeURIComponent(guest.id)}`, {method: 'PATCH', json: {role: 'viewer'}}));
    const access = await socket.next('access', undefined, 2_000);
    assert.deepEqual({role: access.role, canEdit: access.canEdit}, {role: 'viewer', canEdit: false});
    const started = performance.now();
    ok(await files(owner, `/${id}/sharing/guests/${encodeURIComponent(guest.id)}`, {method: 'DELETE'}));
    assert.equal((await socket.next('bye', undefined, 2_000)).reason, 'access');
    const closedAt = await socket.ended(2_000);
    assert.ok(closedAt - started <= 2_000, `closed after ${(closedAt - started).toFixed(0)} ms`);
    assert.equal((await files(guest, `/${id}/session`)).status, 404, 'no new ticket either');
  });

  await t.test('signing out closes the account’s sockets; its other sessions get a ticket again', async () => {
    // A second session of the owner's account (another device).
    const auth = await import('../server/auth');
    const token = 'second-' + Math.random().toString(36).slice(2);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), owner.id, Date.now() + 3_600_000]);
    const session = ok(await files(owner, `/${id}/session`));
    const socket = await openSocket(session, {clientId: 'owner-tab-out'});
    const device = {id: owner.id, token};
    ok(await c.fetchAs(device, '/api/auth/logout', {method: 'POST'}));
    assert.equal((await socket.next('bye', undefined, 2_000)).reason, 'access');
    assert.equal((await c.fetchAs(device, `/api/design-files/${id}/session`)).status, 401, 'the ended session gets no ticket');
    ok(await files(owner, `/${id}/session`), 200);
  });

  await t.test('collab re-validates through /internal/design-files/:id/access with the secret only', async () => {
    const url = (user: string) => `${c.base}/internal/design-files/${id}/access?user=${encodeURIComponent(user)}`;
    assert.equal((await fetch(url(owner.id))).status, 403);
    assert.equal((await fetch(url(owner.id), {headers: {authorization: 'Bearer wrong-secret-of-the-same-size'}})).status, 403);
    const auth = {headers: {authorization: `Bearer ${collab!.secret}`}};
    assert.deepEqual(await (await fetch(url(owner.id), auth)).json(), {role: 'owner'});
    assert.deepEqual(await (await fetch(url(editor.id), auth)).json(), {role: null});
    assert.deepEqual(await (await fetch(url(outsider.id), auth)).json(), {role: null});
  });

  await t.test('a rename reaches the socket as file {name}; the trash ends it with bye {trashed}', async () => {
    const session = ok(await files(owner, `/${id}/session`));
    const socket = await openSocket(session, {clientId: 'owner-tab-3'});
    ok(await files(owner, `/${id}`, {method: 'PATCH', json: {name: 'New name'}}));
    assert.equal((await socket.next('file', undefined, 2_000)).name, 'New name');
    ok(await files(owner, `/${id}`, {method: 'DELETE'}));
    assert.equal((await socket.next('bye', undefined, 2_000)).reason, 'trashed');
    ok(await files(owner, `/${id}/restore`, {method: 'POST'}));
  });

  await t.test('erasing a file keeps the holder’s pictures while a file collab wrote has rows above its checkpoint; checkpoints keep image_files', async () => {
    const sharp = (await import('sharp')).default;
    const png = await sharp({create: {width: 4, height: 4, channels: 3, background: '#f00'}}).png().toBuffer();
    const upload = async (fileId: string, who = owner) => {
      const form = new FormData();
      form.append('file', new Blob([new Uint8Array(png)], {type: 'image/png'}), 'Photo.png');
      return ok(await c.fetchAs(who, `/api/design-files/${fileId}/images`, {method: 'POST', body: form}));
    };
    const fileOf = async (name: string, who = owner) => ok(await files(who, '', {method: 'POST', json: {name, document: doc}}), 201).file.id as string;
    // Without a file collab wrote (a new account), a picture of an erased file goes with it.
    const fresh = await c.account('pictures');
    const plain = await fileOf('Not collaborative', fresh);
    const first = await upload(plain, fresh);
    ok(await files(fresh, `/${plain}?permanent=1`, {method: 'DELETE'}));
    assert.equal(await db.one('SELECT 1 FROM design_images WHERE filename=$1', [first.asset.url.slice('/uploads/'.length)]), undefined);
    // A file collab wrote (journal rows under its lease): its document may show the picture without image_files saying so.
    const written = await fileOf('Collaborative');
    const socket = await openSocket(ok(await files(owner, `/${written}/session`)), {clientId: 'owner-pictures'});
    const other = await fileOf('With a picture');
    const second = await upload(other);
    socket.send({t: 'op', seq: 1, baseVersion: 1, patch: {nodes: {a: {...node('a'), name: 'With a picture'}}, images: {[second.ref]: second.asset}}, before: {a: node('a')}, beforeTables: {images: {[second.ref]: null}}});
    await socket.next('ack');
    socket.close();
    ok(await files(owner, `/${other}?permanent=1`, {method: 'DELETE'}));
    assert.ok(await db.one('SELECT 1 FROM design_images WHERE filename=$1', [second.asset.url.slice('/uploads/'.length)]), 'kept: the collab-written file shows it');

    // The checkpoint the actor writes when the last socket leaves records what the document holds.
    const another = await c.account('pictures-2');
    process.env.DESIGN_COLLAB_ACCOUNTS += `,${another.id}=rust`;
    const shown = await fileOf('Collaborative 2', another);
    const holderOf = await fileOf('Original', another);
    const third = await upload(holderOf, another);
    const thirdFile = third.asset.url.slice('/uploads/'.length);
    const written2 = await openSocket(ok(await files(another, `/${shown}/session`)), {clientId: 'pictures-2'});
    written2.send({t: 'op', seq: 1, baseVersion: 1, patch: {nodes: {a: {...node('a'), name: 'With a picture'}}, images: {[third.ref]: third.asset}}, before: {a: node('a')}, beforeTables: {images: {[third.ref]: null}}});
    await written2.next('ack');
    written2.close();
    const stats = await until(
      () => db.one<{image_files: string[]; bytes: number; node_count: number}>(
        'SELECT image_files,bytes,node_count FROM design_files WHERE id=$1 AND checkpoint_version=2 AND $2=ANY(image_files)', [shown, thirdFile]),
      15_000,
      'the checkpoint with its stats',
    );
    const opened = ok(await files(another, `/${shown}`));
    assert.equal(stats.bytes, Buffer.byteLength(JSON.stringify(opened.document)), 'bytes: the JSON of the document');
    assert.equal(stats.node_count, Object.keys(opened.document.nodes).length);
    // Erasing the file it came from keeps it (image_files lists it); a picture nothing shows goes, as no collab row is above a
    // checkpoint any more.
    ok(await files(another, `/${holderOf}?permanent=1`, {method: 'DELETE'}));
    assert.ok(await db.one('SELECT 1 FROM design_images WHERE filename=$1', [thirdFile]), 'kept: image_files of the checkpoint lists it');
    const unused = await fileOf('No references', another);
    const fourth = await upload(unused, another);
    ok(await files(another, `/${unused}?permanent=1`, {method: 'DELETE'}));
    assert.equal(await db.one('SELECT 1 FROM design_images WHERE filename=$1', [fourth.asset.url.slice('/uploads/'.length)]), undefined, 'erased with its file');
  });

  await t.test('a checkpoint collab writes when the last socket leaves is what the api reads, with the rows after it', async () => {
    const own = ok(await files(owner, '', {method: 'POST', json: {name: 'Checkpoint', document: doc}}), 201).file.id as string;
    const session = ok(await files(owner, `/${own}/session`));
    const socket = await openSocket(session, {clientId: 'owner-ckpt'});
    for (let seq = 1; seq <= 5; seq++) {
      socket.send({t: 'op', seq, baseVersion: seq, patch: {nodes: {a: {...node('a'), x: 100 + seq}}}, before: {a: {...node('a'), x: seq === 1 ? node('a').x : 99 + seq}}});
      await socket.next('ack', message => message.seq === seq);
    }
    socket.close();
    const pointer = await until(() => db.one<{checkpoint_key: string; checkpoint_version: number}>(
      'SELECT checkpoint_key,checkpoint_version FROM design_files WHERE id=$1 AND checkpoint_key IS NOT NULL', [own]), 15_000, 'the checkpoint');
    assert.equal(Number(pointer.checkpoint_version), 6);
    assert.match(pointer.checkpoint_key, new RegExp(`^ckpt/${own}/6\\.bin\\.zst$`));
    const opened = ok(await files(owner, `/${own}`));
    assert.equal(opened.file.version, 6);
    assert.equal(opened.document.nodes.a.x, 105, 'read from the checkpoint object');
    // More ops after the checkpoint: rows above it.
    const again = await openSocket(ok(await files(owner, `/${own}/session`)), {clientId: 'owner-ckpt-2', since: 6});
    again.send({t: 'op', seq: 1, baseVersion: 6, patch: {nodes: {b: {...node('b'), y: 77}}}, before: {b: node('b')}});
    assert.equal((await again.next('ack')).version, 7);
    const after = ok(await files(owner, `/${own}`));
    assert.equal(after.document.nodes.a.x, 105);
    assert.equal(after.document.nodes.b.y, 77, 'the checkpoint with the row above it');
    again.close();

    // Back to legacy for this account: the node lets go, PATCH works again on top of collab's checkpoint and rows.
    process.env.DESIGN_COLLAB_ACCOUNTS = `${teamId}=rust,${editor.id}=rust`;
    assert.ok((await reconcile.reconcileCollab()) >= 1, 'the node was told to let go');
    await until(async () => !(await db.one('SELECT 1 FROM design_files WHERE id=$1 AND lease_until>=clock_timestamp()', [own])), 10_000, 'the lease released');
    const saved = ok(await files(owner, `/${own}/document`, {method: 'PATCH', json: {baseVersion: 7, patch: {nodes: {c: {...node('c'), y: 88}}}, before: {c: node('c')}}}));
    assert.equal(saved.version, 8);
    const legacy = ok(await files(owner, `/${own}`));
    assert.deepEqual([legacy.document.nodes.a.x, legacy.document.nodes.b.y, legacy.document.nodes.c.y], [105, 77, 88]);
    // That save took the file's first automatic version, so it wrote the whole text: the checkpoint pointer and every row (collab's
    // journal and catch-up tail too) went with it, and nothing is left to catch up.
    const whole = (await db.one<{checkpoint_key: string | null; rows: number}>(
      'SELECT checkpoint_key,(SELECT count(*)::int FROM design_file_changes WHERE file_id=$1) AS rows FROM design_files WHERE id=$1', [own]))!;
    assert.deepEqual(whole, {checkpoint_key: null, rows: 0});
    assert.equal(await store.compact(own), false);
    assert.deepEqual(ok(await files(owner, `/${own}`)).document, legacy.document);
  });
});
