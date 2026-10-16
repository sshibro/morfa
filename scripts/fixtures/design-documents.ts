// Writes the document fixtures of the Rust `model` crate's round-trip and zod-parity checks:
// fixtures/documents/<name>.json (JSON.stringify, no indentation) and fixtures/documents/index.json (name, bytes, layer count,
// source, sha256). The set: the 20 041-layer page and the product file of tests/helpers/design-big-files.ts (the latter also
// with 60 pictures), every starter template, every board template, the unit tests' documents and hand-built ones that set
// every optional field of a layer and every variant of every union of shared/design/types.ts (scripts/model/documents.ts).
// Every fixture passes `validateDocument`; the script prints which schema points the set covers and which it misses.
//
//   npx tsx scripts/fixtures/design-documents.ts            write the fixtures, print the index and the coverage
//   npx tsx scripts/fixtures/design-documents.ts --strict   also exit 1 when a layer field or a union variant is never covered
//
// Deterministic: ids, `Math.random` and `Date.now` are seeded per fixture, so every run writes the same bytes.

import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import type {DesignDocument, ImageAsset} from '../../shared/design/types';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const FIXTURES_DIR = path.join(repo, 'fixtures', 'documents');
export const INDEX_FILE = path.join(FIXTURES_DIR, 'index.json');

export type FixtureEntry = {
  name: string;
  file: string;
  bytes: number;
  nodes: number;
  /** Where the document comes from (a builder of the repo). */
  source: string;
  /** heavy: the 16 MB page, kept out of the mutation fuzz; large: hundreds of KB; small: the rest. */
  size: 'heavy' | 'large' | 'small';
  sha256: string;
};

// ── Determinism ──────────────────────────────────────────────────────────────────────────────────

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hash32 = (text: string) => createHash('sha256').update(text).digest().readUInt32LE(0);
let random = mulberry32(1);
/** Every source of randomness the builders reach (`newId`'s `crypto.getRandomValues`, `Math.random`, `Date.now`) is seeded. */
function installDeterminism() {
  const fixed = Date.UTC(2026, 9, 7);
  Date.now = () => fixed;
  Math.random = () => random();
  const getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array) {
      const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(random() * 256);
    }
    return array;
  };
  Object.defineProperty(globalThis.crypto, 'getRandomValues', {value: getRandomValues, configurable: true, writable: true});
}
const reseed = (name: string) => (random = mulberry32(hash32(name)));
/** Ids for builders that take a generator: short, readable, one counter per fixture. */
const counter = (prefix: string) => {
  let n = 0;
  return () => `${prefix}${(++n).toString(36)}`;
};

// ── The set ──────────────────────────────────────────────────────────────────────────────────────

/** `skip`: why the fixture cannot be built in this checkout (printed, never silent). */
type Builder = {name: string; source: string; build: () => DesignDocument; skip?: string};

