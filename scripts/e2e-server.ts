// The isolated server behind `npm run test:e2e` (playwright.config.ts starts it): the API on a freshly migrated
// throwaway PostgreSQL database with a temporary DATA_DIR, and the Vite dev server for the app in front of it.
// Cut to what the design specs use.
import {fork} from 'node:child_process';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {randomBytes, randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.E2E_PORT || 4400);
const apiPort = Number(process.env.E2E_API_PORT || 4401);
const runKey = process.env.MORFA_E2E_RUN_KEY;
// MORFA_E2E_WARMUP=0 skips walking the editor's module graph before the server reports ready (scripts/e2e-warmup.ts).
const warmUp = process.env.MORFA_E2E_WARMUP !== '0';
// E2E_API_PROCESSES=2: the API as production runs it, two processes on one database behind a least-connections balancer
// (scripts/e2e-balancer.ts), their live events passed through PostgreSQL (DESIGN_LIVE_FANOUT=postgres). For the co-editing specs:
// a request that reaches the process without the browser's stream is the case one process never meets.
const apiProcesses = Number(process.env.E2E_API_PROCESSES || 1);
if (apiProcesses !== 1 && apiProcesses !== 2) throw Error('E2E_API_PROCESSES is 1 or 2.');
if (!runKey) throw Error('Run this isolated server through playwright.config.ts.');
if (![port, apiPort].every(n => Number.isInteger(n) && n > 1024 && n < 65536) || port === apiPort) throw Error('Invalid E2E ports.');

// Discard inherited application credentials/config before importing any server module.
// Vite is created with configFile/envFile disabled, so neither it nor the API reads .env.local.
// The isolated PostgreSQL test-cluster keys stay: the fixture creates a throwaway database from them.
const runtimeKeys = new Set(['PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'SYSTEMROOT', 'WINDIR', 'LANG', 'LC_ALL', 'TERM', 'CI', 'NO_COLOR', 'FORCE_COLOR',
  'MORFA_TEST_DATABASE_URL', 'MORFA_TEST_CLUSTER_ID', 'MORFA_TEST_CLUSTER_TOKEN', 'MORFA_TEST_ENDPOINT',
  // Where the server's own Chromium is (the design tool's vector PDF): the machine's browser install, never an application setting.
  'PLAYWRIGHT_BROWSERS_PATH', 'IMPORT_CHROMIUM_PATH',
  // The server's own layout of merged saves: a test run may ask for it (DESIGN_SERVER_LAYOUT=1 npm run test:e2e).
  'DESIGN_SERVER_LAYOUT',
  // Big files (docs/decisions/big-files.md): a run may open the caps (DESIGN_BIG_FILES=1 npm run test:e2e); the editor's page
  // loading and memory budget run from `?bigFiles=1` in the address either way. The collab node's switch (MORFA_BIG_FILES)
  // follows DESIGN_BIG_FILES unless set on its own.
  'DESIGN_BIG_FILES', 'MORFA_BIG_FILES']);
