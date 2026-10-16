import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocument, createNode} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {
  anchorAt,
  anchorIssue,
  anchorPoint,
  commentSegments,
  commentTargetAt,
  commentTextIssue,
  designCommentLink,
  mentionsIssue,
  shiftMentions,
  type DesignCommentThread,
} from '../shared/design/comments';
import {
  avatarColor,
  clusterPins,
  initials,
  insertMention,
  listThreads,
  matchMembers,
  mentionQueryAt,
  mergeChanges,
  relativeTime,
  repliesLabel,
  sameClusters,
  separatingZoom,
  tidyDraft,
  unreadCount,
  DEFAULT_FILTER,
} from '../src/design/comments/model';
import {linkedThreadId} from '../src/design/comments/links';
import {budget} from './helpers/speed';

// Comments (docs/design-tool.md §Teams "Comments"): anchoring a pin to a layer and following it, the text and mention rules shared
// with the server, and the client model (merging changes, filters, unread, clusters, typing mentions, links).

function documentWith(...nodes: SceneNode[]): DesignDocument {
  const doc = createDocument('0:1');
  const pageId = doc.pages[0];
  for (const node of nodes) {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  }
  return {...doc, nodes: {...doc.nodes, [pageId]: {...doc.nodes[pageId]}}};
}

const thread = (id: string, fields: Partial<DesignCommentThread> = {}): DesignCommentThread => ({
  id,
  seq: 1,
  anchor: {pageId: 'p1', x: 0, y: 0, nodeId: null, offset: null},
  author: {id: 'u1', name: 'Anna'},
  createdAt: '2026-10-07T10:00:00.000Z',
  resolvedAt: null,
  resolvedBy: null,
  comments: [{id: id + ':c', author: {id: 'u1', name: 'Anna'}, text: 'Text', mentions: [], createdAt: '2026-10-07T10:00:00.000Z', editedAt: null, seq: 1}],
  readSeq: 0,
  unread: 0,
  ...fields,
});

test('a pin follows its layer: it moves, resizes and rotates with it, and stays where it was once the layer is gone', () => {
  const doc0 = createDocument('0:1');
  const pageId = doc0.pages[0];
  const frame = createNode('FRAME', {id: 'f1', parentId: pageId, x: 100, y: 200, width: 400, height: 300});
  const inner = createNode('FRAME', {id: 'f2', parentId: 'f1', x: 50, y: 60, width: 100, height: 100});
  const rect = createNode('RECTANGLE', {id: 'r1', parentId: 'f2', x: 0, y: 0, width: 100, height: 100});
  const doc = documentWith(frame, inner, rect);
  // The innermost frame under the point (not the rectangle: shapes are not targets).
  assert.equal(commentTargetAt(doc, pageId, {x: 160, y: 270}), 'f2');
  assert.equal(commentTargetAt(doc, pageId, {x: 110, y: 210}), 'f1');
  assert.equal(commentTargetAt(doc, pageId, {x: 10, y: 10}), null, 'the canvas');
  const anchor = anchorAt(doc, pageId, {x: 160, y: 270});
  assert.deepEqual(anchor, {pageId, x: 160, y: 270, nodeId: 'f2', offset: {x: 10, y: 10}});
  assert.equal(anchorIssue(anchor), null);
  assert.deepEqual(anchorPoint(doc, anchor), {x: 160, y: 270, attached: true});
  // The parent moves: the pin moves with it.
  const moved = {...doc, nodes: {...doc.nodes, f1: {...doc.nodes.f1, x: 300, y: 0}}};
  assert.deepEqual(anchorPoint(moved, anchor), {x: 360, y: 70, attached: true});
  // Rotated 90° (counter-clockwise on screen) about its own top-left.
  const rotated = {...doc, nodes: {...doc.nodes, f2: {...doc.nodes.f2, rotation: 90}}};
  const point = anchorPoint(rotated, anchor);
  assert.ok(Math.abs(point.x - 160) < 1e-9 && Math.abs(point.y - 250) < 1e-9, JSON.stringify(point));
  // Gone, or moved to another page: the last absolute point.
  const {f2: _gone, ...rest} = doc.nodes;
  assert.deepEqual(anchorPoint({...doc, nodes: rest}, anchor), {x: 160, y: 270, attached: false});
  const otherPage = {...anchor, pageId: 'elsewhere'};
  assert.deepEqual(anchorPoint(doc, otherPage), {x: 160, y: 270, attached: false});
  // On the canvas: no layer, no offset.
  assert.deepEqual(anchorAt(doc, pageId, {x: 10.123, y: -5.556}), {pageId, x: 10.12, y: -5.56, nodeId: null, offset: null});
  // Hidden frames are not targets; locked ones are (a comment does not change them); instances are not entered.
  const hidden = {...doc, nodes: {...doc.nodes, f2: {...doc.nodes.f2, visible: false}}};
  assert.equal(commentTargetAt(hidden, pageId, {x: 160, y: 270}), 'f1');
  const locked = {...doc, nodes: {...doc.nodes, f2: {...doc.nodes.f2, locked: true}}};
  assert.equal(commentTargetAt(locked, pageId, {x: 160, y: 270}), 'f2');
});

