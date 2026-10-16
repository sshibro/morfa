// The shadow comparison: `/internal/shadow-op` of a running
// morfa-collab must hold the same document as the Node route after every op, for 10 000 patch pairs.
//
//   MORFA_COLLAB_INTERNAL_SECRET=s morfa-collab serve &
//   npx tsx crates/collab/harness/shadow.ts http://127.0.0.1:3410 s [cases=10000] [seed=1]
//   (SHADOW_DUMP=<file>: on a difference, the case as JSON for crates/collab/examples/shadow_case.rs)
//
// Per case: a random document and two concurrent edits made on it with real transactions (lane L2a's generator,
// tests/helpers/ops-fuzz.ts, standing in for S2's `fuzzPatchPair`). The first lands on the version it was made on,
// the second on the version after the first (a stale op that merges). Each is run through the TypeScript exactly as
// `patchDesignDocument` runs it (server/design/files.ts: the shape of the patch and of its copies (`validatePatch`, which
// refuses a picture URL outside `/uploads/<file>` as the Rust validator does), empty patch, `applyDocumentChange`,
// `checkPatchedDocument`)
// and sent to the shadow with what Node stored; the shadow answers its document hash, compared with the hash of
// Node's document (SHA-256 of the JSON with keys sorted by UTF-16 code units at every depth: schema.json
// `x-documentHash`). A refusal must be a refusal on both sides.

import {createHash} from 'node:crypto';
import {applyDocumentChange} from '../../../server/design/apply';
import {invertPatch, isEmptyPatch, type DocumentPatch} from '../../../shared/design/patch';
import {checkPatchedDocument, validateDocument, validatePatch} from '../../../shared/design/schema';
import type {DesignDocument} from '../../../shared/design/types';
import {mulberry32, patchPair, randomDocument} from '../../../tests/helpers/ops-fuzz';

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.keys(value)
      .filter(key => (value as Record<string, unknown>)[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
};
const hash = (doc: DesignDocument) => createHash('sha256').update(canonical(doc)).digest('hex');

type Outcome = {doc: DesignDocument; stored: DocumentPatch; refused: string | null};

/** What `patchDesignDocument` does with a change on `current` (the database aside). */
function nodeRoute(current: DesignDocument, change: {patch: DocumentPatch; before?: DocumentPatch['nodes']; beforeTables?: DocumentPatch}): Outcome {
  // `checkedPatch` of the route: the patch, then its copies (`before.` paths), each with validatePatch.
  const shapes: [unknown, string][] = [[change.patch, '']];
  if (change.before !== undefined) shapes.push([{nodes: change.before}, 'before.']);
  if (change.beforeTables !== undefined) shapes.push([change.beforeTables, 'before.']);
  for (const [value, prefix] of shapes) {
    const valid = validatePatch(value);
    if (!valid.ok) return {doc: current, stored: {}, refused: prefix + (valid.path ?? 'shape')};
  }
  if (isEmptyPatch(change.patch)) return {doc: current, stored: {}, refused: null};
  const applied = applyDocumentChange(current, change as Parameters<typeof applyDocumentChange>[1]);
  if (isEmptyPatch(applied.stored)) return {doc: current, stored: {}, refused: null};
  const checked = checkPatchedDocument(current, applied.doc, applied.stored);
  if (!checked.ok) return {doc: current, stored: {}, refused: checked.path ?? 'refused'};
  return {doc: applied.doc, stored: applied.stored, refused: null};
}

/** The copies a client sends with a patch it made on `base`. */
function copies(base: DesignDocument, patch: DocumentPatch) {
  const full = invertPatch(base, patch);
  const {nodes, ...tables} = full;
  return {before: nodes ?? {}, beforeTables: Object.keys(tables).length ? (tables as DocumentPatch) : undefined};
}

async function shadow(url: string, secret: string, body: unknown) {
  const response = await fetch(`${url}/internal/shadow-op`, {
    method: 'POST',
    headers: {authorization: `Bearer ${secret}`, 'content-type': 'application/json'},
    body: JSON.stringify(body),
  });
  const answer = (await response.json()) as {hash?: string; fallback?: boolean; refused?: unknown; code?: string};
  if (!response.ok) throw new Error(`shadow-op ${response.status}: ${JSON.stringify(answer)}`);
  return answer;
}

async function main() {
  const [url, secret] = [process.argv[2], process.argv[3]];
  if (!url || !secret) throw new Error('usage: shadow.ts <base url> <internal secret> [cases] [seed]');
  const cases = Number(process.argv[4] ?? 10_000);
  const seed = Number(process.argv[5] ?? 1);
  const counts = {ops: 0, merged: 0, refused: 0, empty: 0, skipped: 0};
  const started = performance.now();
  for (let i = 0; i < cases; i++) {
    const rng = mulberry32(seed * 1_000_003 + i);
    const base = randomDocument(rng);
    if (!validateDocument(base).ok) {
      counts.skipped++;
      continue;
    }
    const {theirs, ours} = patchPair(base, rng);
    const file = `shadow-${seed}-${i}`;
    let current = base;
    let version = 0;
    for (const [n, edit] of [theirs, ours].entries()) {
      const {before, beforeTables} = copies(base, edit.patch);
      const outcome = nodeRoute(current, {patch: edit.patch, before, ...(beforeTables ? {beforeTables} : {})});
      const next = isEmptyPatch(outcome.stored) ? version : version + 1;
      const answer = await shadow(url, secret, {
        t: 'op',
        seq: n + 1,
        baseVersion: 0,
        patch: edit.patch,
        before,
        ...(beforeTables ? {beforeTables} : {}),
        file,
        version: next,
        stored: outcome.stored,
        ...(n === 0 ? {document: base} : {}),
      });
      counts.ops++;
      if (n === 1 && version > 0) counts.merged++;
      if (outcome.refused) counts.refused++;
      if (!outcome.refused && isEmptyPatch(outcome.stored)) counts.empty++;
      const where = `case ${i} (rng seed ${seed * 1_000_003 + i}), op ${n + 1}`;
      if (Boolean(outcome.refused) !== Boolean(answer.fallback)) {
        throw new Error(`${where}: Node ${outcome.refused ? `refused at ${outcome.refused}` : 'accepted'}, the shadow ${answer.fallback ? `refused ${JSON.stringify(answer.refused)}` : 'accepted'}`);
      }
      if (answer.hash !== hash(outcome.doc)) {
        if (process.env.SHADOW_DUMP) {
          const {writeFileSync} = await import('node:fs');
          writeFileSync(process.env.SHADOW_DUMP, JSON.stringify({base, ops: [theirs.patch, ours.patch].map(patch => ({patch, ...copies(base, patch)})), node: outcome.doc, stored: outcome.stored}));
        }
        throw new Error(`${where}: the documents differ`);
      }
      current = outcome.doc;
      version = next;
    }
    if ((i + 1) % 1000 === 0) console.error(`shadow: ${i + 1}/${cases}, ${((performance.now() - started) / 1000).toFixed(0)} s`);
  }
  console.log(`shadow: ${cases} patch pairs, ${JSON.stringify(counts)}, every hash equal, ${((performance.now() - started) / 1000).toFixed(1)} s`);
}

await main();
