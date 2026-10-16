// Catalog run (docs/marketplaces.md §Catalog run): "Catalog from a table", a seller's table of SKUs, titles and benefits mapped onto a
// card used as the template, one editable copy of it per row. This is the pure part the editor's dialog
// (src/design/marketplace/catalog) and the tests share: reading the table (catalog-table.ts, catalog-xlsx.ts), the template's layers a
// column can fill, the automatic mapping, photos matched to rows, how many rows the file can still hold, and the copy one row makes.

import {cloneSubtrees} from '../clone';
import {withOverrideTracking} from '../components';
import {isAutoLayout} from '../constraints';
import {DESIGN_FIELD_LIMITS} from '../document-limits';
import {insertText} from '../text-edit';
import type {Transaction} from '../transaction';
import type {DesignDocument, ImagePaint, ImageRef, NodeId, Paint, SceneNode, TextProps, Vec} from '../types';
import type {DocumentCaps} from '../big-files';
import {readXlsx} from './catalog-xlsx';
import {CATALOG_TABLE_LIMITS, CatalogTableError, decodeTableText, parseTableText, tableFromCells, type CatalogTable} from './catalog-table';
import {cardMeta, layerRole, withCardMeta, type CardMeta, type LayerRole} from './meta';

export {CATALOG_TABLE_LIMITS, CatalogTableError, columnLetter, decodeCp1251, decodeTableText, detectDelimiter, parseDelimited, parseTableText, tableFromCells} from './catalog-table';
export type {CatalogTable, CatalogTableFormat, CatalogTextEncoding, Delimiter} from './catalog-table';
export {readXlsx, xmlTokens, type XmlToken} from './catalog-xlsx';

export const CATALOG_LIMITS = {
  /** Rows one undo step makes at most. */
  batchRows: 50,
  /** A batch's layers and estimated JSON, kept well under one autosave patch (DESIGN_PATCH_MAX_BYTES, 8 MB). */
  batchNodes: 5_000,
  batchBytes: 3 * 1024 * 1024,
  /** Picture addresses one POST /api/marketplace/catalog/fetch-images takes. */
  urlsPerRequest: 50,
  /** Rows the dialog previews. */
  previewRows: 5,
  /** `CardMeta.sku` (meta.ts keeps at most 64 characters). */
  sku: 64,
} as const;

const isZip = (bytes: Uint8Array) => bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
const isOle = (bytes: Uint8Array) => bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0;

/** A table file: XLSX by its zip signature, the old binary .xls refused with a way out, anything else as delimited text. */
export function parseTableBytes(bytes: Uint8Array, name = ''): CatalogTable {
  if (bytes.length > CATALOG_TABLE_LIMITS.bytes) throw new CatalogTableError(`The table is larger than ${CATALOG_TABLE_LIMITS.bytes / 1024 / 1024} MB.`);
  if (!bytes.length) throw new CatalogTableError('The file is empty.');
  if (isZip(bytes)) return tableFromCells(readXlsx(bytes), 'xlsx');
  if (isOle(bytes) || /\.xls$/i.test(name)) throw new CatalogTableError('This is the old .xls format. Save the table as .xlsx or .csv.');
  if (/\.(numbers|ods|pdf|docx?)$/i.test(name)) throw new CatalogTableError('A .xlsx, .csv or .tsv table is needed.');
  const {text, encoding} = decodeTableText(bytes);
  if (text.includes('\u0000')) throw new CatalogTableError('This is not a table: a .xlsx, .csv or .tsv file is needed.');
  return parseTableText(text, encoding);
}

// ── The template ───────────────────────────────────────────────────────────────────────────────

/** A layer of the template a column can fill: a text, or a picture (an image fill, or the product's place). */
export type CatalogSlot = {
  id: NodeId;
  kind: 'text' | 'image';
  name: string;
  role: LayerRole | null;
  /** A text's characters (the first 120), shown beside it in the mapping. */
  sample: string;
  /** A text's {{Column}} placeholders, in order, each once. */
  placeholders: string[];
};

const PLACEHOLDER = /\{\{\s*([^{}\n]{1,100}?)\s*\}\}/g;

