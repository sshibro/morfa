import '../styles/versions.css';
import {useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent, type MouseEvent, type ReactNode} from 'react';
import {createPortal} from 'react-dom';
import type {DesignDocument, NodeId} from '../../../shared/design/types';
import type {DesignFileSummary, DesignSaved, DesignVersionSummary} from '../../../shared/design/api';
import {duplicateDesignVersion, listDesignVersions, readDesignVersion, renameDesignVersion, restoreDesignVersion, saveDesignVersion} from '../api';
import type {DesignFontRegistry} from '../engine/fonts';
import type {DesignImageCache} from '../engine/images';
import type {DesignStore} from '../engine/store';
import {useEditorServices} from '../editor/services';
import {Button, IconButton} from '../ui/Button';
import {IconChevronDown, IconClock, IconClose, IconCopy, IconEye, IconLink, IconOffline, IconPlus, IconRename, IconRestore} from '../ui/icons';
import {versionLink} from '../engine/commands/link';
import {useContextMenu} from '../ui/Menu';
import type {MenuItem} from '../ui/menu-model';
import {useToast} from '../ui/Toast';
import {EmptyState} from '../ui/ProgressBar';
import {TextInput} from '../ui/TextInput';
import {
  autosaveWord, createVersionCache, decodeVersionLabel, descriptionRoom, encodeVersionLabel, groupVersions, historyNote, momentPhrase, previewTitle, restoredMessage, restoreVersion,
  VERSION_NAME_MAX, type VersionRow,
} from './model';
import {VersionLayers, VersionPages} from './VersionLayers';
import {VersionPreview, versionPage} from './VersionPreview';
import {layerTreeState} from '../panels/left/tree-state';

// "Version history" (docs/design-tool.md §Server API: versions): the right panel's place is taken by the
// list of versions, newest first, by day; a click shows that version read-only over the canvas with a
// banner to restore it or go back. "Save version" (⌥⌘S) names the current state. The note under the list
// says how long automatic versions are kept. Restoring goes through the editor's autosave: pending
// edits are stored first, the server keeps the replaced document as a version, the editor adopts the
// restored one.

/** What the panel needs of the editor's autosave (EditorServices.persistence). */
export type VersionPersistence = {
  version(): number;
  flush(): Promise<void>;
  adopt(doc: DesignDocument, version: number): void;
};

/** The requests the panel makes (the files API by default; harnesses pass their own). */
export type VersionsApi = {
  list(fileId: string): Promise<{versions: DesignVersionSummary[]}>;
  save(fileId: string, label: string): Promise<{version: DesignVersionSummary}>;
  read(fileId: string, versionId: string): Promise<{document: DesignDocument}>;
  restore(fileId: string, versionId: string, baseVersion: number): Promise<DesignSaved>;
  duplicate(fileId: string, versionId: string): Promise<{file: DesignFileSummary}>;
  rename(fileId: string, versionId: string, label: string): Promise<{version: DesignVersionSummary}>;
};
const DEFAULT_API: VersionsApi = {
  list: listDesignVersions,
  save: saveDesignVersion,
  read: readDesignVersion,
  restore: restoreDesignVersion,
  duplicate: (fileId, versionId) => duplicateDesignVersion(fileId, versionId),
  rename: renameDesignVersion,
};

export type VersionHistoryProps = {
  fileId: string;
  store: DesignStore;
  fonts: DesignFontRegistry;
  images: DesignImageCache;
  persistence?: VersionPersistence;
  toast: (message: string, kind?: 'success' | 'error') => void;
  onClose: () => void;
  /** Opens with the "Save version" form (⌥⌘S). */
  startWithSave?: boolean;
  /** Opens showing this version (a version link, `#design/<file>?version=<id>`). */
  startWithVersion?: string;
  api?: Partial<VersionsApi>;
  /** Where the panel and the preview render (and the previewed version's layers); found in the editor's chrome by default. */
  targets?: {panel: Element | null; canvas: Element | null; layers?: Element | null; pages?: Element | null};
  /** Clock for the labels (tests and harnesses). */
  now?: () => number;
  timeZone?: string;
};

type ListState = {status: 'loading'} | {status: 'error'; message: string} | {status: 'ready'; versions: DesignVersionSummary[]};
type Preview = {id: string; version: DesignVersionSummary; doc: DesignDocument | null; error: string | null};

const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

