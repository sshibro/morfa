import type {Action, DesignDocument, NodeId, Reaction} from '../../../shared/design/types';
import type {PasteHandler} from '../engine/commands/clipboard';
import {notify} from '../engine/commands/components';
import {editableStructure} from '../engine/selection';
import {userUpdate} from '../engine/user-edit';

// Copying an interaction (Figma: ⌘C / ⌘X on a connection, ⌘V on another layer, help.figma.com "Connect your prototype"): ⌘C in
// the interaction details puts the interaction on the clipboard as text with a prefix of its own; ⌘V with layers selected adds
// it to each of them. An action whose destination is not in this file (copied from another one) is left out.

export const REACTIONS_PREFIX = 'morfa-interactions:';

export const reactionsText = (reactions: readonly Reaction[]) => REACTIONS_PREFIX + JSON.stringify(reactions);

/** The interactions in clipboard text, or null when it is something else. */
export function parseReactions(text: string | null): Reaction[] | null {
  if (!text?.startsWith(REACTIONS_PREFIX)) return null;
  try {
    const value = JSON.parse(text.slice(REACTIONS_PREFIX.length)) as unknown;
    return Array.isArray(value) && value.every(each => each && typeof each === 'object' && 'trigger' in each && Array.isArray((each as Reaction).actions)) ? value as Reaction[] : null;
  } catch {
    return null;
  }
}

const reaches = (doc: DesignDocument, action: Action) => action.type !== 'NODE' || !!doc.nodes[action.destinationId];

/** The interactions as they can stand on `id` in `doc`: actions to missing layers (or to the layer itself) dropped,
 *  interactions left without an action dropped. */
export function adaptReactions(doc: DesignDocument, id: NodeId, reactions: readonly Reaction[]): Reaction[] {
  return reactions
    .map(reaction => ({...reaction, actions: reaction.actions.filter(action => reaches(doc, action) && !(action.type === 'NODE' && action.destinationId === id))}))
    .filter(reaction => reaction.actions.length);
}

export const pasteReactions: PasteHandler = (data, ctx) => {
  const reactions = parseReactions(data.text);
  if (!reactions) return false;
  const {doc, selection} = ctx.store.getState();
  const ids = editableStructure(doc, selection);
  if (!ids.length) {
    notify(ctx.store, 'Select a layer to paste the interaction.', 'info');
    return true;
  }
  ctx.store.transact('Paste interaction', tx => {
    for (const id of ids) {
      const node = tx.get(id);
      const added = node && adaptReactions(tx.doc, id, reactions);
      if (node && added?.length) userUpdate(tx, id, {reactions: [...node.reactions, ...structuredClone(added)]});
    }
  });
  return true;
};
