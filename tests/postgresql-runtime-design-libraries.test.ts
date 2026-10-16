import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import path from 'node:path';
import type {Server} from 'node:http';
import sharp from 'sharp';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import {LIBRARY_PAGE_ID} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {beginTransaction} from '../shared/design/transaction';
import {diffDocuments} from '../shared/design/patch';
import {createInstance, withOverrideTracking} from '../shared/design/components';
import {applyLibraryImport, libraryUpdates, remoteId, validateLibraryImport, validateLibrarySnapshot, type LibraryImport} from '../shared/design/libraries';

// "Morfa Design" shared libraries (docs/design-tool.md §Teams) against the real PostgreSQL schema, through the whole app: publishing,
// enabling and using a team library in another team file, updates that keep instance overrides, isolation between teams and
// accounts, pictures copied into a file's place, unpublishing, the room for documents, erasure and the export.

type Account = {id: string; token: string};
type Answer = {status: number; data: any; type: string | null};
type Init = RequestInit & {json?: unknown};

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};
const png = (width: number, height: number, r = 200) =>
  sharp({create: {width, height, channels: 4, background: {r, g: 40, b: 90, alpha: 1}}}).png().toBuffer();
const BLUE = {r: 0, g: 0, b: 1}, GREEN = {r: 0, g: 1, b: 0};

