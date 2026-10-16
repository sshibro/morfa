import {memo, useCallback, useRef, useState, type ReactNode} from 'react';
import type {AutoLayout, DesignDocument, LayoutAlign, NodeId, SceneNode} from '../../../../../shared/design/types';
import {FRAME_LIKE_TYPES} from '../../../../../shared/design/types';
import {defaultAutoLayout} from '../../../../../shared/design/defaults';
import {suggestAutoLayout} from '../../../../../shared/design/auto-layout-suggest';
import {IconButton} from '../../../ui/Button';
import {Checkbox} from '../../../ui/Toggle';
import {Popover} from '../../../ui/Popover';
import {SegmentedControl} from '../../../ui/Tabs';
import {Select} from '../../../ui/Select';
import type {MenuItem} from '../../../ui/menu-model';
import {IconGapHorizontal, IconGapVertical, IconLayoutGrid, IconMinus, IconPaddingHorizontal, IconPaddingVertical, IconPaddingSides} from '../../../ui/icons';
import {GridRows, newGrid} from './GridLayoutRows';
import {sameSectionProps, usePanelEdit, type EditSource, type PanelEdit, useSectionView} from '../shared/edit';
import {userUpdate} from '../../../engine/user-edit';
import {Captions, FieldMenuButton, Group, PanelNumber, Row, offsetToPanelEdge} from '../shared/fields';
import {BindableNumber} from '../shared/bindable';
import {mixedOf, sameValue, type Mixed, type NumberEdit} from '../shared/mixed';
import {IconArrowDown, IconArrowRight, IconAutoLayoutAdd, IconFreeform, IconPadBottom, IconPadLeft, IconPadRight, IconPadTop, IconSliders, IconWrap} from './icons';

// Auto layout inside "Layout" (SizeSection.tsx), as UI3's Layout section holds it: the header's "+" turns it on
// (inferring direction, gap and padding from the children, shared/design/auto-layout-suggest.ts) and "−" off; "Flow"
// (Freeform, Vertical, Horizontal, and "Wrap" for rows); then the nine-dot alignment beside the gap
// ("Auto" is SPACE_BETWEEN), the row gap when wrapping, padding (horizontal + vertical, or four sides), "Clip
// content", and the rarer settings — stacking order, strokes in layout, text baseline, wrapped rows — in a popover.

type Direction = 'VERTICAL' | 'HORIZONTAL' | 'WRAP' | 'GRID';
const isFrameLike = (node: SceneNode) => FRAME_LIKE_TYPES.includes(node.type);
const hasLayout = (node: SceneNode) => !!node.autoLayout && node.autoLayout.layoutMode !== 'NONE';
const directionOf = (layout: AutoLayout): Direction => (layout.layoutMode === 'GRID' ? 'GRID' : layout.layoutMode === 'VERTICAL' ? 'VERTICAL' : layout.layoutWrap === 'WRAP' ? 'WRAP' : 'HORIZONTAL');

type View = {
  state: 'none' | 'some' | 'all';
  direction: Mixed<Direction>;
  gap: Mixed<number>; auto: Mixed<boolean>; rowGap: Mixed<number>;
  left: Mixed<number>; right: Mixed<number>; top: Mixed<number>; bottom: Mixed<number>;
  primary: Mixed<AutoLayout['primaryAxisAlignItems']>; counter: Mixed<AutoLayout['counterAxisAlignItems']>;
  reverse: Mixed<boolean>; strokes: Mixed<boolean>; content: Mixed<AutoLayout['counterAxisAlignContent']>;
  clip: Mixed<boolean>;
};

