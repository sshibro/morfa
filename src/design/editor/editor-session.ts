import type {DesignDocument, NodeId, SceneNode, VectorPath} from '../../../shared/design/types';
import type {DesignFileOpened, DesignSaved} from '../../../shared/design/api';
import {booleanGeometry} from '../../../shared/design/boolean';
import {snapshotDocument} from '../../../shared/design/table-cache';
import {textBoxSize, type FontSpec} from '../../../shared/design/text-layout';
import type {SpatialIndex} from '../../../shared/design/tree';
import type {DocumentPatch} from '../../../shared/design/patch';
import {openDesignFile, replaceDesignDocument, uploadDesignThumbnail} from '../api';
import {fontSpecsUnder} from '../engine/export-raster';
import {createFontRegistry, internalFamily, type DesignFontRegistry} from '../engine/fonts';
import {createImageCache, type DesignImageCache} from '../engine/images';
import {createSwitchingSceneRenderer, type DesignSceneRenderer} from '../engine/render';
import {benchRenderer} from './bench-hook';
import {createDesignStore, type DesignStore, type EditorUI, type PartialOptions} from '../engine/store';
import {renderThumbnail} from '../engine/thumbnail';
import {createAutosave, type Autosave, type AutosaveOptions, type AutosaveRequest, type AutosaveStatus, type AutosaveStop} from '../persistence/autosave';
import {describeEntry, recoveryMessage, revertRefused, stoppedMessage, type Reverted} from '../persistence/recovery';
import {ONE_SHOT_TOOLS} from './command-bridge';
import {createThumbnailScheduler, type ThumbnailScheduler} from './thumbnails';

// One open file: its fonts, pictures, store and renderer (`createEditorSession`, no side effects),
// and what runs while the editor is mounted (`startSession`): autosave fed by the store's patches,
// the card picture, text re-measured when its font arrives, and the drawing tools handing back to
// "Move". DesignEditor.tsx creates one per file and starts it in an effect, so a React
// remount (StrictMode) stops and starts it cleanly.

export type EditorSession = {
  readonly fileId: string;
  readonly store: DesignStore;
  readonly fonts: DesignFontRegistry;
  readonly images: DesignImageCache;
  /** The canvas renderer once CanvasView has made it. */
  renderer(): DesignSceneRenderer | null;
  /** CanvasView's `createRenderer`: the tiled renderer, fed the store's document changes. */
  createRenderer(canvas: HTMLCanvasElement): DesignSceneRenderer;
  /** CanvasView's `spatialIndex`. */
  spatialIndex(doc: DesignDocument, pageId: NodeId): SpatialIndex | null;
  readonly booleanGeometry: (doc: DesignDocument, id: NodeId) => readonly VectorPath[] | null;
  /** Families whose faces finished loading since the session was made and before it started (their
   *  text is checked when it starts). */
  takeEarlyFontLoads(): string[];
  dispose(): void;
};

/** Boolean geometry for painting: a shape over the time or point budget paints its operands instead of failing the frame. */
const safeBooleanGeometry = (doc: DesignDocument, id: NodeId): readonly VectorPath[] | null => {
  try {
    return booleanGeometry(doc, id);
  } catch {
    return null;
  }
};

export function createEditorSession(options: {fileId: string; doc: DesignDocument; fonts?: DesignFontRegistry; images?: DesignImageCache; ui?: Partial<EditorUI>; readOnly?: boolean; partial?: PartialOptions}): EditorSession {
  const fonts = options.fonts ?? createFontRegistry();
  const images = options.images ?? createImageCache();
  // Big files: eviction (the memory budget) never drops a page while a change waits to be saved.
  let dirty: () => boolean = () => false;
  const partial = options.partial ? {...options.partial, dirty: () => options.partial?.dirty?.() || dirty()} : undefined;
  const store = createDesignStore({doc: options.doc, measurer: fonts.measurer, ui: options.ui, readOnly: options.readOnly, partial});
  store.setDirtyCheck = check => {
    dirty = check;
  };
  let renderer: DesignSceneRenderer | null = null;
  let offDocument: (() => void) | null = null;
  const early = new Set<string>();
  let offEarly: (() => void) | null = fonts.onLoad(family => void early.add(family));
  return {
    fileId: options.fileId,
    store,
    fonts,
    images,
    booleanGeometry: safeBooleanGeometry,
    takeEarlyFontLoads() {
      offEarly?.();
      offEarly = null;
      const families = [...early];
      early.clear();
      return families;
    },
    renderer: () => renderer,
    createRenderer(canvas) {
      // A remounted canvas makes a new renderer; the old one stops listening.
      offDocument?.();
      // Canvas2D at once; the GPU renderer (lane L4) takes over when the render module runs as wasm on WebGPU.
      const next = createSwitchingSceneRenderer(canvas, {fonts, images, booleanGeometry: safeBooleanGeometry});
      void next.whenReady.then(() => benchRenderer(next.engine(), next.reason()));
      offDocument = store.onDocument(change => next.documentChanged(change));
      renderer = next;
      return next;
    },
    spatialIndex: (doc, pageId) => renderer?.indexFor(doc, pageId) ?? null,
    dispose() {
      offEarly?.();
      offDocument?.();
      offDocument = null;
      renderer = null;
      images.dispose();
    },
  };
}

