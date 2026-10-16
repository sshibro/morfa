// The Performance Loop's switch, cadence and addresses (docs/marketplaces.md §Performance Loop). It reads the environment and nothing
// else, and every function reads it when called, so a test may change it between requests.

/** ENABLE_MARKETPLACE_API=1 turns on the seller connections, publishing, the numbers and the A/B tests (with the design tool). Anything
 *  else: /api/marketplace's loop routes answer 404 as any unknown path, the worker leaves the marketplaces alone, and "Sales" says so. */
export const marketplaceApiOn = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.ENABLE_DESIGN_TOOL === '1' && env.ENABLE_MARKETPLACE_API === '1';

/** The development app's origin (Vite on 5400 proxies /api), as the MCP server's config falls back to. */
const DEV_APP_ORIGIN = 'http://127.0.0.1:5400';
/** The app's origin: the public picture links are under it (APP_ORIGIN; https://app.morfa.example in production). */
export const appOrigin = (env: NodeJS.ProcessEnv = process.env): string =>
  (env.APP_ORIGIN || DEV_APP_ORIGIN).replace(/\/+$/, '');
/** The address a marketplace downloads a published picture from (GET /api/marketplace-media/<token>.<ext>, no session). */
export const mediaUrl = (token: string, extension: string, env: NodeJS.ProcessEnv = process.env): string =>
  `${appOrigin(env)}/api/marketplace-media/${token}.${extension}`;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The worker's pass (server/worker.ts): swaps due, pictures to confirm, connections to sync, sweeping. */
export const LOOP_TICK_MS = 15 * MINUTE_MS;
/** A connection's numbers are read again this long after the last read. */
export const SYNC_EVERY_MS = 3 * HOUR_MS;
/** A marketplace that answered 429 is left alone this long. */
export const RATE_BACKOFF_MS = 30 * MINUTE_MS;
/** The days each sync reads back (the marketplaces correct recent days). */
export const SYNC_DAYS = 7;
/** Daily numbers older than this are deleted. */
export const METRICS_KEEP_DAYS = 400;
/** A published picture's public link lasts this long (a rotation's pictures: the test and this). */
export const MEDIA_DAYS = 7;
export const mediaExpiry = (from: number = Date.now()) => new Date(from + MEDIA_DAYS * DAY_MS);
/** A picture Ozon has not confirmed in this long is reported failed. */
export const CONFIRM_WITHIN_MS = DAY_MS;
/** WB's analytics take three requests a minute: one every 20 seconds. */
export const WB_ANALYTICS_SPACING_MS = 21_000;
/** One request to a marketplace waits this long at most; nothing is retried inline (the next pass does). */
export const MARKETPLACE_TIMEOUT_MS = 20_000;
