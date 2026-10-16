import express, {Router, type NextFunction, type Request, type RequestHandler, type Response} from 'express';
import {z} from 'zod';
import {requireAuth} from '../auth';
import {captureCustomerAuthority} from '../customer-authority';
import {asyncHandler} from '../http';
import {limitRequests} from '../rate-limit';
import {ONE_MINUTE_MS} from '../time-constants';
import {TEAM_TEMPLATE_CAPS} from '../../shared/design/team-templates';
import {isDesignFailure} from './errors';
import {designToolAvailable, designToolEnabled} from './flag';
import * as templates from './templates';

// Custom team templates (server/design/templates.ts): publishing and renaming a board's template on
// `/api/design-files/:id/template` (mounted by the files router, `mountTemplateRoutes`), and the "+" sheet's list and the insertion's
// content on `/api/design-templates`.

const UNAVAILABLE = {error: 'Design is unavailable.', code: 'design_unavailable'};
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const name = z.string().max(TEAM_TEMPLATE_CAPS.name * 4);
const description = z.string().max(TEAM_TEMPLATE_CAPS.description * 4);
const actorOf = (req: Request, res: Response) => captureCustomerAuthority(req, res);

/** `POST` and `PATCH /api/design-files/:id/template`, behind the files router's flag, session and limits. */
export function mountTemplateRoutes(router: Router, gates: {otherWrites: RequestHandler; json: (limit: number, tooLarge: string) => RequestHandler}): void {
  const body = gates.json(8 * 1024, 'The request is too large.');
  router.post(
    '/:id/template',
    gates.otherWrites,
    body,
    asyncHandler(async (req, res) => {
      const input = z.object({baseVersion: version, name, description: description.optional(), scope: z.enum(['team', 'organization'])}).strict().parse(req.body);
      res.status(201).json(await templates.publishTemplate(actorOf(req, res), String(req.params.id), input));
    }),
  );
  router.patch(
    '/:id/template',
    gates.otherWrites,
    body,
    asyncHandler(async (req, res) => {
      const input = z.object({name: name.optional(), description: description.optional()}).strict().parse(req.body);
      res.json(await templates.updateTemplate(actorOf(req, res), String(req.params.id), input));
    }),
  );
}

/** `/api/design-templates`: the templates a team may insert, and one version's content for a board. */
export function createDesignTemplatesRouter(): Router {
  const router = Router();
  router.use((_req, res, next) => (designToolEnabled() ? next() : res.status(404).json(UNAVAILABLE)));
  router.use(requireAuth);
  router.use((_req, res, next) => (designToolAvailable(res.locals.user) ? next() : res.status(404).json(UNAVAILABLE)));
  router.use(express.json({limit: 1024}));
  const accountKey = (_req: Request, res: Response) => String(res.locals.user.id);
  const reads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: accountKey});
  // An insertion may copy pictures into the board's place: as often as a library's import.
  const inserts = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: accountKey});
  const id = z.string().max(64);

  router.get(
    '/',
    reads,
    asyncHandler(async (req, res) => {
      res.json(await templates.listTemplates(actorOf(req, res), id.parse(req.query.teamId)));
    }),
  );
  router.get(
    '/:templateId/content',
    inserts,
    asyncHandler(async (req, res) => {
      const query = z
        .object({fileId: z.string().min(1).max(200), version: z.string().regex(/^\d{1,9}$/).transform(Number).optional()})
        .parse(req.query);
      res.json(await templates.templateContent(actorOf(req, res), String(req.params.templateId), query));
    }),
  );
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError) {
      res.status(400).json({error: 'Check the request data.', code: 'invalid_request', requestId: res.locals.requestId});
      return;
    }
    if (!isDesignFailure(error) || error.status >= 500) return next(error);
    res.status(error.status).json({...error.extra, error: error.message, code: error.code, requestId: res.locals.requestId});
  });
  return router;
}
