import type {DesignDocument} from '../../../shared/design/types';
import type {DocumentPatch} from '../../../shared/design/patch';
import {documentBytes} from '../document-text';
import {lendDocument} from '../document-cache';
import {nodeFor} from './leases';
import type {CollabNode} from './config';
import {shadowDoc, shadowOp, type ShadowAnswer} from './client';
import {collabBodyLimit} from './config';
import {fileCollabMode} from './switch';
import {documentHash, firstDifference, logMismatch, type MismatchKind, type ShadowCase} from './shadow-log';

// DESIGN_COLLAB=shadow (docs/BACKEND.md §7 step 2): Node stays authoritative; after every accepted PATCH, and every whole-document
// write, the same op goes to collab's POST /internal/shadow-op (crates/collab/src/internal.rs), which applies it to its own copy
// with its own engine and answers the copy's hash. Node compares it with the hash of its own document; a difference is logged
// (shadow-log.ts). Nothing waits for collab: the forwards of a file run one after another behind the answer, in version order.
//
// Seeding: collab's copy of a file starts from a document sent with an op (`document`, the document the op is applied on, at the
// op's base version). The first forward of a file in this process, any forward after a version this process did not forward
// (another process's save, a write it does not see), a restart of collab (404 shadow_unseeded) and a failed call all re-seed.
// When the op was made on the version it applied on, the seed carries the client's own op (collab merges and checks it exactly
// as from a client); when Node merged it onto a newer version, the seed carries what Node stored, on the document it applied to.
//
// Cost: hashing a document (canonical JSON + SHA-256) takes ~10 ms per MB on this server's thread, after the answer is sent.
// Documents up to SHADOW_HASH_EVERY_BYTES are compared after every op, larger ones after every SHADOW_HASH_EVERY-th (a difference
// persists, so it is still found, a few ops later). At most SHADOW_PENDING forwards wait per file; past that the file is
// re-seeded rather than queue without bound. Several api processes may forward one file: each op says the version it applied on
// (`appliedOn`), and collab answers 409 shadow_stale rather than apply it to a copy another process moved (counted as `stale`, then
// seeded again). A body over what collab reads (config.ts `collabBodyLimit`: a seed of a document past
// 2 MiB with today's build) is not sent: that file is counted as `oversize` and compared again once a seed fits.

const SHADOW_HASH_EVERY_BYTES = 2 * 1024 * 1024;
const SHADOW_HASH_EVERY = 10;
const SHADOW_PENDING = 500;
/** A replayable case keeps at most this many ops (or bytes of their JSON) since the seed. */
const CASE_OPS = 1_000;
const CASE_BYTES = 16 * 1024 * 1024;
/** Files whose copies are followed at once; the least recently used is forgotten (and re-seeded when it comes back). */
const FILES = 256;

export type ClientOp = {baseVersion: number; patch: unknown; before?: unknown; beforeTables?: unknown};

export type ShadowSave = {
  fileId: string;
  file: {user_id: string; team_id: string | null};
  /** The version Node stored, or the one it kept for an op that changed nothing. */
  version: number;
  /** The version the op was applied on, and its document. */
  appliedOn: number;
  current: DesignDocument;
  next: DesignDocument;
  op: ClientOp;
  stored: DocumentPatch;
  /** Start collab's copy again from `current` whatever it is at (a whole new document). */
  reseed?: boolean;
};

type State = {
  version: number | null;
  seq: number;
  pending: number;
  ops: number;
  chain: Promise<void>;
  shadowCase: ShadowCase | null;
  caseBytes: number;
};

const files = new Map<string, State>();
const counts = {forwarded: 0, seeded: 0, compared: 0, equal: 0, mismatches: 0, refusals: 0, unavailable: 0, dropped: 0, oversize: 0, stale: 0};

function stateOf(fileId: string): State {
  let state = files.get(fileId);
  if (state) {
    files.delete(fileId);
    files.set(fileId, state);
    return state;
  }
  state = {version: null, seq: 0, pending: 0, ops: 0, chain: Promise.resolve(), shadowCase: null, caseBytes: 0};
  files.set(fileId, state);
  for (const [key, other] of files) {
    if (files.size <= FILES) break;
    if (!other.pending) files.delete(key);
  }
  return state;
}

/** The op as the socket's `op` message, plus the shadow fields (internal.rs `ShadowExtra`). */
function body(save: ShadowSave, state: State, seed: boolean, hash: boolean): Record<string, unknown> {
  const own = !seed || save.op.baseVersion === save.appliedOn;
  const op = own
    ? {
        baseVersion: save.op.baseVersion,
        patch: save.op.patch,
        ...(save.op.before !== undefined ? {before: save.op.before} : {}),
        ...(save.op.beforeTables !== undefined ? {beforeTables: save.op.beforeTables} : {}),
      }
    : {baseVersion: save.appliedOn, patch: save.stored};
  return {t: 'op', seq: ++state.seq, ...op, file: save.fileId, version: save.version, appliedOn: save.appliedOn, stored: save.stored, hash};
}

/** Where collab's copy differs from Node's document (GET /internal/shadow-doc): the first differing path, or null when the copy
 *  cannot be read (an older collab build, a copy already re-seeded). */
async function differingPath(node: CollabNode, save: ShadowSave): Promise<string | null> {
  try {
    const answer = await shadowDoc(node, save.fileId);
    if (answer.status !== 200 || !answer.body?.document) return null;
    return firstDifference(save.next, answer.body.document);
  } catch {
    return null;
  }
}

