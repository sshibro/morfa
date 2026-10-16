import {memo, useCallback, useState} from 'react';
import type {IndividualStrokeWeights, NodeId, SceneNode, StrokeAlign, StrokeCap, StrokeJoin, StrokeMarker, StrokeWidthProfile} from '../../../../../shared/design/types';
import {takesWidthProfile, widthAt, widthPointsOf, WIDTH_PROFILE_LABELS} from '../../../../../shared/design/stroke-profile';
import {rememberBrushProfile} from '../../../engine/tools/brush';
import type {EditorState} from '../../../engine/store';
import {useDesignStore, useStoreApi} from '../../../engine/useDesignStore';
import {userUpdate} from '../../../engine/user-edit';
import {IconButton} from '../../../ui/Button';
import {FloatingPanel, besidePanel} from '../../../ui/ColorPicker';
import {IconSliders, IconClose, IconStrokeSides, IconSwap} from '../../../ui/icons';
import {Menu} from '../../../ui/Menu';
import {NumberField} from '../../../ui/NumberField';
import type {Rect} from '../../../ui/position';
import {Select, type SelectEntry} from '../../../ui/Select';
import type {Committer} from './editing';
import {MIXED, SIDE_KEYS, SIDE_LABELS, commonValue, sideMode, sidePatch, takesMarkers, takesSideWeights, type Mixed, type SideMode} from './paints';

// The stroke's geometry under its paints: alignment, weight, weights per side (rectangles and
// frames), line ends for lines and open paths, and "More" with dashes, caps, joins and the miter limit.

type StrokeData = {
  ids: NodeId[];
  weight: number | Mixed;
  align: StrokeAlign | Mixed;
  sides: IndividualStrokeWeights | null | Mixed;
  dash: number[] | Mixed;
  cap: StrokeCap | Mixed;
  join: StrokeJoin | Mixed;
  miter: number | Mixed;
  start: StrokeMarker | Mixed | null;
  end: StrokeMarker | Mixed | null;
  /** "Width profile" when every layer takes one (lines and open paths), else null. */
  profile: StrokeWidthProfile | Mixed | null;
  sideWeights: boolean;
  markers: boolean;
};

const json = (value: unknown) => JSON.stringify(value);
const sameStroke = (a: StrokeData, b: StrokeData) => json(a) === json(b);

function selectStroke(state: EditorState, ids: readonly NodeId[]): StrokeData {
  const nodes = ids.map(id => state.doc.nodes[id]).filter((node): node is SceneNode => !!node);
  const pick = <T,>(get: (node: SceneNode) => T): T | Mixed => (commonValue(nodes, get) ?? MIXED) as T | Mixed;
  const markerNodes = nodes.filter(takesMarkers);
  return {
    ids: nodes.map(node => node.id),
    weight: pick(node => node.strokeWeight),
    align: pick(node => node.strokeAlign),
    sides: pick(node => node.individualStrokeWeights ?? null),
    dash: pick(node => node.dashPattern),
    cap: pick(node => node.strokeCap),
    join: pick(node => node.strokeJoin),
    miter: pick(node => node.strokeMiterLimit),
    start: markerNodes.length ? (commonValue(markerNodes, node => node.strokeStartMarker ?? 'NONE') ?? null) : null,
    end: markerNodes.length ? (commonValue(markerNodes, node => node.strokeEndMarker ?? 'NONE') ?? null) : null,
    profile: nodes.length && nodes.every(takesWidthProfile) ? pick(node => (widthPointsOf(node.variableWidthStrokeProperties) ? node.variableWidthStrokeProperties!.widthProfile : 'UNIFORM')) : null,
    sideWeights: nodes.length > 0 && nodes.every(node => takesSideWeights(node.type)),
    markers: markerNodes.length > 0,
  };
}

