import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {inflateSync} from 'node:zlib';
import {request as httpRequest, type Server} from 'node:http';
import sharp from 'sharp';
import {chromium} from 'playwright-core';
import {createPostgresqlRuntimeFixture} from './helpers/postgresql-runtime';
import {budget} from './helpers/speed';
import {createDocument, createNode, defaultTextProps, solid} from '../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../shared/design/types';
import type {TextMeasurer} from '../shared/design/text-layout';
import {PDF_EXPORT_LIMITS, pdfPagePlan, pdfPageSvg, recordMeasurements, type PdfMeasurements} from '../shared/design/pdf-export';

// "Morfa Design" vector PDF (docs/design-tool.md §Export): POST /api/design-files/:id/export/pdf through the whole app
// against the real PostgreSQL schema: the switch, the session, roles, the limits, the version the editor measured, the
// pictures a caller may read, and — where this machine can start the sandboxed Chromium — the PDF itself: one page per
// frame at the frame's exact size in points, real text in embedded fonts, vector paths, the picture's own JPEG bytes.

type Account = {id: string; token: string};
type Answer = {status: number; data: any; type: string | null; headers: Headers};

// The browser starts only where Chromium's sandbox can (not as root without it).
const printable = await chromium
  .launch({headless: true, chromiumSandbox: true, timeout: 15000, ...(process.env.IMPORT_CHROMIUM_PATH ? {executablePath: process.env.IMPORT_CHROMIUM_PATH} : {})})
  .then(browser => browser.close().then(() => true), () => false);

/** The editor's measurer stand-in: fixed advances, so the server's replay must reproduce them exactly. */
const measurer: TextMeasurer = {
  width: (text, font) => [...text].length * font.size * 0.55,
  metrics: font => ({ascent: font.size * 0.9, descent: font.size * 0.25}),
};

/** What the editor sends: its own export of the pages, measured. */
function measure(doc: DesignDocument, ids: string[]): PdfMeasurements {
  const recorder = recordMeasurements(measurer);
  ids.forEach((id, index) => {
    const plan = pdfPagePlan(doc, id);
    if (plan) pdfPageSvg(doc, plan, index, {measurer: recorder.measurer});
  });
  return recorder.table();
}

const jpegPhoto = () =>
  sharp({create: {width: 640, height: 480, channels: 3, background: {r: 30, g: 120, b: 200}}})
    .composite([{input: Buffer.from('<svg width="640" height="480"><circle cx="320" cy="240" r="180" fill="#f2c94c"/></svg>'), top: 0, left: 0}])
    .jpeg({quality: 90})
    .toBuffer();

/** Objects of a PDF: its streams inflated, so tests can look for operators and resources. */
function pdfParts(pdf: Buffer) {
  const text = pdf.toString('latin1');
  const streams: string[] = [];
  const pattern = /<<((?:[^<>]|<<[^>]*>>)*?)>>\s*stream\r?\n/g;
  for (let match; (match = pattern.exec(text)); ) {
    const length = Number(/\/Length (\d+)/.exec(match[1])?.[1] ?? -1);
    if (length < 0) continue;
    const start = match.index + match[0].length;
    const bytes = pdf.subarray(start, start + length);
    if (/\/FlateDecode/.test(match[1]) && !/\/Subtype \/Image/.test(match[1])) {
      try {
        streams.push(inflateSync(bytes).toString('latin1'));
      } catch {
        // A font program or an image: not a content stream.
      }
    }
  }
  return {text, streams};
}

