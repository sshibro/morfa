import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import {EMPTY_PRESENCE, type DesignPeer, type DesignPresencePost} from '../shared/design/live';
import {
  applyBallot,
  cleanChat,
  clampTimer,
  durationWords,
  formatTimer,
  frameTargetAt,
  highFives,
  isCleanChat,
  MEETING_LIMITS,
  rankTallies,
  sameMeetingPresence,
  targetLabel,
  timerPhase,
  timerRemaining,
  voteEnded,
  votesLeft,
  type DesignMeetingState,
  type MeetingTimer,
  type MeetingVote,
} from '../shared/design/meeting';
import {createServerClock} from '../src/design/meeting/clock';
import {createMeetingSession, type MeetingTransport} from '../src/design/meeting/session';
import {createLocalMeeting, createSpotlight, watchPeers} from '../src/design/meeting/ephemeral';
import {createLocalPresence, createPeerStore} from '../src/design/realtime/presence';

// "Meeting" without a network (docs/board-meeting.md): the shared rules (the timer on the server's clock, ballots and the tally, cursor
// chat text, high fives, what a vote counts in a design file), the server clock estimate, the durable session (signals, stale answers,
// ballots shown at once), and the ephemeral half (presence fields, bursts, chat, waves, "Get attention").

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function clock() {
  let now = 1_000_000;
  const timers = new Map<number, {at: number; run: () => void}>();
  let next = 1;
  return {
    timers: {
      now: () => now,
      random: () => 0.5,
      setTimeout: (run: () => void, ms: number) => {
        timers.set(next, {at: now + ms, run});
        return next++;
      },
      clearTimeout: (handle: unknown) => void timers.delete(handle as number),
    },
    get now() {
      return now;
    },
    async advance(ms: number) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      now = until;
      for (let i = 0; i < 5; i++) await Promise.resolve();
    },
  };
}

const running = (endsAt: number, durationMs = 180_000): MeetingTimer => ({state: 'running', durationMs, endsAt, remainingMs: null, music: null, by: {id: 'u1', name: 'Anna'}});

test('timer: phases and the countdown follow the server clock; «03:00» rounds seconds up', () => {
  assert.equal(timerPhase(null, 0), 'idle');
  const timer = running(10_000);
  assert.equal(timerPhase(timer, 9_999), 'running');
  assert.equal(timerRemaining(timer, 7_500), 2_500);
  assert.equal(timerPhase(timer, 10_000), 'done', 'reaching zero shows "Time is up"');
  assert.equal(timerPhase(timer, 10_000 + MEETING_LIMITS.doneShownMs - 1), 'done');
  assert.equal(timerPhase(timer, 10_000 + MEETING_LIMITS.doneShownMs), 'idle', 'then the pill rests');
  assert.equal(timerRemaining(timer, 20_000), 0);
  const paused: MeetingTimer = {...timer, state: 'paused', endsAt: null, remainingMs: 42_000};
  assert.equal(timerPhase(paused, 999_999), 'paused');
  assert.equal(timerRemaining(paused, 999_999), 42_000);
  assert.equal(formatTimer(180_000), '03:00');
  assert.equal(formatTimer(179_001), '03:00', 'the first second still shows the whole minute');
  assert.equal(formatTimer(1), '00:01');
  assert.equal(formatTimer(0), '00:00');
  assert.equal(formatTimer(MEETING_LIMITS.timerMaxMs), '99:59');
  assert.equal(durationWords(180_000), '3 minutes');
  assert.equal(durationWords(60_000), '1 minute');
  assert.equal(durationWords(300_000), '5 minutes');
  assert.equal(durationWords(30_000), '30 seconds');
  assert.equal(clampTimer(1), MEETING_LIMITS.timerMinMs);
  assert.equal(clampTimer(1e12), MEETING_LIMITS.timerMaxMs);
  assert.equal(clampTimer(61_400), 61_000, 'whole seconds');
});

