import {createHash} from 'node:crypto';
import {collabNodes, type CollabNode} from './config';

// Which collab node an idle file goes to (docs/BACKEND.md §2 "Routing and the lease"): rendezvous hashing over the healthy nodes, so
// a file always goes to the same node while the set stays, and adding or losing a node moves only that node's share. leases.ts
// keeps the health (three failed checks in a row: unhealthy until one passes) and whether a node is full (its /healthz says
// `memory.full`: over MORFA_COLLAB_MEMORY_LIMIT_MB it opens no new file; the files it holds stay there).

const unhealthy = new Set<string>();
const full = new Set<string>();

export const unhealthyNodes = (): ReadonlySet<string> => unhealthy;
export const nodeUnhealthy = (name: string) => void unhealthy.add(name);
export const nodeHealthy = (name: string) => void unhealthy.delete(name);
export const fullNodes = (): ReadonlySet<string> => full;
/** A node's /healthz said whether it is over its memory cap. */
export const nodeFull = (name: string, isFull: boolean) => void (isFull ? full.add(name) : full.delete(name));

/** The node an idle file goes to: the highest score among the healthy nodes with room (the healthy ones when every one is full,
 *  all of them when none is healthy). */
export function nodeFor(fileId: string): CollabNode | undefined {
  const nodes = collabNodes();
  const healthy = nodes.filter(node => !unhealthy.has(node.name));
  const roomy = healthy.filter(node => !full.has(node.name));
  let best: CollabNode | undefined,
    bestScore = -1n;
  for (const node of roomy.length ? roomy : healthy.length ? healthy : nodes) {
    const score = createHash('sha256').update(fileId + '\n' + node.name).digest().readBigUInt64BE(0);
    if (score > bestScore) [best, bestScore] = [node, score];
  }
  return best;
}
