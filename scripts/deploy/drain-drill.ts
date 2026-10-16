// The drain drill: editors edit through the
// real edge (Caddy → api /session → a collab node's socket), a collab node is stopped with systemd mid-run (SIGTERM = drain),
// and afterwards every acked op must be in the journal, every editor of a drained file must be back on the other node within
// 5 s, and the drained files must have a checkpoint written by the drain.
//
// Run on the host as root, from a release tree (it reads /etc/morfa/api.env for the database and the app origin):
//   node --import tsx scripts/deploy/drain-drill.ts [--base http://<ip>] [--files 40] [--editors 5] [--big 2] [--before 20]
//     [--after 20] [--rate 1] [--node a] [--drain "systemctl stop morfa-collab@a"] [--out drill.json] [--env /etc/morfa/api.env]
//     [--cookie __Host-forma_session] [--run <id>] [--allow-production]
//   node --import tsx scripts/deploy/drain-drill.ts --cleanup-only <run id> [--env /etc/morfa/api.env] [--allow-production]
//
// It cleans up after itself (lane D step 5: the run of 2026-10-08 left 800 accounts, 121 teams, 120 files and 14 195 changes in
// production). Every account it makes is `drill-<run>-<n>` with the e-mail `drill-<run>-<n>@drill.invalid`; when the run ends,
// fails, or is stopped (SIGINT, SIGTERM, SIGHUP), it deletes those accounts in one transaction, and the schema's cascades take
// their sessions, teams, team memberships, files and the files' changes. It prints the counts it removed. The runtime role may
// not delete accounts (they are anonymised on erasure, server/postgresql/migrations.ts), so the cleanup uses the migration role
// (MORFA_MIGRATION_DATABASE_URL in api.env, as host.sh migrate does). A run killed with SIGKILL leaves its rows: `--cleanup-only
// <run>` removes them. Nothing outside the `.invalid` domain is ever removed.
//
// It refuses a production database unless `--allow-production` is given: production is an APP_ORIGIN on a public name (the
// deploy scripts' rule: staging serves morfa.test, bench-ru its IP, the test cluster 127.0.0.1; production: any public name, e.g. app.example.com).
//
// The client is the editor's protocol (crates/protocol, B3's live session): `hello {ticket, clientId, since, lastSeq}`, ops with
// a per-client `seq`, unacked ops re-sent with the same seq after a reconnect (the node re-acks journaled ones, never re-applies
// them), reconnect through GET /session after `bye` or a closed socket. crates/loadgen has no reconnect, so it cannot run this.
import {execSync} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import pg from 'pg';
import {createDocument, createNode} from '../../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../../shared/design/types';

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const env = Object.fromEntries(
  readFileSync(arg('env', '/etc/morfa/api.env'), 'utf8').split('\n').map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(m => [m![1], m![2].replace(/^'(.*)'$|^"(.*)"$/, '$1$2')]),
) as Record<string, string>;
const CLEANUP_ONLY = flag('cleanup-only') ? arg('cleanup-only', '') : null;
/** This run's id: in every account it makes, so `--cleanup-only` can find them. */
const RUN = CLEANUP_ONLY ?? arg('run', randomBytes(5).toString('hex'));
if (!/^[a-z0-9]{6,32}$/.test(RUN)) {
  console.error(`drain drill: a run id is 6 to 32 lowercase letters and digits (got ${JSON.stringify(RUN)})`);
  process.exit(2);
}

/** Production is an app origin on a public name; staging (*.test), bench-ru (an IP) and the test cluster (127.0.0.1) are not. */
function isProductionOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
  } catch {
    return false;
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return false;
  return !/(^|\.)(localhost|test|invalid|example|local)$/.test(host);
}
if (isProductionOrigin(env.APP_ORIGIN) && !flag('allow-production')) {
  console.error(
    `drain drill: refusing ${new URL(env.APP_ORIGIN).hostname}: it is a production database (APP_ORIGIN on a public name). The drill ` +
      'adds hundreds of accounts, teams and files there; run it on staging (scripts/deploy/staging.sh drain) or bench-ru, or pass ' +
      '--allow-production if you mean it.',
  );
  process.exit(2);
}

