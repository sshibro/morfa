// The numbers (docs/marketplaces.md §Performance Loop): the worker reads each connection's daily numbers for its linked products every
// three hours and keeps them by Moscow day; "Sales" and the canvas read them back per frame, counting each day to the frame that was
// the live picture that day (shared/design/marketplace/loop-stats.ts).
import {db} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import type {CardNumbers} from '../../../shared/design/marketplace/score';
import {
  NUMBERS_WINDOW_DAYS,
  type DayNumbers,
  type FileCards,
  type FrameNumbers,
  type LoopTest,
} from '../../../shared/design/marketplace/loop';
import {
  addDays,
  daysByFrame,
  daysFrom,
  EMPTY_NUMBERS,
  moscowDay,
  rotationStanding,
  sumNumbers,
  type LiveSpan,
} from '../../../shared/design/marketplace/loop-stats';
import {isMarketplaceError, marketplaceAdapters, type MetricRow} from './adapters';
import {METRICS_KEEP_DAYS, RATE_BACKOFF_MS, SYNC_DAYS} from './config';
import {refuseConnection} from './publish';
import {
  CONNECTION_COLUMNS,
  connectionOf,
  iso,
  LINK_COLUMNS,
  linkOf,
  openSecret,
  PUBLICATION_COLUMNS,
  publicationOf,
  TEST_COLUMNS,
  testOf,
  type ConnectionRow,
  type LinkRow,
  type PublicationRow,
  type TestRow,
} from './store';

/** Connections a marketplace asked to slow down for, until when (ms). One worker process holds it. */
const backoff = new Map<string, number>();

/** Upserts a connection's daily numbers, a thousand rows a statement. */
export async function storeMetrics(
  tx: SqlExecutor,
  connectionId: string,
  rows: readonly MetricRow[],
  at: number,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    const part = rows.slice(i, i + 1000);
    await tx.execute(
      `INSERT INTO marketplace_metrics(connection_id,product_id,day,views,clicks,carts,orders,updated_at)
       SELECT $1,m.product_id,m.day,m.views,m.clicks,m.carts,m.orders,$8
         FROM unnest($2::text[],$3::date[],$4::int[],$5::int[],$6::int[],$7::int[]) AS m(product_id,day,views,clicks,carts,orders)
       ON CONFLICT(connection_id,product_id,day) DO UPDATE
         SET views=excluded.views,clicks=excluded.clicks,carts=excluded.carts,orders=excluded.orders,updated_at=excluded.updated_at`,
      [
        connectionId,
        part.map(row => row.productId),
        part.map(row => row.day),
        part.map(row => row.views),
        part.map(row => row.clicks),
        part.map(row => row.carts),
        part.map(row => row.orders),
        iso(at),
      ],
    );
  }
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * Reads one connection's last SYNC_DAYS days for the products its cards are linked to and keeps them. A refused key marks the
 * connection `refused` (no more syncs until it is entered again); 429 leaves it alone for RATE_BACKOFF_MS; any other failure is noted
 * and retried at the next sync.
 */
export async function syncConnection(
  row: ConnectionRow,
  now: number,
  pause: (ms: number) => Promise<void> = sleep,
): Promise<'ok' | 'refused' | 'rate' | 'error'> {
  const products = await db.many<{product_id: string; sku: string | null}>(
    'SELECT product_id,max(sku) AS sku FROM marketplace_card_links WHERE connection_id=$1 GROUP BY product_id ORDER BY product_id LIMIT 2000',
    [row.id],
  );
  const to = moscowDay(now),
    from = addDays(to, -(SYNC_DAYS - 1));
  let rows: MetricRow[] = [];
  try {
    if (products.length) {
      const adapters = await marketplaceAdapters();
      rows = await adapters[row.marketplace].numbers(openSecret(row.user_id, row.secret), {
        products: products.map(product => ({productId: product.product_id, sku: product.sku})),
        from,
        to,
        pause,
      });
    }
  } catch (error) {
    if (!isMarketplaceError(error)) throw error;
    if (error.kind === 'refused') {
      await refuseConnection(db, row.id, error.message, now);
      return 'refused';
    }
    if (error.kind === 'rate') {
      backoff.set(row.id, now + RATE_BACKOFF_MS);
      return 'rate';
    }
    await db.execute(
      "UPDATE marketplace_connections SET status='error',last_error=$2,synced_at=$3 WHERE id=$1 AND status<>'refused'",
      [row.id, error.message.slice(0, 500), iso(now)],
    );
    return 'error';
  }
  const linked = new Set(products.map(product => product.product_id));
  const kept = rows.filter(metric => linked.has(metric.productId) && metric.day >= from && metric.day <= to);
  await db.transaction(async tx => {
    await storeMetrics(tx, row.id, kept, now);
    await tx.execute(
      "UPDATE marketplace_connections SET status='ok',last_error=NULL,synced_at=$2 WHERE id=$1 AND status<>'refused'",
      [row.id, iso(now)],
    );
  });
  backoff.delete(row.id);
  return 'ok';
}

