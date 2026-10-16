// The Rust model against the TypeScript one, driven from Node through the
// `morfa-model` CLI (crates/model/src/bin/morfa-model.rs):
//
//   1. round trip   every fixture: Rust from_json → to_json equals JSON.parse of the original (deep, key order free);
//                   and through the store and its binary codec (from_json → store → binary → store → model → to_json)
//   2. parity       every fixture, then ≥10 000 seeded mutants (scripts/model/mutate.ts) and documents at the caps:
//                   Rust's verdict equals `validateDocument`'s, and on a double accept Rust's value equals zod's stripped one
//                   and survives the store + binary codec unchanged (`check --store`; --no-store skips that)
//   3. patches      ≥2 000 mutated DocumentPatches against `validatePatch`, the same comparisons
//   4. js-number    ≥100 000 doubles (seeded, every exponent, subnormals, integers, edges) against String(n)
//   5. bench        parse / validate / serialize of the 16 MB page and the product file, release build
//
//   npx tsx scripts/model/check.ts --all                     everything (the default when no part is named)
//   npx tsx scripts/model/check.ts --parity --count 2000     some parts; --seed S, --patch-count N, --numbers N,
//                                                            --iterations N (bench), --no-build, --js-only (no Rust)
//
// Disagreements are printed and written to fixtures/parity-disagreements.jsonl (each mutant's text beside it in
// fixtures/tmp/). Exit 1 on any failure. CARGO_TARGET_DIR defaults to ~/.cache/morfa-target/S1-h.

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {designDocumentSchema, documentPatchSchema, validateDocument, validatePatch} from '../../shared/design/schema';
import type {DesignDocument} from '../../shared/design/types';
import {ensureFixtures, FIXTURES_DIR, type FixtureEntry} from '../fixtures/design-documents';
import {documentMutants, patchMutants, specialDocuments, specialPatches, Rng, type Base, type Mutant} from './mutate';
import * as W from './schema-walk';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TMP = path.join(repo, 'fixtures', 'tmp');
const DISAGREEMENTS = path.join(repo, 'fixtures', 'parity-disagreements.jsonl');

// ── Arguments ────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes('--' + name);
const option = (name: string, fallback: number) => {
  const at = argv.indexOf('--' + name);
  if (at < 0) return fallback;
  const value = Number(argv[at + 1]);
  if (!Number.isFinite(value)) throw Error(`--${name} needs a number`);
  return value;
};
const PARTS = ['roundtrip', 'parity', 'patches', 'js-number', 'bench'] as const;
const known = new Set([...PARTS, 'all', 'count', 'patch-count', 'numbers', 'seed', 'iterations', 'no-build', 'js-only', 'no-store', 'help']);
for (const arg of argv) if (arg.startsWith('--') && !known.has(arg.slice(2))) throw Error(`unknown flag ${arg} (see the header of scripts/model/check.ts)`);
if (flag('help')) {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').filter(line => line.startsWith('//')).join('\n'));
  process.exit(0);
}
const selected = new Set<string>(flag('all') || !PARTS.some(flag) ? PARTS : PARTS.filter(flag));
const COUNT = option('count', 10_000);
const PATCH_COUNT = option('patch-count', 2_000);
const NUMBERS = option('numbers', 100_000);
const SEED = option('seed', 1);
const ITERATIONS = option('iterations', 10);
const JS_ONLY = flag('js-only');
const STORE = !flag('no-store') && !JS_ONLY;

const TARGET = process.env.CARGO_TARGET_DIR || path.join(os.homedir(), '.cache', 'morfa-target', 'S1-h');
const BIN = path.join(TARGET, 'release', 'morfa-model');

// ── Output ───────────────────────────────────────────────────────────────────────────────────────

type Row = {part: string; result: string; ok: boolean};
const summary: Row[] = [];
const log = (line = '') => console.log(line);
const ms = (value: number) => (value >= 100 ? value.toFixed(0) : value.toFixed(1)) + ' ms';
const kb = (bytes: number) => (bytes >= 1e6 ? (bytes / 1e6).toFixed(1) + ' MB' : (bytes / 1e3).toFixed(1) + ' KB');
const table = (header: string[], rows: string[][], right = new Set<number>()) => {
  const widths = header.map((cell, i) => Math.max(cell.length, ...rows.map(row => (row[i] ?? '').length)));
  const line = (row: string[]) => '  ' + row.map((cell, i) => (right.has(i) ? cell.padStart(widths[i]) : cell.padEnd(widths[i]))).join('  ').trimEnd();
  log(line(header));
  log('  ' + widths.map(width => '─'.repeat(width)).join('  '));
  for (const row of rows) log(line(row));
};

// ── The CLI ──────────────────────────────────────────────────────────────────────────────────────