/** The {{…}} names in a text, in order, each once. */
export function placeholdersOf(characters: string): string[] {
  const out: string[] = [];
  for (const match of characters.matchAll(PLACEHOLDER)) if (!out.includes(match[1])) out.push(match[1]);
  return out;
}

const hasImageFill = (node: SceneNode) => node.fills.some(paint => paint.type === 'IMAGE');

/** The template's layers a column can fill, texts first, each list in reading order (top to bottom, then left to right). Hidden
 *  layers and the inside of hidden ones are left out. */
export function templateSlots(doc: Pick<DesignDocument, 'nodes'>, frameId: NodeId): CatalogSlot[] {
  const root = doc.nodes[frameId];
  if (!root) return [];
  const found: {slot: CatalogSlot; x: number; y: number}[] = [];
  const visit = (node: SceneNode, x: number, y: number, depth: number) => {
    if (!node.visible || depth > DESIGN_FIELD_LIMITS.depth) return;
    const role = layerRole(node);
    if (node.type === 'TEXT' && node.text) {
      found.push({slot: {id: node.id, kind: 'text', name: node.name, role, sample: node.text.characters.slice(0, 120), placeholders: placeholdersOf(node.text.characters)}, x, y});
    } else if (node.type !== 'GROUP' && node.type !== 'BOOLEAN_OPERATION' && (hasImageFill(node) || (role === 'product' && node.id !== frameId))) {
      found.push({slot: {id: node.id, kind: 'image', name: node.name, role, sample: '', placeholders: []}, x, y});
    }
    for (const child of node.children ?? []) {
      const next = doc.nodes[child];
      if (next) visit(next, x + next.x, y + next.y, depth + 1);
    }
  };
  visit(root, 0, 0, 0);
  const order = (a: (typeof found)[number], b: (typeof found)[number]) => (Math.abs(a.y - b.y) > 4 ? a.y - b.y : a.x - b.x);
  return [...found.filter(entry => entry.slot.kind === 'text').sort(order), ...found.filter(entry => entry.slot.kind === 'image').sort(order)].map(entry => entry.slot);
}

// ── Mapping ────────────────────────────────────────────────────────────────────────────────────

/** How one layer is filled from a row. */
export type CatalogBinding =
  | {kind: 'keep'}
  /** A text: the cell replaces the whole text. A picture: the cell holds the picture's https address. */
  | {kind: 'column'; column: number}
  /** A text: each {{Column}} takes that column's cell. */
  | {kind: 'template'}
  /** A picture: the dropped file whose name holds the row's SKU. */
  | {kind: 'files'};

export type CatalogMapping = {
  /** The SKU (article number) column: required, it names each card and goes into its meta. */
  sku: number | null;
  /** Layer id → binding; a layer left out is kept as the template has it. */
  bindings: Record<NodeId, CatalogBinding>;
};

/** A header or a layer name as matching compares it: lower case, "ё" as "е", letters and digits only (the Russian header words below stay Russian: sellers' tables for the Russian marketplaces have Russian headers). */
export const columnKey = (value: string) => value.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');

const SKU_KEYS = ['артикул', 'артикулпродавца', 'вашартикул', 'sku', 'vendorcode', 'offerid', 'артикулwb', 'артикулozon', 'article', 'арт', 'кодтовара', 'код'];
const PHOTO_WORDS = ['фото', 'изображен', 'картинк', 'photo', 'image', 'img', 'picture', 'url', 'ссылк'];
const ROLE_WORDS: Partial<Record<LayerRole, readonly string[]>> = {
  headline: ['название', 'наименование', 'заголовок', 'headline', 'title', 'name', 'товар'],
  benefit: ['преимуществ', 'benefit', 'особенност', 'свойств', 'буллет', 'bullet', 'польза'],
  badge: ['плашка', 'бейдж', 'badge', 'метка', 'акция', 'стикер'],
};
const PRODUCT_WORDS = ['фото', 'товар', 'product', 'photo', 'изображен', 'картинк', 'image', 'packshot', 'упаковк'];

