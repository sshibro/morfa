import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, measurer, type Account} from './helpers/collab-app';
import {openSocket, type CollabSocket} from './helpers/collab-socket';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, SceneNode} from '../shared/design/types';

// The cutover of docs/BACKEND.md §7 at the protocol level: two tabs of one account edit a file over SSE + PATCH
// (legacy), the account's switch flips to rust, both tabs move to the socket through /session (one on its own, the other when its
// PATCH is refused with 409 collab_active) and keep editing, an undo goes as an op, then the switch flips back: the node lets go,
// both sockets end, /session says collab_inactive and the tabs go back to SSE + PATCH. Every acknowledged edit is in the document at
// the end, in the order the server took them. The browser version with the editor itself is tests/e2e/design-collab-cutover.spec.ts.

const LAYERS = 12;

function startDocument(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'F', x: 0, y: 0, width: 2000, height: 2000}), 'page');
  for (let i = 0; i < LAYERS; i++) tx.create(createNode('RECTANGLE', {id: `r${i}`, x: 10 * i, y: 0, width: 20, height: 20}), 'F');
  return tx.commit({measurer}).doc;
}

type Tab = {
  name: string;
  who: Account;
  /** The document as this tab last knew the server's (its own edits included once stored). */
  doc: DesignDocument;
  version: number;
  socket: CollabSocket | null;
  seq: number;
  clientId: string;
};

