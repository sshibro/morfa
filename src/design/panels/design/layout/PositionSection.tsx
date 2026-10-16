import {memo, useMemo, useRef} from 'react';
import type {ConstraintType, DesignDocument, NodeId, SceneNode} from '../../../../../shared/design/types';
import {IconButton} from '../../../ui/Button';
import {Select, type SelectEntry} from '../../../ui/Select';
import {PanelSection} from '../../../ui/PanelSection';
import {useTooltip} from '../../../ui/Tooltip';
import type {SectionProps} from '../sections';
import {applyUpdates, sameSectionProps, usePanelEdit, type EditSource, type PanelEdit, useSectionView} from '../shared/edit';
import {Group, PanelNumber, Row} from '../shared/fields';
import {mixedOf, sameValue, type Mixed, type NumberEdit} from '../shared/mixed';
import {flipUpdates, rotateUpdates} from './flip';
import {CONSTRAINT_LABELS, CONSTRAINT_ORDER, canBeAbsolute, constraintAfterClick, constraintParts, parentRelation, type ConstraintAxis, type ConstraintPart} from './constraints-model';
import {displayPlacement, displayPlacements, isInFlow, positionUpdate, rotationUpdate} from './geometry';
import {AlignmentRow} from '../SelectionHeader';
import {IconAbsolute, IconAngle, IconFlipHorizontal, IconFlipVertical, IconRotateCw} from './icons';

// "Position" (order 20), Figma UI3's Position section: the alignment row (SelectionHeader.tsx `AlignmentRow`), X and Y
// ("Absolute position" beside them for children of auto layout), rotation with the 90° turn and flips, and
// constraints for children of plain containers. Size, sizing and clipping are "Layout" (SizeSection.tsx); corner radius
// is "Appearance" (LayerSection.tsx), as UI3 groups them.
// Values come from every selected layer: "Mixed" where they differ, and an edit applies to each (a scrub moves each
// from its own value).

type View = {
  x: Mixed<number>; y: Mixed<number>; rotation: Mixed<number>;
  placeLocked: boolean;
  relation: Mixed<'constraints' | 'flow' | null>;
  horizontal: Mixed<ConstraintType>; vertical: Mixed<ConstraintType>;
  absolute: Mixed<boolean> | undefined;
};

function viewOf(doc: DesignDocument, ids: readonly NodeId[]): View | null {
  const nodes = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && node.type !== 'PAGE');
  if (!nodes.length) return null;
  const place = displayPlacements(doc);
  const placed = nodes.map(place);
  return {
    x: mixedOf(placed.map(p => p.x)), y: mixedOf(placed.map(p => p.y)),
    rotation: mixedOf(placed.map(p => p.rotation)),
    placeLocked: nodes.some(node => isInFlow(doc, node)),
    relation: mixedOf(nodes.map(node => parentRelation(doc, node))),
    horizontal: mixedOf(nodes.map(node => node.constraints.horizontal)),
    vertical: mixedOf(nodes.map(node => node.constraints.vertical)),
    absolute: nodes.every(node => canBeAbsolute(doc, node)) ? mixedOf(nodes.map(node => node.layoutPositioning === 'ABSOLUTE')) : undefined,
  };
}

const sameView = (a: View | null, b: View | null) => sameValue(a, b);

/** Equal apart from X and Y (what a drag, a nudge or an undo of one usually changes). */
function sameApartFromPlace(a: View, b: View): boolean {
  for (const key in a) if (key !== 'x' && key !== 'y' && !sameValue(a[key as keyof View], b[key as keyof View])) return false;
  for (const key in b) if (!(key in a) && b[key as keyof View] !== undefined) return false;
  return true;
}

export const PositionSection = memo(function PositionSection({ids}: SectionProps) {
  const view = useSectionView(viewOf, ids, sameView);
  const edit = usePanelEdit();
  // The rows below X and Y keep their elements while only X and Y change, so React skips them on every frame of a drag.
  const steadyView = useRef<View | null>(null);
  const steady = view && steadyView.current && sameApartFromPlace(steadyView.current, view) ? steadyView.current : view;
  steadyView.current = steady;

  const rest = useMemo(() => {
    if (!steady) return null;
    const view = steady;
    return (
      <>
        <Group caption="Rotation">
          <Row>
            <PanelNumber icon={<IconAngle />} aria-label="Rotation" value={view.rotation} suffix="°" precision={2} edit={edit}
              onChange={(change, source) => edit.run('Rotation', tx => {
                for (const id of ids) {
                  const node = tx.get(id);
                  if (node) applyUpdates(tx, new Map([[id, rotationUpdate(tx.doc, node, change(displayPlacement(tx.doc, node).rotation))]]), () => true);
                }
              }, source)} />
            <div className="dz-pl-buttons">
              <IconButton label="Rotate 90° clockwise" onClick={() => edit.run('Rotate 90°', tx => applyUpdates(tx, rotateUpdates(tx.doc, ids, -90), () => true))}><IconRotateCw /></IconButton>
              <IconButton label="Flip horizontal" onClick={() => edit.run('Flip horizontal', tx => applyUpdates(tx, flipUpdates(tx.doc, ids, 'x'), () => true))}><IconFlipHorizontal /></IconButton>
              <IconButton label="Flip vertical" onClick={() => edit.run('Flip vertical', tx => applyUpdates(tx, flipUpdates(tx.doc, ids, 'y'), () => true))}><IconFlipVertical /></IconButton>
            </div>
          </Row>
        </Group>
        {view.relation === 'constraints' && <ConstraintsGroup ids={ids} horizontal={view.horizontal} vertical={view.vertical} edit={edit} />}
      </>
    );
  }, [steady, ids, edit]);

  if (!view) return null;

  const setPlace = (axis: 'x' | 'y') => (change: NumberEdit, source: EditSource) =>
    edit.run(axis === 'x' ? 'Position X' : 'Position Y', tx => {
      for (const id of ids) {
        const node = tx.get(id);
        if (!node) continue;
        const shown = displayPlacement(tx.doc, node)[axis];
        applyUpdates(tx, new Map([[id, positionUpdate(tx.doc, node, axis, change(shown))]]), () => true);
      }
    }, source);

  return (
    <PanelSection title="Position" className="dz-pl-section">
      <Group caption="Alignment"><AlignmentRow /></Group>
      <Group caption="Position">
        <Row>
          <PanelNumber label="X" aria-label="Position X" value={view.x} disabled={view.placeLocked} edit={edit} onChange={setPlace('x')} />
          <PanelNumber label="Y" aria-label="Position Y" value={view.y} disabled={view.placeLocked} edit={edit} onChange={setPlace('y')} />
          {view.absolute !== undefined && (
            <IconButton label="Absolute position" pressed={view.absolute === true}
              onClick={() => edit.nodes(view.absolute === true ? 'Include in auto layout' : 'Absolute position', ids, () => ({layoutPositioning: view.absolute === true ? 'AUTO' : 'ABSOLUTE'}))}>
              <IconAbsolute />
            </IconButton>
          )}
        </Row>
      </Group>
      {rest}
    </PanelSection>
  );
}, sameSectionProps);

