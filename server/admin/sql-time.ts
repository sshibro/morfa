/** Trusted column references only: text timestamps become timestamptz, invalid or infinite values NULL. */
export const sqlTime = (column: string) =>
  `CASE WHEN pg_input_is_valid(${column},'timestamp with time zone') THEN CASE WHEN isfinite(${column}::timestamptz) THEN ${column}::timestamptz END END`;
