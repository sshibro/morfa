import {timingSafeEqual} from 'node:crypto';
import {Router, type Request} from 'express';
import {asyncHandler} from '../../http';
import {collabSecret} from './config';
import {rolesIn} from './acl-push';
import {leaseTaken} from './session';
import {scheduleServerThumbnail, serverThumbnailsEnabled} from '../thumbnails';

// api's routes for collab (crates/collab/src/acl.rs `HttpAcl`): every socket is re-validated through here every 20 s.
//
//   GET /internal/design-files/:id/access?user=<account id>   → {"role": "owner"|"admin"|"editor"|"developer"|"viewer"|null}
//   GET /internal/design-files/:id/collab-taken               → 204: a collab node's /session took the file's lease (lane A7,
//                                                                crates/collab/src/session.rs); what session.ts does here when api
//                                                                takes it: the stale copy dropped, open SSE streams told to move
//   POST /internal/design-files/:id/checkpoint {version}     → {"thumbnail": true|false}: collab wrote a checkpoint; the file
//                                                              card's picture follows through the render service (../thumbnails.ts)
//
// `Authorization: Bearer <DESIGN_COLLAB_INTERNAL_SECRET>`; without the secret configured every request is 403. These routes are
// for the private network only: the edge (Caddy, lane B5) must not route /internal/* from the internet.

const FILE_ID = /^[0-9a-f-]{36}$/;
const MAX_USER_ID = 200;

function authorized(req: Request): boolean {
  const secret = collabSecret();
  const given = /^Bearer (.+)$/.exec(req.get('authorization') ?? '')?.[1];
  if (!secret || !given) return false;
  const a = Buffer.from(given),
    b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createCollabInternalRouter(): Router {
  const router = Router();
  router.use((req, res, next) => {
    // Never part of the activity journal: a machine asking, many times a minute.
    res.locals.notActivity = true;
    res.setHeader('Cache-Control', 'no-store');
    if (!authorized(req)) {
      res.status(403).json({code: 'forbidden'});
      return;
    }
    next();
  });
  router.get(
    '/design-files/:id/access',
    asyncHandler(async (req, res) => {
      const fileId = String(req.params.id),
        user = typeof req.query.user === 'string' ? req.query.user : '';
      if (!FILE_ID.test(fileId) || !user || user.length > MAX_USER_ID) {
        res.status(400).json({code: 'bad_message'});
        return;
      }
      res.json({role: (await rolesIn(fileId, [user])).get(user) ?? null});
    }),
  );
  router.get('/design-files/:id/collab-taken', (req, res) => {
    const fileId = String(req.params.id);
    if (!FILE_ID.test(fileId)) {
      res.status(400).json({code: 'bad_message'});
      return;
    }
    leaseTaken(fileId);
    res.status(204).end();
  });
  router.post(
    '/design-files/:id/checkpoint',
    asyncHandler(async (req, res) => {
      const fileId = String(req.params.id);
      if (!FILE_ID.test(fileId)) {
        res.status(400).json({code: 'bad_message'});
        return;
      }
      const thumbnail = serverThumbnailsEnabled();
      if (thumbnail) scheduleServerThumbnail(fileId);
      res.json({thumbnail});
    }),
  );
  router.use((_req, res) => res.status(404).json({code: 'not_found'}));
  return router;
}
