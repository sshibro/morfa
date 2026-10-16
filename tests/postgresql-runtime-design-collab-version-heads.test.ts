import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument} from './helpers/collab-app';
import {openSocket} from './helpers/collab-socket';
import type {SceneNode} from '../shared/design/types';

// SQL016 with the switch on: a collab node run with MORFA_JOURNAL_VERSION_HEADS=1 moves the journal's version
// counter in design_file_heads instead of design_files.version, which lags until a checkpoint folds it back. Every reader of a file's
// version reads both (file-access.ts `versionOf`) and every write of the api bumps from both: opening, the file list, /session, named
// versions, saves and version restores see the journal's version, before and after a node that stopped without its checkpoint.

test('the journal version head: the api reads and writes from it, and collab carries on from the api’s writes', {timeout: 300_000}, async t => {
  const c = await collabApp(t, {collab: {env: {MORFA_JOURNAL_VERSION_HEADS: '1'}}, env: {DESIGN_DOCUMENT_DELTA_BYTES: '0'}});
  const {db, files, ok, until} = c;
  const owner = await c.account('owner', 'Anna');
  const reconcile = await import('../server/design/collab/reconcile');
  const doc = smallDocument();
  const node = (id: string) => doc.nodes[id] as SceneNode;
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Counter', document: doc}}), 201).file.id as string;
  const raw = async () =>
    (await db.one<{version: number; head: number | null}>(
      'SELECT f.version,h.version AS head FROM design_files f LEFT JOIN design_file_heads h ON h.file_id=f.id WHERE f.id=$1',
      [id],
    ))!;
  const listed = async () => (ok(await files(owner, '')).files as {id: string; version: number}[]).find(file => file.id === id)!.version;

  process.env.DESIGN_COLLAB_ACCOUNTS = `${owner.id}=rust`;
  const session = ok(await files(owner, `/${id}/session`));
  assert.equal(session.version, 1);
  const socket = await openSocket(session, {clientId: 'heads-tab-1'});
  for (let seq = 1; seq <= 3; seq++) {
    socket.send({t: 'op', seq, baseVersion: seq, patch: {nodes: {a: {...node('a'), x: 200 + seq}}}, before: {a: {...node('a'), x: seq === 1 ? node('a').x : 199 + seq}}});
    assert.equal((await socket.next('ack', message => message.seq === seq)).version, seq + 1);
  }
  assert.deepEqual(await raw(), {version: 1, head: 4}, 'the node moved the head, not the file’s row');

  await t.test('open, the file list and /session read the head', async () => {
    const opened = ok(await files(owner, `/${id}`));
    assert.equal(opened.file.version, 4);
    assert.equal(opened.document.nodes.a.x, 203);
    assert.equal(await listed(), 4);
    assert.equal(ok(await files(owner, `/${id}/session`)).version, 4);
  });

  let named = '';
  await t.test('a named version is taken at the head', async () => {
    const saved = ok(await files(owner, `/${id}/versions`, {method: 'POST', json: {label: 'After collab'}}), 201).version;
    assert.equal(saved.version, 4);
    named = saved.id;
  });

  socket.close();
  // The node lets go (its checkpoint may fold the head into design_files.version meanwhile).
  process.env.DESIGN_COLLAB_ACCOUNTS = '';
  await reconcile.reconcileCollab();
  await until(async () => !(await db.one('SELECT 1 FROM design_files WHERE id=$1 AND lease_until>=clock_timestamp()', [id])), 15_000, 'the lease released');
  // A node that stopped before its next checkpoint leaves rows and a head above design_files.version: one more op, written as such
  // a node would have (the trigger lets a row without a fence through).
  const before = await raw();
  const top = Math.max(Number(before.version), Number(before.head ?? 0));
  await db.execute('INSERT INTO design_file_changes(file_id,version,patch) VALUES($1,$2,$3)', [id, top + 1, JSON.stringify({nodes: {b: {...node('b'), y: 61}}})]);
  await db.execute('INSERT INTO design_file_heads(file_id,version) VALUES($1,$2) ON CONFLICT(file_id) DO UPDATE SET version=EXCLUDED.version', [id, top + 1]);
  assert.ok(Number((await raw()).version) < top + 1, 'design_files.version lags the head');

  await t.test('a save and a version restore bump from the head; a stale base version is a conflict', async () => {
    const opened = ok(await files(owner, `/${id}`));
    assert.equal(opened.file.version, top + 1);
    assert.equal(opened.document.nodes.b.y, 61, 'the row above the file’s own version is read');
    // A whole document from before the head is refused (a patch from behind is merged, as for any save).
    const stale = await files(owner, `/${id}/document`, {method: 'PUT', json: {baseVersion: top, document: doc}});
    assert.equal(stale.status, 409);
    assert.equal(stale.data.currentVersion, top + 1);
    const saved = ok(await files(owner, `/${id}/document`, {method: 'PATCH', json: {baseVersion: top + 1, patch: {nodes: {c: {...node('c'), y: 62}}}, before: {c: node('c')}}}));
    assert.equal(saved.version, top + 2);
    assert.equal(Number((await raw()).version), top + 2, 'the save wrote design_files.version past the head');
    const after = ok(await files(owner, `/${id}`));
    assert.deepEqual([after.file.version, after.document.nodes.a.x, after.document.nodes.b.y, after.document.nodes.c.y], [top + 2, 203, 61, 62]);
    const restored = ok(await files(owner, `/${id}/versions/${named}/restore`, {method: 'POST', json: {baseVersion: top + 2}}));
    assert.equal(restored.version, top + 3);
    const back = ok(await files(owner, `/${id}`));
    assert.deepEqual([back.file.version, back.document.nodes.a.x, back.document.nodes.b.y, back.document.nodes.c.y], [top + 3, 203, node('b').y, node('c').y]);
    assert.equal(await listed(), top + 3);
  });

  await t.test('collab takes the file again at the api’s version and moves the head from there', async () => {
    process.env.DESIGN_COLLAB_ACCOUNTS = `${owner.id}=rust`;
    const again = ok(await files(owner, `/${id}/session`));
    assert.equal(again.version, top + 3);
    const next = await openSocket(again, {clientId: 'heads-tab-2', since: top + 3});
    next.send({t: 'op', seq: 1, baseVersion: top + 3, patch: {nodes: {a: {...node('a'), x: 300}}}, before: {a: {...node('a'), x: 203}}});
    assert.equal((await next.next('ack')).version, top + 4);
    assert.deepEqual(await raw(), {version: top + 3, head: top + 4});
    const opened = ok(await files(owner, `/${id}`));
    assert.deepEqual([opened.file.version, opened.document.nodes.a.x], [top + 4, 300]);
    next.close();
  });
});
