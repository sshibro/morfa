// Reads a text/event-stream over `fetch` (not EventSource): the request carries the account header the API checks
// (X-Forma-Account), a refusal arrives with its status and JSON, and the caller decides when to reconnect. The parser
// follows the HTML spec's rules for `event:`, `data:` and `id:` lines; comments keep the connection alive.

export type StreamEvent = {event: string; data: string; id: string | null};

export class StreamRefused extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/** Splits a growing text into events; returns the unfinished tail. */
export function parseEvents(buffer: string, emit: (event: StreamEvent) => void): string {
  let start = 0;
  for (;;) {
    const end = buffer.indexOf('\n\n', start);
    if (end < 0) break;
    const block = buffer.slice(start, end);
    start = end + 2;
    let name = 'message',
      id: string | null = null;
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (!line || line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') name = value;
      else if (field === 'data') data.push(value);
      else if (field === 'id') id = value;
    }
    if (data.length) emit({event: name, data: data.join('\n'), id});
  }
  return buffer.slice(start);
}

/**
 * Opens `url` and calls `onEvent` for each event until the stream ends (resolves), the network fails (rejects with the
 * fetch error) or the server refuses (rejects with StreamRefused). `onActivity` runs on every chunk, comments included.
 */
export async function readEventStream(url: string, init: RequestInit, onEvent: (event: StreamEvent) => void, onActivity?: () => void): Promise<void> {
  const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store', ...init, headers: {Accept: 'text/event-stream', ...init.headers}});
  if (!response.ok || !response.body || !response.headers.get('content-type')?.startsWith('text/event-stream')) {
    let message = 'Could not connect to co-editing.',
      code: string | null = null;
    try {
      const body = (await response.json()) as {error?: unknown; code?: unknown};
      if (typeof body.error === 'string') message = body.error;
      if (typeof body.code === 'string') code = body.code;
    } catch {
      // Not our JSON (a proxy's page).
    }
    throw new StreamRefused(message, response.status, code);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  try {
    for (;;) {
      const {value, done} = await reader.read();
      if (done) return;
      onActivity?.();
      // The server writes plain "\n" line ends (server/design/live/hub.ts).
      buffer = parseEvents(buffer + value, onEvent);
    }
  } finally {
    reader.releaseLock();
  }
}
