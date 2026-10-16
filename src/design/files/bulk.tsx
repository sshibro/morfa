import type {DesignFileSummary} from '../../../shared/design/api';
import {canEditTeamFiles, canManageTeam, type DesignTeamSummary} from '../../../shared/design/teams';
import {IconCopy, IconFolder, IconGrid, IconLeave, IconRestore, IconTeam, IconTrash, IconUser} from '../ui/icons';
import type {MenuItem} from '../ui/menu-model';
import {quoted} from '../teams/model';
import {plural} from './format';

// The menu of several selected files (docs/figma-parity-shell.md, "Several files selected"), as Figma's "Move [X] files": what
// every selected file allows, each row naming how many it acts on. The actions themselves are the browser's (FileBrowser.tsx).

/** "1 file", "5 files". */
export const filesCount = (count: number) => `${count} ${plural(count, 'file', 'files')}`;

/** Where a move sends the files: a team and project, or personal files (`teamId` null), and how the toast says it. */
export type MoveTarget = {teamId: string | null; projectId: string | null; where: string};

export type BulkActions = {
  duplicate: (files: DesignFileSummary[]) => void;
  move: (files: DesignFileSummary[], target: MoveTarget) => void;
  trash: (files: DesignFileSummary[]) => void;
  restore: (files: DesignFileSummary[]) => void;
  erase: (files: DesignFileSummary[]) => void;
  leave: (files: DesignFileSummary[]) => void;
};

type Rights = {canEdit: boolean; canManage: boolean};

const rightsOf = (file: DesignFileSummary, teams: readonly DesignTeamSummary[]): Rights => {
  if (!file.teamId) return {canEdit: true, canManage: true};
  const team = teams.find(entry => entry.id === file.teamId);
  return {canEdit: !!team && canEditTeamFiles(team.role), canManage: !!team && canManageTeam(team.role)};
};

/** The places every one of the files may move to: one team's projects (and personal files for its managers), or, for
 *  personal files only, the teams the caller manages. Files from different places have no common move. */
function movePlaces(files: DesignFileSummary[], teams: readonly DesignTeamSummary[], go: (target: MoveTarget) => void): MenuItem[] {
  const teamIds = new Set(files.map(file => file.teamId ?? null));
  if (teamIds.size !== 1) return [];
  const teamId = files[0].teamId ?? null;
  if (!teamId) {
    return teams.filter(team => canManageTeam(team.role)).map((team): MenuItem => ({
      id: 'move-' + team.id, label: team.name, icon: <IconTeam />, onSelect: () => go({teamId: team.id, projectId: null, where: `to the team ${quoted(team.name)}`}),
    }));
  }
  const owner = teams.find(team => team.id === teamId);
  if (!owner || !canEditTeamFiles(owner.role)) return [];
  const places: MenuItem[] = [
    {id: 'move-none', label: 'No project', icon: <IconGrid />, onSelect: () => go({teamId, projectId: null, where: 'out of any project'})},
    ...owner.projects.map((project): MenuItem => ({id: 'move-' + project.id, label: project.name, icon: <IconFolder />,
      onSelect: () => go({teamId, projectId: project.id, where: `to the project ${quoted(project.name)}`})})),
  ];
  if (canManageTeam(owner.role)) places.push({type: 'separator'}, {id: 'move-personal', label: 'To personal files', icon: <IconUser />, onSelect: () => go({teamId: null, projectId: null, where: 'to personal files'})});
  return places;
}

/** The rows for `files` (two or more), in Figma's order: duplicate and move, then the trash. `shared`: "Shared with me". */
export function bulkMenuItems(files: DesignFileSummary[], options: {teams: readonly DesignTeamSummary[]; trash: boolean; shared: boolean; actions: BulkActions}): MenuItem[] {
  const {teams, trash, shared, actions} = options;
  const count = filesCount(files.length);
  const heading: MenuItem = {type: 'label', label: `Selected: ${count}`};
  if (shared) return [heading, {id: 'leave', label: `Remove from Shared with me: ${count}`, icon: <IconLeave />, danger: true, onSelect: () => actions.leave(files)}];
  const rights = files.map(file => rightsOf(file, teams));
  const canEdit = rights.every(entry => entry.canEdit);
  const canManage = rights.every(entry => entry.canManage);
  if (trash) {
    if (!canManage) return [heading, {type: 'label', label: 'Only the team owner and admins can restore files'}];
    return [
      heading,
      {id: 'restore', label: `Restore ${count}`, icon: <IconRestore />, onSelect: () => actions.restore(files)},
      {type: 'separator'},
      {id: 'erase', label: `Delete permanently ${count}`, icon: <IconTrash />, danger: true, onSelect: () => actions.erase(files)},
    ];
  }
  const places = canEdit ? movePlaces(files, teams, target => actions.move(files, target)) : [];
  const personal = !files[0].teamId;
  return [
    heading,
    ...(canEdit ? [{id: 'duplicate', label: `Duplicate ${count}`, icon: <IconCopy />, onSelect: () => actions.duplicate(files)} as MenuItem] : []),
    ...(places.length ? [{type: 'submenu', id: 'move', label: `${personal ? 'Move to team' : 'Move'} ${count}`, icon: personal ? <IconTeam /> : <IconFolder />, items: places} as MenuItem] : []),
    ...(canManage ? [{type: 'separator'} as MenuItem, {id: 'trash', label: `Move ${count} to trash`, icon: <IconTrash />, danger: true, onSelect: () => actions.trash(files)} as MenuItem] : []),
  ];
}
