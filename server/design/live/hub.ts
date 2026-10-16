import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {serverLayoutOn} from '../wasm-engine';
import type {Response} from 'express';
import type {DocumentPatch} from '../../../shared/design/patch';
import type {DesignChange} from '../../../shared/design/api';
import {canEditTeamFiles, type DesignTeamRole} from '../../../shared/design/teams';
import {DESIGN_LIVE, DESIGN_LIVE_COLORS, EMPTY_PRESENCE, type DesignLiveBye, type DesignPeer, type DesignPresence, type DesignPresencePost} from '../../../shared/design/live';
import type {CustomerAuthority} from '../../customer-authority';
import {designRead, fileAccess} from '../file-access';
import {isDesignFailure} from '../errors';
import {localFanOut, postgresFanOut, type FanOutMessage, type LiveFanOut} from './fanout';
import {liveLimits} from './limits';
import {collabAclChanged, type AclTarget} from '../collab/acl-push';
import {collabCommentsChanged, collabFileClosed, collabFileRenamed, collabMeetingChanged} from '../collab/notices';

// The live side of a design file (docs/design-tool.md "Co-editing"): who has it open (a stream each),
// the changes accepted since (a bounded log, so a stream that reconnects or a save made on an older version catches
// up), and where everyone is (presence, never stored). One process holds its own streams; `LiveFanOut` passes events
// to the others when the app runs as several (server/design/live/fanout.ts).
//
// A stream is checked again every DESIGN_LIVE.revalidateMs (± a quarter, so they spread): a signed-out session or a
// member who lost the file gets `bye` and the stream ends; a changed role gets `access` (an editor made a viewer turns
// read-only at once, and the server refuses its writes anyway). Team changes in this process ask for the check at once.
//
// A file a collab node holds (DESIGN_COLLAB=rust, docs/BACKEND.md §7) gets the same events on its sockets: each record* below,
// in the process where it happened, also hands them to server/design/collab/ (notices.ts, acl-push.ts), which tells the node.

type Connection = {
  id: string;
  /** The digest of the stream's presence token (`tokenKey`): what `byToken` and another process's forwarded post name it by. */
  tokenKey: string;
  fileId: string;
  userId: string;
  sessionHash: string;
  /** When the stream opened: of two people given one colour by different processes, the later one takes another. */
  openedAt: number;
  role: DesignTeamRole;
  canEdit: boolean;
  name: string;
  color: number;
  teamId: string | null;
  res: Response;
  presence: DesignPresence;
  dirty: boolean;
  tokens: number;
  tokensAt: number;
  heartbeat: ReturnType<typeof setInterval> | null;
  check: ReturnType<typeof setTimeout> | null;
  checking: boolean;
  /** Asked for again while a check was running (a role changed meanwhile): the next one runs at once. */
  recheck: boolean;
  closed: boolean;
};
type LogEntry = DesignChange & {data: string; bytes: number};
/** `openedAt`: when its stream opened, as its process said (an older process does not say: 0, as if it came first). */
type RemotePeer = {peer: DesignPeer; seenAt: number; openedAt: number};
type Room = {
  fileId: string;
  connections: Map<string, Connection>;
  /** Changes after `logFrom`, in version order. */
  log: LogEntry[];
  logBytes: number;
  logFrom: number;
  version: number;
  flush: ReturnType<typeof setTimeout> | null;
  left: Set<string>;
  colors: Map<string, number>;
  remote: Map<string, RemotePeer>;
  touchedAt: number;
};

const rooms = new Map<string, Room>();
/** Streams by the digest of their presence token. */
const byToken = new Map<string, Connection>();
const tokenKey = (token: string) => createHash('sha256').update(token).digest('base64url');
/** Several api processes share the files' streams through the fan-out (the same switch `fan()` reads). */
const multiProcess = () => process.env.DESIGN_LIVE_FANOUT === 'postgres';
const perAccount = new Map<string, number>();
let streams = 0;
let logTotal = 0;
let fanOut: LiveFanOut | null = null;
let sweeper: ReturnType<typeof setInterval> | null = null;

