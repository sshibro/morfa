// Who signs up and when they come back: signups that grow over the window with weekday seasonality and two spikes (a launch day
// and a press mention), an engagement level per account, a lifetime after which the person stops coming, and the sessions in between
// (Moscow working hours, quieter weekends). Everything else in the model (files, money, the journal) happens inside these sessions.
import {DAY, HOUR, MINUTE, moscowDay, moscowDayStart, moscowWeekday} from './time';
import {person} from './texts';
import type {Random} from './random';

export type Engagement = 'bounce' | 'casual' | 'regular' | 'power';
/** live: an ordinary account; closing: asked to close it (not erased yet); erased: closed and erased by the maintenance pass. */
export type Fate = 'live' | 'closing' | 'erased';
export type Session = {start: number; end: number};
export type Account = {
  index: number;
  id: string;
  name: string;
  firstName: string;
  email: string;
  emailVerified: boolean;
  signupAt: number;
  engagement: Engagement;
  /** The person stops coming after this. */
  activeUntil: number;
  /** Hours the person's day is shifted by (evening people). */
  shift: number;
  fate: Fate;
  closedAt: number | null;
  erasedAt: number | null;
  sessions: Session[];
};
export type ModelOptions = {accounts: number; days: number; seed: string; now: number};

/** The launch day and a press mention, as fractions of the window. */
export const SPIKES = {launch: 0.42, press: 0.78} as const;
const SIGNUP_WEEKDAY = [1.12, 1.15, 1.12, 1.08, 0.95, 0.72, 0.78];
const SIGNUP_HOURS = [
  0.5, 0.3, 0.2, 0.1, 0.1, 0.2, 0.5, 1, 2, 3.5, 5, 6, 6.5, 6, 6, 6, 5.5, 5, 4.5, 4.5, 5, 4.5, 3, 1.5,
];
/** Moscow hours of a working day and of a weekend, as weights. */
const WEEKDAY_HOURS = [
  0.6, 0.3, 0.15, 0.1, 0.1, 0.15, 0.4, 1, 2.2, 4, 6, 7, 7.2, 6.6, 7, 7.2, 6.8, 6, 4.8, 4, 4.2, 4, 3, 1.6,
];
const WEEKEND_HOURS = [
  1, 0.6, 0.3, 0.15, 0.1, 0.1, 0.2, 0.4, 0.9, 1.8, 3, 4, 4.6, 4.8, 4.8, 4.6, 4.4, 4.2, 4, 4.2, 4.6, 4.4, 3.4, 2,
];
/** How likely a person is to come on each weekday (Monday first), normalised so a week averages 1. */
const WEEKDAY_ACTIVITY = (() => {
  const raw = [1.12, 1.16, 1.16, 1.1, 0.95, 0.5, 0.55];
  const mean = raw.reduce((a, b) => a + b, 0) / raw.length;
  return raw.map(value => value / mean);
})();

const ENGAGEMENT: Record<
  Engagement,
  {dayChance: number; lifetimeDays: number; sessionMinutes: number; sessionsPerDay: readonly number[]}
> = {
  bounce: {dayChance: 0, lifetimeDays: 0, sessionMinutes: 7, sessionsPerDay: [1]},
  casual: {dayChance: 0.16, lifetimeDays: 28, sessionMinutes: 13, sessionsPerDay: [0.85, 0.15]},
  regular: {dayChance: 0.45, lifetimeDays: 75, sessionMinutes: 24, sessionsPerDay: [0.65, 0.28, 0.07]},
  power: {dayChance: 0.8, lifetimeDays: 210, sessionMinutes: 38, sessionsPerDay: [0.45, 0.4, 0.15]},
};

/** The window's first and last Moscow day numbers. */
export function windowDays(options: ModelOptions): {first: number; last: number} {
  const last = moscowDay(options.now);
  return {first: last - options.days + 1, last};
}

