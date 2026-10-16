import assert from 'node:assert/strict';
import {test} from 'node:test';
import {dropAction} from '../src/design/files/drop';

const team = (id: string, role: 'owner' | 'admin' | 'editor' | 'viewer') => ({id, name: 'Studio', role, projects: [{id: 'p1', name: 'Site'}, {id: 'p2', name: 'Logo'}]}) as never;
const TEAMS = [team('t', 'owner'), team('v', 'viewer'), team('e', 'editor')];

test('should move team files into a project of their team when they are dropped on it', () => {
  assert.deepEqual(dropAction([{teamId: 't', projectId: null}], {kind: 'team', teamId: 't', projectId: 'p1'}, TEAMS),
    {kind: 'move', teamId: 't', projectId: 'p1', where: 'to the project "Site"'});
});

test('should refuse a drop on the project the files are already in', () => {
  assert.equal(dropAction([{teamId: 't', projectId: 'p1'}], {kind: 'team', teamId: 't', projectId: 'p1'}, TEAMS), null);
});

test('should take files out of a project when they are dropped on all of the team files', () => {
  assert.deepEqual(dropAction([{teamId: 't', projectId: 'p1'}], {kind: 'team', teamId: 't', projectId: null}, TEAMS),
    {kind: 'move', teamId: 't', projectId: null, where: 'out of any project'});
});

test('should move personal files into a team only when the caller manages it', () => {
  assert.equal(dropAction([{teamId: null}], {kind: 'team', teamId: 't', projectId: null}, TEAMS)?.kind, 'move');
  assert.equal(dropAction([{teamId: null}], {kind: 'team', teamId: 'e', projectId: null}, TEAMS), null);
});

test('should refuse a drop when the caller only views the team', () => {
  assert.equal(dropAction([{teamId: 'v', projectId: null}], {kind: 'team', teamId: 'v', projectId: 'p1'}, TEAMS), null);
});

test('should refuse files of two places or a move between two teams', () => {
  assert.equal(dropAction([{teamId: 't'}, {teamId: null}], {kind: 'team', teamId: 't', projectId: 'p1'}, TEAMS), null);
  assert.equal(dropAction([{teamId: 't'}], {kind: 'team', teamId: 'e', projectId: null}, TEAMS), null);
});

test('should send files to their own trash and team files back to personal files when dropped there', () => {
  assert.deepEqual(dropAction([{teamId: null}], {kind: 'trash'}, TEAMS), {kind: 'trash'});
  assert.equal(dropAction([{teamId: 't'}], {kind: 'trash'}, TEAMS), null);
  assert.deepEqual(dropAction([{teamId: 't'}], {kind: 'team-trash', teamId: 't'}, TEAMS), {kind: 'trash'});
  assert.equal(dropAction([{teamId: 'e'}], {kind: 'team-trash', teamId: 'e'}, TEAMS), null);
  assert.equal(dropAction([{teamId: 't'}], {kind: 'recent'}, TEAMS)?.kind, 'move');
  assert.equal(dropAction([{teamId: null}], {kind: 'recent'}, TEAMS), null);
  assert.equal(dropAction([{teamId: null}], {kind: 'shared'}, TEAMS), null);
});
