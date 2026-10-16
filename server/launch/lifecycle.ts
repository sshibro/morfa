// The life of a Morfa account after its owner closes it: closure (sessions end, the account is queued)
// and erasure on the next maintenance pass (files first, then every row in one transaction, the account row anonymised).
import fs from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {db, dataDir} from '../db';
import type {TransactionContext} from '../postgresql/client';
import {lockResources} from '../postgresql/locks';
import {lockCurrentSession} from '../session-authority';
import type {CustomerAuthority} from '../customer-authority';
import {fail} from '../hosting/errors';
import {checkName, nameAddress} from '../../shared/sign-in';
import {eraseDesignAccount, removeDesignAccountFiles} from '../design/lifecycle';
import {pruneActivity} from '../admin/telemetry';
import {eraseSupportOf} from '../support/store';
import {eraseMcpOf} from '../mcp/oauth/store';
import {eraseMarketplaceOf} from '../marketplace/loop/erasure';

const uploadName = /^[a-zA-Z0-9._-]+$/;
/** Erasure and the activity journal (server/admin/telemetry.ts) both take the account's lock: no journal row outlives the erasure. */
const erasureLocks = (userId: string) => [{kind: 'account' as const, id: userId}];
/** The text format of users.deletion_requested_at and erasure_completed_at. */
export const accountTimestamp = (at: Date) => at.toISOString().replace('T', ' ').slice(0, 19);

/**
 * The owner closes the account (POST /api/settings/delete-account). Under the account lock and the live session: the account is
 * marked, every session ends. Its data
 * goes on the next maintenance pass.
 */
export async function closeAccount(actor: CustomerAuthority, input: unknown): Promise<void> {
  const {confirmName} = z.object({confirmName: z.string().trim().min(1).max(200)}).parse(input);
  await db.transaction(async (tx: TransactionContext) => {
    await lockResources(tx, [{kind: 'account', id: actor.ownerId}]);
    if (!(await lockCurrentSession(tx, actor.ownerId, actor.sessionHash)))
      fail(401, 'unauthenticated', 'Sign in to your account.');
    const user = await tx.one<{email: string}>(
      'SELECT email FROM users WHERE id=$1 AND deletion_requested_at IS NULL',
      [actor.ownerId],
    );
    if (!user) return fail(401, 'unauthenticated', 'Sign in to your account.');
    // The account is confirmed by the name it signs in with (any spelling of it: shared/sign-in.ts `nameAddress`).
    const typed = checkName(confirmName);
    if (!typed.ok || nameAddress(typed.name) !== user.email.toLowerCase())
      fail(400, 'confirmation_required', 'Type the name you sign in with to confirm.');
    const at = new Date();
    await tx.execute('UPDATE users SET deletion_requested_at=$1 WHERE id=$2', [accountTimestamp(at), actor.ownerId]);
    await tx.execute('DELETE FROM sessions WHERE user_id=$1', [actor.ownerId]);
    // The assistants it connected stop too (their calls already refuse a closed account; this ends the connections themselves).
    await tx.execute('UPDATE oauth_grants SET revoked_at=clock_timestamp() WHERE user_id=$1 AND revoked_at IS NULL', [
      actor.ownerId,
    ]);
    await tx.execute(
      "INSERT INTO launch_audit(id,user_id,project_id,action,result) VALUES(gen_random_uuid()::text,$1,NULL,'account_erasure_requested','ok')",
      [actor.ownerId],
    );
  });
}

/**
 * Erases one closed account. Picture files go before their rows, so a later SQL failure retries the same intent instead of leaving
 * private files behind; the rows then go in one transaction under the account's lock.
 */
export async function eraseAccount(userId: string, at: string): Promise<void> {
  for (const file of await db.many<{filename: string}>('SELECT filename FROM uploads WHERE user_id=$1', [userId]))
    if (uploadName.test(file.filename)) await fs.rm(path.join(dataDir, 'uploads', file.filename), {force: true});
  // The teams it owns are deleted under their own locks, then the design pictures and thumbnails go.
  await removeDesignAccountFiles(userId);
  await db.transaction(async tx => {
    await lockResources(tx, erasureLocks(userId));
    if (
      !(await tx.one(
        'SELECT id FROM users WHERE id=$1 AND deletion_requested_at IS NOT NULL AND erasure_completed_at IS NULL',
        [userId],
      ))
    )
      return;
    await tx.execute("INSERT INTO erasure_ledger(id,kind) VALUES($1,'account') ON CONFLICT(id) DO NOTHING", [userId]);
    await tx.execute('DELETE FROM uploads WHERE user_id=$1', [userId]);
    // Files, versions, pictures, libraries, comments in its own files, ballots, memberships and the teams it owned.
    await eraseDesignAccount(tx, userId);
    // The conversation with support and its messages (SQL019).
    await eraseSupportOf(tx, userId);
    // The assistants it connected (the MCP server's grants, their tokens and requests) and its daily call counts.
    await eraseMcpOf(tx, userId);
    // "Marketplaces": brand kits, seller connections and their keys, card links, published pictures and their files, tests, numbers.
    await eraseMarketplaceOf(tx, userId);
    await tx.execute('DELETE FROM admin_activity WHERE user_id=$1', [userId]);
    await tx.execute('DELETE FROM sessions WHERE user_id=$1', [userId]);
    // The row is anonymised, not deleted: evidence rows keep naming an account that no longer says who it was.
    await tx.execute(
      "UPDATE users SET name='Deleted account',email=$1,password='',email_verified=0,erasure_completed_at=$2 WHERE id=$3",
      ['erased-' + userId + '@invalid.local', accountTimestamp(new Date(at)), userId],
    );
  });
}

/** The maintenance pass (hourly is plenty): erases closed accounts, forgets expired sessions and the activity journal's rows past its
 *  retention. Each account is its own attempt; a failure is thrown after the rest ran, and the next pass retries it. */
export async function launchMaintenance(): Promise<void> {
  const at = new Date().toISOString();
  const failures: unknown[] = [];
  const closing = await db.many<{id: string}>(
    'SELECT id FROM users WHERE deletion_requested_at IS NOT NULL AND erasure_completed_at IS NULL ORDER BY id',
  );
  for (const account of closing)
    await eraseAccount(account.id, at).catch(error => {
      failures.push(error);
    });
  await db.execute('DELETE FROM sessions WHERE expires<=$1', [Date.now()]).catch(error => failures.push(error));
  await pruneActivity(new Date(at)).catch(error => failures.push(error));
  if (failures.length) {
    console.error('[accounts] maintenance: ' + failures.length + ' item(s) failed; retrying next run.');
    throw failures[0];
  }
}
