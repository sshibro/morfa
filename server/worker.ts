// Morfa's background process: the design trash sweep, account erasure and the support chat's letters about unseen answers. Exactly
// one runs per database: it holds a session advisory lock on a connection of its own and exits when that connection is lost.
import dotenv from 'dotenv';
dotenv.config({path: '.env.local', quiet: true});
dotenv.config({quiet: true});

const ONE_MINUTE_MS = 60_000;
const HOURLY_MS = 60 * ONE_MINUTE_MS;
const DEFAULT_SHUTDOWN_GRACE_MS = 30_000;
// pg_try_advisory_lock key: "MORF", "WORK".
const WORKER_LOCK = [1297044038, 1464816203] as const;

process.env.ENABLE_DESIGN_TOOL = '1';
const {initializeDatabase, closeDatabase} = await import('./db');
await initializeDatabase();
const {Client} = await import('pg');
const {loadDatabaseConfig} = await import('./postgresql/config');
const {postgresClientOptions} = await import('./postgresql/connection-options');
const {captureError} = await import('./admin/telemetry');

let stopping = false;
const pending = new Set<Promise<unknown>>(),
  timers: ReturnType<typeof setInterval>[] = [];
const lease = new Client(postgresClientOptions(loadDatabaseConfig('application')));
lease.on('error', () => void stop(1));
await lease.connect();
if (!(await lease.query<{held: boolean}>('SELECT pg_try_advisory_lock($1,$2) AS held', [...WORKER_LOCK])).rows[0]?.held) {
  console.error('[worker] another worker holds this database; exiting.');
  await lease.end().catch(() => {});
  await closeDatabase().catch(() => {});
  process.exit(1);
}
lease.on('end', () => {
  if (stopping) return;
  console.error('[worker] the lease connection was lost; exiting.');
  void stop(1);
});

/** Runs `work` now and every `ms`, never two of the same at once. A failure is logged and retried at the next turn. */
function schedule(name: string, ms: number, work: () => Promise<unknown>) {
  let active = false;
  const tick = () => {
    if (active || stopping) return;
    active = true;
    const task = work()
      .catch(error => {
        if (stopping) return;
        console.error('[worker] ' + name + ' failed; retrying.');
        void captureError(error, 'worker');
      })
      .finally(() => {
        active = false;
        pending.delete(task);
      });
    pending.add(task);
  };
  timers.push(setInterval(tick, ms));
  tick();
}
schedule('design-trash', HOURLY_MS, async () => (await import('./design/lifecycle')).sweepDesignTrash());
schedule('maintenance', HOURLY_MS, async () => (await import('./launch/lifecycle')).launchMaintenance());
// The support chat: an operator's answer the person has not seen for ten minutes is e-mailed to them (server/support/follow-up.ts).
schedule('support-follow-ups', ONE_MINUTE_MS, async () => (await import('./support/follow-up')).sendSupportFollowUps());
// "Marketplaces": rotations' swaps, pictures to confirm, the sellers' numbers every three hours (server/marketplace/loop/worker.ts).
schedule('marketplace-loop', 15 * ONE_MINUTE_MS, async () => (await import('./marketplace/loop/worker')).runMarketplaceLoopTick());

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => process.exit(1), Number(process.env.SHUTDOWN_GRACE_MS || DEFAULT_SHUTDOWN_GRACE_MS));
  deadline.unref();
  for (const timer of timers) clearInterval(timer);
  await Promise.allSettled([...pending]);
  const {drainTelemetry} = await import('./admin/telemetry');
  await drainTelemetry().catch(() => {});
  await lease.end().catch(() => {});
  await closeDatabase().catch(() => {});
  process.exit(code);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