const ALIGN_OPTIONS: SelectEntry<StrokeAlign>[] = [{value: 'INSIDE', label: 'Inside'}, {value: 'CENTER', label: 'Center'}, {value: 'OUTSIDE', label: 'Outside'}];
export const MARKER_OPTIONS: SelectEntry<StrokeMarker>[] = [
  {value: 'NONE', label: 'None'}, {separator: true},
  {value: 'LINE_ARROW', label: 'Line arrow'}, {value: 'TRIANGLE_ARROW', label: 'Triangle arrow'}, {value: 'REVERSED_TRIANGLE', label: 'Reversed triangle'},
  {value: 'CIRCLE', label: 'Circle'}, {value: 'DIAMOND', label: 'Diamond'}, {separator: true},
  {value: 'ROUND', label: 'Round'}, {value: 'SQUARE', label: 'Square'},
];
const PROFILES: Exclude<StrokeWidthProfile, 'CUSTOM'>[] = ['UNIFORM', 'WEDGE', 'TAPER', 'QUARTER_TAPER', 'EYE', 'MIRRORED_TAPER'];
/** The presets with a picture of each (Figma's stroke presets), and "Custom" (width points from an imported Figma file, which
 *  no control here edits yet), shown only when a layer has it. */
const profileOptions = (current: StrokeWidthProfile | Mixed | null): SelectEntry<StrokeWidthProfile>[] => [
  ...PROFILES.map(profile => ({value: profile, label: WIDTH_PROFILE_LABELS[profile], icon: <ProfileGlyph profile={profile} />})),
  ...(current === 'CUSTOM' ? [{separator: true} as const, {value: 'CUSTOM' as const, label: WIDTH_PROFILE_LABELS.CUSTOM, description: 'From an imported file', disabled: true}] : []),
];
const CAP_OPTIONS: SelectEntry<StrokeCap>[] = [{value: 'NONE', label: 'None'}, {value: 'ROUND', label: 'Round'}, {value: 'SQUARE', label: 'Square'}];
const JOIN_OPTIONS: SelectEntry<StrokeJoin>[] = [{value: 'MITER', label: 'Miter'}, {value: 'BEVEL', label: 'Bevel'}, {value: 'ROUND', label: 'Round'}];

