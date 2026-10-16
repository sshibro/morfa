import {memo, useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import type {DesignDocument, LayoutGrid, NodeId, RGBA, SceneNode, Style} from '../../../../../shared/design/types';
import {FRAME_LIKE_TYPES} from '../../../../../shared/design/types';
import {applyStyle, createStyleFromNode, detachStyle, styleDisplayName} from '../../../../../shared/design/styles';
import {IconButton} from '../../../ui/Button';
import {ColorSwatch} from '../../../ui/ColorSwatch';
import {PanelSection} from '../../../ui/PanelSection';
import {Popover} from '../../../ui/Popover';
import {Select} from '../../../ui/Select';
import {TextInput} from '../../../ui/TextInput';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {useTooltip} from '../../../ui/Tooltip';
import {IconEye, IconEyeOff, IconMinus} from '../../../ui/icons';
import type {SectionProps} from '../sections';
import {applyUpdates, sameSectionProps, usePanelEdit, type EditSource, type PanelEdit, useSectionView} from '../shared/edit';
import {PanelNumber, offsetToPanelEdge} from '../shared/fields';
import {mixedOf, sameValue, type NumberEdit} from '../shared/mixed';
import {IconDetach, IconGridColumns, IconGridRows, IconGridSquare, IconStyles} from './icons';
import {GRID_ALIGNMENT_LABELS, defaultGrid, gridSummary, gridWithPattern, hexOf, nextGridStyleName, parseHex} from './grids';

// "Layout grid" (order 40): the frame's layout grids — "+" adds a 10 px grid; each row opens its
// settings (Grid / Columns / Rows, count, colour, type, width, offset, gutter), hides it or
// removes it. Grid styles ("Grid styles") apply, detach and are created from the frame's grids.

const isFrameLike = (node: SceneNode) => FRAME_LIKE_TYPES.includes(node.type);

type View = {grids: LayoutGrid[] | 'mixed'; styleId: string | 'mixed' | null; style: Style | null; styles: Style[]};

function viewOf(doc: DesignDocument, ids: readonly NodeId[]): View | null {
  const nodes = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && isFrameLike(node));
  if (!nodes.length) return null;
  const grids = mixedOf(nodes.map(node => node.layoutGrids ?? []));
  const styleId = mixedOf(nodes.map(node => node.gridStyleId ?? ''));
  const id = styleId === 'mixed' ? 'mixed' : styleId || null;
  return {
    grids: grids === 'mixed' ? 'mixed' : grids ?? [],
    styleId: id,
    style: id && id !== 'mixed' ? doc.styles[id] ?? null : null,
    styles: Object.values(doc.styles).filter(style => style.type === 'GRID'),
  };
}

const sameView = (a: View | null, b: View | null) => {
  if (!a || !b) return a === b;
  return a.styleId === b.styleId && a.style === b.style && sameValue(a.grids, b.grids) && a.styles.length === b.styles.length && a.styles.every((style, i) => style === b.styles[i]);
};

export const LayoutGridSection = memo(function LayoutGridSection({ids}: SectionProps) {
  const view = useSectionView(viewOf, ids, sameView);
  const edit = usePanelEdit();
  const [editing, setEditing] = useState<{index: number; anchor: HTMLElement} | null>(null);
  if (!view) return null;

  /** Rewrites the grids of every selected frame (they all show the same list unless mixed). */
  const setGrids = (label: string, make: (grids: LayoutGrid[]) => LayoutGrid[], source?: EditSource) =>
    edit.nodes(label, ids, node => (isFrameLike(node) ? {layoutGrids: make(node.layoutGrids ?? [])} : null), source);
  const add = () => {
    setGrids('Add grid', grids => (view.grids === 'mixed' ? [defaultGrid()] : [...grids, defaultGrid()]));
  };
  const grids = view.grids === 'mixed' ? [] : view.grids;
  const styled = view.style !== null;
  // Figma lists the newest grid first.
  const order = grids.map((_, index) => index).reverse();

  return (
    <PanelSection title="Layout grid" className="dz-pl-section" empty={!styled && view.grids !== 'mixed' && !grids.length}
      onAdd={styled ? undefined : add} addLabel="Add grid"
      actions={<GridStyles view={view} ids={ids} edit={edit} />}>
      {styled ? (
        <div className="dz-pl-item">
          <span className="dz-pl-item-icon" aria-hidden="true"><IconStyles /></span>
          <span className="dz-pl-item-label">{styleDisplayName(view.style!)}</span>
          <span />
          <IconButton label="Detach style" onClick={() => edit.nodes('Detach grid style', ids, node => detachStyle(node, 'grid'))}><IconDetach /></IconButton>
        </div>
      ) : view.grids === 'mixed' ? (
        <p className="dz-pl-note">The layers have different grids. "+" will replace them with one.</p>
      ) : order.map(index => {
        const grid = grids[index];
        const Icon = grid.pattern === 'GRID' ? IconGridSquare : grid.pattern === 'COLUMNS' ? IconGridColumns : IconGridRows;
        return (
          <div key={index} className={`dz-pl-item ${grid.visible ? '' : 'is-hidden'}`.trim()}>
            <GridOpenButton active={editing?.index === index} label={`Settings: ${gridSummary(grid)}`}
              onOpen={anchor => setEditing(current => (current?.index === index ? null : {index, anchor}))}>
              <Icon />
            </GridOpenButton>
            <span className="dz-pl-item-label">{gridSummary(grid)}</span>
            <IconButton label={grid.visible ? 'Hide grid' : 'Show grid'} className="dz-pl-item-eye" onClick={() => setGrids(grid.visible ? 'Hide grid' : 'Show grid', list => list.map((each, i) => (i === index ? {...each, visible: !each.visible} : each)))}>
              {grid.visible ? <IconEye /> : <IconEyeOff />}
            </IconButton>
            <IconButton label="Delete grid" onClick={() => {
              setEditing(null);
              setGrids('Delete grid', list => list.filter((_, i) => i !== index));
            }}><IconMinus /></IconButton>
          </div>
        );
      })}
      {editing && grids[editing.index] && (
        <GridEditor grid={grids[editing.index]} anchor={editing.anchor} onClose={() => setEditing(null)} edit={edit}
          onChange={(make, label, source) => setGrids(label, list => list.map((each, i) => (i === editing.index ? make(each) : each)), source)} />
      )}
    </PanelSection>
  );
}, sameSectionProps);

