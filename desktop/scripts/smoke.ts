// The desktop app's smoke run (docs/desktop.md §Smoke run), driven by desktop/scripts/smoke.sh: the Linux build of the
// shell under tauri-driver (WebKitWebDriver) on a virtual display, pointed at the isolated e2e server. It checks what
// the lane promises end to end: the window loads the app, the name sign-in works, a file opens, a local font of this
// computer draws its text, "Save to computer" writes the portable file through the shell's save dialog, and a
// deep link opens a file in its own window.
//
// Plain W3C WebDriver over HTTP: no client library.
import assert from 'node:assert/strict';
import {mkdir, readFile, stat, writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createDocument, createNode, defaultTextProps, defaultTextStyle, solid} from '../../shared/design/defaults';
import type {DesignDocument} from '../../shared/design/types';
import {catalogueFamilies} from '../../src/design/engine/fonts';

const driver = process.env.SMOKE_DRIVER ?? 'http://127.0.0.1:4444';
const binary = process.env.SMOKE_BINARY!;
const savePath = process.env.MORFA_DESKTOP_SMOKE_SAVE!;
const appOrigin = process.env.MORFA_APP_ORIGIN!;
// SMOKE_OFFLINE=1: the app's server cannot be reached (a release build before production exists): only the offline page is checked.
const offline = process.env.SMOKE_OFFLINE === '1';
assert.ok(binary && (offline || (savePath && appOrigin)), 'run through desktop/scripts/smoke.sh');
const ELEMENT = 'element-6066-11e4-a52e-4f735466cecf';

