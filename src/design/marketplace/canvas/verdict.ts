// Card Canvas: Spec Lint's verdict in words ("2 errors, 1 remark"), for "Check" and the marketplace switch's names.

import type {LintReport} from '../../../../shared/design/marketplace/lint';

export const plural = (n: number, one: string, other: string) => (n === 1 ? one : other);
export const errors = (n: number) => `${n} ${plural(n, 'error', 'errors')}`;
export const remarks = (n: number) => `${n} ${plural(n, 'remark', 'remarks')}`;

type Tally = {fail: number; warn: number; pending: number};
export function tallyOf(report: Pick<LintReport, 'checks'> | undefined): Tally {
  const tally: Tally = {fail: 0, warn: 0, pending: 0};
  for (const check of report?.checks ?? []) if (check.status !== 'pass') tally[check.status]++;
  return tally;
}

/** "Ozon: 2 errors" — a marketplace's verdict in words, for the switch's accessible names and tooltips. */
export function verdictText(report: LintReport | undefined, measuring: boolean): string {
  if (!report) return 'no data';
  const tally = tallyOf(report);
  if (tally.fail) return errors(tally.fail) + (tally.warn ? `, ${remarks(tally.warn)}` : '');
  if (tally.warn) return remarks(tally.warn);
  if (tally.pending) return measuring ? 'checking' : 'no errors, some checks have no data';
  return 'passes';
}
