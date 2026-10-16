// The HTTP layer of /mcp (docs/mcp-server.md §Calls). Mounted
// before the app's JSON reader, so the body is read here, raw, with its own cap. With the server off none of these paths is ours: the
// request falls through, and what answers it is exactly what answers any unknown path.
import {Router, type NextFunction, type Request, type Response} from 'express';
import {validateHostHeader, validateOriginHeader} from '@modelcontextprotocol/server';
import {gateMcpRequest, type GateCall, type GateRefusal, unauthorizedRefusal} from './auth';
import {acceptedResourceUrls, MCP_PATH, mcpHosts, mcpIssuer, mcpOrigins, mcpResourceUrl, mcpServerOn} from './config';
import {createMcpEndpoint, MAX_MCP_BODY_BYTES, requestStorage, type ToolRunOptions, type ToolSource} from './endpoint';
import {offeredScopes} from './oauth/shared';
import {MAX_PICTURE_BYTES, receiveUpload, UPLOAD_PATH} from './uploads';
import {currentTools} from './tool-list';

const PROTECTED_RESOURCE_PATHS = [
  '/.well-known/oauth-protected-resource',
  `/.well-known/oauth-protected-resource${MCP_PATH}`,
];
const BODY_READ_TIMEOUT_MS = 30_000;
const UPLOAD_READ_TIMEOUT_MS = 120_000;
const MAX_MESSAGES_PER_REQUEST = 20;
const DISCARD_LIMIT_BYTES = 16 * 1024 * 1024;
const DISCARD_LIMIT_MS = 5_000;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const REFUSED = -32000;

export type McpRouterOptions = {
  /** Default: ENABLE_MCP_SERVER (with the design tool on). */
  enabled?: () => boolean;
  /** Host names answered. Default: the app's. */
  hosts?: () => string[];
  /** Browser origins (host names) allowed. Default: none in production. */
  origins?: () => string[];
  tools?: ToolSource;
  gate?: typeof gateMcpRequest;
  run?: ToolRunOptions;
};

class BodyTooLarge extends Error {}
class BodyTimedOut extends Error {}

/** Reads the request body. The cap counts bytes as they arrive, so a body without a Content-Length is stopped too. */
function readBytes(req: Request, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0,
      settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      finish();
    };
    const timer = setTimeout(() => settle(() => reject(new BodyTimedOut())), timeoutMs);
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) return settle(() => reject(new BodyTooLarge()));
      chunks.push(chunk);
    };
    const onEnd = () => settle(() => resolve(Buffer.concat(chunks)));
    const onError = (error: Error) => settle(() => reject(error));
    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
  });
}

/** After a refused body: the answer goes out at once, and what the client is still sending is thrown away (so it can finish and read
 *  the answer) up to a limit, past which the connection is cut. */
function discardRest(req: Request) {
  let discarded = 0;
  const stop = () => {
    clearTimeout(timer);
    req.off('data', onData);
    req.off('end', stop);
    req.off('close', stop);
  };
  const cut = () => {
    stop();
    req.destroy();
  };
  const onData = (chunk: Buffer) => {
    discarded += chunk.length;
    if (discarded > DISCARD_LIMIT_BYTES) cut();
  };
  const timer = setTimeout(cut, DISCARD_LIMIT_MS);
  req.on('data', onData);
  req.once('end', stop);
  req.once('close', stop);
  req.resume();
}

const readBody = async (req: Request, maxBytes: number, timeoutMs: number) =>
  (await readBytes(req, maxBytes, timeoutMs)).toString('utf8');

async function reportUnexpected(error: unknown): Promise<void> {
  try {
    const {captureError} = await import('../admin/telemetry');
    await captureError(error);
  } catch {
    /* the error list is optional */
  }
}

const noStore = {'Cache-Control': 'no-store'};

