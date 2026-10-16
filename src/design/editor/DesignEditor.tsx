import '../styles/editor-session.css';
import '../styles/teams.css';
import '../styles/libraries.css';
import {lazy, memo, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import {ApiError} from '../../api';
import type {ReadProgress} from '../../api-read';
import {requestNavigation} from '../../navigation';
import {setSupportPlace} from '../../support/open';
import type {DesignFileOpened} from '../../../shared/design/api';
import {defaultPageBackground} from '../../../shared/design/defaults';
import {rectContains, worldBox} from '../../../shared/design/geometry';
import {pageIdOf} from '../../../shared/design/tree';
import type {NodeId, SceneNode, Vec} from '../../../shared/design/types';
import {createDesignFile, duplicateDesignFile, renameDesignFile, restoreDesignFile, trashDesignFile, uploadDesignImage} from '../api';
import {adoptOpenedShadow, keepCheckpointFresh, openedFromBytes, openForEditing, partialOf, reopenForEditing} from './open-file';
import {memoryWarning} from './memory-budget';
import {startMemoryWatch} from './memory-watch';
import {DESIGN_SECTIONS, type SelectionInfo} from '../panels/design/sections';
import {getCommand, runCommand} from '../engine/commands';
import {createFontRegistry} from '../engine/fonts';
import {sizeLabel} from '../engine/selection';
import {currentViewport, type DesignStore} from '../engine/store';
import {canInspectCode, DESIGN_TEAM_ROLE_LABELS, type DesignTeamRole} from '../../../shared/design/teams';
import {hasTool, onToolsChange, toolsVersion, type SnapHook} from '../engine/tools';
import {connectComponentCommands} from '../engine/commands/components';
import {REACT_EXPORT_DIALOG, registerCodeCommands, VUE_EXPORT_DIALOG} from '../engine/commands/code';
import {bindFileCommandHost, registerFileCommands, savePortable} from '../engine/commands/file';
import {canvasSizeOf} from '../engine/rulers';
import {createSmartGuides, NO_TARGETS, snapPointTo, snapRect, SNAP_THRESHOLD_PX, type SmartSnapContext} from '../engine/snapping';
import {DesignStoreProvider, useDesignStore} from '../engine/useDesignStore';
import {installTextEditing} from '../engine/text-editor';
import {registerTextTool} from '../engine/tools/text';
import {registerTextCommands} from '../engine/commands/text';
import {installVectorEditing} from '../engine/vector-edit/session';
import {VectorEditBar} from '../panels/design/VectorEditBar';
import {ComponentCanvasOverlay} from '../panels/design/components';
import {FramePresets, framePresetsVisible} from '../panels/FramePresets';
import {registerVersionDialogs} from '../versions';
import {Rulers} from './Rulers';
import {EXPORT_DIALOG_ID, registerExportCommands, type ExportScope} from '../engine/commands/export';
import {SelectionHeader} from '../panels/design/SelectionHeader';
import {PageBackgroundSection} from '../panels/design/paint';
import {AssetsPanel, LayersPanel, PagesPanel, registerLeftPanelCommands, VariablesDialog, layerTreeState} from '../panels/left';
import {FIT_PADDING, fitRect, nodesBounds, pageToScreen, visiblePageRect, zoomAround} from '../engine/viewport';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {errorText} from '../ui/error-text';
import {IconFile, IconOffline} from '../ui/icons';
import {EmptyState} from '../ui/ProgressBar';
import {ResizablePanel} from '../ui/ResizablePanel';
import {isMacPlatform, isTypingTarget} from '../ui/shortcuts';
import {Spinner} from '../ui/Spinner';
import {SegmentedControl} from '../ui/Tabs';
import {TextInput} from '../ui/TextInput';
import {Toggle} from '../ui/Toggle';
import {useToast} from '../ui/Toast';
import {setThemePreference, useResolvedTheme, useThemePreference, type ThemePreference} from '../ui/theme';
import {CanvasView, type CanvasController} from './CanvasView';
import {benchMark, exposeForBench} from './bench-hook';
import {LEFT_WIDTH_KEY, RIGHT_WIDTH_KEY} from './chrome/Panels';
import {useDesignSave} from './chrome/save-registration';
import {useSteadySaveState} from './chrome/save-indicator';
import {ModeSwitcher} from './chrome/Toolbar';
import {modeForTool, modeHasTool, modesFor, toolGroupsFor, TOOLS, type EditorMode, type ToolId} from './chrome/tools';
import {bindCommandHost, chromeToolOf, createCommandLookup, EDITOR_MENU, installEditorCommands, pasteAt, resolveCommand} from './command-bridge';
import {publishEditorMenu} from '../../desktop/host';
import {ConflictDialog} from './ConflictDialog';
import {SaveStoppedBanner} from './SaveStoppedBanner';
import {useCanvasContextMenu} from './ContextMenu';
import {loadEngineWasmIfNeeded} from '../engine/engine-wasm';
import {loadTextWasmIfNeeded} from '../engine/text-wasm';
import {loadRenderWasmIfNeeded} from '../engine/render-wasm';
import {loadGeometryWasmIfNeeded} from '../engine/geometry-wasm';
import {loadExportWasmIfNeeded} from '../engine/export-wasm';
import {createEditorSession, firstPageFontSpecs, startSession, waitForFonts, type EditorSession, type SaveRecovered, type SaveStopped, type SessionRuntime} from './editor-session';
import type {AutosaveStatus} from '../persistence/autosave';
import {EditorLayout, type ExternalValue, type LeftTab, type RightTab, type SaveState, type ZoomAction} from './EditorLayout';
import type {Realtime} from '../realtime';
import type {LiveEnd} from '../realtime/live-session';
import type {Meeting} from '../meeting';
import {markReady} from './readiness';
import {getPreferences, setPreferences, subscribePreferences, usePreferences} from './preferences';
import {ActionsButton, ActionsMenu} from './ActionsMenu';
import {EditorServicesContext, getEditorDialog, getEditorPanel, registerEditorDialog, useEditorServices, type EditorDialogProps, type EditorPanelSlot, type EditorServices} from './services';
import {ShortcutsDialog} from './ShortcutsDialog';

// ── Features ─────────────────────────────────────────────────────────────────────────────────────
// A feature plugs in by being imported here: its module registers commands (`registerCommand`, under
// MAIN_MENU ids), tools (`registerTool`, under chrome/tools.ts ids), dialogs (`registerEditorDialog`),
// panels (`registerEditorPanel`), design-panel sections (panels/design/*-sections.ts) and smart guides
// (`registerCanvasSnap`). One import line per feature, below.

// (feature imports)
// "Prototype" tab, canvas connections and ▶ "Present" (the player opens in a new tab).
import '../prototype/register';
// "Find and replace", "Copy/Paste properties", "Paste over selection", "Rasterize selection",
// "Copy link to selection", "Guide", "Contact support" (the bar sits in the overlay).
import {FindReplace} from './FindReplace';
import {followNodeLinks, followVersionLinks} from '../engine/commands/link';
// Comments: "Comment" (C) in the toolbar, pins and threads over the canvas, the "Comments" tab, `?comment=` links (UI lazy).
import {anchorAt} from '../../../shared/design/comments';
import {COMMENT_TOOL, commentToolHost, connectCommentTool, createCommentsController, followCommentLinks, unreadOf, type CommentsController} from '../comments';
// Dev annotations and measurements: "Annotation" (Y), "Measure" (⇧M), "View → Annotations" (⇧Y); their canvas layer is lazy.
import {AnnotationsHost} from '../annotations';
// Shared libraries: "Libraries…", "Publish library…", the updates review, the assets' library sections (lazy chunks).
import {registerLibraries, useLibraryHost} from '../libraries/host';
import {createUploadQueue} from '../engine/upload-queue';

// ─────────────────────────────────────────────────────────────────────────────────────────────────

// Order matters and is fixed: the editor's own commands first (its "Duplicate file" and "Move to trash" flush
// and close autosave), then the file feature's, whose fallbacks only take ids still free.
installEditorCommands();
registerFileCommands();
registerLeftPanelCommands();
// The text tool and commands exist before the first render (the toolbar reads the tool registry
// once); installTextEditing then gives them the open file's fonts and pictures.
registerTextTool();
registerTextCommands();
registerVersionDialogs(registerEditorDialog);
registerEditorDialog('variables', ({onClose}) => <Suspense fallback={null}><VariablesDialog onClose={onClose} /></Suspense>);
// "Export" loads with its first opening (its encoders and preview stay out of the editor's chunk).
/** The tab's picture uploads, a few at a time and again when the server is busy (engine/upload-queue.ts). */
const uploads = createUploadQueue();
const ExportDialog = lazy(() => import('./ExportDialog'));
registerEditorDialog(EXPORT_DIALOG_ID, ({params, onClose}) => (
  <Suspense fallback={null}><ExportDialog scope={params.scope === 'selection' ? 'selection' : 'page'} onClose={onClose} /></Suspense>
));
registerEditorDialog('shortcuts', ShortcutsDialog);
registerEditorDialog('preferences', PreferencesDialog);
registerLibraries();
// The "Code" tab and "Export to React…" / "Export to Vue…" load with their first use, and the code generators with them.
const CodePanel = lazy(() => import('../panels/code/CodePanel').then(module => ({default: module.CodePanel})));
const ReactExportDialog = lazy(() => import('./ReactExportDialog').then(module => ({default: module.ReactExportDialog})));
// The comments' UI loads with the first use of comment mode or the "Comments" tab.
import {TextLinkLayer} from './TextLinkLayer';
const CommentsLayer = lazy(() => import('../comments/ui').then(module => ({default: module.CommentsLayer})));
const CommentsPanel = lazy(() => import('../comments/ui').then(module => ({default: module.CommentsPanel})));
const CommentModePanel = lazy(() => import('../comments/ui').then(module => ({default: module.CommentModePanel})));
// "Share" (src/design/teams/ShareDialog.tsx) loads with its first opening: the editor's first load stays as it was.
const ShareDialog = lazy(() => import('../teams/ShareDialog'));

// The editor of one file: it opens the file, waits briefly for the first page's fonts, then makes one
// session (fonts, pictures, store, renderer) and assembles the chrome around the canvas: the main
// menu and the context menu from the command registry, the toolbar from the tool registry, the
// panels from their registries, autosave in the title, quick actions, dialogs.

type Load = {status: 'loading'} | {status: 'error'; error: unknown} | {status: 'ready'; opened: DesignFileOpened; session: EditorSession; board: BoardModule | null};

// "Board" (docs/board.md): a board opens in its own frame from its own chunk, loaded beside the first page's fonts once the file says
// it is a board. A design file never loads it.
type BoardModule = typeof import('../board/editor');
const loadBoard = () => import('../board/editor');
// Module-level, as every lazy import here: the first import of a chunk with CSS leaves the bundler's
// `<link>` listeners holding the function that asked for it, and one written inside the editor would
// keep that whole editor (its document and history) alive after the file is closed.
const loadRealtime = () => import('../realtime');
const loadMeeting = () => import('../meeting');

/** First paint waits at most this long for the first page's fonts. */
const FONT_WAIT_MS = 1500;
/** Leaving the editor waits at most this long for the last card picture. */
const THUMBNAIL_WAIT_MS = 2500;

// A session outlives a React remount (StrictMode runs effects twice): disposal waits a tick and is
// cancelled when the same session mounts again.
const pendingDispose = new WeakMap<EditorSession, ReturnType<typeof setTimeout>>();

export default function DesignEditor({fileId}: {fileId: string}) {
  const [load, setLoad] = useState<Load>({status: 'loading'});
  const [attempt, setAttempt] = useState(0);
  const [progress, setProgress] = useState<ReadProgress | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setLoad({status: 'loading'});
    setProgress(null);
    // The engines' wasm (only the modules that run as wasm or both, engine-switch.ts) loads while the file downloads: over a
    // slow link the document is the long pole, and the open then waits only for the fonts after it.
    // The Rust engine: the store's shadow needs it. The text engine's own modules (lane L3, src/design/engine/text-wasm.ts),
    // before the fonts settle; the geometry module (lane L1, src/design/engine/geometry-wasm.ts); the renderer's own module
    // (lane L4, src/design/engine/render-wasm.ts): only on WebGPU browsers.
    const textWasm = loadTextWasmIfNeeded();
    const engines = Promise.all([textWasm, loadEngineWasmIfNeeded(), loadGeometryWasmIfNeeded(), loadExportWasmIfNeeded(), loadRenderWasmIfNeeded()]);
    engines.catch(() => {});
    // Progress at most a few times a second (each chunk of a large file would otherwise render the frame again).
    let shown = 0;
    const onProgress = (next: ReadProgress) => {
      const now = performance.now();
      if (now - shown < 250) return;
      shown = now;
      setProgress(next);
    };
    (async () => {
      const opened = await openForEditing(fileId, controller.signal, onProgress);
      benchMark('open:document');
      const boardChunk = opened.file.kind === 'board' ? loadBoard() : null;
      const fonts = createFontRegistry();
      const [board] = await Promise.all([boardChunk, textWasm.then(() => waitForFonts(fonts, firstPageFontSpecs(opened.document), FONT_WAIT_MS)), engines]);
      benchMark('open:engines');
      if (controller.signal.aborted) return;
      // A team's developer or viewer opens the file read-only (docs/design-tool.md §Teams); the server refuses their writes anyway.
      const readOnly = opened.access ? !opened.access.canEdit : false;
      // A board has no rulers, pixel grid or layout grids (and never writes the design editor's view preferences).
      const view = board ? {...getPreferences().view, rulers: false, pixelGrid: false, layoutGrids: false, pixelPreview: false} : getPreferences().view;
      const session = createEditorSession({fileId: opened.file.id, doc: opened.document, fonts, ui: view, readOnly, partial: partialOf(opened)});
      board?.prepareBoard(session.store);
      // Opened from checkpoint bytes: the decoded document becomes the engine's shadow.
      adoptOpenedShadow(opened.document, session.store.getState().doc);
      benchMark('open:session');
      setLoad({status: 'ready', opened, session, board});
    })().catch(error => {
      if (!controller.signal.aborted) setLoad({status: 'error', error});
    });
    return () => controller.abort();
  }, [fileId, attempt]);

  const session = load.status === 'ready' ? load.session : null;
  useEffect(() => {
    if (!session) return;
    clearTimeout(pendingDispose.get(session));
    return () => {
      pendingDispose.set(session, setTimeout(() => session.dispose(), 0));
    };
  }, [session]);

  if (load.status === 'loading') return <EditorFrame><Spinner size={20} className="dz-canvas-spinner" label="Opening file" />{progress && <OpenProgress progress={progress} />}</EditorFrame>;
  if (load.status === 'error') {
    const missing = load.error instanceof ApiError && load.error.status === 404;
    return (
      <EditorFrame>
        <div className="dz-editor-state">
          {missing ? (
            <EmptyState icon={<IconFile />} title="File not found" actions={<Button size={32} variant="primary" onClick={() => requestNavigation({view: 'designs'})}>Back to files</Button>}>
              It may have been deleted, or you may not have access. Ask whoever sent you the link to give you access using Share.
            </EmptyState>
          ) : (
            <EmptyState tone="error" icon={<IconOffline />} title="Could not open file" actions={
              <>
                <Button size={32} onClick={() => requestNavigation({view: 'designs'})}>Back to files</Button>
                <Button size={32} variant="primary" onClick={() => setAttempt(value => value + 1)}>Try again</Button>
              </>
            }>
              {errorText(load.error, 'Check your connection and try again.')}
            </EmptyState>
          )}
        </div>
      </EditorFrame>
    );
  }
  return <OpenedEditor key={load.opened.file.id} opened={load.opened} session={load.session} board={load.board} reopen={() => setAttempt(value => value + 1)} />;
}

