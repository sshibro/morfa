// The Performance Loop's pass in the background process (server/worker.ts, every LOOP_TICK_MS under the worker's lock): rotations'
// swaps and verdicts, pictures a marketplace is still processing, connections due a sync (every three hours), and sweeping expired
// pictures and numbers past their keep. Off with the switch. Each step's failure is reported after the rest ran.
import {db} from '../../db';
import {runRotations} from './ab';
import {loopNow} from './clock';
import {marketplaceApiOn, SYNC_EVERY_MS} from './config';
import {sweepMedia} from './media';
import {pruneMetrics, syncDue} from './numbers';
import {confirmPublications} from './publish';

/** One pass. `force` syncs every connection now (the e2e server's "a day later"). */
export async function runMarketplaceLoopTick(options: {force?: boolean} = {}): Promise<void> {
  if (!marketplaceApiOn()) return;
  const now = loopNow();
  const failures: unknown[] = [];
  const step = (work: () => Promise<unknown>) => work().catch(error => void failures.push(error));
  // Numbers first, so a rotation judged in this pass counts its last day.
  await step(() => syncDue(now, SYNC_EVERY_MS, options.force));
  await step(() => runRotations(now));
  await step(() => confirmPublications(now));
  await step(() => sweepMedia(db, now));
  await step(() => pruneMetrics(now));
  if (failures.length) throw failures[0];
}
