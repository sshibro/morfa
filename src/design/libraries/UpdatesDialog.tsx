import {memo, useRef, useState} from 'react';
import type {DesignFileLibrary} from '../../../shared/design/api';
import type {LibraryUpdate} from '../../../shared/design/libraries';
import type {Style} from '../../../shared/design/types';
import {useEditorServices, type EditorDialogProps} from '../editor/services';
import {StylePreview} from '../panels/left/AssetsPanel';
import type {ThumbnailPainter} from '../panels/left/thumbnails';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {IconArrowRight, IconCheck, IconVariables} from '../ui/icons';
import {EmptyState} from '../ui/ProgressBar';
import {count, errorText, useLibrarySession, useLibraryState, useSnapshot, useSnapshotPainter, useThumbnail} from './hooks';
import type {LibrarySession} from './session';

// "Library updates" (docs/design-tool.md §Teams, "Shared libraries"): every asset this file holds an older copy of, by library,
// with the change's description and, for components and styles, how it looks now and after. "Update" takes one, "Update all"
// takes them all in one undo step; instances keep their overrides. "Later" puts the greeting off until the next version.

export default function UpdatesDialog({onClose}: EditorDialogProps) {
  const services = useEditorServices();
  const session = useLibrarySession(services);
  const state = useLibraryState(session);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const updates = state?.updates ?? [];
  const canEdit = !!session?.canEdit;

  const take = async (list: readonly LibraryUpdate[], key: string) => {
    if (!session) return;
    setBusy(key);
    setError(null);
    try {
      const done = await session.update(list);
      services.toast(done === 1 ? 'Asset updated' : `Updated: ${count(done, 'asset', 'assets')}`, 'success');
      if (list === updates) onClose();
    } catch (reason) {
      setError(errorText(reason, 'Could not update.'));
    } finally {
      setBusy(null);
    }
  };
  const later = async () => {
    await session?.later().catch(() => undefined);
    onClose();
  };

  const byLibrary = new Map<string, LibraryUpdate[]>();
  for (const update of updates) {
    const list = byLibrary.get(update.libraryId);
    if (list) list.push(update);
    else byLibrary.set(update.libraryId, [update]);
  }

  return (
    <Dialog title="Library updates" onClose={onClose} width={520} className="dz-updates"
      footer={updates.length > 0 && canEdit ? (
        <>
          {error && <p className="dz-publish-error" role="alert">{error}</p>}
          <Button size={32} onClick={() => void later()} disabled={busy !== null}>Later</Button>
          <Button size={32} variant="primary" busy={busy === 'all'} disabled={busy !== null && busy !== 'all'} onClick={() => void take(updates, 'all')}>Update all</Button>
        </>
      ) : (
        <Button size={32} variant="primary" onClick={onClose}>Done</Button>
      )}>
      {!updates.length ? (
        <EmptyState icon={<IconCheck />} title="Everything is up to date">Assets from the enabled libraries are the latest versions.</EmptyState>
      ) : (
        <div className="dz-updates-groups">
          {[...byLibrary].map(([libraryId, list]) => {
            const library = session?.library(libraryId);
            if (!library || !session) return null;
            return <LibraryUpdates key={libraryId} session={session} library={library} updates={list} busy={busy} canEdit={canEdit} onTake={take} />;
          })}
        </div>
      )}
      {!canEdit && updates.length > 0 && <p className="dz-libraries-note">Only the owner, admins and editors can update assets.</p>}
    </Dialog>
  );
}

type GroupProps = {
  session: LibrarySession;
  library: DesignFileLibrary;
  updates: LibraryUpdate[];
  busy: string | null;
  canEdit: boolean;
  onTake: (list: readonly LibraryUpdate[], key: string) => Promise<void>;
};

function LibraryUpdates({session, library, updates, busy, canEdit, onTake}: GroupProps) {
  const services = useEditorServices();
  const snapshot = useSnapshot(session, library.id, library.version);
  const after = snapshot.status === 'ready' ? snapshot.value.document : null;
  const afterPainter = useSnapshotPainter(services, after);
  const beforePainter = useSnapshotPainter(services, null);
  const from = Math.min(...updates.map(update => update.from));
  return (
    <section className="dz-updates-group" aria-label={library.name}>
      <header className="dz-updates-head">
        <span className="dz-updates-name">{library.name}</span>
        <span className="dz-updates-versions">version {from} → {library.version}</span>
      </header>
      {library.description && <p className="dz-updates-description">{library.description}</p>}
      <ul className="dz-updates-list">
        {updates.map(update => {
          const key = `${update.kind}:${update.localId}`;
          return (
            <li key={key} className="dz-update-row" data-update={update.key}>
              <UpdatePreview update={update} before={beforePainter} after={afterPainter} ready={!!after}
                styleBefore={services.store.getState().doc.styles[update.localId]} styleAfter={after?.styles[update.key]} />
              <span className="dz-update-text">
                <span className="dz-update-name">{update.name}</span>
                <span className="dz-update-kind">{update.kind === 'component' ? 'Component' : update.kind === 'style' ? 'Style' : 'Variables'}</span>
              </span>
              {canEdit && <Button size={24} busy={busy === key} disabled={busy !== null && busy !== key} onClick={() => void onTake([update], key)}>Update</Button>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

type PreviewProps = {update: LibraryUpdate; before: ThumbnailPainter; after: ThumbnailPainter; ready: boolean; styleBefore?: Style; styleAfter?: Style};

const UpdatePreview = memo(function UpdatePreview({update, before, after, ready, styleBefore, styleAfter}: PreviewProps) {
  if (update.kind === 'component') return <ComponentPreview update={update} before={before} after={after} ready={ready} />;
  if (update.kind === 'style' && styleBefore && styleAfter)
    return (
      <span className="dz-update-preview is-style" aria-hidden="true">
        <StylePreview style={styleBefore} /><IconArrowRight size={12} /><StylePreview style={styleAfter} />
      </span>
    );
  return <span className="dz-update-preview is-icon" aria-hidden="true"><IconVariables /></span>;
});

function ComponentPreview({update, before, after, ready}: {update: LibraryUpdate; before: ThumbnailPainter; after: ThumbnailPainter; ready: boolean}) {
  const was = useRef<HTMLCanvasElement>(null);
  const now = useRef<HTMLCanvasElement>(null);
  useThumbnail(was, before, update.localId, update.from, 40);
  useThumbnail(now, after, update.key, ready ? update.to : 0, 40);
  return (
    <span className="dz-update-preview" role="img" aria-label="Now and after the update">
      <span className="dz-asset-thumb" style={{width: 40, height: 40}} title="Now"><canvas ref={was} style={{width: 40, height: 40}} /></span>
      <IconArrowRight size={12} />
      <span className="dz-asset-thumb" style={{width: 40, height: 40}} title="After the update"><canvas ref={now} style={{width: 40, height: 40}} /></span>
    </span>
  );
}
