// Card Canvas: Russian text proofing under /api/marketplace/proof (docs/marketplaces.md §Russian text proofing), behind the session the
// marketplace router asks for. POST / checks the spelling of a card's texts (free; the file must be one the account can open).
import {Router, type Request, type Response} from 'express';
import {z} from 'zod';
import {captureCustomerAuthority, type CustomerAuthority} from '../../customer-authority';
import {designToolAvailable} from '../../design/flag';
import {designRead, fileAccess} from '../../design/file-access';
import {asyncHandler} from '../../http';
import {limitRequests} from '../../rate-limit';
import type {AddressOf} from '../../account-list';
import {ONE_MINUTE_MS} from '../../time-constants';
import {PROOF_LIMITS, type ProofAnswer, type ProofBody} from '../../../shared/design/marketplace/proof';
import {spellingIssues, type Speller} from './spelling';

const body = z
  .object({
    fileId: z.string().regex(/^[0-9a-f-]{36}$/),
    texts: z
      .array(z.object({id: z.string().min(1).max(200), text: z.string().max(PROOF_LIMITS.chars)}).strict())
      .max(PROOF_LIMITS.texts),
  })
  .strict();

type Account = {id: string} & AddressOf;

export type ProofRouterOptions = {
  /** The speller (default: the process's Russian Hunspell). */
  speller?: () => Promise<Speller>;
  /** Throws the files API's error unless the account can open the file (default: the design files' access check). */
  canRead?: (actor: CustomerAuthority, fileId: string) => Promise<void>;
  /** The design tool is open to the account (default: its switch and rollout). */
  toolAvailable?: (account: Account) => boolean;
  actorOf?: (req: Request, res: Response) => CustomerAuthority;
};

const readable = (actor: CustomerAuthority, fileId: string) =>
  designRead(actor, async tx => void (await fileAccess(tx, actor.ownerId, fileId, 'view')));

export function createProofRouter(options: ProofRouterOptions = {}): Router {
  const {
    speller,
    canRead = readable,
    toolAvailable = designToolAvailable,
    actorOf = captureCustomerAuthority,
  } = options;
  const router = Router();
  const owner = (res: Response) => String(res.locals.user.id);
  const userKey = (_req: unknown, res: Response) => owner(res);
  const hidden = (res: Response) => void res.status(404).json({error: 'Route not found.'});
  router.use((_req, res, next) => (res.locals.user && toolAvailable(res.locals.user) ? next() : hidden(res)));
  // The editor asks again after each pause in typing, with only the texts that changed.
  const spelling = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: userKey});
  const parse = (raw: unknown): ProofBody => {
    const parsed = body.safeParse(raw);
    if (!parsed.success)
      throw Object.assign(new Error('The texts could not be read. Refresh the page and try again.'), {
        status: 400,
        code: 'invalid_request',
      });
    return parsed.data;
  };

  router.post(
    '/',
    spelling,
    asyncHandler(async (req, res) => {
      const input = parse(req.body);
      await canRead(actorOf(req, res), input.fileId);
      const answer: ProofAnswer = {issues: await spellingIssues(input.texts, speller ? await speller() : undefined)};
      res.json(answer);
    }),
  );
  return router;
}
