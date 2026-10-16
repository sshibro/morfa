import '../styles/teams.css';
import {useCallback, useMemo, useState, type ReactNode} from 'react';
import {canManageTeam, type DesignInviteAccepted, type DesignTeamSummary} from '../../../shared/design/teams';
import {IconButton, Button} from '../ui/Button';
import {IconFolderPlus, IconMore, IconPlus, IconRename, IconSettings, IconTeam, IconTrash} from '../ui/icons';
import {useMenuTrigger} from '../ui/Menu';
import type {MenuItem} from '../ui/menu-model';
import {useToast} from '../ui/Toast';
import type {BrowserView, SidebarSection} from '../files/sidebar';
import {createDesignProject, createDesignTeam, deleteDesignProject, renameDesignProject} from './api';
import {InviteDialog} from './InviteDialog';
import {MembersDialog} from './MembersDialog';
import {ConfirmDialog, NameDialog, TeamSettingsDialog} from './TeamDialogs';
import {useDesignTeams} from './useDesignTeams';
import {quoted} from './model';
import {useInviteToken} from './useInvite';

// The file browser's team side (docs/design-tool.md §Teams): the teams list, each team section's "+ Project" and menu, "Create
// team", the dialogs they open and the invite landing. FileBrowser renders what this returns; the files of a team view are its own.

type Dialog =
  | null
  | {kind: 'create-team'}
  | {kind: 'new-project'; teamId: string}
  | {kind: 'rename-project'; teamId: string; projectId: string; name: string}
  | {kind: 'delete-project'; teamId: string; projectId: string; name: string}
  | {kind: 'members'; teamId: string}
  | {kind: 'settings'; teamId: string};

export type TeamWorkspace = {
  teams: DesignTeamSummary[];
  /** The caller's teams have been read at least once (until then a team view cannot be judged gone). */
  loaded: boolean;
  /** The server no longer lets the caller into a team (removed, the team deleted): it leaves the list at once. */
  forget(teamId: string): void;
  /** The team a view shows, when it is one the caller is still in. */
  teamOf(view: BrowserView): DesignTeamSummary | null;
  refresh(): void;
  sectionActions(section: SidebarSection): ReactNode;
  footer: ReactNode;
  /** The dialogs and the invite landing, rendered once by the browser. */
  element: ReactNode;
  openMembers(teamId: string): void;
  openSettings(teamId: string): void;
  createTeam(): void;
  newProject(teamId: string): void;
  renameProject(teamId: string, projectId: string): void;
  deleteProject(teamId: string, projectId: string): void;
};

