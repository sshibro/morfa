// A/B tests of two card frames for one product slot (docs/marketplaces.md §Performance Loop).
//
// "Rotation in Morfa": Morfa keeps both pictures, publishes A, then the worker swaps A and B at Moscow midnight every `swap_hours` for
// `days` days through the ordinary publishing path; each day's numbers count to the variant live that day, and six hours after the
// end (one sync later) a two-proportion z-test picks the winner, which is left as the live picture (A when there is no clear one).
//
// "Test in the seller account": WB's and Ozon's own tests have no public API, so Morfa only follows one the seller runs in the cabinet: planned,
// started on a date the seller marks, finished with the winner the seller enters.
import {randomUUID} from 'node:crypto';
import {db} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import {lockResources} from '../../postgresql/locks';
import type {CardNumbers} from '../../../shared/design/marketplace/score';
import type {LoopTest, TestMode, TestVariant, TestWinner} from '../../../shared/design/marketplace/loop';
import {
  moscowDay,
  moscowDayStart,
  rotationEnd,
  rotationNextSwap,
  rotationVariantAt,
  type RotationClock,
} from '../../../shared/design/marketplace/loop-stats';
import {fail} from '../../hosting/errors';
import {loopNow} from './clock';
import {MEDIA_DAYS} from './config';
import {pictureKind, readMediaBytes, storeMedia} from './media';
import {rotationResult, spansOf} from './numbers';
import {publishPicture, type LinkWithKey} from './publish';
import {iso, readLink, TEST_COLUMNS, testOf, type TestRow} from './store';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A rotation is judged this long after its end: a sync has read its last day by then. */
export const FINISH_AFTER_MS = 6 * HOUR_MS;

const readTest = (tx: SqlExecutor, userId: string, testId: string) =>
  tx.one<TestRow>(`SELECT ${TEST_COLUMNS} FROM marketplace_tests t WHERE t.id=$1 AND t.user_id=$2`, [testId, userId]);
const clockOf = (row: Pick<TestRow, 'started_at' | 'swap_hours' | 'days'>): RotationClock => ({
  startedAt: Date.parse(row.started_at!),
  swapHours: Number(row.swap_hours ?? 24),
  days: Number(row.days),
});
const notFound = () => fail(404, 'not_found', 'Test not found.');

export type NewTest = {linkId: string; variantB: string; mode: TestMode; days: number; swapHours: number | null};

/**
 * A new test of the link's frame (A) against `variantB`. A rotation starts at once with both pictures (`pictures`, rendered by the
 * editor): they are kept for its days and A is published; a cabinet test waits for the seller to start it there.
 */
