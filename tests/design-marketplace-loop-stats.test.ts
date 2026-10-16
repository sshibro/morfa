import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays,
  daysFrom,
  daysLeft,
  frameOfDay,
  judgeVariants,
  liveTimeOn,
  moscowDay,
  moscowDayStart,
  daysByFrame,
  nextMoscowMidnight,
  normalCdf,
  rotationEnd,
  rotationFirstSwap,
  rotationNextSwap,
  rotationStanding,
  rotationVariantAt,
  sumNumbers,
  twoProportionTest,
  type LiveSpan,
} from '../shared/design/marketplace/loop-stats';
import {lowCtr, stripTexts} from '../src/design/marketplace/loop/format';

// Performance Loop arithmetic (docs/marketplaces.md §Performance Loop): Moscow days, which frame a day's numbers count to, the
// two-proportion z-test, the rotation's clock, and the strip's words.

const HOUR = 3_600_000;
const at = (iso: string) => Date.parse(iso);

test('should count days in Moscow time (UTC+3 all year)', () => {
  assert.equal(moscowDay(at('2026-10-12T20:59:59Z')), '2026-10-12');
  assert.equal(moscowDay(at('2026-10-12T21:00:00Z')), '2026-10-13');
  assert.equal(moscowDay(at('2026-01-15T21:30:00Z')), '2026-01-16', 'no daylight saving in winter either');
  assert.equal(moscowDayStart('2026-10-13'), at('2026-10-12T21:00:00Z'));
  assert.equal(nextMoscowMidnight(at('2026-10-12T10:00:00Z')), at('2026-10-12T21:00:00Z'));
  assert.equal(nextMoscowMidnight(at('2026-10-12T21:00:00Z')), at('2026-10-13T21:00:00Z'), 'midnight itself goes to the next one');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.deepEqual(daysFrom('2026-02-27', '2026-03-01'), ['2026-02-27', '2026-02-28', '2026-03-01']);
  assert.equal(daysLeft(at('2026-10-20T00:00:00Z'), at('2026-10-12T12:00:00Z')), 8);
  assert.equal(daysLeft(at('2026-10-10T00:00:00Z'), at('2026-10-12T12:00:00Z')), 0);
});

test('should count a day to the frame live for more than half of it, and to none when a swap splits it', () => {
  // A from 10:00 Moscow on the 12th until midnight of the 14th; B since.
  const spans: LiveSpan[] = [
    {nodeId: 'A', from: at('2026-10-12T07:00:00Z'), until: at('2026-10-13T21:00:00Z')},
    {nodeId: 'B', from: at('2026-10-13T21:00:00Z'), until: null},
  ];
  const now = at('2026-10-15T09:00:00Z'); // 12:00 Moscow on the 15th
  assert.equal(frameOfDay(spans, '2026-10-11', now), null, 'nothing was live');
  assert.equal(frameOfDay(spans, '2026-10-12', now), 'A', '14 of 24 hours');
  assert.equal(frameOfDay(spans, '2026-10-13', now), 'A');
  assert.equal(frameOfDay(spans, '2026-10-14', now), 'B');
  assert.equal(frameOfDay(spans, '2026-10-15', now), 'B', 'today counts its elapsed part');
  assert.equal(frameOfDay(spans, '2026-10-16', now), null, 'tomorrow has not begun');
  const split: LiveSpan[] = [
    {nodeId: 'A', from: at('2026-10-11T21:00:00Z'), until: at('2026-10-12T09:00:00Z')},
    {nodeId: 'B', from: at('2026-10-12T09:00:00Z'), until: null},
  ];
  assert.equal(frameOfDay(split, '2026-10-12', now), null, '12 and 12 hours: neither');
  assert.equal(liveTimeOn(split, '2026-10-12', now).get('A'), 12 * HOUR);
  // The same frame published twice counts as one.
  const twice: LiveSpan[] = [
    {nodeId: 'A', from: at('2026-10-11T21:00:00Z'), until: at('2026-10-12T05:00:00Z')},
    {nodeId: 'C', from: at('2026-10-12T05:00:00Z'), until: at('2026-10-12T09:00:00Z')},
    {nodeId: 'A', from: at('2026-10-12T09:00:00Z'), until: null},
  ];
  assert.equal(frameOfDay(twice, '2026-10-12', now), 'A');
});