function build(): boolean {
  if (flag('no-build') || JS_ONLY) return fs.existsSync(BIN) || JS_ONLY;
  log(`cargo build --release -p morfa-model --bin morfa-model  (CARGO_TARGET_DIR=${TARGET})`);
  const started = performance.now();
  const result = spawnSync('cargo', ['build', '--release', '-p', 'morfa-model', '--bin', 'morfa-model'], {
    cwd: repo, encoding: 'utf8', env: {...process.env, CARGO_TARGET_DIR: TARGET, CARGO_BUILD_JOBS: process.env.CARGO_BUILD_JOBS || '2'},
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(0);
  if (result.status !== 0) {
    log((result.stderr || '').split('\n').filter(line => /^(error|warning: unused)|-->/.test(line) || line.startsWith('  ')).slice(0, 60).join('\n'));
    summary.push({part: 'build', result: `cargo build failed (${seconds} s); see above`, ok: false});
    return false;
  }
  summary.push({part: 'build', result: `release build in ${seconds} s`, ok: true});
  return true;
}

type Run = {status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; ms: number};
function cli(args: string[]): Run {
  const started = performance.now();
  const result = spawnSync(BIN, args, {encoding: 'utf8', maxBuffer: 1 << 30});
  if (result.error) throw result.error;
  return {status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr, ms: performance.now() - started};
}

/** `store`: what `check --store` said of an accepted document (it came back from store + binary with the same JSON, or not). */
type StoreVerdict = {same: boolean; value?: unknown; error?: string};
type RustVerdict = {ok: true; value?: unknown; raw: string; store?: StoreVerdict} | {ok: false; error: string; path: string} | {crash: string};
/** Runs `check` over the lines; a crash is pinned on its line by running the rest one by one. */
function rustCheck(lines: string[], patch: boolean): RustVerdict[] {
  fs.mkdirSync(TMP, {recursive: true});
  const out: RustVerdict[] = [];
  const run = (batch: string[]): {verdicts: RustVerdict[]; complete: boolean; why: string} => {
    const file = path.join(TMP, `batch-${process.pid}.jsonl`);
    fs.writeFileSync(file, batch.join('\n') + '\n');
    const result = cli([patch ? 'check-patch' : 'check', ...(STORE && !patch ? ['--store'] : []), file]);
    const answered = result.stdout.split('\n').filter(Boolean);
    const verdicts = answered.slice(0, batch.length).map((line): RustVerdict => {
      const parsed = JSON.parse(line) as {ok: boolean; value?: unknown; error?: string; path?: string; store?: boolean; storeValue?: unknown; storeError?: string};
      if (!parsed.ok) return {ok: false, error: parsed.error ?? '', path: parsed.path ?? ''};
      const store = parsed.store === undefined ? undefined : {same: parsed.store, value: parsed.storeValue, error: parsed.storeError};
      return {ok: true, value: parsed.value, raw: line, ...(store ? {store} : {})};
    });
    const complete = result.status === 0 && verdicts.length === batch.length;
    return {verdicts, complete, why: `exit ${result.status ?? result.signal}: ${result.stderr.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`};
  };
  const first = run(lines);
  out.push(...first.verdicts);
  if (first.complete) return out;
  // Pin the crash: the first unanswered line alone, then the rest.
  for (let i = out.length; i < lines.length; i++) {
    const single = run([lines[i]]);
    out.push(single.complete ? single.verdicts[0] : {crash: single.why});
  }
  return out;
}

// ── Comparing ────────────────────────────────────────────────────────────────────────────────────

type JsVerdict = {ok: true; value: unknown} | {ok: false; error: string; path: string} | {threw: string};
function jsVerdict(text: string, patch: boolean): JsVerdict {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {ok: false, error: 'JSON.parse: ' + (error as Error).message, path: ''};
  }
  try {
    const result = patch ? validatePatch(parsed) : validateDocument(parsed);
    return result.ok ? {ok: true, value: result.value} : {ok: false, error: result.error, path: result.path};
  } catch (error) {
    return {threw: String((error as Error).stack ?? error).split('\n').slice(0, 3).join(' | ')};
  }
}

/** The first place two JSON values differ, or null. */
function firstDifference(a: unknown, b: unknown, at = ''): {path: string; js: unknown; rust: unknown} | null {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return {path: at || '(root)', js: a, rust: b};
  if (Array.isArray(a) !== Array.isArray(b)) return {path: at || '(root)', js: a, rust: b};
  if (Array.isArray(a)) {
    const other = b as unknown[];
    if (a.length !== other.length) return {path: `${at}.length`, js: a.length, rust: other.length};
    for (let i = 0; i < a.length; i++) {
      const found = firstDifference(a[i], other[i], `${at}.${i}`);
      if (found) return found;
    }
    return null;
  }
  const left = a as Record<string, unknown>,
    right = b as Record<string, unknown>;
  for (const key of Object.keys(left)) {
    if (!Object.hasOwn(right, key)) return {path: `${at}.${key}`, js: left[key], rust: '(absent)'};
    const found = firstDifference(left[key], right[key], `${at}.${key}`);
    if (found) return found;
  }
  for (const key of Object.keys(right)) if (!Object.hasOwn(left, key)) return {path: `${at}.${key}`, js: '(absent)', rust: right[key]};
  return null;
}
/** A JSON value with every lone surrogate replaced by U+FFFD (keys included): what the Rust model reads them as (json.rs). */
// String.prototype.toWellFormed is ES2024 (Node 22 has it); the type programs use the ES2022 lib.
const toWellFormed = (text: string): string => (text as string & {toWellFormed(): string}).toWellFormed();
function wellFormed(value: unknown): unknown {
  if (typeof value === 'string') return toWellFormed(value);
  if (Array.isArray(value)) return value.map(wellFormed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [toWellFormed(key), wellFormed(item)]));
  return value;
}
const clip = (value: unknown, max = 160) => {
  const text = typeof value === 'string' ? JSON.stringify(value) : (JSON.stringify(value) ?? String(value));
  return text.length > max ? text.slice(0, max) + `…(${text.length} chars)` : text;
};
/** The part of a mutant a refusal path points at (zod paths: dot-joined segments; ids may hold dots, so walk greedily). */
function excerpt(text: string, at: string): string {
  if (!at) return clip(text, 300);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return clip(text, 300);
  }
  const parts = at.split('.');
  let shown = '';
  for (let i = 0; i < parts.length && value && typeof value === 'object'; i++) {
    let key = parts[i];
    // Ids may hold dots: take the longest run of parts that names a key.
    for (let j = parts.length; j > i + 1; j--) {
      const joined = parts.slice(i, j).join('.');
      if (Object.hasOwn(value as object, joined)) {
        key = joined;
        i = j - 1;
        break;
      }
    }
    if (!Object.hasOwn(value as object, key)) break;
    value = (value as Record<string, unknown>)[key];
    shown += (shown ? '.' : '') + key;
  }
  return `${shown || '(root)'} = ${clip(value, 300)}`;
}

