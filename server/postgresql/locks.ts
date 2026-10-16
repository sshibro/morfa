import {createHash} from 'node:crypto';
import type {TransactionContext} from './client';

/** All application aggregate locks use this order, including resources whose
 * database row does not exist yet. Callers must lock before reading an allowance.
 */
export type ResourceKind = 'global' | 'account' | 'project' | 'operation';
export interface LockResource {
  kind: ResourceKind;
  id: string;
}
const ranks: Record<ResourceKind, number> = {global: 0, account: 1, project: 2, operation: 3};
const stateKey = Symbol('morfa-transaction-resource-locks');
type LockState = Readonly<{held: readonly string[]; last: string | undefined; acquiring: boolean}>;

export class LockOrderError extends Error {
  readonly code = 'MORFA_LOCK_ORDER';
  constructor(message = 'Acquire resources in global, account, project, operation order') {
    super(message);
    this.name = 'LockOrderError';
  }
}

function canonical(resource: LockResource): string {
  if (
    !Object.hasOwn(ranks, resource.kind) ||
    typeof resource.id !== 'string' ||
    resource.id.length === 0 ||
    resource.id.length > 512 ||
    resource.id.includes('\0')
  ) {
    throw new LockOrderError('Invalid lock resource');
  }
  return `${ranks[resource.kind]}:${resource.kind}:${resource.id}`;
}

/** Stable signed bigint key. Hash collisions cause unnecessary serialization,
 * never independent execution for the same resource. No user values enter SQL.
 */
export function resourceLockKey(resource: LockResource): string {
  return hashKey(canonical(resource));
}

function hashKey(key: string): string {
  return createHash('sha256').update('morfa-resource-lock:v1\0').update(key).digest().readBigInt64BE().toString();
}

export async function lockResources(tx: TransactionContext, resources: readonly LockResource[]): Promise<void> {
  if (resources.length > 1_000) throw new LockOrderError('Too many lock resources');
  // Capture strings before the first await: caller-owned objects may change
  // while an earlier resource lock is waiting on another transaction.
  const ordered = [...new Set(resources.map(canonical))]
    .map(key => [key, hashKey(key)] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const initial = tx.getLocal<LockState>(stateKey) ?? {held: [], last: undefined, acquiring: false};
  if (initial.acquiring) throw new LockOrderError('Await each resource-lock acquisition before starting another');
  const fresh = ordered.filter(([key]) => !initial.held.includes(key));
  if (initial.held.length + fresh.length > 1_000) throw new LockOrderError('Too many transaction lock resources');
  if (initial.last !== undefined && fresh.some(([key]) => key < initial.last!)) throw new LockOrderError();
  // Immutable values allow the client to restore transaction-local state when
  // rolling back a savepoint, matching PostgreSQL's release of those locks.
  let state: LockState = {...initial, acquiring: true};
  tx.setLocal(stateKey, state);
  try {
    for (const [key, hash] of fresh) {
      await tx.query('SELECT pg_advisory_xact_lock($1::bigint)', [hash]);
      state = {held: [...state.held, key], last: key, acquiring: true};
      tx.setLocal(stateKey, state);
    }
  } finally {
    if (tx.transactionScope.active) tx.setLocal(stateKey, {...state, acquiring: false});
  }
}