async function wd<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(driver + path, {method, headers: {'content-type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body)});
  const json = (await response.json()) as {value: T & {error?: string; message?: string}};
  if (!response.ok) throw new Error(`${method} ${path}: ${json.value?.error} ${json.value?.message}`);
  return json.value;
}

const step = (text: string) => console.log(`smoke: ${text}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function until<T>(what: string, probe: () => Promise<T | null | undefined | false>, timeout = 60_000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await sleep(250);
  }
  throw new Error(`timed out: ${what}${last ? ` (${last})` : ''}`);
}

function textDocument(family: string): DesignDocument {
  const doc = createDocument('page', 'Smoke');
  const frame = createNode('FRAME', {id: 'frame', parentId: 'page', name: 'Frame', x: 0, y: 0, width: 600, height: 200, fills: [solid({r: 1, g: 1, b: 1})]});
  const text = createNode('TEXT', {
    id: 'local-text', parentId: 'frame', name: 'Local font', x: 24, y: 24, width: 552, height: 60, fills: [solid({r: 0.1, g: 0.1, b: 0.1})],
    text: {...defaultTextProps('Local font · The quick brown fox'), style: {...defaultTextStyle(), fontFamily: family, fontSize: 36, fontWeight: 400}, textAutoResize: 'NONE'},
  });
  return {...doc, nodes: {...doc.nodes, frame: {...frame, children: ['local-text']}, 'local-text': text, page: {...doc.nodes.page, children: ['frame']}}};
}

const session = await wd<{sessionId: string}>('POST', '/session', {capabilities: {alwaysMatch: {'tauri:options': {application: binary}}}});
const s = `/session/${session.sessionId}`;
const run = <T>(script: string, ...args: unknown[]) => wd<T>('POST', `${s}/execute/sync`, {script, args});
const runAsync = <T>(script: string, ...args: unknown[]) => wd<T>('POST', `${s}/execute/async`, {script, args});
const find = (xpath: string) => wd<Record<string, string>>('POST', `${s}/element`, {using: 'xpath', value: xpath}).then(element => element[ELEMENT]);
const click = (id: string) => wd('POST', `${s}/element/${id}/click`, {});

try {
  if (offline) {
    step('no server: the window shows the bundled offline page');
    const href = await until('the offline page', async () => {
      const url = await wd<string>('GET', `${s}/url`);
      return /^(tauri:\/\/localhost|https?:\/\/tauri\.localhost)\/index\.html/.test(url) && url;
    });
    const text = await until('its text', () => run<string>('return document.body.innerText;').then(body => body.includes('No connection to Morfa') && body));
    assert.ok(text.includes('Retry'));
    assert.equal(await run('return window.__MORFA_DESKTOP__ === undefined;'), true, 'the offline page gets no app marker');
    step(`PASS (${href})`);
    await wd('DELETE', s).catch(() => undefined);
    process.exit(0);
  }
  step('the window loads the app from ' + appOrigin);
  const url = await until('the app page', async () => {
    const href = await wd<string>('GET', `${s}/url`);
    return href.startsWith(appOrigin) && href;
  });
  assert.ok(url.startsWith(appOrigin), url);
  const marker = await until('the desktop marker', () => run<{version: string} | null>('return window.__MORFA_DESKTOP__ || null;'));
  assert.equal(typeof marker.version, 'string');

  step('signing in through the app’s own name entry form');
  const field = await until('the sign-in form', () => find("//input[@id=//label[normalize-space()='Your name']/@for]"));
  await wd('POST', `${s}/element/${field}/clear`, {});
  await wd('POST', `${s}/element/${field}/value`, {text: `Desktop smoke ${Date.now()}`});
  await click(await find("//button[normalize-space()='Continue']"));
  await until('the file browser', () => find("//button[normalize-space()='New file']"), 90_000);

  step('local fonts come from the shell');
  const local = await until('a local font list', () =>
    runAsync<{family: string; bytes: number}[] | null>(
      `const done = arguments[arguments.length - 1];
       if (typeof window.queryLocalFonts !== 'function' || !window.queryLocalFonts.morfaDesktop) return done(null);
       window.queryLocalFonts().then(async fonts => {
         const own = fonts.filter(font => font.morfaBytes);
         const first = own[0];
         done(first ? [{family: first.family, bytes: (await first.morfaBytes()).byteLength}, ...own.slice(1, 50).map(font => ({family: font.family, bytes: -1}))] : null);
       }, () => done(null));`));
  // A family the editor's catalogue does not ship, so only the shell can supply it.
  const catalogue = catalogueFamilies().map(font => font.family);
  const family = local.find(font => !catalogue.includes(font.family))?.family;
  assert.ok(family, 'this computer has a font the catalogue does not ship');
  assert.ok(local[0].bytes > 1000, 'a face reads as bytes');
  step(`using “${family}”`);

  step('opening a file with a text in that font');
  const fileId = await runAsync<string>(
    `const [doc, done] = [arguments[0], arguments[arguments.length - 1]];
     (async () => {
       const json = {'content-type': 'application/json'};
       const created = await (await fetch('/api/design-files', {method: 'POST', headers: json, body: '{}', credentials: 'same-origin'})).json();
       const put = await fetch('/api/design-files/' + encodeURIComponent(created.file.id) + '/document', {method: 'PUT', headers: json, credentials: 'same-origin',
         body: JSON.stringify({baseVersion: created.file.version, document: doc})});
       if (!put.ok) throw new Error('document: ' + put.status + ' ' + await put.text());
       location.hash = '#design/' + encodeURIComponent(created.file.id);
       done(created.file.id);
     })().catch(error => done('error: ' + error.message));`,
    textDocument(family),
  );
  assert.ok(!fileId.startsWith('error'), fileId);
  await until('the editor', () => find("//button[@aria-label='Main menu']"), 90_000);
  const loaded = await until(`the “${family}” face drawn from the shell’s bytes`, () =>
    run<string | null>(`for (const face of document.fonts) if (face.family.replace(/"/g, '') === 'dz ' + arguments[0] && face.status === 'loaded') return face.family; return null;`, family));
  assert.ok(loaded);

  step('"Save to computer" through the native save dialog');
  await click(await find("//button[@aria-label='Main menu']"));
  await click(await until('"File"', () => find("//*[@role='menuitem' and .//*[normalize-space()='File'] or @role='menuitem' and normalize-space()='File']")));
  await click(await until('"Save to computer"', () => find("//*[@role='menuitem' and contains(normalize-space(), 'Save to computer')]")));
  const saved = await until('the saved portable file', async () => (await stat(savePath).catch(() => null))?.size ?? 0, 60_000);
  const portable = JSON.parse(await readFile(savePath, 'utf8')) as {format: string; document: DesignDocument};
  assert.equal(portable.format, 'morfa-design');
  assert.equal(portable.document.nodes['local-text']?.text?.style.fontFamily, family);
  step(`saved ${saved} bytes`);

  step('a deep link opens a file in its own window');
  const handles = await wd<string[]>('GET', `${s}/window/handles`);
  const second = await runAsync<string>(
    `const done = arguments[arguments.length - 1];
     fetch('/api/design-files', {method: 'POST', headers: {'content-type': 'application/json'}, body: '{"name":"Deep link"}', credentials: 'same-origin'})
       .then(r => r.json()).then(r => done(r.file.id), e => done('error: ' + e.message));`);
  assert.ok(!second.startsWith('error'), second);
  // A second launch hands the link to the running app (single instance) and exits.
  const launched = spawn(binary, [`morfa://file/${second}`], {stdio: 'inherit', env: process.env});
  const exited = await new Promise<number | null>(resolve => launched.on('exit', resolve));
  step(`second launch exited with ${exited}`);
  const handle = await until('the new window', async () => (await wd<string[]>('GET', `${s}/window/handles`)).find(h => !handles.includes(h)), 30_000);
  await wd('POST', `${s}/window`, {handle});
  await until('the linked file', async () => (await wd<string>('GET', `${s}/url`)).includes(`#design/${encodeURIComponent(second)}`), 60_000);
  // A link to a file already open focuses its window instead of opening another.
  const again = spawn(binary, [`${appOrigin}/#design/${second}`], {stdio: 'inherit', env: process.env});
  await new Promise(resolve => again.on('exit', resolve));
  await sleep(1500);
  assert.equal((await wd<string[]>('GET', `${s}/window/handles`)).length, handles.length + 1, 'no duplicate window');
  step('PASS');
} catch (error) {
  // What the window showed: output/desktop-smoke/ (gitignored), for the next person to look at.
  const dir = 'output/desktop-smoke';
  await mkdir(dir, {recursive: true});
  const shot = await wd<string>('GET', `${s}/screenshot`).catch(() => '');
  if (shot) await writeFile(`${dir}/failure.png`, Buffer.from(shot, 'base64'));
  const text = await run<string>('return location.href + "\\n" + document.body.innerText.slice(0, 4000);').catch(() => '');
  await writeFile(`${dir}/failure.txt`, `${error}\n\n${text}`);
  console.error(`smoke: FAIL — ${error}\nsmoke: page text and screenshot in ${dir}/`);
  process.exitCode = 1;
} finally {
  await wd('DELETE', s).catch(() => undefined);
}