export function useTeamWorkspace({onView, view}: {onView: (view: BrowserView) => void; view: BrowserView}): TeamWorkspace {
  const toast = useToast();
  const state = useDesignTeams();
  const teams = useMemo(() => state.teams ?? [], [state.teams]);
  const invite = useInviteToken();
  const [dialog, setDialog] = useState<Dialog>(null);
  const close = useCallback(() => setDialog(null), []);
  const teamById = useCallback((id: string) => teams.find(team => team.id === id) ?? null, [teams]);
  const teamOf = useCallback(
    (shown: BrowserView) => (shown.kind === 'team' || shown.kind === 'team-trash' ? teamById(shown.teamId) : null),
    [teamById],
  );

  const projectName = (teamId: string, projectId: string) => teamById(teamId)?.projects.find(project => project.id === projectId)?.name ?? '';
  const workspace: TeamWorkspace = {
    teams,
    loaded: state.teams !== null,
    forget: state.remove,
    teamOf,
    refresh: state.refresh,
    sectionActions: section => {
      const team = section.teamId ? teamById(section.teamId) : null;
      return team ? <TeamSectionActions team={team} onDialog={setDialog} /> : null;
    },
    footer: (
      <>
        <Button variant="ghost" icon={<IconPlus />} className="dz-files-place dz-team-create" onClick={() => setDialog({kind: 'create-team'})}>
          Create team
        </Button>
      </>
    ),
    element: null,
    openMembers: teamId => setDialog({kind: 'members', teamId}),
    openSettings: teamId => setDialog({kind: 'settings', teamId}),
    createTeam: () => setDialog({kind: 'create-team'}),
    newProject: teamId => setDialog({kind: 'new-project', teamId}),
    renameProject: (teamId, projectId) => setDialog({kind: 'rename-project', teamId, projectId, name: projectName(teamId, projectId)}),
    deleteProject: (teamId, projectId) => setDialog({kind: 'delete-project', teamId, projectId, name: projectName(teamId, projectId)}),
  };

  const joined = async (answer: DesignInviteAccepted) => {
    // The list holds the team before the view shows it: a team view the list does not know falls back to personal files.
    await state.reload();
    invite.clear();
    onView({kind: 'team', teamId: answer.team.id, projectId: null});
    if (answer.joined) toast(`You are in the team ${quoted(answer.team.name)}`, {kind: 'success'});
  };
  const shownTeam = dialog && 'teamId' in dialog ? teamById(dialog.teamId) : null;
  workspace.element = (
    <>
      {invite.token && <InviteDialog token={invite.token} onClose={invite.clear} onJoined={joined} />}
      {dialog?.kind === 'create-team' && (
        <NameDialog title="Create team" label="Team name" placeholder="For example, North Studio" submitLabel="Create" onClose={close}
          note="You will be the owner. Invite members with a link and give them roles: editors change files, developers and viewers look."
          onSubmit={async name => {
            const {team} = await createDesignTeam(name);
            state.put(team);
            onView({kind: 'team', teamId: team.id, projectId: null});
            // The next step is people, as in Figma: the new team's "Members" opens with the invite link ready to make.
            setDialog({kind: 'members', teamId: team.id});
          }} />
      )}
      {dialog?.kind === 'new-project' && (
        <NameDialog title="New project" label="Project name" placeholder="For example, Coffee shop website" submitLabel="Create" onClose={close}
          onSubmit={async name => {
            const {project} = await createDesignProject(dialog.teamId, name);
            // The team gets its project at once: the browser drops a view whose project the team does not list, and the refreshed list
            // arrives after the view changes.
            const owner = teamById(dialog.teamId);
            if (owner) state.put({...owner, projects: [...owner.projects.filter(entry => entry.id !== project.id), project]});
            state.refresh();
            close();
            onView({kind: 'team', teamId: dialog.teamId, projectId: project.id});
          }} />
      )}
      {dialog?.kind === 'rename-project' && (
        <NameDialog title="Rename project" label="Project name" initial={dialog.name} submitLabel="Save" onClose={close}
          onSubmit={async name => {
            await renameDesignProject(dialog.teamId, dialog.projectId, name);
            state.refresh();
            close();
          }} />
      )}
      {dialog?.kind === 'delete-project' && (
        <ConfirmDialog title="Delete project?" confirmLabel="Delete" onClose={close} onConfirm={async () => {
          await deleteDesignProject(dialog.teamId, dialog.projectId);
          state.refresh();
          close();
          if (view.kind === 'team' && view.projectId === dialog.projectId) onView({kind: 'team', teamId: dialog.teamId, projectId: null});
          toast(`Project ${quoted(dialog.name)} deleted, its files are in the team trash`);
        }}>
          <p>The files of the project {quoted(dialog.name)} go to the team trash. Once restored, they return to All files.</p>
        </ConfirmDialog>
      )}
      {dialog?.kind === 'members' && shownTeam && <MembersDialog team={shownTeam} onClose={close} onChanged={state.refresh} />}
      {dialog?.kind === 'settings' && shownTeam && (
        <TeamSettingsDialog team={shownTeam} onClose={close} onChanged={state.put} onGone={text => {
          close();
          state.remove(shownTeam.id);
          onView({kind: 'recent'});
          toast(text);
        }} />
      )}
    </>
  );
  return workspace;
}

/** A team section's title row: "New project" for managers, and the team's menu. */
function TeamSectionActions({team, onDialog}: {team: DesignTeamSummary; onDialog: (dialog: Dialog) => void}) {
  const manager = canManageTeam(team.role);
  const items = useCallback((): MenuItem[] => [
    {id: 'members', label: 'Members', icon: <IconTeam />, onSelect: () => onDialog({kind: 'members', teamId: team.id})},
    ...(manager ? [{id: 'project', label: 'New project', icon: <IconFolderPlus />, onSelect: () => onDialog({kind: 'new-project', teamId: team.id})} as MenuItem] : []),
    {type: 'separator'},
    {id: 'settings', label: 'Team settings', icon: <IconSettings />, onSelect: () => onDialog({kind: 'settings', teamId: team.id})},
  ], [team.id, manager, onDialog]);
  const menu = useMenuTrigger({items, label: `Team ${quoted(team.name)}`, placement: 'bottom-end', minWidth: 200});
  return (
    <span className="dz-files-place-actions">
      {manager && (
        <IconButton label="New project" onClick={() => onDialog({kind: 'new-project', teamId: team.id})}><IconFolderPlus /></IconButton>
      )}
      <IconButton label="Team" tooltip={false} {...menu.triggerProps}><IconMore /></IconButton>
      {menu.element}
    </span>
  );
}

/** A project's menu in the browser's heading: rename and delete, for managers. */
export function projectMenuItems(workspace: TeamWorkspace, teamId: string, projectId: string): MenuItem[] {
  return [
    {id: 'rename-project', label: 'Rename project', icon: <IconRename />, onSelect: () => workspace.renameProject(teamId, projectId)},
    {id: 'delete-project', label: 'Delete project', icon: <IconTrash />, danger: true, onSelect: () => workspace.deleteProject(teamId, projectId)},
  ];
}
