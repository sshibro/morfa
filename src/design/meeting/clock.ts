// The server's clock as this editor sees it (docs/board-meeting.md "Timer"): everyone counts the shared timer down to the same
// `endsAt`, so each editor needs the server's time, not its own (a laptop a minute off would end the meeting a minute early).
// Every answer of `GET …/meeting` carries `now`; the request's round trip bounds the error: the server read its clock somewhere
// between sending and receiving, so `now + rtt/2` is the estimate and `rtt/2` its uncertainty. The sample with the smallest round
// trip in the last few wins (NTP's rule): a slow answer never drags a good estimate off.

export type ServerClock = {
  /** The server's time now, in ms since 1970. */
  now(): number;
  /** A sample: the server said `serverNow` for a request sent at `sentAt` and answered at `receivedAt` (this clock, ms). */
  sample(serverNow: number, sentAt: number, receivedAt: number): void;
  /** The offset in use (server − local), for tests and the debug overlay. */
  offset(): number;
};

const KEEP = 8;

export function createServerClock(local: () => number = () => Date.now()): ServerClock {
  const samples: {offset: number; rtt: number; at: number}[] = [];
  let offset = 0;
  return {
    now: () => local() + offset,
    sample(serverNow, sentAt, receivedAt) {
      if (!Number.isFinite(serverNow) || receivedAt < sentAt) return;
      const rtt = receivedAt - sentAt;
      samples.push({offset: serverNow + rtt / 2 - receivedAt, rtt, at: receivedAt});
      if (samples.length > KEEP) samples.shift();
      let best = samples[0];
      for (const item of samples) if (item.rtt < best.rtt || (item.rtt === best.rtt && item.at > best.at)) best = item;
      offset = best.offset;
    },
    offset: () => offset,
  };
}
