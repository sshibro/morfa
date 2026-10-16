import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import type {Server} from 'node:http';
import type {TestContext} from 'node:test';
import {createPostgresqlRuntimeFixture} from './postgresql-runtime';
import {startCollab, type Collab} from './collab-binary';
import {createDocument, createNode} from '../../shared/design/defaults';
import {beginTransaction} from '../../shared/design/transaction';
import type {DesignDocument} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {parseEvents} from '../../src/design/realtime/stream';

// The whole app on a migrated PostgreSQL database with lane B1's collab binary beside it, for the api's collab tests (lane B6):
// accounts with sessions, requests as one of them, SSE streams, and collab on the same database (B2's journal, lease and
// checkpoints) with the api's DESIGN_COLLAB_* settings pointing at it.

export type Account = {id: string; token: string};
export type Answer = {status: number; data: any};
export type Init = RequestInit & {json?: unknown};
type Event = {event: string; data: any};

export const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

/** A small page: frame F with rectangles a, b and c. */
export function smallDocument(): DesignDocument {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'F', x: 0, y: 0, width: 400, height: 400}), 'page');
  for (const [k, id] of ['a', 'b', 'c'].entries()) tx.create(createNode('RECTANGLE', {id, x: 10 + 50 * k, y: 10, width: 40, height: 40}), 'F');
  return tx.commit({measurer}).doc;
}

export async function collabApp(t: TestContext, options: {env?: NodeJS.ProcessEnv; collab?: boolean | {pg?: boolean; env?: Record<string, string>}} = {}) {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const keys = ['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN', 'DESIGN_LIVE_FANOUT', 'ERASURE_LEDGER_PATH', 'DESIGN_LIVE_REVALIDATE_MS',
    'DESIGN_COLLAB', 'DESIGN_COLLAB_ACCOUNTS', 'DESIGN_COLLAB_NODES', 'DESIGN_COLLAB_INTERNAL_SECRET', 'DESIGN_COLLAB_TICKET_KEY', 'DESIGN_CHECKPOINT_DIR',
    'DESIGN_COLLAB_SHADOW_LOG', 'DESIGN_DOCUMENT_DELTA_BYTES', 'DESIGN_DOCUMENT_COMPACT_MS', ...Object.keys(options.env ?? {})];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, {
    ENABLE_DESIGN_TOOL: '1',
    ERASURE_LEDGER_PATH: path.join(f.dataDir, 'ledger', 'erasure.jsonl'),
    DESIGN_COLLAB_SHADOW_LOG: path.join(f.dataDir, 'collab-shadow', 'mismatches.jsonl'),
    ...options.env,
  });
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../../server/auth');
  const hub = await import('../../server/design/live/hub');
  const {app, drainAppTasks} = await import('../../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  let collab: Collab | null = null;
  if (options.collab) {
    const pg = typeof options.collab === 'object' ? options.collab.pg !== false : true;
    const env = typeof options.collab === 'object' ? options.collab.env : undefined;
    collab = await startCollab({pgUrl: pg ? f.isolated.runtimeUrl : undefined, apiUrl: base, env});
    Object.assign(process.env, collab.apiEnv);
  }
  const streams: (() => void)[] = [];
  t.after(async () => {
    for (const close of streams) close();
    hub.closeDesignLiveStreams();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await hub.resetLiveFanOut();
    await collab?.stop();
    (await import('../../server/design/collab/leases')).stopCollabHealth();
    (await import('../../server/design/collab/reconcile')).stopCollabSwitch();
    await drainAppTasks().catch(() => undefined);
  });

  async function account(label: string, name = 'Designer ' + label): Promise<Account> {
    const id = `collab:${label}:${randomUUID()}`,
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

  /** An open SSE stream of `fileId` as `who`. */
  async function live(who: Account, fileId: string, since?: number) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/design-files/${fileId}/events${since !== undefined ? `?since=${since}` : ''}`, {headers: {cookie: cookie(who)}, signal: controller.signal});
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
      status: response.status,
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
          if (done) assert.fail(`the stream ended before «${name}» (${JSON.stringify(events.map(event => event.event))})`);
          if (Date.now() > deadline) assert.fail(`no «${name}» within ${timeoutMs} ms (${JSON.stringify(events.map(event => event.event))})`);
          await new Promise<void>(resolve => {
            waiters.push(resolve);
            setTimeout(resolve, 200);
          });
        }
      },
      close,
    };
  }

  /** Waits until `check` holds (polling). */
  async function until<T>(check: () => Promise<T | undefined | null | false>, timeoutMs = 10_000, what = 'the condition'): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() > deadline) assert.fail(`${what} did not hold within ${timeoutMs} ms`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  return {f, db, base, app, collab, account, fetchAs, files, teams, ok, live, until, cookie};
}
