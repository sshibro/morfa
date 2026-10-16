import type {BoardToolId} from './tools';
import type {BoardChoices} from './state';

// The board's single keys (docs/board.md §Keys), FigJam's: by physical key (`KeyboardEvent.code`), so they work on the Russian
// layout. The board reads them before the design editor's commands, so S is a sticky here and never "Slice"; design tools the
// board has no use for (frame, pen, slice, scale) are swallowed rather than switched to.

export type BoardKeyAction =
  | {kind: 'tool'; tool: BoardToolId; choices?: Partial<BoardChoices>}
  | {kind: 'stamp-wheel'}
  | {kind: 'actions'}
  | {kind: 'swallow'};

type Pressed = Pick<KeyboardEvent, 'code' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey'>;

export const BOARD_KEYS: {code: string; shift?: boolean; mod?: boolean; action: BoardKeyAction; label?: string}[] = [
  {code: 'KeyV', action: {kind: 'tool', tool: 'move'}},
  {code: 'KeyH', action: {kind: 'tool', tool: 'hand'}},
  {code: 'KeyM', action: {kind: 'tool', tool: 'board-marker', choices: {marker: 'marker'}}},
  {code: 'KeyM', shift: true, action: {kind: 'tool', tool: 'board-marker', choices: {marker: 'highlighter'}}},
  // help.figma.com "Doodle and highlight in FigJam with drawing tools": W washi tape (⇧W kept, the key the board had first).
  {code: 'KeyW', action: {kind: 'tool', tool: 'board-marker', choices: {marker: 'washi'}}},
  {code: 'KeyW', shift: true, action: {kind: 'tool', tool: 'board-marker', choices: {marker: 'washi'}}},
  {code: 'Backspace', shift: true, action: {kind: 'tool', tool: 'board-marker', choices: {marker: 'eraser'}}},
  {code: 'Delete', shift: true, action: {kind: 'tool', tool: 'board-marker', choices: {marker: 'eraser'}}},
  {code: 'KeyS', action: {kind: 'tool', tool: 'board-sticky'}},
  {code: 'KeyS', shift: true, action: {kind: 'tool', tool: 'section'}},
  {code: 'KeyR', action: {kind: 'tool', tool: 'board-shape', choices: {shape: 'square'}}},
  {code: 'KeyO', action: {kind: 'tool', tool: 'board-shape', choices: {shape: 'ellipse'}}},
  // help.figma.com "Create diagrams and flows with connectors": X or ⇧L a bent connector, L a straight one.
  {code: 'KeyX', action: {kind: 'tool', tool: 'board-connector', choices: {line: 'elbow'}}},
  {code: 'KeyL', action: {kind: 'tool', tool: 'board-connector', choices: {line: 'straight'}}},
  {code: 'KeyL', shift: true, action: {kind: 'tool', tool: 'board-connector', choices: {line: 'elbow'}}},
  {code: 'KeyT', action: {kind: 'tool', tool: 'text'}},
  // help.figma.com "Tables in FigJam": ⇧T.
  {code: 'KeyT', shift: true, action: {kind: 'tool', tool: 'board-table'}},
  {code: 'KeyC', action: {kind: 'tool', tool: 'comment'}},
  {code: 'KeyE', action: {kind: 'stamp-wheel'}},
  {code: 'KeyK', mod: true, action: {kind: 'actions'}},
  // Design tools a board does not offer.
  {code: 'KeyF', action: {kind: 'swallow'}},
  {code: 'KeyA', action: {kind: 'swallow'}},
  {code: 'KeyK', action: {kind: 'swallow'}},
  {code: 'KeyP', action: {kind: 'swallow'}},
  {code: 'KeyP', shift: true, action: {kind: 'swallow'}},
];

/** What a key press does on the board, or null for the design editor's commands to decide (⌘C, Delete, arrows…). */
export function boardKeyAction(event: Pressed, mac: boolean): BoardKeyAction | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const other = mac ? event.ctrlKey : event.metaKey;
  if (event.altKey || other) return null;
  for (const entry of BOARD_KEYS) {
    if (entry.code === event.code && !!entry.shift === event.shiftKey && !!entry.mod === mod) return entry.action;
  }
  return null;
}

/** The shortcut a tool shows in its tooltip (chrome's string form). */
export const BOARD_TOOL_SHORTCUTS: Partial<Record<BoardToolId, string>> = {
  move: 'KeyV',
  hand: 'KeyH',
  'board-marker': 'KeyM',
  'board-sticky': 'KeyS',
  'board-shape': 'KeyR',
  'board-connector': 'KeyX',
  text: 'KeyT',
  section: 'Shift+KeyS',
  'board-table': 'Shift+KeyT',
  'board-stamp': 'KeyE',
  comment: 'KeyC',
};