function viewOf(doc: DesignDocument, ids: readonly NodeId[]): View | null {
  const nodes = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && isFrameLike(node));
  if (!nodes.length) return null;
  const on = nodes.filter(hasLayout);
  const layouts = on.map(node => node.autoLayout!);
  const of = <T,>(read: (layout: AutoLayout) => T) => mixedOf(layouts.map(read));
  return {
    state: on.length === nodes.length ? 'all' : on.length ? 'some' : 'none',
    direction: of(directionOf),
    gap: of(layout => layout.itemSpacing), auto: of(layout => layout.primaryAxisAlignItems === 'SPACE_BETWEEN'), rowGap: of(layout => layout.counterAxisSpacing),
    left: of(layout => layout.paddingLeft), right: of(layout => layout.paddingRight), top: of(layout => layout.paddingTop), bottom: of(layout => layout.paddingBottom),
    primary: of(layout => layout.primaryAxisAlignItems), counter: of(layout => layout.counterAxisAlignItems),
    reverse: of(layout => layout.itemReverseZIndex), strokes: of(layout => layout.strokesIncludedInLayout), content: of(layout => layout.counterAxisAlignContent),
    clip: mixedOf(on.map(node => node.clipsContent !== false)),
  };
}

/** Both sides as one field: their value when equal, "Mixed" otherwise. */
const pairOf = (a: Mixed<number>, b: Mixed<number>): Mixed<number> => (a === 'mixed' || b === 'mixed' ? 'mixed' : a === b ? a : 'mixed');

/** The auto-layout state of the selected frames and the edits on it, shared by the parts below (each subscribes to the
 *  same view, so "Layout" re-renders a part only when its own values change). */
function useAutoLayout(ids: readonly NodeId[]) {
  const view = useSectionView(viewOf, ids, sameValue);
  const edit = usePanelEdit();
  /** Writes auto-layout fields on every selected frame that has auto layout. */
  const layout = (label: string, make: (layout: AutoLayout, node: SceneNode) => Partial<AutoLayout> | null, source?: EditSource) =>
    edit.nodes(label, ids, node => {
      if (!node.autoLayout || !hasLayout(node)) return null;
      const patch = make(node.autoLayout, node);
      return patch ? {autoLayout: {...node.autoLayout, ...patch}} : null;
    }, source);
  /** Turns auto layout on: the direction the children suggest (shared/design/auto-layout-suggest.ts), or `mode`. */
  const add = (mode?: 'VERTICAL' | 'HORIZONTAL') => edit.run('Add auto layout', tx => {
    for (const id of ids) {
      const node = tx.get(id);
      if (!node || !isFrameLike(node) || hasLayout(node)) continue;
      const suggestion = suggestAutoLayout(tx.doc, [id]);
      const suggested = suggestion?.frameId === id ? suggestion.autoLayout : defaultAutoLayout('VERTICAL');
      const autoLayout = mode && suggested.layoutMode !== mode ? {...suggested, layoutMode: mode, layoutWrap: 'NO_WRAP' as const} : suggested;
      userUpdate(tx, id, {
        autoLayout: {...autoLayout, itemReverseZIndex: node.autoLayout?.itemReverseZIndex ?? false, strokesIncludedInLayout: node.autoLayout?.strokesIncludedInLayout ?? false},
        ...(suggestion?.frameId === id ? {layoutSizingHorizontal: suggestion.sizing.horizontal, layoutSizingVertical: suggestion.sizing.vertical} : {}),
      });
      if (suggestion?.frameId === id) suggestion.order.forEach((child, index) => tx.reorder(child, index));
    }
  });
  const remove = () => edit.nodes('Remove auto layout', ids, node => node.autoLayout && hasLayout(node)
    // Without auto layout a frame cannot hug: a hugging side keeps its size as a fixed one.
    ? {autoLayout: {...node.autoLayout, layoutMode: 'NONE', layoutWrap: 'NO_WRAP'},
      layoutSizingHorizontal: node.layoutSizingHorizontal === 'HUG' ? 'FIXED' : node.layoutSizingHorizontal,
      layoutSizingVertical: node.layoutSizingVertical === 'HUG' ? 'FIXED' : node.layoutSizingVertical}
    : null);
  // Wrapping breaks rows at a width, and "Auto" spreads layers along a length: a frame hugging that axis has neither,
  // so it keeps its current size as a fixed one (as Figma switches "Hug contents" to "Fixed" there).
  const fixMain = (label: string, make: (layout: AutoLayout, node: SceneNode) => Partial<AutoLayout> | null) =>
    edit.nodes(label, ids, node => {
      if (!node.autoLayout || !hasLayout(node)) return null;
      const patch = make(node.autoLayout, node);
      if (!patch) return null;
      const next = {...node.autoLayout, ...patch};
      const spreads = next.primaryAxisAlignItems === 'SPACE_BETWEEN' || next.layoutWrap === 'WRAP';
      const field = next.layoutMode === 'VERTICAL' ? 'layoutSizingVertical' : 'layoutSizingHorizontal';
      return {autoLayout: next, ...(spreads && node[field] === 'HUG' ? {[field]: 'FIXED' as const} : {})};
    });
  return {view, edit, layout, add, remove, fixMain};
}