/** The first record (a map of the schema: nodes, styles, valuesByMode...) whose keys come in another order on the Rust side
 *  (serde_json's preserve_order keeps the file's order; JSON.parse keeps a repeated key at its first place). */
function recordOrder(schema: W.Schema, js: unknown, rust: unknown, at = ''): string | null {
  const def = W.defOf(schema);
  switch (def.typeName) {
    case 'ZodOptional':
    case 'ZodNullable':
      return js === null || js === undefined ? null : recordOrder(def.innerType, js, rust, at);
    case 'ZodEffects':
      return recordOrder(def.schema, js, rust, at);
    case 'ZodObject':
      if (!W.isPlainObject(js) || !W.isPlainObject(rust)) return null;
      for (const [name, field] of Object.entries(W.objectShape(schema))) {
        const found = Object.hasOwn(js, name) ? recordOrder(field, js[name], rust[name], `${at}.${name}`) : null;
        if (found) return found;
      }
      return null;
    case 'ZodArray':
      if (!Array.isArray(js) || !Array.isArray(rust)) return null;
      for (let i = 0; i < js.length; i++) {
        const found = recordOrder(def.type, js[i], rust[i], `${at}.${i}`);
        if (found) return found;
      }
      return null;
    case 'ZodRecord': {
      if (!W.isPlainObject(js) || !W.isPlainObject(rust)) return null;
      const left = Object.keys(js),
        right = Object.keys(rust);
      if (left.join('\u0000') !== right.join('\u0000')) return `${at || '(root)'}: js [${left.slice(0, 4).join(', ')}…] / rust [${right.slice(0, 4).join(', ')}…]`;
      for (const key of left) {
        const found = recordOrder(def.valueType, js[key], rust[key], `${at}.${key}`);
        if (found) return found;
      }
      return null;
    }
    case 'ZodDiscriminatedUnion': {
      const option = W.duOption(schema, js);
      return option ? recordOrder(option, js, rust, at) : null;
    }
    case 'ZodUnion': {
      const index = W.unionOption(schema, js);
      return index >= 0 ? recordOrder((def.options as W.Schema[])[index], js, rust, at) : null;
    }
    default:
      return null;
  }
}

type Outcome = 'agree-accept' | 'agree-reject' | 'verdict' | 'value' | 'crash' | 'js-threw';
type Comparison = {outcome: Outcome; tolerated?: 'surrogate'; samePath?: boolean; diff?: {path: string; js: unknown; rust: unknown}; order?: string};
function compare(js: JsVerdict, rust: RustVerdict | undefined, patch = false): Comparison {
  if ('threw' in js) return {outcome: 'js-threw'};
  if (!rust) return {outcome: 'agree-accept'}; // --js-only
  if ('crash' in rust) return {outcome: 'crash'};
  if (js.ok !== rust.ok) return {outcome: 'verdict'};
  if (!js.ok) return {outcome: 'agree-reject', samePath: js.path === (rust as {path: string}).path};
  // JSON.stringify writes −0 as 0 and drops undefined: compare what each side would store.
  const left = JSON.parse(JSON.stringify(js.value));
  const right = (rust as {value?: unknown}).value;
  const diff = firstDifference(left, right);
  const order = () => recordOrder(patch ? documentPatchSchema : designDocumentSchema, left, right) ?? undefined;
  if (!diff) return {outcome: 'agree-accept', order: order()};
  if (!firstDifference(wellFormed(left), right)) return {outcome: 'agree-accept', tolerated: 'surrogate', order: order()};
  return {outcome: 'value', diff};
}

type Tally = {count: number; accepted: number; rejected: number; disagreements: number; samePath: number; bothRejected: number; tolerated: number; order: number; stored: number; storeChanged: number};
const tally = (): Tally => ({count: 0, accepted: 0, rejected: 0, disagreements: 0, samePath: 0, bothRejected: 0, tolerated: 0, order: 0, stored: 0, storeChanged: 0});
/** Record key orders that differ (a warning: the TypeScript never reads meaning into a map's order). */
const orderWarnings: string[] = [];
type Disagreement = Record<string, unknown>;