const megabytes = (bytes: number) => (bytes / 1e6).toLocaleString('en-US', {maximumFractionDigits: bytes < 1e7 ? 1 : 0});
/** How much of a large file has arrived (a few times a second while it downloads). */
function OpenProgress({progress: {loaded, total}}: {progress: ReadProgress}) {
  return (
    <div className="dz-open-progress" role="status">
      {total ? `Loaded ${megabytes(loaded)} of ${megabytes(total)} MB` : `Loaded ${megabytes(loaded)} MB`}
    </div>
  );
}

/** The chrome's outline while the file loads or fails: the same panel widths, nothing to click. */
function EditorFrame({children}: {children: ReactNode}) {
  return (
    <div className="dz-editor is-loading">
      <ResizablePanel side="left" storageKey={LEFT_WIDTH_KEY} aria-label="Layers and assets">
        <div className="dz-panel-header" />
        <div className="dz-skeleton-rows" aria-hidden="true">{[70, 52, 64, 44].map(width => <span key={width} className="dz-skeleton-bar" style={{width: width + '%'}} />)}</div>
      </ResizablePanel>
      <main className="dz-canvas-area" aria-label="Canvas">{children}</main>
      <ResizablePanel side="right" storageKey={RIGHT_WIDTH_KEY} aria-label="Properties">
        <div className="dz-panel-header" />
      </ResizablePanel>
    </div>
  );
}

