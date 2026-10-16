import type {ExportFormat, ExportSetting, NodeId, SceneNode} from '../../../../../../shared/design/types';

// What "Export" writes: export settings as the panel edits them ("2x", "512w", "@2x", PNG…) and
// the files they become. Pure, covered by node tests (tests/design-panel-layout-export.test.ts).

export const EXPORT_FORMATS: readonly ExportFormat[] = ['PNG', 'JPG', 'SVG', 'PDF', 'WEBP'];
export const FORMAT_EXTENSION: Record<ExportFormat, string> = {PNG: 'png', JPG: 'jpg', SVG: 'svg', PDF: 'pdf', WEBP: 'webp'};
/** Menu labels. PDF is the vector PDF the server prints (docs/design-tool.md §Export). */
export const FORMAT_LABEL: Record<ExportFormat, string> = {PNG: 'PNG', JPG: 'JPG', SVG: 'SVG', PDF: 'PDF', WEBP: 'WEBP'};
export const FORMAT_MIME: Record<ExportFormat, string> = {PNG: 'image/png', JPG: 'image/jpeg', SVG: 'image/svg+xml', PDF: 'application/pdf', WEBP: 'image/webp'};

/** What a PDF setting writes: vectors and text printed by the server, or, where the server's vector PDF is off
 *  (/api/config `designPdf: false`), a lossless picture inside a PDF page, named so in the menu. */
export type PdfKind = 'vector' | 'raster';
export const formatLabel = (format: ExportFormat, pdf: PdfKind = 'vector') => (format === 'PDF' && pdf === 'raster' ? 'PDF (raster)' : FORMAT_LABEL[format]);

/** SVG and the vector PDF keep vectors at any size (a PDF page is the frame at 1 px = 1 pt, as in Figma), so
 *  they have no scale. Everything else is painted at a size. */
export const formatHasScale = (format: ExportFormat, pdf: PdfKind = 'vector') => format !== 'SVG' && !(format === 'PDF' && pdf === 'vector');

export const SCALE_PRESETS: readonly ExportSetting['constraint'][] = [
  {type: 'SCALE', value: 0.5}, {type: 'SCALE', value: 0.75}, {type: 'SCALE', value: 1}, {type: 'SCALE', value: 1.5},
  {type: 'SCALE', value: 2}, {type: 'SCALE', value: 3}, {type: 'SCALE', value: 4},
  {type: 'WIDTH', value: 512}, {type: 'HEIGHT', value: 512},
];

export const SCALE_LIMITS = {min: 0.01, max: 32} as const;
export const SIDE_LIMITS = {min: 1, max: 16384} as const;

const short = (value: number) => String(Math.round(value * 100) / 100);

/** "1x", "0,5x", "512w", "300h". */
export function formatConstraint(constraint: ExportSetting['constraint']): string {
  const unit = constraint.type === 'WIDTH' ? 'w' : constraint.type === 'HEIGHT' ? 'h' : 'x';
  return short(constraint.value) + unit;
}

/** Reads what a designer types into the scale field: "2", "2x", "0.5x", "512w", "300h". */
export function parseConstraint(text: string): ExportSetting['constraint'] | null {
  const match = /^\s*(\d+(?:[.,]\d+)?|[.,]\d+)\s*([x×wh]?)\s*$/i.exec(text);
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  if (!Number.isFinite(value) || value <= 0) return null;
  const unit = match[2].toLowerCase();
  if (unit === 'w') return value >= SIDE_LIMITS.min && value <= SIDE_LIMITS.max ? {type: 'WIDTH', value: Math.round(value)} : null;
  if (unit === 'h') return value >= SIDE_LIMITS.min && value <= SIDE_LIMITS.max ? {type: 'HEIGHT', value: Math.round(value)} : null;
  return value >= SCALE_LIMITS.min && value <= SCALE_LIMITS.max ? {type: 'SCALE', value: Math.round(value * 100) / 100} : null;
}

/** The setting "+" adds: PNG 1x first; then the next whole scale with its "@Nx" suffix (Figma's habit),
 *  up to 4x, then 1x again. */
export function nextExportSetting(existing: readonly ExportSetting[]): ExportSetting {
  if (!existing.length) return {format: 'PNG', suffix: '', constraint: {type: 'SCALE', value: 1}};
  const last = existing[existing.length - 1];
  const scales = existing.filter(setting => setting.constraint.type === 'SCALE').map(setting => setting.constraint.value);
  const top = scales.length ? Math.max(...scales) : 1;
  const next = Math.floor(top) + 1;
  if (next > 4) return {format: last.format, suffix: '', constraint: {type: 'SCALE', value: 1}};
  return {format: formatHasScale(last.format) ? last.format : 'PNG', suffix: `@${next}x`, constraint: {type: 'SCALE', value: next}};
}

