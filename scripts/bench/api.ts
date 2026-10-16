// A-rows of docs/TARGETS.md §7: the TypeScript API under 50 concurrent clients (autocannon-style: closed loops on keep-alive
// connections, each client its own account and session, so per-account limits do not decide the numbers).
//
//   tsx scripts/bench/api.ts --machine dev-4 [--only A1,A4,A5] [--quick] [--legacy]
//
// With lane B1's `morfa-collab` built (tests/helpers/collab-binary.ts finds it) and without --legacy, the server runs with
// DESIGN_COLLAB=rust and a collab node on this machine on the same database (lane B6): A2 is GET /:id/session itself (auth, ACL,
// lease, ticket) and A4 is the member's socket closed by the api's ACL push. Without it, A2 and A4 are legacy's analogs (B0).
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {fillNa, runStandalone, wants, type Bench} from './lib/context';
import {accounts, api, bench, cookieOf, createFile, team, type Account} from './lib/fixtures';
import {LoadWatch} from './lib/machine';
import {startServer, type BenchServer} from './lib/server';
import {median, summary} from './lib/stats';
import type {RowResult} from './lib/targets';
import {createDocument} from '../../shared/design/defaults';
import {collabBinary, freePort, startCollab, ticketKeys, type Collab} from '../../tests/helpers/collab-binary';
import {openSocket} from '../../tests/helpers/collab-socket';

const CONCURRENCY = 50;

/** Upper bounds (ms) of the buckets holding p50 and p95 of a Prometheus histogram in `text`. */
function serverQuantiles(text: string, name: string): {p50: number; p95: number} | null {
  const buckets = [...text.matchAll(new RegExp(`^${name}_bucket\\{le="([^"]+)"\\} (\\d+)$`, 'gm'))].map(m => ({le: m[1] === '+Inf' ? Infinity : Number(m[1]), n: Number(m[2])}));
  const total = buckets.at(-1)?.n ?? 0;
  if (!total) return null;
  const at = (q: number) => Number(((buckets.find(b => b.n >= q * total)?.le ?? Infinity) * 1000).toFixed(2));
  return {p50: at(0.5), p95: at(0.95)};
}

/** `CONCURRENCY` clients, each sending `route(client)` back to back for `ms` or `perClient` requests. */
async function hammer(server: BenchServer, clients: Account[], route: (i: number, n: number) => string, options: {ms?: number; perClient?: number}) {
  const latencies: number[] = [];
  const statuses: Record<string, number> = {};
  const end = performance.now() + (options.ms ?? Infinity);
  await Promise.all(clients.slice(0, CONCURRENCY).map(async (client, i) => {
    for (let n = 0; performance.now() < end && n < (options.perClient ?? Infinity); n++) {
      const started = performance.now();
      try {
        const response = await fetch(server.base + route(i, n), {headers: {cookie: cookieOf(client)}});
        await response.arrayBuffer();
        statuses[response.status] = (statuses[response.status] ?? 0) + 1;
      } catch {
        statuses.error = (statuses.error ?? 0) + 1;
      }
      latencies.push(performance.now() - started);
    }
  }));
  return {...summary(latencies), statuses};
}

