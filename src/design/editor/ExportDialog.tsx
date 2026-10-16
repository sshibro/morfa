import {createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode} from 'react';
import type {DesignDocument, NodeId, SceneNode} from '../../../shared/design/types';
import {snapshotDocument} from '../../../shared/design/table-cache';
import {Button} from '../ui/Button';
import {Checkbox} from '../ui/Toggle';
import {Dialog} from '../ui/Dialog';
import {EmptyState, ProgressBar} from '../ui/ProgressBar';
import {IconExport} from '../ui/icons';
import {useEditorServices} from './services';
import {exportableIds, type ExportScope} from '../engine/commands/export';
import {groupPdfJobs, nextExportSetting, planExport, settingsSummary} from '../panels/design/layout/export/files';
import {usePdfKind} from '../panels/design/layout/export/pdf-mode';
import type {VectorPdfPhase} from '../panels/design/layout/export/vector-pdf';
import '../styles/panel-layout.css';

// The export dialog (⇧⌘E "Export…", "Export selection…"): every layer of the page that has
// export settings — or the selection — with a checkbox, a small preview and what it will write; one
// "Export" downloads them, several files as one zip. Opened by the editor through
// `services.openDialog('export', {scope})` (engine/commands/export.ts).

export type ExportDialogProps = {scope?: ExportScope; onClose: () => void};

const loadRunner = () => import('../panels/design/layout/export/run');
const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);
const filesLabel = (count: number) => `${count} ${plural(count, 'file', 'files')}`;
/** What the vector PDF waits for, under the progress bar. */
const PHASE_LABEL: Record<VectorPdfPhase, string> = {saving: 'Saving file…', printing: 'Building PDF…', waiting: 'Waiting in line…'};

export default function ExportDialog({scope = 'page', onClose}: ExportDialogProps) {
  const services = useEditorServices();
  const {store} = services;
  // A snapshot: the dialog lists what was there when it opened — a document of its own, since the store's table may be
  // written in place and a remote change may land while the dialog is open.
  const [doc] = useState(() => snapshotDocument(store.getState().doc));
  const ids = useMemo(() => {
    const state = store.getState();
    return exportableIds(doc, state.pageId, scope, state.selection);
  }, [doc, scope, store]);
  const [checked, setChecked] = useState<ReadonlySet<NodeId>>(() => new Set(ids));
  const pdf = usePdfKind();
  const [progress, setProgress] = useState<{done: number; total: number} | null>(null);
  const [phase, setPhase] = useState<VectorPdfPhase | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const items = useMemo(() => ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node)
    .map(node => ({node, settings: node.exportSettings.length ? node.exportSettings : [nextExportSetting([])]})), [doc, ids]);
  const jobs = useMemo(() => planExport(items.filter(item => checked.has(item.node.id))), [items, checked]);
  // The vector PDF writes the PDF settings of all the layers into one file per suffix: count files, not settings.
  const fileCount = useMemo(() => {
    if (pdf !== 'vector') return jobs.length;
    const {pdf: groups, other} = groupPdfJobs(jobs, '');
    return groups.length + other.length;
  }, [jobs, pdf]);
  const all = checked.size === items.length ? true : checked.size ? 'mixed' : false;

  const run = async () => {
    if (!jobs.length) return;
    const controller = new AbortController();
    abort.current = controller;
    setProgress({done: 0, total: jobs.length});
    try {
      const runner = await loadRunner();
      const chosen = items.filter(item => checked.has(item.node.id));
      const base = chosen.length === 1 ? chosen[0].node.name : pageName(doc, store.getState().pageId);
      const files = await runner.runExport(doc, jobs, services, (done, total) => {
        setProgress({done, total});
        setPhase(null);
      }, controller.signal, {pdf, base, onPdfPhase: setPhase, onLocalFonts: families => services.toast(runner.localFontsNote(families))});
      const packed = await runner.packFiles(files, base);
      runner.downloadFile(packed.name, packed.blob);
      services.toast(files.length === 1 ? 'File saved' : `Saved ${filesLabel(files.length)} in the archive`, 'success');
      onClose();
    } catch (error) {
      if (controller.signal.aborted) return;
      const runner = await loadRunner().catch(() => null);
      services.toast(runner ? runner.exportErrorMessage(error) : 'Could not load export. Check your connection.', 'error');
      setProgress(null);
      setPhase(null);
    }
  };

  const busy = progress !== null;
  const title = scope === 'selection' ? 'Export selection' : 'Export';
  return (
    <Dialog title={title} onClose={onClose} width={440} dismissible={!busy}
      footer={items.length ? (
        <>
          {busy && <ProgressBar className="dz-xd-progress" value={progress.done} max={progress.total} label={phase ? PHASE_LABEL[phase] : `Done ${progress.done} of ${progress.total}`} />}
          <Button size={32} onClick={onClose}>{busy ? 'Stop' : 'Cancel'}</Button>
          <Button size={32} variant="primary" icon={<IconExport />} busy={busy} disabled={!jobs.length} onClick={run}>
            {jobs.length ? `Export ${filesLabel(fileCount)}` : 'Export'}
          </Button>
        </>
      ) : <Button size={32} variant="primary" onClick={onClose}>Got it</Button>}>
      {items.length ? (
        <>
          <div className="dz-xd-head">
            <Checkbox checked={all} disabled={busy} onChange={next => setChecked(next ? new Set(ids) : new Set())}>Select all</Checkbox>
            <span className="dz-xd-count">{items.length} {plural(items.length, 'layer', 'layers')}</span>
          </div>
          <ThumbnailQueueProvider doc={doc}>
            <div className="dz-xd-list" role="list">
              {items.map(item => (
                <ExportRow key={item.node.id} node={item.node} summary={settingsSummary(item.settings, pdf)} checked={checked.has(item.node.id)} disabled={busy}
                  onToggle={on => setChecked(current => {
                    const next = new Set(current);
                    if (on) next.add(item.node.id);
                    else next.delete(item.node.id);
                    return next;
                  })} />
              ))}
            </div>
          </ThumbnailQueueProvider>
        </>
      ) : (
        <EmptyState icon={<IconExport />} title={scope === 'selection' ? 'Nothing selected' : 'Nothing to export'}>
          {scope === 'selection' ? 'Select layers on the canvas and open export again.' : 'This page has no layers with export settings. Add them in the Export section of the Design panel.'}
        </EmptyState>
      )}
    </Dialog>
  );
}

