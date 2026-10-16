// NOTE: the Cyrillic strings in the candidate lists below (text, internationalised URLs, ids, 'я'/'п' fills) are deliberate non-ASCII
// test data: multi-byte characters must be measured the same by the zod schema and the Rust model, so they stay Russian.
// The parity mutator (lane S1): seeded, deterministic mutants of the fixture documents and of patches built from them, for
// scripts/model/check.ts to run through both `validateDocument` / `validatePatch` (TypeScript, zod) and the Rust model.
//
// A mutant starts from a fixture trimmed to a small valid document (whole subtrees of one to three pages), then takes one
// to three mutations. Most are driven by the zod schema itself (scripts/model/schema-walk.ts): pick a place in the value,
// read what the schema says about it, and write something just inside or just outside it — bounds of every number,
// lengths of every string in UTF-16 units, id characters, enum spellings, tuple and list sizes, record keys and caps,
// union tags and options, dropped, renamed, retyped and unknown fields. The rest are hand-written: URLs, picture URLs,
// library ids, the structural invariants of `checkDocument` (links, cycles, pages, the library page, instance copies,
// text runs, measurements, annotations, keys, depth, path commands) and what only the JSON text can say (`__proto__` keys,
// duplicate keys, lone surrogates, numbers JSON.parse rounds to Infinity, 0 or −0).

import {designDocumentSchema, documentPatchSchema} from '../../shared/design/schema';
import {DESIGN_FIELD_LIMITS as L} from '../../shared/design/document-limits';
import {DESIGN_DOCUMENT_CAPS} from '../../shared/design/limits';
import {createNode} from '../../shared/design/defaults';
import {LIBRARY_PAGE_ID, type DesignDocument, type NodeId, type SceneNode} from '../../shared/design/types';
import * as W from './schema-walk';

type Json = unknown;
type Obj = Record<string, unknown>;

// ── Randomness ───────────────────────────────────────────────────────────────────────────────────

export class Rng {
  private a: number;
  constructor(seed: number) {
    this.a = seed >>> 0;
  }
  next(): number {
    this.a = (this.a + 0x6d2b79f5) >>> 0;
    let t = this.a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  range(lo: number, hi: number): number {
    return lo + this.int(hi - lo + 1);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)];
  }
  weighted<T>(entries: readonly (readonly [T, number])[]): T {
    let total = 0;
    for (const [, weight] of entries) total += weight;
    let at = this.next() * total;
    for (const [value, weight] of entries) if ((at -= weight) < 0) return value;
    return entries[entries.length - 1][0];
  }
  shuffle<T>(list: T[]): T[] {
    for (let i = list.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
  }
}

// ── Raw JSON text ────────────────────────────────────────────────────────────────────────────────

/** A mutant under construction: a JSON value plus raw text spliced in where markers stand (keys or values). */
export class Draft {
  private raws: string[] = [];
  constructor(public value: Json) {}
  /** A marker string; where it stands as a key or a string value, `text` is written instead (including the quotes). */
  raw(text: string): string {
    this.raws.push(text);
    return `@@RAW${this.raws.length - 1}@@`;
  }
  /** Where each raw text landed in the last `text()` (UTF-16 offsets), for the reports' excerpts. */
  marks: {offset: number; length: number}[] = [];
  rawText(marker: string): string | undefined {
    const match = /^@@RAW(\d+)@@$/.exec(marker);
    return match ? this.raws[Number(match[1])] : undefined;
  }
  text(separator?: string): string {
    const base = separator === undefined ? JSON.stringify(this.value) : JSON.stringify(this.value, null, separator).replace(/\n/g, ' ');
    this.marks = [];
    if (!this.raws.length) return base;
    let out = '',
      last = 0;
    for (const match of base.matchAll(/"@@RAW(\d+)@@"/g)) {
      out += base.slice(last, match.index);
      const raw = this.raws[Number(match[1])];
      if (raw === undefined) throw Error(`mutate: marker ${match[0]} of another mutant (a shared value was written into)`);
      this.marks.push({offset: out.length, length: raw.length});
      out += raw;
      last = match.index! + match[0].length;
    }
    return out + base.slice(last);
  }
}

/** `paths`: where the schema-driven mutations wrote (dot-joined); `marks`: where raw JSON text was spliced in. */
export type Mutant = {id: number; base: string; kinds: string[]; details: string[]; paths: string[]; marks: {offset: number; length: number}[]; text: string};

// ── Places in a value ────────────────────────────────────────────────────────────────────────────

export type Loc = {path: (string | number)[]; schema: W.Schema; parent: Obj | Json[]; key: string | number; present: boolean};
const valueAt = (loc: Loc): Json => (loc.parent as Obj)[loc.key as string];
const setAt = (loc: Loc, value: Json) => ((loc.parent as Obj)[loc.key as string] = value);
const lastName = (loc: Loc) => [...loc.path].reverse().find((part): part is string => typeof part === 'string') ?? '';
const pathText = (path: readonly (string | number)[]) => path.join('.');

/** Every place below `value` (present values, and absent optional fields of objects), with its schema. */
export function locate(schema: W.Schema, parent: Obj | Json[], key: string | number, path: (string | number)[], out: Loc[] = []): Loc[] {
  const value = (parent as Obj)[key as string];
  out.push({path, schema, parent, key, present: value !== undefined});
  if (value === undefined || value === null) return out;
  children(W.unwrap(schema).core, value, path, out);
  return out;
}
function children(core: W.Schema, value: Json, path: (string | number)[], out: Loc[]) {
  const def = W.defOf(core);
  switch (def.typeName) {
    case 'ZodObject':
      if (W.isPlainObject(value)) for (const [name, field] of Object.entries(W.objectShape(core))) locate(field, value, name, [...path, name], out);
      return;
    case 'ZodArray':
      if (Array.isArray(value)) value.forEach((_, i) => locate(def.type, value, i, [...path, i], out));
      return;
    case 'ZodTuple':
      if (Array.isArray(value)) (def.items as W.Schema[]).forEach((item, i) => i < value.length && locate(item, value, i, [...path, i], out));
      return;
    case 'ZodRecord':
      // Keys spliced in as raw text (`__proto__`, repeats) are not places of the schema: no mutation targets them.
      if (W.isPlainObject(value)) for (const name of Object.keys(value)) if (!name.startsWith('@@RAW')) locate(def.valueType, value, name, [...path, name], out);
      return;
    case 'ZodDiscriminatedUnion': {
      const option = W.duOption(core, value);
      if (option) children(option, value, path, out);
      return;
    }
    case 'ZodUnion': {
      const index = W.unionOption(core, value);
      if (index >= 0) children(W.unwrap((def.options as W.Schema[])[index]).core, value, path, out);
      return;
    }
    default:
      return;
  }
}

// ── Valid samples of a schema ────────────────────────────────────────────────────────────────────

const ID_PATTERN = /^[A-Za-z0-9_:;.,-]+$/.source;
const patternKind = (patterns: RegExp[]): 'id' | 'image' | 'library' | 'sticker' | null => {
  for (const pattern of patterns) {
    if (pattern.source === ID_PATTERN) return 'id';
    if (pattern.source.includes('uploads')) return 'image';
    if (pattern.source.includes('{36}')) return 'library';
    if (pattern.source.includes('a-z0-9-')) return 'sticker';
  }
  return null;
};
const UUID = '0f1e2d3c-4b5a-4968-8776-655443322110';

