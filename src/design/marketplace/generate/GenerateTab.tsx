// Catalog Generation: "Generation" of a card (docs/marketplaces.md §Catalog Generation). "Product" cuts the product out of the seller's photo
// (free, on an even studio background), "Variants" makes a batch of cover variants beside the card, "WB covers" the pair of
// personalized covers, "Brand kit" edits and applies the account's brand kits, and "Catalog" starts a catalog run (the catalog module's
// button). The product itself is never redrawn.

import {memo, useMemo, useRef, useState, useSyncExternalStore, type ReactNode} from 'react';
import type {BrandKitRecord} from '../../../../shared/design/marketplace/brand-kit';
import {VARIANT_COUNT} from '../../../../shared/design/marketplace/generation';
import {pictureLayers, productColorMatch, productLayers, type Picture} from '../../../../shared/design/marketplace/generation-layers';
import type {CardMeta, LayerRole} from '../../../../shared/design/marketplace/meta';
import type {DesignDocument, NodeId} from '../../../../shared/design/types';
import {uploadDesignImage} from '../../api';
import {useEditorServices, type EditorServices} from '../../editor/services';
import type {DesignStore} from '../../engine/store';
import {useDesignStore} from '../../engine/useDesignStore';
import {Button} from '../../ui/Button';
import {IconCheck, IconWarning} from '../../ui/icons';
import {NumberField} from '../../ui/NumberField';
import {ProgressBar} from '../../ui/ProgressBar';
import {Select} from '../../ui/Select';
import {CatalogRunButton} from '../catalog/CatalogRunButton';
import {brandKitPicturesFor} from './api';
import {applyBrandKit, fontWeights, insertKitPicture, insertProductPhoto, kitPictureRoles} from './apply';
import {BrandKitDialog} from './BrandKitDialog';
import {useBrandKits} from './brand-kits-client';
import {useGenerateOptions, type GenerateOptions} from './options';
import {runCovers, runCutOut, runnerOf, runVariants, variantsWord, type RunServices, type RunState} from './runs';

// ── The runner, read live ──────────────────────────────────────────────────────────────────────

function useRun(store: DesignStore): RunState {
  const runner = runnerOf(store);
  return useSyncExternalStore(runner.subscribe, runner.get);
}

const runServices = (services: EditorServices): RunServices => ({fileId: services.fileId, store: services.store, fonts: services.fonts, revealNodes: ids => services.revealNodes(ids)});

function Group({title, children, actions}: {title: string; children: ReactNode; actions?: ReactNode}) {
  return (
    <section className="dz-mp-gen-group" aria-label={title}>
      <div className="dz-mp-gen-head">
        <h4 className="dz-mp-gen-title">{title}</h4>
        {actions}
      </div>
      {children}
    </section>
  );
}

function Note({children, tone, role}: {children: ReactNode; tone?: 'warning' | 'error' | 'ok'; role?: 'alert' | 'status'}) {
  return <p className={`dz-mp-gen-note ${tone ? `is-${tone}` : ''}`.trim()} role={role}>{children}</p>;
}

// ── The tab ─────────────────────────────────────────────────────────────────────────────────────

export const GenerateTab = memo(function GenerateTab({frameId, meta}: {frameId: NodeId; meta: CardMeta}) {
  const services = useEditorServices();
  const run = useRun(services.store);
  if (services.readOnly)
    return (
      <div className="dz-mp-gen">
        <Note>The file is open for viewing only: generation is unavailable.</Note>
      </div>
    );
  const busy = !!run.running;
  return (
    <div className="dz-mp-gen">
      <RunStatus frameId={frameId} run={run} />
      <ProductGroup frameId={frameId} busy={busy} />
      <VariantsGroup frameId={frameId} meta={meta} busy={busy} />
      {meta.marketplace === 'wb' && <CoversGroup frameId={frameId} busy={busy} />}
      <BrandGroup frameId={frameId} />
      <Group title="Catalog">
        <CatalogRunButton frameId={frameId} meta={meta} />
      </Group>
    </div>
  );
});