/** Runs mutants (or any labelled texts) through both sides in batches; tallies per kind; collects disagreements. */
function compareAll(
  suite: string, items: Iterable<Mutant>, patch: boolean, disagreements: Disagreement[], options: {batch?: number; progress?: boolean; onResult?: (js: JsVerdict, rust: RustVerdict | undefined) => void} = {},
): {byKind: Map<string, Tally>; total: Tally; bytes: number; ms: number} {
  const byKind = new Map<string, Tally>();
  const total = tally();
  const batchSize = options.batch ?? 250;
  let bytes = 0,
    done = 0;
  const started = performance.now();
  let batch: Mutant[] = [];
  const flush = () => {
    if (!batch.length) return;
    const texts = batch.map(mutant => mutant.text);
    const rust = JS_ONLY ? [] : rustCheck(texts, patch);
    batch.forEach((mutant, i) => {
      bytes += mutant.text.length;
      const js = jsVerdict(mutant.text, patch);
      const result = compare(js, rust[i], patch);
      if (result.order) orderWarnings.push(`${suite} #${mutant.id}: ${result.order}`);
      options.onResult?.(js, rust[i]);
      const accepted = 'ok' in js && js.ok;
      const r0 = rust[i];
      const store = r0 && 'ok' in r0 && r0.ok ? r0.store : undefined;
      const storeChanged = !!store && !store.same;
      const bad = result.outcome === 'verdict' || result.outcome === 'value' || result.outcome === 'crash' || result.outcome === 'js-threw' || storeChanged;
      for (const kind of [...new Set(mutant.kinds)].concat(['(all)'])) {
        const entry = kind === '(all)' ? total : byKind.get(kind) ?? byKind.set(kind, tally()).get(kind)!;
        entry.count++;
        if (accepted) entry.accepted++;
        else entry.rejected++;
        if (bad) entry.disagreements++;
        if (result.outcome === 'agree-reject') {
          entry.bothRejected++;
          if (result.samePath) entry.samePath++;
        }
        if (result.tolerated) entry.tolerated++;
        if (result.order) entry.order++;
        if (store) entry.stored++;
        if (storeChanged) entry.storeChanged++;
      }
      if (bad) {
        const file = path.join(TMP, `${suite}-${mutant.id}.json`);
        fs.mkdirSync(TMP, {recursive: true});
        fs.writeFileSync(file, mutant.text);
        const r = rust[i];
        const jsPath = 'path' in js ? js.path : '';
        const rustPath = r && 'path' in r ? r.path : '';
        const storeDiff = storeChanged && store!.value !== undefined ? firstDifference((r as {value?: unknown}).value, store!.value) : null;
        disagreements.push({
          suite, id: mutant.id, base: mutant.base, kinds: mutant.kinds, mutations: mutant.details, outcome: storeChanged && !(result.outcome === 'verdict' || result.outcome === 'value' || result.outcome === 'crash' || result.outcome === 'js-threw') ? 'store' : result.outcome,
          ...(storeChanged ? {store: store!.error ? {error: store!.error} : {differsAt: storeDiff?.path, model: clip(storeDiff?.js, 300), stored: clip(storeDiff?.rust, 300)}} : {}),
          js: 'threw' in js ? {threw: js.threw} : js.ok ? {ok: true} : {ok: false, error: js.error, path: js.path},
          rust: !r ? null : 'crash' in r ? {crash: r.crash} : r.ok ? {ok: true} : {ok: false, error: r.error, path: r.path},
          ...(result.diff ? {valueDiff: {path: result.diff.path, js: clip(result.diff.js, 400), rust: clip(result.diff.rust, 400)}} : {}),
          excerpt: mutant.marks.length
            ? mutant.marks.map(mark => `…${mutant.text.slice(Math.max(0, mark.offset - 140), mark.offset + Math.min(mark.length, 200) + 60)}…`).join(' ‖ ')
            : excerpt(mutant.text, jsPath || rustPath || mutant.paths[0] || (result.diff?.path.replace(/^\./, '') ?? '')),
          bytes: mutant.text.length, file: path.relative(repo, file),
        });
      }
    });
    done += batch.length;
    if (options.progress && done % 2000 < batchSize) process.stdout.write(`  … ${done} ${suite} compared (${((performance.now() - started) / 1000).toFixed(0)} s)\n`);
    batch = [];
  };
  for (const item of items) {
    batch.push(item);
    if (batch.length >= batchSize) flush();
  }
  flush();
  return {byKind, total, bytes, ms: performance.now() - started};
}

function printKinds(byKind: Map<string, Tally>, total: Tally) {
  const storeCell = (t: Tally) => (t.stored ? `${t.stored - t.storeChanged}/${t.stored}` : '–');
  const rows = [...byKind].sort(([a], [b]) => a.localeCompare(b)).map(([kind, t]) => [kind, String(t.count), String(t.accepted), String(t.rejected), String(t.disagreements), t.bothRejected ? `${t.samePath}/${t.bothRejected}` : '–', t.tolerated ? String(t.tolerated) : '', storeCell(t)]);
  rows.push(['(all mutants)', String(total.count), String(total.accepted), String(total.rejected), String(total.disagreements), total.bothRejected ? `${total.samePath}/${total.bothRejected}` : '–', total.tolerated ? String(total.tolerated) : '', storeCell(total)]);
  table(['mutation kind', 'count', 'accepted', 'rejected', 'disagree', 'same path', 'U+FFFD', 'store kept'], rows, new Set([1, 2, 3, 4, 5, 6, 7]));
}

function printDisagreements(list: Disagreement[], limit = 40) {
  for (const entry of list.slice(0, limit)) {
    log(`  ✗ ${entry.suite} #${entry.id} (${entry.base}) ${entry.outcome}: ${(entry.kinds as string[]).join(' + ')}`);
    for (const detail of entry.mutations as string[]) log(`      mutation: ${detail}`);
    log(`      js:   ${JSON.stringify(entry.js)}`);
    log(`      rust: ${JSON.stringify(entry.rust)}`);
    if (entry.store) log(`      store + binary changed it: ${JSON.stringify(entry.store)}`);
    if (entry.valueDiff) log(`      value differs at ${(entry.valueDiff as {path: string}).path}: js ${(entry.valueDiff as {js: string}).js} / rust ${(entry.valueDiff as {rust: string}).rust}`);
    log(`      excerpt: ${entry.excerpt}`);
    log(`      text: ${entry.file} (${kb(entry.bytes as number)})`);
  }
  if (list.length > limit) log(`  … and ${list.length - limit} more in ${path.relative(repo, DISAGREEMENTS)}`);
}

