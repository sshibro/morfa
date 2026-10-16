import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {DesignFileSummary} from '../shared/design/api';
import type {DesignTeamSummary} from '../shared/design/teams';
import {bulkMenuItems, filesCount, type BulkActions} from '../src/design/files/bulk';

const file = (id: string, teamId: string | null = null) => ({id, name: id, teamId, projectId: null} as unknown as DesignFileSummary);
const team = (id: string, role: DesignTeamSummary['role']) => ({id, name: 'Studio', role, projects: [{id: 'p1', name: 'Site'}]} as unknown as DesignTeamSummary);
const calls: string[] = [];
const actions: BulkActions = {
  duplicate: files => calls.push('duplicate:' + files.length),
  move: (files, target) => calls.push(`move:${files.length}:${target.teamId}:${target.projectId}`),
  trash: files => calls.push('trash:' + files.length),
  restore: files => calls.push('restore:' + files.length),
  erase: files => calls.push('erase:' + files.length),
  leave: files => calls.push('leave:' + files.length),
};
const ids = (items: ReturnType<typeof bulkMenuItems>) => items.map(item => ('id' in item ? item.id : item.type));

test('should count files in English when the menu names how many it acts on', () => {
  assert.deepEqual([1, 2, 5, 11, 21].map(filesCount), ['1 file', '2 files', '5 files', '11 files', '21 files']);
});

test('should offer duplicate, move into a team and trash when several personal files are selected', () => {
  const items = bulkMenuItems([file('a'), file('b')], {teams: [team('t', 'owner')], trash: false, shared: false, actions});
  assert.deepEqual(ids(items), ['label', 'duplicate', 'move', 'separator', 'trash']);
  assert.equal((items[2] as {label: string}).label, 'Move to team 2 files');
});

test('should move every file into the chosen project when the submenu row is picked', () => {
  calls.length = 0;
  const items = bulkMenuItems([file('a', 't'), file('b', 't')], {teams: [team('t', 'editor')], trash: false, shared: false, actions});
  const move = items.find(item => 'id' in item && item.id === 'move') as {items: Array<{id?: string; onSelect?: () => void}>};
  move.items.find(item => item.id === 'move-p1')!.onSelect!();
  assert.deepEqual(calls, ['move:2:t:p1']);
});

test('should leave out the move when the files come from different places', () => {
  const items = bulkMenuItems([file('a'), file('b', 't')], {teams: [team('t', 'owner')], trash: false, shared: false, actions});
  assert.deepEqual(ids(items), ['label', 'duplicate', 'separator', 'trash']);
});

test('should leave out the trash when a team file may not be trashed by the caller', () => {
  const items = bulkMenuItems([file('a', 't'), file('b', 't')], {teams: [team('t', 'editor')], trash: false, shared: false, actions});
  assert.ok(!ids(items).includes('trash'));
});

test('should offer restore and erase when several files are selected in the trash', () => {
  assert.deepEqual(ids(bulkMenuItems([file('a'), file('b')], {teams: [], trash: true, shared: false, actions})), ['label', 'restore', 'separator', 'erase']);
});

test('should offer only to leave them when the files were shared with the caller', () => {
  assert.deepEqual(ids(bulkMenuItems([file('a'), file('b')], {teams: [], trash: false, shared: true, actions})), ['label', 'leave']);
});
