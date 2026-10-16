// Catalog run (docs/marketplaces.md §Catalog run): the first sheet of an XLSX workbook as a grid of strings. The zip is opened with
// fflate; the XML is read by the small tokenizer below rather than DOMParser, so the same code runs in the editor and in node
// tests, and no entity, DTD or external reference is ever expanded. Shared strings, inline strings, formula results, numbers and
// booleans are read; styles are not (a date stays Excel's serial number).

import {unzipSync} from 'fflate';
import {CATALOG_TABLE_LIMITS, CatalogTableError} from './catalog-table';

// ── XML ────────────────────────────────────────────────────────────────────────────────────────

/** One step through an XML text. Element and attribute names lose their namespace prefix (`x:c` is `c`, `r:id` is `id`). */
export type XmlToken =
  | {kind: 'open'; name: string; attrs: Record<string, string>; empty: boolean}
  | {kind: 'close'; name: string}
  | {kind: 'text'; text: string};

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

/** The five XML entities and numeric references; any other `&name;` stays as written. */
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ({lt: '<', gt: '>', amp: '&', quot: '"', apos: "'"} as Record<string, string>)[entity];
  });
}

function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    if (match[1] === 'xmlns' || match[1].startsWith('xmlns:')) continue;
    attrs[localName(match[1])] = decodeXmlEntities(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/** The tokens of an XML text in order. Comments, processing instructions and DOCTYPE are skipped; CDATA is text. */
export function* xmlTokens(xml: string): Generator<XmlToken> {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) {
      const tail = xml.slice(i);
      if (tail) yield {kind: 'text', text: decodeXmlEntities(tail)};
      return;
    }
    if (lt > i) yield {kind: 'text', text: decodeXmlEntities(xml.slice(i, lt))};
    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      i = end < 0 ? xml.length : end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      yield {kind: 'text', text: xml.slice(lt + 9, end < 0 ? xml.length : end)};
      i = end < 0 ? xml.length : end + 3;
    } else if (xml[lt + 1] === '?') {
      const end = xml.indexOf('?>', lt + 2);
      i = end < 0 ? xml.length : end + 2;
    } else if (xml[lt + 1] === '!') {
      const end = xml.indexOf('>', lt + 2);
      i = end < 0 ? xml.length : end + 1;
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt + 2);
      yield {kind: 'close', name: localName(xml.slice(lt + 2, end < 0 ? xml.length : end).trim())};
      i = end < 0 ? xml.length : end + 1;
    } else {
      // The tag ends at the first '>' outside a quoted attribute value.
      let end = lt + 1, quote = '';
      for (; end < xml.length; end++) {
        const char = xml[end];
        if (quote) {
          if (char === quote) quote = '';
        } else if (char === '"' || char === "'") quote = char;
        else if (char === '>') break;
      }
      let body = xml.slice(lt + 1, end);
      const empty = body.endsWith('/');
      if (empty) body = body.slice(0, -1);
      const space = body.search(/\s/);
      const name = localName(space < 0 ? body : body.slice(0, space));
      yield {kind: 'open', name, attrs: space < 0 ? {} : parseAttrs(body.slice(space)), empty};
      i = end + 1;
    }
  }
}

// ── Workbook ───────────────────────────────────────────────────────────────────────────────────

/** A part a sane workbook never exceeds unpacked; a bigger one is refused before it is inflated. */
const PART_BYTES = 200 * 1024 * 1024;

function unzipParts(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      filter: file => {
        if (!wanted(file.name)) return false;
        if (file.originalSize > PART_BYTES) throw new CatalogTableError('The sheet of the table is too large.');
        return true;
      },
    });
  } catch (error) {
    if (error instanceof CatalogTableError) throw error;
    throw new CatalogTableError('Could not open the .xlsx file: it is damaged or is not a table.');
  }
}

const utf8 = (bytes: Uint8Array | undefined) => (bytes ? new TextDecoder('utf-8').decode(bytes) : '');