const BASE = arg('base', `http://${new URL(env.APP_ORIGIN).hostname}`);
const ORIGIN = env.APP_ORIGIN;
const FILES = Number(arg('files', '40')), EDITORS = Number(arg('editors', '5')), BIG = Number(arg('big', '2'));
const BEFORE_S = Number(arg('before', '20')), AFTER_S = Number(arg('after', '20'));
// Ops per second per editor (1 = TARGETS' editor; higher = a busy file whose journal never idles during the drain).
const RATE = Number(arg('rate', '1'));
const NODE = arg('node', 'a');
const DRAIN = arg('drain', `systemctl stop morfa-collab@${NODE}`);
const OUT = arg('out', `/srv/morfa/bench/drain-drill-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const BIG_FIXTURE = arg('big-fixture', 'fixtures/bench/f20k.json');
const RECONNECT_LIMIT_MS = 5000;

const log = (line: string) => console.error(`[drill ${new Date().toISOString().slice(11, 23)}] ${line}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
// A role over verified TLS, as api connects (MORFA_DATABASE_CA_CERT_FILE): the runtime role for the drill, the migration role for
// the cleanup.
const pool = (url: string, max: number) => {
  const parsed = new URL(url);
  const verifyFull = parsed.searchParams.get('sslmode') === 'verify-full';
  parsed.searchParams.delete('sslmode');
  return new pg.Pool({
    connectionString: parsed.href, max,
    ssl: verifyFull ? {rejectUnauthorized: true, ca: readFileSync(env.MORFA_DATABASE_CA_CERT_FILE, 'utf8')} : false,
  });
};
const db = pool(env.MORFA_DATABASE_URL, 4);

/** The accounts of one run: `drill-<run>-<n>`, e-mail `drill-<run>-<n>@drill.invalid`, and nothing else. */
const RUN_ACCOUNTS = `SELECT id FROM users WHERE id LIKE $1 AND email = id || '@drill.invalid'`;
const runPattern = (run: string) => `drill-${run}-%`;

/** Deletes a run's accounts in one transaction (the schema's cascades take their sessions, teams, memberships, files and changes)
 *  and answers what went. Over the migration role: the runtime role may not delete accounts. */
async function cleanupRun(run: string): Promise<Record<string, number>> {
  const url = env.MORFA_MIGRATION_DATABASE_URL;
  if (!url) throw Error(`no MORFA_MIGRATION_DATABASE_URL in the env file: the run's accounts (drill-${run}-*) stay; remove them with --cleanup-only ${run} where it is set`);
  const admin = pool(url, 1);
  const client = await admin.connect();
  try {
    await client.query('BEGIN');
    const ids = (await client.query(RUN_ACCOUNTS + ' FOR UPDATE', [runPattern(run)])).rows.map(row => row.id as string);
    const count = async (sql: string) => Number((await client.query(sql, [ids])).rows[0].n);
    const files = 'SELECT id FROM design_files WHERE user_id = ANY($1) OR team_id IN (SELECT id FROM design_teams WHERE owner_id = ANY($1))';
    const removed = {
      accounts: ids.length,
      sessions: await count('SELECT count(*) AS n FROM sessions WHERE user_id = ANY($1)'),
      teams: await count('SELECT count(*) AS n FROM design_teams WHERE owner_id = ANY($1)'),
      files: await count(`SELECT count(*) AS n FROM (${files}) f`),
      changes: await count(`SELECT count(*) AS n FROM design_file_changes WHERE file_id IN (${files})`),
    };
    // Files first (a team file may have been made by an account of another team's run), then the accounts and all they own.
    await client.query(`DELETE FROM design_files WHERE id IN (${files})`, [ids]);
    await client.query('DELETE FROM design_teams WHERE owner_id = ANY($1)', [ids]);
    await client.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
    await client.query('COMMIT');
    return removed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await admin.end();
  }
}

type Account = {id: string; token: string};
async function accounts(count: number): Promise<Account[]> {
  const list = Array.from({length: count}, (_, n) => ({id: `drill-${RUN}-${n + 1}`, token: randomBytes(32).toString('hex')}));
  const digest = (s: string) => createHash('sha256').update(s).digest('hex');
  await db.query('INSERT INTO users(id,email,name,password) SELECT * FROM unnest($1::text[],$2::text[],$3::text[],$4::text[])',
    [list.map(a => a.id), list.map(a => `${a.id}@drill.invalid`), list.map((_, i) => `Editor ${i + 1}`), list.map(() => '')]);
  await db.query('INSERT INTO sessions(token,user_id,expires) SELECT * FROM unnest($1::text[],$2::text[],$3::bigint[])',
    [list.map(a => digest(a.token)), list.map(a => a.id), list.map(() => Date.now() + 6 * 3_600_000)]);
  return list;
}
async function team(owner: Account, members: Account[]): Promise<string> {
  const id = randomUUID();
  await db.query('INSERT INTO design_teams(id,name,owner_id) VALUES($1,$2,$3)', [id, 'Drill', owner.id]);
  const rows = [{id: owner.id, role: 'owner'}, ...members.map(m => ({id: m.id, role: 'editor'}))];
  await db.query('INSERT INTO design_team_members(team_id,user_id,role) SELECT $1, * FROM unnest($2::text[],$3::text[])', [id, rows.map(r => r.id), rows.map(r => r.role)]);
  return id;
}

// Production names the cookie __Host-forma_session (server/auth.ts); a non-production api (scripts/deploy/staging.sh) forma_session.
const COOKIE = arg('cookie', '__Host-forma_session');
const cookie = (account: Account) => `${COOKIE}=${account.token}`;
async function api<T>(account: Account, method: string, path: string, body?: unknown): Promise<{status: number; body: T}> {
  const response = await fetch(BASE + path, {method, headers: {cookie: cookie(account), ...(body ? {'content-type': 'application/json'} : {})}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60_000)});
  const text = await response.text();
  return {status: response.status, body: (text ? JSON.parse(text) : null) as T};
}

