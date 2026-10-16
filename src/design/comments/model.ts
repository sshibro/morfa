import type {DesignCommentChange, DesignCommentMention, DesignCommentThread} from '../../../shared/design/comments';
import {shiftMentions} from '../../../shared/design/comments';

// The comments' client model (docs/design-tool.md §Teams "Comments"): merging the server's changes, the panel's filters and order,
// unread counts, clustering pins when zoomed out, mention typing and the Russian relative time. Pure functions: node tests cover them.

export type Threads = ReadonlyMap<string, DesignCommentThread>;

/** The threads after `changes` (a page of `GET ?since=` or one write's answer): a newer copy replaces an older one, a tombstone removes the
 *  thread. Answers in any order converge: a copy never replaces one with a higher counter. Returns the same map when nothing changed. */
export function mergeChanges(threads: Threads, changes: readonly DesignCommentChange[]): Threads {
  let next: Map<string, DesignCommentThread> | null = null;
  const tombstones = new Map<string, number>();
  for (const change of changes) {
    const current = (next ?? threads).get(change.id);
    if (change.deleted) {
      tombstones.set(change.id, change.seq);
      if (current && current.seq <= change.seq) (next ??= new Map(threads)).delete(change.id);
      continue;
    }
    if ((tombstones.get(change.id) ?? -1) >= change.seq) continue;
    if (current && current.seq > change.seq) continue;
    // What the viewer has read here already (marked a moment ago, before an older answer arrived) stays read.
    const incoming =
      current && current.readSeq > change.readSeq
        ? {...change, readSeq: current.readSeq, unread: current.readSeq >= change.seq ? 0 : change.unread}
        : change;
    if (current && current.seq === incoming.seq && current.readSeq === incoming.readSeq && current.unread === incoming.unread) continue;
    (next ??= new Map(threads)).set(change.id, incoming);
  }
  return next ?? threads;
}

/** The thread as read by its viewer now (before the server confirms). */
export const asRead = (thread: DesignCommentThread): DesignCommentThread =>
  thread.unread === 0 && thread.readSeq >= thread.seq ? thread : {...thread, unread: 0, readSeq: Math.max(thread.readSeq, thread.seq)};

export type CommentFilter = {
  /** "Open" or "Resolved". */
  status: 'open' | 'resolved';
  /** Threads the viewer started or replied to. */
  mine: boolean;
  /** Threads that mention the viewer. */
  mentions: boolean;
  /** Newest activity first, unread threads first (then newest), or grouped by page in the file's order. */
  sort: 'date' | 'unread' | 'page';
  /** Words the thread's comments or their authors' names must hold (the list's search; any case). */
  query?: string;
};
export const DEFAULT_FILTER: CommentFilter = {status: 'open', mine: false, mentions: false, sort: 'date'};

export const involves = (thread: DesignCommentThread, userId: string) =>
  thread.author.id === userId || thread.comments.some(comment => comment.author.id === userId);
export const mentions = (thread: DesignCommentThread, userId: string) =>
  thread.comments.some(comment => comment.mentions.some(mention => mention.userId === userId));
/** When something last happened in the thread (its last comment). */
export const lastActivity = (thread: DesignCommentThread) => thread.comments.at(-1)?.createdAt ?? thread.createdAt;

export function matchesFilter(thread: DesignCommentThread, filter: CommentFilter, userId: string | null): boolean {
  if ((thread.resolvedAt !== null) !== (filter.status === 'resolved')) return false;
  if (filter.mine && (!userId || !involves(thread, userId))) return false;
  if (filter.mentions && (!userId || !mentions(thread, userId))) return false;
  if (filter.query?.trim() && !matchesQuery(thread, filter.query)) return false;
  return true;
}

const foldText = (text: string) => text.toLocaleLowerCase('en').replaceAll('\u0451', '\u0435');

/** Whether every word of `query` is in one of the thread's comments or its people's names. */
export function matchesQuery(thread: DesignCommentThread, query: string): boolean {
  const haystack = foldText([thread.author.name, ...thread.comments.flatMap(comment => [comment.author.name, comment.text])].join('\n'));
  return foldText(query).split(/\s+/).filter(Boolean).every(word => haystack.includes(word));
}