test('votes: ballots respect the votes each person has; the tally ranks with shared places and a fixed order', () => {
  assert.deepEqual(applyBallot([], 2, 'b', 1), [{nodeId: 'b', count: 1}]);
  let mine = applyBallot([{nodeId: 'b', count: 1}], 2, 'a', 1);
  assert.deepEqual(mine, [{nodeId: 'a', count: 1}, {nodeId: 'b', count: 1}], 'kept in id order');
  assert.equal(applyBallot(mine as never, 2, 'c', 1), 'no-votes-left');
  assert.equal(applyBallot([], 2, 'c', -1), 'no-vote-here');
  mine = applyBallot([{nodeId: 'a', count: 2}], 3, 'a', -1);
  assert.deepEqual(mine, [{nodeId: 'a', count: 1}]);
  assert.deepEqual(applyBallot([{nodeId: 'a', count: 1}], 3, 'a', -1), [], 'the last vote taken back leaves nothing');
  assert.equal(votesLeft({perPerson: 3, mine: [{nodeId: 'a', count: 2}]}), 1);
  assert.deepEqual(rankTallies([{nodeId: 'c', count: 2}, {nodeId: 'a', count: 5}, {nodeId: 'b', count: 2}, {nodeId: 'd', count: 0}]), [
    {nodeId: 'a', count: 5, rank: 1},
    {nodeId: 'b', count: 2, rank: 2},
    {nodeId: 'c', count: 2, rank: 2},
  ]);
  assert.equal(voteEnded({endedAt: null, endsAt: null}, 5), false);
  assert.equal(voteEnded({endedAt: null, endsAt: 10}, 10), true, 'a timed vote ends with its timer');
  assert.equal(voteEnded({endedAt: 3, endsAt: null}, 1), true);
});

test('cursor chat: one line of plain text, no control or direction characters, at most 100 code points', () => {
  assert.equal(cleanChat('Hello\neveryone'), 'Hello everyone');
  assert.equal(cleanChat('a' + String.fromCharCode(0x202e) + 'b'), 'a b', 'a right-to-left override cannot reorder the bubble');
  assert.equal(cleanChat('x' + String.fromCharCode(0x2028) + 'y'), 'x y');
  const emoji = '🎉'.repeat(150);
  assert.equal([...cleanChat(emoji)].length, MEETING_LIMITS.chatLength, 'emoji count as one each');
  assert.equal(isCleanChat('Great 👍'), true);
  assert.equal(isCleanChat('a\u0007'), false);
  assert.equal(isCleanChat('x'.repeat(101)), false);
});

test('high five: two waves on one page close on screen (at the larger zoom of the two) meet once', () => {
  const near = highFives([
    {connection: 'b', wave: 2, page: 'p', cursor: {x: 100, y: 100}, zoom: 1},
    {connection: 'a', wave: 1, page: 'p', cursor: {x: 140, y: 120}, zoom: 1},
  ]);
  assert.equal(near.length, 1);
  assert.deepEqual({a: near[0].a, b: near[0].b, at: near[0].at}, {a: 'a', b: 'b', at: {x: 120, y: 110}});
  assert.equal(near[0].key, 'a:1|b:2', 'each pair once per wave, in connection order on every editor');
  assert.equal(highFives([{connection: 'a', wave: 1, page: 'p', cursor: {x: 0, y: 0}, zoom: 1}, {connection: 'b', wave: 1, page: 'q', cursor: {x: 0, y: 0}, zoom: 1}]).length, 0, 'other page');
  assert.equal(highFives([{connection: 'a', wave: 1, page: 'p', cursor: {x: 0, y: 0}, zoom: 1}, {connection: 'b', wave: 1, page: 'p', cursor: {x: 60, y: 0}, zoom: 2}]).length, 0, '120 px apart at zoom 2');
  assert.equal(highFives([{connection: 'a', wave: 1, page: 'p', cursor: null, zoom: 1}, {connection: 'b', wave: 1, page: 'p', cursor: {x: 0, y: 0}, zoom: 1}]).length, 0);
});

