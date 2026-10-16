// The account's data export (GET /api/settings/data-export, Russian Federal Law 152-FZ): the profile, the design files with their documents and
// versions, teams, comments, ballots and pictures' metadata, and the conversation with support.
// Captured in one read-only snapshot into an anonymous spool, then sent, so a slow client never holds a database connection.
import type {Response} from 'express';
import {mkdtemp, open, rmdir, unlink, type FileHandle} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {pipeline} from 'node:stream/promises';
import {db} from '../db';
import type {SqlExecutor} from '../postgresql/client';
import type {CustomerAuthority} from '../customer-authority';
import {fail} from '../hosting/errors';
import {prepareExportMetadata} from './export-json';
import {exportDesignAccount} from '../design/lifecycle';
import {exportSupport} from '../support/store';

/** At most this many exports run at once, and one per account. */
const EXPORTS_AT_ONCE = 2;
const exporting = new Set<string>();

/** The account behind the exact session, or 401. */
async function identity(sql: SqlExecutor, actor: CustomerAuthority) {
  const user = await sql.one<{name: string; email: string; created_at: string; expires: number}>(
    `SELECT u.name,u.email,u.created_at,s.expires FROM users u JOIN sessions s ON s.user_id=u.id
     WHERE u.id=$1 AND s.token=$2 AND u.deletion_requested_at IS NULL`,
    [actor.ownerId, actor.sessionHash],
  );
  if (!user || user.expires <= Date.now()) return fail(401, 'unauthenticated', 'Sign in to your account.');
  return {id: actor.ownerId, name: user.name, email: user.email, createdAt: user.created_at};
}

export async function streamAccountExport(res: Response, actor: CustomerAuthority): Promise<void> {
  const owner = actor.ownerId;
  if (exporting.has(owner) || exporting.size >= EXPORTS_AT_ONCE)
    fail(429, 'export_busy', 'An export is already running. Try again later.');
  exporting.add(owner);
  let file: FileHandle | undefined;
  try {
    const directory = await mkdtemp(path.join(tmpdir(), 'morfa-account-export-'));
    const filename = path.join(directory, 'account.json');
    file = await open(filename, 'wx+', 0o600);
    // The descriptor stays open; no named file with the account's data is ever left behind.
    await unlink(filename);
    await rmdir(directory);
    const write = async (text: string) => {
      if (res.destroyed) throw Error('Export connection closed.');
      await file!.writeFile(text);
    };
    await db.transaction(
      async tx => {
        const writeMetadata = prepareExportMetadata({
          profile: await identity(tx, actor),
          design: exportDesignAccount(owner),
          support: exportSupport(owner),
        });
        await write('{');
        await writeMetadata(tx, write);
        await write('}');
      },
      {readOnly: true, isolation: 'repeatable read'},
    );
    // Recheck the session outside the snapshot, before any byte of the account's data leaves the spool.
    await identity(db, actor);
    res.attachment('morfa-account.json').type('application/json');
    await pipeline(file.createReadStream({start: 0, autoClose: false}), res);
  } finally {
    try {
      await file?.close();
    } finally {
      exporting.delete(owner);
    }
  }
}
