import {memo, useCallback, useEffect, useRef, useState} from 'react';
import type {DesignDocument, ExportSetting, NodeId, SceneNode} from '../../../../../shared/design/types';
import {Button, IconButton} from '../../../ui/Button';
import {PanelSection} from '../../../ui/PanelSection';
import {TextInput} from '../../../ui/TextInput';
import type {MenuItem} from '../../../ui/menu-model';
import {IconChevronDown, IconMinus} from '../../../ui/icons';
import {Spinner} from '../../../ui/Spinner';
import {useEditorServices} from '../../../editor/services';
import {isAncestor} from '../../../../../shared/design/tree';
import type {SectionProps} from '../sections';
import {sameSectionProps, usePanelEdit, usePanelStore, useSectionView} from '../shared/edit';
import {FieldMenuButton, MenuSelect} from '../shared/fields';
import {layersLabel, mixedOf, sameValue} from '../shared/mixed';
import {EXPORT_FORMATS, SCALE_PRESETS, exportButtonLabel, formatConstraint, formatHasScale, formatLabel, nextExportSetting, parseConstraint, planExport, type PdfKind} from './export/files';
import {usePdfKind} from './export/pdf-mode';

// "Export" (order 110): the layer's export settings — scale ("1x", "512w"), suffix, format — then
// "Export …" and a live preview. Several settings or layers download as one zip; the PDF
// settings of several layers become one multi-page PDF. The export code itself (raster, SVG, the
// server's vector PDF, zip) loads on first use (export/run.ts).

type View = {settings: ExportSetting[] | 'mixed'; names: string[]};

function viewOf(doc: DesignDocument, ids: readonly NodeId[]): View | null {
  const nodes = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && node.type !== 'PAGE');
  if (!nodes.length) return null;
  const settings = mixedOf(nodes.map(node => node.exportSettings));
  return {settings: settings === 'mixed' ? 'mixed' : settings ?? [], names: nodes.map(node => node.name)};
}

const loadRunner = () => import('./export/run');

export const ExportSection = memo(function ExportSection({ids}: SectionProps) {
  const view = useSectionView(viewOf, ids, sameValue);
  const edit = usePanelEdit();
  const store = usePanelStore();
  const services = useEditorServices();
  const pdf = usePdfKind();
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(false);
  if (!view) return null;

  const settings = view.settings === 'mixed' ? [] : view.settings;
  const setSettings = (label: string, make: (settings: ExportSetting[]) => ExportSetting[]) =>
    edit.nodes(label, ids, node => ({exportSettings: make(node.exportSettings)}));
  const add = () => setSettings('Add export', current => (view.settings === 'mixed' ? [nextExportSetting([])] : [...current, nextExportSetting(current)]));
  const update = (index: number, patch: Partial<ExportSetting>, label: string) =>
    setSettings(label, current => current.map((setting, i) => (i === index ? {...setting, ...patch} : setting)));

  const run = async () => {
    const doc = store.getState().doc;
    const items = ids.map(id => doc.nodes[id]).filter(Boolean).map(node => ({node, settings: node.exportSettings.length ? node.exportSettings : [nextExportSetting([])]}));
    const jobs = planExport(items);
    if (!jobs.length) return;
    setBusy(true);
    try {
      const runner = await loadRunner();
      const base = items.length === 1 ? items[0].node.name : 'Export';
      const files = await runner.runExport(doc, jobs, services, undefined, undefined, {pdf, base, onLocalFonts: families => services.toast(runner.localFontsNote(families))});
      const packed = await runner.packFiles(files, base);
      runner.downloadFile(packed.name, packed.blob);
    } catch (error) {
      const runner = await loadRunner().catch(() => null);
      services.toast(runner ? runner.exportErrorMessage(error) : 'Could not download the export. Check your connection.', 'error');
    } finally {
      setBusy(false);
    }
  };

  const empty = view.settings !== 'mixed' && !settings.length;
  return (
    <PanelSection title="Export" className="dz-pl-section" empty={empty} onAdd={add} addLabel="Add export setting">
      {view.settings === 'mixed' ? (
        <p className="dz-pl-note">The layers have different export settings. "+" will replace them with one.</p>
      ) : settings.map((setting, index) => (
        <ExportRow key={index} setting={setting} pdf={pdf}
          onChange={(patch, label) => update(index, patch, label)}
          onRemove={() => setSettings('Delete export setting', current => current.filter((_, i) => i !== index))} />
      ))}
      {!empty && (
        <>
          <Button className="dz-pl-export-button" busy={busy} onClick={run} title={exportButtonLabel(view.names, layersLabel)}>
            {exportButtonLabel(view.names, layersLabel)}
          </Button>
          <button type="button" className="dz-pl-disclosure" aria-expanded={preview} onClick={() => setPreview(open => !open)}>
            <span className={`dz-pl-disclosure-chevron ${preview ? 'is-open' : ''}`.trim()} aria-hidden="true"><IconChevronDown size={12} /></span>
            Preview
          </button>
          {preview && <ExportPreview id={ids[0]} />}
        </>
      )}
    </PanelSection>
  );
}, sameSectionProps);

// ── One setting ────────────────────────────────────────────────────────────────────────────────

const PDF_NOTE: Record<PdfKind, string> = {vector: 'Vectors and text, 1 px = 1 pt', raster: 'Lossless image on the PDF page'};

