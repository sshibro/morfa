import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument, type Account, type Answer} from './helpers/collab-app';
import {freePort, startCollab, ticketKeys, type Collab} from './helpers/collab-binary';

// GET /api/design-files/:id/session served by a collab node (crates/collab/src/session.rs; lane A7, TARGETS A2) against api's
// own route (server/design/collab/session.ts), the oracle: every case asked of both from the same database state, with the same
// settings, compared field by field — status, code, mode, the node, the version, the socket URL, the ticket's verified claims —
// and the lease each one left (holder and fence). Then what only the node does: tell api when it took a lease (open SSE streams
// hear `collab`), refuse the 61st open of a minute, and keep refusing without a signing key.

test('collab node /session answers as api does', {timeout: 300_000}, async t => {
  const c = await collabApp(t);
  const {db, files, teams, ok} = c;
  const tickets = await import('../server/design/collab/tickets');

  const owner = await c.account('owner', '  Anna 😀 ');
  const editor = await c.account('editor', '');
  const viewer = await c.account('viewer', 'Vera');
  const outsider = await c.account('outsider');
  const solo = await c.account('solo');
  const shadowy = await c.account('shadowy');
  const closing = await c.account('closing');
  const expired = await c.account('expired');
  const limited = await c.account('limited');

  const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
  for (const [who, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
    const invite = ok(await teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1}}), 201);
    ok(await teams(who, `/invites/${invite.token}/accept`, {method: 'POST'}));
  }
  const otherTeam = ok(await teams(shadowy, '', {method: 'POST', json: {name: 'Shadows'}}), 201).team.id as string;
  const make = async (who: Account, team?: string) =>
    ok(await files(who, '', {method: 'POST', json: {name: 'Mockup', document: smallDocument(), ...(team ? {teamId: team} : {})}}), 201).file.id as string;
  const teamFile = await make(owner, teamId);
  const trashedFile = await make(owner, teamId);
  const soloFile = await make(solo);
  const shadowFile = await make(shadowy, otherTeam);
  const limitedFile = await make(limited);
  await db.execute('UPDATE design_files SET trashed_at=clock_timestamp() WHERE id=$1', [trashedFile]);
  await db.execute('UPDATE users SET deletion_requested_at=clock_timestamp() WHERE id=$1', [closing.id]);
  await db.execute('UPDATE sessions SET expires=$1 WHERE user_id=$2', [Date.now() - 1, expired.id]);

  // One node that mints, configured as api is: global legacy, the team and two accounts moved by DESIGN_COLLAB_ACCOUNTS.
  const switches = {DESIGN_COLLAB: 'legacy', DESIGN_COLLAB_ACCOUNTS: `${teamId}=rust,${otherTeam}=shadow,${solo.id}=legacy,${limited.id}=rust`};
  const port = await freePort(),
    node = 'mint' + port,
    keys = ticketKeys();
  const collab: Collab = await startCollab({
    port,
    node,
    keys,
    pgUrl: c.f.isolated.runtimeUrl,
    apiUrl: c.base,
    env: {
      MORFA_COLLAB_TICKET_PRIVATE_KEY: keys.privateKey,
      MORFA_COLLAB_SESSION_COOKIE: 'forma_session',
      DESIGN_COLLAB_NODES: `${node}=http://127.0.0.1:${port}`,
      ENABLE_DESIGN_TOOL: '1',
      ...switches,
    },
  });
  t.after(() => collab.stop());
  Object.assign(process.env, collab.apiEnv, switches);
  const publicKey = tickets.publicKeyFrom(keys.publicKey);

  type Lease = {collab_node: string | null; fence: number};
  const leases = async () =>
    new Map((await db.many<{id: string; collab_node: string | null; fence: string}>('SELECT id,collab_node,fence FROM design_files')).map(r => [r.id, {collab_node: r.collab_node, fence: Number(r.fence)}] as [string, Lease]));
  const release = () => db.execute('UPDATE design_files SET collab_node=NULL,lease_until=NULL');
  async function ask(base: string, who: Account | null, file: string, headers: Record<string, string> = {}): Promise<Answer> {
    const response = await fetch(`${base}/api/design-files/${file}/session`, {headers: {...(who ? {cookie: c.cookie(who)} : {}), ...headers}});
    const text = await response.text();
    return {status: response.status, data: text ? JSON.parse(text) : null};
  }
  /** What must be equal: the answer without its request id and ticket bytes, the claims, the lease changes. */
  const comparable = (answer: Answer, before: Map<string, Lease>, after: Map<string, Lease>) => {
    const {requestId: _id, ticket, expiresAt, ...rest} = answer.data ?? {};
    const claims = ticket ? tickets.readTicket(publicKey, ticket) : null;
    if (ticket) {
      assert.ok(claims, 'the ticket verifies with the public key');
      assert.ok(Math.abs(expiresAt - claims!.exp * 1000) === 0 && Math.abs(claims!.exp * 1000 - Date.now() - 60_000) < 2_000, 'valid 60 s');
    }
    const moved = [...after].filter(([id, lease]) => before.get(id)?.collab_node !== lease.collab_node || before.get(id)?.fence !== lease.fence);
    return {status: answer.status, body: rest, claims: claims && {...claims, exp: undefined}, moved: moved.map(([id, lease]) => [id, lease.collab_node, lease.fence - before.get(id)!.fence])};
  };
  /** The same request to api and to the node from the same lease state; `keep` leaves the leases as each found them. */
  async function same(label: string, who: Account | null, file: string, headers: Record<string, string> = {}, keep = false) {
    const start = await leases();
    if (!keep) await release();
    const before = await leases();
    const api = await ask(c.base, who, file, headers);
    const apiSide = comparable(api, before, await leases());
    if (!keep) await release();
    else for (const [id, lease] of start) await db.execute('UPDATE design_files SET collab_node=$2,fence=$3 WHERE id=$1', [id, lease.collab_node, lease.fence]);
    const before2 = await leases();
    const nodeAnswer = await ask(collab.url, who, file, headers);
    const nodeSide = comparable(nodeAnswer, before2, await leases());
    assert.deepEqual(nodeSide, apiSide, label);
    return nodeAnswer;
  }

  await t.test('every case: the same status, words, node, version, URL, claims and lease', async () => {
    const taken = await same('owner, rust team file: takes the lease', owner, teamFile);
    assert.equal(taken.status, 200, JSON.stringify(taken.data));
    assert.equal(taken.data.node, node);
    assert.equal(taken.data.wsUrl, `http://127.0.0.1:${port}/collab/${teamFile}`);
    assert.equal(tickets.readTicket(publicKey, taken.data.ticket)!.name, 'Anna 😀', 'trimmed as JS trims');
    // The lease is live now: a second ask finds the holder (no new fence) — on both sides from that same state.
    await db.execute('UPDATE design_files SET collab_node=$2,lease_until=clock_timestamp()+interval \'15 seconds\' WHERE id=$1', [teamFile, node]);
    await same('editor, live holder found', editor, teamFile, {}, true);
    await same('editor, "Member" for an empty name', editor, teamFile);
    await same('viewer', viewer, teamFile);
    await same('editor of a trashed file: a viewer ticket', editor, trashedFile);
    await same('owner of a trashed file stays owner', owner, trashedFile);
    await same('a stranger: 404', outsider, teamFile);
    // Guests (the file shared with someone outside its team, or its link open): THE rule (file-access.ts fileRoleJoins), whose text
    // session.sql holds for both.
    await db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'viewer')", [teamFile, outsider.id]);
    await same('a guest of the file: a viewer ticket', outsider, teamFile);
    await db.execute("UPDATE design_files SET link_access='edit' WHERE id=$1", [teamFile]);
    await same('the link open to edit: a guest of the file edits', outsider, teamFile);
    await same('the link open to edit: anyone signed in edits', solo, teamFile);
    await same('the link open to edit: a viewer of the team gets the higher role', viewer, teamFile);
    await db.execute("UPDATE design_files SET link_access='none' WHERE id=$1", [teamFile]);
    await db.execute('DELETE FROM design_file_members WHERE file_id=$1', [teamFile]);
    await same('access taken back: 404', outsider, teamFile);
    await same('the link closed: 404', solo, teamFile);
    await same('legacy override of the holder: 409 legacy', solo, soloFile);
    await same('team override shadow: 409 shadow', shadowy, shadowFile);
    await same('global legacy for a personal file of a rust team member', owner, await make(owner));
    await same('unknown file', owner, '00000000-0000-0000-0000-000000000000');
    await same('malformed file id', owner, 'NOT-A-FILE');
    await same('no cookie: 401', null, teamFile);
    await same('an expired session: 401', expired, teamFile);
    await same('a closing account: 401', closing, teamFile);
    await same('X-Forma-Account of another account: 409', owner, teamFile, {'x-forma-account': editor.id});
    await same('X-Forma-Account of this account', owner, teamFile, {'x-forma-account': owner.id});
    await same('an Origin header binds the ticket', owner, teamFile, {origin: 'http://127.0.0.1:5400'});
    // The node remembers which account a session is (it never changes); a session that ended since is still 401 first.
    await db.execute('UPDATE sessions SET expires=$1 WHERE user_id=$2', [Date.now() - 1, editor.id]);
    await same('a known session that ended: 401 before 409', editor, teamFile, {'x-forma-account': owner.id});
    await same('a known session that ended: 401 before 404', editor, 'NOT-A-FILE');
    await same('a known session that ended: 401', editor, teamFile);
    await db.execute('UPDATE sessions SET expires=$1 WHERE user_id=$2', [Date.now() + 3_600_000, editor.id]);
    await same('the session lives again (its row came back): the ticket', editor, teamFile);
  });

  await t.test('a lease the node takes reaches api: open SSE streams of the file hear `collab`', async () => {
    await release();
    const stream = await c.live(owner, teamFile);
    await stream.next('hello');
    const answer = await ask(collab.url, owner, teamFile);
    assert.equal(answer.status, 200);
    assert.equal((await stream.next('collab')).mode, 'rust');
    stream.close();
  });

  await t.test('the 61st open of a minute is 429 on both, RateLimit headers on the node', async () => {
    const statuses = async (base: string) => {
      const seen: number[] = [];
      for (let i = 0; i < 61; i++) seen.push((await ask(base, limited, limitedFile)).status);
      return seen;
    };
    const api = await statuses(c.base),
      nodeSide = await statuses(collab.url);
    assert.deepEqual(nodeSide, api);
    assert.equal(nodeSide[60], 429);
    assert.ok(nodeSide.slice(0, 60).every(status => status === 200));
    const response = await fetch(`${collab.url}/api/design-files/${limitedFile}/session`, {headers: {cookie: c.cookie(limited)}});
    assert.equal(response.headers.get('ratelimit-limit'), '60');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal((await response.json()).code, 'rate_limited');
    // Over the limit with a session that ended: 401, as api answers before its limiter.
    await db.execute('UPDATE sessions SET expires=$1 WHERE user_id=$2', [Date.now() - 1, limited.id]);
    assert.equal((await ask(c.base, limited, limitedFile)).status, 401);
    assert.equal((await ask(collab.url, limited, limitedFile)).status, 401);
  });

  await t.test('a node without the signing key does not serve the route', async () => {
    const plain = await startCollab({pgUrl: c.f.isolated.runtimeUrl});
    t.after(() => plain.stop());
    assert.equal((await ask(plain.url, owner, teamFile)).status, 404);
  });
});
