import {memo, useEffect, useMemo, useRef, useState} from 'react';
import {cardSet, EXPORT_FORMAT_LABEL, formatFileSize, isLossy} from '../../../../shared/design/marketplace/export';
import {cardExportOf, cardMeta, withCardMeta, type CardExport, type CardMeta} from '../../../../shared/design/marketplace/meta';
import {buildSlideKit, SLIDE_GAP} from '../../../../shared/design/marketplace/slide-kits';
import {CARD_SLIDE_KINDS, CARD_SLIDE_LABELS, MARKETPLACES, marketplaceSpec, type CardSlideKind, type Marketplace} from '../../../../shared/design/marketplace/specs';
import type {Transaction} from '../../../../shared/design/transaction';
import type {NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import type {Gesture} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {Button} from '../../ui/Button';
import {IconCheck} from '../../ui/icons';
import {NumberField} from '../../ui/NumberField';
import {ProgressBar} from '../../ui/ProgressBar';
import {Select} from '../../ui/Select';
import {Slider} from '../../ui/Slider';
import {SegmentedControl} from '../../ui/Tabs';
import {Checkbox} from '../../ui/Toggle';
import {useBrandKits} from '../generate/brand-kits-client';
import type {CardExportResult} from './run';

// Card Canvas: "Export", one master card exported for each marketplace (docs/marketplaces.md §One master, three exports). The format,
// quality (WB's least 65 % marked on the slider) and scale are the card's own (meta `export`, each change one undo step); the marketplaces
// are this panel's. "Export" zips the card re-flowed for each marketplace, "Whole set" every frame of its set numbered by slide;
// each file's size shows after. Below, "Slide set" adds the six slides a card needs from auto-layout templates (slide-kits.ts).

const loadRunner = () => import('./run');

const FORMATS: readonly CardExport['format'][] = ['jpg', 'png', 'webp'];
const SCALES = [{value: '1', label: '1×'}, {value: '2', label: '2×'}] as const;
/** WB's least JPEG quality: the one marketplace that sets one. */
const WB_QUALITY = marketplaceSpec('wb').minJpegQuality ?? 65;

export function ExportTab({frameId, meta}: {frameId: NodeId; meta: CardMeta}) {
  return (
    <>
      <ExportBlock frameId={frameId} meta={meta} />
      <SlideKitBlock frameId={frameId} meta={meta} />
    </>
  );
}

// ── Export ──────────────────────────────────────────────────────────────────────────────────────

type Run = {scope: 'card' | 'set'; done: number; total: number} | null;

const ExportBlock = memo(function ExportBlock({frameId, meta}: {frameId: NodeId; meta: CardMeta}) {
  const services = useEditorServices();
  const {store} = services;
  const settings = cardExportOf(meta);
  const [markets, setMarkets] = useState<readonly Marketplace[]>(MARKETPLACES);
  const [run, setRun] = useState<Run>(null);
  const [result, setResult] = useState<CardExportResult | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const setSize = useDesignStore(state => cardSet(state.doc, frameId).length, Object.is, {slice: 'doc'});
  const alive = useRef(true);
  const gesture = useRef<Gesture | null>(null);
  // Set on every mount: StrictMode mounts twice, and a flag only ever cleared would drop every answer.
  useEffect(() => {
    alive.current = true;
    return () => void (alive.current = false);
  }, []);
  useEffect(() => {
    setResult(null);
    setFailure(null);
  }, [frameId]);

  /** The card's meta with new export settings, as the recipe of one step. */
  const write = (next: CardExport) => (tx: Transaction) => {
    const node = tx.get(frameId);
    const current = cardMeta(node);
    if (node && current) tx.update(frameId, {pluginData: withCardMeta(node.pluginData, {...current, export: next})});
  };
  const save = (patch: Partial<CardExport>, coalesce?: string) => {
    const next = {...settings, ...patch};
    if (gesture.current?.active) gesture.current.update(write(next));
    else store.transact('Card export settings', write(next), coalesce ? {coalesce} : undefined);
  };

  const start = async (scope: 'card' | 'set') => {
    if (run || !markets.length) return;
    setRun({scope, done: 0, total: 0});
    setFailure(null);
    setResult(null);
    try {
      const runner = await loadRunner();
      const answer = await runner.exportCard(services, frameId, scope, markets, settings, (done, total) => alive.current && setRun({scope, done, total}));
      if (alive.current) setResult(answer);
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : 'Could not export. Try again.';
      if (alive.current) setFailure(message);
    } finally {
      if (alive.current) setRun(null);
    }
  };

  const lossy = isLossy(settings.format);
  const wbLow = lossy && markets.includes('wb') && settings.quality < WB_QUALITY;
  const readOnly = !!services.readOnly;
  return (
    <div className="dz-mp-export">
      <div className="dz-mp-export-row">
        <span className="dz-mp-export-label">Format</span>
        <Select<CardExport['format']> aria-label="File format" value={settings.format} disabled={readOnly}
          options={FORMATS.map(format => ({value: format, label: EXPORT_FORMAT_LABEL[format]}))}
          onChange={format => save({format})} className="dz-mp-export-format" />
        <SegmentedControl aria-label="Scale" value={settings.scale === 2 ? '2' : settings.scale === 1 ? '1' : null} options={SCALES}
          onChange={value => !readOnly && save({scale: Number(value)})} />
      </div>
      <div className={`dz-mp-export-row ${lossy ? '' : 'is-off'}`.trim()}>
        <span className="dz-mp-export-label">Quality</span>
        <div className="dz-mp-export-quality">
          <Slider aria-label="Quality" min={1} max={100} value={settings.quality} valueText={`${settings.quality} %`} disabled={!lossy || readOnly}
            onChangeStart={() => {
              gesture.current = store.gesture('Card export quality');
            }}
            onChange={quality => save({quality}, 'mp-export-quality')}
            onChangeEnd={() => {
              gesture.current?.commit();
              gesture.current = null;
            }} />
          <span className="dz-mp-export-tick" aria-hidden="true" style={{left: `calc(6px + ${(WB_QUALITY - 1) / 99} * (100% - 12px))`}} />
        </div>
        <NumberField aria-label="Quality, %" value={settings.quality} min={1} max={100} precision={0} suffix=" %" disabled={!lossy || readOnly}
          className="dz-mp-export-percent" onChange={quality => save({quality: Math.round(quality)}, 'mp-export-quality')} />
      </div>
      <p className={`dz-mp-export-note ${wbLow ? 'is-warning' : ''}`.trim()}>
        {!lossy ? 'PNG is lossless: the file is larger and quality cannot be set.'
          : wbLow ? `WB will not accept this: at least ${WB_QUALITY}% is needed.`
            : `The mark is WB's minimum, ${WB_QUALITY}%. A file over 10 MB is compressed harder, but not below that.`}
      </p>
      <div className="dz-mp-export-row" role="group" aria-label="Marketplaces">
        <span className="dz-mp-export-label">For</span>
        {MARKETPLACES.map(id => (
          <Checkbox key={id} checked={markets.includes(id)} className="dz-mp-export-market"
            onChange={on => setMarkets(current => (on ? MARKETPLACES.filter(each => each === id || current.includes(each)) : current.filter(each => each !== id)))}>
            {marketplaceSpec(id).short}
          </Checkbox>
        ))}
      </div>
      <div className="dz-mp-export-actions">
        <Button variant="primary" busy={run?.scope === 'card'} disabled={!!run || !markets.length} onClick={() => void start('card')}>Export</Button>
        <Button busy={run?.scope === 'set'} disabled={!!run || !markets.length || setSize < 2} onClick={() => void start('set')}
          title={setSize < 2 ? 'The set has one card: add slides below' : undefined}>
          Whole set{setSize > 1 ? ` · ${setSize}` : ''}
        </Button>
      </div>
      {run && run.total > 1 && <ProgressBar value={run.done} max={run.total} label="Export" valueText={`${run.done} of ${run.total}`} className="dz-mp-export-progress" />}
      {failure && <p className="dz-mp-export-note is-error" role="alert">{failure}</p>}
      {result && <ExportResult result={result} settings={settings} />}
    </div>
  );
});

function ExportResult({result, settings}: {result: CardExportResult; settings: CardExport}) {
  const over = result.files.filter(file => file.oversize).length;
  return (
    <div className="dz-mp-export-result" aria-live="polite">
      <p className="dz-mp-export-note">Downloaded {result.zipName}</p>
      <ul className="dz-mp-export-files" aria-label="Files">
        {result.files.map(file => (
          <li key={file.path} className={file.oversize ? 'is-over' : undefined}>
            <span className="dz-mp-export-file" title={file.path}>{file.path.split('/').slice(1).join('/')}</span>
            {file.quality !== null && file.quality < settings.quality && <span className="dz-mp-export-squeezed">{file.quality} %</span>}
            <span className="dz-mp-export-size">{formatFileSize(file.bytes)}</span>
          </li>
        ))}
      </ul>
      {over > 0 && <p className="dz-mp-export-note is-error">Over 10 MB: {over === 1 ? 'the file' : `${over} files`} will not pass the marketplace check. Reduce the scale or choose JPG.</p>}
    </div>
  );
}

// ── Slide kits ──────────────────────────────────────────────────────────────────────────────────

const NO_BRAND = 'none';

const SlideKitBlock = memo(function SlideKitBlock({frameId, meta}: {frameId: NodeId; meta: CardMeta}) {
  const services = useEditorServices();
  const {store} = services;
  const {kits} = useBrandKits();
  const [brand, setBrand] = useState<string>(NO_BRAND);
  const present = useDesignStore(state => cardSet(state.doc, frameId).map(member => member.meta.slide).filter((slide): slide is CardSlideKind => !!slide).sort().join(','), Object.is, {slice: 'doc'});
  const have = useMemo(() => new Set(present.split(',').filter(Boolean)), [present]);
  const missing = CARD_SLIDE_KINDS.filter(kind => !have.has(kind));
  const readOnly = !!services.readOnly;

  const add = (kinds: readonly CardSlideKind[]) => {
    const doc = store.getState().doc;
    const frame = doc.nodes[frameId];
    const current = cardMeta(frame);
    if (!frame || !current || !frame.parentId || !kinds.length) return;
    const group = current.group ?? frameId;
    // To the right of the set, level with its top.
    const members = cardSet(doc, frameId).map(member => doc.nodes[member.id]!).filter(Boolean);
    const right = Math.max(...members.map(node => node.x + node.width));
    const top = Math.min(...members.map(node => node.y));
    const kit = kits.find(record => record.id === brand)?.kit ?? null;
    const build = buildSlideKit({marketplace: current.marketplace, slides: kinds, origin: {x: right + SLIDE_GAP, y: top}, group, brand: kit});
    const parentId = frame.parentId;
    store.transact(kinds.length === 1 ? `Add slide "${CARD_SLIDE_LABELS[kinds[0]]}"` : 'Add slides', tx => {
      // A card without a set starts one: it and its new slides share its id.
      if (!current.group) tx.update(frameId, {pluginData: withCardMeta(frame.pluginData, {...current, group})});
      for (const node of build.nodes) tx.create(node, node.parentId ?? parentId);
    });
    services.revealNodes([frameId, ...build.frameIds]);
    services.toast(kinds.length === 1 ? `Slide "${CARD_SLIDE_LABELS[kinds[0]]}" added to the right of the set.` : `Slides added: ${kinds.length}.`, 'success');
  };

  return (
    <div className="dz-mp-kit">
      <div className="dz-mp-kit-head">
        <span className="dz-mp-kit-title">Slide set</span>
        <span className="dz-mp-kit-count">{CARD_SLIDE_KINDS.length - missing.length} of {CARD_SLIDE_KINDS.length}</span>
      </div>
      {kits.length > 0 && !readOnly && (
        <div className="dz-mp-export-row">
          <span className="dz-mp-export-label">Brand</span>
          <Select aria-label="Brand for new slides" value={brand} onChange={setBrand} className="dz-mp-kit-brand"
            options={[{value: NO_BRAND, label: 'No brand'}, ...kits.map(record => ({value: record.id, label: record.name}))]} />
        </div>
      )}
      <ul className="dz-mp-kit-list" aria-label="Slides of the set">
        {CARD_SLIDE_KINDS.map((kind, index) => (
          <li key={kind} className={`dz-mp-kit-slide ${have.has(kind) ? 'is-present' : ''}`.trim()}>
            <span className="dz-mp-kit-number">{String(index + 1).padStart(2, '0')}</span>
            <span className="dz-mp-kit-name">{CARD_SLIDE_LABELS[kind]}</span>
            {have.has(kind) ? (
              <span className="dz-mp-kit-mark" aria-label="In the set"><IconCheck size={14} /></span>
            ) : !readOnly && (
              <Button size={24} variant="ghost" className="dz-mp-kit-add" aria-label={`Add "${CARD_SLIDE_LABELS[kind]}"`} onClick={() => add([kind])}>Add</Button>
            )}
          </li>
        ))}
      </ul>
      {missing.length > 1 && !readOnly && (
        <Button className="dz-mp-kit-all" onClick={() => add(missing)}>Add the missing ones · {missing.length}</Button>
      )}
      <p className="dz-mp-export-note">Auto layout: long text wraps and the product photo makes room for it. Content stays clear of the {marketplaceSpec(meta.marketplace).short} badges.</p>
    </div>
  );
});
