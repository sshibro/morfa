import type {DesignDocument} from '../../../shared/design/types';
import type {DesignSaved, DesignVersionSummary} from '../../../shared/design/api';
import {DESIGN_LIMITS, type DesignLimits} from '../../../shared/design/limits';

// "Version history" without React: labels, the list grouped by day, the retention note, the restore flow and
// a small cache of version documents. The panel (VersionHistory.tsx) renders what these answer.

// ── Labels ───────────────────────────────────────────────────────────────────────────────────────

/** The server keeps one label of at most 120 characters (control characters become spaces), so a
 *  version's name and its optional description share it, split by U+2028 LINE SEPARATOR: a character
 *  the server keeps, a name never contains, and any reader shows as a line break. */
export const LABEL_SEPARATOR = '\u2028';
export const VERSION_LABEL_MAX = 120;
export const VERSION_NAME_MAX = 60;

export type VersionLabel = {name: string; description: string};

const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();

/** The label to store for a name and a description; null when the name is empty. */
export function encodeVersionLabel(name: string, description = ''): string | null {
  const title = [...clean(name)].slice(0, VERSION_NAME_MAX).join('').trim();
  if (!title) return null;
  const room = VERSION_LABEL_MAX - [...title].length - 1;
  const text = room > 0 ? [...clean(description)].slice(0, room).join('').trim() : '';
  return text ? title + LABEL_SEPARATOR + text : title;
}

/** Name and description of a stored label; null for an automatic version. */
export function decodeVersionLabel(label: string | null): VersionLabel | null {
  if (label === null) return null;
  const at = label.indexOf(LABEL_SEPARATOR);
  const name = (at < 0 ? label : label.slice(0, at)).trim();
  const description = at < 0 ? '' : label.slice(at + 1).trim();
  return {name: name || 'Untitled', description};
}

/** How many characters the description may still take after `name`. */
export const descriptionRoom = (name: string) => Math.max(0, VERSION_LABEL_MAX - 1 - Math.min(VERSION_NAME_MAX, [...clean(name)].length));

// ── Dates ────────────────────────────────────────────────────────────────────────────────────────

export type ClockOptions = {now: number; timeZone?: string};

