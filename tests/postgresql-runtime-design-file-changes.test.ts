import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {Server} from 'node:http';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {applyPatch, type DocumentPatch} from '../shared/design/patch';
import type {DesignDocument, SceneNode} from '../shared/design/types';

// "Morfa Design": saves of large files stored as changes after the document's stored text (SQL038, server/design/document-store.ts,
// docs/design-tool.md "Saving large files"), against the real PostgreSQL schema. Every reader sees the whole document at the
// file's version (the editor's read, a forgotten cache, the account export, copies, versions, restores, moves, library publishing);
// the text catches up without changing it; the size, pictures and layer count stay exact; a file under the threshold is written whole.

/** A document of `layers` text layers with long names: about 500 bytes each. */
function documentOf(layers: number): DesignDocument {
  const doc = createDocument('page', 'Screen');
  for (let k = 0; k < layers; k++) {
    const id = `t${k}`;
    doc.nodes[id] = createNode('TEXT', {id, parentId: 'page', name: `Text layer number ${k} with a long name`, x: k, y: k * 2, width: 200, height: 20, text: defaultTextProps('Hello, world ' + k)});
    doc.nodes.page.children!.push(id);
  }
  return doc;
}

test('"Morfa Design" saves of large files: changes after the stored text, whole reads, catching up, copies and limits', {timeout: 600_000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const values: NodeJS.ProcessEnv = {
    ENABLE_DESIGN_TOOL: '1',
    ERASURE_LEDGER_PATH: path.join(f.dataDir, 'ledger', 'erasure.jsonl'),
    // Files of 20 KB or more are saved as changes here (256 KB in production); the timer never fires on its own during the test.
    DESIGN_DOCUMENT_DELTA_BYTES: String(20_000),
    DESIGN_DOCUMENT_COMPACT_MS: String(10 * 60_000),
  };
  const saved = Object.fromEntries(['APP_ORIGIN', 'DESIGN_TOOL_ACCOUNTS', 'DESIGN_DOCUMENT_CACHE_BYTES', ...Object.keys(values)].map(key => [key, process.env[key]]));
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  delete process.env.DESIGN_DOCUMENT_CACHE_BYTES;
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const auth = await import('../server/auth');
  const files = await import('../server/design/files');
  const libraries = await import('../server/design/libraries');
  const teams = await import('../server/design/teams');
  const store = await import('../server/design/document-store');
  const cache = await import('../server/design/document-cache');
  const {dataDir} = await import('../server/db');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
  });

  const id = `changes:${randomUUID()}`,
    token = randomUUID();
  await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, randomUUID() + '@example.invalid']);
  await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
  const actor = Object.freeze({ownerId: id, sessionHash: auth.digest(token)});
  const cookie = auth.authCookieName('session') + '=' + token;

  type Row = {document: string; version: number; bytes: number; node_count: number; image_files: string[]};
  const row = async (fileId: string) => (await db.one<Row>('SELECT document,version,bytes,node_count,image_files FROM design_files WHERE id=$1', [fileId]))!;
  const changes = async (fileId: string) => (await db.many<{version: number}>('SELECT version FROM design_file_changes WHERE file_id=$1 ORDER BY version', [fileId])).map(change => Number(change.version));
  const text = (doc: DesignDocument) => JSON.stringify(doc);
  /** The next save is not one that takes an automatic version (those write the whole text). */
  const versionTaken = (fileId: string) => db.execute('UPDATE design_files SET auto_version_at=clock_timestamp() WHERE id=$1', [fileId]);
  /** What GET /:id answers, through the whole app. */
  const opened = async (fileId: string) => {
    const response = await fetch(`${base}/api/design-files/${fileId}`, {headers: {cookie}});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    return (await response.json()) as {file: {version: number}; document: DesignDocument};
  };
  /** One save of `edit` made on `doc` at `version` (as autosave sends it, with the client's copies). */
  async function save(fileId: string, doc: DesignDocument, version: number, edit: Record<string, Partial<SceneNode> | null>, extra: DocumentPatch = {}) {
    const nodes: Record<string, SceneNode | null> = {}, before: Record<string, SceneNode | null> = {};
    for (const [key, partial] of Object.entries(edit)) {
      before[key] = doc.nodes[key] ?? null;
      nodes[key] = partial === null ? null : ({...doc.nodes[key], ...partial} as SceneNode);
    }
    const patch: DocumentPatch = {...extra, nodes};
    const answer = await files.patchDesignDocument(actor, fileId, {baseVersion: version, patch, before, client: null});
    assert.equal(answer.version, version + 1, 'every save writes');
    return {doc: applyPatch(doc, patch), version: answer.version};
  }
  const exact = async (fileId: string, doc: DesignDocument, version: number) => {
    const stored = await row(fileId);
    assert.equal(Number(stored.version), version);
    assert.equal(stored.bytes, Buffer.byteLength(text(doc)), 'the size is the whole document’s');
    assert.equal(stored.node_count, Object.keys(doc.nodes).length);
    const open = await opened(fileId);
    assert.equal(open.file.version, version);
    assert.deepEqual(open.document, doc, 'a read sees the whole document');
    // Another process (no cached document) puts the text and its changes together to the same document.
    cache.forgetDocument(fileId);
    assert.deepEqual((await opened(fileId)).document, doc, 'a read without the cache sees the whole document');
  };

  await t.test('saves of a large file go after its stored text; reads, a forgotten cache and the catch-up see the same document', async () => {
    let doc = documentOf(80);
    const file = (await files.createDesignFile(actor, {name: 'Large', document: doc})).file;
    assert.equal((await row(file.id)).document, text(doc));
    await versionTaken(file.id);
    let version = 1;
    for (let k = 0; k < 3; k++) ({doc, version} = await save(file.id, doc, version, {[`t${k}`]: {name: `Renamed ${k}`, x: 500 + k}}));
    assert.deepEqual(await changes(file.id), [2, 3, 4], 'one row per save');
    assert.equal((await row(file.id)).document, text(documentOf(80)), 'the stored text did not move');
    assert.deepEqual(store.scheduledCompactions(), [file.id], 'its catch-up waits for the timer');
    await exact(file.id, doc, 4);
    // The cold read above planned a catch-up (with the usual delay: a read never brings it forward or puts it off).
    assert.deepEqual(store.scheduledCompactions(), [file.id]);
    assert.equal(await store.compact(file.id), true);
    assert.deepEqual(await changes(file.id), [], 'the text caught up');
    assert.equal((await row(file.id)).document, text(doc));
    assert.equal(await store.compact(file.id), false, 'nothing waits any more');
    if ((await db.one<{lz4: boolean}>("SELECT 'lz4'=ANY(enumvals) AS lz4 FROM pg_settings WHERE name='default_toast_compression'"))?.lz4)
      assert.equal((await db.one<{method: string}>('SELECT pg_column_compression(document) AS method FROM design_files WHERE id=$1', [file.id]))!.method, 'lz4');
    await exact(file.id, doc, 4);
    // A removal and a new layer, a picture of the account: the size, layer count and pictures follow every save.
    await db.execute("INSERT INTO design_images(filename,user_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,'image',100,10,10)", ['dz-photo.webp', id, file.id]);
    const added = createNode('RECTANGLE', {id: 'new', parentId: 'page', name: 'New', fills: [{type: 'IMAGE', imageRef: 'photo', scaleMode: 'FILL', visible: true, opacity: 1, blendMode: 'NORMAL'}]});
    ({doc, version} = await save(file.id, doc, version, {t5: null, new: added, page: {children: [...doc.nodes.page.children!.filter(child => child !== 't5'), 'new']}}, {images: {photo: {url: '/uploads/dz-photo.webp', width: 10, height: 10}}}));
    assert.deepEqual(await changes(file.id), [5]);
    assert.deepEqual((await row(file.id)).image_files, ['dz-photo.webp']);
    await exact(file.id, doc, 5);
    // The process stops: every waiting text is written.
    await store.flushDocumentWrites();
    assert.deepEqual(store.scheduledCompactions(), []);
    assert.deepEqual(await changes(file.id), []);
    assert.equal((await row(file.id)).document, text(doc));
  });

  await t.test('copies, named and automatic versions, replaces, restores and the account export take the whole document', async () => {
    let doc = documentOf(60);
    const file = (await files.createDesignFile(actor, {name: 'Copies', document: doc})).file;
    let version = 1;
    await versionTaken(file.id);
    for (let k = 0; k < 2; k++) ({doc, version} = await save(file.id, doc, version, {[`t${k}`]: {name: `Copy ${k}`}}));
    assert.deepEqual(await changes(file.id), [2, 3]);
    cache.forgetDocument(file.id);
    const copy = await files.duplicateDesignFile(actor, file.id);
    assert.equal((await row(copy.id)).document, text(doc), 'the copy holds the whole document');
    assert.deepEqual(await changes(copy.id), []);
    const named = await files.saveDesignVersion(actor, file.id, 'Before the edits');
    assert.deepEqual(JSON.parse(await files.readDesignVersion(actor, file.id, named.id)), doc, 'a named version is the whole document');
    assert.deepEqual(await changes(file.id), [2, 3], 'copies leave the waiting changes alone');
    // "Duplicate" of that version: a new file with the whole document.
    const fromVersion = await files.duplicateDesignVersion(actor, file.id, named.id, {});
    assert.deepEqual(JSON.parse((await row(fromVersion.id)).document), doc);
    // The automatic version is due: the save keeps the document it replaces, whole, and writes its own text whole.
    await db.execute("UPDATE design_files SET auto_version_at=clock_timestamp()-interval '11 minutes' WHERE id=$1", [file.id]);
    const replaced = doc;
    ({doc, version} = await save(file.id, doc, version, {t9: {name: 'After the version'}}));
    assert.deepEqual(await changes(file.id), [], 'a save that takes a version writes the whole text');
    assert.equal((await row(file.id)).document, text(doc));
    const automatic = (await db.many<{id: string; version: number}>('SELECT id,version FROM design_file_versions WHERE file_id=$1 AND label IS NULL ORDER BY created_at DESC', [file.id]))[0];
    assert.equal(Number(automatic.version), 3);
    assert.deepEqual(JSON.parse(await files.readDesignVersion(actor, file.id, automatic.id)), replaced);
    // A replace (import, "Keep mine") writes the whole text over waiting changes and keeps the document it replaced.
    ({doc, version} = await save(file.id, doc, version, {t8: {name: 'Waiting'}}));
    assert.deepEqual(await changes(file.id), [5]);
    const before = doc;
    const next = documentOf(61);
    const put = await files.replaceDesignDocument(actor, file.id, {baseVersion: version, document: next});
    assert.deepEqual(await changes(file.id), []);
    await exact(file.id, next, put.version);
    const kept = (await db.one<{id: string}>('SELECT id FROM design_file_versions WHERE file_id=$1 AND version=$2 AND label IS NULL', [file.id, version]))!;
    assert.deepEqual(JSON.parse(await files.readDesignVersion(actor, file.id, kept.id)), before, 'the replaced document, whole');
    // A restore over waiting changes: the document it replaces is kept whole, the restored one written whole.
    ({doc, version} = await save(file.id, next, put.version, {t2: {name: 'Before the restore'}}));
    assert.deepEqual(await changes(file.id), [version]);
    cache.forgetDocument(file.id);
    const restored = await files.restoreDesignVersion(actor, file.id, named.id, version);
    assert.deepEqual(await changes(file.id), []);
    const beforeRestore = (await db.one<{id: string}>('SELECT id FROM design_file_versions WHERE file_id=$1 AND version=$2 AND label IS NULL', [file.id, version]))!;
    assert.deepEqual(JSON.parse(await files.readDesignVersion(actor, file.id, beforeRestore.id)), doc, 'the document before the restore, whole');
    await exact(file.id, JSON.parse(await files.readDesignVersion(actor, file.id, named.id)), restored.version);
    // The account export (GET /api/settings/data-export) reads the whole document of a file with waiting changes.
    await versionTaken(file.id);
    let exported: DesignDocument = (await opened(file.id)).document;
    ({doc: exported, version} = await save(file.id, exported, restored.version, {t3: {name: 'In the export'}}));
    assert.deepEqual(await changes(file.id), [version]);
    cache.forgetDocument(file.id);
    const response = await fetch(`${base}/api/settings/data-export`, {headers: {cookie}});
    assert.equal(response.status, 200);
    const data = (await response.json()) as {design: {files: {id: string; version: number; document: string}[]}};
    const listed = data.design.files.find(item => item.id === file.id)!;
    assert.equal(Number(listed.version), version);
    assert.equal(listed.document, text(exported), 'the export holds the latest document');
    assert.equal(await db.transaction(tx => store.currentDocumentText(tx, file.id, id)), text(exported));
    // Erasing the file takes its waiting changes.
    await files.eraseDesignFile(actor, file.id);
    assert.deepEqual(await changes(file.id), []);
    for (const other of [copy.id, fromVersion.id]) await files.eraseDesignFile(actor, other);
  });

  await t.test('moves and library publishing read the whole document; a move that rewrites it drops the changes', async () => {
    // Two personal files show one picture: moving one into a team copies it, so that file's document is rewritten.
    const picture = `dz-${randomUUID()}.webp`;
    await fs.writeFile(path.join(dataDir, 'uploads', picture), Buffer.from('RIFF0000WEBP'));
    await db.execute("INSERT INTO design_images(filename,user_id,file_id,kind,bytes,width,height) VALUES($1,$2,NULL,'image',100,10,10)", [picture, id]);
    const pictured = (doc: DesignDocument): DesignDocument => {
      const fill = {type: 'IMAGE' as const, imageRef: 'pic', scaleMode: 'FILL' as const, visible: true, opacity: 1, blendMode: 'NORMAL' as const};
      return {...doc, images: {pic: {url: '/uploads/' + picture, width: 10, height: 10}}, nodes: {...doc.nodes, t0: {...doc.nodes.t0, fills: [fill]}}};
    };
    const other = (await files.createDesignFile(actor, {name: 'Other', document: pictured(documentOf(3))})).file;
    let doc = pictured(documentOf(70));
    const file = (await files.createDesignFile(actor, {name: 'Move', document: doc})).file;
    const plain = (await files.createDesignFile(actor, {name: 'No pictures', document: documentOf(70)})).file;
    let plainDoc = documentOf(70);
    let version = 1,
      plainVersion = 1;
    for (const each of [file.id, plain.id]) await versionTaken(each);
    for (let k = 0; k < 2; k++) {
      ({doc, version} = await save(file.id, doc, version, {[`t${k + 1}`]: {name: `Before the move ${k}`}}));
      ({doc: plainDoc, version: plainVersion} = await save(plain.id, plainDoc, plainVersion, {[`t${k + 1}`]: {name: `Before the move ${k}`}}));
    }
    assert.deepEqual(await changes(file.id), [2, 3]);
    const team = await teams.createDesignTeam(actor, 'Studio');
    // Without a rewrite the file keeps its version, its stored text and the changes after it.
    cache.forgetDocument(plain.id);
    await files.moveDesignFile(actor, plain.id, {teamId: team.id, projectId: null});
    assert.deepEqual(await changes(plain.id), [2, 3]);
    await exact(plain.id, plainDoc, plainVersion);
    ({doc: plainDoc, version: plainVersion} = await save(plain.id, plainDoc, plainVersion, {t9: {name: 'In the team'}}));
    assert.deepEqual(await changes(plain.id), [2, 3, 4]);
    await exact(plain.id, plainDoc, plainVersion);
    // With a rewrite: the whole document at the next version, pointing at the copy; nothing waits after it.
    cache.forgetDocument(file.id);
    const moved = await files.moveDesignFile(actor, file.id, {teamId: team.id, projectId: null});
    assert.equal(moved.version, version + 1);
    assert.deepEqual(await changes(file.id), []);
    const rewritten = JSON.parse((await row(file.id)).document) as DesignDocument;
    assert.notEqual(rewritten.images.pic.url, '/uploads/' + picture, 'the document points at the copy');
    assert.deepEqual({...rewritten, images: {}}, {...doc, images: {}}, 'every change made before the move is in it');
    await exact(file.id, rewritten, version + 1);

    // A library published from a file whose last saves wait after its text is built from the whole document.
    let lib = documentOf(70);
    lib = {...lib, nodes: {...lib.nodes, card: createNode('COMPONENT', {id: 'card', parentId: 'page', name: 'Card', width: 100, height: 100}), page: {...lib.nodes.page, children: [...lib.nodes.page.children!, 'card']}}};
    const published = (await files.createDesignFile(actor, {name: 'Library', document: lib})).file;
    await versionTaken(published.id);
    let libVersion = 1;
    ({doc: lib, version: libVersion} = await save(published.id, lib, libVersion, {card: {name: 'Product card'}}));
    assert.deepEqual(await changes(published.id), [2]);
    cache.forgetDocument(published.id);
    await libraries.publishLibrary(actor, published.id, {baseVersion: libVersion, components: ['card'], styles: [], variableCollections: []});
    const snapshot = (await db.one<{snapshot: string}>('SELECT v.snapshot FROM design_library_versions v JOIN design_libraries l ON l.id=v.library_id WHERE l.file_id=$1', [published.id]))!;
    assert.equal((JSON.parse(snapshot.snapshot) as {document: DesignDocument}).document.nodes.card.name, 'Product card');
    for (const each of [other.id, file.id, plain.id, published.id]) await files.eraseDesignFile(actor, each);
  });

  await t.test('two processes save one large file at once, each catching its text up on its own timer: one document, every save kept', async () => {
    let doc = documentOf(60);
    const file = (await files.createDesignFile(actor, {name: 'Two processes', document: doc})).file;
    await versionTaken(file.id);
    const theirs = Array.from({length: 20}, (_, k) => `t${40 + k}`),
      theirSaves = 80;
    // The other process catches its text up 25 ms after its last save, so its catch-ups race this process's saves.
    const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'helpers', 'design-file-changes-process.ts'), file.id, id, actor.sessionHash, theirs.join(','), String(theirSaves)], {
      env: {...process.env, DESIGN_DOCUMENT_COMPACT_MS: '25'},
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let output = '';
    const started = new Promise<void>((resolve, reject) => {
      child.stdout.on('data', chunk => {
        output += chunk;
        if (output.includes('ready')) resolve();
      });
      child.once('exit', code => reject(Error(`the other process stopped first (${code})`)));
    });
    const finished = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
    await started;
    let version = 1;
    for (let k = 0; k < 80; k++) {
      const layer = `t${k % 20}`;
      const node = {...doc.nodes[layer], x: 3000 + k};
      try {
        version = (await files.patchDesignDocument(actor, file.id, {baseVersion: version, patch: {nodes: {[layer]: node}}, before: {[layer]: doc.nodes[layer]}, client: null})).version;
      } catch (error) {
        // Lost the race with the other process four times over: the editor sends the same change again.
        if ((error as {code?: string}).code !== 'version_conflict') throw error;
        k--;
        continue;
      }
      doc = applyPatch(doc, {nodes: {[layer]: node}});
      if (k % 7 === 0) cache.forgetDocument(file.id);
      if (k % 5 === 0) void store.compact(file.id);
      await new Promise(resolve => setTimeout(resolve, Math.random() * 6));
    }
    assert.equal(await finished, 0, 'the other process saved everything');
    const last = JSON.parse(output.trim().split('\n').pop()!) as Record<string, number>;
    for (const [layer, x] of Object.entries(last)) doc = applyPatch(doc, {nodes: {[layer]: {...doc.nodes[layer], x}}});
    await store.flushDocumentWrites();
    const stored = await row(file.id);
    assert.equal(Number(stored.version), 1 + 80 + theirSaves, 'one version per save, none lost to a race');
    const versions = await changes(file.id);
    assert.deepEqual(versions, versions.length ? Array.from({length: versions.length}, (_, k) => Number(stored.version) - versions.length + 1 + k) : []);
    await exact(file.id, doc, Number(stored.version));
    assert.equal(await store.compact(file.id), versions.length > 0);
    assert.equal((await row(file.id)).document, text(doc), 'the caught-up text is that document');
    await files.eraseDesignFile(actor, file.id);
  });

  await t.test('a process holding an older version catches up from the changes another process saved, or reads the whole text', async () => {
    let doc = documentOf(60);
    const file = (await files.createDesignFile(actor, {name: 'Catching up', document: doc})).file;
    await versionTaken(file.id);
    let version = 1;
    ({doc, version} = await save(file.id, doc, version, {t0: {x: 777}}));
    /** Saves of another process: `saves` layers moved there, its changes left waiting unless it catches its text up. */
    const other = async (layers: string[], saves: number, keep: boolean) => {
      const child = spawn(process.execPath, ['--import', 'tsx', path.join(import.meta.dirname, 'helpers', 'design-file-changes-process.ts'), file.id, id, actor.sessionHash, layers.join(','), String(saves), ...(keep ? ['keep'] : [])], {
        env: {...process.env, DESIGN_DOCUMENT_COMPACT_MS: String(10 * 60_000)},
        stdio: ['ignore', 'pipe', 'inherit'],
      });
      let output = '';
      child.stdout.on('data', chunk => (output += chunk));
      assert.equal(await new Promise(resolve => child.once('exit', resolve)), 0);
      for (const [layer, x] of Object.entries(JSON.parse(output.trim().split('\n').pop()!) as Record<string, number>)) doc = applyPatch(doc, {nodes: {[layer]: {...doc.nodes[layer], x}}});
      version += saves;
    };
    // This process holds version 2; the other one saves 3 changes and leaves them waiting: a read here applies those 3.
    await other(['t10', 't11', 't12'], 3, true);
    assert.deepEqual(await changes(file.id), [2, 3, 4, 5]);
    let before = store.documentReads();
    const open = await opened(file.id);
    assert.equal(open.file.version, version);
    assert.deepEqual(open.document, doc, 'the held document caught up is the stored one');
    assert.deepEqual(store.documentReads(), {whole: before.whole, caughtUp: before.caughtUp + 1}, 'caught up, not read whole');
    ({doc, version} = await save(file.id, doc, version, {t1: {x: 778}}));
    // The other process catches its text up before it stops: nothing to catch up from, so the text is read whole.
    await other(['t20'], 2, false);
    assert.deepEqual(await changes(file.id), []);
    before = store.documentReads();
    assert.deepEqual((await opened(file.id)).document, doc);
    assert.deepEqual(store.documentReads(), {whole: before.whole + 1, caughtUp: before.caughtUp});
    await exact(file.id, doc, version);
    await files.eraseDesignFile(actor, file.id);
  });

  await t.test('a board is stored like a design file: changes after its text, whole reads, copies that stay boards', async () => {
    const created = (await files.createDesignFile(actor, {name: 'Board', document: documentOf(60), kind: 'board'})).file;
    assert.equal(created.kind, 'board');
    let doc = (await opened(created.id)).document;
    assert.equal(doc.board, true);
    await versionTaken(created.id);
    let version = 1;
    for (let k = 0; k < 2; k++) ({doc, version} = await save(created.id, doc, version, {[`t${k}`]: {name: `Sticky ${k}`}}));
    assert.deepEqual(await changes(created.id), [2, 3]);
    await exact(created.id, doc, version);
    cache.forgetDocument(created.id);
    const copy = await files.duplicateDesignFile(actor, created.id);
    assert.equal(copy.kind, 'board');
    assert.equal((await row(copy.id)).document, text(doc), 'the copy of a board holds its whole document');
    const named = await files.saveDesignVersion(actor, created.id, 'Board before the edits');
    const fromVersion = await files.duplicateDesignVersion(actor, created.id, named.id, {});
    assert.equal(fromVersion.kind, 'board');
    assert.deepEqual(JSON.parse((await row(fromVersion.id)).document), doc);
    for (const each of [created.id, copy.id, fromVersion.id]) await files.eraseDesignFile(actor, each);
  });

  await t.test('a long run of saves writes the whole text every so often; saves and catch-ups interleaved keep one document', async () => {
    let doc = documentOf(50);
    const file = (await files.createDesignFile(actor, {name: 'Many', document: doc})).file;
    await versionTaken(file.id);
    let version = 1,
      most = 0;
    for (let k = 0; k < store.MAX_WAITING_CHANGES + 5; k++) {
      ({doc, version} = await save(file.id, doc, version, {[`t${k % 50}`]: {x: 1000 + k}}));
      most = Math.max(most, (await changes(file.id)).length);
    }
    assert.equal(most, store.MAX_WAITING_CHANGES, 'at most this many changes wait');
    assert.deepEqual(await changes(file.id), [version - 3, version - 2, version - 1, version], 'the whole text was written and the changes went');
    await exact(file.id, doc, version);
    // A change that would take the waiting bytes past 4 MB writes the whole text (a paste of long texts: 15 × 100 000 characters).
    const long = (k: number) => Object.fromEntries(Array.from({length: 15}, (_, j) => [`t${j}`, {text: defaultTextProps(String(k).repeat(100_000))}]));
    const sizes: number[] = [];
    for (let k = 1; k <= 3; k++) {
      ({doc, version} = await save(file.id, doc, version, long(k)));
      sizes.push((await changes(file.id)).length);
    }
    assert.deepEqual(sizes, [5, 6, 0], 'the third change of 1.5 MB would pass 4 MB of waiting changes');
    await exact(file.id, doc, version);
    // Saves and catch-ups at once (the timer, another reader), and the cache gone in between: one document in the end.
    const saves: Promise<unknown>[] = [];
    for (let k = 0; k < 12; k++) {
      const result = save(file.id, doc, version, {[`t${k}`]: {y: 1000 + k}});
      saves.push(result);
      ({doc, version} = await result);
      if (k % 3 === 0) cache.forgetDocument(file.id);
      saves.push(store.compact(file.id));
    }
    await Promise.all(saves);
    const versions = await changes(file.id);
    assert.deepEqual(versions, versions.length ? Array.from({length: versions.length}, (_, k) => version - versions.length + 1 + k) : [], 'the waiting changes are the last versions');
    await exact(file.id, doc, version);
    // A save that read an older version than the stored one meets a conflict (and merges again in the route), never a mix.
    await assert.rejects(db.transaction(tx => store.storedDocument(tx, {id: file.id, user_id: id, version: version - 1})), (error: {code?: string}) => error.code === 'version_conflict');
    // Changes that are not exactly the versions after the stored text are refused, never put together.
    assert.throws(() => store.composeStored({document: text(doc), version: 9, versions: [7, 9], patches: ['{}', '{}']}), /not the versions/);
    await files.eraseDesignFile(actor, file.id);
  });

  await t.test('saves reuse the previous version\'s node table (lane L6): a lent document never changes, the text stays byte for byte', async () => {
    let doc = documentOf(60);
    const file = (await files.createDesignFile(actor, {name: 'Tables', document: doc})).file;
    await versionTaken(file.id);
    let version = 1;
    const before = cache.recycledTables();
    // Saves one after another: from the third on, each writes into the table of the version two back.
    for (let k = 0; k < 6; k++) ({doc, version} = await save(file.id, doc, version, {[`t${k}`]: {x: 900 + k}, [`t${k + 10}`]: null, page: {children: doc.nodes.page.children!.filter(child => child !== `t${k + 10}`)}}));
    // DESIGN_COLLAB=shadow (the `.shadow` run of this suite): the forward to collab reads both documents of a save after the
    // answer, so it lends them (collab/shadow.ts) and no table is reused; the rest of this test holds the same.
    if (process.env.DESIGN_COLLAB === 'shadow') assert.equal(cache.recycledTables().taken, before.taken, `no reused table under the shadow: ${JSON.stringify(cache.recycledTables())}`);
    else assert.ok(cache.recycledTables().taken - before.taken >= 4, `saves wrote into a reused table: ${JSON.stringify(cache.recycledTables())}`);
    // A reader holds the document (a move, a PDF, a library): its table is lent, later saves never write into it.
    const held = await files.openDesignFile(actor, file.id);
    const lent = await store.storedDocument(db, {id: file.id, user_id: id, version});
    const lentText = text(lent);
    for (let k = 0; k < 4; k++) ({doc, version} = await save(file.id, doc, version, {[`t${k + 20}`]: {name: `Layer ${k}`}, [`n${k}`]: createNode('RECTANGLE', {id: `n${k}`, parentId: 'page'}), page: {children: [...doc.nodes.page.children!, `n${k}`]}}));
    assert.equal(text(lent), lentText, 'the lent document is as it was');
    assert.equal(String(held.documentText), lentText);
    // Byte for byte (key order too) what applying every patch with copies makes, through the cache and after the catch-up.
    assert.equal(text((await opened(file.id)).document), text(doc));
    assert.equal(await store.compact(file.id), true);
    assert.equal((await row(file.id)).document, text(doc), 'the caught-up text is the copies\' text');
    await exact(file.id, doc, version);
  });

  await t.test('the document a file is created or replaced with stays the caller\'s: later saves never write into its node table', async () => {
    // validateDocument answers the caller's own object, and the cache kept it as the file's document: two saves later its table was
    // the spare a save wrote into, so the caller's copy took that version's layers. The race of two processes above saw it as a
    // retried save whose `before` (read from the test's document) already held the change: merged as nothing, one version short.
    const created = documentOf(60);
    const createdText = text(created);
    const file = (await files.createDesignFile(actor, {name: 'Foreign table', document: created})).file;
    await versionTaken(file.id);
    let doc = documentOf(60),
      version = 1;
    for (let k = 0; k < 4; k++) ({doc, version} = await save(file.id, doc, version, {[`t${k}`]: {x: 4000 + k}}));
    assert.equal(text(created), createdText, 'the document the file was created with is as it was');
    const replacement = documentOf(60);
    const replacementText = text(replacement);
    version = (await files.replaceDesignDocument(actor, file.id, {baseVersion: version, document: replacement})).version;
    doc = documentOf(60);
    for (let k = 0; k < 4; k++) ({doc, version} = await save(file.id, doc, version, {[`t${k}`]: {x: 4100 + k}}));
    assert.equal(text(replacement), replacementText, 'the document the file was replaced with is as it was');
    await exact(file.id, doc, version);
  });

  await t.test('a file under the threshold is written whole on every save, as before', async () => {
    let doc = documentOf(4);
    assert.ok(Buffer.byteLength(text(doc)) < 20_000);
    const file = (await files.createDesignFile(actor, {name: 'Small', document: doc})).file;
    await versionTaken(file.id);
    let version = 1;
    for (let k = 0; k < 3; k++) ({doc, version} = await save(file.id, doc, version, {t1: {x: 10 + k}}));
    assert.deepEqual(await changes(file.id), []);
    assert.equal((await row(file.id)).document, text(doc));
    await exact(file.id, doc, version);
  });
});