test('should give each frame the numbers of its own days', () => {
  const spans: LiveSpan[] = [
    {nodeId: 'A', from: at('2026-10-09T21:00:00Z'), until: at('2026-10-11T21:00:00Z')},
    {nodeId: 'B', from: at('2026-10-11T21:00:00Z'), until: null},
  ];
  const numbers = new Map([
    ['2026-10-10', {views: 1000, clicks: 20, carts: 5, orders: 2}],
    ['2026-10-11', {views: 1000, clicks: 30, carts: 6, orders: 3}],
    ['2026-10-12', {views: 900, clicks: 45, carts: 9, orders: 4}],
  ]);
  const byFrame = daysByFrame(spans, numbers, daysFrom('2026-10-09', '2026-10-12'), at('2026-10-12T20:00:00Z'));
  assert.deepEqual(byFrame.get('A')?.map(day => day.day), ['2026-10-10', '2026-10-11']);
  assert.deepEqual(byFrame.get('B')?.map(day => day.clicks), [45]);
  assert.deepEqual(sumNumbers(byFrame.get('A')!), {views: 2000, clicks: 50, carts: 11, orders: 5});
  assert.deepEqual(sumNumbers([{views: null, clicks: 3, carts: null, orders: 1}, {views: null, clicks: 4, carts: 2, orders: null}]), {
    views: null,
    clicks: 7,
    carts: 2,
    orders: 1,
  }, 'a number no day reported stays null');
});

test('should run a two-proportion z-test as the textbook does', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-7);
  assert.ok(Math.abs(normalCdf(1.959964) - 0.975) < 1e-6);
  assert.ok(Math.abs(normalCdf(-1.644854) - 0.05) < 1e-6);
  // 200 of 10 000 against 260 of 10 000: pooled 2,3 %, se ≈ 0.00212, z ≈ −2.830, p ≈ 0.0047.
  const result = twoProportionTest(200, 10_000, 260, 10_000)!;
  assert.ok(Math.abs(result.z + 2.8303) < 0.001, String(result.z));
  assert.ok(Math.abs(result.p - 0.00465) < 0.0002, String(result.p));
  assert.equal(twoProportionTest(0, 100, 0, 100), null, 'nothing to tell apart');
  assert.equal(twoProportionTest(5, 0, 5, 100), null, 'no trials');
});

test('should judge a rotation on CTR with impressions, on orders per click without, and call a near tie no winner', () => {
  const side = (views: number | null, clicks: number, orders: number, days = 7) => ({views, clicks, carts: 0, orders, days});
  const ctr = judgeVariants(side(10_000, 200, 10), side(10_000, 260, 11));
  assert.equal(ctr.winner, 'b');
  assert.equal(ctr.result.metric, 'ctr');
  assert.ok(ctr.result.p! < 0.05);
  const wb = judgeVariants(side(null, 1000, 80), side(null, 1000, 40));
  assert.equal(wb.result.metric, 'conversion', "WB's funnel has no impressions");
  assert.equal(wb.winner, 'a');
  const tie = judgeVariants(side(10_000, 200, 10), side(10_000, 210, 10));
  assert.equal(tie.winner, 'none');
  assert.ok(tie.result.p! > 0.05);
  const empty = judgeVariants(side(null, 0, 0, 0), side(null, 0, 0, 0));
  assert.deepEqual([empty.winner, empty.result.metric, empty.result.p], ['none', null, null]);
});

