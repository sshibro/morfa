import {memo, useMemo, useState, type CSSProperties, type ReactNode} from 'react';
import type {DesignDocument, NodeId, SceneNode} from '../../../../shared/design/types';
import type {CodeFormat} from '../../../../shared/design/codegen/format';
import {formatValue} from '../../../../shared/design/codegen/format';
import {snapshotDocument} from '../../../../shared/design/table-cache';
import type {TokenTable} from '../../../../shared/design/codegen/tokens';
import {px} from '../../../../shared/design/codegen/values';
import {booleanGeometry} from '../../../../shared/design/boolean';
import {layersLabel} from '../design/shared/mixed';
import {exportSvg} from '../../../../shared/design/svg-export';
import {IconButton} from '../../ui/Button';
import {ColorSwatch} from '../../ui/ColorSwatch';
import {IconDownload} from '../../ui/icons';
import {PanelSection} from '../../ui/PanelSection';
import {formatNumber} from '../../ui/number-expression';
import {useEditorServices} from '../../editor/services';
import {downloadBlob} from '../../engine/commands/code';
import {exportRaster, ExportError} from '../../engine/export-raster';
import {useCopy} from './CopyButton';
import {boxModel, detectAssets, exportAssets, layoutRows, sizingLabel, stylesUsed, typographyRows, type AssetEntry, type BoxModel, type DetectedAsset, type Measure, type StyleEntry, type StyleKind} from './inspect';

// The "Code" tab's inspect sections (Figma's Dev Mode): the box model and auto layout, typography with a sample, the styles
// and variables in use, and the assets: icons and images found in the selection, and the layer's export settings.

export function MeasureRows({rows}: {rows: readonly Measure[]}) {
  const copy = useCopy();
  return (
    <div className="dz-code-measures">
      {rows.map(row => (
        <button key={row.label} type="button" className="dz-code-measure" onClick={() => copy(row.copy)} title={`Copy "${row.copy}"`}>
          <span className="dz-code-measure-label">{row.label}</span>
          <span className="dz-code-measure-value">{row.value}</span>
          {row.note && <span className="dz-code-measure-note">{row.note}</span>}
        </button>
      ))}
    </div>
  );
}

// ── Layout ─────────────────────────────────────────────────────────────────────────────────────

export const LayoutSection = memo(function LayoutSection({doc, node, format}: {doc: DesignDocument; node: SceneNode; format: CodeFormat}) {
  const box = useMemo(() => boxModel(doc, node), [doc, node]);
  const length = (value: number) => formatValue('width', px(value), format);
  const rows: Measure[] = [
    {label: 'Width', value: length(box.width), note: sizingLabel(box.sizing.horizontal), copy: box.sizing.horizontal === 'FILL' ? 'flex: 1;' : `width: ${length(box.width)};`},
    {label: 'Height', value: length(box.height), note: sizingLabel(box.sizing.vertical), copy: box.sizing.vertical === 'FILL' ? 'align-self: stretch;' : `height: ${length(box.height)};`},
  ];
  if (!box.inFlow && node.parentId && doc.nodes[node.parentId]?.type !== 'PAGE') {
    rows.push({label: 'Left', value: length(box.x), copy: `left: ${length(box.x)};`}, {label: 'Top', value: length(box.y), copy: `top: ${length(box.y)};`});
  }
  if (box.radius) rows.push({label: 'Corner radius', value: box.radius, copy: `border-radius: ${formatValue('border-radius', box.radius, format)};`});
  if (box.rotation) rows.push({label: 'Rotation', value: `${formatNumber(box.rotation, 2)}°`, copy: `transform: rotate(${formatNumber(-box.rotation, 2).replace(',', '.')}deg);`});
  if (node.opacity < 1) rows.push({label: 'Opacity', value: `${formatNumber(node.opacity * 100, 1)}%`, copy: `opacity: ${node.opacity};`});
  const autoLayout = layoutRows(node, format);
  return (
    <PanelSection title="Layout">
      <BoxDiagram box={box} format={format} />
      <MeasureRows rows={rows} />
      {autoLayout && (
        <>
          <h4 className="dz-code-subtitle">Auto layout</h4>
          <MeasureRows rows={autoLayout} />
        </>
      )}
    </PanelSection>
  );
});

