import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignTeamEmailInvitesForTest} from './postgresql-design-team-email-invites-inverse';

/** The fixed caps SQL013 (docs/decisions/big-files.md) took out of the database: 20 MB of JSON, 50 000 layers. */
export const FIXED_DOCUMENT_BYTES = 20971520;
export const FIXED_NODE_COUNT = 50000;

/**
 * Test-only inverse of SQL013 in a guarded temporary database (the caller holds the migration lock and checked the database name):
 * the fixed caps come back as the check constraints of design_files and design_file_versions, and its ledger row goes (SQL014's
 * first, when it is there). A database without SQL013 is left alone, so every older inverse can call it first (the SQL012 inverse does). Refuses what only SQL013 can
 * hold: a file or a saved version past the fixed caps.
 */
export async function removeDesignBigFilesForTest(tx: TransactionContext): Promise<boolean> {
  await removeDesignTeamEmailInvitesForTest(tx);
  const present = await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.postgres_migrations WHERE version=13');
  if (!present!.n) return false;
  const retained = async (sql: string) => (await tx.one<{n: number}>(sql))!.n;
  assert.equal(await retained(`SELECT count(*)::int AS n FROM public.design_files WHERE bytes>${FIXED_DOCUMENT_BYTES} OR node_count>${FIXED_NODE_COUNT} OR octet_length(document)>${FIXED_DOCUMENT_BYTES}`), 0, 'Retained big files forbid the inverse');
  assert.equal(await retained(`SELECT count(*)::int AS n FROM public.design_file_versions WHERE bytes>${FIXED_DOCUMENT_BYTES} OR octet_length(document)>${FIXED_DOCUMENT_BYTES}`), 0, 'Retained big versions forbid the inverse');
  await tx.execute(`ALTER TABLE public.design_files
    DROP CONSTRAINT design_files_document_check, DROP CONSTRAINT design_files_bytes_check, DROP CONSTRAINT design_files_node_count_check,
    ADD CONSTRAINT design_files_document_check CHECK(octet_length(document) BETWEEN 2 AND ${FIXED_DOCUMENT_BYTES}),
    ADD CONSTRAINT design_files_bytes_check CHECK(bytes BETWEEN 2 AND ${FIXED_DOCUMENT_BYTES}),
    ADD CONSTRAINT design_files_node_count_check CHECK(node_count BETWEEN 0 AND ${FIXED_NODE_COUNT})`);
  await tx.execute(`ALTER TABLE public.design_file_versions
    DROP CONSTRAINT design_file_versions_document_check, DROP CONSTRAINT design_file_versions_bytes_check,
    ADD CONSTRAINT design_file_versions_document_check CHECK(octet_length(document) BETWEEN 2 AND ${FIXED_DOCUMENT_BYTES}),
    ADD CONSTRAINT design_file_versions_bytes_check CHECK(bytes BETWEEN 2 AND ${FIXED_DOCUMENT_BYTES})`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=13');
  return true;
}