async function builders(): Promise<Builder[]> {
  installDeterminism();
  // Imported after the stubs are in place, in case a module draws an id when it loads.
  const big = await import('../../tests/helpers/design-big-files');
  const templates = await import('../../shared/design/templates/index');
  const board = await import('../../shared/design/board/templates');
  const {createBoardDocument} = await import('../../shared/design/board/document');
  const {installBoardSteps} = await import('../../shared/design/board/install');
  const {beginTransaction} = await import('../../shared/design/transaction');
  const codegen = await import('../../tests/design-codegen-fixture');
  const docs = await import('../model/documents');
  let figma: typeof import('../../shared/design/figma-import') | null = null,
    figmaMissing = '';
  try {
    figma = await import('../../shared/design/figma-import');
  } catch (error) {
    figmaMissing = String((error as Error).message ?? error).split('\n')[0];
  }

  const pictures: Record<string, ImageAsset> = {};
  // The Cyrillic file names are non-ASCII test data for the codec parity checks (they stay Russian).
  for (let k = 1; k <= 60; k++) pictures['img' + k] = {url: `/uploads/img${k}.png`, width: 400 + k * 16, height: 300 + ((k * 37) % 500), ...(k % 3 ? {} : {name: `Фото ${k}.png`})};

  const list: Builder[] = [
    {name: 'heavy-page', source: 'tests/helpers/design-big-files.ts heavyPage()', build: big.heavyPage},
    {name: 'product-file', source: 'tests/helpers/design-big-files.ts productFile()', build: () => big.productFile()},
    {name: 'product-file-images', source: 'tests/helpers/design-big-files.ts productFile(60 ImageAssets)', build: () => big.productFile(pictures)},
  ];
  for (const template of templates.DESIGN_TEMPLATES)
    list.push({name: 'template-' + template.id, source: `shared/design/templates DESIGN_TEMPLATES "${template.name}"`, build: () => template.build({measurer: big.testMeasurer, newId: counter('t')})});
  for (const template of board.BOARD_TEMPLATES)
    list.push({
      name: 'board-' + template.id,
      source: `shared/design/board/templates.ts "${template.name}" on a board`,
      build: () => {
        installBoardSteps();
        const doc = createBoardDocument('page');
        const tx = beginTransaction(doc);
        board.insertBoardTemplate(tx, board.buildBoardTemplate(template.id, counter('b')), 'page', {x: 1000, y: -400});
        return tx.commit({measurer: big.testMeasurer}).doc;
      },
    });
  list.push(
    {name: 'codegen-buttons', source: 'tests/design-codegen-fixture.ts buttonFile()', build: () => codegen.buttonFile().doc},
    {name: 'codegen-showcase', source: 'tests/design-codegen-fixture.ts showcaseFile()', build: codegen.showcaseFile},
    {name: 'schema-sample', source: 'tests/design-schema.test.ts sample()', build: docs.schemaSample},
    {name: 'instance-ids', source: 'tests/design-schema.test.ts instance copies', build: docs.instanceIds},
    {name: 'edges', source: 'scripts/model/documents.ts edges(): depth limit, bounds, astral text', build: docs.edges},
    {name: 'kitchen-sink', source: 'scripts/model/documents.ts kitchenSink(): every field and variant', build: docs.kitchenSink},
    {name: 'board-everything', source: 'scripts/model/documents.ts boardEverything(): every board object', build: () => docs.boardEverything(counter('o'))},
    {name: 'library-source', source: 'tests/design-libraries.test.ts libraryDoc()', build: docs.libraryDoc},
    {name: 'library-consumer', source: 'shared/design/libraries.ts applyLibraryImport of libraryDoc()', build: docs.libraryConsumer},
    {
      name: 'figma-import', source: 'shared/design/figma-import importFigmaFile (the tests\' landing and kit files)', build: () => docs.figmaImport(figma!),
      ...(figma ? {} : {skip: `the Figma importer does not load in this checkout (${figmaMissing})`}),
    },
    {name: 'svg-import', source: 'shared/design/svg-import.ts importSvg', build: docs.svgImport},
  );
  return list;
}

// ── Writing ──────────────────────────────────────────────────────────────────────────────────────

/** Keys a validation dropped (the builders should never produce any). */
function strippedKeys(before: unknown, after: unknown, at = '', out: string[] = []): string[] {
  if (Array.isArray(before) && Array.isArray(after)) before.forEach((item, i) => strippedKeys(item, after[i], `${at}[${i}]`, out));
  else if (before && after && typeof before === 'object' && typeof after === 'object')
    for (const [key, value] of Object.entries(before)) {
      if (!Object.hasOwn(after, key)) out.push(at + '.' + key);
      else strippedKeys(value, (after as Record<string, unknown>)[key], at + '.' + key, out);
    }
  return out;
}