/** Whether every selected frame has auto layout: "Layout" is titled "Auto layout" then, as UI3's Layout section is. */
export const autoLayoutOn = (doc: DesignDocument, ids: readonly NodeId[]): boolean => viewOf(doc, ids)?.state === 'all';

/** "Layout"'s header actions for frames: "Add auto layout", or with it on its settings and "Remove auto layout". */
export const AutoLayoutActions = memo(function AutoLayoutActions({ids}: {ids: readonly NodeId[]}) {
  const {view, layout, add, remove} = useAutoLayout(ids);
  if (!view) return null;
  if (view.state !== 'all') return <IconButton label="Add auto layout" shortcut="Shift+KeyA" onClick={() => add()}><IconAutoLayoutAdd /></IconButton>;
  return (
    <>
      <LayoutSettings view={view} onChange={layout} />
      <IconButton label="Remove auto layout" shortcut="Alt+Shift+KeyA" onClick={remove}><IconMinus /></IconButton>
    </>
  );
}, sameSectionProps);

type Flow = 'NONE' | 'VERTICAL' | 'HORIZONTAL' | 'GRID';

/** "Flow", UI3's flow row: "Freeform" (no auto layout), "Vertical", "Horizontal", "Grid" (Figma's grid flow,
 *  GridLayoutRows.tsx), and "Wrap" beside it for a horizontal flow. */
export const FlowRow = memo(function FlowRow({ids}: {ids: readonly NodeId[]}) {
  const {view, edit, add, remove, fixMain} = useAutoLayout(ids);
  if (!view) return null;
  const direction = view.direction;
  const flow: Flow | null = view.state === 'none' ? 'NONE' : view.state === 'some' || direction === 'mixed' ? null
    : direction === 'GRID' ? 'GRID' : direction === 'VERTICAL' ? 'VERTICAL' : 'HORIZONTAL';
  const choose = (next: Flow) => {
    if (next === 'NONE') remove();
    else if (next === 'GRID') toGrid();
    else if (view.state !== 'all') add(next);
    else fixMain('Auto layout direction', current => ({layoutMode: next, layoutWrap: next === 'VERTICAL' ? 'NO_WRAP' : current.layoutWrap}));
  };
  /** The grid flow: a frame keeps its flex fields (a switch back finds them) and gets a grid fitted to its children. */
  const toGrid = () => edit.run('Auto layout: grid', tx => {
    for (const id of ids) {
      const node = tx.get(id);
      if (!node || !isFrameLike(node) || node.autoLayout?.layoutMode === 'GRID') continue;
      const base = node.autoLayout && hasLayout(node) ? node.autoLayout : {...defaultAutoLayout('HORIZONTAL'), itemReverseZIndex: node.autoLayout?.itemReverseZIndex ?? false, strokesIncludedInLayout: node.autoLayout?.strokesIncludedInLayout ?? false};
      userUpdate(tx, id, {autoLayout: {...base, layoutMode: 'GRID', layoutWrap: 'NO_WRAP'}, grid: node.grid ?? newGrid(tx.doc, node)});
    }
  });
  const wrap = direction === 'WRAP';
  return (
    <Group caption="Flow">
      <Row>
        <SegmentedControl aria-label="Flow" className="dz-pl-flow" fill value={flow} onChange={choose}
          options={[
            {value: 'NONE', label: 'Freeform', icon: <IconFreeform />},
            {value: 'VERTICAL', label: 'Vertical', icon: <IconArrowDown />},
            {value: 'HORIZONTAL', label: 'Horizontal', icon: <IconArrowRight />},
            {value: 'GRID', label: 'Grid', icon: <IconLayoutGrid />},
          ]} />
        {view.state === 'all' && flow === 'HORIZONTAL' && (
          <IconButton label="Wrap" pressed={wrap} onClick={() => fixMain(wrap ? 'No wrap' : 'Wrap', () => ({layoutWrap: wrap ? 'NO_WRAP' : 'WRAP'}))}>
            <IconWrap />
          </IconButton>
        )}
      </Row>
    </Group>
  );
}, sameSectionProps);

