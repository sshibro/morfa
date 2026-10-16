import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {LIBRARY_PAGE_ID} from '../../../shared/design/types';
import type {EditorServices} from '../editor/services';

// "Go to main component" for a shared library's component (docs/design-tool.md §Teams, "Shared libraries"). Plain code
// with no React and no stylesheet, so the engine's component commands can use it wherever they run.

let editor: EditorServices | null = null;
/** Module-level: the bundler's preload keeps the function that first asked for a chunk (and what it closes over). */
const loadSession = () => import('./session');

/** The open file's editor, set by useLibraryHost (host.tsx) while a file is open. */
export function setLibraryEditor(next: EditorServices | null, previous?: EditorServices): void {
  if (next || !previous || editor === previous) editor = next;
}

/** The copied library root a node of the hidden library page belongs to. */
function remoteRoot(doc: DesignDocument, id: NodeId): SceneNode | null {
  let node = doc.nodes[id];
  for (let guard = 0; node && guard < 10_000; guard++) {
    if (node.parentId === LIBRARY_PAGE_ID) return node.remote ? node : null;
    if (node.parentId === null) return null;
    node = doc.nodes[node.parentId];
  }
  return null;
}

/**
 * "Go to main component" for an instance of a library's component: the copy here is read-only and hidden, so the
 * library's file opens in a new tab with the component selected, when this account can open it. False for a local main.
 */
export function goToRemoteMain(doc: DesignDocument, mainId: NodeId, toast: (message: string) => void): boolean {
  const root = remoteRoot(doc, mainId);
  if (!root?.remote) return false;
  const {libraryId} = root.remote;
  const key = mainId.replace(/^r[0-9a-f]{16}:/, '');
  const current = editor;
  void loadSession().then(({librarySession}) => {
    const library = current ? librarySession(current)?.library(libraryId) : undefined;
    if (!library) {
      toast('This component comes from a library that cannot be opened: its file was deleted or moved.');
      return;
    }
    // The layer link of "Copy link to layer" (engine/commands/link.ts): the file opens with the component selected.
    window.open(`${location.origin}${location.pathname}#design/${encodeURIComponent(library.fileId)}?node=${encodeURIComponent(key)}`, '_blank', 'noopener');
  });
  return true;
}
