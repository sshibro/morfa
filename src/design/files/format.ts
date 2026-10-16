// Words and numbers of the file browser, in English. Pure, so node tests cover them.

const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60],
];

let short: Intl.RelativeTimeFormat | null = null;
let long: Intl.RelativeTimeFormat | null = null;

/**
 * "5 min ago", "3 hr ago", "yesterday", "3 days ago", "last week" (Intl.RelativeTimeFormat('en')):
 * minutes and hours in the short style without the dot after "min" and "hr", days and longer in full words,
 * because the short forms there ("last yr.") read as clipped. Under 45 seconds, "just now".
 */
export function relativeTime(iso: string, now = Date.now()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const seconds = Math.round((then - now) / 1000);
  if (Math.abs(seconds) < 45) return 'just now';
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size || unit === 'minute') {
      const value = Math.round(seconds / size) || (seconds < 0 ? -1 : 1);
      if (unit === 'minute' || unit === 'hour') {
        short ??= new Intl.RelativeTimeFormat('en', {numeric: 'auto', style: 'short'});
        return short.format(value, unit).replace(/\b(min|hr|sec)\./g, '$1');
      }
      long ??= new Intl.RelativeTimeFormat('en', {numeric: 'auto', style: 'long'});
      return long.format(value, unit);
    }
  }
  return '';
}

/** "Modified 5 min ago" / "Modified yesterday": a card's line of its own, in sentence case. */
export const editedAgo = (iso: string, now?: number) => `Modified ${relativeTime(iso, now)}`;
/** "Deleted 3 days ago". */
export const trashedAgo = (iso: string, now?: number) => `Deleted ${relativeTime(iso, now)}`;

const KB = 1024;
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

/** Binary sizes: "512 KB", "120 MB", "1.2 GB" (one decimal below 10, none above). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0\u00a0B';
  const exponent = Math.min(SIZE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(KB)));
  const value = bytes / KB ** exponent;
  const rounded = value < 10 && exponent > 0 ? Math.round(value * 10) / 10 : Math.round(value);
  // 1023.6 MB rounds up to the next unit rather than printing "1024 MB".
  if (rounded >= KB && exponent < SIZE_UNITS.length - 1) return formatBytes(KB ** (exponent + 1));
  return `${String(rounded)} ${SIZE_UNITS[exponent]}`;
}

/** English plural: plural(1, 'file', 'files') → 'file', any other count gives the second form. */
export function plural(count: number, one: string, other: string): string {
  return Math.abs(count) === 1 ? one : other;
}

/** Sorting the browser offers: by last change (newest first; in the trash, by when it was deleted), by name (A→Z), by creation
 *  (newest first), by when it was last opened in this browser (Figma's "Last viewed"; never-opened files after, by last change). */
export type FileSort = 'updated' | 'name' | 'created' | 'viewed';

type Sortable = {id?: string; name: string; updatedAt: string; createdAt: string; trashedAt?: string | null};

export function sortFiles<T extends Sortable>(files: readonly T[], sort: FileSort, viewed: ReadonlyMap<string, number> = new Map()): T[] {
  const collator = new Intl.Collator('en', {numeric: true, sensitivity: 'base'});
  const list = [...files];
  if (sort === 'name') return list.sort((a, b) => collator.compare(a.name, b.name));
  const changed = (file: T) => Date.parse(file.trashedAt ?? file.updatedAt);
  const time = (file: T) => (sort === 'created' ? Date.parse(file.createdAt) : sort === 'viewed' ? (file.id === undefined ? undefined : viewed.get(file.id)) ?? -Infinity : changed(file));
  return list.sort((a, b) => time(b) - time(a) || changed(b) - changed(a) || collator.compare(a.name, b.name));
}

/** Case-insensitive name search. */
export function matchesSearch(name: string, query: string): boolean {
  const fold = (text: string) => text.toLocaleLowerCase('en').trim();
  const needle = fold(query);
  return !needle || fold(name).includes(needle);
}

/** The file browser's kind filter, as Figma's "All files / Design files / FigJam files". */
export type FileKindFilter = 'all' | 'design' | 'board';

/** The files of one kind; a file without a kind is a design file. */
export const filterKind = <T extends {kind?: string}>(files: readonly T[], kind: FileKindFilter): T[] =>
  kind === 'all' ? [...files] : files.filter(file => (file.kind === 'board' ? 'board' : 'design') === kind);
