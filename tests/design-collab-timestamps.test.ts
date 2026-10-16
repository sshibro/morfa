import test from 'node:test';
import assert from 'node:assert/strict';
import {parseUtcTimestamp} from '../server/postgresql/codecs';

// server/postgresql/codecs.ts `parseUtcTimestamp` took a fast path for what PostgreSQL writes in a UTC session (lane B6, TARGETS A1:
// the general parser was a third of the file list's CPU). The answers must be exactly the general parser's, which is copied here
// as it was, for every shape the database writes and the malformed ones around it. (Named design-* so the gate's unit run takes it.)

function generalParser(value: string): string {
  const fail = () => {
    throw Error('invalid');
  };
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value);
  if (!m) return fail();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(m[1])) return fail();
  const day = new Date(m[1] + 'T00:00:00.000Z');
  if (!Number.isFinite(day.getTime()) || day.toISOString().slice(0, 10) !== m[1]) return fail();
  const [hour, minute, second] = m[2].split(':').map(Number);
  if (hour > 23 || minute > 59 || second > 59) return fail();
  let offset = m[4] || 'Z';
  if (/^[+-]\d{2}$/.test(offset)) offset += ':00';
  else if (/^[+-]\d{4}$/.test(offset)) offset = offset.slice(0, 3) + ':' + offset.slice(3);
  const date = new Date(m[1] + 'T' + m[2] + offset);
  if (!Number.isFinite(date.getTime())) return fail();
  return date.toISOString().slice(0, 19) + '.' + (m[3] || '').padEnd(3, '0') + 'Z';
}

const outcome = (parse: (value: string) => string, value: string) => {
  try {
    return parse(value);
  } catch {
    return 'refused';
  }
};

test('the fast UTC path answers exactly what the general parser answers', () => {
  let state = 7;
  const random = (n: number) => ((state = (state * 1103515245 + 12345) % 2 ** 31) % n);
  const pad = (n: number, width: number) => String(n).padStart(width, '0');
  const samples = [
    '2026-10-08 05:44:51.317+00', '2026-10-08 05:44:51+00', '2026-10-08 05:44:51.123456+00', '2024-02-29 23:59:59.9+00',
    '2023-02-29 10:00:00+00', '2026-13-01 00:00:00+00', '2026-04-31 00:00:00+00', '2026-01-01 24:00:00+00', '2026-01-01 00:60:00+00',
    '2026-01-01 00:00:60+00', '2026-01-01 00:00:00.1234567+00', '2026-01-01 00:00:00.+00', '2026-01-01T00:00:00+00', '2026-01-01 00:00:00+03',
    '2026-01-01 00:00:00+05:30', '2026-01-01 00:00:00Z', '0001-01-01 00:00:00+00', '1900-02-29 00:00:00+00', '2000-02-29 00:00:00+00',
    '2026-1-01 00:00:00+00', '2026-01-01 00:00:0a+00', '', 'garbage', '2026-01-01 00:00:00-00',
  ];
  for (let i = 0; i < 20_000; i++) {
    const fraction = random(3) ? '' : '.' + pad(random(1_000_000), 6).slice(0, 1 + random(6));
    const offset = random(10) ? '+00' : ['+03', '-07', 'Z', '+05:30', ''][random(5)];
    samples.push(`${pad(1 + random(2999), 4)}-${pad(random(14), 2)}-${pad(random(33), 2)} ${pad(random(26), 2)}:${pad(random(62), 2)}:${pad(random(62), 2)}${fraction}${offset}`);
  }
  for (const value of samples) assert.equal(outcome(parseUtcTimestamp, value), outcome(generalParser, value), value);
});
