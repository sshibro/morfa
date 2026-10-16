// Errors of the MCP tools (docs/mcp-server.md §Tools). A tool error is a normal result with isError: true, never a protocol error and
// never a stack trace: `message` says what went wrong, `fix` says how the call should change. Both are written for the model, in
// English (an assistant answers its person in their own language); nothing in them comes from an exception's own text.
import type {CallToolResult} from '@modelcontextprotocol/server';

export type ToolErrorCode =
  | 'unauthorized'
  | 'not_found'
  | 'invalid_input'
  | 'too_large'
  | 'rate_limited'
  | 'unavailable'
  | 'internal'
  // Editing (docs/mcp-server.md §Editing): the connection may not change files, the account may only view this one, the change was
  // refused as a whole (the reasons say why), the layers to undo were changed again since.
  | 'insufficient_scope'
  | 'forbidden'
  | 'refused'
  | 'conflict';

export class ToolError extends Error {
  constructor(
    readonly code: ToolErrorCode,
    message: string,
    readonly fix: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export const internalError = () =>
  new ToolError(
    'internal',
    'The call could not be completed.',
    'Retry in a minute. If it keeps failing, tell the person.',
  );

/** Any error: a ToolError as it is, anything else `internal` and saying nothing of what went wrong. */
export const translateError = (error: unknown): ToolError => (error instanceof ToolError ? error : internalError());

export function toErrorResult(error: ToolError): CallToolResult {
  const {code, message, fix, details} = error;
  return {
    isError: true,
    content: [{type: 'text', text: `${code}: ${message} ${fix}`}],
    structuredContent: {error: {code, message, fix, ...(details ? {details} : {})}},
  };
}