test('finding the layer under a click walks only the containers under it (a big page stays fast)', () => {
  const doc0 = createDocument('0:1');
  const pageId = doc0.pages[0];
  const frames: SceneNode[] = [];
  for (let i = 0; i < 2000; i++) {
    const id = 'f' + i;
    frames.push(createNode('FRAME', {id, parentId: pageId, x: (i % 50) * 120, y: Math.floor(i / 50) * 120, width: 100, height: 100}));
    for (let j = 0; j < 9; j++) frames.push(createNode('RECTANGLE', {id: id + 'r' + j, parentId: id, x: j * 10, y: 0, width: 8, height: 8}));
  }
  const doc = documentWith(...frames);
  const started = performance.now();
  for (let i = 0; i < 50; i++) commentTargetAt(doc, pageId, {x: 120 * 7 + 50, y: 120 * 20 + 50});
  const each = (performance.now() - started) / 50;
  assert.equal(commentTargetAt(doc, pageId, {x: 120 * 7 + 50, y: 120 * 20 + 50}), 'f1007');
  assert.ok(each < budget(4), `${each.toFixed(2)} ms per click`);
});

test('text and mentions: plain text within the limits, mentions inside it; segments never parse markup', () => {
  assert.equal(commentTextIssue('Hello'), null);
  for (const bad of ['', '   ', ' x', 'x\n', 'a\u0000b', 'a\u001bb', 'a\ud800b', 'x'.repeat(4001), 42])
    assert.ok(commentTextIssue(bad), JSON.stringify(bad));
  assert.equal(commentTextIssue('Line\nand\ttab 👍'), null);
  const text = 'Look, see @Anna & @Boris';
  const mentions = [{userId: 'a', at: 10, length: 5}, {userId: 'b', at: 18, length: 6}];
  assert.equal(mentionsIssue(text, mentions), null);
  assert.ok(mentionsIssue(text, [mentions[1], mentions[0]]), 'in order');
  assert.ok(mentionsIssue(text, [{userId: 'a', at: 11, length: 4}]), 'at an "@"');
  assert.ok(mentionsIssue(text, [{userId: 'a', at: 20, length: 10}]), 'inside the text');
  assert.ok(mentionsIssue(text, [{userId: 'a', at: 10, length: 1}]), 'more than the "@"');
  assert.ok(mentionsIssue(text, 'x'), 'a list');
  assert.deepEqual(commentSegments(text, mentions), [
    {text: 'Look, see '},
    {text: '@Anna', userId: 'a'},
    {text: ' & '},
    {text: '@Boris', userId: 'b'},
  ]);
  assert.deepEqual(commentSegments('<b>x</b>', []), [{text: '<b>x</b>'}]);
  // Editing moves the mentions after the edit and drops one it touches.
  assert.deepEqual(shiftMentions(mentions, 0, 0, 3), [{userId: 'a', at: 13, length: 5}, {userId: 'b', at: 21, length: 6}]);
  assert.deepEqual(shiftMentions(mentions, 12, 13, 0), [{userId: 'b', at: 17, length: 6}]);
  assert.deepEqual(shiftMentions(mentions, 15, 16, 0), [{userId: 'a', at: 10, length: 5}, {userId: 'b', at: 17, length: 6}]);
});

test('anchors: ids of the document\'s shape, finite bounded points, an offset exactly with a layer', () => {
  const base = {pageId: '0:1', x: 1, y: 2, nodeId: null, offset: null};
  assert.equal(anchorIssue(base), null);
  assert.equal(anchorIssue({...base, nodeId: '12:3', offset: {x: 0, y: 0}}), null);
  for (const bad of [null, {}, {...base, pageId: ''}, {...base, pageId: '<b>'}, {...base, x: Infinity}, {...base, y: Number.NaN}, {...base, x: 2e9},
    {...base, nodeId: '1:2'}, {...base, offset: {x: 0, y: 0}}, {...base, nodeId: '1:2', offset: {x: 0, y: Infinity}}, {...base, pageId: 'x'.repeat(513)}])
    assert.ok(anchorIssue(bad), JSON.stringify(bad));
});

