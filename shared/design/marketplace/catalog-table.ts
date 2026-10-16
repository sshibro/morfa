// Catalog run (docs/marketplaces.md §Catalog run): the seller's table read into one header row and rows of strings. CSV with
// commas or semicolons (quoted fields, a BOM, CRLF), TSV and the cells Excel or Google Sheets put on the clipboard, in UTF-8,
// UTF-16 or Windows-1251 (what Russian Excel saves "CSV" in); XLSX goes through catalog-xlsx.ts. Pure, no DOM: the editor reads
// files and pastes with it, and node tests run it as is. `parseTableBytes` in catalog.ts picks between this and XLSX.

export const CATALOG_TABLE_LIMITS = {
  /** A table file. */
  bytes: 20 * 1024 * 1024,
  /** Rows read after the header; the rest are counted in `cut`. */
  rows: 5_000,
  columns: 200,
  /** One cell, UTF-16 code units. */
  cell: 5_000,
} as const;

export type CatalogTableFormat = 'csv' | 'tsv' | 'xlsx';
export type CatalogTextEncoding = 'utf-8' | 'utf-16' | 'windows-1251';

/** A table as the catalog run reads it: unique, non-empty headers and rows of exactly `headers.length` trimmed cells. */
export type CatalogTable = {
  headers: string[];
  rows: string[][];
  /** Rows past `CATALOG_TABLE_LIMITS.rows`, not read. */
  cut: number;
  format: CatalogTableFormat;
  /** A text table: how its bytes were read. */
  encoding?: CatalogTextEncoding;
};

/** A table that cannot be read; the message is for the user. */
export class CatalogTableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CatalogTableError';
  }
}

// ── Encodings ──────────────────────────────────────────────────────────────────────────────────

/** Windows-1251 bytes 0x80..0xBF (WHATWG's index); 0xC0..0xFF are the Cyrillic letters А..я in order (the table below is encoding data and stays Cyrillic). */
const CP1251_HIGH =
  'ЂЃ‚ѓ„…†‡€‰Љ‹ЊЌЋЏ' +
  'ђ‘’“”•–—\u0098™љ›њќћџ' +
  ' ЎўЈ¤Ґ¦§Ё©Є«¬­®Ї' +
  '°±Ііґµ¶·ё№є»јЅѕї';

/** Windows-1251 to text, by table (no TextDecoder label support needed). */
export function decodeCp1251(bytes: Uint8Array): string {
  let out = '';
  for (let start = 0; start < bytes.length; start += 8192) {
    const chunk: string[] = [];
    for (let i = start; i < Math.min(bytes.length, start + 8192); i++) {
      const byte = bytes[i];
      chunk.push(byte < 0x80 ? String.fromCharCode(byte) : byte < 0xc0 ? CP1251_HIGH[byte - 0x80] : String.fromCharCode(0x410 + byte - 0xc0));
    }
    out += chunk.join('');
  }
  return out;
}

/** A text file's characters: a BOM says UTF-8 or UTF-16; otherwise strict UTF-8, and Windows-1251 when that fails. */
export function decodeTableText(bytes: Uint8Array): {text: string; encoding: CatalogTextEncoding} {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return {text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8'};
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return {text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16'};
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    // UTF-16 BE: swap to LE, which every TextDecoder knows.
    const swapped = new Uint8Array(bytes.length - 2 - ((bytes.length - 2) % 2));
    for (let i = 0; i < swapped.length; i += 2) {
      swapped[i] = bytes[i + 3];
      swapped[i + 1] = bytes[i + 2];
    }
    return {text: new TextDecoder('utf-16le').decode(swapped), encoding: 'utf-16'};
  }
  try {
    return {text: new TextDecoder('utf-8', {fatal: true}).decode(bytes), encoding: 'utf-8'};
  } catch {
    return {text: decodeCp1251(bytes), encoding: 'windows-1251'};
  }
}

// ── Delimited text ─────────────────────────────────────────────────────────────────────────────

export type Delimiter = ',' | ';' | '\t';
const DELIMITERS: readonly Delimiter[] = ['\t', ';', ','];

/** Per-line counts of each delimiter outside quotes, over the first lines. */
function delimiterCounts(text: string, lines = 20): Record<Delimiter, number[]> {
  const counts: Record<Delimiter, number[]> = {'\t': [], ';': [], ',': []};
  let current: Record<Delimiter, number> = {'\t': 0, ';': 0, ',': 0};
  let quoted = false, fieldStart = true, filled = false;
  const endLine = () => {
    if (filled) for (const delimiter of DELIMITERS) counts[delimiter].push(current[delimiter]);
    current = {'\t': 0, ';': 0, ',': 0};
    filled = false;
  };
  for (let i = 0; i < text.length && counts[','].length < lines; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') i++;
        else quoted = false;
      }
      continue;
    }
    if (char === '"' && fieldStart) {
      quoted = true;
      filled = true;
      fieldStart = false;
      continue;
    }
    if (char === '\n' || char === '\r') {
      endLine();
      fieldStart = true;
      continue;
    }
    if (char === '\t' || char === ';' || char === ',') {
      current[char]++;
      fieldStart = true;
    } else fieldStart = false;
    filled = true;
  }
  endLine();
  return counts;
}

