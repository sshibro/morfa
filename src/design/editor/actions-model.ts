import {searchPalette, type PaletteEntry} from './command-bridge';

// "Actions" (⌘K, also ⌘/ and ⌘P; Figma's Actions menu), as pure functions: the sections the list shows (recent first while the
// search is empty). tests/design-actions-menu.test.ts reads it.

// ── Sections ─────────────────────────────────────────────────────────────────────────────────────

export type ActionSection = {id: string; title: string | null; entries: PaletteEntry[]};

const LIMIT = 60;
const RECENT_SHOWN = 5;

/**
 * What "All" lists. With an empty search: "Recent" (up to five), then every command by name. With a search: one list, best
 * first, what can run now before what cannot (Enter on the top row always does something).
 */
export function actionSections(entries: readonly PaletteEntry[], query: string, recent: readonly string[], runnable: (id: string) => boolean): ActionSection[] {
  if (query.trim()) {
    const found = searchPalette(entries, query, recent);
    return [{id: 'results', title: null, entries: [...found.filter(entry => runnable(entry.id)), ...found.filter(entry => !runnable(entry.id))].slice(0, LIMIT)}];
  }
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const sections: ActionSection[] = [];
  const recentEntries = recent.map(id => byId.get(id)).filter((entry): entry is PaletteEntry => !!entry).slice(0, RECENT_SHOWN);
  if (recentEntries.length) sections.push({id: 'recent', title: 'Recent', entries: recentEntries});
  const rest = [...entries].sort((a, b) => a.label.localeCompare(b.label, 'en'));
  if (rest.length) sections.push({id: 'all', title: 'All commands', entries: rest});
  return sections;
}