// ── Fonts ────────────────────────────────────────────────────────────────────────────────────────

/** The faces the text on the first page sets type in (what the first picture needs). */
export const firstPageFontSpecs = (doc: DesignDocument): FontSpec[] => (doc.pages[0] ? fontSpecsUnder(doc, doc.pages[0]) : []);

/** Starts loading the faces and resolves when they are usable or `timeoutMs` has passed, whichever is
 *  first: the first picture waits a moment for real type rather than flashing the fallback. */
export async function waitForFonts(fonts: Pick<DesignFontRegistry, 'ensure'>, specs: readonly FontSpec[], timeoutMs = 1500): Promise<void> {
  if (!specs.length) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([Promise.all(specs.map(spec => fonts.ensure(spec).catch(() => undefined))).then(() => undefined), timeout]);
  clearTimeout(timer);
}

/** Whether the text sets any of its characters in `family`. */
export function textUsesFamily(node: SceneNode, family: string): boolean {
  const text = node.text;
  if (!text) return false;
  if (text.style.fontFamily === family) return true;
  return text.runs.some(run => run.style.fontFamily === family);
}

/** Text whose box follows its content (auto width or auto height) and is stale for `family`: measured
 *  with a fallback before the real face arrived. */
export function staleTextFor(doc: DesignDocument, family: string, measurer: DesignStore['measurer']): NodeId[] {
  const out: NodeId[] = [];
  for (const id in doc.nodes) {
    const node = doc.nodes[id];
    const mode = node.text?.textAutoResize;
    if ((mode !== 'WIDTH_AND_HEIGHT' && mode !== 'HEIGHT') || !textUsesFamily(node, family)) continue;
    const size = textBoxSize(node, measurer);
    if (Math.abs(size.width - node.width) > 0.005 || Math.abs(size.height - node.height) > 0.005) out.push(id);
  }
  return out;
}

/** Re-measures the text that uses `family` (its face just loaded): the boxes follow the real type, the
 *  layouts around them settle, and autosave stores it. Not an undo step. Returns the texts touched. */
export function relayoutTextFor(store: DesignStore, family: string): NodeId[] {
  const ids = staleTextFor(store.getState().doc, family, store.measurer);
  if (!ids.length) return ids;
  store.transact('Font loaded', tx => {
    // Normalization re-measures what the transaction touched: a height that differs from the measured
    // one marks the text, and the auto-resize step writes the real size (anchored as typing would be).
    for (const id of ids) {
      const node = tx.get(id);
      if (node) tx.update(id, {height: node.height + 1});
    }
  }, {history: false});
  return ids;
}

/** Whether a face of `family` is actually loaded in the page (a failed load also fires `onLoad`, and
 *  re-measuring with the fallback would overwrite sizes measured with the real face). */
