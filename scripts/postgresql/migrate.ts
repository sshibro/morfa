import {createDatabase} from '../../server/postgresql/client';
import {loadDatabaseConfig} from '../../server/postgresql/config';
import {DATABASE_SCHEMA_VERSION, migrateDatabase, type MigrationOptions} from '../../server/postgresql/migrations';

// Brings MORFA_MIGRATION_DATABASE_URL's database to this release's schema (server/postgresql/schema/001…): the whole chain on an
// empty schema, the missing migrations on a migrated one. The roles must exist already (deploy/postgres/init-roles.sh).
const usage =
  'Usage: MORFA_MIGRATION_DATABASE_URL=… node --import tsx scripts/postgresql/migrate.ts --mode fresh [--runtime-role morfa_runtime] [--backup-role morfa_backup]';
const values = new Map<string, string>();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 2) {
  const key = args[index],
    value = args[index + 1];
  if (!['--mode', '--runtime-role', '--backup-role'].includes(key) || !value || value.startsWith('--') || values.has(key))
    throw Error(usage);
  values.set(key, value);
}
if (values.get('--mode') !== 'fresh') throw Error(usage);
const options: MigrationOptions = {
  mode: 'fresh',
  runtimeRole: values.get('--runtime-role') ?? 'morfa_runtime',
  backupRole: values.get('--backup-role') ?? 'morfa_backup',
};

// Explicit migration credentials only. No dotenv, application bootstrap or role provisioning.
const database = createDatabase(loadDatabaseConfig('migration'));
try {
  const result = await migrateDatabase(database, options);
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.version > DATABASE_SCHEMA_VERSION)
    process.stderr.write(
      `The database is at schema version ${result.version}, ahead of this release (${DATABASE_SCHEMA_VERSION}). Its migrations allow this release to run; nothing was applied.\n`,
    );
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'PostgreSQL migration failed.') + '\n');
  process.exitCode = 1;
} finally {
  await database.close();
}
