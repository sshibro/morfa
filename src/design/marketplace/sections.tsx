import {lazy, memo, Suspense} from 'react';
import {cardOf} from '../../../shared/design/marketplace/meta';
import type {DesignDocument, NodeId} from '../../../shared/design/types';
import type {DesignSection, SectionProps} from '../panels/design/sections';

// "Card" in the "Design" tab (docs/marketplaces.md): shown for one top-level frame or one layer inside a card. A plain frame
// offers to become a card; a card shows its four tabs, each owned by one module (./card-section.tsx). Only the test of
// which selection gets the section is here: the section itself, its tabs and their styles load the first time it shows, so the
// editor's first load does not carry them.

/** A frame standing directly on a page (or in a section): what can be a card. */
export function isTopLevelFrame(doc: DesignDocument, id: NodeId): boolean {
  const node = doc.nodes[id];
  if (!node || node.type !== 'FRAME') return false;
  const parent = node.parentId ? doc.nodes[node.parentId] : undefined;
  return parent?.type === 'PAGE' || parent?.type === 'SECTION';
}

const CardSectionBody = lazy(() => import('./card-section').then(module => ({default: module.CardSection})));
// It reads the store itself: a drag that moves the selected frame (new `nodes`, same `ids`) re-renders nothing here.
const CardSection = memo(
  function CardSection({ids}: SectionProps) {
    return (
      <Suspense fallback={null}>
        <CardSectionBody ids={ids} />
      </Suspense>
    );
  },
  (before, after) => before.ids === after.ids,
);

export const marketplaceSections: DesignSection[] = [
  {
    id: 'marketplace-card',
    order: 15,
    applies: ({doc, ids}) => ids.length === 1 && (isTopLevelFrame(doc, ids[0]) || cardOf(doc, ids[0]) !== null),
    Component: CardSection,
  },
];