function sampleString(core: W.Schema, rng: Rng, hint: string): string {
  const {min, max, patterns} = W.stringBounds(core);
  switch (patternKind(patterns)) {
    case 'id':
      return rng.pick(['a', 'x1', 'n:1', 'k_2.3,4-5', 'I1:2;3:4']);
    case 'image':
      return rng.pick(['/uploads/a.png', '/uploads/0b5c7f3e-1d2a.webp', '/uploads/...', '/uploads/_']);
    case 'library':
      return rng.pick([UUID, 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', '-'.repeat(36), 'f'.repeat(36)]);
    case 'sticker':
      return rng.pick(['star', 'light-bulb', 'a', '0-9']);
  }
  const candidates = /url/i.test(hint)
    ? ['https://example.com', 'http://a.b/c?d#e', 'mailto:x@y.z', 'HTTPS://EXAMPLE.COM']
    : ['', 'Текст', 'abc', '😀 эмодзи', 'a/b', 'Иконка#12', ' ', 'k'];
  const fits = candidates.filter(text => text.length >= min && text.length <= max);
  return fits.length ? rng.pick(fits) : 'x'.repeat(Math.max(min, 1));
}
function sampleNumber(core: W.Schema, rng: Rng): number {
  const b = W.numberBounds(core);
  const lo = Number.isFinite(b.min) ? b.min : -1000,
    hi = Number.isFinite(b.max) ? Math.min(b.max, lo + 2000) : lo + 2000;
  let value = rng.pick([lo, hi, lo + (hi - lo) * rng.next(), 0, 1, 0.5]);
  if (b.int) value = Math.round(value);
  value = Math.min(hi, Math.max(lo, value));
  if (!b.minInclusive && value <= b.min) value = b.int ? b.min + 1 : b.min + (hi - b.min) / 2;
  if (!b.maxInclusive && value >= b.max) value = b.int ? b.max - 1 : (lo + b.max) / 2;
  return value;
}

/** A value the schema accepts (most of the time: refinements are retried a few times). */
export function sample(schema: W.Schema, rng: Rng, hint = '', depth = 0): Json {
  const def = W.defOf(schema);
  switch (def.typeName) {
    case 'ZodOptional':
      return sample(def.innerType, rng, hint, depth);
    case 'ZodNullable':
      return rng.chance(0.15) ? null : sample(def.innerType, rng, hint, depth);
    case 'ZodEffects': {
      let value: Json;
      for (let i = 0; i < 12; i++) {
        value = sample(def.schema, rng, hint, depth);
        if (schema.safeParse(value).success) return value;
      }
      return value;
    }
    case 'ZodString':
      return sampleString(schema, rng, hint);
    case 'ZodNumber':
      return sampleNumber(schema, rng);
    case 'ZodBoolean':
      return rng.chance(0.5);
    case 'ZodLiteral':
      return def.value;
    case 'ZodEnum':
      return rng.pick(def.values as string[]);
    case 'ZodObject': {
      const out: Obj = {};
      for (const [name, field] of Object.entries(W.objectShape(schema))) {
        if (W.unwrap(field).optional && (depth > 2 || rng.chance(0.6))) continue;
        out[name] = sample(field, rng, name, depth + 1);
      }
      return out;
    }
    case 'ZodArray': {
      const {min, max} = W.arrayBounds(schema);
      const n = Math.min(max, Math.max(min, depth > 2 ? min : rng.int(3)));
      return Array.from({length: n}, () => sample(def.type, rng, hint, depth + 1));
    }
    case 'ZodTuple':
      return (def.items as W.Schema[]).map(item => sample(item, rng, hint, depth + 1));
    case 'ZodRecord': {
      const out: Obj = {};
      const n = depth > 2 ? 0 : rng.int(3);
      for (let i = 0; i < n; i++) out['k' + i] = sample(def.valueType, rng, hint, depth + 1);
      return out;
    }
    case 'ZodDiscriminatedUnion':
      return sample(rng.pick(def.options as W.Schema[]), rng, hint, depth);
    case 'ZodUnion':
      return sample(rng.pick(def.options as W.Schema[]), rng, hint, depth);
    default:
      throw Error('sample: unsupported ' + def.typeName);
  }
}

// ── Edge values ──────────────────────────────────────────────────────────────────────────────────

const view = new DataView(new ArrayBuffer(8));
function nextAfter(x: number, up: boolean): number {
  if (Number.isNaN(x) || !Number.isFinite(x)) return x;
  if (x === 0) return up ? 5e-324 : -5e-324;
  view.setFloat64(0, x);
  let bits = view.getBigUint64(0);
  bits += (x > 0) === up ? 1n : -1n;
  view.setBigUint64(0, bits);
  return view.getFloat64(0);
}

type Candidate = {value: Json; note: string} | {raw: string; note: string};
/** Numbers at and around every bound of a number schema, and texts JSON.parse turns into something else. */
function numberEdges(core: W.Schema): Candidate[] {
  const b = W.numberBounds(core);
  const out: Candidate[] = [];
  const add = (value: number, note: string) => out.push({value, note});
  for (const [bound, name] of [[b.min, 'min'], [b.max, 'max']] as const)
    if (Number.isFinite(bound)) {
      add(bound, name);
      add(nextAfter(bound, true), `${name} + 1 ulp`);
      add(nextAfter(bound, false), `${name} − 1 ulp`);
      add(bound + 1, `${name} + 1`);
      add(bound - 1, `${name} − 1`);
      if (b.int) add(bound + 0.5, `${name} + 0.5`);
    }
  if (b.int) for (const value of [0.5, 1.5, 2 ** 53, 2 ** 53 + 2, 1e21, -0.5, 3.0000000000000004]) add(value, 'integer check');
  for (const value of [0, 1, -1, 1e308, -1e308, 5e-324, -5e-324, 1e9, -1e9, 1e9 + 1, Number.MAX_VALUE, 0.1 + 0.2, 1 / 3]) add(value, 'generic');
  for (const raw of ['-0', '1e400', '-1e400', '1e-400', '1.0', '1E0', '0.1e1', '1e+0', '100000000000000000000000', '0.30000000000000004', '1.7976931348623159e308', '2.2250738585072011e-308'])
    out.push({raw, note: 'JSON text ' + raw});
  return out;
}

const URLS = [
  'https://foo.test', 'http://example.com', 'mailto:hi@foo.test', 'mailto:', 'http:', 'https:', 'http://exa mple.com', ' https://x.y', 'https://x.y ', 'HTTPS://X.Y',
  'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'java\tscript:alert(1)', 'data:text/html,<b>', 'file:///etc/passwd', '/relative', '//host/path', 'http://[::1]:99999', 'http://[::1]:8080/a',
  'https://xn--80ak6aa92e.com', 'https://пример.рф', 'http://a b', 'https://x.y/\t', 'https://x\n.y', 'https://x.y/\u0000', 'http://1.2.3.4.5', 'http://256.0.0.1', 'https://a..b',
  'https://' + 'a'.repeat(2048 - 8), 'https://' + 'a'.repeat(2049 - 8), 'https://x.y/' + '😀'.repeat(1018), 'https://x.y/' + '😀'.repeat(1019), 'ftp://x.y', 'ws://x.y', 'blob:https://x.y/1',
  'https://user:pass@x.y', 'http://x.y:0', 'http://x.y:65535', 'http://x.y:65536', 'https://%', 'https://x.y/%zz', 'mailto:a@b?subject=😀', 'tel:+7900', 'http://localhost', 'HTTP://LOCALHOST/',
  'https:x.y', 'http:/x.y', 'http:\\\\x.y', 'https://x.y# ', '', ' ',
];
const IMAGE_URLS = [
  '/uploads/a.png', '/uploads/..', '/uploads/.', '/uploads/...', '/uploads/a/b', '/uploads/', '/uploads/' + 'a'.repeat(200), '/uploads/' + 'a'.repeat(201), '/uploads/a.png?x',
  '/uploads/a b.png', '/uploads/я.png', 'https://evil.example/x.png', '//evil/x.png', 'data:image/png;base64,AAAA', '/UPLOADS/a.png', '/uploads/a.png\n', ' /uploads/a.png', '/uploads/.a', '/uploads/-_.',
];
const LIBRARY_IDS = [UUID, UUID.toUpperCase(), UUID.slice(1), UUID + 'a', '-'.repeat(36), '0'.repeat(36), 'g'.repeat(36), UUID.replace(/-/g, '') + '0000', ' ' + UUID.slice(1), UUID.slice(0, 35) + 'я'];
const STICKERS = ['star', 'light-bulb', 'Star', 'star!', '', 'a'.repeat(200), 'a'.repeat(201), 'звезда', 'a b', '-', '0', 'star_1'];
const BAD_IDS = ['', ' ', 'a b', 'a/b', 'é', '😀', 'a\n', 'a\u0000', '#', '__proto__', '__proto', 'constructor', 'toString', 'a;b', ';', '.', ',', 'x'.repeat(512), 'x'.repeat(513), 'Я', 'a\tb', 'a '];

function stringEdges(core: W.Schema, loc: Loc, refined: boolean): Candidate[] {
  const {min, max, patterns} = W.stringBounds(core);
  const kind = patternKind(patterns);
  const out: Candidate[] = [];
  const add = (value: string, note: string) => out.push({value, note});
  if (kind === 'image') IMAGE_URLS.forEach(url => add(url, 'picture URL'));
  else if (kind === 'library') LIBRARY_IDS.forEach(id => add(id, 'library id'));
  else if (kind === 'sticker') STICKERS.forEach(name => add(name, 'sticker'));
  else if (kind === 'id') BAD_IDS.forEach(id => add(id, 'id characters'));
  else if (refined && /url/i.test(lastName(loc))) URLS.forEach(url => add(url, 'URL'));
  else if (refined) ['__proto__', '__proto__ ', 'constructor', '', 'k'].forEach(value => add(value, 'refined key'));
  if (Number.isFinite(max) && max <= 100_000) {
    const fill = kind === 'id' ? 'a' : 'я';
    add(fill.repeat(max), `${max} units`);
    add(fill.repeat(max + 1), `${max + 1} units`);
    if (kind !== 'id' && kind !== 'image' && kind !== 'library' && kind !== 'sticker') {
      add('😀'.repeat(Math.floor(max / 2)) + (max % 2 ? 'a' : ''), `${max} units of astral text`);
      add('😀'.repeat(Math.floor(max / 2) + 1), `${max + (max % 2 ? 1 : 2)} units of astral text (${Math.floor(max / 2) + 1} code points)`);
      add('a' + '😀'.repeat(Math.floor(max / 2)), 'astral text one unit too long');
    }
  }
  if (min > 0) add('', 'empty');
  if (kind !== 'id') for (const value of ['\u0000', '  ', 'é', '﻿', 'a"b\\c']) add(value, 'unusual characters');
  out.push({raw: '"a\\ud800b"', note: 'lone high surrogate'}, {raw: '"\\udc00"', note: 'lone low surrogate'}, {raw: '"\\ud83d\\ude00"', note: 'escaped surrogate pair'});
  return out;
}
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};
const RETYPES: readonly Candidate[] = deepFreeze<Candidate[]>([
  {value: 0, note: 'number'}, {value: 1, note: 'number'}, {value: '1', note: 'string'}, {value: '', note: 'empty string'}, {value: true, note: 'boolean'},
  {value: false, note: 'boolean'}, {value: null, note: 'null'}, {value: {}, note: 'object'}, {value: [], note: 'array'}, {value: [0], note: 'array'}, {value: 'true', note: 'string'},
]);

// ── Generic mutations (any value, schema-driven) ─────────────────────────────────────────────────

type Mutation = {kind: string; detail: string; path?: string};
type Ctx = {rng: Rng; draft: Draft; locs: Loc[]};
type Operator = (ctx: Ctx) => Mutation | null;

const pickLoc = (ctx: Ctx, test: (loc: Loc, core: W.Schema) => boolean): Loc | null => {
  const fits = ctx.locs.filter(loc => test(loc, W.unwrap(loc.schema).core));
  return fits.length ? ctx.rng.pick(fits) : null;
};
const isObjectLoc = (loc: Loc) => loc.present && W.isPlainObject(valueAt(loc));
const coreKind = (core: W.Schema) => W.kindOf(core);
// Candidates are shared constants: a value written into a mutant is a copy, so a later mutation never edits the constant.
const applyCandidate = (ctx: Ctx, loc: Loc, candidate: Candidate) => setAt(loc, 'raw' in candidate ? ctx.draft.raw(candidate.raw) : structuredClone(candidate.value));
const show = (value: Json) => {
  const text = typeof value === 'string' && value.startsWith('@@RAW') ? 'raw' : JSON.stringify(value) ?? 'undefined';
  return text.length > 60 ? text.slice(0, 57) + `…(${text.length})` : text;
};

const UNKNOWN_KEYS = ['extra', 'Fills', 'fills ', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype', '', '0', 'опасно', 'x'.repeat(600)];

export const GENERIC: Record<string, {weight: number; run: Operator}> = {
  'drop-field': {
    weight: 6,
    run: ctx => {
      const loc = pickLoc(ctx, loc => loc.present && typeof loc.key === 'string' && W.isPlainObject(loc.parent));
      if (!loc) return null;
      delete (loc.parent as Obj)[loc.key];
      return {kind: 'drop-field', path: pathText(loc.path), detail: `drop ${pathText(loc.path)} (${W.unwrap(loc.schema).optional ? 'optional' : 'required'})`};
    },
  },
  'unknown-field': {
    weight: 5,
    run: ctx => {
      const loc = pickLoc(ctx, isObjectLoc);
      if (!loc) return null;
      const target = valueAt(loc) as Obj;
      const proto = ctx.rng.chance(0.3);
      const name = proto ? ctx.draft.raw('"__proto__"') : ctx.rng.pick(UNKNOWN_KEYS);
      const rawValue = ctx.rng.chance(0.25) ? ctx.rng.pick(['1e400', '-1e400', '1e-400', '-0', '"\\ud800"', '123456789012345678901234567890']) : undefined;
      const value = rawValue !== undefined ? ctx.draft.raw(rawValue) : ctx.rng.pick<Json>([1, 'x', null, {a: 1}, [1, 2], true, {a: {b: [1, 'é']}}]);
      if (Object.hasOwn(target, name)) return null;
      target[name] = value;
      return {kind: 'unknown-field', path: pathText(loc.path), detail: `add ${proto ? '__proto__' : JSON.stringify(name.slice(0, 20))} = ${rawValue ?? show(value)} at ${pathText(loc.path)}`};
    },
  },
  'rename-field': {
    weight: 3,
    run: ctx => {
      const loc = pickLoc(ctx, loc => loc.present && typeof loc.key === 'string' && W.isPlainObject(loc.parent));
      if (!loc) return null;
      const name = loc.key as string;
      const renamed = ctx.rng.pick([name.toUpperCase(), name + '_', name.replace(/[A-Z]/g, c => '_' + c.toLowerCase()), name.slice(1), ' ' + name]);
      if (renamed === name || Object.hasOwn(loc.parent, renamed)) return null;
      const parent = loc.parent as Obj;
      parent[renamed] = parent[name];
      delete parent[name];
      return {kind: 'rename-field', path: pathText(loc.path), detail: `rename ${pathText(loc.path)} → ${JSON.stringify(renamed)}`};
    },
  },
  retype: {
    weight: 6,
    run: ctx => {
      const loc = pickLoc(ctx, loc => loc.present);
      if (!loc) return null;
      const candidate = ctx.rng.pick(RETYPES);
      applyCandidate(ctx, loc, candidate);
      return {kind: 'retype', path: pathText(loc.path), detail: `${pathText(loc.path)} := ${show((candidate as {value: Json}).value)} (${candidate.note})`};
    },
  },
  'null-optional': {
    weight: 4,
    run: ctx => {
      const loc = pickLoc(ctx, loc => W.unwrap(loc.schema).optional || W.unwrap(loc.schema).nullable);
      if (!loc) return null;
      setAt(loc, null);
      const {optional, nullable} = W.unwrap(loc.schema);
      return {kind: 'null-optional', path: pathText(loc.path), detail: `${pathText(loc.path)} := null (${nullable ? 'nullable' : optional ? 'optional, not nullable' : ''})`};
    },
  },
  'number-edge': {
    weight: 14,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodNumber');
      if (!loc) return null;
      const candidate = ctx.rng.pick(numberEdges(W.unwrap(loc.schema).core));
      applyCandidate(ctx, loc, candidate);
      return {kind: 'number-edge', path: pathText(loc.path), detail: `${pathText(loc.path)} := ${'raw' in candidate ? candidate.raw : show(candidate.value)} (${candidate.note})`};
    },
  },
  'string-edge': {
    weight: 12,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodString' && loc.present);
      if (!loc) return null;
      const candidate = ctx.rng.pick(stringEdges(W.unwrap(loc.schema).core, loc, W.unwrap(loc.schema).refined));
      applyCandidate(ctx, loc, candidate);
      return {kind: 'string-edge', path: pathText(loc.path), detail: `${pathText(loc.path)} := ${'raw' in candidate ? candidate.raw : show(candidate.value)} (${candidate.note})`};
    },
  },
  'enum-value': {
    weight: 5,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => (coreKind(core) === 'ZodEnum' || coreKind(core) === 'ZodLiteral') && loc.present);
      if (!loc) return null;
      const core = W.unwrap(loc.schema).core;
      const current = valueAt(loc);
      const values = coreKind(core) === 'ZodEnum' ? (W.defOf(core).values as string[]) : [W.defOf(core).value];
      const candidates: Json[] = [
        ...values, typeof current === 'string' ? current.toLowerCase() : 2, typeof current === 'string' ? current + ' ' : '1', 'UNKNOWN', '', 'Normal', 'CENTER', 'NONE', 'SOLID', 1, true, false, null,
      ];
      const value = ctx.rng.pick(candidates);
      setAt(loc, value);
      return {kind: 'enum-value', path: pathText(loc.path), detail: `${pathText(loc.path)} := ${show(value)}`};
    },
  },
  'boolean-value': {
    weight: 2,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodBoolean' && loc.present);
      if (!loc) return null;
      const value = ctx.rng.pick<Json>([true, false, 0, 1, 'true', 'false', null, []]);
      setAt(loc, value);
      return {kind: 'boolean-value', path: pathText(loc.path), detail: `${pathText(loc.path)} := ${show(value)}`};
    },
  },
  'array-size': {
    weight: 5,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodArray' && loc.present && Array.isArray(valueAt(loc)));
      if (!loc) return null;
      const core = W.unwrap(loc.schema).core;
      const {min, max} = W.arrayBounds(core);
      const list = valueAt(loc) as Json[];
      const item = () => (list.length && ctx.rng.chance(0.7) ? structuredClone(ctx.rng.pick(list)) : sample(W.defOf(core).type, ctx.rng, lastName(loc)));
      const choice = ctx.rng.pick(['max', 'max+1', 'min', 'min-1', 'single', 'wrap'] as const);
      if ((choice === 'max' || choice === 'max+1') && max > 1000) return null;
      if (choice === 'min-1' && min === 0) return null;
      const length = choice === 'max' ? max : choice === 'max+1' ? max + 1 : choice === 'min' ? min : choice === 'min-1' ? min - 1 : 1;
      if (choice === 'wrap') setAt(loc, list.length ? list[0] : item());
      else setAt(loc, Array.from({length}, (_, i) => (i < list.length ? list[i] : item())));
      return {kind: 'array-size', path: pathText(loc.path), detail: `${pathText(loc.path)}: ${choice === 'wrap' ? 'an item instead of the list' : `${length} items (min ${min}, max ${max})`}`};
    },
  },
  'tuple-length': {
    weight: 2,
    run: ctx => {
      // Present tuples, or absent optional ones (rectangleCornerRadii, imageTransform) written with the wrong length.
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodTuple' && (loc.present ? Array.isArray(valueAt(loc)) : W.isPlainObject(loc.parent)));
      if (!loc) return null;
      const list = [...((loc.present ? valueAt(loc) : sample(W.unwrap(loc.schema).core, ctx.rng, lastName(loc))) as Json[])];
      if (Array.isArray(list[0]) && ctx.rng.chance(0.4)) {
        // A matrix row of the wrong length.
        const row = [...(list[0] as Json[])];
        if (ctx.rng.chance(0.5)) row.pop();
        else row.push(0);
        list[0] = row;
        setAt(loc, list);
        return {kind: 'tuple-length', path: pathText(loc.path), detail: `${pathText(loc.path)}: first row of ${row.length}`};
      }
      const choice = ctx.rng.pick(['shorter', 'longer', 'empty', 'object'] as const);
      if (choice === 'shorter') list.pop();
      else if (choice === 'longer') list.push(structuredClone(list[0] ?? 0));
      setAt(loc, choice === 'empty' ? [] : choice === 'object' ? Object.fromEntries(list.map((value, i) => [String(i), value])) : list);
      return {kind: 'tuple-length', path: pathText(loc.path), detail: `${pathText(loc.path)}: ${choice}`};
    },
  },
  'record-key': {
    weight: 5,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodRecord' && loc.present && W.isPlainObject(valueAt(loc)));
      if (!loc) return null;
      const core = W.unwrap(loc.schema).core;
      const map = valueAt(loc) as Obj;
      const existing = Object.keys(map).filter(key => !key.startsWith('@@RAW'));
      const value = existing.length && ctx.rng.chance(0.7) ? structuredClone(map[ctx.rng.pick(existing)]) : sample(W.defOf(core).valueType, ctx.rng, lastName(loc));
      const choice = ctx.rng.pick(['__proto__', 'bad', 'long', 'rekey'] as const);
      let shown: string;
      if (choice === '__proto__') {
        map[ctx.draft.raw('"__proto__"')] = value;
        shown = '__proto__';
      } else if (choice === 'rekey' && existing.length) {
        const from = ctx.rng.pick(existing);
        const to = ctx.rng.pick(BAD_IDS.filter(id => id !== '__proto__'));
        if (Object.hasOwn(map, to)) return null;
        // Keep the order: rebuild with the new key in place.
        const rebuilt: Obj = {};
        for (const key of Object.keys(map)) rebuilt[key === from ? to : key] = map[key];
        setAt(loc, rebuilt);
        shown = `${JSON.stringify(from)} → ${show(to)}`;
      } else {
        const key = choice === 'long' ? ctx.rng.pick(['k'.repeat(200), 'k'.repeat(201), 'k'.repeat(512), 'k'.repeat(513)]) : ctx.rng.pick(BAD_IDS.filter(id => id !== '__proto__'));
        if (Object.hasOwn(map, key)) return null;
        map[key] = value;
        shown = show(key);
      }
      return {kind: 'record-key', path: pathText(loc.path), detail: `key ${shown} in ${pathText(loc.path)}`};
    },
  },
  'record-size': {
    weight: 2,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodRecord' && loc.present && W.isPlainObject(valueAt(loc)) && W.unwrap(loc.schema).refined);
      if (!loc) return null;
      // The cap lives in the record's refinement (schema.ts `record`): find the Effects around the record.
      let effects = loc.schema;
      while (W.kindOf(effects) !== 'ZodEffects') effects = W.defOf(effects).innerType;
      const cap = W.recordCap(effects);
      if (cap > 1000) return null;
      const core = W.unwrap(loc.schema).core;
      const map = valueAt(loc) as Obj;
      const existing = Object.keys(map);
      const length = ctx.rng.pick([cap, cap + 1]);
      for (let i = 0; existing.length + i < length; i++) map['r' + i] = existing.length ? structuredClone(map[existing[i % existing.length]]) : sample(W.defOf(core).valueType, ctx.rng, lastName(loc));
      return {kind: 'record-size', path: pathText(loc.path), detail: `${pathText(loc.path)}: ${Object.keys(map).length} entries (cap ${cap})`};
    },
  },
  'union-tag': {
    weight: 8,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodDiscriminatedUnion' && isObjectLoc(loc));
      if (!loc) return null;
      const core = W.unwrap(loc.schema).core;
      const discriminator = W.defOf(core).discriminator as string;
      const value = valueAt(loc) as Obj;
      const tags = [...(W.defOf(core).optionsMap as Map<string, W.Schema>).keys()];
      const choice = ctx.rng.pick(['swap', 'swap', 'morph', 'unknown', 'lower', 'drop'] as const);
      const before = value[discriminator];
      if (choice === 'swap') value[discriminator] = ctx.rng.pick(tags.filter(tag => tag !== before));
      else if (choice === 'morph') setAt(loc, {...value, ...(sample(W.defOf(core).optionsMap.get(ctx.rng.pick(tags)), ctx.rng, lastName(loc)) as Obj)});
      else if (choice === 'unknown') value[discriminator] = ctx.rng.pick(['UNKNOWN', 'NOISE', 'VIDEO', 'SET_VARIABLE', 'emoji', 1, null]);
      else if (choice === 'lower') value[discriminator] = typeof before === 'string' ? before.toLowerCase() : before;
      else delete value[discriminator];
      const after = (valueAt(loc) as Obj)[discriminator];
      return {kind: 'union-tag', path: pathText(loc.path), detail: `${pathText(loc.path)}.${discriminator}: ${show(before)} → ${choice === 'drop' ? '(dropped)' : show(after)} (${choice})`};
    },
  },
  'union-option': {
    weight: 7,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodUnion' && (loc.present || W.isPlainObject(loc.parent)));
      if (!loc) return null;
      const core = W.unwrap(loc.schema).core;
      const options = W.defOf(core).options as W.Schema[];
      const current = valueAt(loc);
      const other = sample(ctx.rng.pick(options), ctx.rng, lastName(loc));
      const choice = ctx.rng.pick(['other', 'merge', 'merge-bad', 'merge-bad'] as const);
      let value: Json = other;
      if (choice !== 'other' && W.isPlainObject(current) && W.isPlainObject(other)) {
        value = choice === 'merge' ? {...current, ...other} : {...other, ...current};
        // An option that fails its bounds: the union then falls through to the next option (zod keeps the first that parses).
        if (choice === 'merge-bad') for (const key of Object.keys(value as Obj)) if (typeof (value as Obj)[key] === 'number' && ctx.rng.chance(0.5)) (value as Obj)[key] = ctx.rng.pick([2, -1, 1.5]);
      } else if (choice !== 'other') {
        value = ctx.rng.pick<Json>([
          {r: 0, g: 0, b: 0, a: 1, type: 'VARIABLE_ALIAS', id: 'v1'}, {r: 2, g: 0, b: 0, a: 1, type: 'VARIABLE_ALIAS', id: 'v1'}, {r: 0, g: 0, b: 0, type: 'VARIABLE_ALIAS', id: 'v1'},
          {node: 'n1', magnet: 'auto', x: 1, y: 2}, {node: 'bad id', magnet: 'auto', x: 1, y: 2}, {node: 'n1', magnet: 'AUTO', x: 1, y: 2}, {node: 'n1', x: 1, y: 2}, {x: 1e10, y: 2, node: 'n', magnet: 'top'},
          '', 'id', 0, 90, 45, '90', true, 'text', null,
        ]);
      }
      setAt(loc, value);
      return {kind: 'union-option', path: pathText(loc.path), detail: `${pathText(loc.path)} := ${show(value)} (${choice})`};
    },
  },
  'sample-field': {
    weight: 8,
    run: ctx => {
      const loc = pickLoc(ctx, loc => !loc.present && typeof loc.key === 'string' && W.isPlainObject(loc.parent));
      if (!loc) return null;
      const value = sample(loc.schema, ctx.rng, lastName(loc));
      if (value === undefined) return null;
      setAt(loc, value);
      return {kind: 'sample-field', path: pathText(loc.path), detail: `add ${pathText(loc.path)} = ${show(value)}`};
    },
  },
  'sample-value': {
    weight: 4,
    run: ctx => {
      const loc = pickLoc(ctx, loc => loc.present && loc.path.length > 1);
      if (!loc) return null;
      const value = sample(loc.schema, ctx.rng, lastName(loc));
      setAt(loc, value);
      return {kind: 'sample-value', path: pathText(loc.path), detail: `${pathText(loc.path)} := ${show(value)}`};
    },
  },
  'targeted-value': {
    weight: 6,
    run: ctx => {
      const targets: [RegExp, Json[]][] = [
        [/\.rotation$/, [0, 90, 180, 270, 45, -90, 360, 90.0000001, '90', null]],
        [/\.scalingFactor$/, [0, -0, 5e-324, 1e-300, 10_000, 10_000.000000001, -1]],
        [/\.pointCount$/, [2, 3, 1000, 1001, 3.5, 0, -3]],
        [/\.maxLines$/, [0, 1, 100_000, 100_001, 1.5, null, -1]],
        [/\.(opacity|r|g|b|a|innerRadius|startOffset|relative|position|cornerSmoothing)$/, [0, 1, -0, 1.0000000000000002, -5e-324, 0.5, 2, -1]],
        [/\.(exposure|contrast|saturation|temperature|tint|highlights|shadows)$/, [-1, 1, -1.0000000000000002, 1.0000000000000002, 0]],
        [/\.(fontWeight)$/, [1, 1000, 0.9999999999999999, 1000.0000000000001, 400.5]],
        [/\.(count)$/, [0, 10_000, 10_001, 1.5, -1]],
        [/\.(version)$/, [1, 0, 1_000_000_000, 1_000_000_001, 1.5]],
        [/\.(start|end)$/, [0, 1, 100_000, 100_001, 0.5, -1]],
        [/\.(width|height)$/, [0, -0, 1e9, 1e9 + 1, -5e-324, 1e6, 1e6 + 1]],
        [/\.(timeout|duration)$/, [0, 1_000_000, 1_000_001, -0.001]],
        [/\.keyCode$/, ['', 'a', 'k'.repeat(64), 'k'.repeat(65), '😀'.repeat(32), '😀'.repeat(33)]],
        [/\.(presetId)$/, ['', 'iphone-16', 'x'.repeat(200), 'x'.repeat(201)]],
        [/\.(rectangleCornerRadii)$/, [[1, 2, 3], [1, 2, 3, 4], [1, 2, 3, 4, 5], null, [], [0, 0, 0, -1]]],
        [/\.(imageTransform)$/, [[[1, 0, 0], [0, 1, 0]], [[1, 0], [0, 1]], [[1, 0, 0]], [[1, 0, 0], [0, 1, 0], [0, 0, 1]]]],
      ];
      const loc = pickLoc(ctx, loc => loc.present && targets.some(([pattern]) => pattern.test('.' + pathText(loc.path))));
      if (!loc) return null;
      const [, values] = targets.find(([pattern]) => pattern.test('.' + pathText(loc.path)))!;
      const value = ctx.rng.pick(values);
      setAt(loc, value);
      return {kind: 'targeted-value', path: pathText(loc.path), detail: `${pathText(loc.path)} := ${show(value)}`};
    },
  },
};

