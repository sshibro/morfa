import {readFileSync} from 'node:fs';
import {db} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import {collabNode, collabNodes, collabSecret, type CollabNode} from './config';
import {fullNodes, nodeFull, nodeHealthy, nodeUnhealthy, unhealthyNodes} from './nodes';

export {nodeFor} from './nodes';
export const knownNode = (name: string) => collabNode(name);

// The per-file lease (docs/BACKEND.md §2 "Routing and the lease", §8; migration 012; lane B2's crates/lease). One collab
// node owns a document at a time: `design_files.collab_node, lease_until, fence`. Time is the database's (clock_timestamp()).
//
// api's part: GET /:id/session finds the live holder, or takes the lease of an idle file for the node the file hashes to
// (rendezvous hashing over the healthy nodes), moving the fence up by one as every new owner does. The node's actor then takes
// the same lease for itself (B2's acquire accepts the node that already holds it) and renews it every 5 s; api never renews.
// api never takes a lease another node still holds: a holder is only replaced once its lease ran out, or at once when api
// sees its health check fail three times in a row (B2's `expire_node`).

/** B1's LEASE_TTL. */
export const LEASE_TTL_MS = 15_000;
const HEALTH_EVERY_MS = 2_000;
const HEALTH_TIMEOUT_MS = 1_000;
const HEALTH_FAILURES = 3;

export type Holder = {node: string; fence: number};

// One text with the collab nodes' /session (crates/collab/src/session.rs).
const TAKE_OR_FIND = readFileSync(new URL('./sql/take-or-find.sql', import.meta.url), 'utf8');

type TakeRow = {collab_node: string | null; fence: string | number; version: string | number; taken: boolean; live: boolean};

/** The live holder of `fileId`, or the lease taken for `node` when the file is idle. Undefined: no such file. */
export async function takeOrFindLease(
  fileId: string,
  node: CollabNode,
  executor: SqlExecutor = db,
): Promise<{holder: Holder; taken: boolean; version: number} | undefined> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await executor.one<TakeRow>(TAKE_OR_FIND, [fileId, node.name, LEASE_TTL_MS]);
    if (!row) return undefined;
    // Not taken, and the snapshot shows no live holder: another statement took or released it meanwhile. Read again.
    if (!row.taken && (!row.collab_node || !row.live)) continue;
    return {holder: {node: row.collab_node!, fence: Number(row.fence)}, taken: row.taken, version: Number(row.version)};
  }
  return undefined;
}

/** The node that holds `fileId` now (a lease that has not run out), or null. */
export async function leaseHolder(fileId: string, executor: SqlExecutor = db): Promise<Holder | null> {
  const row = await executor.one<{collab_node: string; fence: string | number}>(
    'SELECT collab_node,fence FROM design_files WHERE id=$1 AND collab_node IS NOT NULL AND lease_until>=clock_timestamp()',
    [fileId],
  );
  return row ? {node: row.collab_node, fence: Number(row.fence)} : null;
}

export type HeldFile = {id: string; node: string; user_id: string; team_id: string | null; trashed: boolean};

/** The files a collab node holds now among `where`: one file, a team's, or every file of an account, its teams and those shared with it. */
export async function heldFiles(where: {fileId?: string; teamId?: string; userId?: string}, executor: SqlExecutor = db): Promise<HeldFile[]> {
  const rows = await executor.many<{id: string; collab_node: string; user_id: string; team_id: string | null; trashed: boolean}>(
    `SELECT f.id,f.collab_node,f.user_id,f.team_id,f.trashed_at IS NOT NULL AS trashed FROM design_files f
      WHERE f.collab_node IS NOT NULL AND f.lease_until>=clock_timestamp()
        AND ($1::text IS NULL OR f.id=$1) AND ($2::text IS NULL OR f.team_id=$2)
        AND ($3::text IS NULL OR f.user_id=$3 OR f.team_id IN (SELECT team_id FROM design_team_members WHERE user_id=$3)
             OR f.id IN (SELECT file_id FROM design_file_members WHERE user_id=$3))`,
    [where.fileId ?? null, where.teamId ?? null, where.userId ?? null],
  );
  return rows.map(row => ({id: row.id, node: row.collab_node, user_id: row.user_id, team_id: row.team_id, trashed: row.trashed}));
}

/** Ends every lease of `node` at once (its health check failed): its files move on the next /session. */
export async function expireNode(node: string, executor: SqlExecutor = db): Promise<number> {
  return (await executor.execute('UPDATE design_files SET collab_node=NULL,lease_until=NULL WHERE collab_node=$1', [node])).changes;
}

// ── Health ───────────────────────────────────────────────────────────────────────────────────────

const failures = new Map<string, number>();
/** Nodes that answered "draining": unhealthy for new files, leases left to them; if one then stops answering (killed during
 *  the drain), its leases are expired after the usual three failures like any dead node's. */
const draining = new Set<string>();
/** One health check of `node` (exported for tests). */
export const checkCollabNode = (node: CollabNode) => checkNode(node);
let healthTimer: ReturnType<typeof setInterval> | null = null;

async function checkNode(node: CollabNode) {
  let ok = false,
    isDraining = false;
  try {
    const response = await fetch(node.internal + '/healthz', {signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)});
    ok = response.ok;
    // A draining node (deploy; crates/collab/src/drain.rs) answers 503 {draining: true}: no new files go to it from now on, and
    // its leases stay with it (it checkpoints and releases them itself), so nothing is expired here.
    if (!ok) isDraining = ((await response.json().catch(() => null)) as {draining?: unknown} | null)?.draining === true;
    // Over its memory cap a node opens no new file: /session sends idle files elsewhere (nodes.ts), its own files stay.
    if (ok) nodeFull(node.name, ((await response.json().catch(() => null)) as {memory?: {full?: boolean}} | null)?.memory?.full === true);
  } catch {
    ok = false;
  }
  if (isDraining) {
    failures.delete(node.name);
    draining.add(node.name);
    nodeUnhealthy(node.name);
    return;
  }
  if (ok) {
    failures.delete(node.name);
    draining.delete(node.name);
    nodeHealthy(node.name);
    return;
  }
  const count = (failures.get(node.name) ?? 0) + 1;
  failures.set(node.name, count);
  if (count < HEALTH_FAILURES || (unhealthyNodes().has(node.name) && !draining.has(node.name))) return;
  draining.delete(node.name);
  nodeUnhealthy(node.name);
  const moved = await expireNode(node.name).catch(() => 0);
  console.error(`collab node ${node.name} failed ${count} health checks: ${moved} leases expired.`);
}

/** Starts the health checks of the configured nodes (once; the timer does not keep the process alive). */
export function watchCollabHealth() {
  if (healthTimer || !collabNodes().length || !collabSecret()) return;
  healthTimer = setInterval(() => {
    for (const node of collabNodes()) void checkNode(node);
  }, HEALTH_EVERY_MS);
  healthTimer.unref();
}

export function stopCollabHealth() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = null;
  failures.clear();
  draining.clear();
  for (const name of [...unhealthyNodes()]) nodeHealthy(name);
  for (const name of [...fullNodes()]) nodeFull(name, false);
}