test('a design file votes for its top-level frames: the frontmost, frames in sections too, never a hidden one', () => {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'back', name: 'Home', x: 0, y: 0, width: 300, height: 300}), 'page');
  tx.create(createNode('FRAME', {id: 'front', name: 'Catalog', x: 200, y: 200, width: 300, height: 300}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'inner', x: 10, y: 10, width: 50, height: 50}), 'back');
  tx.create(createNode('SECTION', {id: 'section', name: 'Section', x: 1000, y: 0, width: 600, height: 600}), 'page');
  tx.create(createNode('FRAME', {id: 'inSection', name: 'Cart', x: 50, y: 50, width: 200, height: 200}), 'section');
  tx.create(createNode('FRAME', {id: 'hidden', name: 'Hidden', x: 2000, y: 0, width: 100, height: 100, visible: false}), 'page');
  tx.create(createNode('RECTANGLE', {id: 'loose', x: 3000, y: 0, width: 100, height: 100}), 'page');
  const doc = tx.commit({measurer}).doc;
  assert.equal(frameTargetAt(doc, 'page', {x: 20, y: 20}), 'back', 'a click on a layer inside a frame votes for the frame');
  assert.equal(frameTargetAt(doc, 'page', {x: 250, y: 250}), 'front', 'the frontmost of two');
  assert.equal(frameTargetAt(doc, 'page', {x: 1100, y: 100}), 'inSection');
  assert.equal(frameTargetAt(doc, 'page', {x: 1500, y: 500}), null, 'a section itself is not voted for');
  assert.equal(frameTargetAt(doc, 'page', {x: 2050, y: 50}), null);
  assert.equal(frameTargetAt(doc, 'page', {x: 3050, y: 50}), null, 'a loose shape is not a frame');
  assert.equal(frameTargetAt(doc, 'nope', {x: 20, y: 20}), null);
  assert.equal(targetLabel(doc, 'front'), 'Catalog');
  assert.equal(targetLabel(doc, 'gone'), 'Deleted object');
});

test('server clock: the sample with the shortest round trip wins, so a slow answer never drags the estimate', () => {
  const server = createServerClock(() => 1_000);
  server.sample(5_000, 900, 1_000); // rtt 100: offset 5000 + 50 − 1000 = 4050
  assert.equal(server.offset(), 4_050);
  server.sample(9_000, 0, 2_000); // rtt 2000: ignored, the first is better
  assert.equal(server.offset(), 4_050);
  server.sample(5_010, 990, 1_000); // rtt 10: offset 4015
  assert.equal(server.offset(), 4_015);
  assert.equal(server.now(), 5_015);
});

function meetingState(revision: number, fields: Partial<DesignMeetingState> = {}): DesignMeetingState {
  return {revision, now: 1_000_000, timer: null, vote: null, canControl: true, ...fields};
}
const vote = (fields: Partial<MeetingVote> = {}): MeetingVote => ({
  id: '00000000-0000-4000-8000-000000000001',
  by: {id: 'u1', name: 'Anna'},
  perPerson: 2,
  withTimer: false,
  startedAt: 0,
  endsAt: null,
  endedAt: null,
  mine: [],
  results: null,
  voters: null,
  prompt: null,
  hideCursors: false,
  ...fields,
});

