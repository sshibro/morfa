import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawn, type ChildProcess} from 'node:child_process';
import {existsSync, statSync} from 'node:fs';
import {createServer, type Server} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import {chromium} from 'playwright-core';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';

// The vector PDF through lane B4's render service (DESIGN_PDF_ENGINE=service, server/design/pdf/service.ts →
// crates/render-service): the whole app against the real PostgreSQL schema. With `morfa-render` built (cargo builds it
// with the workspace's tests), the real service writes the file; a stand-in service checks what the api sends and how
// it maps the service's refusals, and that a service that refuses a document or does not answer leaves the export to
// Chromium.

type Account = {id: string; token: string};
type Answer = {status: number; data: any; type: string | null; headers: Headers};

const printable = await chromium
  .launch({headless: true, chromiumSandbox: true, timeout: 15000, ...(process.env.IMPORT_CHROMIUM_PATH ? {executablePath: process.env.IMPORT_CHROMIUM_PATH} : {})})
  .then(browser => browser.close().then(() => true), () => false);

/** MORFA_RENDER_BIN, or the newest morfa-render cargo built (any profile; ./target, CARGO_TARGET_DIR, the gate's). */
const targets = [process.env.CARGO_TARGET_DIR, path.resolve('target'), path.join(os.homedir(), '.cache/morfa-target/gate')].filter((dir): dir is string => !!dir);
const binary = (process.env.MORFA_RENDER_BIN ? [process.env.MORFA_RENDER_BIN] : targets.flatMap(dir => ['service', 'release', 'debug'].map(profile => path.join(dir, profile, 'morfa-render'))))
  .filter(file => existsSync(file))
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
const haveFonts = existsSync(path.resolve('public/fonts/inter'));

const jpegPhoto = () => sharp({create: {width: 320, height: 240, channels: 3, background: {r: 30, g: 120, b: 200}}}).jpeg({quality: 90}).toBuffer();

const listen = (server: Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as {port: number}).port)));

