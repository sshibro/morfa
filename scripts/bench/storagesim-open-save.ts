// Lane BF: S1 and S3 on the collab checkpoint path for one bench file (docs/TARGETS.md §5, docs/decisions/big-files.md §8
// step 2): a migrated database in the lane's test cluster, then B2's `storagesim open-save` (the checkpoint written off the hot
// thread and the cold load of checkpoint + a 1 000-row journal tail, `--runs` times) on the file, with the big-files switch on.
//
//   tsx scripts/bench/storagesim-open-save.ts [--doc fixtures/bench/f100k.json] [--tail 1000] [--runs 3] [--format bin]
//
// Needs the cluster env (MORFA_TEST_DATABASE_URL… from <state>/cluster.env) and a release build of storagesim
// (cargo build --release -p morfa-storagesim; CARGO_TARGET_DIR is read). For B5 on bench-ru: the same command there.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdtempSync, rmSync} from 'node:fs';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';
import {createPostgresqlTestDatabase} from '../../tests/helpers/postgresql';
import {createDatabase} from '../../server/postgresql/client';
import {loadDatabaseConfig} from '../../server/postgresql/config';
import {migrateDatabase} from '../../server/postgresql/migrations';
import {ROOT} from './lib/targets';

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
};
const doc = path.resolve(ROOT, arg('doc', 'fixtures/bench/f100k.json'));
if (!existsSync(doc)) throw Error(`${doc} is missing: tsx scripts/bench/gen-file.ts --name f100k`);
const target = process.env.CARGO_TARGET_DIR || path.join(homedir(), '.cache/morfa-target/gate');
const binary = path.join(target, 'release/storagesim');
if (!existsSync(binary)) throw Error(`${binary} is missing: CARGO_TARGET_DIR=${target} cargo build --release -p morfa-storagesim`);

const isolated = await createPostgresqlTestDatabase();
const store = mkdtempSync(path.join(tmpdir(), 'morfa-bf-open-save-'));
try {
  const migration = createDatabase(loadDatabaseConfig('migration', {...isolated.env}));
  await migrateDatabase(migration, {mode: 'fresh', runtimeRole: isolated.roles.runtime, backupRole: isolated.roles.backup});
  await migration.close();
  const args = ['open-save', '--db', isolated.migrationUrl, '--doc', doc, '--tail', arg('tail', '1000'), '--runs', arg('runs', '3'), '--format', arg('format', 'bin'), '--store', store];
  console.log(`storagesim ${args.filter(a => !a.startsWith('postgresql://')).join(' ')} (MORFA_BIG_FILES=1, load ${process.platform === 'linux' ? (await import('node:os')).loadavg().map(n => n.toFixed(2)).join(' ') : '?'})`);
  const run = spawnSync(binary, args, {stdio: 'inherit', env: {...process.env, MORFA_BIG_FILES: '1'}});
  process.exitCode = run.status ?? 1;
} finally {
  rmSync(store, {recursive: true, force: true});
  await isolated.close();
}
