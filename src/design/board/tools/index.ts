import {registerScopedTool, registerTool} from '../../engine/tools';
import type {DesignStore} from '../../engine/store';
import {createConnectorTool, createLineTool} from './connector';
import {createMarkerTool} from './marker';
import {createBoardMoveTool} from './move';
import {createStampTool, createStickyTool, createTableTool} from './place';
import {createShapeTool} from './shape';

// The board's tools (docs/board.md §Tools), registered when the board's chunk loads. Their ids start with `board-` so they never
// meet the design tools; the board's "Move" replaces the shared one for the board's store only (registerScopedTool).

let registered = false;

export function registerBoardTools(store: DesignStore): void {
  if (!registered) {
    registered = true;
    registerTool('board-sticky', createStickyTool);
    registerTool('board-shape', createShapeTool);
    registerTool('board-connector', createConnectorTool);
    registerTool('board-line', createLineTool);
    registerTool('board-marker', createMarkerTool);
    registerTool('board-stamp', createStampTool);
    registerTool('board-table', createTableTool);
  }
  registerScopedTool(store, 'move', createBoardMoveTool);
}

/** The board's tools as the toolbar and the keys know them. */
export type BoardToolId =
  | 'move' | 'hand' | 'board-marker' | 'board-sticky' | 'board-shape' | 'board-connector' | 'board-line' | 'text' | 'section' | 'board-table'
  | 'board-stamp' | 'comment';

export const BOARD_TOOL_LABELS: Record<BoardToolId, string> = {
  move: 'Move',
  hand: 'Hand',
  'board-marker': 'Marker',
  'board-sticky': 'Sticky',
  'board-shape': 'Shapes',
  'board-connector': 'Connector',
  'board-line': 'Line',
  text: 'Text',
  section: 'Section',
  'board-table': 'Table',
  'board-stamp': 'Stamp',
  comment: 'Comment',
};

/** The tools a read-only board keeps (store.ts READ_ONLY_TOOLS). */
export const BOARD_READ_ONLY_TOOLS: readonly BoardToolId[] = ['move', 'hand', 'comment'];
