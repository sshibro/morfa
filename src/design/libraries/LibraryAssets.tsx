import {memo, useCallback, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode} from 'react';
import type {DesignFileLibrary} from '../../../shared/design/api';
import type {LibraryCollectionAsset, LibraryComponentAsset, LibraryStyleAsset} from '../../../shared/design/libraries';
import type {Style, StyleType} from '../../../shared/design/types';
import {applyStyle} from '../../../shared/design/styles';
import {frameAtPoint} from '../../../shared/design/tree';
import {userUpdate} from '../engine/user-edit';
import {useEditorServices, type EditorServices} from '../editor/services';
import {placeInstanceAt} from '../panels/left/assets-actions';
import {folderTree, type AssetFolder} from '../panels/left/component-index';
import {foldText} from '../panels/left/layer-rows';
import {currentIndex, pagePointAt, viewportCentre} from '../panels/left/panel-context';
import {StylePreview} from '../panels/left/AssetsPanel';
import type {ThumbnailPainter} from '../panels/left/thumbnails';
import {IconButton} from '../ui/Button';
import {IconChevronRight, IconPlus, IconVariables} from '../ui/icons';
import {Portal} from '../ui/layer';
import {PanelSection} from '../ui/PanelSection';
import {Spinner} from '../ui/Spinner';
import {count, errorText, useLibrarySession, useLibraryState, useSnapshot, useSnapshotPainter, useThumbnail} from './hooks';
import {UPDATES_DIALOG} from './host';
import type {LibrarySession} from './session';

// "Assets" → one section per library the file enabled (docs/design-tool.md §Teams, "Shared libraries"): its components as
// thumbnails painted from the library's newest version (a click places an instance at the centre of the view, a drag where it
// lands), its styles (a click applies one to the selection) and its variable collections (added to the file to bind them). A
// component, style or collection comes into the file as a read-only copy on first use.

type View = 'list' | 'grid';
const THUMB = {list: 24, grid: 64} as const;

export default function LibraryAssets({query, view}: {query: string; view: View}) {
  const services = useEditorServices();
  const session = useLibrarySession(services);
  const state = useLibraryState(session);
  if (!session || !state) return null;
  const enabled = state.libraries.filter(library => library.enabled);
  return (
    <>
      {enabled.map(library => (
        <LibrarySection key={library.id} session={session} library={library} query={query} view={view}
          updates={state.updates.filter(update => update.libraryId === library.id).length} />
      ))}
    </>
  );
}

const STYLE_GROUPS: readonly {type: StyleType; label: string}[] = [
  {type: 'FILL', label: 'Colors'},
  {type: 'TEXT', label: 'Text'},
  {type: 'EFFECT', label: 'Effects'},
  {type: 'GRID', label: 'Grids'},
];

function Folder({label, depth, children, strong = false}: {label: string; depth: number; children: ReactNode; strong?: boolean}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="dz-asset-group">
      <button type="button" className={`dz-asset-folder ${strong ? 'is-page' : ''}`.trim()} aria-expanded={open} style={{'--dz-depth': depth} as CSSProperties} onClick={() => setOpen(value => !value)}>
        <span className={`dz-layer-caret ${open ? 'is-open' : ''}`} aria-hidden="true"><IconChevronRight size={12} /></span>
        <span className="dz-asset-folder-name">{label}</span>
      </button>
      {open && children}
    </div>
  );
}

