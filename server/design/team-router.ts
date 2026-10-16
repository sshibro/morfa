import express, {Router, type NextFunction, type Request, type Response} from 'express';
import {z} from 'zod';
import {requireAuth} from '../auth';
import {captureCustomerAuthority} from '../customer-authority';
import {asyncHandler} from '../http';
import {limitRequests} from '../rate-limit';
import {ONE_MINUTE_MS} from '../time-constants';
import {DESIGN_INVITE_ROLES, DESIGN_TEAM_LIMITS, DESIGN_TEAM_ROLES} from '../../shared/design/teams';
import {isDesignFailure} from './errors';
import {designToolAvailable, designToolEnabled} from './flag';
import * as invites from './invites';
import * as teams from './teams';
import {revalidateLive} from './live/hub';

// `/api/design-teams` (docs/design-tool.md §Teams; the routes are listed in shared/design/teams.ts). Mounted after the app's Origin guard;
// answers 404 while "Design" is off for the account, then needs a session. Invite tokens travel in the path of two routes; the request
// telemetry masks them (server/admin/sanitize.ts `maskDesignInvite`), and nothing here logs a request.

const UNAVAILABLE = {error: 'Design is unavailable.', code: 'design_unavailable'};
const name = z.string().max(1_000);
const id = z.string().max(64);

