// Performance Loop arithmetic (docs/marketplaces.md §Performance Loop): Moscow days, which frame a day's numbers count to, the
// A/B test's two-proportion z-test and the rotation's schedule. Pure, so the server and the editor count the same way and the
// tests pin it.
//
// The marketplaces report a product's numbers by Moscow day, so a day counts to the frame that was the live picture for most of
// it; a day split between two pictures counts to neither. Rotation therefore swaps at Moscow midnight.

import type {CardNumbers} from './score';
import type {DayNumbers, TestResult, TestVariant, TestWinner} from './loop';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Moscow keeps UTC+3 all year (no daylight saving since 2014). */
export const MOSCOW_OFFSET_MS = 3 * HOUR_MS;

const time = (at: Date | number | string) => (typeof at === 'number' ? at : typeof at === 'string' ? Date.parse(at) : at.getTime());

/** The Moscow day of an instant, "2026-10-12". */
export const moscowDay = (at: Date | number | string): string => new Date(time(at) + MOSCOW_OFFSET_MS).toISOString().slice(0, 10);
/** The instant a Moscow day begins (ms). */
export const moscowDayStart = (day: string): number => Date.parse(day + 'T00:00:00.000Z') - MOSCOW_OFFSET_MS;
/** The day `n` days after `day` (before, when negative). */
export const addDays = (day: string, n: number): string => new Date(Date.parse(day + 'T00:00:00.000Z') + n * DAY_MS).toISOString().slice(0, 10);
/** Every day from `from` to `to`, both included, oldest first. */
export function daysFrom(from: string, to: string): string[] {
  const out: string[] = [];
  for (let day = from; day <= to && out.length < 1000; day = addDays(day, 1)) out.push(day);
  return out;
}
/** The first Moscow midnight after `at`. */
export const nextMoscowMidnight = (at: Date | number | string): number => moscowDayStart(addDays(moscowDay(at), 1));

/** A picture's hours as the live photo: from `from` until `until` (still live: null). Instants in ms. */
export type LiveSpan = {nodeId: string; from: number; until: number | null};

/** Each frame's live time within one Moscow day, up to `now` (ms). */
export function liveTimeOn(spans: readonly LiveSpan[], day: string, now: number): Map<string, number> {
  const start = moscowDayStart(day), end = Math.min(start + DAY_MS, now);
  const out = new Map<string, number>();
  for (const span of spans) {
    const overlap = Math.min(end, span.until ?? now) - Math.max(start, span.from);
    if (overlap > 0) out.set(span.nodeId, (out.get(span.nodeId) ?? 0) + overlap);
  }
  return out;
}

/** The frame a day's numbers count to: the one live for more than half of the day (of its elapsed part, today); null when none
 *  was (another picture, a swap in the middle of the day, or nothing published yet). */
export function frameOfDay(spans: readonly LiveSpan[], day: string, now: number): string | null {
  const start = moscowDayStart(day);
  const length = Math.min(start + DAY_MS, now) - start;
  if (length <= 0) return null;
  for (const [nodeId, live] of liveTimeOn(spans, day, now)) if (live * 2 > length) return nodeId;
  return null;
}

const NUMBER_KEYS = ['views', 'clicks', 'carts', 'orders'] as const;
export const EMPTY_NUMBERS: CardNumbers = {views: null, clicks: null, carts: null, orders: null};

/** Sums days' numbers; a number no day reported stays null. */
export function sumNumbers(rows: readonly CardNumbers[]): CardNumbers {
  const out: CardNumbers = {...EMPTY_NUMBERS};
  for (const row of rows)
    for (const key of NUMBER_KEYS) {
      const value = row[key];
      if (value !== null && value !== undefined) out[key] = (out[key] ?? 0) + value;
    }
  return out;
}

/** Φ(z), the standard normal distribution (Abramowitz and Stegun 7.1.26, error under 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

/** Two-proportion z-test of `x1` of `n1` against `x2` of `n2` (pooled), two-sided. Null when either side has no trials or the
 *  pooled share is 0 or 1 (nothing to tell apart). */
export function twoProportionTest(x1: number, n1: number, x2: number, n2: number): {z: number; p: number} | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const pooled = (x1 + x2) / (n1 + n2);
  if (pooled <= 0 || pooled >= 1) return null;
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  const z = (x1 / n1 - x2 / n2) / se;
  return {z, p: 2 * (1 - normalCdf(Math.abs(z)))};
}

