import {test, expect} from './fixtures';
import type {Page, Route} from '@playwright/test';

// "Import from Figma" by link end to end in the real app (a .fig file: design-figma-import-fig.spec.ts): a link and a personal token in the dialog, the file read from Figma's API (mocked
// here in the browser: the browser calls Figma, the server never does), its pages chosen, its pictures copied
// into Morfa, the new file opened and saved. The file is what people import first: a component set of buttons with its variants
// and a frame with a photo.

const KEY = 'E2eFigmaFile0123456789';
type T = [[number, number, number], [number, number, number]];
const at = (x: number, y: number): T => [[1, 0, x], [0, 1, y]];
const node = (type: string, id: string, name: string, x: number, y: number, width: number, height: number, extra: Record<string, unknown> = {}) => ({
  id, name, type, visible: true, relativeTransform: at(x, y), size: {x: width, y: height}, absoluteBoundingBox: {x, y, width, height},
  fills: [], strokes: [], effects: [], ...extra,
});
const solid = (r: number, g: number, b: number) => ({type: 'SOLID', color: {r, g, b, a: 1}});
const label = (id: string, x: number, characters: string) => node('TEXT', id, characters, x, 12, 60, 20, {
  characters, fills: [solid(1, 1, 1)],
  style: {fontFamily: 'Inter', fontPostScriptName: 'Inter-Medium', fontWeight: 500, fontSize: 14, textAlignHorizontal: 'LEFT', textAlignVertical: 'CENTER', letterSpacing: 0, lineHeightPx: 20, lineHeightUnit: 'PIXELS'},
});

function figmaFile() {
  const variant = (id: string, name: string, x: number, fill: number[]) => node('COMPONENT', id, name, x, 0, 120, 44, {
    fills: [solid(fill[0], fill[1], fill[2])], cornerRadius: 8, children: [label(`${id}:t`, 30, 'Button')],
  });
  return {
    name: 'Design system',
    document: {id: '0:0', name: 'Document', type: 'DOCUMENT', children: [
      {id: '0:1', name: 'Buttons', type: 'CANVAS', backgroundColor: {r: 0.96, g: 0.96, b: 0.96, a: 1}, children: [
        node('COMPONENT_SET', '1:1', 'Button', 0, 0, 280, 44, {children: [
          variant('1:2', 'size=md, state=default, icon-only=false', 0, [0.255, 0.412, 0.882]),
          variant('1:3', 'size=md, state=hover, icon-only=false', 160, [0.2, 0.34, 0.78]),
        ]}),
        node('FRAME', '2:1', 'Cover', 0, 100, 320, 200, {fills: [solid(1, 1, 1)], children: [
          node('RECTANGLE', '2:2', 'Photo', 10, 10, 300, 180, {fills: [{type: 'IMAGE', scaleMode: 'FILL', imageRef: 'photo0001'}]}),
        ]}),
      ]},
    ]},
    components: {'1:2': {key: 'k-default', name: 'size=md, state=default, icon-only=false', componentSetId: '1:1'}, '1:3': {key: 'k-hover', name: 'size=md, state=hover, icon-only=false', componentSetId: '1:1'}},
    componentSets: {'1:1': {key: 'k-button', name: 'Button'}},
  };
}

// A 1×1 PNG, the photo's bytes.
const PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