test('merging changes: newer copies win, tombstones remove, answers in any order converge, the read state a viewer marked stays', () => {
  const empty = new Map<string, DesignCommentThread>();
  const a1 = thread('a', {seq: 1}),
    a3 = thread('a', {seq: 3, unread: 2}),
    b2 = thread('b', {seq: 2});
  const merged = mergeChanges(empty, [a1, b2]);
  assert.deepEqual([...merged.keys()], ['a', 'b']);
  assert.equal(mergeChanges(merged, [a1]), merged, 'the same copy changes nothing');
  const newer = mergeChanges(merged, [a3]);
  assert.equal(newer.get('a')!.seq, 3);
  assert.equal(mergeChanges(newer, [a1]).get('a')!.seq, 3, 'an older answer never replaces a newer copy');
  assert.equal(mergeChanges(newer, [{id: 'a', deleted: true, seq: 4}]).has('a'), false);
  assert.equal(mergeChanges(newer, [{id: 'a', deleted: true, seq: 2}]).has('a'), true, 'a stale tombstone');
  assert.equal(mergeChanges(empty, [{id: 'a', deleted: true, seq: 5}, thread('a', {seq: 4})]).has('a'), false, 'a tombstone in the same page wins over older copies');
  // Marked read here a moment before an older answer arrived.
  const read = mergeChanges(newer, [{...a3, unread: 0, readSeq: 3}]);
  const stale = mergeChanges(read, [a3]);
  assert.deepEqual([stale.get('a')!.unread, stale.get('a')!.readSeq], [0, 3]);
  assert.equal(unreadCount(newer), 2);
  assert.equal(unreadCount(mergeChanges(newer, [{...a3, seq: 5, resolvedAt: '2026-10-07T11:00:00.000Z'}])), 0, 'resolved threads do not count');
});

test('the panel: open or resolved, only mine, only mentions, by date or by page', () => {
  const you = 'me';
  const threads = mergeChanges(new Map(), [
    thread('old', {createdAt: '2026-10-01T10:00:00.000Z', comments: [{...thread('x').comments[0], createdAt: '2026-10-01T10:00:00.000Z'}], anchor: {pageId: 'p2', x: 0, y: 0, nodeId: null, offset: null}}),
    thread('new', {createdAt: '2026-10-05T10:00:00.000Z', comments: [{...thread('x').comments[0], createdAt: '2026-10-05T10:00:00.000Z', mentions: [{userId: you, at: 0, length: 3}], text: '@Me'}]}),
    thread('mine', {author: {id: you, name: 'Me'}, createdAt: '2026-10-03T10:00:00.000Z', comments: [{...thread('x').comments[0], author: {id: you, name: 'Me'}, createdAt: '2026-10-03T10:00:00.000Z'}]}),
    thread('done', {resolvedAt: '2026-10-06T10:00:00.000Z'}),
  ]);
  const ids = (filter: Partial<typeof DEFAULT_FILTER>) => listThreads(threads, {...DEFAULT_FILTER, ...filter}, you, ['p1', 'p2']).map(each => each.id);
  assert.deepEqual(ids({}), ['new', 'mine', 'old']);
  assert.deepEqual(ids({status: 'resolved'}), ['done']);
  assert.deepEqual(ids({mine: true}), ['mine']);
  assert.deepEqual(ids({mentions: true}), ['new']);
  assert.deepEqual(ids({sort: 'page'}), ['new', 'mine', 'old'], 'page 1 first, then page 2');
  assert.deepEqual(listThreads(threads, {...DEFAULT_FILTER, sort: 'page'}, you, ['p2', 'p1']).map(each => each.id), ['old', 'new', 'mine']);
});

