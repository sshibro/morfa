// Catalog Generation: catalog runs, a spreadsheet of SKUs mapped onto a template (docs/marketplaces.md §Catalog run). The cards are made
// in the editor; the server's part is POST /fetch-images: the photos a table links to, downloaded from public https addresses
// (./fetch-image.ts) and stored as pictures of the file the caller may edit, as an upload would store them (`storeDesignImage`). Ten
// minutes allow 40 requests of up to 50 addresses per account, one request at a time.
import {Router, type Request, type RequestHandler, type Response} from 'express';
import {z} from 'zod';
import {asyncHandler} from '../../http';
import {limitRequests} from '../../rate-limit';
import {ONE_MINUTE_MS} from '../../time-constants';
import {slotGate} from '../../upload-storage';
import type {CustomerAuthority} from '../../customer-authority';
import type {DesignImageUploaded} from '../../../shared/design/api';
import {CATALOG_FETCH_LIMITS, type CatalogFetched} from '../../../shared/design/marketplace/catalog-api';
import {fetchPublicPhoto, PhotoFetchError, type PhotoFetcher} from './fetch-image';

export type CatalogRouterDeps = {
  actorOf: (req: Request, res: Response) => CustomerAuthority | Promise<CustomerAuthority>;
  /** Refuses (404, 403) unless the caller may edit the file. */
  checkFile: (actor: CustomerAuthority, fileId: string) => Promise<void>;
  fetchPhoto: PhotoFetcher;
  /** Stores a picture in the file: `files.storeDesignImage`. */
  storeImage: (actor: CustomerAuthority, fileId: string, data: Buffer, name: string) => Promise<DesignImageUploaded>;
};

// The defaults reach the database only when a request runs, so the router loads in tests without one.
const DEFAULTS: CatalogRouterDeps = {
  actorOf: async (req, res) => (await import('../../customer-authority')).captureCustomerAuthority(req, res),
  checkFile: async (actor, fileId) => {
    const {designRead, fileAccess} = await import('../../design/file-access');
    await designRead(actor, async tx => void (await fileAccess(tx, actor.ownerId, fileId, 'edit')));
  },
  fetchPhoto: fetchPublicPhoto,
  storeImage: async (actor, fileId, data, name) =>
    (await import('../../design/files')).storeDesignImage(actor, fileId, data, name),
};

const request = z
  .object({
    fileId: z.string().min(1).max(64),
    urls: z.array(z.string().min(1).max(CATALOG_FETCH_LIMITS.url)).min(1).max(CATALOG_FETCH_LIMITS.urls),
  })
  .strict();

type Failure = Error & {status: number; code?: string};
const isFailure = (error: unknown): error is Failure =>
  error instanceof Error && typeof (error as Failure).status === 'number';
/** The file is gone or no longer the caller's to edit: the whole request stops. */
const isFatal = (error: unknown) => isFailure(error) && [401, 403, 404, 409].includes(error.status);
/** The room for pictures is full: the remaining addresses are not even downloaded. */
const isStorageFull = (error: unknown) => isFailure(error) && error.code === 'design_storage_limit';

const accountKey = (_req: Request, res: Response) => String(res.locals.user.id);

function oneAtATime(): RequestHandler {
  const take = slotGate(1, 6);
  return (_req, res, next) => {
    const release = take(accountKey(_req, res));
    if (!release) {
      res.status(429).json({error: 'Photos from the previous batch are still uploading.', code: 'rate_limited', retryable: true});
      return;
    }
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

export function createCatalogRouter(overrides: Partial<CatalogRouterDeps> = {}): Router {
  const deps: CatalogRouterDeps = {...DEFAULTS, ...overrides};
  const router = Router();
  const fetches = limitRequests({
    windowMs: 10 * ONE_MINUTE_MS,
    limit: CATALOG_FETCH_LIMITS.requestsPer10Minutes,
    keyGenerator: accountKey,
    message: {error: 'Too many photos in a row. Wait a few minutes.', retryable: true},
  });

  router.post(
    '/fetch-images',
    fetches,
    oneAtATime(),
    asyncHandler(async (req, res) => {
      const body = request.safeParse(req.body);
      if (!body.success) {
        res.status(400).json({error: 'Check the request data.', code: 'invalid_request'});
        return;
      }
      const {fileId, urls} = body.data;
      // The client went away: downloads that have not started are skipped, running ones stop.
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableFinished) controller.abort();
      });
      try {
        const actor = await deps.actorOf(req, res);
        await deps.checkFile(actor, fileId);
        const unique = [...new Set(urls)];
        const outcome = new Map<string, CatalogFetched>();
        let stopped: CatalogFetched | null = null;
        let fatal: unknown = null;
        let next = 0;
        const worker = async () => {
          while (next < unique.length && !fatal && !controller.signal.aborted) {
            const url = unique[next++];
            if (stopped) {
              outcome.set(url, {...stopped, url});
              continue;
            }
            try {
              const photo = await deps.fetchPhoto(url, controller.signal);
              const stored = await deps.storeImage(actor, fileId, photo.data, photo.name);
              outcome.set(url, {url, ref: stored.ref, asset: stored.asset});
            } catch (error) {
              if (isFatal(error)) {
                fatal = error;
                return;
              }
              const answer: CatalogFetched =
                error instanceof PhotoFetchError || isFailure(error)
                  ? {url, error: error.message, code: (error as {code?: string}).code}
                  : {url, error: 'Could not save the photo.', code: 'failed'};
              if (isStorageFull(error)) stopped = answer;
              outcome.set(url, answer);
            }
          }
        };
        await Promise.all(Array.from({length: Math.min(CATALOG_FETCH_LIMITS.parallel, unique.length)}, worker));
        if (fatal) throw fatal;
        if (controller.signal.aborted) return;
        res.json({
          results: urls.map(url => outcome.get(url) ?? {url, error: 'Photo not uploaded.', code: 'skipped'}),
        });
      } catch (error) {
        if (!isFailure(error) || res.headersSent) throw error;
        res.status(error.status).json({error: error.message, code: error.code});
      }
    }),
  );
  return router;
}
