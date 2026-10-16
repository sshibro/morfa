import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import type {DesignStore, DocumentChange} from '../../engine/store';

// The file's local components for the assets panel: main components that stand alone and variant
// sets (a set is one asset, as in Figma), never copies inside instances nor a shared library's copies
// (the panel lists those under their library). Built once when the panel
// opens, then kept up to date from the store's change events: only the changed ids are looked at,
// and a change anywhere inside a component bumps that component's thumbnail version.

export type ComponentEntry = {
  id: NodeId;
  type: 'COMPONENT' | 'COMPONENT_SET';
  name: string;
  description: string;
  pageId: NodeId;
};

export const isAsset = (doc: DesignDocument, node: SceneNode | undefined): boolean =>
  !!node && node.mainId === undefined && !node.remote
  && (node.type === 'COMPONENT_SET' || (node.type === 'COMPONENT' && doc.nodes[node.parentId ?? '']?.type !== 'COMPONENT_SET'));

function pageOf(doc: DesignDocument, node: SceneNode): NodeId | null {
  let current: SceneNode | undefined = node;
  for (let guard = 0; current && current.type !== 'PAGE' && guard < 10_000; guard++) current = current.parentId ? doc.nodes[current.parentId] : undefined;
  return current?.type === 'PAGE' ? current.id : null;
}

function entryOf(doc: DesignDocument, node: SceneNode): ComponentEntry | null {
  const pageId = pageOf(doc, node);
  if (!pageId) return null;
  return {id: node.id, type: node.type as ComponentEntry['type'], name: node.name, description: node.description ?? '', pageId};
}

const sameEntry = (a: ComponentEntry | undefined, b: ComponentEntry | null) =>
  !!a && !!b && a.name === b.name && a.description === b.description && a.pageId === b.pageId && a.type === b.type;

export class ComponentIndex {
  private entries = new Map<NodeId, ComponentEntry>();
  private versions = new Map<NodeId, number>();
  private listeners = new Set<() => void>();
  private list: ComponentEntry[] = [];
  private detach: (() => void) | null = null;
  /** Bumped when the list or any thumbnail version changes. */
  private revision = 0;

  constructor(readonly store: DesignStore) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    if (!this.detach) {
      this.scan(this.store.getState().doc);
      this.detach = this.store.onDocument(change => this.apply(change));
    }
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size && this.detach) {
        this.detach();
        this.detach = null;
      }
    };
  };

  readonly getRevision = () => this.revision;

  /** Components and sets in page order, then by name. */
  components(): readonly ComponentEntry[] {
    if (!this.detach) this.scan(this.store.getState().doc);
    return this.list;
  }

  /** Changes whenever the component or anything inside it changes (thumbnails redraw on it). */
  thumbnailVersion(id: NodeId): number {
    return this.versions.get(id) ?? 0;
  }

  /** Pictures or fonts arrived: every thumbnail is drawn again. */
  invalidateThumbnails() {
    for (const id of this.entries.keys()) this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
    this.emit();
  }

  private scan(doc: DesignDocument) {
    this.entries.clear();
    for (const id in doc.nodes) {
      const node = doc.nodes[id];
      if (!isAsset(doc, node)) continue;
      const entry = entryOf(doc, node);
      if (entry) this.entries.set(id, entry);
    }
    this.rebuildList(doc);
  }

  private apply(change: DocumentChange) {
    if (change.source === 'gesture') return;
    const doc = change.doc;
    if (change.source === 'replace' || change.pagesChanged) {
      this.scan(doc);
      for (const id of this.entries.keys()) this.versions.set(id, (this.versions.get(id) ?? 0) + 1);
      this.emit();
      return;
    }
    let listChanged = false;
    let thumbsChanged = false;
    const bumped = new Set<NodeId>();
    for (const id of change.changed) {
      const node = doc.nodes[id];
      const before = this.entries.get(id);
      if (isAsset(doc, node)) {
        const entry = entryOf(doc, node);
        if (!sameEntry(before, entry)) {
          if (entry) this.entries.set(id, entry);
          else this.entries.delete(id);
          listChanged = true;
        }
      } else if (before) {
        this.entries.delete(id);
        listChanged = true;
      }
      // Anything inside a component (or the component itself) redraws its thumbnail.
      for (let up: SceneNode | undefined = node, guard = 0; up && up.type !== 'PAGE' && guard < 10_000; up = up.parentId ? doc.nodes[up.parentId] : undefined, guard++) {
        if (bumped.has(up.id)) break;
        if (this.entries.has(up.id)) {
          bumped.add(up.id);
          this.versions.set(up.id, (this.versions.get(up.id) ?? 0) + 1);
          thumbsChanged = true;
        }
      }
    }
    if (listChanged) this.rebuildList(doc);
    if (listChanged || thumbsChanged) this.emit();
  }

  private rebuildList(doc: DesignDocument) {
    const pageOrder = new Map(doc.pages.map((id, i) => [id, i]));
    this.list = [...this.entries.values()].sort((a, b) =>
      (pageOrder.get(a.pageId) ?? 0) - (pageOrder.get(b.pageId) ?? 0) || BY_NAME.compare(a.name, b.name));
  }

  private emit() {
    this.revision++;
    for (const listener of [...this.listeners]) listener();
  }
}

/** `localeCompare(…, 'en', {numeric: true})`, the same order: a call with options builds a collator each time (34 ms to sort 600
 *  names, against 1 ms with one collator). */
const BY_NAME = new Intl.Collator('en', {numeric: true});

const indexes = new WeakMap<DesignStore, ComponentIndex>();

export function componentIndex(store: DesignStore): ComponentIndex {
  let index = indexes.get(store);
  if (!index) indexes.set(store, (index = new ComponentIndex(store)));
  return index;
}

// ── Folders ────────────────────────────────────────────────────────────────────────────────────

export type AssetFolder<T> = {name: string; key: string; folders: AssetFolder<T>[]; items: {entry: T; name: string}[]};

/** "Button/Primary" → the folder "Button" holding "Primary". Spaces around "/" do not count. */
export function folderTree<T extends {name: string}>(entries: readonly T[], keyPrefix: string): AssetFolder<T> {
  const root: AssetFolder<T> = {name: '', key: keyPrefix, folders: [], items: []};
  for (const entry of entries) {
    const parts = entry.name.split('/').map(part => part.trim()).filter(Boolean);
    const leaf = parts.pop() ?? entry.name;
    let folder = root;
    for (const part of parts) {
      let next = folder.folders.find(each => each.name === part);
      if (!next) folder.folders.push((next = {name: part, key: `${folder.key}/${part}`, folders: [], items: []}));
      folder = next;
    }
    folder.items.push({entry, name: leaf});
  }
  return root;
}
