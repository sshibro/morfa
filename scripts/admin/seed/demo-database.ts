// The demo database of scripts/admin/demo-up.sh: one database in the running PostgreSQL test cluster (docs/dev.md), made the way every
// test database is made (tests/helpers/postgresql.ts: its own three roles) but kept after the run, and migrated to this release's schema.
// Its connection settings go to a private env file outside the checkout (mode 0600 in a 0700 directory); a second run reuses the
// database the file names while it still answers. Prints the database's `host:port/name`, never a credential.
//
//   npx tsx scripts/admin/seed/demo-database.ts --write-env ~/.cache/morfa-demo/demo.env   (with the cluster's MORFA_TEST_* loaded)
import {chmod, lstat, mkdir, readFile, realpath, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDatabase} from '../../../server/postgresql/client';
import {loadDatabaseConfig} from '../../../server/postgresql/config';
import {migrateDatabase} from '../../../server/postgresql/migrations';
import {createPostgresqlTestDatabase} from '../../../tests/helpers/postgresql';
import {describeDatabase} from './database';

const KEYS = ['MORFA_DATABASE_URL', 'MORFA_MIGRATION_DATABASE_URL', 'MORFA_BACKUP_DATABASE_URL'] as const;
type DemoEnv = Record<(typeof KEYS)[number], string>;

async function readEnvFile(file: string): Promise<DemoEnv | null> {
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return null;
  const values = Object.fromEntries(
    text
      .split('\n')
      .map(line => /^([A-Z_]+)=(.*)$/.exec(line.trim()))
      .filter(m => m !== null)
      .map(m => [m[1], m[2]]),
  );
  return KEYS.every(key => values[key]) ? (values as DemoEnv) : null;
}

/** Migrates the database the env names (the whole chain on a new one, what is missing on an older one). */
async function migrate(env: DemoEnv): Promise<string> {
  const config = loadDatabaseConfig('migration', {...process.env, ...env});
  const database = createDatabase(config);
  try {
    await migrateDatabase(database, {
      mode: 'fresh',
      runtimeRole: decodeURIComponent(new URL(env.MORFA_DATABASE_URL).username),
      backupRole: decodeURIComponent(new URL(env.MORFA_BACKUP_DATABASE_URL).username),
    });
  } finally {
    await database.close();
  }
  return describeDatabase(config);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== '--write-env')
    throw Error('Usage: demo-database.ts --write-env <path outside the checkout>');
  const file = path.resolve(args[1]);
  const root = await realpath(fileURLToPath(new URL('../../..', import.meta.url)));
  const directory = path.dirname(file);
  await mkdir(directory, {recursive: true, mode: 0o700});
  const real = await realpath(directory);
  if (real === root || real.startsWith(root + path.sep))
    throw Error('Keep the demo env file outside the checkout: it holds passwords.');
  await chmod(directory, 0o700);

  const existing = await readEnvFile(file);
  if (existing) {
    try {
      console.log(JSON.stringify({database: await migrate(existing), reused: true}));
      return;
    } catch {
      // The cluster was recreated since, or the database is gone: make a new one.
    }
  }
  const made = await createPostgresqlTestDatabase();
  const env: DemoEnv = made.env;
  const where = await migrate(env);
  const stat = await lstat(file).catch(() => null);
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw Error('The demo env file path is not a regular file.');
  await writeFile(
    file,
    `# The demo database ${where} in the PostgreSQL test cluster (scripts/admin/demo-up.sh). Private: it holds passwords.\n` +
      KEYS.map(key => `${key}=${env[key]}`).join('\n') +
      '\n',
    {mode: 0o600},
  );
  await chmod(file, 0o600);
  console.log(JSON.stringify({database: where, reused: false}));
}

main().catch(error => {
  // Messages of the cluster helpers and the migration never carry credentials.
  console.error(error instanceof Error ? error.message : 'The demo database could not be prepared.');
  process.exitCode = 1;
});
