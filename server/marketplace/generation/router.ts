// Catalog Generation: brand kits and the free product cut-out (docs/marketplaces.md §Catalog Generation), under
// /api/marketplace/generation behind the session (server/marketplace/router.ts). The routes are listed in
// shared/design/marketplace/generation.ts. Everything answers 404 while the design tool is closed to the account. The cut-out runs
// one at a time per account (sharp works on full-size photos).
import fs from 'node:fs/promises';
import path from 'node:path';
import {Router, type Request, type RequestHandler, type Response} from 'express';
import {z} from 'zod';
import type {CustomerAuthority} from '../../customer-authority';
import {asyncHandler} from '../../http';
import {limitRequests} from '../../rate-limit';
import {ONE_MINUTE_MS} from '../../time-constants';
import type {DesignImageUploaded} from '../../../shared/design/api';
import {BRAND_KIT_ICONS, brandKitPictures} from '../../../shared/design/marketplace/brand-kit';
import type {CutOutAnswer} from '../../../shared/design/marketplace/generation';
import type {Database} from '../../postgresql/client';
import {
  BRAND_KIT_TEXTS,
  brandKitSchema,
  createBrandKit,
  deleteBrandKit,
  listBrandKits,
  readBrandKit,
  updateBrandKit,
} from './brand-kits';
import {CutOutRefusal, floodCutOut} from './cut-out';
import {kitPicturesFor, usableInPlace, type PictureDeps} from './pictures';

type Account = {id: string; email?: string | null};
export type GenerationRouterOptions = PictureDeps & {
  db: () => Database;
  /** "Design" is open to the account (server/design/flag.ts). */
  designOn: (account: Account) => boolean;
  actorOf: (req: Request, res: Response) => CustomerAuthority;
};

const TEXTS = {
  notFound: 'Not found.',
  invalid: 'The request could not be read. Refresh the page and try again.',
  busy: 'Wait until the previous photo is cut out.',
} as const;
class GenerationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const invalid = () => new GenerationError(400, 'invalid_request', TEXTS.invalid);

const uuid = z.string().regex(/^[0-9a-f-]{36}$/);
const imageRef = z.string().regex(/^[A-Za-z0-9_-]{1,120}$/);
const cutOutBody = z.object({fileId: uuid, imageRef}).strict();
const kitBody = z.object({kit: z.unknown()}).strict();
const picturesBody = z
  .object({
    fileId: uuid,
    urls: z
      .array(z.string().max(200))
      .max(BRAND_KIT_ICONS + 2)
      .optional(),
  })
  .strict();

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw invalid();
  return parsed.data;
}

export function createGenerationRouter(options?: Partial<GenerationRouterOptions>): Router {
  const router = Router();
  // The real wiring is loaded on first use: the module stays importable without a database (tests hand their own).
  let wired: Promise<GenerationRouterOptions> | null = null;
  const complete = (given: typeof options): given is GenerationRouterOptions =>
    OPTION_KEYS.every(key => given?.[key] !== undefined);
  const deps = () =>
    (wired ??= complete(options) ? Promise.resolve(options) : realOptions().then(real => ({...real, ...options})));
  const owner = (res: Response) => String(res.locals.user.id);
  const userKey = (_req: unknown, res: Response) => owner(res);
  const hidden = (res: Response) => void res.status(404).json({error: TEXTS.notFound, code: 'not_found'});
  const gate =
    (check: (o: GenerationRouterOptions, account: Account) => boolean): RequestHandler =>
    (_req, res, next) =>
      void deps().then(o => (check(o, res.locals.user) ? next() : hidden(res)), next);
  router.use(gate((o, account) => !!account && o.designOn(account)));
  const reads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: userKey});
  const writes = limitRequests({windowMs: ONE_MINUTE_MS, limit: 30, keyGenerator: userKey});
  const cuts = limitRequests({windowMs: ONE_MINUTE_MS, limit: 20, keyGenerator: userKey});

  // ── Brand kits ──
  router.get(
    '/brand-kits',
    reads,
    asyncHandler(async (_req, res) => {
      res.json({kits: await listBrandKits((await deps()).db(), owner(res))});
    }),
  );
  const kitOf = (body: unknown) => {
    const parsed = brandKitSchema.safeParse(parse(kitBody, body).kit);
    if (!parsed.success) throw new GenerationError(400, 'invalid_request', BRAND_KIT_TEXTS.invalid);
    return parsed.data;
  };
  router.post(
    '/brand-kits',
    writes,
    asyncHandler(async (req, res) => {
      const record = await createBrandKit((await deps()).db(), owner(res), kitOf(req.body));
      if (!record) throw new GenerationError(409, 'brand_kit_limit', BRAND_KIT_TEXTS.limit);
      res.status(201).json({kit: record});
    }),
  );
  const kitId = (req: Request) => {
    const id = uuid.safeParse(req.params.id);
    if (!id.success) throw new GenerationError(404, 'not_found', BRAND_KIT_TEXTS.notFound);
    return id.data;
  };
  router.patch(
    '/brand-kits/:id',
    writes,
    asyncHandler(async (req, res) => {
      const record = await updateBrandKit((await deps()).db(), owner(res), kitId(req), kitOf(req.body));
      if (!record) throw new GenerationError(404, 'not_found', BRAND_KIT_TEXTS.notFound);
      res.json({kit: record});
    }),
  );
  router.delete(
    '/brand-kits/:id',
    writes,
    asyncHandler(async (req, res) => {
      if (!(await deleteBrandKit((await deps()).db(), owner(res), kitId(req))))
        throw new GenerationError(404, 'not_found', BRAND_KIT_TEXTS.notFound);
      res.json({ok: true});
    }),
  );
  router.post(
    '/brand-kits/:id/pictures',
    writes,
    asyncHandler(async (req, res) => {
      const o = await deps();
      const {fileId, urls} = parse(picturesBody, req.body);
      const record = await readBrandKit(o.db(), owner(res), kitId(req));
      if (!record) throw new GenerationError(404, 'not_found', BRAND_KIT_TEXTS.notFound);
      // Only the pictures the card needs (its logos): a team file gets a copy of each, so the rest are not copied for nothing.
      const wanted = brandKitPictures(record.kit).filter(asset => !urls || urls.includes(asset.url));
      res.json(await kitPicturesFor(o, o.actorOf(req, res), fileId, wanted));
    }),
  );

  // ── Cut-outs ──
  const cutting = new Set<string>();
  router.post(
    '/cut-out',
    cuts,
    asyncHandler(async (req, res) => {
      const o = await deps();
      const body = parse(cutOutBody, req.body);
      const actor = o.actorOf(req, res);
      if (cutting.has(actor.ownerId)) throw new GenerationError(429, 'busy', TEXTS.busy);
      cutting.add(actor.ownerId);
      try {
        const original = await o.readImage(actor.ownerId, body.imageRef);
        if (!original) throw new GenerationError(404, 'image_missing', 'Photo not found in your files.');
        const cut = await floodCutOut(original);
        const stored: DesignImageUploaded = await o.storeImage(actor, body.fileId, cut.image, 'Product');
        const answer: CutOutAnswer = {ref: stored.ref, asset: stored.asset, box: cut.box, source: cut.source};
        res.json(answer);
      } finally {
        cutting.delete(actor.ownerId);
      }
    }),
  );
  router.use((error: unknown, _req: Request, res: Response, next: (error?: unknown) => void) => {
    if (error instanceof GenerationError || error instanceof CutOutRefusal) {
      res.status(error.status).json({error: error.message, code: error.code, requestId: res.locals.requestId});
      return;
    }
    next(error);
  });
  return router;
}

