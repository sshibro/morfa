import {types, type CustomTypesConfig} from 'pg';
import {parse as parseArray} from 'postgres-array';
import {DatabaseError} from './errors';

const invalid = (kind: string): never => {
  throw new DatabaseError('database_codec', `The database ${kind} cannot be represented safely.`);
};

export function parseSafeInteger(value: string): number {
  if (!/^-?\d+$/.test(value)) return invalid('integer');
  const result = Number(value);
  if (!Number.isSafeInteger(result)) return invalid('integer');
  return result;
}

function decimalKey(value: string): string {
  const m = /^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(value);
  if (!m) return invalid('numeric value');
  let digits = (m[2] + (m[3] || '')).replace(/^0+/, '');
  if (!digits) return '0';
  let exponent = Number(m[4] || 0) - (m[3]?.length || 0);
  if (!Number.isSafeInteger(exponent)) return invalid('numeric value');
  const trailing = /0+$/.exec(digits)?.[0].length || 0;
  digits = digits.slice(0, digits.length - trailing);
  exponent += trailing;
  return (m[1] === '-' ? '-' : '') + digits + 'e' + exponent;
}

/** Deliberate numeric conversion: reject decimal precision loss rather than silently round. */
export function parseSafeNumeric(value: string): number {
  const result = Number(value);
  if (
    !Number.isFinite(result) ||
    (Number.isInteger(result) && !Number.isSafeInteger(result)) ||
    decimalKey(value) !== decimalKey(String(result))
  )
    return invalid('numeric value');
  return result;
}

export function parseUtcDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return invalid('date');
  const date = new Date(value + 'T00:00:00.000Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) return invalid('date');
  return value;
}

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const digitsAt = (value: string, from: number, count: number): number => {
  let n = 0;
  for (let i = from; i < from + count; i++) {
    const code = value.charCodeAt(i) - 48;
    if (code < 0 || code > 9) return -1;
    n = n * 10 + code;
  }
  return n;
};

/**
 * The common case of `parseUtcTimestamp` without a regular expression or a Date: what PostgreSQL writes for timestamptz in the
 * pools' UTC session (connection-options.ts `timezone=UTC`, `datestyle=ISO`) — `YYYY-MM-DD HH:MM:SS[.f{1,6}]+00` — checked field by
 * field (a real calendar day, hours, minutes and seconds in range). Null for anything else, which the general parser takes.
 * Lane B6 measured the general parser at a third of the file list's CPU (TARGETS A1: four timestamps × 200 rows per request).
 */
function fastUtcTimestamp(value: string): string | null {
  const length = value.length;
  if (length < 22 || value.charCodeAt(length - 3) !== 43 || value.charCodeAt(length - 2) !== 48 || value.charCodeAt(length - 1) !== 48) return null;
  if (value[4] !== '-' || value[7] !== '-' || value[10] !== ' ' || value[13] !== ':' || value[16] !== ':') return null;
  const year = digitsAt(value, 0, 4), month = digitsAt(value, 5, 2), day = digitsAt(value, 8, 2);
  const hour = digitsAt(value, 11, 2), minute = digitsAt(value, 14, 2), second = digitsAt(value, 17, 2);
  if (year < 1 || month < 1 || month > 12 || day < 1 || hour < 0 || hour > 23 || minute < 0 || minute > 59 || second < 0 || second > 59) return null;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (day > (month === 2 && leap ? 29 : DAYS_IN_MONTH[month - 1])) return null;
  let fraction = '';
  if (length > 22) {
    if (value[19] !== '.' || length - 23 < 1 || length - 23 > 6) return null;
    fraction = value.slice(20, length - 3);
    if (digitsAt(fraction, 0, fraction.length) < 0) return null;
  }
  return value.slice(0, 10) + 'T' + value.slice(11, 19) + '.' + fraction.padEnd(3, '0') + 'Z';
}

/** Preserve PostgreSQL microseconds while exposing one UTC ISO string contract. */
export function parseUtcTimestamp(value: string): string {
  const fast = fastUtcTimestamp(value);
  if (fast !== null) return fast;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?$/.exec(value);
  if (!m) return invalid('timestamp');
  parseUtcDate(m[1]);
  const [hour, minute, second] = m[2].split(':').map(Number);
  if (hour > 23 || minute > 59 || second > 59) return invalid('timestamp');
  let offset = m[4] || 'Z';
  if (/^[+-]\d{2}$/.test(offset)) offset += ':00';
  else if (/^[+-]\d{4}$/.test(offset)) offset = offset.slice(0, 3) + ':' + offset.slice(3);
  const date = new Date(m[1] + 'T' + m[2] + offset);
  if (!Number.isFinite(date.getTime())) return invalid('timestamp');
  return date.toISOString().slice(0, 19) + '.' + (m[3] || '').padEnd(3, '0') + 'Z';
}

/** Per-pool parsers; never change pg's process-global registry used by unrelated tools. */
export const databaseTypes = {
  getTypeParser(oid: number, format?: 'text' | 'binary') {
    if (format === 'binary') return types.getTypeParser(oid, format);
    if (oid === 20) return parseSafeInteger; // int8, COUNT and insertion order
    if (oid === 1700) return parseSafeNumeric;
    if (oid === 1082) return parseUtcDate;
    if (oid === 1114 || oid === 1184) return parseUtcTimestamp;
    if (oid === 1016) return (value: string) => parseArray(value, parseSafeInteger);
    if (oid === 1231) return (value: string) => parseArray(value, parseSafeNumeric);
    if (oid === 1182) return (value: string) => parseArray(value, parseUtcDate);
    if (oid === 1115 || oid === 1185) return (value: string) => parseArray(value, parseUtcTimestamp);
    return types.getTypeParser(oid, 'text');
  },
} satisfies CustomTypesConfig;
