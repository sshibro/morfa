// The authorization server's routes on the app's origin (docs/mcp-server.md §Sign-in):
//   GET  /.well-known/oauth-authorization-server   RFC 8414 metadata
//   POST /oauth/register                           dynamic client registration (RFC 7591), public clients only
//   GET  /oauth/authorize                          checks the request, ties it to this browser, on to sign-in or consent
//   GET  /oauth/consent, POST /oauth/consent       the person's "Allow" or "Cancel"
//   POST /oauth/token                              authorization_code (PKCE S256) and refresh_token
//   POST /oauth/revoke                             RFC 7009
// With the server off, or on a host that is not ours, none of these paths is ours: the request falls through to whatever answers an
// unknown path. Each family has its own per-address budget; the form routes read only a small form body.
import {randomBytes} from 'node:crypto';
import express, {
  Router,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import cookieParser from 'cookie-parser';
import {z} from 'zod';
import {currentUser, type UserRow} from '../../auth';
import {limitRequests} from '../../rate-limit';
import {anonymousKey} from '../auth';
import {mcpAvailable, mcpEditsOn, mcpHosts, mcpIssuer, mcpResourceUrl, mcpServerOn} from '../config';
import {db} from '../../db';
import {sendConsentPage, sendErrorPage, sendNotForEveryonePage, sendSignInPage} from './pages';
import {
  authorizationServerMetadata,
  bindingHash,
  bindingOf,
  BODY_LIMIT,
  BODY_LIMIT_BYTES,
  captureOAuthError,
  CHALLENGE_PATTERN,
  clearBinding,
  CLIENT_ID_MAX,
  csrfToken,
  csrfValid,
  FORM_PARAMETER_LIMIT,
  isSameOriginPost,
  LIMIT_WINDOW_MS,
  noStore,
  OAuthError,
  oneString,
  openCors,
  PAGE_LIMIT,
  parseScopes,
  REDIRECT_URI_MAX,
  redirectUriMatches,
  REGISTRATION_LIMIT,
  REQUEST_ID,
  responseUrl,
  sendOAuthError,
  sessionDigestOf,
  setBinding,
  STATE_MAX,
  TOKEN_LIMIT,
} from './shared';
import {
  createAuthorizeRequest,
  denyRequest,
  dropRequest,
  exchangeCode,
  normalizeResource,
  readAuthorizeRequest,
  recordConsent,
  refreshTokens,
  registerClient,
  resolveClient,
  revokeToken,
  STALE_REQUEST,
  sweepOAuth,
  type OpenRequest,
} from './store';

export type OAuthRouterOptions = {enabled?: () => boolean; hosts?: () => string[]; issuer?: () => string};

const OAUTH_PATHS = ['/oauth', '/.well-known/oauth-authorization-server'];
/** RFC 6749 appendix A: the visible ASCII range. */
const STATE_SHAPE = /^[\x20-\x7e]*$/;
const SCOPE_TEXT_MAX = 200;

/** The person's account as the server checks it: open to the MCP server, by its proven address or id. */
const openTo = (user: UserRow) => mcpAvailable(user);

const pageLimiter = (limit: number) =>
  limitRequests({
    windowMs: LIMIT_WINDOW_MS,
    limit,
    keyGenerator: (req: Request) => anonymousKey(req.ip ?? ''),
    answer: (_req, res) => sendErrorPage(res, 429, 'Too many attempts. Try again in 15 minutes.'),
  });
const programLimiter = (limit: number, cors: boolean) =>
  limitRequests({
    windowMs: LIMIT_WINDOW_MS,
    limit,
    keyGenerator: (req: Request) => anonymousKey(req.ip ?? ''),
    answer: (_req, res) => {
      if (cors) openCors(res);
      sendOAuthError(res, {
        error: 'temporarily_unavailable',
        description: 'Too many requests. Try again later.',
        status: 429,
      });
    },
  });

/** Navigations only: an image, frame or fetch fired by another page gets nothing. Browsers without Fetch Metadata pass. */
const navigation = (req: Request) => {
  const destination = req.get('sec-fetch-dest');
  return !destination || destination === 'document';
};

function authorizeHandler(issuer: () => string): RequestHandler {
  return async (req, res) => {
    noStore(res);
    void sweepOAuth();
    if (!navigation(req)) return void res.sendStatus(400);
    const clientId = oneString(req.query.client_id, CLIENT_ID_MAX),
      redirectUri = oneString(req.query.redirect_uri, REDIRECT_URI_MAX);
    if (!clientId || !redirectUri)
      return sendErrorPage(
        res,
        400,
        'The request is missing application details. Go back to the assistant and start again.',
      );
    let client;
    try {
      client = await resolveClient(clientId);
    } catch {
      return sendErrorPage(res, 400, 'Application not found. Go back to the assistant and start connecting again.');
    }
    // Until the redirect address is known to be the client's, a problem is a page and never a redirect.
    if (!redirectUriMatches(client.redirectUris, redirectUri))
      return sendErrorPage(
        res,
        400,
        'The redirect address does not match the one the application registered with us. Nothing is connected.',
      );
    const state = oneString(req.query.state, STATE_MAX);
    const goodState = state !== undefined && STATE_SHAPE.test(state) ? state : undefined;
    const fail = (error: string, description: string) =>
      void res
        .status(302)
        .setHeader(
          'Location',
          responseUrl(redirectUri, {error, error_description: description, state: goodState, iss: issuer()}),
        )
        .end();
    if (oneString(req.query.response_type, 20) !== 'code')
      return fail('unsupported_response_type', 'Only response_type=code is supported.');
    if (req.query.state !== undefined && goodState === undefined)
      return fail('invalid_request', 'state must be up to 1024 printable characters.');
    const challenge = oneString(req.query.code_challenge, 100);
    if (oneString(req.query.code_challenge_method, 20) !== 'S256' || !challenge || !CHALLENGE_PATTERN.test(challenge))
      return fail('invalid_request', 'PKCE is required: code_challenge_method=S256 and code_challenge.');
    // The one resource is this server's /mcp; a client that names none means it.
    const resource =
      req.query.resource === undefined ? mcpResourceUrl() : normalizeResource(oneString(req.query.resource, 512) ?? '');
    if (!resource) return fail('invalid_target', 'resource must be the address of the Morfa MCP server.');
    const scopes = parseScopes(req.query.scope === undefined ? undefined : oneString(req.query.scope, SCOPE_TEXT_MAX));
    if (!scopes) return fail('invalid_scope', 'The rights available are read, write and offline_access.');
    const binding = randomBytes(32).toString('base64url');
    const requestId = await createAuthorizeRequest(
      {
        clientId,
        redirectUri,
        scopes: scopes.scopes,
        state: goodState,
        codeChallenge: challenge,
        resource,
        offlineAccess: scopes.offlineAccess,
      },
      bindingHash(binding),
    );
    setBinding(res, binding);
    if (await currentUser(req)) return res.redirect(302, `/oauth/consent?req=${requestId}`);
    // Not signed in: the page's name form signs in and comes back to the consent page.
    sendSignInPage(res, requestId);
  };
}

function consentHandlers(issuer: () => string): {get: RequestHandler; post: RequestHandler} {
  const redirectBack = (
    res: Response,
    redirectUri: string,
    state: string | undefined,
    parameters: Record<string, string>,
  ) => {
    clearBinding(res);
    res
      .status(302)
      .setHeader('Location', responseUrl(redirectUri, {...parameters, state, iss: issuer()}))
      .end();
  };
  const show = (res: Response, request: OpenRequest, user: UserRow, binding: string, sessionDigest: string) =>
    sendConsentPage(res, {
      clientName: request.clientName,
      clientHost: request.clientHost,
      redirectUri: request.redirectUri,
      name: user.name,
      requestId: request.id,
      csrf: csrfToken(binding, request.id, sessionDigest),
      write: request.scopes.includes('write') && mcpEditsOn(),
    });
  const notOpen = async (res: Response, requestId: string, user: UserRow) => {
    await dropRequest(requestId);
    clearBinding(res);
    sendNotForEveryonePage(res, user.name);
  };

  const get: RequestHandler = async (req, res) => {
    noStore(res);
    if (!navigation(req)) return void res.sendStatus(400);
    const id = typeof req.query.req === 'string' ? req.query.req : '';
    const binding = bindingOf(req);
    if (!REQUEST_ID.test(id) || !binding) return sendErrorPage(res, 400, STALE_REQUEST);
    const request = await readAuthorizeRequest(id, bindingHash(binding));
    if (!request) return sendErrorPage(res, 400, STALE_REQUEST);
    const user = await currentUser(req);
    if (!user) {
      return sendSignInPage(res, id);
    }
    if (!openTo(user)) return notOpen(res, id, user);
    show(res, request, user, binding, sessionDigestOf(req)!);
  };

  const form = z.object({
    req: z.string().regex(REQUEST_ID),
    csrf: z.string().min(1).max(200),
    decision: z.enum(['allow', 'deny']),
  });
  const post: RequestHandler = async (req, res) => {
    noStore(res);
    if (!isSameOriginPost(req, issuer()))
      return sendErrorPage(
        res,
        403,
        'The request did not come from the connection page. Start connecting in the assistant again.',
      );
    const user = await currentUser(req);
    const sessionDigest = sessionDigestOf(req);
    if (!user || !sessionDigest)
      return sendErrorPage(res, 401, 'Sign in to Morfa and try connecting again.', 'Sign-in required');
    const parsed = form.safeParse(req.body ?? {});
    const binding = bindingOf(req);
    if (!parsed.success || !binding) return sendErrorPage(res, 400, STALE_REQUEST);
    const body = parsed.data;
    if (!csrfValid(body.csrf, binding, body.req, sessionDigest))
      return sendErrorPage(res, 403, 'This page has expired. Start connecting in the assistant again.');
    const request = await readAuthorizeRequest(body.req, bindingHash(binding));
    if (!request) return sendErrorPage(res, 400, STALE_REQUEST);
    if (!openTo(user)) return notOpen(res, body.req, user);
    if (body.decision === 'deny') {
      const spent = await denyRequest(body.req, bindingHash(binding));
      if (!spent) return sendErrorPage(res, 400, STALE_REQUEST);
      return redirectBack(res, spent.redirectUri, spent.state, {
        error: 'access_denied',
        error_description: 'Access was not allowed.',
      });
    }
    try {
      const granted = await recordConsent(body.req, bindingHash(binding), user.id);
      redirectBack(res, granted.redirectUri, granted.state, {code: granted.code});
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      if (error.error === 'access_denied') return sendNotForEveryonePage(res, user.name);
      return sendErrorPage(res, 400, STALE_REQUEST);
    }
  };
  return {get, post};
}

const text = (max: number) => z.string().min(1).max(max);
const tokenRequest = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    client_id: text(CLIENT_ID_MAX),
    code: text(200),
    redirect_uri: text(REDIRECT_URI_MAX),
    code_verifier: text(200),
    resource: text(512).optional(),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    client_id: text(CLIENT_ID_MAX),
    refresh_token: text(200),
    resource: text(512).optional(),
  }),
]);