/** The worker: every connection not refused, not backing off and not synced for `every` ms (all of them, forced). */
export async function syncDue(now: number, every: number, force = false): Promise<void> {
  const due = await db.many<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM marketplace_connections c
      WHERE c.status<>'refused' AND ($2 OR c.synced_at IS NULL OR c.synced_at<=$1)
      ORDER BY c.synced_at NULLS FIRST LIMIT 200`,
    [iso(now - every), force],
  );
  for (const row of due) {
    if (!force && (backoff.get(row.id) ?? 0) > now) continue;
    await syncConnection(row, now);
  }
}

/** The worker: daily numbers past their keep. */
export const pruneMetrics = (now: number) =>
  db.execute('DELETE FROM marketplace_metrics WHERE day<$1', [addDays(moscowDay(now), -METRICS_KEEP_DAYS)]);

// ── Reading them back ─────────────────────────────────────────────────────────────────────────────

type MetricsRow = {
  connection_id: string;
  product_id: string;
  day: string;
  views: number | null;
  clicks: number | null;
  carts: number | null;
  orders: number | null;
};
const numbersOf = (row: MetricsRow): CardNumbers => ({
  views: row.views,
  clicks: row.clicks,
  carts: row.carts,
  orders: row.orders,
});
const productKey = (connectionId: string, productId: string) => `${connectionId}\u0000${productId}`;

/** The live hours of a link's pictures. */
export const spansOf = (
  publications: readonly {node_id: string; live_from: string | null; live_until: string | null}[],
): LiveSpan[] =>
  publications
    .filter(publication => publication.live_from !== null)
    .map(publication => ({
      nodeId: publication.node_id,
      from: Date.parse(publication.live_from!),
      until: publication.live_until === null ? null : Date.parse(publication.live_until),
    }));

/** A rotation's numbers per variant over its days so far (or all of them), judged. */
export const rotationResult = (
  test: Pick<TestRow, 'variant_a' | 'variant_b' | 'started_at' | 'ends_at'>,
  spans: readonly LiveSpan[],
  numbers: ReadonlyMap<string, CardNumbers>,
  now: number,
) =>
  rotationStanding(
    {variantA: test.variant_a, variantB: test.variant_b, startedAt: test.started_at!, endsAt: test.ends_at},
    spans,
    numbers,
    now,
  );

const frameNumbers = (
  nodeId: string,
  linkId: string,
  window: readonly string[],
  days: readonly DayNumbers[],
  productWide: boolean,
): FrameNumbers => {
  const byDay = new Map(days.map(day => [day.day, day]));
  return {
    nodeId,
    linkId,
    totals: days.length ? sumNumbers(days) : {...EMPTY_NUMBERS},
    days: days.length,
    series: window.map(day => byDay.get(day) ?? null),
    productWide,
  };
};

/** Everything "Sales" and the canvas show for one of the caller's files (their own links only). */
export async function readFileCards(tx: SqlExecutor, userId: string, fileId: string, now: number): Promise<FileCards> {
  const to = moscowDay(now),
    from = addDays(to, -(NUMBERS_WINDOW_DAYS - 1));
  const window = daysFrom(from, to);
  // One after another: a transaction's client runs one query at a time.
  const connections = await tx.many<ConnectionRow>(
    `SELECT ${CONNECTION_COLUMNS} FROM marketplace_connections c WHERE c.user_id=$1 ORDER BY c.created_at,c.id`,
    [userId],
  );
  const links = await tx.many<LinkRow>(
    `SELECT ${LINK_COLUMNS} FROM marketplace_card_links l JOIN marketplace_connections c ON c.id=l.connection_id
      WHERE l.file_id=$1 AND l.user_id=$2 ORDER BY l.created_at,l.id`,
    [fileId, userId],
  );
  const tests = await tx.many<TestRow>(
    `SELECT ${TEST_COLUMNS} FROM marketplace_tests t WHERE t.file_id=$1 AND t.user_id=$2 ORDER BY t.created_at DESC LIMIT 100`,
    [fileId, userId],
  );
  const linkIds = links.map(link => link.id);
  const publications = linkIds.length
    ? await tx.many<PublicationRow>(
        `SELECT ${PUBLICATION_COLUMNS} FROM marketplace_publications p WHERE p.link_id=ANY($1::text[]) ORDER BY p.requested_at DESC LIMIT 2000`,
        [linkIds],
      )
    : [];
  // Numbers from the window's first day, or the earliest test's start if that is older.
  const earliest = tests.reduce(
    (day, test) => (test.started_at && moscowDay(test.started_at) < day ? moscowDay(test.started_at) : day),
    from,
  );
  const metrics = linkIds.length
    ? await tx.many<MetricsRow>(
        `SELECT m.connection_id,m.product_id,m.day,m.views,m.clicks,m.carts,m.orders FROM marketplace_metrics m
          WHERE (m.connection_id,m.product_id) IN (SELECT l.connection_id,l.product_id FROM marketplace_card_links l WHERE l.id=ANY($1::text[]))
            AND m.day>=$2`,
        [linkIds, earliest],
      )
    : [];
  const numbers = new Map<string, Map<string, CardNumbers>>();
  for (const row of metrics) {
    const key = productKey(row.connection_id, row.product_id);
    if (!numbers.has(key)) numbers.set(key, new Map());
    numbers.get(key)!.set(row.day, numbersOf(row));
  }

  const frames: FrameNumbers[] = [];
  const spansByLink = new Map<string, LiveSpan[]>();
  for (const link of links) {
    const own = publications.filter(publication => publication.link_id === link.id);
    const spans = spansOf(own);
    spansByLink.set(link.id, spans);
    const product = numbers.get(productKey(link.connection_id, link.product_id)) ?? new Map<string, CardNumbers>();
    if (!spans.length) {
      // Never published from Morfa: the product's numbers, whatever picture it shows.
      const days = window.filter(day => product.has(day)).map(day => ({day, ...product.get(day)!}));
      frames.push(frameNumbers(link.node_id, link.id, window, days, true));
      continue;
    }
    const byFrame = daysByFrame(spans, product, window, now);
    const nodes = new Set([link.node_id, ...spans.map(span => span.nodeId)]);
    for (const nodeId of nodes) frames.push(frameNumbers(nodeId, link.id, window, byFrame.get(nodeId) ?? [], false));
  }

  // A running rotation shows its standing so far; a finished one keeps its verdict.
  const loopTests: LoopTest[] = tests.map(row => {
    const test = testOf(row);
    if (row.mode === 'rotation' && row.status === 'running' && row.started_at) {
      const link = links.find(entry => entry.id === row.link_id);
      if (link) {
        const product = numbers.get(productKey(link.connection_id, link.product_id)) ?? new Map<string, CardNumbers>();
        test.result = rotationResult(row, spansByLink.get(link.id) ?? [], product, now).result;
      }
    }
    return test;
  });

  return {
    now: iso(now),
    window: {from, to},
    connections: connections.map(connectionOf),
    links: links.map(linkOf),
    frames,
    tests: loopTests,
    publications: publications.slice(0, 200).map(publicationOf),
  };
}
