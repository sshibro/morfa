import {Router, type Request, type RequestHandler, type Response} from 'express';
import {z} from 'zod';
import {captureCustomerAuthority} from '../../customer-authority';
import {asyncHandler} from '../../http';
import {limitRequests} from '../../rate-limit';
import {ONE_MINUTE_MS} from '../../time-constants';
import {isCleanChat, MEETING_EMOTES, MEETING_LIMITS, MEETING_TRACKS, type MeetingBallot, type MeetingEmote, type MeetingTimerAction, type MeetingTrack, type MeetingVoteAction} from '../../../shared/design/meeting';
import {castDesignMeetingBallot, changeDesignMeetingTimer, changeDesignMeetingVote, deleteDesignMeetingVote, listDesignMeetingVotes, readDesignMeeting} from './service';

// `/api/design-files/:id/meeting` (docs/board-meeting.md; routes in shared/design/meeting.ts). Mounted inside the files router, after its
// flag, session (and the account the tab expects) and rollout checks, before its 404 and error handlers, which answer for these routes
// too. Bodies are a few bytes of JSON read by the files router's own windowed reader (`body`), after the session check.

/** The stream connection of the tab that acts: its own stream is not told about the change (the answer carries it). */
const client = z.string().max(64).nullable().optional();
const track = z.enum(MEETING_TRACKS.map(item => item.id) as [MeetingTrack, ...MeetingTrack[]]);
const duration = z.number().int().min(MEETING_LIMITS.timerMinMs).max(MEETING_LIMITS.timerMaxMs);
const timerAction = z.discriminatedUnion('action', [
  z.object({action: z.literal('start'), durationMs: duration, music: track.nullable().optional(), client}).strict(),
  z.object({action: z.literal('pause'), client}).strict(),
  z.object({action: z.literal('resume'), client}).strict(),
  z.object({action: z.literal('add'), client}).strict(),
  z.object({action: z.literal('stop'), client}).strict(),
  z.object({action: z.literal('music'), music: track.nullable(), client}).strict(),
]);
const voteAction = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('start'),
      perPerson: z.number().int().min(MEETING_LIMITS.votesPerPersonMin).max(MEETING_LIMITS.votesPerPersonMax),
      durationMs: duration.nullable(),
      music: track.nullable().optional(),
      // Cleaned as everyone shows it (cleanPrompt); the bound is generous for what cleaning drops.
      prompt: z.string().max(MEETING_LIMITS.promptLength * 4).nullable().optional(),
      hideCursors: z.boolean().optional(),
      client,
    })
    .strict(),
  z.object({action: z.literal('cursors'), hide: z.boolean(), client}).strict(),
  z.object({action: z.literal('end'), client}).strict(),
  z.object({action: z.literal('clear'), client}).strict(),
]);
const VOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ballot = z
  .object({
    voteId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    nodeId: z.string().min(1).max(MEETING_LIMITS.idLength).regex(/^[A-Za-z0-9_:;.,-]+$/),
    delta: z.union([z.literal(1), z.literal(-1)]),
    client,
  })
  .strict();

/** The `meeting` field of a presence post (server/design/router.ts): cursor chat, the last emote, a wave, spotlight. Never stored. */
export const meetingPresenceSchema = z
  .object({
    chat: z.string().max(MEETING_LIMITS.chatLength * 2).refine(isCleanChat, 'The message is not allowed.').nullable(),
    emote: z
      .object({id: z.enum(MEETING_EMOTES.map(item => item.id) as [MeetingEmote, ...MeetingEmote[]]), n: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER)})
      .strict()
      .nullable(),
    wave: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
    spotlight: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable(),
  })
  .strict();

/** `body`: the files router's windowed JSON reader. */
export function createDesignMeetingRouter(options: {body: RequestHandler}): Router {
  const router = Router({mergeParams: true});
  const accountKey = (_req: Request, res: Response) => String(res.locals.user.id);
  // Every open tab reads once per change of the file's meeting and once per (re)connect.
  const reads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 240, keyGenerator: accountKey});
  // Starting, pausing, "+1 min", a vote's start and end: people press these a few times a meeting.
  const controls = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: accountKey});
  // A vote is a click on an object, and taking it back another.
  const ballots = limitRequests({windowMs: ONE_MINUTE_MS, limit: 240, keyGenerator: accountKey});
  const actorOf = (req: Request, res: Response) => captureCustomerAuthority(req, res);
  const fileOf = (req: Request) => String(req.params.id);

  router.get(
    '/',
    reads,
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await readDesignMeeting(actorOf(req, res), fileOf(req)));
    }),
  );
  router.post(
    '/timer',
    controls,
    options.body,
    asyncHandler(async (req, res) => {
      const {client: by, ...action} = timerAction.parse(req.body ?? {});
      res.json(await changeDesignMeetingTimer(actorOf(req, res), fileOf(req), action as MeetingTimerAction, by ?? null));
    }),
  );
  router.post(
    '/vote',
    controls,
    options.body,
    asyncHandler(async (req, res) => {
      const {client: by, ...action} = voteAction.parse(req.body ?? {});
      res.json(await changeDesignMeetingVote(actorOf(req, res), fileOf(req), action as MeetingVoteAction, by ?? null));
    }),
  );
  // "Results": the ended sessions, and an editor deleting one.
  router.get(
    '/votes',
    reads,
    asyncHandler(async (req, res) => {
      res.set('Cache-Control', 'no-store').json(await listDesignMeetingVotes(actorOf(req, res), fileOf(req)));
    }),
  );
  router.delete(
    '/votes/:voteId',
    controls,
    asyncHandler(async (req, res) => {
      const voteId = z.string().regex(VOTE_ID).parse(req.params.voteId);
      await deleteDesignMeetingVote(actorOf(req, res), fileOf(req), voteId, typeof req.query.client === 'string' ? req.query.client.slice(0, 64) : null);
      res.json({ok: true});
    }),
  );
  router.post(
    '/vote/ballot',
    ballots,
    options.body,
    asyncHandler(async (req, res) => {
      const {client: by, ...input} = ballot.parse(req.body ?? {});
      res.json(await castDesignMeetingBallot(actorOf(req, res), fileOf(req), input as MeetingBallot, by ?? null));
    }),
  );
  return router;
}