/** The first http(s) address in a cell (several may be listed, separated by spaces, ";" or "|"). */
export function photoUrlOf(cell: string): string | null {
  for (const part of cell.split(/[\s;|]+|,\s+/)) {
    if (!/^https?:\/\//i.test(part)) continue;
    try {
      const url = new URL(part);
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
    } catch {
      // Not an address; look further.
    }
  }
  return null;
}

/** The column holding article numbers: a known header first ("Article", "SKU", "Seller's article"…), then any header that says so. */
export function findSkuColumn(headers: readonly string[]): number | null {
  const keys = headers.map(columnKey);
  for (const wanted of SKU_KEYS) {
    const at = keys.indexOf(wanted);
    if (at >= 0) return at;
  }
  const loose = keys.findIndex(key => key.startsWith('артикул') || key.includes('sku') || key.includes('vendorcode') || key.includes('offerid'));
  return loose >= 0 ? loose : null;
}

/** The column of photo addresses: a header about photos whose cells are addresses, else any column that is mostly addresses. */
export function findPhotoColumn(table: CatalogTable): number | null {
  const share = (column: number) => {
    let filled = 0, urls = 0;
    for (const row of table.rows.slice(0, 200)) {
      if (!row[column]) continue;
      filled++;
      if (photoUrlOf(row[column])) urls++;
    }
    return filled ? urls / filled : 0;
  };
  const keys = table.headers.map(columnKey);
  const named = keys.map((key, column) => ({column, named: PHOTO_WORDS.some(word => key.includes(word)), share: share(column)}));
  const best = named.find(entry => entry.named && entry.share >= 0.5) ?? named.filter(entry => entry.share >= 0.5).sort((a, b) => b.share - a.share)[0];
  return best ? best.column : null;
}

/** The column a {{placeholder}} names, or null. */
export function placeholderColumn(name: string, headers: readonly string[]): number | null {
  const key = columnKey(name);
  const at = headers.findIndex(header => columnKey(header) === key);
  return at >= 0 ? at : null;
}

const roleOfName = (key: string): LayerRole | null => {
  for (const [role, words] of Object.entries(ROLE_WORDS) as [LayerRole, readonly string[]][]) if (words.some(word => key.startsWith(word))) return role;
  return null;
};

/**
 * The mapping a table and a template suggest: the SKU column; a text with {{…}} placeholders fills them; any other text takes the
 * column named as the layer (or as the text it shows, "Title" typed as a sample), else the column its role suggests (benefits in
 * order: the first benefit layer takes the first "Benefit" column), else one whose name contains the layer's; the product
 * picture takes the photo column, or the dropped files when there is none and `files` is set. Anything unmatched is kept.
 */
export function autoMapping(table: CatalogTable, slots: readonly CatalogSlot[], options: {files?: boolean} = {}): CatalogMapping {
  const keys = table.headers.map(columnKey);
  const sku = findSkuColumn(table.headers);
  const photo = findPhotoColumn(table);
  const bindings: Record<NodeId, CatalogBinding> = {};
  const used = new Set<number>();
  if (sku !== null) used.add(sku);
  if (photo !== null) used.add(photo);
  const texts = slots.filter(slot => slot.kind === 'text');
  // Exact names first, so a loose match never takes a column another layer is named after.
  for (const slot of texts) {
    if (slot.placeholders.some(name => placeholderColumn(name, table.headers) !== null)) {
      bindings[slot.id] = {kind: 'template'};
      continue;
    }
    const name = columnKey(slot.name), sample = columnKey(slot.sample);
    const exact = keys.findIndex(key => key !== '' && (key === name || key === sample));
    if (exact >= 0) {
      bindings[slot.id] = {kind: 'column', column: exact};
      used.add(exact);
    }
  }
  for (const slot of texts) {
    if (bindings[slot.id]) continue;
    const name = columnKey(slot.name);
    const role = slot.role ?? roleOfName(name) ?? roleOfName(columnKey(slot.sample));
    const words = role ? ROLE_WORDS[role] : undefined;
    let column = words ? keys.findIndex((key, at) => !used.has(at) && words.some(word => key.startsWith(word))) : -1;
    if (column < 0 && name.length >= 4) column = keys.findIndex((key, at) => !used.has(at) && key.length >= 4 && (key.includes(name) || name.includes(key)));
    if (column >= 0) {
      bindings[slot.id] = {kind: 'column', column};
      used.add(column);
    }
  }
  const images = slots.filter(slot => slot.kind === 'image');
  const productish = images.filter(slot => slot.role === 'product' || (slot.role === null && PRODUCT_WORDS.some(word => columnKey(slot.name).includes(word))));
  const plain = images.filter(slot => slot.role === null || slot.role === 'product');
  const targets = productish.length ? productish : plain.length === 1 ? plain : [];
  for (const slot of targets) {
    if (photo !== null) bindings[slot.id] = {kind: 'column', column: photo};
    else if (options.files) bindings[slot.id] = {kind: 'files'};
  }
  return {sku, bindings};
}

/** A binding that still makes sense for this table and layer (a column that exists, placeholders on a text). */
export function bindingFits(binding: CatalogBinding, slot: CatalogSlot, table: CatalogTable): boolean {
  if (binding.kind === 'keep') return true;
  if (binding.kind === 'column') return binding.column >= 0 && binding.column < table.headers.length;
  if (binding.kind === 'template') return slot.kind === 'text' && slot.placeholders.length > 0;
  return slot.kind === 'image';
}

/** Whether a mapping can run: a SKU column, and at least one layer filled from the table. The answer is for the user; null is yes. */
export function mappingProblem(mapping: CatalogMapping, slots: readonly CatalogSlot[], table: CatalogTable): string | null {
  if (mapping.sku === null || mapping.sku >= table.headers.length) return 'Choose the column with the article number.';
  const filled = slots.some(slot => {
    const binding = mapping.bindings[slot.id];
    return binding && binding.kind !== 'keep' && bindingFits(binding, slot, table);
  });
  return filled ? null : 'Choose which layers to fill from the table.';
}

// ── Rows ───────────────────────────────────────────────────────────────────────────────────────

/** A row's SKU as the card keeps it (trimmed, at most 64 characters); '' when the cell is empty. */
export function rowSku(table: CatalogTable, mapping: CatalogMapping, row: number): string {
  if (mapping.sku === null) return '';
  return (table.rows[row]?.[mapping.sku] ?? '').replace(/\s+/g, ' ').trim().slice(0, CATALOG_LIMITS.sku);
}

/** The rows that make cards (those with a SKU), and the ones skipped for having none. */
export function catalogRows(table: CatalogTable, mapping: CatalogMapping): {rows: number[]; withoutSku: number[]} {
  const rows: number[] = [], withoutSku: number[] = [];
  table.rows.forEach((_, row) => (rowSku(table, mapping, row) ? rows : withoutSku).push(row));
  return {rows, withoutSku};
}

/** {{…}} placeholders replaced by their columns' cells in plain text (an unknown name stays as written). */
export function fillPlaceholderText(characters: string, table: CatalogTable, row: number): string {
  return characters.replace(PLACEHOLDER, (whole, name: string) => {
    const column = placeholderColumn(name, table.headers);
    return column === null ? whole : (table.rows[row]?.[column] ?? '');
  });
}

/** What a text layer reads on the card a row makes (the mapping's preview); null when the binding keeps it. */
export function slotText(slot: CatalogSlot, binding: CatalogBinding | undefined, table: CatalogTable, row: number, characters = slot.sample): string | null {
  if (!binding || slot.kind !== 'text') return null;
  if (binding.kind === 'column') return table.rows[row]?.[binding.column] ?? '';
  if (binding.kind === 'template') return fillPlaceholderText(characters, table, row);
  return null;
}

// ── Photos ─────────────────────────────────────────────────────────────────────────────────────

const isWordChar = (char: string | undefined) => !!char && /[\p{L}\p{N}]/u.test(char);
const baseName = (name: string) => name.replace(/^.*[\\/]/, '').replace(/\.[a-z0-9]{1,5}$/i, '').trim().toLowerCase();

/**
 * Which dropped file is each SKU's photo, by its name: the name is the SKU ("12345.jpg"), starts with it ("12345_1.jpg",
 * "12345 cream.png"), or holds it as a whole word ("cream-12345-white.webp"), in that order of preference, then by name. A SKU
 * that is part of a longer number never matches it ("123" is not "1234.jpg"). Answers a file index per SKU, -1 for none.
 */
export function matchPhotoFiles(skus: readonly string[], fileNames: readonly string[]): number[] {
  const files = fileNames.map((name, index) => ({index, name, base: baseName(name)}));
  const exact = new Map<string, number>();
  for (const file of [...files].sort((a, b) => a.name.localeCompare(b.name))) if (!exact.has(file.base)) exact.set(file.base, file.index);
  return skus.map(raw => {
    const sku = raw.trim().toLowerCase();
    if (!sku) return -1;
    const found = exact.get(sku);
    if (found !== undefined) return found;
    let best: {rank: number; name: string; index: number} | null = null;
    for (const file of files) {
      let rank = -1;
      if (file.base.startsWith(sku) && !isWordChar(file.base[sku.length])) rank = 1;
      else {
        for (let at = file.base.indexOf(sku, 1); at > 0; at = file.base.indexOf(sku, at + 1)) {
          if (!isWordChar(file.base[at - 1]) && !isWordChar(file.base[at + sku.length])) {
            rank = 2;
            break;
          }
        }
      }
      if (rank < 0) continue;
      if (!best || rank < best.rank || (rank === best.rank && file.name.localeCompare(best.name) < 0)) best = {rank, name: file.name, index: file.index};
    }
    return best ? best.index : -1;
  });
}

// ── Room in the file ───────────────────────────────────────────────────────────────────────────

/** UTF-8 bytes of a string (what the document caps count). */
export function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code >= 0xd800 && code <= 0xdbff ? (i++, 4) : 3;
  }
  return bytes;
}