// Characters Windows, macOS or zip readers refuse in a name, and control characters.
const UNSAFE = /[\\:*?"<>|\u0000-\u001f\u007f]/g;
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** One path segment: unsafe characters become "_", no leading or trailing dots and spaces, ≤ 120 chars. */
export function safeSegment(text: string): string {
  let out = text.replace(UNSAFE, '_').replace(/\s+/g, ' ').trim().replace(/^\.+|\.+$/g, '').trim();
  if (out.length > 120) out = out.slice(0, 120).trim();
  if (RESERVED.test(out)) out = `_${out}`;
  return out;
}

/** The file a setting writes for a layer: the layer's name plus the suffix, "/" in a name makes
 *  folders (as Figma does: "Icons/Arrow" → Icons/Arrow@2x.png). */
export function exportFileName(name: string, setting: Pick<ExportSetting, 'format' | 'suffix'>): string {
  const parts = name.split('/').map(safeSegment).filter(Boolean);
  const base = parts.pop() || 'Untitled';
  const file = safeSegment(base + setting.suffix) || 'Untitled';
  return [...parts, `${file}.${FORMAT_EXTENSION[setting.format]}`].join('/');
}

export type ExportJob = {nodeId: NodeId; setting: ExportSetting; path: string};

/** Every file of the layers' settings, in order, names made unique ("Button.png", "Button (2).png"). */
export function planExport(items: readonly {node: Pick<SceneNode, 'id' | 'name'>; settings: readonly ExportSetting[]}[]): ExportJob[] {
  const taken = new Set<string>();
  const jobs: ExportJob[] = [];
  for (const {node, settings} of items) {
    for (const setting of settings) {
      const path = uniquePath(exportFileName(node.name, setting), taken);
      jobs.push({nodeId: node.id, setting, path});
    }
  }
  return jobs;
}

function uniquePath(path: string, taken: Set<string>): string {
  const key = (value: string) => value.toLocaleLowerCase('en');
  if (!taken.has(key(path))) {
    taken.add(key(path));
    return path;
  }
  const dot = path.lastIndexOf('.');
  const stem = path.slice(0, dot), ext = path.slice(dot);
  for (let n = 2; ; n++) {
    const next = `${stem} (${n})${ext}`;
    if (!taken.has(key(next))) {
      taken.add(key(next));
      return next;
    }
  }
}

/** The name of the zip several files go into: the one layer's name, or the file's. */
export function zipName(base: string): string {
  return `${safeSegment(base.split('/').pop() ?? '') || 'Export'}.zip`;
}

/** A short line about a layer's settings for lists: "PNG 1x, SVG, PDF". */
export function settingsSummary(settings: readonly ExportSetting[], pdf: PdfKind = 'vector'): string {
  return settings.map(setting => (formatHasScale(setting.format, pdf) ? `${setting.format} ${formatConstraint(setting.constraint)}` : setting.format)
    + (setting.format === 'SVG' && setting.svgIdAttribute ? ' with id' : '') + (setting.suffix ? ` "${setting.suffix}"` : '')).join(', ');
}

/** The vector PDF puts every PDF setting of one export with the same suffix into one file, a page per layer (Figma
 *  exports several selected frames as one multi-page PDF): "Poster.pdf" for one layer, "<base><suffix>.pdf" for
 *  several. The other files keep their paths; the name is made unique against them. */
export type PdfGroup = {suffix: string; jobs: ExportJob[]; path: string};
export function groupPdfJobs(jobs: readonly ExportJob[], base: string): {pdf: PdfGroup[]; other: ExportJob[]} {
  const other = jobs.filter(job => job.setting.format !== 'PDF');
  const bySuffix = new Map<string, ExportJob[]>();
  for (const job of jobs) {
    if (job.setting.format !== 'PDF') continue;
    const group = bySuffix.get(job.setting.suffix) ?? [];
    if (!group.some(each => each.nodeId === job.nodeId)) group.push(job);
    bySuffix.set(job.setting.suffix, group);
  }
  const taken = new Set(other.map(job => job.path.toLocaleLowerCase('en')));
  const pdf: PdfGroup[] = [];
  for (const [suffix, group] of bySuffix) {
    const wanted = group.length === 1 ? group[0].path : exportFileName(base.split('/').pop() || 'Export', {format: 'PDF', suffix});
    pdf.push({suffix, jobs: group, path: uniquePath(wanted, taken)});
  }
  return {pdf, other};
}

/** "Export Button", "Export 3 layers". */
export function exportButtonLabel(names: readonly string[], layers: (count: number) => string): string {
  if (names.length === 1) return `Export ${names[0] || 'layer'}`;
  return `Export ${layers(names.length)}`;
}
