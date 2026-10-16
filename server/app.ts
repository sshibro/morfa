// Morfa's HTTP application: the account and sign-in routes and the design tool's routers, nothing else. The design tool is the product, so
// no switch hides it here (server/index.ts keeps the design code's own ENABLE_DESIGN_TOOL on). Listening and shutdown live in
// server/index.ts; tests import this module and listen on a port of their own.
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import multer from 'multer';
import {z} from 'zod';
import {db, dataDir} from './db';
import {prepared} from './postgresql/client';
import {accountChanged, currentUser, requestUser} from './auth';
import {asyncHandler} from './http';
import {REQUEST_TOO_SLOW, requestBodyWindow} from './request-window';
import {captureError, context, recordActivity, safeRoute} from './admin/telemetry';
import {isOperator, operatorGate} from './admin/operators';
import {createAdminRouter} from './admin/router';
import {createAccountsRouter, createSettingsRouter} from './accounts';
import {createDesignFilesRouter} from './design/router';
import {createDesignFavouritesRouter} from './design/favourites';
import {createDesignTeamsRouter} from './design/team-router';
import {createDesignTemplatesRouter} from './design/template-router';
import {designToolAvailable} from './design/flag';
import {guestPicturesSql} from './design/file-access';
import {designPdfAvailable, designRasterAvailable} from './design/pdf/flag';
import {drainServerThumbnails} from './design/thumbnails';
import {bigFilesEnabled} from '../shared/design/big-files';
import {collabConfigFor} from './design/collab/switch';
import {createCollabInternalRouter} from './design/collab/internal-router';
import {httpMetrics} from './observability/metrics';
import {traceControlPlane} from './observability/tracing';
import {createSupportRouter} from './support/router';
import {createSupportAdminRouter} from './support/admin-router';
import {supportChatEnabled} from './support/config';
import {drainSupportNotifications} from './support/notify';
import {mcpAvailable, mcpResourceUrl} from './mcp/config';
import {createMcpConnectionsRouter} from './mcp/connections-router';
import {createMarketplaceMediaRouter, createMarketplaceRouter} from './marketplace/router';
import {createMcpOAuthRouter} from './mcp/oauth/router';
import {createMcpRouter} from './mcp/router';

export const app = express();
const prod = process.env.NODE_ENV === 'production';
/** Development origins of the app (Vite on 5400, the API on 3400); production names its one origin in APP_ORIGIN. */
const DEV_ORIGINS = [
  'http://127.0.0.1:5400',
  'http://localhost:5400',
  'http://127.0.0.1:3400',
  'http://localhost:3400',
];
const JSON_LIMIT = '4mb';
const SERVER_ERROR = 500;

app.disable('x-powered-by');
// No ETag from res.send/res.json/res.sendFile: every /api and /uploads answer is `Cache-Control: no-store`, so the SHA-1 of each body
// (a file list is ~55 KB) was never used (lane A7). index.html keeps Last-Modified (production's Caddy serves it anyway); /fonts and
// /assets are serve-static's, whose own ETag this does not change.
app.set('etag', false);
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);
// Five minutes for a request to arrive (server/request-window.ts); Morfa has no long file imports yet.
app.use(requestBodyWindow({isUpload: () => false, uploadMessage: REQUEST_TOO_SLOW}));
app.use(helmet({contentSecurityPolicy: false, crossOriginEmbedderPolicy: false}));
// Request timings (METRICS_PORT's /metrics) and the control plane's OTLP spans (server/observability, lane B5).
app.use(httpMetrics, traceControlPlane);
// The MCP server (ENABLE_MCP_SERVER, docs/mcp-server.md): /mcp, its sign-in under /oauth and their well-known documents, each reading
// its own body (before the JSON reader below). Off, every one of these paths falls through to what answers an unknown path.
app.use(createMcpOAuthRouter(), createMcpRouter());

// The design files' routes read their own bodies, each with its own cap (a document is up to 20 MB), after the session check; so does
// the design agent (a conversation's signed state and a picture, up to 8 MB).
const readJsonBody = express.json({limit: JSON_LIMIT});
app.use((req, res, next) =>
  /^\/api\/design-(?:files|agent)(?:\/|$)/.test(req.path) ? next() : readJsonBody(req, res, next),
);
app.use(cookieParser());

