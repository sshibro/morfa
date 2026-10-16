// The shadow comparison's report (docs/BACKEND.md §7 step 2): reads DESIGN_COLLAB_SHADOW_LOG (one JSON line per
// difference between Node's document and collab's copy, server/design/collab/shadow-log.ts), the runs beside it (`runs.jsonl`:
// what each fuzz run sent and how many hashes it compared) and the cases (`cases/*.json`: the seed and every op since), and prints
// one table of runs and one of differences with the first differing path, ready to file against the merge/apply code or the
// engine. The path comes from replaying the case: Node's route in TypeScript (server/design/apply.ts, as patchDesignDocument runs
// it) against crates/ops in wasm (OpsDocument.applyDocumentChange, the merge collab's OpsEngine uses).
//
//   npx tsx scripts/collab-shadow-report.ts [<log>]   (default: DESIGN_COLLAB_SHADOW_LOG, else data/collab-shadow/mismatches.jsonl)
//   exit status 1 when the log holds any difference.

import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import type {MismatchEntry, ShadowCase} from '../server/design/collab/shadow-log';
import type {DesignDocument} from '../shared/design/types';
import type {DocumentPatch} from '../shared/design/patch';

export type ShadowRun = {
  at: string;
  label: string;
  /** Ops sent through PATCH, and what Node did with them. */
  ops: number;
  stored: number;
  empty: number;
  refused: number;
  merged: number;
  /** What the forwarder did (shadow.ts `shadowStats`). */
  forwarded: number;
  seeded: number;
  compared: number;
  equal: number;
  mismatches: number;
  refusals: number;
  unavailable: number;
  dropped: number;
  seconds: number;
};

export type ShadowDifference = MismatchEntry & {path: string};

const lines = <T>(file: string): T[] =>
  existsSync(file)
    ? readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as T)
    : [];

/** The first differing path of a case: its ops replayed through Node's route (TypeScript) and crates/ops (wasm). */
export async function differingPath(shadowCase: ShadowCase): Promise<string> {
  const {applyDocumentChange} = await import('../server/design/apply');
  const {isEmptyPatch} = await import('../shared/design/patch');
  const {engineWasm} = await import('../shared/design/engine-switch');
  const {firstDifference} = await import('../server/design/collab/shadow-log');
  let node: DesignDocument = shadowCase.seed;
  const rust = new (engineWasm().OpsDocument)(JSON.stringify(shadowCase.seed));
  try {
    for (const op of shadowCase.ops) {
      const change = {patch: op.patch as DocumentPatch, ...(op.before ? {before: op.before} : {}), ...(op.beforeTables ? {beforeTables: op.beforeTables} : {})};
      if (!isEmptyPatch(change.patch)) node = applyDocumentChange(node, change as Parameters<typeof applyDocumentChange>[1]).doc;
      rust.applyDocumentChange(JSON.stringify(change));
    }
    const replayed = firstDifference(JSON.parse(rust.toJson()), JSON.parse(JSON.stringify(node)));
    const recorded = firstDifference(JSON.parse(JSON.stringify(node)), JSON.parse(JSON.stringify(shadowCase.node)));
    if (replayed) return replayed;
    return recorded ? `(replay differs from Node's record at ${recorded})` : '(the replay agrees: not in merge/apply; see the hashes)';
  } finally {
    rust.free();
  }
}

export async function readShadowReport(log: string): Promise<{runs: ShadowRun[]; differences: ShadowDifference[]}> {
  const dir = path.dirname(log);
  const runs = lines<ShadowRun>(path.join(dir, 'runs.jsonl'));
  const differences: ShadowDifference[] = [];
  for (const entry of lines<MismatchEntry>(log)) {
    let where = entry.case ? '(case missing)' : '(no case: more ops since the seed than a case keeps)';
    if (entry.case && existsSync(path.join(dir, entry.case)))
      where = await differingPath(JSON.parse(readFileSync(path.join(dir, entry.case), 'utf8')) as ShadowCase).catch(error => `(replay failed: ${(error as Error).message})`);
    differences.push({...entry, path: where});
  }
  return {runs, differences};
}

export function formatShadowReport(report: {runs: ShadowRun[]; differences: ShadowDifference[]}): string {
  const out: string[] = [];
  out.push('| Run | PATCH ops | stored / kept / refused | merged | forwarded | seeded | hashes compared | equal | mismatches | collab refusals | unavailable | s |');
  out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const run of report.runs)
    out.push(`| ${run.label} (${run.at.slice(0, 16)}) | ${run.ops} | ${run.stored} / ${run.empty} / ${run.refused} | ${run.merged} | ${run.forwarded} | ${run.seeded} | ${run.compared} | ${run.equal} | **${run.mismatches}** | ${run.refusals} | ${run.unavailable} | ${run.seconds.toFixed(1)} |`);
  out.push('');
  if (!report.differences.length) out.push('Differences: none.');
  else {
    out.push('| Kind | File | Version (applied on, base) | First differing path | Node hash / collab hash | Note |');
    out.push('|---|---|---|---|---|---|');
    for (const d of report.differences)
      out.push(`| ${d.kind} | ${d.file} | ${d.version} (${d.appliedOn}, ${d.baseVersion}) | \`${d.path}\` | ${(d.nodeHash ?? '-').slice(0, 12)} / ${(d.collabHash ?? '-').slice(0, 12)} | ${d.message ?? ''}${d.refused ? ' ' + JSON.stringify(d.refused) : ''} |`);
  }
  return out.join('\n');
}

async function main() {
  const log = process.argv[2] || process.env.DESIGN_COLLAB_SHADOW_LOG || path.join(process.env.DATA_DIR || 'data', 'collab-shadow', 'mismatches.jsonl');
  const report = await readShadowReport(log);
  console.log(formatShadowReport(report));
  process.exitCode = report.differences.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
