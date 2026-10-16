import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createDocument, createNode} from '../shared/design/defaults';
import {beginTransaction} from '../shared/design/transaction';
import type {TextMeasurer} from '../shared/design/text-layout';
import type {DesignLiveHello} from '../shared/design/live';
import type {Rect} from '../shared/design/geometry';
import type {DesignMeetingState, MeetingBallot, MeetingTally} from '../shared/design/meeting';
import type {NodeId, Vec} from '../shared/design/types';
import type {BoardBadge, BoardClick, BoardMeetingProps, BoardObjectsApi} from '../src/design/board/meeting';
import {createDesignStore} from '../src/design/engine/store';
import type {LiveSession} from '../src/design/realtime/live-session';
import {createLocalPresence, createPeerStore} from '../src/design/realtime/presence';
import {acquireBoardMeeting, boardBadges, boardLabel, boardSurface, boardTargets, releaseBoardMeeting} from '../src/design/meeting/board-adapter';
import type {SurfaceHooks} from '../src/design/meeting/surface';
import type {MeetingTransport} from '../src/design/meeting/session';
import {createMeetingSound, type SoundEnvironment} from '../src/design/meeting/sound';

// "Meeting" on a board against the board's meeting slot (docs/board-meeting.md "On a board", docs/board.md §Meeting slot), with a fake
// board-objects API: what a vote counts (votable objects only, a sticky named by its words), the voting and reactions modes through
// `interceptClicks` (a click votes, ⌥-click takes back, empty canvas stays the board's, Escape leaves, a press bursts until the button
// comes up), badges through `setBadges('voting')`, and one controller shared by the board's two places: a vote that starts takes the
// board into voting, a click casts a ballot, the end shows results and leaves the mode. Also: the timer's sound waits for a gesture.

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

function boardDocument() {
  const tx = beginTransaction(createDocument('page'));
  tx.create(createNode('FRAME', {id: 'sticky', name: 'Sticky', x: 0, y: 0, width: 100, height: 100}), 'page');
  tx.create(createNode('TEXT', {id: 'sticky-text', name: 'Text', x: 10, y: 10, width: 80, height: 20, text: {characters: 'Idea:   dark\ntheme'}} as never), 'sticky');
  tx.create(createNode('FRAME', {id: 'shape', name: 'Diamond', x: 200, y: 0, width: 100, height: 100}), 'page');
  tx.create(createNode('VECTOR', {id: 'arrow', name: 'Link', x: 100, y: 40, width: 100, height: 2}), 'page');
  return tx.commit({measurer}).doc;
}

/** A board-objects API over fixed boxes: the sticky and the shape are votable, the connector is not. */
function fakeBoard() {
  const boxes: Record<NodeId, Rect> = {sticky: {x: 0, y: 0, width: 100, height: 100}, shape: {x: 200, y: 0, width: 100, height: 100}, arrow: {x: 100, y: 40, width: 100, height: 2}};
  const handlers: ((click: BoardClick) => boolean)[] = [];
  const badges = new Map<string, readonly BoardBadge[]>();
  const objectAtPage = (point: Vec): NodeId | null =>
    Object.entries(boxes).find(([, box]) => point.x >= box.x && point.x <= box.x + box.width && point.y >= box.y - 2 && point.y <= box.y + box.height + 2)?.[0] ?? null;
  const api: BoardObjectsApi = {
    objectAtPage,
    objectAtClient: () => null,
    objectBounds: id => boxes[id] ?? null,
    votableObjects: () => ['sticky', 'shape'],
    setBadges(source, list) {
      if (list.length) badges.set(source, [...list]);
      else badges.delete(source);
    },
    interceptClicks(handler) {
      handlers.push(handler);
      return () => void handlers.splice(handlers.indexOf(handler), 1);
    },
    pageId: () => 'page',
    onPageChange: () => () => undefined,
  };
  /** A primary click as the board offers it: the last interceptor first; false when none took it. */
  const click = (page: Vec, alt = false) => {
    const event: BoardClick = {id: objectAtPage(page), page, clientX: page.x, clientY: page.y, shiftKey: false, altKey: alt, mod: false};
    for (let i = handlers.length - 1; i >= 0; i--) if (handlers[i](event)) return true;
    return false;
  };
  return {api, handlers, badges, click};
}

