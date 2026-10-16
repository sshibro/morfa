import express, {Router, type NextFunction, type Request, type RequestHandler, type Response} from 'express';
import multer from 'multer';
import {z} from 'zod';
import {requireAuth} from '../auth';
import {captureCustomerAuthority} from '../customer-authority';
import {asyncHandler} from '../http';
import {limitRequests} from '../rate-limit';
import {ONE_MINUTE_MS} from '../time-constants';
import {multipartImageName, slotGate} from '../upload-storage';
import {REQUEST_BODY_WINDOW_MS, REQUEST_TOO_SLOW} from '../request-window';
import {DESIGN_DOCUMENT_CAPS} from '../../shared/design/limits';
import {bigFilesEnabled, documentCaps, tooLargeMessage, type DocumentCaps} from '../../shared/design/big-files';
import {DESIGN_PATCH_MAX_BYTES} from '../../shared/design/document-limits';
import {DESIGN_LIVE} from '../../shared/design/live';
import {digest, sessionToken} from '../auth';
import {createDesignCommentsRouter, DESIGN_COMMENT_BODY_BYTES} from './comments-router';
import {isDesignFailure} from './errors';
import {designToolAvailable, designToolEnabled} from './flag';
import * as files from './files';
import {readFastPut} from './document-fast';
import {checkpointAnswer, checkpointEncoding} from './document-checkpoint';
import {mountTemplateRoutes} from './template-router';
import {mountLibraryRoutes} from './library-router';
import {PDF_EXPORT_LIMITS, readMeasurements} from '../../shared/design/pdf-export';
import {openStream, streamRoom, updatePresence} from './live/hub';
import {createDesignMeetingRouter, meetingPresenceSchema} from './meeting/router';
import {createLinkPreviewRouter} from './link-preview';
import {exportDesignPdf} from './pdf/export';
import {designPdfExportEnabled, designPdfRenderer, designPdfRenderMs, designRasterEngine} from './pdf/flag';
import {RASTER_EXPORT_LIMITS, exportDesignRaster} from './raster-export';
import {openCollabSession} from './collab/session';
import * as sharing from './file-sharing';
import {imageUrl} from './images';
import {DESIGN_FILE_GUEST_ROLES, DESIGN_FILE_LINK_ACCESS} from '../../shared/design/teams';

// `/api/design-files` (docs/design-tool.md §Server API). Mounted after the app's Origin guard; the app's own JSON
// reader skips these paths, so each route reads its body here, after the session check, with its own cap.

const UNAVAILABLE = {error: 'Design is unavailable.', code: 'design_unavailable'};
/** A whole document plus its wrapper (`{baseVersion, document}`) in JSON, for the caps in force. */
const documentBodyBytes = (caps = documentCaps()) => caps.bytes + 1024 * 1024;
const SMALL_BODY_BYTES = 64 * 1024;

const version = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const clientId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
const shortText = z.string().max(1_000);

const failure = (status: number, code: string, message: string) => Object.assign(new Error(message), {status, code});

/** The slowest a body may arrive (about 0.5 Mbit/s) and the least time any body gets. */
export const DESIGN_BODY_MIN_BYTES_PER_SECOND = 64 * 1024;
export const DESIGN_BODY_MIN_WINDOW_MS = 15_000;
/** How long a body of a route whose cap is `capBytes` may take to arrive: its declared length (never more than the
 * cap; the cap when it declares none) at the slowest rate, between 15 seconds and the app's five minutes. A few
 * kilobytes of autosave get 15 seconds, a 20 MB document five minutes. */
export function designBodyWindowMs(capBytes: number, declaredBytes: number): number {
  const bytes = declaredBytes > 0 ? Math.min(declaredBytes, capBytes) : capBytes;
  return Math.min(REQUEST_BODY_WINDOW_MS, Math.max(DESIGN_BODY_MIN_WINDOW_MS, Math.ceil((bytes / DESIGN_BODY_MIN_BYTES_PER_SECOND) * 1000)));
}

/**
 * Reads a body within its window (`designBodyWindowMs`): a body that has not arrived in time is answered 408 and
 * its connection closed, so a slow sender holds its own account's place only that long. `read` gets a callback
 * that runs once, when the reader finishes; after a 408 it never does.
 */
function withinWindow(capBytes: number, read: (req: Request, res: Response, done: (error?: unknown) => void) => void): RequestHandler {
  return (req, res, next) => {
    let expired = false;
    const timer = req.complete
      ? null
      : setTimeout(() => {
          if (req.complete || res.headersSent) return;
          expired = true;
          res.once('finish', () => req.destroy());
          res.status(408).set('Connection', 'close').json({error: REQUEST_TOO_SLOW, code: 'request_timeout', retryable: true});
        }, designBodyWindowMs(capBytes, Number(req.headers['content-length']) || 0));
    timer?.unref();
    res.once('close', () => timer && clearTimeout(timer));
    read(req, res, error => {
      if (timer) clearTimeout(timer);
      if (!expired) next(error);
    });
  };
}