// ── JSON-text mutations ──────────────────────────────────────────────────────────────────────────

/** An object that is one option of a union (a paint, an effect, a path command, board meta, a connector end, a variable
 *  value...): the Rust model buffers these before it knows the option, so they get their own text mutations. */
const unionObjectLoc = (loc: Loc, core: W.Schema) => isObjectLoc(loc) && (coreKind(core) === 'ZodDiscriminatedUnion' || coreKind(core) === 'ZodUnion');
/** The schema of field `key` of the object at `core` (the option a union value selects, the value of a record). */
function fieldSchema(core: W.Schema, value: Obj, key: string): W.Schema | undefined {
  switch (coreKind(core)) {
    case 'ZodObject':
      return W.objectShape(core)[key];
    case 'ZodRecord':
      return W.defOf(core).valueType;
    case 'ZodDiscriminatedUnion': {
      const option = W.duOption(core, value);
      return option ? W.objectShape(option)[key] : undefined;
    }
    case 'ZodUnion': {
      const index = W.unionOption(core, value);
      const option = index >= 0 ? W.unwrap((W.defOf(core).options as W.Schema[])[index]).core : undefined;
      return option && coreKind(option) === 'ZodObject' ? W.objectShape(option)[key] : undefined;
    }
    default:
      return undefined;
  }
}
const NESTING_TARGETS = [127, 128, 129, 130, 200, 1000, 1023, 1024, 1025, 1026];
/** The deepest bracket nesting of a JSON text (strings skipped). */
export function jsonDepth(text: string): number {
  let depth = 0,
    max = 0,
    inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 92) i++;
      else if (c === 34) inString = false;
    } else if (c === 34) inString = true;
    else if (c === 91 || c === 123) max = Math.max(max, ++depth);
    else if (c === 93 || c === 125) depth--;
  }
  return max;
}

