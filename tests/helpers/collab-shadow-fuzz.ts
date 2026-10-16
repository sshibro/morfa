import {invertPatch, type DocumentPatch} from '../../shared/design/patch';
import {validateDocument} from '../../shared/design/schema';
import type {DesignDocument} from '../../shared/design/types';
import {mulberry32, patchPair, randomDocument} from './ops-fuzz';
import type {Account, Answer, Init} from './collab-app';

// The shadow comparison's load (10 000 fuzz ops through legacy PATCH with shadow-op forwarding →
// 0 hash mismatches). Per case: the ops fuzz generator (tests/helpers/ops-fuzz.ts) makes a random document and two concurrent edits
// of it with real transactions; the document goes in by PUT (collab's copy re-seeds), then both edits by PATCH on the version it
// went in at, with their `before` copies, so the second one merges onto the first at Node and at collab alike. Every case runs
// through the HTTP routes as an editor's autosave does; the forwarding is server/design/collab/shadow.ts.

export type FuzzCounts = {cases: number; ops: number; stored: number; empty: number; refused: number; skipped: number; merged: number};

/** The copies an editor sends with a patch it made on `base`. */
function copies(base: DesignDocument, patch: DocumentPatch) {
  const {nodes, ...tables} = invertPatch(base, patch);
  return {before: nodes ?? {}, ...(Object.keys(tables).length ? {beforeTables: tables} : {})};
}

/**
 * Runs `ops` fuzz ops (two per case) over the accounts' files, `parallel` files at a time. Each account owns one file (`files`
 * maps account id → file id). PUTs and PATCHes keep inside one account's limits (60 whole documents and 600 saves in 10 minutes):
 * the caller gives enough accounts (`ops / 2 / 50` and some).
 */
export async function shadowFuzz(input: {
  accounts: Account[];
  files: Map<string, string>;
  ops: number;
  seed: number;
  parallel?: number;
  request: (who: Account, suffix: string, init?: Init) => Promise<Answer>;
  progress?: (done: number) => void;
}): Promise<FuzzCounts> {
  const counts: FuzzCounts = {cases: 0, ops: 0, stored: 0, empty: 0, refused: 0, skipped: 0, merged: 0};
  const cases = Math.ceil(input.ops / 2);
  const perAccount = Math.ceil(cases / input.accounts.length);
  if (perAccount > 55) throw Error(`shadowFuzz: ${cases} cases need at least ${Math.ceil(cases / 55)} accounts (PUT is 60 per 10 minutes per account)`);
  let next = 0;
  const versions = new Map<string, number>();
  const worker = async (who: Account) => {
    const fileId = input.files.get(who.id)!;
    for (let k = 0; k < perAccount; k++) {
      const index = next++;
      if (index >= cases) return;
      const rng = mulberry32(input.seed * 1_000_003 + index);
      const base = randomDocument(rng);
      if (!validateDocument(base).ok) {
        counts.skipped++;
        continue;
      }
      const {theirs, ours} = patchPair(base, rng);
      const current = versions.get(fileId) ?? 1;
      const put = await input.request(who, `/${fileId}/document`, {method: 'PUT', json: {baseVersion: current, document: base}});
      if (put.status !== 200) throw Error(`PUT ${fileId} at ${current}: ${put.status} ${JSON.stringify(put.data)}`);
      let version = put.data.version as number;
      const at = version;
      counts.cases++;
      for (const [n, edit] of [theirs, ours].entries()) {
        const answer = await input.request(who, `/${fileId}/document`, {method: 'PATCH', json: {baseVersion: at, patch: edit.patch, ...copies(base, edit.patch)}});
        counts.ops++;
        if (answer.status === 200) {
          if (answer.data.version > version) {
            counts.stored++;
            if (n === 1 && version > at) counts.merged++;
            version = answer.data.version;
          } else counts.empty++;
        } else if (answer.status === 400) counts.refused++;
        else throw Error(`PATCH ${fileId}: ${answer.status} ${JSON.stringify(answer.data)}`);
      }
      versions.set(fileId, version);
      input.progress?.(counts.ops);
    }
  };
  const parallel = input.parallel ?? 8;
  for (let start = 0; start < input.accounts.length; start += parallel) await Promise.all(input.accounts.slice(start, start + parallel).map(worker));
  return counts;
}

/** Appends one run to `runs.jsonl` beside the mismatch log (scripts/collab-shadow-report.ts reads it). */
export async function recordShadowRun(log: string, label: string, counts: FuzzCounts, stats: Record<string, number>, seconds: number) {
  const {appendFile, mkdir} = await import('node:fs/promises');
  const path = await import('node:path');
  await mkdir(path.dirname(log), {recursive: true});
  const run = {
    at: new Date().toISOString(),
    label,
    ops: counts.ops,
    stored: counts.stored,
    empty: counts.empty,
    refused: counts.refused,
    merged: counts.merged,
    forwarded: stats.forwarded,
    seeded: stats.seeded,
    compared: stats.compared,
    equal: stats.equal,
    mismatches: stats.mismatches,
    refusals: stats.refusals,
    unavailable: stats.unavailable,
    dropped: stats.dropped,
    seconds,
  };
  await appendFile(path.join(path.dirname(log), 'runs.jsonl'), JSON.stringify(run) + '\n');
}