function signupDayWeights(rng: Random, options: ModelOptions): number[] {
  const {first} = windowDays(options),
    days = options.days;
  const launch = Math.round(days * SPIKES.launch),
    press = Math.round(days * SPIKES.press);
  const spike: Record<number, number> = {
    [launch]: 7,
    [launch + 1]: 3,
    [launch + 2]: 1.8,
    [launch + 3]: 1.3,
    [press]: 3.2,
    [press + 1]: 1.6,
  };
  const weights: number[] = [];
  for (let d = 0; d < days; d++) {
    const growth = Math.exp((1.25 * d) / Math.max(1, days - 1));
    weights.push(growth * SIGNUP_WEEKDAY[moscowWeekday(first + d)] * rng.logNormal(1, 0.2) * (spike[d] ?? 1));
  }
  // Today has only begun.
  const today = (options.now - moscowDayStart(first + days - 1)) / DAY;
  weights[days - 1] *= Math.max(0.05, today);
  return weights;
}

function signupTime(rng: Random, day: number, now: number): number {
  const start = moscowDayStart(day);
  const t = start + rng.index(SIGNUP_HOURS) * HOUR + rng.uniform(0, HOUR);
  return t < now ? t : start + rng.uniform(0, Math.max(MINUTE, now - start - MINUTE));
}

/** The accounts, oldest first, with their engagement, lifetime and fate (sessions come later). */
export function createAccounts(rng: Random, options: ModelOptions): Account[] {
  const {first} = windowDays(options);
  const weights = signupDayWeights(rng.fork('days'), options);
  const launch = Math.round(options.days * SPIKES.launch);
  const times: number[] = [];
  for (let i = 0; i < options.accounts; i++) {
    const offset = rng.index(weights);
    times.push(signupTime(rng, first + offset, options.now));
  }
  times.sort((a, b) => a - b);
  const taken = new Set<string>();
  return times.map((signupAt, index) => {
    const who = person(rng, taken);
    const offset = moscowDay(signupAt) - first;
    // Launch-day visitors are more often tourists.
    const tourists = offset >= launch && offset <= launch + 3;
    const engagement = rng.weighted<Engagement>(
      tourists
        ? [
            ['bounce', 0.58],
            ['casual', 0.27],
            ['regular', 0.11],
            ['power', 0.04],
          ]
        : [
            ['bounce', 0.45],
            ['casual', 0.3],
            ['regular', 0.18],
            ['power', 0.07],
          ],
    );
    const baseLife = engagement === 'bounce' ? 0 : rng.exponential(ENGAGEMENT[engagement].lifetimeDays * DAY);
    const activeUntil = signupAt + baseLife;
    return {
      index,
      id: rng.uuid(),
      name: who.name,
      firstName: who.firstName,
      email: who.email,
      emailVerified: rng.chance(0.82),
      signupAt,
      engagement,
      activeUntil,
      shift: rng.weighted<number>([
        [0, 0.7],
        [2, 0.15],
        [3, 0.05],
        [-1, 0.1],
      ]),
      fate: 'live',
      closedAt: null,
      erasedAt: null,
      sessions: [],
    };
  });
}

/** Marks a handful of accounts as closing (asked to close in the last hours) and a couple as erased long ago. */
export function assignFates(rng: Random, accounts: Account[], options: ModelOptions): void {
  const now = options.now;
  const closingCount = Math.max(2, Math.round(accounts.length * 0.009));
  const erasedCount = Math.max(1, Math.round(accounts.length * 0.0035));
  const closable = accounts.filter(
    a =>
      a.engagement !== 'bounce' &&
      a.engagement !== 'power' &&
      a.signupAt < now - 10 * DAY &&
      a.activeUntil > now - 20 * DAY,
  );
  const closing = rng.sample(closable, closingCount);
  for (const account of closing) {
    account.fate = 'closing';
    account.closedAt = now - rng.uniform(10 * MINUTE, 6 * HOUR);
  }
  const erasable = accounts.filter(a => a.fate === 'live' && a.signupAt < now - 70 * DAY && a.engagement !== 'bounce');
  const erased = rng.sample(erasable, erasedCount);
  for (const account of erased) {
    account.fate = 'erased';
    account.closedAt = Math.max(account.signupAt + 30 * DAY, now - rng.uniform(15, 60) * DAY);
    account.erasedAt = account.closedAt + rng.uniform(20, 70) * MINUTE;
  }
}

