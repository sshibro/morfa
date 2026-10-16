import {memo, useCallback, useRef, type ReactNode} from 'react';
import type {DesignDocument, LayoutSizing, NodeId, SceneNode} from '../../../../../shared/design/types';
import {FRAME_LIKE_TYPES} from '../../../../../shared/design/types';
import type {SizingAxis} from '../../../../../shared/design/layout';
import {IconButton} from '../../../ui/Button';
import {Checkbox} from '../../../ui/Toggle';
import {PanelSection} from '../../../ui/PanelSection';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {useTooltip} from '../../../ui/Tooltip';
import {IconChevronDown, IconMinus} from '../../../ui/icons';
import type {SectionProps} from '../sections';
import {applyUpdates, sameSectionProps, usePanelEdit, type EditSource, type PanelEdit, useSectionView} from '../shared/edit';
import {Group, Row} from '../shared/fields';
import {AutoLayoutActions, AutoLayoutRows, FlowRow, autoLayoutOn} from './AutoLayoutSection';
import {BindableNumber} from '../shared/bindable';
import {TextResizeRows, textResizeView, type TextResizeView} from '../text/TextResize';
import {GridChildRows, inGrid} from './GridLayoutRows';
import {mixedOf, sameValue, type Mixed, type NumberEdit} from '../shared/mixed';
import {hasHeight, sizeUpdates} from './geometry';
import {IconLink, IconUnlink} from './icons';
import {LIMIT_ADD, LIMIT_FIELDS, LIMIT_LABELS, LIMIT_REMOVE, SIZING_LABELS, SIZING_MENU, canLimit, limitStart, limitValue, selectionSizingUpdates, showsSizing, sizingChoice, type LimitField, type SizingChoice} from './sizing';

// "Layout" (order 25), Figma UI3's Layout section: for frames "Flow" and auto layout's controls (AutoLayoutSection.tsx;
// the section is titled "Auto layout" while it is on, as UI3's is); W and H with the proportion lock and, inside auto
// layout, the sizing ("Fixed / Hug / Fill") and min/max in a chip inside each field; a text's resizing
// (TextResize.tsx); "Clip content". Values come from every selected layer:
// "Mixed" where they differ.

const isFrameLike = (node: SceneNode) => FRAME_LIKE_TYPES.includes(node.type);

type View = {
  width: Mixed<number>; height: Mixed<number>; noHeight: boolean;
  /** Every layer keeps its proportions ("Constrain proportions", stored on the layer). */
  ratio: boolean;
  sizing: {horizontal: SizingChoice; vertical: SizingChoice} | null;
  limits: Partial<Record<LimitField, Mixed<number>>> | null;
  clip: Mixed<boolean> | undefined;
  /** Every selected layer is a frame: the flow and auto layout belong here. */
  frames: boolean;
  /** …and every one has auto layout: the section is "Auto layout". */
  autoLayout: boolean;
  /** Every selected layer is a text in a box: its resizing shows here, as in UI3. */
  text: TextResizeView | null;
  /** Every selected layer sits in a grid: its spans (and cell) show here. */
  gridChild: boolean;
};

function viewOf(doc: DesignDocument, ids: readonly NodeId[]): View | null {
  const nodes = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && node.type !== 'PAGE');
  if (!nodes.length) return null;
  const limits = nodes.every(node => canLimit(doc, node)) ? Object.fromEntries(LIMIT_FIELDS.map(field => [field, limitValue(nodes, field)]).filter(([, value]) => value !== undefined)) : null;
  return {
    width: mixedOf(nodes.map(node => node.width)), height: mixedOf(nodes.map(node => node.height)),
    noHeight: nodes.every(node => !hasHeight(node)),
    ratio: nodes.every(node => node.constrainProportions === true),
    sizing: showsSizing(doc, nodes) ? {horizontal: sizingChoice(doc, nodes, 'horizontal'), vertical: sizingChoice(doc, nodes, 'vertical')} : null,
    limits,
    // With auto layout (flex or grid) the clip row is AutoLayoutRows' own.
    clip: nodes.every(node => isFrameLike(node) && (node.autoLayout?.layoutMode ?? 'NONE') === 'NONE') ? mixedOf(nodes.map(node => node.clipsContent !== false)) : undefined,
    frames: nodes.every(isFrameLike),
    autoLayout: autoLayoutOn(doc, ids),
    text: textResizeView(nodes),
    gridChild: inGrid(doc, ids),
  };
}