/** A JSON-RPC error with an HTTP status; never any text but the fixed one given. */
function rpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  id: string | number | null = null,
  headers: Record<string, string> = {},
) {
  res
    .status(status)
    .set({...noStore, ...headers})
    .type('application/json')
    .send(JSON.stringify({jsonrpc: '2.0', error: {code, message}, id}));
}

function refuse(res: Response, refusal: GateRefusal) {
  res
    .status(refusal.status)
    .set({...noStore, ...refusal.headers})
    .type('application/json')
    .send(JSON.stringify(refusal.body));
}

/** What each message of the request asks for. Undefined when the body is not a JSON-RPC message or a short list of them. */
export function callsOf(body: unknown): GateCall[] | undefined {
  const messages = Array.isArray(body) ? body : [body];
  if (!messages.length || messages.length > MAX_MESSAGES_PER_REQUEST) return;
  const calls: GateCall[] = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    const {method, id} = message as {method?: unknown; id?: unknown};
    calls.push({
      method: typeof method === 'string' ? method : '',
      id: typeof id === 'string' || typeof id === 'number' ? id : null,
      // Every tool reads an account's files: any tools/call needs a credential, whatever it names.
      tool: method === 'tools/call',
    });
  }
  return calls;
}

export function createMcpRouter(options: McpRouterOptions = {}): Router & {close: () => Promise<void>} {
  const router = Router() as Router & {close: () => Promise<void>};
  const enabled = options.enabled ?? (() => mcpServerOn());
  const hosts = options.hosts ?? (() => mcpHosts());
  const origins = options.origins ?? (() => mcpOrigins());
  const gate = options.gate ?? gateMcpRequest;
  const endpoint = createMcpEndpoint(options.tools ?? currentTools, options.run);
  router.close = () => endpoint.close();

  /** The address to call this resource: the one the request came in on when it is an accepted alternate (development), else the canonical. */
  const resourceFor = (req: Request): string => {
    const host = req.get('host')?.toLowerCase();
    return acceptedResourceUrls().find(url => new URL(url).host === host) ?? mcpResourceUrl();
  };

  router.all(MCP_PATH, async (req: Request, res: Response, next: NextFunction) => {
    if (!enabled()) return next();
    try {
      if (!validateHostHeader(req.headers.host, hosts()).ok) return rpcError(res, 403, REFUSED, 'Host is not allowed.');
      if (!validateOriginHeader(req.headers.origin, origins()).ok)
        return rpcError(res, 403, REFUSED, 'Origin is not allowed.');
      if (!['POST', 'GET', 'DELETE'].includes(req.method))
        return rpcError(res, 405, REFUSED, 'Method not allowed.', null, {Allow: 'POST, GET, DELETE'});

      const caller = {
        authorization: req.get('authorization'),
        userAgent: String(req.get('user-agent') ?? '').slice(0, 300),
        ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
      };
      const serve = (principal: RequestContextPrincipal, parsedBody?: unknown) =>
        requestStorage.run({principal}, () => endpoint.handle(req, res, parsedBody));

      if (req.method !== 'POST') {
        // GET and DELETE are session operations of the 2025 era; the stateless endpoint answers 405 itself.
        const decision = await gate({...caller, calls: []});
        return decision.ok ? await serve(decision.principal) : refuse(res, decision);
      }

      let parsed: unknown;
      try {
        if (Number(req.get('content-length') ?? 0) > MAX_MCP_BODY_BYTES) throw new BodyTooLarge();
        parsed = JSON.parse(await readBody(req, MAX_MCP_BODY_BYTES, BODY_READ_TIMEOUT_MS));
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          discardRest(req);
          return rpcError(res, 413, REFUSED, 'Request body is too large.');
        }
        if (error instanceof BodyTimedOut)
          return rpcError(res, 408, REFUSED, 'Request body was not received in time.', null, {Connection: 'close'});
        if (error instanceof SyntaxError) return rpcError(res, 400, PARSE_ERROR, 'Parse error.');
        throw error;
      }
      const calls = callsOf(parsed);
      if (!calls) return rpcError(res, 400, INVALID_REQUEST, 'Invalid Request.');

      const decision = await gate({...caller, calls});
      if (!decision.ok) return refuse(res, decision);
      // Whatever the gate does, a tool never runs without a principal.
      const toolCall = calls.find(call => call.tool);
      if (toolCall && !decision.principal) return refuse(res, unauthorizedRefusal(toolCall.id));
      await serve(decision.principal, parsed);
    } catch (error) {
      void reportUnexpected(error);
      if (!res.headersSent) rpcError(res, 500, INTERNAL_ERROR, 'Internal error.');
      else res.end();
    }
  });

  /** RFC 9728 protected-resource metadata: where the sign-in lives. Public, cacheable, readable from a browser. One route for every
   *  method, so that with the server off nothing here answers (Express would otherwise answer OPTIONS for a path it has a route for). */
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  };
  router.all(PROTECTED_RESOURCE_PATHS, (req: Request, res: Response, next: NextFunction) => {
    if (!enabled()) return next();
    if (req.method === 'OPTIONS') return void res.status(204).set(corsHeaders).end();
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!validateHostHeader(req.headers.host, hosts()).ok)
      return void res.status(403).set(noStore).json({error: 'Host is not allowed.'});
    res
      .status(200)
      .set({...corsHeaders, 'Cache-Control': 'public, max-age=300'})
      .json({
        resource: resourceFor(req),
        authorization_servers: [mcpIssuer()],
        scopes_supported: offeredScopes(),
        bearer_methods_supported: ['header'],
        resource_name: 'Morfa',
      });
  });

  /** An upload address (uploads.ts): a picture's bytes, PUT or POST, from a program on the person's computer or a page of the
   *  assistant's own. The address is the credential, so any origin may send to it; nothing here reads a cookie. */
  const uploadCors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'PUT, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-File-Name',
    'Access-Control-Max-Age': '600',
  };
  router.all(`${UPLOAD_PATH}/:secret`, async (req: Request, res: Response, next: NextFunction) => {
    if (!enabled()) return next();
    const answer = (status: number, body: Record<string, unknown>) =>
      void res.status(status).set({...noStore, ...uploadCors}).json(body);
    try {
      if (!validateHostHeader(req.headers.host, hosts()).ok) return answer(403, {error: 'forbidden', message: 'Host is not allowed.'});
      if (req.method === 'OPTIONS') return void res.status(204).set(uploadCors).end();
      if (req.method !== 'PUT' && req.method !== 'POST')
        return void res.status(405).set({...noStore, ...uploadCors, Allow: 'PUT, POST, OPTIONS'}).end();
      let data: Buffer;
      try {
        if (Number(req.get('content-length') ?? 0) > MAX_PICTURE_BYTES) throw new BodyTooLarge();
        data = await readBytes(req, MAX_PICTURE_BYTES, UPLOAD_READ_TIMEOUT_MS);
      } catch (error) {
        if (error instanceof BodyTooLarge) {
          discardRest(req);
          return answer(413, {error: 'too_large', message: `The picture is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB.`});
        }
        if (error instanceof BodyTimedOut) return answer(408, {error: 'timeout', message: 'The picture was not received in time.'});
        throw error;
      }
      if (!data.length) return answer(400, {error: 'invalid_input', message: 'Send the picture file as the request body.'});
      const name = String(req.get('x-file-name') ?? '').slice(0, 200) || undefined;
      const result = await receiveUpload(String(req.params.secret), data, name);
      answer(result.status, result.body);
    } catch (error) {
      void reportUnexpected(error);
      if (!res.headersSent) answer(500, {error: 'internal', message: 'Internal error.'});
      else res.end();
    }
  });

  return router;
}

type RequestContextPrincipal = Parameters<typeof requestStorage.run>[0]['principal'];
