import type {SqlExecutor, TransactionContext} from '../postgresql/client';
import {DESIGN_DOCUMENT_CAPS} from '../../shared/design/limits';
import {designFail} from './errors';

// The room an account has for design documents: the JSON of the files it holds (`user_id`: its personal files and those of the teams
// it owns), of their saved versions and of their shared libraries' versions, the trash included (docs/design-tool.md §Server API).

/** DESIGN_DOCUMENT_CAPS.accountBytes, or DESIGN_ACCOUNT_DOCUMENT_BYTES when the operator (or a test) sets it. */
export function accountDocumentBytes(): number {
  const value = Number(process.env.DESIGN_ACCOUNT_DOCUMENT_BYTES ?? DESIGN_DOCUMENT_CAPS.accountBytes);
  return Number.isSafeInteger(value) && value > 0 ? value : DESIGN_DOCUMENT_CAPS.accountBytes;
}

export function documentsFull(message?: (size: string) => string): never {
  const cap = accountDocumentBytes();
  const size = cap >= 1024 ** 3 ? `${Math.round((cap / 1024 ** 3) * 10) / 10} GB` : `${Math.max(1, Math.round(cap / 1024 ** 2))} MB`;
  return designFail(
    413,
    'design_documents_limit',
    message?.(size) ?? `Out of storage space: files and their saved versions take more than ${size}. Empty the trash or delete files you don't need.`,
    {limit: cap},
  );
}

/**
 * Room for `adding` more bytes of JSON among the files and saved versions an account holds (`user_id`: its personal files and
 * those of the teams it owns, the trash included), within `accountDocumentBytes()`. A version is a full copy of a document of
 * up to 20 MB made by a request of a few bytes, so without this cap one account could fill the database. Automatic versions
 * give way, oldest first (never `keep`); files and named versions do not. False, with nothing erased, when even without
 * automatic versions there is no room.
 */
export async function makeRoom(tx: TransactionContext, holder: string, adding: number, keep: string | null = null): Promise<boolean> {
  const usage = (await tx.one<{total: number; automatic: number}>(
    `SELECT (SELECT COALESCE(sum(bytes),0) FROM design_files WHERE user_id=$1)
           +(SELECT COALESCE(sum(bytes),0) FROM design_file_versions WHERE user_id=$1)
           +(SELECT COALESCE(sum(bytes),0) FROM design_library_versions WHERE user_id=$1) AS total,
            (SELECT COALESCE(sum(bytes),0) FROM design_file_versions WHERE user_id=$1 AND label IS NULL AND id IS DISTINCT FROM $2) AS automatic`,
    [holder, keep],
  ))!;
  const excess = Number(usage.total) + adding - accountDocumentBytes();
  if (excess <= 0) return true;
  if (excess > Number(usage.automatic)) return false;
  await tx.execute(
    `DELETE FROM design_file_versions WHERE id IN (
       SELECT id FROM (SELECT id,bytes,sum(bytes) OVER (ORDER BY created_at,id) AS through FROM design_file_versions
                       WHERE user_id=$1 AND label IS NULL AND id IS DISTINCT FROM $2) automatic
       WHERE through-bytes<$3)`,
    [holder, keep, excess],
  );
  return true;
}

/** Whether `holder` has room for `adding` more bytes as things are: for a change another account makes (a team handed over), which
 *  never makes anything of the holder's give way. */
export async function hasRoom(tx: SqlExecutor, holder: string, adding: number): Promise<boolean> {
  const usage = (await tx.one<{total: number}>(
    `SELECT (SELECT COALESCE(sum(bytes),0) FROM design_files WHERE user_id=$1)
           +(SELECT COALESCE(sum(bytes),0) FROM design_file_versions WHERE user_id=$1)
           +(SELECT COALESCE(sum(bytes),0) FROM design_library_versions WHERE user_id=$1) AS total`,
    [holder],
  ))!;
  return Number(usage.total) + adding <= accountDocumentBytes();
}