function hooksLog() {
  const calls: string[] = [];
  const targets = boardTargets(() => board.api);
  const board = fakeBoard();
  const doc = boardDocument();
  const hooks: SurfaceHooks = {
    targetAt: page => targets.at(doc, 'page', page),
    box: id => targets.box(doc, id),
    vote: id => calls.push('vote ' + id),
    unvote: id => calls.push('unvote ' + id),
    press: page => calls.push(`press ${page.x},${page.y}`),
    move: () => undefined,
    release: () => calls.push('release'),
    cursor: () => 'pointer',
    accent: () => '#9747ff',
  };
  return {calls, hooks, board, doc};
}

const key = (name: string) => Object.assign(new Event('keydown'), {key: name});

test('a board votes for its votable objects: a sticky by its words, never a connector; badges as the board draws them', () => {
  const {board, doc} = hooksLog();
  const targets = boardTargets(() => board.api);
  assert.equal(targets.at(doc, 'page', {x: 50, y: 50}), 'sticky');
  assert.equal(targets.at(doc, 'page', {x: 150, y: 41}), null, 'a connector takes no vote');
  assert.equal(targets.at(doc, 'page', {x: 500, y: 500}), null);
  assert.equal(targets.noun, 'stickies and shapes');
  assert.equal(boardLabel(doc, 'sticky'), 'Idea: dark theme', 'a sticky is named by its words, on one line');
  assert.equal(boardLabel(doc, 'shape'), 'Diamond');
  assert.equal(boardLabel(doc, 'gone'), 'Deleted object');
  assert.deepEqual(targets.box(doc, 'shape'), {x: 200, y: 0, width: 100, height: 100});
  assert.deepEqual(
    boardBadges([
      {nodeId: 'sticky', kind: 'mine', count: 2, color: '#f00', label: 'Idea'},
      {nodeId: 'shape', kind: 'result', count: 5, top: true, label: 'Diamond'},
      {nodeId: 'sticky', kind: 'result', count: 1, top: false, label: 'Idea'},
    ]),
    [
      {id: 'sticky', count: 2, tone: 'mine', label: 'Your votes: 2'},
      {id: 'shape', count: 5, tone: 'accent', label: '5 votes'},
      {id: 'sticky', count: 1, tone: 'neutral', label: '1 vote'},
    ],
  );
});

test('the board’s surface: clicks of the voting and reactions modes go to the meeting first; Escape leaves; badges and cleanup', () => {
  const {calls, hooks, board, doc} = hooksLog();
  const store = createDesignStore({doc, measurer, tool: 'sticky'});
  const events = new EventTarget();
  const surface = boardSurface(() => board.api, store, events as unknown as Window)(hooks);
  assert.equal(surface.kind, 'board');
  assert.equal(surface.mode(), null);
  assert.equal(surface.idle(), false, 'busy with the board’s own tool: a vote that starts leaves it alone');
  assert.equal(board.click({x: 50, y: 50}), false, 'no mode: the board keeps its clicks');
  let changes = 0;
  surface.subscribe(() => changes++);

  surface.setMode('vote');
  assert.equal(store.getState().tool, 'move', 'a click on empty canvas never draws a sticky while voting');
  assert.equal(board.handlers.length, 1);
  assert.equal(board.click({x: 50, y: 50}), true);
  assert.equal(board.click({x: 250, y: 50}, true), true);
  assert.equal(board.click({x: 150, y: 41}), false, 'a connector: the board selects it');
  assert.equal(board.click({x: 600, y: 600}), false, 'empty canvas: the board’s marquee and panning');
  assert.deepEqual(calls.splice(0), ['vote sticky', 'unvote shape']);
  assert.match(surface.takeBack, /click an object to remove a vote/);

  events.dispatchEvent(key('Escape'));
  assert.equal(surface.mode(), null);
  assert.equal(board.handlers.length, 0, 'leaving the mode gives the clicks back');

  surface.setMode('emote');
  assert.equal(board.click({x: 10, y: 20}), true);
  assert.deepEqual(calls.splice(0), ['press 10,20']);
  events.dispatchEvent(new Event('pointerup'));
  assert.deepEqual(calls.splice(0), ['release'], 'the burst ends with the button');
  events.dispatchEvent(new Event('pointerup'));
  assert.deepEqual(calls.splice(0), [], 'once');
  assert.equal(board.click({x: 30, y: 40}), true);
  surface.setMode('vote');
  assert.deepEqual(calls.splice(0), ['press 30,40', 'release'], 'switching modes ends a held burst');
  assert.equal(board.handlers.length, 1);
  assert.equal(changes, 4);

  surface.badges!([{nodeId: 'sticky', kind: 'mine', count: 1, color: '#f00', label: 'Idea'}]);
  assert.deepEqual(board.badges.get('voting'), [{id: 'sticky', count: 1, tone: 'mine', label: 'Your votes: 1'}]);
  surface.dispose();
  assert.equal(board.handlers.length, 0);
  assert.equal(board.badges.has('voting'), false, 'closing removes the badges');
});

