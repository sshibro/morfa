import type {RequestHandler} from 'express';
import {ACCOUNT_CHANGED, accountChanged, requestUser, type UserRow} from '../auth';
import {asyncHandler} from '../http';
import {accountList} from '../account-list';

/* Who the operators are: the operator's console (#admin, GET /api/admin/*; shared/admin-analytics.ts) and the support chat's side of
 * it (/api/admin/support, server/support). MORFA_OPERATORS names them, account ids and addresses, comma separated (an address
 * compared in lower case). Unset or empty: nobody. Accounts are made by typing a name (docs/authentication.md), and an account's address
 * is that name in lower case at name.invalid (`anna@name.invalid`, shown in the console beside the account): whoever signs in with
 * that name is the operator, so an operator's name is as secret as a password and the deployment must sit behind the access control
 * the operator provides. An account that asked to be closed, or was erased, is never an operator. To anyone else an operator route is
 * the API's answer to a route it does not have. */

/** The API's answer to a route it does not have (server/app.ts). */
export const UNKNOWN_ROUTE = {error: 'Route not found.'} as const;

export type OperatorCandidate = Pick<
  UserRow,
  'id' | 'email' | 'email_verified' | 'deletion_requested_at' | 'erasure_completed_at'
>;

/** Whether MORFA_OPERATORS names anyone at all. */
export const operatorsNamed = (env: NodeJS.ProcessEnv = process.env): boolean =>
  accountList(env.MORFA_OPERATORS) !== null;

/** The entries MORFA_OPERATORS names, in its order (account ids as written, addresses in lower case): who the support chat shows. */
export const operatorEntries = (env: NodeJS.ProcessEnv = process.env): string[] => [
  ...(accountList(env.MORFA_OPERATORS) ?? []),
];

/** Whether the account is an operator (the module comment has the rules). Reads the environment, never the database. */
export function isOperator(
  account: OperatorCandidate | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!account || account.deletion_requested_at || account.erasure_completed_at) return false;
  const operators = accountList(env.MORFA_OPERATORS);
  if (!operators) return false;
  if (operators.has(account.id)) return true;
  const proven = Number(account.email_verified) === 1 || env.NODE_ENV !== 'production';
  return proven && operators.has(account.email.toLowerCase());
}

/** Express guard of the operator routes: the operator's account in res.locals.operator and res.locals.user; 409 when the operator's tab
 *  names another account (the account generation check of server/auth.ts); anyone else, signed out included, the plain 404. */
export const operatorGate: RequestHandler = asyncHandler(async (req, res, next) => {
  const account = await requestUser(req, res).catch(() => undefined);
  if (!account || !isOperator(account)) {
    res.status(404).json(UNKNOWN_ROUTE);
    return;
  }
  if (accountChanged(req, account.id)) {
    res.status(409).json({error: ACCOUNT_CHANGED, code: 'account_changed'});
    return;
  }
  res.locals.user = account;
  res.locals.operator = account;
  next();
});
