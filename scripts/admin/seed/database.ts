// The seeder's side of PostgreSQL: which database it may touch (a loopback one, never production, with the migration role), what it
// finds there (its own earlier run, or anybody else's accounts), how it removes exactly its own rows, how it writes a whole table in
// a few multi-row statements, and the summary it reads back from what was written.
import {
  createDatabase,
  type Database,
  type SqlExecutor,
  type TransactionContext,
} from '../../../server/postgresql/client';
import {loadDatabaseConfig, type DatabaseConfig} from '../../../server/postgresql/config';
import {TABLE_ORDER, type Tables} from './tables';
import {DEMO_DOMAIN} from './texts';

/** A refusal the command explains and exits on (no stack, nothing secret). */
export class SeedRefusal extends Error {}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
/** The seeder's own row in launch_audit: what it wrote last time, so `--reset` removes exactly that. */
export const MARKER_ID = 'admin-demo-seed';
export type Marker = {
  format: 1;
  seed: string;
  accounts: number;
  days: number;
  now: string;
  seededAt: string;
  operator: {id: string; email: string; created: boolean};
  users: string[];
};

/**
 * The database to seed: `--database-url`, else MORFA_MIGRATION_DATABASE_URL (the role that owns the tables: the seeder deletes ledger
 * rows on `--reset`, which the runtime role may not). The same parsing and checks as the app's
 * (server/postgresql/config.ts: no ambient PG* variables, TLS unless local), and on top: never production, loopback hosts only.
 */
export function seedDatabaseConfig(url: string | undefined, env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  if (env.NODE_ENV === 'production') throw new SeedRefusal('Refusing to seed: NODE_ENV is production.');
  const source = url ?? env.MORFA_MIGRATION_DATABASE_URL;
  if (!source)
    throw new SeedRefusal(
      'Pass --database-url or set MORFA_MIGRATION_DATABASE_URL (the migration role of a local database).',
    );
  let config: DatabaseConfig;
  try {
    config = loadDatabaseConfig('migration', {...env, MORFA_MIGRATION_DATABASE_URL: source});
  } catch (error) {
    throw new SeedRefusal(
      `Refusing to seed: ${error instanceof Error ? error.message : 'the database URL is invalid.'}`,
    );
  }
  if (!LOOPBACK.has(config.host))
    throw new SeedRefusal(
      `Refusing to seed ${config.host}: only a loopback database (127.0.0.1, localhost, ::1) may hold demo data.`,
    );
  if (config.production) throw new SeedRefusal('Refusing to seed a production database.');
  return config;
}

/** `host:port/database`, never the user or the password. */
export const describeDatabase = (config: DatabaseConfig) =>
  `${config.host.includes(':') ? `[${config.host}]` : config.host}:${config.port}/${config.database}`;

export const openDatabase = (config: DatabaseConfig): Database => createDatabase(config);

export async function readMarker(sql: SqlExecutor): Promise<Marker | null> {
  const row = await sql.one<{result: string}>('SELECT result FROM launch_audit WHERE id=$1', [MARKER_ID]);
  if (!row) return null;
  const marker = JSON.parse(row.result) as Marker;
  if (marker.format !== 1 || !Array.isArray(marker.users))
    throw new SeedRefusal('The demo marker in launch_audit is not one this seeder wrote.');
  return marker;
}

/**
 * Refuses a database that holds anybody's account: only name accounts (`…@name.invalid`) and the accounts this seeder wrote
 * (`…@demo.example`, and its erased ones, which no longer carry an address) may be there.
 */
export async function assertDemoOnly(sql: SqlExecutor, marker: Marker | null): Promise<void> {
  const row = await sql.one<{foreign: number; demo: number}>(
    `SELECT count(*) FILTER (WHERE NOT (email LIKE '%@name.invalid' OR email LIKE $1 OR id = ANY($2::text[])))::int AS foreign,
            count(*) FILTER (WHERE email LIKE $1 AND NOT id = ANY($2::text[]))::int AS demo
     FROM users`,
    ['%@' + DEMO_DOMAIN, marker?.users ?? []],
  );
  if (row!.foreign > 0)
    throw new SeedRefusal(
      `Refusing to seed: the database holds ${row!.foreign} account(s) that are neither name (@name.invalid) nor demo (@${DEMO_DOMAIN}) accounts.`,
    );
  if (row!.demo > 0)
    throw new SeedRefusal(
      `Refusing to seed: ${row!.demo} @${DEMO_DOMAIN} account(s) exist that this seeder did not record. Remove them first.`,
    );
}