/** Figma's REST API and its picture host, as the dialog calls them from the tab; what was asked comes back. */
async function mockFigma(page: Page) {
  const asked: string[] = [];
  const file = figmaFile();
  const json = (route: Route, body: unknown) => route.fulfill({status: 200, contentType: 'application/json', headers: {'Access-Control-Allow-Origin': '*'}, body: JSON.stringify(body)});
  await page.route('https://api.figma.com/**', route => {
    const url = new URL(route.request().url());
    asked.push(url.pathname);
    if (route.request().method() === 'OPTIONS') return route.fulfill({status: 204, headers: {'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'}});
    expect(route.request().headers()['x-figma-token'], 'the token typed in the dialog').toBe('figd_e2e-token');
    if (url.pathname === '/v1/me') return json(route, {id: '1', handle: 'anna.design', email: 'anna@example.test'});
    if (url.pathname === `/v1/files/${KEY}/images`) return json(route, {error: false, status: 200, meta: {images: {photo0001: 'https://s3-alpha-sig.figma.com/img/photo0001'}}});
    if (url.pathname === `/v1/files/${KEY}/nodes`) {
      const ids = (url.searchParams.get('ids') ?? '').split(',');
      const find = (at: {id: string; children?: unknown[]}, id: string): unknown =>
        at.id === id ? at : (at.children ?? []).map(child => find(child as {id: string; children?: unknown[]}, id)).find(Boolean);
      return json(route, {name: file.name, nodes: Object.fromEntries(ids.map(id => [id, {document: find(file.document, id), components: file.components, componentSets: file.componentSets}]))});
    }
    if (url.pathname === `/v1/images/${KEY}`) return json(route, {err: null, images: {}});
    if (url.pathname === `/v1/files/${KEY}`) return json(route, file);
    return route.fulfill({status: 404, contentType: 'application/json', body: '{"status":404,"err":"Not found"}'});
  });
  await page.route('https://s3-alpha-sig.figma.com/**', route => {
    asked.push(new URL(route.request().url()).pathname);
    return route.fulfill({status: 200, contentType: 'image/png', headers: {'Access-Control-Allow-Origin': '*'}, body: PHOTO});
  });
  return asked;
}

type Saved = {document: {nodes: Record<string, {type: string; name: string; text?: {characters: string}; fills?: {type: string; imageRef?: string}[]}>; images: Record<string, {url: string}>}};

test('a Figma file with a component set and a photo: link and token, pages, transfer, the new file opens with every layer saved', async ({page, seed: _seed}) => {
  test.setTimeout(90_000);
  const asked = await mockFigma(page);
  await page.goto('/#designs');
  await expect(page.getByRole('heading', {name: 'Recent', exact: true})).toBeVisible();
  await page.getByRole('button', {name: 'Import'}).click();
  await page.getByRole('menuitem', {name: 'Import from Figma…'}).click();
  const dialog = page.getByRole('dialog', {name: 'Import from Figma'});
  await expect(dialog).toBeVisible();

  // The dialog opens on ".fig file" (no token needed); the link and a token are the other way in.
  await dialog.getByRole('radio', {name: 'Link and token'}).click();
  await dialog.getByRole('textbox', {name: 'Link to file'}).fill(`https://www.figma.com/design/${KEY}/Design-system?node-id=0-1`);
  await dialog.getByRole('textbox', {name: 'Figma access token'}).fill('figd_e2e-token');
  await dialog.getByRole('button', {name: 'Continue'}).click();

  // The pages step: the one page, chosen; then the transfer runs to its report.
  await expect(dialog.getByRole('group', {name: 'Pages'})).toContainText('Buttons');
  await dialog.getByRole('button', {name: 'Import file'}).click();
  const open = dialog.getByRole('button', {name: 'Open file'});
  await expect(open).toBeVisible({timeout: 30_000});
  expect(asked).toContain(`/v1/files/${KEY}`);
  expect(asked).toContain('/img/photo0001');
  await open.click();

  await expect(page.getByRole('application', {name: 'Canvas'})).toBeVisible();
  const id = decodeURIComponent(/#design\/([^/?#]+)/.exec(page.url())![1]);
  // What the server keeps: the component set with both variants and their texts, and the photo copied into Morfa.
  await expect.poll(async () => {
    const response = await page.request.get('/api/design-files/' + encodeURIComponent(id));
    const saved = (await response.json()) as Saved;
    const nodes = Object.values(saved.document.nodes);
    const photo = nodes.find(each => each.name === 'Photo')?.fills?.find(fill => fill.type === 'IMAGE')?.imageRef;
    return {
      variants: nodes.filter(each => each.name.startsWith('size=md, state=')).map(each => each.name).sort(),
      texts: nodes.filter(each => each.type === 'TEXT').map(each => each.text?.characters),
      photo: !!photo && !!saved.document.images[photo]?.url && !saved.document.images[photo].url.includes('figma.com'),
    };
  }, {timeout: 15_000}).toEqual({
    variants: ['size=md, state=default, icon-only=false', 'size=md, state=hover, icon-only=false'],
    texts: ['Button', 'Button'],
    photo: true,
  });
});