const dayKeyFormat = new Map<string, Intl.DateTimeFormat>();
function formatter(timeZone: string | undefined, kind: 'key' | 'day' | 'dayYear' | 'time'): Intl.DateTimeFormat {
  const cacheKey = `${timeZone ?? ''}|${kind}`;
  let format = dayKeyFormat.get(cacheKey);
  if (!format) {
    format = kind === 'key' ? new Intl.DateTimeFormat('en-CA', {timeZone, year: 'numeric', month: '2-digit', day: '2-digit'})
      : kind === 'day' ? new Intl.DateTimeFormat('en-US', {timeZone, day: 'numeric', month: 'long'})
        : kind === 'dayYear' ? new Intl.DateTimeFormat('en-US', {timeZone, day: 'numeric', month: 'long', year: 'numeric'})
          : new Intl.DateTimeFormat('en-US', {timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23'});
    dayKeyFormat.set(cacheKey, format);
  }
  return format;
}

/** 'YYYY-MM-DD' of the moment in the time zone. */
export const dayKey = (time: number, timeZone?: string) => formatter(timeZone, 'key').format(time);
/** "14:05". */
export const timeLabel = (time: number, timeZone?: string) => formatter(timeZone, 'time').format(time);

/** "Today", "Yesterday", "October 3", "October 3, 2025" (another year). */
export function dayTitle(time: number, clock: ClockOptions): string {
  const key = dayKey(time, clock.timeZone);
  if (key === dayKey(clock.now, clock.timeZone)) return 'Today';
  // The day 24 hours ago (Moscow keeps no daylight-saving time; elsewhere this can be off for an hour a year).
  if (key === dayKey(clock.now - 86_400_000, clock.timeZone)) return 'Yesterday';
  const sameYear = key.slice(0, 4) === dayKey(clock.now, clock.timeZone).slice(0, 4);
  return formatter(clock.timeZone, sameYear ? 'day' : 'dayYear').format(time);
}

/** "today at 14:05", "yesterday at 9:30", "October 3 at 18:00": the moment a version was taken, in a sentence. */
export function momentPhrase(iso: string, clock: ClockOptions): string {
  const time = Date.parse(iso);
  const day = dayTitle(time, clock);
  const lead = day === 'Today' || day === 'Yesterday' ? day.toLowerCase() : day;
  return `${lead} at ${timeLabel(time, clock.timeZone)}`;
}

/** The preview banner: "You are viewing the version from October 3, 18:00", "…, saved today at 14:05",
 *  with the name of a named version. */
export function previewTitle(version: Pick<DesignVersionSummary, 'label' | 'createdAt'>, clock: ClockOptions): string {
  const time = Date.parse(version.createdAt);
  const day = dayTitle(time, clock);
  const recent = day === 'Today' || day === 'Yesterday';
  const when = recent ? `saved ${day.toLowerCase()} at ${timeLabel(time, clock.timeZone)}` : `from ${day}, ${timeLabel(time, clock.timeZone)}`;
  const label = decodeVersionLabel(version.label);
  return label ? `You are viewing the version "${label.name}"${recent ? ',' : ''} ${when}` : `You are viewing the version${recent ? ',' : ''} ${when}`;
}

/** The toast after a restore: which version came back (the server keeps the state it replaced). */
export function restoredMessage(version: Pick<DesignVersionSummary, 'label' | 'createdAt'>, clock: ClockOptions): string {
  const time = Date.parse(version.createdAt);
  const day = dayTitle(time, clock);
  const at = timeLabel(time, clock.timeZone);
  const label = decodeVersionLabel(version.label);
  const first = label ? `Restored version "${label.name}".`
    : day === 'Today' || day === 'Yesterday' ? `Restored the version saved ${day.toLowerCase()} at ${at}.`
      : `Restored the version from ${day}, ${at}.`;
  return `${first} The previous state of the file is saved in the history.`;
}

// ── The list ─────────────────────────────────────────────────────────────────────────────────────

export type VersionRow = {
  kind: 'version';
  version: DesignVersionSummary;
  /** The label's name, or "Autosave". */
  title: string;
  description: string;
  named: boolean;
  time: string;
};
/** A run of automatic versions folded under its newest one: "5 more autosaves". */
export type MoreRow = {kind: 'more'; key: string; count: number};
export type VersionDay = {key: string; title: string; rows: (VersionRow | MoreRow)[]};

/** Runs of this many automatic versions or more fold. */
export const FOLD_FROM = 3;

export function versionRow(version: DesignVersionSummary, timeZone?: string): VersionRow {
  const label = decodeVersionLabel(version.label);
  return {
    kind: 'version',
    version,
    title: label ? label.name : 'Autosave',
    description: label?.description ?? '',
    named: !!label,
    time: timeLabel(Date.parse(version.createdAt), timeZone),
  };
}

/** Versions newest first, grouped by local day. In each day, a run of FOLD_FROM or more automatic
 *  versions shows its newest one and a "more" row, unless its key (the newest's id) is in `expanded`. */
export function groupVersions(versions: readonly DesignVersionSummary[], clock: ClockOptions & {expanded?: ReadonlySet<string>}): VersionDay[] {
  const sorted = [...versions].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.version - a.version);
  const days: VersionDay[] = [];
  let run: VersionRow[] = [];
  const flush = (day: VersionDay) => {
    if (!run.length) return;
    const key = run[0].version.id;
    if (run.length >= FOLD_FROM && !clock.expanded?.has(key)) day.rows.push(run[0], {kind: 'more', key, count: run.length - 1});
    else day.rows.push(...run);
    run = [];
  };
  for (const version of sorted) {
    const time = Date.parse(version.createdAt);
    const key = dayKey(time, clock.timeZone);
    let day = days[days.length - 1];
    if (!day || day.key !== key) {
      if (day) flush(day);
      day = {key, title: dayTitle(time, clock), rows: []};
      days.push(day);
    }
    const row = versionRow(version, clock.timeZone);
    if (row.named) {
      flush(day);
      day.rows.push(row);
    } else run.push(row);
  }
  if (days.length) flush(days[days.length - 1]);
  return days;
}

/** "autosave", "autosaves". */
export function autosaveWord(count: number): string {
  return count === 1 ? 'autosave' : 'autosaves';
}

function daysPhrase(days: number): string {
  if (days === 365 || days === 366) return 'year';
  return days === 1 ? '1 day' : `${days} days`;
}

/** The note under the list: how long the history is kept (shared/design/limits.ts). */
export function historyNote(limits: Pick<DesignLimits, 'historyDays'> = DESIGN_LIMITS): {title: string; detail: string} {
  return {
    title: `History for the last ${daysPhrase(limits.historyDays)}.`,
    detail: 'Autosaves older than that are deleted; versions saved by hand stay.',
  };
}

// ── Restoring ────────────────────────────────────────────────────────────────────────────────────

export type RestoreStep = 'saving' | 'loading' | 'restoring' | 'done';

export type RestoreDeps = {
  /** Stores the editor's unsaved edits first; rejects when they could not be stored. */
  flush(): Promise<void>;
  /** The server version the editor's copy is based on (read after the flush). */
  baseVersion(): number;
  /** The version's document. */
  document(): Promise<DesignDocument>;
  /** POST …/restore with `baseVersion`. */
  restore(baseVersion: number): Promise<DesignSaved>;
  /** The editor now shows `doc` as the file at `version`, without saving it back. */
  adopt(doc: DesignDocument, version: number): void;
  onStep?(step: RestoreStep): void;
};

export type RestoreResult = {version: number; doc: DesignDocument; retried: boolean};

/** Shown as it is. */
export class RestoreError extends Error {
  constructor(message: string, readonly reason: 'unsaved' | 'conflict' | 'failed') {
    super(message);
    this.name = 'RestoreError';
  }
}

/** A 409 `version_conflict` and the server's current version, if the answer said it. */
export function versionConflict(error: unknown): {conflict: boolean; currentVersion: number | null} {
  const value = error as {status?: number; details?: {code?: unknown; currentVersion?: unknown}} | null;
  const conflict = value?.status === 409 && value.details?.code === 'version_conflict';
  return {conflict, currentVersion: conflict && typeof value?.details?.currentVersion === 'number' ? value.details.currentVersion : null};
}

const messageOf = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/**
 * "Restore": stores the edits not yet saved, reads the version, asks the server to make it the file's
 * next version on top of the editor's base, then shows it. The server keeps the document it replaces as a
 * version, so when another tab saved meanwhile (409 with the current version) nothing is lost by restoring
 * over that version once more; a second conflict, or one without a version, stops.
 */
export async function restoreVersion(deps: RestoreDeps): Promise<RestoreResult> {
  deps.onStep?.('saving');
  try {
    await deps.flush();
  } catch (error) {
    throw new RestoreError(`${messageOf(error, 'Could not save the latest changes.')} The version was not restored.`, 'unsaved');
  }
  deps.onStep?.('loading');
  let doc: DesignDocument;
  try {
    doc = await deps.document();
  } catch (error) {
    throw new RestoreError(messageOf(error, 'Could not load the version.'), 'failed');
  }
  deps.onStep?.('restoring');
  let base = deps.baseVersion();
  let retried = false;
  for (;;) {
    try {
      const saved = await deps.restore(base);
      deps.adopt(doc, saved.version);
      deps.onStep?.('done');
      return {version: saved.version, doc, retried};
    } catch (error) {
      const {conflict, currentVersion} = versionConflict(error);
      if (conflict && !retried && currentVersion !== null) {
        retried = true;
        base = currentVersion;
        continue;
      }
      if (conflict) throw new RestoreError('The file is being changed in another tab at the same time. Close it and try again.', 'conflict');
      throw new RestoreError(messageOf(error, 'Could not restore the version.'), 'failed');
    }
  }
}

// ── Version documents ────────────────────────────────────────────────────────────────────────────

/** The last few version documents read, so clicking back and forth does not download them again. A
 *  failed read is forgotten. Versions never change, so entries never go stale. */
export function createVersionCache(read: (versionId: string) => Promise<DesignDocument>, size = 4) {
  const entries = new Map<string, Promise<DesignDocument>>();
  return {
    get(versionId: string): Promise<DesignDocument> {
      let entry = entries.get(versionId);
      if (entry) {
        entries.delete(versionId);
        entries.set(versionId, entry);
        return entry;
      }
      entry = read(versionId);
      entries.set(versionId, entry);
      entry.catch(() => {
        if (entries.get(versionId) === entry) entries.delete(versionId);
      });
      while (entries.size > size) entries.delete(entries.keys().next().value!);
      return entry;
    },
    has: (versionId: string) => entries.has(versionId),
  };
}
