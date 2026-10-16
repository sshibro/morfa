import '../../styles/board.css';
import '../../styles/phone-board.css';
import '../../styles/phone-editor-comments.css';
import '../../styles/phone-editor-meeting.css';
import {installBoardSteps} from '../../../../shared/design/board/install';
import type {DesignStore} from '../../engine/store';
import {registerBoardTools} from '../tools';

// "Board" (docs/board.md): the board editor's chunk. DesignEditor loads it with `import()` once the opened file says it is a board,
// before the editor session exists, and calls `prepareBoard` on the new store before the canvas mounts (the board's own
// "Move" replaces the shared one for that store only). Nothing here is reachable from a design file's first load.

export {BoardLayout, type BoardLayoutProps} from './BoardLayout';
export {BOARD_MENU, isBoardAction} from '../commands';
export {BOARD_NAMES} from '../../../../shared/design/board/names';

// The board's normalization steps (sticky fit, connectors) are in place before any board's store is made.
installBoardSteps();

/** The board's tools for this store; call before the canvas mounts. */
export function prepareBoard(store: DesignStore): void {
  installBoardSteps();
  registerBoardTools(store);
}