test('"Morfa Design" shared libraries: publish, enable, use, update, isolation, pictures, unpublish, room and erasure', {timeout: 900000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const values: NodeJS.ProcessEnv = {
    ENABLE_DESIGN_TOOL: '1',
    ERASURE_LEDGER_PATH: path.join(f.dataDir, 'ledger', 'erasure.jsonl'),
    BACKUP_ENCRYPTION_KEY: 'ab'.repeat(32),
  };
  const saved = Object.fromEntries(['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN', 'DESIGN_ACCOUNT_DOCUMENT_BYTES', ...Object.keys(values)].map(key => [key, process.env[key]]));
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const lifecycle = await import('../server/launch/lifecycle');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
  });

  async function account(label: string): Promise<Account> {
    const id = `design:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute('INSERT INTO users(id,email,name,password) VALUES($1,$2,$3,$4)', [id, `${label}-${randomUUID()}@example.invalid`, 'Designer ' + label, '']);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token};
  }
  async function fetchAs(who: Account | null, url: string, init: Init = {}): Promise<Answer> {
    const {json, ...rest} = init;
    const headers: Record<string, string> = {
      ...(who ? {cookie: auth.authCookieName('session') + '=' + who.token} : {}),
      ...(json !== undefined ? {'content-type': 'application/json'} : {}),
      ...(rest.headers as Record<string, string>),
    };
    const response = await fetch(base + url, {...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const type = response.headers.get('content-type');
    const raw = Buffer.from(await response.arrayBuffer());
    return {status: response.status, data: type?.includes('json') ? JSON.parse(raw.toString('utf8')) : raw, type};
  }
  const files = (who: Account | null, suffix: string, init: Init = {}) => fetchAs(who, '/api/design-files' + suffix, init);
  const teams = (who: Account | null, suffix: string, init: Init = {}) => fetchAs(who, '/api/design-teams' + suffix, init);
  const ok = (answer: Answer, status = 200) => {
    assert.equal(answer.status, status, JSON.stringify(answer.data));
    return answer.data;
  };
  const upload = async (who: Account, id: string, data: Buffer) => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], {type: 'image/png'}), 'Photo.png');
    return ok(await files(who, `/${id}/images`, {method: 'POST', body: form})) as {ref: string; asset: {url: string; width: number; height: number}};
  };
  const open = async (who: Account, id: string) => ok(await files(who, '/' + id)) as {file: {version: number; teamId: string | null}; document: DesignDocument};
  /** Saves `next` over the stored document as autosave does: a patch from the stored version. */
  const save = async (who: Account, id: string, next: DesignDocument) => {
    const current = await open(who, id);
    return files(who, `/${id}/document`, {method: 'PATCH', json: {baseVersion: current.file.version, patch: diffDocuments(current.document, next)}});
  };
  const newFile = async (who: Account, teamId?: string, name = 'Mockup') => ok(await files(who, '', {method: 'POST', json: {name, ...(teamId ? {teamId} : {})}}), 201).file as {id: string};
  const invite = async (who: Account, teamId: string, role: string) =>
    ok(await teams(who, `/${teamId}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1}}), 201) as {token: string};
  const join = async (who: Account, teamId: string, inviter: Account, role: string) => ok(await teams(who, `/invites/${(await invite(inviter, teamId, role)).token}/accept`, {method: 'POST'}));

  /** A library file's document: the component "Button" (a styled background, a label, a picture). */
  const buttonDoc = (doc: DesignDocument, color: typeof BLUE, label: string, picture?: {ref: string; asset: {url: string; width: number; height: number}}): DesignDocument => {
    const pageId = doc.pages[0];
    const nodes: Record<string, SceneNode> = {...doc.nodes};
    const add = (node: SceneNode) => {
      nodes[node.id] = node;
      const parent = nodes[node.parentId!];
      nodes[parent.id] = {...parent, children: [...(parent.children ?? []).filter(id => id !== node.id), node.id]};
    };
    for (const id of ['btn', 'bg', 'label', 'pic']) delete nodes[id];
    nodes[pageId] = {...nodes[pageId], children: (nodes[pageId].children ?? []).filter(id => id !== 'btn')};
    add(createNode('COMPONENT', {id: 'btn', parentId: pageId, name: 'Button', width: 120, height: 40, description: 'Primary'}));
    add(createNode('RECTANGLE', {id: 'bg', parentId: 'btn', name: 'Background', width: 120, height: 40, fills: [solid(color)], fillStyleId: 'brand', constraints: {horizontal: 'STRETCH', vertical: 'STRETCH'}}));
    add(createNode('TEXT', {id: 'label', parentId: 'btn', name: 'Label', x: 10, y: 10, width: 60, height: 20, text: defaultTextProps(label)}));
    const images = {...doc.images};
    if (picture) {
      add(createNode('RECTANGLE', {id: 'pic', parentId: 'btn', name: 'Picture', width: 8, height: 8, fills: [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}]}));
      images[picture.ref] = picture.asset;
    }
    return {...doc, nodes, images, styles: {...doc.styles, brand: {id: 'brand', type: 'FILL', name: 'Brand', description: '', paints: [solid(color)]}}};
  };
  const publish = (who: Account, id: string, baseVersion: number, extra: Record<string, unknown> = {}) =>
    files(who, `/${id}/library`, {method: 'POST', json: {baseVersion, components: ['btn'], styles: ['brand'], variableCollections: [], ...extra}});
  const libraries = async (who: Account, id: string) => ok(await files(who, `/${id}/libraries`)).libraries as any[];
  const importFrom = async (who: Account, fileId: string, libraryId: string, version: number, components = ['btn']) => {
    const answer = ok(await files(who, `/${fileId}/libraries/${libraryId}/import`, {method: 'POST', json: {version, components}}));
    const checked = validateLibraryImport(answer.import);
    assert.ok(checked.ok, checked.ok ? '' : checked.error);
    return checked.value as LibraryImport;
  };
  const applied = (doc: DesignDocument, payload: LibraryImport) => {
    const tx = beginTransaction(doc);
    applyLibraryImport(tx, payload);
    return tx.commit({measurer}).doc;
  };

  // ── The cast ─────────────────────────────────────────────────────────────────────────────────
  const owner = await account('owner'),
    editor = await account('editor'),
    viewer = await account('viewer'),
    stranger = await account('stranger'),
    solo = await account('solo');
  const teamId = ok(await teams(owner, '', {method: 'POST', json: {name: 'Studio'}}), 201).team.id as string;
  await join(editor, teamId, owner, 'editor');
  await join(viewer, teamId, owner, 'viewer');
  const otherTeam = ok(await teams(stranger, '', {method: 'POST', json: {name: 'Foreign'}}), 201).team.id as string;

  const libraryFile = await newFile(owner, teamId, 'UI kit');
  const useFile = await newFile(editor, teamId, 'Landing page');
  const strangerFile = await newFile(stranger, otherTeam, 'Foreign');
  const soloFile = await newFile(solo);
  const picture = await upload(owner, libraryFile.id, await png(12, 12));
  let libraryDoc = buttonDoc((await open(owner, libraryFile.id)).document, BLUE, 'Button', picture);
  ok(await save(owner, libraryFile.id, libraryDoc));
  let libraryId = '';

  await t.test('publishing: an editor of the library file publishes from the stored document; others cannot', async () => {
    const version = (await open(owner, libraryFile.id)).file.version;
    assert.equal((await publish(viewer, libraryFile.id, version)).status, 403, 'a viewer');
    assert.equal((await publish(stranger, libraryFile.id, version)).status, 404, 'a stranger');
    assert.equal((await publish(owner, libraryFile.id, version - 1)).data.code, 'version_conflict', 'a stale copy');
    assert.equal((await publish(owner, libraryFile.id, version, {components: [], styles: []})).status, 400, 'nothing to publish');
    assert.equal((await publish(owner, libraryFile.id, version, {extra: 1})).status, 400);
    const published = ok(await publish(owner, libraryFile.id, version, {description: '  First  version '}), 201).library;
    libraryId = published.id;
    assert.equal(published.version, 1);
    assert.equal(published.description, 'First version');
    assert.deepEqual(published.manifest.components.map((entry: {key: string; name: string; changedIn: number}) => [entry.key, entry.name, entry.changedIn]), [['btn', 'Button', 1]]);
    assert.deepEqual(published.manifest.styles.map((entry: {key: string}) => entry.key), ['brand']);
    const own = ok(await files(viewer, `/${libraryFile.id}/library`));
    assert.deepEqual(own.library.versions.map((entry: {version: number}) => entry.version), [1]);
    assert.equal(ok(await files(viewer, `/${useFile.id}/library`)).library, null);
    const stored = await db.one<{bytes: number; image_files: string[]; user_id: string}>('SELECT bytes,image_files,user_id FROM design_library_versions WHERE library_id=$1', [libraryId]);
    assert.deepEqual(stored!.image_files, [picture.asset.url.slice('/uploads/'.length)]);
    assert.equal(stored!.user_id, owner.id, 'held by the team owner');
  });

  await t.test('isolation: a team file lists the team\'s libraries; another team, another account and personal files see nothing', async () => {
    const listed = await libraries(editor, useFile.id);
    assert.deepEqual(listed.map(entry => [entry.id, entry.name, entry.enabled, entry.available]), [[libraryId, 'UI kit', false, true]]);
    assert.deepEqual(await libraries(owner, libraryFile.id), [], 'a file never lists its own library');
    assert.deepEqual(await libraries(stranger, strangerFile.id), []);
    assert.deepEqual(await libraries(solo, soloFile.id), []);
    const ownerPersonal = await newFile(owner);
    assert.deepEqual(await libraries(owner, ownerPersonal.id), [], 'the owner\'s personal files are another place');
    assert.equal((await files(stranger, `/${useFile.id}/libraries`)).status, 404);
    for (const [who, fileId] of [[stranger, strangerFile.id], [solo, soloFile.id], [owner, ownerPersonal.id]] as const) {
      assert.equal((await files(who, `/${fileId}/libraries/${libraryId}`, {method: 'PUT'})).status, 404);
      assert.equal((await files(who, `/${fileId}/libraries/${libraryId}/versions/1`)).status, 404);
      assert.equal((await files(who, `/${fileId}/libraries/${libraryId}/import`, {method: 'POST', json: {version: 1, components: ['btn']}})).status, 404);
    }
    assert.equal((await files(editor, `/${useFile.id}/libraries/not-a-library`, {method: 'PUT'})).status, 404);
  });

  let useDoc: DesignDocument;
  await t.test('using: an editor enables the library, imports the button and places an instance with an override', async () => {
    assert.equal((await files(viewer, `/${useFile.id}/libraries/${libraryId}`, {method: 'PUT'})).status, 403, 'a viewer cannot enable');
    assert.equal((await files(editor, `/${useFile.id}/libraries/${libraryId}/import`, {method: 'POST', json: {version: 1, components: ['btn']}})).data.code, 'design_library_unavailable', 'enable first');
    const enabled = ok(await files(editor, `/${useFile.id}/libraries/${libraryId}`, {method: 'PUT'})).library;
    assert.deepEqual([enabled.enabled, enabled.seenVersion], [true, 1]);
    const snapshot = ok(await files(viewer, `/${useFile.id}/libraries/${libraryId}/versions/1`)).snapshot;
    assert.ok(validateLibrarySnapshot(snapshot).ok, 'a member reads the version (thumbnails)');
    assert.equal((await files(viewer, `/${useFile.id}/libraries/${libraryId}/import`, {method: 'POST', json: {version: 1, components: ['btn']}})).status, 403, 'a viewer cannot import');
    assert.equal((await files(editor, `/${useFile.id}/libraries/${libraryId}/import`, {method: 'POST', json: {version: 1, components: ['ghost']}})).status, 400);
    assert.equal((await files(editor, `/${useFile.id}/libraries/${libraryId}/import`, {method: 'POST', json: {version: 9, components: ['btn']}})).status, 404);
    const payload = await importFrom(editor, useFile.id, libraryId, 1);
    assert.equal(payload.document.images[picture.ref].url, picture.asset.url, 'a picture of the same place stays as it is');
    useDoc = applied((await open(editor, useFile.id)).document, payload);
    const btn = remoteId(libraryId, 'btn');
    useDoc = createInstance(useDoc, btn, {parentId: useDoc.pages[0], x: 40, y: 40, newId: 'cta'}).doc;
    const label = `cta;${remoteId(libraryId, 'label')}`;
    const tx = beginTransaction(useDoc);
    tx.update(label, withOverrideTracking(useDoc, label, {text: defaultTextProps('Buy')}));
    useDoc = tx.commit({measurer}).doc;
    ok(await save(editor, useFile.id, useDoc));
    const stored = (await open(viewer, useFile.id)).document;
    assert.equal(stored.nodes[btn].parentId, LIBRARY_PAGE_ID);
    assert.equal(stored.nodes[label].text?.characters, 'Buy');
    assert.ok(!stored.pages.includes(LIBRARY_PAGE_ID));
  });

  await t.test('updates: a new version is offered, taken with the overrides kept, and marked as seen', async () => {
    libraryDoc = buttonDoc((await open(owner, libraryFile.id)).document, GREEN, 'Button 2', picture);
    ok(await save(owner, libraryFile.id, libraryDoc));
    const version = (await open(owner, libraryFile.id)).file.version;
    const second = ok(await publish(editor, libraryFile.id, version, {description: 'Green'}), 201).library;
    assert.equal(second.version, 2);
    assert.equal(second.manifest.components[0].changedIn, 2);
    const listed = (await libraries(editor, useFile.id))[0];
    assert.deepEqual([listed.version, listed.seenVersion, listed.description], [2, 1, 'Green']);
    const offered = libraryUpdates(useDoc, [{id: libraryId, version: listed.version, manifest: listed.manifest}]);
    assert.deepEqual(offered.map(update => [update.kind, update.key, update.from, update.to]), [['component', 'btn', 1, 2], ['style', 'brand', 1, 2]]);
    useDoc = applied((await open(editor, useFile.id)).document, await importFrom(editor, useFile.id, libraryId, 2));
    ok(await save(editor, useFile.id, useDoc));
    const stored = (await open(editor, useFile.id)).document;
    assert.equal(stored.nodes[`cta;${remoteId(libraryId, 'label')}`].text?.characters, 'Buy', 'the override is kept');
    assert.deepEqual((stored.nodes[`cta;${remoteId(libraryId, 'bg')}`].fills[0] as {color: unknown}).color, GREEN, 'the rest follows the library');
    assert.equal(stored.nodes[remoteId(libraryId, 'btn')].remote?.version, 2);
    assert.deepEqual(libraryUpdates(stored, [{id: libraryId, version: 2, manifest: listed.manifest}]), []);
    ok(await files(editor, `/${useFile.id}/libraries/${libraryId}`, {method: 'PATCH', json: {seenVersion: 2}}));
    ok(await files(editor, `/${useFile.id}/libraries/${libraryId}`, {method: 'PATCH', json: {seenVersion: 99}}));
    assert.equal((await libraries(editor, useFile.id))[0].seenVersion, 2, 'never past the newest version');
    assert.equal((await files(viewer, `/${useFile.id}/libraries/${libraryId}`, {method: 'PATCH', json: {seenVersion: 2}})).status, 403);
  });

  await t.test('a guest of a team file (shared outside the team) uses the libraries the file enabled, and reaches no other of the team', async () => {
    // A second library of the team that the file did not enable.
    const iconsFile = await newFile(owner, teamId, 'Icons');
    ok(await save(owner, iconsFile.id, buttonDoc((await open(owner, iconsFile.id)).document, BLUE, 'Icon')));
    const icons = ok(await publish(owner, iconsFile.id, (await open(owner, iconsFile.id)).file.version), 201).library;
    const guest = await account('guest');
    await db.execute("INSERT INTO design_file_members(file_id,user_id,role,invited_by) VALUES($1,$2,'editor',$3)", [useFile.id, guest.id, editor.id]);
    assert.deepEqual((await libraries(editor, useFile.id)).map(entry => entry.id).sort(), [libraryId, icons.id].sort(), 'the team sees both');
    assert.deepEqual((await libraries(guest, useFile.id)).map(entry => [entry.id, entry.enabled]), [[libraryId, true]], 'the guest: the enabled one only');
    for (const [method, suffix, json] of [
      ['PUT', `/libraries/${icons.id}`, undefined],
      ['GET', `/libraries/${icons.id}/versions/1`, undefined],
      ['POST', `/libraries/${icons.id}/import`, {version: 1, components: ['btn']}],
    ] as const)
      assert.equal((await files(guest, `/${useFile.id}${suffix}`, {method, ...(json ? {json} : {})})).status, 404, `${method} ${suffix}`);
    // The enabled one works as for an editor of the team.
    assert.ok(validateLibrarySnapshot(ok(await files(guest, `/${useFile.id}/libraries/${libraryId}/versions/2`)).snapshot).ok);
    await importFrom(guest, useFile.id, libraryId, 2);
    // Publishing puts a library among the team's: not a guest's to do.
    const version = (await open(guest, useFile.id)).file.version;
    assert.equal((await publish(guest, useFile.id, version)).data.code, 'design_forbidden');
    assert.equal((await files(guest, `/${useFile.id}/library`, {method: 'DELETE'})).data.code, 'design_forbidden');
    assert.deepEqual(await libraries(owner, useFile.id).then(list => list.map(entry => entry.id).sort()), [libraryId, icons.id].sort(), 'the file published nothing');
    ok(await files(owner, `/${iconsFile.id}?permanent=1`, {method: 'DELETE'}));
    await db.execute('DELETE FROM design_file_members WHERE file_id=$1 AND user_id=$2', [useFile.id, guest.id]);
  });

  await t.test('unpublishing hides the library from new files; files that have it keep their copies; publishing again resumes it', async () => {
    assert.equal((await files(viewer, `/${libraryFile.id}/library`, {method: 'DELETE'})).status, 403);
    const own = ok(await files(owner, `/${libraryFile.id}/library`, {method: 'DELETE'})).library;
    assert.notEqual(own.unpublishedAt, null);
    const fresh = await newFile(editor, teamId, 'New');
    assert.deepEqual(await libraries(editor, fresh.id), []);
    assert.equal((await files(editor, `/${fresh.id}/libraries/${libraryId}`, {method: 'PUT'})).data.code, 'design_library_unavailable');
    const kept = (await libraries(editor, useFile.id))[0];
    assert.deepEqual([kept.enabled, kept.available], [true, false]);
    assert.equal((await files(editor, `/${useFile.id}/libraries/${libraryId}/import`, {method: 'POST', json: {version: 2, components: ['btn']}})).data.code, 'design_library_unavailable');
    assert.ok((await open(editor, useFile.id)).document.nodes[remoteId(libraryId, 'btn')]);
    const version = (await open(owner, libraryFile.id)).file.version;
    const again = ok(await publish(owner, libraryFile.id, version), 201).library;
    assert.deepEqual([again.version, again.unpublishedAt, again.manifest.components[0].changedIn], [3, null, 2]);
    assert.equal((await libraries(editor, fresh.id)).length, 1);
    // Disabling stops new imports; the copies stay.
    ok(await files(editor, `/${useFile.id}/libraries/${libraryId}`, {method: 'DELETE'}));
    assert.equal((await libraries(editor, useFile.id))[0].enabled, false);
    ok(await files(editor, `/${useFile.id}/libraries/${libraryId}`, {method: 'PUT'}));
  });

  await t.test('pictures: a library whose file moved into the team hands team files copies of its personal pictures, once', async () => {
    // Two personal files of the owner share a picture; the first publishes a library, then moves into the team.
    const personal = await newFile(owner, undefined, 'Personal kit'),
      sibling = await newFile(owner, undefined, 'Sibling');
    const shared = await upload(owner, personal.id, await png(20, 20, 30));
    ok(await save(owner, personal.id, buttonDoc((await open(owner, personal.id)).document, BLUE, 'Personal', shared)));
    const siblingDoc = buttonDoc((await open(owner, sibling.id)).document, BLUE, 'Sibling', shared);
    ok(await save(owner, sibling.id, siblingDoc));
    const personalLibrary = ok(await publish(owner, personal.id, (await open(owner, personal.id)).file.version), 201).library.id as string;
    const ownerPersonal = await newFile(owner);
    assert.deepEqual((await libraries(owner, ownerPersonal.id)).map(entry => entry.id), [personalLibrary], 'personal files see the account\'s personal libraries');
    assert.deepEqual(await libraries(editor, useFile.id).then(list => list.map(entry => entry.id)), [libraryId], 'the team does not');
    ok(await files(owner, `/${personal.id}/move`, {method: 'POST', json: {teamId}}));
    assert.deepEqual(await libraries(owner, ownerPersonal.id), [], 'the library went with its file');
    assert.deepEqual((await libraries(editor, useFile.id)).map(entry => entry.id).sort(), [libraryId, personalLibrary].sort());
    ok(await files(editor, `/${useFile.id}/libraries/${personalLibrary}`, {method: 'PUT'}));
    const first = await importFrom(editor, useFile.id, personalLibrary, 1);
    const url = first.document.images[shared.ref].url;
    assert.notEqual(url, shared.asset.url, 'the personal picture was copied');
    const copy = url.slice('/uploads/'.length);
    const row = await db.one<{team_id: string; file_id: string; source: string}>(
      'SELECT d.team_id,d.file_id,p.source FROM design_images d JOIN design_library_pictures p ON p.filename=d.filename WHERE d.filename=$1',
      [copy],
    );
    assert.deepEqual(row, {team_id: teamId, file_id: useFile.id, source: shared.asset.url.slice('/uploads/'.length)});
    assert.equal((await fetchAs(viewer, url)).status, 200, 'team members see the copy');
    assert.equal((await fetchAs(viewer, shared.asset.url)).status, 404, 'never the original');
    const second = await importFrom(editor, useFile.id, personalLibrary, 1);
    assert.equal(second.document.images[shared.ref].url, url, 'the next use takes the same copy');
    // The file saves with the copy: it is the team's own picture.
    useDoc = applied((await open(editor, useFile.id)).document, second);
    ok(await save(editor, useFile.id, useDoc));
    // A hand-made patch pointing at the personal original is refused.
    const current = await open(editor, useFile.id);
    const refused = await files(editor, `/${useFile.id}/document`, {method: 'PATCH', json: {baseVersion: current.file.version, patch: {images: {stolen: shared.asset}}}});
    assert.equal(refused.status, 403);
  });

  await t.test('the room for documents counts library versions; a full room refuses a publication', async () => {
    const usage = await db.one<{total: number}>(
      `SELECT (SELECT COALESCE(sum(bytes),0) FROM design_files WHERE user_id=$1)+(SELECT COALESCE(sum(bytes),0) FROM design_file_versions WHERE user_id=$1)
         +(SELECT COALESCE(sum(bytes),0) FROM design_library_versions WHERE user_id=$1) AS total`,
      [owner.id],
    );
    process.env.DESIGN_ACCOUNT_DOCUMENT_BYTES = String(Number(usage!.total) + 10);
    try {
      const refused = await publish(owner, libraryFile.id, (await open(owner, libraryFile.id)).file.version);
      assert.deepEqual([refused.status, refused.data.code], [413, 'design_documents_limit']);
    } finally {
      delete process.env.DESIGN_ACCOUNT_DOCUMENT_BYTES;
    }
  });

  await t.test('erasing the library file takes its library; the file that used it keeps its copies and the pictures they show', async () => {
    const before = (await open(editor, useFile.id)).document;
    ok(await files(owner, `/${libraryFile.id}`, {method: 'DELETE'}));
    // In the trash: no new file may enable it, the ones that have it are offered nothing new.
    const listed = (await libraries(editor, useFile.id)).find(entry => entry.id === libraryId);
    assert.deepEqual([listed.enabled, listed.available], [true, false]);
    ok(await files(owner, `/${libraryFile.id}?permanent=1`, {method: 'DELETE'}));
    for (const table of ['design_libraries', 'design_library_versions', 'design_library_subscriptions'])
      assert.equal(await db.one(`SELECT 1 FROM ${table} WHERE ${table === 'design_libraries' ? 'id' : 'library_id'}=$1`, [libraryId]), undefined, table);
    const after = (await open(editor, useFile.id)).document;
    assert.deepEqual(after, before, 'the copies stay');
    const filename = picture.asset.url.slice('/uploads/'.length);
    assert.ok(await db.one('SELECT 1 FROM design_images WHERE filename=$1', [filename]), 'the picture the copies show stays');
    assert.ok(existsSync(path.join(f.dataDir, 'uploads', filename)));
  });

  await t.test('account erasure takes the account\'s libraries; the export lists them with their snapshots', async () => {
    const leaving = await account('leaving');
    const kit = await newFile(leaving, undefined, 'My kit');
    ok(await save(leaving, kit.id, buttonDoc((await open(leaving, kit.id)).document, BLUE, 'Button')));
    const library = ok(await publish(leaving, kit.id, (await open(leaving, kit.id)).file.version), 201).library.id as string;
    const user = await newFile(leaving);
    ok(await files(leaving, `/${user.id}/libraries/${library}`, {method: 'PUT'}));
    const {prepareExportMetadata} = await import('../server/launch/export-json');
    const {exportDesignAccount} = await import('../server/design/lifecycle');
    const chunks: string[] = [];
    await prepareExportMetadata({design: exportDesignAccount(leaving.id)})(db, async text => void chunks.push(text));
    const exported = JSON.parse('{' + chunks.join('') + '}').design;
    assert.deepEqual(exported.libraries.published.map((entry: {id: string; fileId: string; version: number}) => [entry.id, entry.fileId, entry.version]), [[library, kit.id, 1]]);
    assert.equal(exported.libraries.versions.length, 1);
    assert.ok(validateLibrarySnapshot(JSON.parse(exported.libraries.versions[0].snapshot)).ok);
    assert.deepEqual(exported.libraries.enabled.map((entry: {fileId: string; libraryId: string}) => [entry.fileId, entry.libraryId]), [[user.id, library]]);
    await db.execute('UPDATE users SET deletion_requested_at=$1 WHERE id=$2', [new Date().toISOString().replace('T', ' ').slice(0, 19), leaving.id]);
    await lifecycle.launchMaintenance();
    assert.notEqual((await db.one<{erasure_completed_at: string | null}>('SELECT erasure_completed_at FROM users WHERE id=$1', [leaving.id]))!.erasure_completed_at, null);
    assert.equal(await db.one('SELECT 1 FROM design_libraries WHERE id=$1', [library]), undefined);
    assert.equal(await db.one('SELECT 1 FROM design_library_versions WHERE library_id=$1', [library]), undefined);
    assert.equal(await db.one('SELECT 1 FROM design_library_subscriptions WHERE library_id=$1', [library]), undefined);
  });
});
