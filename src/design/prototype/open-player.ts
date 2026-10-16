import type {NodeId} from '../../../shared/design/types';
import {playTarget} from '../../../shared/design/prototype';
import type {EditorState} from '../engine/store';
import {presentHash} from './route';

// ▶ and "Run": the player opens in a new tab, as Figma's does, at `#design/<id>?present=<frame>`
// (route.ts), and reads the document the editor tab streams to it (feed.ts) or, without one, the
// saved file.

export {editorHash, presentedFrame, presentHash, PRESENT_PARAM} from './route';

/** Opens the player for `frameId` in a new tab (call it from the click, or the browser blocks it). */
export function openPlayer(fileId: string, frameId: NodeId): void {
  window.open(location.pathname + presentHash(fileId, frameId), '_blank', 'noopener');
}

/** ▶ in the editor: the selection's top-level frame, else the page's first flow, else its first frame.
 *  Returns false when the page has no frame to present (the caller says so). */
export function playFromEditor(fileId: string, state: Pick<EditorState, 'doc' | 'pageId' | 'selection'>): boolean {
  const frame = playTarget(state.doc, state.pageId, state.selection);
  if (!frame) return false;
  openPlayer(fileId, frame);
  return true;
}
