/**
 * Who the console counts as a person. An account whose e-mail ends in `.invalid` is not one: RFC 6761 reserves that top-level domain, so
 * no person holds such an address; only our own tools make them (the drain drill's `drill-<uuid>@drill.invalid`, the bench's
 * `@bench.invalid`). Every report leaves them out wherever it counts, lists or shows accounts or what they did: sign-ups and totals,
 * active accounts (DAU/WAU/MAU, cohorts, the heatmap), the funnel, segments, teams and their members, adoption, the files,
 * versions, comments and teams made, the top actions, the accounts list and its counts, and an account's page, which
 * answers 404 as an unknown one does (the support inbox's account card reads it). What is stored stays whole: the storage. The rule is the console's alone: sign-in and the product treat these accounts as any other.
 * users.email is COLLATE "C", whose lower() folds ASCII, all `.INVALID` needs; an erased account's tombstone
 * (`erased-<id>@invalid.local`, server/launch/lifecycle.ts) is not one.
 */
const reserved = (user: string) => `lower(${user}.email) LIKE '%.invalid'`;

/** The users row `user` (a trusted alias) is a person. */
export const personSql = (user: string) => `NOT ${reserved(user)}`;

/** The account `id` (a trusted SQL expression) is not a reserved one: an anti-join on the few reserved accounts, cheap beside the table it
 *  filters (the journal), and true for an id no account has. */
export const personIdSql = (id: string) =>
  `NOT EXISTS(SELECT 1 FROM users reserved_account WHERE reserved_account.id=${id} AND ${reserved('reserved_account')})`;
