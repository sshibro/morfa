// The second api process of a two-process e2e run (E2E_API_PROCESSES=2, scripts/e2e-server.ts): the same application on the
// same database and DATA_DIR, as api@2 runs beside api@1 in production, both behind one balancer. Started by e2e-server.ts with
// its environment once that is complete; takes the switches a spec flips through /__e2e (env updates over IPC, acknowledged).
import {once} from 'node:events';

if (!process.send) throw Error('Started by scripts/e2e-server.ts only.');

// As in the first process: an accidental server fetch fails locally rather than reaching a live provider.
const nativeFetch = globalThis.fetch;
globalThis.fetch = ((input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('External fetch disabled in E2E: ' + url.origin);
  return nativeFetch(input, init);
}) as typeof fetch;

const storage = await import('../server/db');
await storage.initializeDatabase();
const {app} = await import('../server/app');

process.on('message', (message: {id: number; env: Record<string, string | null>}) => {
  for (const [key, value] of Object.entries(message.env)) {
    if (value === null) delete process.env[key];
    else process.env[key] = value;
  }
  process.send!({ack: message.id});
});

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
process.send({ready: true, port: (server.address() as {port: number}).port});

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  (await import('../server/design/live/hub')).closeDesignLiveStreams();
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await storage.closeDatabase().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
process.on('disconnect', () => void stop());
