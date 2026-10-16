/** Trusted column references only. Imported SQLite timestamps without an offset
 * mean UTC. Unsupported/nonfinite values are NULL, never granting expiry-based
 * authority or failing an otherwise valid query with an unsafe cast. */
export function finiteUtcInstantSql(column: string): string {
  if (!/^[a-z_][a-z0-9_]*(?:\.[a-z_][a-z0-9_]*)?$/.test(column)) throw Error('Expected a static SQL column reference.');
  const timestamp = `(CASE WHEN ${column} ~ '(Z|[+-][0-9]{2}(:?[0-9]{2})?)$' THEN ${column} ELSE ${column}||'Z' END)`;
  return `(CASE WHEN ${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]{1,6})?(Z|[+-][0-9]{2}(:?[0-9]{2})?)?$'
   AND pg_input_is_valid(${timestamp},'timestamp with time zone')
   THEN CASE WHEN isfinite(${timestamp}::timestamptz) THEN ${timestamp}::timestamptz END END)`;
}

/** History ordering also accepts a retained calendar date as UTC midnight.
 * Keep this separate from expiry/dispatch authority's stricter grammar. */
export function finiteUtcHistoryInstantSql(column: string): string {
  const full = finiteUtcInstantSql(column),
    midnight = `(${column}||'T00:00:00Z')`;
  return `(CASE WHEN ${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
   AND pg_input_is_valid(${midnight},'timestamp with time zone')
   THEN ${midnight}::timestamptz ELSE ${full} END)`;
}