// ── The open editor ──────────────────────────────────────────────────────────────────────────────

type OpenDialog = {key: number; id: string; params: Record<string, unknown>};

const READ_ONLY_NOTICE = 'View only: team owners, admins and editors can edit team files.';
const DEV_MODE_NOTICE = "The design can't be edited in Dev Mode, only annotations and measurements.";
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const designUrl = (id: string) => `${location.origin}${location.pathname}${location.search}#design/${encodeURIComponent(id)}`;

/** A callback with a stable identity that runs the latest closure (keeps memoized chrome quiet). */
function useStableCallback<A extends unknown[], R>(callback: (...args: A) => R): (...args: A) => R {
  const latest = useRef(callback);
  useLayoutEffect(() => {
    latest.current = callback;
  });
  const [stable] = useState(() => (...args: A) => latest.current(...args));
  return stable;
}

function OpenedEditor({opened, session, board, reopen}: {opened: DesignFileOpened; session: EditorSession; board: BoardModule | null; reopen: () => void}) {
  const {store, fileId} = session;
  const showToast = useToast();
  const [name, setName] = useState(opened.file.name);
  const [autosaveState, setAutosaveState] = useState<SaveState>('saved');
  // A save that follows a failed request is said at once (the title's "Saving…" otherwise waits, chrome/save-indicator.ts).
  const [retrying, setRetrying] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [conflict, setConflict] = useState<{currentVersion: number | null} | null>(null);
  // "Saving stopped": a refused change could not be put back (SaveStoppedBanner), until the file is reloaded.
  const [saveStopped, setSaveStopped] = useState<string | null>(null);
  const [renameRequest, setRenameRequest] = useState(0);
  const [leftTab, setLeftTab] = useState<LeftTab>('file');
  // The mode at the toolbar's right end: the right panel's tab, or "Draw" (the drawing tools on the bar, "Design" on the right).
  const [rightTab, setRightTab] = useState<RightTab>('design');
  const [drawMode, setDrawMode] = useState(false);
  const mode: EditorMode = drawMode ? 'draw' : rightTab;
  const availableModes = useMemo(() => modesFor(store.readOnly, canInspectCode(opened.access?.role ?? 'owner')), [store, opened.access?.role]);
  const [quickOpen, setQuickOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const onShare = useCallback(() => setSharing(true), []);
  const [dialogs, setDialogs] = useState<OpenDialog[]>([]);
  const controller = useRef<CanvasController | null>(null);
  const runtime = useRef<SessionRuntime | null>(null);
  const pendingRename = useRef<Promise<unknown> | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const lastError = useRef<string | null>(null);

  const toast = useCallback((message: string, kind?: 'success' | 'error') => showToast(message, kind ? {kind} : undefined), [showToast]);
  const reportError = useStableCallback((error: unknown) => toast(errorText(error), 'error'));
  const readOnly = store.readOnly;
  const sayReadOnly = useStableCallback(() => toast(READ_ONLY_NOTICE));
  // An edit the store refused says why, at most once every few seconds (a held key repeats); in "Code" with the way back
  // to "Design" (⇧D).
  const toDesign = useRef<() => void>(() => {});
  useEffect(() => {
    let last = 0;
    return store.onRefused((_label, reason) => {
      const at = Date.now();
      if (at - last < 4000) return;
      last = at;
      if (reason === 'devMode') showToast(DEV_MODE_NOTICE, {action: {label: 'Back to Design', onClick: () => toDesign.current()}});
      else if (reason === 'memory') toast(memoryWarning('full')!, 'error');
      else sayReadOnly();
    });
  }, [store, toast, showToast, sayReadOnly]);

  // ── Saving ──
  const onStatus = useStableCallback((status: AutosaveStatus) => {
    setAutosaveState(status === 'saved' ? 'saved' : status === 'offline' ? 'offline' : status === 'conflict' || status === 'stopped' ? 'unsaved' : 'saving');
    if (status === 'error' || status === 'saved') setRetrying(status === 'error');
    // A refused or failed save retries by itself (or with the next edit); say so once per streak.
    if (status === 'error' && lastError.current !== 'error') toast('Could not save the latest changes. Trying again.', 'error');
    lastError.current = status;
  });
  const onConflict = useStableCallback((currentVersion: number | null) => setConflict({currentVersion}));
  // A copy of what is on screen (.rdesign, pictures inlined): offered whenever a change could not be saved.
  const downloadCopy = useStableCallback(async () => {
    // Big files: the copy holds every page, so the pages the store let go come back first.
    await store.ensureAllPages();
    return savePortable(store.getState().doc, nameRef.current, showToast, opened.file.kind);
  });
  // The server would refuse a change (a pasted or imported value, an AI result...): it was put back, the rest saves.
  const onRecovered = useStableCallback((report: SaveRecovered) =>
    showToast(report.message, {kind: 'error', durationMs: 12_000, action: {label: 'Download a copy', onClick: () => void downloadCopy()}}));
  const onStopped = useStableCallback((report: SaveStopped) => setSaveStopped(report.message));
  // "Reload file": the stored version replaces the editor's, and saving starts again from it.
  const reloadStored = useStableCallback(async () => {
    try {
      const latest = await reopenForEditing(fileId, store);
      runtime.current?.persistence.adopt(latest.document, latest.file.version);
      setName(latest.file.name);
      setConflict(null);
      setSaveStopped(null);
    } catch (error) {
      toast(errorText(error, 'Could not open the saved version. Check your connection and try again.'), 'error');
    }
  });
  useEffect(() => {
    const started = startSession(session, opened, {onStatus, onConflict, onRecovered, onStopped});
    runtime.current = started;
    // Big files: the memory budget (docs/decisions/big-files.md §5) — nothing runs for a whole document.
    const memory = startMemoryWatch(store, {renderer: () => session.renderer(), onLevel: (_level, warning) => warning && toast(warning, 'error')});
    // The warm-open cache follows the saved document (open-file.ts); written before saving stops.
    // (Opened from bytes: the store may hold its own copy of the opened document, so the open's document is asked.)
    const checkpoint = keepCheckpointFresh({fileId, store, persistence: started.persistence, binary: openedFromBytes(opened.document)});
    return () => {
      checkpoint();
      memory.stop();
      started.stop();
      if (runtime.current === started) runtime.current = null;
    };
  }, [session, opened, onStatus, onConflict, onRecovered, onStopped, store, toast]);

  // Co-editing and presence (src/design/realtime, docs/design-tool.md "Collaborative editing"): loaded after the
  // editor shows. Others' changes arrive live, saves merge into newer versions, the avatars and cursors show who is here.
  const [realtime, setRealtime] = useState<Realtime | null>(null);
  const [meeting, setMeeting] = useState<Meeting | null>(null);
  const leaving = useRef(false);
  const onLiveAccess = useStableCallback((access: {role: DesignTeamRole; canEdit: boolean}) => {
    const editing = access.canEdit === store.readOnly;
    // A developer made a viewer (or the reverse) keeps read-only and gains or loses the "Code" tab. A change that leaves both
    // alone (an editor made an admin, a handover) does not reload the file under someone at work.
    const code = canInspectCode(access.role) !== canInspectCode(opened.access?.role ?? 'owner');
    if (!editing && !code) return;
    toast(editing
      ? access.canEdit ? 'You can now edit this file.' : 'You can now only view this file.'
      : `Your team role is now "${DESIGN_TEAM_ROLE_LABELS[access.role]}".`);
    reopen();
  });
  const onLiveEnd = useStableCallback((reason: LiveEnd) => {
    if (leaving.current || reason === 'session') return;
    leaving.current = true;
    toast(reason === 'trashed' ? 'The file was moved to trash.' : reason === 'erased' ? 'The file was deleted.' : 'You no longer have access to this file.', 'error');
    runtime.current?.persistence.close();
    requestNavigation({view: 'designs'});
  });
  useEffect(() => {
    let started: Realtime | null = null,
      cancelled = false;
    void loadRealtime().then(module => {
      const persistence = runtime.current?.persistence;
      if (cancelled || !persistence) return;
      started = module.startRealtime({
        fileId,
        store,
        persistence,
        version: persistence.version(),
        canEdit: !store.readOnly,
        role: opened.access?.role,
        host: () => canvasHost.current,
        canvas: () => controller.current,
        callbacks: {onAccess: onLiveAccess, onEnd: onLiveEnd, onRename: next => setName(next), onStatus: status => markReady(fileId, 'live', status === 'live')},
      });
      setRealtime(started);
    }, () => {
      // The chunk did not load (offline): the editor still saves, without the others' changes.
    });
    return () => {
      cancelled = true;
      started?.stop();
      markReady(fileId, 'live', false);
      setRealtime(null);
    };
  }, [fileId, store, session, opened, onLiveAccess, onLiveEnd]);

  // The editor takes keys once its first commit's effects ran (these, after its children's): `data-design-ready` waits for it and
  // for co-editing and the meeting (readiness.ts); "Saved" shows a frame earlier.
  useEffect(() => markReady(fileId, 'editor'), [fileId]);

  // e2e only (the dev server; `import.meta.env.DEV` is false in a build, which drops this): the spec reaches the
  // store to put in a value no UI path produces any more, and checks that saving survives it.
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const host = window as unknown as {__morfaDesignTest?: {store: DesignStore; live?: Realtime['live']; meeting?: Meeting['controller']}};
    host.__morfaDesignTest = {store, live: realtime?.live, meeting: meeting?.controller};
    return () => {
      if (host.__morfaDesignTest?.store === store) delete host.__morfaDesignTest;
    };
  }, [store, realtime, meeting]);

  // Bench-only (`?bench=1`, scripts/bench): the store for the canvas and edit benches; nothing without the parameter.
  useEffect(() => exposeForBench(store), [store]);

  // The vector editor (double click on a shape, Enter, the pen) speaks through the toasts. CanvasView
  // installs it too: whichever runs first installs, the other only adds or keeps the messages.
  useEffect(() => installVectorEditing(store, {notify: (message, kind) => toast(message, kind)}), [store, toast]);
  // Text: "Text" (T), the text commands and in-canvas editing; editing a text makes it the tool.
  useEffect(() => installTextEditing({store, fonts: session.fonts, images: session.images, toast}), [store, session, toast]);

  useDesignSave(useCallback(async () => {
    await pendingRename.current?.catch(() => undefined);
    const current = runtime.current;
    if (!current) return;
    await current.persistence.flush();
    await Promise.race([current.thumbnails.flush(), delay(THUMBNAIL_WAIT_MS)]);
  }, []));

  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (!runtime.current?.persistence.dirty()) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, []);

  // Quick saves keep "Saved" steady; "Saving…" shows for a slow one or a retry, trouble at once (save-indicator.ts).
  const saveState: SaveState = useSteadySaveState(readOnly ? 'readonly' : autosaveState === 'saved' && renaming ? 'saving' : autosaveState, retrying);

  const rename = useCallback((next: string) => {
    if (readOnly) return;
    const previous = name;
    setName(next);
    setRenaming(true);
    const request = renameDesignFile(fileId, next)
      .then(({file}) => setName(file.name))
      .catch(error => {
        setName(previous);
        toast(errorText(error, 'Could not rename the file.'), 'error');
      })
      .finally(() => setRenaming(false));
    pendingRename.current = request;
  }, [name, fileId, toast, readOnly]);

  useEffect(() => {
    document.title = `${name} — ${board ? board.BOARD_NAMES.product : 'Design'}`;
  }, [name, board]);
  // A message to support written from here names this file and its kind (src/support/open.ts).
  useEffect(() => setSupportPlace({fileId: opened.file.id, where: board ? 'board' : 'editor'}), [opened.file.id, board]);

  // ── Commands ──
  const context = useCallback(() => controller.current?.commandContext() ?? {store, canvasSize: () => ({width: 0, height: 0})}, [store]);
  const lookup = useMemo(() => createCommandLookup(context, reportError), [context, reportError]);
  // The desktop app's native menu bar shows the same menu (src/desktop/menu.ts); in a browser nobody listens.
  useEffect(() => publishEditorMenu({sections: EDITOR_MENU, lookup, clipboard: id => resolveCommand(id)?.clipboardEvent}), [lookup]);

  const selectTool = useCallback((id: ToolId) => {
    if (hasTool(id)) store.setTool(id);
    else toast(`The ${TOOLS[id].label} tool is not available yet.`);
  }, [store, toast]);

  // A mode whose bar has no button for the tool in hand hands back to "Move" (Figma's Dev Mode and Draw do the same).
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const enterMode = useCallback((next: EditorMode) => {
    setDrawMode(next === 'draw');
    setRightTab(next === 'draw' ? 'design' : next);
    const current = chromeToolOf(store.getState().tool);
    if (current && !modeHasTool(next, current, readOnly) && hasTool('move')) store.setTool('move');
  }, [store, readOnly]);
  // The switcher and the commands offer only the person's modes; the right panel's tabs stay as they were (a viewer's "Code" tab
  // says the code is a developer's).
  const changeMode = useCallback((next: EditorMode) => {
    if (availableModes.includes(next)) enterMode(next);
  }, [availableModes, enterMode]);
  const changeRightTab = useCallback((tab: RightTab) => enterMode(tab), [enterMode]);
  toDesign.current = () => enterMode('design');
  // "Code" is Dev Mode on the canvas too (`ui.devMode`): clicks and hover reach the deepest layer, hover measures, nothing moves.
  useEffect(() => {
    store.setUI({devMode: mode === 'code'});
  }, [store, mode]);

  const openDialog = useStableCallback((id: string, params: Record<string, unknown> = {}) => {
    if (!getEditorDialog(id)) {
      toast('This section is not available yet.');
      return;
    }
    setQuickOpen(false);
    setDialogs(list => [...list.filter(dialog => dialog.id !== id), {key: Date.now() + Math.random(), id, params}]);
  });
  const closeDialog = useCallback((key: number) => setDialogs(list => list.filter(dialog => dialog.key !== key)), []);

  const newFile = useStableCallback(async () => {
    // Opened now, inside the click, so the browser lets the tab through; it gets its address once the file exists.
    const tab = window.open('', '_blank');
    try {
      const {file} = await createDesignFile(board ? {kind: 'board'} : undefined);
      if (tab) {
        tab.opener = null;
        tab.location.href = designUrl(file.id);
      } else requestNavigation({kind: 'design', fileId: file.id});
    } catch (error) {
      tab?.close();
      toast(errorText(error), 'error');
    }
  });
  const duplicateFile = useStableCallback(async () => {
    try {
      await runtime.current?.persistence.flush();
      const {file} = await duplicateDesignFile(fileId);
      showToast(`Created a copy of "${file.name}"`, {kind: 'success', action: {label: 'Open', onClick: () => void window.open(designUrl(file.id), '_blank', 'noopener')}});
    } catch (error) {
      toast(errorText(error), 'error');
    }
  });
  const trashFile = useStableCallback(async () => {
    try {
      await runtime.current?.persistence.flush();
      // The live stream's "moved to trash" is this editor's own doing: it says nothing more.
      leaving.current = true;
      await trashDesignFile(fileId).catch(error => {
        leaving.current = false;
        throw error;
      });
      runtime.current?.persistence.close();
      requestNavigation({view: 'designs'});
      showToast(`"${name}" moved to trash`, {action: {label: 'Undo', onClick: () => void restoreDesignFile(fileId).catch(reportError)}});
    } catch (error) {
      reportError(error);
    }
  });

  // Versions, the portable copy (and the file feature's own fallbacks) act on this file while it is open.
  const nameRef = useRef(name);
  nameRef.current = name;
  useEffect(() => bindFileCommandHost({
    fileId,
    fileName: () => nameRef.current,
    openDialog: (id, params) => openDialog(id, params),
    toast: showToast,
    flush: async () => runtime.current?.persistence.flush(),
    kind: opened.file.kind,
  }), [fileId, openDialog, showToast, opened.file.kind]);

  // "Copy as" (text, CSS, SVG, PNG) and "Export to React…" / "Export to Vue…" use this file's fonts and pictures;
  // the export dialog names the project after the file.
  useEffect(() => registerCodeCommands({fonts: session.fonts, images: session.images, toast, openDialog}), [session, toast, openDialog]);
  useEffect(() => {
    const undo = (['react', 'vue'] as const).map(framework => registerEditorDialog(framework === 'vue' ? VUE_EXPORT_DIALOG : REACT_EXPORT_DIALOG, ({params, onClose}) => (
      <Suspense fallback={null}>
        <ReactExportDialog onClose={onClose} fileName={nameRef.current} framework={framework}
          ids={Array.isArray(params.ids) ? params.ids.filter((id): id is NodeId => typeof id === 'string') : []}
          pageId={typeof params.pageId === 'string' ? params.pageId : undefined} />
      </Suspense>
    )));
    return () => undo.forEach(fn => fn());
  }, []);

  useEffect(() => bindCommandHost({
    renameFile: () => {
      if (readOnly) {
        sayReadOnly();
        return;
      }
      store.setUI({showUI: true});
      setRenameRequest(value => value + 1);
    },
    newFile: () => void newFile(),
    duplicateFile: () => void duplicateFile(),
    trashFile: () => void trashFile(),
    showLeftTab: tab => {
      store.setUI({showUI: true, minimizeUI: false});
      setLeftTab(tab);
    },
    toggleQuickActions: () => setQuickOpen(open => !open),
    openDialog: id => openDialog(id),
    selectTool,
    mode: () => modeRef.current,
    modes: () => availableModes,
    setMode: changeMode,
  }), [store, newFile, duplicateFile, trashFile, openDialog, selectTool, readOnly, sayReadOnly, changeMode, availableModes]);

  // ── Tools ──
  const engineTool = useDesignStore(state => state.tool, Object.is, {store, slice: 'tool'});
  const tool = chromeToolOf(engineTool);
  // A key (R in "Code", F in "Draw", a Draw tool's key in "Design") or a text being edited picked a tool this mode's bar has no
  // button for: to the mode whose bar has it, so the bar always shows what is in hand.
  useEffect(() => {
    if (!tool) return;
    const next = modeForTool(mode, tool, readOnly, availableModes);
    if (next === mode) return;
    setDrawMode(next === 'draw');
    setRightTab(next === 'draw' ? 'design' : next);
  }, [tool, mode, readOnly, availableModes]);
  // Tools register when their module loads: the bar shows one as soon as it is there.
  const toolsRegistered = useSyncExternalStore(onToolsChange, toolsVersion, toolsVersion);
  const isToolAvailable = useMemo(() => (id: ToolId) => toolsRegistered >= 0 && hasTool(id), [toolsRegistered]);
  const toolGroups = useMemo(() => toolGroupsFor(mode, readOnly), [mode, readOnly]);

  // ── Comments (src/design/comments) ──
  // One controller per open file: it polls the file's comments (the feed is the hook for a real-time channel) from the first render, so
  // the tab's unread count and `?comment=` links work before comment mode is used.
  const teamId = opened.access?.team?.id ?? null;
  const [comments, setComments] = useState<CommentsController | null>(null);
  useEffect(() => {
    const created = createCommentsController({fileId, teamId});
    setComments(created);
    return () => created.dispose();
  }, [fileId, teamId]);
  const unreadComments = useSyncExternalStore(
    useCallback((listener: () => void) => comments?.subscribe(listener) ?? (() => {}), [comments]),
    () => (comments ? unreadOf(comments.getState()) : 0),
  );
  useEffect(() => (comments ? followCommentLinks({controller: comments, store, toast: message => toast(message, 'error')}) : undefined), [comments, store, toast]);
  useEffect(() => (comments ? connectCommentTool(store, commentToolHost(comments)) : undefined), [comments, store]);
  // Comment mode shows the threads on the left (the tab comes back to where it was after) and hides the design tools on the right.
  const commentMode = engineTool === COMMENT_TOOL;
  const tabBeforeComments = useRef<LeftTab | null>(null);
  const wasCommenting = useRef(false);
  useEffect(() => {
    if (commentMode) {
      wasCommenting.current = true;
      setLeftTab(current => {
        if (current !== 'comments') tabBeforeComments.current = current;
        return 'comments';
      });
      return;
    }
    // Pins stay on the canvas after comment mode: an open card or a pin being placed goes with the mode.
    if (wasCommenting.current) comments?.setUI({openId: null, draft: null});
    wasCommenting.current = false;
    const previous = tabBeforeComments.current;
    tabBeforeComments.current = null;
    if (previous) setLeftTab(current => (current === 'comments' ? previous : current));
  }, [commentMode, comments]);

  // Escape in a drawing tool goes back to "Move" (when nothing else used the key).
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || isTypingTarget(event.target) || quickOpen || dialogs.length || conflict) return;
      const state = store.getState();
      if (state.tool !== 'move' && !state.live.size && hasTool('move')) store.setTool('move');
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [store, quickOpen, dialogs.length, conflict]);

  // ── View ──
  const showUI = useDesignStore(state => state.ui.showUI, Object.is, {store, slice: 'ui'});
  const setUiHidden = useCallback((hidden: boolean) => store.setUI({showUI: !hidden}), [store]);
  const minimizeUI = useDesignStore(state => state.ui.minimizeUI, Object.is, {store, slice: 'ui'});
  const setUiMinimized = useCallback((minimized: boolean) => store.setUI({minimizeUI: minimized, showUI: true}), [store]);
  const zoom = useMemo<ExternalValue<number>>(() => ({
    get: () => currentViewport(store.getState()).zoom,
    subscribe: listener => store.subscribe(listener, {slice: ['viewport', 'page']}),
  }), [store]);
  const onZoom = useCallback((action: ZoomAction) => {
    const ctx = context();
    if (action.type === 'set') {
      const size = ctx.canvasSize();
      if (size.width && size.height) store.setViewport(zoomAround(currentViewport(store.getState()), {x: size.width / 2, y: size.height / 2}, action.zoom));
      return;
    }
    runCommand({in: 'zoom-in', out: 'zoom-out', fit: 'zoom-fit', selection: 'zoom-selection'}[action.type], ctx);
  }, [store, context]);

  // The view toggles a designer sets survive a reload (preferences.ts).
  useEffect(() => (board ? undefined : store.select(state => state.ui, next => {
    const {pixelGrid, snapToPixel, layoutGrids, rulers, pixelPreview, minimizeUI: minimized, multiplayerCursors} = next;
    setPreferences({view: {pixelGrid, snapToPixel, layoutGrids, rulers, pixelPreview, minimizeUI: minimized, multiplayerCursors}});
  }, {slice: 'ui'})), [store, board]);

  const revealNodes = useStableCallback((ids: readonly NodeId[]) => {
    const {doc, pageId} = store.getState();
    const present = ids.filter(id => doc.nodes[id] && doc.nodes[id].type !== 'PAGE');
    if (!present.length) return;
    const page = pageIdOf(doc, present[0]);
    if (page && page !== pageId) store.setPage(page);
    const view = controller.current?.view;
    const bounds = nodesBounds(doc, present.filter(id => pageIdOf(doc, id) === page));
    if (!view || !bounds) return;
    const size = view.size();
    if (!size.width || !size.height) return;
    const viewport = currentViewport(store.getState());
    if (rectContains(visiblePageRect(viewport, size), bounds)) return;
    // Panning is enough when they fit at this zoom; otherwise zoom out just enough.
    store.setViewport(fitRect(size, bounds, FIT_PADDING, viewport.zoom));
  });

  // "Meeting" (src/design/meeting, docs/board-meeting.md): the shared timer, votes, emotes, cursor chat ("/") and "Get attention".
  // It rides on the co-editing stream, so it loads once that runs, in a chunk of its own (its state is declared beside `realtime`).
  // A board mounts the same module through its own meeting slot (src/design/meeting/board.tsx), never this one.
  useEffect(() => {
    const live = realtime?.live;
    if (!live || board) return;
    let started: Meeting | null = null,
      cancelled = false;
    void loadMeeting().then(module => {
      if (cancelled) return;
      started = module.startMeeting({fileId, live, store, host: () => canvasHost.current, canvas: () => controller.current, toast, reveal: ids => revealNodes(ids)});
      setMeeting(started);
    }, () => {
      // The chunk did not load (offline): the file works without it.
    });
    return () => {
      cancelled = true;
      started?.stop();
      setMeeting(null);
    };
  }, [realtime, fileId, store, toast, revealNodes, board]);

  // A link to a layer (`#design/<file>?node=<id>`, "Copy link to selection") selects and shows it.
  useEffect(() => followNodeLinks({store, fileId, reveal: id => revealNodes([id]), toast: message => toast(message, 'error')}), [store, fileId, revealNodes, toast]);
  // A link to a version (`#design/<file>?version=<id>`, "Copy link to version") opens the history showing it.
  useEffect(() => followVersionLinks({fileId, open: version => openDialog('versions', {version})}), [fileId, openDialog]);

  // Component commands (create, variants, instances) speak through the toasts and reveal what they make.
  useEffect(() => connectComponentCommands(store, {toast: (message, kind) => toast(message, kind === 'info' ? undefined : kind), revealNodes: ids => revealNodes(ids)}), [store, toast, revealNodes]);

  // ── Canvas ──
  // Smart guides (snapping.ts) while "Snap to objects" is on; off, positions still land on whole
  // pixels when "Snap to pixel grid" is.
  const snap = useMemo<SnapHook>(() => {
    const guides = createSmartGuides({store, index: session.spatialIndex, canvasSize: () => controller.current?.view.size() ?? canvasSizeOf(store) ?? {width: innerWidth, height: innerHeight}});
    const plain = (zoom: number) => ({threshold: SNAP_THRESHOLD_PX / zoom, zoom, pixel: store.getState().ui.snapToPixel});
    return {
      snapMove: (rect, ctx) => (getPreferences().snapToObjects ? guides.snapMove(rect, ctx) : snapRect(rect, NO_TARGETS, plain(ctx.zoom))),
      snapPoint: (point, ctx) => (getPreferences().snapToObjects && guides.snapPoint ? guides.snapPoint(point, ctx) : snapPointTo(point, NO_TARGETS, {...plain(ctx.zoom), axes: (ctx as SmartSnapContext).axes})),
      end: () => guides.end?.(),
    };
  }, [store, session]);

  const canvasSize = useCallback(() => controller.current?.view.size() ?? {width: 0, height: 0}, []);
  const pageAt = useCallback((clientX: number, clientY: number): Vec | null => {
    const host = canvasHost.current, view = controller.current?.view;
    if (!host || !view) return null;
    const rect = host.getBoundingClientRect();
    return view.screenToPage({x: clientX - rect.left, y: clientY - rect.top});
  }, []);
  const pasteHere = useCallback((point: Vec) => void pasteAt(context(), point).then(created => {
    if (!created) toast('Nothing to paste: copy some layers first.');
  }, reportError), [context, reportError, toast]);
  const renameLayer = useCallback((id: NodeId) => {
    store.setUI({showUI: true, minimizeUI: false});
    setLeftTab('file');
    layerTreeState(store).requestRename(id);
  }, [store]);
  // On a phone a long press on the empty canvas offers a comment first (src/design/editor/phone, Figma's app).
  const commentAt = useMemo(() => (comments ? (point: Vec) => {
    const {doc, pageId} = store.getState();
    store.setTool(COMMENT_TOOL);
    commentToolHost(comments).place(anchorAt(doc, pageId, point));
  } : undefined), [comments, store]);
  const menu = useCanvasContextMenu({session, lookup, pageAt, zoom: () => currentViewport(store.getState()).zoom, pasteHere, context, rename: renameLayer, commentAt});
  const openMenu = useStableCallback((event: {clientX: number; clientY: number}) => menu.open(event));
  const onReady = useCallback((next: CanvasController) => {
    controller.current = next;
  }, []);

  const active = !quickOpen && !dialogs.length && !conflict;
  // A page without its own colour shows the theme's canvas (#F5F5F5 light, #1E1E1E dark), as in Figma.
  const theme = useResolvedTheme();
  // A board's canvas stays light in both themes (its notes and ink are drawn for paper, as FigJam's); its chrome follows the theme.
  const background = useMemo(() => defaultPageBackground(board ? 'light' : theme), [theme, board]);
  const canvas = useMemo(() => (
    <div ref={canvasHost} className="dz-canvas-host">
      <CanvasView store={store} createRenderer={session.createRenderer} spatialIndex={session.spatialIndex} snap={snap} active={active}
        onReady={onReady} onContextMenu={openMenu} background={background} dotGrid={!!board} hiddenSections={!!board} />
      {!board && <HoverSize store={store} />}
    </div>
  ), [store, session, snap, active, onReady, openMenu, background, board]);

  // ── Panels ──
  // The left panel (panels/left): pages, the layers tree (its row menu runs in the canvas's command
  // context) and assets. Stable elements, so canvas work never re-renders them through the layout.
  const pages = useMemo(() => <PagesPanel />, []);
  const layers = useMemo(() => <LayersPanel commandContext={context} />, [context]);
  const assets = useMemo(() => <AssetsPanel />, []);
  // Read-only: the panels show the values, their controls disabled (the store refuses edits anyway). The "Code" tab is a developer's and
  // an editor's; a viewer looks and exports.
  const designPanel = useMemo(() => (readOnly ? <ReadOnlyPanel><DesignPanel store={store} /></ReadOnlyPanel> : <DesignPanel store={store} />), [store, readOnly]);
  const prototypePanel = useMemo(() => {
    const panel = <Slot slot="prototype" fallback={<PanelNote>Prototyping is not available yet.</PanelNote>} />;
    return readOnly ? <ReadOnlyPanel>{panel}</ReadOnlyPanel> : panel;
  }, [readOnly]);
  const role = opened.access?.role ?? 'owner';
  const codePanel = useMemo(() => (canInspectCode(role)
    ? <Suspense fallback={null}><CodePanel /></Suspense>
    : <PanelNote>Code is available to developers and team editors. To export images, use Export.</PanelNote>), [role]);
  // The people in the file (their avatars, a click follows) beside ▶ and "Export".
  const rightHeader = useMemo(() => (
    <>
      {realtime && <realtime.Avatars />}
      {meeting && <meeting.Header />}
    </>
  ), [realtime, meeting]);
  // Over the canvas: rulers, guides, ⌥ measurements (in "Code" on hover, with auto layout's spacing) and picture drops (Rulers
  // also connects uploads for the image tool and paste), the components' canvas marks, and the vector editor's bar (only while
  // editing).
  const overlay = useMemo(() => (
    <>
      <Rulers store={store} />
      <ComponentCanvasOverlay />
      <VectorEditBar store={store} />
      <FindReplace />
      <AnnotationsHost store={store} readOnly={readOnly} />
      {!readOnly && <TextLinkLayer store={store} canvasSize={canvasSize} />}
      {realtime && <realtime.CanvasLayer />}
      {meeting && <meeting.CanvasLayer />}
      {/* Pins show in every mode, as Figma's; ⇧C hides them outside comment mode (the layer reads it). */}
      {comments && (
        <Suspense fallback={null}>
          <CommentsLayer controller={comments} store={store} toast={toast} canvasSize={canvasSize} />
        </Suspense>
      )}
      {saveStopped !== null && <SaveStoppedBanner message={saveStopped} onDownload={downloadCopy} onReload={reloadStored} />}
    </>
  ), [store, readOnly, saveStopped, downloadCopy, reloadStored, realtime, meeting, commentMode, comments, toast, canvasSize]);
  const commentsPanel = useMemo(() => (comments ? <Suspense fallback={null}><CommentsPanel controller={comments} store={store} /></Suspense> : undefined), [comments, store]);
  const commentModePanel = useMemo(() => (commentMode && comments ? <Suspense fallback={null}><CommentModePanel controller={comments} readOnly={readOnly} /></Suspense> : undefined), [commentMode, comments, readOnly]);

  const playCommand = getCommand('prototype.play');
  // "Export…" (⇧⌘E) and "Export selection…" open this editor's dialog while it is open.
  useEffect(() => registerExportCommands((scope: ExportScope) => openDialog(EXPORT_DIALOG_ID, {scope})), [openDialog]);
  const onExport = useCallback(() => openDialog(EXPORT_DIALOG_ID, {scope: 'page'}), [openDialog]);
  const onPlay = useMemo(() => (playCommand ? () => lookup('prototype.play')?.run() : undefined), [playCommand, lookup]);

  const backToFiles = useCallback(() => requestNavigation({view: 'designs'}), []);
  const onToolChange = useCallback((id: ToolId) => selectTool(id), [selectTool]);

  // ── Services ──
  const services = useMemo<EditorServices>(() => ({
    fileId,
    store,
    fonts: session.fonts,
    images: session.images,
    renderer: session.renderer,
    async uploadImage(image, imageName) {
      const {ref, asset} = await uploads(() => uploadDesignImage(fileId, image, imageName));
      // The picture's record is not a step of its own: undo takes away the layer or fill that uses it.
      store.transact('Image', tx => tx.setImage(ref, asset), {history: false});
      return {ref, asset};
    },
    toast,
    revealNodes,
    openDialog,
    readOnly,
    canvas: () => controller.current,
    persistence: {
      version: () => runtime.current?.persistence.version() ?? opened.file.version,
      flush: async () => runtime.current?.persistence.flush(),
      adopt: (doc, version) => runtime.current?.persistence.adopt(doc, version),
    },
  }), [fileId, store, session, toast, revealNodes, openDialog, opened.file.version, readOnly]);
  // After the tools: "Actions" (⌘K); at the right end the modes (a read-only file is not drawn on).
  const toggleActions = useCallback(() => setQuickOpen(open => !open), []);
  const closeActions = useCallback(() => setQuickOpen(false), []);
  const toolbarEnd = useMemo(() => <ActionsButton open={quickOpen} onToggle={toggleActions} />, [quickOpen, toggleActions]);
  const toolbarModes = useMemo(() => <ModeSwitcher mode={mode} onModeChange={changeMode} modes={availableModes} />, [mode, changeMode, availableModes]);
  // The libraries of the file's place (docs/design-tool.md §Teams): its session, "Library updates available" on open.
  useLibraryHost(services, {canEdit: !readOnly, teamName: opened.access?.team?.name ?? null, showToast});

  const reloadLatest = useCallback(async () => {
    const latest = await reopenForEditing(fileId, store);
    runtime.current?.persistence.adopt(latest.document, latest.file.version);
    setName(latest.file.name);
    setConflict(null);
    setSaveStopped(null);
  }, [fileId, store]);
  const keepMine = useCallback(async () => {
    await runtime.current?.persistence.keepMine(conflict?.currentVersion ?? null);
    setConflict(null);
  }, [conflict]);

  const spatialIndex = useCallback(() => {
    const state = store.getState();
    return session.spatialIndex(state.doc, state.pageId);
  }, [store, session]);
  const hostOf = useCallback(() => canvasHost.current, []);

  return (
    <EditorServicesContext.Provider value={services}>
      <DesignStoreProvider store={store}>
      {board ? (
        <board.BoardLayout store={store} services={services} fileName={name} onRename={rename} saveState={saveState} renameRequest={renameRequest}
          onBackToFiles={backToFiles} commands={lookup} menu={board.BOARD_MENU} context={context} zoom={zoom} onZoom={onZoom} canvas={canvas} overlay={overlay}
          host={hostOf} index={spatialIndex} realtime={realtime} comments={comments} commentsPanel={commentsPanel} unreadComments={unreadComments} teamId={teamId}
          uiHidden={!showUI} onUiHiddenChange={setUiHidden} readOnly={readOnly} onShare={onShare}
          toast={toast} active={active} onActions={toggleActions} />
      ) : (
      <EditorLayout fileName={name} onRename={rename} saveState={saveState} renameRequest={renameRequest} onBackToFiles={backToFiles}
        commands={lookup} menu={EDITOR_MENU} tool={tool} onToolChange={onToolChange} isToolAvailable={isToolAvailable} zoom={zoom} onZoom={onZoom}
        onPlay={onPlay} onExport={onExport} onShare={onShare} rightHeader={rightHeader} toolbarEnd={toolbarEnd} toolbarModes={toolbarModes}
        toolGroups={toolGroups} rightTab={rightTab} onRightTabChange={changeRightTab}
        uiHidden={!showUI} onUiHiddenChange={setUiHidden} uiMinimized={minimizeUI} onUiMinimizedChange={setUiMinimized} leftTab={leftTab} onLeftTabChange={setLeftTab}
        canvas={canvas} overlay={overlay} pages={pages} layers={layers} assets={assets} designPanel={designPanel} prototypePanel={prototypePanel} codePanel={codePanel}
        comments={commentsPanel} commentsBadge={unreadComments} rightOverride={commentModePanel} />
      )}
      {menu.element}
      {quickOpen && <ActionsMenu context={context} onClose={closeActions} onError={reportError} listed={board?.isBoardAction} />}
      {dialogs.map(dialog => {
        const Component = getEditorDialog(dialog.id);
        return Component ? <Component key={dialog.key} params={dialog.params} onClose={() => closeDialog(dialog.key)} /> : null;
      })}
      {conflict && <ConflictDialog onReload={reloadLatest} onKeepMine={keepMine} />}
      {sharing && (
        <Suspense fallback={null}>
          <ShareDialog fileId={fileId} fileName={name} kind={board ? 'board' : 'design'} access={opened.access ?? null} link={designUrl(fileId)}
            onClose={() => setSharing(false)} />
        </Suspense>
      )}
      </DesignStoreProvider>
    </EditorServicesContext.Provider>
  );
}

