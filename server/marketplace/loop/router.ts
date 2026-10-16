// Performance Loop (docs/marketplaces.md §Performance Loop): seller connections, card links, publishing, numbers and A/B tests under
// /api/marketplace (behind the session: server/marketplace/router.ts); the public, unguessable picture links under /api/marketplace-media
// the marketplaces download published cards from. Off unless ENABLE_MARKETPLACE_API=1 (the routes answer 404 as any unknown path);
// open to every account.
import {randomUUID} from 'node:crypto';
import {Router, type NextFunction, type Request, type RequestHandler, type Response} from 'express';
import multer from 'multer';
import {z} from 'zod';
import {db} from '../../db';
import {asyncHandler} from '../../http';
import {limitRequests} from '../../rate-limit';
import {ONE_MINUTE_MS} from '../../time-constants';
import {fileAccess} from '../../design/file-access';
import {fail} from '../../hosting/errors';
import {
  DEFAULT_TEST_DAYS,
  LOOP_MARKETPLACE_NAMES,
  PUBLISH_MAX_BYTES,
  ROTATION_SWAP_HOURS,
  SLOT_MAX,
  TEST_DAYS_MAX,
  TEST_DAYS_MIN,
  type LoopProduct,
} from '../../../shared/design/marketplace/loop';
import {createTest, finishCabinetTest, startCabinetTest, stopTest} from './ab';
import {isMarketplaceError, marketplaceAdapters, type MarketplaceSecret} from './adapters';
import {loopNow} from './clock';
import {marketplaceApiOn} from './config';
import {contentTypeOf, mediaForToken} from './media';
import {readFileCards} from './numbers';
import {publishPicture} from './publish';
import {
  CONNECTION_COLUMNS,
  connectionOf,
  iso,
  LINK_COLUMNS,
  linkOf,
  openSecret,
  readLink,
  sealSecret,
  type ConnectionRow,
  type LinkRow,
} from './store';

const MAX_CONNECTIONS = 10;
const NO_CONNECTION = 'Connection not found.';

const userOf = (res: Response) => String(res.locals.user.id);
const accountKey = (_req: Request, res: Response) => userOf(res);
const idParam = (req: Request, name = 'id') => {
  const value = String(req.params[name] ?? '');
  if (!/^[0-9a-f-]{36}$/.test(value)) fail(404, 'not_found', 'Not found.');
  return value;
};
const nodeId = z.string().min(1, 'Choose a frame.').max(200);
const days = z.coerce
  .number()
  .int()
  .min(TEST_DAYS_MIN, 'A test lasts at least 1 day.')
  .max(TEST_DAYS_MAX, 'A test lasts at most 60 days.');

/** The loop is off: the route is not there. */
const switchedOn: RequestHandler = (_req, res, next) =>
  marketplaceApiOn() ? next() : void res.status(404).json({error: 'Route not found.'});

/** One picture (`image`) or a test's two (`a`, `b`), at most 10 MB each, in the API's words when refused. */
function pictures(fields: multer.Field[]): RequestHandler {
  const read = multer({
    storage: multer.memoryStorage(),
    limits: {fileSize: PUBLISH_MAX_BYTES, files: fields.length, fields: 12, parts: 20},
  }).fields(fields);
  return (req, res, next: NextFunction) =>
    read(req, res, error => {
      if (!error) return next();
      if (error instanceof multer.MulterError)
        return next(
          error.code === 'LIMIT_FILE_SIZE'
            ? Object.assign(new Error('The picture is larger than 10 MB: reduce the scale or export quality.'), {
                status: 413,
                code: 'invalid_request',
              })
            : Object.assign(new Error('Could not read the picture.'), {status: 400, code: 'invalid_request'}),
        );
      next(error);
    });
}
const fileOf = (req: Request, field: string): Buffer | null => {
  const files = req.files as Record<string, Express.Multer.File[]> | undefined;
  return files?.[field]?.[0]?.buffer ?? null;
};

