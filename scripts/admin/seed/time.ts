// Instants of the demo history: epoch milliseconds in the model, the text shapes each table stores on the way out. Moscow is UTC+3 all
// year (shared/moscow-calendar.ts); the console counts days, weekdays and hours in Moscow time, and so does the model.
import {MOSCOW_OFFSET_MS} from '../../../shared/moscow-calendar';

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** The Moscow calendar day of an instant, as a day number (days since 1970-01-01 in Moscow). */
export const moscowDay = (t: number): number => Math.floor((t + MOSCOW_OFFSET_MS) / DAY);
/** The instant a Moscow day number begins. */
export const moscowDayStart = (day: number): number => day * DAY - MOSCOW_OFFSET_MS;
/** 0 Monday … 6 Sunday (1970-01-01 was a Thursday). */
export const moscowWeekday = (day: number): number => (day + 3) % 7;
export const moscowHour = (t: number): number => Math.floor(((((t + MOSCOW_OFFSET_MS) % DAY) + DAY) % DAY) / HOUR);

/** ISO with milliseconds, what the server's `new Date().toISOString()` writes (the activity journal). */
export const iso = (t: number): string => new Date(t).toISOString();
/** 'YYYY-MM-DD HH:MM:SS' UTC: users, sessions and the erasure ledger (server/launch/lifecycle.ts `accountTimestamp`). */
export const textTime = (t: number): string => iso(t).replace('T', ' ').slice(0, 19);
