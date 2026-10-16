import {lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent} from 'react';
import {ApiError} from '../../api';
import {requestNavigation} from '../../navigation';
import type {DesignFileSummary} from '../../../shared/design/api';
import {DESIGN_LIMITS} from '../../../shared/design/limits';
import {canEditTeamFiles, canManageTeam, DESIGN_FILE_GUEST_SHORT, DESIGN_TEAM_ROLE_LABELS, type DesignFileAccess, type DesignTeamSummary} from '../../../shared/design/teams';
import {createDesignFile, duplicateDesignFile, eraseDesignFile, moveDesignFile, removeDesignFileGuest, renameDesignFile, restoreDesignFile, trashDesignFile} from '../api';
import {Button, IconButton} from '../ui/Button';
import {
  IconCheck, IconChevronDown, IconClock, IconClose, IconCopy, IconDownload, IconExternal, IconFile, IconFileOpen, IconFolder, IconGrid, IconImport, IconList, IconMore, IconOffline,
  IconLeave, IconLink, IconMenu, IconPlus, IconStar, IconRename, IconRestore, IconSearch, IconSettings, IconTeam, IconTrash, IconUser, IconUserPlus,
} from '../ui/icons';
import {useContextMenu, useMenuTrigger} from '../ui/Menu';
import type {MenuItem} from '../ui/menu-model';
import {EmptyState} from '../ui/ProgressBar';
import {Select} from '../ui/Select';
import {SegmentedControl} from '../ui/Tabs';
import {TextInput} from '../ui/TextInput';
import {useToast} from '../ui/Toast';
import {usePhone, useTablet} from '../ui/viewport';
import {quoted} from '../teams/model';
import {projectMenuItems, useTeamWorkspace} from '../teams/TeamWorkspace';
import {EraseDialog, EraseManyDialog, FigmaImportUnavailable} from './dialogs';
import {FileGrid, designHref, type FileMenuAnchor} from './FileGrid';
import {filterKind, matchesSearch, sortFiles, type FileKindFilter, type FileSort} from './format';
import {BOARD_NAMES} from '../../../shared/design/board/names';
import {loadFigmaImport, loadPortable, portableAvailable} from './integrations';
import {NewBoardButton, NewFileMenu} from './NewFileMenu';
import {Drawer} from './phone/Drawer';
import {viewedTimes} from './viewed';
import {matchProjects} from './search';
import {useMarquee} from './marquee';
import {duplicateToDrafts} from './trash-api';
import {Starred} from './Starred';
import {AssistantsEntry} from '../assistants/Assistants';
import {useFavourites} from './useFavourites';
import {bulkMenuItems, filesCount, type BulkActions, type MoveTarget} from './bulk';
import {dropAction} from './drop';
import {keepShown, NO_SELECTION, selectAll, selectFile, selectOnly, type FileSelection, type SelectHow} from './selection';
// The extension tells Sidebar.tsx from sidebar.ts on a case-insensitive disk (TS1149 otherwise).
import {Sidebar} from './Sidebar.tsx';
import {isTrashView, PERSONAL_SECTIONS, teamSections, viewFromKey, viewKey, viewTitle, type BrowserView, type SidebarSection} from './sidebar';
import {useDesignFiles} from './useDesignFiles';
import {errorText, useOnline} from '../ui/error-text';
import {SupportButton} from '../../support/SupportButton';

type DialogState = null | {kind: 'figma'} | {kind: 'erase'; file: DesignFileSummary} | {kind: 'erase-many'; files: DesignFileSummary[]} | {kind: 'share'; file: DesignFileSummary};

const SORT_OPTIONS = [{value: 'updated', label: 'Last modified'}, {value: 'viewed', label: 'Last viewed'}, {value: 'name', label: 'Name'}, {value: 'created', label: 'Created'}] as const;
// In the trash the newest change is the deletion: Figma's "Date trashed".
const TRASH_SORT_OPTIONS = SORT_OPTIONS.map(option => (option.value === 'updated' ? {...option, label: 'Deleted'} : option));
const KIND_OPTIONS = [{value: 'all', label: 'All files'}, {value: 'design', label: 'Design'}, {value: 'board', label: BOARD_NAMES.many}] as const;
const MODE_OPTIONS = [{value: 'grid', label: 'Grid', icon: <IconGrid />}, {value: 'list', label: 'List', icon: <IconList />}] as const;

/** A file's menu as a screen reader names it. */
const fileMenuLabel = (file: DesignFileSummary) => `File actions ${quoted(file.name)}`;

/** A per-browser preference that survives blocked storage. */
function useStoredChoice<T extends string>(key: string, allowed: readonly T[], fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = localStorage.getItem(key);
      return allowed.includes(stored as T) ? (stored as T) : fallback;
    } catch {
      return fallback;
    }
  });
  const set = useCallback((next: T) => {
    setValue(next);
    try { localStorage.setItem(key, next); } catch { /* storage blocked */ }
  }, [key]);
  return [value, set] as const;
}

/** The place the browser showed last in this tab: coming back from the editor lands there (a team's view once the teams are known). */
const VIEW_KEY = 'morfa-design-view';
const storedView = (): string | null => {
  try { return sessionStorage.getItem(VIEW_KEY); } catch { return null; }
};
const storeView = (view: BrowserView) => {
  try { sessionStorage.setItem(VIEW_KEY, viewKey(view)); } catch { /* storage blocked */ }
};

/** Re-renders once a minute so "Modified 5 min ago" stays true. */
function useMinuteClock() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

// "Share" from a file's menu (Figma's file browser has it there too): the editor's dialog, loaded with its first opening.
const ShareDialog = lazy(() => import('../teams/ShareDialog'));
/** The file's whole address, as the editor's "Copy link" gives it. */
const fileUrl = (id: string) => `${location.origin}${location.pathname}${location.search}${designHref(id)}`;

const FigmaImport = loadFigmaImport ? lazy(() => loadFigmaImport!().then(component => ({default: component}))) : null;

