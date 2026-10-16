// The MCP server and its Node handler (docs/mcp-server.md §Calls). One McpServer per HTTP request, nothing kept between calls (stateless, both protocol eras). The
// router has already read the body, checked the caller and put them in AsyncLocalStorage; this file turns tools.ts into SDK tools.
import {AsyncLocalStorage} from 'node:async_hooks';
import {
  createMcpHandler,
  McpServer,
  type CallToolResult,
  type McpHttpHandler,
  type ServerContext,
  type StandardSchemaWithJSON,
} from '@modelcontextprotocol/server';
import {toNodeHandler} from '@modelcontextprotocol/node';
import {z} from 'zod/v4';
import type {Principal} from './auth';
import {takeDailyCall} from './auth';
import {MCP_SERVER_NAME, mcpDailyCalls, mcpIssuer} from './config';
import {toErrorResult, ToolError, translateError} from './errors';
import {READ_ONLY, type ToolDefinition, type ToolSuccess} from './tools';
import {currentTools, EDIT_INSTRUCTIONS} from './tool-list';
import {registerCard} from './app-card';

/** The most body the router reads; also the SDK's own bound for what it would read itself. */
export const MAX_MCP_BODY_BYTES = 1024 * 1024;
/** How long one tool call may take: opening a big file and writing its code is the slowest. */
export const TOOL_BUDGET_MS = 30_000;
/** The most text one result carries: the summary and the JSON copy together. */
export const TOOL_TEXT_CAP = 150_000;
const MAX_REPORTED_ISSUES = 3;
const SERVER_VERSION = '1.0.0';

export const SERVER_INSTRUCTIONS = [
  "Morfa is a design tool (like Figma). These tools read the signed-in account's design files; they change nothing.",
  'Start with morfa_list_files (or a Morfa link the person gives you), then morfa_get_file for its pages and frames.',
  'To build a frame: read it with morfa_get_layers, then ask morfa_get_code for it in the stack the project uses, and adapt the code to the',
  'project\'s components and conventions rather than pasting it. morfa_get_variables (or morfa_get_code format "tokens") gives the design tokens.',
  'morfa_show_file shows the person a card with a button that opens a file in Morfa.',
].join(' ');

/** The caller of the request being served: the SDK's handler factory is not given the Express request, so the router runs the SDK call
 *  inside `requestStorage.run(...)` and the tool wrapper reads it back. */
export type RequestContext = {principal: Principal | null};
export const requestStorage = new AsyncLocalStorage<RequestContext>();

/**
 * The SDK asks for a Standard Schema that can also describe itself as JSON Schema. This pairs zod 4's JSON Schema of the input with a
 * `validate` that lets every argument through: the wrapper parses with zod itself, so a bad argument becomes a tool error with a fix the
 * model can act on, not a protocol error.
 */
export function standardSchemaOf(schema: z.ZodType): StandardSchemaWithJSON {
  const {$schema: _dialect, ...json} = z.toJSONSchema(schema, {io: 'input'}) as Record<string, unknown>;
  return {
    '~standard': {
      version: 1,
      vendor: 'morfa',
      validate: (value: unknown) => ({value}),
      jsonSchema: {input: () => json, output: () => json},
    },
  };
}

/** The first three problems of a rejected call, plainly, with where they are. */
export function invalidInputError(error: z.ZodError): ToolError {
  const issues = error.issues.slice(0, MAX_REPORTED_ISSUES);
  const said = issues.map(
    issue => `${issue.path.length ? `"${issue.path.join('.')}"` : 'The call'}: ${issue.message}.`,
  );
  return new ToolError(
    'invalid_input',
    `The arguments are not valid. ${said.join(' ')}`,
    "Correct the arguments as the tool's input schema says and call again.",
    {
      issues: issues.map(issue => ({path: issue.path.join('.'), code: issue.code})),
    },
  );
}

const unauthorized = () =>
  new ToolError('unauthorized', 'Sign in to Morfa to continue.', 'Ask the person to connect Morfa.');

/** Runs the work within the budget. A handler still running after it is given up on and its signal aborts: a read leaves nothing half
 *  done, an edit stores its change in one write (or not at all). */
async function withinBudget<T>(budgetMs: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const controller = new AbortController();
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new ToolError(
        'unavailable',
        'The call took too long.',
        'Ask for a smaller frame (a nodeId deeper in the tree), less depth, or another format; for an edit, change fewer layers at once.',
      );
      controller.abort(error);
      reject(error);
    }, budgetMs);
  });
  try {
    return await Promise.race([work(controller.signal), expiry]);
  } finally {
    clearTimeout(timer);
  }
}

/** A success as the protocol result: the summary, then a compact JSON copy for clients that read only text (left out when both would not
 *  fit), and the typed result as structuredContent. */
export function toCallToolResult({structured, text, images}: ToolSuccess): CallToolResult {
  const summary = text.length > TOOL_TEXT_CAP ? `${text.slice(0, TOOL_TEXT_CAP - 12)}… (cut off)` : text;
  const json = JSON.stringify(structured);
  const content: CallToolResult['content'] = [{type: 'text', text: summary}];
  if (summary.length + json.length <= TOOL_TEXT_CAP) content.push({type: 'text', text: json});
  for (const image of images ?? []) content.push({type: 'image', data: image.data, mimeType: image.mimeType});
  return {content, structuredContent: structured};
}