test('meeting session: signals read once at a time; an older answer never replaces a newer one; own votes in another tab', async () => {
  const time = clock();
  const answers: ((state: DesignMeetingState) => void)[] = [];
  let reads = 0;
  const transport: MeetingTransport = {
    read: () => {
      reads++;
      return new Promise(resolve => answers.push(resolve));
    },
    timer: async () => meetingState(9),
    vote: async () => meetingState(9),
    ballot: async () => meetingState(9),
  };
  let user = 'u1';
  const session = createMeetingSession({fileId: 'f', client: () => 'c1', user: () => user, transport, timers: time.timers});
  session.refresh();
  assert.equal(reads, 1);
  session.signal({revision: 3});
  await time.advance(300);
  assert.equal(reads, 1, 'a signal while a read is on its way waits for it');
  answers.shift()!(meetingState(2));
  await time.advance(1);
  assert.equal(session.state()?.revision, 2);
  assert.equal(reads, 2, 'then reads once more');
  answers.shift()!(meetingState(3));
  await time.advance(1);
  assert.equal(session.state()?.revision, 3);
  session.signal({revision: 3});
  await time.advance(300);
  assert.equal(reads, 2, 'a revision already shown is not read again');
  // An action's answer and a late read: the later revision stays.
  assert.equal(await session.timer({action: 'add'}), true);
  assert.equal(session.state()?.revision, 9);
  session.signal({revision: 10});
  await time.advance(300);
  answers.shift()!(meetingState(4));
  await time.advance(1);
  assert.equal(session.state()?.revision, 9, 'a stale answer is dropped');
  // Only this person's votes changed (another tab): read; someone else's: ignore.
  session.signal({revision: 9, user: 'u2'});
  await time.advance(300);
  assert.equal(reads, 3);
  session.signal({revision: 9, user});
  await time.advance(300);
  assert.equal(reads, 4);
  user = 'x';
  session.dispose();
});

test('meeting session: a re-read with nothing new wakes no one; the same revision with this person\'s new votes does', async () => {
  const time = clock();
  const answers: ((state: DesignMeetingState) => void)[] = [];
  const transport: MeetingTransport = {
    read: () => new Promise(resolve => answers.push(resolve)),
    timer: async () => meetingState(1),
    vote: async () => meetingState(1),
    ballot: async () => meetingState(1),
  };
  const session = createMeetingSession({fileId: 'f', client: () => 'c1', user: () => 'u1', transport, timers: time.timers});
  let wakes = 0;
  session.subscribe(() => wakes++);
  session.refresh();
  answers.shift()!(meetingState(5, {vote: vote()}));
  await time.advance(1);
  assert.equal(wakes, 1);
  const shown = session.state();
  // The poll or a stream notice reads again: same revision, only the server's clock moved.
  session.refresh();
  answers.shift()!(meetingState(5, {now: 1_000_500, vote: vote()}));
  await time.advance(1);
  assert.equal(wakes, 1, 'nothing new: no re-render');
  assert.equal(session.state(), shown, 'the shown state stays the same object');
  // This person voted in another tab: same revision, their own ballots differ.
  session.refresh();
  answers.shift()!(meetingState(5, {vote: vote({mine: [{nodeId: 'n1', count: 1}]})}));
  await time.advance(1);
  assert.equal(wakes, 2);
  assert.deepEqual(session.state()?.vote?.mine, [{nodeId: 'n1', count: 1}]);
  session.dispose();
});