/** The delimiter of a text table: the one every line has most of (tab, then semicolon, then comma on a tie); comma for one column.
 *  Russian Excel's "12,5" decimals lose to its semicolons because each line has fewer of them. */
export function detectDelimiter(text: string): Delimiter {
  const counts = delimiterCounts(text);
  let best: Delimiter = ',', score = 0;
  for (const delimiter of DELIMITERS) {
    const lines = counts[delimiter];
    const least = lines.length ? Math.min(...lines) : 0;
    if (least > score) {
      best = delimiter;
      score = least;
    }
  }
  if (score > 0) return best;
  // Lines disagree (a ragged table): the delimiter seen most at all.
  let most = 0;
  for (const delimiter of DELIMITERS) {
    const total = counts[delimiter].reduce((sum, value) => sum + value, 0);
    if (total > most) {
      best = delimiter;
      most = total;
    }
  }
  return best;
}

/** RFC 4180 cells: quoted fields hold delimiters, line breaks and doubled quotes; CRLF, LF or CR end a row; a stray quote inside
 *  an unquoted field is kept as a character, as Excel reads it. A BOM at the start is dropped. */
export function parseDelimited(input: string, delimiter: Delimiter = detectDelimiter(input)): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false, wasQuoted = false;
  const endField = () => {
    row.push(field);
    field = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else if (char === '\r') {
        field += '\n';
        if (text[i + 1] === '\n') i++;
      } else field += char;
      continue;
    }
    if (char === '"' && field === '' && !wasQuoted) {
      quoted = wasQuoted = true;
      continue;
    }
    if (char === delimiter) endField();
    else if (char === '\n') endRow();
    else if (char === '\r') {
      if (text[i + 1] === '\n') i++;
      endRow();
    } else field += char;
  }
  if (field !== '' || wasQuoted || row.length) endRow();
  return rows;
}

// ── Tables ─────────────────────────────────────────────────────────────────────────────────────

/** "A", "B" … "Z", "AA": Excel's name of a column. */
export function columnLetter(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const cleanCell = (value: string | undefined) => (value ?? '').replace(/\r\n?/g, '\n').replace(/ /g, ' ').trim().slice(0, CATALOG_TABLE_LIMITS.cell);

/** The table a grid of cells makes: the first non-empty row names the columns (an empty name becomes "Column C", a repeated
 *  one "Price (2)"), empty rows and empty trailing columns go, every row gets one cell per column. */
export function tableFromCells(cells: readonly (readonly string[])[], format: CatalogTableFormat, encoding?: CatalogTextEncoding): CatalogTable {
  const filled = cells.map(row => row.slice(0, CATALOG_TABLE_LIMITS.columns).map(cleanCell)).filter(row => row.some(cell => cell !== ''));
  if (!filled.length) throw new CatalogTableError('The table has no data.');
  if (filled.length < 2) throw new CatalogTableError('The table has only headers: add rows with products.');
  let width = 0;
  for (const row of filled) for (let i = row.length - 1; i >= width; i--) if (row[i] !== '') { width = i + 1; break; }
  const seen = new Map<string, number>();
  const headers = Array.from({length: width}, (_, i) => {
    const base = filled[0][i] || `Column ${columnLetter(i)}`;
    const key = base.toLowerCase();
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count > 1 ? `${base} (${count})` : base;
  });
  const body = filled.slice(1);
  const rows = body.slice(0, CATALOG_TABLE_LIMITS.rows).map(row => Array.from({length: width}, (_, i) => row[i] ?? ''));
  return {headers, rows, cut: Math.max(0, body.length - CATALOG_TABLE_LIMITS.rows), format, ...(encoding ? {encoding} : {})};
}

/** Text typed or pasted (cells copied from Excel or Google Sheets arrive as TSV), or a text file's characters. */
export function parseTableText(text: string, encoding?: CatalogTextEncoding): CatalogTable {
  const delimiter = detectDelimiter(text);
  return tableFromCells(parseDelimited(text, delimiter), delimiter === '\t' ? 'tsv' : 'csv', encoding);
}
