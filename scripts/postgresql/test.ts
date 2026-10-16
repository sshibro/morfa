import {spawn} from 'node:child_process';
import {readdir} from 'node:fs/promises';
import {postgresqlTestConfigured} from '../../tests/helpers/postgresql';

// npm run test:pg: every tests/postgresql-*.test.ts against the isolated test cluster (docs/dev.md).
// It must never succeed by skipping every database test, so it refuses to run without the cluster's env.
if (!postgresqlTestConfigured())
  throw Error('Load the isolated PostgreSQL test-cluster environment (MORFA_TEST_*) before running test:pg; see docs/dev.md.');
// Each file migrates its own throwaway database; four at a time keeps one test cluster and this machine responsive.
const DEFAULT_CONCURRENCY = 4;
const concurrency = Number(process.env.MORFA_PG_TEST_CONCURRENCY || DEFAULT_CONCURRENCY);
if (!Number.isInteger(concurrency) || concurrency < 1) throw Error('MORFA_PG_TEST_CONCURRENCY must be a positive integer.');
const files = (await readdir('tests'))
  .filter(name => /^postgresql-.*\.test\.ts$/.test(name))
  .sort()
  .map(name => 'tests/' + name);
if (!files.length) throw Error('No PostgreSQL acceptance tests found.');
const child = spawn(process.execPath, ['--import', 'tsx', '--test', `--test-concurrency=${concurrency}`, ...files], {stdio: 'inherit', env: process.env});
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
