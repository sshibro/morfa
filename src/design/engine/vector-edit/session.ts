import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import type {Transaction} from '../../../../shared/design/transaction';
import type {DesignStore, EditorState} from '../store';
import {userUpdate} from '../user-edit';
import {removeNodes} from '../commands/structure';
import {hasLonePoints, networkOfNode, pruneLonePoints, remappedPaints, validKeys, vectorEditBlocker, vectorFields, type AnchorKey, type Network, type PenEnd} from './model';

// The vector editor's state around the store: which anchors are selected and where the pen is
// drawing. It lives beside the store (one session per store), not in it, because none of it is
// saved or undone: an undo changes the network and the session simply drops keys that no longer
// name an anchor. `installVectorEditing` keeps the store's `editing`, `tool` and `selection` in
// step with the editor, so entering and leaving work from every door: a double click, Enter, the
// pen, "Done", another tool, another layer selected in the panel.

/** Tools that work inside the vector editor. Any other tool leaves it. */
export const VECTOR_EDIT_TOOLS: ReadonlySet<string> = new Set(['vector-edit', 'vector-bend', 'pen']);

export type Notify = (message: string, kind?: 'success' | 'error') => void;

export type VectorSession = {
  /** Selected anchors (`p.s.a` keys) of the edited node. */
  selected: Set<AnchorKey>;
  /** The open end the pen extends, or null between paths. */
  drawing: PenEnd | null;
  /** The document the pen's lead handle was set on: any other change (an undo) drops the lead. */
  leadDoc: DesignDocument | null;
  /** Vectors the pen made in this file: closing one gives it the default fill. */
  readonly created: Set<NodeId>;
  notify: Notify | null;
  /** The node the selection belongs to (a different node starts empty). */
  nodeId: NodeId | null;
  installed: boolean;
  /** Told when the selected anchors change (the panel's "Point"). */
  readonly listeners: Set<() => void>;
};

const sessions = new WeakMap<DesignStore, VectorSession>();

export function sessionOf(store: DesignStore): VectorSession {
  let session = sessions.get(store);
  if (!session) {
    session = {selected: new Set(), drawing: null, leadDoc: null, created: new Set(), notify: null, nodeId: null, installed: false, listeners: new Set()};
    sessions.set(store, session);
  }
  return session;
}

export const editedVectorId = (state: EditorState): NodeId | null => (state.editing?.kind === 'vector' ? state.editing.id : null);

/** Shows a message through the toast the editor installed (silently nothing in tests). */
export function notify(store: DesignStore, message: string, kind: 'success' | 'error' = 'error') {
  sessionOf(store).notify?.(message, kind);
}

/** The session's selection, reset when the node changed and pruned to anchors that exist. */
export function selectedKeys(store: DesignStore, network: Network): Set<AnchorKey> {
  const session = sessionOf(store);
  const id = editedVectorId(store.getState());
  if (session.nodeId !== id) {
    session.nodeId = id;
    session.selected = new Set();
    session.drawing = null;
  }
  if ([...session.selected].some(key => !validKeys(network, [key]).size)) session.selected = validKeys(network, session.selected);
  return session.selected;
}

/** The end the pen extends, its lead handle kept only while the document is the one it was set on. */
export function penEnd(store: DesignStore): PenEnd | null {
  const session = sessionOf(store);
  const end = session.drawing;
  if (!end?.lead || session.leadDoc === store.getState().doc) return end;
  return {p: end.p, s: end.s, end: end.end, lead: null};
}

export function setPenEnd(store: DesignStore, end: PenEnd | null) {
  const session = sessionOf(store);
  session.drawing = end;
  session.leadDoc = end?.lead ? store.getState().doc : null;
}

export function setSelectedKeys(store: DesignStore, keys: Iterable<AnchorKey>) {
  const session = sessionOf(store);
  session.nodeId = editedVectorId(store.getState());
  session.selected = new Set(keys);
  for (const listener of [...session.listeners]) listener();
}