/** The right panel and the canvas area of the open editor, where the history takes its place. */
function chromeTargets(): {panel: Element | null; canvas: Element | null} {
  const editor = document.querySelector('.dz .dz-editor');
  return {panel: editor?.querySelector('.dz-side-panel.is-right') ?? null, canvas: editor?.querySelector('.dz-canvas-area') ?? null};
}

/** The left panel's "Layers" and "Pages" areas, where a previewed version lists its own layers and pages (looked up
 *  when a preview opens: the left panel may have switched tabs since the history opened). */
const layersTarget = (): Element | null => document.querySelector('.dz .dz-editor .dz-left-layers');
const pagesTarget = (): Element | null => document.querySelector('.dz .dz-editor .dz-left-pages');

/** The editor's dialog registry entry (`openDialog('versions', {save?: true})`): reads the services. */
export function VersionHistoryDialog({params, onClose}: {params: Record<string, unknown>; onClose: () => void}) {
  const services = useEditorServices() as ReturnType<typeof useEditorServices> & {persistence?: VersionPersistence};
  return (
    <VersionHistory fileId={services.fileId} store={services.store} fonts={services.fonts} images={services.images} persistence={services.persistence}
      toast={services.toast} onClose={onClose} startWithSave={params.save === true} startWithVersion={typeof params.version === 'string' ? params.version : undefined} />
  );
}