// ── Slots and their fallbacks ────────────────────────────────────────────────────────────────────

/** A panel a feature registered for the slot, or the editor's own minimal one. */
function Slot({slot, fallback}: {slot: EditorPanelSlot; fallback: ReactNode}) {
  const Component = getEditorPanel(slot);
  return Component ? <Component /> : <>{fallback}</>;
}

function PanelNote({children}: {children: ReactNode}) {
  return <p className="dz-panel-note dz-slot-note">{children}</p>;
}

/** A panel of a read-only file: every control inside is disabled by the fieldset, values stay readable. */
function ReadOnlyPanel({children}: {children: ReactNode}) {
  return <fieldset disabled className="dz-readonly-fieldset dz-readonly-panel" aria-label="View only">{children}</fieldset>;
}

// ── "Design" ─────────────────────────────────────────────────────────────────────────────────────

const sameNodes = (a: readonly SceneNode[], b: readonly SceneNode[]) => a.length === b.length && a.every((node, i) => node === b[i]);

/** The "Design" tab: the registered sections that apply to the selection, in their order; with nothing
 *  selected, "Page" first. Reads only the selection and the selected nodes, so panning never
 *  re-renders it. */
const DesignPanel = memo(function DesignPanel({store}: {store: DesignStore}) {
  // With "Frame" (F) chosen the tab offers device and format sizes instead, as in Figma.
  const presets = useDesignStore(framePresetsVisible, Object.is, {store, slice: 'tool'});
  if (presets) return <FramePresets store={store} />;
  return <DesignSections store={store} />;
});