/** With auto layout on: the alignment box beside the gap, the row gap when wrapping, padding and "Clip
 *  content", under "Layout"'s size rows as UI3 lays them out. Nothing otherwise. */
export const AutoLayoutRows = memo(function AutoLayoutRows({ids}: {ids: readonly NodeId[]}) {
  const {view, edit, layout, fixMain} = useAutoLayout(ids);
  // Four padding fields: the designer's toggle for this selection, else open while the sides differ. Fields opened
  // because they differed stay open while this selection is edited: typing them equal never folds them under the caret.
  const selectionKey = ids.join('\n');
  const [sides, setSides] = useState<{key: string; open: boolean} | null>(null);
  const opened = useRef<string | null>(null);
  if (!view || view.state !== 'all') return null;

  const numberField = (field: 'itemSpacing' | 'counterAxisSpacing' | 'paddingLeft' | 'paddingRight' | 'paddingTop' | 'paddingBottom', label: string, min?: number) =>
    (change: NumberEdit, source: EditSource) =>
      layout(label, current => {
        const value = change(current[field]);
        return {[field]: min === undefined ? value : Math.max(min, value)};
      }, source);
  const pair = (fields: ['paddingLeft', 'paddingRight'] | ['paddingTop', 'paddingBottom'], label: string) =>
    (change: NumberEdit, source: EditSource) =>
      layout(label, current => ({[fields[0]]: Math.max(0, change(current[fields[0]])), [fields[1]]: Math.max(0, change(current[fields[1]]))}), source);

  const direction = view.direction;
  const horizontal = direction !== 'VERTICAL';
  const gapAuto = view.auto === true;
  const horizontalPad = pairOf(view.left, view.right), verticalPad = pairOf(view.top, view.bottom);
  const padsDiffer = horizontalPad === 'mixed' || verticalPad === 'mixed';
  if (padsDiffer) opened.current = selectionKey;
  const individual = sides?.key === selectionKey ? sides.open : padsDiffer || opened.current === selectionKey;

  const grid = direction === 'GRID';
  return (
    <>
      {grid ? <GridRows ids={ids} /> : (
      <>
      <Captions left="Alignment" right="Gap" />
      <div className="dz-pl-al">
        <AlignmentGrid direction={direction} primary={view.primary} counter={view.counter}
          onPick={(primary, counter) => layout('Auto layout alignment', current => ({
            primaryAxisAlignItems: current.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'SPACE_BETWEEN' : primary,
            counterAxisAlignItems: counter,
          }))} />
        <div className="dz-pl-combo dz-pl-al-gap">
          <BindableNumber field="itemSpacing" ids={ids} icon={horizontal ? <IconGapHorizontal /> : <IconGapVertical />} aria-label="Gap between layers"
            value={gapAuto ? null : view.auto === 'mixed' ? 'mixed' : view.gap} placeholder="Auto" edit={edit}
            onChange={(change, source) => layout('Gap', current => ({itemSpacing: change(current.itemSpacing), ...(current.primaryAxisAlignItems === 'SPACE_BETWEEN' ? {primaryAxisAlignItems: 'MIN' as const} : {})}), source)} />
          <FieldMenuButton label="Gap" items={() => gapMenu(view, auto => fixMain(auto ? 'Gap: auto' : 'Gap: fixed', current => ({primaryAxisAlignItems: auto ? 'SPACE_BETWEEN' : current.primaryAxisAlignItems === 'SPACE_BETWEEN' ? 'MIN' : current.primaryAxisAlignItems})))} />
        </div>
      </div>
      {direction === 'WRAP' && (
        <Row>
          <BindableNumber field="counterAxisSpacing" ids={ids} icon={<IconGapVertical />} aria-label="Gap between rows" value={view.rowGap} edit={edit} onChange={numberField('counterAxisSpacing', 'Gap between rows')} />
        </Row>
      )}
      </>
      )}
      <Captions left="Padding" />
      {individual ? (
        <>
          <Row>
            <BindableNumber field="paddingLeft" ids={ids} icon={<IconPadLeft />} aria-label="Padding left" value={view.left} min={0} edit={edit} onChange={numberField('paddingLeft', 'Padding left', 0)} />
            <BindableNumber field="paddingTop" ids={ids} icon={<IconPadTop />} aria-label="Padding top" value={view.top} min={0} edit={edit} onChange={numberField('paddingTop', 'Padding top', 0)} />
            <IconButton label="Horizontal and vertical padding" pressed onClick={() => setSides({key: selectionKey, open: false})}><IconPaddingSides /></IconButton>
          </Row>
          <Row>
            <BindableNumber field="paddingRight" ids={ids} icon={<IconPadRight />} aria-label="Padding right" value={view.right} min={0} edit={edit} onChange={numberField('paddingRight', 'Padding right', 0)} />
            <BindableNumber field="paddingBottom" ids={ids} icon={<IconPadBottom />} aria-label="Padding bottom" value={view.bottom} min={0} edit={edit} onChange={numberField('paddingBottom', 'Padding bottom', 0)} />
          </Row>
        </>
      ) : (
        <Row>
          <PanelNumber icon={<IconPaddingHorizontal />} aria-label="Horizontal padding" value={horizontalPad} min={0} edit={edit} onChange={pair(['paddingLeft', 'paddingRight'], 'Horizontal padding')} />
          <PanelNumber icon={<IconPaddingVertical />} aria-label="Vertical padding" value={verticalPad} min={0} edit={edit} onChange={pair(['paddingTop', 'paddingBottom'], 'Vertical padding')} />
          <IconButton label="Padding for each side" onClick={() => setSides({key: selectionKey, open: true})}><IconPaddingSides /></IconButton>
        </Row>
      )}
      <Row layout="single">
        <Checkbox checked={view.clip === 'mixed' ? 'mixed' : view.clip === true}
          onChange={checked => edit.nodes(checked ? 'Clip content' : 'Do not clip content', ids, () => ({clipsContent: checked}))}>
          Clip content
        </Checkbox>
      </Row>
    </>
  );
}, sameSectionProps);

