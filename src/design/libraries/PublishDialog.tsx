import {memo, useEffect, useId, useMemo, useRef, useState, type ReactNode} from 'react';
import type {NodeId, Style} from '../../../shared/design/types';
import {buildLibrarySnapshot, isPrivateAssetName, publishableAssets, type LibraryManifest} from '../../../shared/design/libraries';
import {useEditorServices, type EditorDialogProps} from '../editor/services';
import {useDesignStore} from '../engine/useDesignStore';
import {StylePreview} from '../panels/left/AssetsPanel';
import type {ThumbnailPainter} from '../panels/left/thumbnails';
import {Button} from '../ui/Button';
import {Dialog} from '../ui/Dialog';
import {TextArea} from '../ui/TextArea';
import {IconVariables} from '../ui/icons';
import {Checkbox} from '../ui/Toggle';
import {count, errorText, useLibrarySession, useLibraryState, useSnapshotPainter, useThumbnail} from './hooks';

// "Publish library" (docs/design-tool.md §Teams, "Shared libraries"): which components, styles and variable collections the
// file publishes, each marked "New" or "Changed" against the last version, and what changed in words. The server builds the version
// from the saved file, so everything typed is saved first. Names that start with "_" or "." are private, as in Figma: unchecked
// unless they were published before.

type Kind = 'components' | 'styles' | 'variableCollections';
type Change = 'new' | 'changed' | null;
const MARK: Record<Exclude<Change, null>, string> = {new: 'New', changed: 'Changed'};