export const SizeSection = memo(function SizeSection({ids}: SectionProps) {
  const view = useSectionView(viewOf, ids, sameValue);
  const edit = usePanelEdit();
  if (!view) return null;
  const locked = view.ratio;
  const setSize = (axis: 'width' | 'height') => (change: NumberEdit, source: EditSource) =>
    edit.run(axis === 'width' ? 'Width' : 'Height', tx => {
      for (const id of ids) {
        const node = tx.get(id);
        if (!node) continue;
        const value = Math.max(0, change(node[axis]));
        applyUpdates(tx, sizeUpdates(tx.doc, id, {[axis]: value}, node.constrainProportions === true), each => each === id);
      }
    }, source);
  const width = <BindableNumber field="width" ids={ids} label="W" aria-label="Width" value={view.width} min={0} edit={edit} onChange={setSize('width')} />;
  const height = <BindableNumber field="height" ids={ids} label="H" aria-label="Height" value={view.noHeight ? null : view.height} min={0} disabled={view.noHeight} edit={edit} onChange={setSize('height')} />;
  return (
    <PanelSection title={view.autoLayout ? 'Auto layout' : 'Layout'} className="dz-pl-section" actions={view.frames ? <AutoLayoutActions ids={ids} /> : undefined}>
      {view.frames && <FlowRow ids={ids} />}
      <Group caption="Dimensions">
        <Row>
          {view.sizing ? (
            <SizedField ids={ids} axis="horizontal" choice={view.sizing.horizontal} limits={view.limits} edit={edit}>{width}</SizedField>
          ) : width}
          {view.sizing ? (
            <SizedField ids={ids} axis="vertical" choice={view.sizing.vertical} limits={view.limits} edit={edit}>{height}</SizedField>
          ) : height}
          <IconButton label={locked ? 'Unlock proportions' : 'Lock proportions'} pressed={locked}
            onClick={() => edit.nodes(locked ? 'Unlock proportions' : 'Lock proportions', ids, () => ({constrainProportions: locked ? undefined : true}))}>
            {locked ? <IconLink /> : <IconUnlink />}
          </IconButton>
        </Row>
        {view.limits && <LimitRows ids={ids} limits={view.limits} edit={edit} />}
        {view.text && <TextResizeRows ids={ids} view={view.text} />}
      </Group>
      {view.gridChild && <GridChildRows ids={ids} />}
      {view.frames && <AutoLayoutRows ids={ids} />}
      {view.clip !== undefined && (
        <Row layout="single">
          <Checkbox checked={view.clip === 'mixed' ? 'mixed' : view.clip === true}
            onChange={checked => edit.nodes(checked ? 'Clip content' : 'Do not clip content', ids, () => ({clipsContent: checked}))}>
            Clip content
          </Checkbox>
        </Row>
      )}
    </PanelSection>
  );
}, sameSectionProps);

// ── Sizing ─────────────────────────────────────────────────────────────────────────────────────

/** What the chip inside W or H reads, as UI3 writes "Hug" and "Fill" there (short: the field is narrow; the menu and the
 *  tooltip say it whole). A fixed side shows only the chevron. */
const SIZING_CHIP: Record<LayoutSizing, string> = {FIXED: '', HUG: 'Hug', FILL: 'Fill'};
const AXIS_LIMITS: Record<SizingAxis, readonly LimitField[]> = {horizontal: ['minWidth', 'maxWidth'], vertical: ['minHeight', 'maxHeight']};

/** W or H with its sizing inside the field, as Figma UI3: the value, then a chip naming the sizing that opens its menu —
 *  fixed, hug, fill, and the min and max of that axis. */