test('collab cutover: legacy → rust → legacy with two tabs, no edit lost', {timeout: 300_000}, async t => {
  const c = await collabApp(t, {collab: true, env: {DESIGN_DOCUMENT_DELTA_BYTES: '0'}});
  const {files, ok, db} = c;
  const reconcile = await import('../server/design/collab/reconcile');
  const owner = await c.account('owner', 'Anna');
  const base = startDocument();
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Cutover', document: base}}), 201).file.id as string;
  /** What the server must hold at the end: every stored edit, as (layer, field) → value. */
  const expected = new Map<string, number>();
  const tabs: Tab[] = ['A', 'B'].map(name => ({name, who: owner, doc: base, version: 1, socket: null, seq: 0, clientId: `tab-${name}-${Date.now()}`}));

  const node = (tab: Tab, layer: string) => tab.doc.nodes[layer] as SceneNode;
  /** The tab catches up with the server's document (as the editor does from its stream or socket). */
  const refresh = async (tab: Tab) => {
    const opened = ok(await files(owner, `/${id}`));
    tab.doc = opened.document;
    tab.version = opened.file.version;
  };
  /** One edit: `field` of `layer` set to `value`, made on the tab's version with its `before` copy. */
  const change = (tab: Tab, layer: string, field: 'x' | 'y', value: number) => ({
    baseVersion: tab.version,
    patch: {nodes: {[layer]: {...node(tab, layer), [field]: value}}},
    before: {[layer]: node(tab, layer)},
  });
  async function patchEdit(tab: Tab, layer: string, field: 'x' | 'y', value: number) {
    const answer = await files(owner, `/${id}/document`, {method: 'PATCH', json: change(tab, layer, field, value)});
    if (answer.status === 200) {
      expected.set(`${layer}.${field}`, value);
      await refresh(tab);
    }
    return answer;
  }
  async function opEdit(tab: Tab, layer: string, field: 'x' | 'y', value: number) {
    const seq = ++tab.seq;
    tab.socket!.send({t: 'op', seq, ...change(tab, layer, field, value)});
    const answer = await tab.socket!.next('ack', message => message.seq === seq);
    expected.set(`${layer}.${field}`, value);
    tab.version = answer.version;
    await refresh(tab);
    return answer;
  }
  async function connect(tab: Tab) {
    const session = ok(await files(owner, `/${id}/session`));
    tab.socket = await openSocket(session, {clientId: tab.clientId, since: tab.version, lastSeq: tab.seq});
    assert.ok(tab.socket.welcome.version >= tab.version);
  }
  const verify = async (stage: string) => {
    const opened = ok(await files(owner, `/${id}`));
    for (const [key, value] of expected) {
      const [layer, field] = key.split('.');
      assert.equal(opened.document.nodes[layer][field], value, `${stage}: ${key}`);
    }
    return opened;
  };

  await t.test('legacy: both tabs edit over SSE + PATCH, merging', async () => {
    const [a, b] = tabs;
    const streamA = await c.live(owner, id, 1), streamB = await c.live(owner, id, 1);
    await streamA.next('hello');
    await streamB.next('hello');
    for (let i = 0; i < 4; i++) {
      ok(await patchEdit(a, `r${i}`, 'x', 100 + i));
      // B edits on the version it has (older than A's save): the server merges it field by field.
      ok(await patchEdit(b, `r${i + 4}`, 'y', 200 + i));
    }
    await streamA.next('change');
    streamA.close();
    streamB.close();
    await verify('legacy');
  });

  let streamB: Awaited<ReturnType<typeof c.live>>;
  await t.test('flip to rust: tab A moves to the socket; tab B is told on its stream and its PATCH is refused', async () => {
    const [a, b] = tabs;
    process.env.DESIGN_COLLAB_ACCOUNTS = `${owner.id}=rust`;
    assert.equal(ok(await c.fetchAs(owner, '/api/config')).designCollab, 'rust');
    // Without a node holding the file a PATCH still lands (an editor that has not moved yet loses nothing).
    ok(await patchEdit(b, 'r8', 'x', 300));
    streamB = await c.live(owner, id, b.version);
    await streamB.next('hello');
    await connect(a);
    const told = await streamB.next('collab');
    assert.deepEqual(told, {mode: 'rust', sessionUrl: `/api/design-files/${id}/session`});
    await opEdit(a, 'r0', 'y', 400);
    const refused = await patchEdit(b, 'r9', 'x', 301);
    assert.equal(refused.status, 409);
    assert.equal(refused.data.code, 'collab_active');
    // B moves too and sends the refused edit again, now as an op (on the version it made it on: collab merges it).
    streamB.close();
    const pending = change(b, 'r9', 'x', 301);
    await connect(b);
    b.socket!.send({t: 'op', seq: ++b.seq, ...pending});
    const ack = await b.socket!.next('ack');
    expected.set('r9.x', 301);
    b.version = ack.version;
    await verify('after the flip');
  });

  await t.test('rust: both tabs edit through the socket, see each other, and an undo goes as an op', async () => {
    const [a, b] = tabs;
    await refresh(a);
    await refresh(b);
    for (let i = 0; i < 4; i++) {
      await opEdit(a, `r${i}`, 'x', 500 + i);
      const seen = await b.socket!.next('change', message => message.patch?.nodes?.[`r${i}`]?.x === 500 + i);
      assert.equal(seen.patch.nodes[`r${i}`].x, 500 + i, 'B sees A’s edit on its socket');
      await opEdit(b, `r${i + 4}`, 'x', 600 + i);
    }
    // A's undo of its last edit: the inverse, with the copy of what it undoes.
    await refresh(a);
    const before = node(a, 'r3');
    const seq = ++a.seq;
    a.socket!.send({t: 'op', seq, baseVersion: a.version, patch: {nodes: {r3: {...before, x: 502}}}, before: {r3: before}});
    await a.socket!.next('ack', message => message.seq === seq);
    expected.set('r3.x', 502);
    const opened = await verify('rust');
    assert.equal(opened.document.nodes.r7.x, 603, 'B’s edit made after A’s stays through the undo');
    const journal = (await db.one<{rows: number; fenced: number}>(
      'SELECT count(*)::int AS rows,count(fence)::int AS fenced FROM design_file_changes WHERE file_id=$1', [id]))!;
    assert.ok(journal.fenced > 0, 'collab journaled the ops under its lease');
  });

  await t.test('flip back: the node lets go, the sockets end, /session says collab_inactive, SSE + PATCH again with nothing lost', async () => {
    const [a, b] = tabs;
    process.env.DESIGN_COLLAB_ACCOUNTS = `${owner.id}=legacy`;
    assert.ok((await reconcile.reconcileCollab()) >= 1);
    assert.equal((await a.socket!.next('bye')).reason, 'moved');
    assert.equal((await b.socket!.next('bye')).reason, 'moved');
    await c.until(async () => !(await db.one('SELECT 1 FROM design_files WHERE id=$1 AND lease_until>=clock_timestamp()', [id])), 10_000, 'the lease released');
    const inactive = await files(owner, `/${id}/session`);
    assert.equal(inactive.status, 409);
    assert.equal(inactive.data.code, 'collab_inactive');
    await refresh(a);
    await refresh(b);
    const stream = await c.live(owner, id, b.version);
    await stream.next('hello');
    ok(await patchEdit(a, 'r10', 'x', 700));
    const seen = await stream.next('change');
    assert.equal(seen.patch.nodes.r10.x, 700, 'B hears A on SSE again');
    ok(await patchEdit(b, 'r11', 'y', 701));
    stream.close();
    const opened = await verify('legacy again');
    assert.equal(opened.document.nodes.r3.x, 502);
    assert.equal(Object.keys(opened.document.nodes).length, base ? Object.keys(base.nodes).length : 0, 'no layer appeared or went');
  });
});