const tokenHandler: RequestHandler = async (req, res) => {
  noStore(res);
  openCors(res);
  try {
    if (!req.is('application/x-www-form-urlencoded'))
      throw new OAuthError('invalid_request', 'The body must be application/x-www-form-urlencoded.');
    const type = z.object({grant_type: z.string()}).safeParse(req.body ?? {});
    if (!type.success) throw new OAuthError('invalid_request', 'grant_type is missing.');
    if (type.data.grant_type !== 'authorization_code' && type.data.grant_type !== 'refresh_token')
      throw new OAuthError('unsupported_grant_type', 'authorization_code and refresh_token are supported.');
    const parsed = tokenRequest.safeParse(req.body);
    if (!parsed.success) throw new OAuthError('invalid_request', 'A parameter is missing or repeated.');
    const input = parsed.data;
    const pair =
      input.grant_type === 'authorization_code'
        ? await exchangeCode({
            code: input.code,
            clientId: input.client_id,
            redirectUri: input.redirect_uri,
            codeVerifier: input.code_verifier,
            resource: input.resource,
          })
        : await refreshTokens({refreshToken: input.refresh_token, clientId: input.client_id, resource: input.resource});
    res.json({
      access_token: pair.accessToken,
      token_type: pair.tokenType,
      expires_in: pair.expiresIn,
      refresh_token: pair.refreshToken,
      scope: pair.scope,
    });
  } catch (error) {
    if (error instanceof OAuthError) return sendOAuthError(res, error);
    await captureOAuthError(error);
    sendOAuthError(res, {error: 'server_error', description: 'The server could not process the request.', status: 500});
  }
};