export function familyLoaded(family: string, fontSet: Iterable<FontFace> | undefined = typeof document !== 'undefined' ? document.fonts : undefined): boolean {
  if (!fontSet) return false;
  const name = internalFamily(family);
  for (const face of fontSet) {
    if (face.status === 'loaded' && face.family.replace(/^["']|["']$/g, '') === name) return true;
  }
  return false;
}

/** Keeps text boxes true to loaded fonts: each family that finishes loading (and `early` ones, loaded
 *  before this started) has its text re-measured. Waits for a drag to end (a transaction would end it). */
export function watchFontLoads(store: DesignStore, fonts: Pick<DesignFontRegistry, 'onLoad'>, early: Iterable<string> = [], isLoaded: (family: string) => boolean = familyLoaded): () => void {
  const waiting = new Set<string>();
  const run = () => {
    if (store.getState().live.size) return;
    for (const family of [...waiting]) {
      waiting.delete(family);
      if (isLoaded(family)) relayoutTextFor(store, family);
    }
  };
  const offLoad = fonts.onLoad(family => {
    waiting.add(family);
    run();
  });
  const offLive = store.subscribe(() => {
    if (waiting.size) run();
  }, {slice: 'live'});
  for (const family of early) waiting.add(family);
  run();
  return () => {
    offLoad();
    offLive();
  };
}

// ── Tools ────────────────────────────────────────────────────────────────────────────────────────

/** After a drawing tool creates a layer the tool hands back to "Move" (Figma's default). */
export function returnToMoveAfterDrawing(store: DesignStore, schedule: (run: () => void) => void = queueMicrotask): () => void {
  return store.onPatch(event => {
    if (event.source !== 'edit') return;
    const tool = store.getState().tool;
    if (!ONE_SHOT_TOOLS.has(tool)) return;
    // A layer the change made: one the inverse takes back to none.
    const created = Object.entries(event.patch.nodes ?? {}).some(([id, node]) => node && event.inverse.nodes?.[id] === null);
    // After the tool's pointer-up has finished, so it is not switched off in the middle of its own handler.
    if (created) schedule(() => {
      if (store.getState().tool === tool) store.setTool('move');
    });
  });
}

// ── Saving ───────────────────────────────────────────────────────────────────────────────────────

export type SessionPersistence = {
  version(): number;
  status(): AutosaveStatus;
  /** Changes not on the server yet. */
  dirty(): boolean;
  /** Sends what is waiting; rejects with a Russian message when it could not be stored. */
  flush(): Promise<void>;
  /** The page is going away: hand a small pending patch to a keepalive request. */
  flushOnHide(): void;
  /** Retry now after a failure. */
  retry(): void;
  /** Shows the server's copy (`doc` at `version`) without saving it back; autosave continues from it. */
  adopt(doc: DesignDocument, version: number): void;
  /** "Keep mine": writes the editor's whole document over the server's newer one (the server keeps the
   *  replaced one as a version), then autosave continues. Rejects when it could not. */
  keepMine(currentVersion: number | null): Promise<void>;
  /** Stops saving (the file went to the trash); flush then resolves at once. */
  close(): void;
  /** Why saving stopped ("Saving stopped"), until the file is reloaded. */
  stopped(): SaveStopped | null;
  dispose(): void;
  /** Co-editing (src/design/realtime): the autosave saving now (null for a read-only file), and the hooks it calls. */
  autosave(): Autosave | null;
  setCollaboration(hooks: CollaborationHooks | null): void;
};

/** What the realtime module plugs into saving: the connection id sent with each save, a hold while remote changes wait,
 *  the stored answers (with what to catch up on) and a fresh start after a reload of the stored file. */
export type CollaborationHooks = {
  client(): string | null;
  /** The socket carries saves (DESIGN_COLLAB rust): the request that sends them as ops; null for autosave's PATCH. */
  request?(): AutosaveRequest | null;
  hold(): boolean;
  onSaved(saved: DesignSaved, sent: DocumentPatch): void;
  /** The document was replaced by the stored one at `version` (reload, "Keep mine"). */
  onReset(version: number): void;
};

/** Refused changes were put back (no undo step); `message` says which and why, once per save. */
export type SaveRecovered = {message: string; reverted: readonly Reverted[]};
/** Saving stopped: a refused change could not be put back, or was refused again. */
export type SaveStopped = {message: string; stop: AutosaveStop};

export type PersistenceOptions = {
  fileId: string;
  baseVersion: number;
  onStatus: (status: AutosaveStatus) => void;
  onConflict: (currentVersion: number | null) => void;
  /** Every edit that goes to the server (the card picture follows them). */
  onEdit?: () => void;
  request?: AutosaveRequest;
  replace?: (fileId: string, baseVersion: number, doc: DesignDocument) => Promise<DesignSaved>;
  /** The server's current version when a conflict did not say it. */
  currentVersion?: (fileId: string) => Promise<number>;
  /** Autosave's page events (tests pass null). */
  events?: null;
  /** The server would refuse some changes (or did): they were put back and the rest saves. */
  onRecovered?: (report: SaveRecovered) => void;
  /** Saving stopped; the editor offers a copy to download and a reload. */
  onStopped?: (report: SaveStopped) => void;
  /** Tests: autosave's clock (a fake one sends only on flush). */
  timers?: AutosaveOptions['timers'];
};

const conflictOf = (error: unknown): {conflict: boolean; version: number | null} => {
  const details = (error as {status?: number; details?: {code?: unknown; currentVersion?: unknown}}) ?? {};
  const conflict = details.status === 409 && details.details?.code === 'version_conflict';
  return {conflict, version: typeof details.details?.currentVersion === 'number' ? details.details.currentVersion : null};
};

export function saveFailureMessage(status: AutosaveStatus): string {
  if (status === 'conflict') return 'The file was changed in another tab. Choose which version to keep, then navigate again.';
  if (status === 'offline') return 'No connection to the server: the latest changes are not saved yet. Check your connection and navigate again.';
  if (status === 'stopped') return 'Saving stopped: the latest changes are not saved. Download a copy of the file before leaving.';
  return 'Could not save the latest changes. Navigate again.';
}

export function attachPersistence(store: DesignStore, options: PersistenceOptions): SessionPersistence {
  const replace = options.replace ?? replaceDesignDocument;
  const currentVersion = options.currentVersion ?? (async (fileId: string) => (await openDesignFile(fileId)).file.version);
  let closed = false;
  let adopting = false;
  // Entries put back in one save (the check may take a few rounds): one message for all of them.
  let recovered: Reverted[] = [];
  const report = () => {
    const reverted = recovered;
    recovered = [];
    if (reverted.length) options.onRecovered?.({message: recoveryMessage(reverted), reverted});
  };
  let hooks: CollaborationHooks | null = null;
  const make = (version: number) => createAutosave({
    fileId: options.fileId,
    baseVersion: version,
    onStatus: options.onStatus,
    onConflict: options.onConflict,
    request: options.request,
    ...(options.timers ? {timers: options.timers} : {}),
    collaboration: () => (hooks ? {client: hooks.client(), request: hooks.request?.() ?? null} : null),
    hold: () => hooks?.hold() ?? false,
    onSaved: (answer, sent) => hooks?.onSaved(answer, sent),
    // A paste of thousands of layers is more than one PATCH may carry: the whole document goes instead.
    whole: {document: () => store.getState().doc, request: replace, onStored: saved => hooks?.onReset(saved.version)},
    recover(issues, saved) {
      const result = revertRefused(store, issues, saved);
      if (result.reverted.length) {
        if (!recovered.length) queueMicrotask(report);
        recovered.push(...result.reverted);
      }
      return result.ok;
    },
    onStopped(stop) {
      report();
      options.onStopped?.({message: stoppedMessage(stop.issues, issue => describeEntry(store, issue), stop.message), stop});
    },
    ...(options.events === null ? {events: null} : {}),
  });
  let autosave: Autosave = make(options.baseVersion);
  // The values before each change: autosave reads the server's copy of what a change touched from the event's inverse.
  const offPatch = store.onPatch(event => {
    // A change from the server (co-editing) is already the server's: autosave only follows the document. A page's layers
    // arriving or leaving (big files) likewise.
    if (event.source === 'remote' || event.source === 'page') {
      if (!closed) autosave.observe(event.patch, {inverse: event.inverse, after: event.doc});
      return;
    }
    // The server's own copy, shown after a conflict or a restore, is not sent back.
    if (closed || (adopting && event.source === 'replace')) return;
    autosave.push(event.patch, {inverse: event.inverse, after: event.doc});
    options.onEdit?.();
  });
  const restart = (version: number) => {
    autosave.dispose();
    autosave = make(version);
    hooks?.onReset(version);
  };
  return {
    version: () => autosave.version,
    status: () => autosave.status,
    dirty: () => !closed && autosave.unsaved() !== null,
    async flush() {
      if (closed) return;
      if (!(await autosave.flush())) throw new Error(saveFailureMessage(autosave.status));
    },
    flushOnHide: () => {
      if (!closed) autosave.flushOnHide();
    },
    retry: () => void autosave.flush(),
    adopt(doc, version) {
      restart(version);
      adopting = true;
      try {
        store.replaceDocument(doc);
      } finally {
        adopting = false;
      }
      options.onStatus('saved');
    },
    async keepMine(known) {
      // The autosave the conflict stopped sends nothing and still holds the unsaved changes: it stays until the copy is written, so a
      // failed attempt leaves them unsaved for the tab's close guard and the next attempt.
      const held = autosave;
      let base = known ?? (await currentVersion(options.fileId));
      for (let attempt = 0; ; attempt++) {
        try {
          const saved = await replace(options.fileId, base, store.getState().doc);
          held.dispose();
          autosave = make(saved.version);
          hooks?.onReset(saved.version);
          options.onStatus('saved');
          return;
        } catch (error) {
          const {conflict, version} = conflictOf(error);
          // Someone saved again meanwhile: write over that one too, a few times at most.
          if (!conflict || attempt >= 2) throw error;
          base = version ?? (await currentVersion(options.fileId));
        }
      }
    },
    close() {
      closed = true;
      autosave.dispose();
    },
    stopped() {
      const stop = autosave.stop;
      return stop ? {message: stoppedMessage(stop.issues, issue => describeEntry(store, issue), stop.message), stop} : null;
    },
    dispose() {
      offPatch();
      if (!closed) autosave.flushOnHide();
      autosave.dispose();
    },
    autosave: () => (closed ? null : autosave),
    setCollaboration(next) {
      hooks = next;
    },
  };
}

// ── Running ──────────────────────────────────────────────────────────────────────────────────────

export type SessionRuntime = {
  persistence: SessionPersistence;
  thumbnails: ThumbnailScheduler;
  stop(): void;
};

/** A read-only file saves nothing (docs/design-tool.md §Teams): its persistence holds the version it opened at, its card picture is
 *  the editors' to take. `adopt` still shows a newer copy (another member saved). */
export function readOnlyPersistence(store: DesignStore, version: number): SessionPersistence {
  let current = version;
  return {
    version: () => current,
    status: () => 'saved',
    dirty: () => false,
    stopped: () => null,
    flush: async () => undefined,
    flushOnHide: () => undefined,
    retry: () => undefined,
    adopt(doc, next) {
      current = next;
      store.replaceDocument(doc);
    },
    keepMine: async () => {
      throw new Error('View only: team editors can edit the file.');
    },
    close: () => undefined,
    dispose: () => undefined,
    autosave: () => null,
    setCollaboration: () => undefined,
  };
}
const NO_THUMBNAILS: ThumbnailScheduler = {noteEdit() {}, flush: async () => undefined, dirty: false, dispose() {}};

/** What runs while the editor shows the file. */
export function startSession(session: EditorSession, opened: DesignFileOpened, callbacks: Pick<PersistenceOptions, 'onStatus' | 'onConflict' | 'onRecovered' | 'onStopped'>): SessionRuntime {
  const {store, fonts, images, fileId} = session;
  if (store.readOnly) {
    // Text is still measured with the real fonts (a local correction, never saved); nothing else runs.
    const offFonts = watchFontLoads(store, fonts, session.takeEarlyFontLoads());
    return {persistence: readOnlyPersistence(store, opened.file.version), thumbnails: NO_THUMBNAILS, stop: offFonts};
  }
  const thumbnails = createThumbnailScheduler({
    // The picture's own document: rendering spans awaits (fonts, pictures), and the store's table may be written in place.
    getDoc: () => snapshotDocument(store.getState().doc),
    // Big files: the card shows the first page, which the store may not hold when another page is open.
    render: async doc => {
      const first = doc.pages[0];
      if (store.getState().pages && first && !store.getState().pages!.loaded.has(first)) {
        await store.ensurePage(first);
        doc = snapshotDocument(store.getState().doc);
      }
      return renderThumbnail(doc, {fonts, images, booleanGeometry: session.booleanGeometry});
    },
    upload: image => uploadDesignThumbnail(fileId, image),
  });
  const persistence = attachPersistence(store, {fileId, baseVersion: opened.file.version, ...callbacks, onEdit: () => thumbnails.noteEdit()});
  store.setDirtyCheck?.(() => persistence.dirty());
  const offFonts = watchFontLoads(store, fonts, session.takeEarlyFontLoads());
  const offTools = returnToMoveAfterDrawing(store);
  // A file that has content but no card picture yet (made elsewhere, imported) gets one.
  const firstPage = store.getState().doc.nodes[store.getState().doc.pages[0]];
  if (!opened.file.thumbnailUrl && firstPage?.children?.length) thumbnails.noteEdit();
  return {
    persistence,
    thumbnails,
    stop() {
      offFonts();
      offTools();
      persistence.dispose();
      // Leaving with edits the card does not show yet: one last picture (it finishes on its own).
      if (thumbnails.dirty) void thumbnails.flush();
      thumbnails.dispose();
    },
  };
}
