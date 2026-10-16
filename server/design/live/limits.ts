import {DESIGN_LIVE, DESIGN_LIVE_LIMITS} from '../../../shared/design/live';

// Limits of the live streams (docs/design-tool.md "Co-editing"), each overridable by the operator (or a
// test) through the environment. Read on use, so a test can change them between cases.

const positive = (name: string, fallback: number) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
};

export const liveLimits = () => ({
  streamsPerAccount: positive('DESIGN_LIVE_STREAMS_PER_ACCOUNT', DESIGN_LIVE_LIMITS.streamsPerAccount),
  streamsPerFile: positive('DESIGN_LIVE_STREAMS_PER_FILE', DESIGN_LIVE_LIMITS.streamsPerFile),
  streams: positive('DESIGN_LIVE_STREAMS', DESIGN_LIVE_LIMITS.streams),
  logEntries: positive('DESIGN_LIVE_LOG_ENTRIES', DESIGN_LIVE_LIMITS.logEntries),
  logBytes: positive('DESIGN_LIVE_LOG_BYTES', DESIGN_LIVE_LIMITS.logBytes),
  logBytesTotal: positive('DESIGN_LIVE_LOG_BYTES_TOTAL', DESIGN_LIVE_LIMITS.logBytesTotal),
  catchUpBytes: positive('DESIGN_LIVE_CATCH_UP_BYTES', DESIGN_LIVE_LIMITS.catchUpBytes),
  presencePerSecond: positive('DESIGN_LIVE_PRESENCE_PER_SECOND', DESIGN_LIVE_LIMITS.presencePerSecond),
  heartbeatMs: positive('DESIGN_LIVE_HEARTBEAT_MS', DESIGN_LIVE.heartbeatMs),
  revalidateMs: positive('DESIGN_LIVE_REVALIDATE_MS', DESIGN_LIVE.revalidateMs),
  /** A stream whose unsent output grows past this is too slow to follow: it is closed and the editor reloads. */
  backlogBytes: positive('DESIGN_LIVE_BACKLOG_BYTES', 16 * 1024 * 1024),
  /** A file's log and presence state are forgotten this long after its last stream closed and its last change. */
  idleRoomMs: positive('DESIGN_LIVE_IDLE_ROOM_MS', 10 * 60_000),
});