test('vector PDF through the render service (DESIGN_PDF_ENGINE=service)', {timeout: 300000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const keys = ['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN', 'ENABLE_DESIGN_PDF_EXPORT', 'DESIGN_PDF_ENGINE', 'DESIGN_RENDER_URL', 'DESIGN_RENDER_SECRET', 'DESIGN_PDF_RENDER_MS'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of ['APP_ORIGIN', 'DESIGN_TOOL_ACCOUNTS', 'ENABLE_DESIGN_PDF_EXPORT', 'DESIGN_PDF_RENDER_MS']) delete process.env[key];
  const secret = randomBytes(16).toString('hex');
  process.env.ENABLE_DESIGN_TOOL = '1';
  process.env.DESIGN_PDF_ENGINE = 'service';
  process.env.DESIGN_RENDER_SECRET = secret;
  const auth = await import('../server/auth');
  const {app, drainAppTasks} = await import('../server/app');
  const {closePdfBrowser} = await import('../server/design/pdf/browser');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as {port: number}).port;
  const children: ChildProcess[] = [];
  t.after(async () => {
    for (const child of children) child.kill('SIGKILL');
    await closePdfBrowser();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await drainAppTasks().catch(() => undefined);
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function account(label: string): Promise<Account> {
    const id = `design-pdf-service:${label}:${randomUUID()}`,
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
  /** A poster (Cyrillic text, a shadowed card, the account's own photo) and a 375.5 × 812.25 screen. */
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
    add(createNode('FRAME', {id: 'phone', parentId: 'page', x: 700, y: 0, width: 375.5, height: 812.25, fills: [solid({r: 0.95, g: 0.95, b: 1})]}));
    const opened = ok(await fetchAs(who, '/api/design-files/' + created.id));
    const stored = ok(await fetchAs(who, `/api/design-files/${created.id}/document`, {method: 'PUT', json: {baseVersion: opened.file.version, document: doc}}));
    // No measurements: the service measures with its own fonts (lane L3's shaper).
    return {who, id: created.id as string, body: {version: stored.version, nodeIds: ['poster', 'phone'], title: 'Poster', measurements: {fonts: [], widths: []}}};
  }
  const exportPdf = (who: Account, id: string, body: unknown) => fetchAs(who, `/api/design-files/${id}/export/pdf`, {method: 'POST', json: body});

  await t.test('the real service writes the PDF: exact page sizes, embedded glyphs, the photo\'s own bytes', {skip: !binary ? 'cargo build -p morfa-render-service first' : !haveFonts ? 'npm run fonts first' : false}, async () => {
    // A free port (taken and released), then /healthz until the service answers; its log goes into any failure below.
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
    assert.equal(health.service, 'morfa-render');
    const {who, id, body} = await designer('real');
    const answer = await exportPdf(who, id, body);
    assert.equal(answer.status, 200, JSON.stringify(answer.data) + '\n' + log);
    const pdf = answer.data as Buffer;
    assert.equal(answer.headers.get('x-design-pdf-engine'), 'service');
    assert.equal(answer.headers.get('x-design-pdf-pages'), '2');
    const text = pdf.toString('latin1');
    assert.ok(text.startsWith('%PDF-1.7') && text.trimEnd().endsWith('%%EOF'));
    assert.deepEqual([...text.matchAll(/\/MediaBox \[([^\]]*)\]/g)].map(m => m[1]), ['0 0 600 400', '0 0 375.5 812.25']);
    assert.match(text, /\/Subtype \/Type3/, 'text as embedded glyphs');
    assert.match(text, /\/ToUnicode/, 'with a Unicode map (selectable)');
    assert.match(text, /\/Filter \/DCTDecode/, 'the photo as its own JPEG bytes');
    const metrics = await (await fetch(process.env.DESIGN_RENDER_URL + '/metrics')).text();
    assert.match(metrics, /morfa_render_jobs_total\{kind="pdf",outcome="ok"\} 1/);
  });

  await t.test('what the api sends, and how it maps the service\'s refusals', async () => {
    let answer: {status: number; body: unknown} = {status: 413, body: {code: 'design_pdf_too_large', error: 'Too many shadows.'}};
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

    const {who, id, body} = await designer('stand-in');
    const tooLarge = await exportPdf(who, id, body);
    assert.deepEqual([tooLarge.status, tooLarge.data.code, tooLarge.data.error], [413, 'design_pdf_too_large', 'Too many shadows.']);
    // The request: the secret, MRR1, the account, both pages, the service's own fonts, the photo's bytes.
    assert.equal(seen!.authorization, `Bearer ${secret}`);
    const sent = seen!.body;
    assert.equal(sent.subarray(0, 4).toString(), 'MRR1');
    const headerLength = sent.readUInt32LE(4);
    const header = JSON.parse(sent.subarray(8, 8 + headerLength).toString('utf8'));
    assert.equal(header.kind, 'pdf');
    assert.equal(header.account, who.id);
    assert.deepEqual(header.pages.map((p: {ids: string[]}) => p.ids[0]), ['poster', 'phone']);
    assert.equal(header.measure, 'fonts');
    assert.ok(header.fonts.some((face: {family: string; file: string}) => face.family === 'Inter' && face.file.startsWith('inter/')));
    assert.equal(header.pictures.length, 1);
    const documentLength = sent.readUInt32LE(8 + headerLength);
    const picture = sent.subarray(12 + headerLength + documentLength);
    assert.equal(picture.length, header.pictures[0].length);
    assert.deepEqual([...picture.subarray(0, 2)], [0xff, 0xd8], 'the stored JPEG itself');

    answer = {status: 429, body: {code: 'design_pdf_busy', error: ''}};
    const busy = await exportPdf(who, id, body);
    assert.deepEqual([busy.status, busy.data.code], [429, 'design_pdf_busy']);
    answer = {status: 504, body: {code: 'design_pdf_timeout', error: ''}};
    const late = await exportPdf(who, id, body);
    assert.deepEqual([late.status, late.data.code], [504, 'design_pdf_timeout']);

    // A document the service cannot write: Chromium prints it (or, where its sandbox cannot start, 503 as today).
    answer = {status: 422, body: {code: 'render_unsupported', error: 'model: …'}};
    const refused = await exportPdf(who, id, body);
    if (printable) {
      assert.equal(refused.status, 200);
      assert.equal(refused.headers.get('x-design-pdf-engine'), 'chromium');
    } else assert.deepEqual([refused.status, refused.data.code], [503, 'design_pdf_unavailable']);
  });

  await t.test('a service that does not answer leaves the export to Chromium', async () => {
    const closed = createServer();
    const port = await listen(closed);
    await new Promise<void>(resolve => closed.close(() => resolve()));
    process.env.DESIGN_RENDER_URL = `http://127.0.0.1:${port}`;
    const {who, id, body} = await designer('down');
    const answer = await exportPdf(who, id, body);
    if (printable) assert.equal(answer.headers.get('x-design-pdf-engine'), 'chromium');
    else assert.deepEqual([answer.status, answer.data.code], [503, 'design_pdf_unavailable']);
  });
});