test('meeting session: a ballot shows at once, the answer corrects it, a refused one reads the truth; a timed vote is read at its end', async () => {
  const time = clock();
  let reads = 0;
  const ballots: unknown[] = [];
  let refuse = false;
  const errors: string[] = [];
  let release: (() => void) | null = null;
  const transport: MeetingTransport = {
    read: async () => {
      reads++;
      return meetingState(2, {vote: vote({mine: []})});
    },
    timer: async () => meetingState(2),
    vote: async () => meetingState(2),
    ballot: async (_file, ballot) => {
      ballots.push(ballot);
      if (refuse) throw Object.assign(new Error('Voting has already ended.'), {status: 409});
      await new Promise<void>(resolve => (release = resolve));
      return meetingState(2, {vote: vote({mine: [{nodeId: 'a', count: 1}]})});
    },
  };
  const session = createMeetingSession({fileId: 'f', client: () => 'c1', user: () => 'u1', transport, timers: time.timers, onError: message => errors.push(message)});
  session.refresh();
  await time.advance(1);
  const voted = session.ballot('a', 1);
  assert.deepEqual(session.state()?.vote?.mine, [{nodeId: 'a', count: 1}], 'shown before the answer');
  assert.deepEqual(ballots, [{voteId: vote().id, nodeId: 'a', delta: 1, client: 'c1'}]);
  release!();
  assert.equal(await voted, true);
  assert.equal(await session.ballot('b', -1), false, 'no vote there: nothing is sent');
  assert.equal(ballots.length, 1);
  refuse = true;
  const before = reads;
  assert.equal(await session.ballot('b', 1), false);
  assert.equal(errors.length, 1);
  await time.advance(1);
  assert.ok(reads > before, 'a refused ballot reads the truth');
  session.dispose();

  // A vote that ends with its timer is read a moment after the end, by each editor a little apart.
  const time2 = clock();
  let reads2 = 0;
  const endsAt = time2.now + 60_000;
  const session2 = createMeetingSession({
    fileId: 'f',
    client: () => null,
    user: () => 'u1',
    timers: time2.timers,
    clock: createServerClock(time2.timers.now),
    transport: {...transport, read: async () => (reads2++, meetingState(1, {now: time2.now, vote: vote({endsAt, withTimer: true})}))},
  });
  session2.refresh();
  await time2.advance(1);
  assert.equal(reads2, 1);
  await time2.advance(59_000);
  assert.equal(reads2, 1);
  await time2.advance(2_000);
  assert.equal(reads2, 2, 'read again once the vote has ended');
  session2.dispose();
});

function peer(connection: string, fields: Partial<DesignPeer> = {}): DesignPeer {
  return {...EMPTY_PRESENCE, connection, user: 'user-' + connection, name: 'Name ' + connection, color: 1, role: 'editor', page: 'p', cursor: {x: 0, y: 0}, ...fields};
}

test('meeting presence: chat, emotes, waves and spotlight go out with the cursor posts, and only once set', async () => {
  const posts: DesignPresencePost[] = [];
  const presence = createLocalPresence(async post => (posts.push(post), true), {intervalMs: 0});
  presence.connected('token-123456789012');
  presence.set({cursor: {x: 1, y: 2}});
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(posts.at(-1)!.meeting, undefined, 'an editor without the meeting never sends the field');
  const local = createLocalMeeting(presence, () => 0.25);
  local.chat('');
  local.chat('Hello');
  local.emote('fire');
  local.emote('fire');
  await new Promise(resolve => setTimeout(resolve, 5));
  const last = posts.at(-1)!.meeting!;
  assert.equal(last.chat, 'Hello');
  assert.deepEqual(last.emote, {id: 'fire', n: 2}, 'each burst counts, so the same emote twice is two bursts');
  local.wave(true);
  const wave = local.current().wave;
  local.wave(true);
  assert.equal(local.current().wave, wave, 'one wave while held');
  local.spotlight(true);
  assert.ok(local.current().spotlight);
  local.spotlight(false);
  local.chat(null);
  assert.deepEqual({...local.current(), emote: null, wave: null}, {chat: null, emote: null, wave: null, spotlight: null});
  assert.equal(sameMeetingPresence(null, undefined), true);
  assert.equal(sameMeetingPresence({chat: 'a', emote: null, wave: null, spotlight: null}, {chat: 'a', emote: null, wave: null, spotlight: null}), true);
  presence.dispose();
});

