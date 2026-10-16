import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Server} from 'node:http';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {DesignPeer} from '../shared/design/live';
import {MEETING_LIMITS} from '../shared/design/meeting';
import {parseEvents} from '../src/design/realtime/stream';

// "Meeting" against the real PostgreSQL schema, through the whole app (docs/board-meeting.md): the shared timer (start, pause, "+1 min",
// resume, stop, music) on the server's clock and only for editors; voting sessions whose counts stay hidden until the end, with the
// votes each person has, a timer that ends them, results ranked; the stream tells everyone else (and a ballot only its voter's other
// tabs); presence carries cursor chat, emotes, waves and spotlight (checked, never stored); the trash, erasure and the export; the
// PostgreSQL fan-out passes meeting signals and a presence too large for one notification (whole, in parts).

type Account = {id: string; token: string};
type Answer = {status: number; data: any};
type Init = RequestInit & {json?: unknown};
type Event = {event: string; data: any};

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function document(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'A', name: 'Option A', x: 0, y: 0, width: 400, height: 400}), 'page');
  tx.create(createNode('FRAME', {id: 'B', name: 'Option B', x: 500, y: 0, width: 400, height: 400}), 'page');
  tx.create(createNode('FRAME', {id: 'C', name: 'Option C', x: 1000, y: 0, width: 400, height: 400}), 'page');
  return tx.commit({measurer}).doc;
}