test('the panel: unread threads first, as Figma sorts by unread, and the search finds text and people', () => {
  // The search text of thread "old" is Cyrillic on purpose: the search folds ё to е ("цвет елки" finds "ЦВЕТ ёлки").
  const you = 'me';
  const merged = mergeChanges(new Map(), [
    thread('old', {createdAt: '2026-10-01T10:00:00.000Z', comments: [{...thread('x').comments[0], createdAt: '2026-10-01T10:00:00.000Z', text: 'Поменять ЦВЕТ ёлки'}]}),
    thread('new', {createdAt: '2026-10-05T10:00:00.000Z', comments: [{...thread('x').comments[0], createdAt: '2026-10-05T10:00:00.000Z', text: 'Spacing'}]}),
    thread('mine', {author: {id: you, name: 'Jane'}, createdAt: '2026-10-03T10:00:00.000Z', comments: [{...thread('x').comments[0], author: {id: you, name: 'Jane'}, createdAt: '2026-10-03T10:00:00.000Z', text: 'Font'}]}),
  ]);
  const threads = new Map([...merged].map(([id, each]) => [id, {...each, unread: id === 'old' ? 1 : 0}]));
  const ids = (filter: Partial<typeof DEFAULT_FILTER>) => listThreads(threads, {...DEFAULT_FILTER, ...filter}, you, ['p1']).map(each => each.id);
  assert.deepEqual(ids({sort: 'date'}), ['new', 'mine', 'old']);
  assert.deepEqual(ids({sort: 'unread'}), ['old', 'new', 'mine'], 'the unread thread first, then newest');
  assert.deepEqual(ids({query: 'цвет елки'}), ['old'], 'any case, "е" for "ё", every word');
  assert.deepEqual(ids({query: 'jane'}), ['mine'], 'by a person in the thread');
  assert.deepEqual(ids({query: '  '}), ['new', 'mine', 'old'], 'a blank search shows all');
  assert.deepEqual(ids({query: 'no such text'}), []);
});

test('clusters: pins closer than the radius share a bubble; a pan keeps the same clusters', () => {
  const points = [{id: 'a', x: 0, y: 0}, {id: 'b', x: 10, y: 5}, {id: 'c', x: 100, y: 0}, {id: 'd', x: 27, y: 0}, {id: 'e', x: 29, y: 0}];
  const clusters = clusterPins(points, 28);
  assert.deepEqual(clusters.map(cluster => cluster.ids), [['a', 'b', 'd', 'e'], ['c']], 'pins that reach each other through others share one');
  assert.deepEqual([clusters[0].x, clusters[0].y], [16.5, 1.25], 'at their centre');
  assert.deepEqual(clusterPins([{id: 'x', x: 0, y: 0}, {id: 'y', x: 40, y: 0}], 28).map(cluster => cluster.ids), [['x'], ['y']]);
  const panned = clusterPins(points.map(point => ({...point, x: point.x + 0.5})), 28);
  assert.ok(sameClusters(clusters, panned));
  assert.ok(!sameClusters(clusters, clusterPins(points, 5)));
  // A click on a cluster zooms in until its closest pins are a bubble apart, at least twice, at most 400 %.
  assert.equal(separatingZoom([{x: 0, y: 0}, {x: 18, y: 0}, {x: 36, y: 0}], 28, 0.06), (28 * 1.25) / 18);
  assert.equal(separatingZoom([{x: 0, y: 0}, {x: 1000, y: 0}], 28, 0.5), 1);
  assert.equal(separatingZoom([{x: 0, y: 0}, {x: 1, y: 0}], 28, 0.5), 4);
  const many = Array.from({length: 5000}, (_, i) => ({id: String(i), x: (i * 37) % 4000, y: Math.floor(i / 100) * 9}));
  // The best of three runs: one run alone is at the mercy of a collection pause on a busy machine.
  let best = Infinity;
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    clusterPins(many, 28);
    best = Math.min(best, performance.now() - started);
  }
  assert.ok(best < budget(20), `linear in the number of pins (${best.toFixed(1)} ms)`);
});