async function report(
  kind: MismatchKind,
  save: ShadowSave,
  state: State,
  extra: {nodeHash?: string | null; answer?: ShadowAnswer; message?: string; path?: string | null},
) {
  counts.mismatches++;
  if (kind === 'refusal') counts.refusals++;
  await logMismatch(
    {
      kind,
      file: save.fileId,
      version: save.version,
      appliedOn: save.appliedOn,
      baseVersion: save.op.baseVersion,
      nodeHash: extra.nodeHash ?? null,
      collabHash: extra.answer?.hash ?? null,
      collabVersion: extra.answer?.version ?? null,
      refused: extra.answer?.refused ?? undefined,
      message: extra.message,
      ...(extra.path ? {collabPath: extra.path} : {}),
    },
    state.shadowCase ? {...state.shadowCase, node: save.next} : null,
  );
}

async function forward(save: ShadowSave, state: State) {
  const node = nodeFor(save.fileId);
  if (!node) return;
  const big = documentBytes(save.next) > SHADOW_HASH_EVERY_BYTES;
  const hash = !big || ++state.ops % SHADOW_HASH_EVERY === 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const seed = (!attempt && save.reseed) || state.version !== save.appliedOn;
    const message = body(save, state, seed, hash);
    const text = seed ? JSON.stringify({...message, document: save.current}) : JSON.stringify(message);
    // Over the body collab reads (a large file's seed): not compared until a smaller document seeds it again.
    if (Buffer.byteLength(text) > collabBodyLimit()) {
      counts.oversize++;
      state.version = null;
      state.seq--;
      return;
    }
    let answer: {status: number; body: ShadowAnswer};
    try {
      answer = await shadowOp(node, text);
    } catch (error) {
      counts.unavailable++;
      state.version = null;
      if (attempt) console.error('collab shadow:', (error as Error).message);
      continue;
    }
    counts.forwarded++;
    if (answer.status === 404 && answer.body?.code === 'shadow_unseeded') {
      state.version = null;
      continue;
    }
    // The copy is not at the version this op applied on: another api process forwarded the file meanwhile (its seed or its
    // ops moved the copy). Nothing was applied; seed it again from this process's document.
    if (answer.status === 409 && answer.body?.code === 'shadow_stale') {
      counts.stale++;
      state.version = null;
      continue;
    }
    if (answer.status === 413) {
      counts.oversize++;
      state.version = null;
      return;
    }
    if (seed) {
      counts.seeded++;
      state.shadowCase = {file: save.fileId, seedVersion: Number(message.baseVersion), seed: save.current, ops: [], node: save.next};
      state.caseBytes = 0;
    }
    if (state.shadowCase) {
      state.caseBytes += seed ? 0 : text.length;
      if (state.shadowCase.ops.length >= CASE_OPS || state.caseBytes > CASE_BYTES) state.shadowCase = null;
      else state.shadowCase.ops.push(message);
    }
    if (answer.status !== 200) {
      state.version = null;
      await report(answer.status === 409 ? 'diverged' : 'error', save, state, {answer: answer.body, message: `shadow-op ${answer.status}: ${JSON.stringify(answer.body)}`});
      return;
    }
    state.version = answer.body.version ?? null;
    if (answer.body.fallback) {
      await report('refusal', save, state, {answer: answer.body, message: 'collab refused an op Node accepted (its copy took what Node stored)'});
      return;
    }
    if (answer.body.version !== save.version) {
      await report('version', save, state, {answer: answer.body, message: `collab is at ${answer.body.version}, Node at ${save.version}`});
      return;
    }
    if (!hash || !answer.body.hash) return;
    counts.compared++;
    const nodeHash = documentHash(save.next);
    if (nodeHash === answer.body.hash) counts.equal++;
    else {
      await report('hash', save, state, {nodeHash, answer: answer.body, path: await differingPath(node, save)});
      // Compared from a fresh copy from now on: the next forward re-seeds.
      state.version = null;
    }
    return;
  }
}

/** After Node stored (or kept) a version of a file in shadow mode: its op goes to collab, in order, after the answer. */
export function shadowAfterSave(save: ShadowSave): void {
  if (fileCollabMode(save.file) !== 'shadow') return;
  const state = stateOf(save.fileId);
  if (state.pending >= SHADOW_PENDING) {
    counts.dropped++;
    state.version = null;
    return;
  }
  state.pending++;
  // The forward reads both documents after the answer (seed, hash, replay case): their node tables must never be the spare a
  // later save writes into in place (document-cache.ts, lane L6).
  lendDocument(save.current);
  lendDocument(save.next);
  state.chain = state.chain
    .then(() => forward(save, state))
    .catch(error => console.error('collab shadow:', (error as Error).message))
    .finally(() => void state.pending--);
}

/** A whole new document was stored as `version` (a replace, a restore, a rewritten move): collab's copy starts again from it. */
export function shadowAfterReplace(input: {fileId: string; file: {user_id: string; team_id: string | null}; version: number; document: DesignDocument}): void {
  shadowAfterSave({
    fileId: input.fileId,
    file: input.file,
    version: input.version,
    appliedOn: input.version,
    current: input.document,
    next: input.document,
    op: {baseVersion: input.version, patch: {}},
    stored: {},
    reseed: true,
  });
}

/** Resolves when every forward queued so far has been answered (tests, the report). */
export async function shadowIdle(): Promise<void> {
  for (let round = 0; round < 100; round++) {
    const waiting = [...files.values()].filter(state => state.pending);
    if (!waiting.length) return;
    await Promise.all(waiting.map(state => state.chain));
  }
}

export const shadowStats = () => ({...counts, files: files.size});

/** For tests: forget every copy and count. */
export function resetShadow() {
  files.clear();
  for (const key of Object.keys(counts) as (keyof typeof counts)[]) counts[key] = 0;
}
