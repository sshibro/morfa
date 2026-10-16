#!/usr/bin/env node
// No dotenv, inherited PG* configuration, app data mounts or production connections.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {Client} from 'pg';
const exec = promisify(execFile);
const root = fileURLToPath(new URL('../..', import.meta.url));
const compose = path.join(root, 'compose.postgresql-test.yaml');
const permittedFiles = ['state.json', 'cluster.env', 'compose.env', 'init.sql', 'bootstrap-password'];
const dockerEnv = Object.fromEntries(
  ['PATH', 'HOME', 'USER', 'DOCKER_CONFIG', 'TMPDIR'].filter(k => process.env[k]).map(k => [k, process.env[k]]),
);
const fail = message => {
  throw Error(message);
};
let operation = 'argument validation';
async function docker(args, timeout = 30000) {
  try {
    return (await exec('docker', args, {env: dockerEnv, cwd: root, timeout, maxBuffer: 8 * 1024 * 1024})).stdout.trim();
  } catch {
    fail(`Isolated test cluster failed during ${operation}; no credentials were logged.`);
  }
}
async function inspect(kind, name) {
  try {
    return JSON.parse((await exec('docker', [kind, 'inspect', name], {env: dockerEnv, timeout: 10000})).stdout)[0];
  } catch (error) {
    if (error.code === 1) return null;
    throw error;
  }
}
function labelsMatch(labels, id) {
  return labels?.['com.morfa.postgresql-test'] === '1' && labels?.['com.morfa.test-cluster-id'] === id;
}
async function ownedResources(state) {
  const container = await inspect('container', state.containerName);
  const volume = await inspect('volume', state.volumeName);
  if (container && (container.Name !== '/' + state.containerName || !labelsMatch(container.Config?.Labels, state.id)))
    fail('Refusing a container without matching test ownership labels.');
  if (volume && (volume.Name !== state.volumeName || !labelsMatch(volume.Labels, state.id)))
    fail('Refusing a volume without matching test ownership labels.');
  return {container, volume};
}
// `docker compose up` makes the project's default network (<project>_default); removing the container leaves it, and about
// thirty leftovers exhaust Docker's address pools ("all predefined address pools have been fully subnetted"). The project is
// the container's name, so a cluster's network is `morfa-postgres-test-<id>_default`, labelled with that project.
const NETWORK = /^morfa-postgres-test-[a-f0-9]{32}_default$/;
const projectOf = name => name.slice(0, -'_default'.length);
/** Removes one cluster's network when it is that compose project's own; a network already gone is fine. */
async function removeNetwork(name) {
  const network = await inspect('network', name);
  if (!network) return false;
  if (network.Name !== name || network.Labels?.['com.docker.compose.project'] !== projectOf(name))
    fail('Refusing a network without matching compose project labels.');
  if (Object.keys(network.Containers ?? {}).length) return false;
  try {
    await exec('docker', ['network', 'rm', name], {env: dockerEnv, timeout: 30000});
  } catch {
    // Removed meanwhile (another cleanup), or a container joined it: either way it is not a leftover to remove now.
  }
  return true;
}
/** Every test cluster's network whose compose project has no container left, running or stopped, and that is older than a grace
 *  period (default ten minutes, so a cluster another `up` is starting right now keeps its network): what earlier `down`s left
 *  behind. A stopped cluster (a Docker or machine restart) keeps its network: its container still refers to it by id, and
 *  `docker network inspect` lists only running containers. */
