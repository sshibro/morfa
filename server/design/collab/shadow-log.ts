import {createHash} from 'node:crypto';
import {appendFile, mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {DesignDocument} from '../../../shared/design/types';
import {shadowLogPath} from './config';

// The shadow comparison's oracle and its log (docs/BACKEND.md §7 step 2). Node's document after each forwarded op is hashed as
// collab hashes its copy (crates/protocol/schema.json `x-documentHash`: SHA-256 of the JSON with every object's keys sorted by
// UTF-16 code units, no whitespace, numbers as String(n), strings as JSON.stringify writes them). A difference is one JSON line
// of DESIGN_COLLAB_SHADOW_LOG and, when the ops since the copy was seeded are still held, a replayable case beside it
// (`cases/<file>-<version>.json`); scripts/collab-shadow-report.ts reads both and finds the first differing path.

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter(key => record[key] !== undefined)
      .sort()
      .map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

export const documentHash = (doc: DesignDocument) => createHash('sha256').update(canonicalJson(doc)).digest('hex');

/** The first path where two JSON values differ (`nodes.r1.x`), or null when they are equal. Objects compare by key, in sorted
 *  order; arrays by index. */
export function firstDifference(a: unknown, b: unknown, at = ''): string | null {
  if (a === b) return null;
  const objects = a !== null && b !== null && typeof a === 'object' && typeof b === 'object';
  if (!objects || Array.isArray(a) !== Array.isArray(b)) return at || '(root)';
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      const found = i < a.length && i < b.length ? firstDifference(a[i], b[i], `${at}[${i}]`) : `${at}[${i}]`;
      if (found) return found;
    }
    return null;
  }
  const x = a as Record<string, unknown>,
    y = b as Record<string, unknown>;
  const keys = [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(key => x[key] !== undefined || y[key] !== undefined).sort();
  for (const key of keys) {
    const found = firstDifference(x[key], y[key], at ? `${at}.${key}` : key);
    if (found) return found;
  }
  return null;
}

export type MismatchKind = 'hash' | 'refusal' | 'version' | 'diverged' | 'error';

export type MismatchEntry = {
  at: string;
  kind: MismatchKind;
  file: string;
  /** The version Node stored (or kept, for an op that changed nothing). */
  version: number;
  /** The version the op applied on at Node, and the one it was made on. */
  appliedOn: number;
  baseVersion: number;
  nodeHash?: string | null;
  collabHash?: string | null;
  collabVersion?: number | null;
  refused?: unknown;
  message?: string;
  /** The first path where collab's copy itself differs from Node's document (`kind: hash`, read from GET /internal/shadow-doc;
   *  the report's `path` is the case replayed). */
  collabPath?: string;
  /** The case file, relative to the log's directory. */
  case?: string | null;
};

export type ShadowCase = {
  file: string;
  /** The document collab's copy was seeded with, at `seedVersion`. */
  seedVersion: number;
  seed: DesignDocument;
  /** The bodies sent to /internal/shadow-op since the seed (the seed's own op first), without the seed document. */
  ops: Record<string, unknown>[];
  /** Node's document after the last of them. */
  node: DesignDocument;
};

let writing: Promise<unknown> = Promise.resolve();

/** Appends one mismatch (and its case) to the log; the writes of one process go one after another. */
export function logMismatch(entry: Omit<MismatchEntry, 'at' | 'case'>, shadowCase: ShadowCase | null): Promise<void> {
  const log = shadowLogPath(),
    dir = path.dirname(log);
  const caseName = shadowCase ? `cases/${entry.file}-${entry.version}-${entry.kind}.json` : null;
  const line: MismatchEntry = {at: new Date().toISOString(), ...entry, case: caseName};
  const run = writing.then(async () => {
    await mkdir(path.join(dir, 'cases'), {recursive: true});
    if (caseName && shadowCase) await writeFile(path.join(dir, caseName), JSON.stringify(shadowCase));
    await appendFile(log, JSON.stringify(line) + '\n');
  });
  writing = run.catch(error => console.error('collab shadow log:', (error as Error).message));
  return writing.then(() => undefined);
}