test('the others: a burst plays only when it is new, chat and waves are reported, a high five once per pair', () => {
  const later: (() => void)[] = [];
  const peers = createPeerStore({timers: {setTimeout: run => later.push(run), clearTimeout: () => {}}});
  const events: string[] = [];
  let me: {wave: number; cursor: {x: number; y: number}} | null = null;
  const watcher = watchPeers(
    peers,
    {
      burst: (who, id) => events.push(`burst ${who.connection} ${id}`),
      chat: (who, text) => events.push(`chat ${who.connection} ${text}`),
      wave: (who, waving) => events.push(`wave ${who.connection} ${waving}`),
      highFive: (a, b) => events.push(`high five ${a} ${b}`),
      gone: connection => events.push(`gone ${connection}`),
    },
    () => (me ? {connection: 'me', wave: me.wave, page: 'p', cursor: me.cursor, zoom: 1} : null),
  );
  // Someone who arrives mid-burst and mid-chat: the chat shows, the old burst does not replay.
  peers.reset([peer('a', {meeting: {chat: 'hi all', emote: {id: 'heart', n: 4}, wave: null, spotlight: null}})], {connection: 'me', user: 'u-me'});
  assert.deepEqual(events.splice(0), ['chat a hi all']);
  peers.update([peer('a', {meeting: {chat: 'hi all', emote: {id: 'heart', n: 5}, wave: null, spotlight: null}})]);
  assert.deepEqual(events.splice(0), ['burst a heart']);
  peers.update([peer('a', {cursor: {x: 10, y: 0}, meeting: {chat: null, emote: {id: 'heart', n: 5}, wave: 7, spotlight: null}})]);
  assert.deepEqual(events.splice(0), ['chat a null', 'wave a true']);
  me = {wave: 3, cursor: {x: 30, y: 0}};
  watcher.check();
  assert.deepEqual(events.splice(0), ['high five a me']);
  watcher.check();
  assert.deepEqual(events.splice(0), [], 'once per pair of waves');
  peers.leave('a');
  assert.deepEqual(events.splice(0), [], 'someone who left stays a moment (PRESENCE_LINGER_MS): they may be reconnecting');
  later.splice(0).forEach(run => run());
  assert.deepEqual(events.splice(0), ['gone a']);
  watcher.dispose();
});

test('"Get attention": everyone follows the presenter, may step away and come back; the latest presenter wins', () => {
  const peers = createPeerStore();
  const sent: DesignPresencePost[] = [];
  const presence = createLocalPresence(async post => (sent.push(post), true));
  const local = createLocalMeeting(presence);
  const yields: string[] = [];
  const spotlight = createSpotlight({peers, local, self: () => 'me', onYield: name => yields.push(name)});
  peers.reset([peer('a'), peer('b')], {connection: 'me', user: 'u-me'});
  assert.deepEqual(spotlight.view(), {presenter: null, mine: false, following: false});
  peers.update([peer('a', {meeting: {chat: null, emote: null, wave: null, spotlight: 11}})]);
  assert.equal(peers.following(), 'a', 'everyone follows the presenter at once');
  assert.equal(spotlight.view().following, true);
  // Escape (or a pan) steps away: the pill offers to follow again, and nothing pulls the view back.
  peers.follow(null);
  assert.deepEqual(spotlight.view(), {presenter: {connection: 'a', name: 'Name a', color: 1}, mine: false, following: false});
  peers.update([peer('a', {cursor: {x: 5, y: 5}, meeting: {chat: null, emote: null, wave: null, spotlight: 11}})]);
  assert.equal(peers.following(), null);
  spotlight.rejoin();
  assert.equal(peers.following(), 'a');
  // Another person starts: they are the latest, so everyone follows them.
  peers.update([peer('b', {meeting: {chat: null, emote: null, wave: null, spotlight: 12}})]);
  assert.equal(peers.following(), 'b');
  // This editor starts: it stops following; when someone starts after it, it gives way.
  spotlight.start();
  assert.equal(spotlight.view().mine, true);
  assert.equal(peers.following(), null);
  peers.update([peer('a', {meeting: {chat: null, emote: null, wave: null, spotlight: 13}})]);
  assert.equal(spotlight.view().mine, false);
  assert.deepEqual(yields, ['Name a']);
  assert.equal(peers.following(), 'a');
  // The presenter stops: following ends with it.
  peers.update([peer('a', {meeting: {chat: null, emote: null, wave: null, spotlight: null}}), peer('b', {meeting: null})]);
  assert.equal(peers.following(), null);
  assert.equal(spotlight.view().presenter, null);
  spotlight.dispose();
  presence.dispose();
});
