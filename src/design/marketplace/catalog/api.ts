// Catalog run's server call (docs/marketplaces.md §Catalog run): the photos a table links to, downloaded by the server and stored as
// pictures of the open file (server/marketplace/catalog/router.ts).

import {api} from '../../../api';
import type {CatalogFetchAnswer} from '../../../../shared/design/marketplace/catalog-api';

export const fetchCatalogImages = (fileId: string, urls: readonly string[], signal?: AbortSignal) =>
  api<CatalogFetchAnswer>('/marketplace/catalog/fetch-images', {method: 'POST', body: JSON.stringify({fileId, urls}), signal});