test('"Morfa Design" vector PDF export: the route, its limits and the printed file', {timeout: 600000}, async t => {
  const f = await createPostgresqlRuntimeFixture(t, {bindRuntime: true}),
    db = f.runtime;
  const saved = Object.fromEntries(['ENABLE_DESIGN_TOOL', 'DESIGN_TOOL_ACCOUNTS', 'APP_ORIGIN', 'ENABLE_DESIGN_PDF_EXPORT', 'DESIGN_PDF_RENDER_MS'].map(key => [key, process.env[key]]));
  delete process.env.APP_ORIGIN;
  delete process.env.DESIGN_TOOL_ACCOUNTS;
  delete process.env.ENABLE_DESIGN_PDF_EXPORT;
  delete process.env.DESIGN_PDF_RENDER_MS;
  process.env.ENABLE_DESIGN_TOOL = '1';
  const auth = await import('../server/auth');
  const {app, drainAppTasks} = await import('../server/app');
  const {closePdfBrowser} = await import('../server/design/pdf/browser');
  const {pageBoxes} = await import('../server/design/pdf/page-boxes');
  const server: Server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const port = (server.address() as {port: number}).port;
  const base = 'http://127.0.0.1:' + port;
  t.after(async () => {
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
    const id = `design-pdf:${label}:${randomUUID()}`,
      token = randomUUID();
    await db.execute("INSERT INTO users(id,email,name,password) VALUES($1,$2,'Designer','')", [id, `${label}-${randomUUID()}@example.invalid`]);
    await db.execute('INSERT INTO sessions(token,user_id,expires) VALUES($1,$2,$3)', [auth.digest(token), id, Date.now() + 3_600_000]);
    return {id, token};
  }
  const cookie = (who: Account) => auth.authCookieName('session') + '=' + who.token;
  async function fetchAs(who: Account | null, url: string, init: RequestInit & {json?: unknown} = {}): Promise<Answer> {
    const {json, ...rest} = init;
    const headers: Record<string, string> = {...(who ? {cookie: cookie(who)} : {}), ...(json !== undefined ? {'content-type': 'application/json'} : {}), ...(rest.headers as Record<string, string>)};
    const response = await fetch(base + url, {...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body});
    const type = response.headers.get('content-type');
    const raw = Buffer.from(await response.arrayBuffer());
    return {status: response.status, data: type?.includes('json') ? JSON.parse(raw.toString('utf8')) : raw, type, headers: response.headers};
  }
  const files = (who: Account | null, suffix: string, init: RequestInit & {json?: unknown} = {}) => fetchAs(who, '/api/design-files' + suffix, init);
  const ok = (answer: Answer, status = 200) => {
    assert.equal(answer.status, status, answer.type?.includes('json') ? JSON.stringify(answer.data) : String(answer.status));
    return answer.data;
  };
  const upload = async (who: Account, id: string, data: Buffer, type = 'image/jpeg') => {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], {type}), 'Photo.jpg');
    return ok(await files(who, `/${id}/images`, {method: 'POST', body: form})) as {ref: string; asset: {url: string; width: number; height: number}};
  };
  /** A file holding `doc` (pictures uploaded first, their refs in `doc.images`): its id and version. */
  async function fileWith(who: Account, make: (picture: {ref: string; asset: {url: string; width: number; height: number}} | null) => DesignDocument, options: {picture?: boolean; teamId?: string} = {}) {
    const created = ok(await files(who, '', {method: 'POST', json: {name: 'Mockup', ...(options.teamId ? {teamId: options.teamId} : {})}}), 201).file;
    const picture = options.picture ? await upload(who, created.id, await jpegPhoto()) : null;
    const opened = ok(await files(who, '/' + created.id));
    const saved = ok(await files(who, `/${created.id}/document`, {method: 'PUT', json: {baseVersion: opened.file.version, document: make(picture)}}));
    return {id: created.id as string, version: saved.version as number};
  }
  const exportPdf = (who: Account | null, id: string, body: unknown) => files(who, `/${id}/export/pdf`, {method: 'POST', json: body});

  /** Two frames: a poster with text, a rectangle with the photo and a shadowed card; a 375.5 × 812.25 phone screen. */
  function poster(picture: {ref: string; asset: {url: string; width: number; height: number}} | null): DesignDocument {
    const doc = createDocument('page');
    const add = (node: SceneNode) => {
      doc.nodes[node.id] = node;
      const parent = doc.nodes[node.parentId!];
      parent.children = [...(parent.children ?? []), node.id];
    };
    add(createNode('FRAME', {id: 'poster', name: 'Poster', parentId: 'page', x: 0, y: 0, width: 600, height: 400}));
    const title = createNode('TEXT', {id: 'title', parentId: 'poster', x: 40, y: 40, width: 400, height: 60, fills: [solid({r: 0.1, g: 0.1, b: 0.1})]});
    // Cyrillic and Latin on purpose: glyph coverage of the embedded fonts.
    title.text = {...defaultTextProps('Привет, мир — Hello'), textAutoResize: 'NONE', style: {...defaultTextProps().style, fontSize: 32, fontWeight: 700}};
    add(title);
    const card = createNode('RECTANGLE', {id: 'card', parentId: 'poster', x: 40, y: 140, width: 240, height: 160, cornerRadius: 16, fills: [solid({r: 1, g: 1, b: 1})]});
    card.effects = [{type: 'DROP_SHADOW', visible: true, color: {r: 0, g: 0, b: 0, a: 0.25}, offset: {x: 0, y: 8}, radius: 24, spread: 0, blendMode: 'NORMAL', showShadowBehindNode: false}];
    add(card);
    const photo = createNode('RECTANGLE', {id: 'photo', parentId: 'poster', x: 320, y: 140, width: 240, height: 180, cornerRadius: 12});
    if (picture) {
      photo.fills = [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}];
      doc.images[picture.ref] = picture.asset;
    }
    add(photo);
    add(createNode('FRAME', {id: 'phone', name: 'Screen', parentId: 'page', x: 700, y: 0, width: 375.5, height: 812.25, fills: [solid({r: 0.95, g: 0.95, b: 1})]}));
    const label = createNode('TEXT', {id: 'label', parentId: 'phone', x: 20, y: 40, width: 300, height: 30});
    label.text = {...defaultTextProps('Экран телефона'), textAutoResize: 'NONE', style: {...defaultTextProps().style, fontFamily: 'Montserrat', fontSize: 20, fontWeight: 600}};
    add(label);
    return doc;
  }

  const outsider = await account('outsider');
  const pages = ['poster', 'phone'];
  /** An account of its own (each test stays inside the limit of ten exports a minute) with the poster file. */
  async function designer(label: string) {
    const who = await account(label);
    const file = await fileWith(who, poster, {picture: true});
    const stored = ok(await files(who, '/' + file.id)).document as DesignDocument;
    return {who, file, body: {version: file.version, nodeIds: pages, title: 'Poster', measurements: measure(stored, pages)}};
  }

  await t.test('the switch: off, the route is 404 and /api/config says no; the design tool off hides it too', async () => {
    const {who: owner, file, body: request} = await designer('switch');
    assert.equal(ok(await fetchAs(owner, '/api/config')).designPdf, true, 'on with the design tool by default');
    process.env.ENABLE_DESIGN_PDF_EXPORT = '0';
    try {
      const off = await exportPdf(owner, file.id, request);
      assert.deepEqual([off.status, off.data.code], [404, 'design_pdf_unavailable']);
      assert.equal(ok(await fetchAs(owner, '/api/config')).designPdf, false);
    } finally {
      delete process.env.ENABLE_DESIGN_PDF_EXPORT;
    }
    process.env.ENABLE_DESIGN_TOOL = '0';
    try {
      assert.equal((await exportPdf(owner, file.id, request)).data.code, 'design_unavailable');
      assert.equal(ok(await fetchAs(owner, '/api/config')).designPdf, false);
    } finally {
      process.env.ENABLE_DESIGN_TOOL = '1';
    }
  });

  await t.test('who may export: a session, the file\'s own account; another account sees no file', async () => {
    const {who: owner, file, body: request} = await designer('who');
    assert.equal((await exportPdf(null, file.id, request)).status, 401);
    const foreign = await exportPdf(outsider, file.id, request);
    assert.deepEqual([foreign.status, foreign.data.code], [404, 'not_found']);
    const wrongTab = await files(owner, `/${file.id}/export/pdf`, {method: 'POST', json: request, headers: {'x-forma-account': outsider.id}});
    assert.equal(wrongTab.status, 409, 'a tab of another account is stopped before anything is read');
  });

  await t.test('what the body may hold: the version the editor measured, known layers, at most 50 pages, numbers only', async () => {
    const {who: owner, file, body: request} = await designer('body');
    const stale = await exportPdf(owner, file.id, {...request, version: file.version - 1});
    assert.deepEqual([stale.status, stale.data.code, stale.data.currentVersion], [409, 'version_conflict', file.version]);
    const unknown = await exportPdf(owner, file.id, {...request, nodeIds: ['nope']});
    assert.deepEqual([unknown.status, unknown.data.code], [400, 'invalid_request']);
    const pageNode = await exportPdf(owner, file.id, {...request, nodeIds: ['page']});
    assert.equal(pageNode.status, 400, 'a page is not a frame');
    const many = await exportPdf(owner, file.id, {...request, nodeIds: Array.from({length: PDF_EXPORT_LIMITS.pages + 1}, (_, i) => 'n' + i)});
    assert.deepEqual([many.status, many.data.code], [413, 'design_pdf_too_large']);
    for (const measurements of [undefined, {fonts: 'x', widths: []}, {fonts: [['Inter', 400, 0, 16, 1, 1]], widths: [[5, 'a', 1]]}, {fonts: [['Inter', 400, 2, 16, 1, 1]], widths: []}, {fonts: [], widths: [[0, 'x'.repeat(PDF_EXPORT_LIMITS.textLength + 1), 1]]}]) {
      const answer = await exportPdf(owner, file.id, {...request, measurements});
      assert.equal(answer.status, 400, JSON.stringify(measurements)?.slice(0, 80));
    }
    const markup = await exportPdf(owner, file.id, {...request, svg: '<svg/>'});
    assert.equal(markup.status, 400, 'no field carries markup');
  });

  await t.test('shadows and blurs over too large an area are refused before anything is printed', async () => {
    const owner = await account('effects');
    const huge = await fileWith(owner, () => {
      const doc = createDocument('page');
      const frame = createNode('FRAME', {id: 'huge', parentId: 'page', width: 6000, height: 6000});
      frame.effects = [{type: 'LAYER_BLUR', visible: true, radius: 20}];
      doc.nodes.huge = frame;
      doc.nodes.page.children = ['huge'];
      return doc;
    });
    const answer = await exportPdf(owner, huge.id, {version: huge.version, nodeIds: ['huge'], measurements: {fonts: [], widths: []}});
    assert.deepEqual([answer.status, answer.data.code], [413, 'design_pdf_too_large']);
  });

  await t.test('a picture of another account is refused, never printed', async () => {
    const owner = await account('picture');
    const other = await account('other');
    const theirs = await fileWith(other, () => createDocument('page'));
    const picture = await upload(other, theirs.id, await jpegPhoto());
    const mine = await fileWith(owner, () => {
      const doc = createDocument('page');
      doc.nodes.frame = createNode('FRAME', {id: 'frame', parentId: 'page', width: 200, height: 200});
      doc.nodes.page.children = ['frame'];
      return doc;
    });
    // Only a document written around the API's own checks can point at it (the files API refuses it with 403).
    const doc = ok(await files(owner, '/' + mine.id)).document as DesignDocument;
    doc.images[picture.ref] = picture.asset;
    doc.nodes.frame.fills = [{type: 'IMAGE', imageRef: picture.ref, scaleMode: 'FILL', opacity: 1, visible: true, blendMode: 'NORMAL'}];
    // A new version, as a write would make: the parsed copy autosave keeps belongs to the old one.
    await db.execute('UPDATE design_files SET document=$2, version=version+1 WHERE id=$1', [mine.id, JSON.stringify(doc)]);
    const answer = await exportPdf(owner, mine.id, {version: mine.version + 1, nodeIds: ['frame'], measurements: {fonts: [], widths: []}});
    assert.deepEqual([answer.status, answer.data.code, answer.data.error], [403, 'design_document_invalid', 'The image is not available to this account. Upload your own copy.']);
  });

  await t.test('ten exports a minute per account; one at a time per account', async () => {
    const busy = await account('busy');
    const small = await fileWith(busy, () => createDocument('page'));
    // The account's place is taken before the body arrives: a slow sender holds it, a second export is told to wait.
    const slow = httpRequest(`${base}/api/design-files/${small.id}/export/pdf`, {method: 'POST', headers: {cookie: cookie(busy), 'content-type': 'application/json', 'content-length': '200'}});
    const finished = new Promise<number>(resolve => slow.on('response', response => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }));
    slow.on('error', () => undefined);
    slow.write('{"version":');
    await new Promise(resolve => setTimeout(resolve, 200));
    const second = await exportPdf(busy, small.id, {version: small.version - 1, nodeIds: ['x'], measurements: {fonts: [], widths: []}});
    assert.deepEqual([second.status, second.data.code, second.data.error], [429, 'rate_limited', 'This account\'s PDF is still being built. Wait for it.']);
    slow.end(`${small.version - 1},"nodeIds":["x"],"measurements":{"fonts":[],"widths":[]}}`.padEnd(189, ' '));
    assert.equal(await finished, 409);
    // Eight more fit in the minute (the two above counted), the eleventh does not.
    for (let n = 0; n < 8; n++) assert.equal((await exportPdf(busy, small.id, {version: small.version - 1, nodeIds: ['x'], measurements: {fonts: [], widths: []}})).status, 409);
    const limited = await exportPdf(busy, small.id, {version: small.version, nodeIds: ['x'], measurements: {fonts: [], widths: []}});
    assert.deepEqual([limited.status, limited.data.code, limited.data.error], [429, 'rate_limited', 'Too many PDFs in a row. Wait a minute.']);
  });

  await t.test('a team\'s viewers and developers export its files; people outside the team do not', async () => {
    const owner = await account('team-owner');
    const team = ok(await fetchAs(owner, '/api/design-teams', {method: 'POST', json: {name: 'Studio'}}), 201).team;
    const viewer = await account('viewer'),
      developer = await account('developer');
    for (const [who, role] of [[viewer, 'viewer'], [developer, 'developer']] as const) {
      const link = ok(await fetchAs(owner, `/api/design-teams/${team.id}/invites`, {method: 'POST', json: {role, days: 7, maxUses: 1}}), 201);
      ok(await fetchAs(who, `/api/design-teams/invites/${link.token}/accept`, {method: 'POST'}));
    }
    const shared = await fileWith(owner, poster, {picture: true, teamId: team.id});
    const doc = ok(await files(owner, '/' + shared.id)).document as DesignDocument;
    const body = {version: shared.version, nodeIds: ['poster'], measurements: measure(doc, ['poster'])};
    for (const who of [viewer, developer]) {
      const answer = await exportPdf(who, shared.id, body);
      if (printable) {
        assert.equal(answer.status, 200, JSON.stringify(answer.type?.includes('json') ? answer.data : answer.status));
        assert.equal(answer.type, 'application/pdf');
      } else assert.deepEqual([answer.status, answer.data.code], [503, 'design_pdf_unavailable'], 'no sandbox here: the honest answer');
    }
    assert.equal((await exportPdf(outsider, shared.id, body)).status, 404);
  });

  await t.test('the printed file: a page per frame at the frame\'s size, real text, vector shapes, the photo\'s own bytes', {skip: printable ? false : 'Chromium\'s sandbox cannot start on this machine'}, async () => {
    const {who: owner, file, body: request} = await designer('print');
    const started = performance.now();
    const answer = await exportPdf(owner, file.id, request);
    assert.equal(answer.status, 200, answer.type?.includes('json') ? JSON.stringify(answer.data) : '');
    const elapsed = performance.now() - started;
    assert.ok(elapsed < budget(15_000), `printed in ${Math.round(elapsed)} ms`);
    assert.deepEqual([answer.type, answer.headers.get('cache-control'), answer.headers.get('x-design-pdf-pages'), answer.headers.get('x-design-pdf-unmeasured')], ['application/pdf', 'no-store', '2', '0']);
    const pdf = answer.data as Buffer;
    if (process.env.DESIGN_PDF_EVIDENCE_DIR) {
      mkdirSync(process.env.DESIGN_PDF_EVIDENCE_DIR, {recursive: true});
      writeFileSync(path.join(process.env.DESIGN_PDF_EVIDENCE_DIR, 'runtime-export.pdf'), pdf);
    }
    assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
    // 1 px = 1 pt, exactly, whatever Chromium's print grid.
    const boxes = pageBoxes(pdf)!;
    assert.equal(boxes.length, 2);
    const size = (box: number[]) => [Math.round((box[2] - box[0]) * 1000) / 1000, Math.round((box[3] - box[1]) * 1000) / 1000];
    assert.deepEqual(boxes.map(size), [[600, 400], [375.5, 812.25]]);
    const {text, streams} = pdfParts(pdf);
    assert.match(text, /\/Title /, 'the title is set');
    assert.match(text, /\/Type \/Font/, 'fonts are embedded');
    assert.match(text, /\/FontFile2|\/Subtype \/Type3/, 'as font programs or glyph outlines');
    assert.match(text, /\/Subtype \/Image[\s\S]{0,400}?\/Filter \/DCTDecode|\/Filter \/DCTDecode[\s\S]{0,400}?\/Subtype \/Image/, 'the JPEG goes in as JPEG');
    const ops = streams.join('\n');
    assert.match(ops, /\bBT\b[\s\S]*?\bTj\b|\bTJ\b/, 'text is drawn as text');
    assert.match(ops, /\b(re|c|l)\b/, 'shapes are paths');
    const images = (text.match(/\/Subtype \/Image/g) ?? []).length;
    assert.ok(images <= 4, `${images} images: the photo, the shadow raster and their masks, not a picture of the page`);
    const extracted = spawnSync('pdftotext', ['-', '-'], {input: pdf});
    if (!extracted.error && extracted.status === 0) {
      const words = extracted.stdout.toString('utf8');
      for (const word of ['Привет', 'Hello', 'Экран телефона']) assert.ok(words.includes(word), `"${word}" can be copied out of the PDF: ${JSON.stringify(words)}`);
    }
  });

  await t.test('a print that runs out of time is stopped and answered 504; the next one starts a fresh browser', {skip: printable ? false : 'Chromium\'s sandbox cannot start on this machine'}, async () => {
    const {who: owner, file, body: request} = await designer('timeout');
    process.env.DESIGN_PDF_RENDER_MS = '50';
    try {
      const late = await exportPdf(owner, file.id, request);
      assert.deepEqual([late.status, late.data.code], [504, 'design_pdf_timeout']);
    } finally {
      delete process.env.DESIGN_PDF_RENDER_MS;
    }
    const again = await exportPdf(owner, file.id, request);
    assert.equal(again.status, 200);
  });
});
