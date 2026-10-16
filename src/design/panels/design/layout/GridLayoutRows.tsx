import {memo, useCallback, useRef, useState} from 'react';
import type {DesignDocument, GridChild, GridLayout, GridTrackSize, NodeId, SceneNode} from '../../../../../shared/design/types';
import {DEFAULT_GRID, placeGridChildren, wholeTracks} from '../../../../../shared/design/layout-grid';
import {IconButton} from '../../../ui/Button';
import {Checkbox} from '../../../ui/Toggle';
import {NumberField} from '../../../ui/NumberField';
import {Popover} from '../../../ui/Popover';
import {Select} from '../../../ui/Select';
import {IconGapHorizontal, IconGapVertical} from '../../../ui/icons';
import {sameSectionProps, usePanelEdit, useSectionView} from '../shared/edit';
import {userUpdate} from '../../../engine/user-edit';
import {Captions, PanelNumber, Row, offsetToPanelEdge} from '../shared/fields';
import {mixedOf, sameValue, type Mixed, type NumberEdit} from '../shared/mixed';
import {IconAutoPlace, IconSliders} from './icons';

// Figma's grid auto layout flow in "Layout" (help.figma.com 31289469907863): for a GRID frame the "R × C" picker (a grid of cells to pick a size in, the counts, rows
// "Auto"), the gaps between columns and between rows, "Automatic placement" (children fill the cells in layer
// order, or stay where they are put), and each track's size ("Fixed" px, "Fill" a share, "Hug" the content). For a
// child of a GRID frame, its spans and, under manual placement, its cell; its alignment in the cell is the alignment row's
// (engine/commands/align.ts).

const PICKER = 8;

export const isGrid = (node: SceneNode | undefined) => node?.autoLayout?.layoutMode === 'GRID';
export const gridOf = (node: SceneNode): GridLayout => node.grid ?? DEFAULT_GRID;

/** The flow children of a frame, as the grid places them (visible, not absolutely positioned). */
export const flowChildren = (doc: DesignDocument, frame: SceneNode) =>
  (frame.children ?? []).map(id => doc.nodes[id]).filter((child): child is SceneNode => !!child && child.visible && child.layoutPositioning !== 'ABSOLUTE');

/** A grid for a frame switching to the grid flow: about square for its children, rows that follow them, gaps from its
 *  flex gap; columns share the width when the frame's width is set, hug their content when it hugs (Figma forbids shares
 *  on a hugged axis). */
export function newGrid(doc: DesignDocument, frame: SceneNode): GridLayout {
  const count = flowChildren(doc, frame).length;
  const columns = Math.max(1, Math.ceil(Math.sqrt(Math.max(count, 1))));
  const gap = frame.autoLayout?.itemSpacing ?? 0;
  const column: GridTrackSize = frame.layoutSizingHorizontal === 'HUG' ? {type: 'HUG'} : {type: 'FLEX', value: 1};
  return {
    rowCount: Math.max(1, Math.ceil(count / columns)), columnCount: columns, rowGap: gap, columnGap: gap,
    rowSizes: [], columnSizes: Array.from({length: columns}, () => ({...column})),
    autoTracks: 'ROWS', itemsPositioning: 'ROW_AUTO_FLOW',
  };
}

/** `sizes` for `count` tracks: cut to the count, or grown with copies of the last entry (none: missing entries read as FLEX). */
function sizesFor(sizes: readonly GridTrackSize[], count: number): GridTrackSize[] {
  const out = sizes.slice(0, count).map(size => ({...size}));
  const last = sizes.at(-1);
  if (last) while (out.length < count) out.push({...last});
  return out;
}

/** The grid with new counts (and its size lists fitted to them). */
export function withCounts(grid: GridLayout, rows: number | 'auto', columns: number): GridLayout {
  const columnCount = wholeTracks(columns);
  const next: GridLayout = {...grid, columnCount, columnSizes: sizesFor(grid.columnSizes, columnCount)};
  if (rows === 'auto') return {...next, autoTracks: 'ROWS'};
  const rowCount = wholeTracks(rows);
  return {...next, autoTracks: 'NONE', rowCount, rowSizes: sizesFor(grid.rowSizes, rowCount)};
}

type GridView = {
  rows: Mixed<number>; columns: Mixed<number>; autoRows: Mixed<boolean>; auto: Mixed<boolean>;
  rowGap: Mixed<number>; columnGap: Mixed<number>;
  /** The first frame's tracks (the size list shows one grid). */
  columnSizes: GridTrackSize[]; rowSizes: GridTrackSize[]; shownRows: number;
};