export async function generateFixtures(options: {log?: (line: string) => void} = {}): Promise<{entries: FixtureEntry[]; docs: Map<string, DesignDocument>}> {
  const log = options.log ?? (() => {});
  const {validateDocument} = await import('../../shared/design/schema');
  fs.mkdirSync(FIXTURES_DIR, {recursive: true});
  const entries: FixtureEntry[] = [];
  const docs = new Map<string, DesignDocument>();
  const failures: string[] = [];
  for (const {name, source, build, skip} of await builders()) {
    if (skip) {
      log(`  SKIPPED ${name}: ${skip}`);
      continue;
    }
    reseed(name);
    let doc: DesignDocument;
    try {
      doc = build();
    } catch (error) {
      failures.push(`${name}: the builder threw ${(error as Error).stack ?? error}`);
      continue;
    }
    const raw = JSON.parse(JSON.stringify(doc));
    const result = validateDocument(JSON.parse(JSON.stringify(doc)));
    if (!result.ok) {
      failures.push(`${name}: validateDocument refused it: ${result.error} at ${result.path}`);
      continue;
    }
    const dropped = strippedKeys(raw, result.value);
    if (dropped.length) log(`  ${name}: validation dropped ${dropped.length} unknown keys (${dropped.slice(0, 5).join(', ')}…); the stripped document is written`);
    const text = JSON.stringify(result.value);
    const file = name + '.json';
    fs.writeFileSync(path.join(FIXTURES_DIR, file), text);
    const bytes = Buffer.byteLength(text);
    entries.push({
      name, file, bytes, nodes: Object.keys(result.value.nodes).length, source,
      size: name === 'heavy-page' ? 'heavy' : bytes > 500_000 ? 'large' : 'small',
      sha256: createHash('sha256').update(text).digest('hex'),
    });
    docs.set(name, result.value);
  }
  if (failures.length) throw Error('fixtures failed:\n' + failures.join('\n'));
  fs.writeFileSync(INDEX_FILE, JSON.stringify(entries, null, 1) + '\n');
  return {entries, docs};
}

export function readIndex(): FixtureEntry[] | null {
  try {
    return JSON.parse(fs.readFileSync(INDEX_FILE, 'utf8')) as FixtureEntry[];
  } catch {
    return null;
  }
}

/** The fixtures on disk, generated first when missing. */
export async function ensureFixtures(log?: (line: string) => void): Promise<FixtureEntry[]> {
  const index = readIndex();
  if (index && index.every(entry => fs.existsSync(path.join(FIXTURES_DIR, entry.file)))) return index;
  log?.('fixtures missing: generating them (scripts/fixtures/design-documents.ts)');
  return (await generateFixtures({log})).entries;
}

// ── Coverage ─────────────────────────────────────────────────────────────────────────────────────

