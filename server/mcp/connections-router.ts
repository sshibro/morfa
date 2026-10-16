// "Connections" (docs/mcp-server.md §Connections): the assistants an account let read its files, and "Disconnect". Behind the session,
// under /api, so the app's own cross-site check covers the DELETE.
import {Router} from 'express';
import {requireAuth} from '../auth';
import {asyncHandler} from '../http';
import {mcpAvailable, mcpResourceUrl} from './config';
import {listConnections, revokeConnection} from './oauth/store';

export function createMcpConnectionsRouter(): Router {
  const router = Router();
  router.use(requireAuth);
  // Off, or not open to this account: the route is not there, as any unknown /api path.
  router.use((_req, res, next) =>
    mcpAvailable(res.locals.user) ? next() : void res.status(404).json({error: 'Route not found.'}),
  );
  router.get(
    '/connections',
    asyncHandler(async (_req, res) => {
      res.json({url: mcpResourceUrl(), connections: await listConnections(res.locals.user.id)});
    }),
  );
  router.delete(
    '/connections/:id',
    asyncHandler(async (req, res) => {
      if (!(await revokeConnection(res.locals.user.id, String(req.params.id))))
        return void res.status(404).json({error: 'Connection not found.'});
      res.json({ok: true});
    }),
  );
  return router;
}