function gridView(doc: DesignDocument, ids: readonly NodeId[]): GridView | null {
  const frames = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && isGrid(node));
  if (!frames.length || frames.length !== ids.length) return null;
  const placed = frames.map(frame => placeGridChildren(gridOf(frame), flowChildren(doc, frame)));
  const first = gridOf(frames[0]);
  return {
    rows: mixedOf(placed.map(each => each.rows)), columns: mixedOf(placed.map(each => each.columns)),
    autoRows: mixedOf(frames.map(frame => gridOf(frame).autoTracks === 'ROWS')),
    auto: mixedOf(frames.map(frame => gridOf(frame).itemsPositioning === 'ROW_AUTO_FLOW')),
    rowGap: mixedOf(frames.map(frame => gridOf(frame).rowGap)), columnGap: mixedOf(frames.map(frame => gridOf(frame).columnGap)),
    columnSizes: Array.from({length: placed[0].columns}, (_, k) => first.columnSizes[k] ?? {type: 'FLEX', value: 1}),
    rowSizes: Array.from({length: placed[0].rows}, (_, k) => first.rowSizes[k] ?? {type: 'FLEX', value: 1}),
    shownRows: placed[0].rows,
  };
}

/** Writes the grid of every selected GRID frame. */
function useGridEdit(ids: readonly NodeId[]) {
  const edit = usePanelEdit();
  const grid = useCallback((label: string, make: (grid: GridLayout, node: SceneNode) => GridLayout | null, source?: Parameters<typeof edit.nodes>[3]) =>
    edit.nodes(label, ids, node => {
      if (!isGrid(node)) return null;
      const next = make(gridOf(node), node);
      return next ? {grid: next} : null;
    }, source), [edit, ids]);
  return {edit, grid};
}

/** The rows of "Layout" (Auto layout) for GRID frames: the picker, positioning, track sizes, the two gaps. */
export const GridRows = memo(function GridRows({ids}: {ids: readonly NodeId[]}) {
  const view = useSectionView(gridView, ids, sameValue);
  const {edit, grid} = useGridEdit(ids);
  if (!view) return null;
  const gap = (field: 'rowGap' | 'columnGap', label: string) => (change: NumberEdit, source: Parameters<typeof edit.nodes>[3]) =>
    grid(label, current => ({...current, [field]: Math.max(0, change(current[field]))}), source);
  const automatic = view.auto === true;
  return (
    <>
      <Captions left="Grid" right="Gaps" />
      <div className="dz-pl-grid">
        <GridPicker view={view} onPick={(rows, columns) => grid(`Grid ${rows === 'auto' ? 'auto' : rows} × ${columns}`, current => withCounts(current, rows, columns))} />
        <div className="dz-pl-grid-gaps">
          <PanelNumber icon={<IconGapHorizontal />} aria-label="Gap between columns" value={view.columnGap} min={0} edit={edit} onChange={gap('columnGap', 'Gap between columns')} />
          <PanelNumber icon={<IconGapVertical />} aria-label="Gap between rows" value={view.rowGap} min={0} edit={edit} onChange={gap('rowGap', 'Gap between rows')} />
        </div>
        <div className="dz-pl-grid-tools">
          <IconButton label="Automatic placement" pressed={automatic}
            onClick={() => grid(automatic ? 'Manual placement' : 'Automatic placement', current => automatic
              ? {...current, itemsPositioning: 'MANUAL'}
              // Back to automatic: rows follow the children again, as Figma resets them to "Auto".
              : {...current, itemsPositioning: 'ROW_AUTO_FLOW', autoTracks: 'ROWS'})}>
            <IconAutoPlace />
          </IconButton>
          <TrackSizes view={view} onChange={(axis, index, size) => grid('Track size', current => {
            const field = axis === 'column' ? 'columnSizes' : 'rowSizes';
            const count = axis === 'column' ? current.columnCount : Math.max(current.rowCount, view.shownRows);
            const sizes = Array.from({length: Math.max(count, index + 1)}, (_, k) => current[field][k] ?? {type: 'FLEX' as const, value: 1});
            sizes[index] = size;
            return {...current, [field]: sizes};
          })} />
        </div>
      </div>
    </>
  );
}, sameSectionProps);