/** The running job (its step, progress and "Stop") or how the last one on this card ended. */
function RunStatus({frameId, run}: {frameId: NodeId; run: RunState}) {
  const services = useEditorServices();
  const runner = runnerOf(services.store);
  if (run.running) {
    const {running} = run;
    return (
      <div className="dz-mp-gen-run" aria-live="polite">
        <ProgressBar value={running.done} max={running.total > 1 ? running.total : null} label={running.step || 'Preparing…'}
          valueText={running.total > 1 ? `${running.done} of ${running.total}` : undefined} className="dz-mp-gen-progress" />
        <div className="dz-mp-gen-run-row">
          {running.cardId !== frameId && <Note>Running on another card.</Note>}
          <Button variant="ghost" onClick={() => runner.cancel()}>Stop</Button>
        </div>
      </div>
    );
  }
  const last = run.last;
  if (!last || last.cardId !== frameId) return null;
  const made = last.made?.filter(id => services.store.getState().doc.nodes[id]) ?? [];
  return (
    <div className={`dz-mp-gen-result is-${last.tone}`} role={last.tone === 'error' ? 'alert' : 'status'}>
      <span className="dz-mp-gen-result-mark" aria-hidden="true">{last.tone === 'done' ? <IconCheck size={12} /> : <IconWarning size={12} />}</span>
      <span className="dz-mp-gen-result-text">{last.message}</span>
      <span className="dz-mp-gen-result-actions">
        {made.length > 0 && (
          <Button variant="ghost" onClick={() => {
            services.store.setSelection(made);
            services.revealNodes(made);
          }}>Show</Button>
        )}
        <Button variant="ghost" aria-label="Dismiss message" onClick={() => runner.dismiss()}>Dismiss</Button>
      </span>
    </div>
  );
}

// ── "Product" ─────────────────────────────────────────────────────────────────────────────────────

type Source = {id: NodeId; name: string; ref: string; role: LayerRole | null; hidden: boolean; width: number; height: number};
const SOURCE_ROLES: ReadonlySet<LayerRole | null> = new Set([null, 'product']);

/** The card's photos a product can be cut from: the seller's own photos first (shown or hidden behind their cut-out), then its cut-outs. */
function sourcesOf(doc: DesignDocument, cardId: NodeId): Source[] {
  const all = pictureLayers(doc, cardId).filter(layer => SOURCE_ROLES.has(layer.role));
  const ordered = [...all.filter(layer => layer.role !== 'product'), ...all.filter(layer => layer.role === 'product')];
  return ordered.map(layer => {
    const asset = doc.images[layer.ref];
    return {...layer, hidden: !doc.nodes[layer.id]?.visible, width: asset?.width ?? 0, height: asset?.height ?? 0};
  });
}

function ProductGroup({frameId, busy}: {frameId: NodeId; busy: boolean}) {
  const services = useEditorServices();
  const {store} = services;
  const sourcesKey = useDesignStore(state => JSON.stringify(sourcesOf(state.doc, frameId)), Object.is, {slice: 'doc'});
  const sources = useMemo(() => JSON.parse(sourcesKey) as Source[], [sourcesKey]);
  const [chosen, setChosen] = useState<NodeId | null>(null);
  const [uploading, setUploading] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const source = sources.find(each => each.id === chosen) ?? sources[0] ?? null;
  const cut = () => {
    if (!source) return;
    setFailure(null);
    void runCutOut(runServices(services), {cardId: frameId, sourceId: source.id, imageRef: source.ref});
  };
  const upload = async (file: File) => {
    setUploading(true);
    setFailure(null);
    try {
      const picture: Picture = await uploadDesignImage(services.fileId, file, file.name);
      const id = insertProductPhoto(store, frameId, picture);
      if (id) setChosen(id);
    } catch (error) {
      setFailure(error instanceof Error && error.message ? error.message : 'Could not upload the photo.');
    } finally {
      setUploading(false);
    }
  };
  return (
    <Group title="Product">
      {sources.length > 1 && (
        <Select aria-label="Product photo" value={source?.id ?? null} onChange={setChosen}
          options={sources.map(each => ({value: each.id, label: each.name + (each.hidden ? ' · hidden' : ''), description: each.role === 'product' ? 'Already cut out' : undefined}))} />
      )}
      {source ? (
        <>
          <div className="dz-mp-gen-actions">
            <Button disabled={busy} onClick={cut}>Remove background</Button>
          </div>
          <Note>Works for studio photos on an even, plain background.</Note>
        </>
      ) : (
        <Note>The card has no product photo. Upload a photo of the product, then remove its background.</Note>
      )}
      <PhotoPicker busy={uploading} disabled={busy} label={source ? 'Upload another photo' : 'Upload a product photo'} onFile={file => void upload(file)} />
      {failure && <Note tone="error" role="alert">{failure}</Note>}
      <ColorCheck frameId={frameId} />
    </Group>
  );
}

function PhotoPicker({busy, disabled, label, onFile}: {busy: boolean; disabled: boolean; label: string; onFile: (file: File) => void}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <Button variant="ghost" className="dz-mp-gen-upload" busy={busy} disabled={busy || disabled} onClick={() => input.current?.click()}>{label}</Button>
      <input ref={input} type="file" accept="image/png,image/jpeg,image/webp" hidden aria-label={label}
        onChange={event => {
          const file = event.currentTarget.files?.[0];
          event.currentTarget.value = '';
          if (file) onFile(file);
        }} />
    </>
  );
}