// ── The parts ────────────────────────────────────────────────────────────────────────────────────

const fixturePath = (entry: FixtureEntry) => path.join(FIXTURES_DIR, entry.file);

function roundTrip(fixtures: FixtureEntry[]) {
  log('\n── 1. Round trip: Rust from_json → to_json equals JSON.parse of the fixture ──');
  const rows: string[][] = [];
  let failed = 0;
  for (const entry of fixtures) {
    const original = fs.readFileSync(fixturePath(entry), 'utf8');
    const out = path.join(TMP, `roundtrip-${entry.name}.json`);
    fs.mkdirSync(TMP, {recursive: true});
    const run = cli(['roundtrip', fixturePath(entry), out]);
    let verdict = 'equal';
    let bytesOut = 0;
    if (run.status !== 0) {
      verdict = `refused: ${(run.stdout || run.stderr).trim().slice(0, 200)}`;
      failed++;
    } else {
      const text = fs.readFileSync(out, 'utf8');
      bytesOut = Buffer.byteLength(text);
      try {
        assert.deepStrictEqual(JSON.parse(text), JSON.parse(original));
      } catch {
        const diff = firstDifference(JSON.parse(original), JSON.parse(text));
        verdict = `DIFFERS at ${diff?.path}: js ${clip(diff?.js, 80)} / rust ${clip(diff?.rust, 80)}`;
        failed++;
      }
      if (verdict === 'equal') {
        const order = recordOrder(designDocumentSchema, JSON.parse(original), JSON.parse(text));
        if (order) {
          verdict += `; record order differs at ${order}`;
          orderWarnings.push(`round trip ${entry.name}: ${order}`);
        } else verdict += ', record order kept';
      }
      if (bytesOut === Buffer.byteLength(original) && text === original) verdict += ' (byte-identical)';
    }
    rows.push([entry.name, kb(entry.bytes), bytesOut ? kb(bytesOut) : '–', ms(run.ms), verdict]);
  }
  table(['fixture', 'in', 'out', 'process', 'result'], rows, new Set([1, 2, 3]));
  summary.push({part: 'round trip', result: `${fixtures.length - failed}/${fixtures.length} fixtures equal after Rust parse → serialize`, ok: !failed});
  if (STORE) storeRoundTrip(fixtures);
}

function storeRoundTrip(fixtures: FixtureEntry[]) {
  log('\n── 1b. Store round trip: from_json → store → binary → store → model → to_json equals JSON.parse of the fixture ──');
  const rows: string[][] = [];
  let failed = 0,
    json = 0,
    binary = 0;
  for (const entry of fixtures) {
    const original = fs.readFileSync(fixturePath(entry), 'utf8');
    const out = path.join(TMP, `store-${entry.name}.json`);
    const run = cli(['store-roundtrip', fixturePath(entry), out]);
    let verdict = 'equal';
    let stats: {binaryBytes?: number; sameJson?: boolean; ms?: Record<string, number>} = {};
    try {
      stats = JSON.parse(run.stdout.trim().split('\n').pop() ?? '{}');
    } catch {
      stats = {};
    }
    if (run.status !== 0) {
      verdict = `FAILED: ${(run.stdout || run.stderr).trim().slice(0, 200)}`;
      failed++;
    } else {
      const text = fs.readFileSync(out, 'utf8');
      const diff = firstDifference(JSON.parse(original), JSON.parse(text));
      if (diff) {
        verdict = `DIFFERS at ${diff.path}: json ${clip(diff.js, 80)} / store ${clip(diff.rust, 80)}`;
        failed++;
      } else {
        const order = recordOrder(designDocumentSchema, JSON.parse(original), JSON.parse(text));
        if (order) orderWarnings.push(`store round trip ${entry.name}: ${order}`);
        verdict += order ? `; record order differs at ${order}` : ', record order kept';
        if (stats.sameJson === false) verdict += ' (Rust JSON differs before/after the store)';
      }
      json += entry.bytes;
      binary += stats.binaryBytes ?? 0;
    }
    const t = stats.ms ?? {};
    rows.push([
      entry.name, kb(entry.bytes), stats.binaryBytes ? kb(stats.binaryBytes) : '–', stats.binaryBytes ? `${((100 * stats.binaryBytes) / entry.bytes).toFixed(0)}%` : '–',
      [t.fromModel, t.encode, t.decode, t.toModel].map(value => (value === undefined ? '–' : value.toFixed(1))).join(' / '), verdict,
    ]);
  }
  table(['fixture', 'JSON', 'binary', 'ratio', 'from_model / encode / decode / to_model ms', 'result'], rows, new Set([1, 2, 3]));
  summary.push({part: 'store round trip', result: `${fixtures.length - failed}/${fixtures.length} fixtures equal after store + binary; ${kb(binary)} binary for ${kb(json)} JSON (${((100 * binary) / Math.max(json, 1)).toFixed(0)}%)`, ok: !failed});
}