/** Opens a live stream as `who` and resolves with the time of its first event named `name` after `armed()`. */
async function stream(server: BenchServer, who: Account, fileId: string) {
  const controller = new AbortController();
  const response = await fetch(`${server.base}/api/design-files/${fileId}/events`, {headers: {cookie: cookieOf(who)}, signal: controller.signal});
  if (!response.ok || !response.body) throw Error(`stream: ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  const seen: {event: string; at: number}[] = [];
  let waiters: (() => void)[] = [];
  void (async () => {
    let buffer = '';
    try {
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += value;
        for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const name = /^event: (\S+)/m.exec(block)?.[1];
          if (name) seen.push({event: name, at: performance.now()});
          for (const wake of waiters.splice(0)) wake();
        }
      }
    } catch {
      // Aborted.
    }
    seen.push({event: '(end)', at: performance.now()});
    for (const wake of waiters.splice(0)) wake();
  })();
  const next = async (names: string[], timeoutMs = 30_000) => {
    const deadline = performance.now() + timeoutMs;
    for (let read = 0; ; ) {
      for (; read < seen.length; read++) if (names.includes(seen[read].event)) return seen[read];
      if (performance.now() > deadline) return null;
      await new Promise<void>(resolve => {
        waiters.push(resolve);
        setTimeout(resolve, 500);
      });
    }
  };
  return {next, close: () => controller.abort(), seen};
}

const run: Bench = async ctx => {
  const results: RowResult[] = [];
  // The collab node of the rust rows, prepared before the api starts (its settings name the node).
  const withCollab = !process.argv.includes('--legacy') && !!collabBinary();
  const prepared = withCollab ? {port: await freePort(), secret: 'bench-' + Math.random().toString(36).slice(2) + '-secret', keys: ticketKeys()} : null;
  const collabHost = ctx.target === 'dev-4' ? 'host.docker.internal' : '127.0.0.1';
  const collabEnv: Record<string, string> = prepared
    ? {
        DESIGN_COLLAB: 'rust',
        DESIGN_COLLAB_NODES: `bench=http://${collabHost}:${prepared.port}|ws://127.0.0.1:${prepared.port}`,
        DESIGN_COLLAB_INTERNAL_SECRET: prepared.secret,
        DESIGN_COLLAB_TICKET_KEY: prepared.keys.privateKey,
      }
    : {};
  // BENCH_API_PORT: a lane's own port (B0's default 3410 is also collab's default address).
  const server = await startServer({target: ctx.target, source: ctx.source, log: ctx.log, env: collabEnv, port: Number(process.env.BENCH_API_PORT) || undefined});
  // BENCH_API_PROCESSES (lane A7): the api as production runs it, several processes on one port (scripts/bench/server.ts).
  if (Number(process.env.BENCH_API_PROCESSES) > 1) server.shape += `, ${process.env.BENCH_API_PROCESSES} api processes`;
  let collab: Collab | null = null;
  const load = new LoadWatch();
  const prov = () => (load.result().provisional ? `load average up to ${load.result().max.toFixed(1)}` : undefined);
  const ms = ctx.quick ? 3_000 : 10_000;
  try {
    // The node also serves /session as production's Caddy routes it there (lane A7: crates/collab/src/session.rs): with the
    // signing key and the api's own settings. BENCH_A2_VIA=api measures api's route alone.
    const nodeMints = process.env.BENCH_A2_VIA !== 'api';
    if (prepared)
      collab = await startCollab({
        ...prepared,
        node: 'bench',
        pgUrl: server.databaseUrl,
        apiUrl: server.base,
        env: nodeMints
          ? {
              MORFA_COLLAB_TICKET_PRIVATE_KEY: prepared.keys.privateKey,
              MORFA_COLLAB_SESSION_COOKIE: 'forma_session',
              MORFA_COLLAB_APP_ORIGIN: server.base,
              DESIGN_COLLAB_NODES: collabEnv.DESIGN_COLLAB_NODES,
              DESIGN_COLLAB: 'rust',
              ENABLE_DESIGN_TOOL: '1',
              ...(process.env.MORFA_COLLAB_SESSION_POOL ? {MORFA_COLLAB_SESSION_POOL: process.env.MORFA_COLLAB_SESSION_POOL} : {}),
            }
          : {},
      });
    /** BENCH_PROFILE=<row>: the server's CPU profile of that row's measured window (TARGETS §10 "Further wins"). */
    const profiled = async (row: string, stop = false) => {
      if (process.env.BENCH_PROFILE !== row) return;
      if (!stop) return void (await bench(server, 'profile/start', {}));
      const {formatHot, hotSpots} = await import('./lib/cpuprofile');
      const profile = await bench<import('./lib/cpuprofile').CpuProfile>(server, 'profile/stop', {});
      writeFileSync(path.join(ctx.outDir, `${row}.cpuprofile`), JSON.stringify(profile));
      const hot = hotSpots(profile, 40);
      ctx.log(`${row} profile: ${(hot.idleShare * 100).toFixed(0)} % idle\n${formatHot(hot.self, 'self')}\n${formatHot(hot.total, 'total')}`);
    };
    const people = await accounts(server, CONCURRENCY + 6, 'api');
    const [owner] = people;
    const members = people.slice(1);
    const teamId = await team(server, owner, members.map(account => ({account, role: 'editor' as const})));
    // The live file first: the team's 200 listed files below fill a free team's limit (10) at once.
    const file = wants(ctx, 'A2', 'A4', 'A5') ? await createFile(server, owner, 'f2k', teamId) : null;
    if (wants(ctx, 'A1')) {
      await bench(server, 'bulk-files', {owner: owner.id, teamId, count: 200, document: createDocument('page')});
      // Warm-up, then the measured window.
      await hammer(server, [owner, ...members], () => `/api/design-files?team=${teamId}`, {perClient: 2});
      await profiled('A1');
      const listed = await hammer(server, [owner, ...members], () => `/api/design-files?team=${teamId}`, {ms});
      await profiled('A1', true);
      results.push({id: 'A1', values: {p95: listed.p95, p99: listed.p99}, provisional: prov(), notes: [`A1: a team of 200 files listed by 50 members at once for ${ms / 1000} s, ${listed.count} requests (${(listed.count / (ms / 1000)).toFixed(0)}/s), p50 ${listed.p50.toFixed(1)} ms, answers ${JSON.stringify(listed.statuses)}; ${server.shape}`]});
    }
    if (wants(ctx, 'A2') && file && collab) {
      // The socket ticket itself: 50 members ask for it at once, 20 times each (inside /session's 60 opens a minute per account,
      // which api and each node count apart). Asked of the collab node when it mints (production's route), and of api's own.
      const perClient = ctx.quick ? 8 : 20;
      const ask = async (target: BenchServer) => {
        await hammer(target, members, () => `/api/design-files/${file.id}/session`, {perClient: 2});
        return hammer(target, members, () => `/api/design-files/${file.id}/session`, {perClient});
      };
      await profiled('A2');
      const viaApi = await ask(server);
      await profiled('A2', true);
      const viaNode = nodeMints ? await ask({...server, base: collab.url}) : null;
      // The node's own time per answer (its collab_session_seconds histogram, every request incl. the warm-up): what the client's
      // number adds on top is queueing in the client, the network and this machine.
      const served = viaNode ? serverQuantiles(await (await fetch(collab.url + '/metrics')).text(), 'collab_session_seconds') : null;
      const sessions = viaNode ?? viaApi;
      const line = (name: string, s: typeof sessions) => `${name}: ${s.count} requests, p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, p99 ${s.p99.toFixed(1)} ms, answers ${JSON.stringify(s.statuses)}`;
      results.push({id: 'A2', values: {p95: sessions.p95}, provisional: prov(), notes: [`A2: GET /:id/session (session cookie, file access, the lease found, an Ed25519 ticket) by 50 members at once, ${perClient} each; ${viaNode ? `${line('the collab node (crates/collab session.rs, the row)', viaNode)}${served ? ` (the node's own time p50 ≤ ${served.p50} ms, p95 ≤ ${served.p95} ms)` : ''}; ` : ''}${line("api's route", viaApi)}; ${server.shape}, collab node on this machine`]});
    } else if (wants(ctx, 'A2') && file) {
      // Legacy has no socket ticket; the nearest thing is a stream's opening: session, file access, and the hello.
      const opens = await Promise.all(members.slice(0, CONCURRENCY).map(async member => {
        const started = performance.now();
        const live = await stream(server, member, file.id);
        const hello = await live.next(['hello']);
        live.close();
        return hello ? hello.at - started : NaN;
      }));
      const s = summary(opens.filter(Number.isFinite));
      results.push({id: 'A2', na: `GET /:id/session arrives with B6; legacy's analog, 50 streams opened at once to the hello: p95 ${s.p95.toFixed(1)} ms (p50 ${s.p50.toFixed(1)})`});
    }
    if (wants(ctx, 'A3')) results.push({id: 'A3', na: 'the collab service caches ACLs (B1/B6); legacy re-reads the file\'s access from PostgreSQL every 20 s per stream'});
    if (wants(ctx, 'A4') && file && collab) {
      // A member's socket open on the file; the owner removes the member; the api pushes the ACL to the node; the socket closes.
      const walls: number[] = [];
      for (const [k, member] of members.slice(-5).entries()) {
        const session = await api(server, member, 'GET', `/api/design-files/${file.id}/session`);
        if (session.status !== 200) throw Error(`session: ${session.status} ${session.text.slice(0, 200)}`);
        const socket = await openSocket(JSON.parse(session.text), {clientId: `bench-a4-${k}`});
        const started = performance.now();
        const removed = await api(server, owner, 'DELETE', `/api/design-teams/${teamId}/members/${encodeURIComponent(member.id)}`);
        if (removed.status !== 200) throw Error(`remove member: ${removed.status} ${removed.text.slice(0, 200)}`);
        const closedAt = await socket.ended(25_000).catch(() => NaN);
        walls.push(closedAt - started);
      }
      results.push({id: 'A4', values: {wall: median(walls.filter(Number.isFinite))}, provisional: prov(), notes: [`A4: a member removed by the owner while their collab socket is open → the socket closed (api's POST /internal/acl push → bye {access}); ${walls.map(w => w.toFixed(1)).join(', ')} ms`]});
    } else if (wants(ctx, 'A4') && file) {
      const walls: number[] = [];
      for (const member of members.slice(-5)) {
        const live = await stream(server, member, file.id);
        await live.next(['hello']);
        const started = performance.now();
        const removed = await api(server, owner, 'DELETE', `/api/design-teams/${teamId}/members/${member.id}`);
        if (removed.status !== 200) throw Error(`remove member: ${removed.status} ${removed.text.slice(0, 200)}`);
        const bye = await live.next(['bye', '(end)'], 40_000);
        walls.push(bye ? bye.at - started : NaN);
        live.close();
      }
      results.push({id: 'A4', values: {wall: median(walls.filter(Number.isFinite))}, provisional: prov(), notes: [`A4: a member removed by the owner while their stream is open → the stream's bye; legacy rechecks at once in the same process (revalidateLive), ≤ 20 s across processes; ${walls.map(w => w.toFixed(0)).join(', ')} ms`]});
    }
    if (wants(ctx, 'A5') && file) {
      // Something to list: ten comment threads and five named versions.
      for (let i = 0; i < 10; i++)
        await api(server, owner, 'POST', `/api/design-files/${file.id}/comments`, {text: `Note ${i + 1}`, mentions: [], anchor: {pageId: 'page', x: 10 * i, y: 10, nodeId: null, offset: null}});
      for (let i = 0; i < 5; i++) await api(server, owner, 'POST', `/api/design-files/${file.id}/versions`, {label: `Version ${i + 1}`});
      const routes = ['comments', 'libraries', 'versions'];
      const perClient = ctx.quick ? 6 : 30;
      const mixed = await hammer(server, [owner, ...members], (i, n) => `/api/design-files/${file.id}/${routes[(i + n) % routes.length]}`, {perClient});
      results.push({id: 'A5', values: {p95: mixed.p95}, provisional: prov(), notes: [`A5: comments, libraries and versions of a team file listed by 50 members at once (${perClient} requests each, inside the comment reads' 120 a minute), ${mixed.count} requests, p50 ${mixed.p50.toFixed(1)} ms, answers ${JSON.stringify(mixed.statuses)}`]});
    }
  } finally {
    load.stop();
    await collab?.stop();
    await server.stop();
  }
  writeFileSync(path.join(ctx.outDir, 'api.json'), JSON.stringify(results, null, 1));
  return fillNa(ctx, results, 'not run');
};

export default run;
await runStandalone('api', run, import.meta.url);
