import type {DesignDocument, NodeId} from '../types';
import {createDocument} from '../defaults';

// "Board": a board's document (docs/board.md §File kind): a design document marked `board: true`, so normalization runs the board's
// steps (sticky text fit, connectors following their objects). The server marks every document stored in a board file the same way.

export function createBoardDocument(pageId: NodeId, pageName = 'Page 1'): DesignDocument {
  return {...createDocument(pageId, pageName), board: true};
}

/** The document as a board's file stores it. */
export const asBoardDocument = (doc: DesignDocument): DesignDocument => (doc.board ? doc : {...doc, board: true});
