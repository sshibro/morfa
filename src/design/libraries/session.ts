import type {DesignFileLibrary, DesignOwnLibrary} from '../../../shared/design/api';
import type {DesignDocument, NodeId, StyleId} from '../../../shared/design/types';
import {LIBRARY_PAGE_ID} from '../../../shared/design/types';
import {
  applyLibraryImport,
  libraryUpdates,
  remoteId,
  validateLibraryImport,
  validateLibrarySnapshot,
  type LibraryImport,
  type LibrarySelection,
  type LibrarySnapshot,
  type LibraryUpdate,
} from '../../../shared/design/libraries';
import type {EditorServices} from '../editor/services';
import type {ShowToast} from '../ui/Toast';
import * as client from './api';
import {libraryBadge, UPDATES_DIALOG} from './host';

// One open file's view of its shared libraries (docs/design-tool.md §Teams, "Shared libraries"): the libraries of its place and
// which it enabled, the updates its copies are behind on, version snapshots for thumbnails, and the imports that bring assets
// in and keep them current. Loaded with the libraries' first use (src/design/libraries/host.tsx starts it when a file opens).

export type LibrarySessionState = {
  status: 'loading' | 'ready' | 'error';
  libraries: readonly DesignFileLibrary[];
  /** This file's own library, once asked for (the dialogs). */
  own: DesignOwnLibrary['library'] | undefined;
  updates: readonly LibraryUpdate[];
  error: string | null;
};

export type LibrarySessionOptions = {
  canEdit: boolean;
  /** The file's team, null for a personal file: libraries are offered within it. */
  teamName: string | null;
  showToast: ShowToast;
};

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);
const EMPTY: readonly LibraryUpdate[] = [];

export class LibrarySession {
  private state: LibrarySessionState = {status: 'loading', libraries: [], own: undefined, updates: EMPTY, error: null};
  private readonly listeners = new Set<() => void>();
  private readonly snapshots = new Map<string, Promise<LibrarySnapshot>>();
  private stopWatch: (() => void) | null = null;
  /** What the updates were last computed from (identity checks: a pan or a layer edit leaves them). */
  private computedFrom: {page: unknown; styles: unknown; collections: unknown; libraries: unknown} | null = null;
  private greeted = false;
  private disposed = false;

