import {memo, useCallback, useRef} from 'react';
import type {BlendMode, DesignDocument, NodeId, SceneNode} from '../../../../../shared/design/types';
import {CONTAINER_TYPES} from '../../../../../shared/design/types';
import {IconButton} from '../../../ui/Button';
import {PanelSection} from '../../../ui/PanelSection';
import {Select, type SelectEntry} from '../../../ui/Select';
import {IconEye, IconEyeOff} from '../../../ui/icons';
import type {SectionProps} from '../sections';
import {sameSectionProps, usePanelEdit, useSectionView} from '../shared/edit';
import {Captions, Row} from '../shared/fields';
import {useMenuTrigger} from '../../../ui/Menu';
import type {MenuItem} from '../../../ui/menu-model';
import {useTooltip} from '../../../ui/Tooltip';
import {BindableNumber} from '../shared/bindable';
import {ComponentPropertyBindButton} from '../components/ComponentPropertyBindButton';
import {useVariableBinding} from '../../variables/VariableBindButton';
import {mixedOf, sameValue, type Mixed} from '../shared/mixed';
import {IconBlend, IconOpacity} from './icons';
import {CornerDetailsButton, RadiusField, radiusViewOf, type RadiusView} from './CornerRadius';

// "Appearance" (order 50), Figma UI3's Appearance section: the eye and the blend mode's droplet (all seventeen modes,
// grouped as in Figma) in the header; opacity and corner radius in one row with "Individual corners" (CornerRadius.tsx);
// for masks the mask type (Alpha / Vector / Luminance).

/** The names Russian editions of graphics editors use, the same as the paint picker's (ui/ColorPicker.tsx BLEND_MODES). */
export const BLEND_LABELS: Record<BlendMode, string> = {
  PASS_THROUGH: 'Pass through', NORMAL: 'Normal',
  DARKEN: 'Darken', MULTIPLY: 'Multiply', COLOR_BURN: 'Color burn',
  LIGHTEN: 'Lighten', SCREEN: 'Screen', COLOR_DODGE: 'Color dodge',
  OVERLAY: 'Overlay', SOFT_LIGHT: 'Soft light', HARD_LIGHT: 'Hard light',
  DIFFERENCE: 'Difference', EXCLUSION: 'Exclusion',
  HUE: 'Hue', SATURATION: 'Saturation', COLOR: 'Color', LUMINOSITY: 'Luminosity',
};

const GROUPS: readonly (readonly BlendMode[])[] = [
  ['PASS_THROUGH', 'NORMAL'],
  ['DARKEN', 'MULTIPLY', 'COLOR_BURN'],
  ['LIGHTEN', 'SCREEN', 'COLOR_DODGE'],
  ['OVERLAY', 'SOFT_LIGHT', 'HARD_LIGHT'],
  ['DIFFERENCE', 'EXCLUSION'],
  ['HUE', 'SATURATION', 'COLOR', 'LUMINOSITY'],
];

/** "Pass through" belongs to containers (their children blend with what is below the container). */
export function blendOptions(containers: boolean): SelectEntry<BlendMode>[] {
  const out: SelectEntry<BlendMode>[] = [];
  GROUPS.forEach((group, index) => {
    if (index) out.push({separator: true});
    for (const mode of group) if (containers || mode !== 'PASS_THROUGH') out.push({value: mode, label: BLEND_LABELS[mode]});
  });
  return out;
}

const MASK_LABELS = {ALPHA: 'Alpha', VECTOR: 'Vector', LUMINANCE: 'Luminance'} as const;
type MaskType = keyof typeof MASK_LABELS;

type View = {blend: Mixed<BlendMode>; opacity: Mixed<number>; visible: Mixed<boolean>; containers: boolean; mask: Mixed<MaskType> | undefined; radius: RadiusView | undefined};

function viewOf(doc: DesignDocument, ids: readonly NodeId[]): View | null {
  const nodes = ids.map(id => doc.nodes[id]).filter((node): node is SceneNode => !!node && node.type !== 'PAGE');
  if (!nodes.length) return null;
  const masks = nodes.filter(node => node.isMask);
  return {
    blend: mixedOf(nodes.map(node => node.blendMode)),
    opacity: mixedOf(nodes.map(node => Math.round(node.opacity * 10_000) / 100)),
    visible: mixedOf(nodes.map(node => node.visible)),
    containers: nodes.every(node => CONTAINER_TYPES.includes(node.type)),
    mask: masks.length ? mixedOf(masks.map(node => node.maskType ?? 'ALPHA')) : undefined,
    radius: radiusViewOf(nodes),
  };
}

