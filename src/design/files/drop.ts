import {canEditTeamFiles, canManageTeam, type DesignTeamSummary} from '../../../shared/design/teams';
import type {BrowserView} from './sidebar';

// Files dragged onto a place in the sidebar (docs/figma-parity-shell.md, "Drag a file onto a project"), as Figma's: onto a
// team's project or "All files" they move there, onto "Recent" back to personal files, onto a "Trash" into the trash. Only
// where every dragged file may go, by the same rules as "Move" (bulk.tsx); anywhere else the drop is refused.

type Dragged = {teamId?: string | null; projectId?: string | null};
type Team = Pick<DesignTeamSummary, 'id' | 'name' | 'role' | 'projects'>;

export type DropAction = {kind: 'move'; teamId: string | null; projectId: string | null; where: string} | {kind: 'trash'};

const quoted = (name: string) => `"${name}"`;

export function dropAction(files: readonly Dragged[], view: BrowserView, teams: readonly Team[]): DropAction | null {
  if (!files.length) return null;
  const sources = new Set(files.map(file => file.teamId ?? null));
  if (sources.size !== 1) return null;
  const from = files[0].teamId ?? null;
  const source = from ? teams.find(team => team.id === from) ?? null : null;
  if (from && !source) return null;
  const manages = !source || canManageTeam(source.role);
  if (view.kind === 'trash') return !from ? {kind: 'trash'} : null;
  if (view.kind === 'team-trash') return from === view.teamId && manages ? {kind: 'trash'} : null;
  if (view.kind === 'recent') return from && manages ? {kind: 'move', teamId: null, projectId: null, where: 'to personal files'} : null;
  if (view.kind !== 'team') return null;
  const target = teams.find(team => team.id === view.teamId);
  if (!target) return null;
  const project = view.projectId ? target.projects.find(entry => entry.id === view.projectId) : null;
  if (view.projectId && !project) return null;
  const where = project ? `to the project ${quoted(project.name)}` : from === target.id ? 'out of any project' : `to the team ${quoted(target.name)}`;
  if (from === target.id) {
    if (!canEditTeamFiles(target.role)) return null;
    if (files.every(file => (file.projectId ?? null) === (view.projectId ?? null))) return null;
    return {kind: 'move', teamId: target.id, projectId: view.projectId, where};
  }
  // Into a team from personal files: its managers only (as "Move to team").
  if (from || !canManageTeam(target.role)) return null;
  return {kind: 'move', teamId: target.id, projectId: view.projectId, where};
}

/** The drag's own type: files from this browser, not files from the computer. */
export const FILES_DRAG_TYPE = 'application/x-morfa-files';