const DesignSections = memo(function DesignSections({store}: {store: DesignStore}) {
  const ids = useDesignStore(state => state.selection, Object.is, {store, slice: 'selection'});
  const nodes = useDesignStore(state => state.selection.map(id => state.doc.nodes[id]).filter((node): node is SceneNode => !!node), sameNodes, {store, slice: ['doc', 'selection']});
  // With nothing selected the file-wide sections ("Color styles", …) depend on the styles table.
  const styles = useDesignStore(state => (state.selection.length ? null : state.doc.styles), Object.is, {store, slice: ['doc', 'selection']});
  // Which sections apply changes with the selection only: dragging or panning what is not selected
  // re-renders nothing here (`nodes` keeps its identity), and the sections read the store themselves.
  const sections = useMemo(() => {
    const info: SelectionInfo = {doc: store.getState().doc, ids, nodes};
    return DESIGN_SECTIONS.filter(section => {
      try {
        return section.applies(info);
      } catch {
        return false;
      }
    });
  }, [store, ids, nodes, styles]);
  return (
    <div className="dz-design-panel">
      <SelectionHeader />
      {!ids.length && <PageBackgroundSection first />}
      {sections.map(section => <section.Component key={section.id} ids={ids} nodes={nodes} />)}
    </div>
  );
});