// Every request gets an id and a context; a signed-in account's successful requests go to the activity journal (GETs as `read`).
app.use(
  asyncHandler(async (req, res, next) => {
    const requestId = randomUUID();
    res.locals.requestId = requestId;
    res.setHeader('X-Request-ID', requestId);
    // The session's account, read once: requireAuth (server/auth.ts) takes it from res.locals instead of reading it again.
    const user = await currentUser(req).then(
        found => ((res.locals.sessionUser = found ?? null), found),
        () => undefined,
      ),
      operation = safeRoute(req.method + ' ' + req.path);
    context.run({accountId: user?.id, requestId, operation}, () => {
      res.once('finish', () => {
        // `res.locals.notActivity`: a route's requests are no one's action (a co-editing cursor post, many a second).
        if (user && res.statusCode < 400 && !res.locals.notActivity)
          void recordActivity(user.id, req.method === 'GET' ? 'read' : operation);
      });
      next();
    });
  }),
);

// Cross-site writes are refused: an Origin other than the app's, or a browser that says the request is cross-site.
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    const allowed = process.env.APP_ORIGIN ? [process.env.APP_ORIGIN] : DEV_ORIGINS;
    if (origin && !allowed.includes(origin)) {
      res.status(403).json({error: 'The request origin is not allowed.', code: 'forbidden_origin'});
      return;
    }
    if (req.get('sec-fetch-site') === 'cross-site') {
      res.sendStatus(403);
      return;
    }
  }
  next();
});

// The collab nodes' calls (server/design/collab/internal-router.ts): bearer secret, private network only.
app.use('/internal', createCollabInternalRouter());