export async function coverageReport(docs: Map<string, DesignDocument>): Promise<{lines: string[]; gaps: {fields: string[]; variants: string[]; enums: string[]}}> {
  const {designDocumentSchema, sceneNodeSchema} = await import('../../shared/design/schema');
  const walk = await import('../model/schema-walk');
  const lines: string[] = [];
  const seen = new Map<string, number>();
  for (const doc of docs.values()) walk.coverValue(designDocumentSchema, doc, seen);
  const points = walk.schemaPoints(designDocumentSchema);
  const count = (point: Parameters<typeof walk.pointKey>[0]) => seen.get(walk.pointKey(point)) ?? 0;
  const clean = (at: string) => at.replace(/^\./, '');

  // Layer fields: how many layers carry each, in how many fixtures.
  const keys = Object.keys(walk.objectShape(sceneNodeSchema));
  const perKey = new Map(keys.map(key => [key, {nodes: 0, fixtures: [] as string[]}]));
  for (const [name, doc] of docs)
    for (const key of keys) {
      let n = 0;
      for (const node of Object.values(doc.nodes)) if (Object.hasOwn(node, key)) n++;
      if (n) {
        perKey.get(key)!.nodes += n;
        perKey.get(key)!.fixtures.push(name);
      }
    }
  lines.push('', `SceneNode fields (${keys.length}): layers carrying each across the set, and how many fixtures`);
  const cells = keys.map(key => {
    const {nodes, fixtures} = perKey.get(key)!;
    return nodes ? `${key} ${nodes}/${fixtures.length}` : `${key} MISSING`;
  });
  for (let i = 0; i < cells.length; i += 4) lines.push('  ' + cells.slice(i, i + 4).map(cell => cell.padEnd(44)).join(''));
  const fieldGaps = keys.filter(key => !perKey.get(key)!.nodes);

  // Discriminated unions: every tag; plain unions: every option; nullable fields: null seen.
  const group = (kind: string) => {
    const byPath = new Map<string, {value: string; hits: number}[]>();
    for (const point of points.filter(p => p.kind === kind)) {
      const list = byPath.get(point.path) ?? [];
      list.push({value: point.value ?? 'null', hits: count(point)});
      byPath.set(point.path, list);
    }
    return byPath;
  };
  const variantGaps: string[] = [];
  lines.push('', 'Discriminated unions (type / kind / pattern / unit / offset tags): tag ×count');
  for (const [at, values] of group('tag')) {
    lines.push(`  ${clean(at)}: ${values.map(v => (v.hits ? `${v.value}×${v.hits}` : `${v.value} MISSING`)).join(', ')}`);
    for (const v of values) if (!v.hits) variantGaps.push(`${clean(at)} = ${v.value}`);
  }
  lines.push('', 'Plain unions (zod keeps the first option that parses): option ×count');
  for (const [at, values] of group('union')) {
    lines.push(`  ${clean(at)}: ${values.map(v => (v.hits ? `${v.value}×${v.hits}` : `${v.value} MISSING`)).join(', ')}`);
    for (const v of values) if (!v.hits) variantGaps.push(`${clean(at)} ${v.value}`);
  }
  lines.push('', 'Nullable fields stored as null: ×count');
  const nulls = [...group('null')].map(([at, [v]]) => (v.hits ? `${clean(at)}×${v.hits}` : `${clean(at)} MISSING`));
  for (const entry of nulls) lines.push('  ' + entry);
  for (const [at, [v]] of group('null')) if (!v.hits) variantGaps.push(`${clean(at)} = null`);

  // Every field of every nested object, and every enum value at every place.
  const nested = points.filter(p => p.kind === 'field' && !count(p) && !/^\.nodes\{\}\.[A-Za-z]+$/.test(p.path)).map(p => clean(p.path));
  const enums = points.filter(p => p.kind === 'enum');
  const enumGaps = enums.filter(p => !count(p)).map(p => `${clean(p.path)} = ${p.value}`);
  lines.push('', `Nested fields: ${points.filter(p => p.kind === 'field').length - nested.length - fieldGaps.length} covered, ${nested.length} never present${nested.length ? ':' : ''}`);
  for (const entry of nested) lines.push('  MISSING ' + entry);
  lines.push('', `Enum values at every place: ${enums.length - enumGaps.length} of ${enums.length} covered${enumGaps.length ? '; never seen:' : ''}`);
  for (const entry of enumGaps) lines.push('  MISSING ' + entry);
  return {lines, gaps: {fields: [...fieldGaps, ...nested], variants: variantGaps, enums: enumGaps}};
}

// ── Main ─────────────────────────────────────────────────────────────────────────────────────────

async function main() {
  const strict = process.argv.includes('--strict');
  const started = performance.now();
  const {entries, docs} = await generateFixtures({log: line => console.log(line)});
  console.log(`fixtures/documents: ${entries.length} documents in ${((performance.now() - started) / 1000).toFixed(1)} s`);
  const width = Math.max(...entries.map(entry => entry.name.length));
  for (const entry of entries)
    console.log(`  ${entry.name.padEnd(width)}  ${String(entry.bytes).padStart(9)} B  ${String(entry.nodes).padStart(6)} layers  ${entry.size.padEnd(5)}  ${entry.source}`);
  const {lines, gaps} = await coverageReport(docs);
  for (const line of lines) console.log(line);
  const blocking = [...gaps.fields, ...gaps.variants];
  console.log('');
  console.log(
    blocking.length
      ? `COVERAGE GAPS: ${gaps.fields.length} fields and ${gaps.variants.length} union variants / nulls never appear (listed above as MISSING); ${gaps.enums.length} enum values unseen`
      : `coverage: every layer field, nested field, union variant and nullable null appears; ${gaps.enums.length} enum values unseen`,
  );
  if (strict && blocking.length) process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error);
    process.exit(1);
  });
}