function parityFixtures(fixtures: FixtureEntry[], disagreements: Disagreement[]) {
  log('\n── 2a. Parity on the fixtures: verdict and stripped value ──');
  const rows: string[][] = [];
  let bad = 0;
  for (const entry of fixtures) {
    const text = fs.readFileSync(fixturePath(entry), 'utf8');
    const js = jsVerdict(text, false);
    const rust = JS_ONLY ? undefined : rustCheck([text], false)[0];
    const result = compare(js, rust);
    if (result.order) orderWarnings.push(`fixture ${entry.name}: ${result.order}`);
    const stored = rust && 'ok' in rust && rust.ok ? rust.store : undefined;
    const ok = (result.outcome === 'agree-accept' || result.outcome === 'agree-reject') && (!stored || stored.same);
    if (!ok) {
      bad++;
      disagreements.push({suite: 'fixtures', id: entry.name, base: entry.name, kinds: ['fixture'], mutations: [], outcome: result.outcome, js: 'threw' in js ? js : {ok: js.ok, ...(js.ok ? {} : {error: js.error, path: js.path})}, rust: rust && ('crash' in rust ? rust : {ok: rust.ok, ...(rust.ok ? {} : {error: rust.error, path: rust.path})}), ...(result.diff ? {valueDiff: {path: result.diff.path, js: clip(result.diff.js, 400), rust: clip(result.diff.rust, 400)}} : {}), excerpt: '', bytes: text.length, file: path.relative(repo, fixturePath(entry))});
    }
    const side = (v: JsVerdict | RustVerdict | undefined) => (!v ? '–' : 'threw' in v ? 'threw' : 'crash' in v ? 'crash' : v.ok ? 'accept' : `reject ${v.path}`);
    rows.push([
      entry.name, side(js), JS_ONLY ? '–' : side(rust) + (stored ? (stored.same ? ', store kept it' : ', STORE CHANGED IT') : ''),
      ok ? (result.tolerated ? 'agree (U+FFFD)' : 'agree') : `DISAGREE (${stored && !stored.same ? 'store' : result.outcome}${result.diff ? ' at ' + result.diff.path : ''})`,
    ]);
  }
  table(['fixture', 'validateDocument', 'Rust check', 'result'], rows);
  summary.push({part: 'parity: fixtures', result: `${fixtures.length - bad}/${fixtures.length} agree (verdict and value)`, ok: !bad});
}

async function loadBases(fixtures: FixtureEntry[]): Promise<Base[]> {
  return fixtures.filter(entry => entry.size !== 'heavy').map(entry => ({name: entry.name, doc: JSON.parse(fs.readFileSync(fixturePath(entry), 'utf8')) as DesignDocument}));
}

function fuzz(suite: 'documents' | 'patches', bases: Base[], count: number, disagreements: Disagreement[]) {
  const patch = suite === 'patches';
  log(`\n── ${patch ? '3' : '2b'}. Parity fuzz: ${count} ${patch ? 'DocumentPatch' : 'document'} mutants (seed ${SEED}) vs ${patch ? 'validatePatch' : 'validateDocument'} ──`);
  const before = disagreements.length;
  const generator = (patch ? patchMutants : documentMutants)(bases, {seed: patch ? SEED * 7919 + 1 : SEED, count});
  const {byKind, total, bytes, ms: took} = compareAll(suite, generator, patch, disagreements, {progress: true});
  printKinds(byKind, total);
  log(`  ${total.count} mutants, ${kb(bytes)} of JSON, ${(took / 1000).toFixed(1)} s; accepted ${total.accepted}, rejected ${total.rejected}${JS_ONLY ? ' (JS only)' : `; refusal paths agree on ${total.samePath} of ${total.bothRejected}`}`);
  const found = disagreements.slice(before);
  if (found.length) printDisagreements(found);
  if (STORE && !patch) summary.push({part: 'store: accepted mutants', result: `${total.stored - total.storeChanged}/${total.stored} accepted mutants come back from store + binary with the same JSON`, ok: !total.storeChanged});
  summary.push({part: `parity: ${suite} fuzz`, result: JS_ONLY ? `${total.count} mutants (JS only: ${total.accepted} accepted)` : `${total.count} mutants (${total.accepted} accepted, ${total.rejected} rejected), ${total.disagreements} disagreements${total.tolerated ? `, ${total.tolerated} with lone surrogates read as U+FFFD` : ''}`, ok: !total.disagreements});

  log(`\n── ${patch ? '3b' : '2c'}. ${patch ? 'Patches' : 'Documents'} at the caps ──`);
  const specials = (patch ? specialPatches() : specialDocuments()).map((special, i): Mutant => ({id: i, base: '(built)', kinds: ['special'], details: [special.name], paths: [], marks: [], text: special.build()}));
  const beforeSpecial = disagreements.length;
  const rows: string[][] = [];
  for (const special of specials) {
    let shown = '';
    const result = compareAll(`${suite}-caps`, [special], patch, disagreements, {batch: 1, onResult: js => (shown = 'threw' in js ? 'threw' : js.ok ? 'accept' : `reject ${js.path}`)});
    rows.push([special.details[0], kb(special.text.length), shown, JS_ONLY ? '–' : result.total.disagreements ? 'DISAGREE' : 'agree']);
  }
  table(['case', 'size', 'validate' + (patch ? 'Patch' : 'Document'), 'Rust'], rows, new Set([1]));
  const special = disagreements.slice(beforeSpecial);
  if (special.length) printDisagreements(special);
  summary.push({part: `parity: ${suite} at the caps`, result: `${specials.length - special.length}/${specials.length} agree`, ok: !special.length});
}

