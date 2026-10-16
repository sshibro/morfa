// "Marketplaces" on the server (docs/marketplaces.md): one router under /api/marketplace, behind the session, with a part per module,
// and the public picture links the marketplaces download published cards from.
import {Router} from 'express';
import {requireAuth} from '../auth';
import {createProofRouter} from './canvas/proof-router';
import {createCatalogRouter} from './catalog/router';
import {createGenerationRouter} from './generation/router';
import {createLoopRouter, createMarketplaceMediaRouter} from './loop/router';

export function createMarketplaceRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  // Card Canvas: Russian text proofing.
  router.use('/proof', createProofRouter());
  // Catalog Generation: brand kits, cut-outs, scenes, variants and cover sets; catalog runs from a spreadsheet.
  router.use('/generation', createGenerationRouter());
  router.use('/catalog', createCatalogRouter());
  // Performance Loop: seller connections, card links, publishing, numbers and A/B tests.
  router.use('/', createLoopRouter());
  return router;
}

export {createMarketplaceMediaRouter};
