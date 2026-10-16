import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignAiPausesForTest} from './postgresql-design-ai-pauses-inverse';
import {removeDesignLibrariesForTest} from './postgresql-design-libraries-inverse';
import {removeDesignCommentsForTest} from './postgresql-design-comments-inverse';

/** The tables SQL034 ("Morfa Design" teams) adds, in drop order (referencing tables first). */
export const DESIGN_TEAM_DROP_ORDER = ['design_team_invites', 'design_team_members', 'design_projects', 'design_teams'] as const;

/**
 * Test-only inverse of SQL034 in a guarded temporary database (the caller holds the migration lock and checked the database name): the
 * columns and constraints it added to design_files and design_images go, then its empty tables. A database without SQL034 is left alone,
 * so every older inverse can call it first. Refuses retained team data, like the other inverses. SQL035 (comments, on the design files) goes
 * first when it is there.
 */
export async function removeDesignTeamsForTest(tx: TransactionContext): Promise<boolean> {
  // Later migrations on the design tables go first, newest first: SQL040–038 (meetings, the kind of a file, saved changes; inside the
  // SQL037 inverse), SQL037 (AI pauses, the refund of our error), SQL036 (shared libraries), then SQL035 (comments).
  await removeDesignAiPausesForTest(tx);
  await removeDesignLibrariesForTest(tx);
  await removeDesignCommentsForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_teams')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_TEAM_DROP_ORDER)
    assert.equal((await tx.one<{n: number}>('SELECT count(*)::int AS n FROM public.' + table))!.n, 0, 'Retained team data forbids the inverse: ' + table);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_files')::text AS name"))!.name !== null) {
    assert.equal(
      await tx.one('SELECT 1 FROM public.design_files WHERE team_id IS NOT NULL OR project_id IS NOT NULL LIMIT 1'),
      undefined,
      'Retained team files forbid the inverse',
    );
    await tx.execute('DROP INDEX public.design_files_team_files');
    await tx.execute('ALTER TABLE public.design_files DROP CONSTRAINT design_files_project_team');
    await tx.execute('ALTER TABLE public.design_files DROP CONSTRAINT design_files_project');
    await tx.execute('ALTER TABLE public.design_files DROP COLUMN project_id');
    await tx.execute('ALTER TABLE public.design_files DROP CONSTRAINT design_files_team');
    await tx.execute('DROP INDEX public.design_images_team');
    await tx.execute('ALTER TABLE public.design_images DROP COLUMN team_id');
  }
  for (const table of DESIGN_TEAM_DROP_ORDER) await tx.execute('DROP TABLE public.' + table);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=5');
  return true;
}