function GridOpenButton({active, label, onOpen, children}: {active: boolean; label: string; onOpen: (anchor: HTMLElement) => void; children: ReactNode}) {
  const ref = useRef<HTMLButtonElement>(null);
  return <IconButton ref={ref} label={label} aria-expanded={active} aria-haspopup="dialog" onClick={() => ref.current && onOpen(ref.current)}>{children}</IconButton>;
}

// ── Styles ─────────────────────────────────────────────────────────────────────────────────────

function GridStyles({view, ids, edit}: {view: View; ids: readonly NodeId[]; edit: PanelEdit}) {
  const items = useCallback((): MenuItem[] => {
    const list: MenuItem[] = view.styles.map(style => ({
      id: style.id, label: style.name, checked: view.styleId === style.id, radio: true,
      onSelect: () => edit.run('Apply grid style', tx => applyUpdates(tx, applyStyle(tx.doc, ids, style.id), () => true)),
    }));
    if (!list.length) list.push({type: 'label', label: 'No grid styles in this file'});
    const canCreate = view.grids !== 'mixed' && view.grids.length > 0 && !view.style;
    list.push({type: 'separator'}, {
      id: 'create', label: 'Create style from grid', disabled: !canCreate,
      onSelect: () => edit.run('Create grid style', tx => {
        const style = createStyleFromNode(tx.doc, ids[0], 'GRID', nextGridStyleName(tx.doc));
        if (!style) return;
        tx.setStyle(style);
        applyUpdates(tx, applyStyle(tx.doc, ids, style.id), () => true);
      }),
    });
    return list;
  }, [view, ids, edit]);
  const menu = useMenuTrigger({items, label: 'Grid styles', minWidth: 200, placement: 'bottom-end'});
  const tip = useTooltip({label: 'Grid styles'});
  return (
    <>
      <button type="button" aria-label="Grid styles" {...tip} {...menu.triggerProps} className="dz-icon-btn is-24 is-panel"><IconStyles /></button>
      {menu.element}
    </>
  );
}

// ── The settings popover ───────────────────────────────────────────────────────────────────────

type GridChange = (make: (grid: LayoutGrid) => LayoutGrid, label: string, source?: EditSource) => void;

