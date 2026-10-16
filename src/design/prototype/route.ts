// The player's address: `#design/<fileId>?present=<frameId>`. The query rides inside the hash because
// navigation.ts reads a design file's id up to the first "?" (`designIdFromHash`) and never rewrites a
// hash it did not write, while the page's search is where App consumes one-shot entries; so the whole
// app routes the address to DesignRoot untouched, and DesignRoot shows the player instead of the
// editor. Dependency-free: DesignRoot reads it before any of the tool loads.

export const PRESENT_PARAM = 'present';

/** The frame a `#design/<id>?present=<frame>` hash asks to present, or null. */
export function presentedFrame(hash: string): string | null {
  if (!hash.startsWith('#design/')) return null;
  const query = hash.indexOf('?');
  if (query < 0) return null;
  const value = new URLSearchParams(hash.slice(query + 1)).get(PRESENT_PARAM);
  return value || null;
}

export const editorHash = (fileId: string) => '#design/' + encodeURIComponent(fileId);
export const presentHash = (fileId: string, frameId: string) => `${editorHash(fileId)}?${PRESENT_PARAM}=${encodeURIComponent(frameId)}`;
