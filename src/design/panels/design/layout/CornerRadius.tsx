import {useRef, useState, type CSSProperties} from 'react';
import type {NodeId, SceneNode} from '../../../../../shared/design/types';
import {IconButton} from '../../../ui/Button';
import {Popover} from '../../../ui/Popover';
import {Slider} from '../../../ui/Slider';
import {NumberField} from '../../../ui/NumberField';
import {applyUpdates, type EditSource, type PanelEdit} from '../shared/edit';
import {Row, offsetToPanelEdge} from '../shared/fields';
import {BindableNumber} from '../shared/bindable';
import {mixedOf, type Mixed} from '../shared/mixed';
import {IconCornerBL, IconCornerBR, IconCornerRadius, IconCornerTL, IconCornerTR, IconCorners} from './icons';

// Corner radius in "Appearance" (Figma UI3's Appearance): the radius field in the section's row, and "Individual corners"
// beside it opening "Corner radius" (Figma's Corner radius details) with a field per corner and the smoothing.

const RADIUS_TYPES = new Set<SceneNode['type']>(['RECTANGLE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'POLYGON', 'STAR', 'SECTION']);
const CORNER_TYPES = new Set<SceneNode['type']>(['RECTANGLE', 'FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE']);

type Corners = [number, number, number, number];
const radiiOf = (node: SceneNode): Corners => node.rectangleCornerRadii ?? [node.cornerRadius ?? 0, node.cornerRadius ?? 0, node.cornerRadius ?? 0, node.cornerRadius ?? 0];

export type RadiusView = {radius: Mixed<number>; corners: Mixed<number>[] | null; uneven: boolean; smoothing: Mixed<number>};

/** What the radius fields show for these layers, or undefined when one of them has no radius. */
export function radiusViewOf(nodes: readonly SceneNode[]): RadiusView | undefined {
  if (!nodes.every(node => RADIUS_TYPES.has(node.type))) return undefined;
  const withCorners = nodes.every(node => CORNER_TYPES.has(node.type));
  const radii = nodes.map(radiiOf);
  const uniform = radii.map(r => (r.every(value => value === r[0]) ? r[0] : undefined));
  return {
    radius: uniform.some(value => value === undefined) ? 'mixed' : mixedOf(uniform),
    corners: withCorners ? [0, 1, 2, 3].map(k => mixedOf(radii.map(r => r[k]))) : null,
    uneven: withCorners && uniform.some(value => value === undefined),
    smoothing: mixedOf(nodes.map(node => node.cornerSmoothing ?? 0)),
  };
}

/** The radius field of "Appearance"'s row (one radius for the whole shape; "Mixed" when the corners differ). */
export function RadiusField({ids, view, edit}: {ids: readonly NodeId[]; view: RadiusView; edit: PanelEdit}) {
  return (
    <BindableNumber field="cornerRadius" ids={ids} icon={<IconCornerRadius />} aria-label="Corner radius" value={view.radius} min={0} edit={edit}
      onChange={(change, source) => edit.run('Corner radius', tx => {
        for (const id of ids) {
          const node = tx.get(id);
          if (!node) continue;
          const start = tx.base.nodes[id] ?? node;
          const value = Math.max(0, change(radiiOf(start)[0]));
          const fields: Partial<SceneNode> = {cornerRadius: value};
          if (CORNER_TYPES.has(node.type)) fields.rectangleCornerRadii = null;
          applyUpdates(tx, new Map([[id, fields]]), () => true);
        }
      }, source)} />
  );
}

/** "Individual corners" beside the radius: opens "Corner radius", Figma's Corner radius details — a field per corner
 *  (rectangles and frames) and the smoothing slider with Apple's 60 % marked "iOS". Pressed while the corners differ. */
export function CornerDetailsButton({ids, view, edit}: {ids: readonly NodeId[]; view: RadiusView; edit: PanelEdit}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  return (
    <>
      <IconButton ref={button} label="Individual corners" pressed={view.uneven || !!anchor} aria-haspopup="dialog" aria-expanded={!!anchor}
        onClick={() => setAnchor(anchor ? null : button.current)}>
        <IconCorners />
      </IconButton>
      {anchor && (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} placement="left-start" offset={offsetToPanelEdge(anchor)} aria-label="Corner radius" className="dz-pl-popover">
          <div className="dz-pl-popover-head">Corner radius</div>
          <div className="dz-pl-popover-body">
            {view.corners && <CornerRows ids={ids} corners={view.corners} edit={edit} />}
            <div className="dz-pl-caption">Corner smoothing</div>
            <SmoothingControl ids={ids} value={view.smoothing} edit={edit} />
          </div>
        </Popover>
      )}
    </>
  );
}

const CORNER_FIELDS: readonly {index: number; label: string; field: string; Icon: typeof IconCornerTL}[] = [
  {index: 0, label: 'Top left', field: 'topLeftRadius', Icon: IconCornerTL},
  {index: 1, label: 'Top right', field: 'topRightRadius', Icon: IconCornerTR},
  {index: 3, label: 'Bottom left', field: 'bottomLeftRadius', Icon: IconCornerBL},
  {index: 2, label: 'Bottom right', field: 'bottomRightRadius', Icon: IconCornerBR},
];

function CornerRows({ids, corners, edit}: {ids: readonly NodeId[]; corners: Mixed<number>[]; edit: PanelEdit}) {
  const field = ({index, label, field: bindable, Icon}: (typeof CORNER_FIELDS)[number]) => (
    <BindableNumber key={index} field={bindable} ids={ids} icon={<Icon />} aria-label={label} value={corners[index]} min={0} edit={edit}
      onChange={(change, source) => edit.run('Corner radius', tx => {
        for (const id of ids) {
          const start = tx.base.nodes[id];
          if (!start || !CORNER_TYPES.has(start.type)) continue;
          const radii = [...radiiOf(start)] as Corners;
          radii[index] = Math.max(0, change(radii[index]));
          const even = radii.every(value => value === radii[0]);
          applyUpdates(tx, new Map([[id, even ? {cornerRadius: radii[0], rectangleCornerRadii: null} : {rectangleCornerRadii: radii}]]), () => true);
        }
      }, source)} />
  );
  return (
    <>
      <Row>{field(CORNER_FIELDS[0])}{field(CORNER_FIELDS[1])}</Row>
      <Row>{field(CORNER_FIELDS[2])}{field(CORNER_FIELDS[3])}</Row>
    </>
  );
}

/** "Corner smoothing" inside the details: the slider with Apple's 60 % marked "iOS", and the value in percent. */
function SmoothingControl({ids, value, edit}: {ids: readonly NodeId[]; value: Mixed<number>; edit: PanelEdit}) {
  const percent = value === 'mixed' || value === null ? null : Math.round(value * 100);
  const set = (next: number, source: EditSource) =>
    edit.nodes('Corner smoothing', ids, () => ({cornerSmoothing: Math.min(1, Math.max(0, next / 100))}), source);
  return (
    <div className="dz-pl-smoothing-row">
      <div className="dz-pl-smoothing">
        <Slider aria-label="Corner smoothing" value={percent ?? 0} min={0} max={100} step={1} valueText={percent === null ? 'Mixed' : `${percent}%`}
          onChangeStart={() => edit.start('Corner smoothing')} onChange={next => set(next, 'gesture')} onChangeEnd={() => edit.end(false)} />
        <button type="button" className="dz-pl-ios-mark" style={{'--dz-at': 0.6} as CSSProperties} onClick={() => set(60, 'input')}>iOS</button>
      </div>
      <NumberField aria-label="Corner smoothing, %" value={value === 'mixed' ? 'mixed' : percent} min={0} max={100} precision={0} suffix="%" className="dz-pl-smoothing-field"
        onScrubStart={() => edit.start('Corner smoothing')} onScrubEnd={cancelled => edit.end(cancelled)} onChange={(next, source) => set(next, source)} />
    </div>
  );
}