const connectionSchema = z.discriminatedUnion('marketplace', [
  z.object({
    marketplace: z.literal('wb'),
    label: z.string().trim().max(80).optional(),
    token: z.string().trim().min(20, 'Paste the whole token.').max(4000, 'This does not look like a Wildberries token.'),
  }),
  z.object({
    marketplace: z.literal('ozon'),
    label: z.string().trim().max(80).optional(),
    clientId: z
      .string()
      .trim()
      .regex(/^\d{1,20}$/, 'The Client-Id consists of digits.'),
    apiKey: z.string().trim().min(8, 'Paste the whole Api-Key.').max(200, 'This does not look like an Ozon key.'),
  }),
]);
type ConnectionInput = z.infer<typeof connectionSchema>;
const secretOf = (input: ConnectionInput): MarketplaceSecret =>
  input.marketplace === 'wb'
    ? {kind: 'wb', token: input.token}
    : {kind: 'ozon', clientId: input.clientId, apiKey: input.apiKey};
/** Tells two keys apart without showing them: a WB token's last four characters, an Ozon Client-Id. */
const hintOf = (secret: MarketplaceSecret) =>
  secret.kind === 'wb' ? `…${secret.token.slice(-4)}` : `Client-Id ${secret.clientId}`;

/** The key works: one cheap read. A refusal is the seller's mistake (400); a marketplace that did not answer is a 503 to retry. */
async function checkKey(secret: MarketplaceSecret): Promise<void> {
  try {
    await (await marketplaceAdapters())[secret.kind].check(secret);
  } catch (error) {
    if (!isMarketplaceError(error)) throw error;
    if (error.kind === 'refused') fail(400, 'key_refused', error.message);
    fail(503, 'marketplace_unavailable', error.message, true);
  }
}

const readConnection = (userId: string, id: string) =>
  db.one<ConnectionRow>(`SELECT ${CONNECTION_COLUMNS} FROM marketplace_connections c WHERE c.id=$1 AND c.user_id=$2`, [
    id,
    userId,
  ]);

