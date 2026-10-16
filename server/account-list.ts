// The environment's allowlists of accounts (MORFA_OPERATORS, DESIGN_TOOL_ACCOUNTS, MCP_ACCOUNTS…): comma separated, each entry an
// account id or an address compared in lower case. Every account is a name account (docs/authentication.md): its address is made
// from its name (shared/sign-in.ts `nameAddress`, e.g. `anna@name.invalid`) and is created `email_verified=1`, which here means
// "this address belongs to exactly this account", so an address entry names whoever signs in with that name.

export type AddressOf = {email?: string | null; email_verified?: number | string | null};

/** An allowlist of the environment (comma separated): account ids, and addresses compared in lower case. Null when it is unset or
 *  empty. */
export function accountList(value: string | undefined): Set<string> | null {
  const entries = (value ?? '')
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean)
    .map(entry => (entry.includes('@') ? entry.toLowerCase() : entry));
  return entries.length ? new Set(entries) : null;
}

/** The account's address in lower case when it is its own (`email_verified=1`), else null. */
export function provenAddress(account: AddressOf): string | null {
  const email = account.email?.toLowerCase();
  return email && Number(account.email_verified) === 1 ? email : null;
}

/** Whether the account is on the list: by its id, or by its address. */
export function listedAccount(list: ReadonlySet<string>, account: {id: string} & AddressOf): boolean {
  if (list.has(account.id)) return true;
  const address = provenAddress(account);
  return !!address && list.has(address);
}
