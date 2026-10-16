import test from 'node:test';
import assert from 'node:assert/strict';
import {collabApp, smallDocument, type Account} from './helpers/collab-app';
import {createBoardDocument} from '../shared/design/board/document';
import {createConnector, createSticky} from '../shared/design/board/create';
import type {DesignDocument, SceneNode} from '../shared/design/types';

// Custom team templates (the board's "+" sheet): a team's board published as a template, listed for its team and,
// with scope 'organization', the other teams of its owner; renamed; published again as a new version; inserted as copies with fresh ids
// and pictures made the target board's place's. Who may do what, the team's limit (five), and
// what a version holds.

/** A board: two stickies and a connector between them on its first page (the board's own factories), a picture on the first sticky. */
function boardDocument(picture?: string): DesignDocument {
  let n = 0;
  const newId = () => `n${++n}`;
  const doc = createBoardDocument('page');
  const builds = [createSticky(newId, {x: 10, y: 20, text: 'First'}), createSticky(newId, {x: 300, y: 20, text: 'Second'})];
  builds.push(createConnector(newId, {start: {node: builds[0]!.id, magnet: 'right'}, end: {node: builds[1]!.id, magnet: 'left'}}));
  for (const build of builds)
    for (const {node, parent} of build.pieces) {
      const parentId = parent || 'page';
      doc.nodes[node.id] = {...node, parentId};
      doc.nodes[parentId]!.children = [...(doc.nodes[parentId]!.children ?? []), node.id];
    }
  if (picture) {
    const first = doc.nodes[builds[0]!.id]!;
    doc.nodes[first.id] = {...first, fills: [{type: 'IMAGE', imageRef: 'pic', scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]} as SceneNode;
    doc.images = {pic: {url: picture, width: 4, height: 4}};
  }
  return doc;
}

test('custom team templates: publish, the team\'s limit, who may, the list, versions and content', {timeout: 240_000}, async t => {
  const c = await collabApp(t);
  const {db, files, teams, ok, fetchAs} = c;
  const templates = (who: Account, suffix: string) => fetchAs(who, '/api/design-templates' + suffix);
  const owner = await c.account('owner', 'Anna');
  const editor = await c.account('editor', 'Boris');
  const viewer = await c.account('viewer', 'Vera');
  const guest = await c.account('guest', 'George');
  const stranger = await c.account('stranger', 'Dina');
  const join = async (teamId: string, who: Account, role: string) => {
    const invite = ok(await teams(owner, `/${teamId}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1}}), 201);
    ok(await teams(who, `/invites/${invite.token}/accept`, {method: 'POST'}));
  };
  const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
  await join(teamId, editor, 'editor');
  await join(teamId, viewer, 'viewer');
  // Another team of the same owner (the "organization"), and a team of someone else.
  const sister = ok(await teams(owner, '', {method: 'POST', json: {name: 'Sister team'}}), 201).team.id as string;
  await join(sister, viewer, 'viewer');
  const strangers = ok(await teams(stranger, '', {method: 'POST', json: {name: 'Foreign'}}), 201).team.id as string;
  const sharp = (await import('sharp')).default;
  const png = await sharp({create: {width: 4, height: 4, channels: 3, background: '#0a0'}}).png().toBuffer();
  const board = async (who: Account, team: string, name: string) => ok(await files(who, '', {method: 'POST', json: {name, kind: 'board', teamId: team, document: boardDocument()}}), 201).file as {id: string; version: number};
  const upload = async (who: Account, fileId: string) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(png)], {type: 'image/png'}), 'Photo.png');
    return ok(await fetchAs(who, `/api/design-files/${fileId}/images`, {method: 'POST', body: form})).asset as {url: string};
  };
  const publish = (who: Account, fileId: string, body: Record<string, unknown>) => files(who, `/${fileId}/template`, {method: 'POST', json: body});
  const versionOf = async (fileId: string) => Number((await db.one<{version: number}>('SELECT version FROM design_files WHERE id=$1', [fileId]))!.version);

  const source = await board(owner, teamId, 'Retro');
  const picture = await upload(owner, source.id);
  ok(await files(owner, `/${source.id}/document`, {method: 'PUT', json: {baseVersion: source.version, document: boardDocument(picture.url)}}));

  let templateId = '';

  await t.test('an editor publishes at the board\'s version; who may not', async () => {
    const version = await versionOf(source.id);
    assert.equal((await publish(editor, source.id, {baseVersion: version - 1, name: 'Retro', scope: 'team'})).status, 409, 'an older version: save first');
    assert.equal((await publish(viewer, source.id, {baseVersion: version, name: 'Retro', scope: 'team'})).status, 403, 'a viewer');
    await db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'editor')", [source.id, guest.id]);
    assert.equal((await publish(guest, source.id, {baseVersion: version, name: 'Retro', scope: 'team'})).status, 403, 'a guest of the file');
    assert.equal((await publish(stranger, source.id, {baseVersion: version, name: 'Retro', scope: 'team'})).status, 404, 'a stranger');
    assert.equal((await publish(editor, source.id, {baseVersion: version, name: '   ', scope: 'team'})).status, 400, 'no name');
    const answer = ok(await publish(editor, source.id, {baseVersion: version, name: '  Team  retro ', description: 'What went\nwell', scope: 'team'}), 201);
    const template = answer.template;
    templateId = template.id;
    assert.deepEqual(
      [template.fileId, template.name, template.description, template.version, template.teamId, template.scope, template.publishedBy],
      [source.id, 'Team  retro', 'What went well', 1, teamId, 'team', {name: 'Boris'}],
    );
    assert.equal(typeof template.publishedAt, 'string');
    // A design file, or a board of no team, is not a template's.
    const design = ok(await files(owner, '', {method: 'POST', json: {name: 'Mockup', teamId, document: smallDocument()}}), 201).file;
    assert.equal((await publish(owner, design.id, {baseVersion: design.version, name: 'Mockup', scope: 'team'})).status, 400);
    const personal = ok(await files(owner, '', {method: 'POST', json: {name: 'Own', kind: 'board', document: boardDocument()}}), 201).file;
    assert.equal((await publish(owner, personal.id, {baseVersion: personal.version, name: 'Own', scope: 'team'})).status, 400);
  });

  await t.test('the list: the team\'s members, viewers too; organization templates in the owner\'s other teams only', async () => {
    const mine = ok(await templates(viewer, `?teamId=${teamId}`)).templates;
    assert.deepEqual(mine.map((item: {id: string}) => item.id), [templateId]);
    assert.equal((await templates(stranger, `?teamId=${teamId}`)).status, 404, 'not a member');
    assert.deepEqual(ok(await templates(viewer, `?teamId=${sister}`)).templates, [], 'a team template stays in its team');
    ok(await files(owner, `/${source.id}/template`, {method: 'PATCH', json: {name: 'Retro for everyone'}}));
    const version = await versionOf(source.id);
    // Publishing again: the next version, its scope widened to the organization (it never counts against the limit again).
    const again = ok(await publish(owner, source.id, {baseVersion: version, name: 'Retro for everyone', scope: 'organization'}), 201).template;
    assert.deepEqual([again.id, again.version, again.scope, again.publishedBy.name], [templateId, 2, 'organization', 'Anna']);
    assert.deepEqual(ok(await templates(viewer, `?teamId=${sister}`)).templates.map((item: {id: string}) => item.id), [templateId], 'the owner\'s other team');
    assert.deepEqual(ok(await templates(stranger, `?teamId=${strangers}`)).templates, [], 'another owner\'s team');
  });

  await t.test('PATCH renames and redescribes; no template, or not the caller\'s, is refused', async () => {
    const renamed = ok(await files(editor, `/${source.id}/template`, {method: 'PATCH', json: {description: 'New description'}})).template;
    assert.deepEqual([renamed.name, renamed.description, renamed.version], ['Retro for everyone', 'New description', 2]);
    assert.equal((await files(viewer, `/${source.id}/template`, {method: 'PATCH', json: {name: 'x'}})).status, 403);
    const other = await board(owner, teamId, 'No template');
    assert.equal((await files(owner, `/${other.id}/template`, {method: 'PATCH', json: {name: 'x'}})).status, 404);
  });

  await t.test('content: fresh ids, the connector following the copies, the bounds, pictures made the target\'s place\'s', async () => {
    // Into a board of the same team: its pictures are already the team's.
    const target = await board(editor, teamId, 'Target');
    const content = ok(await templates(editor, `/${templateId}/content?fileId=${target.id}`));
    const roots = content.roots as string[];
    assert.equal(roots.length, 3);
    const ids = content.pieces.map((piece: SceneNode) => piece.id);
    assert.ok(!ids.some((id: string) => /^n\d+$/.test(id)), 'fresh ids');
    const byId = new Map(content.pieces.map((piece: SceneNode) => [piece.id, piece]));
    assert.ok(roots.every(id => (byId.get(id) as SceneNode).parentId === null), 'the roots carry no parent');
    assert.ok(content.pieces.every((piece: SceneNode) => piece.parentId === null || byId.has(piece.parentId)), 'parents among the pieces');
    const order = new Map(content.pieces.map((piece: SceneNode, index: number) => [piece.id, index]));
    assert.ok(content.pieces.every((piece: SceneNode) => piece.parentId === null || order.get(piece.parentId)! < order.get(piece.id)!), 'parents before children');
    const [a, b, line] = roots.map(id => byId.get(id) as SceneNode);
    assert.deepEqual([line.board!.kind, (line.board as {start: {node: string}}).start.node, (line.board as {end: {node: string}}).end.node], ['connector', a.id, b.id], 'the connector follows the copies');
    assert.deepEqual(content.bounds, {x: 10, y: 20, width: 530, height: 240}, 'the stickies\' box, without the connector');
    assert.deepEqual(content.images, {pic: {url: picture.url, width: 4, height: 4}});
    assert.equal((a.fills[0] as {imageRef: string}).imageRef, 'pic');
    // Into a board of the owner's other team: the picture is copied there once.
    const elsewhere = ok(await files(owner, '', {method: 'POST', json: {name: 'Sister', kind: 'board', teamId: sister, document: boardDocument()}}), 201).file;
    const copied = ok(await templates(owner, `/${templateId}/content?fileId=${elsewhere.id}`));
    const url = copied.images.pic.url as string;
    assert.notEqual(url, picture.url, 'a copy');
    assert.deepEqual(await db.one('SELECT user_id,team_id,file_id FROM design_images WHERE filename=$1', [url.slice('/uploads/'.length)]), {user_id: owner.id, team_id: sister, file_id: elsewhere.id});
    assert.equal(ok(await templates(owner, `/${templateId}/content?fileId=${elsewhere.id}`)).images.pic.url, url, 'the same copy again');
    // The board edited since: version 1 still holds what was published then; a version not kept is 404.
    assert.equal(ok(await templates(editor, `/${templateId}/content?fileId=${target.id}&version=1`)).roots.length, 3);
    assert.equal((await templates(editor, `/${templateId}/content?fileId=${target.id}&version=9`)).status, 404);
    // A viewer may not insert (edit access to the target), nor anyone into a board of a team the template is not offered to.
    assert.equal((await templates(viewer, `/${templateId}/content?fileId=${target.id}`)).status, 403);
    const foreign = ok(await files(stranger, '', {method: 'POST', json: {name: 'Foreign board', kind: 'board', teamId: strangers, document: boardDocument()}}), 201).file;
    assert.equal((await templates(stranger, `/${templateId}/content?fileId=${foreign.id}`)).status, 404);
    // A guest who may edit one of the team's boards is not offered the team's templates.
    await db.execute("INSERT INTO design_file_members(file_id,user_id,role) VALUES($1,$2,'editor')", [target.id, guest.id]);
    assert.equal((await templates(guest, `/${templateId}/content?fileId=${target.id}`)).status, 404);
  });

  await t.test('five per team; a board in the trash leaves the list', async () => {
    for (let k = 2; k <= 5; k++) {
      const next = await board(owner, teamId, `Template ${k}`);
      ok(await publish(owner, next.id, {baseVersion: next.version, name: `Template ${k}`, scope: 'team'}), 201);
    }
    const sixth = await board(owner, teamId, 'Sixth');
    const refused = await publish(owner, sixth.id, {baseVersion: sixth.version, name: 'Sixth', scope: 'team'});
    assert.equal(refused.status, 409);
    assert.deepEqual([refused.data.code, refused.data.limit], ['design_template_limit', 5]);
    // Publishing an existing template again is never refused by the limit.
    ok(await publish(owner, source.id, {baseVersion: await versionOf(source.id), name: 'Retro for everyone', scope: 'organization'}), 201);
    assert.equal(ok(await templates(owner, `?teamId=${teamId}`)).templates.length, 5);
    ok(await files(owner, `/${source.id}`, {method: 'DELETE'}));
    const listed = ok(await templates(owner, `?teamId=${teamId}`)).templates.map((item: {id: string}) => item.id);
    assert.ok(!listed.includes(templateId), 'its board is in the trash');
    // A template whose board is in the trash does not count: there is no unpublish, and the team may publish another.
    ok(await publish(owner, sixth.id, {baseVersion: sixth.version, name: 'Sixth', scope: 'team'}), 201);
  });

  await t.test('an erased account is no longer named as the one who published', async () => {
    const lifecycle = await import('../server/design/lifecycle');
    // The board back from the trash, published again by the editor (a template's next version never counts against the limit).
    ok(await files(owner, `/${source.id}/restore`, {method: 'POST'}));
    const published = ok(await publish(editor, source.id, {baseVersion: await versionOf(source.id), name: 'Retro for everyone', scope: 'organization'}), 201).template;
    assert.deepEqual([published.id, published.publishedBy.name], [templateId, 'Boris']);
    await db.transaction(tx => lifecycle.eraseDesignAccount(tx, editor.id));
    const after = ok(await templates(owner, `?teamId=${teamId}`)).templates.find((item: {id: string}) => item.id === templateId);
    assert.deepEqual(after.publishedBy, {name: 'Member'});
    assert.equal((await db.one<{n: number}>('SELECT count(*)::int AS n FROM design_template_versions WHERE published_by=$1', [editor.id]))!.n, 0, 'nor as a version\'s');
  });
});
