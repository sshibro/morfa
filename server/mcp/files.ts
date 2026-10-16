// What the MCP tools read (docs/mcp-server.md §Tools): an account's files and one file's document, through the files API's own access
// rule (server/design/file-access.ts fileAccess, THE rule of who may open a file) and the document store's reader, never a raw column.
// A read is one read-only snapshot, and the connection is checked inside it and again after it, as designRead checks the session:
// a connection revoked, expired or closed meanwhile gets no bytes. Files in the trash are not offered to an assistant.
import {db} from '../db';
import {fileAccess, fileRoleJoins} from '../design/file-access';
import {storedDocument} from '../design/document-store';
import type {TransactionContext} from '../postgresql/client';
import type {DesignDocument} from '../../shared/design/types';
import {credentialState, CREDENTIAL_SQL, type Principal} from './auth';
import {ToolError} from './errors';

const CONNECTION_SQL = CREDENTIAL_SQL.replace('k.token_hash=$1', 'k.id=$1');

async function assertConnection(principal: Principal, sql: {one: TransactionContext['one']}) {
  if (credentialState(await sql.one(CONNECTION_SQL, [principal.tokenId])))
    throw new ToolError(
      'unauthorized',
      'This Morfa connection no longer works.',
      'Ask the person to connect Morfa again.',
    );
}

/** One consistent read-only view for the connection, checked before and after. */
export async function mcpRead<T>(principal: Principal, work: (tx: TransactionContext) => Promise<T>): Promise<T> {
  const result = await db.transaction(
    async tx => {
      await assertConnection(principal, tx);
      return work(tx);
    },
    {readOnly: true, isolation: 'repeatable read'},
  );
  await assertConnection(principal, db);
  return result;
}

export type FileEntry = {
  id: string;
  name: string;
  kind: 'design' | 'board';
  team: string | null;
  role: string;
  updatedAt: string;
};

/**
 * The files the account can open, newest first: its personal files, its live teams' files and the files shared with it (a guest row),
 * none in the trash. `query` filters by a part of the name. The role per file is fileRoleJoins', so the list never disagrees with
 * what opening a file allows. A file reached only by its link (no guest row) is not listed, as "Shared with me" does not list it.
 */
export async function listFiles(
  principal: Principal,
  options: {query?: string; limit: number},
): Promise<{files: FileEntry[]; total: number}> {
  return mcpRead(principal, async tx => {
    const rows = await tx.many<{
      id: string;
      name: string;
      kind: string;
      team: string | null;
      role: string;
      updated_at: string;
      total: number;
    }>(
      `SELECT f.id,f.name,f.kind,t.name AS team,fa_role.role,f.updated_at,count(*) OVER()::int AS total
         FROM design_files f
         ${fileRoleJoins('f', '$1')}
         LEFT JOIN design_teams t ON t.id=f.team_id AND t.deleted_at IS NULL
        WHERE f.trashed_at IS NULL AND fa_role.role IS NOT NULL
          AND ((f.team_id IS NULL AND f.user_id=$1)
               OR f.team_id IN (SELECT m.team_id FROM design_team_members m WHERE m.user_id=$1)
               OR EXISTS(SELECT 1 FROM design_file_members x WHERE x.file_id=f.id AND x.user_id=$1))
          AND ($2::text IS NULL OR strpos(lower(f.name), lower($2)) > 0)
        ORDER BY f.updated_at DESC, f.id
        LIMIT $3`,
      [principal.userId, options.query?.trim() || null, options.limit],
    );
    return {
      total: rows[0]?.total ?? 0,
      files: rows.map(row => ({
        id: row.id,
        name: row.name,
        kind: row.kind === 'board' ? 'board' : 'design',
        team: row.team,
        role: row.role,
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
    };
  });
}

export type OpenedFile = {
  id: string;
  name: string;
  version: number;
  kind: 'design' | 'board';
  team: string | null;
  doc: DesignDocument;
};

/** One file's document at its current version, if the account may view it and it is not in the trash. */
export async function openFile(principal: Principal, fileId: string): Promise<OpenedFile> {
  return mcpRead(principal, async tx => {
    let row;
    try {
      row = await fileAccess(tx, principal.userId, fileId, 'view');
    } catch (error) {
      if ((error as {status?: number}).status === 404 || (error as {status?: number}).status === 403)
        throw fileNotFound();
      throw error;
    }
    if (row.trashed_at !== null) throw fileNotFound();
    const doc = await storedDocument(tx, row);
    return {
      id: row.id,
      name: row.name,
      version: Number(row.version),
      kind: row.kind === 'board' ? 'board' : 'design',
      team: row.team_name,
      doc,
    };
  });
}

export const fileNotFound = () =>
  new ToolError(
    'not_found',
    'No such file, or this account cannot open it.',
    'Take the file id from morfa_list_files, or ask the person for a link to the file.',
  );
