/* "Morfa" switches (docs/design-tool.md §Product). Off unless the platform owner turns it on.
 * This file reads the environment and nothing else, so it is importable without a database and a test
 * may change the environment between requests. */

import {accountList, listedAccount, type AddressOf} from '../account-list';

type Account = {id: string} & AddressOf;

/** ENABLE_DESIGN_TOOL=1 turns the product on for the platform. */
export const designToolEnabled = () => process.env.ENABLE_DESIGN_TOOL === '1';

/** DESIGN_TOOL_ACCOUNTS: a staged rollout by account id, or by e-mail for an account whose address is proven (comma separated,
 * emails compare in lower case; server/account-list.ts). Null (unset or empty) means every account. */
const rolloutAccounts = () => accountList(process.env.DESIGN_TOOL_ACCOUNTS);

/** "Design" is open to this account: the files API answers and `/api/config` says `designTool: true`. */
export function designToolAvailable(account: Account | null | undefined): boolean {
  if (!account || !designToolEnabled()) return false;
  const accounts = rolloutAccounts();
  if (!accounts) return true;
  return listedAccount(accounts, account);
}