const registerHandler: RequestHandler = async (req, res) => {
  noStore(res);
  void sweepOAuth();
  try {
    if (!req.is('application/json')) throw new OAuthError('invalid_client_metadata', 'The body must be JSON.');
    if (JSON.stringify(req.body ?? null).length > BODY_LIMIT_BYTES)
      throw new OAuthError('invalid_client_metadata', 'The client metadata is too large.');
    const client = await registerClient(req.body);
    res.status(201).json({
      client_id: client.id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: client.grantTypes.length ? client.grantTypes : ['authorization_code'],
      response_types: ['code'],
    });
  } catch (error) {
    if (error instanceof OAuthError) return sendOAuthError(res, error);
    await captureOAuthError(error);
    sendOAuthError(res, {error: 'server_error', description: 'The server could not process the request.', status: 500});
  }
};

const revokeHandler: RequestHandler = async (req, res) => {
  noStore(res);
  openCors(res);
  try {
    if (!req.is('application/x-www-form-urlencoded'))
      throw new OAuthError('invalid_request', 'The body must be application/x-www-form-urlencoded.');
    const token = oneString(req.body?.token, 200);
    if (!token) throw new OAuthError('invalid_request', 'token is missing.');
    await revokeToken(token, oneString(req.body?.client_id, CLIENT_ID_MAX));
    res.status(200).json({});
  } catch (error) {
    if (error instanceof OAuthError) return sendOAuthError(res, error);
    await captureOAuthError(error);
    sendOAuthError(res, {error: 'server_error', description: 'The server could not process the request.', status: 500});
  }
};