function jsNumbers(count: number) {
  log(`\n── 4. js_number: ${count} doubles + edge cases vs String(n) ──`);
  const rng = new Rng(SEED * 31 + 7);
  const view = new DataView(new ArrayBuffer(8));
  const fromBits = (hi: number, lo: number) => {
    view.setUint32(0, hi >>> 0);
    view.setUint32(4, lo >>> 0);
    return view.getFloat64(0);
  };
  const values: number[] = [];
  const edges = [
    0, -0, 1, -1, 0.1, 0.2, 0.3, 0.1 + 0.2, 1 / 3, 2 / 3, 1.5, 100, 123456789, 5e-324, -5e-324, Number.MIN_VALUE, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MAX_SAFE_INTEGER,
    Number.MIN_SAFE_INTEGER, 2 ** 53, 2 ** 53 + 2, 2 ** 63, 2 ** 64, 1e21, 1e21 - 65536, 999999999999999900000, 1e20, 123456789012345680000, 1e-7, 1e-6, 1.0000000000000001e-7, 9.999999999999999e-7,
    0.000001, 0.0000001, 0.00001, 1e15, 1e16, 1e17, 1e100, 1e300, 1e-300, 123e-20, 2.2250738585072014e-308, 2.225073858507201e-308, 4.9406564584124654e-324, 1.7976931348623157e308,
    0.1 * 3, 1e23, 8.41e21, 5e-7, 1.2345678901234567, 9007199254740993, 4.35, 0.5, 2 ** -1074, 2 ** -1022, 2 ** 1023, 1 - 2 ** -53, 1 + 2 ** -52, 25, 1e9, 1e9 + 1, -1e9, 0.0001, 12345.6789,
  ];
  values.push(...edges, ...edges.map(value => -value));
  for (let e = -324; e <= 308; e++) values.push(Number(`1e${e}`), Number(`9.87654321e${e}`), Number(`4.5e${e}`));
  for (let p = -1074; p <= 1023; p++) values.push(2 ** p);
  while (values.length < count) {
    const kind = rng.int(6);
    let value: number;
    if (kind === 0) value = fromBits(rng.int(2 ** 32), rng.int(2 ** 32)); // any bit pattern
    else if (kind === 1) value = fromBits(rng.int(2) * 0x80000000 + rng.int(0x100000), rng.int(2 ** 32)); // subnormal
    else if (kind === 2) value = (rng.chance(0.5) ? -1 : 1) * rng.int(2 ** 31) * (rng.chance(0.5) ? 2 ** rng.int(30) : 1); // integers
    else if (kind === 3) value = Number(`${rng.chance(0.5) ? '-' : ''}${rng.range(1, 9)}.${String(rng.int(1e9)).padStart(9, '0')}${String(rng.int(1e8))}e${rng.range(-330, 310)}`); // decimal text, every exponent
    else if (kind === 4) value = Number(`${rng.range(1, 9)}${'0'.repeat(rng.range(0, 3))}.${rng.int(1e6)}e${rng.pick([-8, -7, -6, -5, 19, 20, 21, 22])}`); // around the exponent-form thresholds
    else value = rng.next() * 10 ** rng.range(-10, 25); // short and long fractions
    if (Number.isFinite(value)) values.push(value);
  }
  const hex = (value: number) => {
    view.setFloat64(0, value);
    return view.getUint32(0).toString(16).padStart(8, '0') + view.getUint32(4).toString(16).padStart(8, '0');
  };
  const nonFinite = [NaN, Infinity, -Infinity];
  if (JS_ONLY) {
    summary.push({part: 'js_number', result: `${values.length} numbers generated (JS only)`, ok: true});
    return;
  }
  const file = path.join(TMP, 'numbers.txt');
  fs.mkdirSync(TMP, {recursive: true});
  fs.writeFileSync(file, [...values, ...nonFinite].map(hex).join('\n') + '\n');
  const run = cli(['js-number', file]);
  if (run.status !== 0) {
    log(`  js-number failed: ${run.stderr}`);
    summary.push({part: 'js_number', result: 'the CLI failed', ok: false});
    return;
  }
  const lines = run.stdout.split('\n');
  const wrong: string[] = [];
  values.forEach((value, i) => {
    if (lines[i] !== String(value)) wrong.push(`  ✗ ${hex(value)}  String(n) ${String(value)}  rust ${lines[i]}`);
  });
  log(`  ${values.length} finite doubles in ${ms(run.ms)}: ${values.length - wrong.length} equal String(n), ${wrong.length} differ`);
  for (const line of wrong.slice(0, 30)) log(line);
  log(`  non-finite (not stored; for the record): ${nonFinite.map((value, i) => `${String(value)} → ${lines[values.length + i]}`).join(', ')}`);
  summary.push({part: 'js_number', result: `${values.length - wrong.length}/${values.length} equal String(n)`, ok: !wrong.length});
}

