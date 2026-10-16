import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {SceneNode} from '../shared/design/types';

// PNG/JPG/WebP through the render service (DESIGN_RASTER_ENGINE=service, server/design/raster-export.ts → lane L4's
// vello_cpu in crates/render-service): the whole app against the real PostgreSQL schema. With `morfa-render` built the
// real service paints the frame (a frame exports exactly its box, as the browser's export does); a stand-in service
// checks what the api sends and how it maps refusals; a service that is not there answers 503 and the switch off 404 —
// both tell the editor to paint the export itself.

type Account = {id: string; token: string};
type Answer = {status: number; data: any; type: string | null; headers: Headers};

/** MORFA_RENDER_BIN, or the newest morfa-render cargo built (any profile; ./target, CARGO_TARGET_DIR, the gate's). */
const targets = [process.env.CARGO_TARGET_DIR, path.resolve('target'), path.join(os.homedir(), '.cache/morfa-target/gate')].filter((dir): dir is string => !!dir);
const binary = (process.env.MORFA_RENDER_BIN ? [process.env.MORFA_RENDER_BIN] : targets.flatMap(dir => ['service', 'release', 'debug'].map(profile => path.join(dir, profile, 'morfa-render'))))
  .filter(file => existsSync(file))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const haveFonts = existsSync(path.resolve('public/fonts/inter'));

const jpegPhoto = () => sharp({create: {width: 320, height: 240, channels: 3, background: {r: 30, g: 120, b: 200}}}).jpeg({quality: 90}).toBuffer();
const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as {port: number}).port)));