/** The path inside the zip of the workbook's first sheet (tab order), from workbook.xml and its relationships. */
function firstSheetPath(parts: Record<string, Uint8Array>): string {
  let relId: string | null = null;
  for (const token of xmlTokens(utf8(parts['xl/workbook.xml']))) {
    if (token.kind === 'open' && token.name === 'sheet') {
      relId = token.attrs.id ?? null;
      break;
    }
  }
  if (relId) {
    for (const token of xmlTokens(utf8(parts['xl/_rels/workbook.xml.rels']))) {
      if (token.kind !== 'open' || token.name !== 'Relationship' || token.attrs.Id !== relId || !token.attrs.Target) continue;
      const target = token.attrs.Target;
      const path = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
      // `xl/worksheets/../x.xml` and the like.
      const segments: string[] = [];
      for (const segment of path.split('/')) {
        if (segment === '..') segments.pop();
        else if (segment && segment !== '.') segments.push(segment);
      }
      return segments.join('/');
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/** Text of `<t>` elements inside the current element, phonetic runs (`<rPh>`) left out. */
function readStrings(xml: string): string[] {
  const out: string[] = [];
  let current: string[] | null = null, inText = false, phonetic = 0;
  for (const token of xmlTokens(xml)) {
    if (token.kind === 'open') {
      if (token.name === 'si') current = [];
      else if (token.name === 'rPh' && !token.empty) phonetic++;
      else if (token.name === 't' && !token.empty) inText = true;
      else if (token.name === 'si' && token.empty) out.push('');
    } else if (token.kind === 'close') {
      if (token.name === 'si') {
        out.push(current?.join('') ?? '');
        current = null;
      } else if (token.name === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (token.name === 't') inText = false;
    } else if (inText && !phonetic && current) current.push(token.text);
  }
  return out;
}

/** "AB12" → column 27 (0-based); null for anything else. */
function columnOf(ref: string | undefined): number | null {
  const match = ref ? /^([A-Za-z]{1,3})\d*$/.exec(ref) : null;
  if (!match) return null;
  let column = 0;
  for (const char of match[1].toUpperCase()) column = column * 26 + char.charCodeAt(0) - 64;
  return column - 1;
}

/** A number cell as Excel shows it in the General format, without float noise: 0.30000000000000004 is "0.3". */
export function xlsxNumberText(raw: string): string {
  const value = raw.trim();
  if (/^-?\d+$/.test(value)) return value;
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toPrecision(15))) : value;
}

/** The cells of the first sheet, row by row (row and column gaps filled with empty strings). */
export function readXlsx(bytes: Uint8Array): string[][] {
  const index = unzipParts(bytes, name => name === 'xl/workbook.xml' || name === 'xl/_rels/workbook.xml.rels');
  if (!index['xl/workbook.xml']) throw new CatalogTableError('Could not open the .xlsx file: it has no sheets.');
  const sheetPath = firstSheetPath(index);
  const parts = unzipParts(bytes, name => name === sheetPath || name === 'xl/sharedStrings.xml');
  if (!parts[sheetPath]) throw new CatalogTableError('Could not open the .xlsx file: the first sheet was not found.');
  const shared = readStrings(utf8(parts['xl/sharedStrings.xml']));

  const rows: string[][] = [];
  const maxRows = CATALOG_TABLE_LIMITS.rows * 2 + 1;
  let row: string[] | null = null, rowIndex = -1;
  let cell: {column: number; type: string; value: string[]; inline: string[]} | null = null;
  let inValue = false, inInline = false, inText = false, phonetic = 0, nextColumn = 0;
  for (const token of xmlTokens(utf8(parts[sheetPath]))) {
    if (token.kind === 'open') {
      if (token.name === 'row') {
        const declared = Number(token.attrs.r);
        rowIndex = Number.isInteger(declared) && declared > 0 ? declared - 1 : rowIndex + 1;
        if (rowIndex >= maxRows) break;
        row = [];
        nextColumn = 0;
        while (rows.length < rowIndex) rows.push([]);
        rows[rowIndex] = row;
        if (token.empty) row = null;
      } else if (token.name === 'c' && row) {
        const column = columnOf(token.attrs.r) ?? nextColumn;
        nextColumn = column + 1;
        cell = {column, type: token.attrs.t ?? 'n', value: [], inline: []};
        if (token.empty) cell = null;
      } else if (cell) {
        if (token.name === 'v' && !token.empty) inValue = true;
        else if (token.name === 'is' && !token.empty) inInline = true;
        else if (token.name === 'rPh' && !token.empty) phonetic++;
        else if (token.name === 't' && inInline && !token.empty) inText = true;
      }
    } else if (token.kind === 'close') {
      if (token.name === 'row') row = null;
      else if (token.name === 'c' && cell && row) {
        if (cell.column < CATALOG_TABLE_LIMITS.columns) {
          while (row.length < cell.column) row.push('');
          row[cell.column] = cellText(cell.type, cell.value.join(''), cell.inline.join(''), shared);
        }
        cell = null;
      } else if (token.name === 'v') inValue = false;
      else if (token.name === 'is') inInline = false;
      else if (token.name === 'rPh') phonetic = Math.max(0, phonetic - 1);
      else if (token.name === 't') inText = false;
    } else if (cell) {
      if (inValue) cell.value.push(token.text);
      else if (inText && !phonetic) cell.inline.push(token.text);
    }
  }
  return rows;
}

function cellText(type: string, value: string, inline: string, shared: readonly string[]): string {
  switch (type) {
    case 's': {
      const index = Number(value);
      return Number.isInteger(index) && index >= 0 && index < shared.length ? shared[index] : '';
    }
    case 'inlineStr':
      return inline;
    case 'str':
    case 'd':
      return value;
    case 'b':
      return value.trim() === '1' ? 'Yes' : 'No';
    case 'e':
      return '';
    default:
      return value === '' ? '' : xlsxNumberText(value);
  }
}
