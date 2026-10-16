import type {SqlExecutor} from '../postgresql/client';

declare const exportValue: unique symbol;
export type ExportValue = {readonly [exportValue]: true};
type Rows = {factory: (executor: SqlExecutor) => AsyncIterable<unknown>; used: boolean};
type Section = readonly (readonly [string, unknown])[];
const rows = new WeakMap<object, Rows>();
const sections = new WeakMap<object, Section>();
const token = (): ExportValue =>
  Object.freeze({
    toJSON(): never {
      throw Error('Export streams require the snapshot serializer.');
    },
  }) as unknown as ExportValue;

/** The factory is invoked once, sequentially, with the export's live snapshot.
 * Callers must use keyset reads; large document histories should fetch one row
 * at a time. Memory is bounded by the largest row, not the complete history. */
export function exportRows(factory: (executor: SqlExecutor) => AsyncIterable<unknown>): ExportValue {
  if (typeof factory !== 'function') throw Error('An export row factory is required.');
  const value = token();
  rows.set(value, {factory, used: false});
  return value;
}

/** Explicit nested section. Capture its field names and values immediately;
 * ordinary metadata objects retain their existing JSON.stringify behavior. */
export function exportSection(fields: Record<string, unknown>): ExportValue {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw Error('Invalid export section.');
  const value = token();
  sections.set(value, Object.freeze(Object.entries(fields).map(entry => Object.freeze(entry))));
  return value;
}

type Prepared =
  {kind: 'json'; text: string} | {kind: 'rows'; rows: Rows} | {kind: 'section'; entries: [string, Prepared][]};
type Write = (text: string) => Promise<void>;
function encode(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, item) => {
    if (
      item &&
      (typeof item === 'object' || typeof item === 'function') &&
      (rows.has(item) ||
        sections.has(item) ||
        typeof item.then === 'function' ||
        typeof item[Symbol.asyncIterator] === 'function')
    )
      throw Error('Nested export capabilities, promises and generic async iterables are not JSON metadata.');
    return item;
  });
}

async function writeEncoded(text: string, write: Write): Promise<void> {
  // Avoid a second full UTF-8 buffer for large documents. Do not split a valid
  // surrogate pair across writes, which would replace it with two U+FFFD bytes.
  for (let offset = 0; offset < text.length;) {
    let end = Math.min(offset + 16384, text.length);
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff &&
      text.charCodeAt(end) >= 0xdc00 &&
      text.charCodeAt(end) <= 0xdfff
    )
      end--;
    await write(text.slice(offset, end));
    offset = end;
  }
}

/** Validate and capture the complete metadata topology before the first write
 * or factory await. Reusing a stream, including after a failed export, is an
 * error; callers construct a fresh owner-bound capability for each request. */
export function prepareExportMetadata(metadata: Record<string, unknown>) {
  if (
    !metadata ||
    typeof metadata !== 'object' ||
    Array.isArray(metadata) ||
    rows.has(metadata) ||
    sections.has(metadata) ||
    typeof metadata.then === 'function' ||
    typeof metadata[Symbol.asyncIterator as unknown as string] === 'function' ||
    'leads' in metadata ||
    'notes' in metadata
  )
    throw Error('Invalid account export metadata.');
  const seen = new Set<Rows>();
  const prepareEntries = (entries: Section): [string, Prepared][] =>
    entries.flatMap(([key, value]) => {
      const prepared = prepare(value);
      return prepared ? [[key, prepared] as [string, Prepared]] : [];
    });
  const prepare = (value: unknown): Prepared | undefined => {
    if (value && typeof value === 'object') {
      const stream = rows.get(value);
      if (stream) {
        if (stream.used || seen.has(stream)) throw Error('An export stream can be consumed only once.');
        seen.add(stream);
        return {kind: 'rows', rows: stream};
      }
      const section = sections.get(value);
      if (section) return {kind: 'section', entries: prepareEntries(section)};
    }
    const text = encode(value);
    return text === undefined ? undefined : {kind: 'json', text};
  };
  const entries = prepareEntries(Object.entries(metadata));
  for (const stream of seen) stream.used = true;
  let consumed = false;
  return async (executor: SqlExecutor, write: Write): Promise<boolean> => {
    if (consumed) throw Error('Export metadata can be consumed only once.');
    consumed = true;
    const writeEntries = async (fields: [string, Prepared][]) => {
      let first = true;
      for (const [key, value] of fields) {
        await write((first ? '' : ',') + JSON.stringify(key) + ':');
        await writeValue(value);
        first = false;
      }
      return first;
    };
    const writeValue = async (value: Prepared): Promise<void> => {
      if (value.kind === 'json') {
        await writeEncoded(value.text, write);
        return;
      }
      if (value.kind === 'section') {
        await write('{');
        await writeEntries(value.entries);
        await write('}');
        return;
      }
      await write('[');
      let first = true;
      const iterable = value.rows.factory(executor);
      if (!iterable || typeof iterable[Symbol.asyncIterator] !== 'function')
        throw Error('Export factory must return an async iterable.');
      const iterator = iterable[Symbol.asyncIterator]();
      try {
        while (true) {
          const next = await iterator.next();
          if (next.done) break;
          const text = encode(next.value) ?? 'null';
          if (!first) await write(',');
          await writeEncoded(text, write);
          first = false;
        }
      } catch (error) {
        // Also close custom iterators whose next() rejected. Preserve the
        // original capture error if their best-effort cleanup itself fails.
        try {
          await iterator.return?.();
        } catch {
          /* Original failure wins. */
        }
        throw error;
      }
      await write(']');
    };
    return writeEntries(entries);
  };
}