  constructor(readonly services: EditorServices, private readonly options: LibrarySessionOptions) {}

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  };
  readonly getState = () => this.state;
  get canEdit() {
    return this.options.canEdit && !this.services.readOnly;
  }
  get teamName() {
    return this.options.teamName;
  }

  start(): () => void {
    this.stopWatch = this.services.store.subscribe(() => this.recompute(), {slice: 'doc'});
    void this.refresh().then(() => this.greet());
    return () => this.dispose();
  }

  dispose() {
    this.disposed = true;
    this.stopWatch?.();
    this.stopWatch = null;
    this.listeners.clear();
    libraryBadge.set(0);
  }

  private set(partial: Partial<LibrarySessionState>) {
    if (this.disposed) return;
    this.state = {...this.state, ...partial};
    for (const listener of [...this.listeners]) listener();
  }

  /** The libraries of the file's place and the ones it enabled. */
  async refresh(): Promise<void> {
    try {
      const {libraries} = await client.listFileLibraries(this.services.fileId);
      this.set({status: 'ready', libraries, error: null});
      this.recompute(true);
    } catch (error) {
      this.set({status: this.state.status === 'ready' ? 'ready' : 'error', error: errorText(error, 'Could not load libraries.')});
    }
  }

  async loadOwn(): Promise<void> {
    try {
      this.set({own: (await client.readOwnLibrary(this.services.fileId)).library});
    } catch (error) {
      this.set({error: errorText(error, 'Could not load the library of this file.')});
    }
  }

  /** Libraries this file uses or may use, by id. */
  library(id: string): DesignFileLibrary | undefined {
    return this.state.libraries.find(each => each.id === id);
  }

  /** Updates are recomputed only when the copies or the libraries changed (identity checks on the hidden page, the styles, the
   *  collections and the list). */
  private recompute(force = false) {
    const doc = this.services.store.getState().doc;
    const from = {page: doc.nodes[LIBRARY_PAGE_ID], styles: doc.styles, collections: doc.variableCollections, libraries: this.state.libraries};
    const last = this.computedFrom;
    if (!force && last && last.page === from.page && last.styles === from.styles && last.collections === from.collections && last.libraries === from.libraries) return;
    this.computedFrom = from;
    const current = this.state.libraries.filter(library => library.enabled && library.available);
    const updates = libraryUpdates(doc, current);
    const same = updates.length === this.state.updates.length && updates.every((update, i) => update.localId === this.state.updates[i].localId && update.to === this.state.updates[i].to);
    if (!same) this.set({updates: updates.length ? updates : EMPTY});
    libraryBadge.set(updates.length);
  }

  /** "Library updates are available" once per opening, when a library has a version the file was not told about yet. */
  private greet() {
    if (this.greeted || !this.canEdit || !this.state.updates.length) return;
    const fresh = this.state.updates.some(update => {
      const library = this.library(update.libraryId);
      return !!library && library.version > (library.seenVersion ?? 0);
    });
    if (!fresh) return;
    this.greeted = true;
    const names = [...new Set(this.state.updates.map(update => this.library(update.libraryId)?.name).filter(Boolean))];
    this.options.showToast(names.length === 1 ? `Updates are available for the library "${names[0]}"` : 'Library updates are available', {
      durationMs: 10_000,
      action: {label: 'View', onClick: () => this.services.openDialog(UPDATES_DIALOG)},
    });
  }

  // ── Enabling ────────────────────────────────────────────────────────────────────────────────

  async setEnabled(libraryId: string, enabled: boolean): Promise<void> {
    if (enabled) await client.enableLibrary(this.services.fileId, libraryId);
    else await client.disableLibrary(this.services.fileId, libraryId);
    await this.refresh();
  }

  // ── Snapshots ───────────────────────────────────────────────────────────────────────────────

  /** A version's snapshot, checked before anything reads it; kept for the session. */
  snapshot(libraryId: string, version: number): Promise<LibrarySnapshot> {
    const key = `${libraryId}@${version}`;
    let pending = this.snapshots.get(key);
    if (!pending) {
      pending = client.readLibraryVersion(this.services.fileId, libraryId, version).then(answer => {
        const checked = validateLibrarySnapshot(answer.snapshot);
        if (!checked.ok) throw new Error('The library arrived damaged: ' + checked.error);
        return checked.value;
      });
      pending.catch(() => this.snapshots.delete(key));
      this.snapshots.set(key, pending);
    }
    return pending;
  }

  // ── Bringing assets in ──────────────────────────────────────────────────────────────────────

  /** Asks the server for the assets at the library's newest version and puts them into the file as one undo step. */
  private async importInto(libraryId: string, request: LibrarySelection, label: string): Promise<void> {
    const library = this.library(libraryId);
    if (!library) throw new Error('The library is no longer available.');
    const answer = await client.importLibraryAssets(this.services.fileId, libraryId, {
      version: library.version,
      components: [...request.components],
      styles: [...request.styles],
      variableCollections: [...request.variableCollections],
    });
    const checked = validateLibraryImport(answer.import);
    if (!checked.ok) throw new Error('The library arrived damaged: ' + checked.error);
    if (checked.value.libraryId !== libraryId) throw new Error('The wrong library arrived.');
    this.services.store.transact(label, tx => void applyLibraryImport(tx, checked.value));
  }

  /** The local id of a library component, imported first when the file has no copy yet (a copy behind an update stays as it is:
   *  the update brings it forward). */
  async component(libraryId: string, key: NodeId): Promise<NodeId> {
    const local = remoteId(libraryId, key);
    if (!this.services.store.getState().doc.nodes[local]) await this.importInto(libraryId, {components: [key], styles: [], variableCollections: []}, 'Library component');
    if (!this.services.store.getState().doc.nodes[local]) throw new Error('Could not add the component.');
    return local;
  }

  async style(libraryId: string, key: StyleId): Promise<StyleId> {
    const local = remoteId(libraryId, key);
    if (!this.services.store.getState().doc.styles[local]) await this.importInto(libraryId, {components: [], styles: [key], variableCollections: []}, 'Library style');
    if (!this.services.store.getState().doc.styles[local]) throw new Error('Could not add the style.');
    return local;
  }

  async collection(libraryId: string, key: string): Promise<string> {
    const local = remoteId(libraryId, key);
    const existing = this.services.store.getState().doc.variableCollections[local];
    if (!existing || existing.remote?.key !== key || !this.hasWholeCollection(libraryId, key)) {
      await this.importInto(libraryId, {components: [], styles: [], variableCollections: [key]}, 'Library variables');
    }
    return local;
  }

  /** Whether the file holds every published variable of a collection (a dependency brings only the ones it uses). */
  hasWholeCollection(libraryId: string, key: string): boolean {
    const doc: DesignDocument = this.services.store.getState().doc;
    const collection = doc.variableCollections[remoteId(libraryId, key)];
    const published = this.library(libraryId)?.manifest.variableCollections.find(entry => entry.key === key);
    return !!collection && !!published && collection.variableIds.length >= published.variables;
  }

  // ── Updates ─────────────────────────────────────────────────────────────────────────────────

  /** Takes the given updates (all of them by default): each library's assets at its newest version, in one undo step. The
   *  copies are replaced under the same ids, so instances keep their overrides. */
  async update(updates: readonly LibraryUpdate[] = this.state.updates): Promise<number> {
    if (!updates.length) return 0;
    const byLibrary = new Map<string, {components: string[]; styles: string[]; variableCollections: string[]}>();
    for (const update of updates) {
      let request = byLibrary.get(update.libraryId);
      if (!request) byLibrary.set(update.libraryId, (request = {components: [], styles: [], variableCollections: []}));
      (update.kind === 'component' ? request.components : update.kind === 'style' ? request.styles : request.variableCollections).push(update.key);
    }
    const payloads: LibraryImport[] = [];
    for (const [libraryId, request] of byLibrary) {
      const library = this.library(libraryId);
      if (!library) continue;
      const answer = await client.importLibraryAssets(this.services.fileId, libraryId, {version: library.version, ...request});
      const checked = validateLibraryImport(answer.import);
      if (!checked.ok) throw new Error('The library arrived damaged: ' + checked.error);
      payloads.push(checked.value);
    }
    this.services.store.transact(updates.length === 1 ? 'Update from library' : 'Update from libraries', tx => {
      for (const payload of payloads) applyLibraryImport(tx, payload);
    });
    this.recompute(true);
    // A library none of whose updates are left counts as seen at its version.
    for (const libraryId of byLibrary.keys()) {
      if (this.state.updates.some(update => update.libraryId === libraryId)) continue;
      await this.markSeen(libraryId).catch(() => undefined);
    }
    return updates.length;
  }

  /** "Later": the file was told; the greeting waits for the next version. */
  async later(): Promise<void> {
    for (const libraryId of new Set(this.state.updates.map(update => update.libraryId))) await this.markSeen(libraryId).catch(() => undefined);
  }

  private async markSeen(libraryId: string) {
    const library = this.library(libraryId);
    if (!library || !this.canEdit) return;
    await client.markLibrarySeen(this.services.fileId, libraryId, library.version);
    this.set({libraries: this.state.libraries.map(each => (each.id === libraryId ? {...each, seenVersion: library.version} : each))});
  }

  // ── Publishing ──────────────────────────────────────────────────────────────────────────────

  /** Saves what is typed, then publishes the selected assets as the file's next library version. */
  async publish(selection: LibrarySelection, description: string): Promise<number> {
    const persistence = this.services.persistence;
    await persistence?.flush();
    const baseVersion = persistence?.version() ?? 1;
    const {library} = await client.publishLibrary(this.services.fileId, {
      baseVersion,
      components: [...selection.components],
      styles: [...selection.styles],
      variableCollections: [...selection.variableCollections],
      description,
    });
    this.set({own: library});
    return library?.version ?? 0;
  }

  async unpublish(): Promise<void> {
    this.set({own: (await client.unpublishLibrary(this.services.fileId)).library});
  }
}

const sessions = new WeakMap<object, LibrarySession>();
const sessionListeners = new Set<() => void>();
const sessionsChanged = () => {
  for (const listener of [...sessionListeners]) listener();
};

/** The session of an open file (by its store), created when the file opens. */
export function librarySession(services: EditorServices): LibrarySession | undefined {
  return sessions.get(services.store);
}

/** Called when a file's session starts or stops (a dialog opened before it started waits for it). */
export function onLibrarySessions(listener: () => void): () => void {
  sessionListeners.add(listener);
  return () => void sessionListeners.delete(listener);
}

export function startLibrarySession(services: EditorServices, options: LibrarySessionOptions): () => void {
  sessions.get(services.store)?.dispose();
  const session = new LibrarySession(services, options);
  sessions.set(services.store, session);
  const stop = session.start();
  sessionsChanged();
  return () => {
    stop();
    if (sessions.get(services.store) === session) sessions.delete(services.store);
    sessionsChanged();
  };
}
