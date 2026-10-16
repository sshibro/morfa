import {conversionOf, ctrOf, formatCount, formatPercent, MIN_VIEWS_FOR_CTR, type CardNumbers} from '../../../../shared/design/marketplace/score';
import {LOW_CTR} from '../../../../shared/design/marketplace/specs';

// How the Performance Loop writes its numbers (docs/marketplaces.md §Performance Loop): the strip under a card frame ("Impressions 12,400 ·
// CTR 3.1% · Add to cart 410 · Orders 96", shorter when the frame is narrow on screen), "—" for a number the marketplace does not report,
// and the low-CTR flag (under 2 % on enough impressions to judge).

export const DASH = '—';
const countText = (value: number | null) => (value === null ? DASH : formatCount(value));
const percentText = (value: number | null) => (value === null ? DASH : formatPercent(value));

export type StripPart = {label: string; value: string};
export function stripParts(numbers: CardNumbers): StripPart[] {
  return [
    {label: 'Impressions', value: countText(numbers.views)},
    {label: 'CTR', value: percentText(ctrOf(numbers))},
    {label: 'Add to cart', value: countText(numbers.carts)},
    {label: 'Orders', value: countText(numbers.orders)},
  ];
}
const join = (parts: readonly StripPart[]) => parts.map(part => `${part.label} ${part.value}`).join(' · ');

/** The strip's text from the longest to the shortest: all four, then CTR and orders, then CTR alone. */
export function stripTexts(numbers: CardNumbers): string[] {
  const parts = stripParts(numbers);
  return [join(parts), join([parts[1]!, parts[3]!]), join([parts[1]!])];
}

/** CTR under the 2 % benchmark, on enough impressions to say so. */
export function lowCtr(numbers: CardNumbers): boolean {
  const ctr = ctrOf(numbers);
  return ctr !== null && (numbers.views ?? 0) >= MIN_VIEWS_FOR_CTR && ctr < LOW_CTR;
}

/** "Conversion to order 4.1%" */
export const conversionText = (numbers: CardNumbers) => percentText(conversionOf(numbers));

export const daysText = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** "Oct 12, 2:05 PM" in Moscow time (the marketplaces' days). */
export function whenText(iso: string | null): string {
  if (!iso) return DASH;
  return new Date(iso).toLocaleString('en-US', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow'});
}

/** p as people read it: "p < 0.001", "p = 0.03". */
export const pText = (p: number) => (p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}`);