const OPTION_KEYS: readonly (keyof GenerationRouterOptions)[] = [
  'db',
  'designOn',
  'actorOf',
  'fileScope',
  'usable',
  'readImage',
  'storeImage',
];

/** The bytes of one of the account's design pictures by its ref: its own, a live team's it belongs to, a guest picture or an upload. */
async function readOwnImage(userId: string, ref: string): Promise<Buffer | null> {
  if (!/^[A-Za-z0-9_-]{1,120}$/.test(ref)) return null;
  const [{db, dataDir}, {guestPicturesSql}] = await Promise.all([
    import('../../db'),
    import('../../design/file-access'),
  ]);
  const row = await db.one<{filename: string}>(
    `SELECT filename FROM design_images WHERE user_id=$1 AND kind='image' AND filename IN($2||'.png',$2||'.webp')
     UNION ALL SELECT d.filename FROM design_images d JOIN design_teams t ON t.id=d.team_id AND t.deleted_at IS NULL
       JOIN design_team_members m ON m.team_id=t.id AND m.user_id=$1 WHERE d.kind='image' AND d.filename IN($2||'.png',$2||'.webp')
     UNION ALL (${guestPicturesSql("ARRAY[$2||'.png',$2||'.webp']", '$1')})
     UNION ALL SELECT filename FROM uploads WHERE user_id=$1 AND ready=1 AND starts_with(filename,$2||'.')
       AND position('.' in substr(filename,length($2)+2))=0 AND position('/' in filename)=0 LIMIT 1`,
    [userId, ref],
  );
  if (!row || !/^[A-Za-z0-9_.-]{1,200}$/.test(row.filename)) return null;
  return fs.readFile(path.join(dataDir, 'uploads', row.filename)).catch(() => null);
}

/** Production's wiring: the app's database, the design tool's switch, the design files' storage and access. */
async function realOptions(): Promise<GenerationRouterOptions> {
  const [{db}, flag, authority, files, access, fileAccessModule] = await Promise.all([
    import('../../db'),
    import('../../design/flag'),
    import('../../customer-authority'),
    import('../../design/files'),
    import('../../design/access'),
    import('../../design/file-access'),
  ]);
  return {
    db: () => db,
    designOn: account => flag.designToolAvailable(account),
    actorOf: authority.captureCustomerAuthority,
    readImage: readOwnImage,
    storeImage: (actor, fileId, image, name) => files.storeDesignImage(actor, fileId, image, name),
    fileScope: (actor, fileId) =>
      fileAccessModule.designRead(actor, async tx => {
        const row = await fileAccessModule.fileAccess(tx, actor.ownerId, fileId, 'edit');
        const scope = access.scopeOfFile(row);
        return {userId: row.user_id, teamId: scope.kind === 'team' ? scope.teamId : null};
      }),
    usable: (scope, filenames) => usableInPlace(db, scope, filenames),
  };
}