/** A difference counts at this p-value or under. */
export const SIGNIFICANCE = 0.05;

/** The rotation's verdict: CTR (card opens ÷ impressions) when both variants have impressions, else orders ÷ card opens (WB's
 *  funnel has no impressions). The better variant wins when p < 0.05; otherwise there is no clear winner. */
export function judgeVariants(a: CardNumbers & {days: number}, b: CardNumbers & {days: number}): {winner: TestWinner; result: TestResult} {
  const byCtr = a.views !== null && b.views !== null && a.views > 0 && b.views > 0 && a.clicks !== null && b.clicks !== null;
  const byConversion = !byCtr && a.clicks !== null && b.clicks !== null && a.clicks > 0 && b.clicks > 0 && a.orders !== null && b.orders !== null;
  const metric = byCtr ? 'ctr' : byConversion ? 'conversion' : null;
  const test = byCtr ? twoProportionTest(a.clicks!, a.views!, b.clicks!, b.views!) : byConversion ? twoProportionTest(a.orders!, a.clicks!, b.orders!, b.clicks!) : null;
  const winner: TestWinner = test && test.p < SIGNIFICANCE ? (test.z > 0 ? 'a' : 'b') : 'none';
  return {winner, result: {metric, a, b, z: test?.z ?? null, p: test?.p ?? null}};
}

/** The days of `days` each frame was the live picture, with their numbers (days the marketplace reported nothing are left out). */
export function daysByFrame(spans: readonly LiveSpan[], numbers: ReadonlyMap<string, CardNumbers>, days: readonly string[], now: number): Map<string, DayNumbers[]> {
  const out = new Map<string, DayNumbers[]>();
  for (const day of days) {
    const nodeId = frameOfDay(spans, day, now);
    const value = numbers.get(day);
    if (!nodeId || !value) continue;
    out.set(nodeId, [...(out.get(nodeId) ?? []), {day, ...value}]);
  }
  return out;
}

/** A rotation's standing: each variant's numbers over the test's whole days so far (all of them once it ended), judged. Today is
 *  left out: its numbers are partial and a swap at midnight makes its first minutes the previous variant's. */
export function rotationStanding(
  test: {variantA: string; variantB: string; startedAt: string; endsAt: string | null},
  spans: readonly LiveSpan[],
  numbers: ReadonlyMap<string, CardNumbers>,
  now: number,
): {winner: TestWinner; result: TestResult} {
  const first = moscowDay(test.startedAt);
  const yesterday = addDays(moscowDay(now), -1);
  const lastDay = test.endsAt ? moscowDay(Date.parse(test.endsAt) - 1) : yesterday;
  const last = lastDay < yesterday ? lastDay : yesterday;
  const byFrame = daysByFrame(spans, numbers, daysFrom(first, last), now);
  const side = (nodeId: string) => {
    const days = byFrame.get(nodeId) ?? [];
    return {...sumNumbers(days), days: days.length};
  };
  return judgeVariants(side(test.variantA), side(test.variantB));
}

/** A rotation's clock: it starts with A; the first swap is the Moscow midnight after the start, then one every `swapHours`; it ends
 *  `days` days after that first midnight, so every day it counts is whole. Instants in ms. */
export type RotationClock = {startedAt: number; swapHours: number; days: number};
export const rotationFirstSwap = (clock: RotationClock) => nextMoscowMidnight(clock.startedAt);
export const rotationEnd = (clock: RotationClock) => rotationFirstSwap(clock) + clock.days * DAY_MS;

/** The variant that should be live at `at`: A until the first swap, then B, A, B… */
export function rotationVariantAt(clock: RotationClock, at: number): TestVariant {
  const first = rotationFirstSwap(clock);
  if (at < first) return 'a';
  return Math.floor((at - first) / (clock.swapHours * HOUR_MS)) % 2 === 0 ? 'b' : 'a';
}

/** The next swap after `at`, or null when the test ends first. */
export function rotationNextSwap(clock: RotationClock, at: number): number | null {
  const first = rotationFirstSwap(clock), period = clock.swapHours * HOUR_MS;
  const next = at < first ? first : first + (Math.floor((at - first) / period) + 1) * period;
  return next < rotationEnd(clock) ? next : null;
}

/** Whole days left until `endsAt` (rounded up), never below 0. */
export const daysLeft = (endsAt: number, now: number) => Math.max(0, Math.ceil((endsAt - now) / DAY_MS));
