// Demo data for the operator console (#admin, docs/admin.md): a local database full of synthetic, believable history (accounts that
// sign up, come back and leave, run teams, share and comment) so every screen of the console can be
// seen and checked against the real app. Deterministic from --seed; everything ends at the moment of the run (or --now).
//
//   npx tsx scripts/admin/seed-demo.ts [--database-url <url>] [--accounts 600] [--days 200] [--seed 42]
//                                      [--operator owner@name.invalid] [--now <ISO instant>] [--reset] --yes
//
// The database is --database-url, else MORFA_MIGRATION_DATABASE_URL: the migration role (it owns the tables), migrated to this
// release's schema. The seeder refuses NODE_ENV=production, any host but a loopback one, and a database holding any account that is not
// a name (`…@name.invalid`) or demo (`…@demo.example`) one. A database it seeded before needs --reset, which removes exactly the
// rows that run wrote (its marker in launch_audit lists them) and seeds again. Everything is written in one transaction.
import {randomUUID} from 'node:crypto';
import {DatabaseError} from '../../server/postgresql/errors';
import {assertDatabaseReady} from '../../server/postgresql/migrations';
import {
  MARKER_ID,
  SeedRefusal,
  assertDemoOnly,
  describeDatabase,
  openDatabase,
  readMarker,
  readSummary,
  seedDatabaseConfig,
  wipeDemo,
  writeTables,
  type Marker,
} from './seed/database';
import {DAY, iso, textTime} from './seed/time';
import {buildWorld} from './seed/world';

const USAGE = `Usage: npx tsx scripts/admin/seed-demo.ts [--database-url <url>] [--accounts 600] [--days 200] [--seed 42]
       [--operator owner@name.invalid] [--now <ISO instant>] [--reset] --yes

Seeds a local database with demo history for the operator console. The database is --database-url or
MORFA_MIGRATION_DATABASE_URL (the migration role); only a loopback host, never production. --reset replaces
an earlier demo seed (and nothing else). --yes is required.`;
/** The addresses name sign-in makes (shared/sign-in.ts `nameAddress`): the operator account must be one, so typing its name lands in it. */
const NAME_EMAIL = /^[^@\s]{1,100}@name\.invalid$/;

type Args = {
  databaseUrl?: string;
  accounts: number;
  days: number;
  seed: string;
  operator: string;
  now: number;
  reset: boolean;
  yes: boolean;
};