export default function PublishDialog({onClose}: EditorDialogProps) {
  const services = useEditorServices();
  const session = useLibrarySession(services);
  const state = useLibraryState(session);
  const doc = useDesignStore(current => current.doc, Object.is, {store: services.store, slice: 'doc'});
  // The dialog lists what the file had when it opened; edits behind a modal dialog are not expected.
  const [assets] = useState(() => publishableAssets(services.store.getState().doc));
  const own = state?.own;
  const previous: LibraryManifest | null = own?.manifest ?? null;
  const [selected, setSelected] = useState<Record<Kind, Set<string>> | null>(null);
  const [description, setDescription] = useState('');
  const descriptionLabel = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const painter = useSnapshotPainter(services, null);

  useEffect(() => {
    if (session && session.getState().own === undefined) void session.loadOwn();
  }, [session]);

  // Defaults once the last version is known: what was published, plus everything new that is not private.
  useEffect(() => {
    if (selected || own === undefined) return;
    const was = (kind: Kind) => new Set((previous?.[kind] ?? []).map(entry => entry.key));
    const pick = (kind: Kind, entries: readonly {id: string; name: string}[]) => {
      const before = was(kind);
      return new Set(entries.filter(entry => before.has(entry.id) || !isPrivateAssetName(entry.name)).map(entry => entry.id));
    };
    setSelected({
      components: pick('components', assets.components),
      styles: pick('styles', assets.styles),
      variableCollections: pick('variableCollections', assets.variableCollections),
    });
  }, [own, previous, assets, selected]);

  // "New" / "Changed" against the last version: the same hashes the server will compute.
  const changes = useMemo(() => {
    const out = new Map<string, Change>();
    if (!previous) return out;
    try {
      const all = {components: assets.components.map(entry => entry.id), styles: assets.styles.map(entry => entry.id), variableCollections: assets.variableCollections.map(entry => entry.id)};
      if (!all.components.length && !all.styles.length && !all.variableCollections.length) return out;
      const next = (own?.version ?? 0) + 1;
      const preview = buildLibrarySnapshot(doc, all, {version: next, previous});
      for (const kind of ['components', 'styles', 'variableCollections'] as const) {
        const before = new Set((previous?.[kind] ?? []).map(entry => entry.key));
        for (const entry of preview.manifest[kind]) out.set(`${kind}:${entry.key}`, !before.has(entry.key) ? 'new' : entry.changedIn === next ? 'changed' : null);
      }
    } catch {
      // The marks are a convenience: without them every asset is simply listed.
    }
    return out;
  }, [doc, assets, previous, own?.version]);

  const total = selected ? selected.components.size + selected.styles.size + selected.variableCollections.size : 0;
  const empty = !assets.components.length && !assets.styles.length && !assets.variableCollections.length;
  const toggle = (kind: Kind, id: string, on: boolean) =>
    setSelected(current => {
      if (!current) return current;
      const next = new Set(current[kind]);
      if (on) next.add(id);
      else next.delete(id);
      return {...current, [kind]: next};
    });
  const toggleAll = (kind: Kind, ids: readonly string[], on: boolean) => setSelected(current => (current ? {...current, [kind]: new Set(on ? ids : [])} : current));

  const publish = async () => {
    if (!session || !selected || !total) return;
    setBusy(true);
    setError(null);
    try {
      const version = await session.publish({components: [...selected.components], styles: [...selected.styles], variableCollections: [...selected.variableCollections]}, description.trim());
      services.toast(`Library published · version ${version}`, 'success');
      onClose();
    } catch (reason) {
      setError(errorText(reason, 'Could not publish the library.'));
    } finally {
      setBusy(false);
    }
  };

  const group = <T,>(kind: Kind, title: string, entries: readonly T[], idOf: (entry: T) => string, render: (entry: T) => ReactNode) => {
    if (!entries.length || !selected) return null;
    const ids = entries.map(idOf);
    const chosen = ids.filter(id => selected[kind].has(id)).length;
    return (
      <section className="dz-publish-group" aria-label={title}>
        <Checkbox checked={chosen === ids.length ? true : chosen ? 'mixed' : false} onChange={on => toggleAll(kind, ids, on)} className="dz-publish-group-head">
          {title} <span className="dz-publish-count">{chosen} of {ids.length}</span>
        </Checkbox>
        <ul className="dz-publish-list">
          {entries.map(entry => {
            const id = idOf(entry);
            const change = changes.get(`${kind}:${id}`) ?? null;
            return (
              <li key={id} className="dz-publish-row">
                <Checkbox checked={selected[kind].has(id)} onChange={on => toggle(kind, id, on)} className="dz-publish-check">
                  {render(entry)}
                </Checkbox>
                {change && <span className={`dz-publish-mark is-${change}`}>{MARK[change]}</span>}
              </li>
            );
          })}
        </ul>
      </section>
    );
  };

  return (
    <Dialog title={own && !own.unpublishedAt ? 'Publish library changes' : 'Publish library'} onClose={onClose} width={520} dismissible={false} className="dz-publish"
      footer={
        <>
          {error && <p className="dz-publish-error" role="alert">{error}</p>}
          <Button size={32} onClick={onClose}>Cancel</Button>
          <Button size={32} variant="primary" busy={busy} disabled={!total || !session?.canEdit} onClick={() => void publish()}>
            {total ? `Publish · ${count(total, 'asset', 'assets')}` : 'Publish'}
          </Button>
        </>
      }>
      <p className="dz-publish-lead">
        {session?.teamName
          ? `Published assets can be enabled by every file in the "${session.teamName}" team. They get updates after a new publication.`
          : 'Published assets can be enabled by your personal files. They get updates after a new publication.'}
      </p>
      <div className="dz-publish-field">
        <span id={descriptionLabel} className="dz-publish-label">What changed</span>
        <TextArea value={description} onChange={setDescription} maxLength={1000} maxHeight={120} aria-labelledby={descriptionLabel}
          placeholder="For example: new button states, dark theme" />
      </div>
      {empty ? (
        <p className="dz-libraries-note">The file has no components, styles or variables that can be published.</p>
      ) : !selected ? null : (
        <div className="dz-publish-groups">
          {group('components', 'Components', assets.components, entry => entry.id, entry => <ComponentLabel painter={painter} id={entry.id} name={entry.name} variants={entry.type === 'COMPONENT_SET' ? (doc.nodes[entry.id]?.children?.length ?? 0) : 0} />)}
          {group('styles', 'Styles', assets.styles, (entry: Style) => entry.id, entry => <span className="dz-publish-label-row"><StylePreview style={entry} /><span className="dz-publish-name">{entry.name}</span></span>)}
          {group('variableCollections', 'Variables', assets.variableCollections, entry => entry.id, entry => (
            <span className="dz-publish-label-row">
              <span className="dz-style-icon" aria-hidden="true"><IconVariables /></span>
              <span className="dz-publish-name">{entry.name}</span>
              <span className="dz-publish-meta">{count(entry.variableIds.filter(id => !doc.variables[id]?.hiddenFromPublishing).length, 'variable', 'variables')}</span>
            </span>
          ))}
        </div>
      )}
    </Dialog>
  );
}

const ComponentLabel = memo(function ComponentLabel({painter, id, name, variants}: {painter: ThumbnailPainter; id: NodeId; name: string; variants: number}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useThumbnail(canvas, painter, id, 1, 24);
  return (
    <span className="dz-publish-label-row">
      <span className="dz-asset-thumb" style={{width: 24, height: 24}}><canvas ref={canvas} style={{width: 24, height: 24}} aria-hidden="true" /></span>
      <span className="dz-publish-name">{name}</span>
      {variants > 1 && <span className="dz-publish-meta">{count(variants, 'variant', 'variants')}</span>}
    </span>
  );
});
