import {registerCommand, type Command} from '../../../engine/commands/registry';
import {applyTextOp} from '../../../engine/commands/text';
import {textEditingSnapshot} from '../../../engine/text-editor/registry';
import {colorReceiver, pickColor, registerEyedropperTool} from '../../../engine/eyedropper';
import {CROP_TOOL, GRADIENT_TOOL, createGradientEditTool} from '../../../engine/tools/gradient-edit';
import {createImageCropTool} from '../../../engine/tools/image-crop';
import {registerTool} from '../../../engine/tools/registry';
import {writePaints} from './editing';
import {fillsWithColor, takesFills} from './paints';
import {textPaintsOf} from './text-paints';

export {fillsWithColor};

// The paint feature's registrations: the canvas tools that edit gradients and crops, the pipette
// tool, and "Eyedropper" (I), which gives the picked colour to the open picker or to the selection's fill.

export {PageBackgroundSection} from './PageBackgroundSection';
export {paintEditSession} from '../../../engine/tools/gradient-edit';

export const PICK_COLOR_COMMAND: Command = {
  id: 'edit.pick-color',
  label: 'Eyedropper',
  group: 'edit',
  shortcut: {code: 'KeyI'},
  enabled: ctx => !!colorReceiver() || ctx.store.getState().selection.length > 0,
  async run(ctx) {
    const receiver = colorReceiver();
    const color = await pickColor(ctx.store);
    if (!color) return;
    if (receiver) return receiver(color);
    const {selection, doc} = ctx.store.getState();
    const ids = selection.filter(id => doc.nodes[id] && takesFills(doc.nodes[id].type));
    if (!ids.length) return;
    // Texts take colour through the text commands: the edited range, the caret, or whole texts.
    const texts = ids.filter(id => doc.nodes[id].type === 'TEXT');
    if (texts.length === ids.length) {
      const shown = textPaintsOf(doc.nodes[texts[0]], textEditingSnapshot(ctx.store));
      applyTextOp(ctx.store, {kind: 'fills', fills: fillsWithColor(shown === 'mixed' ? [] : shown, color)}, 'Eyedropper', {ids: texts});
      return;
    }
    ctx.store.transact('Eyedropper', tx => writePaints(tx, ids, 'fills', fills => fillsWithColor(fills, color)));
  },
};

let registered = false;

/** Registers the tools and the command once (the sections module calls it when it loads). */
export function registerPaintFeature() {
  if (registered) return;
  registered = true;
  registerTool(GRADIENT_TOOL, createGradientEditTool);
  registerTool(CROP_TOOL, createImageCropTool);
  registerEyedropperTool();
  registerCommand(PICK_COLOR_COMMAND);
}