export function createMcpOAuthRouter(options: OAuthRouterOptions = {}): Router {
  const {enabled = mcpServerOn, issuer = mcpIssuer, hosts = mcpHosts} = options;
  const router = Router();
  const form = express.urlencoded({extended: false, limit: BODY_LIMIT, parameterLimit: FORM_PARAMETER_LIMIT});
  const json = express.json({limit: BODY_LIMIT});
  const consent = consentHandlers(issuer);
  const authorizing = pageLimiter(PAGE_LIMIT),
    deciding = pageLimiter(PAGE_LIMIT),
    tokens = programLimiter(TOKEN_LIMIT, true),
    registrations = programLimiter(REGISTRATION_LIMIT, false);

  router.use(OAUTH_PATHS, (req: Request, _res: Response, next: NextFunction) => {
    const host = (req.hostname || '').toLowerCase();
    if (!enabled() || !host || !hosts().includes(host)) return next('router');
    next();
  });
  router.use(OAUTH_PATHS, cookieParser());

  // Anything a handler did not expect: a page for people, a fixed sentence for programs.
  const safely =
    (kind: 'page' | 'program', handler: RequestHandler): RequestHandler =>
    async (req, res, next) => {
      try {
        await handler(req, res, next);
      } catch (error) {
        await captureOAuthError(error);
        if (res.headersSent) return;
        if (kind === 'page') sendErrorPage(res, 500, 'Something went wrong. Try connecting again a little later.');
        else
          res.status(500).json({error: 'server_error', error_description: 'The server could not process the request.'});
      }
    };
  const notAllowed =
    (allow: string): RequestHandler =>
    (_req, res) => {
      noStore(res);
      res.status(405).setHeader('Allow', allow).end();
    };
  const preflight: RequestHandler = (_req, res) => {
    openCors(res);
    res.status(204).end();
  };

  router.get('/.well-known/oauth-authorization-server', (_req, res) => {
    openCors(res);
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(authorizationServerMetadata(issuer()));
  });
  // Registration has no CORS answer: a page in a browser must not register clients for its visitors.
  router.options(['/.well-known/oauth-authorization-server', '/oauth/token', '/oauth/revoke'], preflight);
  router.all('/.well-known/oauth-authorization-server', notAllowed('GET, OPTIONS'));
  router.get('/oauth/authorize', authorizing, safely('page', authorizeHandler(issuer)));
  router.all('/oauth/authorize', notAllowed('GET'));
  router.get('/oauth/consent', deciding, safely('page', consent.get));
  router.post('/oauth/consent', deciding, form, safely('page', consent.post));
  router.all('/oauth/consent', notAllowed('GET, POST'));
  router.post('/oauth/token', tokens, form, safely('program', tokenHandler));
  router.all('/oauth/token', notAllowed('POST, OPTIONS'));
  router.post('/oauth/register', registrations, json, safely('program', registerHandler));
  router.all('/oauth/register', notAllowed('POST'));
  router.post('/oauth/revoke', tokens, form, safely('program', revokeHandler));
  router.all('/oauth/revoke', notAllowed('POST, OPTIONS'));

  // A body that cannot be read (too large, not JSON, not a form): the endpoint's own kind of answer, never the app's.
  router.use(OAUTH_PATHS, ((error: {status?: number}, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(error);
    const status = error.status && error.status >= 400 && error.status < 500 ? error.status : 400;
    const path = req.originalUrl.split('?')[0];
    if (path === '/oauth/consent') return sendErrorPage(res, status, STALE_REQUEST);
    if (path !== '/oauth/register') openCors(res);
    noStore(res);
    res.status(status).json({
      error: path === '/oauth/register' ? 'invalid_client_metadata' : 'invalid_request',
      error_description: 'The body could not be read.',
    });
  }) as ErrorRequestHandler);
  return router;
}