/** The box model as browsers' dev tools draw it: the stroke, the padding, the size, each side's value where it is. */
function BoxDiagram({box, format}: {box: BoxModel; format: CodeFormat}) {
  const copy = useCopy();
  const value = (n: number) => (n ? formatValue('padding', px(n), format).replace(/px$/, '') : '–');
  const sides = (values: readonly number[] | null, prop: string, label: string, children: ReactNode) => {
    if (!values) return children;
    const css = `${prop}: ${values.every(v => v === values[0]) ? formatValue(prop, px(values[0]), format) : values.map(v => formatValue(prop, px(v), format)).join(' ')};`;
    return (
      <div className={`dz-box-ring is-${prop}`}>
        <button type="button" className="dz-box-label" onClick={() => copy(css)} title={`Copy "${css}"`}>{label}</button>
        <span className="dz-box-side is-top">{value(values[0])}</span>
        <span className="dz-box-side is-right">{value(values[1])}</span>
        <span className="dz-box-side is-bottom">{value(values[2])}</span>
        <span className="dz-box-side is-left">{value(values[3])}</span>
        {children}
      </div>
    );
  };
  const size = `${formatNumber(box.width, 2)} × ${formatNumber(box.height, 2)}`;
  const content = <button type="button" className="dz-box-content" onClick={() => copy(`width: ${formatValue('width', px(box.width), format)};\nheight: ${formatValue('height', px(box.height), format)};`)} title="Copy size">{size}</button>;
  return (
    <div className="dz-box" role="group" aria-label={`Box: ${size}${box.padding ? `, padding ${box.padding.join(' ')}` : ''}${box.border ? `, border ${box.border.join(' ')}` : ''}`}>
      {sides(box.border, 'border', 'Border', sides(box.padding, 'padding', 'Padding', content))}
    </div>
  );
}

// ── Typography ─────────────────────────────────────────────────────────────────────────────────

export const TypographySection = memo(function TypographySection({node, tokens, format}: {node: SceneNode; tokens: TokenTable; format: CodeFormat}) {
  const copy = useCopy();
  const typography = typographyRows(node, tokens, format);
  if (!typography) return null;
  const sample: CSSProperties = {fontFamily: `'${typography.family}', var(--dz-font)`, fontWeight: typography.weight, fontStyle: typography.italic ? 'italic' : undefined};
  return (
    <PanelSection title="Typography">
      <div className="dz-code-type">
        <span className="dz-code-type-sample" style={sample} aria-hidden="true">Ag</span>
        <div className="dz-code-type-text">
          <span className="dz-code-type-name">{typography.style ?? `${typography.family} ${typography.weight}`}</span>
          {typography.token
            ? <button type="button" className="dz-code-token" onClick={() => copy(`var(${typography.token})`)} title="Copy token">{typography.token}</button>
            : <span className="dz-code-type-note">No text style</span>}
        </div>
      </div>
      <MeasureRows rows={typography.rows} />
    </PanelSection>
  );
});

// ── Styles and variables ───────────────────────────────────────────────────────────────────────

const KIND_TITLES: Record<StyleKind, string> = {fill: 'Fills', text: 'Text', stroke: 'Strokes', effect: 'Shadows'};
const KIND_ORDER: StyleKind[] = ['fill', 'text', 'stroke', 'effect'];

export const StylesSection = memo(function StylesSection({doc, ids, tokens, format}: {doc: DesignDocument; ids: readonly NodeId[]; tokens: TokenTable; format: CodeFormat}) {
  const entries = useMemo(() => stylesUsed(doc, ids, tokens, format), [doc, ids, tokens, format]);
  const copy = useCopy();
  if (!entries.length) return null;
  return (
    <PanelSection title="Styles and variables">
      {KIND_ORDER.map(kind => {
        const list = entries.filter(entry => entry.kind === kind);
        if (!list.length) return null;
        return (
          <div key={kind} className="dz-code-styles">
            <h4 className="dz-code-subtitle">{KIND_TITLES[kind]}</h4>
            {list.map(entry => <StyleRow key={entry.key} entry={entry} onCopy={copy} />)}
          </div>
        );
      })}
    </PanelSection>
  );
});

function StyleRow({entry, onCopy}: {entry: StyleEntry; onCopy: (text: string) => void}) {
  const title = `${entry.original ? `"${entry.original}" · ` : ''}${entry.value}${entry.suggested ? '. The value matches a variable — the code uses the variable.' : ''}`;
  // A shadow without a style reads as its kind, its value beside it.
  const label = entry.token ?? (entry.shadow ? entry.where : entry.value);
  const value = entry.token || entry.shadow ? entry.value : null;
  return (
    <button type="button" className={`dz-code-style ${entry.suggested ? 'is-suggested' : ''}`.trim()} onClick={() => onCopy(entry.copy)} title={title}>
      {entry.shadow ? <span className="dz-code-shadow" style={{boxShadow: entry.shadow}} aria-hidden="true" />
        : entry.gradient ? <span className="dz-code-gradient" style={{background: entry.gradient}} aria-hidden="true" />
          : entry.swatch ? <ColorSwatch color={entry.swatch} opacity={entry.alpha} split={entry.alpha < 1} /> : null}
      <span className="dz-code-style-label">{label}</span>
      {entry.suggested && <span className="dz-code-badge">suggested</span>}
      {value && <span className={`dz-code-style-value ${entry.shadow ? 'is-long' : ''}`.trim()}>{value}</span>}
    </button>
  );
}

// ── Assets ─────────────────────────────────────────────────────────────────────────────────────