for (const key of Object.keys(process.env)) if (!runtimeKeys.has(key)) delete process.env[key];
const collabBigFilesFlag = process.env.MORFA_BIG_FILES ?? process.env.DESIGN_BIG_FILES;
const collabBigFiles: Record<string, string> = collabBigFilesFlag ? {MORFA_BIG_FILES: collabBigFilesFlag} : {};
if (!process.env.MORFA_TEST_DATABASE_URL) throw Error('Load the isolated PostgreSQL test-cluster env file (MORFA_TEST_*) before running Playwright (docs/dev.md).');
const origin = `http://127.0.0.1:${port}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
Object.assign(process.env, {NODE_ENV: 'test', APP_ORIGIN: origin});
if (apiProcesses === 2) process.env.DESIGN_LIVE_FANOUT = 'postgres';
// The tool is the product: on for every e2e account.
process.env.ENABLE_DESIGN_TOOL = '1';
// "Import from Figma": the spec mocks api.figma.com in the browser.
process.env.ENABLE_FIGMA_IMPORT = '1';
// The support chat (shared/support.ts) is off for everyone until a spec turns it on with its operator (/__e2e/support,
// tests/e2e/design-support-chat.spec.ts), so no other spec meets its button or its polls.
process.env.SUPPORT_CHAT = '0';
// Provider secrets are encrypted at rest (server/hosting/secrets.ts): a throwaway key per run.
process.env.HOSTING_ENCRYPTION_KEY ||= randomBytes(32).toString('hex');

// The MCP server (docs/mcp-server.md) is on, open to no account until a spec names one through /__e2e/mcp: the file browser's
// "Claude and ChatGPT" card shows only for those (tests/e2e/design-assistants.spec.ts).
const MCP_NOBODY = 'e2e-mcp-nobody';
const mcpAccounts = new Set<string>([MCP_NOBODY]);
Object.assign(process.env, {ENABLE_MCP_SERVER: '1', MCP_ACCOUNTS: MCP_NOBODY});
// "Marketplaces" Performance Loop (docs/marketplaces.md): on, against the in-memory Wildberries and Ozon (server/marketplace/loop/fake.ts) set
// up below, never the real APIs; /__e2e/marketplace sets the numbers they report and moves the loop's clock days ahead.
process.env.ENABLE_MARKETPLACE_API = '1';

// External providers are deliberately unavailable; an accidental server fetch must
// fail locally rather than reaching a live provider even if a test changes a flag.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('External fetch disabled in E2E: ' + url.origin);
  return nativeFetch(input, init);
}) as typeof fetch;

// A freshly migrated throwaway database plus a temporary DATA_DIR, removed on shutdown.
const {bootPostgresqlApp} = await import('../tests/helpers/app-fixture');
const fixture = await bootPostgresqlApp({listen: false});
const dataDir = fixture.dataDir;
const [{default: express}, {digest}, {createServer}, {default: react}] = await Promise.all([
  import('express'), import('../server/auth'), import('vite'), import('@vitejs/plugin-react'),
]);
const {db, app} = fixture;
const SESSION_MS = 3_600_000;
// Lane B1's collab node beside the API on the same database when its binary is built (tests/helpers/collab-binary.ts finds it):
// DESIGN_COLLAB stays legacy for everyone; /__e2e/collab moves one account to rust or back (tests/e2e/design-collab-cutover.spec.ts).
const collabHelpers = await import('../tests/helpers/collab-binary');
const collab = collabHelpers.collabBinary()
  ? await collabHelpers.startCollab({pgUrl: fixture.isolated.runtimeUrl, apiUrl: apiOrigin, node: 'e2e', env: {MORFA_COLLAB_ORIGINS: origin, ...collabBigFiles}}).catch(error => {
      console.warn('E2E collab node not started:', String(error).slice(0, 300));
      return null;
    })
  : null;
if (collab) Object.assign(process.env, collab.apiEnv);
const collabModes = new Map<string, string>();
const marketplaceFake = (await import('../server/marketplace/loop/fake')).createFakeMarketplaces();
(await import('../server/marketplace/loop/adapters')).useMarketplaceFake(marketplaceFake.adapters);
const harness = express();
const late: string[] = [];
const LATE_TRANSFORMS_REPORTED = 40;
// Not ready (503) until Vite listens and, unless skipped, its module graph is warm: Playwright polls this URL before the first spec.
let ready = false;
harness.use('/__e2e', express.json(), (req, res, next) => {
  if (req.path === '/ready') {res.status(ready ? 200 : 503).json({ready}); return;}
  if (req.get('x-e2e-run-key') !== runKey) {res.sendStatus(403); return;}
  next();
});
// A new account with a signed-in session for each test (tests/e2e/fixtures.ts): the same two rows the PostgreSQL runtime
// tests write (tests/postgresql-runtime-design-*.test.ts). No password (people sign in with a provider, which a spec cannot; the specs use the
// session) and no site projects (Morfa has none), so those fields of the seed stay empty.
// The co-editing switch of one account (DESIGN_COLLAB_ACCOUNTS), then what a flip does on a running server: open SSE files moving to
// collab are told, files leaving it are let go by the node (server/design/collab/reconcile.ts).
harness.post('/__e2e/collab', async (req, res, next) => {
  try {
    const {accountId, mode} = req.body as {accountId?: string; mode?: string};
    if (!collab) {res.status(503).json({available: false}); return;}
    if (typeof accountId !== 'string' || !['legacy', 'shadow', 'rust'].includes(String(mode))) {res.sendStatus(400); return;}
    collabModes.set(accountId, String(mode));
    process.env.DESIGN_COLLAB_ACCOUNTS = [...collabModes].map(([id, value]) => `${id}=${value}`).join(',');
    const applied = await (await import('../server/design/collab/reconcile')).applyCollabSwitch();
    res.json({available: true, node: collab.node, ...applied});
  } catch (error) {next(error);}
});
// The support chat on (with the operator, an account id, MORFA_OPERATORS) or off again: what the server reads on each request.
harness.post('/__e2e/support', (req, res) => {
  const {on, operator} = req.body as {on?: unknown; operator?: unknown};
  if (typeof operator === 'string') process.env.MORFA_OPERATORS = operator;
  process.env.SUPPORT_CHAT = on === true ? '1' : '0';
  res.json({on: process.env.SUPPORT_CHAT === '1'});
});
// The MCP server for one account, and optionally an assistant it already allowed (a grant as the sign-in leaves it, without tokens).
harness.post('/__e2e/mcp', async (req, res, next) => {
  try {
    const {accountId, connected} = req.body as {accountId?: string; connected?: unknown};
    if (typeof accountId !== 'string' || !/^[0-9a-f-]{36}$/.test(accountId)) {res.sendStatus(400); return;}
    if (connected !== undefined && connected !== 'Claude' && connected !== 'ChatGPT') {res.sendStatus(400); return;}
    mcpAccounts.add(accountId);
    process.env.MCP_ACCOUNTS = [...mcpAccounts].join(',');
    if (connected) {
      const clientId = 'morfa_c_' + randomUUID(),
        redirect = connected === 'Claude' ? 'https://claude.ai/api/mcp/auth_callback' : 'https://chatgpt.com/connector_platform_oauth_redirect';
      await db.execute(`INSERT INTO oauth_clients(id,kind,client_name,redirect_uris,metadata) VALUES($1,'dcr',$2,$3::jsonb,'{}')`, [clientId, connected, JSON.stringify([redirect])]);
      await db.execute(`INSERT INTO oauth_grants(id,user_id,client_id,client_name,scopes) VALUES($1,$2,$3,$4,'["read","write"]')`, [randomUUID(), accountId, clientId, connected]);
    }
    res.json({ok: true});
  } catch (error) {next(error);}
});
// The fake marketplaces (tests/e2e/design-marketplace-loop.spec.ts): `numbers` maps a frame id to what the marketplace reports on each day
// that frame was the slot's live picture; `advanceHours` moves the loop's clock in `stepHours` steps, running the worker's pass after each
// (the last one syncs every connection).
harness.post('/__e2e/marketplace', async (req, res, next) => {
  try {
    const {numbers, advanceHours, stepHours} = req.body as {numbers?: Record<string, {views: number | null; clicks: number; carts: number; orders: number}>; advanceHours?: number; stepHours?: number};
    const [{advanceLoopClock, loopNow}, {runMarketplaceLoopTick}, {spansOf}, {frameOfDay}] = await Promise.all([
      import('../server/marketplace/loop/clock'), import('../server/marketplace/loop/worker'), import('../server/marketplace/loop/numbers'),
      import('../shared/design/marketplace/loop-stats'),
    ]);
    if (numbers) marketplaceFake.setNumbers(async (_marketplace, productId, day) => {
      const spans = spansOf(await db.many<{node_id: string; live_from: string | null; live_until: string | null}>(
        `SELECT p.node_id,p.live_from,p.live_until FROM marketplace_publications p JOIN marketplace_card_links l ON l.id=p.link_id
          WHERE l.product_id=$1 AND p.live_from IS NOT NULL`, [productId]));
      const frame = frameOfDay(spans, day, loopNow());
      return frame && numbers[frame] ? numbers[frame] : null;
    });
    const total = Math.max(0, Math.min(24 * 90, Number(advanceHours) || 0)), step = Math.max(1, Math.min(24, Number(stepHours) || 3));
    for (let done = 0; done < total; done += step) {
      advanceLoopClock(Math.min(step, total - done) * 3_600_000);
      await runMarketplaceLoopTick();
    }
    await runMarketplaceLoopTick({force: true});
    res.json({uploads: marketplaceFake.uploads.length, calls: marketplaceFake.calls.length});
  } catch (error) {next(error);}
});
harness.post('/__e2e/fixtures', async (req, res, next) => {
  try {
    const accountId = randomUUID(), token = randomBytes(32).toString('hex');
    const email = `e2e-${accountId}@example.test`;
    // A name of the spec's own (a preview's people); every other account is "Browser check".
    const named = (req.body as {name?: unknown} | undefined)?.name;
    const name = typeof named === 'string' && /^[\p{L} .-]{1,60}$/u.test(named) ? named : 'Browser check';
    await db.transaction(async tx => {
      await tx.execute('INSERT INTO users(id,email,name,password) VALUES($1,$2,$3,$4)', [accountId, email, name, '']);
      await tx.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [digest(token), accountId, Date.now() + SESSION_MS]);
    });
    res.json({accountId, token, email, password: '', projectId: '', secondProjectId: '', projectName: ''});
  } catch (error) {next(error);}
});
// Fonts as the API serves them (server/app.ts): any origin may read them, since previews run in
// opaque-origin frames. Here, not in the application, so the e2e run does not depend on how the server ships them.
harness.use('/fonts', express.static(path.join(root, 'public/fonts'), {setHeaders: res => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
}}));
harness.use(app);
const api = harness.listen(apiProcesses === 2 ? 0 : apiPort, '127.0.0.1');
await new Promise<void>((resolve, reject) => {api.once('listening', resolve); api.once('error', reject);});
// The second process and the balancer in front of both (E2E_API_PROCESSES=2). The switches the /__e2e routes flip live in this
// process's environment: each is copied to the second process before the spec hears the route's answer.
const SWITCHES = ['MCP_ACCOUNTS', 'SUPPORT_CHAT', 'MORFA_OPERATORS', 'DESIGN_COLLAB_ACCOUNTS'];
const replica = apiProcesses === 2 ? fork(path.join(root, 'scripts/e2e-api-replica.ts'), [], {execArgv: ['--import', 'tsx'], env: process.env, stdio: 'inherit'}) : null;
let synced = 0;
const syncReplica = () => new Promise<void>((resolve, reject) => {
  const id = ++synced;
  const listener = (message: {ack?: number}) => {
    if (message.ack !== id) return;
    replica!.off('message', listener);
    resolve();
  };
  replica!.on('message', listener);
  replica!.send({id, env: Object.fromEntries(SWITCHES.map(key => [key, process.env[key] ?? null]))}, error => error && reject(error));
});
const balancer = replica
  ? await (async () => {
      const port = await new Promise<number>((resolve, reject) => {
        replica.on('message', (message: {ready?: boolean; port?: number}) => message.ready && resolve(message.port!));
        replica.once('exit', code => reject(Error(`The second API process stopped (${code}).`)));
      });
      const {startBalancer} = await import('./e2e-balancer');
      return startBalancer({
        port: apiPort,
        targets: [(api.address() as {port: number}).port, port],
        // The fake marketplaces and the loop's clock live in this process only (set up above): "Marketplaces" stays on it too.
        pinned: url => url.startsWith('/__e2e') || url.startsWith('/fonts') || url.startsWith('/api/marketplace'),
        after: syncReplica,
      });
    })()
  : null;
const proxied = ['/api', '/__e2e', '/uploads', '/fonts'];
const vite = await createServer({
  root, configFile: false, envFile: false, mode: 'e2e',
  cacheDir: path.join(dataDir, 'vite-cache'),
  plugins: [react({include: /\.[jt]sx$/}), {
    // Every module the warm-up (scripts/e2e-warmup.ts) did not reach is transformed by the first spec that opens it,
    // on a cold server: name those, so a gap in the walk shows in the run's log (stderr) instead of as a slow first attempt.
    name: 'e2e-late-transforms',
    transform(_code, id) {
      if (ready && warmUp && late.length < LATE_TRANSFORMS_REPORTED && !id.includes('/node_modules/')) {
        late.push(id);
        console.warn(`E2E module not warmed (${late.length}): ${path.relative(root, id.split('?')[0])}`);
      }
      return null;
    },
  }],
  optimizeDeps: {entries: ['index.html']},
  define: {
    'import.meta.env.VITE_APP_ORIGIN': JSON.stringify(origin),
  },
  // No file watcher: nothing edits the source during a run and hot reload is off, but the run's own artifacts (videos, traces,
  // screenshots) may go inside the checkout (E2E_OUTPUT_DIR), and a watcher would handle every write to them on the server's one thread.
  server: {host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null,
    // node_modules may be a symlink to a shared install outside the checkout.
    fs: {allow: [root, realpathSync(path.join(root, 'node_modules'))]},
    proxy: Object.fromEntries(proxied.map(route => [route, apiOrigin]))},
});
await vite.listen();
if (warmUp) {
  const {warmModuleGraph} = await import('./e2e-warmup');
  const warmed = await warmModuleGraph(vite).catch(error => ({error: String(error)}));
  console.log('E2E module graph warm-up:', JSON.stringify(warmed));
}
ready = true;
console.log(`Isolated E2E app ready at ${origin}; API ${apiOrigin}${replica ? ' (two processes behind a balancer)' : ''}; temporary database and data only.`);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await vite.close();
  // Design live streams never end by themselves (server/design/live/hub.ts).
  (await import('../server/design/live/hub')).closeDesignLiveStreams();
  await balancer?.close();
  if (replica && replica.exitCode === null) {
    replica.kill('SIGTERM');
    await new Promise(resolve => replica.once('exit', resolve));
  }
  if (replica) api.closeAllConnections();
  await new Promise<void>(resolve => api.close(() => resolve()));
  await collab?.stop();
  await fixture.close();
  process.exit(0);
}
process.on('SIGTERM', () => {void stop();});
process.on('SIGINT', () => {void stop();});