export const StrokeControls = memo(function StrokeControls({ids, committer}: {ids: readonly NodeId[]; committer: Committer}) {
  const store = useStoreApi();
  const selector = useCallback((state: EditorState) => selectStroke(state, ids), [ids]);
  const data = useDesignStore(selector, sameStroke, {slice: 'doc'});
  const [sidesMenu, setSidesMenu] = useState<Element | null>(null);
  const [more, setMore] = useState<{anchor: Rect; row: Element} | null>(null);

  const edit = (label: string, make: (node: SceneNode) => Partial<SceneNode> | null) => committer.set(label, tx => {
    for (const id of data.ids) {
      const node = tx.get(id);
      const patch = node && make(node);
      if (patch) userUpdate(tx, id, patch);
    }
  });
  const scrub = (label: string) => ({onScrubStart: () => committer.begin(label), onScrubEnd: (cancelled: boolean) => (cancelled ? committer.cancel() : committer.end())});

  const mode = data.sides === MIXED ? null : sideMode(data.sides);
  const singleSide = mode && mode !== 'ALL' && mode !== 'CUSTOM' ? SIDE_KEYS[mode] : null;
  const weightValue = singleSide && data.sides !== MIXED && data.sides ? data.sides[singleSide] : data.weight;
  const setWeight = (value: number) => edit('Stroke weight', node => {
    const sides = node.individualStrokeWeights;
    const current = sideMode(sides);
    if (sides && current !== 'ALL' && current !== 'CUSTOM') return {individualStrokeWeights: {...sides, [SIDE_KEYS[current]]: value}, strokeWeight: value};
    if (sides && current === 'CUSTOM') return {individualStrokeWeights: {top: value, right: value, bottom: value, left: value}, strokeWeight: value};
    return {strokeWeight: value};
  });

  return (
    <div className="dz-stroke">
      <div className={`dz-stroke-row ${data.sideWeights ? 'has-sides' : ''}`.trim()}>
        <Select<StrokeAlign> value={data.align === MIXED ? null : data.align} mixed={data.align === MIXED} options={ALIGN_OPTIONS} aria-label="Stroke position"
          className="dz-stroke-align" onChange={align => edit('Stroke position', () => ({strokeAlign: align}))} />
        <NumberField aria-label="Stroke weight" icon={<WeightGlyph />} value={weightValue} min={0} max={10000} precision={2} {...scrub('Stroke weight')}
          onChange={setWeight} className="dz-stroke-weight" />
        {data.sideWeights && (
          <IconButton label="Individual strokes" pressed={!!sidesMenu || (mode !== 'ALL' && mode !== null)} onClick={event => setSidesMenu(sidesMenu ? null : event.currentTarget)}>
            <IconStrokeSides />
          </IconButton>
        )}
        <IconButton label="More" pressed={!!more} onClick={event => {
          const row = event.currentTarget.closest('.dz-stroke-row') as HTMLElement;
          setMore(current => (current ? null : {anchor: besidePanel(row), row: event.currentTarget}));
        }}>
          <IconSliders />
        </IconButton>
      </div>
      {mode === 'CUSTOM' && data.sides !== MIXED && data.sides && (
        <div className="dz-stroke-sides">
          {(['top', 'right', 'bottom', 'left'] as const).map(side => (
            <NumberField key={side} label={{top: 'T', right: 'R', bottom: 'B', left: 'L'}[side]} aria-label={{top: 'Top', right: 'Right', bottom: 'Bottom', left: 'Left'}[side]}
              value={(data.sides as IndividualStrokeWeights)[side]} min={0} max={10000} precision={2} {...scrub('Stroke weight')}
              onChange={value => edit('Stroke weight', node => ({individualStrokeWeights: {...(node.individualStrokeWeights ?? {top: node.strokeWeight, right: node.strokeWeight, bottom: node.strokeWeight, left: node.strokeWeight}), [side]: value}}))} />
          ))}
        </div>
      )}
      {data.markers && (
        <div className="dz-stroke-markers">
          <Select<StrokeMarker> value={data.start === MIXED ? null : data.start} mixed={data.start === MIXED} options={MARKER_OPTIONS} aria-label="Start point"
            className="dz-marker" onChange={marker => edit('Start point', node => (takesMarkers(node) ? {strokeStartMarker: marker} : null))} />
          <IconButton label="Swap start and end" onClick={() => edit('Line ends', node => (takesMarkers(node) ? {strokeStartMarker: node.strokeEndMarker ?? 'NONE', strokeEndMarker: node.strokeStartMarker ?? 'NONE'} : null))}>
            <IconSwap />
          </IconButton>
          <Select<StrokeMarker> value={data.end === MIXED ? null : data.end} mixed={data.end === MIXED} options={MARKER_OPTIONS} aria-label="End point"
            className="dz-marker" onChange={marker => edit('End point', node => (takesMarkers(node) ? {strokeEndMarker: marker} : null))} />
        </div>
      )}
      {data.profile !== null && (
        <div className="dz-stroke-profile">
          <Select<StrokeWidthProfile> aria-label="Width profile" value={data.profile === MIXED ? null : data.profile} mixed={data.profile === MIXED}
            options={profileOptions(data.profile)} className="dz-stroke-profile-select"
            onChange={profile => {
              rememberBrushProfile({widthProfile: profile});
              edit('Width profile', node => (takesWidthProfile(node) ? {variableWidthStrokeProperties: profile === 'UNIFORM' ? undefined : {widthProfile: profile}} : null));
            }} />
          {data.profile !== 'UNIFORM' && ((data.dash !== MIXED && data.dash.length > 0) || (data.start !== null && data.start !== 'NONE') || (data.end !== null && data.end !== 'NONE')) && (
            <p className="dz-panel-note">With a width profile, dashes and line ends are not drawn.</p>
          )}
        </div>
      )}
      {sidesMenu && (
        <Menu anchor={{element: sidesMenu}} placement="bottom-end" ignore={sidesMenu} onClose={() => setSidesMenu(null)} aria-label="Individual strokes" items={
          (Object.keys(SIDE_LABELS) as SideMode[]).map(side => ({
            id: side, label: SIDE_LABELS[side], checked: mode === side, radio: true,
            onSelect: () => store.transact('Individual strokes', tx => {
              for (const id of data.ids) {
                const node = tx.get(id);
                if (!node || !takesSideWeights(node.type)) continue;
                const sides = node.individualStrokeWeights;
                const weight = sides ? Math.max(sides.top, sides.right, sides.bottom, sides.left) || node.strokeWeight : node.strokeWeight;
                userUpdate(tx, id, sidePatch(side, weight));
              }
            }),
          }))
        } />
      )}
      {more && (
        <FloatingPanel anchor={more.anchor} trigger={more.row} onClose={() => setMore(null)} aria-label="Stroke settings" className="dz-stroke-settings">
          <div className="dz-cp-header">
            <h2 className="dz-cp-title">Stroke settings</h2>
            <IconButton label="Close" tooltip={false} onClick={() => setMore(null)}><IconClose /></IconButton>
          </div>
          <div className="dz-effect-grid">
            <label className="dz-effect-label">Line</label>
            <Select<'SOLID' | 'DASH'> aria-label="Line style" value={data.dash === MIXED ? null : data.dash.length ? 'DASH' : 'SOLID'} mixed={data.dash === MIXED}
              options={[{value: 'SOLID', label: 'Solid'}, {value: 'DASH', label: 'Dashed'}]}
              onChange={kind => edit('Dash', node => ({dashPattern: kind === 'DASH' ? (node.dashPattern.length ? node.dashPattern : [Math.max(1, node.strokeWeight * 2), Math.max(1, node.strokeWeight * 2)]) : []}))} />
            {data.dash !== MIXED && data.dash.length > 0 && (
              <>
                <label className="dz-effect-label">Dash and gap</label>
                <div className="dz-effect-pair">
                  <NumberField aria-label="Dash length" value={data.dash[0] ?? 0} min={0} max={10000} precision={2} {...scrub('Dash')}
                    onChange={dash => edit('Dash', node => ({dashPattern: [dash, node.dashPattern[1] ?? node.dashPattern[0] ?? dash]}))} />
                  <NumberField aria-label="Gap" value={data.dash[1] ?? data.dash[0] ?? 0} min={0} max={10000} precision={2} {...scrub('Dash')}
                    onChange={gap => edit('Dash', node => ({dashPattern: [node.dashPattern[0] ?? gap, gap]}))} />
                </div>
              </>
            )}
            <label className="dz-effect-label">Cap</label>
            <Select<StrokeCap> aria-label="Cap" value={data.cap === MIXED ? null : data.cap} mixed={data.cap === MIXED} options={CAP_OPTIONS}
              onChange={cap => edit('Stroke cap', () => ({strokeCap: cap}))} />
            <label className="dz-effect-label">Join</label>
            <Select<StrokeJoin> value={data.join === MIXED ? null : data.join} mixed={data.join === MIXED} options={JOIN_OPTIONS} aria-label="Join"
              onChange={join => edit('Stroke join', () => ({strokeJoin: join}))} />
            {data.join === 'MITER' && (
              <>
                <label className="dz-effect-label">Miter limit</label>
                <NumberField aria-label="Miter limit" value={data.miter} min={1} max={100} precision={2} {...scrub('Miter limit')}
                  onChange={miter => edit('Miter limit', () => ({strokeMiterLimit: miter}))} />
              </>
            )}
          </div>
        </FloatingPanel>
      )}
    </div>
  );
});

/** A width profile drawn as the stroke it makes (the profile menu's pictures, in its 16 px icon slot). */
function ProfileGlyph({profile}: {profile: StrokeWidthProfile}) {
  const points = widthPointsOf({widthProfile: profile}) ?? [{position: 0, width: 1}, {position: 1, width: 1}];
  const steps = 20, top: string[] = [], bottom: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, x = 1 + t * 14, half = Math.max(0.35, widthAt(points, t) * 2.5);
    top.push(`${x.toFixed(2)} ${(8 - half).toFixed(2)}`);
    bottom.unshift(`${x.toFixed(2)} ${(8 + half).toFixed(2)}`);
  }
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d={`M${top.join('L')}L${bottom.join('L')}Z`} />
    </svg>
  );
}

/** Three bars of growing weight: the weight field's label. */
function WeightGlyph() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="3" y="3.5" width="10" height="1" rx="0.5" />
      <rect x="3" y="6.75" width="10" height="2" rx="1" />
      <rect x="3" y="10.75" width="10" height="3" rx="1.5" />
    </svg>
  );
}