export const LayerSection = memo(function LayerSection({ids}: SectionProps) {
  const view = useSectionView(viewOf, ids, sameValue);
  const edit = usePanelEdit();
  // A right click on the eye binds a boolean variable to the visibility, as Figma's; the hexagon shows once one is bound.
  const opener = useRef<(() => void) | null>(null);
  const visibility = useVariableBinding('visible', {ids, opener});
  const bound = visibility.state?.variableId != null;
  if (!view) return null;
  const hidden = view.visible === false;
  const setBlend = (mode: BlendMode) =>
    edit.nodes(`Blend mode: ${BLEND_LABELS[mode].toLowerCase()}`, ids, node => (mode === 'PASS_THROUGH' && !CONTAINER_TYPES.includes(node.type) ? {blendMode: 'NORMAL'} : {blendMode: mode}));
  return (
    <PanelSection title="Appearance" className="dz-pl-section"
      actions={<>
        {ids.length === 1 && <ComponentPropertyBindButton nodeId={ids[0]} field="visible" />}
        <span className={`dz-pl-visibility-var ${bound ? 'is-bound' : ''}`.trim()}>{visibility.button}</span>
        <IconButton label={hidden ? 'Show layer' : 'Hide layer'} shortcut="Mod+Shift+KeyH" pressed={hidden}
          onClick={() => edit.nodes(hidden ? 'Show' : 'Hide', ids, () => ({visible: hidden}))}
          onContextMenu={event => {
            if (!opener.current) return;
            event.preventDefault();
            opener.current();
          }}>
          {hidden ? <IconEyeOff /> : <IconEye />}
        </IconButton>
        <BlendButton blend={view.blend} containers={view.containers || view.blend === 'PASS_THROUGH'} onChange={setBlend} />
      </>}>
      <Captions left="Opacity" right={view.radius ? 'Corner radius' : undefined} />
      <Row className="dz-pl-layer-row">
        <BindableNumber field="opacity" ids={ids} icon={<IconOpacity />} aria-label="Layer opacity" value={view.opacity} suffix="%" min={0} max={100} precision={0}
          onScrubStart={() => edit.start('Opacity')} onScrubEnd={cancelled => edit.end(cancelled)}
          onChange={(change, source) => edit.nodes('Opacity', ids, node => ({opacity: Math.min(100, Math.max(0, change(Math.round(node.opacity * 10_000) / 100))) / 100}), source)} />
        {view.radius && <RadiusField ids={ids} view={view.radius} edit={edit} />}
        {view.radius && <CornerDetailsButton ids={ids} view={view.radius} edit={edit} />}
      </Row>
      {view.mask !== undefined && (
        <>
          <Captions left="Mask type" always />
          <Row layout="wide">
            <Select aria-label="Mask type" value={view.mask === 'mixed' ? null : view.mask} mixed={view.mask === 'mixed'}
              options={(Object.keys(MASK_LABELS) as MaskType[]).map(value => ({value, label: MASK_LABELS[value]}))}
              onChange={maskType => edit.nodes('Mask type', ids, node => (node.isMask ? {maskType} : null))} />
          </Row>
        </>
      )}
    </PanelSection>
  );
}, sameSectionProps);

/** The droplet in the header, as UI3's Appearance: a menu of the blend modes (grouped as in Figma) with a check on the
 *  current one, whose name the tooltip says. */
function BlendButton({blend, containers, onChange}: {blend: Mixed<BlendMode>; containers: boolean; onChange: (mode: BlendMode) => void}) {
  const items = useCallback((): MenuItem[] => blendOptions(containers).map((entry): MenuItem => ('value' in entry
    ? {id: entry.value, label: entry.label, checked: blend === entry.value, radio: true, onSelect: () => onChange(entry.value)}
    : {type: 'separator'})), [blend, containers, onChange]);
  const menu = useMenuTrigger({items, label: 'Blend mode', minWidth: 200, placement: 'bottom-end'});
  const current = blend === 'mixed' ? 'Mixed' : blend ? BLEND_LABELS[blend] : '';
  const tip = useTooltip(menu.open ? null : {label: `Blend mode: ${current}`});
  return (
    <>
      <button type="button" aria-label="Blend mode" aria-description={current} {...tip} {...menu.triggerProps} className="dz-icon-btn is-24 is-panel">
        <IconBlend />
      </button>
      {menu.element}
    </>
  );
}
