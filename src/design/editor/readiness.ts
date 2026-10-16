// The open file is ready for scripted use (e2e): `data-design-ready="<file id>"` on <html> once the
// editor takes keys, co-editing is live and the meeting has its state on screen. "Saved" shows with the editor's first
// frame, before the other two: co-editing (/collab or /events) and the meeting (/meeting, both lazy chunks) mount after it,
// and under load they land inside whatever a script does next. Nothing in the product reads the attribute.

type Part = 'editor' | 'live' | 'meeting';
const PARTS: readonly Part[] = ['editor', 'live', 'meeting'];

const ready = new Map<string, Set<Part>>();

function show() {
  const root = typeof document === 'undefined' ? null : document.documentElement;
  if (!root) return;
  const file = [...ready].find(([, parts]) => PARTS.every(part => parts.has(part)))?.[0];
  if (file === undefined) delete root.dataset.designReady;
  else if (root.dataset.designReady !== file) root.dataset.designReady = file;
}

/** One part of the open file is (or is no longer) ready; returns the undo for an effect's cleanup. */
export function markReady(fileId: string, part: Part, on = true): () => void {
  const parts = ready.get(fileId) ?? new Set<Part>();
  if (on) parts.add(part);
  else parts.delete(part);
  if (parts.size) ready.set(fileId, parts);
  else ready.delete(fileId);
  show();
  return on ? () => markReady(fileId, part, false) : () => {};
}
