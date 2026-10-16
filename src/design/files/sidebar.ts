import type {DesignTeamSummary} from '../../../shared/design/teams';
import {IconClock, IconFile, IconFolder, IconGrid, IconTeam, IconTrash, type IconComponent} from '../ui/icons';

// The file browser's sidebar is data: sections of places. The designer's own files ("Recent",
// "Trash") come first; each team they belong to adds a section (docs/design-tool.md §Teams) titled
// with its name: all its files, one place per project, and its trash. The sidebar and the browser
// render whatever sections they are given.

export type BrowserView =
  /** "Recently viewed", Figma's "Recents": the files opened in this browser lately, from every place (viewed.ts). */
  | {kind: 'viewed'}
  | {kind: 'recent'}
  /** "Shared with me": files other people shared with the caller (docs/design-tool.md §Teams, "File access"). */
  | {kind: 'shared'}
  | {kind: 'trash'}
  /** A team's files; `projectId` narrows them to one project. */
  | {kind: 'team'; teamId: string; projectId: string | null}
  | {kind: 'team-trash'; teamId: string};

export type SidebarItem = {id: string; label: string; icon: IconComponent; view: BrowserView};
export type SidebarSection = {
  id: string;
  title?: string;
  items: SidebarItem[];
  /** The team a section shows, for its header's actions. */
  teamId?: string;
};

export const PERSONAL_SECTIONS: SidebarSection[] = [
  {id: 'personal', items: [
    {id: 'viewed', label: 'Recently viewed', icon: IconClock, view: {kind: 'viewed'}},
    {id: 'recent', label: 'Recent', icon: IconFile, view: {kind: 'recent'}},
    {id: 'shared', label: 'Shared with me', icon: IconTeam, view: {kind: 'shared'}},
    {id: 'trash', label: 'Trash', icon: IconTrash, view: {kind: 'trash'}},
  ]},
];

/** One section per team: "All files", its projects in name order, "Trash". */
export function teamSections(teams: readonly Pick<DesignTeamSummary, 'id' | 'name' | 'projects'>[]): SidebarSection[] {
  return teams.map(team => ({
    id: 'team:' + team.id,
    title: team.name,
    teamId: team.id,
    items: [
      {id: `team:${team.id}:all`, label: 'All files', icon: IconGrid, view: {kind: 'team', teamId: team.id, projectId: null}},
      ...team.projects.map((project): SidebarItem => ({
        id: `team:${team.id}:${project.id}`,
        label: project.name,
        icon: IconFolder,
        view: {kind: 'team', teamId: team.id, projectId: project.id},
      })),
      {id: `team:${team.id}:trash`, label: 'Trash', icon: IconTrash, view: {kind: 'team-trash', teamId: team.id}},
    ],
  }));
}

export const viewKey = (view: BrowserView): string =>
  view.kind === 'team' ? `team:${view.teamId}:${view.projectId ?? 'all'}` : view.kind === 'team-trash' ? `team-trash:${view.teamId}` : view.kind;
export const isTrashView = (view: BrowserView) => view.kind === 'trash' || view.kind === 'team-trash';
export const teamOfView = (view: BrowserView): string | null => (view.kind === 'team' || view.kind === 'team-trash' ? view.teamId : null);

export const VIEW_TITLES: Record<'viewed' | 'recent' | 'shared' | 'trash', string> = {viewed: 'Recently viewed', recent: 'Recent', shared: 'Shared with me', trash: 'Trash'};
/** The heading of a view: a team's views name the team (and the project). */
export function viewTitle(view: BrowserView, teams: readonly Pick<DesignTeamSummary, 'id' | 'name' | 'projects'>[]): string {
  if (view.kind === 'viewed' || view.kind === 'recent' || view.kind === 'shared' || view.kind === 'trash') return VIEW_TITLES[view.kind];
  const team = teams.find(entry => entry.id === view.teamId);
  if (!team) return 'Team';
  if (view.kind === 'team-trash') return 'Trash';
  return (view.projectId && team.projects.find(project => project.id === view.projectId)?.name) || 'All files';
}

/** The view a stored key names, when it still exists (the browser comes back to the last place after the editor). */
export function viewFromKey(key: string | null, teams: readonly Pick<DesignTeamSummary, 'id' | 'projects'>[]): BrowserView | null {
  if (key === 'viewed' || key === 'recent' || key === 'shared' || key === 'trash') return {kind: key};
  const match = key?.match(/^team(-trash)?:([0-9a-f-]{36})(?::(all|[0-9a-f-]{36}))?$/);
  if (!match) return null;
  const team = teams.find(entry => entry.id === match[2]);
  if (!team) return null;
  if (match[1]) return {kind: 'team-trash', teamId: team.id};
  const projectId = match[3] && match[3] !== 'all' ? match[3] : null;
  if (projectId && !team.projects.some(project => project.id === projectId)) return {kind: 'team', teamId: team.id, projectId: null};
  return {kind: 'team', teamId: team.id, projectId};
}
