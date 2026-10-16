import type {NodeId} from '../../../../shared/design/types';
import type {DesignStore} from '../../engine/store';
import {LayerRows} from './layer-rows';

// The layers panel's state that outlives the panel's components: which containers are expanded on
// each page, the rows of the current page, and requests from commands ("Collapse all layers" ⌥L,
// "Rename" ⌘R) that reach the tree when it is mounted. One per store; React reads it with
// useSyncExternalStore through `subscribe` and `getVersion`.

export class LayerTreeState {
  private readonly expandedByPage = new Map<NodeId, Set<NodeId>>();
  private current: LayerRows | null = null;
  private listeners = new Set<() => void>();
  private renameListeners = new Set<(id: NodeId) => void>();
  private batchRenameListeners = new Set<(ids: readonly NodeId[]) => void>();
  private unsubscribe: (() => void) | null = null;
  private version = 0;

  constructor(readonly store: DesignStore) {}

  /** The rows of the store's current page (built on first use, followed while someone listens). */
  rows(): LayerRows {
    const {doc, pageId} = this.store.getState();
    if (!this.current || this.current.pageId !== pageId) {
      this.current = new LayerRows(doc, pageId, this.expandedFor(pageId));
    } else if (!this.unsubscribe) {
      this.current.update(doc);
    }
    return this.current;
  }

  expandedFor(pageId: NodeId): Set<NodeId> {
    let set = this.expandedByPage.get(pageId);
    if (!set) this.expandedByPage.set(pageId, (set = new Set()));
    return set;
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.unsubscribe) {
      this.rows();
      this.unsubscribe = this.store.subscribe(() => this.sync(), {slice: ['doc', 'page']});
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.unsubscribe) {
        this.unsubscribe();
        this.unsubscribe = null;
      }
    };
  };

  readonly getVersion = () => this.version;

  setExpanded(id: NodeId, open: boolean, deep = false) {
    if (this.rows().setExpanded(id, open, deep)) this.emit();
  }

  reveal(ids: Iterable<NodeId>) {
    if (this.rows().reveal(ids)) this.emit();
  }

  collapseAll() {
    const {pageId} = this.store.getState();
    const rows = this.rows();
    const changed = rows.collapseAll();
    this.expandedFor(pageId).clear();
    if (changed) this.emit();
  }

  /** Asks the mounted tree to rename a layer inline. Returns false when no tree is listening. */
  requestRename(id: NodeId): boolean {
    for (const listener of this.renameListeners) listener(id);
    return this.renameListeners.size > 0;
  }

  onRenameRequest(listener: (id: NodeId) => void) {
    this.renameListeners.add(listener);
    return () => void this.renameListeners.delete(listener);
  }

  /** Asks the mounted tree to open "Rename layers" for several layers. Returns false when no tree is listening. */
  requestBatchRename(ids: readonly NodeId[]): boolean {
    for (const listener of this.batchRenameListeners) listener(ids);
    return this.batchRenameListeners.size > 0;
  }

  onBatchRenameRequest(listener: (ids: readonly NodeId[]) => void) {
    this.batchRenameListeners.add(listener);
    return () => void this.batchRenameListeners.delete(listener);
  }

  private sync() {
    const {doc, pageId} = this.store.getState();
    if (!this.current || this.current.pageId !== pageId) {
      this.current = new LayerRows(doc, pageId, this.expandedFor(pageId));
      this.emit();
      return;
    }
    if (this.current.update(doc)) this.emit();
  }

  private emit() {
    this.version++;
    for (const listener of [...this.listeners]) listener();
  }
}

const states = new WeakMap<DesignStore, LayerTreeState>();

export function layerTreeState(store: DesignStore): LayerTreeState {
  let state = states.get(store);
  if (!state) states.set(store, (state = new LayerTreeState(store)));
  return state;
}