/** An error nobody expected goes to the operator's error list; nothing of it reaches the caller. */
async function reportUnexpected(error: unknown): Promise<void> {
  if (error instanceof ToolError) return;
  try {
    const {captureError} = await import('../admin/telemetry');
    await captureError(error);
  } catch {
    /* the error list is optional */
  }
}

export type ToolRunOptions = {dailyCalls?: () => number; takeCall?: typeof takeDailyCall; budgetMs?: number};

/** What every call goes through, in order: a principal, the day's budget, the arguments, the handler within its time. Anything thrown is a
 *  tool error here. */
export async function runTool(
  tool: ToolDefinition,
  rawArguments: unknown,
  options: ToolRunOptions = {},
): Promise<CallToolResult> {
  try {
    // The router's gate decides this first; asking again keeps a tool from ever running for an anonymous caller.
    const principal = requestStorage.getStore()?.principal;
    if (!principal) throw unauthorized();
    const parsed = tool.inputSchema.safeParse(rawArguments ?? {});
    if (!parsed.success) throw invalidInputError(parsed.error);
    const limit = (options.dailyCalls ?? mcpDailyCalls)();
    if (!(await (options.takeCall ?? takeDailyCall)(principal.userId, limit)))
      throw new ToolError(
        'rate_limited',
        `This account has used its ${limit} Morfa calls for today.`,
        'Tell the person; the count starts again at midnight UTC.',
        {limit},
      );
    const success = await withinBudget(options.budgetMs ?? tool.budgetMs ?? TOOL_BUDGET_MS, signal =>
      tool.handler(parsed.data, principal, {signal}),
    );
    return toCallToolResult(success);
  } catch (error) {
    const toolError = translateError(error);
    if (toolError.code === 'internal') await reportUnexpected(error);
    return toErrorResult(toolError);
  }
}

const securityScopes = (tool: ToolDefinition) => ((tool.annotations ?? READ_ONLY).readOnlyHint ? ['read'] : ['read', 'write']);

/** The tools a server is built with: a list, or the list the switches offer at each request (tool-list.ts). */
export type ToolSource = readonly ToolDefinition[] | (() => readonly ToolDefinition[]);
const toolsOf = (source: ToolSource) => (typeof source === 'function' ? source() : source);

/** Morfa's icon for an assistant's list of connectors (MCP 2025-11-25 `serverInfo.icons`), from the app's own public files. Codex reads
 *  it; claude.ai currently shows the favicon of the server's domain instead (morfa.example's, the same mark). */
const serverIcons = () => [
  {src: mcpIssuer() + '/logo-512.png', mimeType: 'image/png', sizes: ['512x512']},
  {src: mcpIssuer() + '/favicon.svg', mimeType: 'image/svg+xml', sizes: ['any']},
];

/** One McpServer holding the given tools; with editing tools, the instructions say how to build in Morfa too. */
export function buildMcpServer(source: ToolSource = currentTools, options: ToolRunOptions = {}): McpServer {
  const tools = toolsOf(source);
  const edits = tools.some(tool => !(tool.annotations ?? READ_ONLY).readOnlyHint);
  // Stateless: the tool list never changes under a client, so no list-changed stream is offered.
  const server = new McpServer(
    {name: MCP_SERVER_NAME, title: 'Morfa', version: SERVER_VERSION, websiteUrl: mcpIssuer(), icons: serverIcons()},
    {instructions: edits ? EDIT_INSTRUCTIONS : SERVER_INSTRUCTIONS, capabilities: {tools: {listChanged: false}}},
  );
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: standardSchemaOf(tool.inputSchema),
        // No output schema is advertised: a client that holds answers to one would reject every tool error, whose structured part is the
        // error and not the tool's answer.
        annotations: {title: tool.title, ...(tool.annotations ?? READ_ONLY)},
        // ChatGPT offers its sign-in for a tool only when the tool names the rights it needs (developers.openai.com/apps-sdk/build/auth,
        // `securitySchemes`; the SDK lists `_meta`, the place ChatGPT reads as well).
        _meta: {...tool.meta, securitySchemes: [{type: 'oauth2', scopes: securityScopes(tool)}]},
      },
      (args: unknown, _context: ServerContext) => runTool(tool, args, options),
    );
  }
  if (tools.some(tool => tool.meta?.ui)) registerCard(server);
  return server;
}

export type McpEndpoint = {
  /** Serves one request: `(req, res, parsedBody?)`, as the SDK's Node adapter does. */
  handle: ReturnType<typeof toNodeHandler>;
  close: () => Promise<void>;
};

/** The SDK handler for both protocol eras, stateless, adapted to Node. */
export function createMcpEndpoint(tools: ToolSource = currentTools, options: ToolRunOptions = {}): McpEndpoint {
  const handler: McpHttpHandler = createMcpHandler(() => buildMcpServer(tools, options), {
    maxRequestBodySize: MAX_MCP_BODY_BYTES,
    // No `subscriptions/listen` stream is ever kept open: nothing here publishes changes.
    maxSubscriptions: 0,
    // Reporting only. The name of the error is enough to find it; its text can hold what a caller sent.
    onerror: error =>
      console.error(
        '[morfa] mcp',
        error?.name ?? 'Error',
        process.env.NODE_ENV === 'test' ? error?.message : 'Request failed',
      ),
  });
  return {handle: toNodeHandler(handler, {maxRequestBodySize: MAX_MCP_BODY_BYTES}), close: () => handler.close()};
}
