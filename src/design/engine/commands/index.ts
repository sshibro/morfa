import {ALIGN_COMMANDS} from './align';
import {ARRANGE_COMMANDS} from './arrange';
import {AUTO_LAYOUT_COMMANDS} from './auto-layout';
import {BOOLEAN_COMMANDS} from './boolean';
import {CLIPBOARD_COMMANDS} from './clipboard';
import {COMPONENT_COMMANDS, guardStructure} from './components';
import {EDIT_COMMANDS} from './edit';
import {INSERT_COMMANDS} from './insert';
import {MASK_COMMANDS} from './mask';
import {OPACITY_COMMANDS} from './opacity';
import {PAINT_SWAP_COMMANDS} from './paint-swap';
import {registerCommand} from './registry';
import {RULER_COMMANDS} from '../rulers';
import {pasteImages} from '../tools/image';
import {registerPasteHandler} from './clipboard';
import {SELECT_COMMANDS} from './select';
import {VECTOR_COMMANDS} from './vector';
import {SHAPE_BUILDER_COMMAND} from './shape-builder';
import {KEYBOARD_SELECT_COMMAND} from '../tools/keyboard-select';
import {VIEW_COMMANDS} from './view';

// The engine's own commands. Other modules register theirs the same way (registerCommand) from
// their own files.

export * from './registry';
export {copySelection, cutSelection, pasteData, registerPasteHandler, type PasteData, type PasteHandler} from './clipboard';
export {duplicateSelection} from './edit';
export {nudge} from './arrange';

export const CORE_COMMANDS = [...EDIT_COMMANDS, ...CLIPBOARD_COMMANDS, ...SELECT_COMMANDS, ...ARRANGE_COMMANDS, ...VIEW_COMMANDS,
  ...ALIGN_COMMANDS, ...AUTO_LAYOUT_COMMANDS, ...INSERT_COMMANDS, ...RULER_COMMANDS, ...VECTOR_COMMANDS, SHAPE_BUILDER_COMMAND, KEYBOARD_SELECT_COMMAND, ...BOOLEAN_COMMANDS, ...MASK_COMMANDS, ...OPACITY_COMMANDS, ...PAINT_SWAP_COMMANDS];

let registered = false;

export function registerCoreCommands() {
  if (registered) return;
  registered = true;
  // Structural commands explain themselves on layers inside instances (components.ts guardStructure).
  for (const command of CORE_COMMANDS) registerCommand(guardStructure(command));
  for (const command of COMPONENT_COMMANDS) registerCommand(command);
  // Pictures and SVG pasted from outside (tools/image.ts).
  registerPasteHandler((data, ctx) => pasteImages(data, ctx));
}