function smallDocument(layers: number): DesignDocument {
  const base = createDocument('page');
  const ids = Array.from({length: layers}, (_, i) => `r${i}`);
  const nodes: Record<string, SceneNode> = {...base.nodes, page: {...base.nodes.page, children: ids} as SceneNode};
  ids.forEach((id, i) => (nodes[id] = createNode('RECTANGLE', {id, parentId: 'page', x: 0, y: i * 40, width: 100, height: 30})));
  return {...base, nodes} as DesignDocument;
}

type FileSetup = {id: string; owner: Account; editors: Account[]; layers: SceneNode[]; big: boolean};
async function createFiles(): Promise<FileSetup[]> {
  const people = await accounts(FILES * EDITORS);
  const files: FileSetup[] = [];
  const bigDoc = BIG ? (JSON.parse(readFileSync(BIG_FIXTURE, 'utf8')) as DesignDocument) : null;
  for (let i = 0; i < FILES; i++) {
    if (stopping) throw Error('stopped');
    const editors = people.slice(i * EDITORS, (i + 1) * EDITORS);
    const teamId = await team(editors[0], editors.slice(1));
    const big = i < BIG && !!bigDoc;
    const document = big ? bigDoc! : smallDocument(EDITORS * 2);
    const created = await api<{file: {id: string}}>(editors[0], 'POST', '/api/design-files', {name: `Drill ${i + 1}`, document, teamId});
    if (created.status >= 300) throw Error(`create file ${i}: ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
    const nodes = Object.values(document.nodes).filter(node => node.type === 'RECTANGLE' || node.type === 'FRAME' || node.type === 'TEXT');
    files.push({id: created.body.file.id, owner: editors[0], editors, layers: nodes.slice(0, EDITORS), big});
  }
  return files;
}

type Ack = {seq: number; version: number};
class Editor {
  readonly clientId = `drill-${randomBytes(6).toString('hex')}`;
  seq = 0;
  known = 0;
  node: SceneNode;
  socket: WebSocket | null = null;
  connectedNode = '';
  nodes: string[] = [];
  readonly unacked = new Map<number, string>();
  readonly acked: Ack[] = [];
  readonly reconnects: {bye: string; downAt: number; upAt?: number; from: string; to?: string}[] = [];
  byes: Record<string, number> = {};
  refused: Record<string, number> = {};
  sending = true;
  constructor(readonly file: FileSetup, readonly account: Account, layer: SceneNode) {
    this.node = structuredClone(layer);
  }

  async connect(): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      const session = await api<{wsUrl: string; ticket: string; version: number; node: string; error?: string}>(this.account, 'GET', `/api/design-files/${this.file.id}/session`).catch(error => ({status: 0, body: {error: String(error)} as never}));
      if (session.status === 200) {
        await this.open(session.body.wsUrl, session.body.ticket, session.body.node);
        return;
      }
      await sleep(Math.min(1000, 100 * 2 ** attempt));
    }
  }

  private open(url: string, ticket: string, node: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // The browser's Origin (collab checks it against MORFA_COLLAB_ORIGINS and the ticket's origin).
      const socket = new WebSocket(url, {headers: {origin: ORIGIN}} as unknown as string[]);
      this.socket = socket;
      let welcomed = false;
      socket.onopen = () => socket.send(JSON.stringify({t: 'hello', ticket, clientId: this.clientId, since: this.known, lastSeq: this.seq, protocol: 1}));
      socket.onmessage = event => {
        const message = JSON.parse(String(event.data));
        switch (message.t) {
          case 'welcome': {
            welcomed = true;
            this.known = Math.max(this.known, message.version);
            this.connectedNode = node;
            this.nodes.push(node);
            const last = this.reconnects.at(-1);
            if (last && last.upAt === undefined) {
              last.upAt = Date.now();
              last.to = node;
            }
            // Ops sent and not acked go again with their seq: journaled ones are re-acked, the rest applied.
            for (const [, frame] of [...this.unacked.entries()].sort(([a], [b]) => a - b)) socket.send(frame);
            resolve();
            break;
          }
          case 'ack':
            this.known = Math.max(this.known, message.version);
            if (this.unacked.delete(message.seq)) this.acked.push({seq: message.seq, version: message.version});
            break;
          case 'refused':
            this.refused[message.code] = (this.refused[message.code] ?? 0) + 1;
            this.unacked.delete(message.seq);
            break;
          case 'change':
            this.known = Math.max(this.known, message.version);
            break;
          case 'bye':
            this.byes[message.reason] = (this.byes[message.reason] ?? 0) + 1;
            break;
        }
      };
      socket.onerror = () => {
        if (!welcomed) reject(Error('socket error before welcome'));
      };
      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (!welcomed) {
          reject(Error('closed before welcome'));
          return;
        }
        if (!this.sending && !this.unacked.size) return;
        const reason = Object.keys(this.byes).at(-1) ?? 'closed';
        this.reconnects.push({bye: reason, downAt: Date.now(), from: node});
        void this.connect().catch(error => log(`reconnect failed: ${String(error)}`));
      };
    });
  }

  /** One op: this editor's own layer moved to x = seq (so the final document shows the last op that landed). */
  tick() {
    if (!this.sending || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.seq++;
    const before = structuredClone(this.node);
    this.node = {...this.node, x: this.seq} as SceneNode;
    const frame = JSON.stringify({t: 'op', seq: this.seq, baseVersion: this.known, patch: {nodes: {[this.node.id]: this.node}}, before: {[this.node.id]: before}});
    this.unacked.set(this.seq, frame);
    this.socket.send(frame);
  }

  presence(step: number) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({t: 'presence', cursor: {x: step % 800, y: (step * 7) % 600}}));
  }
}

const holderOf = async (id: string) => (await db.query('SELECT collab_node, checkpoint_version, version FROM design_files WHERE id=$1', [id])).rows[0];

let stopping = false;
/** The setup in progress: a signal waits for it (it stops at its next step), so no insert commits after the cleanup. */
let setup: Promise<unknown> | null = null;
const sockets = new Set<Editor>();

async function main() {
  log(`run ${RUN}: setup: ${FILES} files (${BIG} of them ${BIG_FIXTURE}) × ${EDITORS} editors through ${BASE}`);
  const creating = createFiles();
  setup = creating;
  const files = await creating;
  const editors = files.flatMap(file => file.editors.map((account, k) => new Editor(file, account, file.layers[k])));
  editors.forEach(editor => sockets.add(editor));
  await Promise.all(editors.map(editor => editor.connect()));
  const onNode = (name: string) => editors.filter(editor => editor.connectedNode === name);
  log(`connected: ${editors.length} sockets, node a ${onNode('a').length}, node b ${onNode('b').length}`);
  const drainedFiles = new Set(onNode(NODE).map(editor => editor.file.id));
  const before = new Map<string, {checkpoint_version: string | null; version: string}>();
  for (const id of drainedFiles) before.set(id, await holderOf(id));

  let step = 0;
  const ops = setInterval(() => editors.forEach(editor => editor.tick()), Math.max(10, Math.round(1000 / RATE)));
  const cursors = setInterval(() => editors.forEach(editor => editor.presence(++step)), 200);
  await sleep(BEFORE_S * 1000);
  const drainStarted = Date.now();
  log(`draining node ${NODE} (${drainedFiles.size} files, ${onNode(NODE).length} sockets): ${DRAIN}`);
  execSync(DRAIN, {stdio: 'inherit'});
  const drainSeconds = (Date.now() - drainStarted) / 1000;
  log(`node ${NODE} stopped after ${drainSeconds.toFixed(1)} s`);
  await sleep(AFTER_S * 1000);
  clearInterval(ops);
  clearInterval(cursors);
  editors.forEach(editor => (editor.sending = false));
  // Everything sent is acked (re-sent after reconnects) before the check.
  const settleDeadline = Date.now() + 30_000;
  while (editors.some(editor => editor.unacked.size) && Date.now() < settleDeadline) await sleep(200);
  const unackedLeft = editors.reduce((sum, editor) => sum + editor.unacked.size, 0);

  // 1. Every acked op is in the journal at the version it was acked with.
  let ackedTotal = 0, missing = 0;
  const missingExamples: string[] = [];
  for (const editor of editors) {
    const rows = (await db.query('SELECT client_seq, version FROM design_file_changes WHERE file_id=$1 AND client_id=$2', [editor.file.id, editor.clientId])).rows as {client_seq: string; version: string}[];
    const journaled = new Map(rows.map(row => [Number(row.client_seq), Number(row.version)]));
    for (const ack of editor.acked) {
      ackedTotal++;
      if (journaled.get(ack.seq) !== ack.version) {
        missing++;
        if (missingExamples.length < 5) missingExamples.push(`${editor.file.id}/${editor.clientId}#${ack.seq}@${ack.version} → ${journaled.get(ack.seq) ?? 'none'}`);
      }
    }
  }
  // 2. The stored document (api's read: checkpoint + journal) holds each editor's last op.
  let documentsChecked = 0, documentMismatches = 0;
  for (const file of files) {
    const read = await api<{document: DesignDocument}>(file.owner, 'GET', `/api/design-files/${file.id}`);
    documentsChecked++;
    for (const editor of editors.filter(e => e.file === file)) {
      const lastAcked = Math.max(0, ...editor.acked.map(ack => ack.seq));
      if (read.body.document.nodes[editor.node.id]?.x !== lastAcked) documentMismatches++;
    }
  }
  // 3. Reconnects of the drained node's editors, bye → welcome on the other node.
  const moved = editors.filter(editor => drainedFiles.has(editor.file.id));
  const gaps = moved.flatMap(editor => editor.reconnects.filter(r => r.upAt).map(r => r.upAt! - r.downAt)).sort((a, b) => a - b);
  const notBack = moved.filter(editor => !editor.reconnects.length || editor.reconnects.some(r => !r.upAt)).length;
  const pct = (q: number) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.ceil(q * gaps.length) - 1)] : NaN;
  // 4. Checkpoints the drain wrote.
  let checkpointed = 0;
  for (const id of drainedFiles) {
    const after = await holderOf(id);
    if (Number(after.checkpoint_version ?? 0) > Number(before.get(id)?.checkpoint_version ?? 0)) checkpointed++;
  }
  const byes = editors.reduce<Record<string, number>>((all, editor) => {
    for (const [reason, count] of Object.entries(editor.byes)) all[reason] = (all[reason] ?? 0) + count;
    return all;
  }, {});
  const refused = editors.reduce<Record<string, number>>((all, editor) => {
    for (const [code, count] of Object.entries(editor.refused)) all[code] = (all[code] ?? 0) + count;
    return all;
  }, {});
  const result = {
    date: new Date().toISOString(), base: BASE, files: FILES, bigFileCount: BIG, editors: editors.length, opsPerSecondPerEditor: RATE, drainedNode: NODE,
    drainedFiles: drainedFiles.size, drainedSockets: moved.length, drainSeconds, opsSent: editors.reduce((s, e) => s + e.seq, 0),
    ackedTotal, missing, missingExamples, unackedLeft, documentsChecked, documentMismatches,
    reconnectMs: {count: gaps.length, p50: pct(0.5), p95: pct(0.95), max: gaps.at(-1) ?? NaN}, notBack,
    movedToOtherNode: moved.filter(editor => editor.connectedNode && editor.connectedNode !== NODE).length,
    checkpointed, byes, refused,
    bigFiles: files.filter(file => file.big).map(file => ({id: file.id, drained: drainedFiles.has(file.id)})),
    pass: missing === 0 && unackedLeft === 0 && documentMismatches === 0 && notBack === 0 && (gaps.at(-1) ?? Infinity) <= RECONNECT_LIMIT_MS && checkpointed === drainedFiles.size,
  };
  writeFileSync(OUT, JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  return result.pass;
}