test('typing a mention: the "@query" before the caret, members matched by any word, the mention inserted and the rest moved', () => {
  assert.deepEqual(mentionQueryAt('Hello, @an', 10), {start: 7, query: 'an'});
  assert.deepEqual(mentionQueryAt('@', 1), {start: 0, query: ''});
  assert.equal(mentionQueryAt('mail@example', 12), null, 'not inside a word');
  assert.equal(mentionQueryAt('@an\nnext one', 12), null, 'not across a line break');
  assert.equal(mentionQueryAt('Hello', 5), null);
  // Right after a mention is inserted the text before the caret still reads "@Name ": the list must not open on it again.
  const inserted = insertMention('Look, see @Bo', [], 10, 13, {userId: 'u2', name: 'Boris'});
  assert.equal(inserted.text, 'Look, see @Boris ');
  assert.equal(mentionQueryAt(inserted.text, inserted.caret, inserted.mentions), null, 'a finished mention');
  assert.deepEqual(mentionQueryAt(inserted.text + '@', inserted.caret + 1, inserted.mentions), {start: 17, query: ''}, 'a new "@" after it opens');
  // The Cyrillic name "Ёлка" is on purpose: member matching treats ё and е as one letter.
  const members = [{userId: 'a', name: 'Anna Petrova'}, {userId: 'b', name: 'Boris Anisimov'}, {userId: 'c', name: 'Ёлка'}];
  assert.deepEqual(matchMembers(members, 'an').map(member => member.userId), ['a', 'b']);
  assert.deepEqual(matchMembers(members, 'pet').map(member => member.userId), ['a']);
  assert.deepEqual(matchMembers(members, 'елк').map(member => member.userId), ['c'], 'ё and е are one letter');
  const before = {text: 'Hello, @an, cf. @Boris Anisimov', mentions: [{userId: 'b', at: 16, length: 15}]};
  const result = insertMention(before.text, before.mentions, 7, 10, members[0]);
  assert.equal(result.text, 'Hello, @Anna Petrova , cf. @Boris Anisimov');
  assert.deepEqual(result.mentions, [{userId: 'a', at: 7, length: 13}, {userId: 'b', at: 27, length: 15}]);
  assert.equal(result.caret, 21);
  assert.equal(mentionsIssue(result.text, result.mentions), null);
  // Sending trims the outer spaces and normalizes line breaks; the mentions move with the text.
  const tidy = tidyDraft('  \r\n@Anna Petrova hello\r\n ', [{userId: 'a', at: 4, length: 13}]);
  assert.deepEqual(tidy, {text: '@Anna Petrova hello', mentions: [{userId: 'a', at: 0, length: 13}]});
  assert.equal(commentTextIssue(tidy.text), null);
});

test('people and time: initials, steady colours, short English times and counts', () => {
  assert.equal(initials('Anna Smith'), 'AS');
  assert.equal(initials('  boris  '), 'B');
  assert.equal(initials('"Studio" North'), 'SN');
  assert.equal(initials(''), '?');
  assert.equal(avatarColor('u1'), avatarColor('u1'));
  assert.equal(avatarColor(null), '#6E6E6E');
  const now = Date.parse('2026-10-07T12:00:00Z');
  assert.equal(relativeTime('2026-10-07T11:59:30Z', now), 'just now');
  assert.equal(relativeTime('2026-10-07T11:55:00Z', now), '5 min ago');
  assert.equal(relativeTime('2026-10-07T09:00:00Z', now), '3 h ago');
  assert.match(relativeTime('2026-09-01T09:00:00Z', now), /^Sep 1$/);
  assert.match(relativeTime('2025-09-01T09:00:00Z', now), /^Sep 1, 2025$/);
  assert.deepEqual([1, 2, 5, 11, 21, 22].map(repliesLabel), ['1 reply', '2 replies', '5 replies', '11 replies', '21 replies', '22 replies']);
});

test('links to a thread: copied for this file, read back only for it', () => {
  const link = designCommentLink({origin: 'https://foo.test', pathname: '/'}, 'file-1', 'thread-2');
  assert.equal(link, 'https://foo.test/#design/file-1?comment=thread-2');
  const hash = new URL(link).hash;
  assert.equal(linkedThreadId(hash, 'file-1'), 'thread-2');
  assert.equal(linkedThreadId(hash, 'file-2'), null);
  assert.equal(linkedThreadId('#design/file-1', 'file-1'), null);
  assert.equal(linkedThreadId('#design/file-1?node=1:2', 'file-1'), null);
  assert.equal(linkedThreadId('#designs', 'file-1'), null);
});

test('the live stream\'s «comments» event pulls every open view of that file, and only while it is open', async () => {
  const {commentFeed, commentsChanged, setCommentFeed} = await import('../src/design/comments/feed');
  setCommentFeed(() => () => undefined);
  try {
    const pulled: string[] = [];
    const stopA = commentFeed()({fileId: 'f1', pull: async () => void pulled.push('a')});
    const stopB = commentFeed()({fileId: 'f1', pull: async () => void pulled.push('b')});
    const stopC = commentFeed()({fileId: 'f2', pull: async () => void pulled.push('c')});
    commentsChanged('f1');
    assert.deepEqual(pulled.sort(), ['a', 'b']);
    stopA();
    stopB();
    commentsChanged('f1');
    assert.deepEqual(pulled.sort(), ['a', 'b'], 'closed views hear nothing');
    commentsChanged('f2');
    assert.deepEqual(pulled.sort(), ['a', 'b', 'c']);
    stopC();
  } finally {
    setCommentFeed(null);
  }
});
