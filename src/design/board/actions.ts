import type {Command, CommandContext} from '../engine/commands';
import type {MainMenuEntry, MainMenuSection} from '../editor/chrome/commands';
import {BOARD_FLOWCHART_SHAPES, BOARD_SHAPES} from '../../../shared/design/board/shapes';
import {BOARD_KEYS} from './keys';
import {setBoardChoices, type BoardChoices} from './state';
import {BOARD_READ_ONLY_TOOLS, BOARD_TOOL_LABELS, type BoardToolId} from './tools';

// "Actions" (⌘K) on a board (docs/board.md §Chrome): FigJam's actions list what a board does — its tools with their keys, its own
// commands and the design editor's commands its main menu offers — and none of the design editor's (frames, components, text case,
// libraries). The tools are commands here only so the list can name and run them; their keys stay the board's (keys.ts reads them
// first, in the capture phase).

type ToolCommand = {id: string; label: string; tool: BoardToolId; choices?: Partial<BoardChoices>};

/** One row per tool and kind the toolbar offers; the key is the one keys.ts gives it. */
const TOOL_ROWS: readonly ToolCommand[] = [
  {id: 'board.tool-move', label: BOARD_TOOL_LABELS.move, tool: 'move'},
  {id: 'board.tool-hand', label: BOARD_TOOL_LABELS.hand, tool: 'hand'},
  {id: 'board.tool-marker', label: 'Marker', tool: 'board-marker', choices: {marker: 'marker'}},
  {id: 'board.tool-highlighter', label: 'Highlighter', tool: 'board-marker', choices: {marker: 'highlighter'}},
  {id: 'board.tool-washi', label: 'Washi tape', tool: 'board-marker', choices: {marker: 'washi'}},
  {id: 'board.tool-eraser', label: 'Eraser', tool: 'board-marker', choices: {marker: 'eraser'}},
  {id: 'board.tool-sticky', label: BOARD_TOOL_LABELS['board-sticky'], tool: 'board-sticky'},
  // Every figure by its name (FigJam: "Type the shape name like rectangle or diamond, then hit Return"); square and ellipse keep R and O.
  ...[...BOARD_SHAPES, ...BOARD_FLOWCHART_SHAPES].map(shape => ({id: shape.id === 'square' || shape.id === 'ellipse' ? `board.tool-${shape.id}` : `board.tool-shape-${shape.id}`, label: shape.id === 'square' ? 'Square' : shape.label, tool: 'board-shape' as const, choices: {shape: shape.id}})),
  {id: 'board.tool-connector', label: 'Elbow connector', tool: 'board-connector', choices: {line: 'elbow'}},
  {id: 'board.tool-straight', label: 'Straight connector', tool: 'board-connector', choices: {line: 'straight'}},
  {id: 'board.tool-curved', label: 'Curved connector', tool: 'board-connector', choices: {line: 'curved'}},
  {id: 'board.tool-line', label: BOARD_TOOL_LABELS['board-line'], tool: 'board-line'},
  {id: 'board.tool-text', label: BOARD_TOOL_LABELS.text, tool: 'text'},
  {id: 'board.tool-section', label: BOARD_TOOL_LABELS.section, tool: 'section'},
  {id: 'board.tool-table', label: BOARD_TOOL_LABELS['board-table'], tool: 'board-table'},
  {id: 'board.tool-stamp', label: BOARD_TOOL_LABELS['board-stamp'], tool: 'board-stamp'},
  {id: 'board.tool-comment', label: BOARD_TOOL_LABELS.comment, tool: 'comment'},
];

const sameChoices = (a: Partial<BoardChoices> | undefined, b: Partial<BoardChoices> | undefined) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** The key keys.ts gives a tool and kind (the first one listed), as a command shortcut. */
function keyOf(row: ToolCommand): Command['shortcut'] {
  const entry = BOARD_KEYS.find(key => key.action.kind === 'tool' && key.action.tool === row.tool && sameChoices(key.action.choices, row.choices));
  return entry ? {code: entry.code, ...(entry.shift ? {shift: true} : {})} : undefined;
}

export const BOARD_TOOL_COMMANDS: Command[] = TOOL_ROWS.map(row => ({
  id: row.id, label: row.label, group: 'board-tools', shortcut: keyOf(row),
  enabled: (ctx: CommandContext) => !ctx.store.readOnly || BOARD_READ_ONLY_TOOLS.includes(row.tool),
  run: (ctx: CommandContext) => {
    if (row.choices) setBoardChoices(row.choices);
    ctx.store.setTool(row.tool);
  },
}));

function menuIds(items: readonly MainMenuEntry[]): string[] {
  return items.flatMap(item => (typeof item === 'string' ? (item === '-' ? [] : [item]) : menuIds(item.items)));
}

/** What "Actions" lists on a board: the board's commands and tools, and the design editor's commands in its main menu. */
export function boardActionFilter(menu: readonly MainMenuSection[]): (id: string) => boolean {
  const listed = new Set(menu.flatMap(section => menuIds(section.items)));
  return id => id.startsWith('board.') || listed.has(id);
}
