import type {NodeId} from '../../../shared/design/types';
import {caretStyleAt, insertText} from '../../../shared/design/text-edit';
import type {DesignStore} from './store';
import {subscribeTextEditing, textEditingSnapshot} from './text-editor/registry';
import {userUpdate} from './user-edit';

// Several texts edited as one (Figma's Multi-edit text, help.figma.com "Edit objects on the canvas in bulk"): Enter with only
// texts selected opens the first in the editor; when that editing ends, every other selected text takes its content (each
// keeps its own look: its first character's style), in one undo step of its own. Nothing changes if the content did not.

export const MULTI_EDIT_LABEL = 'Edit text in all';

const running = new WeakMap<DesignStore, () => void>();

/** Opens `ids[0]` with `open` and copies its content to the rest when its editing ends. False when there is nothing to share. */
export function startMultiEditText(store: DesignStore, ids: readonly NodeId[], open: (id: NodeId) => void): boolean {
  const doc = store.getState().doc;
  const texts = ids.filter(id => doc.nodes[id]?.type === 'TEXT' && !doc.nodes[id].locked);
  if (texts.length < 2 || texts.length !== ids.length) return false;
  running.get(store)?.();
  const [lead, ...followers] = texts;
  const before = doc.nodes[lead].text?.characters ?? '';
  let opened = false;
  const finish = () => {
    off();
    running.delete(store);
    const characters = store.getState().doc.nodes[lead]?.text?.characters;
    if (characters === undefined || characters === before) return;
    store.transact(MULTI_EDIT_LABEL, tx => {
      for (const id of followers) {
        const node = tx.get(id);
        if (!node?.text || node.text.characters === characters) continue;
        userUpdate(tx, id, {text: insertText(node.text, 0, node.text.characters.length, characters, caretStyleAt(node.text, 0))});
      }
    });
  };
  const off = subscribeTextEditing(store, () => {
    const editing = textEditingSnapshot(store);
    if (editing?.id === lead) opened = true;
    else if (opened) finish();
  });
  running.set(store, finish);
  open(lead);
  if (textEditingSnapshot(store)?.id === lead) opened = true;
  else if (!opened) {
    off();
    running.delete(store);
    return false;
  }
  return true;
}