function fakeLive(hello: DesignLiveHello) {
  const listeners = new Set<(name: string, data: unknown) => void>();
  const presence = createLocalPresence(async () => true, {intervalMs: 0});
  presence.connected(hello.token);
  const live = {
    presence,
    peers: createPeerStore(),
    hello: () => hello,
    connection: () => hello.connection,
    status: () => 'live',
    listen(listener: (name: string, data: unknown) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    stop: () => presence.dispose(),
  };
  return {live: live as unknown as LiveSession, emit: (name: string, data: unknown) => listeners.forEach(listener => listener(name, data))};
}

test('one controller for a board’s two places: a vote that starts takes the board into voting, a click votes, the end shows results', async () => {
  const {board, doc} = hooksLog();
  const store = createDesignStore({doc, measurer});
  const hello = {connection: 'conn-me', token: 'token-123456789012', user: 'u-me', name: 'Anna', color: 2, role: 'editor', canEdit: true, version: 1, peers: []} as unknown as DesignLiveHello;
  const {live, emit} = fakeLive(hello);
  let state: DesignMeetingState = {revision: 1, now: Date.now(), timer: null, vote: null, canControl: true};
  let mine: MeetingTally[] = [];
  const ballots: MeetingBallot[] = [];
  const transport: MeetingTransport = {
    read: async () => ({...state, now: Date.now(), vote: state.vote && {...state.vote, mine}}),
    timer: async () => state,
    vote: async () => state,
    async ballot(_file, ballot) {
      ballots.push({voteId: ballot.voteId, nodeId: ballot.nodeId, delta: ballot.delta});
      mine = ballot.delta > 0 ? [{nodeId: ballot.nodeId, count: 1}] : [];
      return {...state, now: Date.now(), vote: state.vote && {...state.vote, mine}};
    },
  };
  const toasts: string[] = [];
  const props = {
    services: {fileId: 'board-1', store, toast: (message: string) => toasts.push(message), revealNodes: () => undefined, canvas: () => null},
    realtime: {live},
    board: board.api,
    editor: 'board',
  } as unknown as BoardMeetingProps;
  const events = new EventTarget() as unknown as Window;
  const controls = acquireBoardMeeting(props, live, {transport, events});
  const layer = acquireBoardMeeting(props, live, {transport, events});
  assert.equal(controls, layer, 'the pill and the canvas layer share one controller');
  const until = async (check: () => boolean, what: string) => {
    const deadline = Date.now() + 3_000;
    while (!check()) {
      if (Date.now() > deadline) assert.fail(what);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await until(() => controls.controller.session.state()?.revision === 1, 'the first read');

  // Someone starts a vote: the stream says so, the state is read, the board enters voting.
  state = {
    ...state,
    revision: 2,
    vote: {id: '0b6f5c2e-1111-4a5b-9c1d-2e3f4a5b6c7d', by: {id: 'u-boris', name: 'Boris'}, perPerson: 2, withTimer: false, startedAt: Date.now(), endsAt: null, endedAt: null, mine: [], results: null, voters: null, prompt: null, hideCursors: false},
  };
  emit('meeting', {revision: 2});
  await until(() => controls.controller.mode.get() === 'vote', 'voting mode');
  assert.equal(board.handlers.length, 1);
  assert.match(toasts.at(-1)!, /Boris started a vote: you have 2 votes/);
  assert.equal(board.click({x: 50, y: 50}), true);
  await until(() => (board.badges.get('voting') ?? []).length === 1, 'my vote drawn by the board');
  assert.deepEqual(ballots, [{voteId: state.vote!.id, nodeId: 'sticky', delta: 1}]);
  assert.deepEqual(board.badges.get('voting'), [{id: 'sticky', count: 1, tone: 'mine', label: 'Your votes: 1'}]);
  assert.equal(board.click({x: 50, y: 50}, true), true);
  await until(() => !board.badges.has('voting'), 'taken back');
  assert.equal(ballots.at(-1)!.delta, -1);

  // It ends: the results replace the dots and the board leaves voting.
  state = {...state, revision: 3, vote: {...state.vote!, endedAt: Date.now(), results: [{nodeId: 'shape', count: 3}, {nodeId: 'sticky', count: 1}], voters: 2}};
  emit('meeting', {revision: 3});
  await until(() => controls.controller.mode.get() === null, 'out of voting');
  assert.equal(board.handlers.length, 0);
  assert.deepEqual(board.badges.get('voting'), [
    {id: 'shape', count: 3, tone: 'accent', label: '3 votes'},
    {id: 'sticky', count: 1, tone: 'neutral', label: '1 vote'},
  ]);

  releaseBoardMeeting(live, controls);
  assert.ok(board.badges.has('voting'), 'one place left keeps it');
  releaseBoardMeeting(live, layer);
  assert.equal(board.badges.has('voting'), false, 'the last place disposes it');
  live.stop();
});

test('the board loads the meeting lazily through its features list', () => {
  const features = readFileSync(new URL('../src/design/board/features.ts', import.meta.url), 'utf8');
  assert.match(features, /\(\) => import\('\.\.\/meeting\/board'\)/);
  const entry = readFileSync(new URL('../src/design/meeting/board.tsx', import.meta.url), 'utf8');
  assert.match(entry, /registerBoardMeeting\(\{Controls: BoardMeetingControls, CanvasLayer: BoardMeetingCanvasLayer\}\)/);
});

test('timer sound: no audio until a gesture; music waits for it, never runs muted, and a bell before it is skipped', () => {
  const made: string[] = [];
  let activated = false;
  let gesture: (() => void) | null = null;
  const saved = new Map<string, string>();
  class FakeContext {
    state = 'running';
    currentTime = 0;
    destination = {};
    constructor() {
      made.push('context');
    }
    createGain() {
      return {gain: {value: 0, setTargetAtTime() {}, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}}, connect: () => ({connect() {}}), disconnect() {}};
    }
    createOscillator() {
      return {type: 'sine', frequency: {value: 0}, connect: () => ({connect() {}}), start() {}, stop() {}};
    }
    resume = async () => undefined;
    close = async () => undefined;
  }
  const environment: SoundEnvironment = {
    AudioContext: FakeContext as unknown as new () => AudioContext,
    activated: () => activated,
    onGesture(listener) {
      gesture = listener;
      return () => (gesture = null);
    },
    load: key => saved.get(key) ?? null,
    save: (key, value) => void saved.set(key, value),
  };
  const sound = createMeetingSound(environment);
  sound.chime();
  sound.music('lofi');
  assert.deepEqual(made, [], 'a file opened with a running timer stays silent before any gesture');
  gesture!();
  assert.deepEqual(made, ['context'], 'the first press starts the music it waited for');
  sound.setMuted(true);
  assert.equal(saved.get('morfa:meeting:muted'), '1', 'muting is this browser’s own');
  sound.setVolume(0.3);
  assert.equal(sound.muted(), false, 'turning the volume up unmutes');
  assert.equal(saved.get('morfa:meeting:volume'), '0.3');
  sound.dispose();
  assert.equal(gesture, null);
  activated = true;
  const again = createMeetingSound(environment);
  assert.equal(again.volume(), 0.3, 'the volume is remembered');
  again.chime();
  assert.deepEqual(made, ['context', 'context'], 'a page that was already touched rings at once');
  again.dispose();
});
