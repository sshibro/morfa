import {lazy, memo, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import type {NodeId} from '../../../../shared/design/types';
import {boardObjectOf} from '../../../../shared/design/board/model';
import type {SpatialIndex} from '../../../../shared/design/tree';
import {runCommand, type CommandContext} from '../../engine/commands';
import {pickFile} from '../../engine/commands/file';
import {setLinkCardFile} from '../link-card';
import {setTemplatePlace} from '../team-templates';
import {isTypingTarget} from '../../engine/keyboard';
import {matchesShortcut} from '../../ui/shortcuts';
import type {DesignStore} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import type {CommandLookup, MainMenuSection} from '../../editor/chrome/commands';
import type {ExternalValue} from '../../editor/chrome/external';
import type {SaveState} from '../../editor/chrome/FileTitle';
import type {EditorServices} from '../../editor/services';
import type {Realtime} from '../../realtime';
import type {CommentsController} from '../../comments';
import {ContextToolbar} from '../chrome/ContextToolbar';
import {BoardDecor} from './Decor';
import {BadgeLayer} from './BadgeLayer';
import {useBoardKeys} from './useBoardKeys';
import {useBoardDialogs} from './dialogs';
import {PhoneBoard} from '../phone/PhoneBoard';
import {TopLeftPill, TopRightPill, ZoomPill, type ZoomAction} from '../chrome/Pills';
import {BoardToolbar} from '../chrome/Toolbar';
import {StampWheel} from '../chrome/StampWheel';
import {Recenter} from '../chrome/Recenter';
import {boardColors} from '../colors';
import type {PlusSheetTab} from './PlusSheet';
import {WHEEL_REACH, wheelCentre} from '../chrome/wheel';
import {installBoardCommands} from '../commands';
import {loadBoardFeatures} from '../features';
import {boardMeeting, subscribeBoardMeeting, type BoardMeetingProps} from '../meeting';
import {createBoardObjects} from '../objects';
import {boardChoices, setBoardChoices, type BoardChoices} from '../state';
import {BOARD_READ_ONLY_TOOLS, type BoardToolId} from '../tools';
import {setBoardIdentity} from '../tools/place';
import {BdClose} from '../chrome/icons';

// "Board" (docs/board.md §Look): the board editor's frame. No panels: the canvas fills the window and FigJam's floating chrome sits
// on it (the pills top left and right, zoom and help bottom right, the big toolbar at the bottom with its trays and the "+" sheet,
// the context toolbar over the selection, the comments sidebar on the right in comment mode). DesignEditor keeps the file's
// session (saving, co-editing, comments, versions, export) and passes this frame the canvas and what goes over it.

const PlusSheet = lazy(() => import('./PlusSheet').then(module => ({default: module.PlusSheet})));

export type BoardLayoutProps = {
  store: DesignStore;
  services: EditorServices;
  fileName: string;
  onRename: (name: string) => void;
  saveState: SaveState;
  renameRequest: number;
  onBackToFiles: () => void;
  commands: CommandLookup;
  menu: readonly MainMenuSection[];
  context: () => CommandContext;
  zoom: ExternalValue<number>;
  onZoom: (action: ZoomAction) => void;
  /** The canvas host (`.dz-canvas-host`) and what DesignEditor draws over it (co-editing cursors, comment pins, banners). */
  canvas: ReactNode;
  overlay: ReactNode;
  host: () => HTMLElement | null;
  index: () => SpatialIndex | null;
  realtime: Realtime | null;
  comments: CommentsController | null;
  /** The comments list (search, filter, threads): the sidebar in comment mode. */
  commentsPanel?: ReactNode;
  unreadComments: number;
  /** The team the board belongs to (null: a personal board): its custom templates (team-templates.ts). */
  teamId?: string | null;
  uiHidden: boolean;
  onUiHiddenChange: (hidden: boolean) => void;
  readOnly: boolean;
  /** "Share": who can open the board, and inviting people (src/design/teams/ShareDialog.tsx). */
  onShare: () => void;
  toast: (message: string, kind?: 'success' | 'error') => void;
  /** No dialog or quick actions over the board: its keys are live. */
  active: boolean;
  /** "Actions" (⌘K): the editor's quick actions. */
  onActions: () => void;
};

export const BoardLayout = memo(function BoardLayout(props: BoardLayoutProps) {
  const {store, services, readOnly, context, host, index, comments} = props;
  const engineTool = useDesignStore(state => state.tool, Object.is, {store, slice: 'tool'});
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusTab, setPlusTab] = useState<PlusSheetTab>('all');
  // "Stamp wheel" (E): where it opened in the canvas area's px, or null.
  const [wheel, setWheel] = useState<{x: number; y: number} | null>(null);
  const area = useRef<HTMLElement>(null);
  const pointer = useRef<{x: number; y: number} | null>(null);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const move = (event: PointerEvent) => {
      const box = element.getBoundingClientRect();
      pointer.current = {x: event.clientX - box.left, y: event.clientY - box.top};
    };
    const leave = () => void (pointer.current = null);
    element.addEventListener('pointermove', move);
    element.addEventListener('pointerleave', leave);
    return () => {
      element.removeEventListener('pointermove', move);
      element.removeEventListener('pointerleave', leave);
    };
  }, []);
  const openWheelAt = useCallback((at: {x: number; y: number} | null) => {
    const element = area.current;
    if (!element) return;
    const box = {width: element.clientWidth, height: element.clientHeight};
    setWheel(wheelCentre(at ?? {x: box.width / 2, y: box.height / 2}, box));
  }, []);
  const openWheel = useCallback(() => openWheelAt(pointer.current), [openWheelAt]);
  /** Above the toolbar's "Stamp", in the canvas area's px. */
  const stampButtonCentre = useCallback(() => {
    const element = area.current, button = element?.querySelector('.bd-toolbar [aria-label="Stamp"]');
    if (!element || !button) return null;
    const box = element.getBoundingClientRect(), rect = button.getBoundingClientRect();
    return {x: rect.left + rect.width / 2 - box.left, y: rect.top - box.top - WHEEL_REACH};
  }, []);
  const closeWheel = useCallback(() => setWheel(null), []);
  // Escape or a press elsewhere leaves the stamp tool with its wheel (FigJam); "+" in the middle opens the sheet on "Emoji".
  const exitWheel = useCallback(() => {
    setWheel(null);
    store.setTool('move');
  }, [store]);
  const moreFromWheel = useCallback(() => {
    setWheel(null);
    setPlusTab('emoji');
    setPlusOpen(true);
  }, []);
  const wheelOpen = useRef(false);
  wheelOpen.current = wheel !== null;
  useEffect(() => {
    if (engineTool !== 'board-stamp') setWheel(null);
  }, [engineTool]);

  // The board's commands live while it is open; its features (the meeting module) load once it shows.
  useEffect(() => installBoardCommands(), []);
  useEffect(() => void loadBoardFeatures(), []);

  // Who is here: the avatar stamp and a sticky's author line carry the viewer's name (the comments feed knows it).
  useEffect(() => {
    if (!comments) return;
    const update = () => {
      const you = comments.getState().you;
      if (you?.name) setBoardIdentity({name: you.name});
    };
    update();
    return comments.subscribe(update);
  }, [comments]);

  const objects = useMemo(() => createBoardObjects({store, host, index}), [store, host, index]);

  // "Export…" and "Keyboard shortcuts" answer with the board's own dialogs while it is open.
  useBoardDialogs(props.fileName, services.openDialog);

  // A layer inside a board object (a sticky's text after typing, a cell) is never selected on its own: the object is (FigJam).
  useEffect(() => store.select(state => (state.editing ? null : state.selection), selection => {
    if (!selection?.length) return;
    const {doc} = store.getState();
    const get = (id: NodeId | null | undefined) => (id ? doc.nodes[id] : undefined);
    let changed = false;
    const lifted = selection.map(id => {
      const node = get(id);
      if (node?.board?.kind !== 'part') return id;
      const owner = boardObjectOf(get, id);
      if (!owner) return id;
      changed = true;
      return owner.id;
    });
    if (changed) store.setSelection([...new Set(lifted)]);
  }, {slice: ['selection', 'editing']}), [store]);

  const onTool = useCallback((tool: BoardToolId, choices?: Partial<BoardChoices>) => {
    if (choices) setBoardChoices(choices);
    if (readOnly && !BOARD_READ_ONLY_TOOLS.includes(tool)) return;
    setPlusOpen(false);
    store.setTool(tool);
    // The toolbar's "Stamp" opens the wheel above its button (FigJam); E opens it at the pointer instead (the keys move it there).
    if (tool === 'board-stamp') openWheelAt(stampButtonCentre());
  }, [store, readOnly, openWheelAt, stampButtonCentre]);

  const activeRef = useRef(props.active);
  activeRef.current = props.active && !plusOpen;
  const onActions = props.onActions;
  // ⌘\ (or ⌘.) hides the chrome, as in the design editor; ⌘\ again or Escape brings it back.
  const {uiHidden, onUiHiddenChange} = props;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (matchesShortcut(event, 'Mod+Backslash') || matchesShortcut(event, 'Mod+Period')) {
        event.preventDefault();
        onUiHiddenChange(!uiHidden);
      } else if (uiHidden && event.key === 'Escape' && !isTypingTarget(event.target)) {
        event.preventDefault();
        onUiHiddenChange(false);
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [uiHidden, onUiHiddenChange]);
  useBoardKeys({store, context, readOnly, active: activeRef, onTool, onActions, onWheel: openWheel, wheelOpen, onWheelMore: moreFromWheel, onEscapePlus: plusOpen ? () => setPlusOpen(false) : null});

  // A click a meeting feature asked for (a vote on a sticky) is theirs before the canvas sees it.
  useEffect(() => {
    const element = host();
    if (!element) return;
    const press = (event: PointerEvent) => {
      if (objects.offerClick(event)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    element.addEventListener('pointerdown', press, true);
    return () => element.removeEventListener('pointerdown', press, true);
  }, [host, objects]);

  const drawnColors = useCallback((kind: 'marker' | 'highlighter' | 'washi') => boardColors(store.getState().doc, kind), [store]);
  const {onZoom} = props;
  const onFit = useCallback(() => onZoom({type: 'fit'}), [onZoom]);
  const commentMode = engineTool === 'comment';
  const onComments = useCallback(() => store.setTool(commentMode ? 'move' : 'comment'), [store, commentMode]);
  // Link cards ask the open board's preview route (link-card.ts); a read-only board pastes nothing.
  useEffect(() => setLinkCardFile(readOnly ? null : services.fileId), [services.fileId, readOnly]);
  // Custom team templates are a team board's (team-templates.ts).
  useEffect(() => setTemplatePlace({fileId: services.fileId, teamId: props.teamId ?? null, canEdit: !readOnly}), [services.fileId, props.teamId, readOnly]);

  // "Tape from picture" (FigJam's custom washi tape): a picture uploaded into this board, new tape printed with it.
  const onWashiPicture = useCallback(async () => {
    const file = await pickFile('image/png,image/jpeg,image/webp,image/gif');
    if (!file) return;
    try {
      const {ref} = await services.uploadImage(file, file.name);
      setBoardChoices({marker: 'washi', washiImage: ref});
    } catch (error) {
      services.toast(error instanceof Error && error.message ? error.message : 'Could not upload the picture.', 'error');
    }
  }, [services]);
  // "Mind map" from the shapes tray: one placed in the view, the tray put away (mind-map.ts).
  const onMindMap = useCallback(() => {
    runCommand('board.mind-map', context());
    store.setTool('move');
  }, [store, context]);
  const onPlus = useCallback(() => {
    setPlusTab('all');
    setPlusOpen(open => !open);
  }, []);
  const closePlus = useCallback(() => setPlusOpen(false), []);

  // A new, empty board offers its templates once (FigJam opens its template browser on a blank file), unless "Show templates for new boards" is off.
  const offered = useRef(false);
  useEffect(() => {
    if (offered.current || readOnly) return;
    offered.current = true;
    const {doc, pageId} = store.getState();
    if (boardChoices().templatesOnNew !== false && doc.pages.length === 1 && !(doc.nodes[pageId]?.children?.length)) setPlusOpen(true);
  }, [store, readOnly]);

  const meeting = useSyncExternalStore(subscribeBoardMeeting, boardMeeting, boardMeeting);
  const meetingProps = useMemo<BoardMeetingProps>(() => ({services, realtime: props.realtime, board: objects, editor: 'board'}), [services, props.realtime, objects]);
  const Controls = meeting?.Controls, MeetingLayer = meeting?.CanvasLayer;
  const avatars = useMemo(() => (props.realtime ? <props.realtime.Avatars /> : null), [props.realtime]);

  return (
    <div className={`dz-editor dz-board ${props.uiHidden ? 'is-ui-hidden' : ''}`.trim()} data-tool={engineTool}>
      <main ref={area} className="dz-canvas-area bd-canvas-area" aria-label="Board">
        {props.canvas}
        <PhoneBoard store={store} />
        <BoardDecor store={store} index={index} />
        <BadgeLayer store={store} objects={objects} />
        {MeetingLayer && <div className="bd-meeting-layer"><MeetingLayer {...meetingProps} /></div>}
        {props.overlay}
        <ContextToolbar store={store} context={context} readOnly={readOnly} />
        {wheel && engineTool === 'board-stamp' && <StampWheel centre={wheel} current={boardChoices().stamp} onClose={closeWheel} onExit={exitWheel} onMore={moreFromWheel} />}
        <div className="bd-chrome">
          <TopLeftPill name={props.fileName} onRename={props.onRename} saveState={props.saveState} renameRequest={props.renameRequest} commands={props.commands}
            menu={props.menu} onBackToFiles={props.onBackToFiles} store={store} readOnly={readOnly} />
          <TopRightPill avatars={avatars} meeting={Controls ? <Controls {...meetingProps} /> : null} commentsOpen={commentMode} unread={props.unreadComments}
            onComments={onComments} onShare={props.onShare} />
          <ZoomPill zoom={props.zoom} onZoom={props.onZoom} commands={props.commands} />
          <BoardToolbar tool={engineTool} onTool={onTool} readOnly={readOnly} plusOpen={plusOpen} onPlus={onPlus} onActions={onActions}
            above={<Recenter store={store} index={index} host={host} onFit={onFit} />} boardColors={drawnColors} onMindMap={onMindMap} onWashiPicture={readOnly ? undefined : onWashiPicture} />
          {plusOpen && (
            <Suspense fallback={null}>
              <PlusSheet store={store} services={services} context={context} onClose={closePlus} tab={plusTab} />
            </Suspense>
          )}
        </div>
        {commentMode && props.commentsPanel && (
          <aside className="bd-sidebar" aria-label="Comments">
            {/* FigJam's sidebar names itself and closes with × (help.figma.com "Comments in FigJam"). */}
            <div className="bd-sidebar-head">
              <h2 className="bd-sidebar-title">Comments</h2>
              <button type="button" className="bd-pill-btn" aria-label="Close comments" title="Close comments" onClick={onComments}>
                <BdClose />
              </button>
            </div>
            {props.commentsPanel}
          </aside>
        )}
      </main>
    </div>
  );
});