/** The account's activity ends here: its lifetime, its closure, or now. */
export const stopAt = (account: Account, now: number): number =>
  Math.min(account.activeUntil, account.closedAt ?? Infinity, now - MINUTE);

function sessionStart(rng: Random, account: Account, day: number): number {
  const weekend = moscowWeekday(day) >= 5;
  const hour = (rng.index(weekend ? WEEKEND_HOURS : WEEKDAY_HOURS) + account.shift + 24) % 24;
  return moscowDayStart(day) + hour * HOUR + rng.uniform(0, HOUR);
}

/** The account's sessions, oldest first: the signup session, then the days it comes back on, until it stops. */
export function buildSessions(rng: Random, account: Account, options: ModelOptions): void {
  const profile = ENGAGEMENT[account.engagement];
  // A tourist's lifetime is its visits: it is set from the sessions below.
  const stop =
    account.engagement === 'bounce'
      ? Math.min(account.closedAt ?? Infinity, options.now - MINUTE)
      : stopAt(account, options.now);
  const minutes = (scale = 1) => Math.min(240, Math.max(2, rng.logNormal(profile.sessionMinutes * scale, 0.75)));
  const sessions: Session[] = [];
  const push = (start: number, length: number) => {
    const previous = sessions[sessions.length - 1];
    if (previous && start < previous.end + 15 * MINUTE) start = previous.end + rng.uniform(15, 60) * MINUTE;
    if (start >= stop) return;
    sessions.push({start, end: Math.min(start + length * MINUTE, stop)});
  };
  push(account.signupAt, minutes(1.3));
  const firstDay = moscowDay(account.signupAt);
  if (account.engagement === 'bounce') {
    // Most tourists never return; a few look once more within the week.
    if (rng.chance(0.13)) {
      const day = firstDay + rng.int(1, 6);
      push(sessionStart(rng, account, day), minutes());
      account.activeUntil = Math.max(account.activeUntil, sessions[sessions.length - 1]?.end ?? 0);
    } else account.activeUntil = sessions[0]?.end ?? account.signupAt;
    account.sessions = sessions;
    return;
  }
  for (let day = firstDay + 1; moscowDayStart(day) < stop; day++) {
    const age = (moscowDayStart(day) - account.signupAt) / DAY;
    // Interest fades a little even before the person stops coming at all.
    const fade = account.engagement === 'power' ? 1 : 0.55 + 0.45 * Math.exp(-age / 45);
    if (!rng.chance(Math.min(0.97, profile.dayChance * WEEKDAY_ACTIVITY[moscowWeekday(day)] * fade))) continue;
    const count = 1 + rng.index(profile.sessionsPerDay);
    const starts = Array.from({length: count}, () => sessionStart(rng, account, day)).sort((a, b) => a - b);
    for (const start of starts) push(start, minutes());
  }
  account.sessions = sessions;
}

/** The first session that ends after `t`, and a moment in it no earlier than `t`; null when the person never comes again. */
export function momentAfter(rng: Random, account: Account, t: number, spread = 0.6): number | null {
  const sessions = account.sessions;
  let lo = 0,
    hi = sessions.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sessions[mid].end <= t) lo = mid + 1;
    else hi = mid;
  }
  const session = sessions[lo];
  if (!session) return null;
  const from = Math.max(t, session.start);
  return from + (session.end - from) * rng.uniform(0, spread);
}

/** The session that holds `t`, if any. */
export function sessionAt(account: Account, t: number): Session | null {
  for (const session of account.sessions) if (session.start <= t && t <= session.end) return session;
  return null;
}
