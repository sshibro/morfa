import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Server} from 'node:http';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {insertText} from '../shared/design/text-edit';
import {parseEvents} from '../src/design/realtime/stream';
import {EMPTY_PRESENCE} from '../shared/design/live';

// Co-editing and presence against the real PostgreSQL schema, through the whole app (docs/design-tool.md "Co-editing"): saves made on older versions merge, the answer catches the editor up, the event stream carries the
// others' changes and presence, a demoted editor turns read-only and a removed member is cut off at once, a signed-out
// session within the revalidation time, limits hold, and the PostgreSQL fan-out passes events between processes.

type Account = {id: string; token: string};
type Answer = {status: number; data: any};
type Init = RequestInit & {json?: unknown};
type Event = {event: string; data: any};

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function document(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'F', x: 0, y: 0, width: 400, height: 400}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'a', x: 10, y: 10, width: 40, height: 40}), 'F');
  tx.create(createNode('TEXT', {id: 't', x: 10, y: 100, width: 300, height: 20, text: {...defaultTextProps('Hello world'), textAutoResize: 'NONE'}}), 'F');
  return tx.commit({measurer}).doc;
}

test('"Morfa Design" co-editing: merges, streams, presence, access and limits', {timeout: 600000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const values: NodeJS.ProcessEnv = {
    ENABLE_DESIGN_TOOL: '1',
    ERASURE_LEDGER_PATH: path.join(f.dataDir, 'ledger', 'erasure.jsonl'),
    DESIGN_LIVE_REVALIDATE_MS: '400',
    DESIGN_LIVE_HEARTBEAT_MS: '300',
  };
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
  const engine = await import('../shared/design/engine-switch');
  const {serverMeasurer} = await import('../server/design/wasm-engine');
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

  async function account(label: string, name = 'Designer ' + label): Promise<Account> {
    const id = `live:${label}:${randomUUID()}`,
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

  /** An open event stream: every event read so far, and a wait for the next matching one. */
  async function live(who: Account, fileId: string, since?: number) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/design-files/${fileId}/events${since !== undefined ? `?since=${since}` : ''}`, {headers: {cookie: cookie(who)}, signal: controller.signal});
    const events: Event[] = [];
    let waiters: (() => void)[] = [];
    let done = false;
    const ended = (async () => {
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
      status: response.status,
      refusal: response.ok ? null : await response.json(),
      events,
      ended,
      get done() {
        return done;
      },
      /** The next event named `name` (after those already taken) matching `match`. */
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
          if (done) assert.fail(`the stream ended before "${name}" (${JSON.stringify(events.map(event => event.event))})`);
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
      /** Events named `name` that arrived so far (taken or not). */
      seen: (name: string) => events.filter(event => event.event === name).map(event => event.data),
      close,
    };
  }
  const settleStreams = () => new Promise(resolve => setTimeout(resolve, 150));
  const patch = (who: Account, id: string, body: Record<string, unknown>) => files(who, `/${id}/document`, {method: 'PATCH', json: body});

  const owner = await account('owner', 'Anna Smith');
  const editor = await account('editor', 'Boris');
  const viewer = await account('viewer', 'Vera');
  const outsider = await account('outsider');
  const lonely = await account('lonely', '');

  const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
  for (const [who, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
    const link = ok(await teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1}}), 201);
    ok(await teams(who, `/invites/${link.token}/accept`, {method: 'POST'}));
  }
  const doc = document();
  const file = ok(await files(owner, '', {method: 'POST', json: {name: 'Mockup', document: doc, teamId}}), 201).file;
  const id = file.id as string;
  const node = (key: string) => doc.nodes[key];

  await t.test('streams open for members only, with a hello that names the role and the people in the file', async () => {
    const stranger = await live(outsider, id);
    assert.equal(stranger.status, 404);
    const a = await live(owner, id, 1);
    assert.equal(a.status, 200);
    const hello = await a.next('hello');
    assert.equal(hello.version, 1);
    assert.equal(hello.canEdit, true);
    assert.equal(hello.name, 'Anna Smith');
    assert.deepEqual(hello.peers, []);
    const b = await live(editor, id, 1);
    const second = await b.next('hello');
    assert.deepEqual(second.peers.map((peer: {user: string}) => peer.user), [owner.id]);
    assert.notEqual(second.color, hello.color, 'two people get two colours');
    const joined = await a.next('presence', data => data.peers.some((peer: {user: string}) => peer.user === editor.id));
    assert.equal(joined.peers.find((peer: {user: string}) => peer.user === editor.id).name, 'Boris');
    a.close();
    b.close();
    await settleStreams();
  });

  await t.test('a save made on an older version merges field by field and the answer catches the editor up', async () => {
    const a = await live(owner, id, 1), b = await live(editor, id, 1);
    const helloA = await a.next('hello'), helloB = await b.next('hello');
    // Both start from version 1: the owner moves a, the editor renames it and types at the end of the text.
    const first = ok(await patch(owner, id, {baseVersion: 1, patch: {nodes: {a: {...node('a'), x: 99}}}, before: {a: node('a')}, client: helloA.connection}));
    assert.equal(first.version, 2);
    assert.equal(first.own, undefined, 'stored as sent');
    const change = await b.next('change');
    assert.equal(change.version, 2);
    assert.equal(change.patch.nodes.a.x, 99);
    assert.equal(change.by, helloA.connection);
    const text = node('t').text!;
    const second = ok(await patch(editor, id, {
      baseVersion: 1,
      patch: {nodes: {a: {...node('a'), name: 'Button'}, t: {...node('t'), text: insertText(text, text.characters.length, text.characters.length, '!')}}},
      before: {a: node('a'), t: node('t')},
      client: helloB.connection,
    }));
    assert.equal(second.version, 3);
    assert.deepEqual(second.changes.map((each: {version: number}) => each.version), [2]);
    assert.equal(second.own.nodes.a.x, 99, 'the owner’s move stays');
    assert.equal(second.own.nodes.a.name, 'Button');
    const opened = ok(await files(owner, `/${id}`));
    assert.equal(opened.file.version, 3);
    assert.equal(opened.document.nodes.a.x, 99);
    assert.equal(opened.document.nodes.a.name, 'Button');
    assert.equal(opened.document.nodes.t.text.characters, 'Hello world!');
    // The owner's stream got the editor's change; neither got its own.
    assert.equal((await a.next('change')).version, 3);
    assert.deepEqual(a.seen('change').map(each => each.version), [3]);
    assert.deepEqual(b.seen('change').map(each => each.version), [2]);
    a.close();
    b.close();
    await settleStreams();
  });

  await t.test('the save path runs on the server\'s Rust build (lane L6): merge and check in wasm, layout on the server', async () => {
    // The ops module in `wasm` unless the run already asks for wasm or both (MORFA_ENGINE_OPS): never a silent TypeScript.
    const restore = engine.engineFor('ops') === 'ts' ? engine.setEngine('ops', 'wasm') : () => {};
    const layout = process.env.DESIGN_SERVER_LAYOUT;
    try {
      engine.resetEngineCalls('ops');
      process.env.DESIGN_SERVER_LAYOUT = '0';
      const current = ok(await files(owner, `/${id}`));
      const v = current.file.version as number, a = current.document.nodes.a as SceneNode;
      // Made on an older version: the merge combines it with what came after.
      const merged = ok(await patch(editor, id, {baseVersion: v - 1, patch: {nodes: {a: {...a, y: 33}}}, before: {a}}));
      assert.equal(merged.own.nodes.a.y, 33);
      assert.equal(merged.layout, undefined, 'the editor lays out (DESIGN_SERVER_LAYOUT off)');
      const calls = engine.engineCalls('ops');
      assert.ok(calls.wasm > 0, `the server's ops ran in wasm: ${JSON.stringify(calls)}`);
      assert.equal(calls.diffs, 0);
      assert.equal(calls.fallback, 0);
      // DESIGN_SERVER_LAYOUT=1: an auto-width text sent with a wrong size comes back measured by the server's shaper.
      process.env.DESIGN_SERVER_LAYOUT = '1';
      const now = ok(await files(owner, `/${id}`));
      const t0 = now.document.nodes.t as SceneNode;
      const wide = {...t0, width: 5, height: 5, text: {...t0.text!, textAutoResize: 'WIDTH_AND_HEIGHT' as const}};
      const laid = ok(await patch(owner, id, {baseVersion: now.file.version, patch: {nodes: {t: wide}}, before: {t: t0}}));
      assert.equal(laid.layout, 'server');
      const text = laid.own.nodes.t as SceneNode;
      const style = text.text!.style;
      const width = serverMeasurer().width(text.text!.characters, {family: style.fontFamily, weight: style.fontWeight, italic: style.italic, size: style.fontSize});
      assert.ok(Math.abs(text.width - width) < 1, `the server measured "${text.text!.characters}": ${text.width} vs ${width}`);
      assert.ok(text.height > 5);
      assert.equal(serverMeasurer().misses, 0);
      const stored = ok(await files(owner, `/${id}`)).document.nodes.t;
      assert.equal(stored.width, text.width, 'stored laid out');
    } finally {
      if (layout === undefined) delete process.env.DESIGN_SERVER_LAYOUT;
      else process.env.DESIGN_SERVER_LAYOUT = layout;
      restore();
    }
  });

  await t.test('two people adding layers to one frame at once both keep theirs; a stale save without copies is still 409', async () => {
    const current = ok(await files(owner, `/${id}`));
    const v = current.file.version as number, frame = current.document.nodes.F as SceneNode;
    const add = (who: Account, layer: string) => patch(who, id, {
      baseVersion: v,
      patch: {nodes: {[layer]: createNode('RECTANGLE', {id: layer, parentId: 'F', x: 200, y: 200}), F: {...frame, children: [...frame.children!, layer]}}},
      before: {[layer]: null, F: frame},
    });
    const [one, two] = await Promise.all([add(owner, 'fromOwner'), add(editor, 'fromEditor')]);
    ok(one);
    ok(two);
    const after = ok(await files(owner, `/${id}`)).document;
    assert.deepEqual(after.nodes.F.children.slice(-2).sort(), ['fromEditor', 'fromOwner']);
    const stale = await patch(owner, id, {baseVersion: v, patch: {nodes: {a: {...after.nodes.a, x: 1}}}});
    assert.equal(stale.status, 409);
    assert.equal(stale.data.code, 'version_conflict');
  });

  await t.test('a viewer sees changes live and cannot write', async () => {
    const before = ok(await files(viewer, `/${id}`));
    assert.equal(before.access.canEdit, false);
    const v = await live(viewer, id, before.file.version);
    const hello = await v.next('hello');
    assert.equal(hello.canEdit, false);
    const a = before.document.nodes.a as SceneNode;
    ok(await patch(owner, id, {baseVersion: before.file.version, patch: {nodes: {a: {...a, y: 55}}}, before: {a}}));
    assert.equal((await v.next('change')).patch.nodes.a.y, 55);
    const refused = await patch(viewer, id, {baseVersion: before.file.version + 1, patch: {nodes: {a: {...a, y: 1}}}, before: {a}});
    assert.equal(refused.status, 403);
    v.close();
    await settleStreams();
  });

  await t.test('a comment written on the file reaches its open streams as a bare "comments" event', async () => {
    const before = ok(await files(viewer, `/${id}`));
    const v = await live(viewer, id, before.file.version);
    await v.next('hello');
    const pageId = before.document.pages[0];
    ok(await files(owner, `/${id}/comments`, {method: 'POST', json: {anchor: {pageId, x: 10, y: 20, nodeId: null, offset: null}, text: 'Fix the spacing', mentions: []}}), 201);
    assert.deepEqual(await v.next('comments'), {}, 'nothing of the comment rides the stream');
    v.close();
    await settleStreams();
  });

  await t.test('presence: the stream’s secret and the same session; others see the cursor; a flood is cut', async () => {
    const a = await live(owner, id), b = await live(editor, id);
    const hello = await a.next('hello');
    await b.next('hello');
    const post = (who: Account, body: unknown) => files(who, `/${id}/presence`, {method: 'POST', json: body});
    assert.equal((await post(owner, {token: hello.token, cursor: {x: 10, y: 20}, page: 'page', selection: ['a'], viewport: {x: 0, y: 0, zoom: 1, width: 800, height: 600}})).status, 204);
    const seen = await b.next('presence', data => data.peers.some((peer: {connection: string; cursor: unknown}) => peer.connection === hello.connection && peer.cursor));
    const peer = seen.peers.find((each: {connection: string}) => each.connection === hello.connection);
    assert.deepEqual(peer.cursor, {x: 10, y: 20});
    assert.deepEqual(peer.selection, ['a']);
    assert.equal(peer.selectionCount, 1);
    assert.equal(peer.page, 'page');
    // Another session (even of a member) cannot speak for this stream; an unknown secret neither.
    assert.equal((await post(editor, {token: hello.token, cursor: {x: 1, y: 1}})).status, 404);
    assert.equal((await post(owner, {token: 'x'.repeat(32), cursor: {x: 1, y: 1}})).status, 404);
    assert.equal((await post(owner, {token: hello.token, cursor: {x: Infinity, y: 1}})).status, 400);
    assert.equal((await post(owner, {token: hello.token, selection: Array.from({length: 201}, (_, i) => 'n' + i)})).status, 400);
    const statuses = await Promise.all(Array.from({length: 120}, (_, i) => post(owner, {token: hello.token, cursor: {x: i, y: i}}).then(answer => answer.status)));
    assert.ok(statuses.includes(429), 'a flood of posts is limited');
    // A stream is never sent its own presence (the editor never shows itself): only the others'.
    await b.next('presence', data => data.peers.some((each: {connection: string; cursor: {x: number} | null}) => each.connection === hello.connection && each.cursor?.x !== 10));
    assert.ok(!a.events.some(each => each.event === 'presence' && each.data.peers.some((other: {connection: string}) => other.connection === hello.connection)), 'its own moves never come back');
    // A cursor post is no one's action: the activity journal (one row, an account lock, a global lock and a count of the whole
    // journal per recorded request) never hears of them, while the account's other requests are recorded as before.
    await (await import('../server/admin/telemetry')).drainTelemetry();
    const journal = await db.many<{action: string}>('SELECT action FROM admin_activity WHERE user_id=$1', [owner.id]);
    assert.ok(journal.length > 0, 'the account’s requests are recorded');
    assert.deepEqual(journal.filter(row => row.action.includes('presence')), []);
    a.close();
    const left = await b.next('leave', data => data.connection === hello.connection);
    assert.equal(left.connection, hello.connection);
    b.close();
    await settleStreams();
  });

  await t.test('a demoted editor turns read-only live; a removed member is cut off at once', async () => {
    // A minute between routine checks: what follows is the team routes' own nudge, not the timer.
    process.env.DESIGN_LIVE_REVALIDATE_MS = '60000';
    t.after(() => void (process.env.DESIGN_LIVE_REVALIDATE_MS = '400'));
    const e = await live(editor, id), v = await live(viewer, id);
    await e.next('hello');
    await v.next('hello');
    process.env.DESIGN_LIVE_REVALIDATE_MS = '400';
    ok(await teams(owner, `/${teamId}/members/${editor.id}`, {method: 'PATCH', json: {role: 'viewer'}}));
    const access = await e.next('access', undefined, 3_000);
    assert.deepEqual(access, {role: 'viewer', canEdit: false});
    const current = ok(await files(owner, `/${id}`));
    const a = current.document.nodes.a as SceneNode;
    assert.equal((await patch(editor, id, {baseVersion: current.file.version, patch: {nodes: {a: {...a, x: 3}}}, before: {a}})).status, 403);
    ok(await teams(owner, `/${teamId}/members/${editor.id}`, {method: 'PATCH', json: {role: 'editor'}}));
    assert.deepEqual(await e.next('access', undefined, 3_000), {role: 'editor', canEdit: true});
    ok(await teams(owner, `/${teamId}/members/${viewer.id}`, {method: 'DELETE'}));
    assert.deepEqual(await v.next('bye', undefined, 3_000), {reason: 'access'});
    await v.ended;
    assert.equal((await live(viewer, id)).status, 404);
    e.close();
    await settleStreams();
  });

  await t.test('a signed-out session stops receiving within the revalidation time', async () => {
    const e = await live(editor, id);
    await e.next('hello');
    await db.execute('DELETE FROM sessions WHERE user_id=$1', [editor.id]);
    assert.deepEqual(await e.next('bye', undefined, 4_000), {reason: 'session'});
    await e.ended;
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(editor.token), editor.id, Date.now() + 3_600_000]);
  });

  await t.test('one account in two tabs of a personal file: each tab gets the other’s changes; resume replays what was missed', async () => {
    const mine = ok(await files(lonely, '', {method: 'POST', json: {name: 'Personal', document: document()}}), 201).file.id as string;
    const one = await live(lonely, mine, 1), two = await live(lonely, mine, 1);
    const helloOne = await one.next('hello'), helloTwo = await two.next('hello');
    assert.equal(helloOne.name, 'Member', 'an account without a name is "Member"');
    assert.deepEqual(helloTwo.peers.map((peer: {connection: string}) => peer.connection), [helloOne.connection]);
    const a = node('a');
    ok(await patch(lonely, mine, {baseVersion: 1, patch: {nodes: {a: {...a, x: 1}}}, before: {a}, client: helloOne.connection}));
    ok(await patch(lonely, mine, {baseVersion: 2, patch: {nodes: {a: {...a, x: 2}}}, before: {a: {...a, x: 1}}, client: helloOne.connection}));
    assert.equal((await two.next('change')).version, 2);
    assert.equal((await two.next('change')).version, 3);
    assert.deepEqual(one.seen('change'), []);
    two.close();
    const late = await live(lonely, mine, 1);
    await late.next('hello');
    assert.deepEqual([(await late.next('change')).version, (await late.next('change')).version], [2, 3]);
    // A whole new document (an import) makes every open tab reload; a rename shows at once; the trash ends the streams.
    ok(await files(lonely, `/${mine}/document`, {method: 'PUT', json: {baseVersion: 3, document: document()}}));
    assert.equal((await one.next('resync')).version, 4);
    ok(await files(lonely, `/${mine}`, {method: 'PATCH', json: {name: 'New name'}}));
    assert.deepEqual(await one.next('file'), {name: 'New name'});
    // A save on an old version after a reload is answered "reload" (the log no longer holds what came before).
    const answer = ok(await patch(lonely, mine, {baseVersion: 2, patch: {nodes: {a: {...a, x: 5}}}, before: {a}}));
    assert.equal(answer.resync, true);
    ok(await files(lonely, `/${mine}`, {method: 'DELETE'}));
    assert.deepEqual(await one.next('bye'), {reason: 'trashed'});
    late.close();
    await settleStreams();
  });

  await t.test('stream limits: per account, per file and on the server', async () => {
    process.env.DESIGN_LIVE_STREAMS_PER_ACCOUNT = '2';
    try {
      const one = await live(owner, id), two = await live(owner, id);
      await one.next('hello');
      await two.next('hello');
      const third = await live(owner, id);
      assert.equal(third.status, 429);
      assert.equal(third.refusal.code, 'design_live_busy');
      one.close();
      two.close();
      await settleStreams();
      process.env.DESIGN_LIVE_STREAMS = String(hub.liveState().streams + 1);
      const fourth = await live(owner, id);
      await fourth.next('hello');
      assert.equal((await live(editor, id)).status, 429);
      fourth.close();
      await settleStreams();
    } finally {
      delete process.env.DESIGN_LIVE_STREAMS_PER_ACCOUNT;
      delete process.env.DESIGN_LIVE_STREAMS;
    }
  });

  await t.test('the PostgreSQL fan-out passes events between processes', async st => {
    const {postgresFanOut} = await import('../server/design/live/fanout');
    const sender = postgresFanOut(), receiver = postgresFanOut();
    // Closed with this case: the next one publishes too, and `sender` would hear it.
    st.after(async () => {
      await sender.close();
      await receiver.close();
    });
    const got: unknown[] = [];
    receiver.subscribe(message => got.push(message));
    sender.subscribe(() => assert.fail('a process does not hear itself'));
    await Promise.all([sender.ready(), receiver.ready()]);
    sender.publish({kind: 'change', fileId: id, version: 9, patch: {nodes: {}}, by: null, user: owner.id});
    // A change longer than one notification (8 000 bytes) travels whole in parts, cut between UTF-8 characters (Cyrillic, an
    // emoji's surrogate pair), and arrives in order with the events around it.
    // The Cyrillic text is on purpose: its UTF-8 bytes are cut between characters.
    const long = {kind: 'change' as const, fileId: id, version: 10, patch: {nodes: {big: createNode('TEXT', {id: 'big', name: 'Layer 😀', text: defaultTextProps('Привет, мир 😀 '.repeat(4_000))})}}, by: null, user: owner.id};
    sender.publish(long);
    // A selection of 200 layers each for five people: whole too.
    const peers = Array.from({length: 5}, (_, k) => ({...EMPTY_PRESENCE, connection: randomUUID(), user: owner.id, name: 'Member', color: k, role: 'editor' as const, selection: Array.from({length: 200}, (_, j) => `node-${k}-${j}`), selectionCount: 200}));
    sender.publish({kind: 'presence', fileId: id, peers, left: []});
    // Only a change over 1 MB travels as its version, and the streams reload the document.
    sender.publish({kind: 'change', fileId: id, version: 11, patch: {nodes: Object.fromEntries(Array.from({length: 12}, (_, k) => [`huge${k}`, createNode('TEXT', {id: `huge${k}`, text: defaultTextProps('x'.repeat(100_000))})]))}, by: null, user: owner.id});
    sender.publish({kind: 'revalidate', teamId});
    const deadline = Date.now() + 5_000;
    while (got.length < 5 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(got.length, 5);
    assert.deepEqual(got[0], {kind: 'change', fileId: id, version: 9, patch: {nodes: {}}, by: null, user: owner.id});
    assert.deepEqual(got[1], JSON.parse(JSON.stringify(long)));
    assert.deepEqual(got[2], {kind: 'presence', fileId: id, peers, left: []});
    assert.deepEqual(got[3], {kind: 'change', fileId: id, version: 11, patch: null, by: null, user: owner.id});
    assert.deepEqual(got[4], {kind: 'revalidate', teamId});
    // Slices never split a character.
    const {splitUtf8} = await import('../server/design/live/fanout');
    // Cyrillic on purpose: multi-byte characters followed by a surrogate pair.
    const text = 'аб😀'.repeat(1000);
    for (const size of [4, 5, 7, 100, 7_820]) {
      const slices = splitUtf8(text, size);
      assert.equal(slices.join(''), text);
      for (const slice of slices) assert.ok(Buffer.byteLength(slice) <= size && !slice.includes('\ufffd'));
    }
  });

  await t.test('with two api processes a presence post that reaches the other one still moves the cursor and keeps the stream', async st => {
    // Production runs api@1 and api@2 behind Caddy (least connections, each request on its own): a stream lives on one process
    // and its presence posts land on either. A post the process could not match was answered 404, the editor took that for a
    // dead stream and reconnected, and the others saw the person's avatar, cursor and selection blink several times a second.
    const {postgresFanOut} = await import('../server/design/live/fanout');
    const {createHash} = await import('node:crypto');
    const tokenKey = (token: string) => createHash('sha256').update(token).digest('base64url');
    process.env.DESIGN_LIVE_FANOUT = 'postgres';
    await hub.resetLiveFanOut();
    // The other process, as the fan-out sees it.
    const other = postgresFanOut();
    const heard: any[] = [];
    other.subscribe(message => heard.push(message));
    st.after(async () => {
      await other.close();
      delete process.env.DESIGN_LIVE_FANOUT;
      await hub.resetLiveFanOut();
    });
    await other.ready();
    const a = await live(owner, id), b = await live(editor, id);
    const hello = await a.next('hello');
    const helloB = await b.next('hello');
    const until = async (match: (message: any) => boolean) => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = heard.find(match);
        if (found) return found;
        if (Date.now() > deadline) assert.fail(`not heard: ${JSON.stringify(heard.map(message => message.kind))}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const post = (who: Account, body: unknown) => files(who, `/${id}/presence`, {method: 'POST', json: body});

    // A post for a stream this process does not hold is taken and passed on, never refused as gone.
    const elsewhere = 'y'.repeat(32);
    assert.equal((await post(owner, {token: elsewhere, cursor: {x: 3, y: 4}})).status, 204);
    const passed = await until(message => message.kind === 'presence-post' && message.token === tokenKey(elsewhere));
    assert.deepEqual(passed, {kind: 'presence-post', fileId: id, token: tokenKey(elsewhere), session: auth.digest(owner.token), post: {cursor: {x: 3, y: 4}}});
    // Without a live session nothing goes on: a made-up cookie costs the database no notification.
    const stranger = 'z'.repeat(32);
    assert.equal((await post({id: 'nobody', token: 'not-a-session'}, {token: stranger, cursor: {x: 1, y: 1}})).status, 404);
    await post(owner, {token: 'w'.repeat(32), cursor: {x: 2, y: 2}});
    await until(message => message.kind === 'presence-post' && message.token === tokenKey('w'.repeat(32)));
    assert.ok(!heard.some(message => message.kind === 'presence-post' && message.token === tokenKey(stranger)), 'a post without a session was passed on');

    // A post the other process passes on for a stream here moves its cursor for the others; one from another session does not.
    other.publish({kind: 'presence-post', fileId: id, token: tokenKey(hello.token), session: auth.digest(editor.token), post: {cursor: {x: 666, y: 6}}});
    other.publish({kind: 'presence-post', fileId: id, token: tokenKey(hello.token), session: auth.digest(owner.token), post: {cursor: {x: 77, y: 5}, selection: ['a'], selectionCount: 1}});
    const seen = await b.next('presence', data => data.peers.some((peer: {connection: string; cursor: {x: number} | null}) => peer.connection === hello.connection && peer.cursor?.x === 77));
    assert.deepEqual(seen.peers.find((peer: {connection: string}) => peer.connection === hello.connection).selection, ['a']);
    assert.ok(!b.events.some(each => each.event === 'presence' && each.data.peers.some((peer: {cursor: {x: number} | null}) => peer.cursor?.x === 666)), 'another session cannot move the cursor');
    // The streams never ended: no leave, no second hello.
    assert.ok(!a.done && !b.done);
    assert.deepEqual(b.seen('leave'), []);
    assert.equal(a.seen('hello').length, 1);

    // A process opening the file asks who is in it, and hears it at once (not at the next announce, up to 20 s later).
    other.publish({kind: 'presence-ask', fileId: id});
    const answer = await until(message => message.kind === 'presence' && message.fileId === id && message.peers.length === 2);
    assert.deepEqual(answer.peers.map((peer: {connection: string}) => peer.connection).sort(), [hello.connection, helloB.connection].sort());
    a.close();
    b.close();
    await settleStreams();
  });

  await t.test('a save that names someone else’s stream as its own still reaches that stream', async () => {
    // `client` tells the server which stream already has the change (it is in the save's answer): it was taken on the saver's
    // word, so an editor could name another person's connection (every peer's is in the presence) and keep changes from them.
    const a = await live(owner, id), b = await live(editor, id);
    const helloA = await a.next('hello');
    await b.next('hello');
    const opened = ok(await files(owner, `/${id}`));
    const was = opened.document.nodes.a;
    const saved = ok(await patch(editor, id, {baseVersion: opened.file.version, patch: {nodes: {a: {...was, x: was.x + 7}}}, before: {a: was}, client: helloA.connection}));
    assert.equal((await a.next('change', change => change.version === saved.version)).patch.nodes.a.x, was.x + 7);
    a.close();
    b.close();
    await settleStreams();
  });

  await t.test('with two api processes two people never keep one colour, and a change heard late still reaches the streams', async st => {
    // Each process colours the people it holds from those it knows of. The first stream of a file in a process was coloured before
    // the other process said who was in the file, so two people, each on their own process, could both get the first colour. And a
    // change committed here a moment after the other process committed the one before it went out at once, while that one, heard a
    // few milliseconds later, was dropped: the editors waited for it, then reloaded the whole file.
    const {postgresFanOut} = await import('../server/design/live/fanout');
    process.env.DESIGN_LIVE_FANOUT = 'postgres';
    await hub.resetLiveFanOut();
    const fresh = ok(await files(owner, '', {method: 'POST', json: {name: 'Two of us', document: document(), teamId}}), 201).file.id as string;
    const other = postgresFanOut();
    const heard: any[] = [];
    const anna = {...EMPTY_PRESENCE, connection: randomUUID(), user: owner.id, name: 'Anna Smith', color: 0, role: 'owner' as const};
    other.subscribe(message => {
      heard.push(message);
      // Anna's process answers who is in the file, as hub.ts does: her stream opened a minute ago.
      if (message.kind === 'presence-ask' && message.fileId === fresh) other.publish({kind: 'presence', fileId: fresh, peers: [anna], left: [], opened: {[anna.connection]: Date.now() - 60_000}});
    });
    st.after(async () => {
      await other.close();
      delete process.env.DESIGN_LIVE_FANOUT;
      await hub.resetLiveFanOut();
    });
    await other.ready();
    const until = async (match: (message: any) => boolean) => {
      const deadline = Date.now() + 5_000;
      for (;;) {
        const found = [...heard].reverse().find(match);
        if (found) return found;
        if (Date.now() > deadline) assert.fail(`not heard: ${JSON.stringify(heard.filter(message => message.fileId === fresh))}`);
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    };
    const colourOf = (message: any, user: string) => message.peers.find((peer: {user: string}) => peer.user === user)?.color;

    // Boris opens the file here, Anna has it open there: he came later, so he is the one who changes colour.
    const b = await live(editor, fresh);
    await b.next('hello');
    await b.next('presence', data => data.peers.some((peer: {user: string}) => peer.user === owner.id));
    await until(message => message.kind === 'presence' && message.fileId === fresh && colourOf(message, editor.id) !== undefined && colourOf(message, editor.id) !== anna.color);
    // Someone who came after him with his new colour does not move him again.
    const boris = colourOf([...heard].reverse().find(message => message.kind === 'presence' && colourOf(message, editor.id) !== undefined), editor.id);
    const vera = {...EMPTY_PRESENCE, connection: randomUUID(), user: viewer.id, name: 'Vera', color: boris as number, role: 'viewer' as const};
    other.publish({kind: 'presence', fileId: fresh, peers: [vera], left: [], opened: {[vera.connection]: Date.now() + 60_000}});
    await b.next('presence', data => data.peers.some((peer: {user: string}) => peer.user === viewer.id));
    await settleStreams();
    assert.equal(colourOf([...heard].reverse().find(message => message.kind === 'presence' && colourOf(message, editor.id) !== undefined), editor.id), boris);

    // A change heard after the next one: both reach the stream, the log holds both in version order, nobody reloads.
    const a = await live(owner, fresh);
    const v = (await a.next('hello')).version as number;
    const n = node('a');
    other.publish({kind: 'change', fileId: fresh, version: v + 2, patch: {nodes: {a: {...n, x: 2}}}, by: null, user: editor.id});
    other.publish({kind: 'change', fileId: fresh, version: v + 1, patch: {nodes: {a: {...n, x: 1}}}, by: null, user: editor.id});
    assert.equal((await a.next('change')).version, v + 2);
    assert.equal((await a.next('change')).version, v + 1);
    assert.deepEqual(hub.changesSince(fresh, v, v + 2)?.map(change => change.version), [v + 1, v + 2]);
    // The same change heard twice goes out once.
    other.publish({kind: 'change', fileId: fresh, version: v + 1, patch: {nodes: {a: {...n, x: 1}}}, by: null, user: editor.id});
    other.publish({kind: 'change', fileId: fresh, version: v + 3, patch: {nodes: {a: {...n, x: 3}}}, by: null, user: editor.id});
    assert.equal((await a.next('change')).version, v + 3);
    assert.deepEqual(a.seen('resync'), []);
    a.close();
    b.close();
    await settleStreams();
  });
});