export const AssetsSection = memo(function AssetsSection({doc, ids}: {doc: DesignDocument; ids: readonly NodeId[]}) {
  const services = useEditorServices();
  const detected = useMemo(() => detectAssets(doc, ids, {measurer: services.store.measurer}), [doc, ids, services]);
  const exports = useMemo(() => exportAssets(doc, ids), [doc, ids]);
  const [busy, setBusy] = useState<string | null>(null);
  const save = async (key: string, make: () => Promise<Blob> | Blob, fileName: string) => {
    setBusy(key);
    try {
      downloadBlob(await make(), fileName);
    } catch (error) {
      services.toast(error instanceof ExportError ? error.message : 'Could not save the file.', 'error');
    } finally {
      setBusy(null);
    }
  };
  const svgOf = (nodeId: NodeId, ids = false) => new Blob([exportSvg(doc, [nodeId], {measurer: services.store.measurer, layerIds: ids})], {type: 'image/svg+xml'});
  // A raster spans awaits (fonts, pictures): it gets a document of its own — the store's current one, taken whole at the
  // click (the panel's settled `doc` may pair an older styles table with the table written in place since).
  const png = (nodeId: NodeId, scale: number) => exportRaster(snapshotDocument(services.store.getState().doc), [nodeId], {format: 'PNG', constraint: {type: 'SCALE', value: scale}}, {images: services.images, fonts: services.fonts, booleanGeometry});
  return (
    <>
      {detected.length > 0 && (
        <PanelSection title="Assets">
          <div className="dz-code-assets">
            {detected.map(asset => (
              <div key={asset.key} className="dz-code-asset">
                <AssetPreview doc={doc} asset={asset} />
                <div className="dz-code-asset-text">
                  <span className="dz-code-asset-name">{asset.fileName}</span>
                  <span className="dz-code-asset-meta">{asset.kind === 'icon' ? 'Icon' : 'Image'} · {formatNumber(asset.width, 0)} × {formatNumber(asset.height, 0)}{asset.count > 1 ? ` · ${layersLabel(asset.count)}` : ''}</span>
                </div>
                {asset.kind === 'icon'
                  ? <IconButton label={`Download ${asset.fileName}`} disabled={busy === asset.key} onClick={() => save(asset.key, () => (asset.svg ? new Blob([asset.svg], {type: 'image/svg+xml'}) : svgOf(asset.nodeId)), asset.fileName)}><IconDownload /></IconButton>
                  : <IconButton label={`Download ${asset.fileName}`} disabled={busy === asset.key} onClick={() => save(asset.key, () => fetch(doc.images[asset.ref!]?.url ?? '', {credentials: 'same-origin'}).then(response => {
                    if (!response.ok) throw new Error(String(response.status));
                    return response.blob();
                  }), asset.fileName)}><IconDownload /></IconButton>}
                {asset.kind === 'icon' && <IconButton label={`Download ${asset.fileName.replace(/\.svg$/, '')}@2x.png`} disabled={busy === asset.key} onClick={() => save(asset.key, () => png(asset.nodeId, 2), asset.fileName.replace(/\.svg$/, '@2x.png'))}><span className="dz-code-asset-format" aria-hidden="true">PNG</span></IconButton>}
              </div>
            ))}
          </div>
        </PanelSection>
      )}
      <PanelSection title="Export" empty={!exports.length}>
        {exports.length ? (
          <div className="dz-code-assets">
            {exports.map((asset: AssetEntry) => (
              <div key={asset.key} className="dz-code-asset">
                <div className="dz-code-asset-text">
                  <span className="dz-code-asset-name">{asset.fileName}</span>
                  <span className="dz-code-asset-meta">{asset.label} · {asset.layer}</span>
                </div>
                <IconButton label={asset.setting.format === 'PDF' ? 'PDF is saved via "Export"' : `Download ${asset.fileName}`} disabled={asset.setting.format === 'PDF' || busy === asset.key}
                  onClick={() => save(asset.key, () => (asset.setting.format === 'SVG' ? svgOf(asset.nodeId, !!asset.setting.svgIdAttribute)
                    : exportRaster(doc, [asset.nodeId], {format: asset.setting.format as 'PNG' | 'JPG' | 'WEBP', constraint: asset.setting.constraint}, {images: services.images, fonts: services.fonts, booleanGeometry})), asset.fileName)}>
                  <IconDownload />
                </IconButton>
              </div>
            ))}
          </div>
        ) : undefined}
      </PanelSection>
    </>
  );
});

/** A thumbnail: a picture from its file; an icon from its SVG, a one-colour one in the panel's text colour (as the code draws it,
 *  in `currentColor`: a white icon of a blue button stays visible). */
function AssetPreview({doc, asset}: {doc: DesignDocument; asset: DetectedAsset}) {
  const services = useEditorServices();
  const src = useMemo(() => {
    if (asset.kind === 'image') return doc.images[asset.ref!]?.url ?? '';
    try {
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(asset.svg ?? exportSvg(doc, [asset.nodeId], {measurer: services.store.measurer}))}`;
    } catch {
      return '';
    }
  }, [doc, asset, services]);
  if (src && asset.monochrome) {
    const mask = `url("${src}") center / contain no-repeat`;
    return <span className="dz-code-asset-preview"><span className="dz-code-asset-mask" style={{mask, WebkitMask: mask}} /></span>;
  }
  return <span className="dz-code-asset-preview">{src && <img src={src} alt="" loading="lazy" decoding="async" />}</span>;
}