function SizedField({ids, axis, choice, limits, edit, children}: {ids: readonly NodeId[]; axis: SizingAxis; choice: SizingChoice; limits: View['limits']; edit: PanelEdit; children: ReactNode}) {
  const value = choice.value;
  const items = useCallback((): MenuItem[] => {
    const choose = (option: LayoutSizing) =>
      edit.run(`Resizing: ${SIZING_LABELS[option].toLowerCase()}`, tx => applyUpdates(tx, selectionSizingUpdates(tx.doc, ids, axis, option), id => ids.includes(id)));
    const sizing = (['FIXED', 'HUG', 'FILL'] as const).map((option): MenuItem => ({
      id: option, label: SIZING_MENU[axis][option], checked: value === option, radio: true,
      disabled: (option === 'HUG' && !choice.hug) || (option === 'FILL' && !choice.fill), onSelect: () => choose(option),
    }));
    if (!limits) return sizing;
    const bounds = AXIS_LIMITS[axis].map((field): MenuItem => {
      const set = limits[field] !== undefined;
      return {id: field, label: set ? LIMIT_REMOVE[field] : LIMIT_ADD[field],
        onSelect: () => edit.nodes(set ? LIMIT_REMOVE[field] : LIMIT_ADD[field], ids, node => ({[field]: set ? null : limitStart(node, field)}))};
    });
    return [...sizing, {type: 'separator'}, ...bounds];
  }, [ids, axis, choice, value, limits, edit]);
  const label = axis === 'horizontal' ? 'Horizontal resizing' : 'Vertical resizing';
  const anchor = useRef<HTMLElement | null>(null);
  const menu = useMenuTrigger({items, label, minWidth: 220, placement: 'bottom-end', anchor: () => anchor.current?.closest('.dz-pl-combo') ?? anchor.current});
  const shown = value === 'mixed' ? 'Mixed' : value ? SIZING_MENU[axis][value] : '';
  const tip = useTooltip(menu.open ? null : {label: `${label}: ${shown.toLowerCase()}`});
  const chip = value === 'mixed' ? '…' : value ? SIZING_CHIP[value] : '';
  return (
    <div className={`dz-pl-combo dz-pl-sized ${chip ? 'has-chip' : ''}`.trim()}>
      {children}
      <button type="button" aria-label={label} aria-description={shown} {...tip} {...menu.triggerProps} className="dz-pl-sizing-chip"
        ref={element => {
          anchor.current = element;
          menu.triggerProps.ref(element);
        }}>
        {chip && <span>{chip}</span>}
        <IconChevronDown size={12} />
      </button>
      {menu.element}
    </div>
  );
}

function LimitRows({ids, limits, edit}: {ids: readonly NodeId[]; limits: NonNullable<View['limits']>; edit: PanelEdit}) {
  const fields = LIMIT_FIELDS.filter(field => limits[field] !== undefined);
  if (!fields.length) return null;
  return (
    <>
      {fields.map(field => (
        <Row key={field}>
          <span className="dz-pl-row-label">{LIMIT_LABELS[field]}</span>
          <BindableNumber field={field} ids={ids} aria-label={LIMIT_LABELS[field]} label={field.endsWith('Width') ? 'W' : 'H'} value={limits[field] ?? null} min={0} edit={edit}
            onChange={(change, source) => edit.run(LIMIT_LABELS[field], tx => {
              for (const id of ids) {
                const node = tx.get(id);
                const start = tx.base.nodes[id];
                if (!node || !start) continue;
                applyUpdates(tx, new Map([[id, {[field]: Math.max(0, change(start[field] ?? limitStart(start, field)))}]]), () => true);
              }
            }, source)} />
          <IconButton label={LIMIT_REMOVE[field]} onClick={() => edit.nodes(LIMIT_REMOVE[field], ids, () => ({[field]: null}))}><IconMinus /></IconButton>
        </Row>
      ))}
    </>
  );
}