export function VersionHistory(props: VersionHistoryProps) {
  const {fileId, store, fonts, images, persistence, toast, onClose} = props;
  const api = useMemo<VersionsApi>(() => ({...DEFAULT_API, ...props.api}), [props.api]);
  const clockNow = props.now ?? Date.now;
  const timeZone = props.timeZone;
  const [targets, setTargets] = useState<{panel: Element | null; canvas: Element | null} | null>(props.targets ?? null);
  useLayoutEffect(() => {
    if (!props.targets) setTargets(chromeTargets());
  }, [props.targets]);

  const [list, setList] = useState<ListState>({status: 'loading'});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewPage, setPreviewPage] = useState<NodeId | null>(null);
  const [layers, setLayers] = useState<Element | null>(null);
  const [pagesHost, setPagesHost] = useState<Element | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [form, setForm] = useState(!!props.startWithSave);
  // "Edit version info…": the version whose name and description are being edited (the form takes the new-version form's place).
  const [editing, setEditing] = useState<DesignVersionSummary | null>(null);
  const [attempt, setAttempt] = useState(0);
  const cache = useMemo(() => createVersionCache(async id => (await api.read(fileId, id)).document), [api, fileId]);

  // The list.
  useEffect(() => {
    let live = true;
    setList(current => (current.status === 'ready' ? current : {status: 'loading'}));
    api.list(fileId).then(
      ({versions}) => {if (live) setList({status: 'ready', versions});},
      error => {if (live) setList({status: 'error', message: errorText(error, 'Check your connection and try again.')});},
    );
    return () => {live = false;};
  }, [api, fileId, attempt]);

  // A version link: once the list is in, that version is shown (or the link said to be stale).
  const linked = useRef(props.startWithVersion ?? null);
  useEffect(() => {
    if (list.status !== 'ready' || !linked.current) return;
    const version = list.versions.find(entry => entry.id === linked.current);
    linked.current = null;
    if (version) show(version);
    else toast('The linked version was not found: it may have been deleted when its retention period ended.', 'error');
  }, [list]); // eslint-disable-line react-hooks/exhaustive-deps

  const now = clockNow();
  const days = useMemo(() => (list.status === 'ready' ? groupVersions(list.versions, {now, timeZone, expanded}) : []), [list, expanded, timeZone]); // eslint-disable-line react-hooks/exhaustive-deps
  const note = historyNote();

  // ── Preview ──
  const show = useCallback((version: DesignVersionSummary) => {
    setPreview({id: version.id, version, doc: null, error: null});
    setLayers(props.targets ? props.targets.layers ?? null : layersTarget());
    setPagesHost(props.targets ? props.targets.pages ?? null : pagesTarget());
    cache.get(version.id).then(
      doc => setPreview(current => (current?.id === version.id ? {...current, doc} : current)),
      error => setPreview(current => (current?.id === version.id ? {...current, error: errorText(error, 'Could not load the version.')} : current)),
    );
  }, [cache, props.targets]);
  const back = useCallback(() => {
    setPreview(null);
    setPreviewPage(null);
  }, []);

  const restoreOf = useCallback(async (version: DesignVersionSummary) => {
    if (!persistence || restoring) return;
    setRestoring(true);
    try {
      const result = await restoreVersion({
        flush: () => persistence.flush(),
        baseVersion: () => persistence.version(),
        document: () => cache.get(version.id),
        restore: base => api.restore(fileId, version.id, base),
        adopt: (doc, at) => persistence.adopt(doc, at),
      });
      setPreview(null);
      toast(restoredMessage(version, {now: clockNow(), timeZone}) + (result.retried ? ' Changes from another tab are restored too.' : ''), 'success');
      setAttempt(value => value + 1);
    } catch (error) {
      toast(errorText(error, 'Could not restore the version.'), 'error');
    } finally {
      setRestoring(false);
    }
  }, [persistence, restoring, cache, api, fileId, toast, clockNow, timeZone]);
  const restore = useCallback(() => (preview ? restoreOf(preview.version) : undefined), [preview, restoreOf]);

  // "Duplicate file" (Figma's "Duplicate" of a version): a new file holding the version, offered to open in a new tab.
  const showToast = useToast();
  const duplicate = useCallback(async (version: DesignVersionSummary) => {
    try {
      const {file} = await api.duplicate(fileId, version.id);
      showToast(`File "${file.name}" created from the version`, {kind: 'success', action: {label: 'Open', onClick: () => window.open('#design/' + encodeURIComponent(file.id), '_blank', 'noopener')}});
    } catch (error) {
      toast(errorText(error, 'Could not create a copy.'), 'error');
    }
  }, [api, fileId, showToast, toast]);
  const copyLink = useCallback(async (version: DesignVersionSummary) => {
    try {
      await navigator.clipboard.writeText(versionLink(globalThis.location, fileId, version.id));
      toast('Version link copied', 'success');
    } catch {
      toast('The browser did not allow access to the clipboard.', 'error');
    }
  }, [fileId, toast]);
  const menu = useContextMenu();
  const menuItems = (version: DesignVersionSummary): MenuItem[] => [
    {id: 'show', label: 'Show version', icon: <IconEye />, onSelect: () => show(version)},
    {id: 'restore', label: 'Restore this version', icon: <IconRestore />, disabled: !persistence || restoring, onSelect: () => void restoreOf(version)},
    {id: 'rename', label: version.label === null ? 'Name this version…' : 'Edit version info…', icon: <IconRename />, disabled: !persistence, onSelect: () => {
      setForm(false);
      setEditing(version);
    }},
    {type: 'separator'},
    {id: 'duplicate', label: 'Duplicate file', icon: <IconCopy />, onSelect: () => void duplicate(version)},
    {id: 'link', label: 'Copy link to version', icon: <IconLink />, onSelect: () => void copyLink(version)},
  ];

  // ── Saving a named version ──
  const saved = useCallback((version: DesignVersionSummary) => {
    setList(current => (current.status === 'ready' ? {status: 'ready', versions: [version, ...current.versions.filter(entry => entry.id !== version.id)]} : current));
    setForm(false);
  }, []);
  const renamed = useCallback((version: DesignVersionSummary) => {
    setList(current => (current.status === 'ready' ? {status: 'ready', versions: current.versions.map(entry => (entry.id === version.id ? version : entry))} : current));
    setPreview(current => (current?.id === version.id ? {...current, version} : current));
    setEditing(null);
  }, []);

  // Escape: back from a preview first, then closes the history (fields and menus handle their own).
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || preview) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, .dz-dialog, .dz-menu')) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [preview, onClose]);

  // Focus comes into the panel when it opens and goes back where it was when it closes.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!props.startWithSave) panel.current?.focus({preventScroll: true});
    return () => {
      if (previous?.isConnected) previous.focus({preventScroll: true});
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const pageId = store.getState().pageId;
  const restoreUnavailable = persistence ? undefined : 'Restoring is unavailable: the editor did not provide file saving.';

  const rowsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-version-row]')];
    if (!rows.length) return;
    event.preventDefault();
    const at = rows.indexOf(document.activeElement as HTMLButtonElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, at < 0 ? 0 : at + (event.key === 'ArrowDown' ? 1 : -1)))];
    next.focus();
    next.click();
  };

  const body: ReactNode = (
    <aside ref={panel} tabIndex={-1} className={`dz-versions ${targets?.panel ? '' : 'is-floating'}`.trim()} aria-label="Version history">
      <header className="dz-panel-header dz-versions-header">
        <h2 className="dz-versions-title">Version history</h2>
        <IconButton label="Save version" shortcut="Alt+Mod+KeyS" pressed={form} onClick={() => {
          setEditing(null);
          setForm(open => !open);
        }}><IconPlus /></IconButton>
        <IconButton label="Close version history" shortcut="Escape" onClick={onClose}><IconClose /></IconButton>
      </header>
      <div className="dz-versions-body dz-scroll" onKeyDown={rowsKeyDown}>
        {form && <SaveVersionForm fileId={fileId} api={api} persistence={persistence} toast={toast} onSaved={saved} onCancel={() => setForm(false)} />}
        {editing && <SaveVersionForm key={editing.id} editing={editing} caption={`Saved ${momentPhrase(editing.createdAt, {now: clockNow(), timeZone})}`} fileId={fileId} api={api} persistence={persistence} toast={toast} onSaved={renamed} onCancel={() => setEditing(null)} />}
        <div className="dz-versions-list" role="list">
          <div role="listitem">
            <button type="button" data-version-row="" className={`dz-version-row is-current ${preview ? '' : 'is-selected'}`.trim()} aria-current={!preview || undefined} onClick={back}>
              <span className="dz-version-dot" aria-hidden="true" />
              <span className="dz-version-main"><span className="dz-version-title">Current version</span></span>
            </button>
          </div>
          {list.status === 'loading' && <ListSkeleton />}
          {list.status === 'error' && (
            <EmptyState tone="error" icon={<IconOffline />} title="Could not load the history" actions={<Button onClick={() => setAttempt(value => value + 1)}>Retry</Button>}>
              {list.message}
            </EmptyState>
          )}
          {list.status === 'ready' && !list.versions.length && (
            <EmptyState icon={<IconClock />} title="No versions yet" actions={!form ? <Button icon={<IconPlus />} onClick={() => setForm(true)}>Save version</Button> : undefined}>
              Versions are saved automatically while you work, at most once every 10 minutes. You can also save and name an important moment yourself.
            </EmptyState>
          )}
          {days.map(day => (
            <section key={day.key} className="dz-versions-day" aria-label={day.title}>
              <h3 className="dz-versions-day-title">{day.title}</h3>
              {day.rows.map(row => row.kind === 'more' ? (
                <div role="listitem" key={'more-' + row.key}>
                  <button type="button" className="dz-version-more" onClick={() => setExpanded(current => new Set([...current, row.key]))}>
                    <IconChevronDown size={12} />
                    {row.count} more {autosaveWord(row.count)}
                  </button>
                </div>
              ) : (
                <div role="listitem" key={row.version.id}>
                  <VersionButton row={row} selected={preview?.id === row.version.id} onClick={() => show(row.version)}
                    onMenu={anchor => menu.open(anchor, menuItems(row.version))} />
                </div>
              ))}
            </section>
          ))}
        </div>
      </div>
      {note && (
        <footer className="dz-versions-note">
          <p className="dz-versions-note-title">{note.title}</p>
          <p>{note.detail}</p>
        </footer>
      )}
    </aside>
  );

  const previewElement = preview && (
    <VersionPreview key="preview" doc={preview.doc} error={preview.error} onRetry={() => show(preview.version)} fonts={fonts} images={images}
      title={previewTitle(preview.version, {now, timeZone})} onBack={back} onRestore={() => void restore()} restoring={restoring}
      restoreUnavailable={restoreUnavailable} pageId={pageId as NodeId} page={previewPage} onPageChange={setPreviewPage} />
  );
  // The version's own layers take the "Layers" panel's place while it is shown (styles/versions.css).
  const layersPage = preview?.doc ? versionPage(preview.doc, previewPage, pageId) : null;
  const layersElement = preview?.doc && layersPage && layers && (
    <VersionLayers key={preview.id + layersPage} doc={preview.doc} pageId={layersPage} expanded={layerTreeState(store).expandedFor(layersPage)} />
  );
  const pagesElement = preview?.doc && layersPage && pagesHost && <VersionPages key={preview.id} doc={preview.doc} current={layersPage} onPick={setPreviewPage} />;

  if (!targets) return null;
  return (
    <>
      {targets.panel ? createPortal(body, targets.panel) : body}
      {previewElement && (targets.canvas ? createPortal(previewElement, targets.canvas) : <div className="dz-version-preview-host is-floating">{previewElement}</div>)}
      {menu.element}
      {layersElement && layers && createPortal(layersElement, layers)}
      {pagesElement && pagesHost && createPortal(pagesElement, pagesHost)}
    </>
  );
}

