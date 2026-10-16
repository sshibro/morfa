// Catalog Generation on PostgreSQL (docs/marketplaces.md §Catalog Generation): brand kits kept per account (only the owner reads or changes
// one, at most twenty, checked by the schema), the pictures a file may hold as they are and the copies made of the rest, and the free
// product cut-out over HTTP.
import {after, before, beforeEach, test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {once} from 'node:events';
import type {AddressInfo} from 'node:net';
import express from 'express';
import sharp from 'sharp';
import {bootPostgresqlDatabase, migrationDatabase} from './helpers/app-fixture';
import {BRAND_KIT_TEXTS, createBrandKit, listBrandKits} from '../server/marketplace/generation/brand-kits';
import {CUT_OUT_TEXTS} from '../server/marketplace/generation/cut-out';
import {kitPicturesFor, usableInPlace} from '../server/marketplace/generation/pictures';
import {createGenerationRouter, type GenerationRouterOptions} from '../server/marketplace/generation/router';
import type {CustomerAuthority} from '../server/customer-authority';
import type {Database} from '../server/postgresql/client';
import {BRAND_KITS_PER_ACCOUNT, newBrandKit, type BrandKit, type BrandKitRecord} from '../shared/design/marketplace/brand-kit';

let fixture: Awaited<ReturnType<typeof bootPostgresqlDatabase>>;
before(async () => {
  fixture = await bootPostgresqlDatabase();
});
after(async () => {
  await fixture?.close();
});
beforeEach(async () => {
  const owner: Database = migrationDatabase(fixture);
  try {
    await owner.execute('TRUNCATE marketplace_brand_kits CASCADE');
  } finally {
    await owner.close();
  }
});

const FILE = randomUUID();
const actor = (userId: string): CustomerAuthority => ({ownerId: userId, sessionHash: 'test-session'});
async function account(db: Database): Promise<string> {
  const id = randomUUID();
  await db.execute('INSERT INTO users(id,email,password,name,email_verified) VALUES($1,$2,$3,$4,1)', [id, `${id.replace(/[^a-z0-9]/gi, '')}@example.test`, '', 'Designer']);
  return id;
}
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** A studio photo: a red product on near-white. */
const studioPhoto = async (width = 400, height = 600) => {
  const data = Buffer.alloc(width * height * 3, 248);
  for (let y = 100; y < 400; y++) for (let x = 100; x < 300; x++) data.set([200, 30, 40], (y * width + x) * 3);
  return sharp(data, {raw: {width, height, channels: 3}}).png().toBuffer();
};
// ── An app with the router and a fake session ───────────────────────────────────────────────────

type Call = {status: number; body: Record<string, any>};
async function serve(options: GenerationRouterOptions) {
  const app = express();
  app.use(express.json({limit: '1mb'}));
  app.use((req, res, next) => {
    const id = req.header('x-user');
    if (id) res.locals.user = {id};
    next();
  });
  app.use('/gen', createGenerationRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/gen`;
  const call = async (user: string | null, method: string, path: string, body?: unknown): Promise<Call> => {
    const res = await fetch(base + path, {method, headers: {'content-type': 'application/json', ...(user ? {'x-user': user} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
    return {status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any>};
  };
  return {call, base, close: () => new Promise<void>(resolve => server.close(() => resolve()))};
}

function routerOptions(over: Partial<GenerationRouterOptions> = {}) {
  const pictures = new Map<string, Buffer>();
  const options: GenerationRouterOptions = {
    db: () => fixture.db,
    designOn: () => true,
    actorOf: (_req, res) => actor(String(res.locals.user.id)),
    fileScope: async who => ({userId: who.ownerId, teamId: null}),
    usable: (scope, filenames) => usableInPlace(fixture.db, scope, filenames),
    readImage: async (_userId, ref) => pictures.get(ref) ?? null,
    storeImage: async (_actor, _fileId, image, name) => {
      const ref = 'dz-' + randomUUID();
      pictures.set(ref, image);
      const meta = await sharp(image).metadata();
      return {ref, asset: {url: `/uploads/${ref}.png`, width: meta.width ?? 1, height: meta.height ?? 1, ...(name ? {name} : {})}};
    },
    ...over,
  };
  return {options, pictures};
}

const KIT = (name: string, patch: Partial<BrandKit> = {}): BrandKit => ({...newBrandKit(name), colors: {primary: '#1D3557', secondary: '#457b9d', accent: '#e63946', background: '#f1faee', text: '#1d1d1d'}, ...patch});

// ── Brand kits ───────────────────────────────────────────────────────────────────────────────────

test('brand kits: the owner creates, lists, changes and deletes them; the schema checks every field', async () => {
  const [owner, other] = [await account(fixture.db), await account(fixture.db)];
  const app = await serve(routerOptions().options);
  try {
    assert.deepEqual((await app.call(owner, 'GET', '/brand-kits')).body, {kits: []});
    const made = await app.call(owner, 'POST', '/brand-kits', {kit: KIT('  Main   brand ')});
    assert.equal(made.status, 201);
    const record = made.body.kit as BrandKitRecord;
    assert.match(record.id, /^[0-9a-f-]{36}$/);
    assert.equal(record.name, 'Main brand');
    assert.equal(record.kit.colors.primary, '#1d3557', 'colours lower-cased');
    // Refused: an unknown field, a colour that is not #rrggbb, a picture from elsewhere, too many icons.
    for (const kit of [{...KIT('A'), extra: 1}, KIT('A', {colors: {...KIT('A').colors, accent: 'red'}}), KIT('A', {logo: {url: 'https://evil.example/logo.png', width: 10, height: 10}}),
      KIT('A', {icons: Array.from({length: 25}, (_, i) => ({url: `/uploads/i${i}.png`, width: 10, height: 10}))}), KIT('')]) {
      const refused = await app.call(owner, 'POST', '/brand-kits', {kit});
      assert.deepEqual([refused.status, refused.body.code, refused.body.error], [400, 'invalid_request', BRAND_KIT_TEXTS.invalid]);
    }
    // Another account sees none of it and can change none of it.
    assert.deepEqual((await app.call(other, 'GET', '/brand-kits')).body, {kits: []});
    assert.equal((await app.call(other, 'PATCH', `/brand-kits/${record.id}`, {kit: KIT('Foreign')})).status, 404);
    assert.equal((await app.call(other, 'DELETE', `/brand-kits/${record.id}`)).status, 404);
    assert.equal((await app.call(other, 'POST', `/brand-kits/${record.id}/pictures`, {fileId: FILE})).status, 404);
    await pause(20);
    const changed = await app.call(owner, 'PATCH', `/brand-kits/${record.id}`, {kit: KIT('New', {fonts: {heading: 'Montserrat', body: 'Inter'}})});
    assert.equal(changed.status, 200);
    assert.equal(changed.body.kit.name, 'New');
    assert.ok(Date.parse(changed.body.kit.updatedAt) >= Date.parse(record.updatedAt));
    const second = (await app.call(owner, 'POST', '/brand-kits', {kit: KIT('Second')})).body.kit as BrandKitRecord;
    assert.deepEqual((await app.call(owner, 'GET', '/brand-kits')).body.kits.map((kit: BrandKitRecord) => kit.name), ['Second', 'New'], 'the last changed first');
    assert.deepEqual((await app.call(owner, 'DELETE', `/brand-kits/${second.id}`)).body, {ok: true});
    assert.equal((await app.call(owner, 'DELETE', `/brand-kits/${second.id}`)).status, 404);
    assert.equal((await app.call(owner, 'PATCH', '/brand-kits/not-a-kit', {kit: KIT('x')})).status, 404);
    assert.deepEqual((await listBrandKits(fixture.db, owner)).map(kit => kit.name), ['New']);
  } finally {
    await app.close();
  }
});

test('an account keeps at most twenty kits, counted under its lock', async () => {
  const owner = await account(fixture.db);
  // Two tabs creating the last ones together: exactly the limit is kept.
  const made = await Promise.all(Array.from({length: BRAND_KITS_PER_ACCOUNT + 3}, (_, i) => createBrandKit(fixture.db, owner, KIT(`Set ${i}`))));
  assert.equal(made.filter(Boolean).length, BRAND_KITS_PER_ACCOUNT);
  const app = await serve(routerOptions().options);
  try {
    const over = await app.call(owner, 'POST', '/brand-kits', {kit: KIT('Extra')});
    assert.deepEqual([over.status, over.body.code, over.body.error], [409, 'brand_kit_limit', BRAND_KIT_TEXTS.limit]);
  } finally {
    await app.close();
  }
});

test('everything is hidden while the design tool is closed to the account', async () => {
  const owner = await account(fixture.db);
  const closed = await serve(routerOptions({designOn: () => false}).options);
  const open = await serve(routerOptions().options);
  try {
    assert.deepEqual(await closed.call(owner, 'GET', '/brand-kits'), {status: 404, body: {error: 'Not found.', code: 'not_found'}});
    assert.equal((await closed.call(null, 'GET', '/brand-kits')).status, 404);
    assert.equal((await open.call(owner, 'GET', '/brand-kits')).status, 200);
    assert.equal((await open.call(owner, 'POST', '/cut-out', {fileId: FILE, imageRef: 'nothing'})).status, 404, 'a missing photo');
  } finally {
    await closed.close();
    await open.close();
  }
});

// ── Kit pictures in a file ───────────────────────────────────────────────────────────────────────

test('the pictures a file may hold as they are: the owner\'s own for a personal file, the team\'s for a team file', async () => {
  const owner = await account(fixture.db);
  const team = randomUUID();
  await fixture.db.execute('INSERT INTO design_teams(id,name,owner_id) VALUES($1,$2,$3)', [team, 'Team', owner]);
  const image = (filename: string, teamId: string | null) =>
    fixture.db.execute("INSERT INTO design_images(filename,user_id,team_id,kind,bytes,width,height) VALUES($1,$2,$3,'image',10,10,10)", [filename, owner, teamId]);
  await image('dz-own.png', null);
  await image('dz-team.png', team);
  await fixture.db.execute('INSERT INTO uploads(filename,user_id,ready) VALUES($1,$2,1),($3,$2,0)', ['site-logo.png', owner, 'site-pending.png']);
  const all = ['dz-own.png', 'dz-team.png', 'site-logo.png', 'site-pending.png', 'dz-missing.png'];
  assert.deepEqual([...(await usableInPlace(fixture.db, {userId: owner, teamId: null}, all))].sort(), ['dz-own.png', 'site-logo.png']);
  assert.deepEqual([...(await usableInPlace(fixture.db, {userId: owner, teamId: team}, all))], ['dz-team.png']);
  assert.deepEqual([...(await usableInPlace(fixture.db, {userId: owner, teamId: null}, []))], []);
});

test('applying a kit copies the pictures a file\'s place lacks and leaves out what cannot be read', async () => {
  const owner = await account(fixture.db);
  const team = randomUUID();
  await fixture.db.execute('INSERT INTO design_teams(id,name,owner_id) VALUES($1,$2,$3)', [team, 'Team', owner]);
  await fixture.db.execute("INSERT INTO design_images(filename,user_id,team_id,kind,bytes,width,height) VALUES('dz-logo.png',$1,NULL,'image',10,10,10)", [owner]);
  const logo = {url: '/uploads/dz-logo.png', width: 10, height: 10, name: 'logo.png'};
  const gone = {url: '/uploads/dz-gone.png', width: 10, height: 10};
  const stored: string[] = [];
  const deps = (teamId: string | null) => ({
    fileScope: async () => ({userId: owner, teamId}),
    usable: (scope: {userId: string; teamId: string | null}, names: readonly string[]) => usableInPlace(fixture.db, scope, names),
    readImage: async (_userId: string, ref: string) => (ref === 'dz-logo' ? Buffer.from('logo') : null),
    storeImage: async (_actor: unknown, fileId: string) => {
      stored.push(fileId);
      return {ref: 'dz-copy', asset: {url: '/uploads/dz-copy.png', width: 10, height: 10}};
    },
  });
  const personal = await kitPicturesFor(deps(null), actor(owner), FILE, [logo, gone, logo]);
  assert.deepEqual(personal, {pictures: {'/uploads/dz-logo.png': {ref: 'dz-logo', asset: logo}}}, 'its own picture as it is; the lost one left out');
  assert.deepEqual(stored, []);
  const inTeam = await kitPicturesFor(deps(team), actor(owner), FILE, [logo]);
  assert.deepEqual(inTeam, {pictures: {'/uploads/dz-logo.png': {ref: 'dz-copy', asset: {url: '/uploads/dz-copy.png', width: 10, height: 10, name: 'logo.png'}}}});
  assert.deepEqual(stored, [FILE], 'copied into the team file');
});

// ── The free cut-out over HTTP ───────────────────────────────────────────────────────────────────

test('"Remove background" over HTTP: stored as the file\'s PNG with alpha, its place in the photo', async () => {
  const owner = await account(fixture.db);
  const {options, pictures} = routerOptions();
  pictures.set('dz-photo', await studioPhoto());
  const app = await serve(options);
  try {
    const cut = await app.call(owner, 'POST', '/cut-out', {fileId: FILE, imageRef: 'dz-photo'});
    assert.equal(cut.status, 200);
    assert.deepEqual(cut.body.source, {width: 400, height: 600});
    // The product (100, 100, 200 × 300) with a margin of 3 % of its longer side and the feather's pixel.
    assert.ok(Math.abs(cut.body.box.x * 400 - 90) <= 2 && Math.abs(cut.body.box.y * 600 - 90) <= 2, JSON.stringify(cut.body.box));
    assert.equal(cut.body.asset.name, 'Product');
    const stored = await sharp(pictures.get(cut.body.ref)!).metadata();
    assert.deepEqual([stored.format, stored.hasAlpha], ['png', true]);
    // A photo on an uneven background is refused in words.
    pictures.set('dz-busy', await sharp({create: {width: 200, height: 200, channels: 3, background: '#ffffff'}}).composite([{input: await sharp({create: {width: 100, height: 200, channels: 3, background: '#101010'}}).png().toBuffer(), left: 0, top: 0}]).png().toBuffer());
    const refused = await app.call(owner, 'POST', '/cut-out', {fileId: FILE, imageRef: 'dz-busy'});
    assert.deepEqual([refused.status, refused.body.code, refused.body.error], [422, 'marketplace_cut_out_refused', CUT_OUT_TEXTS.unevenBackground]);
    assert.equal((await app.call(owner, 'POST', '/cut-out', {fileId: 'nope', imageRef: 'dz-photo'})).status, 400);
  } finally {
    await app.close();
  }
});

test('a cut-out stored as a design picture keeps its alpha: PNG in, PNG with alpha out', async () => {
  const {encodeDesignImage} = await import('../server/design/images');
  const cut = await sharp({create: {width: 40, height: 30, channels: 4, background: {r: 200, g: 30, b: 40, alpha: 0}}})
    .composite([{input: await sharp({create: {width: 20, height: 10, channels: 4, background: {r: 200, g: 30, b: 40, alpha: 1}}}).png().toBuffer(), left: 10, top: 10}])
    .png()
    .toBuffer();
  const encoded = await encodeDesignImage(cut);
  assert.deepEqual([encoded.extension, encoded.width, encoded.height], ['png', 40, 30]);
  const raw = await sharp(encoded.data).ensureAlpha().raw().toBuffer();
  assert.equal(raw[3], 0, 'the clear corner stays clear');
  assert.deepEqual([...raw.subarray((15 * 40 + 20) * 4, (15 * 40 + 20) * 4 + 4)], [200, 30, 40, 255]);
});