test('should swap a rotation at Moscow midnight every swap_hours and end on a whole day', () => {
  const started = at('2026-10-12T11:00:00Z'); // 14:00 Moscow
  const clock = {startedAt: started, swapHours: 24, days: 14};
  const first = rotationFirstSwap(clock);
  assert.equal(first, at('2026-10-12T21:00:00Z'));
  assert.equal(rotationEnd(clock), first + 14 * 24 * HOUR);
  assert.equal(rotationVariantAt(clock, started), 'a');
  assert.equal(rotationVariantAt(clock, first - 1), 'a');
  assert.equal(rotationVariantAt(clock, first), 'b');
  assert.equal(rotationVariantAt(clock, first + 25 * HOUR), 'a');
  assert.equal(rotationVariantAt(clock, first + 48 * HOUR), 'b');
  assert.equal(rotationNextSwap(clock, started), first);
  assert.equal(rotationNextSwap(clock, first), first + 24 * HOUR);
  assert.equal(rotationNextSwap(clock, first + 13 * 24 * HOUR + 1), null, 'the last period ends the test');
  const slow = {startedAt: started, swapHours: 48, days: 6};
  assert.deepEqual(
    [0, 24, 48, 72, 96, 120].map(hours => rotationVariantAt(slow, first + hours * HOUR)),
    ['b', 'b', 'a', 'a', 'b', 'b'],
  );
});

test('should count a finished rotation to the variant live each day', () => {
  const started = '2026-10-01T09:00:00.000Z'; // 12:00 Moscow, A from then
  const first = at('2026-10-01T21:00:00Z');
  const spans: LiveSpan[] = [{nodeId: 'A', from: at(started), until: first}];
  for (let k = 0; k < 6; k++)
    spans.push({nodeId: k % 2 === 0 ? 'B' : 'A', from: first + k * 24 * HOUR, until: k === 5 ? null : first + (k + 1) * 24 * HOUR});
  const numbers = new Map<string, {views: number; clicks: number; carts: number; orders: number}>();
  for (const day of daysFrom('2026-10-01', '2026-10-08'))
    numbers.set(day, {views: 5000, clicks: frameOfDay(spans, day, at('2026-10-09T00:00:00Z')) === 'B' ? 250 : 100, carts: 10, orders: 3});
  const test = {variantA: 'A', variantB: 'B', startedAt: started, endsAt: new Date(first + 6 * 24 * HOUR).toISOString()};
  const {winner, result} = rotationStanding(test, spans, numbers, at('2026-10-09T12:00:00Z'));
  assert.equal(winner, 'b');
  assert.equal(result.a.days, 3, 'the start day (A for 12 of its 24 hours) counts to neither; the 8th is after the end');
  assert.equal(result.b.days, 3);
  assert.equal(result.b.clicks, 750);
  // While it runs, only whole days count: 03:00 Moscow on the 5th reads the 2nd (B), 3rd (A) and 4th (B), not the 5th.
  const running = rotationStanding({...test, endsAt: '2026-10-20T21:00:00.000Z'}, spans, numbers, at('2026-10-05T00:00:00Z'));
  assert.deepEqual([running.result.a.days, running.result.b.days], [1, 2]);
});

test('should write the strip shorter as the frame gets narrow, "—" for numbers not reported, and flag CTR under 2%', () => {
  assert.deepEqual(stripTexts({views: 12_400, clicks: 384, carts: 410, orders: 96}), [
    'Impressions 12,400 · CTR 3.1% · Add to cart 410 · Orders 96',
    'CTR 3.1% · Orders 96',
    'CTR 3.1%',
  ]);
  assert.equal(stripTexts({views: null, clicks: 300, carts: 41, orders: 9})[0], 'Impressions — · CTR — · Add to cart 41 · Orders 9');
  assert.equal(lowCtr({views: 10_000, clicks: 150, carts: 0, orders: 0}), true);
  assert.equal(lowCtr({views: 100, clicks: 1, carts: 0, orders: 0}), false, 'too few impressions to judge');
  assert.equal(lowCtr({views: null, clicks: 150, carts: 0, orders: 0}), false);
});