function bench(fixtures: FixtureEntry[]) {
  log(`\n── 5. Bench (release, ${ITERATIONS} iterations; JS columns: Node ${process.version} on the same file) ──`);
  const names = ['heavy-page', 'product-file', 'product-file-images'];
  const rows: string[][] = [];
  let heavyParse = Infinity;
  for (const name of names) {
    const entry = fixtures.find(fixture => fixture.name === name);
    if (!entry) continue;
    const run = cli(['bench', fixturePath(entry), String(ITERATIONS)]);
    if (run.status !== 0) {
      rows.push([name, kb(entry.bytes), String(entry.nodes), `bench failed: ${run.stderr.trim().slice(0, 120)}`]);
      continue;
    }
    const result = JSON.parse(run.stdout) as Record<string, {min: number; median: number}> & {bytes: number; nodes: number; valid: boolean};
    const text = fs.readFileSync(fixturePath(entry), 'utf8');
    const jsTimes = {parse: Infinity, validate: Infinity, stringify: Infinity};
    for (let i = 0; i < Math.min(ITERATIONS, 5); i++) {
      let t = performance.now();
      const value = JSON.parse(text);
      jsTimes.parse = Math.min(jsTimes.parse, performance.now() - t);
      t = performance.now();
      validateDocument(value);
      jsTimes.validate = Math.min(jsTimes.validate, performance.now() - t);
      t = performance.now();
      JSON.stringify(value);
      jsTimes.stringify = Math.min(jsTimes.stringify, performance.now() - t);
    }
    if (name === 'heavy-page') heavyParse = result.parse.median;
    const cell = (s: {min: number; median: number}) => `${s.median.toFixed(1)} (${s.min.toFixed(1)})`;
    rows.push([name, kb(result.bytes), String(result.nodes), cell(result.parse), cell(result.parseValidate), cell(result.validate), cell(result.serialize), jsTimes.parse.toFixed(1), jsTimes.validate.toFixed(1), jsTimes.stringify.toFixed(1)]);
  }
  table(['file', 'size', 'layers', 'parse', 'parse+validate', 'validate', 'serialize', 'JSON.parse', 'validateDocument', 'JSON.stringify'], rows, new Set([1, 2, 3, 4, 5, 6, 7, 8, 9]));
  log('  Rust columns: median (min) ms; JS columns: min ms.');
  const ok = heavyParse < 150;
  summary.push({part: 'bench', result: `16 MB page parse ${Number.isFinite(heavyParse) ? heavyParse.toFixed(1) + ' ms median' : 'not measured'} (bar: < 150 ms)`, ok});
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const started = performance.now();
  // Mutant texts and round-trip outputs of an earlier run would read as this run's.
  fs.rmSync(TMP, {recursive: true, force: true});
  const fixtures = await ensureFixtures(line => log(line));
  summary.push({part: 'fixtures', result: `${fixtures.length} documents, ${kb(fixtures.reduce((sum, entry) => sum + entry.bytes, 0))}, ${fixtures.reduce((sum, entry) => sum + entry.nodes, 0)} layers`, ok: true});
  if (!build()) return finish(started, []);
  const disagreements: Disagreement[] = [];
  if (selected.has('roundtrip') && !JS_ONLY) roundTrip(fixtures);
  if (selected.has('parity') || selected.has('patches')) {
    const bases = await loadBases(fixtures);
    if (selected.has('parity')) {
      parityFixtures(fixtures, disagreements);
      fuzz('documents', bases, COUNT, disagreements);
    }
    if (selected.has('patches')) fuzz('patches', bases, PATCH_COUNT, disagreements);
  }
  if (selected.has('js-number')) jsNumbers(NUMBERS);
  if (selected.has('bench') && !JS_ONLY) bench(fixtures);
  finish(started, disagreements);
}

function finish(started: number, disagreements: Disagreement[]) {
  if (selected.has('parity') || selected.has('patches')) {
    fs.mkdirSync(path.dirname(DISAGREEMENTS), {recursive: true});
    fs.writeFileSync(DISAGREEMENTS, disagreements.map(entry => JSON.stringify(entry)).join('\n') + (disagreements.length ? '\n' : ''));
  }
  if (!JS_ONLY && (selected.has('roundtrip') || selected.has('parity') || selected.has('patches')))
    summary.push({part: 'record key order', result: orderWarnings.length ? `WARNING: ${orderWarnings.length} values keep a map's keys in another order than JSON.parse (first: ${orderWarnings[0].slice(0, 120)})` : 'every map keeps JSON.parse\'s key order (round trip and every double accept)', ok: true});
  log(`\n── Summary (${((performance.now() - started) / 1000).toFixed(0)} s${JS_ONLY ? ', JS only' : ''}) ──`);
  table(['part', 'result', ''], summary.map(row => [row.part, row.result, row.ok ? 'ok' : 'FAIL']));
  if (disagreements.length) {
    log(`\n── Disagreements by class (${disagreements.length}, all in ${path.relative(repo, DISAGREEMENTS)}) ──`);
    const classes = new Map<string, {count: number; examples: string[]}>();
    for (const entry of disagreements) {
      const js = entry.js as {ok?: boolean; error?: string; threw?: string};
      const rust = entry.rust as {ok?: boolean; error?: string; crash?: string} | null;
      const said = (message = '') => message.replace(/ at line \d+ column \d+/, '').replace(/`[^`]*`/g, '`…`');
      const key = `${String(entry.suite).replace(/-caps$/, '')}: ` + (entry.outcome === 'verdict'
        ? js.ok ? `JS accepts, Rust refuses: ${said(rust?.error)}` : `Rust accepts, JS refuses: ${said(js.error)}`
        : entry.outcome === 'value' ? `value differs (${String((entry.valueDiff as {path: string}).path).replace(/\.[^.]*[;:][^.]*/g, '.<id>')})`
        : entry.outcome === 'crash' ? `Rust crashed: ${said(rust?.crash).slice(0, 80)}`
        : entry.outcome === 'store' ? `store + binary changed an accepted document (${String((entry.store as {differsAt?: string; error?: string}).differsAt ?? (entry.store as {error?: string}).error).replace(/\.[^.]*[;:][^.]*/g, '.<id>').slice(0, 80)})`
        : `JS threw: ${said(js.threw).slice(0, 80)}`);
      const known = classes.get(key) ?? classes.set(key, {count: 0, examples: []}).get(key)!;
      known.count++;
      if (known.examples.length < 3) known.examples.push(`${entry.suite} #${entry.id}`);
    }
    table(['class', 'count', 'examples'], [...classes].sort((a, b) => b[1].count - a[1].count).map(([key, {count, examples}]) => [key, String(count), examples.join(', ')]), new Set([1]));
  }
  process.exitCode = summary.every(row => row.ok) ? 0 : 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