/** A body reader whose refusals are in the API's words: a body over its cap is 413 with `code`. `tooLarge` may name the body's
 *  size (a document's: "File — 27.4 MB, the limit is 20 MB"). */
function body(parser: RequestHandler, capBytes: number, tooLarge: string | ((bytes: number | undefined) => string), code = 'invalid_request'): RequestHandler {
  return withinWindow(capBytes, (req, res, done) =>
    parser(req, res, (error?: unknown) => {
      if (!error) return done();
      const type = (error as {type?: string}).type;
      if (type === 'entity.too.large') {
        const length = Number((error as {length?: unknown}).length);
        return done(failure(413, code, typeof tooLarge === 'string' ? tooLarge : tooLarge(Number.isFinite(length) && length > 0 ? length : undefined)));
      }
      if (type === 'entity.parse.failed' || type === 'encoding.unsupported' || type === 'charset.unsupported')
        return done(failure(400, 'invalid_request', 'Could not read the request data.'));
      done(error);
    }),
  );
}
const json = (limit: number, tooLarge: string | ((bytes: number | undefined) => string), code?: string) => body(express.json({limit}), limit, tooLarge, code);
/** A document body's refusal with its size: the body is the document and a few bytes around it. */
const documentTooLarge = (caps: DocumentCaps) => (bytes: number | undefined) => tooLargeMessage(caps, bytes);
const documentBodies = {
  fixed: json(documentBodyBytes(DESIGN_DOCUMENT_CAPS), documentTooLarge(DESIGN_DOCUMENT_CAPS), 'design_document_too_large'),
  big: null as RequestHandler | null,
};
/** The document reader for the caps in force: the big-files switch (shared/design/big-files.ts) is read per request. */
const documentBody: RequestHandler = (req, res, next) => {
  if (!bigFilesEnabled()) return documentBodies.fixed(req, res, next);
  const caps = documentCaps();
  documentBodies.big ??= json(documentBodyBytes(caps), documentTooLarge(caps), 'design_document_too_large');
  return documentBodies.big(req, res, next);
};
/**
 * A whole document's `PUT` body as bytes (TARGETS S5): the Rust fast path reads it in one pass (document-fast.ts). Same caps,
 * time window and refusals as `documentBody`; a body it declines is then read as `express.json` read it (`jsonOfRaw`).
 */
const rawJson = (limit: number, tooLarge: string | ((bytes: number | undefined) => string), code?: string) =>
  body(express.raw({type: 'application/json', limit}), limit, tooLarge, code);
const rawDocumentBodies = {
  fixed: rawJson(documentBodyBytes(DESIGN_DOCUMENT_CAPS), documentTooLarge(DESIGN_DOCUMENT_CAPS), 'design_document_too_large'),
  big: null as RequestHandler | null,
};
const rawDocumentBody: RequestHandler = (req, res, next) => {
  if (!bigFilesEnabled()) return rawDocumentBodies.fixed(req, res, next);
  const caps = documentCaps();
  rawDocumentBodies.big ??= rawJson(documentBodyBytes(caps), documentTooLarge(caps), 'design_document_too_large');
  return rawDocumentBodies.big(req, res, next);
};
const unreadable = () => failure(400, 'invalid_request', 'Could not read the request data.');
/** A raw JSON body's charset, as `express.json` reads it (`utf-8` by default); 400 for one it does not take. */
function rawCharset(req: Request): string {
  const charset = (/;\s*charset\s*=\s*"?([^";\s]+)/i.exec(req.headers['content-type'] ?? '')?.[1] ?? 'utf-8').toLowerCase();
  if (!charset.startsWith('utf-')) throw unreadable();
  return charset;
}
/** A UTF-8 raw body's bytes without a BOM, for the fast path; undefined for another charset or no body. */
function rawUtf8(req: Request): Buffer | undefined {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return undefined;
  const charset = rawCharset(req);
  if (charset !== 'utf-8' && charset !== 'utf8') return undefined;
  const bom = req.body[0] === 0xef && req.body[1] === 0xbb && req.body[2] === 0xbf;
  return bom ? req.body.subarray(3) : req.body;
}
/** The text of a raw JSON body, decoded as `express.json` decodes it (its charset; a BOM dropped); undefined when there is
 *  none (another content type, an empty body: `express.json` left `{}` then). */