function ExportRow({setting, pdf, onChange, onRemove}: {setting: ExportSetting; pdf: PdfKind; onChange: (patch: Partial<ExportSetting>, label: string) => void; onRemove: () => void}) {
  const scaled = formatHasScale(setting.format, pdf);
  const formats = useCallback((): MenuItem[] => [
    ...EXPORT_FORMATS.map((format): MenuItem => ({
      id: format, label: formatLabel(format, pdf), checked: format === setting.format, radio: true,
      description: format === 'PDF' ? PDF_NOTE[pdf] : undefined,
      onSelect: () => onChange({format}, `Export format: ${format}`),
    })),
    // SVG's own option, as Figma's export settings have it: layer names as ids, for code that styles or animates parts.
    ...(setting.format === 'SVG' ? [
      {type: 'separator'} as MenuItem,
      {id: 'svg-ids', label: 'Add layer ids', checked: !!setting.svgIdAttribute, description: 'The layer name becomes the id attribute',
        onSelect: () => onChange({svgIdAttribute: !setting.svgIdAttribute}, 'SVG: layer ids')} as MenuItem,
    ] : []),
  ], [setting.format, setting.svgIdAttribute, pdf, onChange]);
  return (
    <div className="dz-pl-export-row">
      <ScaleField setting={setting} disabled={!scaled} onChange={constraint => onChange({constraint}, 'Export scale')} />
      <SuffixField value={setting.suffix} onChange={suffix => onChange({suffix}, 'Export suffix')} />
      <MenuSelect label="Format" display={setting.format} items={formats} minWidth={180} alignItemId={setting.format} />
      <IconButton label="Delete export setting" onClick={onRemove}><IconMinus /></IconButton>
    </div>
  );
}

/** "1x": typed ("2", "0,5x", "512w") or picked from the presets. */
function ScaleField({setting, disabled, onChange}: {setting: ExportSetting; disabled: boolean; onChange: (constraint: ExportSetting['constraint']) => void}) {
  const shown = disabled ? '' : formatConstraint(setting.constraint);
  const [draft, setDraft] = useState(shown);
  useEffect(() => setDraft(shown), [shown]);
  const commit = (text: string) => {
    const parsed = parseConstraint(text);
    if (parsed && !sameValue(parsed, setting.constraint)) onChange(parsed);
    else setDraft(shown);
  };
  const presets = (): MenuItem[] => SCALE_PRESETS.map(constraint => ({
    id: formatConstraint(constraint), label: formatConstraint(constraint), checked: sameValue(constraint, setting.constraint), radio: true, onSelect: () => onChange(constraint),
  }));
  return (
    <div className="dz-pl-combo dz-pl-scale">
      <TextInput aria-label="Scale" value={draft} onChange={setDraft} onCommit={commit} onBlur={event => commit(event.currentTarget.value)}
        disabled={disabled} placeholder={disabled ? '—' : '1x'} selectOnFocus
        title={disabled ? (setting.format === 'PDF' ? 'PDF is saved at actual size: 1 px = 1 pt' : 'SVG is saved unscaled') : 'Scale: 2x, 0.5x, 512w (width), 512h (height)'} />
      {!disabled && <FieldMenuButton label="Scale" items={presets} minWidth={96} />}
    </div>
  );
}

function SuffixField({value, onChange}: {value: string; onChange: (suffix: string) => void}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const commit = (text: string) => {
    const next = text.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 64);
    if (next !== value) onChange(next);
    else setDraft(value);
  };
  return <TextInput aria-label="File name suffix" value={draft} onChange={setDraft} onCommit={commit} onBlur={event => commit(event.currentTarget.value)} placeholder="Suffix" className="dz-pl-suffix" />;
}

// ── Preview ────────────────────────────────────────────────────────────────────────────────────

/** True when a change touches the layer or anything inside it. */
function touches(doc: DesignDocument, changed: ReadonlySet<NodeId>, id: NodeId): boolean {
  if (changed.size > 2000) return true;
  for (const each of changed) if (each === id || isAncestor(doc, id, each)) return true;
  return false;
}

/** The layer as it exports, redrawn a moment after it changes (never during a drag). */
function ExportPreview({id}: {id: NodeId}) {
  const services = useEditorServices();
  const store = services.store;
  const [state, setState] = useState<{url: string | null; status: 'loading' | 'ready' | 'empty'}>({url: null, status: 'loading'});
  const urlRef = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let version = 0;
    const draw = async () => {
      const mine = ++version;
      try {
        const runner = await loadRunner();
        const blob = await runner.renderPreview(store.getState().doc, id, services, 216, 160, Math.min(2, window.devicePixelRatio || 1));
        if (!alive || mine !== version) return;
        if (urlRef.current) URL.revokeObjectURL(urlRef.current);
        urlRef.current = blob ? URL.createObjectURL(blob) : null;
        setState({url: urlRef.current, status: blob ? 'ready' : 'empty'});
      } catch {
        if (alive && mine === version) setState({url: null, status: 'empty'});
      }
    };
    void draw();
    const off = store.onDocument(change => {
      if (change.source === 'gesture' || !touches(change.doc, change.changed, id)) return;
      clearTimeout(timer);
      timer = setTimeout(draw, 250);
    });
    return () => {
      alive = false;
      off();
      clearTimeout(timer);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = null;
    };
  }, [id, store, services]);
  return (
    <div className="dz-pl-preview" aria-live="polite">
      {state.url ? <img src={state.url} alt="Export preview" /> : state.status === 'loading' ? <Spinner size={16} label="Preparing the preview" /> : <span className="dz-pl-note">Nothing to show</span>}
    </div>
  );
}