test('rasters through the render service (DESIGN_RASTER_ENGINE=service)', {timeout: 300000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const keys = ['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN', 'DESIGN_PDF_ENGINE', 'DESIGN_RASTER_ENGINE', 'DESIGN_RENDER_URL', 'DESIGN_RENDER_SECRET', 'DESIGN_PDF_RENDER_MS', 'DESIGN_THUMBNAIL_DELAY_MS', 'DESIGN_COLLAB_INTERNAL_SECRET'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of ['APP_ORIGIN', 'DESIGN_TOOL_ACCOUNTS', 'DESIGN_PDF_ENGINE', 'DESIGN_PDF_RENDER_MS']) delete process.env[key];
  const secret = randomBytes(16).toString('hex');
  process.env.ENABLE_DESIGN_TOOL = '1';
  process.env.DESIGN_RASTER_ENGINE = 'service';
  process.env.DESIGN_RENDER_SECRET = secret;
  // The server's thumbnails follow a write quickly here; collab's checkpoint notice carries this secret.
  process.env.DESIGN_THUMBNAIL_DELAY_MS = '150';
  const collabSecret = randomBytes(16).toString('hex');
  process.env.DESIGN_COLLAB_INTERNAL_SECRET = collabSecret;
  const auth = await import('../server/auth');
  const {app, drainAppTasks} = await import('../server/app');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function account(label: string): Promise<Account> {
    const id = `design-raster-service:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, `${label}-${randomUUID()}@example.invalid`]);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token};
  }
  async function fetchAs(who: Account, url: string, init: RequestInit & {json?: unknown} = {}): Promise<Answer> {
    const {json, ...rest} = init;
    const headers: Record<string, string> = {cookie: auth.authCookieName('session') + '=' + who.token, ...(json !== undefined ? {'content-type': 'application/json'} : {})};
    const response = await fetch(base + url, {...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const type = response.headers.get('content-type');
    const raw = Buffer.from(await response.arrayBuffer());
    return {status: response.status, data: type?.includes('json') ? JSON.parse(raw.toString('utf8')) : raw, type, headers: response.headers};
  }
  const ok = (answer: Answer, status = 200) => {
    assert.equal(answer.status, status, answer.type?.includes('json') ? JSON.stringify(answer.data) : String(answer.status));
    return answer.data;
  };
  /** A 600 × 400 poster: Cyrillic text, a shadowed card, the account's own photo. */
  async function designer(label: string) {
    const who = await account(label);
    const created = ok(await fetchAs(who, '/api/design-files', {method: 'POST', json: {name: 'Mockup'}}), 201).file;
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(await jpegPhoto())], {type: 'image/jpeg'}), 'Photo.jpg');
    const picture = ok(await fetchAs(who, `/api/design-files/${created.id}/images`, {method: 'POST', body: form})) as {ref: string; asset: {url: string; width: number; height: number}};
    const doc = createDocument('page');
    const add = (node: SceneNode) => {
      doc.nodes[node.id] = node;
      const parent = doc.nodes[node.parentId!];
      parent.children = [...(parent.children ?? []), node.id];
    };
    add(createNode('FRAME', {id: 'poster', parentId: 'page', x: 0, y: 0, width: 600, height: 400, fills: [solid({r: 1, g: 1, b: 1})]}));
    const title = createNode('TEXT', {id: 'title', parentId: 'poster', x: 40, y: 40, width: 400, height: 60});
    // Cyrillic and Latin on purpose: glyph coverage of the embedded fonts.
    title.text = {...defaultTextProps('Привет, мир — Hello'), textAutoResize: 'NONE', style: {...defaultTextProps().style, fontSize: 32, fontWeight: 700}};
    add(title);
    const card = createNode('RECTANGLE', {id: 'card', parentId: 'poster', x: 40, y: 140, width: 240, height: 160, cornerRadius: 16, fills: [solid({r: 1, g: 1, b: 1})]});
    card.effects = [{type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y: 8}, radius: 24, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: false}];
    add(card);
    const photo = createNode('RECTANGLE', {id: 'photo', parentId: 'poster', x: 320, y: 140, width: 240, height: 180});
    photo.fills = [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}];
    doc.images[picture.ref] = picture.asset;
    add(photo);
    const opened = ok(await fetchAs(who, '/api/design-files/' + created.id));
    const stored = ok(await fetchAs(who, `/api/design-files/${created.id}/document`, {method: 'PUT', json: {baseVersion: opened.file.version, document: doc}}));
    return {who, id: created.id as string, version: stored.version as number};
  }
  const exportRaster = (who: Account, id: string, body: unknown) => fetchAs(who, `/api/design-files/${id}/export/raster`, {method: 'POST', json: body});

  await t.test('the real service paints the frame: its exact box at the scale, JPEG and WebP too', {skip: !binary ? 'cargo build -p morfa-render-service first' : !haveFonts ? 'npm run fonts first' : false}, async () => {
    const probe = createServer();
    const port = await listen(probe);
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const addr = `127.0.0.1:${port}`;
    const child = spawn(binary!, [], {
      env: {...process.env, MORFA_RENDER_ADDR: addr, MORFA_RENDER_INTERNAL_SECRET: secret, MORFA_RENDER_FONTS_DIR: path.resolve('public/fonts'), MORFA_RENDER_WORKERS: '2', RUST_LOG: 'info'},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let log = '';
    child.stdout!.on('data', chunk => (log += String(chunk)));
    child.stderr!.on('data', chunk => (log += String(chunk)));
    let up = false;
    for (let i = 0; i < 300 && !up && child.exitCode === null; i++) {
      up = await fetch(`http://${addr}/healthz`).then(r => r.ok, () => false);
      if (!up) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(up, 'morfa-render did not start: ' + log);
    process.env.DESIGN_RENDER_URL = 'http://' + addr;
    const health = await (await fetch(process.env.DESIGN_RENDER_URL + '/healthz')).json();
    assert.equal(health.raster, true, 'the service carries the renderer');
    const config = ok(await fetchAs((await designer('config')).who, '/api/config'));
    assert.equal(config.designRaster, true);

    const {who, id, version} = await designer('real');
    const png = await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'png', scale: 2});
    assert.equal(png.status, 200, JSON.stringify(png.data) + '\n' + log);
    assert.equal(png.headers.get('content-type'), 'image/png');
    assert.equal(png.headers.get('x-design-raster-engine'), 'service');
    const meta = await sharp(png.data as Buffer).metadata();
    assert.deepEqual([meta.width, meta.height], [1200, 800], 'the frame\'s box at scale 2, shadows cut at its edge');
    const {data, info} = await sharp(png.data as Buffer).raw().toBuffer({resolveWithObject: true});
    // The photo (blue) at its place, the white frame elsewhere.
    const px = (x: number, y: number) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 3)];
    assert.ok(px(880, 460)[2] > 150 && px(880, 460)[0] < 90, `the photo: ${px(880, 460)}`);
    assert.deepEqual(px(1100, 60), [255, 255, 255]);

    const jpeg = await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'jpeg', scale: 0.5, quality: 80});
    assert.equal(jpeg.status, 200, JSON.stringify(jpeg.data));
    assert.equal(jpeg.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual([...(jpeg.data as Buffer).subarray(0, 2)], [0xff, 0xd8]);
    const webp = await exportRaster(who, id, {version, nodeIds: ['card', 'photo'], format: 'webp'});
    assert.equal(webp.status, 200, JSON.stringify(webp.data));
    assert.equal(webp.headers.get('content-type'), 'image/webp');
    // Two plain layers export what they paint: the card's shadow reaches below its box.
    const two = await sharp(webp.data as Buffer).metadata();
    assert.ok(two.width! >= 520 && two.height! > 180, `${two.width}×${two.height}`);

    const stale = await exportRaster(who, id, {version: version + 1, nodeIds: ['poster'], format: 'png'});
    assert.deepEqual([stale.status, stale.data.code], [409, 'version_conflict']);
    const metrics = await (await fetch(process.env.DESIGN_RENDER_URL + '/metrics')).text();
    assert.match(metrics, /morfa_render_jobs_total\{kind="png",outcome="ok"\} 1/);

    // The file card's picture, made on the server after the save (server/design/thumbnails.ts): a WebP within 480 px.
    const thumbnailUrl = async () => {
      for (let i = 0; i < 100; i++) {
        const url = ok(await fetchAs(who, '/api/design-files/' + id)).file.thumbnailUrl as string | null;
        if (url) return url;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error('no thumbnail after 10 s: ' + log);
    };
    const first = await thumbnailUrl();
    const picture = await fetchAs(who, first);
    assert.equal(picture.status, 200);
    const thumb = await sharp(picture.data as Buffer).metadata();
    assert.equal(thumb.format, 'webp');
    assert.equal(Math.max(thumb.width!, thumb.height!), 480, `${thumb.width}×${thumb.height}`);
    // Collab's checkpoint notice (POST /internal/design-files/:id/checkpoint, the collab secret): a fresh picture replaces it.
    const notice = await fetch(base + `/internal/design-files/${id}/checkpoint`, {method: 'POST', headers: {authorization: `Bearer ${collabSecret}`, 'content-type': 'application/json'}, body: JSON.stringify({version})});
    assert.deepEqual([notice.status, await notice.json()], [200, {thumbnail: true}]);
    let second = first;
    for (let i = 0; i < 100 && second === first; i++) {
      await new Promise(resolve => setTimeout(resolve, 100));
      second = ok(await fetchAs(who, '/api/design-files/' + id)).file.thumbnailUrl;
    }
    assert.notEqual(second, first, 'the checkpoint notice made a new picture');
    assert.equal((await fetchAs(who, first)).status, 404, 'the previous picture is gone');
    const refused = await fetch(base + `/internal/design-files/${id}/checkpoint`, {method: 'POST', headers: {authorization: 'Bearer wrong'}});
    assert.equal(refused.status, 403);
  });

  await t.test('what the api sends, and how it maps the service\'s refusals', async () => {
    let answer: {status: number; body: unknown} = {status: 413, body: {code: 'design_pdf_too_large', error: 'The picture is too large.'}};
    let seen: {authorization?: string; body: Buffer} | null = null;
    const stand = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        seen = {authorization: req.headers.authorization, body: Buffer.concat(chunks)};
        res.writeHead(answer.status, {'content-type': 'application/json'}).end(JSON.stringify(answer.body));
      });
    });
    const port = await listen(stand);
    t.after(() => new Promise<void>(resolve => stand.close(() => resolve())));
    process.env.DESIGN_RENDER_URL = `http://127.0.0.1:${port}`;

    const {who, id, version} = await designer('stand-in');
    const tooLarge = await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'jpeg', scale: 3, quality: 70});
    assert.deepEqual([tooLarge.status, tooLarge.data.code, tooLarge.data.error], [413, 'design_raster_too_large', 'The picture is too large.']);
    assert.equal(seen!.authorization, `Bearer ${secret}`);
    const sent = seen!.body;
    assert.equal(sent.subarray(0, 4).toString(), 'MRR1');
    const headerLength = sent.readUInt32LE(4);
    const header = JSON.parse(sent.subarray(8, 8 + headerLength).toString('utf8'));
    assert.equal(header.kind, 'jpeg');
    assert.equal(header.account, who.id);
    assert.deepEqual([header.ids, header.scale, header.quality, header.measure], [['poster'], 3, 70, 'fonts']);
    assert.ok(header.fonts.some((face: {family: string; file: string}) => face.family === 'Inter' && face.file.startsWith('inter/')));
    assert.equal(header.pictures.length, 1);
    const documentLength = sent.readUInt32LE(8 + headerLength);
    const picture = sent.subarray(12 + headerLength + documentLength);
    assert.equal(picture.length, header.pictures[0].length);
    assert.deepEqual([...picture.subarray(0, 2)], [0xff, 0xd8], 'the stored JPEG itself');

    answer = {status: 429, body: {code: 'design_pdf_busy', error: ''}};
    assert.deepEqual((({status, data}) => [status, data.code])(await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'png'})), [429, 'design_raster_busy']);
    answer = {status: 504, body: {code: 'design_pdf_timeout', error: ''}};
    assert.deepEqual((({status, data}) => [status, data.code])(await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'png'})), [504, 'design_raster_timeout']);
    // A document the service cannot draw: the editor paints it.
    answer = {status: 422, body: {code: 'render_unsupported', error: 'model: …'}};
    assert.deepEqual((({status, data}) => [status, data.code])(await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'png'})), [503, 'design_raster_unavailable']);
    // Bad input.
    const bad = await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'gif'});
    assert.equal(bad.status, 400);
  });

  await t.test('a service that does not answer, and the switch off', async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise<void>(resolve => closed.close(() => resolve()));
    process.env.DESIGN_RENDER_URL = `http://127.0.0.1:${port}`;
    const {who, id, version} = await designer('down');
    const down = await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'png'});
    assert.deepEqual([down.status, down.data.code], [503, 'design_raster_unavailable']);
    process.env.DESIGN_RASTER_ENGINE = 'browser';
    const off = await exportRaster(who, id, {version, nodeIds: ['poster'], format: 'png'});
    assert.deepEqual([off.status, off.data.code], [404, 'design_raster_unavailable']);
    assert.equal(ok(await fetchAs(who, '/api/config')).designRaster, false);
    process.env.DESIGN_RASTER_ENGINE = 'service';
  });
});