function rawText(req: Request): string | undefined {
  if (!Buffer.isBuffer(req.body) || !req.body.length) return undefined;
  const charset = rawCharset(req);
  try {
    return new TextDecoder(charset, {fatal: false}).decode(req.body);
  } catch {
    throw unreadable();
  }
}
/** `express.json`'s value of a body's text: an object or an array (its strict mode), else 400. */
function jsonOfRaw(text: string | undefined): unknown {
  if (text === undefined) return {};
  const first = /^[\x20\x09\x0a\x0d]*(.)/.exec(text)?.[1];
  if (first !== '{' && first !== '[') throw unreadable();
  try {
    return JSON.parse(text);
  } catch {
    throw unreadable();
  }
}
const patchBody = json(
  DESIGN_PATCH_MAX_BYTES,
  'The change is too large to save in one go.',
  'design_document_too_large',
);
const smallBody = json(SMALL_BODY_BYTES, 'The request is too large.');
/** A presence post: at most DESIGN_LIVE.maxSelection ids of up to 512 characters, and a few numbers. */
const presenceBody = json(128 * 1024, 'The request is too large.');
const coordinate = z.number().finite().min(-1e9).max(1e9);
const layerId = z.string().min(1).max(512);
const presenceSchema = z
  .object({
    token: z.string().min(16).max(64),
    cursor: z.object({x: coordinate, y: coordinate}).strict().nullable().optional(),
    page: layerId.nullable().optional(),
    selection: z.array(layerId).max(DESIGN_LIVE.maxSelection).optional(),
    selectionCount: z.number().int().min(0).max(1_000_000).optional(),
    viewport: z
      .object({x: coordinate, y: coordinate, zoom: z.number().finite().positive().max(1_000), width: z.number().finite().min(0).max(100_000), height: z.number().finite().min(0).max(100_000)})
      .strict()
      .nullable()
      .optional(),
    editing: layerId.nullable().optional(),
    meeting: meetingPresenceSchema.nullable().optional(),
  })
  .strict();
const thumbnailBody = body(
  express.raw({type: ['image/png', 'image/webp'], limit: DESIGN_DOCUMENT_CAPS.thumbnailBytes}),
  DESIGN_DOCUMENT_CAPS.thumbnailBytes,
  `The thumbnail is larger than ${DESIGN_DOCUMENT_CAPS.thumbnailBytes / 1024} KB.`,
);
const imagePart = multer({
  storage: multer.memoryStorage(),
  limits: {fileSize: DESIGN_DOCUMENT_CAPS.imageBytes, files: 1, fields: 0, parts: 2},
}).single('file');

const accountKey = (_req: Request, res: Response) => String(res.locals.user.id);
const actorOf = (req: Request, res: Response) => captureCustomerAuthority(req, res);
const idOf = (req: Request) => String(req.params.id);

/** A held slot is released when the answer is sent or the client goes away. */
function slots(take: (userId: string) => (() => void) | null, message: string, code = 'rate_limited'): RequestHandler {
  return (_req, res, next) => {
    const release = take(String(res.locals.user.id));
    if (!release) {
      res.status(429).json({error: message, code, retryable: true});
      return;
    }
    res.once('finish', release);
    res.once('close', release);
    next();
  };
}

/**
 * Simultaneous requests of one kind in two gates: `account` (at most `perAccount` of one account), taken before the
 * body is read, and `server` (at most `platform` on the server), taken only once the body has arrived, for the
 * parsing and the work. A slow sender then holds a place of its own account for its body's window, never one of
 * the server's: it cannot keep everyone else's saves waiting.
 */
function gates(perAccount: number, platform: number, message: string): {account: RequestHandler; server: RequestHandler} {
  const accounts = slotGate(perAccount, Number.MAX_SAFE_INTEGER),
    server = slotGate(platform, platform);
  return {account: slots(accounts, message), server: slots(() => server('server'), message)};
}

