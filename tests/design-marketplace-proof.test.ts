// Russian text proofing (docs/marketplaces.md §Russian text proofing): which words the spelling check reads, the spelling of real card
// texts against the Russian Hunspell dictionary (server/marketplace/canvas/spelling.ts), and the limits and switches of POST
// /api/marketplace/proof (proof-router.ts).
// The Cyrillic words and sentences are kept on purpose: they are the Russian spelling-check input (Hunspell ru).
import test from 'node:test';
import assert from 'node:assert/strict';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {createDocument, createNode, defaultTextProps} from '../shared/design/defaults';
import {cardTexts, checkableWord, PROOF_LIMITS, proofWords, spellingMessage, uniqueTexts} from '../shared/design/marketplace/proof';
import {russianSpeller, spellingIssues, SUGGESTIONS_PER_REQUEST} from '../server/marketplace/canvas/spelling';
import type {DesignDocument} from '../shared/design/types';

// The router reaches server/db through the files' access check, whose pool is lazy: a placeholder address is never connected to.
process.env.MORFA_DATABASE_URL ||= 'postgresql://morfa_runtime:unused@127.0.0.1:5999/morfa?sslmode=disable';
const {createProofRouter} = await import('../server/marketplace/canvas/proof-router');
type ProofRouterOptions = import('../server/marketplace/canvas/proof-router').ProofRouterOptions;

const FILE = '00000000-0000-4000-8000-000000000001';

test('reads Cyrillic words only: no digits, Latin, single letters or short abbreviations; hyphens kept', () => {
  assert.deepEqual(proofWords('Натуральная кожа, 5см, LED-подсветка и ГОСТ; темно-синий — в 2 цветах. Кожа!'), ['Натуральная', 'кожа', 'темно-синий', 'цветах', 'Кожа']);
  assert.deepEqual(proofWords('USB Type-C, iPhone 15, ПВХ, СССР, в, и'), []);
  assert.equal(checkableWord('ПРОЧНЫЙ'), true, 'a long word in capitals is read');
  assert.equal(checkableWord('США'), false);
  assert.equal(checkableWord('Wi-Fi'), false);
  assert.equal(checkableWord('кожа-x'), false, 'a mixed word is skipped');
  assert.deepEqual(proofWords('уда́рение й'), ['ударение'], 'stress marks dropped, a decomposed "й" composed');
  assert.equal(spellingMessage(['качество', 'качеств']), 'maybe "качество"');
  assert.equal(spellingMessage([]), 'not in the dictionary');
});

test('finds misspelled words with suggestions in real card texts, and leaves correct Russian alone', async () => {
  const issues = await spellingIssues([
    {id: 'a', text: 'Качесво отличное, гипоалергенный материал'},
    {id: 'b', text: 'Натуральная кожа, удобная застёжка, ёлочные игрушки, тёмно-синий цвет, 100 % хлопок'},
    {id: 'c', text: 'Совместим с iPhone и Android, разъём USB-C, ГОСТ 2026'},
  ]);
  assert.deepEqual(Object.keys(issues), ['a']);
  const [first, second] = issues.a;
  assert.equal(first.word, 'Качесво');
  assert.equal(first.suggestions[0], 'Качество');
  assert.equal(first.message, 'maybe "Качество"');
  assert.equal(second.word, 'гипоалергенный');
  assert.ok(second.suggestions.length <= 3);
});

test('loads the dictionary once per process and keeps answers per word', async () => {
  const [one, two] = await Promise.all([russianSpeller(), russianSpeller()]);
  assert.equal(one, two);
  let suggested = 0;
  const speller = {correct: (word: string) => word.length < 4, suggest: () => (suggested++, ['слово'])};
  const many = Array.from({length: SUGGESTIONS_PER_REQUEST + 5}, (_, i) => `ошибкаа${String.fromCharCode(1072 + i)}`);
  const answer = await spellingIssues([{id: 'x', text: many.join(' ')}], speller);
  assert.equal(answer.x.length, many.length);
  assert.equal(suggested, SUGGESTIONS_PER_REQUEST, 'suggestions are bounded per request');
  assert.equal(answer.x.at(-1)!.message, 'not in the dictionary');
});