function fan(): LiveFanOut {
  if (fanOut) return fanOut;
  fanOut = process.env.DESIGN_LIVE_FANOUT === 'postgres' ? postgresFanOut() : localFanOut();
  fanOut.subscribe(receive, () => {
    // Events of the other processes were missed: every open file reloads.
    for (const room of rooms.values()) resetRoom(room, room.version, false);
  });
  return fanOut;
}
/** Tests and the operator's switch: the next event uses a fresh fan-out. */
export async function resetLiveFanOut() {
  const current = fanOut;
  fanOut = null;
  await current?.close();
}

function roomFor(fileId: string, version: number): Room {
  let room = rooms.get(fileId);
  if (!room) {
    room = {fileId, connections: new Map(), log: [], logBytes: 0, logFrom: version, version, flush: null, left: new Set(), colors: new Map(), remote: new Map(), touchedAt: Date.now()};
    rooms.set(fileId, room);
    sweeper ??= setInterval(sweep, 20_000);
    sweeper.unref();
  }
  return room;
}

/** With several processes, each tells the others who it holds now and then: a peer not heard of for three rounds left. */
function announce() {
  if (!multiProcess()) return;
  for (const room of rooms.values()) announceRoom(room);
}
function announceRoom(room: Room) {
  if (!room.connections.size) return;
  const connections = [...room.connections.values()];
  fan().publish({kind: 'presence', fileId: room.fileId, peers: connections.map(peerOf), left: [], opened: openedOf(connections)});
}

