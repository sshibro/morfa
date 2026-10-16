import {Router, type NextFunction, type Request, type RequestHandler, type Response} from 'express';
import {db} from '../db';
import {asyncHandler} from '../http';
import {limitRequests} from '../rate-limit';
import {ONE_MINUTE_MS} from '../time-constants';
import type {SupportConversation, SupportInbox, SupportWaiting} from '../../shared/support';
import {inboxQuery, messageInput, threadId, threadStatus} from './input';
import {supportErrors} from './router';
import {
  markOperatorRead,
  markOperatorTyping,
  replyAsOperator,
  setSupportStatus,
  supportConversation,
  supportInbox,
  supportWaiting,
} from './store';
import {recordOperatorPresence} from './team';

// `/api/admin/support` (shared/support.ts): the operator's side of the support chat, behind `gate`, the console's operator check
// (server/app.ts mounts it with server/admin/operators.ts `operatorGate`). The gate leaves the operator's
// account in res.locals (`operator`, else `user`); a reply names it. GET /threads is the inbox (?filter=waiting|open|closed|all,
// ?q= the name or e-mail), GET /threads/:id one conversation, POST /threads/:id/messages answers it, /status opens or closes it,
// /read marks it read (204), /typing says the operator is typing an answer (204; the console's composer calls it at most every
// SUPPORT_TYPING_PING_MS while they type), GET /unread counts the conversations waiting for an answer. An unknown conversation is
// 404 with the API's words for one. Every request is the operator's presence (the person's "Online", server/support/team.ts). These
// routes stay open to operators while the person's chat is switched off.

const NOT_FOUND = {error: 'Support request not found.', code: 'not_found'} as const;

/** The operator's account id, as the gate left it. */
const operatorId = (res: Response): string => String((res.locals.operator ?? res.locals.user).id);

export function createSupportAdminRouter(gate: RequestHandler): Router {
  const router = Router();
  router.use(gate);
  const operatorKey = (_req: Request, res: Response) => 'support-operator:' + operatorId(res);
  const reads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 300, keyGenerator: operatorKey});
  const writes = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: operatorKey});
  const typing = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: operatorKey});
  // The operator is here: the person sees "Online" (a failed write never fails the request).
  router.use(
    asyncHandler(async (_req, res, next) => {
      await recordOperatorPresence(operatorId(res)).catch(() => undefined);
      next();
    }),
  );
  // The console polls the open conversation and the rail's badge: no one's action.
  const notActivity = (_req: Request, res: Response, next: NextFunction) => {
    res.locals.notActivity = true;
    next();
  };
  /** The conversation named in the address, or a 404 answer and null. */
  const conversationId = (req: Request, res: Response) => {
    const id = threadId(req.params.id);
    if (!id) res.status(404).json(NOT_FOUND);
    return id;
  };
  const answer = (res: Response, conversation: SupportConversation | undefined) => {
    if (conversation) res.json(conversation);
    else res.status(404).json(NOT_FOUND);
  };

  router.get(
    '/threads',
    notActivity,
    reads,
    asyncHandler(async (req, res) => {
      const {filter, q} = inboxQuery(req.query as Record<string, unknown>);
      const inbox: SupportInbox = await supportInbox(filter, q);
      res.json(inbox);
    }),
  );
  router.get(
    '/threads/:id',
    notActivity,
    reads,
    asyncHandler(async (req, res) => {
      const id = conversationId(req, res);
      if (id) answer(res, await supportConversation(db, id));
    }),
  );
  router.post(
    '/threads/:id/messages',
    writes,
    asyncHandler(async (req, res) => {
      const id = conversationId(req, res);
      if (id) answer(res, await replyAsOperator(id, operatorId(res), messageInput(req.body, {withContext: false})));
    }),
  );
  router.post(
    '/threads/:id/status',
    writes,
    asyncHandler(async (req, res) => {
      const id = conversationId(req, res);
      if (id) answer(res, await setSupportStatus(id, threadStatus(req.body)));
    }),
  );
  router.post(
    '/threads/:id/read',
    notActivity,
    writes,
    asyncHandler(async (req, res) => {
      const id = conversationId(req, res);
      if (!id) return;
      if (await markOperatorRead(id)) res.sendStatus(204);
      else res.status(404).json(NOT_FOUND);
    }),
  );
  router.post(
    '/threads/:id/typing',
    notActivity,
    typing,
    asyncHandler(async (req, res) => {
      const id = conversationId(req, res);
      if (!id) return;
      if (await markOperatorTyping(id, operatorId(res))) res.sendStatus(204);
      else res.status(404).json(NOT_FOUND);
    }),
  );
  router.get(
    '/unread',
    notActivity,
    reads,
    asyncHandler(async (_req, res) => {
      const waiting: SupportWaiting = {waiting: await supportWaiting()};
      res.json(waiting);
    }),
  );
  router.use(supportErrors);
  return router;
}
