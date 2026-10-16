import type {DesignTeamSummary} from '../../../shared/design/teams';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {TeamPeople} from './People';

// "Members" (docs/design-tool.md §Teams): who is in the team and with which role, and how to bring more people in — by a link. The editor's "Share" shows the same (src/design/teams/ShareDialog.tsx).

export function MembersDialog({team, onClose, onChanged}: {
  team: DesignTeamSummary;
  onClose: () => void;
  /** Roles or members changed: the browser reads the team again (the caller's own role after a handover). */
  onChanged: () => void;
}) {
  return (
    <Dialog title={`Members · ${team.name}`} onClose={onClose} width={520} className="dz-team-dialog dz-members" dismissible={false}
      footer={<Button size={32} variant="primary" onClick={onClose} data-autofocus>Done</Button>}>
      <TeamPeople team={team} onChanged={onChanged} />
    </Dialog>
  );
}