export function createLoopRouter(): Router {
  const router = Router();
  router.use(['/loop', '/connections', '/links', '/publish', '/files', '/tests'], switchedOn);
  const keyChecks = limitRequests({
    windowMs: ONE_MINUTE_MS,
    limit: 10,
    keyGenerator: accountKey,
    message: {error: 'Too many connection attempts. Wait a minute.'},
  });
  const searches = limitRequests({
    windowMs: ONE_MINUTE_MS,
    limit: 30,
    keyGenerator: accountKey,
    message: {error: 'Too many searches in a row. Wait a minute.'},
  });
  const publishes = limitRequests({
    windowMs: ONE_MINUTE_MS,
    limit: 20,
    keyGenerator: accountKey,
    message: {error: 'Too many publications in a row. Wait a minute.'},
  });
  const writes = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: accountKey});

  router.get(
    '/loop',
    asyncHandler(async (_req, res) => {
      res.json({on: true});
    }),
  );

  // ── Connections ──
  router.get(
    '/connections',
    asyncHandler(async (_req, res) => {
      const userId = userOf(res);
      const rows = await db.many<ConnectionRow>(
        `SELECT ${CONNECTION_COLUMNS} FROM marketplace_connections c WHERE c.user_id=$1 ORDER BY c.created_at,c.id`,
        [userId],
      );
      res.json({connections: rows.map(connectionOf)});
    }),
  );
  router.post(
    '/connections',
    keyChecks,
    asyncHandler(async (req, res) => {
      const userId = userOf(res);
      const input = connectionSchema.parse(req.body);
      const secret = secretOf(input);
      // Sealed first: without the server's key nothing is sent to the marketplace.
      const sealed = sealSecret(userId, secret);
      const count = (await db.one<{n: number}>(
        'SELECT count(*)::int AS n FROM marketplace_connections WHERE user_id=$1',
        [userId],
      ))!.n;
      if (count >= MAX_CONNECTIONS) fail(409, 'too_many', `You can connect up to ${MAX_CONNECTIONS} shops.`);
      await checkKey(secret);
      const id = randomUUID(),
        now = iso(loopNow());
      const hint = hintOf(secret);
      const label = input.label || `${LOOP_MARKETPLACE_NAMES[input.marketplace]} ${hint}`.slice(0, 80);
      await db.execute(
        `INSERT INTO marketplace_connections(id,user_id,marketplace,label,secret,hint,status,checked_at,created_at) VALUES($1,$2,$3,$4,$5,$6,'ok',$7,$7)`,
        [id, userId, input.marketplace, label, sealed, hint, now],
      );
      res.status(201).json({connection: connectionOf((await readConnection(userId, id))!)});
    }),
  );
  // "Reconnect": a new key for a connection the marketplace refused (or any); its links and numbers stay.
  router.post(
    '/connections/:id/key',
    keyChecks,
    asyncHandler(async (req, res) => {
      const userId = userOf(res);
      const row = (await readConnection(userId, idParam(req))) ?? fail(404, 'not_found', NO_CONNECTION);
      const input = connectionSchema.parse({...req.body, marketplace: row.marketplace});
      const secret = secretOf(input);
      const sealed = sealSecret(userId, secret);
      await checkKey(secret);
      await db.execute(
        "UPDATE marketplace_connections SET secret=$3,hint=$4,status='ok',last_error=NULL,checked_at=$5,synced_at=NULL WHERE id=$1 AND user_id=$2",
        [row.id, userId, sealed, hintOf(secret), iso(loopNow())],
      );
      res.json({connection: connectionOf((await readConnection(userId, row.id))!)});
    }),
  );
  router.delete(
    '/connections/:id',
    writes,
    asyncHandler(async (req, res) => {
      const {changes} = await db.execute('DELETE FROM marketplace_connections WHERE id=$1 AND user_id=$2', [
        idParam(req),
        userOf(res),
      ]);
      if (!changes) fail(404, 'not_found', NO_CONNECTION);
      res.json({ok: true});
    }),
  );
  router.get(
    '/connections/:id/products',
    searches,
    asyncHandler(async (req, res) => {
      const userId = userOf(res);
      const row = (await readConnection(userId, idParam(req))) ?? fail(404, 'not_found', NO_CONNECTION);
      if (row.status === 'refused')
        fail(409, 'connection_refused', row.last_error ?? 'The marketplace rejected the key. Reconnect the shop.');
      const query = z
        .string()
        .trim()
        .max(100)
        .parse(String(req.query.q ?? ''));
      try {
        const products: LoopProduct[] = await (
          await marketplaceAdapters()
        )[row.marketplace].search(openSecret(userId, row.secret), query);
        res.json({products: products.slice(0, 20)});
      } catch (error) {
        if (!isMarketplaceError(error)) throw error;
        fail(
          error.kind === 'refused' ? 409 : 503,
          error.kind === 'refused' ? 'connection_refused' : 'marketplace_unavailable',
          error.message,
          error.kind !== 'refused',
        );
      }
    }),
  );

  // ── Card links ──
  router.post(
    '/links',
    writes,
    asyncHandler(async (req, res) => {
      const userId = userOf(res);
      const input = z
        .object({
          fileId: z.string().regex(/^[0-9a-f-]{36}$/),
          nodeId,
          connectionId: z.string().regex(/^[0-9a-f-]{36}$/),
          productId: z
            .string()
            .trim()
            .regex(/^\d{1,20}$/, 'The product number consists of digits.'),
          slot: z.coerce.number().int().min(1).max(SLOT_MAX, `The photo number is from 1 to ${SLOT_MAX}.`),
        })
        .parse(req.body);
      await fileAccess(db, userId, input.fileId, 'edit');
      const connection = (await readConnection(userId, input.connectionId)) ?? fail(404, 'not_found', NO_CONNECTION);
      if (connection.status === 'refused')
        fail(409, 'connection_refused', 'The marketplace rejected the key. Reconnect the shop.');
      // The product as the marketplace knows it: a pasted number is checked, and the SKU Ozon counts by is learnt.
      let product: LoopProduct | null;
      try {
        product = await (
          await marketplaceAdapters()
        )[connection.marketplace].product(openSecret(userId, connection.secret), input.productId);
      } catch (error) {
        if (!isMarketplaceError(error)) throw error;
        return fail(
          error.kind === 'refused' ? 409 : 503,
          'marketplace_unavailable',
          error.message,
          error.kind !== 'refused',
        );
      }
      if (!product) fail(404, 'product_not_found', `The shop has no product ${input.productId}.`);
      const id = randomUUID();
      // A frame stands for one slot: linking it again moves it. A frame a co-editor linked stays theirs (their tests and history
      // follow it); it is unlinked first.
      const {changes} = await db.execute(
        `INSERT INTO marketplace_card_links(id,user_id,file_id,node_id,connection_id,product_id,sku,title,slot,created_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT(file_id,node_id) DO UPDATE SET connection_id=excluded.connection_id,product_id=excluded.product_id,
           sku=excluded.sku,title=excluded.title,slot=excluded.slot WHERE marketplace_card_links.user_id=excluded.user_id`,
        [
          id,
          userId,
          input.fileId,
          input.nodeId,
          connection.id,
          product!.productId,
          product!.sku,
          product!.title,
          input.slot,
          iso(loopNow()),
        ],
      );
      if (!changes) fail(409, 'already_linked', 'Another member of the file linked this frame to a product.');
      // Its numbers are read on the worker's next pass.
      await db.execute('UPDATE marketplace_connections SET synced_at=NULL WHERE id=$1', [connection.id]);
      const row = await db.one<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM marketplace_card_links l JOIN marketplace_connections c ON c.id=l.connection_id WHERE l.file_id=$1 AND l.node_id=$2`,
        [input.fileId, input.nodeId],
      );
      res.status(201).json({link: linkOf(row!)});
    }),
  );
  // The link follows another frame of the file (the next round starts from the winner); its publications keep their own frames.
  router.post(
    '/links/:id/node',
    writes,
    asyncHandler(async (req, res) => {
      const userId = userOf(res);
      const {nodeId: target} = z.object({nodeId}).parse(req.body);
      const link = (await readLink(db, userId, idParam(req))) ?? fail(404, 'not_found', 'Link not found.');
      await fileAccess(db, userId, link.file_id, 'edit');
      if (
        await db.one('SELECT 1 FROM marketplace_card_links WHERE file_id=$1 AND node_id=$2 AND id<>$3', [
          link.file_id,
          target,
          link.id,
        ])
      )
        fail(409, 'already_linked', 'This frame is already linked to another product.');
      await db.execute('UPDATE marketplace_card_links SET node_id=$2 WHERE id=$1', [link.id, target]);
      const row = await db.one<LinkRow>(
        `SELECT ${LINK_COLUMNS} FROM marketplace_card_links l JOIN marketplace_connections c ON c.id=l.connection_id WHERE l.id=$1`,
        [link.id],
      );
      res.json({link: linkOf(row!)});
    }),
  );
  router.delete(
    '/links/:id',
    writes,
    asyncHandler(async (req, res) => {
      const {changes} = await db.execute('DELETE FROM marketplace_card_links WHERE id=$1 AND user_id=$2', [
        idParam(req),
        userOf(res),
      ]);
      if (!changes) fail(404, 'not_found', 'Link not found.');
      res.json({ok: true});
    }),
  );

  // ── Publishing ──
  router.post(
    '/publish',
    publishes,
    pictures([{name: 'image', maxCount: 1}]),
    asyncHandler(async (req, res) => {
      const userId = userOf(res);
      const {linkId} = z.object({linkId: z.string().regex(/^[0-9a-f-]{36}$/)}).parse(req.body);
      const image = fileOf(req, 'image') ?? fail(400, 'invalid_request', 'No picture.');
      const link = (await readLink(db, userId, linkId)) ?? fail(404, 'not_found', 'The card is not linked to a product.');
      await fileAccess(db, userId, link.file_id, 'edit');
      if (link.connection_status === 'refused')
        fail(409, 'connection_refused', 'The marketplace rejected the key. Reconnect the shop.');
      res.json({publication: await publishPicture({userId, link, nodeId: link.node_id, testId: null, bytes: image})});
    }),
  );

  // ── Numbers ──
  router.get(
    '/files/:fileId/cards',
    asyncHandler(async (req, res) => {
      const userId = userOf(res);
      const fileId = idParam(req, 'fileId');
      const cards = await db.transaction(
        async tx => {
          await fileAccess(tx, userId, fileId, 'view');
          return readFileCards(tx, userId, fileId, loopNow());
        },
        {readOnly: true, isolation: 'repeatable read'},
      );
      res.set('Cache-Control', 'no-store').json(cards);
    }),
  );

  // ── A/B tests ──
  router.post(
    '/tests',
    publishes,
    pictures([
      {name: 'a', maxCount: 1},
      {name: 'b', maxCount: 1},
    ]),
    asyncHandler(async (req, res) => {
      const userId = userOf(res);
      const input = z
        .object({
          linkId: z.string().regex(/^[0-9a-f-]{36}$/),
          variantB: nodeId,
          mode: z.enum(['cabinet', 'rotation']),
          days: days.default(DEFAULT_TEST_DAYS),
          swapHours: z.coerce
            .number()
            .int()
            .refine(value => ROTATION_SWAP_HOURS.includes(value), 'Pictures are swapped every 1, 2 or 3 days.')
            .optional(),
        })
        .parse(req.body);
      const link =
        (await readLink(db, userId, input.linkId)) ?? fail(404, 'not_found', 'The card is not linked to a product.');
      await fileAccess(db, userId, link.file_id, 'edit');
      const a = fileOf(req, 'a'),
        b = fileOf(req, 'b');
      const test = await createTest(
        userId,
        {
          linkId: input.linkId,
          variantB: input.variantB,
          mode: input.mode,
          days: input.days,
          swapHours: input.mode === 'rotation' ? (input.swapHours ?? 24) : null,
        },
        a && b ? {a, b} : null,
      );
      res.status(201).json({test});
    }),
  );
  router.post(
    '/tests/:id/start',
    writes,
    asyncHandler(async (req, res) => {
      const {startedOn} = z
        .object({
          startedOn: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter the start date.')
            .nullish(),
        })
        .parse(req.body ?? {});
      res.json({test: await startCabinetTest(userOf(res), idParam(req), startedOn ?? null)});
    }),
  );
  router.post(
    '/tests/:id/winner',
    writes,
    asyncHandler(async (req, res) => {
      const {winner} = z.object({winner: z.enum(['a', 'b', 'none'])}).parse(req.body);
      res.json({test: await finishCabinetTest(userOf(res), idParam(req), winner)});
    }),
  );
  router.post(
    '/tests/:id/stop',
    writes,
    asyncHandler(async (req, res) => {
      res.json({test: await stopTest(userOf(res), idParam(req))});
    }),
  );
  return router;
}

/** GET /api/marketplace-media/<token>.<jpg|png|webp>: a published picture while its link lasts, to anyone holding the link. */
export function createMarketplaceMediaRouter(): Router {
  const router = Router();
  const downloads = limitRequests({windowMs: ONE_MINUTE_MS, limit: 300});
  router.get(
    '/:name',
    downloads,
    asyncHandler(async (req, res) => {
      const match = /^([A-Za-z0-9_-]{43})\.(jpg|png|webp)$/.exec(String(req.params.name));
      const file = match && marketplaceApiOn() ? await mediaForToken(db, match[1]!, match[2]!, Date.now()) : null;
      if (!file) return void res.status(404).json({error: 'Picture not found or the link has expired.'});
      res.set({
        'Cache-Control': 'private, max-age=600',
        'X-Robots-Tag': 'noindex',
        'Content-Type': contentTypeOf(file),
      });
      res.sendFile(file, {dotfiles: 'deny', cacheControl: false, headers: {'Content-Type': contentTypeOf(file)}});
    }),
  );
  return router;
}