/** "Product colour as in the photo", or what on the card changes the product's colours. */
function ColorCheck({frameId}: {frameId: NodeId}) {
  const key = useDesignStore(state => {
    const product = productLayers(state.doc, frameId)[0];
    return product ? JSON.stringify(productColorMatch(state.doc, frameId, product.id)) : '';
  }, Object.is, {slice: 'doc'});
  if (!key) return null;
  const match = JSON.parse(key) as {ok: boolean; issues: string[]};
  if (match.ok)
    return (
      <p className="dz-mp-gen-check is-ok" role="status">
        <span className="dz-mp-gen-check-mark" aria-hidden="true"><IconCheck size={12} /></span>
        Product colour as in the photo
      </p>
    );
  return (
    <div className="dz-mp-gen-check is-warning" role="status">
      <span className="dz-mp-gen-check-mark" aria-hidden="true"><IconWarning size={12} /></span>
      <ul aria-label="What changes the product colour">
        {match.issues.map(issue => <li key={issue}>{issue}</li>)}
      </ul>
    </div>
  );
}

// ── "Variants" and "WB covers" ───────────────────────────────────────────────────────────────────

/** The kit the panel works with: the chosen one, the last changed when none is chosen, or none. */
function useChosenKit(store: DesignStore): {record: BrandKitRecord | null; kits: readonly BrandKitRecord[]; loading: boolean; error: string | null; options: GenerateOptions; setOptions: (change: Partial<GenerateOptions>) => void} {
  const [options, setOptions] = useGenerateOptions(store);
  const {kits, loading, error} = useBrandKits();
  const record = options.kitId === 'none' ? null : (kits.find(kit => kit.id === options.kitId) ?? (options.kitId === null ? kits[0] : null) ?? null);
  return {record, kits, loading, error: error ?? null, options, setOptions};
}

function VariantsGroup({frameId, meta, busy}: {frameId: NodeId; meta: CardMeta; busy: boolean}) {
  const services = useEditorServices();
  const {record, options, setOptions} = useChosenKit(services.store);
  const start = () => void runVariants(runServices(services), {cardId: frameId, count: options.count, kit: record?.kit ?? null});
  return (
    <Group title="Variants">
      <div className="dz-mp-gen-row">
        <span className="dz-mp-gen-label">How many</span>
        <NumberField aria-label="How many variants" value={options.count} min={VARIANT_COUNT.min} max={VARIANT_COUNT.max} precision={0} className="dz-mp-gen-num"
          onChange={value => setOptions({count: Math.max(VARIANT_COUNT.min, Math.min(VARIANT_COUNT.max, Math.round(value)))})} />
      </div>
      <Button className="dz-mp-gen-main" disabled={busy} onClick={start}>
        <span>Make {options.count} {variantsWord(options.count)}</span>
      </Button>
      <Note>Backgrounds come from the brand kit colours. They appear to the right of the card, each variant is made of regular layers.</Note>
      {meta.variant !== undefined && <Note>This is variant {meta.variant}: new variants will be made from it.</Note>}
    </Group>
  );
}

function CoversGroup({frameId, busy}: {frameId: NodeId; busy: boolean}) {
  const services = useEditorServices();
  const {record} = useChosenKit(services.store);
  const start = () => void runCovers(runServices(services), {cardId: frameId, kit: record?.kit ?? null});
  return (
    <Group title="WB covers">
      <Note>Two covers for WB's personalized covers: "New buyers" shows what it is and the main benefit, "Returning buyers" shows what is new: a colour, a detail or a bundle.</Note>
      <Button className="dz-mp-gen-main" disabled={busy} onClick={start}>
        <span>Pair of WB covers</span>
      </Button>
    </Group>
  );
}

// ── "Brand kit" ──────────────────────────────────────────────────────────────────────────────────

const NO_KIT = 'none';

