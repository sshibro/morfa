import {memo, useState} from 'react';
import {MARKETPLACES, marketplaceSpec, type Marketplace} from '../../../../shared/design/marketplace/specs';
import type {NodeId} from '../../../../shared/design/types';
import {useEditorServices} from '../../editor/services';
import {useDesignStore} from '../../engine/useDesignStore';
import {Button} from '../../ui/Button';
import {PanelSection} from '../../ui/PanelSection';
import {SegmentedControl} from '../../ui/Tabs';
import {fitCardFrame, hasMarketplaceAspect, makeCard} from './card-ops';

// Card Canvas: "Marketplace card" for a plain top-level frame (docs/marketplaces.md §Frames and the new card): pick
// WB, Ozon or Yandex Market and "Make card"; a frame of other proportions is offered "Fit to 900 × 1200" first,
// which scales its content in and grows it to the marketplace's frame. The marketplace picked last is remembered in this browser.

const KEY = 'morfa-mp-marketplace';
const remembered = (): Marketplace => {
  try {
    const value = localStorage.getItem(KEY);
    return value === 'wb' || value === 'ozon' || value === 'ym' ? value : 'wb';
  } catch {
    return 'wb';
  }
};
const remember = (marketplace: Marketplace) => {
  try {
    localStorage.setItem(KEY, marketplace);
  } catch {
    // Storage blocked: the choice lasts for this panel only.
  }
};

const OPTIONS = MARKETPLACES.map(id => ({value: id, label: marketplaceSpec(id).short}));

export const MakeCardControls = memo(function MakeCardControls({frameId}: {frameId: NodeId}) {
  const services = useEditorServices();
  const size = useDesignStore(state => {
    const node = state.doc.nodes[frameId];
    return node ? `${Math.round(node.width)}×${Math.round(node.height)}` : null;
  }, Object.is, {slice: 'doc'});
  const [marketplace, setMarketplace] = useState<Marketplace>(remembered);
  if (!size || services.readOnly) return null;
  const [width, height] = size.split('×').map(Number);
  const spec = marketplaceSpec(marketplace);
  const fits = hasMarketplaceAspect({width, height}, marketplace);
  const choose = (value: Marketplace) => {
    setMarketplace(value);
    remember(value);
  };
  return (
    <PanelSection title="Marketplace card" className="dz-mp-section">
      <div className="dz-mp-make">
        <SegmentedControl aria-label="Marketplace" options={OPTIONS} value={marketplace} onChange={choose} fill />
        {!fits && (
          <p className="dz-mp-note">
            {width} × {height} — not {spec.aspect.width}:{spec.aspect.height}. {spec.aspect.strict ? `${spec.name} will not accept such a picture.` : `${spec.name} will crop the picture or add margins.`}
          </p>
        )}
        <div className="dz-mp-make-actions">
          {!fits && (
            <Button variant="secondary" onClick={() => fitCardFrame(services.store, frameId, marketplace)}>
              Fit to {spec.frame.width} × {spec.frame.height}
            </Button>
          )}
          <Button variant={fits ? 'primary' : 'secondary'} onClick={() => makeCard(services.store, frameId, marketplace)}>Make card</Button>
        </div>
      </div>
    </PanelSection>
  );
});