test('collects a card\'s texts, each once', () => {
  let doc: DesignDocument = createDocument('page');
  const add = (id: string, parentId: string, type: 'FRAME' | 'TEXT', text?: string) => {
    const node = createNode(type, {id, parentId, ...(text !== undefined ? {text: defaultTextProps(text)} : {})});
    doc = {...doc, nodes: {...doc.nodes, [id]: node, [parentId]: {...doc.nodes[parentId], children: [...(doc.nodes[parentId].children ?? []), id]}}};
  };
  add('card', 'page', 'FRAME');
  add('t1', 'card', 'TEXT', 'Натуральный кожа');
  add('row', 'card', 'FRAME');
  add('t2', 'row', 'TEXT', '  ');
  add('t3', 'row', 'TEXT', 'Натуральный кожа');
  add('t4', 'row', 'TEXT', '42 × 30, USB-C');
  add('t5', 'card', 'TEXT', 'Удобная рюкзак');
  const texts = cardTexts(doc, 'card');
  assert.deepEqual(texts.map(item => item.id), ['t1', 't3', 't4', 't5']);
  assert.deepEqual(uniqueTexts(texts).map(item => item.id), ['t1', 't4', 't5']);
});

async function server(options: ProofRouterOptions, user: {id: string} | null = {id: 'u1'}) {
  const app = express();
  app.use(express.json({limit: '4mb'}));
  app.use((_req, res, next) => {
    res.locals.user = user;
    next();
  });
  app.use('/proof', createProofRouter({toolAvailable: () => true, canRead: async () => {}, actorOf: () => ({ownerId: 'u1', sessionHash: 'h'}), ...options}));
  app.use((error: {status?: number; message: string; code?: string}, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({error: error.message, code: error.code});
  });
  const listening = app.listen(0, '127.0.0.1');
  await new Promise(resolve => listening.once('listening', resolve));
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/proof`;
  const post = async (path: string, body: unknown) => {
    const response = await fetch(base + path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    return {status: response.status, body: (await response.json()) as Record<string, unknown>};
  };
  return {post, close: () => new Promise(resolve => listening.close(resolve))};
}

test('POST /api/marketplace/proof checks spelling of a readable file\'s texts within its limits', async () => {
  const checked: string[] = [];
  const api = await server({canRead: async (_actor, fileId) => void checked.push(fileId)});
  try {
    const ok = await api.post('/', {fileId: FILE, texts: [{id: 'n1', text: 'Мягкая ткань'}, {id: 'n2', text: 'Прочная ткнь'}]});
    assert.equal(ok.status, 200);
    assert.deepEqual(Object.keys(ok.body.issues as object), ['n2']);
    assert.deepEqual(checked, [FILE], 'the file is checked for access');
    const many = Array.from({length: PROOF_LIMITS.texts + 1}, (_, i) => ({id: `n${i}`, text: 'слово'}));
    assert.equal((await api.post('/', {fileId: FILE, texts: many})).status, 400);
    assert.equal((await api.post('/', {fileId: FILE, texts: [{id: 'n', text: 'a'.repeat(PROOF_LIMITS.chars + 1)}]})).status, 400);
    assert.equal((await api.post('/', {fileId: 'nope', texts: []})).status, 400);
    assert.deepEqual((await api.post('/', {fileId: FILE, texts: []})).body, {issues: {}});
  } finally {
    await api.close();
  }
  const refused = await server({canRead: async () => Promise.reject(Object.assign(Error('File not found.'), {status: 404, code: 'not_found'}))});
  try {
    assert.deepEqual(await refused.post('/', {fileId: FILE, texts: [{id: 'n1', text: 'текст'}]}), {status: 404, body: {error: 'File not found.', code: 'not_found'}});
  } finally {
    await refused.close();
  }
  const off = await server({toolAvailable: () => false});
  try {
    assert.equal((await off.post('/', {fileId: FILE, texts: []})).status, 404, 'not there while the design tool is closed to the account');
  } finally {
    await off.close();
  }
});
