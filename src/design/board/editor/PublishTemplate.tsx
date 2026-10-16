import {useState} from 'react';
import {Button} from '../../ui/Button';
import {Dialog} from '../../ui/Dialog';
import {SegmentedControl} from '../../ui/Tabs';
import {TextInput} from '../../ui/TextInput';
import {ApiError} from '../../../api';
import {TEAM_TEMPLATE_CAPS, type DesignTemplateScope} from '../../../../shared/design/team-templates';
import {useEditorServices, type EditorDialogProps} from '../../editor/services';
import {publishTemplate} from '../team-templates';

// "Publish as template…" (help.figma.com "Create custom templates in FigJam": Share → Publish template): the board's first page
// becomes a template its team inserts from the "+" sheet. A second publish sends the board's changes as the template's next
// version. There is no unpublish (FigJam has none).

const SCOPES = [{value: 'team', label: 'Team'}, {value: 'organization', label: 'All of my teams'}] as const;

function failure(error: unknown): string {
  if (error instanceof ApiError) {
    const code = (error.details as {code?: string; limit?: number} | undefined)?.code;
    const limit = (error.details as {limit?: number} | undefined)?.limit;
    if (code === 'design_template_limit' && limit) return `The team already has ${limit} templates, the most it can have.`;
    if (code === 'design_document_too_large') return 'The board is too large for a template: keep less on the first page.';
    if (error.message) return error.message;
  }
  return 'Could not publish the template. Try again.';
}

export function PublishTemplateDialog({onClose, name}: EditorDialogProps & {name: () => string}) {
  const services = useEditorServices();
  const [title, setTitle] = useState(() => name().slice(0, TEAM_TEMPLATE_CAPS.name));
  const [description, setDescription] = useState('');
  const [scope, setScope] = useState<DesignTemplateScope>('team');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const publish = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      // The server reads the board at a saved version: save first.
      await services.persistence?.flush();
      const send = () => publishTemplate(services.fileId, {baseVersion: services.persistence?.version() ?? 0, name: title.trim(), description: description.trim() || undefined, scope});
      try {
        await send();
      } catch (first) {
        if (!(first instanceof ApiError) || (first.details as {code?: string} | undefined)?.code !== 'version_conflict') throw first;
        await services.persistence?.flush();
        await send();
      }
      services.toast(`Template "${title.trim()}" published`, 'success');
      onClose();
    } catch (caught) {
      setError(failure(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog title="Publish as template" onClose={onClose} width={420} className="bd-publish" dismissible={!busy} footer={
      <>
        <Button size={32} onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size={32} variant="primary" busy={busy} disabled={!title.trim()} onClick={() => void publish()}>Publish</Button>
      </>
    }>
      <div className="bd-export-rows">
        <p className="bd-export-note">The first page of the board becomes a template: it can be added from "+" on any board of the team. Later changes to the board are published again; a template cannot be withdrawn.</p>
        <label className="bd-publish-field"><span>Name</span>
          <TextInput value={title} onChange={setTitle} maxLength={TEAM_TEMPLATE_CAPS.name} aria-label="Template name" size={32} />
        </label>
        <label className="bd-publish-field"><span>Description</span>
          <TextInput value={description} onChange={setDescription} maxLength={TEAM_TEMPLATE_CAPS.description} aria-label="Template description" size={32} placeholder="What it is for and how to use it" />
        </label>
        <div className="bd-export-row"><span>Available to</span>
          <SegmentedControl options={SCOPES} value={scope} onChange={value => setScope(value)} aria-label="Who can use the template" />
        </div>
        {error && <p className="bd-export-note is-error" role="alert">{error}</p>}
      </div>
    </Dialog>
  );
}
