import test from 'node:test';
import assert from 'node:assert/strict';
import {strToU8, zipSync} from 'fflate';
import {
  CatalogTableError,
  decodeCp1251,
  decodeTableText,
  detectDelimiter,
  parseDelimited,
  parseTableBytes,
  parseTableText,
  readXlsx,
  xmlTokens,
} from '../shared/design/marketplace/catalog';

// Catalog run (docs/marketplaces.md §Catalog run): the seller's table as Russian sellers actually save it — Excel's "CSV" with
// semicolons in Windows-1251, Google Sheets' UTF-8 with a BOM, cells pasted as TSV, and XLSX (built here with fflate).
// The Cyrillic in this file is deliberate: these are Russian marketplace catalog tables (Russian headers, Windows-1251
// bytes, Cyrillic cell text), so the decoding and header handling are tested on the real thing.

const encoder = new TextEncoder();
/** Text to Windows-1251 bytes, through the decoder's own table read backwards. */
function cp1251(text: string): Uint8Array {
  const table = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) table.set(decodeCp1251(Uint8Array.of(byte)), byte);
  return Uint8Array.from([...text].map(char => {
    const byte = table.get(char);
    if (byte === undefined) throw new Error(`not in cp1251: ${char}`);
    return byte;
  }));
}

test('should read RFC 4180 quirks: quoted delimiters, doubled quotes, line breaks in cells, CRLF, a BOM and ragged rows', () => {
  const csv = '﻿Артикул,Название,Описание\r\n' +
    '1001,"Крем, 50 мл","Сказал ""да""\r\nвторая строка"\r\n' +
    '1002,Мыло\r\n' +
    '\r\n' +
    '1003,"",конец\r\n';
  const rows = parseDelimited(csv);
  assert.deepEqual(rows[0], ['Артикул', 'Название', 'Описание']);
  assert.deepEqual(rows[1], ['1001', 'Крем, 50 мл', 'Сказал "да"\nвторая строка']);
  assert.deepEqual(rows[2], ['1002', 'Мыло']);
  const table = parseTableText(csv);
  assert.equal(table.format, 'csv');
  assert.deepEqual(table.headers, ['Артикул', 'Название', 'Описание']);
  assert.deepEqual(table.rows, [
    ['1001', 'Крем, 50 мл', 'Сказал "да"\nвторая строка'],
    ['1002', 'Мыло', ''],
    ['1003', '', 'конец'],
  ]);
  // A stray quote inside an unquoted cell is a character; a last line without a break still counts.
  assert.deepEqual(parseDelimited('a,5"b\nc,d', ','), [['a', '5"b'], ['c', 'd']]);
  assert.deepEqual(parseDelimited('x;y\ry;z', ';'), [['x', 'y'], ['y', 'z']]);
});

test('should take semicolons over decimal commas, tabs over both, and name empty and repeated headers', () => {
  assert.equal(detectDelimiter('Артикул;Цена;Вес\n1;12,5;0,3\n2;13,0;1,2\n'), ';');
  assert.equal(detectDelimiter('a,b,c\n1,2,3\n'), ',');
  assert.equal(detectDelimiter('a\tb;c\n1\t2;3\n'), '\t');
  assert.equal(detectDelimiter('Артикул\n1\n2\n'), ',');
  const table = parseTableText('Артикул;;Цена;Цена\n1;x;10;11\n');
  assert.deepEqual(table.headers, ['Артикул', 'Column B', 'Цена', 'Цена (2)']);
  assert.deepEqual(table.rows, [['1', 'x', '10', '11']]);
  // Empty trailing columns are dropped, cells trimmed (a no-break space too).
  assert.deepEqual(parseTableText('a;b;;\n 1 ; 2 ;;\n').headers, ['a', 'b']);
});

test('should read cells pasted from Excel or Google Sheets as TSV, quoted cells with line breaks included', () => {
  const pasted = 'Артикул\tНазвание\tПреимущество 1\r\n4607001\t"Крем\r\nдля рук"\tУвлажняет\r\n4607002\tМыло\t\r\n';
  const table = parseTableText(pasted);
  assert.equal(table.format, 'tsv');
  assert.deepEqual(table.rows, [['4607001', 'Крем\nдля рук', 'Увлажняет'], ['4607002', 'Мыло', '']]);
});

test('should tell UTF-8 (with or without a BOM), UTF-16 and Windows-1251 apart', () => {
  const text = 'Артикул;Название\n12;Ёлочная игрушка «Шар» №5\n';
  const legacy = cp1251(text);
  assert.equal(decodeTableText(legacy).encoding, 'windows-1251');
  assert.equal(decodeTableText(legacy).text, text);
  const table = parseTableBytes(legacy, 'товары.csv');
  assert.equal(table.encoding, 'windows-1251');
  assert.deepEqual(table.rows, [['12', 'Ёлочная игрушка «Шар» №5']]);
  // Node's own decoder agrees with the table on every byte (where its ICU knows the label).
  let native: TextDecoder | null = null;
  try {
    native = new TextDecoder('windows-1251');
  } catch {
    native = null;
  }
  if (native) {
    const all = Uint8Array.from({length: 256}, (_, byte) => byte);
    assert.equal(decodeCp1251(all), native.decode(all));
  }

  assert.deepEqual(decodeTableText(encoder.encode(text)), {text, encoding: 'utf-8'});
  assert.deepEqual(decodeTableText(Uint8Array.from([0xef, 0xbb, 0xbf, ...encoder.encode(text)])), {text, encoding: 'utf-8'});
  const utf16 = new Uint8Array(2 + text.length * 2);
  utf16.set([0xff, 0xfe]);
  for (let i = 0; i < text.length; i++) {
    utf16[2 + i * 2] = text.charCodeAt(i) & 0xff;
    utf16[3 + i * 2] = text.charCodeAt(i) >> 8;
  }
  assert.deepEqual(decodeTableText(utf16), {text, encoding: 'utf-16'});
  assert.equal(parseTableBytes(utf16).rows[0][1], 'Ёлочная игрушка «Шар» №5');
});

