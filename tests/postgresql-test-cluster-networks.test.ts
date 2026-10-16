import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import path from 'node:path';

// Lane D step 3: scripts/postgresql/test-cluster.mjs leaves no Docker network behind. `down` removes the compose project's
// default network; `up` removes earlier clusters' leftovers that no container uses. After about thirty leftovers Docker had
// no address pool left and `up` failed (the Mac, 2026-10-10). Needs the local Docker daemon and postgres:18, as test:pg does.

const ROOT = path.resolve(import.meta.dirname, '..');
const SCRIPT = path.join(ROOT, 'scripts/postgresql/test-cluster.mjs');
const docker = (...args: string[]) => execFileSync('docker', args, {encoding: 'utf8'}).trim();
const networks = () =>
  docker('network', 'ls', '--filter', 'name=morfa-postgres-test-', '--format', '{{.Name}}')
    .split('\n')
    .filter(name => /^morfa-postgres-test-[a-f0-9]{32}_default$/.test(name))
    .sort();
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as {port: number}).port;
      server.close(() => resolve(port));
    });
  });
const cluster = (command: 'up' | 'down', dir: string, port?: number, env: Record<string, string> = {}) => {
  const {DOCKER_HOST: _host, DOCKER_CONTEXT: _context, ...rest} = process.env;
  return JSON.parse(
    execFileSync(process.execPath, [SCRIPT, command, '--state-dir', dir, ...(port ? ['--port', String(port)] : [])], {
      encoding: 'utf8',
      env: {...rest, ...env},
      timeout: 240_000,
    }),
  );
};

let dockerReady = true;
try {
  docker('image', 'inspect', 'postgres:18');
} catch {
  dockerReady = false;
}

test('test cluster: up/down leaves no network behind; up removes leftovers no container uses, never a live one', {
  skip: dockerReady ? false : 'no local Docker with postgres:18',
  timeout: 900_000,
}, async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'morfa-network-test-'));
  const stale = `morfa-postgres-test-${randomBytes(16).toString('hex')}_default`;
  try {
    // Networks here already: other clusters' (a live one keeps its container and must stay; old leftovers may go).
    const before = networks();
    const live = before.filter(name => docker('network', 'inspect', name, '--format', '{{len .Containers}}') !== '0');
    for (let round = 1; round <= 3; round++) {
      const dir = path.join(parent, `round-${round}`);
      const start = networks();
      const up = cluster('up', dir, await freePort());
      assert.equal(up.status, 'ready');
      const own = `morfa-postgres-test-${JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')).id}_default`;
      assert.ok(networks().includes(own), `round ${round}: its network while it runs`);
      assert.equal(cluster('down', dir).status, 'removed');
      assert.ok(!networks().includes(own), `round ${round}: its network is gone with it`);
      assert.ok(networks().length <= start.length, `round ${round}: no more networks than before it`);
    }

    // A leftover from before this fix (made by hand, as compose labels it): the next `up` removes it.
    docker('network', 'create', '--label', `com.docker.compose.project=${stale.slice(0, -'_default'.length)}`, stale);
    assert.ok(networks().includes(stale));
    const dir = path.join(parent, 'stale');
    cluster('up', dir, await freePort(), {MORFA_TEST_NETWORK_GRACE_SECONDS: '0'});
    assert.ok(!networks().includes(stale), 'the leftover is removed by up');
    for (const name of live) assert.ok(networks().includes(name), `${name} has a container and stays`);
    cluster('down', dir);
    assert.ok(networks().every(name => before.includes(name)), 'nothing new is left');

    // A stopped cluster (Docker or the machine restarted) keeps its network, however old: its container refers to it by id, and
    // removing it left the container unable to start ("network … not found", found on the gate machine after a restart).
    const stoppedDir = path.join(parent, 'stopped');
    cluster('up', stoppedDir, await freePort());
    const stoppedState = JSON.parse(readFileSync(path.join(stoppedDir, 'state.json'), 'utf8'));
    docker('container', 'stop', stoppedState.containerName);
    cluster('up', path.join(parent, 'another'), await freePort(), {MORFA_TEST_NETWORK_GRACE_SECONDS: '0'});
    assert.ok(networks().includes(`${stoppedState.containerName}_default`), 'the stopped cluster keeps its network');
    assert.equal(cluster('up', stoppedDir, stoppedState.port).status, 'ready', 'and starts again');
    cluster('down', stoppedDir);
    cluster('down', path.join(parent, 'another'));
    assert.ok(networks().every(name => before.includes(name)), 'nothing new is left');
  } finally {
    try {
      docker('network', 'rm', stale);
    } catch {}
    rmSync(parent, {recursive: true, force: true});
  }
});
