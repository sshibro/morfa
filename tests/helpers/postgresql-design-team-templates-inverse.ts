import type {TransactionContext} from '../../server/postgresql/client';
import {removeSupportAssistantForTest} from './postgresql-support-assistant-inverse';

/** The tables SQL021 (custom team templates, the voting sessions' history) adds. */
export const DESIGN_TEAM_TEMPLATE_DROP_ORDER = ['design_meeting_sessions', 'design_template_versions', 'design_templates'] as const;

/**
 * Test-only inverse of SQL021 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * tables go, templates and past sessions with them, the meeting's two vote columns go, and its ledger row. Past sessions' ballots stay in
 * design_meeting_votes, as an older release leaves them until it starts the file's next vote. A database without SQL021 is left alone, so
 * every older inverse can call it first (the SQL020 inverse does).
 */
export async function removeDesignTeamTemplatesForTest(tx: TransactionContext): Promise<boolean> {
  // SQL022 first: newer migrations go before older ones.
  await removeSupportAssistantForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_templates')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_TEAM_TEMPLATE_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('ALTER TABLE public.design_meetings DROP COLUMN vote_prompt, DROP COLUMN vote_hide_cursors');
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=21');
  return true;
}