/** Calls `listener` whenever the selected anchors change; returns the undo. */
export function subscribeAnchors(store: DesignStore, listener: () => void): () => void {
  const {listeners} = sessionOf(store);
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/**
 * Opens the vector editor on a node: selects it, sets `editing` and switches to the editor's
 * selection tool (or keeps the pen). Shapes stay shapes until the first edit. Returns false with a
 * message when the node cannot be edited this way (a boolean, a text, a layer inside an instance).
 */
export function enterVectorEdit(store: DesignStore, id: NodeId, options: {tool?: 'vector-edit' | 'pen'} = {}): boolean {
  const state = store.getState();
  const node = state.doc.nodes[id];
  if (!node || node.locked) {
    if (editedVectorId(state) === id) store.setEditing(null);
    return false;
  }
  const blocker = vectorEditBlocker(state.doc, id);
  if (blocker) {
    notify(store, blocker);
    if (editedVectorId(store.getState()) === id) store.setEditing(null);
    return false;
  }
  const session = sessionOf(store);
  if (session.nodeId !== id) {
    session.nodeId = id;
    session.selected = new Set();
    session.drawing = null;
  }
  if (state.selection.length !== 1 || state.selection[0] !== id) store.setSelection([id]);
  store.setEditing({kind: 'vector', id});
  const tool = options.tool ?? (VECTOR_EDIT_TOOLS.has(store.getState().tool) ? store.getState().tool : 'vector-edit');
  store.setTool(tool);
  return true;
}

/**
 * Leaves the vector editor ("Done", Enter, Esc): lone points a pen click left behind go (a vector
 * of nothing but lone points goes entirely), the node stays selected and the move tool returns.
 */
export function exitVectorEdit(store: DesignStore, options: {tool?: string} = {}): void {
  const state = store.getState();
  const id = editedVectorId(state);
  const session = sessionOf(store);
  session.drawing = null;
  session.selected = new Set();
  if (id) {
    const node = state.doc.nodes[id];
    if (node?.type === 'VECTOR') {
      const network = networkOfNode(node);
      if (hasLonePoints(network)) {
        store.transact('Pen', tx => {
          if (!writeNetwork(tx, id, pruneLonePoints(network))) removeNodes(tx, [id]);
        });
      }
    }
    store.setEditing(null);
  }
  const tool = options.tool ?? 'move';
  if (store.getState().tool !== tool) store.setTool(tool);
  if (id && store.getState().doc.nodes[id]) store.setSelection([id]);
}

/** Writes an edited network into the node (re-fitting its box, converting a shape). Returns false
 *  when the network is empty: the caller removes the node then. */
export function writeNetwork(tx: Transaction, id: NodeId, network: Network): boolean {
  const node = tx.get(id);
  if (!node) return false;
  const fields = vectorFields(node, network);
  if (!fields) return false;
  const paints = remappedPaints(node, fields);
  userUpdate(tx, id, fields);
  // Re-expressed paints are the same colours in a new box, not a hand-made change: no style detach.
  if (paints) tx.update(id, paints);
  return true;
}

/**
 * Keeps the store consistent with the vector editor (call once per store; the editor passes its
 * toast): `editing` set from anywhere opens the editor with its tool, a node that cannot be edited
 * is refused with a message, and another tool, another selection or a vanished node leave it.
 */
export function installVectorEditing(store: DesignStore, options: {notify?: Notify} = {}): () => void {
  const session = sessionOf(store);
  if (options.notify) session.notify = options.notify;
  if (session.installed) return () => {};
  session.installed = true;
  let busy = false;
  const sync = () => {
    if (busy) return;
    busy = true;
    try {
      const state = store.getState();
      const id = editedVectorId(state);
      if (id) {
        const node: SceneNode | undefined = state.doc.nodes[id];
        if (!node) {
          store.setEditing(null);
        } else if (!VECTOR_EDIT_TOOLS.has(state.tool)) {
          // Opened by the canvas (double click, Enter): pick the editor's tool, or leave when
          // another tool was chosen while editing.
          if (lastTool !== null && lastTool !== state.tool && VECTOR_EDIT_TOOLS.has(lastTool) && lastEditing === id) store.setEditing(null);
          else enterVectorEdit(store, id);
        } else if (state.selection.length !== 1 || state.selection[0] !== id) {
          // Another layer was picked in the panel (or the selection was cleared): Figma leaves too.
          if (lastEditing === id) store.setEditing(null);
          else store.setSelection([id]);
        }
      } else if (state.tool === 'vector-edit' || state.tool === 'vector-bend') {
        store.setTool('move');
      }
      const after = store.getState();
      lastTool = after.tool;
      lastEditing = editedVectorId(after);
      if (!lastEditing) {
        session.drawing = null;
        session.selected = new Set();
      }
    } finally {
      busy = false;
    }
  };
  let lastTool: string | null = store.getState().tool;
  let lastEditing: NodeId | null = editedVectorId(store.getState());
  const stop = store.subscribe(sync, {slice: ['editing', 'tool', 'selection']});
  sync();
  return () => {
    stop();
    session.installed = false;
  };
}
