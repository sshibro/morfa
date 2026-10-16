import {Router, type NextFunction, type Request, type Response} from 'express';
import {requireAuth} from '../auth';
import {asyncHandler} from '../http';
import {limitRequests} from '../rate-limit';
import {ONE_MINUTE_MS} from '../time-constants';
import type {SupportThreadView, SupportUnread} from '../../shared/support';
import {supportChatEnabled} from './config';
import {SupportInputError, messageInput} from './input';
import {notifySupportOperators} from './notify';
import {UNKNOWN_ROUTE} from '../admin/operators';
import {markPersonRead, personConversation, personUnread, sendPersonMessage, type PersonConversation} from './store';
import {supportTeam} from './team';
import {db} from '../db';

// `/api/support` (shared/support.ts): the signed-in person's conversation with support. GET / answers the conversation (null before
// the first message) with who answers it (server/support/team.ts) and whether one of them is typing, GET /unread the help button's
// badge, POST /messages writes a message and answers the same view, POST /read marks it read (204). Off (SUPPORT_CHAT=0, or no operator named: server/support/config.ts), every route is the
// API's unknown one. The polls are no one's action (the activity journal skips them); sending is limited per account.

/** Messages one account may send per window; a retry of the same key counts too. */
export const SUPPORT_SEND_LIMIT = {limit: 20, windowMs: 10 * ONE_MINUTE_MS} as const;
const SEND_LIMITED = 'You sent many messages in a row. Wait a few minutes and write again.';

/** Errors of the support routes in the API's shape; the rest go to the app's handler. */
export function supportErrors(error: unknown, _req: Request, res: Response, next: NextFunction) {
  if (res.headersSent || !(error instanceof SupportInputError)) return next(error);
  res.status(error.status).json({error: error.message, code: error.code, requestId: res.locals.requestId});
}

export function createSupportRouter(): Router {
  const router = Router();
  router.use((_req, res, next) => (supportChatEnabled() ? next() : res.status(404).json(UNKNOWN_ROUTE)));
  router.use(requireAuth);
  const accountKey = (_req: Request, res: Response) => String(res.locals.user.id);
  // An open chat polls every 5 s and each open tab's badge every minute: generous, per account.
  const reads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: accountKey});
  const marks = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: accountKey});
  const sends = limitRequests({...SUPPORT_SEND_LIMIT, keyGenerator: accountKey, message: {error: SEND_LIMITED}});
  const notActivity = (_req: Request, res: Response, next: NextFunction) => {
    res.locals.notActivity = true;
    next();
  };
  const userId = (res: Response) => String(res.locals.user.id);
  const view = async (res: Response, conversation: PersonConversation): Promise<SupportThreadView> => ({
    enabled: true,
    team: await supportTeam(db, res.locals.user),
    ...conversation,
  });

  router.get(
    '/',
    notActivity,
    reads,
    asyncHandler(async (_req, res) => {
      res.json(await view(res, await personConversation(db, userId(res))));
    }),
  );
  router.get(
    '/unread',
    notActivity,
    reads,
    asyncHandler(async (_req, res) => {
      const answer: SupportUnread = {unread: await personUnread(db, userId(res))};
      res.json(answer);
    }),
  );
  router.post(
    '/messages',
    sends,
    asyncHandler(async (req, res) => {
      const input = messageInput(req.body, {withContext: true});
      const sent = await sendPersonMessage(userId(res), input);
      if (sent.created) notifySupportOperators(sent.threadId, userId(res), input.body);
      res.json(await view(res, sent.conversation));
    }),
  );
  router.post(
    '/read',
    notActivity,
    marks,
    asyncHandler(async (_req, res) => {
      await markPersonRead(userId(res));
      res.sendStatus(204);
    }),
  );
  router.use(supportErrors);
  return router;
}