/** The panel's list: the filter's threads, newest activity first, unread first, or by page (in `pageOrder`) and then newest first. */
export function listThreads(threads: Threads, filter: CommentFilter, userId: string | null, pageOrder: readonly string[]): DesignCommentThread[] {
  const list = [...threads.values()].filter(thread => matchesFilter(thread, filter, userId));
  const byDate = (a: DesignCommentThread, b: DesignCommentThread) => lastActivity(b).localeCompare(lastActivity(a)) || b.seq - a.seq;
  if (filter.sort === 'date') return list.sort(byDate);
  if (filter.sort === 'unread') return list.sort((a, b) => Number(b.unread > 0) - Number(a.unread > 0) || byDate(a, b));
  const rank = new Map(pageOrder.map((id, index) => [id, index]));
  const pageRank = (thread: DesignCommentThread) => rank.get(thread.anchor.pageId) ?? Number.MAX_SAFE_INTEGER;
  return list.sort((a, b) => pageRank(a) - pageRank(b) || byDate(a, b));
}

/** Unread comments in open threads (the tab's badge). */
export function unreadCount(threads: Threads): number {
  let total = 0;
  for (const thread of threads.values()) if (thread.resolvedAt === null) total += thread.unread;
  return total;
}

// ── Pins ─────────────────────────────────────────────────────────────────────────────────────────

export type PinPoint = {id: string; x: number; y: number};
export type PinCluster = {ids: string[]; x: number; y: number};

/**
 * Pins closer than `radius` screen pixels share a bubble, and so do pins that reach each other through others (zoomed out, a crowded
 * corner shows one bubble with a count, at the pins' centre). Buckets of `radius` px keep it linear in the number of pins; only distances
 * count, so a pan keeps the clusters and only moves them. Members keep the input order (pass pins oldest first for a stable result).
 */
export function clusterPins(points: readonly PinPoint[], radius: number): PinCluster[] {
  const parent = points.map((_, index) => index);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number) => cx + ':' + cy;
  points.forEach((point, index) => {
    const cx = Math.floor(point.x / radius),
      cy = Math.floor(point.y / radius);
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (const other of grid.get(key(cx + dx, cy + dy)) ?? []) {
          if (Math.hypot(points[other].x - point.x, points[other].y - point.y) >= radius) continue;
          const a = find(index),
            b = find(other);
          if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
        }
    const cell = key(cx, cy);
    const list = grid.get(cell);
    if (list) list.push(index);
    else grid.set(cell, [index]);
  });
  const byRoot = new Map<number, {ids: string[]; x: number; y: number}>();
  const clusters: PinCluster[] = [];
  points.forEach((point, index) => {
    const root = find(index);
    let cluster = byRoot.get(root);
    if (!cluster) {
      cluster = {ids: [], x: 0, y: 0};
      byRoot.set(root, cluster);
      clusters.push(cluster);
    }
    cluster.ids.push(point.id);
    cluster.x += point.x;
    cluster.y += point.y;
  });
  for (const cluster of clusters) {
    cluster.x /= cluster.ids.length;
    cluster.y /= cluster.ids.length;
  }
  return clusters;
}

/** The zoom at which a cluster's pins come apart (their closest pair `radius` px apart on screen), at least twice the current zoom and
 *  at most 400 %. */
export function separatingZoom(points: readonly {x: number; y: number}[], radius: number, current: number): number {
  let closest = Infinity;
  for (let i = 0; i < points.length; i++)
    for (let j = i + 1; j < points.length && j < i + 50; j++) closest = Math.min(closest, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
  const needed = closest > 0 && Number.isFinite(closest) ? (radius * 1.25) / closest : current * 2;
  return Math.min(4, Math.max(current * 2, needed));
}

/** Same clusters (members in order), whatever their positions: then a frame only moves the bubbles, it renders nothing. */
export const sameClusters = (a: readonly PinCluster[], b: readonly PinCluster[]) =>
  a.length === b.length && a.every((cluster, i) => cluster.ids.length === b[i].ids.length && cluster.ids.every((id, j) => id === b[i].ids[j]));

// ── People ───────────────────────────────────────────────────────────────────────────────────────

// Deep enough that white initials keep 4.5:1 (WCAG AA) on every one.
const AVATAR_COLORS = ['#0B6FCC', '#7B2FD8', '#0B7F45', '#C2410C', '#BE185D', '#0E7490', '#5B3CC4', '#A61E4D', '#2B7A31', '#B45309'];

/** One or two letters for an avatar: "Anna Smith" → "AS", "anna" → "A". */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(word => /\p{L}|\p{N}/u.test(word));
  if (!words.length) return '?';
  const first = (word: string) => [...word].find(char => /\p{L}|\p{N}/u.test(char)) ?? '';
  return (first(words[0]) + (words.length > 1 ? first(words[words.length - 1]) : '')).toLocaleUpperCase('en');
}