export function createDesignTeamsRouter(): Router {
  const router = Router();
  router.use((_req, res, next) => (designToolEnabled() ? next() : res.status(404).json(UNAVAILABLE)));
  router.use(requireAuth);
  router.use((_req, res, next) => (designToolAvailable(res.locals.user) ? next() : res.status(404).json(UNAVAILABLE)));
  router.use(express.json({limit: 16 * 1024}));
  // A change of members, roles or the team itself: the open files of the team check their streams' access at once (a
  // removed member stops receiving changes, a demoted editor turns read-only), here and in the other processes.
  router.use((req, res, next) => {
    const teamId = /^\/([0-9a-f-]{36})(?:\/|$)/.exec(req.path)?.[1];
    // The person the change is about, who may no longer be a member once it is done (a removal, someone leaving): the sockets of
    // the team's files a collab node holds are told about them too (server/design/collab/acl-push.ts).
    const member = /^\/[0-9a-f-]{36}\/members\/([^/]+)$/.exec(req.path)?.[1];
    const decoded = (() => {
      try {
        return member ? decodeURIComponent(member) : null;
      } catch {
        return null;
      }
    })();
    const named = decoded ? [decoded] : /^\/[0-9a-f-]{36}\/leave$/.test(req.path) ? [String(res.locals.user.id)] : [];
    if (teamId && req.method !== 'GET') res.once('finish', () => res.statusCode < 400 && revalidateLive({teamId, users: named}));
    next();
  });

  const accountKey = (_req: Request, res: Response) => String(res.locals.user.id);
  const reads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: accountKey});
  const writes = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: accountKey});
  // An invite token is a bearer secret: few guesses per account (and the accept route, which changes membership, even fewer).
  const inviteReads = limitRequests({windowMs: 10 * ONE_MINUTE_MS, limit: 30, keyGenerator: accountKey});
  const inviteAccepts = limitRequests({windowMs: 10 * ONE_MINUTE_MS, limit: 10, keyGenerator: accountKey});
  const actorOf = (req: Request, res: Response) => captureCustomerAuthority(req, res);
  const team = (req: Request) => String(req.params.teamId);

  router.get(
    '/',
    reads,
    asyncHandler(async (req, res) => {
      res.json(await teams.listDesignTeams(actorOf(req, res)));
    }),
  );
  router.post(
    '/',
    writes,
    asyncHandler(async (req, res) => {
      const input = z.object({name}).strict().parse(req.body ?? {});
      res.status(201).json({team: await teams.createDesignTeam(actorOf(req, res), input.name)});
    }),
  );

  // Invites by token first: `invites` is not a team id.
  router.get(
    '/invites/:token',
    inviteReads,
    asyncHandler(async (req, res) => {
      res.json(await invites.previewTeamInvite(actorOf(req, res), String(req.params.token)));
    }),
  );
  router.post(
    '/invites/:token/accept',
    inviteAccepts,
    asyncHandler(async (req, res) => {
      res.json(await invites.acceptTeamInvite(actorOf(req, res), String(req.params.token)));
    }),
  );

  router.patch(
    '/:teamId',
    writes,
    asyncHandler(async (req, res) => {
      const input = z.object({name}).strict().parse(req.body ?? {});
      res.json({team: await teams.renameDesignTeam(actorOf(req, res), team(req), input.name)});
    }),
  );
  router.delete(
    '/:teamId',
    writes,
    asyncHandler(async (req, res) => {
      await teams.deleteDesignTeam(actorOf(req, res), team(req));
      res.json({ok: true});
    }),
  );
  router.get(
    '/:teamId/members',
    reads,
    asyncHandler(async (req, res) => {
      res.json(await teams.listTeamMembers(actorOf(req, res), team(req)));
    }),
  );
  router.patch(
    '/:teamId/members/:userId',
    writes,
    asyncHandler(async (req, res) => {
      const input = z.object({role: z.enum(DESIGN_TEAM_ROLES as [string, ...string[]])}).strict().parse(req.body ?? {});
      res.json(
        await teams.changeTeamMemberRole(actorOf(req, res), team(req), String(req.params.userId), input.role as never),
      );
    }),
  );
  router.delete(
    '/:teamId/members/:userId',
    writes,
    asyncHandler(async (req, res) => {
      res.json(await teams.removeTeamMember(actorOf(req, res), team(req), String(req.params.userId)));
    }),
  );
  router.post(
    '/:teamId/leave',
    writes,
    asyncHandler(async (req, res) => {
      await teams.leaveDesignTeam(actorOf(req, res), team(req));
      res.json({ok: true});
    }),
  );
  router.get(
    '/:teamId/invites',
    reads,
    asyncHandler(async (req, res) => {
      res.json({invites: await invites.listTeamInvites(actorOf(req, res), team(req))});
    }),
  );
  router.post(
    '/:teamId/invites',
    writes,
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          role: z.enum(DESIGN_INVITE_ROLES as [string, ...string[]]),
          days: z.number().int().min(1).max(DESIGN_TEAM_LIMITS.inviteDays),
          maxUses: z.number().int().min(1).max(DESIGN_TEAM_LIMITS.inviteUses),
        })
        .strict()
        .parse(req.body ?? {});
      res.status(201).json(await invites.createTeamInvite(actorOf(req, res), team(req), input as never));
    }),
  );
  router.delete(
    '/:teamId/invites/:inviteId',
    writes,
    asyncHandler(async (req, res) => {
      res.json({invites: await invites.revokeTeamInvite(actorOf(req, res), team(req), String(req.params.inviteId))});
    }),
  );
  router.post(
    '/:teamId/projects',
    writes,
    asyncHandler(async (req, res) => {
      const input = z.object({name}).strict().parse(req.body ?? {});
      res.status(201).json({project: await teams.createDesignProject(actorOf(req, res), team(req), input.name)});
    }),
  );
  router.patch(
    '/:teamId/projects/:projectId',
    writes,
    asyncHandler(async (req, res) => {
      const input = z.object({name}).strict().parse(req.body ?? {});
      res.json({
        project: await teams.renameDesignProject(actorOf(req, res), team(req), id.parse(req.params.projectId), input.name),
      });
    }),
  );
  router.delete(
    '/:teamId/projects/:projectId',
    writes,
    asyncHandler(async (req, res) => {
      await teams.deleteDesignProject(actorOf(req, res), team(req), id.parse(req.params.projectId));
      res.json({ok: true});
    }),
  );

  router.use((_req, res) => res.status(404).json({error: 'Route not found.', code: 'not_found'}));
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError || (error as {type?: string})?.type === 'entity.parse.failed') {
      res.status(400).json({error: 'Check the request data.', code: 'invalid_request', requestId: res.locals.requestId});
      return;
    }
    if (!isDesignFailure(error) || error.status >= 500) return next(error);
    res.status(error.status).json({...error.extra, error: error.message, code: error.code, requestId: res.locals.requestId});
  });
  return router;
}