app.get('/api/health', async (_req, res) => {
  await db.query('SELECT 1');
  res.json({ok: true});
});
const publicSupportUrl = () => {
  try {
    const url = new URL(process.env.PUBLIC_SUPPORT_URL || '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
};
app.get('/api/config', async (req, res) => {
  const account = await requestUser(req, res).catch(() => undefined);
  res.json({
    publicSupportUrl: publicSupportUrl(),
    designTool: designToolAvailable(account),
    // The server's vector PDF (ENABLE_DESIGN_PDF_EXPORT); off, the editor saves "PDF (raster)" in the browser.
    designPdf: designPdfAvailable(account),
    // PNG/JPG/WebP and thumbnails painted by the render service (DESIGN_RASTER_ENGINE / DESIGN_PDF_ENGINE=service, lane L4);
    // off, the editor paints its exports itself.
    designRaster: designRasterAvailable(account),
    // Co-editing's path for this account (DESIGN_COLLAB, DESIGN_COLLAB_ACCOUNTS; docs/BACKEND.md §7): `legacy`/`shadow` keep the
    // SSE stream and PATCH, `rust` opens the collab socket through GET /api/design-files/:id/session.
    ...collabConfigFor(account?.id),
    // Big files (DESIGN_BIG_FILES, docs/decisions/big-files.md): documents past the fixed cap, pages loaded on demand, the
    // editor's memory budget and indicator.
    bigFiles: bigFilesEnabled(),
    // The support chat (shared/support.ts): on whenever MORFA_OPERATORS names an operator, off with SUPPORT_CHAT=0. Off, "Contact
    // support" offers the address or page above.
    supportChat: supportChatEnabled(),
    // The MCP server's address, when it is open to this account (ENABLE_MCP_SERVER, MCP_ACCOUNTS): "Connections" in the settings.
    ...(mcpAvailable(account) ? {mcpServer: mcpResourceUrl()} : {}),
    // The operator's console (MORFA_OPERATORS, server/admin/router.ts): the key is there only for an operator.
    ...(isOperator(account) ? {admin: true} : {}),
  });
});

app.use('/api/auth', createAccountsRouter());
app.use('/api/settings', createSettingsRouter());
// The design tool (docs/design-tool.md): files and teams.
app.use('/api/design-files', createDesignFilesRouter());
app.use('/api/design-teams', createDesignTeamsRouter());
app.use('/api/design-favourites', createDesignFavouritesRouter());
app.use('/api/design-templates', createDesignTemplatesRouter());
// The support chat (shared/support.ts): the person's conversation, and the operators' side of it behind the operator check. Before the
// console's router, which leaves /api/admin/support to it.
app.use('/api/support', createSupportRouter());
app.use('/api/mcp', createMcpConnectionsRouter());
// "Marketplaces" (docs/marketplaces.md): the public, unguessable links the marketplaces download published cards from (no session;
// under /api so the edge already routes it), then card proofing, generation, catalog runs and the sales loop.
app.use('/api/marketplace-media', createMarketplaceMediaRouter());
app.use('/api/marketplace', createMarketplaceRouter());
app.use('/api/admin/support', createSupportAdminRouter(operatorGate));
// The operator's console (shared/admin-analytics.ts): to anyone but an operator it is the unknown route below.
app.use('/api/admin', createAdminRouter());

// A design picture or thumbnail: to its owner, to the members of its live team, or to the guests of a file that uses it; an account's own
// upload to the account. Prepared: the file browser asks for up to 200 thumbnails at once (the guests' part runs only when the others
// found nothing: UNION ALL under LIMIT 1).
const UPLOAD_ACCESS = prepared(`SELECT filename FROM uploads WHERE filename=$1 AND user_id=$2 AND ready=1
   UNION ALL SELECT filename FROM design_images WHERE filename=$1 AND user_id=$2
   UNION ALL SELECT d.filename FROM design_images d JOIN design_teams t ON t.id=d.team_id AND t.deleted_at IS NULL
     JOIN design_team_members m ON m.team_id=t.id AND m.user_id=$2 WHERE d.filename=$1
   UNION ALL (${guestPicturesSql('ARRAY[$1::text]', '$2')}) LIMIT 1`);
app.get(
  '/uploads/:filename',
  asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const user = await requestUser(req, res),
      file = String(req.params.filename);
    if (
      !/^[a-zA-Z0-9_.-]+$/.test(file) ||
      !user ||
      accountChanged(req, user.id) ||
      !(await db.one(UPLOAD_ACCESS, [file, user.id]))
    ) {
      res.sendStatus(404);
      return;
    }
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    res.sendFile(path.join(dataDir, 'uploads', file), {dotfiles: 'deny', cacheControl: false});
  }),
);
const fontHeaders = (res: express.Response) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
};
app.use(
  '/fonts',
  express.static(path.resolve('public/fonts'), {maxAge: '1y', immutable: true, setHeaders: fontHeaders}),
);
app.use('/api', (_req, res) => res.status(404).json({error: 'Route not found.'}));
if (prod) {
  app.use('/assets', express.static(path.resolve('dist/app/assets'), {maxAge: '1y', immutable: true}));
  app.use('/assets', (_req, res) => res.set('Cache-Control', 'no-store').sendStatus(404));
  app.use(express.static(path.resolve('dist/app')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.resolve('dist/app/index.html')));
}

app.use(async (error: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  // An answer already on its way (a request cut for arriving too slowly) cannot take a second one.
  if (res.headersSent) return next(error);
  if (error instanceof z.ZodError) {
    res.status(400).json({error: error.issues[0]?.message || 'Check the data.', code: 'invalid_input'});
    return;
  }
  const status = error.status || error.statusCode || (error instanceof multer.MulterError ? 400 : SERVER_ERROR);
  if (status >= SERVER_ERROR) await captureError(error);
  res.status(status).json({
    requestId: res.locals.requestId,
    code: error.code,
    fieldErrors: error.fieldErrors,
    error:
      status === SERVER_ERROR
        ? 'Could not complete the action. Check the data and try again.'
        : error.message || 'Request error.',
  });
});

/** Background work the app starts on its own: the design code's thumbnails and the support chat's letters to the operators (the
 *  design code's own work drains with the process, server/index.ts). */
export async function drainAppTasks(): Promise<void> {
  await Promise.all([drainServerThumbnails(), drainSupportNotifications()]);
}