/** A steady colour per account (an erased one is grey). */
export function avatarColor(id: string | null): string {
  if (!id) return '#6E6E6E';
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return AVATAR_COLORS[Math.abs(hash) % AVATAR_COLORS.length];
}

// ── Mentions while typing ────────────────────────────────────────────────────────────────────────

/** The "@query" being typed before the caret, or null: "@" at the start or after a space, then letters without a line break. */
export function mentionQueryAt(text: string, caret: number, mentions: readonly DesignCommentMention[] = []): {start: number; query: string} | null {
  const before = text.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at < 0 || (at > 0 && !/\s/.test(before[at - 1]))) return null;
  // An "@" that already starts a mention is done: the list does not open on it again (Enter then sends).
  if (mentions.some(mention => mention.at === at)) return null;
  const query = before.slice(at + 1);
  if (query.length > 40 || /[\n@]/.test(query) || /^\s/.test(query)) return null;
  return {start: at, query};
}

/** Members whose name starts a word with the query (case-insensitive), best first. */
export function matchMembers<T extends {name: string}>(members: readonly T[], query: string, limit = 8): T[] {
  const fold = (value: string) => value.toLocaleLowerCase('en').replace(/\u0451/g, '\u0435');
  const needle = fold(query.trim());
  if (!needle) return members.slice(0, limit);
  const scored = members
    .map(member => {
      const name = fold(member.name);
      const score = name.startsWith(needle) ? 0 : name.split(/\s+/).some(word => word.startsWith(needle)) ? 1 : name.includes(needle) ? 2 : 3;
      return {member, score};
    })
    .filter(entry => entry.score < 3)
    .sort((a, b) => a.score - b.score || a.member.name.localeCompare(b.member.name, 'en'));
  return scored.slice(0, limit).map(entry => entry.member);
}

/** Puts "@Name " for `member` in place of the "@query" between `start` and `caret`; the mentions after it move. */
export function insertMention(
  text: string,
  mentionList: readonly DesignCommentMention[],
  start: number,
  caret: number,
  member: {userId: string; name: string},
): {text: string; mentions: DesignCommentMention[]; caret: number} {
  const label = '@' + member.name.replace(/\s+/g, ' ').trim().slice(0, 100);
  const inserted = label + ' ';
  const next = text.slice(0, start) + inserted + text.slice(caret);
  const shifted = shiftMentions(mentionList, start, caret, inserted.length);
  const mention = {userId: member.userId, at: start, length: label.length};
  const list = [...shifted, mention].sort((a, b) => a.at - b.at);
  return {text: next, mentions: list, caret: start + inserted.length};
}

/** The text and mentions as sent: line breaks normalized and the outer spaces trimmed, mentions moved by what was trimmed in front (a
 *  mention the trim would cut is dropped). */
export function tidyDraft(text: string, mentionList: readonly DesignCommentMention[]): {text: string; mentions: DesignCommentMention[]} {
  // Each \r\n becomes \n: everything after it moves one place left.
  let normalized = '';
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    map.push(normalized.length);
    if (text[i] === '\r') {
      if (text[i + 1] === '\n') continue;
      normalized += '\n';
    } else normalized += text[i];
  }
  map.push(normalized.length);
  const lead = normalized.length - normalized.trimStart().length;
  const result = normalized.trim();
  const out: DesignCommentMention[] = [];
  for (const mention of mentionList) {
    const at = map[mention.at] - lead,
      end = map[mention.at + mention.length] - lead;
    if (at < 0 || end > result.length || result[at] !== '@') continue;
    out.push({userId: mention.userId, at, length: end - at});
  }
  return {text: result, mentions: out};
}

// ── Time ─────────────────────────────────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "just now", "5 min ago", "2 h ago", "yesterday", "Oct 3", "Oct 3, 2025": short, as a comment's time. */
export function relativeTime(iso: string, now = Date.now()): string {
  const at = new Date(iso);
  const seconds = Math.max(0, (now - at.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (at >= yesterday) return 'yesterday';
  const date = `${MONTHS[at.getMonth()]} ${at.getDate()}`;
  return at.getFullYear() === today.getFullYear() ? date : `${date}, ${at.getFullYear()}`;
}

/** "2 replies", "5 replies". */
export const repliesLabel = (n: number) => `${n} ${n === 1 ? 'reply' : 'replies'}`;
/** "3 unread". */
export const unreadLabel = (n: number) => `${n} unread`;