function VersionButton({row, selected, onClick, onMenu}: {
  row: VersionRow;
  selected: boolean;
  onClick: () => void;
  /** Right-click, the context-menu key or ⇧F10: the version's menu. */
  onMenu: (anchor: MouseEvent | {x: number; y: number; keyboard: boolean; target: Element}) => void;
}) {
  return (
    <button type="button" data-version-row="" className={`dz-version-row ${row.named ? 'is-named' : 'is-auto'} ${selected ? 'is-selected' : ''}`.trim()}
      aria-current={selected || undefined} aria-haspopup="menu" onClick={onClick} onContextMenu={onMenu}
      onKeyDown={event => {
        if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
        event.preventDefault();
        onMenu({x: 0, y: 0, keyboard: true, target: event.currentTarget});
      }}>
      <span className="dz-version-dot" aria-hidden="true" />
      <span className="dz-version-main">
        <span className="dz-version-title">{row.title}</span>
        {row.description && <span className="dz-version-description">{row.description}</span>}
      </span>
      <time className="dz-version-time" dateTime={row.version.createdAt}>{row.time}</time>
    </button>
  );
}

function ListSkeleton() {
  return (
    <div className="dz-versions-skeleton" aria-label="Loading the history" aria-busy="true">
      {[56, 72, 48, 64].map(width => (
        <div key={width} className="dz-versions-skeleton-row">
          <span className="dz-skeleton-bar" style={{width: width + '%'}} />
          <span className="dz-skeleton-bar" style={{width: '14%'}} />
        </div>
      ))}
    </div>
  );
}

