import {frameTargetAt, targetLabel} from '../../../shared/design/meeting';
import {worldBox, type Rect} from '../../../shared/design/geometry';
import type {DesignDocument, NodeId, Vec} from '../../../shared/design/types';

// What people vote for and where a vote's badge stands (docs/board-meeting.md "Voting"). A design file votes for its top-level
// frames (shared/design/meeting.ts `frameTargetAt`); a board passes its own rule — stickies, shapes, the object under the point that
// docs/board.md names — through the same three questions, so the meeting module never needs to know what a sticky is.

export type MeetingTargets = {
  /** The object a click at `point` (page space) votes for, or null. */
  at(doc: DesignDocument, pageId: NodeId, point: Vec): NodeId | null;
  /** Its box on the page (the badge sits on its top-right corner), or null when it is gone. */
  box(doc: DesignDocument, id: NodeId): Rect | null;
  /** Its name in the results list. */
  label(doc: DesignDocument, id: NodeId): string;
  /** "frames", "stickies and shapes": what the voting bar says people vote for. */
  noun: string;
};

/** The page an object is on, or null. */
export function pageOfNode(doc: DesignDocument, id: NodeId): NodeId | null {
  let node = doc.nodes[id];
  for (let depth = 0; node && depth < 1000; depth++) {
    if (node.type === 'PAGE') return node.id;
    node = node.parentId ? doc.nodes[node.parentId] : undefined!;
  }
  return null;
}

export const DESIGN_TARGETS: MeetingTargets = {
  at: frameTargetAt,
  box(doc, id) {
    const node = doc.nodes[id];
    if (!node || node.type === 'PAGE') return null;
    const box = worldBox(doc, id);
    return Number.isFinite(box.x) && Number.isFinite(box.y) ? box : null;
  },
  label: targetLabel,
  noun: 'frames',
};