export const TEXTUAL: Record<string, {weight: number; run: Operator}> = {
  'duplicate-key': {
    weight: 3,
    run: ctx => {
      const loc = pickLoc(ctx, loc => isObjectLoc(loc) && Object.keys(valueAt(loc) as Obj).length > 0);
      if (!loc) return null;
      const target = valueAt(loc) as Obj;
      const key = ctx.rng.pick(Object.keys(target).filter(key => !key.startsWith('@@RAW')));
      if (key === undefined) return null;
      const value = structuredClone(ctx.rng.chance(0.5) ? target[key] : (ctx.rng.pick(RETYPES) as {value: Json}).value);
      target[ctx.draft.raw(JSON.stringify(key))] = value;
      return {kind: 'duplicate-key', path: pathText(loc.path), detail: `${pathText([...loc.path, key])} written twice, the second ${show(value)} (JSON.parse keeps the last)`};
    },
  },
  'lone-surrogate': {
    weight: 2,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodString' && loc.present && typeof valueAt(loc) === 'string' && !(valueAt(loc) as string).startsWith('@@RAW'));
      if (!loc) return null;
      const current = JSON.stringify(valueAt(loc)).slice(1, -1);
      const escape = ctx.rng.pick(['\\ud800', '\\udbff', '\\udc00', '\\udfff', '\\ud83d', '\\ud83d\\ud83d', '\\ude00\\ud83d']);
      setAt(loc, ctx.draft.raw(`"${current}${escape}"`));
      return {kind: 'lone-surrogate', path: pathText(loc.path), detail: `${pathText(loc.path)} gets ${escape}`};
    },
  },
  'number-text': {
    weight: 3,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => coreKind(core) === 'ZodNumber' && loc.present && typeof valueAt(loc) === 'number');
      if (!loc) return null;
      const value = valueAt(loc) as number;
      const text = ctx.rng.pick([
        `${value}.0`, `${value}e0`, `${value}E+0`, value === 0 ? '-0' : `${value}0e-1`, `${value.toExponential()}`, value.toPrecision(17), `${value}00000000000000000001`,
        '1e400', '-1e400', '1e-400', '0.000000000000000000000000000000000000000000000000001', '9007199254740993', '-0.0',
      ]);
      if (!/^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(text)) return null;
      setAt(loc, ctx.draft.raw(text));
      return {kind: 'number-text', path: pathText(loc.path), detail: `${pathText(loc.path)} written as ${text}`};
    },
  },
  'repeat-key': {
    weight: 7,
    run: ctx => {
      const loc = (ctx.rng.chance(0.65) && pickLoc(ctx, unionObjectLoc)) || pickLoc(ctx, loc => isObjectLoc(loc) && Object.keys(valueAt(loc) as Obj).length > 0);
      if (!loc) return null;
      const core = W.unwrap(loc.schema).core;
      const target = valueAt(loc) as Obj;
      const keys = Object.keys(target).filter(key => !key.startsWith('@@RAW'));
      const discriminator = coreKind(core) === 'ZodDiscriminatedUnion' ? (W.defOf(core).discriminator as string) : undefined;
      const key = discriminator && Object.hasOwn(target, discriminator) && ctx.rng.chance(0.35) ? discriminator : ctx.rng.pick(keys);
      if (key === undefined) return null;
      const original = target[key];
      const field = fieldSchema(core, target, key);
      const tags = discriminator ? [...(W.defOf(core).optionsMap as Map<string, W.Schema>).keys()] : [];
      const invalidRaw = ctx.rng.chance(0.2) ? ctx.rng.pick(['1e400', '-1e400', '"\\ud800"']) : undefined;
      const invalid: Json = invalidRaw !== undefined ? ctx.draft.raw(invalidRaw)
        : key === discriminator ? ctx.rng.pick<Json>(['BOGUS', null, 1, ...tags.filter(tag => tag !== original)])
        : ctx.rng.pick<Json>([null, 'x', {}, [], true, -1, 2, 1e10, 'UNKNOWN', {type: 'BOGUS'}]);
      const other: Json = key === discriminator ? ctx.rng.pick(tags.length > 1 ? tags.filter(tag => tag !== original) : tags) : field ? sample(field, ctx.rng, key) : structuredClone(original);
      const mode = ctx.rng.pick(['invalid-first', 'invalid-first', 'invalid-last', 'valid-first', 'other-last'] as const);
      const marker = ctx.draft.raw(JSON.stringify(key));
      const shownInvalid = invalidRaw ?? show(invalid);
      let first: string, last: string;
      if (mode === 'invalid-first' || mode === 'valid-first') {
        // The repeat stands first in the text; JSON.parse keeps the original, which comes last.
        const value = mode === 'invalid-first' ? invalid : structuredClone(original);
        setAt(loc, {[marker]: value, ...target});
        [first, last] = [mode === 'invalid-first' ? shownInvalid : show(value), show(original)];
      } else {
        target[marker] = mode === 'invalid-last' ? invalid : other;
        [first, last] = [show(original), mode === 'invalid-last' ? shownInvalid : show(other)];
      }
      const where = coreKind(core) === 'ZodDiscriminatedUnion' || coreKind(core) === 'ZodUnion' ? 'union object' : coreKind(core) === 'ZodRecord' ? 'record' : 'object';
      return {kind: 'repeat-key', path: pathText(loc.path), detail: `${pathText([...loc.path, key])} repeated in a ${where}: first ${first}, last ${last} (${mode}; JSON.parse keeps the last)`};
    },
  },
  'union-number': {
    weight: 4,
    run: ctx => {
      const loc = pickLoc(ctx, (loc, core) => unionObjectLoc(loc, core) || (coreKind(core) === 'ZodUnion' && loc.present && typeof valueAt(loc) === 'number'));
      if (!loc) return null;
      const text = ctx.rng.pick(['1e400', '-1e400', '1e400', '-1e400', '1e-400', '1.7976931348623159e308', '-0']);
      if (typeof valueAt(loc) === 'number') {
        setAt(loc, ctx.draft.raw(text));
        return {kind: 'union-number', path: pathText(loc.path), detail: `${pathText(loc.path)} (a union value) written as ${text}`};
      }
      const core = W.unwrap(loc.schema).core;
      const target = valueAt(loc) as Obj;
      const numeric = Object.keys(target).filter(key => {
        const field = fieldSchema(core, target, key);
        return field && coreKind(W.unwrap(field).core) === 'ZodNumber';
      });
      if (numeric.length && ctx.rng.chance(0.5)) {
        const key = ctx.rng.pick(numeric);
        target[key] = ctx.draft.raw(text);
        return {kind: 'union-number', path: pathText(loc.path), detail: `known field ${pathText([...loc.path, key])} of a union object written as ${text}`};
      }
      const proto = ctx.rng.chance(0.25);
      const name = proto ? ctx.draft.raw('"__proto__"') : ctx.rng.pick(['extra', 'x', 'Opacity', 'valueOf']);
      if (Object.hasOwn(target, name)) return null;
      target[name] = ctx.draft.raw(text);
      return {kind: 'union-number', path: pathText(loc.path), detail: `unknown key ${proto ? '__proto__' : name} = ${text} in the union object ${pathText(loc.path)}`};
    },
  },
  'deep-unknown': {
    weight: 2,
    run: ctx => {
      const loc = (ctx.rng.chance(0.5) && pickLoc(ctx, unionObjectLoc)) || pickLoc(ctx, isObjectLoc);
      if (!loc) return null;
      const target = valueAt(loc) as Obj;
      // The object at `loc` stands at nesting level path.length + 1 (the document is level 1); its new key's value opens the next.
      const total = ctx.rng.pick(NESTING_TARGETS);
      const levels = total - (loc.path.length + 1);
      if (levels < 1 || Object.hasOwn(target, 'deep')) return null;
      const objects = ctx.rng.chance(0.3);
      target.deep = ctx.draft.raw(objects ? '{"a":'.repeat(levels - 1) + '{}' + '}'.repeat(levels - 1) : '['.repeat(levels) + ']'.repeat(levels));
      return {kind: 'deep-unknown', path: pathText(loc.path), detail: `unknown key "deep" at ${pathText(loc.path)}: ${levels} nested ${objects ? 'objects' : 'arrays'}, the text ${total} levels deep`};
    },
  },
  whitespace: {
    weight: 1,
    run: ctx => ({kind: 'whitespace', detail: 'tabs and spaces between tokens'}),
  },
};