export function createDesignFilesRouter(): Router {
  const router = Router();
  // Off for the platform: nothing answers, signed in or not.
  router.use((_req, res, next) => (designToolEnabled() ? next() : res.status(404).json(UNAVAILABLE)));
  // Presence (cursor, selection, viewport) of an open live stream, many times a second: authorized by the stream's secret
  // and the same session cookie that opened it, which the stream re-checks against the database (no read per post).
  router.post(
    '/:id/presence',
    presenceBody,
    (req, res) => {
      // A pointer moving is not an action: no row of the activity journal (admin/telemetry.ts `recordActivity` takes the account's
      // lock and reads its last minute before it inserts one; when it took a global lock and counted the whole journal, a few people's
      // cursors filled it in minutes).
      res.locals.notActivity = true;
      const token = sessionToken(req);
      if (!token) {
        res.status(401).json({error: 'Sign in to continue.'});
        return;
      }
      const post = presenceSchema.safeParse(req.body);
      if (!post.success) {
        res.status(400).json({error: 'Check the request data.', code: 'invalid_request'});
        return;
      }
      const result = updatePresence(idOf(req), digest(token), post.data, !!res.locals.sessionUser);
      if (result === 'ok') res.status(204).end();
      else if (result === 'limited') res.status(429).json({error: 'Too many requests.', code: 'rate_limited', retryable: true});
      else res.status(404).json({error: 'The connection is closed.', code: 'design_live_gone'});
    },
  );
  // The session and the account the tab expects (X-Forma-Account): 401 / 409 before any body is read.
  router.use(requireAuth);
  router.use((_req, res, next) => (designToolAvailable(res.locals.user) ? next() : res.status(404).json(UNAVAILABLE)));

  const documentWrites = limitRequests({windowMs: 10 * ONE_MINUTE_MS, limit: 600, keyGenerator: accountKey});
  const otherWrites = limitRequests({windowMs: ONE_MINUTE_MS, limit: 120, keyGenerator: accountKey});
  const pictureWrites = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: accountKey});
  // Requests that parse, validate and serialize a whole document (up to 20 MB: about a second and a half of the
  // event loop each) for a body that may be a few bytes (a restore): new files, replaces and restores, which people
  // make a few at a time. Autosave patches stay under documentWrites.
  const wholeDocuments = limitRequests({
    windowMs: 10 * ONE_MINUTE_MS,
    limit: 60,
    keyGenerator: accountKey,
    message: {error: 'Too many new files, replacements and restores in a row. Wait a few minutes.'},
  });
  // A document body is parsed in memory: two at a time per account, sixteen on the server (taken once the body is in).
  const heavy = gates(2, 16, 'Wait for the previous save to finish.');
  // Pictures are decoded and encoded: three per account, eight on the server (once the file has arrived).
  const encoding = gates(3, 8, 'Wait for the image upload to finish.');
  // A document read holds the stored text and the answer built from it (about 20 MB each for a large file) until the
  // client has taken it: without a gate, a few hundred parallel reads of one large file exhausted the process's memory.
  const reading = slots(slotGate(4, 32), 'Too many files are opening at once. Try again in a few seconds.');

  router.get(
    '/',
    asyncHandler(async (req, res) => {
      const query = z
        .object({team: z.string().max(64).optional(), project: z.string().max(64).optional()})
        .passthrough()
        .parse(req.query);
      if (query.project !== undefined && query.team === undefined) throw failure(400, 'invalid_request', 'Specify the project\'s team.');
      // "Shared with me": files shared with the caller (file-sharing.ts).
      if (req.query.shared === '1') {
        res.json({files: await sharing.listSharedFiles(actorOf(req, res), imageUrl)});
        return;
      }
      // The list's JSON is written by PostgreSQL (files.ts `listDesignFiles`): it goes out as it is, as GET /:id sends a document.
      res
        .type('application/json; charset=utf-8')
        .send(await files.listDesignFiles(actorOf(req, res), req.query.trash === '1', {teamId: query.team, projectId: query.project}));
    }),
  );
  router.post(
    '/',
    otherWrites,
    wholeDocuments,
    heavy.account,
    documentBody,
    heavy.server,
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          name: shortText.optional(),
          document: z.unknown().optional(),
          clientId: clientId.optional(),
          teamId: z.string().max(64).optional(),
          projectId: z.string().max(64).nullable().optional(),
          kind: z.enum(['design', 'board']).optional(),
        })
        .parse(req.body ?? {});
      const result = await files.createDesignFile(actorOf(req, res), input);
      res.status(result.created ? 201 : 200).json({file: result.file});
    }),
  );
  // "Share" one file (docs/design-tool.md §Teams, "File access"; the routes are listed in shared/design/teams.ts).
  router.get(
    '/:id/sharing',
    asyncHandler(async (req, res) => {
      res.json(await sharing.readFileSharing(actorOf(req, res), idOf(req)));
    }),
  );
  router.patch(
    '/:id/sharing',
    otherWrites,
    smallBody,
    asyncHandler(async (req, res) => {
      const input = z.object({link: z.enum(DESIGN_FILE_LINK_ACCESS as [string, ...string[]])}).strict().parse(req.body ?? {});
      res.json(await sharing.setFileLink(actorOf(req, res), idOf(req), input.link as never));
    }),
  );
  router.patch(
    '/:id/sharing/guests/:userId',
    otherWrites,
    smallBody,
    asyncHandler(async (req, res) => {
      const input = z.object({role: z.enum(DESIGN_FILE_GUEST_ROLES as [string, ...string[]])}).strict().parse(req.body ?? {});
      res.json(await sharing.setFileGuestRole(actorOf(req, res), idOf(req), z.string().max(200).parse(req.params.userId), input.role as never));
    }),
  );
  router.delete(
    '/:id/sharing/guests/:userId',
    otherWrites,
    asyncHandler(async (req, res) => {
      const answer = await sharing.removeFileGuest(actorOf(req, res), idOf(req), z.string().max(200).parse(req.params.userId));
      res.json(answer ?? {ok: true});
    }),
  );
  // The document in the model's binary codec.
  router.get(
    '/:id/checkpoint',
    reading,
    asyncHandler(async (req, res) => {
      const encoding = checkpointEncoding(req.get('accept-encoding'));
      const {file, access, source} = await files.openDesignCheckpoint(actorOf(req, res), idOf(req), encoding);
      const answer = await checkpointAnswer(source, encoding);
      res.status(200);
      res.set({
        'Content-Type': 'application/vnd.morfa.mrfa',
        'Cache-Control': 'private, no-cache',
        Vary: 'Accept-Encoding',
        'X-Design-Version': String(answer.version),
        'X-Design-File-Version': String(file.version),
        'X-Design-File': Buffer.from(JSON.stringify({file, access})).toString('base64url'),
        'X-Design-Checkpoint-Source': answer.source,
        ...(encoding === 'identity' ? {} : {'Content-Encoding': encoding}),
      });
      res.end(answer.body);
    }),
  );
  // Big files (docs/decisions/big-files.md §3): the skeleton, then one page at a time.
  router.get(
    '/:id/pages/:pageId',
    reading,
    asyncHandler(async (req, res) => {
      const pageId = String(req.params.pageId);
      if (!/^[A-Za-z0-9_:;.,-]{1,512}$/.test(pageId)) {
        res.status(400).json({error: 'Check the request data.', code: 'invalid_request'});
        return;
      }
      res.json(await files.readDesignPage(actorOf(req, res), idOf(req), pageId));
    }),
  );
  router.get(
    '/:id',
    reading,
    asyncHandler(async (req, res) => {
      if (req.query.pages === 'skeleton') {
        // `&always=1`: pages on demand even for a file the fixed caps would hold (the e2e of the page machinery on small files).
        res.json(await files.openDesignSkeleton(actorOf(req, res), idOf(req), {always: req.query.always === '1'}));
        return;
      }
      // `?have=<version>`: the version of the document the browser keeps (src/design/editor/checkpoint-cache.ts). Still that
      // version: the file and access without the document, and the browser shows its own copy (lane O's warm open).
      const have = typeof req.query.have === 'string' && /^\d{1,15}$/.test(req.query.have) ? Number(req.query.have) : null;
      const {file, access, documentText} = await files.openDesignFile(actorOf(req, res), idOf(req), have);
      if (documentText === null) {
        res.json({file, access, current: true});
        return;
      }
      // The stored text is valid JSON written by this server: it goes out as it is, without a parse.
      const head = '{"file":' + JSON.stringify(file) + ',"access":' + JSON.stringify(access) + ',"document":';
      res
        .type('application/json; charset=utf-8')
        .send(typeof documentText === 'string' ? head + documentText + '}' : Buffer.concat([Buffer.from(head), documentText, Buffer.from('}')]));
    }),
  );
  router.patch(
    '/:id/document',
    documentWrites,
    heavy.account,
    patchBody,
    heavy.server,
    asyncHandler(async (req, res) => {
      const input = z
        .object({baseVersion: version, patch: z.unknown(), before: z.unknown().optional(), beforeTables: z.unknown().optional(), client: z.string().max(64).nullable().optional()})
        .parse(req.body);
      res.json(await files.patchDesignDocument(actorOf(req, res), idOf(req), input));
    }),
  );
  // Co-editing and presence (docs/design-tool.md "Co-editing"): a text/event-stream of the file's changes
  // after `since` and of who is in it. No slot is held for its life: its own per-account, per-file and server-wide counts.
  const streamOpens = limitRequests({windowMs: ONE_MINUTE_MS, limit: 60, keyGenerator: accountKey});
  router.get(
    '/:id/events',
    streamOpens,
    asyncHandler(async (req, res) => {
      // The operator's switch: without streams the editors still merge their saves and catch up from the answers.
      if (process.env.DESIGN_LIVE === '0') {
        res.status(503).json({error: 'Co-editing is turned off right now.', code: 'design_live_off'});
        return;
      }
      const actor = actorOf(req, res),
        id = idOf(req);
      const since = /^\d{1,15}$/.test(String(req.query.since ?? '')) ? Number(req.query.since) : null;
      const full = () => {
        const refusal = streamRoom(actor.ownerId, id);
        if (refusal) res.status(refusal.status).json({error: refusal.error, code: refusal.code, retryable: true});
        return !!refusal;
      };
      if (full()) return;
      const access = await files.liveAccess(actor, id);
      // The client may have gone, or others took the last place, while access was read.
      if (req.destroyed || res.writableEnded || full()) return;
      openStream(res, {fileId: id, userId: actor.ownerId, sessionHash: actor.sessionHash, name: access.name, access, version: access.version, since});
    }),
  );
  // The socket of the Rust co-editing service (docs/BACKEND.md §2, DESIGN_COLLAB=rust): which node holds the file and a 60 s
  // ticket for it (collab/session.ts). Opens count against the same 60 a minute as the event streams (BACKEND §11).
  router.get(
    '/:id/session',
    streamOpens,
    asyncHandler(async (req, res) => {
      // A ticket is machine traffic (every reconnect asks again): GET /:id already journals the opening of the file.
      res.locals.notActivity = true;
      res.json(await openCollabSession(actorOf(req, res), idOf(req), process.env.APP_ORIGIN || req.get('origin') || null));
    }),
  );
  // The file's co-editing path (DESIGN_COLLAB for its team, holder or the deployment): the editor picks SSE or the socket from it.
  router.get(
    '/:id/collab',
    asyncHandler(async (req, res) => {
      res.locals.notActivity = true;
      res.json(await files.fileCollab(actorOf(req, res), idOf(req)));
    }),
  );
  router.put(
    '/:id/document',
    documentWrites,
    wholeDocuments,
    heavy.account,
    rawDocumentBody,
    heavy.server,
    asyncHandler(async (req, res) => {
      // The Rust fast path (TARGETS S5) on a UTF-8 body; a body it declines goes the way every body went before.
      const bytes = rawUtf8(req);
      const fast = bytes === undefined ? undefined : readFastPut(bytes);
      const baseVersion = fast ? version.safeParse(fast.baseVersion) : undefined;
      if (fast && baseVersion?.success) {
        res.json(await files.replaceFastDocument(actorOf(req, res), idOf(req), baseVersion.data, fast.document));
        return;
      }
      const input = z.object({baseVersion: version, document: z.unknown()}).parse(jsonOfRaw(rawText(req)));
      res.json(await files.replaceDesignDocument(actorOf(req, res), idOf(req), input));
    }),
  );
  router.patch(
    '/:id',
    otherWrites,
    smallBody,
    asyncHandler(async (req, res) => {
      const input = z.object({name: shortText}).parse(req.body);
      res.json({file: await files.renameDesignFile(actorOf(req, res), idOf(req), input.name)});
    }),
  );
  router.post(
    '/:id/duplicate',
    otherWrites,
    asyncHandler(async (req, res) => {
      res.status(201).json({file: await files.duplicateDesignFile(actorOf(req, res), idOf(req))});
    }),
  );
  // "Duplicate to drafts": a copy in the caller's drafts, also of a file in the trash (files.ts duplicateDesignFileToDrafts).
  router.post(
    '/:id/duplicate-to-drafts',
    otherWrites,
    asyncHandler(async (req, res) => {
      res.status(201).json({file: await files.duplicateDesignFileToDrafts(actorOf(req, res), idOf(req))});
    }),
  );
  router.delete(
    '/:id',
    otherWrites,
    asyncHandler(async (req, res) => {
      const actor = actorOf(req, res);
      if (req.query.permanent === '1') await files.eraseDesignFile(actor, idOf(req));
      else await files.trashDesignFile(actor, idOf(req));
      res.json({ok: true});
    }),
  );
  // Between a team's projects, into a team, or back to the caller's personal files (docs/design-tool.md §Teams).
  router.post(
    '/:id/move',
    otherWrites,
    heavy.account,
    smallBody,
    heavy.server,
    asyncHandler(async (req, res) => {
      const input = z
        .object({teamId: z.string().max(64).nullable(), projectId: z.string().max(64).nullable().optional()})
        .strict()
        .parse(req.body);
      res.json({file: await files.moveDesignFile(actorOf(req, res), idOf(req), input)});
    }),
  );
  router.post(
    '/:id/restore',
    otherWrites,
    asyncHandler(async (req, res) => {
      res.json({file: await files.restoreDesignFile(actorOf(req, res), idOf(req))});
    }),
  );
  router.put(
    '/:id/thumbnail',
    pictureWrites,
    encoding.account,
    thumbnailBody,
    encoding.server,
    asyncHandler(async (req, res) => {
      if (!Buffer.isBuffer(req.body) || !req.body.length)
        throw failure(415, 'invalid_request', 'The thumbnail must be a PNG or WebP image.');
      res.json(await files.storeDesignThumbnail(actorOf(req, res), idOf(req), req.body));
    }),
  );
  router.post(
    '/:id/images',
    pictureWrites,
    encoding.account,
    withinWindow(DESIGN_DOCUMENT_CAPS.imageBytes + 64 * 1024, (req, res, next) =>
      imagePart(req, res, error => {
        if (!error) return next();
        if (error instanceof multer.MulterError)
          return next(
            error.code === 'LIMIT_FILE_SIZE'
              ? failure(
                  413,
                  'invalid_request',
                  `The image is larger than ${DESIGN_DOCUMENT_CAPS.imageBytes / 1024 / 1024} MB.`,
                )
              : failure(400, 'invalid_request', 'Choose one image.'),
          );
        next(error);
      }),
    ),
    encoding.server,
    asyncHandler(async (req, res) => {
      if (!req.file) throw failure(400, 'invalid_request', 'Choose an image.');
      res.json(
        await files.storeDesignImage(
          actorOf(req, res),
          idOf(req),
          req.file.buffer,
          multipartImageName(req.file.originalname),
        ),
      );
    }),
  );
  // Vector PDF (docs/design-tool.md §Export): printed by the server's sandboxed Chromium from the stored document. Viewers
  // and developers export too (fileAccess 'view'). Ten a minute per account, one at a time per account (taken before the
  // body) and two on the server (once it has arrived): a print holds a browser page and up to a minute of CPU.
  const pdfExports = limitRequests({
    windowMs: ONE_MINUTE_MS,
    limit: 10,
    keyGenerator: accountKey,
    message: {error: 'Too many PDFs in a row. Wait a minute.'},
  });
  const pdfAccount = slots(slotGate(1, Number.MAX_SAFE_INTEGER), 'This account\'s PDF is still being built. Wait for it.');
  const pdfPrinters = slotGate(2, 2);
  const pdfServer = slots(() => pdfPrinters('server'), 'The server is building other PDFs right now. Try again in a few seconds.', 'design_pdf_busy');
  const pdfBody = json(
    PDF_EXPORT_LIMITS.bodyBytes,
    'Too much text for one PDF. Export fewer frames at a time.',
    'design_pdf_too_large',
  );
  // PNG/JPG/WebP painted by the render service (lane L4's vello_cpu; ./raster-export.ts) when DESIGN_RASTER_ENGINE says
  // `service`; otherwise 404 `design_raster_unavailable` and the editor paints the export itself. The PDF's limiters
  // stand in front: ten a minute and one at a time per account, the server's slots.
  router.post(
    '/:id/export/raster',
    (_req, res, next) => {
      if (designRasterEngine() === 'service') return next();
      res.status(404).json({error: 'Image export on the render server is turned off.', code: 'design_raster_unavailable'});
    },
    pdfExports,
    pdfAccount,
    json(64 * 1024, 'Too many layers for one export.', 'design_raster_too_large'),
    pdfServer,
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          version,
          nodeIds: z.array(z.string().min(1).max(256)).min(1).max(RASTER_EXPORT_LIMITS.layers),
          format: z.enum(['png', 'jpeg', 'webp']),
          scale: z.number().positive().max(RASTER_EXPORT_LIMITS.maxScale).optional(),
          maxSide: z.number().int().positive().max(RASTER_EXPORT_LIMITS.maxSide).optional(),
          quality: z.number().int().min(1).max(100).optional(),
        })
        .strict()
        .parse(req.body);
      const result = await exportDesignRaster(actorOf(req, res), idOf(req), input, {timeoutMs: designPdfRenderMs()});
      res
        .status(200)
        .set({
          'Content-Type': result.contentType,
          'Content-Disposition': `attachment; filename="export.${input.format === 'jpeg' ? 'jpg' : input.format}"`,
          'Cache-Control': 'no-store',
          'X-Design-Raster-Engine': 'service',
          'X-Design-Raster-Pixels': String(result.rasterPixels),
          'X-Design-Raster-Missing-Fonts': encodeURIComponent(JSON.stringify(result.missingFonts)),
        })
        .send(result.body);
    }),
  );
  router.post(
    '/:id/export/pdf',
    (_req, res, next) => {
      if (designPdfExportEnabled() && designPdfRenderer() === 'rust') {
        res.status(503).json({error: 'Vector PDF on the render server is not ready yet. Save a raster PDF.', code: 'design_pdf_unavailable'});
        return;
      }
      if (designPdfExportEnabled()) return next();
      res.status(404).json({error: 'Vector PDF is turned off on this server.', code: 'design_pdf_unavailable'});
    },
    pdfExports,
    pdfAccount,
    pdfBody,
    pdfServer,
    asyncHandler(async (req, res) => {
      const input = z
        .object({
          version,
          nodeIds: z.array(z.string().min(1).max(256)).min(1).max(1_000),
          title: shortText.optional(),
          measurements: z.unknown(),
        })
        .strict()
        .parse(req.body);
      if (new Set(input.nodeIds).size > PDF_EXPORT_LIMITS.pages)
        throw failure(413, 'design_pdf_too_large', `One PDF holds at most ${PDF_EXPORT_LIMITS.pages} pages. Export the frames in parts.`);
      const measurements = readMeasurements(input.measurements);
      if (!measurements) throw failure(400, 'invalid_request', 'Check the request data.');
      const result = await exportDesignPdf(actorOf(req, res), idOf(req), {...input, measurements}, {timeoutMs: designPdfRenderMs()});
      res
        .status(200)
        .set({
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="export.pdf"',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'X-Design-Pdf-Pages': String(result.pages),
          'X-Design-Pdf-Engine': result.engine,
          'X-Design-Pdf-Unmeasured': String(result.unmeasured),
          'X-Design-Pdf-Missing-Fonts': encodeURIComponent(JSON.stringify(result.missingFonts.slice(0, 20))),
        })
        .send(result.pdf);
    }),
  );
  router.get(
    '/:id/versions',
    asyncHandler(async (req, res) => {
      res.json({versions: await files.listDesignVersions(actorOf(req, res), idOf(req))});
    }),
  );
  router.post(
    '/:id/versions',
    otherWrites,
    heavy.account,
    smallBody,
    heavy.server,
    asyncHandler(async (req, res) => {
      const input = z.object({label: shortText}).parse(req.body);
      res.status(201).json({version: await files.saveDesignVersion(actorOf(req, res), idOf(req), input.label)});
    }),
  );
  router.get(
    '/:id/versions/:versionId',
    reading,
    asyncHandler(async (req, res) => {
      const text = await files.readDesignVersion(actorOf(req, res), idOf(req), String(req.params.versionId));
      res.type('application/json').send('{"document":' + text + '}');
    }),
  );
  router.post(
    '/:id/versions/:versionId/restore',
    documentWrites,
    wholeDocuments,
    heavy.account,
    smallBody,
    heavy.server,
    asyncHandler(async (req, res) => {
      const input = z.object({baseVersion: version}).parse(req.body);
      res.json(
        await files.restoreDesignVersion(actorOf(req, res), idOf(req), String(req.params.versionId), input.baseVersion),
      );
    }),
  );
  router.patch(
    '/:id/versions/:versionId',
    otherWrites,
    smallBody,
    asyncHandler(async (req, res) => {
      const input = z.object({label: shortText}).parse(req.body);
      res.json({version: await files.renameDesignVersion(actorOf(req, res), idOf(req), String(req.params.versionId), input.label)});
    }),
  );
  router.post(
    '/:id/versions/:versionId/duplicate',
    otherWrites,
    wholeDocuments,
    heavy.account,
    smallBody,
    heavy.server,
    asyncHandler(async (req, res) => {
      const input = z.object({name: shortText.optional()}).parse(req.body ?? {});
      res.status(201).json({file: await files.duplicateDesignVersion(actorOf(req, res), idOf(req), String(req.params.versionId), input)});
    }),
  );
  // Comments (docs/design-tool.md §Teams "Comments"): their own limits, small bodies read here.
  router.use('/:id/comments', createDesignCommentsRouter({body: json(DESIGN_COMMENT_BODY_BYTES, 'The comment is too long.'), reading}));
  // "Meeting": the shared timer and voting sessions (docs/board-meeting.md); small bodies read here.
  router.use('/:id/meeting', createDesignMeetingRouter({body: json(4 * 1024, 'The request is too large.')}));
  router.use('/:id/link-preview', createLinkPreviewRouter());
  // Shared libraries: the file's own and those of its place (docs/design-tool.md §Teams).
  mountLibraryRoutes(router, {otherWrites, wholeDocuments, heavy, reading, json: (limit, tooLarge) => json(limit, tooLarge)});
  mountTemplateRoutes(router, {otherWrites, json: (limit, tooLarge) => json(limit, tooLarge)});
  router.use((_req, res) => res.status(404).json({error: 'Route not found.', code: 'not_found'}));
  // Errors in the API's shape, with the extra fields the client branches on (`currentVersion`, `path`, `limit`).
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    if (error instanceof z.ZodError) {
      res
        .status(400)
        .json({error: 'Check the request data.', code: 'invalid_request', requestId: res.locals.requestId});
      return;
    }
    if (!isDesignFailure(error) || error.status >= 500) return next(error);
    res
      .status(error.status)
      .json({...error.extra, error: error.message, code: error.code, requestId: res.locals.requestId});
  });
  return router;
}