/** "Save version": a name (60 characters) and what changed (the rest of the server's 120). With `editing`, the same
 *  form renames that version ("Edit version info…", Figma's "Edit version info"): an automatic one becomes named. */
function SaveVersionForm({editing, caption, fileId, api, persistence, toast, onSaved, onCancel}: {
  editing?: DesignVersionSummary;
  /** Which version the form renames ("Saved today at 14:05"). */
  caption?: string;
  fileId: string;
  api: VersionsApi;
  persistence?: VersionPersistence;
  toast: (message: string, kind?: 'success' | 'error') => void;
  onSaved: (version: DesignVersionSummary) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(() => (editing ? decodeVersionLabel(editing.label)?.name ?? '' : ''));
  const [description, setDescription] = useState(() => (editing ? decodeVersionLabel(editing.label)?.description ?? '' : ''));
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => field.current?.focus({preventScroll: true}), []);
  const room = descriptionRoom(name);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const label = encodeVersionLabel(name, description);
    if (!label || busy) return;
    setBusy(true);
    if (editing) {
      try {
        const {version} = await api.rename(fileId, editing.id, label);
        onSaved(version);
        toast(`Version "${name.trim()}" renamed`, 'success');
      } catch (error) {
        toast(errorText(error, 'Could not rename the version.'), 'error');
        setBusy(false);
      }
      return;
    }
    try {
      // The version copies what the server holds: what was typed until now goes there first.
      if (persistence) {
        try {
          await persistence.flush();
        } catch (error) {
          throw new Error(`${errorText(error, 'Could not save the latest changes.')} The version was not created.`);
        }
      }
      const {version} = await api.save(fileId, label);
      onSaved(version);
      toast(`Version "${name.trim()}" saved`, 'success');
    } catch (error) {
      toast(errorText(error, 'Could not save the version.'), 'error');
      setBusy(false);
    }
  };

  return (
    <form className="dz-version-form" onSubmit={submit} aria-label={editing ? 'Edit version' : 'Save version'}
      onKeyDown={event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }
      }}>
      {caption && <p className="dz-version-form-caption">{caption}</p>}
      <TextInput inputRef={field} value={name} onChange={setName} placeholder="Version name" aria-label="Version name" maxLength={VERSION_NAME_MAX} />
      <label className="dz-textarea">
        <textarea value={description} onChange={event => setDescription(event.currentTarget.value.slice(0, room))} placeholder="What changed — optional"
          aria-label="Version description" rows={3} maxLength={room}
          onKeyDown={event => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void submit(event);
          }} />
      </label>
      <div className="dz-version-form-actions">
        <Button variant="ghost" onClick={onCancel}>Cancel</Button>
        <Button variant="primary" type="submit" busy={busy} disabled={!name.trim()}>Save</Button>
      </div>
    </form>
  );
}