// ── Structural mutations (documents) ─────────────────────────────────────────────────────────────

type Nodes = Record<NodeId, SceneNode>;
const containers = (nodes: Nodes) => Object.values(nodes).filter(node => Array.isArray(node.children));
const nonPages = (nodes: Nodes) => Object.values(nodes).filter(node => node.type !== 'PAGE');
function depthOf(nodes: Nodes, id: NodeId): number {
  let depth = 0;
  for (let node = nodes[id]; node && node.parentId !== null && depth < 1000; node = nodes[node.parentId]) depth++;
  return depth;
}
const fresh = (nodes: Nodes, prefix: string) => {
  let i = 0;
  while (Object.hasOwn(nodes, prefix + i)) i++;
  return prefix + i;
};
const unlist = (nodes: Nodes, parentId: NodeId | null, id: NodeId) => {
  const parent = parentId === null ? undefined : nodes[parentId];
  if (parent?.children) parent.children = parent.children.filter(child => child !== id);
};

type Structural = (doc: DesignDocument, rng: Rng) => string | null;
export const STRUCTURAL: Record<string, {weight: number; run: Structural}> = {
  'struct-links': {
    weight: 4,
    run: (doc, rng) => {
      const node = rng.pick(nonPages(doc.nodes));
      if (!node) return null;
      const parents = containers(doc.nodes).filter(other => other.id !== node.id && other.id !== node.parentId);
      switch (rng.int(6)) {
        case 0:
          node.parentId = 'nowhere';
          return `${node.id}.parentId := "nowhere"`;
        case 1:
          if (!parents.length) return null;
          node.parentId = rng.pick(parents).id;
          return `${node.id}.parentId := ${node.parentId} (that does not list it)`;
        case 2:
          unlist(doc.nodes, node.parentId, node.id);
          return `${node.parentId} stops listing ${node.id}`;
        case 3:
          doc.nodes[node.parentId!]?.children?.push(node.id);
          return `${node.parentId} lists ${node.id} twice`;
        case 4: {
          if (!parents.length) return null;
          const other = rng.pick(parents);
          other.children!.push(node.id);
          return `${other.id} also lists ${node.id} (child of ${node.parentId})`;
        }
        default: {
          // A valid move: under another container, listed there and nowhere else.
          const target = parents.filter(p => p.type !== 'PAGE' || rng.chance(0.5));
          if (!target.length) return null;
          const parent = rng.pick(target);
          unlist(doc.nodes, node.parentId, node.id);
          node.parentId = parent.id;
          parent.children!.splice(rng.int(parent.children!.length + 1), 0, node.id);
          return `move ${node.id} under ${parent.id} (${parent.type})`;
        }
      }
    },
  },
  'struct-cycle': {
    weight: 2,
    run: (doc, rng) => {
      const pairs = containers(doc.nodes).filter(node => node.type !== 'PAGE').flatMap(a => a.children!.filter(id => doc.nodes[id]?.children).map(b => [a, doc.nodes[b]] as const));
      if (!pairs.length) return null;
      const [a, b] = rng.pick(pairs);
      unlist(doc.nodes, a.parentId, a.id);
      a.parentId = b.id;
      b.children!.push(a.id);
      return `cycle: ${a.id} under its own child ${b.id}`;
    },
  },
  'struct-orphan': {
    weight: 2,
    run: (doc, rng) => {
      const id = fresh(doc.nodes, 'orphan');
      const type = rng.pick(['RECTANGLE', 'FRAME', 'TEXT'] as const);
      const parentId = rng.pick([rng.pick(containers(doc.nodes)).id, 'missing', null]);
      doc.nodes[id] = createNode(type, {id, parentId: parentId as NodeId});
      return `orphan ${type} ${id} with parentId ${JSON.stringify(parentId)}, listed nowhere`;
    },
  },
  'struct-pages': {
    weight: 4,
    run: (doc, rng) => {
      const pages = Object.values(doc.nodes).filter(node => node.type === 'PAGE');
      switch (rng.int(7)) {
        case 0: {
          const page = rng.pick(pages);
          const other = rng.pick(nonPages(doc.nodes));
          page.parentId = other?.id ?? 'x';
          return `page ${page.id}.parentId := ${page.parentId}`;
        }
        case 1: {
          const other = rng.pick(nonPages(doc.nodes));
          if (!other) return null;
          doc.pages.push(other.id);
          return `pages lists ${other.id} (${other.type})`;
        }
        case 2:
          doc.pages.push(rng.pick(doc.pages));
          return `pages lists ${doc.pages[doc.pages.length - 1]} twice`;
        case 3:
          doc.pages.push(LIBRARY_PAGE_ID);
          return `pages lists ${LIBRARY_PAGE_ID}${doc.nodes[LIBRARY_PAGE_ID] ? '' : ' (absent)'}`;
        case 4: {
          const id = fresh(doc.nodes, 'page');
          doc.nodes[id] = createNode('PAGE', {id});
          if (rng.chance(0.5)) {
            doc.pages.splice(rng.int(doc.pages.length + 1), 0, id);
            return `a new page ${id}, listed`;
          }
          return `a new page ${id}, not listed`;
        }
        case 5: {
          if (doc.pages.length < 2) return null;
          rng.shuffle(doc.pages);
          return 'pages reordered';
        }
        default: {
          const index = rng.int(doc.pages.length);
          const [id] = doc.pages.splice(index, 1);
          return `page ${id} dropped from pages${doc.pages.length ? '' : ' (none left)'}`;
        }
      }
    },
  },
  'struct-library': {
    weight: 3,
    run: (doc, rng) => {
      if (!doc.nodes[LIBRARY_PAGE_ID]) doc.nodes[LIBRARY_PAGE_ID] = createNode('PAGE', {id: LIBRARY_PAGE_ID, name: 'Libraries'});
      const library = doc.nodes[LIBRARY_PAGE_ID];
      const remote = {libraryId: UUID, key: 'k' + rng.int(100), version: 1};
      const id = fresh(doc.nodes, 'lib');
      const page = doc.nodes[rng.pick(doc.pages)];
      switch (rng.int(6)) {
        case 0:
          doc.nodes[id] = createNode('COMPONENT', {id, parentId: LIBRARY_PAGE_ID, remote});
          library.children!.push(id);
          return `remote COMPONENT ${id} on the library page`;
        case 1:
          doc.nodes[id] = createNode('COMPONENT', {id, parentId: LIBRARY_PAGE_ID});
          library.children!.push(id);
          return `COMPONENT ${id} without remote on the library page`;
        case 2: {
          const type = rng.pick(['RECTANGLE', 'FRAME', 'INSTANCE', 'TEXT'] as const);
          doc.nodes[id] = createNode(type, {id, parentId: LIBRARY_PAGE_ID, remote});
          library.children!.push(id);
          return `remote ${type} ${id} on the library page`;
        }
        case 3:
          if (!page) return null;
          doc.nodes[id] = createNode('COMPONENT', {id, parentId: page.id, remote});
          page.children!.push(id);
          return `remote COMPONENT ${id} on page ${page.id}`;
        case 4: {
          doc.nodes[id] = createNode('COMPONENT_SET', {id, parentId: LIBRARY_PAGE_ID, remote});
          library.children!.push(id);
          const child = id + 'v';
          doc.nodes[child] = createNode('COMPONENT', {id: child, parentId: id, ...(rng.chance(0.5) ? {remote} : {})});
          doc.nodes[id].children!.push(child);
          return `remote COMPONENT_SET ${id} on the library page, its variant ${doc.nodes[child].remote ? 'with' : 'without'} remote`;
        }
        default:
          library.type = rng.pick(['FRAME', 'PAGE'] as const);
          library.parentId = library.type === 'PAGE' ? null : doc.pages[0];
          return `the library page as ${library.type}`;
      }
    },
  },
  'struct-instance': {
    weight: 4,
    run: (doc, rng) => {
      const copies = Object.values(doc.nodes).filter(node => node.mainId !== undefined);
      const instances = Object.values(doc.nodes).filter(node => node.type === 'INSTANCE' && node.mainId === undefined);
      switch (rng.int(6)) {
        case 0: {
          const node = rng.pick(copies);
          if (!node) return null;
          delete node.mainId;
          return `${node.id} loses mainId`;
        }
        case 1: {
          const node = rng.pick(copies);
          if (!node) return null;
          node.mainId = rng.pick(['other', node.mainId + 'x', node.id.split(';').slice(1).join(';'), node.id.split(';').pop()!]);
          return `${node.id}.mainId := ${node.mainId}`;
        }
        case 2: {
          const node = rng.pick(nonPages(doc.nodes).filter(node => !node.id.includes(';')));
          if (!node) return null;
          node.mainId = 'm1';
          return `${node.id} (no ";") gets mainId`;
        }
        case 3: {
          // A copy moved out of its instance (to the page).
          const node = rng.pick(copies);
          if (!node) return null;
          const page = doc.nodes[doc.pages[0]];
          unlist(doc.nodes, node.parentId, node.id);
          node.parentId = page.id;
          page.children!.push(node.id);
          return `copy ${node.id} moved to page ${page.id}`;
        }
        case 4: {
          // A new copy under an instance: right or wrong prefix, at its top or deeper.
          const instance = rng.pick(instances);
          if (!instance?.children) return null;
          const main = 'm' + rng.int(10);
          const right = rng.chance(0.6);
          const id = right ? `${instance.id};${main}` : `x${rng.int(10)};${main}`;
          if (doc.nodes[id]) return null;
          doc.nodes[id] = createNode('RECTANGLE', {id, parentId: instance.id, mainId: main});
          instance.children.push(id);
          return `copy ${id} under instance ${instance.id} (${right ? 'its prefix' : 'another prefix'})`;
        }
        default: {
          const instance = rng.pick(instances.filter(node => node.children?.some(id => doc.nodes[id]?.mainId !== undefined)));
          if (!instance) return null;
          instance.type = rng.pick(['FRAME', 'COMPONENT', 'GROUP'] as const);
          return `instance ${instance.id} becomes ${instance.type} with its copies`;
        }
      }
    },
  },
  'struct-text': {
    weight: 4,
    run: (doc, rng) => {
      const texts = Object.values(doc.nodes).filter(node => node.type === 'TEXT' && node.text);
      const node = rng.pick(texts);
      if (!node) {
        const other = rng.pick(nonPages(doc.nodes));
        if (!other) return null;
        other.text = {characters: 'x', style: {fontFamily: 'Inter', fontWeight: 400, italic: false, fontSize: 12, lineHeight: {unit: 'AUTO'}, letterSpacing: {unit: 'PIXELS', value: 0}, textDecoration: 'NONE', textCase: 'ORIGINAL'}, runs: [], textAlignHorizontal: 'LEFT', textAlignVertical: 'TOP', textAutoResize: 'NONE', paragraphSpacing: 0, paragraphIndent: 0};
        return `text on ${other.type} ${other.id}`;
      }
      const text = node.text!;
      const n = text.characters.length;
      switch (rng.int(8)) {
        case 0:
          text.runs = [{start: 0, end: n, style: {}}];
          return `one run over all ${n} units`;
        case 1:
          text.runs = [{start: 0, end: n + 1, style: {}}];
          return `a run past the end (${n + 1} > ${n})`;
        case 2:
          text.runs = [{start: 1, end: 1, style: {}}];
          return 'an empty run';
        case 3:
          text.runs = n >= 3 ? [{start: 0, end: 2, style: {}}, {start: 1, end: 3, style: {}}] : [{start: 0, end: 1, style: {}}, {start: 0, end: 1, style: {}}];
          return 'overlapping runs';
        case 4:
          text.runs = n >= 4 ? [{start: 2, end: 4, style: {}}, {start: 0, end: 2, style: {}}] : [{start: 1, end: 2, style: {}}, {start: 0, end: 1, style: {}}];
          return 'runs out of order';
        case 5:
          text.characters = text.characters.slice(0, Math.floor(n / 2));
          return `characters cut to ${text.characters.length} with ${text.runs.length} runs`;
        case 6:
          if (n < 2) return null;
          text.runs = [{start: 0, end: 1, style: {fontWeight: 700}}, {start: 1, end: n, style: {italic: true}}];
          return 'adjacent runs';
        default:
          delete node.text;
          return `TEXT ${node.id} without text`;
      }
    },
  },
  'struct-type': {
    weight: 4,
    run: (doc, rng) => {
      const node = rng.pick(nonPages(doc.nodes));
      if (!node) return null;
      switch (rng.int(5)) {
        case 0:
          node.children = node.children ?? [];
          return `${node.type} ${node.id} with a children list`;
        case 1:
          if (!node.children) return null;
          if (node.children.length) return null;
          delete node.children;
          return `container ${node.id} without children`;
        case 2: {
          const groups = Object.values(doc.nodes).filter(other => (other.type === 'GROUP' || other.type === 'BOOLEAN_OPERATION') && other.children?.length);
          const group = rng.pick(groups);
          if (!group) return null;
          for (const child of group.children!) {
            const childNode = doc.nodes[child];
            if (childNode) childNode.parentId = 'detached';
          }
          group.children = [];
          return `empty ${group.type} ${group.id} (its layers detached)`;
        }
        case 3: {
          const before = node.type;
          node.type = rng.pick(['FRAME', 'GROUP', 'RECTANGLE', 'TEXT', 'SECTION', 'BOOLEAN_OPERATION', 'VECTOR', 'SLICE', 'COMPONENT_SET', 'INSTANCE'] as const);
          return `${node.id} ${before} → ${node.type}`;
        }
        default:
          if (node.type === 'TEXT') return null;
          node.textPath = {commands: [{type: 'M', x: 0, y: 0}, {type: 'L', x: 10, y: 0}], startOffset: 0, side: 'LEFT'};
          return `textPath on ${node.type} ${node.id}`;
      }
    },
  },
  'struct-lists': {
    weight: 3,
    run: (doc, rng) => {
      const node = rng.pick(Object.values(doc.nodes));
      const measurement = (id: string) => ({id, start: {nodeId: 'a', side: 'LEFT' as const}, end: {nodeId: 'b', side: 'RIGHT' as const}, offset: {type: 'INNER' as const, relative: 0.5}});
      const annotation = (id: string) => ({id, label: 'x'});
      switch (rng.int(4)) {
        case 0:
          node.measurements = [measurement('m1'), ...(rng.chance(0.5) ? [measurement(rng.pick(['m1', 'm2']))] : [])];
          return `${node.measurements.length} measurements on ${node.type} ${node.id}${node.measurements.length > 1 && node.measurements[1].id === 'm1' ? ' (repeated id)' : ''}`;
        case 1:
          node.annotations = [annotation('a1'), ...(rng.chance(0.5) ? [annotation(rng.pick(['a1', 'a2']))] : [])];
          return `${node.annotations.length} annotations on ${node.type} ${node.id}${node.annotations.length > 1 && node.annotations[1].id === 'a1' ? ' (repeated id)' : ''}`;
        case 2: {
          const withList = Object.values(doc.nodes).find(other => other.annotations?.length || other.measurements?.length);
          if (!withList) return null;
          const field = withList.annotations?.length ? 'annotations' : 'measurements';
          const list = withList[field] as {id: string}[];
          list.push({...structuredClone(list[0])});
          return `${withList.id}.${field}: id ${list[0].id} repeated`;
        }
        default: {
          // The 100 000-command cap itself is in specialDocuments() (a mutant that size would dominate the run).
          const id = fresh(doc.nodes, 'vec');
          const parent = rng.pick(containers(doc.nodes));
          const paths = rng.range(0, 3);
          doc.nodes[id] = createNode('VECTOR', {
            id, parentId: parent.id,
            vectorPaths: Array.from({length: paths}, () => ({windingRule: rng.pick(['NONZERO', 'EVENODD'] as const), commands: Array.from({length: rng.range(0, 6)}, (_, i) => (i % 3 ? {type: 'L' as const, x: i, y: -i} : {type: 'M' as const, x: 0, y: i}))})),
          });
          parent.children!.push(id);
          return `a new vector of ${paths} paths under ${parent.type} ${parent.id}`;
        }
      }
    },
  },
  'struct-keys': {
    weight: 3,
    run: (doc, rng) => {
      const tables = (['styles', 'variables', 'variableCollections', 'nodes'] as const).filter(table => Object.keys(doc[table]).length);
      if (!tables.length) return null;
      const table = rng.pick(tables);
      const map = doc[table] as Record<string, {id: string}>;
      const key = rng.pick(Object.keys(map).filter(key => !key.startsWith('@@RAW')));
      if (key === undefined || !W.isPlainObject(map[key])) return null;
      if (rng.chance(0.5)) {
        map[key].id = key + 'x';
        return `${table}.${key}.id := ${key}x`;
      }
      // Re-key: the entry under a new key with its id (valid for styles and variables, breaks references nobody checks).
      const to = key + '2';
      if (Object.hasOwn(map, to) || table === 'nodes') return null;
      map[to] = {...map[key], id: to};
      delete map[key];
      return `${table}: ${key} re-keyed to ${to} with its id`;
    },
  },
  'struct-depth': {
    weight: 2,
    run: (doc, rng) => {
      const parent = rng.pick(containers(doc.nodes).filter(node => node.mainId === undefined && node.type !== 'INSTANCE'));
      if (!parent) return null;
      const depth = depthOf(doc.nodes, parent.id);
      const target = rng.pick([L.depth, L.depth + 1, L.depth - 1]);
      let at = parent.id;
      for (let level = depth + 1; level < target; level++) {
        const id = fresh(doc.nodes, 'deep');
        doc.nodes[id] = createNode('FRAME', {id, parentId: at});
        doc.nodes[at].children!.push(id);
        at = id;
      }
      const leaf = fresh(doc.nodes, 'deep');
      doc.nodes[leaf] = createNode('RECTANGLE', {id: leaf, parentId: at});
      doc.nodes[at].children!.push(leaf);
      return `a chain under ${parent.id} (depth ${depth}) to a leaf at depth ${depthOf(doc.nodes, leaf)}`;
    },
  },
  'struct-remove': {
    weight: 2,
    run: (doc, rng) => {
      const node = rng.pick(nonPages(doc.nodes).filter(node => !node.children?.length));
      if (!node) return null;
      delete doc.nodes[node.id];
      if (rng.chance(0.5)) {
        unlist(doc.nodes, node.parentId, node.id);
        return `leaf ${node.id} removed with its listing`;
      }
      return `leaf ${node.id} removed, still listed by ${node.parentId}`;
    },
  },
};

