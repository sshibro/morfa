import type {AdminMetric} from '../../shared/admin-analytics';

// How the console writes numbers, sizes and time: English style, short. A comma separates groups ("12,400") and a no-break space
// sits before units ("340 MB", "3 hr ago").

export const NBSP = ' ';
const MINUS = '−';

const whole = new Intl.NumberFormat('en-US', {maximumFractionDigits: 0});
const oneDecimal = new Intl.NumberFormat('en-US', {maximumFractionDigits: 1});

/** 12 400 */
export const num = (value: number) => whole.format(Math.round(value)).replace(/\s/g, NBSP);

/** Axis ticks and tight places: 950 · 1.2K · 12K · 1.2M. */
export function compact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? MINUS : '';
  if (abs < 1000) return sign + oneDecimal.format(abs);
  if (abs < 1e6) return sign + (abs < 10_000 ? oneDecimal.format(abs / 1000) : whole.format(abs / 1000)) + 'K';
  if (abs < 1e9) return sign + (abs < 10e6 ? oneDecimal.format(abs / 1e6) : whole.format(abs / 1e6)) + 'M';
  return sign + oneDecimal.format(abs / 1e9) + 'B';
}

/** A share 0..1 as 42% (3.1% under ten). */
export function pct(share: number): string {
  const value = share * 100;
  const abs = Math.abs(value);
  const text = abs > 0 && abs < 10 ? oneDecimal.format(value) : whole.format(value);
  return text.replace('-', MINUS) + '%';
}

/** Bytes: 0 B · 12 KB · 340 MB · 1.2 GB. */
export function bytes(value: number): string {
  if (value < 1024) return whole.format(value) + NBSP + 'B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let amount = value / 1024;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit++;
  }
  return (amount < 10 ? oneDecimal.format(amount) : whole.format(amount)) + NBSP + units[unit];
}

/** 1 day · 2 days */
export function plural(count: number, one: string, other: string): string {
  return Math.abs(Math.trunc(count)) === 1 ? one : other;
}

export const countOf = (count: number, one: string, other: string) => `${num(count)}${NBSP}${plural(count, one, other)}`;

export type Delta = {text: string; direction: 'up' | 'down' | 'flat'; tone: 'good' | 'bad' | 'neutral'};

/** The change against the previous window: +12%, −8%; `upIsGood` false for errors and other counts that should fall. Null: nothing to compare. */
export function delta(metric: AdminMetric | {value: number | null; previous: number | null}, {upIsGood = true, points = false}: {upIsGood?: boolean; points?: boolean} = {}): Delta | null {
  const {value, previous} = metric;
  if (value === null || previous === null) return null;
  let change: number;
  let text: string;
  if (points) {
    // Shares compare in percentage points: 92% → 95% is +3 pp, not +3.3%.
    change = (value - previous) * 100;
    text = (Math.abs(change) < 10 ? oneDecimal : whole).format(Math.abs(change)) + NBSP + 'pp';
  } else {
    if (previous === 0) {
      if (value === 0) return {text: '0%', direction: 'flat', tone: 'neutral'};
      return {text: 'was 0', direction: value > 0 ? 'up' : 'down', tone: value > 0 === upIsGood ? 'good' : 'bad'};
    }
    change = ((value - previous) / Math.abs(previous)) * 100;
    const abs = Math.abs(change);
    // Past tenfold a percentage stops reading ("+2,771%"): say how many times ("×28").
    if (change >= 900 && previous > 0) return {text: '×' + whole.format(value / previous), direction: 'up', tone: upIsGood ? 'good' : 'bad'};
    text = (abs < 10 && abs >= 0.05 ? oneDecimal : whole).format(abs) + '%';
  }
  if (Math.abs(change) < 0.05) return {text: points ? '0' + NBSP + 'pp' : '0%', direction: 'flat', tone: 'neutral'};
  const direction = change > 0 ? 'up' : 'down';
  return {text: (change > 0 ? '+' : MINUS) + text, direction, tone: (change > 0) === upIsGood ? 'good' : 'bad'};
}

const MOSCOW = 'Europe/Moscow';
const dayFormat = new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'short', timeZone: 'UTC'});
const dayYearFormat = new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'});
const monthFormat = new Intl.DateTimeFormat('en-US', {month: 'short', timeZone: 'UTC'});
const instantDay = new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'short', timeZone: MOSCOW});
const instantDayYear = new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'short', year: 'numeric', timeZone: MOSCOW});
const instantTime = new Intl.DateTimeFormat('en-US', {hour: '2-digit', minute: '2-digit', timeZone: MOSCOW});
const moscowYear = new Intl.DateTimeFormat('en-CA', {year: 'numeric', timeZone: MOSCOW});

/** No-break spaces in dates ("Sep 12, 2025"). */
const clean = (text: string) => text.replace(/\s/g, NBSP);

/** A Moscow day 'YYYY-MM-DD' → "Sep 12" */
export const dayLabel = (day: string) => clean(dayFormat.format(new Date(day + 'T00:00:00Z')));
export const dayYearLabel = (day: string) => clean(dayYearFormat.format(new Date(day + 'T00:00:00Z')));
/** The month of a day → "Oct" */
export const monthLabel = (day: string) => clean(monthFormat.format(new Date(day + 'T00:00:00Z')));

/** An instant → "Sep 12" (with the year when it is not this one), Moscow. */
export function dateLabel(iso: string, now = Date.now()): string {
  const date = new Date(iso);
  const sameYear = moscowYear.format(date) === moscowYear.format(new Date(now));
  return clean((sameYear ? instantDay : instantDayYear).format(date));
}

export const timeLabel = (iso: string) => instantTime.format(new Date(iso));

/** "just now", "5 min ago", "3 hr ago", "yesterday", "4 days ago", then the date. */
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return '—';
  const seconds = (now - new Date(iso).getTime()) / 1000;
  if (seconds < 60) return 'just now';
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)}${NBSP}min ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${Math.floor(hours)}${NBSP}hr ago`;
  const days = hours / 24;
  if (days < 2) return 'yesterday';
  if (days < 30) return `${Math.floor(days)}${NBSP}days${NBSP}ago`;
  return dateLabel(iso, now);
}

/** Whole days since an instant. */
export const daysSince = (iso: string, now = Date.now()) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 86_400_000));

/** "Ivan Smith" → "IS"; an e-mail → its first letter. */
export function initials(name: string, email = ''): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (email[0] ?? '?').toUpperCase();
}