function gapMenu(view: View, set: (auto: boolean) => void): MenuItem[] {
  return [
    {id: 'auto', label: 'Auto', description: 'Layers are spread along the whole length', checked: view.auto === true, radio: true, onSelect: () => set(true)},
    {id: 'fixed', label: view.gap === 'mixed' || view.gap === null ? 'Fixed' : `Fixed: ${view.gap}`, checked: view.auto === false, radio: true, onSelect: () => set(false)},
  ];
}

// ── The nine-dot alignment ─────────────────────────────────────────────────────────────────────

const ALIGNS: readonly LayoutAlign[] = ['MIN', 'CENTER', 'MAX'];
const ROW_NAMES = ['top', 'center', 'bottom'];
const COL_NAMES = ['left', 'center', 'right'];

/** Figma's 3×3 alignment box. Columns and rows map to the main and cross axes by direction; with
 *  "Auto" spacing the main axis is spread, so a click sets only the cross alignment. */
function AlignmentGrid({direction, primary, counter, onPick}: {direction: Mixed<Direction>; primary: Mixed<AutoLayout['primaryAxisAlignItems']>; counter: Mixed<AutoLayout['counterAxisAlignItems']>; onPick: (primary: LayoutAlign, counter: LayoutAlign) => void}) {
  const horizontal = direction !== 'VERTICAL';
  const spread = primary === 'SPACE_BETWEEN';
  const p = primary === 'mixed' || primary === null || spread ? -1 : ALIGNS.indexOf(primary as LayoutAlign);
  const c = counter === 'mixed' || counter === null ? -1 : counter === 'BASELINE' ? 0 : ALIGNS.indexOf(counter);
  const activeRow = horizontal ? c : p, activeCol = horizontal ? p : c;
  const cells: ReactNode[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const main = horizontal ? col : row, cross = horizontal ? row : col;
      const active = spread ? (horizontal ? row === activeRow : col === activeCol) : row === activeRow && col === activeCol;
      cells.push(
        <button key={`${row}-${col}`} type="button" className={`dz-pl-al-cell ${active ? 'is-active' : ''}`.trim()} aria-pressed={active}
          aria-label={`Align ${ROW_NAMES[row]} ${COL_NAMES[col]}`.replace('center center', 'center')}
          onClick={() => onPick(ALIGNS[main], ALIGNS[cross])}>
          <span className="dz-pl-al-dot" />
          <AlignBars horizontal={horizontal} cross={cross} single={spread} />
        </button>,
      );
    }
  }
  return <div className={`dz-pl-al-grid ${horizontal ? 'is-row' : 'is-column'} ${spread ? 'is-spread' : ''}`.trim()} role="group" aria-label="Alignment">{cells}</div>;
}

