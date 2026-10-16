import type {Paint, SceneNode} from '../../../../../shared/design/types';
import {caretStyleAt, styleAtRange} from '../../../../../shared/design/text-edit';
import type {TextEditingSnapshot} from '../../../engine/text-editor/registry';

// "Fill" of a text that is being edited shows the colour of the editor's selection (or of what the
// caret will type next), as Figma does; a text not being edited shows its whole colour ("Mixed" over words
// coloured on their own). Writes go through the text commands' `applyTextOp` (engine/commands/text.ts), which
// sends them to that range, to the caret's pending style or to the whole text.

/** The paints "Fill" shows for a text, given the text editor's state ('mixed' over differing ranges). */
export function textPaintsOf(node: SceneNode, editing: TextEditingSnapshot): Paint[] | 'mixed' {
  const text = node.text;
  if (!text) return node.fills;
  if (!editing || editing.id !== node.id) {
    // The whole text: "Mixed" when words are coloured on their own, as Figma shows such a text's fill.
    if (!text.runs.some(run => run.fills)) return node.fills;
    const fills = styleAtRange(text, 0, text.characters.length, node.fills).fills;
    return fills === 'mixed' ? 'mixed' : fills;
  }
  const length = text.characters.length;
  const start = Math.max(0, Math.min(length, Math.min(editing.start, editing.end)));
  const end = Math.max(0, Math.min(length, Math.max(editing.start, editing.end)));
  if (start === end) {
    if (editing.pending !== undefined) return editing.pending?.fills ?? node.fills;
    return length ? caretStyleAt(text, start)?.fills ?? node.fills : node.fills;
  }
  const fills = styleAtRange(text, start, end, node.fills).fills;
  return fills === 'mixed' ? 'mixed' : fills;
}

/** True when the editor's selection covers part of the text (or is a caret): styles and canvas
 *  editing then stay out of the way, as they apply to whole layers. */
export function editsPartOfText(node: SceneNode | undefined, editing: TextEditingSnapshot): boolean {
  if (!node?.text || !editing || editing.id !== node.id) return false;
  const length = node.text.characters.length;
  return length > 0 && !(Math.min(editing.start, editing.end) <= 0 && Math.max(editing.start, editing.end) >= length);
}