// ── Constraints ────────────────────────────────────────────────────────────────────────────────

function constraintOptions(axis: ConstraintAxis): SelectEntry<ConstraintType>[] {
  return CONSTRAINT_ORDER.map(type => ({value: type, label: CONSTRAINT_LABELS[axis][type]}));
}

function ConstraintsGroup({ids, horizontal, vertical, edit}: {ids: readonly NodeId[]; horizontal: Mixed<ConstraintType>; vertical: Mixed<ConstraintType>; edit: PanelEdit}) {
  const set = (axis: ConstraintAxis, make: (current: ConstraintType) => ConstraintType) =>
    edit.nodes('Constraints', ids, node => ({constraints: {...node.constraints, [axis]: make(node.constraints[axis])}}));
  return (
    <Group caption="Constraints">
      <div className="dz-pl-constraints">
        <ConstraintWidget horizontal={horizontal} vertical={vertical}
          onPick={(axis, part, shift) => set(axis, current => constraintAfterClick(current, part, shift))} />
        <div className="dz-pl-constraint-selects">
          <Select aria-label="Horizontal constraint" value={horizontal === 'mixed' ? null : horizontal} mixed={horizontal === 'mixed'}
            icon={<AxisGlyph axis="horizontal" />} options={constraintOptions('horizontal')} onChange={value => set('horizontal', () => value)} />
          <Select aria-label="Vertical constraint" value={vertical === 'mixed' ? null : vertical} mixed={vertical === 'mixed'}
            icon={<AxisGlyph axis="vertical" />} options={constraintOptions('vertical')} onChange={value => set('vertical', () => value)} />
        </div>
      </div>
    </Group>
  );
}

function AxisGlyph({axis}: {axis: ConstraintAxis}) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      {axis === 'horizontal' ? <path d="M2.75 4.5v7M13.25 4.5v7M5.25 8h5.5" /> : <path d="M4.5 2.75h7M4.5 13.25h7M8 5.25v5.5" />}
    </svg>
  );
}

const WIDGET_PARTS: readonly {axis: ConstraintAxis; part: ConstraintPart; label: string; className: string}[] = [
  {axis: 'vertical', part: 'start', label: 'Top', className: 'is-top'},
  {axis: 'horizontal', part: 'start', label: 'Left', className: 'is-left'},
  {axis: 'horizontal', part: 'end', label: 'Right', className: 'is-right'},
  {axis: 'vertical', part: 'end', label: 'Bottom', className: 'is-bottom'},
  {axis: 'horizontal', part: 'center', label: 'Center horizontally', className: 'is-center-h'},
  {axis: 'vertical', part: 'center', label: 'Center vertically', className: 'is-center-v'},
];

/** Figma's constraints square: a bar per side, two centre lines; ⇧-click pins both sides. */
function ConstraintWidget({horizontal, vertical, onPick}: {horizontal: Mixed<ConstraintType>; vertical: Mixed<ConstraintType>; onPick: (axis: ConstraintAxis, part: ConstraintPart, shift: boolean) => void}) {
  const lit = {horizontal: constraintParts(horizontal), vertical: constraintParts(vertical)};
  return (
    <div className="dz-pl-constraint-widget" role="group" aria-label="Constraints: diagram">
      <span className="dz-pl-constraint-frame" aria-hidden="true" />
      {WIDGET_PARTS.map(({axis, part, label, className}) => (
        <WidgetBar key={className} className={className} label={label} active={lit[axis][part]} onClick={shift => onPick(axis, part, shift)} />
      ))}
    </div>
  );
}

function WidgetBar({className, label, active, onClick}: {className: string; label: string; active: boolean; onClick: (shift: boolean) => void}) {
  const tip = useTooltip({label: `${label}${className.startsWith('is-center') ? '' : ' (⇧ — both sides)'}`});
  return (
    <button type="button" className={`dz-pl-constraint-bar ${className} ${active ? 'is-active' : ''}`.trim()} aria-pressed={active} aria-label={label} {...tip}
      onClick={event => onClick(event.shiftKey)}>
      <span />
    </button>
  );
}