/** Three bars of different lengths, lined up on the cross axis the way the children will be. */
function AlignBars({horizontal, cross, single}: {horizontal: boolean; cross: number; single: boolean}) {
  const lengths = single ? [9] : [9, 5, 7];
  const step = 3.5;
  const start = 8 - ((lengths.length - 1) * step) / 2;
  return (
    <svg className="dz-pl-al-bars" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      {lengths.map((length, i) => {
        const along = start + i * step;
        const from = cross === 0 ? 3 : cross === 2 ? 13 - length : 8 - length / 2;
        return horizontal
          ? <rect key={i} x={along - 0.9} y={from} width={1.8} height={length} rx={0.9} />
          : <rect key={i} x={from} y={along - 0.9} width={length} height={1.8} rx={0.9} />;
      })}
    </svg>
  );
}

// ── Settings popover ───────────────────────────────────────────────────────────────────────────

function LayoutSettings({view, onChange}: {view: View; onChange: (label: string, make: (layout: AutoLayout) => Partial<AutoLayout> | null) => void}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const horizontal = view.direction === 'HORIZONTAL';
  return (
    <>
      <IconButton ref={button} label="Auto layout settings" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(value => !value)}><IconSliders /></IconButton>
      {open && button.current && (
        <Popover anchor={button.current} onClose={close} placement="left-start" offset={offsetToPanelEdge(button.current)} aria-label="Auto layout settings" className="dz-pl-popover">
          <div className="dz-pl-popover-head">Auto layout settings</div>
          <div className="dz-pl-popover-body">
            <div className="dz-pl-caption">Stacking order</div>
            <Select aria-label="Stacking order" value={view.reverse === 'mixed' || view.reverse === null ? null : view.reverse ? 'first' : 'last'} mixed={view.reverse === 'mixed'}
              onChange={value => onChange('Stacking order', () => ({itemReverseZIndex: value === 'first'}))}
              options={[{value: 'first', label: 'First on top'}, {value: 'last', label: 'Last on top'}]} />
            <div className="dz-pl-caption">Strokes</div>
            <Select aria-label="Strokes in auto layout" value={view.strokes === 'mixed' || view.strokes === null ? null : view.strokes ? 'in' : 'out'} mixed={view.strokes === 'mixed'}
              onChange={value => onChange('Strokes in auto layout', () => ({strokesIncludedInLayout: value === 'in'}))}
              options={[{value: 'in', label: 'Included in layout'}, {value: 'out', label: 'Excluded from layout'}]} />
            {view.direction === 'WRAP' && (
              <>
                <div className="dz-pl-caption">Wrapped rows</div>
                <Select aria-label="Wrapped rows" value={view.content === 'mixed' || view.content === null ? null : view.content} mixed={view.content === 'mixed'}
                  onChange={value => onChange('Wrapped rows', () => ({counterAxisAlignContent: value}))}
                  options={[{value: 'AUTO', label: 'Packed'}, {value: 'SPACE_BETWEEN', label: 'Spread across height'}]} />
              </>
            )}
            {horizontal && (
              <Checkbox checked={view.counter === 'BASELINE'}
                onChange={checked => onChange('Text baseline alignment', current => ({counterAxisAlignItems: checked ? 'BASELINE' : current.counterAxisAlignItems === 'BASELINE' ? 'MIN' : current.counterAxisAlignItems}))}>
                Align text baselines
              </Checkbox>
            )}
          </div>
        </Popover>
      )}
    </>
  );
}
