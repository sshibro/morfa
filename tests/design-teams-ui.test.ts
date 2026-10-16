import test from 'node:test';
import assert from 'node:assert/strict';
import {inviteLine, inviteRoleOptions, linkSettingsLine, memberRoleOptions, quoted, takeDesignInvite} from '../src/design/teams/model';
import {isTrashView, teamOfView, teamSections, viewFromKey, viewKey, viewTitle} from '../src/design/files/sidebar';
import {createDesignStore, READ_ONLY_TOOLS} from '../src/design/engine/store';
import {createDocument, createNode} from '../shared/design/defaults';

// The teams UI's pure parts (docs/design-tool.md §Teams): the invite carried over the sign-in, the words of links, the role
// pickers, the sidebar's team sections and views, and the read-only store a developer or a viewer edits nothing with.

const TOKEN = 'Ab3_'.repeat(10) + 'xyz';
const TEAM = '11111111-2222-4333-8444-555555555555',
  PROJECT = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function memory(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {getItem: (key: string) => map.get(key) ?? null, removeItem: (key: string) => void map.delete(key), map};
}

test('should take the invite from the address once, drop it from the query, and fall back to the one kept over the sign-in', () => {
  const kept = memory({'morfa-design-invite': 'K'.repeat(43)});
  assert.deepEqual(takeDesignInvite(`?designInvite=${TOKEN}&tab=1`, kept), {token: TOKEN, search: '?tab=1'});
  assert.equal(kept.map.size, 0, 'the kept one is consumed too');
  assert.deepEqual(takeDesignInvite(`?designInvite=${TOKEN}`, null), {token: TOKEN, search: ''});
  assert.deepEqual(takeDesignInvite('?designInvite=<script>', null), {token: null, search: ''}, 'anything else is dropped');
  assert.deepEqual(takeDesignInvite('', memory({'morfa-design-invite': 'K'.repeat(43)})), {token: 'K'.repeat(43), search: null});
  assert.deepEqual(takeDesignInvite('', memory({'morfa-design-invite': 'bad'})), {token: null, search: null});
  const blocked = {getItem: () => { throw Error('blocked'); }, removeItem: () => undefined};
  assert.deepEqual(takeDesignInvite('?x=1', blocked), {token: null, search: null});
});

test('should say what a link can still do', () => {
  const now = Date.parse('2026-10-07T10:00:00Z');
  assert.equal(inviteLine({state: 'active', expiresAt: '2026-10-14T10:00:00Z', uses: 0, maxUses: 1}, now), 'Expires October 14 · 0 of 1');
  assert.equal(inviteLine({state: 'active', expiresAt: '2026-10-07T20:00:00Z', uses: 2, maxUses: 5}, now), 'Expires in under a day · 2 of 5');
  assert.equal(inviteLine({state: 'used', expiresAt: '2026-10-14T10:00:00Z', uses: 1, maxUses: 1}, now), 'Used');
  assert.equal(inviteLine({state: 'used', expiresAt: '2026-10-14T10:00:00Z', uses: 5, maxUses: 5}, now), 'Used 5 of 5');
  assert.equal(inviteLine({state: 'revoked', expiresAt: '', uses: 0, maxUses: 1}, now), 'Revoked');
  assert.equal(inviteLine({state: 'expired', expiresAt: '', uses: 0, maxUses: 1}, now), 'Expired');
});

test('should say what the next link will be', () => {
  assert.equal(linkSettingsLine('7', '1'), 'For 7 days, for one person');
  assert.equal(linkSettingsLine('30', '25'), 'For 30 days, for up to 25 people');
  assert.equal(linkSettingsLine('1', '100'), 'For 1 day, for up to 100 people');
});

test('should offer each manager the roles it may hand out, and the owner a handover', () => {
  assert.deepEqual(inviteRoleOptions('owner').map(option => option.value), ['admin', 'editor', 'developer', 'viewer']);
  assert.deepEqual(inviteRoleOptions('admin').map(option => option.value), ['editor', 'developer', 'viewer']);
  assert.match(inviteRoleOptions('admin')[0].description, /edits files/);
  assert.deepEqual(memberRoleOptions('owner', 'viewer').map(option => [option.value, option.label]), [
    ['owner', 'Transfer team'], ['admin', 'Admin'], ['editor', 'Editor'], ['developer', 'Developer'], ['viewer', 'Viewer'],
  ]);
  assert.deepEqual(memberRoleOptions('admin', 'viewer').map(option => option.value), ['editor', 'developer', 'viewer']);
});

test('should quote a team name with the inner double quotes turned into single ones', () => {
  assert.equal(quoted('Studio "North"'), '"Studio \'North\'"');
  assert.equal(quoted('North'), '"North"');
});

