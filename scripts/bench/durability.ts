// D-rows of docs/TARGETS.md §4: loadgen keeps editors saving while the server is killed (kill -9) or PostgreSQL stops answering,
// then every acked op is looked for in the stored document. Each editor moves its own layers to x0 + seq, so a layer at
// x0 + k means ops 1..k of that editor are in; an acked op with seq > k is lost.
//
//   tsx scripts/bench/durability.ts --machine dev-4 [--only D1,D2,D3] [--quick]
//
// D1 (commit time at 2 000 editors) is read from collab-load's "many" run (the COMMITs of the saves, timed in the bench server).
// The S3 blackhole of TARGETS §4 has nothing to cut in legacy (no object store): B2 adds it with its checkpoints (D5).
import {execFile} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {promisify} from 'node:util';
import path from 'node:path';
import {SCENARIOS, scenario as collabScenario} from './collab-load';
import {fillNa, runStandalone, wants, type Bench, type BenchContext} from './lib/context';
import {api, cookieOf, fixtureDocument, layersFor, sharedFile, type SharedFile} from './lib/fixtures';
import {Histogram} from './lib/histogram';
import {runLoadgen, type LoadgenConfig, type LoadgenReport} from './lib/loadgen';
import {LoadWatch, sleep} from './lib/machine';
import {clusterContainer, docker, startServer, type BenchServer} from './lib/server';
import type {RowResult} from './lib/targets';
import type {DesignDocument} from '../../shared/design/types';

/** Acked ops whose effect is missing from the stored document. */
async function lostAcked(server: BenchServer, file: SharedFile, report: LoadgenReport): Promise<{lost: number; acked: number; version: number}> {
  const opened = await api(server, file.owner, 'GET', `/api/design-files/${file.id}`);
  if (opened.status !== 200) throw Error(`reading the file back: ${opened.status}`);
  const stored = JSON.parse(opened.text) as {file: {version: number}; document: DesignDocument};
  const doc = fixtureDocument(file.fixture);
  let lost = 0, acked = 0;
  for (const editor of report.acked) {
    const layers = layersFor(doc, editor.editor);
    const applied = Math.min(...layers.map(node => Math.round(stored.document.nodes[node.id].x - node.x)));
    for (const [seq] of editor.ops) {
      acked++;
      if (seq > applied) lost++;
    }
  }
  return {lost, acked, version: stored.file.version};
}

function configFor(server: BenchServer, file: SharedFile, durationMs: number): LoadgenConfig {
  const doc = fixtureDocument(file.fixture);
  return {
    mode: 'legacy', base: server.base, origin: server.base, durationMs, rampMs: 1000, warmupMs: 1000, opIntervalMs: 1000, cursorHz: 10, recordAcked: true, threads: 2,
    files: [{id: file.id, version: file.version, editors: file.editors.map((account, k) => ({cookie: cookieOf(account), role: 'editor' as const, nodes: layersFor(doc, k)}))}],
  };
}

/** D2: kill -9 of the server while 5 editors save; restart on the same database; acked ops looked for. */
async function killUnderLoad(ctx: BenchContext): Promise<RowResult> {
  const server = await startServer({target: ctx.target, source: ctx.source, log: ctx.log});
  try {
    const file = await sharedFile(server, 'f20k', 5);
    const durationMs = ctx.quick ? 8_000 : 20_000;
    const killAt = 2_000 + durationMs - 3_000;
    const load = new LoadWatch();
    let killedAt = 0;
    const kill = setTimeout(() => {
      killedAt = performance.now();
      void server.kill();
    }, killAt);
    const report = await runLoadgen(configFor(server, file, durationMs), path.join(ctx.outDir, 'loadgen-d2.json'), ctx.log);
    clearTimeout(kill);
    if (!killedAt) throw Error('the kill did not happen during the run');
    await server.restart();
    const ready = performance.now();
    const check = await lostAcked(server, file, report);
    const converged = performance.now();
    const loadResult = load.stop();
    return {
      id: 'D2', values: {lost: check.lost, reconverged: (converged - killedAt) / 1000},
      provisional: loadResult.provisional ? `load average up to ${loadResult.max.toFixed(1)}` : undefined,
      notes: [`D2: kill -9 of the ${server.shape} server process during 5 editors' saves on f20k; restart on the same database ${((ready - killedAt) / 1000).toFixed(1)} s after the kill (legacy has no standby: a new process starts), the file read back ${((converged - ready) / 1000).toFixed(1)} s later at version ${check.version}; ${check.acked} acked ops checked, ${check.lost} missing; answers during the run ${JSON.stringify(report.statuses)}`],
    };
  } finally {
    await server.stop();
  }
}

/** How the bench's PostgreSQL is frozen: `docker pause` of the lane's cluster, or on bench-ru (lane B5) BENCH_PG_FREEZE, a
 *  command taking stop|cont (SIGSTOP/SIGCONT of every process of the VM's bench cluster, scripts/deploy/remote/morfa-pg-freeze). */
export function pgFreezer(): {name: string; pause(): Promise<unknown>; unpause(): Promise<unknown>} {
  const command = process.env.BENCH_PG_FREEZE;
  if (command) {
    const run = (verb: string) => promisify(execFile)('sh', ['-c', `${command} ${verb}`], {timeout: 30_000});
    return {name: `${command} (SIGSTOP of the bench cluster)`, pause: () => run('stop'), unpause: () => run('cont')};
  }
  const pg = clusterContainer();
  return {name: `docker pause of ${pg.container}`, pause: () => docker(['pause', pg.container]), unpause: () => docker(['unpause', pg.container])};
}

