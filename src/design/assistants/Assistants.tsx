import {lazy, Suspense, useCallback, useEffect, useRef, useState} from 'react';
import {BrandSymbol} from '../../brand/marks';
import {readAssistants, type AssistantsState} from './api';
import {ChatGptMark, ClaudeMark} from './marks';
import {assistantKind} from './model';
import '../styles/assistants.css';

// "Connections" in the file browser (docs/mcp-server.md §Connections): a card always in view in the sidebar, not in the settings, that
// shows the person's own Claude and ChatGPT joined to Morfa, and opens the screen that connects them. Offered only where the MCP server
// is open to the account (GET /api/mcp/connections answers); the screen itself is its own chunk.

const AssistantsDialog = lazy(() => import('./AssistantsDialog'));

/** The three marks joined by two lines that carry dots into Morfa: the picture of "a connection", at any size. */
export function ConnectionPicture({size, live = {claude: false, chatgpt: false}}: {size: 'small' | 'large'; live?: {claude: boolean; chatgpt: boolean}}) {
  return (
    <div className={`dz-assist-picture is-${size}`} aria-hidden="true">
      <span className={`dz-assist-tile is-claude ${live.claude ? 'is-live' : ''}`}>
        <ClaudeMark className="dz-assist-mark" />
        {size === 'large' && <span className="dz-assist-badge" />}
      </span>
      <Wire direction="in" live={live.claude} />
      <span className="dz-assist-tile is-morfa">
        <BrandSymbol className="dz-assist-mark" />
      </span>
      <Wire direction="out" live={live.chatgpt} />
      <span className={`dz-assist-tile is-chatgpt ${live.chatgpt ? 'is-live' : ''}`}>
        <ChatGptMark className="dz-assist-mark" />
        {size === 'large' && <span className="dz-assist-badge" />}
      </span>
    </div>
  );
}

/** A line between an assistant and Morfa; its dots travel towards Morfa (`in`: left to right, `out`: right to left). */
function Wire({direction, live}: {direction: 'in' | 'out'; live: boolean}) {
  return (
    <span className={`dz-assist-wire is-${direction} ${live ? 'is-live' : ''}`}>
      <svg className="dz-assist-wire-line" viewBox="0 0 100 2" preserveAspectRatio="none">
        <line x1="0" y1="1" x2="100" y2="1" pathLength={100} />
      </svg>
      <span className="dz-assist-dot" />
      <span className="dz-assist-dot is-late" />
    </span>
  );
}

export function AssistantsEntry() {
  const [state, setState] = useState<AssistantsState | null>(null);
  const [open, setOpen] = useState(false);
  const alive = useRef(true);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await readAssistants(signal);
      if (alive.current) setState(next);
      return next;
    } catch {
      return null;
    }
  }, []);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => {
      alive.current = false;
      controller.abort();
    };
  }, [refresh]);
  if (!state) return null;
  const kinds = new Set(state.connections.map(assistantKind));
  const live = {claude: kinds.has('claude'), chatgpt: kinds.has('chatgpt')};
  const count = state.connections.length;
  return (
    <>
      <button type="button" className={`dz-assist-card ${count ? 'is-connected' : ''}`} onClick={() => setOpen(true)}>
        <ConnectionPicture size="small" live={live} />
        <span className="dz-assist-card-text">
          <span className="dz-assist-card-title">Claude and ChatGPT</span>
          <span className="dz-assist-card-line">
            {count ? `Connected: ${count === 1 ? state.connections[0]!.clientName : count}` : 'Connect to Morfa'}
          </span>
        </span>
      </button>
      {open && (
        <Suspense fallback={null}>
          <AssistantsDialog state={state} refresh={refresh} onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
