import {
  IconAnnotation, IconArrow, IconBrush, IconEllipse, IconFrame, IconHand, IconImage, IconLasso, IconLine, IconMeasure, IconMove, IconPen, IconPencil, IconPolygon,
  IconRectangle, IconScale, IconSection, IconSlice, IconStar, IconText, IconTextPath, IconComment, type IconComponent,
} from '../../ui/icons';

// The tools the bottom toolbar offers, their Russian names (docs/design-tool.md §vocabulary) and
// shortcuts. The toolbar only shows them; the engine's tool modules and command registry do the work
// and bind the keys (this list is where they can read the shortcut from).

export type ToolId =
  | 'move' | 'scale' | 'hand' | 'lasso'
  | 'frame' | 'section' | 'slice'
  | 'rectangle' | 'line' | 'arrow' | 'ellipse' | 'polygon' | 'star' | 'image'
  | 'pen' | 'pencil' | 'brush'
  | 'text' | 'text-path'
  | 'comment' | 'annotation' | 'measure';

export type ToolSpec = {id: ToolId; label: string; shortcut?: string; /** Also bound, not printed. */ alternateShortcut?: string; icon: IconComponent};

export const TOOLS: Record<ToolId, ToolSpec> = {
  move: {id: 'move', label: 'Move', shortcut: 'KeyV', icon: IconMove},
  scale: {id: 'scale', label: 'Scale', shortcut: 'KeyK', icon: IconScale},
  hand: {id: 'hand', label: 'Hand', shortcut: 'KeyH', icon: IconHand},
  frame: {id: 'frame', label: 'Frame', shortcut: 'KeyF', alternateShortcut: 'KeyA', icon: IconFrame},
  section: {id: 'section', label: 'Section', shortcut: 'Shift+KeyS', icon: IconSection},
  slice: {id: 'slice', label: 'Slice', shortcut: 'KeyS', icon: IconSlice},
  rectangle: {id: 'rectangle', label: 'Rectangle', shortcut: 'KeyR', icon: IconRectangle},
  line: {id: 'line', label: 'Line', shortcut: 'KeyL', icon: IconLine},
  arrow: {id: 'arrow', label: 'Arrow', shortcut: 'Shift+KeyL', icon: IconArrow},
  ellipse: {id: 'ellipse', label: 'Ellipse', shortcut: 'KeyO', icon: IconEllipse},
  polygon: {id: 'polygon', label: 'Polygon', icon: IconPolygon},
  star: {id: 'star', label: 'Star', icon: IconStar},
  image: {id: 'image', label: 'Image', shortcut: 'Shift+Mod+KeyK', icon: IconImage},
  pen: {id: 'pen', label: 'Pen', shortcut: 'KeyP', icon: IconPen},
  pencil: {id: 'pencil', label: 'Pencil', shortcut: 'Shift+KeyP', icon: IconPencil},
  text: {id: 'text', label: 'Text', shortcut: 'KeyT', icon: IconText},
  // A click on a shape or a path starts a text that follows it (engine/tools/text-path.ts; Figma binds no key).
  'text-path': {id: 'text-path', label: 'Text on path', icon: IconTextPath},
  // Comments (src/design/comments): pins and threads; open to every role that can look at the file.
  comment: {id: 'comment', label: 'Comment', shortcut: 'KeyC', icon: IconComment},
  // Notes and pinned distances for developers (src/design/annotations), shown in "Code" and on the canvas.
  annotation: {id: 'annotation', label: 'Annotation', shortcut: 'KeyY', icon: IconAnnotation},
  measure: {id: 'measure', label: 'Measure', shortcut: 'Shift+KeyM', icon: IconMeasure},
  // Figma Draw's tools ("Draw"): a freehand selection (with Move and Hand) and a smoothed stroke with a width
  // profile. They are on the "Draw" bar only; their keys switch to it (modeForTool).
  lasso: {id: 'lasso', label: 'Lasso', shortcut: 'KeyQ', icon: IconLasso},
  brush: {id: 'brush', label: 'Brush', shortcut: 'KeyB', icon: IconBrush},
};

export type ToolGroup = {id: string; label: string; tools: ToolId[]};

// The bar's groups, as Figma's UI3 bottom toolbar has them: one button per group showing the group's
// last used tool, the rest in its flyout. A tool shows only once its module is registered (`hasTool`),
// so a tool id added here before its module ships never appears as a fake entry; a group with no
// registered tool is left out. Tools that land later join their group by id: "Text on path" the
// text group, "Annotation" (Y) and "Measure" (⇧M) the comment group (which Dev Mode shares), Draw's
// lasso the selection group and its brush a group of its own.

/** "Design" (and "Prototype"): every tool of the file. */
export const TOOL_GROUPS: ToolGroup[] = [
  {id: 'move', label: 'Move tools', tools: ['move', 'hand', 'scale']},
  {id: 'frame', label: 'Frame tools', tools: ['frame', 'section', 'slice']},
  {id: 'shape', label: 'Shape tools', tools: ['rectangle', 'line', 'arrow', 'ellipse', 'polygon', 'star', 'image']},
  {id: 'pen', label: 'Pen and pencil', tools: ['pen', 'pencil']},
  {id: 'text', label: 'Text', tools: ['text', 'text-path']},
  {id: 'comment', label: 'Comments', tools: ['comment', 'annotation', 'measure']},
];