// ── Trimming a fixture to a small valid document ─────────────────────────────────────────────────

function subtree(nodes: Nodes, rootId: NodeId, out: NodeId[] = []): NodeId[] {
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    out.push(id);
    for (const child of nodes[id]?.children ?? []) stack.push(child);
  }
  return out;
}
/** A subtree whose instance copies all have their instance inside it (so it may move to another parent). */
function selfContained(nodes: Nodes, ids: NodeId[]): boolean {
  const inside = new Set(ids);
  for (const id of ids) {
    const node = nodes[id];
    if (node.mainId === undefined) continue;
    let ok = false;
    for (let at = nodes[node.parentId!]; at && inside.has(at.id); at = nodes[at.parentId!]) if (at.type === 'INSTANCE' && id === at.id + ';' + node.mainId) ok = true;
    if (!ok) return false;
  }
  return true;
}

/** Whole subtrees of one to three pages (and the library page sometimes), at most `budget` layers; deep subtrees too big to
 *  keep whole are lifted onto their page when they carry their instances with them. */
export function trimDocument(doc: DesignDocument, rng: Rng, budget: number): DesignDocument {
  const nodes = doc.nodes;
  const pageIds = rng.shuffle([...doc.pages]).slice(0, rng.range(1, Math.min(3, doc.pages.length)));
  const keepPages = doc.pages.filter(id => pageIds.includes(id));
  const roots = [...keepPages];
  if (nodes[LIBRARY_PAGE_ID] && rng.chance(0.6)) roots.push(LIBRARY_PAGE_ID);
  const out: Nodes = {};
  let left = budget;
  for (const pageId of roots) {
    const page = {...structuredClone({...nodes[pageId], children: undefined}), children: [] as NodeId[]};
    out[pageId] = page;
    const kept: NodeId[] = [];
    for (const childId of rng.shuffle([...(nodes[pageId].children ?? [])])) {
      if (left <= 0) break;
      let ids = subtree(nodes, childId);
      let rootId = childId;
      if (ids.length > left) {
        if (pageId === LIBRARY_PAGE_ID || rng.chance(0.4)) continue;
        // Walk down to a subtree that fits and can stand on the page by itself.
        let found = false;
        for (let at = childId, guard = 0; guard < 40; guard++) {
          const kids = (nodes[at].children ?? []).filter(id => nodes[id]);
          if (!kids.length) break;
          at = rng.pick(kids);
          const candidate = subtree(nodes, at);
          if (candidate.length <= left && nodes[at].mainId === undefined && selfContained(nodes, candidate)) {
            ids = candidate;
            rootId = at;
            found = true;
            break;
          }
        }
        if (!found) continue;
      }
      for (const id of ids) out[id] = structuredClone(nodes[id]);
      out[rootId].parentId = pageId;
      kept.push(rootId);
      left -= ids.length;
    }
    const order = new Map((nodes[pageId].children ?? []).map((id, i) => [id, i]));
    page.children = kept.sort((a, b) => (order.get(a) ?? 1e9) - (order.get(b) ?? 1e9));
  }
  const trimmed: DesignDocument = {...structuredClone({...doc, nodes: {}, variableModes: undefined}), pages: keepPages, nodes: out};
  if (doc.variableModes) trimmed.variableModes = structuredClone(Object.fromEntries(Object.entries(doc.variableModes).filter(([id]) => out[id])));
  if (!trimmed.variableModes) delete trimmed.variableModes;
  return trimmed;
}