function parseArgs(argv: string[]): Args | 'help' {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return 'help';
    if (arg === '--reset' || arg === '--yes') {
      flags.add(arg);
      continue;
    }
    const [key, inline] = arg.split(/=(.*)/s, 2);
    if (!['--database-url', '--accounts', '--days', '--seed', '--operator', '--now'].includes(key) || values.has(key))
      throw new SeedRefusal(`Unknown or repeated argument ${key}.\n\n${USAGE}`);
    const value = inline ?? argv[++i];
    if (value === undefined || value.startsWith('--')) throw new SeedRefusal(`${key} needs a value.\n\n${USAGE}`);
    values.set(key, value);
  }
  const whole = (key: string, fallback: number, min: number, max: number) => {
    const raw = values.get(key);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max)
      throw new SeedRefusal(`${key} must be a whole number from ${min} to ${max}.`);
    return Number(raw);
  };
  const operator = (values.get('--operator') ?? 'owner@name.invalid').toLowerCase();
  if (!NAME_EMAIL.test(operator)) throw new SeedRefusal('--operator must be a name address, name@name.invalid.');
  const seed = values.get('--seed') ?? '42';
  if (!/^[\w.-]{1,64}$/.test(seed))
    throw new SeedRefusal('--seed must be 1 to 64 letters, digits, dots, dashes or underscores.');
  const nowText = values.get('--now');
  const now = nowText === undefined ? Date.now() : Date.parse(nowText);
  if (!Number.isFinite(now)) throw new SeedRefusal('--now must be an ISO instant, e.g. 2026-10-10T09:00:00Z.');
  return {
    databaseUrl: values.get('--database-url'),
    accounts: whole('--accounts', 600, 20, 5000),
    days: whole('--days', 200, 30, 730),
    seed,
    operator,
    now,
    reset: flags.has('--reset'),
    yes: flags.has('--yes'),
  };
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args === 'help') {
    console.log(USAGE);
    return;
  }
  if (process.env.NODE_ENV === 'production') throw new SeedRefusal('Refusing to seed: NODE_ENV is production.');
  if (!args.yes)
    throw new SeedRefusal('This writes hundreds of thousands of rows into the database. Pass --yes to go ahead.');
  const config = seedDatabaseConfig(args.databaseUrl);
  const where = describeDatabase(config);
  const db = openDatabase(config);
  const started = Date.now();
  try {
    await assertDatabaseReady(db).catch(() => {
      throw new SeedRefusal(
        `The database ${where} is not migrated to this release's schema: run npm run db:migrate first.`,
      );
    });
    const checks = async (sql: Parameters<typeof readMarker>[0]): Promise<Marker | null> => {
      const marker = await readMarker(sql);
      await assertDemoOnly(sql, marker);
      if (marker && !args.reset)
        throw new SeedRefusal(
          `${where} already holds demo data (seed ${marker.seed}, ${marker.accounts} accounts, ${marker.seededAt}). Pass --reset to replace it.`,
        );
      return marker;
    };
    await checks(db);
    const operator = await db.one<{id: string}>('SELECT id FROM users WHERE email=$1 ORDER BY created_at,id LIMIT 1', [
      args.operator,
    ]);
    const operatorId = operator?.id ?? randomUUID();

    const world = buildWorld({accounts: args.accounts, days: args.days, seed: args.seed, now: args.now});
    const built = Date.now();
    let written = 0;
    await db.transaction(async tx => {
      // One seeder at a time per database.
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('morfa-admin-demo-seed'))");
      const marker = await checks(tx);
      if (marker) await wipeDemo(tx, marker);
      if (!operator)
        await tx.execute(
          "INSERT INTO users(id,email,name,password,email_verified,created_at) VALUES($1,$2,$3,'',1,$4)",
          [operatorId, args.operator, args.operator.split('@')[0], textTime(args.now - (args.days + 1) * DAY)],
        );
      written = await writeTables(tx, world.tables);
      const record: Marker = {
        format: 1,
        seed: args.seed,
        accounts: args.accounts,
        days: args.days,
        now: iso(args.now),
        seededAt: new Date().toISOString(),
        operator: {id: operatorId, email: args.operator, created: !operator || !!marker?.operator.created},
        users: world.users,
      };
      await tx.execute(
        "INSERT INTO launch_audit(id,user_id,project_id,action,result) VALUES($1,NULL,NULL,'admin_demo_seed',$2)",
        [MARKER_ID, JSON.stringify(record)],
      );
    });
    const done = Date.now();
    const summary = await readSummary(db, world.users, iso(args.now));
    const width = Math.max(...summary.rows.map(([k]) => k.length));
    console.log(
      `\nDemo data in ${where}: seed ${args.seed}, ${args.accounts} accounts over ${args.days} days to ${iso(args.now)}.`,
    );
    console.log(
      `${written.toLocaleString('en')} rows in ${seconds(done - started)} (model ${seconds(built - started)}, write ${seconds(done - built)}).\n`,
    );
    for (const [key, value] of summary.rows) console.log(`  ${key.padEnd(width)}  ${value}`);
    console.log(`
The operator account is ${args.operator} (${operator ? 'kept' : 'created'}): sign in by typing the name "${args.operator.split('@')[0]}"
and start the API with
  MORFA_OPERATORS=${args.operator}`);
  } finally {
    await db.close();
  }
}

main().catch(error => {
  if (error instanceof SeedRefusal) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  // Database failures carry no SQL, parameters or credentials (server/postgresql/errors.ts); name the constraint when there is one.
  if (error instanceof DatabaseError)
    console.error(
      `Seeding failed: ${error.message}${error.constraint ? ` (${error.table ?? '?'}.${error.constraint})` : ''} [${error.code}]`,
    );
  else console.error('Seeding failed:', error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
