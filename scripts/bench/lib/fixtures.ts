// Accounts, teams and files on a bench server (scripts/bench/server.ts), and the bench files of gen-file.ts.
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';
import type {DesignDocument, SceneNode} from '../../../shared/design/types';
import {BENCH_DIR, STANDARD_FILES, generateFile} from '../gen-file';
import type {BenchServer} from './server';

export type Account = {id: string; token: string};
export const cookieOf = (account: Account) => `forma_session=${account.token}`;

/** The text of a bench file, generated when missing (the big ones are not committed). */
export function fixtureText(name: string): string {
  const file = path.join(BENCH_DIR, `${name}.json`);
  if (!existsSync(file)) {
    const options = STANDARD_FILES[name];
    if (!options) throw Error(`unknown bench file ${name}`);
    generateFile(name, options);
  }
  return readFileSync(file, 'utf8');
}
const parsed = new Map<string, DesignDocument>();
export function fixtureDocument(name: string): DesignDocument {
  let doc = parsed.get(name);
  if (!doc) {
    doc = JSON.parse(fixtureText(name)) as DesignDocument;
    parsed.set(name, doc);
  }
  return doc;
}

/** The layers editor `k` moves: the first `count` children of the k-th group of the page (separate layers per editor). */
export function layersFor(doc: DesignDocument, k: number, count = 20): SceneNode[] {
  const groups = Object.values(doc.nodes).filter(node => node.type === 'GROUP');
  if (!groups.length) throw Error('the bench file has no groups to move layers in');
  const group = groups[k % groups.length];
  return (group.children ?? []).slice(0, count).map(id => doc.nodes[id]);
}

export async function bench<T>(server: BenchServer, route: string, body?: unknown): Promise<T> {
  const response = await fetch(server.base + '/__bench/' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {'x-bench-key': server.benchKey, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw Error(`/__bench/${route}: ${response.status} ${await response.text()}`);
  return (await response.json()) as T;
}

export async function accounts(server: BenchServer, count: number, prefix = 'bench'): Promise<Account[]> {
  const out: Account[] = [];
  for (let left = count; left > 0; left -= 5000) out.push(...(await bench<{accounts: Account[]}>(server, 'accounts', {count: Math.min(left, 5000), prefix})).accounts);
  return out;
}

export async function team(server: BenchServer, owner: Account, members: {account: Account; role: 'editor' | 'viewer' | 'admin'}[]): Promise<string> {
  return (await bench<{teamId: string}>(server, 'team', {owner: owner.id, members: members.map(member => ({id: member.account.id, role: member.role}))})).teamId;
}

/** An API call as `who`, with the app's Origin on writes. */
export async function api(server: BenchServer, who: Account, method: string, route: string, body?: string | object): Promise<{status: number; text: string; ms: number}> {
  const started = performance.now();
  const response = await fetch(server.base + route, {
    method,
    headers: {cookie: cookieOf(who), ...(body !== undefined ? {'content-type': 'application/json', origin: server.base} : {})},
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await response.text();
  return {status: response.status, text, ms: performance.now() - started};
}

/** A file made the way the editor makes one (POST /api/design-files) from a bench file, in `teamId` when given. */
export async function createFile(server: BenchServer, owner: Account, fixture: string, teamId?: string): Promise<{id: string; version: number}> {
  const body = '{"name":' + JSON.stringify(fixture) + (teamId ? ',"teamId":' + JSON.stringify(teamId) : '') + ',"document":' + fixtureText(fixture) + '}';
  const answer = await api(server, owner, 'POST', '/api/design-files', body);
  if (answer.status !== 201 && answer.status !== 200) throw Error(`create ${fixture}: ${answer.status} ${answer.text.slice(0, 300)}`);
  const file = (JSON.parse(answer.text) as {file: {id: string; version: number}}).file;
  return {id: file.id, version: file.version};
}

export type SharedFile = {id: string; version: number; fixture: string; teamId: string; owner: Account; editors: Account[]; viewers: Account[]};

/** One file of a team: `editors` (the first is the owner) and `viewers`, every one with their own account and session. */
export async function sharedFile(server: BenchServer, fixture: string, editors: number, viewers = 0, pool?: Account[]): Promise<SharedFile> {
  const people = pool ?? (await accounts(server, editors + viewers));
  const owner = people[0];
  const editorAccounts = people.slice(0, editors);
  const viewerAccounts = people.slice(editors, editors + viewers);
  const teamId = await team(server, owner, [...editorAccounts.slice(1).map(account => ({account, role: 'editor' as const})), ...viewerAccounts.map(account => ({account, role: 'viewer' as const}))]);
  const file = await createFile(server, owner, fixture, teamId);
  return {...file, fixture, teamId, owner, editors: editorAccounts, viewers: viewerAccounts};
}

export type ServerMetrics = {
  pid: number;
  wallMs: number;
  cpuUserMs: number;
  cpuSystemMs: number;
  memory: NodeJS.MemoryUsage;
  rssMax: number;
  eventLoop: {p50: number; p99: number; max: number};
  patch: import('./histogram').HistogramJson;
  patchByStatus: Record<string, number>;
  fanout: import('./histogram').HistogramJson;
  fanoutFirst: import('./histogram').HistogramJson;
  commit: import('./histogram').HistogramJson;
  commitSave: import('./histogram').HistogramJson;
  presence: import('./histogram').HistogramJson;
  presenceByStatus: Record<string, number>;
  get: import('./histogram').HistogramJson;
  sse: {open: number; bytes: number; changeWrites: number; presenceWrites: number};
  walBytes: number | null;
  live: {streams: number; rooms: number; logBytes: number};
};
export const metrics = (server: BenchServer) => bench<ServerMetrics>(server, 'metrics');
export const resetMetrics = (server: BenchServer) => bench<{ok: true}>(server, 'reset', {});
export const gc = (server: BenchServer) => bench<{gc: boolean; memory: NodeJS.MemoryUsage}>(server, 'gc', {});