// ── Patches ──────────────────────────────────────────────────────────────────────────────────────

/** A patch the way the editor makes them: whole entries replaced or removed (null), sometimes a page order. */
export function basePatch(doc: DesignDocument, rng: Rng): Obj {
  const patch: Obj = {};
  const subset = <T>(map: Record<string, T>, max: number, prefix: string) => {
    const out: Record<string, T | null> = {};
    const keys = rng.shuffle(Object.keys(map)).slice(0, rng.range(1, max));
    for (const key of keys) out[key] = rng.chance(0.2) ? null : structuredClone(map[key]);
    if (keys.length && rng.chance(0.15)) {
      const from = rng.pick(keys);
      const id = prefix + rng.int(1000);
      if (map[from] && typeof map[from] === 'object') out[id] = {...structuredClone(map[from]), ...('id' in (map[from] as object) ? {id} : {})} as T;
    }
    return out;
  };
  if (rng.chance(0.85)) patch.nodes = subset(doc.nodes, 12, 'new');
  if (rng.chance(0.25)) patch.pages = rng.shuffle([...doc.pages]).slice(0, rng.range(1, doc.pages.length));
  if (rng.chance(0.3) && Object.keys(doc.styles).length) patch.styles = subset(doc.styles, 4, 's');
  if (rng.chance(0.2) && Object.keys(doc.images).length) patch.images = subset(doc.images, 3, 'img');
  if (rng.chance(0.2) && Object.keys(doc.variableCollections).length) patch.variableCollections = subset(doc.variableCollections, 2, 'c');
  if (rng.chance(0.2) && Object.keys(doc.variables).length) patch.variables = subset(doc.variables, 4, 'v');
  if (rng.chance(0.2)) patch.variableModes = doc.variableModes && Object.keys(doc.variableModes).length ? subset(doc.variableModes, 3, 'n') : {n1: {c1: 'm1'}, n2: null};
  if (rng.chance(0.03)) return structuredClone(doc) as unknown as Obj;
  return patch;
}

// ── Mutants ──────────────────────────────────────────────────────────────────────────────────────

export type Base = {name: string; doc: DesignDocument};

/** The top-level field a mutation works in, weighted, and its places. */
function regionLocs(draft: Draft, rootSchema: W.Schema, rng: Rng, weights: Record<string, number>): Loc[] {
  const root = draft.value as Obj;
  if (!W.isPlainObject(root)) return [];
  const shape = W.objectShape(W.unwrap(rootSchema).core);
  const field = rng.weighted(Object.keys(shape).map(name => [name, weights[name] ?? 1] as const));
  const value = root[field];
  const schema = shape[field];
  const core = W.unwrap(schema).core;
  const entries = W.isPlainObject(value) ? Object.keys(value).filter(key => !key.startsWith('@@RAW')) : [];
  if (W.kindOf(core) === 'ZodRecord' && entries.length && rng.chance(0.85)) {
    const key = rng.pick(entries);
    // The table itself (keys, size) and every place in one entry.
    const locs: Loc[] = [{path: [field], schema, parent: root, key: field, present: true}];
    return locate(W.defOf(core).valueType, value as Obj, key, [field, key], locs);
  }
  // The document's own fields (never the document itself: specialDocuments() covers non-objects).
  if (rng.chance(0.2)) return locate(rootSchema, draft as unknown as Obj, 'value', []).filter(loc => loc.path.length === 1);
  return locate(schema, root, field, [field]);
}

export type MutantOptions = {seed: number; count: number; minNodes?: number; maxNodes?: number};

const DOCUMENT_WEIGHTS = {nodes: 70, pages: 4, styles: 6, images: 3, variableCollections: 3, variables: 6, variableModes: 3, schemaVersion: 1, board: 1};
const PATCH_WEIGHTS = {nodes: 60, pages: 8, styles: 8, images: 5, variableCollections: 5, variables: 8, variableModes: 6};

function chooseKind(rng: Rng, structural: boolean): {name: string; generic?: Operator; structural?: Structural} {
  const entries: [string, number][] = [
    ...Object.entries(GENERIC).map(([name, {weight}]) => [name, weight] as [string, number]),
    ...Object.entries(TEXTUAL).map(([name, {weight}]) => [name, weight] as [string, number]),
    ...(structural ? Object.entries(STRUCTURAL).map(([name, {weight}]) => [name, weight * 1.6] as [string, number]) : []),
  ];
  const name = rng.weighted(entries);
  if (GENERIC[name]) return {name, generic: GENERIC[name].run};
  if (TEXTUAL[name]) return {name, generic: TEXTUAL[name].run};
  return {name, structural: STRUCTURAL[name].run};
}

function mutateOnce(draft: Draft, rootSchema: W.Schema, rng: Rng, weights: Record<string, number>, structural: boolean): Mutation | null {
  for (let attempt = 0; attempt < 30; attempt++) {
    const kind = chooseKind(rng, structural);
    // An earlier mutation may have broken the shape a later one walks (a table retyped to a string): the later one stops
    // where it fails, and the mutant says so.
    try {
      if (kind.structural) {
        const detail = kind.structural(draft.value as DesignDocument, rng);
        if (detail) return {kind: kind.name, detail};
        continue;
      }
      const locs = regionLocs(draft, rootSchema, rng, weights);
      const mutation = kind.generic!({rng, draft, locs});
      if (mutation) return mutation;
    } catch (error) {
      return {kind: kind.name, detail: `stopped midway on the broken shape (${String((error as Error).message ?? error).slice(0, 80)})`};
    }
  }
  return null;
}