const pageName = (doc: DesignDocument, pageId: NodeId) => doc.nodes[pageId]?.name || 'Export';

const ExportRow = memo(function ExportRow({node, summary, checked, disabled, onToggle}: {node: SceneNode; summary: string; checked: boolean; disabled: boolean; onToggle: (on: boolean) => void}) {
  return (
    <div className="dz-xd-row" role="listitem">
      <Checkbox checked={checked} disabled={disabled} onChange={onToggle} aria-label={`Export ${node.name}`} />
      <Thumbnail id={node.id} />
      <div className="dz-xd-text">
        <span className="dz-xd-name" title={node.name}>{node.name}</span>
        <span className="dz-xd-files" title={summary}>{summary}</span>
      </div>
    </div>
  );
});

// ── Thumbnails: drawn one at a time, only for rows scrolled into view ─────────────────────────


type Queue = {request(id: NodeId, done: (url: string | null) => void): () => void};
const QueueContext = createContext<Queue | null>(null);

function ThumbnailQueueProvider({doc, children}: {doc: DesignDocument; children: ReactNode}) {
  const services = useEditorServices();
  // Made in the effect that disposes it: a queue disposed by one effect run (React runs effects twice in
  // development) must never be handed out again, or no thumbnail is ever drawn.
  const [queue, setQueue] = useState<Queue | null>(null);
  useEffect(() => {
    const made = createThumbnailQueue(doc, services);
    setQueue(made);
    return () => made.dispose();
  }, [doc, services]);
  return <QueueContext.Provider value={queue}>{children}</QueueContext.Provider>;
}

function createThumbnailQueue(doc: DesignDocument, services: ReturnType<typeof useEditorServices>): Queue & {dispose(): void} {
  const waiting: {id: NodeId; done: (url: string | null) => void; cancelled: boolean}[] = [];
  const urls: string[] = [];
  let running = false;
  let disposed = false;
  const pump = async () => {
    if (running || disposed) return;
    running = true;
    while (waiting.length && !disposed) {
      const job = waiting.shift()!;
      if (job.cancelled) continue;
      try {
        const runner = await loadRunner();
        const blob = await runner.renderPreview(doc, job.id, services, 40, 40, Math.min(2, window.devicePixelRatio || 1));
        const url = blob ? URL.createObjectURL(blob) : null;
        if (url) urls.push(url);
        if (!job.cancelled && !disposed) job.done(url);
      } catch {
        if (!job.cancelled && !disposed) job.done(null);
      }
    }
    running = false;
  };
  return {
    request(id, done) {
      const job = {id, done, cancelled: false};
      waiting.push(job);
      void pump();
      return () => {job.cancelled = true;};
    },
    dispose() {
      disposed = true;
      urls.forEach(url => URL.revokeObjectURL(url));
    },
  };
}

function Thumbnail({id}: {id: NodeId}) {
  const queue = useContext(QueueContext);
  const box = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    const element = box.current;
    if (!element || !queue) return;
    let cancel: (() => void) | null = null;
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting) || cancel) return;
      cancel = queue.request(id, setUrl);
      observer.disconnect();
    });
    observer.observe(element);
    return () => {
      observer.disconnect();
      cancel?.();
    };
  }, [id, queue]);
  return <div ref={box} className="dz-xd-thumb" aria-hidden="true">{url ? <img src={url} alt="" /> : null}</div>;
}