test('"Morfa Design" meetings: the timer, votes, signals, presence, trash, erasure and fan-out', {timeout: 600000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const values: NodeJS.ProcessEnv = {ENABLE_DESIGN_TOOL: '1', ERASURE_LEDGER_PATH: path.join(f.dataDir, 'ledger', 'erasure.jsonl'), DESIGN_LIVE_HEARTBEAT_MS: '300'};
  const saved = Object.fromEntries(['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN', 'DESIGN_LIVE_FANOUT', ...Object.keys(values)].map(key => [key, process.env[key]]));
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  delete process.env.DESIGN_LIVE_FANOUT;
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const hub = await import('../server/design/live/hub');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  const streams: (() => void)[] = [];
  t.after(async () => {
    for (const close of streams) close();
    hub.closeDesignLiveStreams();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await hub.resetLiveFanOut();
    await drainAppTasks().catch(() => undefined);
  });

  async function account(label: string, name = 'Member ' + label): Promise<Account> {
    const id = `meet:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute('INSERT INTO users(id,email,name,password) VALUES($1,$2,$3,$4)', [id, `${label}-${randomUUID()}@example.invalid`, name, '']);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token};
  }
  const cookie = (who: Account) => auth.authCookieName('session') + '=' + who.token;
  async function fetchAs(who: Account, url: string, init: Init = {}): Promise<Answer> {
    const {json, ...rest} = init;
    const response = await fetch(base + url, {...rest, headers: {cookie: cookie(who), ...(json !== undefined ? {'content-type': 'application/json'} : {}), ...(rest.headers as Record<string, string>)}, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const text = await response.text();
    return {status: response.status, data: text ? JSON.parse(text) : null};
  }
  const files = (who: Account, suffix: string, init: Init = {}) => fetchAs(who, '/api/design-files' + suffix, init);
  const teams = (who: Account, suffix: string, init: Init = {}) => fetchAs(who, '/api/design-teams' + suffix, init);
  const ok = (answer: Answer, status = 200) => {
    assert.equal(answer.status, status, JSON.stringify(answer.data));
    return answer.data;
  };

  async function live(who: Account, fileId: string) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/design-files/${fileId}/events`, {headers: {cookie: cookie(who)}, signal: controller.signal});
    const events: Event[] = [];
    let waiters: (() => void)[] = [];
    let done = false;
    void (async () => {
      if (!response.ok || !response.body) return;
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      try {
        for (;;) {
          const {value, done: finished} = await reader.read();
          if (finished) break;
          buffer = parseEvents(buffer + value, event => events.push({event: event.event, data: JSON.parse(event.data)}));
          for (const wake of waiters.splice(0)) wake();
        }
      } catch {
        // Aborted.
      }
      done = true;
      for (const wake of waiters.splice(0)) wake();
    })();
    let read = 0;
    const close = () => controller.abort();
    streams.push(close);
    return {
      events,
      async next(name: string, match: (data: any) => boolean = () => true, timeoutMs = 8_000): Promise<any> {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          for (; read < events.length; read++) {
            const event = events[read];
            if (event.event === name && match(event.data)) {
              read++;
              return event.data;
            }
          }
          if (done) assert.fail(`the stream ended before "${name}"`);
          const left = deadline - Date.now();
          if (left <= 0) assert.fail(`no "${name}" within ${timeoutMs} ms (${JSON.stringify(events.map(event => event.event))})`);
          await new Promise<void>(resolve => {
            const timer = setTimeout(resolve, left);
            waiters.push(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        }
      },
      seen: (name: string) => events.filter(event => event.event === name).map(event => event.data),
      close,
    };
  }
  const settle = (ms = 200) => new Promise(resolve => setTimeout(resolve, ms));

  const owner = await account('owner', 'Anna Smith');
  const editor = await account('editor', 'Boris');
  const viewer = await account('viewer', 'Vera');
  const outsider = await account('outsider');
  const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
  for (const [who, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
    const link = ok(await teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1}}), 201);
    ok(await teams(who, `/invites/${link.token}/accept`, {method: 'POST'}));
  }
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Decision board', document: document(), teamId}}), 201).file.id as string;
  const meeting = (who: Account, suffix = '', init: Init = {}) => files(who, `/${id}/meeting${suffix}`, init);
  const timer = (who: Account, body: Record<string, unknown>) => meeting(who, '/timer', {method: 'POST', json: body});
  const vote = (who: Account, body: Record<string, unknown>) => meeting(who, '/vote', {method: 'POST', json: body});
  const ballot = (who: Account, body: Record<string, unknown>) => meeting(who, '/vote/ballot', {method: 'POST', json: body});

  await t.test('the timer: editors run it on the server clock, everyone else hears and reads it, viewers and strangers cannot', async () => {
    const first = ok(await meeting(viewer));
    assert.deepEqual({revision: first.revision, timer: first.timer, vote: first.vote, canControl: first.canControl}, {revision: 0, timer: null, vote: null, canControl: false});
    assert.ok(Math.abs(first.now - Date.now()) < 5_000, 'the answer carries the server clock');
    assert.equal(ok(await meeting(editor)).canControl, true);
    assert.equal((await meeting(outsider)).status, 404, 'a stranger learns nothing, as for a file that does not exist');
    assert.equal((await timer(viewer, {action: 'start', durationMs: 60_000})).status, 403);
    assert.equal((await timer(outsider, {action: 'start', durationMs: 60_000})).status, 404);
    assert.equal((await timer(editor, {action: 'start', durationMs: 1_000})).status, 400, 'at least five seconds');
    assert.equal((await timer(editor, {action: 'start', durationMs: 60_000, music: 'jazz'})).status, 400, 'only the built-in tracks');
    assert.equal((await timer(editor, {action: 'start', durationMs: 60_000, extra: 1})).status, 400);

    const a = await live(owner, id), b = await live(editor, id), v = await live(viewer, id);
    const helloB = await b.next('hello');
    await a.next('hello');
    await v.next('hello');
    const before = Date.now();
    const started = ok(await timer(editor, {action: 'start', durationMs: 180_000, music: 'lofi', client: helloB.connection}));
    assert.equal(started.timer.state, 'running');
    assert.equal(started.timer.music, 'lofi');
    assert.equal(started.timer.by.name, 'Boris');
    assert.ok(started.timer.endsAt >= before + 180_000 && started.timer.endsAt <= Date.now() + 180_000);
    const signal = await a.next('meeting');
    assert.equal(signal.revision, started.revision);
    assert.equal((await v.next('meeting')).revision, started.revision, 'viewers hear it too');
    await settle();
    assert.equal(b.seen('meeting').length, 0, 'the tab that acted has the state in its answer');
    assert.equal(ok(await meeting(viewer)).timer.endsAt, started.timer.endsAt, 'everyone counts down to the same moment');

    const paused = ok(await timer(owner, {action: 'pause'}));
    assert.equal(paused.timer.state, 'paused');
    assert.ok(paused.timer.remainingMs > 170_000 && paused.timer.remainingMs <= 180_000);
    assert.equal(ok(await timer(owner, {action: 'pause'})).revision, paused.revision, 'pausing twice changes nothing');
    const added = ok(await timer(owner, {action: 'add'}));
    assert.equal(added.timer.remainingMs, paused.timer.remainingMs + 60_000);
    assert.equal(added.timer.durationMs, 240_000);
    const resumed = ok(await timer(owner, {action: 'resume'}));
    assert.equal(resumed.timer.state, 'running');
    assert.ok(Math.abs(resumed.timer.endsAt - (resumed.now + added.timer.remainingMs)) < 50);
    const quiet = ok(await timer(owner, {action: 'music', music: null}));
    assert.equal(quiet.timer.music, null);
    const stopped = ok(await timer(owner, {action: 'stop'}));
    assert.equal(stopped.timer, null);
    assert.ok(stopped.revision > resumed.revision);
    // "+1 min" with no timer starts one minute.
    const minute = ok(await timer(editor, {action: 'add'}));
    assert.equal(minute.timer.durationMs, 60_000);
    ok(await timer(editor, {action: 'stop'}));
    a.close();
    b.close();
    v.close();
    await settle();
  });

  await t.test('a vote: counts stay hidden until the end, each has their votes, the results rank everyone’s', async () => {
    const a = await live(owner, id), v1 = await live(viewer, id), v2 = await live(viewer, id);
    await a.next('hello');
    const helloV1 = await v1.next('hello');
    await v2.next('hello');
    assert.equal((await vote(viewer, {action: 'start', perPerson: 2, durationMs: null})).status, 403, 'editors run votes');
    assert.equal((await vote(editor, {action: 'start', perPerson: 0, durationMs: null})).status, 400);
    assert.equal((await vote(editor, {action: 'start', perPerson: MEETING_LIMITS.votesPerPersonMax + 1, durationMs: null})).status, 400);
    const started = ok(await vote(editor, {action: 'start', perPerson: 2, durationMs: null}));
    const voteId = started.vote.id as string;
    assert.equal(started.vote.perPerson, 2);
    assert.equal(started.vote.endsAt, null);
    assert.deepEqual(started.vote.mine, []);
    assert.equal(started.vote.results, null);
    await a.next('meeting', data => data.revision === started.revision);

    // The viewer votes (votes are not edits) twice for A; the owner once for B and once for C.
    const one = ok(await ballot(viewer, {voteId, nodeId: 'A', delta: 1, client: helloV1.connection}));
    assert.deepEqual(one.vote.mine, [{nodeId: 'A', count: 1}]);
    const mine = await v2.next('meeting', data => data.user === viewer.id);
    assert.equal(mine.revision, started.revision, 'a ballot changes no revision');
    ok(await ballot(viewer, {voteId, nodeId: 'A', delta: 1}));
    const over = await ballot(viewer, {voteId, nodeId: 'B', delta: 1});
    assert.equal(over.status, 409);
    assert.equal(over.data.code, 'design_meeting_conflict');
    assert.equal((await ballot(viewer, {voteId, nodeId: 'C', delta: -1})).status, 409, 'nothing to take back there');
    assert.equal((await ballot(viewer, {voteId: randomUUID(), nodeId: 'A', delta: 1})).status, 409, 'another session');
    assert.equal((await ballot(viewer, {voteId, nodeId: 'bad id!', delta: 1})).status, 400);
    assert.equal((await ballot(outsider, {voteId, nodeId: 'A', delta: 1})).status, 404);
    ok(await ballot(owner, {voteId, nodeId: 'B', delta: 1}));
    ok(await ballot(owner, {voteId, nodeId: 'C', delta: 1}));
    await settle();
    assert.deepEqual(a.seen('meeting').filter(data => data.user).map(data => data.user), [owner.id, owner.id], 'the owner’s tab hears of its own ballots only');
    assert.equal(v2.seen('meeting').filter(data => data.user && data.user !== viewer.id).length, 0, 'nobody hears of another person’s ballot');
    // While it runs nobody sees anyone else's counts.
    const during = ok(await meeting(editor));
    assert.deepEqual(during.vote.mine, []);
    assert.equal(during.vote.results, null);
    assert.equal(during.vote.voters, null);
    assert.deepEqual(ok(await meeting(viewer)).vote.mine, [{nodeId: 'A', count: 2}]);
    // Taking one back frees it.
    assert.deepEqual(ok(await ballot(viewer, {voteId, nodeId: 'A', delta: -1})).vote.mine, [{nodeId: 'A', count: 1}]);
    ok(await ballot(viewer, {voteId, nodeId: 'C', delta: 1}));

    const ended = ok(await vote(owner, {action: 'end'}));
    assert.ok(ended.vote.endedAt);
    assert.deepEqual(
      ended.vote.results.map(({nodeId, count}: {nodeId: string; count: number}) => ({nodeId, count})),
      [{nodeId: 'C', count: 2}, {nodeId: 'A', count: 1}, {nodeId: 'B', count: 1}],
    );
    // Who voted for what, once it ended (MeetingTally.by).
    assert.deepEqual(ended.vote.results[0].by, [{name: 'Anna Smith', count: 1}, {name: 'Vera', count: 1}]);
    assert.equal(ended.vote.voters, 2);
    await v1.next('meeting', data => data.revision === ended.revision);
    assert.deepEqual(ok(await meeting(editor)).vote.results, ended.vote.results, 'the results are everyone’s');
    assert.equal((await ballot(viewer, {voteId, nodeId: 'B', delta: 1})).status, 409, 'no ballot after the end');
    const cleared = ok(await vote(editor, {action: 'clear'}));
    assert.equal(cleared.vote, null);
    // Clearing takes the vote off the meeting; the session and its ballots stay among the past ones (GET …/meeting/votes).
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_meeting_votes WHERE file_id=$1 AND vote_id=$2', [id, voteId]))!.n, 4, 'the session keeps its ballot rows');
    assert.deepEqual(ok(await meeting(viewer, '/votes')).votes.map((session: {id: string}) => session.id), [voteId]);
    a.close();
    v1.close();
    v2.close();
    await settle();
  });

  await t.test('a vote with the timer ends when it reaches zero, waits while it is paused, and "End" stops it', async () => {
    const timed = ok(await vote(owner, {action: 'start', perPerson: 3, durationMs: 60_000, music: 'rain'}));
    assert.equal(timed.vote.withTimer, true);
    assert.equal(timed.vote.endsAt, timed.timer.endsAt, 'the vote ends with the timer');
    assert.equal(timed.timer.music, 'rain');
    const paused = ok(await timer(editor, {action: 'pause'}));
    assert.equal(paused.vote.endsAt, null, 'paused with it');
    const later = ok(await timer(editor, {action: 'add'}));
    assert.equal(later.vote.endsAt, null);
    const resumed = ok(await timer(editor, {action: 'resume'}));
    assert.equal(resumed.vote.endsAt, resumed.timer.endsAt);
    const voteId = resumed.vote.id;
    ok(await ballot(editor, {voteId, nodeId: 'B', delta: 1}));
    // Time runs out (moved into the past here): the vote has ended for every reader, written or not.
    await db.execute("UPDATE design_meetings SET timer_ends_at=clock_timestamp()-interval '1 second',vote_ends_at=clock_timestamp()-interval '1 second' WHERE file_id=$1", [id]);
    const after = ok(await meeting(viewer));
    assert.ok(after.vote.endedAt);
    assert.deepEqual(after.vote.results, [{nodeId: 'B', count: 1, by: [{name: 'Boris', count: 1}]}]);
    assert.equal((await ballot(viewer, {voteId, nodeId: 'A', delta: 1})).status, 409);
    // The next timer does not bring it back: the end is written with the first write after it.
    const next = ok(await timer(owner, {action: 'start', durationMs: 30_000}));
    assert.ok(next.vote.endedAt);
    assert.deepEqual(next.vote.results, [{nodeId: 'B', count: 1, by: [{name: 'Boris', count: 1}]}]);
    // Ending a timed vote early stops its timer; ending an untimed one leaves a timer alone.
    const again = ok(await vote(owner, {action: 'start', perPerson: 1, durationMs: 120_000}));
    const early = ok(await vote(owner, {action: 'end'}));
    assert.ok(early.vote.endedAt);
    assert.equal(early.timer, null);
    assert.notEqual(again.vote.id, voteId);
    ok(await vote(owner, {action: 'clear'}));
    // Stopping the timer of a running timed vote lets the vote go on until an editor ends it.
    ok(await vote(owner, {action: 'start', perPerson: 1, durationMs: 120_000}));
    const untimed = ok(await timer(owner, {action: 'stop'}));
    assert.equal(untimed.vote.withTimer, false);
    assert.equal(untimed.vote.endsAt, null);
    assert.equal(untimed.vote.endedAt, null);
    ok(await vote(owner, {action: 'clear'}));
  });

  await t.test('ballots sent at once never exceed a person’s votes; different people vote in parallel', async () => {
    const started = ok(await vote(owner, {action: 'start', perPerson: 2, durationMs: null}));
    const voteId = started.vote.id;
    const burst = await Promise.all(['A', 'B', 'C', 'A', 'B', 'C'].map(nodeId => ballot(owner, {voteId, nodeId, delta: 1})));
    assert.equal(burst.filter(answer => answer.status === 200).length, 2, 'the account lock orders one person’s ballots');
    assert.ok(burst.every(answer => answer.status === 200 || answer.data?.code === 'design_meeting_conflict'));
    const together = await Promise.all([ballot(editor, {voteId, nodeId: 'A', delta: 1}), ballot(viewer, {voteId, nodeId: 'B', delta: 1})]);
    assert.deepEqual(together.map(answer => answer.status), [200, 200]);
    const counted = await db.many<{user_id: string; n: number}>(
      'SELECT user_id,sum(count)::int AS n FROM design_meeting_votes WHERE file_id=$1 AND vote_id=$2 GROUP BY user_id ORDER BY user_id',
      [id, voteId],
    );
    assert.deepEqual(Object.fromEntries(counted.map(row => [row.user_id, row.n])), {[owner.id]: 2, [editor.id]: 1, [viewer.id]: 1});
    ok(await vote(owner, {action: 'clear'}));
  });

  await t.test('presence carries cursor chat, emotes, a wave and spotlight to the others; malformed values are refused', async () => {
    const a = await live(owner, id), b = await live(editor, id);
    const helloA = await a.next('hello');
    await b.next('hello');
    const post = (body: Record<string, unknown>) => files(owner, `/${id}/presence`, {method: 'POST', json: {token: helloA.token, ...body}});
    const stored = () => db.many('SELECT * FROM design_meetings WHERE file_id=$1', [id]);
    const before = await stored();
    assert.equal((await post({cursor: {x: 10, y: 20}, meeting: {chat: 'Look here 👀', emote: {id: 'party', n: 1}, wave: null, spotlight: 77}})).status, 204);
    const seen = await b.next('presence', data => data.peers.some((peer: DesignPeer) => peer.user === owner.id && peer.meeting?.chat));
    const peer = seen.peers.find((each: DesignPeer) => each.user === owner.id);
    assert.deepEqual(peer.meeting, {chat: 'Look here 👀', emote: {id: 'party', n: 1}, wave: null, spotlight: 77});
    // Someone who opens the file now sees the open chat and the spotlight in its hello.
    const c = await live(viewer, id);
    const helloC = await c.next('hello');
    assert.equal(helloC.peers.find((each: DesignPeer) => each.connection === helloA.connection).meeting.spotlight, 77);
    for (const meetingValue of [
      {chat: 'a' + String.fromCharCode(0x202e) + 'b', emote: null, wave: null, spotlight: null},
      {chat: 'x'.repeat(101), emote: null, wave: null, spotlight: null},
      {chat: null, emote: {id: 'skull', n: 1}, wave: null, spotlight: null},
      {chat: null, emote: null, wave: -1, spotlight: null},
      {chat: null, emote: null, wave: null},
      {chat: null, emote: null, wave: null, spotlight: null, html: '<b>'},
    ])
      assert.equal((await post({meeting: meetingValue})).status, 400, JSON.stringify(meetingValue));
    // Never stored: the meeting's row is as it was.
    assert.deepEqual(await stored(), before);
    a.close();
    b.close();
    c.close();
    await settle();
  });

  await t.test('a file in the trash keeps its meeting readable but takes no change; erasure takes an account’s ballots and forgets it as a starter; the export lists them', async () => {
    // The editor starts a vote with the timer: both name them until their account is erased.
    const started = ok(await vote(editor, {action: 'start', perPerson: 2, durationMs: 600_000}));
    assert.equal(started.vote.by.id, editor.id);
    assert.equal(started.timer.by.id, editor.id);
    ok(await ballot(viewer, {voteId: started.vote.id, nodeId: 'A', delta: 1}));
    ok(await ballot(owner, {voteId: started.vote.id, nodeId: 'B', delta: 1}));
    ok(await ballot(editor, {voteId: started.vote.id, nodeId: 'C', delta: 1}));
    const lifecycle = await import('../server/design/lifecycle');
    // The export lists the account's own votes (which object of which file, how many dots).
    const {prepareExportMetadata} = await import('../server/launch/export-json');
    const chunks: string[] = [];
    await prepareExportMetadata({design: lifecycle.exportDesignAccount(viewer.id)})(db, async text => void chunks.push(text));
    const exported = JSON.parse('{' + chunks.join('') + '}').design.meetingVotes;
    // Its votes in this session, and those it gave in the past sessions the file keeps (GET …/meeting/votes): every ballot row of theirs.
    assert.deepEqual(exported.filter((row: {voteId: string}) => row.voteId === started.vote.id), [{fileId: id, voteId: started.vote.id, nodeId: 'A', count: 1}]);
    const theirs = await db.many<{n: number}>('SELECT count(*)::int AS n FROM design_meeting_votes WHERE user_id=$1', [viewer.id]);
    assert.equal(exported.length, theirs[0]!.n);
    await db.transaction(tx => lifecycle.eraseDesignAccount(tx, viewer.id));
    await db.transaction(tx => lifecycle.eraseDesignAccount(tx, editor.id));
    assert.deepEqual(await db.many('SELECT user_id,node_id,count FROM design_meeting_votes WHERE file_id=$1 AND vote_id=$2 ORDER BY node_id', [id, started.vote.id]), [{user_id: owner.id, node_id: 'B', count: 1}]);
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_meeting_votes WHERE user_id=ANY($1::text[])', [[viewer.id, editor.id]]))!.n, 0, 'none in past sessions either');
    const forgotten = ok(await meeting(owner));
    assert.equal(forgotten.vote.id, started.vote.id, 'the vote goes on');
    assert.equal(forgotten.vote.by, null, 'an erased account is no longer named as the one who started the vote');
    assert.equal(forgotten.timer.by, null, '… nor the timer');
    assert.deepEqual(
      await db.many('SELECT timer_by,vote_by FROM design_meetings WHERE file_id=$1', [id]),
      [{timer_by: null, vote_by: null}],
    );
    ok(await files(owner, `/${id}`, {method: 'DELETE'}));
    assert.equal(ok(await meeting(owner)).vote.id, started.vote.id, 'read in the trash');
    assert.equal((await timer(owner, {action: 'start', durationMs: 60_000})).status, 404);
    assert.equal((await ballot(owner, {voteId: started.vote.id, nodeId: 'C', delta: 1})).status, 404);
    ok(await files(owner, `/${id}/restore`, {method: 'POST'}));
    ok(await timer(owner, {action: 'start', durationMs: 60_000}));
    // Erasing the file takes its meeting.
    ok(await files(owner, `/${id}?permanent=1`, {method: 'DELETE'}));
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_meetings WHERE file_id=$1', [id]))!.n, 0);
  });

  await t.test('the PostgreSQL fan-out passes meeting signals and a presence too large for one notification', async () => {
    const {postgresFanOut} = await import('../server/design/live/fanout');
    const sender = postgresFanOut(),
      receiver = postgresFanOut();
    t.after(async () => {
      await sender.close();
      await receiver.close();
    });
    const got: any[] = [];
    receiver.subscribe(message => got.push(message));
    await Promise.all([sender.ready(), receiver.ready()]);
    sender.publish({kind: 'meeting', fileId: id, revision: 7, user: owner.id, by: 'conn-1'});
    const crowd = Array.from({length: 24}, (_, index) => ({
      connection: 'c' + index,
      user: 'u' + index,
      name: 'Member ' + index,
      color: index % 8,
      role: 'editor' as const,
      cursor: {x: index, y: index},
      page: 'page',
      selection: Array.from({length: 20}, (__, n) => `node-${index}-${n}`),
      selectionCount: 20,
      viewport: null,
      editing: null,
      // Cyrillic on purpose: the limit counts code points, not bytes.
      meeting: {chat: 'Ж'.repeat(MEETING_LIMITS.chatLength), emote: null, wave: null, spotlight: null},
    }));
    sender.publish({kind: 'presence', fileId: id, peers: crowd, left: ['gone-1']});
    // Over 1 MB (a crowd selecting 200 layers each with long ids): whole, without the selections.
    const huge = crowd.map((peer, index) => ({...peer, selection: Array.from({length: 200}, (__, n) => `${'x'.repeat(400)}-${index}-${n}`), selectionCount: 200}));
    sender.publish({kind: 'presence', fileId: id, peers: huge, left: []});
    const deadline = Date.now() + 8_000;
    while (got.length < 3 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(got.length, 3);
    assert.deepEqual(got[0], {kind: 'meeting', fileId: id, revision: 7, user: owner.id, by: 'conn-1'});
    // Longer than one notification (8 000 bytes): one event in parts, every person's chat and selection kept.
    assert.deepEqual(got[1], {kind: 'presence', fileId: id, peers: crowd, left: ['gone-1']});
    assert.equal(got[2].peers.length, 24);
    assert.ok(got[2].peers.every((peer: {selection: string[]; meeting: {chat: string}}) => peer.selection.length === 0 && peer.meeting.chat.length === MEETING_LIMITS.chatLength));
  });
});
