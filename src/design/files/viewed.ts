// When each file was last opened in this browser, for the "Last viewed" sort (Figma's "Last viewed"). A per-browser convenience
// in localStorage: blocked storage means no such order, never an error. The newest `VIEWED_LIMIT` files are kept.

const KEY = 'morfa-design-viewed';
export const VIEWED_LIMIT = 200;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const storage = (): Store | null => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

export function viewedTimes(store: Store | null = storage()): Map<string, number> {
  try {
    const entries = JSON.parse(store?.getItem(KEY) ?? '[]') as unknown;
    return new Map(Array.isArray(entries) ? entries.filter((entry): entry is [string, number] => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') : []);
  } catch {
    return new Map();
  }
}

export function recordViewed(id: string, at = Date.now(), store: Store | null = storage()): void {
  const times = viewedTimes(store);
  times.delete(id);
  const entries = [[id, at] as [string, number], ...[...times].sort((a, b) => b[1] - a[1])].slice(0, VIEWED_LIMIT);
  try { store?.setItem(KEY, JSON.stringify(entries)); } catch { /* storage blocked */ }
}