test('should refuse what is not a table with a way out', () => {
  assert.throws(() => parseTableBytes(Uint8Array.of(0xd0, 0xcf, 0x11, 0xe0, 0, 0), 'old.xls'), (error: Error) => error instanceof CatalogTableError && /\.xlsx or \.csv/.test(error.message));
  assert.throws(() => parseTableBytes(new Uint8Array()), CatalogTableError);
  assert.throws(() => parseTableText('Артикул;Название\n'), /only headers/);
  assert.throws(() => parseTableText('\n\n'), /no data/);
  assert.throws(() => parseTableBytes(Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 1, 2, 3)), /\.xlsx/);
});

test('should tokenize XML without a DOM: entities, CDATA, comments, prefixes and quoted «>»', () => {
  const tokens = [...xmlTokens('<?xml version="1.0"?><!-- note --><x:root a="1 > 0" b=\'&amp;&#1055;\'><t>A &lt;b&gt; &#x41;</t><![CDATA[<raw>]]><empty/></x:root>')];
  assert.deepEqual(tokens, [
    {kind: 'open', name: 'root', attrs: {a: '1 > 0', b: '&П'}, empty: false},
    {kind: 'open', name: 't', attrs: {}, empty: false},
    {kind: 'text', text: 'A <b> A'},
    {kind: 'close', name: 't'},
    {kind: 'text', text: '<raw>'},
    {kind: 'open', name: 'empty', attrs: {}, empty: true},
    {kind: 'close', name: 'root'},
  ]);
});

/** A minimal workbook: two sheets, the second file first in tab order, shared and inline strings, numbers, a boolean, gaps. */
function workbook(): Uint8Array {
  const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  return zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types/>'),
    'xl/workbook.xml': strToU8(`<?xml version="1.0" encoding="UTF-8"?><workbook ${ns}><sheets><sheet name="Товары" sheetId="2" r:id="rId7"/><sheet name="Другое" sheetId="1" r:id="rId1"/></sheets></workbook>`),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Type="worksheet" Target="/xl/worksheets/sheet2.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0"?><sst ${ns} count="5" uniqueCount="5">` +
      '<si><t>Артикул</t></si><si><t>Название</t></si><si><t>Цена</t></si>' +
      '<si><r><rPr><b/></rPr><t xml:space="preserve">Крем </t></r><r><t>для рук</t></r><rPh sb="0" eb="1"><t>くりーむ</t></rPh></si>' +
      '<si><t>Мыло &amp; пена</t></si></sst>'),
    'xl/worksheets/sheet2.xml': strToU8(`<?xml version="1.0"?><worksheet ${ns}><sheetData>` +
      '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="inlineStr"><is><t>В наличии</t></is></c></row>' +
      '<row r="2"><c r="A2"><v>4607001234567</v></c><c r="B2" t="s"><v>3</v></c><c r="C2"><f>1.1*3</f><v>3.3000000000000003</v></c><c r="D2" t="b"><v>1</v></c></row>' +
      '<row r="4"><c r="A4" t="str"><f>"A-"&amp;"7"</f><v>A-7</v></c><c r="C4"><v>12.5</v></c><c r="D4" t="b"><v>0</v></c></row>' +
      '<row r="5"><c r="A5" t="inlineStr"><is><r><t>B-</t></r><r><t>8</t></r></is></c><c r="B5" t="s"><v>4</v></c><c r="E5" t="e"><v>#DIV/0!</v></c></row>' +
      '</sheetData></worksheet>'),
    'xl/worksheets/sheet1.xml': strToU8(`<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>не тот лист</t></is></c></row></sheetData></worksheet>`),
  });
}

test('should read the first sheet of an XLSX: shared, rich and inline strings, numbers without float noise, booleans, gaps', () => {
  const cells = readXlsx(workbook());
  assert.deepEqual(cells[0], ['Артикул', 'Название', 'Цена', 'В наличии']);
  assert.deepEqual(cells[1], ['4607001234567', 'Крем для рук', '3.3', 'Yes']);
  assert.deepEqual(cells[2], []);
  assert.deepEqual(cells[3], ['A-7', '', '12.5', 'No']);
  assert.deepEqual(cells[4], ['B-8', 'Мыло & пена', '', '', '']);
  const table = parseTableBytes(workbook(), 'каталог.xlsx');
  assert.equal(table.format, 'xlsx');
  assert.deepEqual(table.headers, ['Артикул', 'Название', 'Цена', 'В наличии']);
  assert.deepEqual(table.rows.map(row => row[0]), ['4607001234567', 'A-7', 'B-8']);
});

test('should fall back to sheet1 without relationships, and refuse a zip that is not a workbook', () => {
  const bare = zipSync({
    'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Лист1" sheetId="1"/></sheets></workbook>'),
    'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row><c t="inlineStr"><is><t>Артикул</t></is></c></row><row><c><v>5</v></c></row></sheetData></worksheet>'),
  });
  assert.deepEqual(readXlsx(bare), [['Артикул'], ['5']]);
  assert.throws(() => readXlsx(zipSync({'readme.txt': strToU8('hi')})), CatalogTableError);
});
