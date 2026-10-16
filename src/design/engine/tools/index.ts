import {registerTool} from './registry';
import {createHandTool} from './hand';
import {createMoveTool} from './move';
import {createArrowTool, createEllipseTool, createLineTool, createPolygonTool, createRectangleTool, createStarTool} from './shapes';
import {createFrameTool} from './frame';
import {createSectionTool} from './section';
import {createSliceTool} from './slice';
import {createImageTool} from './image';
import {createScaleTool} from './scale';
import {createPenTool} from './pen';
import {createPencilTool} from './pencil';
import {createVectorBendTool, createVectorEditTool} from '../vector-edit/tool';
import {createTextPathTool} from './text-path';
import {createLassoTool} from './lasso';
import {createKeyboardSelectTool, KEYBOARD_SELECT_TOOL} from './keyboard-select';
import {createShapeBuilderTool} from './shape-builder';
import {createBrushTool} from './brush';

// The engine's own tools. Drawing, text and pen tools register themselves the same way from their
// modules (registerTool('rectangle', () => new RectangleTool())).

export {createTool, hasTool, onToolsChange, registerScopedTool, registerTool, toolIds, toolsVersion, type ToolFactory} from './registry';
export type {EditKind, OverlayHints, SnapContext, SnapHook, SnapResult, Tool, ToolContext, ToolKeyEvent, ToolPointerEvent, ViewHelpers} from './types';
export {NO_SNAP} from './types';

let registered = false;

export function registerCoreTools() {
  if (registered) return;
  registered = true;
  registerTool('move', createMoveTool);
  registerTool('hand', createHandTool);
  registerTool('scale', createScaleTool);
  registerTool('frame', createFrameTool);
  registerTool('section', createSectionTool);
  registerTool('slice', createSliceTool);
  registerTool('rectangle', createRectangleTool);
  registerTool('ellipse', createEllipseTool);
  registerTool('line', createLineTool);
  registerTool('arrow', createArrowTool);
  registerTool('polygon', createPolygonTool);
  registerTool('star', createStarTool);
  registerTool('image', createImageTool);
  registerTool('pen', createPenTool);
  registerTool('pencil', createPencilTool);
  // Figma's Text on path, and Figma Draw's lasso and brush (chrome/tools.ts DRAW_TOOL_GROUPS).
  registerTool('text-path', createTextPathTool);
  registerTool('lasso', createLassoTool);
  // Figma's Keyboard box selection (⌥Space / Ctrl+Space; the command is in commands/index.ts).
  registerTool(KEYBOARD_SELECT_TOOL, createKeyboardSelectTool);
  registerTool('brush', createBrushTool);
  // Figma's Shape builder: opened by "Shape builder" (Object menu, the boolean menu), not on the bar.
  registerTool('shape-builder', createShapeBuilderTool);
  // The vector editor's own tools (state.editing = {kind: 'vector'}): selection and bend.
  registerTool('vector-edit', createVectorEditTool);
  registerTool('vector-bend', createVectorBendTool);
}