/** Removes every row an earlier run wrote (and nothing else): its accounts with all they own, the marker. */
export async function wipeDemo(tx: TransactionContext, marker: Marker): Promise<void> {
  const users = marker.users;
  // launch_audit: what the running app audited for demo accounts since.
  await tx.execute('DELETE FROM launch_audit WHERE user_id = ANY($1::text[])', [users]);
  await tx.execute("DELETE FROM erasure_ledger WHERE kind='account' AND id = ANY($1::text[])", [users]);
  // Teams and files first, as the app's erasure does: in one cascading DELETE of the accounts PostgreSQL may set a thread's author to
  // NULL after another path already took the thread's file, and refuse. Versions, pictures, comments, libraries and meetings go with
  // their files; sessions and the journal with the account rows.
  await tx.execute('DELETE FROM design_teams WHERE owner_id = ANY($1::text[])', [users]);
  await tx.execute('DELETE FROM design_files WHERE user_id = ANY($1::text[])', [users]);
  await tx.execute('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await tx.execute('DELETE FROM launch_audit WHERE id=$1', [MARKER_ID]);
}

/** Rows per statement, and the text a statement may carry (documents are large). */
const CHUNK_ROWS = 5000;
const CHUNK_CHARS = 24_000_000;

/** Writes every table, parents first: one `INSERT … SELECT FROM unnest(…)` per chunk. Returns the rows written. */
export async function writeTables(tx: TransactionContext, tables: Tables): Promise<number> {
  let written = 0;
  for (const name of TABLE_ORDER) {
    const table = tables[name];
    if (!table.rows.length) continue;
    const columns = table.columns,
      types = table.types;
    const sql = `INSERT INTO ${name}(${columns.map(c => `"${c}"`).join(',')}) SELECT * FROM unnest(${types
      .map((type, i) => `$${i + 1}::${type}[]`)
      .join(',')})`;
    let start = 0;
    while (start < table.rows.length) {
      let end = start,
        chars = 0;
      while (end < table.rows.length && end - start < CHUNK_ROWS && chars < CHUNK_CHARS) {
        for (const value of Object.values(table.rows[end])) if (typeof value === 'string') chars += value.length;
        end++;
      }
      const slice = table.rows.slice(start, end) as Record<string, unknown>[];
      const params = columns.map(column => slice.map(row => row[column] ?? null));
      await tx.execute(sql, params);
      written += slice.length;
      start = end;
    }
  }
  return written;
}

export type Summary = {rows: [string, string][]};

/** What was written, read back with SQL: the console's headline numbers, in the console's own terms. */
export async function readSummary(sql: SqlExecutor, users: string[], now: string): Promise<Summary> {
  const one = async <T extends Record<string, unknown>>(text: string, params: unknown[]) => (await sql.one<T>(text, params))!;
  const accounts = await one<{total: number; closing: number}>(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE deletion_requested_at IS NOT NULL)::int AS closing
     FROM users WHERE id = ANY($1::text[]) AND erasure_completed_at IS NULL`,
    [users],
  );
  const at = '$1::timestamptz';
  const usage = await one<{
    activity: number;
    files: number;
    trashed: number;
    versions: number;
    dau: number;
    teams: number;
    threads: number;
  }>(
    `SELECT (SELECT count(*)::int FROM admin_activity) AS activity,
      (SELECT count(*)::int FROM design_files WHERE trashed_at IS NULL) AS files,
      (SELECT count(*)::int FROM design_files WHERE trashed_at IS NOT NULL) AS trashed,
      (SELECT count(*)::int FROM design_file_versions) AS versions,
      (SELECT round(avg(n))::int FROM (SELECT count(DISTINCT user_id) AS n FROM admin_activity
        WHERE created_at::timestamptz>${at}-interval '30 days' GROUP BY date_trunc('day', created_at::timestamptz AT TIME ZONE 'Europe/Moscow')) d) AS dau,
      (SELECT count(*)::int FROM design_teams) AS teams,
      (SELECT count(*)::int FROM design_comment_threads) AS threads`,
    [now],
  );
  return {
    rows: [
      ['accounts (demo, not erased)', String(accounts.total)],
      ['  closing', String(accounts.closing)],
      ['activity rows', String(usage.activity)],
      ['DAU, last 30 d (mean)', String(usage.dau)],
      ['files (in trash)', `${usage.files} (${usage.trashed})`],
      ['versions', String(usage.versions)],
      ['teams / comment threads', `${usage.teams} / ${usage.threads}`],
    ],
  };
}
