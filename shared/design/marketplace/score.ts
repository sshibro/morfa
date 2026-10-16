// Card Score (docs/marketplaces.md §Performance Loop): one 0–100 number per card. Half is Spec Lint (does the card pass the
// marketplace's rules), half is its click-through rate against the 2 % benchmark sellers use for WB. A card the marketplace has not
// reported impressions for yet is scored on Spec Lint alone and says so.

import type {LintReport} from './lint';
import {LOW_CTR, STRONG_CTR} from './specs';

export type CardNumbers = {
  /** Impressions in the catalogue and search; null where the marketplace does not report them (WB's funnel). */
  views: number | null;
  /** Card opens. */
  clicks: number | null;
  carts: number | null;
  orders: number | null;
};

export type CardScore = {
  score: number;
  /** clicks ÷ views, when both are known and views > 0. */
  ctr: number | null;
  /** Under the 2 % benchmark. */
  lowCtr: boolean;
  /** Orders ÷ clicks. */
  conversion: number | null;
  /** The score has no CTR half yet. */
  lintOnly: boolean;
};

/** Impressions under this are too few to judge a CTR by. */
export const MIN_VIEWS_FOR_CTR = 200;

export const ctrOf = (numbers: CardNumbers): number | null =>
  numbers.views !== null && numbers.clicks !== null && numbers.views > 0 ? numbers.clicks / numbers.views : null;
export const conversionOf = (numbers: CardNumbers): number | null =>
  numbers.clicks !== null && numbers.orders !== null && numbers.clicks > 0 ? numbers.orders / numbers.clicks : null;

/** Spec Lint's half, 0..50: 50 less 20 a failed check and 5 a warning; a pending check costs nothing. */
export function lintPoints(report: Pick<LintReport, 'checks'>): number {
  let points = 50;
  for (const check of report.checks) points -= check.status === 'fail' ? 20 : check.status === 'warn' ? 5 : 0;
  return Math.max(0, points);
}

/** CTR's half, 0..50: linear from 0 to STRONG_CTR (5 %). */
export const ctrPoints = (ctr: number) => Math.round(50 * Math.min(1, Math.max(0, ctr / STRONG_CTR)));

export function cardScore(report: Pick<LintReport, 'checks'>, numbers: CardNumbers | null): CardScore {
  const lint = lintPoints(report);
  const ctr = numbers ? ctrOf(numbers) : null;
  const conversion = numbers ? conversionOf(numbers) : null;
  const judged = ctr !== null && numbers !== null && (numbers.views ?? 0) >= MIN_VIEWS_FOR_CTR;
  if (!judged) return {score: lint * 2, ctr, lowCtr: false, conversion, lintOnly: true};
  return {score: lint + ctrPoints(ctr), ctr, lowCtr: ctr < LOW_CTR, conversion, lintOnly: false};
}

/** "4.2%" */
export const formatPercent = (share: number, digits = 1) => `${(share * 100).toFixed(digits)}%`;
/** "12,400", "1.2M" */
export function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  return Math.round(value).toLocaleString('en-US');
}
