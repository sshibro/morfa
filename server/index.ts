// The Morfa API process: checks its configuration and the database, then serves server/app.ts until SIGTERM/SIGINT.
import dotenv from 'dotenv';
dotenv.config({path: '.env.local', quiet: true});
dotenv.config({quiet: true});

const DEFAULT_PORT = 3400;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;

// The design tool is Morfa's product: its code's own switch (server/design/flag.ts) is always on here. DESIGN_TOOL_ACCOUNTS still
// stages it by account when set.
process.env.ENABLE_DESIGN_TOOL = '1';
if (process.env.NODE_ENV === 'production' && !/^https:\/\/[^/]+$/.test(process.env.APP_ORIGIN || ''))
  throw Error('Set APP_ORIGIN to the https origin of the app (no path, no trailing slash).');

// An unready database refuses to serve before any listener opens.
const {initializeDatabase, closeDatabase, db} = await import('./db');
await initializeDatabase();
// The Rust engine the environment asks for (MORFA_ENGINE*, DESIGN_SERVER_LAYOUT) is there, or the process refuses to start.
(await import('./design/wasm-engine')).startServerEngines();
const {app, drainAppTasks} = await import('./app');
const {captureError} = await import('./admin/telemetry');
process.on('uncaughtExceptionMonitor', error => void captureError(error, 'backend', {fatal: true}));
const host = process.env.HOST || '127.0.0.1',
  port = Number(process.env.PORT || DEFAULT_PORT);
const server = app.listen(port, host, () => console.log(`Morfa API: http://${host}:${port}`));
// Prometheus metrics on a private listener of their own (server/observability/metrics.ts): METRICS_PORT, METRICS_HOST.
const observability = {metrics: await import('./observability/metrics'), tracing: await import('./observability/tracing')};
observability.metrics.watchPool(() => db.getStatistics());
if (process.env.METRICS_PORT) observability.metrics.startMetricsServer(Number(process.env.METRICS_PORT), process.env.METRICS_HOST || '127.0.0.1');
// Only a backstop: server/request-window.ts gives each request its own time to arrive, all within this.
server.requestTimeout = (await import('./request-window')).SERVER_REQUEST_TIMEOUT_MS;
// The Rust co-editing service (DESIGN_COLLAB_NODES): its nodes' health, and files the switch no longer puts on collab let go.
const collab = {leases: await import('./design/collab/leases'), reconcile: await import('./design/collab/reconcile')};
collab.leases.watchCollabHealth();
collab.reconcile.watchCollabSwitch();

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_GRACE_MS || DEFAULT_SHUTDOWN_GRACE_MS));
  deadline.unref();
  // Ingress closes first. Live co-editing streams never finish by themselves: they end now and the editors reconnect.
  (await import('./design/live/hub')).closeDesignLiveStreams();
  server.closeIdleConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  // Large files saved as changes get their whole text written before the process goes (docs/design-tool.md).
  const designWrites = (await import('./design/document-store')).flushDocumentWrites();
  const {drainTelemetry} = await import('./admin/telemetry');
  await Promise.allSettled([drainAppTasks(), designWrites, drainTelemetry(), observability.tracing.flushSpans()]);
  await closeDatabase().catch(() => {});
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
