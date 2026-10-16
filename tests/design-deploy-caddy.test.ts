import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {request} from 'node:https';
import {createServer} from 'node:net';
import {createServer as createHttpServer, type Server} from 'node:http';
import {homedir, tmpdir} from 'node:os';
import path from 'node:path';

// Lane D: production's Caddy sites (deploy/caddy/morfa-sites.caddy + morfa-routes.caddy) run locally on a temp root that holds
// every private path as a real file, so a private path that slips past its 404 to file_server (or to the app's index.html
// fallback) answers 200 here. The 2026-10-10 deploy found /BUILD_COMMIT and /build-graph.json answering 200 on morfa.example:
// `respond @private 404` sorts after a catch-all `handle` in Caddy's directive order.
//
// Needs a Caddy binary: MORFA_CADDY_BIN, `caddy` on PATH, or the pinned one scripts/deploy/fetch-caddy.sh puts in
// ~/.cache/morfa-caddy/caddy. Skipped (with that note) when there is none.

const ROOT = path.resolve(import.meta.dirname, '..');
const CADDY_DIR = path.join(ROOT, 'deploy/caddy');

const findCaddy = (): string | undefined => {
  const candidates = [process.env.MORFA_CADDY_BIN, path.join(homedir(), '.cache/morfa-caddy/caddy')];
  const onPath = spawnSync('sh', ['-c', 'command -v caddy'], {encoding: 'utf8'});
  if (onPath.status === 0 && onPath.stdout.trim()) candidates.splice(1, 0, onPath.stdout.trim());
  return candidates.find(candidate => candidate && existsSync(candidate));
};
const caddy = findCaddy();
const skip = caddy ? false : 'no Caddy binary (MORFA_CADDY_BIN, PATH, or scripts/deploy/fetch-caddy.sh)';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as {port: number}).port;
      server.close(() => resolve(port));
    });
  });

// GET https://<name>:<port><path> on loopback, with the name as SNI and Host (Caddy's local CA: not verified).
const get = (port: number, name: string, urlPath: string) =>
  new Promise<{status: number; body: string}>((resolve, reject) => {
    const req = request(
      {host: '127.0.0.1', port, path: urlPath, servername: name, headers: {host: name}, rejectUnauthorized: false, timeout: 5000},
      res => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', chunk => (body += chunk));
        res.on('end', () => resolve({status: res.statusCode ?? 0, body}));
      },
    );
    req.on('timeout', () => req.destroy(new Error(`timeout: ${name}${urlPath}`)));
    req.on('error', reject);
    req.end();
  });

// Every file a private path could otherwise serve, in the app's root.
const SECRET = 'served-a-private-file';
const PRIVATE_FILES = ['BUILD_COMMIT', 'build-graph.json', 'metrics', 'healthz', 'internal/x', 'internal/index.html', 'api/x', '__bench/x', '__e2e/x'];

const writeTree = (dir: string, label: string) => {
  for (const file of PRIVATE_FILES) {
    mkdirSync(path.dirname(path.join(dir, file)), {recursive: true});
    writeFileSync(path.join(dir, file), SECRET);
  }
  mkdirSync(path.join(dir, 'assets'), {recursive: true});
  writeFileSync(path.join(dir, 'index.html'), `<!doctype html>${label}`);
  writeFileSync(path.join(dir, 'assets/a.js'), `// ${label}`);
};

test('caddy adapt: the production Caddyfile with morfa-sites.caddy and morfa-routes.caddy', {skip}, () => {
  const result = spawnSync(caddy!, ['adapt', '--config', path.join(CADDY_DIR, 'Caddyfile.staging'), '--adapter', 'caddyfile'], {
    cwd: CADDY_DIR,
    encoding: 'utf8',
    env: {...process.env, MORFA_MARKETING_DOMAIN: 'morfa.test', MORFA_DOMAIN: 'app.morfa.test'},
  });
  assert.equal(result.status, 0, result.stderr);
  JSON.parse(result.stdout);
});

