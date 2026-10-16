import assert from 'node:assert/strict';
import type {TransactionContext} from '../../server/postgresql/client';
import {removeDesignCollabForTest} from './postgresql-design-collab-inverse';

/** The tables SQL040 ("Morfa Design" and "Board" meetings: the shared timer, votes and ballots) adds, dependants first. */
export const DESIGN_MEETING_DROP_ORDER = ['design_meeting_votes', 'design_meetings'] as const;

/**
 * Test-only inverse of SQL040 in a guarded temporary database (the caller holds the migration lock and checked the database name): its
 * empty tables go, and its ledger row (SQL012's first, when it is there). A database without SQL040 is left alone, so every older inverse can call it first (the SQL039
 * inverse does). Refuses retained meetings or ballots, like the other inverses.
 */
export async function removeDesignMeetingsForTest(tx: TransactionContext): Promise<boolean> {
  await removeDesignCollabForTest(tx);
  if ((await tx.one<{name: string | null}>("SELECT to_regclass('public.design_meetings')::text AS name"))!.name === null) return false;
  for (const table of DESIGN_MEETING_DROP_ORDER)
    assert.equal((await tx.one<{n: number}>(`SELECT count(*)::int AS n FROM public.${table}`))!.n, 0, `Retained ${table} forbid the inverse`);
  for (const table of DESIGN_MEETING_DROP_ORDER) await tx.execute(`DROP TABLE public.${table}`);
  await tx.execute('DELETE FROM public.postgres_migrations WHERE version=11');
  return true;
}
