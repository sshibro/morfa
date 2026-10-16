import type {Hyperlink} from '../../../../shared/design/types';
import {hyperlinkAt} from '../../../../shared/design/text-edit';
import type {DesignStore} from '../store';
import {layerOfLink} from '../commands/link';
import {activeTextEdit} from './registry';
import {normalizeLink} from './style-ops';

// Figma's text links ("Add links to text"): ⌘K while editing a text asks the editor for the link field at the caret; the
// text session asks, `TextLinkLayer` (src/design/editor/TextLinkLayer.tsx) answers. A caret inside a link shows that
// link's card there.

const listeners = new WeakMap<DesignStore, Set<() => void>>();

/** Opens the link field for the words selected in the text being edited (or the link the caret is in). */
export function requestTextLink(store: DesignStore): void {
  for (const listener of [...(listeners.get(store) ?? [])]) listener();
}

export function onTextLinkRequest(store: DesignStore, listener: () => void): () => void {
  let set = listeners.get(store);
  if (!set) listeners.set(store, (set = new Set()));
  set.add(listener);
  return () => void set!.delete(listener);
}

/** What an address typed or pasted onto words links them to: a layer of this file for its "Copy link to layer"
 *  link (as Figma links text to a frame), else the web address; null when it is neither. */
export function textLinkFor(store: DesignStore, value: string): Hyperlink | null {
  const layer = layerOfLink(store, value);
  if (layer) return {type: 'NODE', nodeId: layer};
  const url = normalizeLink(value);
  return url ? {type: 'URL', url} : null;
}

/** The link the caret of the text being edited stands in (a collapsed selection only), with its extent. */
export function linkAtCaret(store: DesignStore): {hyperlink: Hyperlink; start: number; end: number} | null {
  const session = activeTextEdit(store);
  if (!session) return null;
  const {start, end} = session.range();
  const text = store.getState().doc.nodes[session.id]?.text;
  if (!text || start !== end) return null;
  return hyperlinkAt(text, start);
}

/** Whether ⌘K has something to link: selected words, or a caret inside a link. */
export function canLinkText(store: DesignStore): boolean {
  const session = activeTextEdit(store);
  if (!session) return false;
  const {start, end} = session.range();
  return start !== end || !!linkAtCaret(store);
}