/** "R × C": opens a grid of cells to pick a size in (hover shows it, a click sets it), and the counts with rows "Auto". */
function GridPicker({view, onPick}: {view: GridView; onPick: (rows: number | 'auto', columns: number) => void}) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<{rows: number; columns: number} | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const rows = view.rows === 'mixed' || view.rows === null ? null : view.rows;
  const columns = view.columns === 'mixed' || view.columns === null ? null : view.columns;
  const label = rows === null || columns === null ? 'Mixed' : `${rows} × ${columns}`;
  return (
    <>
      <button ref={button} type="button" className="dz-pl-grid-picker" aria-label={`Grid: ${label}`} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="dz-pl-grid-picker-cells" aria-hidden="true" />
        <span className="dz-pl-grid-picker-label">{label}</span>
      </button>
      {open && button.current && (
        <Popover anchor={button.current} onClose={() => setOpen(false)} placement="left-start" offset={offsetToPanelEdge(button.current)} aria-label="Grid size" className="dz-pl-popover">
          <div className="dz-pl-popover-head">Grid size{hover ? `: ${hover.rows} × ${hover.columns}` : ''}</div>
          <div className="dz-pl-popover-body">
            <div className="dz-pl-grid-cells" role="grid" aria-label="Rows and columns" onMouseLeave={() => setHover(null)}>
              {Array.from({length: PICKER}, (_, r) => (
                <div key={r} role="row" className="dz-pl-grid-cells-row">
                  {Array.from({length: PICKER}, (_, c) => {
                    const lit = hover ? r < hover.rows && c < hover.columns : rows !== null && columns !== null && r < rows && c < columns;
                    return (
                      <button key={c} type="button" role="gridcell" aria-label={`${r + 1} × ${c + 1}`} className={`dz-pl-grid-cell ${lit ? 'is-lit' : ''}`.trim()}
                        onMouseEnter={() => setHover({rows: r + 1, columns: c + 1})} onFocus={() => setHover({rows: r + 1, columns: c + 1})}
                        onClick={() => {
                          onPick(r + 1, c + 1);
                          setOpen(false);
                        }} />
                    );
                  })}
                </div>
              ))}
            </div>
            <Row>
              <NumberField label="Row" aria-label="Rows" value={view.autoRows === true ? null : view.rows === 'mixed' ? 'mixed' : view.rows} placeholder={view.autoRows === true ? `Auto (${rows ?? '…'})` : undefined}
                min={1} max={1000} precision={0} disabled={view.autoRows === true}
                onChange={value => onPick(Math.max(1, Math.round(value)), columns ?? 1)} />
              <NumberField label="Col" aria-label="Columns" value={view.columns} min={1} max={1000} precision={0}
                onChange={value => onPick(view.autoRows === true ? 'auto' : rows ?? 1, Math.max(1, Math.round(value)))} />
            </Row>
            <Checkbox checked={view.autoRows === 'mixed' ? 'mixed' : view.autoRows === true} onChange={checked => onPick(checked ? 'auto' : rows ?? 1, columns ?? 1)}>
              Rows by content ("Auto")
            </Checkbox>
          </div>
        </Popover>
      )}
    </>
  );
}

const TRACK_TYPES = [
  {value: 'FIXED', label: 'Fixed'},
  {value: 'FLEX', label: 'Fill'},
  {value: 'HUG', label: 'Hug'},
] as const;

/** Each column's and row's size: fixed px, a share ("Fill", fr) or the content. */
function TrackSizes({view, onChange}: {view: GridView; onChange: (axis: 'column' | 'row', index: number, size: GridTrackSize) => void}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const list = (axis: 'column' | 'row', sizes: GridTrackSize[], name: string) => sizes.map((size, index) => (
    <div key={`${axis}${index}`} className="dz-pl-track" role="group" aria-label={`${name} ${index + 1}`}>
      <span className="dz-pl-track-name">{name} {index + 1}</span>
      <Select aria-label="Size" value={size.type} options={TRACK_TYPES}
        onChange={type => onChange(axis, index, type === 'HUG' ? {type} : {type, value: type === 'FIXED' ? 100 : 1})} />
      <NumberField aria-label={size.type === 'FLEX' ? 'Share' : 'Pixels'} value={size.type === 'HUG' ? null : size.value ?? 1} placeholder="—" disabled={size.type === 'HUG'}
        suffix={size.type === 'FLEX' ? ' fr' : ''} min={0} precision={size.type === 'FLEX' ? 2 : 0}
        onChange={value => onChange(axis, index, {type: size.type, value: Math.max(0, value)})} />
    </div>
  ));
  return (
    <>
      <IconButton ref={button} label="Row and column sizes" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}><IconSliders /></IconButton>
      {open && button.current && (
        <Popover anchor={button.current} onClose={() => setOpen(false)} placement="left-start" offset={offsetToPanelEdge(button.current)} aria-label="Row and column sizes" className="dz-pl-popover">
          <div className="dz-pl-popover-head">Row and column sizes</div>
          <div className="dz-pl-popover-body dz-pl-tracks">
            <div className="dz-pl-caption">Columns</div>
            {list('column', view.columnSizes, 'Column')}
            <div className="dz-pl-caption">Rows</div>
            {list('row', view.rowSizes, 'Row')}
          </div>
        </Popover>
      )}
    </>
  );
}

