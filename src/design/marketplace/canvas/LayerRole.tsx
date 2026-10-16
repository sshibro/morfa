import {memo, useMemo} from 'react';
import {LAYER_ROLE_LABELS, LAYER_ROLES, layerRole, layerShownOn, type CardMeta, type LayerRole} from '../../../../shared/design/marketplace/meta';
import {MARKETPLACES, marketplaceSpec, type Marketplace} from '../../../../shared/design/marketplace/specs';
import type {NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import {useDesignStore} from '../../engine/useDesignStore';
import {Button} from '../../ui/Button';
import {IconBack, IconLock} from '../../ui/icons';
import {PanelSection} from '../../ui/PanelSection';
import {Select, type SelectEntry} from '../../ui/Select';
import {setLayerRole, setLayerShownOn} from './card-ops';
import {FindingRow} from './LintTab';
import {useCardLint} from './use-card-lint';

// Card Canvas: a layer inside a card (docs/marketplaces.md §Layer roles): its role on the card (product, logo…), which Spec Lint
// reads and generation keeps to, and the marketplaces whose pictures show it. Under them, the card's findings about this very
// layer (from the last check of the card, never measured here) and the way back to the card's "Check".

type RoleValue = LayerRole | 'none';
const ROLE_OPTIONS: readonly SelectEntry<RoleValue>[] = [
  {value: 'none', label: 'None'},
  {separator: true},
  ...LAYER_ROLES.map(role => ({value: role, label: LAYER_ROLE_LABELS[role]})),
];

type View = {role: LayerRole | null; shown: Marketplace[]; locked: boolean} | null;
const sameView = (a: View, b: View) => a === b || (!!a && !!b && a.role === b.role && a.locked === b.locked && a.shown.join() === b.shown.join());

export const LayerRoleControls = memo(function LayerRoleControls({nodeId, card}: {nodeId: NodeId; card: {id: NodeId; meta: CardMeta}}) {
  const services = useEditorServices();
  const view = useDesignStore((state): View => {
    const node = state.doc.nodes[nodeId];
    return node ? {role: layerRole(node), shown: layerShownOn(node) ?? [...MARKETPLACES], locked: node.locked} : null;
  }, sameView, {slice: 'doc'});
  const {reports} = useCardLint(card.id, card.meta, {measure: false, all: false});
  const report = reports[card.meta.marketplace];
  const findings = useMemo(() => (report?.checks ?? []).flatMap(check => check.findings.filter(finding => finding.nodeIds.includes(nodeId))), [report, nodeId]);
  if (!view) return null;
  const spec = marketplaceSpec(card.meta.marketplace);
  const readOnly = !!services.readOnly;
  const toggle = (id: Marketplace) => {
    const next = view.shown.includes(id) ? view.shown.filter(entry => entry !== id) : [...view.shown, id];
    setLayerShownOn(services.store, nodeId, next);
  };
  const show = (ids: readonly NodeId[]) => {
    const doc = services.store.getState().doc;
    const present = ids.filter(id => doc.nodes[id]);
    if (!present.length) return;
    services.store.setSelection(present);
    services.revealNodes(present);
  };
  return (
    <PanelSection title={`Layer on the ${spec.short} card`} className="dz-mp-section">
      <div className="dz-mp-layer">
        <div className="dz-mp-field">
          <span className="dz-mp-caption">Role on the card</span>
          <Select aria-label="Role on the card" value={view.role ?? 'none'} options={ROLE_OPTIONS} disabled={readOnly}
            onChange={value => setLayerRole(services.store, nodeId, value === 'none' ? null : value)} />
        </div>
        {view.role === 'product' && view.locked && (
          <p className="dz-mp-note">
            <IconLock size={14} aria-hidden="true" />
            <span>The layer is locked so it is not moved by accident.</span>
          </p>
        )}
        <div className="dz-mp-field">
          <span className="dz-mp-caption" id={`dz-mp-shown-${nodeId}`}>Show on</span>
          <div className="dz-mp-shown" role="group" aria-labelledby={`dz-mp-shown-${nodeId}`}>
            {MARKETPLACES.map(id => (
              <button key={id} type="button" className="dz-mp-toggle" aria-pressed={view.shown.includes(id)} disabled={readOnly}
                title={marketplaceSpec(id).name} onClick={() => toggle(id)}>{marketplaceSpec(id).short}</button>
            ))}
          </div>
        </div>
        {findings.length > 0 && (
          <ul className="dz-mp-findings is-layer" aria-label="Layer remarks">
            {findings.map((finding, index) => <FindingRow key={index} finding={finding} onShow={show} />)}
          </ul>
        )}
        <Button variant="ghost" icon={<IconBack />} className="dz-mp-back" onClick={() => show([card.id])}>Card check</Button>
      </div>
    </PanelSection>
  );
});