// ── Canvas extras ────────────────────────────────────────────────────────────────────────────────

/** "Show sizes on hover": the hovered layer's size under it, written straight to the DOM on store
 *  changes (no React render per hover or pan). */
const HoverSize = memo(function HoverSize({store}: {store: DesignStore}) {
  const badge = useRef<HTMLDivElement>(null);
  const enabled = usePreferences().hoverSizes;
  useEffect(() => {
    const element = badge.current;
    if (!element || !enabled) return;
    let frame = 0;
    const draw = () => {
      frame = 0;
      const state = store.getState();
      const id = state.hoverId;
      const node = id ? state.doc.nodes[id] : undefined;
      if (!node || !id || state.selection.includes(id) || state.live.size || node.type === 'PAGE') {
        element.hidden = true;
        return;
      }
      const box = worldBox(state.doc, id);
      const at = pageToScreen(currentViewport(state), {x: box.x + box.width / 2, y: box.y + box.height});
      element.textContent = sizeLabel(node.width, node.height);
      element.style.transform = `translate(${Math.round(at.x)}px, ${Math.round(at.y + 6)}px) translateX(-50%)`;
      element.hidden = false;
    };
    const request = () => {
      if (!frame) frame = requestAnimationFrame(draw);
    };
    draw();
    const off = store.subscribe(request, {slice: ['hover', 'viewport', 'doc', 'selection', 'live', 'page']});
    return () => {
      off();
      cancelAnimationFrame(frame);
      element.hidden = true;
    };
  }, [store, enabled]);
  return <div ref={badge} className="dz-hover-size" hidden aria-hidden="true" />;
});