test('caddy: every private path answers 404 on the base name and the app; the app answers 200, the base name moves to it', {skip, timeout: 60_000}, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'morfa-caddy-'));
  let proc: ChildProcess | undefined;
  let log = '';
  // A stand-in api upstream: 200 for everything (Caddy's health checks too), so a proxied request is logged at once.
  const api: Server = createHttpServer((_req, res) => res.writeHead(200, {'content-type': 'application/json'}).end('{}'));
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  try {
    const [httpPort, httpsPort] = [await freePort(), await freePort()];
    const app = path.join(dir, 'app');
    writeTree(app, 'app');
    mkdirSync(path.join(dir, 'downloads'));
    mkdirSync(path.join(dir, 'updates'));
    writeFileSync(
      path.join(dir, 'Caddyfile'),
      `{
	admin off
	local_certs
	skip_install_trust
	storage file_system ${path.join(dir, 'data')}
	http_port ${httpPort}
	https_port ${httpsPort}
}
import ${path.join(CADDY_DIR, 'morfa-routes.caddy')}
import ${path.join(CADDY_DIR, 'morfa-sites.caddy')}
`,
    );
    const env = {
      ...process.env,
      HOME: dir,
      XDG_DATA_HOME: path.join(dir, 'xdg-data'),
      XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
      MORFA_MARKETING_DOMAIN: 'morfa.test',
      MORFA_DOMAIN: 'app.morfa.test',
      MORFA_APP_DIR: app,
      MORFA_DOWNLOADS_DIR: path.join(dir, 'downloads'),
      MORFA_UPDATES_DIR: path.join(dir, 'updates'),
      MORFA_API_UPSTREAMS: `127.0.0.1:${(api.address() as {port: number}).port}`,
    };
    proc = spawn(caddy!, ['run', '--config', path.join(dir, 'Caddyfile'), '--adapter', 'caddyfile'], {env, stdio: ['ignore', 'pipe', 'pipe']});
    proc.stdout!.on('data', chunk => (log += chunk));
    proc.stderr!.on('data', chunk => (log += chunk));

    let ready = false;
    for (let i = 0; i < 100 && !ready; i++) {
      try {
        ready = (await get(httpsPort, 'app.morfa.test', '/')).status === 200;
      } catch {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(ready, `Caddy did not answer https://app.morfa.test/ within 10 s:\n${log.slice(-3000)}`);

    const basePrivate = ['/BUILD_COMMIT', '/build-graph.json', '/metrics', '/metrics/x', '/healthz', '/internal', '/internal/x', '/api', '/api/x'];
    const appPrivate = ['/BUILD_COMMIT', '/build-graph.json', '/metrics', '/healthz', '/internal', '/internal/x', '/__bench/x', '/__e2e/x'];
    const failures: string[] = [];
    for (const [name, paths] of [['morfa.test', basePrivate], ['app.morfa.test', appPrivate]] as const) {
      for (const urlPath of paths) {
        const {status, body} = await get(httpsPort, name, urlPath);
        if (status !== 404 || body.includes(SECRET)) failures.push(`${name}${urlPath} → ${status}`);
      }
    }
    assert.deepEqual(failures, [], 'private paths answered something other than 404');

    const page = await get(httpsPort, 'app.morfa.test', '/');
    assert.equal(page.status, 200, 'app.morfa.test/');
    assert.match(page.body, /app/);
    assert.equal((await get(httpsPort, 'app.morfa.test', '/assets/a.js')).status, 200, 'app.morfa.test/assets/a.js');
    // The base name has no site: it moves to the app.
    assert.equal((await get(httpsPort, 'morfa.test', '/files/123')).status, 308, 'morfa.test/files/123');
    // The link preview's ?url= never reaches the access log.
    await get(httpsPort, 'app.morfa.test', `/api/design-files/f/link-preview?url=${encodeURIComponent('https://pasted.example/secret?token=abc')}&x=1`);
    for (let i = 0; i < 50 && !/link-preview/.test(log); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const line = log.split('\n').find(entry => entry.includes('link-preview')) ?? '';
    assert.match(line, /url=REDACTED/, line);
    assert.doesNotMatch(log, /pasted\.example|token=abc/);
    // The app's single-page fallback still answers an unknown route with index.html.
    const route = await get(httpsPort, 'app.morfa.test', '/files/123');
    assert.equal(route.status, 200);
    assert.match(route.body, /app/);
  } finally {
    proc?.kill('SIGTERM');
    if (proc && proc.exitCode === null) await new Promise(resolve => proc!.once('exit', resolve));
    api.closeAllConnections();
    await new Promise(resolve => api.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
});
