import {useEffect, useState} from 'react';
import type {DesignFileLibrary} from '../../../shared/design/api';
import {useEditorServices, type EditorDialogProps} from '../editor/services';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {IconBook} from '../ui/icons';
import {Spinner} from '../ui/Spinner';
import {Toggle} from '../ui/Toggle';
import {count, errorText, manifestSummary, useLibrarySession, useLibraryState} from './hooks';
import {PUBLISH_DIALOG, UPDATES_DIALOG} from './host';

// "Libraries" (docs/design-tool.md §Teams, "Shared libraries"): this file's own library (published, its version, "Publish…",
// "Unpublish") and the libraries of its place — the team's files, or the account's personal files — each with a switch
// that enables it for this file. A file of a team never sees another team's or a member's personal libraries.

const dateFormat = new Intl.DateTimeFormat('en-US', {day: 'numeric', month: 'long', year: 'numeric'});
const dateOf = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
};

export default function LibrariesDialog({onClose}: EditorDialogProps) {
  const services = useEditorServices();
  const session = useLibrarySession(services);
  const state = useLibraryState(session);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unpublishing, setUnpublishing] = useState(false);

  useEffect(() => {
    if (!session) return;
    void session.loadOwn();
    void session.refresh();
  }, [session]);

  const toggle = async (library: DesignFileLibrary, enabled: boolean) => {
    if (!session) return;
    setPending(library.id);
    setError(null);
    try {
      await session.setEnabled(library.id, enabled);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setPending(null);
    }
  };
  const unpublish = async () => {
    if (!session) return;
    setUnpublishing(true);
    setError(null);
    try {
      await session.unpublish();
      services.toast('Library unpublished', 'success');
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setUnpublishing(false);
    }
  };

  const canEdit = !!session?.canEdit;
  const own = state?.own;
  const place = session?.teamName ? `"${session.teamName}" team libraries` : 'Your libraries';
  const libraries = state?.libraries ?? [];
  const updates = state?.updates.length ?? 0;

  return (
    <Dialog title="Libraries" onClose={onClose} width={480} className="dz-libraries">
      <section className="dz-libraries-own" aria-label="This file">
        <span className="dz-libraries-mark" aria-hidden="true"><IconBook /></span>
        <div className="dz-libraries-own-text">
          <span className="dz-libraries-title">This file</span>
          <span className="dz-libraries-meta">
            {own === undefined ? 'Loading…'
              : own === null ? 'Not published as a library.'
              : own.unpublishedAt ? `Unpublished · version ${own.version}`
              : `Published ${dateOf(own.publishedAt)} · version ${own.version} · ${manifestSummary(own.manifest)}`}
          </span>
        </div>
        {canEdit && own !== undefined && (
          <div className="dz-libraries-own-actions">
            {own && !own.unpublishedAt && <Button size={24} variant="ghost" busy={unpublishing} onClick={() => void unpublish()}>Unpublish</Button>}
            <Button size={24} onClick={() => services.openDialog(PUBLISH_DIALOG)}>
              {own && !own.unpublishedAt ? 'Publish changes…' : 'Publish…'}
            </Button>
          </div>
        )}
      </section>

      {updates > 0 && (
        <div className="dz-libraries-updates" role="status">
          <span className="dz-libraries-updates-dot" aria-hidden="true" />
          <span className="dz-libraries-updates-text">Updates available: {count(updates, 'asset', 'assets')}</span>
          <Button size={24} variant="secondary" onClick={() => services.openDialog(UPDATES_DIALOG)}>View</Button>
        </div>
      )}

      <section className="dz-libraries-place" aria-label={place}>
        <h3 className="dz-libraries-heading">{place}</h3>
        {!state || state.status === 'loading' ? (
          <div className="dz-libraries-loading"><Spinner size={16} label="Loading libraries" /></div>
        ) : state.status === 'error' && !libraries.length ? (
          <p className="dz-libraries-note is-error">{state.error}</p>
        ) : !libraries.length ? (
          <p className="dz-libraries-note">
            {session?.teamName
              ? 'The team has no published libraries yet. Publish a file with components, styles or variables and it will appear here for every file in the team.'
              : 'No published libraries yet. A library from a personal file is available only to your personal files.'}
          </p>
        ) : (
          <ul className="dz-libraries-list">
            {libraries.map(library => (
              <li key={library.id} className={`dz-library-row ${library.available ? '' : 'is-unavailable'}`.trim()} data-library={library.id}>
                <div className="dz-library-text">
                  <span className="dz-library-name">{library.name}</span>
                  <span className="dz-library-meta">
                    {library.available ? `${manifestSummary(library.manifest)} · version ${library.version}` : 'Unpublished: what was added stays in the file'}
                  </span>
                </div>
                {pending === library.id && <Spinner size={12} className="dz-library-pending" />}
                <Toggle checked={library.enabled} disabled={!canEdit || pending !== null || (!library.enabled && !library.available)}
                  aria-label={`${library.enabled ? 'Disable' : 'Enable'} "${library.name}"`}
                  onChange={value => void toggle(library, value)} />
              </li>
            ))}
          </ul>
        )}
        {error && <p className="dz-libraries-note is-error" role="alert">{error}</p>}
        {!canEdit && libraries.length > 0 && <p className="dz-libraries-note">Only the owner, admins and editors can enable libraries.</p>}
      </section>
    </Dialog>
  );
}
