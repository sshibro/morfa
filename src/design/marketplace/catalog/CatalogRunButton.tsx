import {lazy, Suspense} from 'react';
import type {CardMeta} from '../../../../shared/design/marketplace/meta';
import type {NodeId} from '../../../../shared/design/types';
import {registerEditorDialog, useEditorServices} from '../../editor/services';
import {Button} from '../../ui/Button';
import {IconList} from '../../ui/icons';

// Catalog run (docs/marketplaces.md §Catalog run): "Catalog from a table", a spreadsheet of SKUs mapped onto this card as a template.
// Rendered in "Generation". The dialog is one of the editor's own (registered here, loaded on first open), so it stays open while the
// run switches pages and selections under it.

export const CATALOG_DIALOG = 'marketplace-catalog';
const CatalogDialog = lazy(() => import('./CatalogDialog'));
registerEditorDialog(CATALOG_DIALOG, ({params, onClose}) => (
  <Suspense fallback={null}><CatalogDialog frameId={String(params.frameId ?? '')} onClose={onClose} /></Suspense>
));

export function CatalogRunButton({frameId}: {frameId: NodeId; meta: CardMeta}) {
  const services = useEditorServices();
  if (services.readOnly) return null;
  return (
    <div className="dz-mp-catalog-entry">
      <Button icon={<IconList />} className="dz-mp-catalog-open" onClick={() => services.openDialog(CATALOG_DIALOG, {frameId})}>Catalog from a table</Button>
      <p className="dz-mp-catalog-entry-hint">The card becomes a template: one copy for each row with an article number.</p>
    </div>
  );
}
