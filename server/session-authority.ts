import type {TransactionContext} from './postgresql/client';

/** Call after the account's canonical locks in a write transaction. Keep the
 * exact session locked until commit, and sample expiry after any row-lock wait.
 * FOR KEY SHARE is insufficient: an expiry UPDATE does not change its key. */
export async function lockCurrentSession(
  tx: TransactionContext,
  ownerId: string,
  sessionHash: string,
): Promise<boolean> {
  if (!tx.transactionScope.active) throw Error('Session write authority requires an active transaction.');
  if (!sessionHash) return false;
  const row = await tx.one<{expires: number}>(
    `SELECT s.expires FROM users u JOIN sessions s ON s.user_id=u.id
   WHERE u.id=$1 AND s.token=$2 AND u.deletion_requested_at IS NULL FOR SHARE OF s`,
    [ownerId, sessionHash],
  );
  return !!row && row.expires > Date.now();
}
