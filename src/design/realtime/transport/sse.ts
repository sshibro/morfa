import type {DesignFileOpened} from '../../../../shared/design/api';
import {DESIGN_LIVE, type DesignLiveBye, type DesignLiveChange, type DesignLiveHello, type DesignPeer, type DesignPresencePost} from '../../../../shared/design/live';
import type {DesignTeamRole} from '../../../../shared/design/teams';
import {apiAccount} from '../../../api';
import {openDesignFile} from '../../api';
import {readEventStream, type StreamEvent} from '../stream';
import {sleep, type LiveConnect, type LiveHandlers, type LiveTransport} from './types';

// Today's path (DESIGN_COLLAB legacy and shadow; docs/design-tool.md "Co-editing", "Stream"): the
// others' changes on a text/event-stream (`GET /:id/events?since=`), presence in small posts, saves by autosave's PATCH.
// The code is the session's as it was; only the events now go through LiveHandlers.

/** The network side of the SSE transport (tests script it). */
export type SseIo = {
  stream(url: string, init: RequestInit, onEvent: (event: StreamEvent) => void, onActivity: () => void): Promise<void>;
  open(fileId: string): Promise<DesignFileOpened>;
  presence(fileId: string, post: DesignPresencePost): Promise<boolean>;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
};

export const accountHeaders = (): Record<string, string> => {
  const account = apiAccount();
  return account ? {'X-Forma-Account': account} : {};
};

export const browserSseIo: SseIo = {
  stream: (url, init, onEvent, onActivity) => readEventStream(url, init, onEvent, onActivity),
  open: fileId => openDesignFile(fileId),
  async presence(fileId, post) {
    const response = await fetch(`/api/design-files/${encodeURIComponent(fileId)}/presence`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json', ...accountHeaders()},
      body: JSON.stringify(post),
    });
    // Too many at once: not taken, so it goes again with the next post (presence.ts resends what differs) rather than
    // the last position being lost.
    if (response.status === 429) throw new Error('presence rate limited');
    return response.status !== 404;
  },
  sleep,
};

/** One SSE event into the handlers (unknown names reach only `raw`). */
export function dispatchSseEvent(event: StreamEvent, handlers: LiveHandlers) {
  let data: unknown;
  try {
    data = JSON.parse(event.data);
  } catch {
    return;
  }
  switch (event.event) {
    case 'hello':
      handlers.hello(data as DesignLiveHello);
      break;
    case 'change':
      handlers.change(data as DesignLiveChange);
      break;
    case 'resync':
      handlers.resync({});
      break;
    case 'presence':
      handlers.presence((data as {peers: DesignPeer[]}).peers);
      break;
    case 'leave':
      handlers.leave((data as {connection: string}).connection);
      break;
    case 'access':
      handlers.access(data as {role: DesignTeamRole; canEdit: boolean});
      break;
    case 'file':
      handlers.file((data as {name: string}).name);
      break;
    case 'comments':
      handlers.comments();
      break;
    case 'bye':
      handlers.bye((data as DesignLiveBye).reason);
      break;
  }
  handlers.raw(event.event, data);
}

export function sseTransport(io: SseIo = browserSseIo): LiveTransport {
  return {
    kind: 'sse',
    sendsOps: false,
    presenceMs: DESIGN_LIVE.presenceMs,
    connect(options: LiveConnect, handlers: LiveHandlers) {
      return io.stream(
        `/api/design-files/${encodeURIComponent(options.fileId)}/events?since=${options.since}`,
        {signal: options.signal, headers: options.headers},
        event => dispatchSseEvent(event, handlers),
        handlers.activity,
      );
    },
    send: () => false,
    pull: () => undefined,
    presence: (fileId, post) => io.presence(fileId, post),
    open: fileId => io.open(fileId),
    sleep: (ms, signal) => io.sleep(ms, signal),
  };
}
