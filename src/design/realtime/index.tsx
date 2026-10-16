import type {DesignTeamRole} from '../../../shared/design/teams';
import type {DesignStore} from '../engine/store';
import type {CanvasController} from '../editor/CanvasView';
import type {SessionPersistence} from '../editor/editor-session';
import {startLiveSession, type LiveCallbacks, type LiveSession} from './live-session';
import {followPeers, publishPresence} from './presence-bridge';
import {CanvasPresence, PresenceAvatars} from './PresenceUI';
import {pickTransport, setWasmWire} from './transport/pick';
import {loadWasmWire} from './transport/wasm-wire';

// Co-editing and presence of the open file (docs/design-tool.md "Co-editing"), loaded by the editor with
// `import()` after it shows, so its code is never part of the editor's first load. Without this module the editor
// still saves (as before: one editor at a time per version).

// The binary wire's WASM, loaded only when /api/config says `designCollabWire: 'binary'` (pick.ts).
setWasmWire(loadWasmWire);

export type Realtime = {
  live: LiveSession;
  /** The avatars, for the right panel's header. */
  Avatars: () => React.JSX.Element | null;
  /** Cursors, selections and the follow frame, over the canvas. */
  CanvasLayer: () => React.JSX.Element | null;
  stop(): void;
};

export function startRealtime(options: {
  fileId: string;
  store: DesignStore;
  persistence: SessionPersistence;
  version: number;
  canEdit: boolean;
  /** The caller's role in a team file. */
  role?: DesignTeamRole;
  host: () => HTMLElement | null;
  canvas: () => CanvasController | null;
  callbacks: LiveCallbacks;
}): Realtime {
  const {store, canvas} = options;
  const live = startLiveSession({fileId: options.fileId, store, persistence: options.persistence, version: options.version, canEdit: options.canEdit, role: options.role, callbacks: options.callbacks, transport: () => pickTransport(undefined, options.fileId)});
  const offPresence = publishPresence({store, presence: live.presence, host: options.host, canvas});
  const offFollow = followPeers({store, peers: live.peers, canvas});
  return {
    live,
    Avatars: () => <PresenceAvatars live={live} store={store} />,
    CanvasLayer: () => <CanvasPresence live={live} store={store} canvas={canvas} />,
    stop() {
      offFollow();
      offPresence();
      live.stop();
    },
  };
}