// ── "Preferences" ──────────────────────────────────────────────────────────────────────────────────

const THEME_OPTIONS = [{value: 'system', label: 'System'}, {value: 'light', label: 'Light'}, {value: 'dark', label: 'Dark'}] as const;

function stepValue(text: string): number | null {
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && value > 0 && value <= 1000 ? Math.round(value * 100) / 100 : null;
}

/** The designer's preferences: theme, nudge steps, snapping, sizes on hover. Changes apply at once. */
function PreferencesDialog({onClose}: EditorDialogProps) {
  const preferences = usePreferences();
  const theme = useThemePreference();
  const {store} = useEditorServices();
  const snapToPixel = useDesignStore(state => state.ui.snapToPixel, Object.is, {store, slice: 'ui'});
  const [small, setSmall] = useState(String(preferences.nudgeSmall));
  const [large, setLarge] = useState(String(preferences.nudgeLarge));
  useEffect(() => subscribePreferences(() => {
    setSmall(String(getPreferences().nudgeSmall));
    setLarge(String(getPreferences().nudgeLarge));
  }), []);
  const commitStep = (key: 'nudgeSmall' | 'nudgeLarge', text: string) => {
    const value = stepValue(text);
    if (value === null) {
      (key === 'nudgeSmall' ? setSmall : setLarge)(String(getPreferences()[key]));
      return;
    }
    setPreferences({[key]: value});
  };
  return (
    <Dialog title="Preferences" onClose={onClose} width={400} className="dz-preferences" footer={<Button size={32} variant="primary" onClick={onClose}>Done</Button>}>
      <div className="dz-pref-rows">
        <div className="dz-pref-row">
          <span id="dz-pref-theme">Theme</span>
          <SegmentedControl options={THEME_OPTIONS} value={theme} onChange={(value: ThemePreference) => setThemePreference(value)} aria-label="Theme" />
        </div>
        <div className="dz-pref-row">
          <span>Nudge step</span>
          <TextInput value={small} onChange={setSmall} onCommit={value => commitStep('nudgeSmall', value)} end="px" inputMode="decimal" aria-label="Nudge step, px" className="dz-pref-number" />
        </div>
        <div className="dz-pref-row">
          <span>Large step (with {isMacPlatform() ? '⇧' : 'Shift'})</span>
          <TextInput value={large} onChange={setLarge} onCommit={value => commitStep('nudgeLarge', value)} end="px" inputMode="decimal" aria-label="Large nudge step, px" className="dz-pref-number" />
        </div>
        <Toggle checked={preferences.snapToObjects} onChange={value => setPreferences({snapToObjects: value})}>Snap to objects</Toggle>
        <Toggle checked={snapToPixel} onChange={value => store.setUI({snapToPixel: value})}>Snap to pixel grid</Toggle>
        <Toggle checked={preferences.hoverSizes} onChange={value => setPreferences({hoverSizes: value})}>Show sizes on hover</Toggle>
      </div>
    </Dialog>
  );
}