export type FileBrowserProps = {
  /** The designer's own sections; each team adds its own after them (docs/design-tool.md §Teams). */
  sections?: readonly SidebarSection[];
};

/** The "Design" home: recent files and the trash, the teams and their projects, search, sort, grid or list. */
export function FileBrowser({sections = PERSONAL_SECTIONS}: FileBrowserProps) {
  const [view, setView] = useState<BrowserView>(() => {
    const key = storedView();
    return key === 'trash' || key === 'shared' || key === 'viewed' ? {kind: key} : {kind: 'recent'};
  });
  const trash = isTrashView(view);
  // "Recently viewed" reads every team's list too: the teams' ids, once the workspace knows them.
  const [teamIds, setTeamIds] = useState<readonly string[]>([]);
  const {state, refresh, update} = useDesignFiles(view, teamIds);
  // Without a network the browser says so above the files, and reads them again once the network is back.
  const online = useOnline();
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) refresh();
    wasOnline.current = online;
  }, [online, refresh]);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useStoredChoice<FileSort>('morfa-design-sort', ['updated', 'viewed', 'name', 'created'], 'updated');
  const [mode, setMode] = useStoredChoice<'grid' | 'list'>('morfa-design-layout', ['grid', 'list'], 'grid');
  const [kind, setKind] = useStoredChoice<FileKindFilter>('morfa-design-kind', ['all', 'design', 'board'], 'all');
  const [selection, setSelection] = useState<FileSelection>(NO_SELECTION);
  const selectedId = selection.focus;
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [creating, setCreating] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const context = useContextMenu();
  const now = useMinuteClock();

  const changeView = useCallback((next: BrowserView) => {
    setView(next);
    storeView(next);
    setSelection(NO_SELECTION);
    setRenamingId(null);
  }, []);
  // On a phone the sidebar is a drawer (phone/Drawer.tsx) that closes on the place chosen in it.
  const phone = usePhone();
  const [drawer, setDrawer] = useState(false);
  const closeDrawer = useCallback(() => setDrawer(false), []);
  const chooseView = useCallback((next: BrowserView) => {
    changeView(next);
    setDrawer(false);
  }, [changeView]);
  const workspace = useTeamWorkspace({view, onView: changeView});
  // "Favorites", Figma's "Starred" (useFavourites.ts): the sidebar's section and a row in the file and project menus.
  const starError = useCallback((error: unknown) => toast(errorText(error), {kind: 'error'}), [toast]);
  const stars = useFavourites(starError);
  const teams = workspace.teams;
  const teamIdsKey = teams.map(entry => entry.id).join(',');
  useEffect(() => setTeamIds(teamIdsKey ? teamIdsKey.split(',') : []), [teamIdsKey]);
  const team: DesignTeamSummary | null = workspace.teamOf(view);
  // A team view comes back once the teams are read; one the caller left (or a project that went) falls back.
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !teams.length) return;
    restored.current = true;
    const saved = viewFromKey(storedView(), teams);
    if (saved && (saved.kind === 'team' || saved.kind === 'team-trash')) setView(saved);
  }, [teams]);
  useEffect(() => {
    if ((view.kind === 'team' || view.kind === 'team-trash') && workspace.loaded && !team) changeView({kind: 'recent'});
    else if (view.kind === 'team' && team && view.projectId && !team.projects.some(project => project.id === view.projectId))
      changeView({kind: 'team', teamId: team.id, projectId: null});
  }, [view, team, workspace.loaded, changeView]);
  // The team's files answer 404 while the browser shows it: the caller was removed or the team deleted. Back to personal files.
  const forget = workspace.forget, refreshTeams = workspace.refresh;
  useEffect(() => {
    const teamId = view.kind === 'team' || view.kind === 'team-trash' ? view.teamId : null;
    if (!teamId || state.status !== 'error' || !(state.error instanceof ApiError) || state.error.status !== 404 || state.unavailable) return;
    refreshTeams();
    // A project someone deleted: the team's other files.
    if (view.kind === 'team' && view.projectId) return changeView({kind: 'team', teamId, projectId: null});
    toast('You no longer have access to this team.');
    forget(teamId);
    changeView({kind: 'recent'});
  }, [state, view, forget, refreshTeams, changeView, toast]);

  const sharedView = view.kind === 'shared';
  const editable = !sharedView && (!team || canEditTeamFiles(team.role));
  const manager = !sharedView && (!team || canManageTeam(team.role));
  const personal = view.kind === 'recent' || view.kind === 'trash';
  const target = view.kind === 'team' ? {teamId: view.teamId, projectId: view.projectId} : undefined;
  const allSections = useMemo<SidebarSection[]>(() => [
    ...sections.map(section => (teams.length && section.id === 'personal' && !section.title ? {...section, title: 'Personal files'} : section)),
    ...teamSections(teams),
  ], [sections, teams]);

  const ready = state.status === 'ready' ? state : null;
  // A file trashed, moved or erased leaves "Favorites" on the server's next answer: read it again with every list.
  const refreshStars = stars.refresh;
  useEffect(() => {
    if (ready) refreshStars();
  }, [ready, refreshStars]);
  // "Shared with me": whose each file is and what the caller may do with it (docs/design-tool.md §Teams, "File access").
  const sharedInfo = ready?.shared ?? null;
  const describeShared = useMemo(() => (sharedInfo ? (file: DesignFileSummary) => {
    const entry = sharedInfo.get(file.id);
    return entry ? {text: `${entry.from} · ${DESIGN_FILE_GUEST_SHORT[entry.role]}`} : null;
  } : undefined), [sharedInfo]);
  // "Recently viewed" is in the order of opening; the other views by the chosen sort.
  const shownSort: FileSort = view.kind === 'viewed' ? 'viewed' : sort;
  const visible = useMemo(() => (ready ? sortFiles(filterKind(ready.files, kind).filter(file => matchesSearch(file.name, search)), shownSort, shownSort === 'viewed' ? viewedTimes() : undefined) : []), [ready, kind, search, shownSort]);
  const order = useMemo(() => visible.map(file => file.id), [visible]);
  // Figma's search finds projects too: the teams' projects whose name (or team's) matches, above the files (search.ts).
  const projectMatches = useMemo(() => matchProjects(teams, search), [teams, search]);
  // What leaves the view (a filter, a search, a move, the trash) leaves the selection.
  useEffect(() => setSelection(current => keepShown(current, order)), [order]);
  const select = useCallback((id: string, how: SelectHow = 'only') => setSelection(current => selectFile(current, id, how, order)), [order]);
  // A finger has no ⌘ or Shift: on a phone a file's menu offers "Select", after which a tap adds a file to the selection or
  // takes it out (FileGrid `touchSelecting`), until nothing is selected (lane PH).
  const touchTablet = useTablet();
  const [touchSelecting, setTouchSelecting] = useState(false);
  useEffect(() => {
    if (!selection.ids.length) setTouchSelecting(false);
  }, [selection.ids.length]);
  const selectItem = (file: DesignFileSummary): MenuItem[] => (phone || touchTablet ? [{id: 'select', label: 'Select', icon: <IconCheck />, onSelect: () => {
    select(file.id);
    setTouchSelecting(true);
  }}] : []);
  const selectEvery = useCallback(() => setSelection(selectAll(order)), [order]);
  const clearSelection = useCallback(() => setSelection(NO_SELECTION), []);
  // The marquee (marquee.ts): a drag from the empty space between files selects the cards its box touches.
  const marquee = useMarquee(
    () => [...document.querySelectorAll<HTMLElement>('.dz-files-content .dz-file[data-file-id]')].map(element => {
      const rect = element.getBoundingClientRect();
      return {id: element.dataset.fileId!, box: {left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom}};
    }),
    () => selection.ids,
    ids => setSelection(ids.length ? {ids, anchor: ids[0], focus: ids[ids.length - 1]} : NO_SELECTION),
  );
  const title = viewTitle(view, teams);

  // ── Actions ─────────────────────────────────────────────────────────────────────────────────
  const open = useCallback((file: DesignFileSummary, newTab = false) => {
    if (file.trashedAt) {
      toast('The file is in the trash. Restore it to open it.');
      return;
    }
    if (newTab) window.open(designHref(file.id), '_blank', 'noopener');
    else requestNavigation({kind: 'design', fileId: file.id});
  }, [toast]);

  const create = async () => {
    if (creating) return;
    setCreating(true);
    try {
      const {file} = await createDesignFile(target ?? {});
      requestNavigation({kind: 'design', fileId: file.id});
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    } finally {
      setCreating(false);
    }
  };

  const rename = useCallback(async (file: DesignFileSummary, name: string) => {
    setRenamingId(null);
    update(files => files.map(entry => (entry.id === file.id ? {...entry, name} : entry)));
    try {
      const {file: saved} = await renameDesignFile(file.id, name);
      update(files => files.map(entry => (entry.id === saved.id ? saved : entry)));
    } catch (error) {
      update(files => files.map(entry => (entry.id === file.id ? {...entry, name: file.name} : entry)));
      toast(errorText(error), {kind: 'error'});
    }
  }, [update, toast]);

  const duplicate = async (file: DesignFileSummary) => {
    try {
      const {file: copy} = await duplicateDesignFile(file.id);
      update(files => [copy, ...files]);
      setSelection(selectOnly(copy.id));
      toast(`Copy of "${file.name}" created`, {kind: 'success'});
      refresh();
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    }
  };

  const moveToTrash = useCallback(async (file: DesignFileSummary) => {
    update(files => files.filter(entry => entry.id !== file.id));
    try {
      await trashDesignFile(file.id);
      toast(`"${file.name}" moved to the trash`, {action: {label: 'Undo', onClick: () => {
        void restoreDesignFile(file.id).then(refresh, error => toast(errorText(error), {kind: 'error'}));
      }}});
      refresh();
    } catch (error) {
      refresh();
      toast(errorText(error), {kind: 'error'});
    }
  }, [update, refresh, toast]);

  /** A copy of a trashed file in the caller's personal files (trash-api.ts); the trashed one stays. */
  const copyFromTrash = async (file: DesignFileSummary) => {
    try {
      const copy = await duplicateToDrafts(file.id);
      toast(`Copy of "${file.name}" in your personal files`, {kind: 'success', action: {label: 'Open', onClick: () => open(copy)}});
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    }
  };

  const restore = async (file: DesignFileSummary) => {
    try {
      const {file: restored} = await restoreDesignFile(file.id);
      update(files => files.filter(entry => entry.id !== file.id));
      toast(`"${file.name}" restored`, {kind: 'success', action: {label: 'Open', onClick: () => open(restored)}});
      refresh();
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    }
  };

  const erase = async (file: DesignFileSummary) => {
    try {
      await eraseDesignFile(file.id);
      update(files => files.filter(entry => entry.id !== file.id));
      setDialog(null);
      toast(`"${file.name}" deleted permanently`);
      refresh();
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    }
  };

  /** "Remove from Shared with me": the caller leaves a file shared with them (the owner can share it again). */
  const leave = useCallback(async (file: DesignFileSummary) => {
    update(files => files.filter(entry => entry.id !== file.id));
    try {
      await removeDesignFileGuest(file.id, 'me');
      toast(`"${file.name}" removed from Shared with me`);
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    }
    refresh();
  }, [update, refresh, toast]);

  /** Into a team (and project), between projects, or back to personal files; the list drops what left this view. */
  const move = useCallback(async (file: DesignFileSummary, teamId: string | null, projectId: string | null, where: string) => {
    try {
      const {file: moved} = await moveDesignFile(file.id, {teamId, projectId});
      const stays = view.kind === 'team' ? moved.teamId === view.teamId && (view.projectId === null || moved.projectId === view.projectId) : !moved.teamId;
      update(files => (stays ? files.map(entry => (entry.id === moved.id ? moved : entry)) : files.filter(entry => entry.id !== moved.id)));
      toast(`"${file.name}" moved ${where}`, {kind: 'success'});
      refresh();
      workspace.refresh();
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    }
  }, [view, update, toast, refresh, workspace]);

  const copyLink = async (file: DesignFileSummary) => {
    try {
      await navigator.clipboard.writeText(fileUrl(file.id));
      toast('Link copied', {kind: 'success'});
    } catch {
      toast('Could not copy the link.', {kind: 'error'});
    }
  };

  /** What the caller may do with a file, as the editor learns it on opening (the share dialog reads the team from it). */
  const accessOf = (file: DesignFileSummary): DesignFileAccess => {
    const shared = sharedInfo?.get(file.id);
    if (shared) return {role: shared.role, canEdit: shared.role === 'editor', team: null, guest: true};
    const owner = file.teamId ? teams.find(entry => entry.id === file.teamId) ?? null : null;
    return owner ? {role: owner.role, canEdit: canEditTeamFiles(owner.role), team: {id: owner.id, name: owner.name}} : {role: 'owner', canEdit: true, team: null};
  };

  const download = async (file: DesignFileSummary) => {
    const module = await loadPortable()?.catch(() => null);
    if (!module?.downloadPortableFile) {
      toast('Downloading .rdesign is not available yet.', {kind: 'error'});
      return;
    }
    try {
      await module.downloadPortableFile(file.id, file.name);
    } catch (error) {
      toast(errorText(error), {kind: 'error'});
    }
  };

  const openPortable = async (files: File[]) => {
    const designs = files.filter(file => /\.rdesign$/i.test(file.name));
    if (!designs.length) {
      if (files.length) toast('Only .rdesign files can be opened.', {kind: 'error'});
      return;
    }
    const module = await loadPortable()?.catch(() => null);
    if (!module) {
      toast('Opening .rdesign files is not available yet.', {kind: 'error'});
      return;
    }
    for (const design of designs) {
      try {
        const {fileId} = await module.openPortableAsNewFile(design);
        toast(`"${design.name.replace(/\.rdesign$/i, '')}" added`, {kind: 'success', action: {label: 'Open', onClick: () => requestNavigation({kind: 'design', fileId})}});
      } catch (error) {
        toast(`${design.name}: ${errorText(error)}`, {kind: 'error'});
      }
    }
    if (view.kind !== 'recent') changeView({kind: 'recent'});
    else refresh();
  };

  /** "Move": a team file goes between its team's projects (editors) or back to personal files (managers); a personal file into a
   * team the caller manages. */
  const moveItems = useCallback((file: DesignFileSummary): MenuItem[] => {
    if (file.teamId) {
      const owner = teams.find(entry => entry.id === file.teamId);
      if (!owner || !canEditTeamFiles(owner.role)) return [];
      const places: MenuItem[] = [
        {id: 'move-none', label: 'No project', icon: <IconGrid />, checked: !file.projectId, onSelect: () => void move(file, owner.id, null, 'out of any project')},
        ...owner.projects.map((project): MenuItem => ({id: 'move-' + project.id, label: project.name, icon: <IconFolder />, checked: file.projectId === project.id,
          onSelect: () => void move(file, owner.id, project.id, `to the project ${quoted(project.name)}`)})),
      ];
      if (canManageTeam(owner.role)) places.push({type: 'separator'}, {id: 'move-personal', label: 'To personal files', icon: <IconUser />, onSelect: () => void move(file, null, null, 'to personal files')});
      return [{type: 'submenu', id: 'move', label: 'Move', icon: <IconFolder />, items: places}];
    }
    const into = teams.filter(entry => canManageTeam(entry.role));
    if (!into.length) return [];
    return [{type: 'submenu', id: 'move', label: 'Move to team', icon: <IconTeam />, items: into.map((entry): MenuItem => ({
      id: 'move-' + entry.id, label: entry.name, icon: <IconTeam />, onSelect: () => void move(file, entry.id, null, `to the team ${quoted(entry.name)}`),
    }))}];
  }, [teams, move]);

  /** Runs `act` on every file at once and says in one toast how it went: "Done" for all, or how many failed and why. */
  const runMany = useCallback(async (files: DesignFileSummary[], act: (file: DesignFileSummary) => Promise<unknown>, done: string) => {
    const results = await Promise.allSettled(files.map(act));
    const failed = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    refresh();
    if (!failed.length) toast(done, {kind: 'success'});
    else toast(`Failed for ${filesCount(failed.length)}: ${errorText(failed[0].reason)}`, {kind: 'error'});
    return failed.length;
  }, [refresh, toast]);
  const bulk = useMemo<BulkActions>(() => ({
    duplicate: files => void runMany(files, file => duplicateDesignFile(file.id), `Copies created: ${filesCount(files.length)}`),
    move: (files, target: MoveTarget) => void runMany(files, file => moveDesignFile(file.id, {teamId: target.teamId, projectId: target.projectId}),
      `${filesCount(files.length)} moved ${target.where}`).then(() => workspace.refresh()),
    trash: files => {
      const ids = new Set(files.map(file => file.id));
      update(entries => entries.filter(entry => !ids.has(entry.id)));
      void Promise.allSettled(files.map(file => trashDesignFile(file.id))).then(results => {
        refresh();
        const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failed) return toast(errorText(failed.reason), {kind: 'error'});
        toast(`Moved to the trash: ${filesCount(files.length)}`, {action: {label: 'Undo', onClick: () => void runMany(files, file => restoreDesignFile(file.id), 'Files restored')}});
      });
    },
    restore: files => void runMany(files, file => restoreDesignFile(file.id), `Restored: ${filesCount(files.length)}`),
    erase: files => setDialog({kind: 'erase-many', files}),
    leave: files => void runMany(files, file => removeDesignFileGuest(file.id, 'me'), `Removed from Shared with me: ${filesCount(files.length)}`),
  }), [runMany, update, refresh, toast, workspace]);
  const eraseMany = async (files: DesignFileSummary[]) => {
    const failed = await runMany(files, file => eraseDesignFile(file.id), `Deleted permanently: ${filesCount(files.length)}`);
    if (!failed) setDialog(null);
  };

  // Dragging cards onto a place in the sidebar (drop.ts): the files the drag carries, kept while it lasts.
  const [dragged, setDragged] = useState<DesignFileSummary[]>([]);
  const dragFiles = useCallback((file: DesignFileSummary): readonly string[] => {
    if (sharedInfo || file.trashedAt) return [];
    const group = selection.ids.length > 1 && selection.ids.includes(file.id) ? visible.filter(entry => selection.ids.includes(entry.id)) : [file];
    setDragged(group);
    return group.map(entry => entry.id);
  }, [sharedInfo, selection, visible]);
  const endDrag = useCallback(() => setDragged([]), []);
  /** Cards dropped on "Favorites": every one of them starred. */
  const starDragged = () => {
    const files = dragged;
    setDragged([]);
    for (const file of files) void stars.setStar('files', starEntry(file), true);
  };
  const toggleStar = useCallback((file: DesignFileSummary, on: boolean) => void stars.setStar('files', starEntry(file), on), [stars]);
  const sidebarDrop = useMemo(() => (phone ? undefined : {
    accepts: (target: BrowserView) => !!dropAction(dragged, target, teams),
    onDrop: (target: BrowserView) => {
      const action = dropAction(dragged, target, teams);
      setDragged([]);
      if (action?.kind === 'trash') bulk.trash(dragged);
      else if (action) bulk.move(dragged, {teamId: action.teamId, projectId: action.projectId, where: action.where});
    },
  }), [phone, dragged, teams, bulk]);

  /** "Add to favorites" / "Remove from favorites", Figma's "Add to your favorites". */
  const starEntry = (file: DesignFileSummary) => ({id: file.id, name: file.name, kind: file.kind === 'board' ? 'board' as const : 'design' as const, teamId: file.teamId ?? null});
  const starItem = (file: DesignFileSummary): MenuItem => {
    const on = stars.isStarred('files', file.id);
    return {id: 'star', label: on ? 'Remove from favorites' : 'Add to favorites', icon: <IconStar />,
      onSelect: () => void stars.setStar('files', starEntry(file), !on)};
  };

  const showMenu = useCallback((file: DesignFileSummary, anchor: FileMenuAnchor) => {
    // Inside a selection of several files: their shared menu (bulk.tsx); otherwise this file's own.
    const group = selection.ids.length > 1 && selection.ids.includes(file.id) ? visible.filter(entry => selection.ids.includes(entry.id)) : null;
    if (group) {
      const items = bulkMenuItems(group, {teams, trash, shared: !!sharedInfo, actions: bulk});
      const label = `Actions for ${filesCount(group.length)}`;
      if ('element' in anchor) context.open({x: 0, y: 0, keyboard: anchor.keyboard, target: anchor.element}, items, label);
      else context.open(anchor, items, label);
      return;
    }
    const shared = sharedInfo?.get(file.id);
    if (shared) {
      const sharedItems: MenuItem[] = [
        {id: 'open', label: 'Open', icon: <IconFile />, onSelect: () => open(file)},
        {id: 'open-tab', label: 'Open in new tab', icon: <IconExternal />, onSelect: () => open(file, true)},
        {id: 'copy-link', label: 'Copy link', icon: <IconLink />, onSelect: () => void copyLink(file)},
        starItem(file),
        ...(shared.role === 'editor' ? [{id: 'rename', label: 'Rename', icon: <IconRename />, onSelect: () => setRenamingId(file.id)} as MenuItem] : []),
        {type: 'separator'} as MenuItem,
        {id: 'leave', label: 'Remove from Shared with me', icon: <IconLeave />, danger: true, onSelect: () => void leave(file)} as MenuItem,
      ];
      if ('element' in anchor) context.open({x: 0, y: 0, keyboard: anchor.keyboard, target: anchor.element}, sharedItems, fileMenuLabel(file));
      else context.open(anchor, sharedItems, fileMenuLabel(file));
      return;
    }
    const fileTeam = file.teamId ? teams.find(entry => entry.id === file.teamId) ?? null : null;
    const canEdit = !fileTeam || canEditTeamFiles(fileTeam.role);
    const canManage = !fileTeam || canManageTeam(fileTeam.role);
    // Figma's trash menu: "Duplicate to drafts", then restore and delete for whoever may.
    const copyToDrafts: MenuItem = {id: 'duplicate-to-drafts', label: 'Duplicate to personal files', icon: <IconCopy />, onSelect: () => void copyFromTrash(file)};
    const items: MenuItem[] = file.trashedAt ? (canManage ? [
      ...selectItem(file),
      copyToDrafts,
      {type: 'separator'},
      {id: 'restore', label: 'Restore', icon: <IconRestore />, onSelect: () => void restore(file)},
      {type: 'separator'},
      {id: 'erase', label: 'Delete permanently', icon: <IconTrash />, danger: true, onSelect: () => setDialog({kind: 'erase', file})},
    ] : [copyToDrafts, {type: 'separator'}, {type: 'label', label: 'Only the team owner and admins can restore a file'}]) : [
      {id: 'open', label: 'Open', icon: <IconFile />, onSelect: () => open(file)},
      {id: 'open-tab', label: 'Open in new tab', icon: <IconExternal />, onSelect: () => open(file, true)},
      ...selectItem(file),
      {type: 'separator'},
      starItem(file),
      {type: 'separator'},
      // Figma's order: the link and sharing, then what changes the file, then the trash.
      {id: 'copy-link', label: 'Copy link', icon: <IconLink />, onSelect: () => void copyLink(file)},
      {id: 'share', label: 'Share…', icon: <IconUserPlus />, onSelect: () => setDialog({kind: 'share', file})},
      ...(canEdit ? [
        {id: 'duplicate', label: 'Duplicate', icon: <IconCopy />, onSelect: () => void duplicate(file)} as MenuItem,
        {type: 'separator'} as MenuItem,
        {id: 'rename', label: 'Rename', icon: <IconRename />, onSelect: () => setRenamingId(file.id)} as MenuItem,
        ...moveItems(file),
      ] : [{type: 'separator'} as MenuItem]),
      {id: 'download', label: 'Save to computer (.rdesign)', icon: <IconDownload />, disabled: !portableAvailable(),
        description: portableAvailable() ? undefined : 'Coming in an upcoming update', onSelect: () => void download(file)},
      ...(canManage ? [
        {type: 'separator'} as MenuItem,
        {id: 'trash', label: 'Move to trash', icon: <IconTrash />, danger: true, onSelect: () => void moveToTrash(file)} as MenuItem,
      ] : []),
    ];
    if ('element' in anchor) context.open({x: 0, y: 0, keyboard: anchor.keyboard, target: anchor.element}, items, fileMenuLabel(file));
    else context.open(anchor, items, fileMenuLabel(file));
  }, [context, open, moveToTrash, teams, moveItems, sharedInfo, leave, selection, visible, trash, bulk, stars, phone, touchTablet, select]); // eslint-disable-line react-hooks/exhaustive-deps

  // Rename ends: focus goes back to the card it came from.
  const endRename = useCallback(() => setRenamingId(null), []);
  const startRename = useCallback((file: DesignFileSummary) => {
    const shared = sharedInfo?.get(file.id);
    if (shared ? shared.role === 'editor' : editable) setRenamingId(file.id);
  }, [editable, sharedInfo]);
  const focusAfterTrash = useRef(false);
  const trashFromGrid = useCallback((file: DesignFileSummary) => {
    // Somebody else's file: Delete does nothing here ("Remove from Shared with me" is in its menu).
    if (sharedInfo) return;
    const group = selection.ids.length > 1 && selection.ids.includes(file.id) ? visible.filter(entry => selection.ids.includes(entry.id)) : null;
    if (!manager) return toast('Only the owner and admins can move team files to the trash.');
    // The keyboard stays in the list: the next file (or the one before) takes the selection and the focus; with none left,
    // the empty view's first action does.
    const gone = new Set((group ?? [file]).map(entry => entry.id));
    const at = visible.findIndex(entry => entry.id === file.id);
    const next = visible.slice(at + 1).find(entry => !gone.has(entry.id)) ?? visible.slice(0, Math.max(at, 0)).reverse().find(entry => !gone.has(entry.id));
    focusAfterTrash.current = true;
    if (group) bulk.trash(group);
    else void moveToTrash(file);
    if (next) select(next.id);
  }, [manager, moveToTrash, toast, sharedInfo, selection, visible, bulk, select]);
  useEffect(() => {
    if (renamingId !== null || document.activeElement !== document.body) return;
    const link = selectedId ? document.querySelector<HTMLElement>(`[data-file-link][href="${CSS.escape(designHref(selectedId))}"]`) : null;
    const target = link ?? (focusAfterTrash.current && !visible.length ? document.querySelector<HTMLElement>('.dz-files-content .dz-empty button') : null);
    if (!target) return;
    target.focus({preventScroll: true});
    focusAfterTrash.current = false;
  }, [renamingId, selectedId, visible]);

  const importMenu = useMenuTrigger({
    label: 'Import',
    placement: 'bottom-end',
    minWidth: 240,
    items: useCallback((): MenuItem[] => [
      {id: 'portable', label: 'Open .rdesign file…', icon: <IconFileOpen />, disabled: !portableAvailable(),
        description: portableAvailable() ? undefined : 'Coming in an upcoming update', onSelect: () => fileInput.current?.click()},
      {id: 'figma', label: 'Import from Figma…', icon: <IconImport />, onSelect: () => setDialog({kind: 'figma'})},
    ], []),
  });
  const teamMenu = useMenuTrigger({
    label: 'Team',
    placement: 'bottom-end',
    minWidth: 220,
    items: useCallback((): MenuItem[] => {
      if (!team) return [];
      const project = view.kind === 'team' && view.projectId ? team.projects.find(entry => entry.id === view.projectId) ?? null : null;
      const starred = !!project && stars.isStarred('projects', project.id);
      return [
        ...(project ? [{id: 'star-project', label: starred ? 'Remove project from favorites' : 'Add project to favorites', icon: <IconStar />,
          onSelect: () => void stars.setStar('projects', {id: project.id, name: project.name, teamId: team.id}, !starred)} as MenuItem, {type: 'separator'} as MenuItem] : []),
        ...(view.kind === 'team' && view.projectId && canManageTeam(team.role) ? [...projectMenuItems(workspace, team.id, view.projectId), {type: 'separator'} as MenuItem] : []),
        {id: 'settings', label: 'Team settings', icon: <IconSettings />, onSelect: () => workspace.openSettings(team.id)},
      ];
    }, [team, view, workspace, stars]),
  });
  const switcherOptions = useMemo(() => [
    {value: 'personal', label: 'Personal files'},
    ...teams.map(entry => ({value: entry.id, label: entry.name})),
    {separator: true} as const,
    {value: 'create', label: 'Create team…', icon: <IconPlus />},
  ], [teams]);

  // ── Drop zone (personal files: .rdesign files open as new personal files) ───────────────────────
  const hasFiles = (event: DragEvent) => [...event.dataTransfer.types].includes('Files');
  const dropProps = view.kind !== 'recent' ? {} : {
    onDragEnter: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current++;
      setDragging(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    onDragLeave: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      dragDepth.current = 0;
      setDragging(false);
      void openPortable([...event.dataTransfer.files]);
    },
  };

  const limits = ready?.limits ?? null;
  // As Figma's file browser: on a desktop the search sits in the sidebar under the account and the page's title heads the top
  // bar beside the ways to make a file; on a phone the search and the title stay in the main column (the sidebar is a drawer).
  const searchField = (
    <TextInput size={32} className="dz-files-search" icon={<IconSearch />} value={search} onChange={setSearch} placeholder="Search files" aria-label="Search files"
      inputRef={searchInput} type="search" onCancel={() => setSearch('')}
      end={search ? <IconButton label="Clear search" tooltip={false} onClick={() => {setSearch(''); searchInput.current?.focus();}}><IconClose size={14} /></IconButton> : undefined} />
  );
  const titleBlock = (
    <div className="dz-files-title-block">
      {team && (
        <div className="dz-files-eyebrow">
          <span className="dz-files-eyebrow-name">{team.name}</span>
          <span className="dz-files-eyebrow-role">{DESIGN_TEAM_ROLE_LABELS[team.role]}</span>
          <IconButton label="Team" tooltip={false} {...teamMenu.triggerProps}><IconMore /></IconButton>
          {teamMenu.element}
        </div>
      )}
      <h1 className="dz-files-title">{title}</h1>
    </div>
  );
  const sidebar = (
    <Sidebar sections={allSections} view={view} onView={phone ? chooseView : changeView} onBack={() => requestNavigation({kind: 'sign-out'})} search={phone ? undefined : searchField} drop={sidebarDrop}
      starred={<Starred favourites={stars.favourites} view={view} onView={phone ? chooseView : changeView} onOpenFile={fileId => requestNavigation({kind: 'design', fileId})}
        dragging={dragged.length > 0} onDropFiles={starDragged} />}
      sectionActions={workspace.sectionActions} footer={workspace.footer} assistants={<AssistantsEntry />} />
  );
  // "New board" and "New file": in the top bar on a desktop, in a bar at the bottom of a phone, a thumb's reach away.
  const creation = editable && !trash ? (
    <>
      <NewBoardButton target={target} />
      <NewFileMenu target={target} />
    </>
  ) : null;
  return (
    <div className="dz-files-app">
      {phone ? <Drawer open={drawer} onClose={closeDrawer}>{sidebar}</Drawer> : sidebar}
      <main className="dz-files-main" aria-label={team ? `${team.name}: ${title}` : title} {...dropProps}>
        <header className="dz-files-top">
          {!phone && titleBlock}
          {phone && <IconButton label="Sections" tooltip={false} className="dz-files-drawer-button" aria-expanded={drawer} onClick={() => setDrawer(true)}><IconMenu /></IconButton>}
          <Select size={32} className="dz-files-switcher" aria-label="Workspace" value={team?.id ?? 'personal'} options={switcherOptions}
            onChange={value => value === 'create' ? workspace.createTeam() : changeView(value === 'personal' ? {kind: 'recent'} : {kind: 'team', teamId: value, projectId: null})} />
          {phone && searchField}
          <div className="dz-files-actions">
            <SupportButton />
            {personal && (
              <>
                <Button size={32} {...importMenu.triggerProps}>
                  Import<IconChevronDown size={12} />
                </Button>
                {importMenu.element}
              </>
            )}
            {team && (
              <Button size={32} icon={<IconTeam />} className="dz-files-members" aria-label="Members" onClick={() => workspace.openMembers(team.id)}>Members</Button>
            )}
            {!phone && creation}
          </div>
        </header>

        <div className="dz-files-heading">
          <div className="dz-files-heading-text">
            {phone && titleBlock}
            {trash && limits && <p className="dz-files-subtitle">Files are deleted permanently {limits.trashDays} days after they are moved to the trash.</p>}
            {team && !editable && !trash && <p className="dz-files-subtitle">You can open, view and export the team's files. Editors can change them.</p>}
            {sharedView && <p className="dz-files-subtitle">Files that were shared with you. To share one of your own files, click Share in the editor.</p>}
          </div>
          {ready && ready.files.length > 0 && (
            <div className="dz-files-view-controls">
              <Select aria-label="File type" appearance="quiet" value={kind} options={KIND_OPTIONS} onChange={setKind} />
              {view.kind !== 'viewed' && <Select aria-label="Sort" appearance="quiet" value={sort} options={trash ? TRASH_SORT_OPTIONS : SORT_OPTIONS} onChange={setSort} />}
              <SegmentedControl aria-label="View" value={mode} options={MODE_OPTIONS} onChange={setMode} />
            </div>
          )}
        </div>

        {!online && (
          <div className="dz-banner is-offline" role="status">
            <IconOffline aria-hidden="true" />
            <span>No internet connection. Files will update when the network is back.</span>
          </div>
        )}

        {/* A click on the empty space between files clears the selection, as Figma's. */}
        {projectMatches.length > 0 && (
          <section className="dz-files-projects" aria-label="Projects">
            <h2 className="dz-files-projects-title">Projects</h2>
            <ul className="dz-files-projects-list">
              {projectMatches.map(match => (
                <li key={match.projectId}>
                  <button type="button" className="dz-files-project" onClick={() => {
                    setSearch('');
                    changeView({kind: 'team', teamId: match.teamId, projectId: match.projectId});
                  }}>
                    <IconFolder /><span className="dz-files-project-name">{match.name}</span><span className="dz-files-project-team">{match.teamName}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
        <div className="dz-files-content" {...(phone ? {} : marquee.handlers)} onClick={event => {
          if (marquee.consumeDrag()) return;
          if (!(event.target as Element).closest('.dz-file, button, a, input')) clearSelection();
        }}>
          {marquee.box && <div className="dz-marquee" aria-hidden="true" style={{left: marquee.box.left, top: marquee.box.top, width: marquee.box.right - marquee.box.left, height: marquee.box.bottom - marquee.box.top}} />}
          {state.status === 'loading' && <FilesSkeleton mode={mode} />}
          {state.status === 'error' && (state.unavailable ? (
            <EmptyState icon={<IconFile />} title="Design is not available yet" actions={<Button size={32} onClick={() => requestNavigation({kind: 'sign-out'})}>Sign out</Button>}>
              The tool is not open for your account yet.
            </EmptyState>
          ) : (
            <EmptyState tone="error" icon={<IconOffline />} title="Could not load files" actions={<Button size={32} variant="primary" onClick={refresh}>Retry</Button>}>
              {errorText(state.error)}
            </EmptyState>
          ))}
          {ready && ready.files.length === 0 && (sharedView ? (
            <EmptyState icon={<IconTeam />} title="Nobody has shared a file with you yet">
              When someone shares a file with you or you open a file by its link, it will appear here.
            </EmptyState>
          ) : view.kind === 'viewed' ? (
            <EmptyState icon={<IconClock />} title="You have not opened any files in this browser yet">
              Files you have opened will appear here, from your personal, team and shared files.
            </EmptyState>
          ) : trash ? (
            <EmptyState icon={<IconTrash />} title="Trash is empty">Deleted files are kept here for {limits?.trashDays ?? DESIGN_LIMITS.trashDays} days.</EmptyState>
          ) : team ? (
            <EmptyState icon={view.kind === 'team' && view.projectId ? <IconFolder /> : <IconTeam />} title={view.kind === 'team' && view.projectId ? 'No files in this project yet' : 'This team has no files yet'} actions={
              editable ? (
                <>
                  <Button size={32} variant="primary" icon={<IconPlus />} busy={creating} onClick={() => void create()}>New file</Button>
                  <NewBoardButton target={target} />
                </>
              ) : undefined
            }>
              {editable ? 'Create a file here or move a personal one: use Move to team in its menu.' : 'When editors create files, they will appear here.'}
            </EmptyState>
          ) : (
            <EmptyState icon={<IconFile />} title="Your files will be here" actions={
              <>
                <Button size={32} variant="primary" icon={<IconPlus />} busy={creating} onClick={() => void create()}>New file</Button>
                <NewBoardButton target={target} />
                {portableAvailable() && <Button size={32} icon={<IconFileOpen />} onClick={() => fileInput.current?.click()}>Open .rdesign</Button>}
              </>
            }>
              Create your first design or board{portableAvailable() ? ', or drop an .rdesign file here' : ''}.
            </EmptyState>
          ))}
          {ready && ready.files.length > 0 && visible.length === 0 && (search.trim() ? (
            <EmptyState icon={<IconSearch />} title="Nothing found" actions={<Button size={32} onClick={() => setSearch('')}>Clear search</Button>}>
              No files with "{search.trim()}" in their name.
            </EmptyState>
          ) : (
            <EmptyState icon={<IconFile />} title={kind === 'board' ? 'No boards here' : 'No design files here'} actions={<Button size={32} onClick={() => setKind('all')}>Show all files</Button>}>
              The filter "{KIND_OPTIONS.find(option => option.value === kind)!.label}" is on.
            </EmptyState>
          ))}
          {ready && visible.length > 0 && (
            <FileGrid files={visible} mode={mode} trash={trash} selectedId={selectedId} selectedIds={selection.ids} touchSelecting={touchSelecting} onSelect={select} onSelectAll={selectEvery} onClearSelection={clearSelection} sort={shownSort} onSort={view.kind === 'viewed' ? undefined : setSort} onDragFiles={phone ? undefined : dragFiles} onDragEnd={endDrag} starred={id => stars.isStarred('files', id)} onStar={sharedInfo ? undefined : toggleStar} onOpen={open} onMenu={showMenu}
              renamingId={renamingId} onRenameStart={startRename} onRename={rename} onRenameEnd={endRename} onTrash={trashFromGrid} now={now} describe={describeShared} />
          )}
        </div>

        {phone && creation && <div className="dz-files-bar">{creation}</div>}
        {dragging && (
          <div className="dz-drop" aria-hidden="true">
            <div className="dz-drop-card"><IconFileOpen size={20} /><span>Drop to open the .rdesign file</span></div>
          </div>
        )}
        <input ref={fileInput} type="file" accept=".rdesign" multiple hidden onChange={event => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = '';
          void openPortable(files);
        }} />
      </main>
      {context.element}
      {workspace.element}
      {dialog?.kind === 'share' && (
        <Suspense fallback={null}>
          <ShareDialog fileId={dialog.file.id} fileName={dialog.file.name} kind={dialog.file.kind === 'board' ? 'board' : 'design'} access={accessOf(dialog.file)}
            link={fileUrl(dialog.file.id)} onClose={() => setDialog(null)} />
        </Suspense>
      )}
      {dialog?.kind === 'erase-many' && <EraseManyDialog count={dialog.files.length} onClose={() => setDialog(null)} onConfirm={() => eraseMany(dialog.files)} />}
      {dialog?.kind === 'erase' && <EraseDialog name={dialog.file.name} onClose={() => setDialog(null)} onConfirm={() => erase(dialog.file)} />}
      {dialog?.kind === 'figma' && (FigmaImport
        ? <Suspense fallback={null}><FigmaImport onClose={() => {setDialog(null); refresh();}} onImported={(fileId: string) => {setDialog(null); requestNavigation({kind: 'design', fileId});}} /></Suspense>
        : <FigmaImportUnavailable onClose={() => setDialog(null)} />)}
    </div>
  );
}

function FilesSkeleton({mode}: {mode: 'grid' | 'list'}) {
  return (
    <ul className={`dz-files is-${mode} is-skeleton`} aria-label="Loading files" aria-busy="true">
      {Array.from({length: mode === 'grid' ? 8 : 6}, (_, index) => (
        <li key={index} className="dz-file" style={{'--i': index} as CSSProperties}>
          <div className="dz-file-thumb" />
          <div className="dz-file-meta"><span className="dz-skeleton-bar" style={{width: '62%'}} /><span className="dz-skeleton-bar" style={{width: '38%'}} /></div>
        </li>
      ))}
    </ul>
  );
}
