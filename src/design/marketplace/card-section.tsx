// "Card" in the "Design" tab (docs/marketplaces.md), loaded the first time a frame is selected (./sections.tsx): a plain
// top-level frame offers to become a card; a card shows its four tabs, each owned by one module: "Check" and the layer roles (Card
// Canvas), "Export" (Card Canvas), "Generation" (Catalog Generation) and "Sales" (Performance Loop).
import {memo, useState} from 'react';
import {cardMeta, cardOf, type CardMeta} from '../../../shared/design/marketplace/meta';
import {marketplaceSpec} from '../../../shared/design/marketplace/specs';
import type {NodeId} from '../../../shared/design/types';
import {useDesignStore} from '../engine/useDesignStore';
import type {SectionProps} from '../panels/design/sections';
import {PanelSection} from '../ui/PanelSection';
import {TabPanel, Tabs} from '../ui/Tabs';
import {LayerRoleControls} from './canvas/LayerRole';
import {LintTab} from './canvas/LintTab';
import {MakeCardControls} from './canvas/MakeCard';
import {ExportTab} from './export/ExportTab';
import {GenerateTab} from './generate/GenerateTab';
import {SalesTab} from './loop/SalesTab';
import {isTopLevelFrame} from './sections';
import './marketplace.css';

export type CardTab = 'lint' | 'export' | 'generate' | 'sales';
const TABS: readonly {id: CardTab; label: string}[] = [
  {id: 'lint', label: 'Check'},
  {id: 'export', label: 'Export'},
  {id: 'generate', label: 'Generation'},
  {id: 'sales', label: 'Sales'},
];

const CardPanel = memo(function CardPanel({frameId, meta}: {frameId: NodeId; meta: CardMeta}) {
  const [tab, setTab] = useState<CardTab>('lint');
  const spec = marketplaceSpec(meta.marketplace);
  return (
    <PanelSection title={`${spec.short} card`} className="dz-mp-section">
      <Tabs tabs={TABS} value={tab} onChange={setTab} idBase="dz-mp" aria-label="Card" className="dz-mp-tabs" />
      <TabPanel idBase="dz-mp" id={tab} className="dz-mp-panel">
        {tab === 'lint' && <LintTab frameId={frameId} meta={meta} />}
        {tab === 'export' && <ExportTab frameId={frameId} meta={meta} />}
        {tab === 'generate' && <GenerateTab frameId={frameId} meta={meta} />}
        {tab === 'sales' && <SalesTab frameId={frameId} meta={meta} />}
      </TabPanel>
    </PanelSection>
  );
});

export const CardSection = memo(function CardSection({ids}: Pick<SectionProps, 'ids'>) {
  const id = ids[0];
  const own = useDesignStore(state => state.doc.nodes[id]?.pluginData, Object.is, {slice: 'doc'});
  const card = useDesignStore(state => cardOf(state.doc, id), (a, b) => a?.id === b?.id && JSON.stringify(a?.meta) === JSON.stringify(b?.meta), {slice: 'doc'});
  const topLevel = useDesignStore(state => isTopLevelFrame(state.doc, id), Object.is, {slice: 'doc'});
  const meta = cardMeta({pluginData: own});
  if (meta) return <CardPanel frameId={id} meta={meta} />;
  if (card) return <LayerRoleControls nodeId={id} card={card} />;
  if (topLevel) return <MakeCardControls frameId={id} />;
  return null;
});