function sweep() {
  announce();
  const now = Date.now(), idle = liveLimits().idleRoomMs;
  for (const room of rooms.values()) {
    for (const [id, remote] of room.remote) if (now - remote.seenAt > DESIGN_LIVE.heartbeatMs * 3) {
      room.remote.delete(id);
      room.left.add(id);
      schedule(room);
    }
    if (!room.connections.size && !room.remote.size && now - room.touchedAt > idle) dropRoom(room);
  }
  if (!rooms.size && sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}
function dropRoom(room: Room) {
  if (room.flush) clearTimeout(room.flush);
  logTotal -= room.logBytes;
  rooms.delete(room.fileId);
}

// ── Writing to a stream ──────────────────────────────────────────────────────────────────────────

function write(connection: Connection, chunk: string) {
  if (connection.closed) return;
  connection.res.write(chunk);
  if (connection.res.writableLength > liveLimits().backlogBytes) end(connection, 'slow');
}
const event = (name: string, data: string, id?: number) => `event: ${name}\n${id !== undefined ? `id: ${id}\n` : ''}data: ${data}\n\n`;
const send = (connection: Connection, name: string, value: unknown) => write(connection, event(name, JSON.stringify(value)));

function end(connection: Connection, reason: DesignLiveBye['reason']) {
  if (connection.closed) return;
  try {
    connection.res.write(event('bye', JSON.stringify({reason})));
  } catch {
    // The socket is already gone.
  }
  connection.res.end();
  release(connection);
}

function release(connection: Connection) {
  if (connection.closed) return;
  connection.closed = true;
  if (connection.heartbeat) clearInterval(connection.heartbeat);
  if (connection.check) clearTimeout(connection.check);
  byToken.delete(connection.tokenKey);
  streams--;
  const count = (perAccount.get(connection.userId) ?? 1) - 1;
  if (count) perAccount.set(connection.userId, count);
  else perAccount.delete(connection.userId);
  const room = rooms.get(connection.fileId);
  if (!room) return;
  room.connections.delete(connection.id);
  room.touchedAt = Date.now();
  room.left.add(connection.id);
  schedule(room);
  if (![...room.connections.values()].some(other => other.userId === connection.userId) && ![...room.remote.values()].some(other => other.peer.user === connection.userId)) room.colors.delete(connection.userId);
}

// ── Presence ─────────────────────────────────────────────────────────────────────────────────────

const peerOf = (connection: Connection): DesignPeer => ({
  ...connection.presence,
  connection: connection.id,
  user: connection.userId,
  name: connection.name,
  color: connection.color,
  role: connection.role,
});
function schedule(room: Room) {
  if (room.flush) return;
  room.flush = setTimeout(() => flushPresence(room), DESIGN_LIVE.presenceFlushMs);
  room.flush.unref();
}
function flushPresence(room: Room) {
  room.flush = null;
  const peers: DesignPeer[] = [];
  const moved: Connection[] = [];
  for (const connection of room.connections.values()) if (connection.dirty) {
    connection.dirty = false;
    peers.push(peerOf(connection));
    moved.push(connection);
  }
  const left = [...room.left];
  room.left.clear();
  if (!peers.length && !left.length) return;
  const leaving = left.map(id => event('leave', JSON.stringify({connection: id}))).join('');
  // Each stream gets the others: an editor never shows itself (src/design/realtime/presence.ts drops it), so its own moves are
  // not sent back to it (a cursor crossing the canvas would come back ~25 times a second, each a roster rebuild for nothing).
  const texts = peers.map(peer => JSON.stringify(peer));
  const presence = (skip: number) => {
    const others = skip < 0 ? texts : texts.filter((_, k) => k !== skip);
    return others.length ? event('presence', '{"peers":[' + others.join(',') + ']}') : '';
  };
  const all = presence(-1);
  for (const connection of room.connections.values()) {
    const own = peers.findIndex(peer => peer.connection === connection.id);
    const data = leaving + (own < 0 ? all : presence(own));
    if (data) write(connection, data);
  }
  fan().publish({kind: 'presence', fileId: room.fileId, peers, left, opened: openedOf(moved)});
}
const openedOf = (connections: readonly Connection[]) => Object.fromEntries(connections.map(connection => [connection.id, connection.openedAt]));

function colorFor(room: Room, userId: string): number {
  // A person already in the file through another process keeps the colour that process gave them, and nobody here takes it.
  const known = room.colors.get(userId) ?? [...room.remote.values()].find(remote => remote.peer.user === userId)?.peer.color;
  if (known !== undefined) {
    room.colors.set(userId, known);
    return known;
  }
  const used = new Set([...room.colors.values(), ...[...room.remote.values()].map(remote => remote.peer.color)]);
  let color = 0;
  while (used.has(color) && color < DESIGN_LIVE_COLORS.length) color++;
  if (color >= DESIGN_LIVE_COLORS.length) color = room.colors.size % DESIGN_LIVE_COLORS.length;
  room.colors.set(userId, color);
  return color;
}

/**
 * With several processes, each colours the people it holds from those it knows of, and the first stream of a file in a process
 * is coloured before the others have said who is in it: two people, each on their own process, could both get the first colour.
 * When another process's people are heard, a person here who has the colour of someone else there and came later (their first
 * stream here opened after that person's; the same moment: the larger account id) takes the first colour nobody has. Every process
 * decides the same way, so only one of the two changes.
 */
function settleColors(room: Room) {
  const firstSeen = new Map<string, number>();
  const note = (user: string, at: number) => firstSeen.set(user, Math.min(at, firstSeen.get(user) ?? Infinity));
  for (const connection of room.connections.values()) note(connection.userId, connection.openedAt);
  for (const remote of room.remote.values()) note(remote.peer.user, remote.openedAt);
  const later = (user: string, other: string) => firstSeen.get(user)! > firstSeen.get(other)! || (firstSeen.get(user) === firstSeen.get(other) && user > other);
  for (const connection of [...room.connections.values()]) {
    const clash = [...room.remote.values()].some(remote => remote.peer.user !== connection.userId && remote.peer.color === connection.color && later(connection.userId, remote.peer.user));
    if (clash) recolor(room, connection.userId);
  }
}
function recolor(room: Room, userId: string) {
  const used = new Set<number>();
  for (const connection of room.connections.values()) if (connection.userId !== userId) used.add(connection.color);
  for (const remote of room.remote.values()) if (remote.peer.user !== userId) used.add(remote.peer.color);
  let color = 0;
  while (used.has(color) && color < DESIGN_LIVE_COLORS.length) color++;
  // More people than colours: some share one anyway.
  if (color >= DESIGN_LIVE_COLORS.length) return;
  room.colors.set(userId, color);
  for (const connection of room.connections.values())
    if (connection.userId === userId && connection.color !== color) {
      connection.color = color;
      connection.dirty = true;
    }
  schedule(room);
}

/** Presence posts passed to the other processes, per session and in all: a signed-in post with a made-up token still costs a notification, so
 *  they are bounded like a stream's own posts. */
const forwards = new Map<string, {tokens: number; at: number}>();
let forwardsAll = {tokens: 0, at: 0};
const FORWARDS_PER_SECOND = 1_000;
function forwardAllowed(sessionHash: string): boolean {
  const now = Date.now(), rate = liveLimits().presencePerSecond;
  if (forwards.size > 10_000) forwards.clear();
  const own = forwards.get(sessionHash) ?? {tokens: rate * 2, at: now};
  own.tokens = Math.min(rate * 2, own.tokens + ((now - own.at) / 1000) * rate);
  own.at = now;
  forwards.set(sessionHash, own);
  forwardsAll.tokens = Math.min(FORWARDS_PER_SECOND, forwardsAll.tokens + ((now - forwardsAll.at) / 1000) * FORWARDS_PER_SECOND);
  forwardsAll.at = now;
  if (own.tokens < 1 || forwardsAll.tokens < 1) return false;
  own.tokens -= 1;
  forwardsAll.tokens -= 1;
  return true;
}

/**
 * A presence post of a stream (`token`), from the same session that opened it. With several api processes the post may reach
 * one that does not hold the stream (Caddy balances every request on its own, least connections): it goes on through the
 * fan-out to the process that does, and is answered as taken. Refusing it here read as "the stream is gone" to the editor,
 * which closed the stream and reconnected, so everyone else saw the person's avatar, cursor and selection blink away and back
 * several times a second.
 */
export function updatePresence(fileId: string, sessionHash: string, post: DesignPresencePost, signedIn: boolean): 'ok' | 'unknown' | 'limited' {
  const key = tokenKey(post.token);
  const connection = byToken.get(key);
  if (!connection && multiProcess()) {
    // Only a live session's posts go on (server/app.ts has read it for this request already): a made-up cookie costs no notification.
    if (!signedIn) return 'unknown';
    if (!forwardAllowed(sessionHash)) return 'limited';
    const {token: _token, ...fields} = post;
    fan().publish({kind: 'presence-post', fileId, token: key, session: sessionHash, post: fields});
    return 'ok';
  }
  return applyPresence(connection, fileId, sessionHash, post);
}

function applyPresence(connection: Connection | undefined, fileId: string, sessionHash: string, post: Omit<DesignPresencePost, 'token'>): 'ok' | 'unknown' | 'limited' {
  if (!connection || connection.closed || connection.fileId !== fileId || connection.sessionHash !== sessionHash) return 'unknown';
  const now = Date.now(), rate = liveLimits().presencePerSecond;
  connection.tokens = Math.min(rate * 2, connection.tokens + ((now - connection.tokensAt) / 1000) * rate);
  connection.tokensAt = now;
  if (connection.tokens < 1) return 'limited';
  connection.tokens -= 1;
  const next: DesignPresence = {...connection.presence};
  if (post.cursor !== undefined) next.cursor = post.cursor;
  if (post.page !== undefined) next.page = post.page;
  if (post.selection !== undefined) {
    next.selection = post.selection.slice(0, DESIGN_LIVE.maxSelection);
    next.selectionCount = Math.max(post.selectionCount ?? post.selection.length, next.selection.length);
  }
  if (post.viewport !== undefined) next.viewport = post.viewport;
  if (post.editing !== undefined) next.editing = post.editing;
  // "Meeting" (cursor chat, emotes, a wave, spotlight): held here like the cursor, never stored (server/design/meeting/).
  if (post.meeting !== undefined) next.meeting = post.meeting;
  connection.presence = next;
  connection.dirty = true;
  const room = rooms.get(fileId);
  if (room) schedule(room);
  return 'ok';
}

// ── Streams ──────────────────────────────────────────────────────────────────────────────────────

export type StreamRefusal = {status: number; code: string; error: string};

/** Room for one more stream of `userId` on `fileId`, or why not. */
export function streamRoom(userId: string, fileId: string): StreamRefusal | null {
  const limits = liveLimits();
  const busy = (error: string): StreamRefusal => ({status: 429, code: 'design_live_busy', error});
  if (streams >= limits.streams) return busy('The server cannot show other people\'s changes right now. Try again later.');
  if ((perAccount.get(userId) ?? 0) >= limits.streamsPerAccount) return busy('Too many open file tabs. Close some.');
  if ((rooms.get(fileId)?.connections.size ?? 0) >= limits.streamsPerFile) return busy('There are too many people in the file right now. Try again later.');
  return null;
}

/**
 * Opens the stream of `res` (already checked: the caller may view the file, `access` says how): the hello, the changes
 * after `since` (or `resync` when the log no longer holds them), then everything live until the client goes, the
 * session or access ends, or the server stops.
 */
export function openStream(res: Response, input: {fileId: string; userId: string; sessionHash: string; name: string; access: {role: DesignTeamRole; canEdit: boolean; teamId: string | null}; version: number; since: number | null}) {
  const limits = liveLimits();
  const room = roomFor(input.fileId, input.version);
  // The first stream of the file here: the other processes say who they hold in it now. Without the ask, someone there who sits
  // still shows up here only at their process's next announce (up to 20 s), as the hello cannot list them.
  // Asked once this process listens: the fan-out starts with the first event after a restart, and an answer before then is lost.
  if (multiProcess() && !room.connections.size) {
    const out = fan();
    void out.ready().then(() => out.publish({kind: 'presence-ask', fileId: input.fileId}));
  }
  // A room nobody follows catches up with the stored version. A followed one does not: a save that committed a moment
  // ago records its change right after (here or from another process), and every stream gets it then; versions that
  // never pass here (another process without a fan-out) reset the log with the next change that does.
  if (input.version > room.version && !room.connections.size) {
    room.log = [];
    logTotal -= room.logBytes;
    room.logBytes = 0;
    room.version = room.logFrom = input.version;
  }
  const token = randomBytes(24).toString('base64url');
  const connection: Connection = {
    id: randomUUID(),
    tokenKey: tokenKey(token),
    fileId: input.fileId,
    userId: input.userId,
    sessionHash: input.sessionHash,
    openedAt: Date.now(),
    role: input.access.role,
    canEdit: input.access.canEdit,
    name: input.name,
    color: colorFor(room, input.userId),
    teamId: input.access.teamId,
    res,
    presence: {...EMPTY_PRESENCE},
    dirty: true,
    tokens: limits.presencePerSecond * 2,
    tokensAt: Date.now(),
    heartbeat: null,
    check: null,
    checking: false,
    recheck: false,
    closed: false,
  };
  streams++;
  perAccount.set(input.userId, (perAccount.get(input.userId) ?? 0) + 1);
  byToken.set(connection.tokenKey, connection);
  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.socket?.setNoDelay(true);
  res.socket?.setTimeout(0);
  // The browser retries a stream itself only when this is missing; the editor reconnects on its own.
  res.write('retry: 600000\n\n');
  const peers = [...room.connections.values()].map(peerOf).concat([...room.remote.values()].map(remote => remote.peer));
  send(connection, 'hello', {
    connection: connection.id,
    token,
    version: room.version,
    role: connection.role,
    canEdit: connection.canEdit,
    user: connection.userId,
    name: connection.name,
    color: connection.color,
    peers,
    ...(serverLayoutOn() ? {layout: 'server' as const} : {}),
  });
  if (input.since !== null && input.since < room.version) {
    const missed = changesSince(input.fileId, input.since, room.version);
    if (missed) for (const change of missed) write(connection, (change as LogEntry).data ?? event('change', JSON.stringify(change), change.version));
    else send(connection, 'resync', {version: room.version});
  }
  room.connections.set(connection.id, connection);
  room.touchedAt = Date.now();
  schedule(room);
  connection.heartbeat = setInterval(() => write(connection, ': hb\n\n'), limits.heartbeatMs);
  connection.heartbeat.unref();
  planCheck(connection);
  res.on('close', () => release(connection));
  return connection.id;
}

/** Ends every stream (the server is stopping): the editors reconnect to the next process. */
export function closeDesignLiveStreams() {
  for (const room of rooms.values()) for (const connection of [...room.connections.values()]) end(connection, 'shutdown');
}

// ── Access ───────────────────────────────────────────────────────────────────────────────────────

function planCheck(connection: Connection, delay?: number) {
  if (connection.closed) return;
  // The running check may have read the access before the change that asks for this one: it plans the next at once.
  if (connection.checking && delay === 0) {
    connection.recheck = true;
    return;
  }
  if (connection.check) clearTimeout(connection.check);
  const every = liveLimits().revalidateMs;
  connection.check = setTimeout(() => void check(connection), delay ?? every * (0.75 + Math.random() * 0.5));
  connection.check.unref();
}

/** The stream's session and access, read again. */
async function check(connection: Connection) {
  if (connection.closed || connection.checking) return;
  connection.checking = true;
  const actor: CustomerAuthority = Object.freeze({ownerId: connection.userId, sessionHash: connection.sessionHash});
  try {
    const row = await designRead(actor, tx => fileAccess(tx, connection.userId, connection.fileId, 'view'));
    const canEdit = canEditTeamFiles(row.role) && row.trashed_at === null;
    if (row.role !== connection.role || canEdit !== connection.canEdit) {
      connection.role = row.role;
      connection.canEdit = canEdit;
      connection.teamId = row.team_id;
      send(connection, 'access', {role: row.role, canEdit});
      connection.dirty = true;
      const room = rooms.get(connection.fileId);
      if (room) schedule(room);
    }
    connection.teamId = row.team_id;
  } catch (error) {
    const status = (error as {status?: unknown})?.status;
    if (status === 401) return end(connection, 'session');
    if (status === 404 || status === 403 || isDesignFailure(error)) return end(connection, 'access');
    // A database hiccup is not a verdict: the next check decides.
  } finally {
    connection.checking = false;
    const again = connection.recheck;
    connection.recheck = false;
    planCheck(connection, again ? 0 : undefined);
  }
}

/** Checks the matching streams now (a role changed, a member left, a file moved): in this process and the others, and the sockets
 *  of the files a collab node holds (`users`: people the change named who may no longer be members; `extraTeams`: a team the file
 *  left). */
export function revalidateLive(target: AclTarget & {teamId?: string; fileId?: string; userId?: string}, local = true) {
  for (const room of rooms.values())
    for (const connection of room.connections.values()) {
      if (target.fileId && connection.fileId !== target.fileId) continue;
      if (target.teamId && connection.teamId !== target.teamId) continue;
      if (target.userId && connection.userId !== target.userId) continue;
      planCheck(connection, 0);
    }
  if (local) {
    fan().publish({kind: 'revalidate', ...(target.teamId ? {teamId: target.teamId} : {}), ...(target.fileId ? {fileId: target.fileId} : {}), ...(target.userId ? {userId: target.userId} : {})});
    collabAclChanged(target);
  }
}

// ── Changes ──────────────────────────────────────────────────────────────────────────────────────

function trimLog(room: Room) {
  const limits = liveLimits();
  while (room.log.length && (room.log.length > limits.logEntries || room.logBytes > limits.logBytes)) {
    const first = room.log.shift()!;
    room.logBytes -= first.bytes;
    logTotal -= first.bytes;
    room.logFrom = first.version;
  }
  // All files together: the least recently touched give way first.
  if (logTotal > limits.logBytesTotal) {
    const order = [...rooms.values()].filter(other => other.log.length).sort((a, b) => a.touchedAt - b.touchedAt);
    for (const other of order) {
      while (other.log.length && logTotal > limits.logBytesTotal) {
        const first = other.log.shift()!;
        other.logBytes -= first.bytes;
        logTotal -= first.bytes;
        other.logFrom = first.version;
      }
      if (logTotal <= limits.logBytesTotal) break;
    }
  }
}

/**
 * An accepted change of `fileId` stored as `version` (`by`: the connection that made it, which is not sent it back):
 * kept in the log and sent to every other stream of the file, here and in the other processes.
 */
export function recordChange(fileId: string, change: {version: number; patch: DocumentPatch; by: string | null; user: string}, local = true) {
  const room = roomFor(fileId, change.version - 1);
  room.touchedAt = Date.now();
  // Already held, or older than the log: nothing new.
  if (change.version <= room.logFrom || room.log.some(entry => entry.version === change.version)) return;
  // A version above the next leaves a gap in the log: written elsewhere and not heard yet (two processes each announce their own
  // commits, so a change committed there a moment before one committed here can arrive after it), or never passing here. The
  // streams get what they have; the editors hold a change until the ones before it came (src/design/realtime/live-session.ts),
  // and a catch-up across a gap is answered "reload" (changesSince).
  const data = event('change', JSON.stringify({version: change.version, patch: change.patch, by: change.by, user: change.user}), change.version);
  const entry: LogEntry = {version: change.version, patch: change.patch, data, bytes: data.length};
  // Heard late: it fills its gap, in version order.
  const at = change.version > room.version ? room.log.length : room.log.findIndex(other => other.version > change.version);
  room.log.splice(at < 0 ? room.log.length : at, 0, entry);
  room.logBytes += entry.bytes;
  logTotal += entry.bytes;
  room.version = Math.max(room.version, change.version);
  // `by` is the saver's word for their own stream (it has the change in its answer): only a stream of the same person is skipped,
  // so a made-up `by` can never keep a change from someone else's editor.
  for (const connection of room.connections.values()) if (connection.id !== change.by || connection.userId !== change.user) write(connection, data);
  trimLog(room);
  if (local) fan().publish({kind: 'change', fileId, ...change});
}

/** The document of `fileId` was replaced as `version` (restore, import, a move that rewrote it): the streams reload it. */
export function recordReset(fileId: string, version: number) {
  const room = rooms.get(fileId);
  if (room) resetRoom(room, version, true);
  else fan().publish({kind: 'reset', fileId, version});
}
function resetRoom(room: Room, version: number, local: boolean) {
  room.log = [];
  logTotal -= room.logBytes;
  room.logBytes = 0;
  room.logFrom = Math.max(version, room.version);
  room.version = room.logFrom;
  room.touchedAt = Date.now();
  for (const connection of room.connections.values()) send(connection, 'resync', {version: room.version});
  if (local) fan().publish({kind: 'reset', fileId: room.fileId, version: room.version});
}

/** The changes of `fileId` after `base` up to `upTo` in order, or null when the log no longer holds all of them. */
export function changesSince(fileId: string, base: number, upTo: number): DesignChange[] | null {
  if (upTo <= base) return [];
  const room = rooms.get(fileId);
  if (!room || base < room.logFrom || upTo > room.version) return null;
  const out: DesignChange[] = [];
  let expected = base + 1;
  for (const entry of room.log) {
    if (entry.version <= base) continue;
    if (entry.version > upTo) break;
    if (entry.version !== expected) return null;
    out.push(entry);
    expected++;
  }
  return expected === upTo + 1 ? out : null;
}
/** The plain changes (without the stream's own text), for a save's answer; null over `maxBytes`. */
export function catchUp(fileId: string, base: number, upTo: number, maxBytes = liveLimits().catchUpBytes): DesignChange[] | null {
  const changes = changesSince(fileId, base, upTo);
  if (!changes) return null;
  let bytes = 0;
  for (const change of changes) bytes += (change as LogEntry).bytes ?? 0;
  if (bytes > maxBytes) return null;
  return changes.map(change => ({version: change.version, patch: change.patch}));
}

/** The file was renamed: the open editors show the new name. */
export function recordRename(fileId: string, name: string, local = true) {
  const room = rooms.get(fileId);
  if (room) for (const connection of room.connections.values()) send(connection, 'file', {name});
  if (local) {
    fan().publish({kind: 'file', fileId, name});
    collabFileRenamed(fileId, name);
  }
}
/** The file's comments changed: the open editors fetch what is new (the event carries nothing, so it reaches every member, viewers
 *  included; `GET /:id/comments?since=` answers what each may read). */
export function recordComments(fileId: string, local = true) {
  const room = rooms.get(fileId);
  if (room) for (const connection of room.connections.values()) send(connection, 'comments', {});
  if (local) {
    fan().publish({kind: 'comments', fileId});
    collabCommentsChanged(fileId);
  }
}
/** The file's meeting (timer, vote) changed as `revision`: the open editors read it again (server/design/meeting/). With `user`, only
 *  that person's own votes changed, so only their streams are told (the counts of a running vote are hidden from everyone else). */
export function recordMeeting(fileId: string, change: {revision: number; user?: string; by?: string | null}, local = true) {
  const room = rooms.get(fileId);
  if (room) {
    // `by`: the connection whose action it was, which has the new state in its answer already.
    const data = event('meeting', JSON.stringify({revision: change.revision, ...(change.user ? {user: change.user} : {})}));
    for (const connection of room.connections.values())
      if (connection.id !== change.by && (!change.user || connection.userId === change.user)) write(connection, data);
  }
  if (local) {
    fan().publish({kind: 'meeting', fileId, revision: change.revision, ...(change.user ? {user: change.user} : {}), ...(change.by ? {by: change.by} : {})});
    collabMeetingChanged(fileId, {revision: change.revision, ...(change.user ? {user: change.user} : {})});
  }
}
/** The file went to the trash or was erased: its streams end. */
export function closeFile(fileId: string, reason: 'trashed' | 'erased', local = true) {
  const room = rooms.get(fileId);
  if (room) {
    for (const connection of [...room.connections.values()]) end(connection, reason);
    if (reason === 'erased') dropRoom(room);
  }
  if (local) {
    fan().publish({kind: 'close', fileId, reason});
    collabFileClosed(fileId, reason);
  }
}

/** A collab node took the file (DESIGN_COLLAB=rust): its SSE streams hear where the socket is (`collab {mode, sessionUrl}`), so an
 *  editor still on SSE can move to the socket; their PATCHes are refused from now on (409 collab_active). */
export function recordCollab(fileId: string, change: {mode: 'rust'; sessionUrl: string}, local = true) {
  const room = rooms.get(fileId);
  if (room) for (const connection of room.connections.values()) send(connection, 'collab', change);
  if (local) fan().publish({kind: 'collab', fileId, ...change});
}

/** An event of another process. */
function receive(message: FanOutMessage) {
  switch (message.kind) {
    case 'change': {
      if (message.patch) recordChange(message.fileId, {version: message.version, patch: message.patch, by: message.by, user: message.user}, false);
      else {
        const room = rooms.get(message.fileId);
        if (room) resetRoom(room, message.version, false);
      }
      return;
    }
    case 'reset': {
      const room = rooms.get(message.fileId);
      if (room) resetRoom(room, message.version, false);
      return;
    }
    case 'file':
      return recordRename(message.fileId, message.name, false);
    case 'comments':
      return recordComments(message.fileId, false);
    case 'meeting':
      return recordMeeting(message.fileId, {revision: message.revision, user: message.user, by: message.by}, false);
    case 'close':
      return closeFile(message.fileId, message.reason, false);
    case 'revalidate':
      return revalidateLive(message, false);
    case 'collab':
      return recordCollab(message.fileId, {mode: message.mode, sessionUrl: message.sessionUrl}, false);
    case 'presence-post':
      applyPresence(byToken.get(message.token), message.fileId, message.session, message.post);
      return;
    case 'presence-ask': {
      const room = rooms.get(message.fileId);
      if (room) announceRoom(room);
      return;
    }
    case 'presence': {
      const room = rooms.get(message.fileId);
      if (!room) return;
      const now = Date.now();
      for (const peer of message.peers) room.remote.set(peer.connection, {peer, seenAt: now, openedAt: message.opened?.[peer.connection] ?? room.remote.get(peer.connection)?.openedAt ?? 0});
      for (const id of message.left) room.remote.delete(id);
      settleColors(room);
      const data = (message.left.map(id => event('leave', JSON.stringify({connection: id}))).join('')) + (message.peers.length ? event('presence', JSON.stringify({peers: message.peers})) : '');
      for (const connection of room.connections.values()) write(connection, data);
      return;
    }
  }
}

/** For tests: the streams and logs this process holds. */
export function liveState() {
  return {streams, rooms: rooms.size, logBytes: logTotal, files: [...rooms.values()].map(room => ({fileId: room.fileId, version: room.version, logFrom: room.logFrom, log: room.log.length, connections: room.connections.size}))};
}