export async function createTest(
  userId: string,
  input: NewTest,
  pictures: {a: Buffer; b: Buffer} | null,
): Promise<LoopTest> {
  const link = await readLink(db, userId, input.linkId);
  if (!link) return fail(404, 'not_found', 'The card is not linked to a product.');
  if (link.node_id === input.variantB) fail(400, 'invalid_request', 'Variant B must be a different frame.');
  if (input.mode === 'rotation') {
    if (!pictures) fail(400, 'invalid_request', 'Rotation needs both pictures.');
    for (const bytes of [pictures!.a, pictures!.b])
      if (!pictureKind(bytes)) fail(415, 'invalid_request', 'Pictures must be JPG, PNG or WebP.');
    if (link.connection_status === 'refused')
      fail(409, 'connection_refused', 'The marketplace rejected the key. Reconnect the shop.');
  }
  const now = loopNow();
  const id = randomUUID();
  await db.transaction(async tx => {
    await lockResources(tx, [{kind: 'account', id: userId}]);
    if (await tx.one("SELECT 1 FROM marketplace_tests WHERE link_id=$1 AND status IN('planned','running')", [link.id]))
      fail(409, 'test_running', 'This card already has a test running. Stop it to start a new one.');
    let media: {a: string; b: string} | null = null;
    let clock: RotationClock | null = null;
    if (input.mode === 'rotation' && pictures) {
      clock = {startedAt: now, swapHours: input.swapHours ?? 24, days: input.days};
      const keep = rotationEnd(clock) + FINISH_AFTER_MS + MEDIA_DAYS * DAY_MS;
      const a = await storeMedia(tx, {userId, bytes: pictures.a, kind: pictureKind(pictures.a)!, expiresAt: keep});
      const b = await storeMedia(tx, {userId, bytes: pictures.b, kind: pictureKind(pictures.b)!, expiresAt: keep});
      media = {a: a.id, b: b.id};
    }
    await tx.execute(
      `INSERT INTO marketplace_tests(id,user_id,link_id,file_id,variant_a,variant_b,media_a,media_b,mode,status,days,swap_hours,live_variant,
         next_swap_at,started_at,ends_at,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        id,
        userId,
        link.id,
        link.file_id,
        link.node_id,
        input.variantB,
        media?.a ?? null,
        media?.b ?? null,
        input.mode,
        clock ? 'running' : 'planned',
        input.days,
        input.mode === 'rotation' ? (input.swapHours ?? 24) : null,
        clock ? 'a' : null,
        clock ? iso(rotationNextSwap(clock, now)!) : null,
        clock ? iso(now) : null,
        clock ? iso(rotationEnd(clock)) : null,
        iso(now),
      ],
    );
  });
  if (pictures && input.mode === 'rotation') {
    const first = await publishPicture({userId, link, nodeId: link.node_id, testId: id, bytes: pictures.a});
    // A rotation whose first picture did not go out never started.
    if (first.status === 'failed') {
      await db.execute("UPDATE marketplace_tests SET status='stopped',finished_at=$2,next_swap_at=NULL WHERE id=$1", [
        id,
        iso(loopNow()),
      ]);
      fail(409, 'publish_failed', first.error ?? 'Could not publish variant A.');
    }
  }
  return testOf((await readTest(db, userId, id))!);
}

/** A cabinet test: the seller started it there on `startedOn` (a Moscow day; today when absent). */
export async function startCabinetTest(userId: string, testId: string, startedOn: string | null): Promise<LoopTest> {
  const now = loopNow();
  await db.transaction(async tx => {
    await lockResources(tx, [{kind: 'account', id: userId}]);
    const row = (await readTest(tx, userId, testId)) ?? notFound();
    if (row.mode !== 'cabinet' || row.status !== 'planned')
      fail(409, 'test_state', 'This test is already started or finished.');
    const day = startedOn ?? moscowDay(now);
    if (day > moscowDay(now)) fail(400, 'invalid_request', 'The start date has not come yet.');
    const started = Math.min(moscowDayStart(day), now);
    await tx.execute("UPDATE marketplace_tests SET status='running',started_at=$2,ends_at=$3 WHERE id=$1", [
      testId,
      iso(started),
      iso(started + Number(row.days) * DAY_MS),
    ]);
  });
  return testOf((await readTest(db, userId, testId))!);
}

/** A cabinet test's result, as the seller read it in the cabinet. */
export async function finishCabinetTest(userId: string, testId: string, winner: TestWinner): Promise<LoopTest> {
  const now = loopNow();
  await db.transaction(async tx => {
    await lockResources(tx, [{kind: 'account', id: userId}]);
    const row = (await readTest(tx, userId, testId)) ?? notFound();
    if (row.mode !== 'cabinet' || (row.status !== 'running' && row.status !== 'planned'))
      fail(409, 'test_state', 'This test is already finished.');
    await tx.execute(
      "UPDATE marketplace_tests SET status='finished',finished_at=$2,winner=$3,started_at=coalesce(started_at,$2) WHERE id=$1",
      [testId, iso(now), winner],
    );
  });
  return testOf((await readTest(db, userId, testId))!);
}

/** "Stop": no more swaps; a rotation showing B puts A back. */
export async function stopTest(userId: string, testId: string): Promise<LoopTest> {
  const now = loopNow();
  const row = await db.transaction(async tx => {
    await lockResources(tx, [{kind: 'account', id: userId}]);
    const row = (await readTest(tx, userId, testId)) ?? notFound();
    if (row.status !== 'planned' && row.status !== 'running') fail(409, 'test_state', 'This test is already finished.');
    await tx.execute("UPDATE marketplace_tests SET status='stopped',finished_at=$2,next_swap_at=NULL WHERE id=$1", [
      testId,
      iso(now),
    ]);
    return row;
  });
  if (row.mode === 'rotation' && row.live_variant === 'b') await swapTo(row, 'a');
  return testOf((await readTest(db, userId, testId))!);
}

/** Publishes the rotation's stored picture of `variant`; true when it went out. */
async function swapTo(row: TestRow, variant: TestVariant): Promise<boolean> {
  const mediaId = variant === 'a' ? row.media_a : row.media_b;
  const stored = mediaId ? await readMediaBytes(db, mediaId) : null;
  const link = (await readLink(db, row.user_id, row.link_id)) as LinkWithKey | undefined;
  if (!stored || !link || link.connection_status === 'refused') return false;
  const publication = await publishPicture({
    userId: row.user_id,
    link,
    nodeId: variant === 'a' ? row.variant_a : row.variant_b,
    testId: row.id,
    bytes: stored.bytes,
  });
  if (publication.status === 'failed') return false;
  await db.execute('UPDATE marketplace_tests SET live_variant=$2 WHERE id=$1', [row.id, variant]);
  return true;
}

/** The rotation's verdict from the numbers the syncs kept. */
async function judge(row: TestRow, now: number) {
  const link = (await readLink(db, row.user_id, row.link_id))!;
  const publications = await db.many<{node_id: string; live_from: string | null; live_until: string | null}>(
    'SELECT node_id,live_from,live_until FROM marketplace_publications WHERE link_id=$1 AND live_from IS NOT NULL',
    [row.link_id],
  );
  const metrics = await db.many<{
    day: string;
    views: number | null;
    clicks: number | null;
    carts: number | null;
    orders: number | null;
  }>(
    'SELECT day,views,clicks,carts,orders FROM marketplace_metrics WHERE connection_id=$1 AND product_id=$2 AND day>=$3',
    [link.connection_id, link.product_id, moscowDay(row.started_at!)],
  );
  const numbers = new Map<string, CardNumbers>(
    metrics.map(metric => [
      metric.day,
      {views: metric.views, clicks: metric.clicks, carts: metric.carts, orders: metric.orders},
    ]),
  );
  return rotationResult(row, spansOf(publications), numbers, now);
}

/**
 * The worker's rotations: each running one whose swap is due gets the variant due now (a failed publish is tried again next pass);
 * one past its end and FINISH_AFTER_MS is judged, its winner left live, and finished.
 */
export async function runRotations(now: number): Promise<void> {
  const due = await db.many<TestRow>(
    `SELECT ${TEST_COLUMNS} FROM marketplace_tests t
      WHERE t.status='running' AND t.mode='rotation' AND (t.next_swap_at<=$1 OR t.ends_at<=$2)
      ORDER BY t.next_swap_at NULLS FIRST LIMIT 200`,
    [iso(now), iso(now - FINISH_AFTER_MS)],
  );
  for (const row of due) {
    const clock = clockOf(row);
    if (row.ends_at && Date.parse(row.ends_at) + FINISH_AFTER_MS <= now) {
      const {winner, result} = await judge(row, now);
      const keep: TestVariant = winner === 'b' ? 'b' : 'a';
      if (row.live_variant !== keep && !(await swapTo(row, keep))) continue;
      await db.execute(
        "UPDATE marketplace_tests SET status='finished',finished_at=$2,winner=$3,result=$4::jsonb,next_swap_at=NULL WHERE id=$1 AND status='running'",
        [row.id, iso(now), winner, JSON.stringify(result)],
      );
      continue;
    }
    const wanted = rotationVariantAt(clock, now);
    if (row.live_variant !== wanted && !(await swapTo(row, wanted))) continue;
    const next = rotationNextSwap(clock, now);
    await db.execute("UPDATE marketplace_tests SET next_swap_at=$2 WHERE id=$1 AND status='running'", [
      row.id,
      next === null ? null : iso(next),
    ]);
  }
}
