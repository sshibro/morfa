import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument} from './helpers/collab-app';
import type {SceneNode} from '../shared/design/types';

// "Duplicate to drafts" (POST /api/design-files/:id/duplicate-to-drafts): a copy of a file, also one in the trash, as a new file of
// the caller's drafts. The owner or an editor of the file's team may make it, never a guest or a viewer; the file is untouched; a team
// file's pictures come along as copies the caller holds.

test('duplicate to drafts: from the trash, a personal and a team file, who may and who may not', {timeout: 180_000}, async t => {
  const c = await collabApp(t);
  const {db, files, teams, ok} = c;
  const owner = await c.account('owner', 'Anna');
  const editor = await c.account('editor', 'Boris');
  const viewer = await c.account('viewer', 'Vera');
  const guest = await c.account('guest', 'George');
  const stranger = await c.account('stranger');
  const sharp = (await import('sharp')).default;
  const png = await sharp({create: {width: 4, height: 4, channels: 3, background: '#00f'}}).png().toBuffer();
  const upload = async (fileId: string, who = owner) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], {type: 'image/png'}), 'Photo.png');
    return ok(await c.fetchAs(who, `/api/design-files/${fileId}/images`, {method: 'POST', body: form})).asset as {url: string};
  };
  const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
  for (const [who, role] of [[editor, 'editor'], [viewer, 'viewer']] as const) {
    const invite = ok(await teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1}}), 201);
    ok(await teams(who, `/invites/${invite.token}/accept`, {method: 'POST'}));
  }
  const doc = smallDocument();
  const node = (key: string) => doc.nodes[key] as SceneNode;
  const withPicture = (url: string) => ({
    ...doc,
    nodes: {...doc.nodes, a: {...node('a'), fills: [{type: 'IMAGE', imageRef: 'pic', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]}},
    images: {pic: {url, width: 4, height: 4}},
  });
  const raw = async (id: string) =>
    (await db.one<{user_id: string; team_id: string | null; project_id: string | null; trashed_at: string | null; version: number; image_files: string[]; document: string; name: string}>(
      'SELECT user_id,team_id,project_id,trashed_at,version,image_files,document,name FROM design_files WHERE id=$1',
      [id],
    ))!;
  const picture = async (filename: string) =>
    db.one<{user_id: string; team_id: string | null; file_id: string | null}>("SELECT user_id,team_id,file_id FROM design_images WHERE filename=$1 AND kind='image'", [filename]);

  await t.test('the owner’s own file from the trash: a new draft, the file still in the trash, the picture shared', async () => {
    const id = ok(await files(owner, '', {method: 'POST', json: {name: 'My mockup', document: doc}}), 201).file.id as string;
    const asset = await upload(id);
    ok(await files(owner, `/${id}/document`, {method: 'PUT', json: {baseVersion: 1, document: withPicture(asset.url)}}));
    ok(await files(owner, `/${id}`, {method: 'DELETE'}));
    const before = await raw(id);
    assert.ok(before.trashed_at);
    // A version head beside the file (SQL016): the copy still starts at version 1.
    await db.execute('INSERT INTO design_file_heads(file_id,version) VALUES($1,$2)', [id, Number(before.version) + 5]);
    const copy = ok(await files(owner, `/${id}/duplicate-to-drafts`, {method: 'POST'}), 201).file;
    assert.notEqual(copy.id, id);
    assert.equal(copy.name, 'My mockup (copy)');
    assert.equal(copy.version, 1);
    assert.equal(copy.trashedAt, null);
    assert.equal(copy.teamId, null);
    const stored = await raw(copy.id);
    assert.deepEqual([stored.user_id, stored.team_id, stored.project_id], [owner.id, null, null]);
    assert.deepStrictEqual(JSON.parse(stored.document), JSON.parse(before.document), 'the same document');
    assert.deepEqual(stored.image_files, before.image_files, 'the picture is shared within the owner’s files');
    const after = await raw(id);
    assert.deepEqual({...after}, {...before}, 'the trashed file is untouched');
    assert.ok(ok(await files(owner, '')).files.some((file: {id: string}) => file.id === copy.id), 'listed in the drafts');
  });

  await t.test('a team file from the trash, by an editor: a draft of the editor’s with copies of its pictures', async () => {
    const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Team file', document: doc, teamId}}), 201).file.id as string;
    const asset = await upload(id);
    ok(await files(owner, `/${id}/document`, {method: 'PUT', json: {baseVersion: 1, document: withPicture(asset.url)}}));
    ok(await files(owner, `/${id}`, {method: 'DELETE'}));
    const before = await raw(id);
    const original = asset.url.slice('/uploads/'.length);
    const copy = ok(await files(editor, `/${id}/duplicate-to-drafts`, {method: 'POST'}), 201).file;
    const stored = await raw(copy.id);
    assert.deepEqual([stored.user_id, stored.team_id, stored.project_id, Number(stored.version)], [editor.id, null, null, 1]);
    assert.equal(stored.image_files.length, 1);
    const copied = stored.image_files[0]!;
    assert.notEqual(copied, original, 'the picture is a copy');
    assert.deepEqual(await picture(copied), {user_id: editor.id, team_id: null, file_id: copy.id}, 'the editor holds the copy');
    assert.equal(JSON.parse(stored.document).images.pic.url, `/uploads/${copied}`, 'the document points at the copy');
    assert.deepEqual(await picture(original), {user_id: owner.id, team_id: teamId, file_id: id}, 'the team keeps its picture');
    assert.deepEqual({...(await raw(id))}, {...before}, 'the trashed file is untouched');
    // The copy opens for the editor, with the copied picture.
    const opened = ok(await files(editor, `/${copy.id}`));
    assert.equal(opened.document.images.pic.url, `/uploads/${copied}`);
  });

  await t.test('a viewer of the team, a guest and a stranger may not; a file outside the trash may be copied too', async () => {
    const id = ok(await files(owner, '', {method: 'POST', json: {name: 'Closed', document: doc, teamId}}), 201).file.id as string;
    await db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'editor')", [id, guest.id]);
    assert.equal((await files(viewer, `/${id}/duplicate-to-drafts`, {method: 'POST'})).status, 403);
    assert.equal((await files(guest, `/${id}/duplicate-to-drafts`, {method: 'POST'})).status, 403);
    assert.equal((await files(stranger, `/${id}/duplicate-to-drafts`, {method: 'POST'})).status, 404);
    const copy = ok(await files(owner, `/${id}/duplicate-to-drafts`, {method: 'POST'}), 201).file;
    assert.equal((await raw(copy.id)).team_id, null);
    ok(await files(owner, `/${id}`, {method: 'DELETE'}));
    assert.equal((await files(viewer, `/${id}/duplicate-to-drafts`, {method: 'POST'})).status, 403, 'nor from the trash');
  });
});