function* mutants(bases: Base[], options: MutantOptions, patch: boolean): Generator<Mutant> {
  const rng = new Rng(options.seed);
  const weights = bases.map(base => [base, Math.max(1, Math.round(10 / Math.log10(10 + Object.keys(base.doc.nodes).length)))] as const);
  for (let id = 0; id < options.count; id++) {
    const base = rng.weighted(weights);
    const doc = trimDocument(base.doc, rng, rng.range(options.minNodes ?? 3, options.maxNodes ?? 60));
    const draft = new Draft(patch ? basePatch(doc, rng) : doc);
    const kinds: string[] = [],
      details: string[] = [],
      paths: string[] = [];
    const steps = rng.weighted([[1, 6], [2, 3], [3, 1]] as const);
    let separator: string | undefined;
    for (let step = 0; step < steps; step++) {
      const mutation = mutateOnce(draft, patch ? documentPatchSchema : designDocumentSchema, rng, patch ? PATCH_WEIGHTS : DOCUMENT_WEIGHTS, !patch);
      if (!mutation) continue;
      if (mutation.kind === 'whitespace') separator = rng.pick(['\t', ' ', '  ']);
      kinds.push(mutation.kind);
      details.push(mutation.detail);
      if (mutation.path) paths.push(mutation.path);
    }
    if (!kinds.length) kinds.push('none'), details.push('no mutation applied (the trimmed document as it is)');
    const text = draft.text(separator);
    // A place reached through a spliced key or id reads with its raw text, "…".
    const resolve = (line: string) => line.replace(/@@RAW\d+@@/g, marker => `"${draft.rawText(marker)}"`);
    yield {id, base: base.name, kinds, details: details.map(resolve), paths: paths.map(resolve), marks: draft.marks, text};
  }
}

/** `count` seeded mutants of trimmed fixture documents. */
export const documentMutants = (bases: Base[], options: MutantOptions) => mutants(bases, options, false);
/** `count` seeded mutants of patches built from trimmed fixture documents. */
export const patchMutants = (bases: Base[], options: MutantOptions) => mutants(bases, options, true);

// ── One-off documents at the caps ────────────────────────────────────────────────────────────────

export type Special = {name: string; build: () => string};
const smallDoc = (): DesignDocument => {
  const page = createNode('PAGE', {id: 'p', name: 'Page'});
  return {schemaVersion: 1, pages: ['p'], nodes: {p: page}, styles: {}, images: {}, variableCollections: {}, variables: {}};
};
const withChildren = (doc: DesignDocument, count: number, make: (id: string) => SceneNode) => {
  for (let i = 0; i < count; i++) {
    const node = make('n' + i);
    doc.nodes[node.id] = node;
    doc.nodes.p.children!.push(node.id);
  }
  return doc;
};
const textNode = (characters: string, extra: Partial<NonNullable<SceneNode['text']>> = {}) => {
  const node = createNode('TEXT', {id: 't', parentId: 'p'});
  node.text = {...node.text!, characters, ...extra};
  return node;
};
const oneNode = (node: SceneNode) => {
  const doc = smallDoc();
  doc.nodes[node.id] = node;
  doc.nodes.p.children!.push(node.id);
  return doc;
};
const variablesDoc = (count: number, modes = 1): DesignDocument => {
  const doc = smallDoc();
  const modeIds = Array.from({length: modes}, (_, i) => 'm' + i);
  doc.variableCollections = {c: {id: 'c', name: 'C', modes: modeIds.map(modeId => ({modeId, name: modeId})), defaultModeId: 'm0', variableIds: []}};
  for (let i = 0; i < count; i++) doc.variables['v' + i] = {id: 'v' + i, name: 'v', collectionId: 'c', type: 'FLOAT', valuesByMode: Object.fromEntries(modeIds.map(id => [id, i])), description: ''};
  return doc;
};
const json = (value: unknown) => () => JSON.stringify(value);

/** Documents exactly at and one past each cap that a random mutant cannot reach cheaply. */
export function specialDocuments(): Special[] {
  const list: Special[] = [];
  const both = (name: string, cap: number, build: (n: number) => unknown) => {
    list.push({name: `${name} at the cap (${cap})`, build: () => JSON.stringify(build(cap))});
    list.push({name: `${name} past the cap (${cap + 1})`, build: () => JSON.stringify(build(cap + 1))});
  };
  both('pages', DESIGN_DOCUMENT_CAPS.pages, n => {
    const doc = smallDoc();
    for (let i = 1; i < n; i++) {
      doc.nodes['p' + i] = createNode('PAGE', {id: 'p' + i});
      doc.pages.push('p' + i);
    }
    return doc;
  });
  both('layers', DESIGN_DOCUMENT_CAPS.nodes, n => withChildren(smallDoc(), n - 1, id => createNode('RECTANGLE', {id, parentId: 'p'})));
  both('path commands of one vector', L.pathCommands, n => oneNode(createNode('VECTOR', {id: 'v', parentId: 'p', vectorPaths: [{windingRule: 'NONZERO', commands: Array.from({length: n - 1}, () => ({type: 'Z' as const}))}, {windingRule: 'NONZERO', commands: [{type: 'M', x: 0, y: 0}]}]})));
  both('commands of one path', L.pathCommands, n => oneNode(createNode('VECTOR', {id: 'v', parentId: 'p', vectorPaths: [{windingRule: 'NONZERO', commands: Array.from({length: n}, () => ({type: 'Z' as const}))}]})));
  both('vector paths', L.vectorPaths, n => oneNode(createNode('VECTOR', {id: 'v', parentId: 'p', vectorPaths: Array.from({length: n}, () => ({windingRule: 'NONZERO' as const, commands: []}))})));
  both('nesting depth', L.depth, n => {
    const doc = smallDoc();
    let parent = 'p';
    for (let i = 0; i < n - 1; i++) {
      doc.nodes['d' + i] = createNode('FRAME', {id: 'd' + i, parentId: parent});
      doc.nodes[parent].children!.push('d' + i);
      parent = 'd' + i;
    }
    doc.nodes.leaf = createNode('RECTANGLE', {id: 'leaf', parentId: parent});
    doc.nodes[parent].children!.push('leaf');
    return doc;
  });
  both('text characters', L.characters, n => oneNode(textNode('я'.repeat(n))));
  both('text characters in astral units', L.characters, n => oneNode(textNode('😀'.repeat(Math.floor(n / 2)) + (n % 2 ? 'a' : ''))));
  both('text runs', L.textRuns, n => oneNode(textNode('a'.repeat(n), {runs: Array.from({length: n}, (_, i) => ({start: i, end: i + 1, style: {}}))})));
  both('list types', L.listTypes, n => oneNode(textNode('', {listTypes: Array.from({length: n}, () => 'NONE' as const)})));
  both('styles', L.styles, n => ({...smallDoc(), styles: Object.fromEntries(Array.from({length: n}, (_, i) => ['s' + i, {id: 's' + i, type: 'FILL', name: '', description: ''}]))}));
  both('images', L.images, n => ({...smallDoc(), images: Object.fromEntries(Array.from({length: n}, (_, i) => ['i' + i, {url: `/uploads/i${i}.png`, width: 1, height: 1}]))}));
  both('variables', L.variables, n => variablesDoc(n));
  both('modes of a variable', L.modes, n => variablesDoc(1, n));
  both('variable collections', L.variableCollections, n => ({...smallDoc(), variableCollections: Object.fromEntries(Array.from({length: n}, (_, i) => ['c' + i, {id: 'c' + i, name: '', modes: [{modeId: 'm', name: ''}], defaultModeId: 'm', variableIds: []}]))}));
  both('variable mode choices', DESIGN_DOCUMENT_CAPS.nodes, n => ({...smallDoc(), variableModes: Object.fromEntries(Array.from({length: n}, (_, i) => ['n' + i, {c: 'm'}]))}));
  both('mode choices of one layer', L.variableCollections, n => ({...smallDoc(), variableModes: {p: Object.fromEntries(Array.from({length: n}, (_, i) => ['c' + i, 'm']))}}));
  list.push({name: 'an empty JSON object', build: json({})});
  list.push({name: 'an array', build: json([])});
  list.push({name: 'null', build: () => 'null'});
  list.push({name: 'a string', build: () => '"x"'});
  list.push({name: 'a number', build: () => '1'});
  list.push({name: 'trailing whitespace', build: () => JSON.stringify(smallDoc()) + ' \t '});
  list.push({name: 'leading whitespace', build: () => '  ' + JSON.stringify(smallDoc())});
  for (const total of [127, 128, 129, 1023, 1024, 1025]) {
    // The document is level 1: an unknown key at its root holding `total - 1` levels of arrays.
    list.push({name: `unknown key at the root, text ${total} levels deep`, build: () => JSON.stringify(smallDoc()).replace(/}$/, ',"deep":' + '['.repeat(total - 1) + ']'.repeat(total - 1) + '}')});
    // Inside a paint (a buffered union): document 1, nodes 2, node 3, fills 4, paint 5.
    list.push({
      name: `unknown key inside a paint, text ${total} levels deep`,
      build: () => JSON.stringify(oneNode(createNode('RECTANGLE', {id: 'r', parentId: 'p'}))).replace('"blendMode":"NORMAL"}]', '"blendMode":"NORMAL","deep":' + '['.repeat(total - 5) + ']'.repeat(total - 5) + '}]'),
    });
  }
  list.push({name: 'deeply nested unknown field (512 levels)', build: () => JSON.stringify({...smallDoc(), extra: JSON.parse('['.repeat(512) + ']'.repeat(512))})});
  list.push({name: 'deeply nested unknown field (100 000 levels)', build: () => JSON.stringify(smallDoc()).replace(/}$/, ',"extra":' + '['.repeat(100_000) + ']'.repeat(100_000) + '}')});
  return list;
}

/** Patches at the caps of validatePatch. */
export function specialPatches(): Special[] {
  const node = createNode('RECTANGLE', {id: 'r', parentId: 'p'});
  return [
    {name: 'an empty patch', build: json({})},
    {name: 'pages: []', build: json({pages: []})},
    {name: 'nodes: null', build: json({nodes: null})},
    {name: 'every table empty', build: json({nodes: {}, styles: {}, images: {}, variableCollections: {}, variables: {}, variableModes: {}})},
    {name: 'node removals at the cap', build: json({nodes: Object.fromEntries(Array.from({length: DESIGN_DOCUMENT_CAPS.nodes}, (_, i) => ['n' + i, null]))})},
    {name: 'node removals past the cap', build: json({nodes: Object.fromEntries(Array.from({length: DESIGN_DOCUMENT_CAPS.nodes + 1}, (_, i) => ['n' + i, null]))})},
    {name: 'pages at the cap', build: json({pages: Array.from({length: DESIGN_DOCUMENT_CAPS.pages}, (_, i) => 'p' + i)})},
    {name: 'pages past the cap', build: json({pages: Array.from({length: DESIGN_DOCUMENT_CAPS.pages + 1}, (_, i) => 'p' + i)})},
    {name: 'a node entry and a __proto__ entry', build: () => JSON.stringify({nodes: {r: node}}).replace('{"r":', '{"__proto__":null,"r":')},
    {name: 'a whole document as a patch', build: () => JSON.stringify({schemaVersion: 1, pages: ['p'], nodes: {p: createNode('PAGE', {id: 'p'}), r: node}, styles: {}, images: {}, variableCollections: {}, variables: {}, board: true})},
  ];
}