/** The template's layers (itself included). */
export function templateNodes(doc: Pick<DesignDocument, 'nodes'>, frameId: NodeId): SceneNode[] {
  const out: SceneNode[] = [];
  const stack = [frameId];
  while (stack.length) {
    const node = doc.nodes[stack.pop()!];
    if (!node) continue;
    out.push(node);
    for (const child of node.children ?? []) stack.push(child);
  }
  return out;
}

export type CatalogCapacity = {
  /** Rows of the run that fit, at most the rows asked for. */
  fits: number;
  /** The cap that stops it short; null when every row fits. */
  limit: 'nodes' | 'bytes' | 'pages' | 'images' | null;
  /** One card's layers and estimated bytes. */
  perCard: {nodes: number; bytes: number};
};

/**
 * How many cards the file can still take (`DESIGN_DOCUMENT_CAPS` via `documentCaps()`): its layers, its JSON size (`docBytes`, measured
 * by the caller) with each card's estimate (the template's JSON plus `rowBytes`, the mapped cells' average), the page the run adds, and
 * one picture record per card when `photos`.
 */
export function catalogCapacity(input: {doc: Pick<DesignDocument, 'nodes' | 'pages' | 'images'>; frameId: NodeId; rows: number; caps: DocumentCaps; docBytes: number; rowBytes?: number; photos?: boolean}): CatalogCapacity {
  const {doc, caps} = input;
  const nodes = templateNodes(doc, input.frameId);
  const perCard = {nodes: nodes.length, bytes: utf8Length(JSON.stringify(nodes)) + Math.ceil(input.rowBytes ?? 0) + 128};
  if (!nodes.length || doc.pages.length >= caps.pages) return {fits: 0, limit: nodes.length ? 'pages' : null, perCard};
  // The page node and its share of the file.
  const nodeRoom = caps.nodes - Object.keys(doc.nodes).length - 1;
  const byteRoom = caps.bytes - input.docBytes - 1024;
  const options: {limit: CatalogCapacity['limit']; fits: number}[] = [
    {limit: 'nodes', fits: Math.floor(nodeRoom / perCard.nodes)},
    {limit: 'bytes', fits: Math.floor(byteRoom / perCard.bytes)},
  ];
  if (input.photos) options.push({limit: 'images', fits: DESIGN_FIELD_LIMITS.images - Object.keys(doc.images).length});
  let fits = input.rows, limit: CatalogCapacity['limit'] = null;
  for (const option of options) {
    if (option.fits < fits) {
      fits = Math.max(0, option.fits);
      limit = option.limit;
    }
  }
  return {fits, limit, perCard};
}