function BrandGroup({frameId}: {frameId: NodeId}) {
  const services = useEditorServices();
  const {store, fileId, fonts} = services;
  const {record, kits, loading, error, setOptions} = useChosenKit(store);
  const [dialog, setDialog] = useState<{record: BrandKitRecord | null} | null>(null);
  const [state, setState] = useState<{busy: boolean; note: string | null; tone?: 'ok' | 'warning' | 'error'}>({busy: false, note: null});

  const apply = async (kit: BrandKitRecord) => {
    setState({busy: true, note: null});
    try {
      const roles = kitPictureRoles(store.getState().doc, frameId);
      const urls = [roles.logo ? kit.kit.logo?.url : null, roles.storeLogo ? kit.kit.storeLogo?.url : null].filter((url): url is string => !!url);
      const pictures = urls.length ? new Map(Object.entries((await brandKitPicturesFor(kit.id, fileId, urls)).pictures)) : new Map<string, Picture>();
      await Promise.race([
        Promise.all([kit.kit.fonts.heading, kit.kit.fonts.body].flatMap(family => [400, 700].map(weight => fonts.ensure({family, weight, italic: false, size: 16}).catch(() => undefined)))),
        new Promise(resolve => setTimeout(resolve, 3000)),
      ]);
      const count = applyBrandKit(store, frameId, kit.kit, fontWeights(fonts), pictures);
      const lost = urls.filter(url => !pictures.has(url)).length;
      setState({
        busy: false,
        tone: count ? (lost ? 'warning' : 'ok') : 'warning',
        note: count
          ? `Brand kit "${kit.name}" applied: ${count} ${count === 1 ? 'layer' : 'layers'}. Undo with ⌘Z.${lost ? ' The logo is unavailable: upload it to the brand kit again.' : ''}`
          : 'The brand kit has nothing to change: mark the card layers with roles: headline, benefit, badge, background, logo.',
      });
    } catch (failure) {
      setState({busy: false, tone: 'error', note: failure instanceof Error && failure.message ? failure.message : 'Could not apply the brand kit.'});
    }
  };
  const insert = async (kit: BrandKitRecord, url: string, role: LayerRole | null, name: string) => {
    setState({busy: true, note: null});
    try {
      const picture = (await brandKitPicturesFor(kit.id, fileId, [url])).pictures[url];
      if (!picture) setState({busy: false, tone: 'warning', note: 'The picture is unavailable: upload it to the brand kit again.'});
      else {
        insertKitPicture(store, frameId, picture, role, name);
        setState({busy: false, note: null});
      }
    } catch (failure) {
      setState({busy: false, tone: 'error', note: failure instanceof Error && failure.message ? failure.message : 'Could not insert the picture.'});
    }
  };

  const kit = record?.kit;
  const pictures = kit ? [
    ...(kit.logo ? [{url: kit.logo.url, role: 'logo' as const, name: 'Logo', label: 'Brand logo'}] : []),
    ...(kit.storeLogo ? [{url: kit.storeLogo.url, role: 'store-logo' as const, name: 'Store logo', label: 'Store logo'}] : []),
    ...kit.icons.map((icon, index) => ({url: icon.url, role: null, name: icon.name?.replace(/\.[a-z0-9]+$/i, '') || `Icon ${index + 1}`, label: `Icon ${icon.name ?? index + 1}`})),
  ] : [];
  return (
    <Group title="Brand kit" actions={<Button variant="ghost" onClick={() => setDialog({record: null})} disabled={kits.length >= 20}>New</Button>}>
      {loading ? (
        <Note>Loading brand kits…</Note>
      ) : kits.length ? (
        <>
          <Select aria-label="Brand kit" value={record?.id ?? NO_KIT} onChange={kitId => setOptions({kitId})}
            options={[...kits.map(each => ({value: each.id, label: each.name})), {separator: true} as const, {value: NO_KIT, label: 'No brand kit'}]} />
          {kit && (
            <div className="dz-mp-gen-kit-preview" aria-label="Brand kit colours and fonts">
              <span className="dz-mp-gen-kit-dots">
                {(['primary', 'secondary', 'accent', 'background', 'text'] as const).map(key => <span key={key} className="dz-mp-gen-kit-dot" style={{background: kit.colors[key]}} />)}
              </span>
              <span className="dz-mp-gen-kit-fonts">{kit.fonts.heading === kit.fonts.body ? kit.fonts.heading : `${kit.fonts.heading} / ${kit.fonts.body}`}</span>
            </div>
          )}
          {record && (
            <div className="dz-mp-gen-actions">
              <Button busy={state.busy} disabled={state.busy} onClick={() => void apply(record)}>Apply to card</Button>
              <Button variant="ghost" onClick={() => setDialog({record})}>Edit</Button>
            </div>
          )}
          {pictures.length > 0 && record && (
            <div className="dz-mp-gen-kit-strip" role="group" aria-label="Insert on the card">
              {pictures.map(each => (
                <button key={each.url} type="button" className="dz-mp-gen-kit-chip" title={`Insert: ${each.label}`} aria-label={`Insert: ${each.label}`} disabled={state.busy}
                  onClick={() => void insert(record, each.url, each.role, each.name)}>
                  <img src={each.url} alt="" draggable={false} onError={event => event.currentTarget.classList.add('is-missing')} />
                </button>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          <Note>{error ?? 'Fonts, colours, logos and the brand tone in one place. Variants and covers take them from here.'}</Note>
          <Button onClick={() => setDialog({record: null})}>Create brand kit</Button>
        </>
      )}
      {state.note && <Note tone={state.tone} role={state.tone === 'error' ? 'alert' : 'status'}>{state.note}</Note>}
      {dialog && (
        <BrandKitDialog record={dialog.record} onClose={() => setDialog(null)} onSaved={saved => setOptions({kitId: saved.id})} onApply={saved => void apply(saved)} />
      )}
    </Group>
  );
}