const LibrarySection = memo(function LibrarySection({session, library, query, view, updates}: {session: LibrarySession; library: DesignFileLibrary; query: string; view: View; updates: number}) {
  const services = useEditorServices();
  const [open, setOpen] = useState(true);
  const snapshot = useSnapshot(session, open && library.available ? library.id : null, library.version);
  const doc = snapshot.status === 'ready' ? snapshot.value.document : null;
  const painter = useSnapshotPainter(services, doc);
  const needle = foldText(query.trim());
  const matches = <T extends {name: string}>(list: readonly T[]) => list.filter(entry => !needle || foldText(entry.name).includes(needle));
  const components = matches(library.manifest.components);
  const styles = matches(library.manifest.styles);
  const collections = matches(library.manifest.variableCollections);
  const readOnly = !session.canEdit;

  let body: ReactNode;
  if (!library.available) body = <p className="dz-assets-note">The library was unpublished: new assets from it are unavailable, those already added stay in the file.</p>;
  else if (snapshot.status === 'error') body = <p className="dz-assets-note is-error">{snapshot.error}</p>;
  else if (!components.length && !styles.length && !collections.length) body = <p className="dz-assets-note">{needle ? 'Nothing found.' : 'The library is empty.'}</p>;
  else {
    const renderComponents = (folder: AssetFolder<LibraryComponentAsset>, depth: number): ReactNode => (
      <>
        {folder.folders.map(child => (
          <Folder key={child.key} label={child.name} depth={depth}>{renderComponents(child, depth + 1)}</Folder>
        ))}
        {folder.items.length > 0 && (
          <div className={view === 'grid' ? 'dz-asset-grid' : 'dz-asset-list'} style={{'--dz-depth': depth} as CSSProperties}>
            {folder.items.map(({entry, name}) => (
              <LibraryComponent key={entry.key} session={session} library={library} entry={entry} name={name} view={view} painter={painter} ready={!!doc} readOnly={readOnly} />
            ))}
          </div>
        )}
      </>
    );
    const renderStyles = (folder: AssetFolder<LibraryStyleAsset>, depth: number): ReactNode => (
      <>
        {folder.folders.map(child => (
          <Folder key={child.key} label={child.name} depth={depth}>{renderStyles(child, depth + 1)}</Folder>
        ))}
        {folder.items.length > 0 && (
          <div className="dz-asset-list" style={{'--dz-depth': depth} as CSSProperties}>
            {folder.items.map(({entry, name}) => <LibraryStyleRow key={entry.key} session={session} library={library} entry={entry} name={name} style={doc?.styles[entry.key]} readOnly={readOnly} />)}
          </div>
        )}
      </>
    );
    body = (
      <>
        {components.length > 0 && <Folder label="Components" depth={0} strong>{renderComponents(folderTree(components, `lib:${library.id}`), 1)}</Folder>}
        {styles.length > 0 && STYLE_GROUPS.map(group => {
          const ofType = styles.filter(style => style.type === group.type);
          if (!ofType.length) return null;
          return (
            <Folder key={group.type} label={group.label} depth={0} strong>
              {renderStyles(folderTree(ofType, `lib:${library.id}:${group.type}`), 1)}
            </Folder>
          );
        })}
        {collections.length > 0 && (
          <Folder label="Variables" depth={0} strong>
            <div className="dz-asset-list" style={{'--dz-depth': 1} as CSSProperties}>
              {collections.map(entry => <LibraryCollectionRow key={entry.key} session={session} library={library} entry={entry} readOnly={readOnly} />)}
            </div>
          </Folder>
        )}
      </>
    );
  }
  return (
    <PanelSection title={library.name} collapsible open={open} onOpenChange={setOpen} className="dz-assets-section dz-library-section"
      actions={updates > 0 ? (
        <button type="button" className="dz-library-update-chip" onClick={() => services.openDialog(UPDATES_DIALOG)}>
          {count(updates, 'update', 'updates')}
        </button>
      ) : undefined}>
      <div className="dz-assets-body">{body}</div>
    </PanelSection>
  );
});

async function placeComponent(services: EditorServices, session: LibrarySession, libraryId: string, key: string, point: {x: number; y: number}) {
  try {
    const local = await session.component(libraryId, key);
    placeInstanceAt(services, local, point);
  } catch (error) {
    services.toast(errorText(error, 'Could not add the component.'), 'error');
  }
}

type ComponentProps = {session: LibrarySession; library: DesignFileLibrary; entry: LibraryComponentAsset; name: string; view: View; painter: ThumbnailPainter; ready: boolean; readOnly: boolean};

const LibraryComponent = memo(function LibraryComponent({session, library, entry, name, view, painter, ready, readOnly}: ComponentProps) {
  const services = useEditorServices();
  const canvas = useRef<HTMLCanvasElement>(null);
  const item = useRef<HTMLDivElement>(null);
  const press = useRef<{x: number; y: number; id: number; dragging: boolean} | null>(null);
  const [ghost, setGhost] = useState<{x: number; y: number} | null>(null);
  const [busy, setBusy] = useState(false);
  const size = THUMB[view];
  useThumbnail(canvas, painter, entry.key, ready ? library.version : 0, size);

  const place = useCallback((point: {x: number; y: number}) => {
    if (readOnly) return;
    setBusy(true);
    void placeComponent(services, session, library.id, entry.key, point).finally(() => setBusy(false));
  }, [services, session, library.id, entry.key, readOnly]);

  const pointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || readOnly) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    press.current = {x: event.clientX, y: event.clientY, id: event.pointerId, dragging: false};
  };
  const pointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = press.current;
    if (!state || state.id !== event.pointerId) return;
    if (!state.dragging && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 4) return;
    state.dragging = true;
    setGhost({x: event.clientX, y: event.clientY});
    const point = pagePointAt(services, event.clientX, event.clientY, item.current);
    const {doc, pageId} = services.store.getState();
    services.store.setHover(point ? frameAtPoint(doc, pageId, point, new Set(), currentIndex(services)) : null);
  };
  const pointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = press.current;
    if (!state || state.id !== event.pointerId) return;
    press.current = null;
    setGhost(null);
    if (state.dragging) services.store.setHover(null);
    if (!state.dragging) return place(viewportCentre(services, item.current));
    const point = pagePointAt(services, event.clientX, event.clientY, item.current);
    if (point) place(point);
  };
  const cancel = () => {
    if (press.current?.dragging) services.store.setHover(null);
    press.current = null;
    setGhost(null);
  };
  const label = entry.variants > 1 ? `${entry.name} — ${count(entry.variants, 'variant', 'variants')}` : entry.name;
  return (
    <div ref={item} className={`dz-asset-item is-${view} ${ghost ? 'is-dragging' : ''} ${busy ? 'is-busy' : ''}`.trim()} role="button" tabIndex={0}
      aria-label={view === 'grid' ? label : undefined} aria-busy={busy || undefined} aria-disabled={readOnly || undefined}
      title={entry.description ? `${label}\n${entry.description}` : view === 'grid' ? label : undefined} data-library-asset={entry.key}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={cancel} onLostPointerCapture={() => press.current?.dragging || cancel()}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        place(viewportCentre(services, item.current));
      }}>
      <span className="dz-asset-thumb" style={{width: size, height: size}}>
        <canvas ref={canvas} style={{width: size, height: size}} aria-hidden="true" />
        {busy && <Spinner size={12} className="dz-library-busy" label="Adding" />}
      </span>
      {view === 'list' && <span className="dz-asset-name">{name}</span>}
      {ghost && <Ghost source={canvas.current} x={ghost.x} y={ghost.y} />}
    </div>
  );
});