/** Rows per undo step: up to 50, fewer for a heavy template so one step stays a modest autosave patch. */
export function catalogBatchRows(perCard: {nodes: number; bytes: number}): number {
  return Math.max(1, Math.min(CATALOG_LIMITS.batchRows, Math.floor(CATALOG_LIMITS.batchNodes / Math.max(1, perCard.nodes)), Math.floor(CATALOG_LIMITS.batchBytes / Math.max(1, perCard.bytes))));
}

// ── The page ───────────────────────────────────────────────────────────────────────────────────

/** "Catalog — 12.10.2026", or "… (2)" when the file has one already. */
export function catalogPageName(date: Date, taken: readonly string[]): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  const base = `Catalog — ${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) if (!taken.includes(`${base} (${n})`)) return `${base} (${n})`;
}

/** Where card `index` of `count` stands on the catalog page: a grid about as tall as it is wide, at most ten across. */
export function catalogGrid(count: number, size: {width: number; height: number}): {columns: number; gap: number; position: (index: number) => Vec} {
  const width = Math.max(1, size.width), height = Math.max(1, size.height);
  const columns = Math.max(1, Math.min(10, Math.ceil(Math.sqrt((Math.max(1, count) * height) / width))));
  const gap = Math.max(40, Math.round(Math.min(width, height) * 0.1));
  return {columns, gap, position: index => ({x: (index % columns) * (width + gap), y: Math.floor(index / columns) * (height + gap)})};
}

// ── One card ───────────────────────────────────────────────────────────────────────────────────

/** A text's width on one line (natural width), measured by the editor's text engine. */
export type MeasureText = (node: SceneNode) => number;

export type CardPlan = {
  /** The template's copy with fresh ids, parents before children; the root stands at its grid place with the row's meta. */
  nodes: SceneNode[];
  rootId: NodeId;
  /** Template id → copy id. */
  ids: Map<NodeId, NodeId>;
  /** Changes to copied layers, by copy id, applied after they exist (inside an instance they become overrides). */
  updates: Map<NodeId, Partial<SceneNode>>;
  sku: string;
  /** A picture layer bound to a photo the row has none for: it keeps the template's placeholder. */
  missingPhoto: boolean;
};

export type CardPlanInput = {
  doc: Pick<DesignDocument, 'nodes'>;
  frameId: NodeId;
  table: CatalogTable;
  mapping: CatalogMapping;
  row: number;
  position: Vec;
  /** The picture the row puts into a picture layer bound to `binding`, or null to keep the placeholder. */
  photoFor?: (slotId: NodeId, binding: CatalogBinding) => ImageRef | null;
  /** Without it, an auto-width text that got longer always wraps. */
  measure?: MeasureText;
  makeId?: () => NodeId;
};

/** `text` with each {{…}} replaced by its column's cell, styles kept (the inserted characters take the placeholder's style). */
export function fillPlaceholders(text: TextProps, table: CatalogTable, row: number): TextProps {
  const matches = [...text.characters.matchAll(PLACEHOLDER)];
  let out = text;
  for (let i = matches.length - 1; i >= 0; i--) {
    const match = matches[i];
    const column = placeholderColumn(match[1], table.headers);
    if (column === null) continue;
    out = insertText(out, match.index!, match.index! + match[0].length, table.rows[row]?.[column] ?? '');
  }
  return out;
}

/** The whole text replaced by `value`, in the style of its first character. */
export const replaceText = (text: TextProps, value: string): TextProps => insertText(text, 0, text.characters.length, value);

/** Left offset of a layer inside the card (rotation ignored: cards are laid out upright). */
function offsetInCard(doc: Pick<DesignDocument, 'nodes'>, node: SceneNode, frameId: NodeId): number {
  let left = 0;
  for (let at: SceneNode | undefined = node, depth = 0; at && at.id !== frameId && depth < 256; at = at.parentId ? doc.nodes[at.parentId] : undefined, depth++) left += at.x;
  return left;
}

/** The card's side margin as its other layers show it: the least distance of any of them from the left or right edge (full-bleed
 *  layers aside); 6 % of the width when nothing else says. */
function contentMargin(doc: Pick<DesignDocument, 'nodes'>, card: SceneNode, except: NodeId): number {
  let margin = Infinity;
  for (const id of card.children ?? []) {
    const child = doc.nodes[id];
    if (!child || id === except || !child.visible || child.rotation) continue;
    for (const side of [child.x, card.width - child.x - child.width]) if (side > 4 && side < margin) margin = side;
  }
  return Number.isFinite(margin) ? margin : Math.round(card.width * 0.06);
}

/**
 * An auto-width text that no longer fits on one line wraps instead of widening the card or its auto layout: in a flow whose frame does
 * not hug its width it fills the frame (aligned as the frame placed it); otherwise it gets a fixed width up to the card's margin on
 * its side (a centred text keeps its centre) and grows down. One that still fits is left to the layout, which grows it away from its
 * alignment edge. Fixed-width, fixed-size and truncated texts already wrap and are left alone.
 */
export function wrapLongText(doc: Pick<DesignDocument, 'nodes'>, node: SceneNode, text: TextProps, frameId: NodeId, measure?: MeasureText): Partial<SceneNode> {
  if (!node.text || node.text.textAutoResize !== 'WIDTH_AND_HEIGHT' || node.textPath) return {};
  const natural = measure ? measure({...node, text}) : null;
  if (natural === null && text.characters.length <= node.text.characters.length) return {};
  const card = doc.nodes[frameId];
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  if (!card || !parent) return {};
  const flow = isAutoLayout(parent) && node.layoutPositioning !== 'ABSOLUTE' && parent.autoLayout!.layoutMode !== 'GRID';
  if (flow && parent.layoutSizingHorizontal !== 'HUG') {
    const layout = parent.autoLayout!;
    const inner = parent.width - layout.paddingLeft - layout.paddingRight;
    let room = inner;
    if (layout.layoutMode === 'HORIZONTAL') {
      const others = (parent.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => !!child && child.id !== node.id && child.visible && child.layoutPositioning !== 'ABSOLUTE');
      room = inner - others.reduce((sum, child) => sum + child.width, 0) - layout.itemSpacing * others.length;
    }
    if (natural !== null && natural <= room + 0.5) return {};
    const align = layout.layoutMode === 'VERTICAL' && text.textAlignHorizontal === 'LEFT'
      ? (layout.counterAxisAlignItems === 'CENTER' ? 'CENTER' : layout.counterAxisAlignItems === 'MAX' ? 'RIGHT' : 'LEFT')
      : text.textAlignHorizontal;
    return {layoutSizingHorizontal: 'FILL', text: {...text, textAutoResize: 'HEIGHT', textAlignHorizontal: align}};
  }
  const left = offsetInCard(doc, node, frameId);
  const margin = contentMargin(doc, card, node.id);
  let room: number, start: number;
  if (text.textAlignHorizontal === 'CENTER') {
    const centre = left + node.width / 2;
    const half = Math.min(centre, card.width - centre) - margin;
    room = 2 * half;
    start = centre - half;
  } else if (text.textAlignHorizontal === 'RIGHT') {
    room = left + node.width - margin;
    start = margin;
  } else {
    room = card.width - margin - left;
    start = left;
  }
  if (room <= node.width) {
    room = node.width;
    start = left;
  }
  if (natural !== null && natural <= room + 0.5) return {};
  const out: Partial<SceneNode> = {text: {...text, textAutoResize: 'HEIGHT'}, width: room, layoutSizingHorizontal: 'FIXED'};
  if (!flow && Math.abs(start - left) > 0.01) out.x = node.x + start - left;
  return out;
}

const imagePaint = (imageRef: ImageRef): ImagePaint => ({type: 'IMAGE', imageRef, scaleMode: 'FIT', opacity: 1, visible: true, blendMode: 'NORMAL'});

/** A picture layer's fills with the row's photo: its (first visible) image fill takes the new picture, its crop dropped; a product
 *  place without an image fill gets one that fits the photo in. */
export function photoFills(fills: readonly Paint[], ref: ImageRef): Paint[] {
  let at = fills.findIndex(paint => paint.type === 'IMAGE' && paint.visible);
  if (at < 0) at = fills.findIndex(paint => paint.type === 'IMAGE');
  if (at < 0) return [imagePaint(ref)];
  return fills.map((paint, index) => {
    if (index !== at || paint.type !== 'IMAGE') return paint;
    const {imageTransform: _crop, ...rest} = paint;
    void _crop;
    return {...rest, imageRef: ref, scaleMode: paint.scaleMode === 'CROP' ? 'FILL' : paint.scaleMode};
  });
}

/** The copy of the template one row makes: texts and photos from the row, the SKU and the set in its card meta. */
export function planCard(input: CardPlanInput): CardPlan {
  const {doc, frameId, table, mapping, row} = input;
  const template = doc.nodes[frameId];
  if (!template) throw new Error(`catalog: no template ${frameId}`);
  const sku = rowSku(table, mapping, row);
  const {nodes, ids} = cloneSubtrees(doc.nodes, [frameId], input.makeId);
  const rootId = ids.get(frameId)!;
  const root = nodes.find(node => node.id === rootId)!;
  const meta: CardMeta = cardMeta(template) ?? {v: 1, marketplace: 'wb'};
  const {variant: _variant, ...kept} = meta;
  void _variant;
  root.x = input.position.x;
  root.y = input.position.y;
  root.name = (sku || template.name).slice(0, DESIGN_FIELD_LIMITS.name);
  root.pluginData = withCardMeta(root.pluginData, {...kept, sku, group: meta.group ?? frameId});

  const updates = new Map<NodeId, Partial<SceneNode>>();
  let missingPhoto = false;
  for (const [slotId, binding] of Object.entries(mapping.bindings)) {
    const node = doc.nodes[slotId];
    const copy = ids.get(slotId);
    if (!node || !copy || binding.kind === 'keep') continue;
    if (node.type === 'TEXT' && node.text) {
      let text: TextProps;
      if (binding.kind === 'column') text = replaceText(node.text, (table.rows[row]?.[binding.column] ?? '').slice(0, DESIGN_FIELD_LIMITS.characters));
      else if (binding.kind === 'template') text = fillPlaceholders(node.text, table, row);
      else continue;
      if (text.characters === node.text.characters) continue;
      const partial: Partial<SceneNode> = {text, ...wrapLongText(doc, node, text, frameId, input.measure)};
      // An empty cell leaves no stray sample text behind, and no gap in an auto layout.
      if (!text.characters.trim()) partial.visible = false;
      updates.set(copy, partial);
    } else if (binding.kind === 'column' || binding.kind === 'files') {
      const ref = input.photoFor?.(slotId, binding) ?? null;
      if (!ref) {
        missingPhoto = true;
        continue;
      }
      updates.set(copy, {fills: photoFills(node.fills, ref)});
    }
  }
  return {nodes, rootId, ids, updates, sku, missingPhoto};
}

/** Puts a planned card on `pageId` in a transaction: its layers, then the row's changes (as overrides inside instances), then the
 *  template's variable modes on the copies. */
export function insertCard(tx: Transaction, plan: CardPlan, pageId: NodeId, variableModes?: DesignDocument['variableModes']): void {
  for (const node of plan.nodes) tx.create(node, node.id === plan.rootId ? pageId : node.parentId!);
  for (const [id, partial] of plan.updates) tx.update(id, withOverrideTracking(tx.doc, id, partial));
  if (variableModes) {
    for (const [from, to] of plan.ids) {
      const modes = variableModes[from];
      if (modes) tx.setVariableModes(to, modes);
    }
  }
}
