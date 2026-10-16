// Account routes: who is signed in, signing in with a name, signing out, the name, closing the account and its data export.
// Morfa has no passwords, e-mail codes or outside providers (docs/authentication.md): a person types a display name, and the same name
// is always the same account.
import {randomUUID} from 'node:crypto';
import {Router} from 'express';
import {z} from 'zod';
import {db, inTransaction} from './db';
import {
  ACCOUNT_CHANGED,
  SIGN_IN_REQUIRED,
  accountChanged,
  clearSession,
  requireAuth,
  requestUser,
  revokeSession,
  sessionToken,
  setSession,
  userInfo,
  type UserRow,
} from './auth';
import {captureCustomerAuthority} from './customer-authority';
import {asyncHandler} from './http';
import {limitRequests} from './rate-limit';
import {closeAccount} from './launch/lifecycle';
import {streamAccountExport} from './launch/account-export';
import {collabSignedOut} from './design/collab/acl-push';
import {lockResources} from './postgresql/locks';
import {NAME_PROBLEM_TEXT, checkName, nameAddress} from '../shared/sign-in';

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
// Sign-ins per client address in a quarter of an hour. A team behind one office address signs in well within it; a script that
// invents names to fill the accounts table does not.
const SIGN_IN_ATTEMPTS = 60;
const profile = z.object({name: z.string().trim().min(1, 'Enter a name.').max(100)});

/** The lock every first sign-in of one name takes (rank global, before the account's): two people typing a new name at the same moment
 *  find one account, never two. */
const addressLock = (address: string) => ({kind: 'global' as const, id: 'email:' + address});

/** The account of the name's address, made on first use. Its address is the key of the name (shared/sign-in.ts `nameAddress`) and is
 *  its own (`email_verified=1`: unique among accounts), so the same name is the same account on every sign-in; the display name is the
 *  first spelling typed. The oldest account with the address is the one, as before addresses were unique. */
async function nameAccount(address: string, name: string): Promise<UserRow> {
  return inTransaction(async tx => {
    await lockResources(tx, [addressLock(address)]);
    const existing = await tx.one<UserRow>('SELECT * FROM users WHERE email=$1 ORDER BY created_at,id LIMIT 1', [
      address,
    ]);
    if (existing) return existing;
    return (await tx.one<UserRow>(
      "INSERT INTO users(id,email,name,password,email_verified) VALUES($1,$2,$3,'',1) RETURNING *",
      [randomUUID(), address, name],
    ))!;
  });
}

/** Mounted at /api/auth. */
export function createAccountsRouter(): Router {
  const router = Router();
  const limit = limitRequests({windowMs: FIFTEEN_MINUTES_MS, limit: SIGN_IN_ATTEMPTS});
  router.get(
    '/me',
    asyncHandler(async (req, res) => {
      const u = await requestUser(req, res);
      const named = req.get('x-forma-account');
      if (named && !u) {
        res.status(401).json({error: SIGN_IN_REQUIRED, code: 'unauthorized'});
        return;
      }
      if (u && accountChanged(req, u.id)) {
        res.status(409).json({error: ACCOUNT_CHANGED, code: 'account_changed'});
        return;
      }
      res.json(u ? userInfo(u) : null);
    }),
  );
  router.post(
    '/logout',
    asyncHandler(async (req, res) => {
      await revokeSession(req);
      clearSession(res);
      // The account's collab sockets close too (server/design/collab/acl-push.ts): a socket ticket outlives no session.
      const user = res.locals.sessionUser as {id: string} | null | undefined;
      if (user) collabSignedOut(user.id);
      res.json({ok: true});
    }),
  );
  // Signing in with a name: no password, no code. The account of the name is made on first use; a closed account's name is refused until
  // its data is erased.
  router.post(
    '/name',
    limit,
    asyncHandler(async (req, res) => {
      const checked = checkName(req.body?.name);
      const address = checked.ok ? nameAddress(checked.name) : null;
      if (!checked.ok || !address) {
        const problem = checked.ok ? 'long' : checked.problem;
        res.status(400).json({error: NAME_PROBLEM_TEXT[problem], code: 'invalid_name'});
        return;
      }
      const user = await nameAccount(address, checked.name);
      if (user.deletion_requested_at) {
        res.status(403).json({error: 'This account is closed.', code: 'account_closed'});
        return;
      }
      await setSession(res, user.id, {previousToken: sessionToken(req)});
      res.json(userInfo(user));
    }),
  );
  return router;
}

/** Mounted at /api/settings. */
export function createSettingsRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  router.put(
    '/',
    asyncHandler(async (req, res) => {
      const {name} = profile.parse(req.body);
      const user = await db.one<UserRow>(
        'UPDATE users SET name=$1 WHERE id=$2 AND deletion_requested_at IS NULL RETURNING *',
        [name, res.locals.user.id],
      );
      if (!user) {
        res.status(401).json({error: SIGN_IN_REQUIRED, code: 'unauthorized'});
        return;
      }
      res.json({user: userInfo(user)});
    }),
  );
  router.post(
    '/delete-account',
    asyncHandler(async (req, res) => {
      await closeAccount(captureCustomerAuthority(req, res), req.body);
      clearSession(res);
      res.status(202).json({ok: true, message: 'The account is closed. The data will be deleted at the next cleanup.'});
    }),
  );
  router.get(
    '/data-export',
    asyncHandler(async (req, res) => {
      await streamAccountExport(res, captureCustomerAuthority(req, res));
    }),
  );
  return router;
}