function GridEditor({grid, anchor, onClose, onChange, edit}: {grid: LayoutGrid; anchor: HTMLElement; onClose: () => void; onChange: GridChange; edit: PanelEdit}) {
  const number = (field: 'sectionSize' | 'count' | 'offset' | 'gutterSize', label: string, min = 0) => (change: NumberEdit, source: EditSource) =>
    onChange(current => {
      const value = Math.max(min, change(Number((current as Record<string, unknown>)[field]) || 0));
      return {...current, [field]: field === 'count' ? Math.round(value) : value} as LayoutGrid;
    }, label, source);
  const lines = grid.pattern !== 'GRID' ? grid : null;
  const columns = grid.pattern === 'COLUMNS';
  return (
    <Popover anchor={anchor} onClose={onClose} placement="left-start" offset={offsetToPanelEdge(anchor)} aria-label="Grid settings" className="dz-pl-popover dz-pl-grid-popover" layoutKey={grid.pattern}>
      <div className="dz-pl-popover-head">
        <Select aria-label="Grid pattern" value={grid.pattern} appearance="quiet" className="dz-pl-grid-kind"
          options={[{value: 'GRID', label: 'Grid', icon: <IconGridSquare />}, {value: 'COLUMNS', label: 'Columns', icon: <IconGridColumns />}, {value: 'ROWS', label: 'Rows', icon: <IconGridRows />}]}
          onChange={pattern => onChange(current => gridWithPattern(current, pattern), 'Grid pattern')} />
      </div>
      <div className="dz-pl-popover-body dz-pl-form">
        {grid.pattern === 'GRID' ? (
          <FormRow label="Size"><PanelNumber aria-label="Cell size" value={grid.sectionSize} min={1} edit={edit} onChange={number('sectionSize', 'Grid size', 1)} /></FormRow>
        ) : (
          <FormRow label="Count">
            <PanelNumber aria-label="Count" value={lines!.count > 0 ? lines!.count : null} placeholder="Auto" min={0} precision={0} edit={edit} onChange={number('count', 'Count')} />
          </FormRow>
        )}
        <FormRow label="Color"><GridColor color={grid.color} onChange={(color, source) => onChange(current => ({...current, color}), 'Grid color', source)} edit={edit} /></FormRow>
        {lines && (
          <>
            <FormRow label="Type">
              <Select aria-label="Grid type" value={lines.alignment}
                options={(['STRETCH', 'MIN', 'CENTER', 'MAX'] as const).map(value => ({value, label: GRID_ALIGNMENT_LABELS[columns ? 'COLUMNS' : 'ROWS'][value]}))}
                onChange={alignment => onChange(current => (current.pattern === 'GRID' ? current : {...current, alignment}), 'Grid type')} />
            </FormRow>
            <FormRow label={columns ? 'Width' : 'Height'}>
              <PanelNumber aria-label={columns ? 'Column width' : 'Row height'} value={lines.alignment === 'STRETCH' ? null : lines.sectionSize} placeholder="Auto"
                disabled={lines.alignment === 'STRETCH'} min={1} edit={edit} onChange={number('sectionSize', columns ? 'Column width' : 'Row height', 1)} />
            </FormRow>
            <FormRow label={lines.alignment === 'STRETCH' ? 'Margin' : 'Offset'}>
              <PanelNumber aria-label={lines.alignment === 'STRETCH' ? 'Margin' : 'Offset'} value={lines.offset} min={0} edit={edit} onChange={number('offset', 'Grid offset')} />
            </FormRow>
            <FormRow label="Gutter">
              <PanelNumber aria-label="Gutter" value={lines.gutterSize} min={0} edit={edit} onChange={number('gutterSize', 'Grid gutter')} />
            </FormRow>
          </>
        )}
      </div>
    </Popover>
  );
}

function FormRow({label, children}: {label: string; children: ReactNode}) {
  return (
    <div className="dz-pl-form-row">
      <span className="dz-pl-form-label">{label}</span>
      {children}
    </div>
  );
}

/** Swatch (the system picker), hex and opacity: enough for a grid's tint. */
function GridColor({color, onChange, edit}: {color: RGBA; onChange: (color: RGBA, source?: EditSource) => void; edit: PanelEdit}) {
  const [draft, setDraft] = useState(hexOf(color));
  useEffect(() => setDraft(hexOf(color)), [color]);
  const picker = useRef<HTMLInputElement>(null);
  const commitHex = (text: string) => {
    const parsed = parseHex(text);
    if (parsed) onChange({...parsed, a: color.a});
    else setDraft(hexOf(color));
  };
  return (
    <div className="dz-pl-color">
      <ColorSwatch interactive color={color} split size={14} aria-label="Choose color" onClick={() => picker.current?.click()} />
      <input ref={picker} type="color" className="dz-pl-color-native" tabIndex={-1} aria-hidden="true" value={`#${hexOf(color)}`.toLowerCase()}
        onChange={event => {
          const parsed = parseHex(event.currentTarget.value);
          if (parsed) onChange({...parsed, a: color.a}, 'coalesce');
        }} />
      <TextInput aria-label="Color, hex" value={draft} onChange={setDraft} onCommit={commitHex} onBlur={event => commitHex(event.currentTarget.value)} className="dz-pl-hex" selectOnFocus spellCheck={false} />
      <PanelNumber aria-label="Grid opacity" value={Math.round(color.a * 100)} suffix="%" min={0} max={100} precision={0} className="dz-pl-alpha"
        onScrubStart={() => edit.start('Grid color')} onScrubEnd={cancelled => edit.end(cancelled)}
        onChange={(change, source) => onChange({...color, a: Math.min(100, Math.max(0, change(color.a * 100))) / 100}, source)} />
    </div>
  );
}
