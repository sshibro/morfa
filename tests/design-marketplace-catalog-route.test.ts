import test from 'node:test';
import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import express from 'express';
import type {CatalogFetchAnswer} from '../shared/design/marketplace/catalog-api';
import {createCatalogRouter, type CatalogRouterDeps} from '../server/marketplace/catalog/router';
import {fetchPublicPhoto, photoName, photoUrl, PhotoFetchError} from '../server/marketplace/catalog/fetch-image';

// POST /api/marketplace/catalog/fetch-images (docs/marketplaces.md §Catalog run) over HTTP with a fake download and a fake store: the
// file check first, each address's own answer in the order asked, a full picture room stopping the rest, one request at a time per
// account. The real download's address checks run without the network (IP literals, localhost).

const FILE = '00000000-0000-4000-8000-000000000001';
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

async function serve(t: test.TestContext, overrides: Partial<CatalogRouterDeps> = {}) {
  const fetched: string[] = [];
  const stored: {name: string; bytes: number}[] = [];
  const deps: Partial<CatalogRouterDeps> = {
    actorOf: () => ({ownerId: 'u1', sessionHash: 'h'}) as never,
    checkFile: async (_actor, fileId) => {
      if (fileId !== FILE) throw Object.assign(new Error('File not found.'), {status: 404, code: 'not_found'});
    },
    fetchPhoto: async url => {
      photoUrl(url);
      fetched.push(url);
      if (url.includes('missing')) throw new PhotoFetchError('The site with the photo answered with error 404.', 'http_error');
      return {data: url.includes('text') ? Buffer.from('<html>') : PNG, name: photoName(new URL(url))};
    },
    storeImage: async (_actor, _fileId, data, name) => {
      if (data.toString() === '<html>') throw Object.assign(new Error('Supported images: JPEG, PNG, WebP, AVIF and GIF.'), {status: 415, code: 'invalid_request'});
      stored.push({name, bytes: data.length});
      return {ref: `ref-${stored.length}`, asset: {url: `/uploads/${stored.length}.png`, width: 10, height: 10, name}};
    },
    ...overrides,
  };
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => ((res.locals.user = {id: 'u1'}), next()));
  app.use('/catalog', createCatalogRouter(deps));
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/catalog`;
  const post = (body: unknown) => fetch(base + '/fetch-images', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  return {post, fetched, stored};
}

test('should check the file first and refuse a malformed body', async t => {
  const {post, fetched} = await serve(t);
  const bad = await post({fileId: FILE, urls: []});
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).code, 'invalid_request');
  assert.equal((await post({fileId: FILE, urls: Array(51).fill('https://cdn.test/a.png')})).status, 400);
  const other = await post({fileId: 'someone-elses', urls: ['https://cdn.test/a.png']});
  assert.equal(other.status, 404);
  assert.deepEqual(await other.json(), {error: 'File not found.', code: 'not_found'});
  assert.deepEqual(fetched, []);
});

test('should answer each address in order: a picture once per address, or why there is none', async t => {
  // The %D0… addresses are percent-encoded Cyrillic file names on purpose: the picture's name is the decoded text.
  const {post, fetched, stored} = await serve(t);
  const urls = ['https://cdn.test/%D0%BA%D1%80%D0%B5%D0%BC.png', 'http://cdn.test/b.png', 'https://cdn.test/missing.png', 'https://cdn.test/text.html', 'https://cdn.test/%D0%BA%D1%80%D0%B5%D0%BC.png'];
  const response = await post({fileId: FILE, urls});
  assert.equal(response.status, 200);
  const {results} = (await response.json()) as CatalogFetchAnswer;
  assert.deepEqual(results.map(result => result.url), urls);
  assert.deepEqual(results[0], {url: urls[0], ref: 'ref-1', asset: {url: '/uploads/1.png', width: 10, height: 10, name: 'крем.png'}});
  assert.deepEqual(results[4], results[0]);
  assert.deepEqual(results[1], {url: urls[1], error: 'A link that starts with https:// is needed.', code: 'not_https'});
  assert.deepEqual(results[2], {url: urls[2], error: 'The site with the photo answered with error 404.', code: 'http_error'});
  assert.equal((results[3] as {code: string}).code, 'invalid_request');
  assert.equal(stored.length, 1);
  assert.equal(fetched.filter(url => url === urls[0]).length, 1);
});

test('should stop downloading once the plan\'s room for pictures is full', async t => {
  let calls = 0;
  const {post, fetched} = await serve(t, {
    storeImage: async () => {
      calls++;
      throw Object.assign(new Error('Image storage is full: 1 GB. Delete files you no longer need.'), {status: 413, code: 'design_storage_limit'});
    },
  });
  const urls = Array.from({length: 12}, (_, i) => `https://cdn.test/${i}.png`);
  const {results} = (await (await post({fileId: FILE, urls})).json()) as CatalogFetchAnswer;
  assert.ok(results.every(result => 'error' in result && result.code === 'design_storage_limit'));
  // The workers that were already downloading finish; nobody starts another.
  assert.ok(fetched.length <= 4 && calls <= 4, `${fetched.length} downloads`);
});

test('should take one request per account at a time', async t => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => (release = resolve));
  const {post} = await serve(t, {
    fetchPhoto: async () => {
      await gate;
      return {data: PNG, name: 'a.png'};
    },
  });
  const first = post({fileId: FILE, urls: ['https://cdn.test/a.png']});
  await new Promise(resolve => setTimeout(resolve, 50));
  const second = await post({fileId: FILE, urls: ['https://cdn.test/b.png']});
  assert.equal(second.status, 429);
  release();
  assert.equal((await first).status, 200);
  assert.equal((await post({fileId: FILE, urls: ['https://cdn.test/c.png']})).status, 200);
});

test('should refuse addresses that are not public https before any connection', async () => {
  const refused = async (url: string, code: string) => {
    await assert.rejects(fetchPublicPhoto(url), (error: unknown) => error instanceof PhotoFetchError && error.code === code, url);
  };
  await refused('http://example.com/a.png', 'not_https');
  await refused('ftp://example.com/a.png', 'not_https');
  await refused('https://user:secret@example.com/a.png', 'unsafe_url');
  await refused('https://example.com:8443/a.png', 'unsafe_url');
  await refused('not a link', 'invalid_url');
  await refused('https://127.0.0.1/a.png', 'unsafe_destination');
  await refused('https://10.1.2.3/a.png', 'unsafe_destination');
  await refused('https://169.254.169.254/latest/meta-data', 'unsafe_destination');
  await refused('https://192.168.0.10/a.png', 'unsafe_destination');
  await refused('https://localhost/a.png', 'unsafe_destination');
  // A percent-encoded Cyrillic file name ("foto.jpg") is decoded to the text.
  assert.equal(photoName(new URL('https://cdn.test/a/%D1%84%D0%BE%D1%82%D0%BE.jpg?x=1')), 'фото.jpg');
  assert.equal(photoName(new URL('https://cdn.test/')), 'cdn.test');
});