/** D3: PostgreSQL frozen (docker pause of the lane's own cluster) for 30 s under load. */
async function databaseOutage(ctx: BenchContext): Promise<RowResult> {
  const server = await startServer({target: ctx.target, source: ctx.source, log: ctx.log});
  const pg = pgFreezer();
  let paused = false;
  try {
    const file = await sharedFile(server, 'f20k', 5);
    const outageMs = ctx.quick ? 10_000 : 30_000;
    const before = 10_000, after = ctx.quick ? 10_000 : 20_000;
    const durationMs = before + outageMs + after;
    const load = new LoadWatch();
    const pauseAt = setTimeout(() => {
      paused = true;
      void pg.pause();
    }, 2_000 + before);
    const resumeAt = setTimeout(() => {
      void pg.unpause().then(() => (paused = false));
    }, 2_000 + before + outageMs);
    const report = await runLoadgen(configFor(server, file, durationMs), path.join(ctx.outDir, 'loadgen-d3.json'), ctx.log);
    clearTimeout(pauseAt);
    clearTimeout(resumeAt);
    if (paused) {
      await pg.unpause().catch(() => '');
      paused = false;
    }
    await sleep(2_000);
    const check = await lostAcked(server, file, report);
    const seconds = (from: number, to: number, series: number[]) => series.slice(from, to).reduce((a, b) => a + b, 0);
    const outFrom = Math.floor((2_000 + before) / 1000), outTo = Math.ceil((2_000 + before + outageMs) / 1000);
    const acksDuring = seconds(outFrom + 1, outTo, report.acksPerSecond), errorsDuring = seconds(outFrom, outTo + 5, report.errorsPerSecond);
    const conflicts = Object.entries(report.statuses).filter(([status]) => status.startsWith('409')).reduce((sum, [, count]) => sum + count, 0);
    const failures = Object.entries(report.statuses).filter(([status]) => /^5\d\d|^error/.test(status)).reduce((sum, [, count]) => sum + count, 0);
    const recovered = report.acksPerSecond.slice(outTo, outTo + 10).some(count => count > 0);
    const pass = failures === 0 && conflicts === 0 && check.lost === 0 && recovered;
    const loadResult = load.stop();
    return {
      id: 'D3', pass, provisional: loadResult.provisional ? `load average up to ${loadResult.max.toFixed(1)}` : undefined,
      text: `PostgreSQL frozen ${outageMs / 1000} s under 5 editors: ${acksDuring} acks and ${errorsDuring} refused or failed saves during it; answers ${JSON.stringify(report.statuses)}; ${conflicts} × 409; saves ${recovered ? 'resumed' : 'did not resume'} within 10 s; ${check.lost} of ${check.acked} acked ops missing`,
      notes: [`D3: ${pg.name}, ${outageMs / 1000} s; acks per second ${JSON.stringify(report.acksPerSecond)}`],
    };
  } finally {
    if (paused) await pg.unpause().catch(() => '');
    await server.stop();
  }
}

const run: Bench = async ctx => {
  const results: RowResult[] = [];
  if (wants(ctx, 'D1')) {
    try {
      const many = await collabScenario(ctx, SCENARIOS.many);
      const save = Histogram.from(many.server.commitSave).summary(), all = Histogram.from(many.server.commit).summary();
      results.push({id: 'D1', values: {p50: save.p50, p99: save.p99}, provisional: many.load.provisional ? `load average up to ${many.load.max.toFixed(1)}` : undefined,
        notes: [`D1: COMMIT of each save's transaction at 2 000 editors (400 f2k files), timed around pg in the bench server: legacy commits every save on its own (no group commit), ${save.count} save commits; all commits p50/p99 ${all.p50.toFixed(2)}/${all.p99.toFixed(2)} ms`]});
    } catch (error) {
      results.push({id: 'D1', na: `run failed: ${String((error as Error).message ?? error).slice(0, 200)}`});
    }
  }
  if (wants(ctx, 'D2')) {
    try {
      results.push(await killUnderLoad(ctx));
    } catch (error) {
      ctx.log(`D2 failed: ${String((error as Error).stack ?? error)}`);
      results.push({id: 'D2', na: `run failed: ${String((error as Error).message ?? error).slice(0, 200)}`});
    }
  }
  if (wants(ctx, 'D3')) {
    try {
      results.push(await databaseOutage(ctx));
    } catch (error) {
      ctx.log(`D3 failed: ${String((error as Error).stack ?? error)}`);
      results.push({id: 'D3', na: `run failed: ${String((error as Error).message ?? error).slice(0, 200)}`});
    }
  }
  if (wants(ctx, 'D4')) results.push({id: 'D4', na: 'the owner\'s replica/backup choice (★, BACKEND §8); B5 provisions the replica, then the loss bound is its lag'});
  if (wants(ctx, 'D5')) results.push({id: 'D5', na: 'legacy has no checkpoints (B2 writes them to S3 with a hash header)'});
  writeFileSync(path.join(ctx.outDir, 'durability.json'), JSON.stringify(results, null, 1));
  return fillNa(ctx, results, 'not run');
};

export default run;
await runStandalone('durability', run, import.meta.url);
