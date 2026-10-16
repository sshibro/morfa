import {Router, type Request, type RequestHandler, type Response} from 'express';
import {z} from 'zod';
import {captureCustomerAuthority} from '../customer-authority';
import {asyncHandler} from '../http';
import {limitRequests} from '../rate-limit';
import {ONE_MINUTE_MS} from '../time-constants';
import {DESIGN_COMMENT_LIMITS, type DesignCommentAnchor, type DesignCommentMention} from '../../shared/design/comments';
import * as comments from './comments';

// `/api/design-files/:id/comments` (docs/design-tool.md §Teams "Comments"; routes in shared/design/comments.ts). Mounted inside the
// files router, after its flag, session and rollout checks and before its 404 and error handlers, which answer for these routes too.
// Bodies are small JSON read by the files router's own windowed reader (`body`), after the session check.

/** A comment's JSON: 4000 characters (up to 6 bytes each escaped) and 20 mentions. */
export const DESIGN_COMMENT_BODY_BYTES = 32 * 1024;

const mention = z.object({userId: z.string().min(1).max(200), at: z.number().int().min(0), length: z.number().int().min(2).max(DESIGN_COMMENT_LIMITS.mentionLength)}).strict();
const draft = {
  text: z.string().max(DESIGN_COMMENT_LIMITS.textLength),
  mentions: z.array(mention).max(DESIGN_COMMENT_LIMITS.mentions).default([]),
};
const point = z.number().finite();
const anchor = z
  .object({
    pageId: z.string().max(DESIGN_COMMENT_LIMITS.idLength),
    x: point,
    y: point,
    nodeId: z.string().max(DESIGN_COMMENT_LIMITS.idLength).nullable(),
    offset: z.object({x: point, y: point}).strict().nullable(),
  })
  .strict();
const id = z.string().max(64);

/** `body`: the files router's windowed JSON reader; `reading`: its gate of simultaneous reads (a file's whole discussion can be large). */
export function createDesignCommentsRouter(options: {body: RequestHandler; reading: RequestHandler}): Router {
  const router = Router({mergeParams: true});
  const accountKey = (_req: Request, res: Response) => String(res.locals.user.id);
  // An open file asks every 20 seconds per tab; a reload or a link asks once more.
  const reads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: accountKey});
  const writes = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: accountKey});
  const readMarks = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: accountKey});
  const actorOf = (req: Request, res: Response) => captureCustomerAuthority(req, res);
  const fileOf = (req: Request) => String(req.params.id);
  const threadOf = (req: Request) => id.parse(req.params.threadId);

  router.get(
    '/',
    reads,
    options.reading,
    asyncHandler(async (req, res) => {
      const query = z.object({since: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional()}).passthrough().parse(req.query);
      res.json(await comments.listDesignComments(actorOf(req, res), fileOf(req), query.since ?? 0));
    }),
  );
  router.post(
    '/',
    writes,
    options.body,
    asyncHandler(async (req, res) => {
      const input = z.object({...draft, anchor}).strict().parse(req.body ?? {});
      const thread = await comments.createDesignCommentThread(actorOf(req, res), fileOf(req), {
        text: input.text,
        mentions: input.mentions as DesignCommentMention[],
        anchor: input.anchor as DesignCommentAnchor,
      });
      res.status(201).json({thread});
    }),
  );
  // Before `/:threadId`: "read" is not a thread id.
  router.post(
    '/read',
    readMarks,
    options.body,
    asyncHandler(async (req, res) => {
      const input = z.object({threads: z.array(id).max(DESIGN_COMMENT_LIMITS.readBatch)}).strict().parse(req.body ?? {});
      res.json(await comments.markDesignCommentsRead(actorOf(req, res), fileOf(req), input.threads));
    }),
  );
  router.patch(
    '/:threadId',
    writes,
    options.body,
    asyncHandler(async (req, res) => {
      const input = z.object({resolved: z.boolean()}).strict().parse(req.body ?? {});
      res.json({thread: await comments.resolveDesignCommentThread(actorOf(req, res), fileOf(req), threadOf(req), input.resolved)});
    }),
  );
  router.delete(
    '/:threadId',
    writes,
    asyncHandler(async (req, res) => {
      res.json({thread: await comments.deleteDesignCommentThread(actorOf(req, res), fileOf(req), threadOf(req))});
    }),
  );
  router.post(
    '/:threadId/replies',
    writes,
    options.body,
    asyncHandler(async (req, res) => {
      const input = z.object(draft).strict().parse(req.body ?? {});
      const thread = await comments.replyToDesignComment(actorOf(req, res), fileOf(req), threadOf(req), {
        text: input.text,
        mentions: input.mentions as DesignCommentMention[],
      });
      res.status(201).json({thread});
    }),
  );
  router.patch(
    '/:threadId/messages/:commentId',
    writes,
    options.body,
    asyncHandler(async (req, res) => {
      const input = z.object(draft).strict().parse(req.body ?? {});
      res.json({
        thread: await comments.editDesignComment(actorOf(req, res), fileOf(req), threadOf(req), id.parse(req.params.commentId), {
          text: input.text,
          mentions: input.mentions as DesignCommentMention[],
        }),
      });
    }),
  );
  router.delete(
    '/:threadId/messages/:commentId',
    writes,
    asyncHandler(async (req, res) => {
      res.json({thread: await comments.deleteDesignComment(actorOf(req, res), fileOf(req), threadOf(req), id.parse(req.params.commentId))});
    }),
  );
  return router;
}