/** "Draw" (Figma Draw): selecting (with the lasso), shapes, the pen, the pencil, the brush and text, each drawing tool on a
 *  button of its own. */
export const DRAW_TOOL_GROUPS: ToolGroup[] = [
  {id: 'draw-select', label: 'Selection', tools: ['move', 'hand', 'lasso']},
  {id: 'draw-shape', label: 'Shape tools', tools: ['rectangle', 'line', 'arrow', 'ellipse', 'polygon', 'star']},
  {id: 'draw-pen', label: 'Pen', tools: ['pen']},
  {id: 'draw-pencil', label: 'Pencil', tools: ['pencil']},
  {id: 'draw-brush', label: 'Brush', tools: ['brush']},
  {id: 'draw-text', label: 'Text', tools: ['text', 'text-path']},
];

/** "Code" (Figma's Dev Mode): the file is looked at, measured and commented on. Its comment group is the design bar's, so a
 *  tool that joins that group (annotations, measurements) is in Dev Mode too. */
export const DEV_TOOL_GROUPS: ToolGroup[] = [
  {id: 'move', label: 'Move tools', tools: ['move', 'hand']},
  TOOL_GROUPS.find(group => group.id === 'comment')!,
];

/** A read-only file (a team's viewer or developer): selecting, the hand and comments. */
export const READ_ONLY_TOOL_GROUPS: ToolGroup[] = [
  {id: 'move', label: 'Move tools', tools: ['move', 'hand']},
  {id: 'comment', label: 'Comments', tools: ['comment']},
];

// ── Modes ────────────────────────────────────────────────────────────────────────────────────────

/** The modes at the bar's right end: "Draw", "Design", "Prototype" and "Code" (Dev Mode). The last
 *  three are the right panel's tabs; "Draw" switches the bar to the drawing tools. */
export type EditorMode = 'draw' | 'design' | 'prototype' | 'code';

export type ModeSpec = {id: EditorMode; label: string; shortcut?: string; description: string; /** The tooltip, when the label alone says too little. */ tooltip?: string};

export const MODES: readonly ModeSpec[] = [
  {id: 'draw', label: 'Draw', description: 'Pencil, pen and shapes'},
  {id: 'design', label: 'Design', description: 'All tools and layer properties'},
  {id: 'prototype', label: 'Prototype', description: 'Connections between screens and the player'},
  // Figma toggles Dev Mode with ⇧D.
  {id: 'code', label: 'Code', tooltip: 'Code — Dev Mode', shortcut: 'Shift+KeyD', description: 'Sizes, styles and code for development'},
];

/** The modes a person has: a read-only file is not drawn on, and "Code" is a developer's and an editor's (a team's viewer
 *  sees no code: shared/design/teams.ts canInspectCode). */
export function modesFor(readOnly: boolean, canInspectCode: boolean): readonly EditorMode[] {
  return MODES.map(mode => mode.id).filter(mode => !(mode === 'draw' && readOnly) && !(mode === 'code' && !canInspectCode));
}

/** The groups the bar shows in a mode. */
export function toolGroupsFor(mode: EditorMode, readOnly = false): readonly ToolGroup[] {
  if (readOnly) return READ_ONLY_TOOL_GROUPS;
  return mode === 'draw' ? DRAW_TOOL_GROUPS : mode === 'code' ? DEV_TOOL_GROUPS : TOOL_GROUPS;
}

/** Whether the bar of a mode has a button for the tool. */
export const modeHasTool = (mode: EditorMode, tool: ToolId, readOnly = false) => toolGroupsFor(mode, readOnly).some(group => group.tools.includes(tool));

/** The mode to show once a key (or a text being edited) picked a tool: the current one when its bar has the tool, else "Design"
 *  (R in "Code", F in "Draw"), else "Draw" (Draw's own tools), so the bar always shows the tool in hand. */
export function modeForTool(mode: EditorMode, tool: ToolId, readOnly: boolean, modes: readonly EditorMode[]): EditorMode {
  if (modeHasTool(mode, tool, readOnly)) return mode;
  for (const next of ['design', 'draw'] as const) if (modes.includes(next) && modeHasTool(next, tool, readOnly)) return next;
  return mode;
}

/** The tool a key press selects (KeyboardEvent.code based, so it works on the Russian layout), or null. */
export function toolForKey(event: Pick<KeyboardEvent, 'code' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey'>, mac: boolean): ToolId | null {
  const mod = mac ? event.metaKey : event.ctrlKey;
  const extra = mac ? event.ctrlKey : event.metaKey;
  if (event.altKey || extra) return null;
  // Shortcuts above are written modifiers first, Shift before Mod.
  const pressed = `${event.shiftKey ? 'Shift+' : ''}${mod ? 'Mod+' : ''}${event.code}`;
  for (const tool of Object.values(TOOLS)) {
    if (tool.shortcut === pressed || tool.alternateShortcut === pressed) return tool.id;
  }
  return null;
}
