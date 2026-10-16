import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument, type Account} from './helpers/collab-app';
import {MEETING_LIMITS} from '../shared/design/meeting';

// Voting sessions after FigJam's ("Run voting sessions in FigJam"): a vote's prompt and its "hide cursors" flag,
// how each person voted once it ended (`results[].by`), the ended sessions kept ("Results", the last 20, newest first) and an
// editor deleting one. Who may: anyone who may open the file reads and votes; editors run, clear and delete.

test('meeting votes: the prompt, hidden cursors, who voted for what, the past sessions and deleting one', {timeout: 240_000}, async t => {
  const c = await collabApp(t);
  const {db, files, teams, ok} = c;
  const owner = await c.account('owner', 'Anna');
  const editor = await c.account('editor', 'Boris');
  const viewer = await c.account('viewer', 'Vera');
  const stranger = await c.account('stranger');
  const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
  for (const [who, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
    const invite = ok(await teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1}}), 201);
    ok(await teams(who, `/invites/${invite.token}/accept`, {method: 'POST'}));
  }
  const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Meeting', teamId, document: smallDocument()}}), 201).file.id as string;
  const meeting = (who: Account, suffix = '', init: Parameters<typeof files>[2] = {}) => files(who, `/${id}/meeting${suffix}`, init);
  const vote = (who: Account, body: Record<string, unknown>) => meeting(who, '/vote', {method: 'POST', json: body});
  const ballot = (who: Account, voteId: string, nodeId: string, delta: 1 | -1 = 1) => meeting(who, '/vote/ballot', {method: 'POST', json: {voteId, nodeId, delta}});

  await t.test('a vote with a prompt and the cursors hidden; an editor turns the hiding off; a viewer may not', async () => {
    const started = ok(await vote(editor, {action: 'start', perPerson: 3, durationMs: null, prompt: '  Which\nidea?  ', hideCursors: true})).vote;
    assert.deepEqual([started.prompt, started.hideCursors, started.results, started.endedAt], ['Which idea?', true, null, null]);
    assert.equal(ok(await meeting(viewer)).vote.prompt, 'Which idea?');
    assert.equal((await vote(viewer, {action: 'cursors', hide: false})).status, 403);
    assert.equal(ok(await vote(editor, {action: 'cursors', hide: false})).vote.hideCursors, false);
    assert.equal(ok(await vote(owner, {action: 'cursors', hide: true})).vote.hideCursors, true);
    assert.equal((await vote(editor, {action: 'start', perPerson: 3, durationMs: null, prompt: 'x'.repeat(MEETING_LIMITS.promptLength * 4 + 1)})).status, 400, 'a prompt far too long');
  });

  let first = '';
  await t.test('after the end every tally says who voted for it, the most first; while it runs nobody sees them', async () => {
    const state = ok(await meeting(owner)).vote;
    first = state.id;
    ok(await ballot(owner, first, 'a'));
    ok(await ballot(owner, first, 'a'));
    ok(await ballot(viewer, first, 'a'));
    ok(await ballot(viewer, first, 'b'));
    const running = ok(await meeting(viewer)).vote;
    assert.equal(running.results, null);
    assert.deepEqual(running.mine.map((tally: {nodeId: string; by?: unknown}) => [tally.nodeId, tally.by]), [['a', undefined], ['b', undefined]], 'mine carries no `by`');
    const ended = ok(await vote(editor, {action: 'end'})).vote;
    assert.equal(ended.voters, 2);
    assert.deepEqual(ended.results, [
      {nodeId: 'a', count: 3, by: [{name: 'Anna', count: 2}, {name: 'Vera', count: 1}]},
      {nodeId: 'b', count: 1, by: [{name: 'Vera', count: 1}]},
    ]);
    assert.equal(ended.hideCursors, true, 'the flag stays; the editors show cursors once the vote ended');
    assert.equal((await vote(editor, {action: 'cursors', hide: false})).status, 200, 'after the end: nothing to change');
  });

  await t.test('the past sessions: an ended one is listed before it is archived; start archives a running one; clear keeps it', async () => {
    let past = ok(await meeting(viewer, '/votes')).votes;
    assert.deepEqual(past.map((session: {id: string; prompt: string; voters: number}) => [session.id, session.prompt, session.voters]), [[first, 'Which idea?', 2]]);
    assert.deepEqual(past[0].results[0].by, [{name: 'Anna', count: 2}, {name: 'Vera', count: 1}]);
    assert.ok(past[0].endedAt >= past[0].startedAt);
    // The next vote: the first one is kept with its ballots; this one runs (not listed) until it ends.
    const second = ok(await vote(editor, {action: 'start', perPerson: 1, durationMs: null})).vote.id as string;
    ok(await ballot(editor, second, 'c'));
    assert.deepEqual(ok(await meeting(viewer, '/votes')).votes.map((session: {id: string}) => session.id), [first]);
    // A third start while the second runs: the second ends now and is kept too.
    const third = ok(await vote(editor, {action: 'start', perPerson: 1, durationMs: null, prompt: 'Third'})).vote.id as string;
    past = ok(await meeting(viewer, '/votes')).votes;
    assert.deepEqual(past.map((session: {id: string}) => session.id), [second, first], 'newest first');
    assert.deepEqual(past[0].results, [{nodeId: 'c', count: 1, by: [{name: 'Boris', count: 1}]}]);
    ok(await vote(editor, {action: 'end'}));
    ok(await vote(editor, {action: 'clear'}));
    assert.equal(ok(await meeting(viewer)).vote, null, 'off the meeting');
    assert.deepEqual(ok(await meeting(viewer, '/votes')).votes.map((session: {id: string}) => session.id), [third, second, first], 'clear keeps the session');
    assert.equal((await meeting(stranger, '/votes')).status, 404);
  });

  await t.test('an editor deletes a session with its ballots; a viewer may not; the meeting\'s own vote is cleared with it', async () => {
    assert.equal((await meeting(viewer, `/votes/${first}`, {method: 'DELETE'})).status, 403);
    ok(await meeting(editor, `/votes/${first}`, {method: 'DELETE'}));
    assert.ok(!ok(await meeting(viewer, '/votes')).votes.some((session: {id: string}) => session.id === first));
    assert.equal(Number((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_meeting_votes WHERE file_id=$1 AND vote_id=$2', [id, first]))!.n), 0, 'its ballots went');
    assert.equal((await meeting(editor, `/votes/${first}`, {method: 'DELETE'})).status, 404, 'gone');
    assert.equal((await meeting(editor, '/votes/not-a-vote', {method: 'DELETE'})).status, 400);
    // The vote the meeting shows, deleted: the meeting has none.
    const shown = ok(await vote(editor, {action: 'start', perPerson: 1, durationMs: null})).vote.id as string;
    ok(await vote(editor, {action: 'end'}));
    ok(await meeting(owner, `/votes/${shown}`, {method: 'DELETE'}));
    assert.equal(ok(await meeting(viewer)).vote, null);
  });

  await t.test('the last 20 sessions are kept, newest first; older ones go with their ballots', async () => {
    for (let k = 0; k < MEETING_LIMITS.history + 2; k++) {
      const voteId = ok(await vote(editor, {action: 'start', perPerson: 1, durationMs: null, prompt: `Round ${k}`})).vote.id as string;
      ok(await ballot(viewer, voteId, 'a'));
      ok(await vote(editor, {action: 'end'}));
    }
    ok(await vote(editor, {action: 'clear'}));
    const past = ok(await meeting(viewer, '/votes')).votes;
    assert.equal(past.length, MEETING_LIMITS.history);
    assert.equal(past[0].prompt, `Round ${MEETING_LIMITS.history + 1}`);
    const kept = Number((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_meeting_sessions WHERE file_id=$1', [id]))!.n);
    assert.equal(kept, MEETING_LIMITS.history);
    const orphans = Number(
      (await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_meeting_votes v WHERE v.file_id=$1 AND NOT EXISTS (SELECT 1 FROM design_meeting_sessions s WHERE s.file_id=v.file_id AND s.vote_id=v.vote_id)', [id]))!.n,
    );
    assert.equal(orphans, 0, 'no ballots of a session not kept');
  });
});