/** What follows the pointer while a component is dragged onto the canvas. */
function Ghost({source, x, y}: {source: HTMLCanvasElement | null; x: number; y: number}) {
  const copy = useRef<HTMLCanvasElement>(null);
  const size = 64;
  return (
    <Portal>
      <div className="dz-asset-ghost" style={{transform: `translate(${x - size / 2}px, ${y - size / 2}px)`}} aria-hidden="true">
        <canvas ref={element => {
          copy.current = element;
          if (element && source) {
            element.width = source.width;
            element.height = source.height;
            element.getContext('2d')?.drawImage(source, 0, 0);
          }
        }} style={{width: size, height: size}} />
      </div>
    </Portal>
  );
}

function LibraryStyleRow({session, library, entry, name, style, readOnly}: {session: LibrarySession; library: DesignFileLibrary; entry: LibraryStyleAsset; name: string; style: Style | undefined; readOnly: boolean}) {
  const services = useEditorServices();
  const [busy, setBusy] = useState(false);
  const apply = async () => {
    if (readOnly || busy) return;
    setBusy(true);
    try {
      const local = await session.style(library.id, entry.key);
      const ids = services.store.getState().selection;
      if (!ids.length) {
        services.toast('Style added to the file. Select layers to apply it.');
        return;
      }
      services.store.transact('Apply style', tx => {
        for (const [id, patch] of applyStyle(tx.doc, ids, local)) userUpdate(tx, id, patch);
      });
    } catch (error) {
      services.toast(errorText(error, 'Could not apply the style.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div role="button" tabIndex={0} className={`dz-style-row ${busy ? 'is-busy' : ''}`.trim()} aria-disabled={readOnly || undefined} aria-busy={busy || undefined}
      title={entry.description ? `${entry.name}\n${entry.description}` : entry.name} data-library-style={entry.key}
      onClick={() => void apply()}
      onKeyDown={event => {
        if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
        event.preventDefault();
        void apply();
      }}>
      {style ? <StylePreview style={style} /> : <span className="dz-style-icon" aria-hidden="true" />}
      <span className="dz-asset-name">{name}</span>
    </div>
  );
}

function LibraryCollectionRow({session, library, entry, readOnly}: {session: LibrarySession; library: DesignFileLibrary; entry: LibraryCollectionAsset; readOnly: boolean}) {
  const services = useEditorServices();
  const [busy, setBusy] = useState(false);
  const inFile = session.hasWholeCollection(library.id, entry.key);
  const add = async () => {
    setBusy(true);
    try {
      await session.collection(library.id, entry.key);
      services.toast(`Variables "${entry.name}" added to the file`, 'success');
    } catch (error) {
      services.toast(errorText(error, 'Could not add the variables.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="dz-style-row dz-library-collection" data-library-collection={entry.key} title={`${entry.name}: ${count(entry.variables, 'variable', 'variables')}`}>
      <span className="dz-style-icon" aria-hidden="true"><IconVariables /></span>
      <span className="dz-asset-name">{entry.name}</span>
      {inFile
        ? <span className="dz-library-in-file">In file</span>
        : !readOnly && <IconButton label={`Add "${entry.name}" to the file`} disabled={busy} aria-busy={busy || undefined} onClick={() => void add()}>{busy ? <Spinner size={12} /> : <IconPlus />}</IconButton>}
    </div>
  );
}
