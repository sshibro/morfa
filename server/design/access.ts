/** Whose rows a file belongs to (docs/design-tool.md §Teams): an account's personal files, or a team's. A team's rows are held by
 * its owner (`ownerId`, the files' `user_id`). */
export type DesignScope = {kind: 'personal'; userId: string} | {kind: 'team'; teamId: string; ownerId: string};
export const scopeOfFile = (row: {user_id: string; team_id: string | null}): DesignScope =>
  row.team_id ? {kind: 'team', teamId: row.team_id, ownerId: row.user_id} : {kind: 'personal', userId: row.user_id};
/** The account whose rows (files, versions, pictures) a scope's are. */
export const holderOf = (scope: DesignScope): string => (scope.kind === 'team' ? scope.ownerId : scope.userId);