async function removeStaleNetworks() {
  const grace = Number(process.env.MORFA_TEST_NETWORK_GRACE_SECONDS ?? 600) * 1000;
  const names = (await docker(['network', 'ls', '--filter', 'name=morfa-postgres-test-', '--format', '{{.Name}}'])).split('\n');
  for (const name of names.filter(name => NETWORK.test(name))) {
    const network = await inspect('network', name);
    if (!network || network.Labels?.['com.docker.compose.project'] !== projectOf(name)) continue;
    if (Object.keys(network.Containers ?? {}).length) continue;
    const members = await docker(['container', 'ls', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${projectOf(name)}`]);
    if (members) continue;
    if (Date.now() - Date.parse(network.Created) < grace) continue;
    await removeNetwork(name);
  }
}
function validateState(s) {
  if (
    s?.version !== 1 ||
    !/^[a-f0-9]{32}$/.test(s.id) ||
    !/^[a-f0-9]{64}$/.test(s.token) ||
    !/^[a-f0-9]{64}$/.test(s.bootstrapPassword) ||
    !/^[a-f0-9]{64}$/.test(s.adminPassword) ||
    !Number.isInteger(s.port) ||
    s.port < 1025 ||
    s.port > 65535 ||
    s.port === 5432 ||
    s.containerName !== 'morfa-postgres-test-' + s.id ||
    s.volumeName !== s.containerName + '-data' ||
    s.bootstrapRole !== 'morfa_test_bootstrap_' + s.id ||
    s.adminRole !== 'morfa_test_admin_' + s.id ||
    s.controlDatabase !== 'morfa_test_control_' + s.id
  )
    fail('Refusing malformed test cluster state.');
}
async function freePort(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  }).catch(() => fail('Requested loopback test port is occupied.'));
  await new Promise(resolve => server.close(resolve));
}
async function privateFile(dir, name, contents, mode = 0o600) {
  const file = path.join(dir, name);
  const old = await fs.lstat(file).catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (old && (!old.isFile() || old.isSymbolicLink())) fail('Refusing a non-regular private test state file.');
  await fs.writeFile(file, contents, {mode});
  await fs.chmod(file, mode);
}
async function verifyDatabase(state) {
  const client = new Client({
    host: '127.0.0.1',
    port: state.port,
    user: state.adminRole,
    password: state.adminPassword,
    database: state.controlDatabase,
    ssl: false,
    connectionTimeoutMillis: 5000,
    statement_timeout: 5000,
    query_timeout: 7000,
    options: '-c search_path=public',
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const result = await client.query(
      `SELECT cluster_id,token,format_version,current_user AS username,current_database() AS database,current_setting('server_version_num')::int AS version FROM morfa_test_guard.cluster`,
    );
    const row = result.rows[0];
    if (
      result.rowCount !== 1 ||
      row.cluster_id !== state.id ||
      row.token !== state.token ||
      row.format_version !== 1 ||
      row.username !== state.adminRole ||
      row.database !== state.controlDatabase ||
      row.version < 180000 ||
      row.version >= 190000
    )
      fail('PostgreSQL test cluster marker mismatch.');
  } catch {
    fail('PostgreSQL test cluster marker verification failed.');
  } finally {
    await client.end().catch(() => {});
  }
}

try {
  const args = process.argv.slice(2),
    command = args.shift();
  if (!['up', 'down', 'status'].includes(command))
    fail('Usage: test-cluster.mjs up|down|status --state-dir /absolute/private/path [--port 55432]');
  let directory,
    port = 55432;
  while (args.length) {
    const key = args.shift(),
      value = args.shift();
    if (key === '--state-dir' && value && !directory) directory = value;
    else if (key === '--port' && value && command === 'up' && /^\d+$/.test(value)) port = Number(value);
    else fail('Unknown or incomplete test-cluster argument.');
  }
  if (
    !directory ||
    !path.isAbsolute(directory) ||
    !Number.isInteger(port) ||
    port < 1025 ||
    port > 65535 ||
    port === 5432
  )
    fail('Provide an absolute state directory and a nonstandard private test port.');
  directory = path.resolve(directory);
  const previousDir = await fs
    .lstat(directory)
    .catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));
  if (previousDir && (!previousDir.isDirectory() || previousDir.isSymbolicLink()))
    fail('State directory must be a regular private directory.');
  if (!previousDir && command !== 'up') fail('No test cluster state exists at this directory.');
  const missing = [];
  let ancestor = directory;
  while (!(await fs.lstat(ancestor).catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error))))) {
    missing.unshift(path.basename(ancestor));
    ancestor = path.dirname(ancestor);
  }
  const realDirectory = path.join(await fs.realpath(ancestor), ...missing),
    realRoot = await fs.realpath(root);
  if (realDirectory === realRoot || realDirectory.startsWith(realRoot + path.sep))
    fail('Test credentials/state must live outside the repository.');
  await fs.mkdir(directory, {recursive: true, mode: 0o700});
  const dirStat = await fs.stat(directory);
  if (typeof process.getuid === 'function' && dirStat.uid !== process.getuid())
    fail('Test state directory must belong to the current user.');
  for (const name of await fs.readdir(directory))
    if (!permittedFiles.includes(name)) fail('State directory contains files not owned by this test-cluster tool.');
  if (dirStat.mode & 0o077)
    fail('Test state directory must already be private (mode 0700); existing permissions were not changed.');
  // Mutation is only allowed through the local Docker socket, never a remote daemon.
  if (process.env.DOCKER_HOST || process.env.DOCKER_CONTEXT)
    fail('Unset Docker endpoint overrides before using the isolated test-cluster tool.');
  operation = 'local Docker context verification';
  const context = await docker(['context', 'show']);
  const contextInfo = JSON.parse(await docker(['context', 'inspect', context]))[0];
  if (!contextInfo?.Endpoints?.docker?.Host?.startsWith('unix://'))
    fail('Only a local Unix-socket Docker context is allowed.');
  const statePath = path.join(directory, 'state.json');
  let state;
  try {
    const stat = await fs.lstat(statePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
      fail('Test cluster state must be a private regular file.');
    state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    validateState(state);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!state && command !== 'up') fail('No initialized test cluster state found.');
  if (!state) {
    operation = 'loopback port availability check';
    await freePort(port);
    const id = randomBytes(16).toString('hex');
    state = {
      version: 1,
      id,
      token: randomBytes(32).toString('hex'),
      port,
      containerName: 'morfa-postgres-test-' + id,
      volumeName: 'morfa-postgres-test-' + id + '-data',
      bootstrapRole: 'morfa_test_bootstrap_' + id,
      bootstrapPassword: randomBytes(32).toString('hex'),
      adminRole: 'morfa_test_admin_' + id,
      adminPassword: randomBytes(32).toString('hex'),
      controlDatabase: 'morfa_test_control_' + id,
    };
    await privateFile(directory, 'state.json', JSON.stringify(state));
  } else if (command === 'up' && port !== state.port) fail('The requested port differs from the saved cluster port.');
  let resources = await ownedResources(state);
  if (command === 'down') {
    operation = 'owned test container removal';
    if (resources.container) await docker(['container', 'rm', '--force', resources.container.Id]);
    operation = 'owned test volume removal';
    if (resources.volume) await docker(['volume', 'rm', state.volumeName]);
    operation = 'owned test network removal';
    await removeNetwork(state.containerName + '_default');
    // Only these known regular files, never recursive removal or broad Docker pruning.
    for (const name of permittedFiles) {
      const file = path.join(directory, name),
        stat = await fs.lstat(file).catch(error => (error.code === 'ENOENT' ? null : Promise.reject(error)));
      if (stat && (!stat.isFile() || stat.isSymbolicLink())) fail('Refusing cleanup of an unexpected state file.');
      if (stat) await fs.unlink(file);
    }
    console.log(JSON.stringify({status: 'removed', stateDir: directory}));
  } else if (command === 'status') {
    const running = resources.container?.State?.Running === true;
    if (running) await verifyDatabase(state);
    console.log(
      JSON.stringify({
        status: running ? 'ready' : 'stopped',
        stateDir: directory,
        envFile: path.join(directory, 'cluster.env'),
        port: state.port,
      }),
    );
  } else {
    if (!resources.container) await freePort(state.port);
    const init = `CREATE ROLE "${state.adminRole}" LOGIN NOSUPERUSER CREATEDB CREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD '${state.adminPassword}';
REVOKE ALL ON DATABASE "${state.controlDatabase}" FROM PUBLIC;
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE "${state.controlDatabase}" TO "${state.adminRole}";
CREATE SCHEMA morfa_test_guard;
CREATE TABLE morfa_test_guard.cluster(cluster_id text PRIMARY KEY,token text NOT NULL,format_version integer NOT NULL);
INSERT INTO morfa_test_guard.cluster VALUES('${state.id}','${state.token}',1);
CREATE TABLE morfa_test_guard.allocations(database_name text PRIMARY KEY CHECK(database_name ~ '^morfa_test_[a-f0-9]{32}$'),proof text NOT NULL,roles jsonb NOT NULL);
REVOKE ALL ON ALL TABLES IN SCHEMA morfa_test_guard FROM PUBLIC;
GRANT USAGE ON SCHEMA morfa_test_guard TO "${state.adminRole}";
GRANT SELECT ON morfa_test_guard.cluster TO "${state.adminRole}";
GRANT SELECT,INSERT,DELETE ON morfa_test_guard.allocations TO "${state.adminRole}";
`;
    // Container postgres UID must read these files; the host parent remains mode 0700.
    await privateFile(directory, 'init.sql', init, 0o644);
    await privateFile(directory, 'bootstrap-password', state.bootstrapPassword + '\n', 0o644);
    const composeEnv = {
      MORFA_TEST_CONTAINER: state.containerName,
      MORFA_TEST_VOLUME: state.volumeName,
      MORFA_TEST_CLUSTER_ID: state.id,
      MORFA_TEST_BOOTSTRAP_ROLE: state.bootstrapRole,
      MORFA_TEST_CONTROL_DATABASE: state.controlDatabase,
      MORFA_TEST_PORT: state.port,
      MORFA_TEST_STATE_DIR: directory,
    };
    if (/[\r\n#"'$]/.test(directory)) fail('Use a simple private path without env-file metacharacters.');
    await privateFile(
      directory,
      'compose.env',
      Object.entries(composeEnv)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
    );
    const testUrl = `postgresql://${state.adminRole}:${state.adminPassword}@127.0.0.1:${state.port}/${state.controlDatabase}`;
    await privateFile(
      directory,
      'cluster.env',
      `MORFA_TEST_DATABASE_URL=${testUrl}\nMORFA_TEST_CLUSTER_ID=${state.id}\nMORFA_TEST_CLUSTER_TOKEN=${state.token}\nMORFA_TEST_ENDPOINT=127.0.0.1:${state.port}\n`,
    );
    operation = 'stale test network removal';
    await removeStaleNetworks();
    operation = 'PostgreSQL 18 image availability';
    try {
      await exec('docker', ['image', 'inspect', 'postgres:18'], {env: dockerEnv, timeout: 10000});
    } catch {
      await docker(['pull', 'postgres:18'], 300000);
    }
    operation = 'owned test cluster startup';
    await docker(
      [
        'compose',
        '--project-name',
        state.containerName,
        '--env-file',
        path.join(directory, 'compose.env'),
        '-f',
        compose,
        'up',
        '-d',
        '--no-build',
        '--wait',
        '--wait-timeout',
        '120',
      ],
      150000,
    );
    resources = await ownedResources(state);
    if (!resources.container?.State?.Running) fail('Test cluster did not start.');
    await verifyDatabase(state);
    console.log(
      JSON.stringify({
        status: 'ready',
        postgresMajor: 18,
        envFile: path.join(directory, 'cluster.env'),
        stateDir: directory,
        port: state.port,
      }),
    );
  }
} catch (error) {
  // Errors from PostgreSQL/JSON/Docker may contain private values: emit only known tool messages.
  const message =
    error instanceof Error &&
    /^(Usage:|Unsafe |Refusing |Provide |Unknown |No |State |Test |Only |Unset |Requested |The requested |Isolated |PostgreSQL |Use a simple)/.test(
      error.message,
    )
      ? error.message
      : 'Isolated test cluster operation failed; inspect private state without publishing credentials.';
  console.error(message);
  process.exitCode = 1;
}
