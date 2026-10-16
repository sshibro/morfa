import type {NodeId, Vec} from './types';
import type {DocumentPatch} from './patch';
import type {DesignTeamRole} from './teams';
import type {MeetingPresence} from './meeting';

// Co-editing and presence of one open file (docs/design-tool.md "Co-editing"): the wire types of
// `GET /api/design-files/:id/events` (a text/event-stream the server writes) and `POST /api/design-files/:id/presence`,
// shared by the server (server/design/live/) and the editor (src/design/realtime/). Types and numbers only.
//
// Events of the stream (`event:` names, `data:` JSON):
//   hello     DesignLiveHello      first, and after every reconnect
//   change    DesignLiveChange     an accepted change of someone else's connection, in version order (`id:` the version)
//   resync    {version}            the document was replaced (restore, import) or the server lacks changes: reload it
//   presence  {peers: DesignPeer[]} peers whose presence changed (joined, moved, selected...)
//   leave     {connection}         a peer closed the file
//   access    {role, canEdit}      the caller's role in the file changed (a demoted editor becomes read-only)
//   file      {name}               the file was renamed
//   meeting   DesignMeetingSignal  the file's timer or vote changed: read GET /:id/meeting (shared/design/meeting.ts)
//   collab    {mode, sessionUrl}   the file moved to the Rust collab service (DESIGN_COLLAB=rust, docs/BACKEND.md §7): its
//                                  socket is where `sessionUrl` (GET /:id/session) says; PATCH is refused once a node holds it
//   bye       {reason}             the stream ends: the caller lost access, signed out, the file went to the trash...
// A comment line (`: hb`) every DESIGN_LIVE.heartbeatMs keeps proxies from closing a quiet stream.

export const DESIGN_LIVE = {
  /** The server writes a heartbeat this often. */
  heartbeatMs: 20_000,
  /** The client treats a stream silent for this long as dead and reconnects. */
  silenceMs: 50_000,
  /** The server re-checks each stream's session and access this often (± a quarter): a removed member stops receiving
   *  changes within this time even when the removal happened in another process. */
  revalidateMs: 20_000,
  /** The client sends its presence at most this often (cursor moves are coalesced in between). */
  presenceMs: 60,
  /** The server sends a file's presence changes at most this often. */
  presenceFlushMs: 40,
  /** Selected layers a presence carries (more are summarized by the count). */
  maxSelection: 200,
  /** Reconnect waits (the last repeats), with ±20 % jitter. */
  reconnectMs: [500, 1_000, 2_000, 5_000, 10_000, 20_000] as readonly number[],
} as const;

/** Server-side limits (env overrides in server/design/live/limits.ts). */
export const DESIGN_LIVE_LIMITS = {
  streamsPerAccount: 16,
  streamsPerFile: 50,
  streams: 2_000,
  /** Changes a file keeps for resuming streams and catching saves up. */
  logEntries: 512,
  logBytes: 8 * 1024 * 1024,
  /** All files' change logs together. */
  logBytesTotal: 64 * 1024 * 1024,
  /** The catch-up a save's answer may carry before it asks for a reload instead. */
  catchUpBytes: 2 * 1024 * 1024,
  /** Presence posts per second per stream (burst twice that). */
  presencePerSecond: 25,
} as const;

/** Colours of people in a file (cursor, avatar ring, selection outline), Figma-bright: white 12 px labels stay readable on each. Never
 *  the selection blue of one's own selection, never the brand's lime, yellow or lilac. */
export const DESIGN_LIVE_COLORS: readonly string[] = ['#F24822', '#14AE5C', '#E5229E', '#7B61FF', '#E8650A', '#0B9EB7', '#9747FF', '#B0721E'];

export type DesignViewportPresence = {x: number; y: number; zoom: number; width: number; height: number};
/** What one connection shows the others; everything optional is absent until known. */
export type DesignPresence = {
  /** The pointer on the canvas in page coordinates, null when it is outside the canvas. */
  cursor: Vec | null;
  page: NodeId | null;
  /** At most DESIGN_LIVE.maxSelection ids; `selectionCount` the full count. */
  selection: NodeId[];
  selectionCount: number;
  viewport: DesignViewportPresence | null;
  /** The text layer being typed in. */
  editing: NodeId | null;
  /** "Meeting": cursor chat, emotes, a wave, spotlight (shared/design/meeting.ts); absent until the meeting module sends it. */
  meeting?: MeetingPresence | null;
};
export const EMPTY_PRESENCE: DesignPresence = {cursor: null, page: null, selection: [], selectionCount: 0, viewport: null, editing: null};

/** Another connection in the file (one person may have several tabs). */
export type DesignPeer = DesignPresence & {
  connection: string;
  user: string;
  /** A display name ("Participant" when the account has none). */
  name: string;
  /** Index into DESIGN_LIVE_COLORS; one person keeps one colour in a file. */
  color: number;
  role: DesignTeamRole;
};

export type DesignLiveHello = {
  connection: string;
  /** The secret that authorizes this connection's presence posts. */
  token: string;
  /** The file's version when the stream opened (changes after it follow on the stream). */
  version: number;
  role: DesignTeamRole;
  canEdit: boolean;
  user: string;
  name: string;
  color: number;
  peers: DesignPeer[];
  /** The server lays out every merged save (DESIGN_SERVER_LAYOUT=1): an editor's unsaved changes rebased onto others'
   *  are laid out when they are saved, not corrected here. */
  layout?: 'server';
};
export type DesignLiveChange = {version: number; patch: DocumentPatch; by: string | null; user: string};
export type DesignLiveBye = {reason: 'access' | 'session' | 'trashed' | 'erased' | 'limit' | 'slow' | 'shutdown' | 'replaced'};
/** `POST /:id/presence`: the fields that changed. */
export type DesignPresencePost = Partial<DesignPresence> & {token: string};