/** Removes the run's rows once: at the end, on a failure or on a signal. */
let cleaned: Promise<void> | null = null;
function cleanup(): Promise<void> {
  cleaned ??= (async () => {
    stopping = true;
    if (setup) await Promise.race([setup.catch(() => undefined), sleep(15_000)]);
    for (const editor of sockets) {
      editor.sending = false;
      editor.socket?.close();
    }
    try {
      const removed = await cleanupRun(RUN);
      log(`run ${RUN}: removed ${Object.entries(removed).map(([what, n]) => `${n} ${what}`).join(', ')}`);
    } catch (error) {
      log(`run ${RUN}: cleanup failed: ${String(error)}; run --cleanup-only ${RUN}`);
      process.exitCode = 3;
    }
  })();
  return cleaned;
}

if (CLEANUP_ONLY) {
  const removed = await cleanupRun(RUN).catch(error => {
    console.error(`drain drill: ${String(error)}`);
    process.exit(3);
  });
  console.log(JSON.stringify({run: RUN, removed}));
  await db.end();
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const)
  process.once(signal, () => {
    log(`run ${RUN}: ${signal}: stopping and removing what the run made`);
    void cleanup().finally(() => process.exit(130));
  });

let pass = false;
try {
  pass = await main();
} catch (error) {
  log(`run ${RUN}: failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await cleanup();
  await db.end().catch(() => undefined);
}
process.exit(process.exitCode && process.exitCode !== 0 ? process.exitCode : pass ? 0 : 1);