test('should give each team a sidebar section: all files, its projects, its trash; and come back to the last place', () => {
  const teams = [{id: TEAM, name: 'Studio', projects: [{id: PROJECT, name: 'Site', createdAt: ''}]}];
  const [section] = teamSections(teams);
  assert.equal(section.title, 'Studio');
  assert.equal(section.teamId, TEAM);
  assert.deepEqual(section.items.map(item => item.label), ['All files', 'Site', 'Trash']);
  const [all, project, trash] = section.items.map(item => item.view);
  assert.deepEqual([viewKey(all), viewKey(project), viewKey(trash)], [`team:${TEAM}:all`, `team:${TEAM}:${PROJECT}`, `team-trash:${TEAM}`]);
  assert.deepEqual([isTrashView(trash), isTrashView(all), teamOfView(project), teamOfView({kind: 'recent'})], [true, false, TEAM, null]);
  assert.deepEqual([viewTitle(all, teams), viewTitle(project, teams), viewTitle(trash, teams), viewTitle({kind: 'recent'}, teams)], ['All files', 'Site', 'Trash', 'Recent']);
  for (const view of [all, project, trash, {kind: 'recent'} as const, {kind: 'shared'} as const, {kind: 'trash'} as const]) assert.deepEqual(viewFromKey(viewKey(view), teams), view);
  assert.deepEqual(viewFromKey(`team:${TEAM}:${'0'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}`, teams), all, 'a project that went falls back to the team');
  assert.equal(viewFromKey(`team:${'9'.repeat(8)}-0000-4000-8000-${'0'.repeat(12)}:all`, teams), null, 'a team the caller left is gone');
  assert.equal(viewFromKey('nonsense', teams), null);
});

test('should refuse every edit, gesture, undo, editing mode and drawing tool of a read-only file, and say so', () => {
  const doc = createDocument('page-1');
  const rect = createNode('RECTANGLE', {id: 'r1', parentId: 'page-1', x: 0, y: 0, width: 10, height: 10});
  doc.nodes.r1 = rect;
  doc.nodes['page-1'] = {...doc.nodes['page-1'], children: ['r1']};
  const measurer = {measure: () => ({width: 0, ascent: 0, descent: 0})} as never;
  const store = createDesignStore({doc, measurer, readOnly: true, tool: 'rectangle'});
  const refused: string[] = [];
  store.onRefused(label => refused.push(label));
  const patches: unknown[] = [];
  store.onPatch(event => patches.push(event));
  assert.equal(store.readOnly, true);
  assert.equal(store.getState().tool, 'move', 'a drawing tool never starts');
  const before = store.getState().doc;
  const result = store.transact('Nudge', tx => tx.update('r1', {x: 50}));
  assert.equal(store.getState().doc, before, 'the document is the same object');
  assert.equal(store.getState().doc.nodes.r1.x, 0);
  assert.deepEqual(Object.keys(result.patch.nodes ?? {}), []);
  const drag = store.gesture('Move');
  drag.update(tx => tx.update('r1', {x: 99}));
  assert.equal(drag.commit(), null);
  assert.equal(store.getState().doc.nodes.r1.x, 0);
  assert.equal(store.undo(), false);
  store.setTool('rectangle');
  store.setTool('hand');
  assert.equal(store.getState().tool, 'hand', 'looking around stays');
  // Commenting is not an edit of the document (docs/design-tool.md §Teams "Comments"): viewers comment. Nor are votes and emotes
  // (docs/board-meeting.md): viewers vote and react.
  assert.deepEqual([...READ_ONLY_TOOLS].sort(), ['comment', 'hand', 'meeting-emote', 'meeting-vote', 'move']);
  store.setTool('comment');
  assert.equal(store.getState().tool, 'comment', 'commenting stays');
  store.setTool('meeting-vote');
  assert.equal(store.getState().tool, 'meeting-vote', 'voting stays');
  store.setTool('hand');
  store.setEditing({kind: 'text', id: 'r1'});
  assert.equal(store.getState().editing, null);
  store.setSelection(['r1']);
  assert.deepEqual(store.getState().selection, ['r1'], 'selection is not an edit');
  assert.deepEqual(refused, ['Nudge', 'Move', 'Tool', 'Editing']);
  // The engine's own corrections (fonts measured) still apply locally; nothing reaches autosave for an edit.
  store.transact('Font loaded', tx => tx.update('r1', {name: 'Measured'}), {history: false});
  assert.equal(store.getState().doc.nodes.r1.name, 'Measured');
  assert.equal(patches.length, 1, 'only the correction');
  const editable = createDesignStore({doc, measurer});
  assert.equal(editable.readOnly, false);
  editable.transact('Nudge', tx => tx.update('r1', {x: 50}));
  assert.equal(editable.getState().doc.nodes.r1.x, 50);
});
