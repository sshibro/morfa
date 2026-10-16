/* Paid periods and grants run on the Moscow calendar: a month bought at 01:30 on 1 March lasts until
 * 01:30 on 1 April. Moscow has kept UTC+3 all year since 2014, with no daylight saving, so its wall
 * clock is UTC moved three hours on. */
export const MOSCOW_OFFSET_MS = 3 * 60 * 60 * 1000;

/** The Moscow day of the month an instant falls on. */
export const moscowDayOfMonth = (instant: number) => new Date(instant + MOSCOW_OFFSET_MS).getUTCDate();

/**
 * The instant `months` Moscow calendar months after `start`, at the same Moscow time of day, on
 * `anchorDay` (the start's own day unless given), or on the month's last day when it is shorter.
 */
export function moscowMonthsLater(start: number, months: number, anchorDay = moscowDayOfMonth(start)): number {
  const wall = new Date(start + MOSCOW_OFFSET_MS);
  const year = wall.getUTCFullYear(),
    month = wall.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const target = Date.UTC(
    year,
    month,
    Math.min(anchorDay, lastDay),
    wall.getUTCHours(),
    wall.getUTCMinutes(),
    wall.getUTCSeconds(),
    wall.getUTCMilliseconds(),
  );
  return target - MOSCOW_OFFSET_MS;
}