// ── A child's cell ────────────────────────────────────────────────────────────────────────────────

type ChildView = {rowSpan: Mixed<number>; columnSpan: Mixed<number>; manual: boolean; row: Mixed<number>; column: Mixed<number>};

/** The cells of the selected flow children of GRID frames (null unless every selected layer is one). */
function childView(doc: DesignDocument, ids: readonly NodeId[]): ChildView | null {
  const cells = [];
  let manual = true;
  for (const id of ids) {
    const node = doc.nodes[id];
    const frame = node?.parentId ? doc.nodes[node.parentId] : undefined;
    if (!node || !frame || !isGrid(frame) || node.layoutPositioning === 'ABSOLUTE' || !node.visible) return null;
    const cell = placeGridChildren(gridOf(frame), flowChildren(doc, frame)).cells.get(id);
    if (!cell) return null;
    cells.push(cell);
    manual &&= gridOf(frame).itemsPositioning === 'MANUAL';
  }
  if (!cells.length) return null;
  return {
    rowSpan: mixedOf(cells.map(cell => cell.rowSpan)), columnSpan: mixedOf(cells.map(cell => cell.columnSpan)), manual,
    row: mixedOf(cells.map(cell => cell.row + 1)), column: mixedOf(cells.map(cell => cell.column + 1)),
  };
}

/** Whether every selected layer sits in a grid (its spans show in "Layout"). */
export const inGrid = (doc: DesignDocument, ids: readonly NodeId[]) => !!childView(doc, ids);

/** A child of a GRID frame: how many columns and rows it spans and, under manual placement, its cell (1-based). */
export const GridChildRows = memo(function GridChildRows({ids}: {ids: readonly NodeId[]}) {
  const view = useSectionView(childView, ids, sameValue);
  const edit = usePanelEdit();
  if (!view) return null;
  type Source = Parameters<typeof edit.nodes>[3];
  /** Writes each selected child's `gridChild`, given its current cell as the layout placed it. */
  const write = (label: string, make: (child: GridChild, cell: {row: number; column: number}) => GridChild, source: Source) =>
    edit.run(label, tx => {
      for (const id of ids) {
        const node = tx.get(id);
        const frame = node?.parentId ? tx.get(node.parentId) : undefined;
        if (!node || !frame) continue;
        const cell = placeGridChildren(gridOf(frame), flowChildren(tx.doc, frame)).cells.get(id) ?? {row: 0, column: 0};
        userUpdate(tx, id, {gridChild: make({...node.gridChild}, cell)});
      }
    }, source);
  const span = (field: 'rowSpan' | 'columnSpan', label: string) => (change: NumberEdit, source: Source) =>
    write(label, child => ({...child, [field]: Math.max(1, Math.round(change(child[field] ?? 1)))}), source);
  const anchor = (field: 'rowAnchorIndex' | 'columnAnchorIndex', label: string) => (change: NumberEdit, source: Source) =>
    write(label, (child, cell) => ({
      ...child,
      // Both anchors are written, so the child stays put on the other axis.
      rowAnchorIndex: child.rowAnchorIndex ?? cell.row,
      columnAnchorIndex: child.columnAnchorIndex ?? cell.column,
      [field]: Math.max(0, Math.round(change((field === 'rowAnchorIndex' ? cell.row : cell.column) + 1)) - 1),
    }), source);
  return (
    <>
      <Captions left="Cell span" right={view.manual ? 'Cell' : undefined} always />
      <Row>
        <PanelNumber label="Col" aria-label="Column span" value={view.columnSpan} min={1} precision={0} edit={edit} onChange={span('columnSpan', 'Column span')} />
        <PanelNumber label="Row" aria-label="Row span" value={view.rowSpan} min={1} precision={0} edit={edit} onChange={span('rowSpan', 'Row span')} />
      </Row>
      {view.manual && (
        <Row>
          <PanelNumber label="Col" aria-label="Cell column" value={view.column} min={1} precision={0} edit={edit} onChange={anchor('columnAnchorIndex', 'Cell: column')} />
          <PanelNumber label="Row" aria-label="Cell row" value={view.row} min={1} precision={0} edit={edit} onChange={anchor('rowAnchorIndex', 'Cell: row')} />
        </Row>
      )}
    </>
  );
}, sameSectionProps);
