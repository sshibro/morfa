import express, {Router, type NextFunction, type Request, type Response} from 'express';
import {z} from 'zod';
import {requireAuth} from '../auth';
import {captureCustomerAuthority} from '../customer-authority';
import {asyncHandler} from '../http';
import {limitRequests} from '../rate-limit';
import {ONE_MINUTE_MS} from '../time-constants';
import type {TransactionContext} from '../postgresql/client';
import {exportRows} from '../launch/export-json';
import type {DesignFavourites} from '../../shared/design/favourites';
import {designFail, isDesignFailure} from './errors';
import {fileAccess, fileRoleJoins, designRead, designWrite} from './file-access';
import {designToolAvailable, designToolEnabled} from './flag';

// `/api/design-favourites` (SQL018, docs/figma-parity-shell.md "Favorites"): the files and projects the caller starred, as Figma's
// "Starred". GET lists what the caller may still open; PUT stars a file it may open or a project of a team it is in; DELETE takes a
// star back (always, even of a file it can no longer open). Writes answer {ok: true}. Mounted in server/app.ts.

const UNAVAILABLE = {error: 'Design is unavailable.', code: 'design_unavailable'};
const ID = /^[0-9a-f-]{36}$/;
const notFound = (): never => designFail(404, 'not_found', 'Not found.');

const LIST_FILES = `SELECT f.id,f.name,COALESCE(f.kind,'design') AS kind,f.team_id AS "teamId"
   FROM design_favourite_files s JOIN design_files f ON f.id=s.file_id
   ${fileRoleJoins('f', '$1')}
   WHERE s.user_id=$1 AND fa_role.role IS NOT NULL AND f.trashed_at IS NULL
   ORDER BY s.created_at`;
const PROJECT_OF_MEMBER = `FROM design_projects p
   JOIN design_teams t ON t.id=p.team_id AND t.deleted_at IS NULL
   JOIN design_team_members m ON m.team_id=t.id AND m.user_id=$1
   WHERE p.deleted_at IS NULL`;
const LIST_PROJECTS = `SELECT p.id,p.name,p.team_id AS "teamId" FROM design_favourite_projects s JOIN (SELECT p.* ${PROJECT_OF_MEMBER}) p ON p.id=s.project_id
   WHERE s.user_id=$1 ORDER BY s.created_at`;

export async function listDesignFavourites(tx: TransactionContext, userId: string): Promise<DesignFavourites> {
  return {files: await tx.many(LIST_FILES, [userId]), projects: await tx.many(LIST_PROJECTS, [userId])};
}

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The account's data export (server/design/lifecycle.ts `exportDesignAccount`, 152-FZ): what it starred and when. */
export const exportDesignFavourites = (ownerId: string) => exportRows(async function* (tx) {
  const rows = await tx.many<{kind: 'file' | 'project'; id: string; created_at: string}>(
    `SELECT 'file' AS kind,file_id AS id,to_char(created_at AT TIME ZONE 'UTC',${ISO}) AS created_at FROM design_favourite_files WHERE user_id=$1
     UNION ALL
     SELECT 'project',project_id,to_char(created_at AT TIME ZONE 'UTC',${ISO}) FROM design_favourite_projects WHERE user_id=$1
     ORDER BY created_at,id LIMIT 10000`,
    [ownerId],
  );
  for (const row of rows) yield {kind: row.kind, id: row.id, starredAt: row.created_at};
});

/** Account erasure (server/design/lifecycle.ts): its stars go with it. */
export async function eraseDesignFavouritesOf(tx: TransactionContext, userId: string): Promise<void> {
  await tx.execute('DELETE FROM design_favourite_files WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM design_favourite_projects WHERE user_id=$1', [userId]);
}

export function createDesignFavouritesRouter(): Router {
  const router = Router();
  router.use((_req, res, next) => (designToolEnabled() ? next() : res.status(404).json(UNAVAILABLE)));
  router.use(requireAuth);
  router.use((_req, res, next) => (designToolAvailable(res.locals.user) ? next() : res.status(404).json(UNAVAILABLE)));
  router.use(express.json({limit: 1024}));
  const accountKey = (_req: Request, res: Response) => String(res.locals.user.id);
  const reads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: accountKey});
  const writes = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: accountKey});
  const actorOf = (req: Request, res: Response) => captureCustomerAuthority(req, res);
  const idOf = (req: Request) => z.string().regex(ID).parse(req.params.id);

  router.get('/', reads, asyncHandler(async (req, res) => {
    const actor = actorOf(req, res);
    res.json(await designRead(actor, tx => listDesignFavourites(tx, actor.ownerId)));
  }));
  router.put('/files/:id', writes, asyncHandler(async (req, res) => {
    const actor = actorOf(req, res),
      id = idOf(req);
    await designWrite(actor, async tx => {
      await fileAccess(tx, actor.ownerId, id, 'view');
      await tx.execute('INSERT INTO design_favourite_files(user_id,file_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [actor.ownerId, id]);
    });
    res.json({ok: true});
  }));
  router.delete('/files/:id', writes, asyncHandler(async (req, res) => {
    const actor = actorOf(req, res),
      id = idOf(req);
    await designWrite(actor, tx => tx.execute('DELETE FROM design_favourite_files WHERE user_id=$1 AND file_id=$2', [actor.ownerId, id]));
    res.json({ok: true});
  }));
  router.put('/projects/:id', writes, asyncHandler(async (req, res) => {
    const actor = actorOf(req, res),
      id = idOf(req);
    await designWrite(actor, async tx => {
      if (!(await tx.one(`SELECT p.id ${PROJECT_OF_MEMBER} AND p.id=$2`, [actor.ownerId, id]))) notFound();
      await tx.execute('INSERT INTO design_favourite_projects(user_id,project_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [actor.ownerId, id]);
    });
    res.json({ok: true});
  }));
  router.delete('/projects/:id', writes, asyncHandler(async (req, res) => {
    const actor = actorOf(req, res),
      id = idOf(req);
    await designWrite(actor, tx => tx.execute('DELETE FROM design_favourite_projects WHERE user_id=$1 AND project_id=$2', [actor.ownerId, id]));
    res.json({ok: true});
  }));
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
