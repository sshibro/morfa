import {useCallback, useEffect, useRef, useState} from 'react';
import {ApiError} from '../../api';
import {DESIGN_FILES_CHANGED_EVENT, listDesignFiles, listSharedDesignFiles} from '../api';
import type {DesignFileSummary, DesignUsage} from '../../../shared/design/api';
import type {DesignLimits} from '../../../shared/design/limits';
import type {DesignSharedFile} from '../../../shared/design/teams';
import {isTrashView, viewKey, type BrowserView} from './sidebar';
import {viewedTimes} from './viewed';

export type FilesState =
  | {status: 'loading'}
  | {status: 'error'; error: unknown; unavailable: boolean}
  | {
      status: 'ready';
      files: DesignFileSummary[];
      /** Null in "Shared with me": the files there count against their owners' storage. */
      usage: DesignUsage | null;
      limits: DesignLimits | null;
      refreshing: boolean;
      /** "Shared with me": whose each file is, what the caller may do, and which wait for their first opening. */
      shared?: ReadonlyMap<string, DesignSharedFile>;
    };

/** The server says the product is off for this account (ENABLE_DESIGN_TOOL / DESIGN_TOOL_ACCOUNTS). */
export const isUnavailable = (error: unknown) =>
  error instanceof ApiError && (error.details?.code === 'design_unavailable' || (error.status === 404 && !error.details?.code));

/** At most this many files in "Recently viewed". */
export const VIEWED_SHOWN = 50;

/** "Recently viewed": the files of every place the caller sees (its own, shared with it, each team's) that this browser opened,
 *  newest opening first, through the same list reads as the other views. The limits and usage are the personal files'. */
async function listViewed(teamIds: readonly string[], signal: AbortSignal) {
  const opened = viewedTimes();
  const [own, shared, ...teams] = await Promise.all([
    listDesignFiles({signal}),
    listSharedDesignFiles(signal).then(answer => answer.files as DesignFileSummary[], () => []),
    ...teamIds.map(team => listDesignFiles({team, signal}).then(answer => answer.files, () => [] as DesignFileSummary[])),
  ]);
  const byId = new Map<string, DesignFileSummary>();
  for (const file of [...own.files, ...shared, ...teams.flat()]) if (opened.has(file.id) && !file.trashedAt && !byId.has(file.id)) byId.set(file.id, file);
  const files = [...byId.values()].sort((a, b) => opened.get(b.id)! - opened.get(a.id)!).slice(0, VIEWED_SHOWN);
  return {files, usage: own.usage, limits: own.limits};
}

/**
 * The listing of one browser view (the caller's own files, or a team's: docs/design-tool.md §Teams), refreshed on demand. Changes made here (rename, trash, duplicate)
 * update the list at once through `update`, then a quiet refresh brings usage and order up to date.
 */
export function useDesignFiles(view: BrowserView, teamIds: readonly string[] = []) {
  const [state, setState] = useState<FilesState>({status: 'loading'});
  const [revision, setRevision] = useState(0);
  const shownView = useRef<string>('');
  // Local changes made through `update`, counted: a listing asked for before one of them is older than the list it would replace.
  const edits = useRef(0);
  const teamsKey = view.kind === 'viewed' ? teamIds.join(',') : '';
  const key = viewKey(view) + (teamsKey ? ':' + teamsKey : '');
  const team = view.kind === 'team' || view.kind === 'team-trash' ? view.teamId : undefined;
  const project = view.kind === 'team' ? view.projectId ?? undefined : undefined;
  const trash = isTrashView(view);

  useEffect(() => {
    const controller = new AbortController();
    const editsAtStart = edits.current;
    // Same view refreshed: keep showing the list. Another view: a fresh skeleton.
    setState(current => (current.status === 'ready' && shownView.current === key ? {...current, refreshing: true} : {status: 'loading'}));
    const listing =
      view.kind === 'viewed'
        ? listViewed(teamsKey ? teamsKey.split(',') : [], controller.signal)
        : view.kind === 'shared'
        ? listSharedDesignFiles(controller.signal).then(answer => ({files: answer.files as DesignFileSummary[], usage: null, limits: null, shared: new Map(answer.files.map(file => [file.id, file]))}))
        : listDesignFiles({trash, team, project, signal: controller.signal});
    listing
      .then(answer => {
        if (controller.signal.aborted) return;
        // A change made here while this listing was on its way (the second of two quick Deletes) is newer than the answer, which would
        // bring the trashed file back for a moment and take the keyboard's focus with it: ask again instead.
        if (edits.current !== editsAtStart && shownView.current === key) return setRevision(value => value + 1);
        shownView.current = key;
        setState({status: 'ready', refreshing: false, ...answer});
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        setState(current => (current.status === 'ready' && shownView.current === key ? {...current, refreshing: false} : {status: 'error', error, unavailable: isUnavailable(error)}));
      });
    return () => controller.abort();
  }, [key, revision]);

  const refresh = useCallback(() => setRevision(value => value + 1), []);
  // A file restored elsewhere (the editor's "Undo" after its "Move to trash") is read again here.
  useEffect(() => {
    window.addEventListener(DESIGN_FILES_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(DESIGN_FILES_CHANGED_EVENT, refresh);
  }, [refresh]);
  const update = useCallback((change: (files: DesignFileSummary[]) => DesignFileSummary[]) => {
    edits.current += 1;
    setState(current => (current.status === 'ready' ? {...current, files: change(current.files)} : current));
  }, []);
  return {state, refresh, update};
}
