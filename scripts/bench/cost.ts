// K-rows of docs/TARGETS.md §8, derived from the load runs of collab-load.ts (TARGETS: "cost.ts prints from the load run").
//
//   tsx scripts/bench/cost.ts --machine dev-4 [--only K1,K2,K3]
//
// K1 scales the "pair" run (5 editors on f20k, 1 op/s each, cursors 30 Hz) to 1 000 editors: the server CPU an editor costs ×
// 1 000, and resident memory = one open f20k document (the "memory" run) × 200 files + the process. Legacy is one Node process,
// so past one core it cannot go at all; the number says how many cores the same work would need. K2 prices that at a Russian
// cloud provider: a dedicated 8 vCPU / 16 GB VM at 4 300 ₽ a month, from the provider's price list of 2026-10-06
// (BENCH_RUB_PER_8x16 overrides). K3 = WAL bytes (pg_stat_wal) over the saves of the "pair" run.
import {SCENARIOS, memoryPerDocument, scenario as collabScenario, serverCores, type ScenarioResult} from './collab-load';
import {fillNa, runStandalone, wants, type Bench} from './lib/context';
import {Histogram} from './lib/histogram';
import type {RowResult} from './lib/targets';

const RUB_PER_VM = Number(process.env.BENCH_RUB_PER_8x16 || 4300);
const VM = {cores: 8, ramGb: 16};
const EDITORS = 1000;
const PER_FILE = 5;

const run: Bench = async ctx => {
  const results: RowResult[] = [];
  let pair: ScenarioResult;
  try {
    pair = await collabScenario(ctx, SCENARIOS.pair);
  } catch (error) {
    return fillNa(ctx, [], `the pair load run failed: ${String((error as Error).message ?? error).slice(0, 160)}`);
  }
  const editors = pair.scenario.editors * pair.scenario.files;
  const coresPerEditor = serverCores(pair.server) / editors;
  const cores = coresPerEditor * EDITORS;
  let memory = ctx.shared.get('collab:memory') as Awaited<ReturnType<typeof memoryPerDocument>> | undefined;
  if (!memory && wants(ctx, 'K1', 'K2')) {
    memory = await memoryPerDocument(ctx);
    ctx.shared.set('collab:memory', memory);
  }
  const ramGb = memory ? ((EDITORS / PER_FILE) * memory.perDocMb + memory.rss1 / 2 ** 20) / 1024 : NaN;
  const prov = pair.load.provisional ? `load average up to ${pair.load.max.toFixed(1)}` : undefined;
  if (wants(ctx, 'K1'))
    results.push({id: 'K1', values: {cores, ram: ramGb}, provisional: prov,
      notes: [`K1: extrapolated from the pair run (${editors} editors on f20k, ${Histogram.from(pair.server.patch).count} saves, ${serverCores(pair.server).toFixed(2)} cores ⇒ ${(coresPerEditor * 1000).toFixed(0)} millicores an editor) to 1 000 editors in 200 files; RAM = 200 open f20k documents × ${memory?.perDocMb.toFixed(0) ?? '–'} MB + the process; legacy runs one Node process, so it cannot use more than one core however many it would need`]});
  if (wants(ctx, 'K2')) {
    const vms = Math.max(cores / VM.cores, ramGb / VM.ramGb);
    results.push({id: 'K2', values: {rub: (vms * RUB_PER_VM) / EDITORS}, provisional: prov,
      notes: [`K2: ${vms.toFixed(1)} VMs of 8 vCPU / 16 GB at ${RUB_PER_VM} ₽ a month (a Russian cloud provider's price list, 2026-10-06) for K1's cores and RAM, over 1 000 editors; an estimate: the provider's quote and the database/S3 costs are not in it`]});
  }
  if (wants(ctx, 'K3')) {
    const saves = Histogram.from(pair.server.patch).count;
    const wal = pair.server.walBytes;
    results.push(wal !== null && saves ? {id: 'K3', values: {wal: wal / saves / 1024}, provisional: prov, notes: [`K3: ${(wal / 2 ** 20).toFixed(2)} MB of WAL (pg_stat_wal, the lane's own cluster) over ${saves} saves of 20 moved layers on f20k, with legacy's whole-text catch-up every 120 changes`]} : {id: 'K3', na: 'pg_stat_wal not readable'});
  }
  return fillNa(ctx, results, 'not run');
};

export default run;
await runStandalone('cost', run, import.meta.url);
