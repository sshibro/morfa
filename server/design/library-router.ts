import type {Request, RequestHandler, Response, Router} from 'express';
import {z} from 'zod';
import {captureCustomerAuthority} from '../customer-authority';
import {asyncHandler} from '../http';
import {LIBRARY_CAPS} from '../../shared/design/libraries';
import {DESIGN_FIELD_LIMITS} from '../../shared/design/document-limits';
import * as libraries from './libraries';

// Shared libraries under `/api/design-files/:id` (docs/design-tool.md §Teams, "Shared libraries"): the file's own library
// (`/library`) and the libraries of its place it lists, enables and uses (`/libraries`). Mounted by the files router before its
// catch-all, behind the same flag, session and rollout, with its limits and gates.

export type LibraryRouteGates = {
  /** Small writes (120 a minute per account). */
  otherWrites: RequestHandler;
  /** Requests that parse or build a whole document (60 per 10 minutes per account). */
  wholeDocuments: RequestHandler;
  /** Two document bodies at a time per account, taken before the body is read; sixteen on the server, taken after. */
  heavy: {account: RequestHandler; server: RequestHandler};
  /** Reads that hold a document-sized answer. */
  reading: RequestHandler;
  /** A JSON body reader with its cap. */
  json: (limit: number, tooLarge: string) => RequestHandler;
};

const keys = z.array(z.string().min(1).max(DESIGN_FIELD_LIMITS.id)).max(LIBRARY_CAPS.assets);
/** A selection of up to 3 × 5 000 ids of up to 512 characters is far below this; anything bigger is not a selection. */
const SELECTION_BODY_BYTES = 2 * 1024 * 1024;
const version = z.number().int().min(1).max(1_000_000_000);

const actorOf = (req: Request, res: Response) => captureCustomerAuthority(req, res);
const idOf = (req: Request) => String(req.params.id);
const libraryOf = (req: Request) => String(req.params.libraryId);

export function mountLibraryRoutes(router: Router, gates: LibraryRouteGates): void {
  const selectionBody = gates.json(SELECTION_BODY_BYTES, 'The request is too large.');
  const smallBody = gates.json(64 * 1024, 'The request is too large.');

  router.get(
    '/:id/library',
    asyncHandler(async (req, res) => {
      res.json(await libraries.readOwnLibrary(actorOf(req, res), idOf(req)));
    }),
  );
  // "Publish library": builds the snapshot from the stored document (a whole document is read and checked).
  router.post(
    '/:id/library',
    gates.otherWrites,
    gates.wholeDocuments,
    gates.heavy.account,
    selectionBody,
    gates.heavy.server,
    asyncHandler(async (req, res) => {
      const input = z
        .object({baseVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), components: keys, styles: keys, variableCollections: keys, description: z.string().max(4_000).optional()})
        .strict()
        .parse(req.body);
      res.status(201).json(await libraries.publishLibrary(actorOf(req, res), idOf(req), input));
    }),
  );
  router.delete(
    '/:id/library',
    gates.otherWrites,
    asyncHandler(async (req, res) => {
      res.json(await libraries.unpublishLibrary(actorOf(req, res), idOf(req)));
    }),
  );
  router.get(
    '/:id/libraries',
    asyncHandler(async (req, res) => {
      res.json(await libraries.listFileLibraries(actorOf(req, res), idOf(req)));
    }),
  );
  router.put(
    '/:id/libraries/:libraryId',
    gates.otherWrites,
    asyncHandler(async (req, res) => {
      res.json({library: await libraries.enableLibrary(actorOf(req, res), idOf(req), libraryOf(req))});
    }),
  );
  router.patch(
    '/:id/libraries/:libraryId',
    gates.otherWrites,
    smallBody,
    asyncHandler(async (req, res) => {
      const input = z.object({seenVersion: version}).strict().parse(req.body);
      await libraries.markLibrarySeen(actorOf(req, res), idOf(req), libraryOf(req), input.seenVersion);
      res.json({ok: true});
    }),
  );
  router.delete(
    '/:id/libraries/:libraryId',
    gates.otherWrites,
    asyncHandler(async (req, res) => {
      await libraries.disableLibrary(actorOf(req, res), idOf(req), libraryOf(req));
      res.json({ok: true});
    }),
  );
  router.get(
    '/:id/libraries/:libraryId/versions/:version',
    gates.reading,
    asyncHandler(async (req, res) => {
      const number = version.parse(Number(req.params.version));
      const text = await libraries.readLibraryVersion(actorOf(req, res), idOf(req), libraryOf(req), number);
      // Stored JSON written by this server after validation: sent as it is.
      res.type('application/json').send('{"snapshot":' + text + '}');
    }),
  );
  // Using or updating assets: the version's snapshot is read and parsed, pictures of another place are copied.
  router.post(
    '/:id/libraries/:libraryId/import',
    gates.otherWrites,
    gates.heavy.account,
    selectionBody,
    gates.heavy.server,
    asyncHandler(async (req, res) => {
      const input = z
        .object({version, components: keys.optional(), styles: keys.optional(), variableCollections: keys.optional()})
        .strict()
        .parse(req.body);
      res.json(await libraries.importLibraryAssets(actorOf(req, res), idOf(req), libraryOf(req), input));
    }),
  );
}
