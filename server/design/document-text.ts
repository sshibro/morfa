import type {DesignDocument, NodeId, SceneNode} from '../../shared/design/types';
import {tableCache} from '../../shared/design/table-cache';

// The stored JSON text of a document (docs/design-tool.md §Performance). A save changes a few entries of a document that may
// hold 20 000 layers in 16 MB of JSON; serializing all of it again took ~120 ms of the event loop per save, and handing the
// string to PostgreSQL encoded it once more. Documents are immutable (an entry a save did not touch is the same object in
// the next version), so the UTF-8 text of each entry is kept with the entry and the document's text is put together from
// those pieces: only the entries a save wrote are serialized. The result is byte for byte `JSON.stringify(doc)`
// (tests/design-document-text.test.ts), as a Buffer the database driver sends without encoding it again.

/** The tables whose entries are kept: objects keyed by id. */
const ENTRY_TABLES: ReadonlySet<string> = new Set(['nodes', 'styles', 'images', 'variableCollections', 'variables', 'variableModes']);

type Piece = {key: string; text: Buffer};
/** `"key":value` of an entry object, by the object. The key is checked: the same object under another key is serialized again. */
const pieces = new WeakMap<object, Piece>();

const OPEN = Buffer.from('{'), CLOSE = Buffer.from('}'), COMMA = Buffer.from(',');

/** JSON.stringify leaves out properties whose value it cannot write. */
const skipped = (value: unknown) => value === undefined || typeof value === 'function' || typeof value === 'symbol';

function entry(key: string, value: object): Buffer {
  const known = pieces.get(value);
  if (known && known.key === key) return known.text;
  const text = Buffer.from(JSON.stringify(key) + ':' + JSON.stringify(value));
  pieces.set(value, {key, text});
  return text;
}

/** The bytes of `"key":value` as the document's text writes it. */
const pieceBytes = (key: string, item: unknown) =>
  item !== null && typeof item === 'object' ? entry(key, item).length : Buffer.byteLength(JSON.stringify(key) + ':' + JSON.stringify(item));

/** `bytes`: the written entries' text, without the commas between them; `written`: how many are written; `count`: the table's own
 *  keys (`Object.keys(nodes).length`, what `node_count` always stored). */
type Totals = {bytes: number; written: number; count: number};
/**
 * The bytes of a node table's written entries (without the commas between them) and how many there are, by the table. A save's
 * table differs from the one it was made from only at the ids the save wrote (shared/design/patch.ts carries this along with the
 * other indexes, shared/design/table-cache.ts), so the size and the layer count of a 20 000-layer document cost what changed:
 * walking every entry took ~8 ms and counting the keys ~2.5 ms, each on every save.
 */
const nodeTotals = tableCache<Totals>((previous, before, after, changed) => {
  let {bytes, written, count} = previous;
  for (const id of new Set(changed)) {
    const had = Object.hasOwn(before, id),
      has = Object.hasOwn(after, id);
    const old: unknown = had ? before[id] : undefined,
      now: unknown = has ? after[id] : undefined;
    if (!skipped(old)) (bytes -= pieceBytes(id, old)), written--;
    if (!skipped(now)) (bytes += pieceBytes(id, now)), written++;
    count += Number(has) - Number(had);
  }
  return {bytes, written, count};
});
function totalsOf(nodes: Readonly<Record<NodeId, SceneNode>>): Totals {
  const known = nodeTotals.get(nodes);
  if (known) return known;
  const keys = Object.keys(nodes);
  let bytes = 0,
    written = 0;
  for (const key of keys) {
    const item: unknown = nodes[key];
    if (skipped(item)) continue;
    bytes += pieceBytes(key, item);
    written++;
  }
  const totals = {bytes, written, count: keys.length};
  nodeTotals.set(nodes, totals);
  return totals;
}
/** The layers of a document (`Object.keys(doc.nodes).length`), kept with its node table like its size. */
export const documentNodeCount = (doc: DesignDocument): number => (plainObject(doc.nodes) ? totalsOf(doc.nodes).count : Object.keys(doc.nodes).length);

function table(parts: Buffer[], value: Record<string, unknown>) {
  parts.push(OPEN);
  let first = true;
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (skipped(item)) continue;
    if (!first) parts.push(COMMA);
    first = false;
    parts.push(item !== null && typeof item === 'object' ? entry(key, item) : Buffer.from(JSON.stringify(key) + ':' + JSON.stringify(item)));
  }
  parts.push(CLOSE);
}

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype && typeof (value as {toJSON?: unknown}).toJSON !== 'function';

/** `Buffer.byteLength(JSON.stringify(doc))`, from the same kept pieces, without putting the text together. */
export function documentBytes(doc: DesignDocument): number {
  if (!plainObject(doc)) return Buffer.byteLength(JSON.stringify(doc));
  let bytes = 2,
    fields = 0;
  for (const key of Object.keys(doc)) {
    const value = (doc as unknown as Record<string, unknown>)[key];
    if (skipped(value)) continue;
    fields++;
    bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
    if (key === 'nodes' && plainObject(value)) {
      const totals = totalsOf(value as Record<NodeId, SceneNode>);
      bytes += 2 + totals.bytes + Math.max(0, totals.written - 1);
    } else if (ENTRY_TABLES.has(key) && plainObject(value)) {
      let entries = 0;
      bytes += 2;
      for (const name of Object.keys(value)) {
        const item = value[name];
        if (skipped(item)) continue;
        entries++;
        bytes += pieceBytes(name, item);
      }
      bytes += Math.max(0, entries - 1);
    } else bytes += Buffer.byteLength(JSON.stringify(value));
  }
  return bytes + Math.max(0, fields - 1);
}

/** `Buffer.from(JSON.stringify(doc))`, reusing the text of every entry serialized before. */
export function documentText(doc: DesignDocument): Buffer {
  if (!plainObject(doc)) return Buffer.from(JSON.stringify(doc));
  const parts: Buffer[] = [OPEN];
  let first = true;
  for (const key of Object.keys(doc)) {
    const value = (doc as unknown as Record<string, unknown>)[key];
    if (skipped(value)) continue;
    if (!first) parts.push(COMMA);
    first = false;
    parts.push(Buffer.from(JSON.stringify(key) + ':'));
    if (ENTRY_TABLES.has(key) && plainObject(value)) table(parts, value);
    else parts.push(Buffer.from(JSON.stringify(value)));
  }
  parts.push(CLOSE);
  return Buffer.concat(parts);
}
