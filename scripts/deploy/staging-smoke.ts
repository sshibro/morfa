// The staging stack's smoke (lane P3; scripts/deploy/staging.sh): everything a user touches, through the production edge
// (Caddy's sites and routes on the morfa.test names, TLS by its local CA: run with NODE_EXTRA_CA_CERTS).
//
//   tsx scripts/deploy/staging-smoke.ts smoke --env <api.env> --render-env <render.env> --domain morfa.test --state <dir> --out <json>
//       the edge (the base name moving to the app, HSTS, private paths 404, collab and updater names), name sign-in, a file created and
//       opened on the rust collab path (/session → wss://collab-<node>.<domain>, hello → welcome, ops acked and read back by
//       api), the vector PDF through api → morfa-render (X-Design-Pdf-Engine: service), an SVG from morfa-render
//   tsx scripts/deploy/staging-smoke.ts document --base <api> --file <id> --cookie <session> [--welcome --origin <app origin>]
//       {file, version, sha256} of the file's document as api reads it (canonical JSON); --welcome adds the version a collab
//       socket is welcomed at (the restore drill's check)
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {createDocument, createNode, defaultTextProps, solid} from '../../shared/design/defaults';
import type {DesignDocument, SceneNode} from '../../shared/design/types';
import {encodeRenderRequest, renderFaces} from '../../server/design/pdf/service';

const arg = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0) return process.argv[index + 1];
  if (fallback === undefined) throw Error(`--${name} is required`);
  return fallback;
};
const flag = (name: string) => process.argv.includes(`--${name}`);
const readEnv = (file: string) =>
  Object.fromEntries(readFileSync(file, 'utf8').split('\n').map(line => /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())).filter(Boolean).map(m => [m![1], m![2]])) as Record<string, string>;
const log = (line: string) => console.error(`[smoke ${new Date().toISOString().slice(11, 23)}] ${line}`);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sorted = (v: unknown): unknown =>
  Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])])) : v;

type Check = {name: string; pass: boolean; detail?: string};
const checks: Check[] = [];
function check(name: string, pass: boolean, detail?: string) {
  checks.push({name, pass, ...(detail ? {detail} : {})});
  log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

async function request(url: string, init: RequestInit & {cookie?: string; json?: unknown} = {}) {
  const {cookie, json, ...rest} = init;
  const headers: Record<string, string> = {...(rest.headers as Record<string, string>)};
  if (cookie) headers.cookie = cookie;
  if (json !== undefined) headers['content-type'] = 'application/json';
  // Writes need the app's Origin (server/http.ts refuses any other).
  if (rest.method && rest.method !== 'GET') headers.origin ??= new URL(url).origin;
  return fetch(url, {redirect: 'manual', ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body, signal: AbortSignal.timeout(60_000)});
}

/** hello → welcome on a collab socket; resolves with the socket and the welcome's version. */
function openSocket(wsUrl: string, ticket: string, origin: string, clientId: string) {
  return new Promise<{socket: WebSocket; version: number}>((resolve, reject) => {
    const socket = new WebSocket(wsUrl, {headers: {origin}} as unknown as string[]);
    const timer = setTimeout(() => reject(Error('no welcome in 20 s')), 20_000);
    socket.onopen = () => socket.send(JSON.stringify({t: 'hello', ticket, clientId, since: 0, lastSeq: 0, protocol: 1}));
    socket.onerror = () => reject(Error('socket error'));
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data));
      if (message.t === 'welcome') {
        clearTimeout(timer);
        resolve({socket, version: message.version});
      } else if (message.t === 'bye') reject(Error(`bye ${message.reason}`));
    };
  });
}

async function documentOf(base: string, file: string, cookie: string) {
  const response = await request(`${base}/api/design-files/${file}`, {cookie});
  if (!response.ok) throw Error(`GET file: ${response.status}`);
  const body = (await response.json()) as {file: {version: number}; document: DesignDocument};
  const sha256 = createHash('sha256').update(JSON.stringify(sorted(body.document))).digest('hex');
  return {version: Number(body.file.version), sha256, document: body.document};
}

async function smoke() {
  const env = readEnv(arg('env'));
  const renderEnv = readEnv(arg('render-env'));
  const domain = arg('domain');
  const state = arg('state');
  const app = `https://app.${domain}`, base = `https://${domain}`;

  // 1. The edge.
  // The base name has no site: it moves to the app (deploy/caddy/morfa-sites.caddy).
  let response = await request(base + '/files/1?a=1');
  check('base name → app (308)', response.status === 308 && response.headers.get('location') === `${app}/files/1?a=1`, `${response.status} ${response.headers.get('location')}`);
  check('HSTS on the base name', /max-age=31536000; includeSubDomains/.test(response.headers.get('strict-transport-security') ?? ''));
  response = await request(app + '/');
  check('app https://app.' + domain, response.status === 200 && (await response.text()).includes('<div id="root">'), `${response.status}`);
  check('HSTS on the app', !!response.headers.get('strict-transport-security'));
  for (const path of ['/internal/design-files', '/metrics', '/healthz']) {
    response = await request(app + path);
    check(`app ${path} is not routed`, response.status === 404, `${response.status}`);
  }
  response = await request(`https://collab-a.${domain}/healthz`);
  check('collab-a name routes only the socket path', response.status === 404, `${response.status}`);
  response = await request(`https://updates.${domain}/desktop/linux/x86_64/0.1.0`);
  check('updater: 204 while no update is uploaded', response.status === 204, `${response.status}`);
  response = await request(`${base}/api/health`);
  check('the base name does not serve the api', response.status === 404, `${response.status}`);
  // The private metrics site (deploy/caddy/morfa-metrics.caddy; staging binds it on loopback): each service's /metrics only.
  response = await fetch('http://127.0.0.1:9400/collab-a/metrics');
  const metricsText = await response.text();
  check('metrics site: collab a /metrics', response.status === 200 && metricsText.includes('# TYPE'), `${response.status}`);
  response = await fetch('http://127.0.0.1:9400/api-1/metrics');
  check('metrics site: api-1 /metrics', response.status === 200 && (await response.text()).includes('# TYPE'), `${response.status}`);
  response = await fetch('http://127.0.0.1:9400/collab-a/internal/docs');
  check('metrics site: nothing but /metrics', response.status === 404, `${response.status}`);

  // 2. Name sign-in through the edge.
  response = await request(app + '/api/auth/name', {method: 'POST', json: {name: 'Staging'}, headers: {origin: app}});
  const setCookie = response.headers.get('set-cookie') ?? '';
  const cookie = /^(forma_session=[^;]+)/.exec(setCookie)?.[1] ?? '';
  check('name sign-in', response.status === 200 && !!cookie, `${response.status}`);
  if (!cookie) throw Error('no session: the rest cannot run');
  writeFileSync(`${state}/smoke-cookie`, cookie, {mode: 0o600});
  response = await request(app + '/api/config', {cookie});
  const config = (await response.json()) as Record<string, unknown>;
  check('/api/config: vector PDF on', config.designPdf === true, JSON.stringify({designPdf: config.designPdf}));

  // 3. A file: created, its document written, opened on the rust collab path.
  response = await request(app + '/api/design-files', {method: 'POST', cookie, json: {name: 'Staging'}});
  const created = (await response.json()) as {file: {id: string; version: number}};
  check('file created', response.status === 201, `${response.status}`);
  const file = created.file.id;
  const doc = createDocument('page');
  const add = (node: SceneNode) => {
    doc.nodes[node.id] = node;
    const parent = doc.nodes[node.parentId!];
    parent.children = [...(parent.children ?? []), node.id];
  };
  add(createNode('FRAME', {id: 'poster', parentId: 'page', x: 0, y: 0, width: 600, height: 400, fills: [solid({r: 1, g: 1, b: 1})]}));
  const title = createNode('TEXT', {id: 'title', parentId: 'poster', x: 40, y: 40, width: 480, height: 60});
  // Cyrillic on purpose: the PDF below must embed a font with Cyrillic glyphs.
  title.text = {...defaultTextProps('Привет, Morfa — staging'), textAutoResize: 'NONE', style: {...defaultTextProps().style, fontSize: 32, fontWeight: 700}};
  add(title);
  add(createNode('RECTANGLE', {id: 'card', parentId: 'poster', x: 40, y: 140, width: 240, height: 160, cornerRadius: 16}));
  response = await request(`${app}/api/design-files/${file}/document`, {method: 'PUT', cookie, json: {baseVersion: created.file.version, document: doc}});
  check('document written', response.status === 200, `${response.status}`);

  response = await request(`${app}/api/design-files/${file}/session`, {cookie});
  const session = (await response.json()) as {wsUrl: string; ticket: string; node: string; version: number};
  check('/session names a collab node', response.status === 200 && /^wss:\/\/collab-[ab]\./.test(session.wsUrl ?? ''), `${response.status} ${session.wsUrl}`);
  const {socket, version: welcomed} = await openSocket(session.wsUrl, session.ticket, app, 'staging-smoke');
  check('socket welcomed through the edge', welcomed >= 1, `node ${session.node}, version ${welcomed}`);
  const acks: number[] = [];
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    if (message.t === 'ack') acks.push(message.version);
  };
  let card = structuredClone(doc.nodes.card);
  const OPS = 20;
  for (let seq = 1; seq <= OPS; seq++) {
    const before = card;
    card = {...card, x: 40 + seq} as SceneNode;
    socket.send(JSON.stringify({t: 'op', seq, baseVersion: welcomed + seq - 1, patch: {nodes: {card}}, before: {card: before}}));
    await sleep(20);
  }
  for (let i = 0; i < 100 && acks.length < OPS; i++) await sleep(100);
  check(`${OPS} ops acked by collab`, acks.length === OPS, `${acks.length} acks, last version ${acks.at(-1)}`);
  socket.close();
  await sleep(300);
  const read = await documentOf(app, file, cookie);
  check('api reads the collab edits back (checkpoint + journal)', read.document.nodes.card?.x === 40 + OPS && read.version === acks.at(-1), `card.x ${read.document.nodes.card?.x}, version ${read.version}`);

  // 4. The vector PDF through api → morfa-render.
  response = await request(`${app}/api/design-files/${file}/export/pdf`, {method: 'POST', cookie, json: {version: read.version, nodeIds: ['poster'], title: 'Staging', measurements: {fonts: [], widths: []}}});
  const pdf = Buffer.from(await response.arrayBuffer());
  check('PDF through morfa-render', response.status === 200 && pdf.subarray(0, 5).toString() === '%PDF-' && response.headers.get('x-design-pdf-engine') === 'service',
    `${response.status}, engine ${response.headers.get('x-design-pdf-engine')}, ${pdf.length} bytes`);
  writeFileSync(`${state}/results/smoke.pdf`, pdf);

  // 5. An SVG from morfa-render (the api routes only the PDF there today; the service's own svg job, as api would send it).
  const {faces} = renderFaces(['Inter']);
  const body = encodeRenderRequest({kind: 'svg', account: 'staging', ids: ['poster'], measure: 'fonts', fonts: faces, pictures: []}, JSON.stringify(read.document), []);
  response = await fetch(`http://${renderEnv.MORFA_RENDER_ADDR}/internal/render`, {method: 'POST', headers: {authorization: `Bearer ${renderEnv.MORFA_RENDER_INTERNAL_SECRET}`, 'content-type': 'application/octet-stream'}, body: new Uint8Array(body)});
  const svg = await response.text();
  check('SVG from morfa-render', response.status === 200 && svg.includes('<svg') && svg.includes('</svg>'), `${response.status}, ${svg.length} bytes`);
  writeFileSync(`${state}/results/smoke.svg`, svg);
  response = await fetch(`http://${renderEnv.MORFA_RENDER_ADDR}/internal/render`, {method: 'POST', body: new Uint8Array(body)});
  check('morfa-render refuses a job without the secret', response.status === 403 || response.status === 401, `${response.status}`);

  const result = {date: new Date().toISOString(), app, file, version: read.version, node: session.node, collab: env.DESIGN_COLLAB, checks, pass: checks.every(c => c.pass)};
  writeFileSync(arg('out'), JSON.stringify(result, null, 1));
  console.log(JSON.stringify(result, null, 1));
  process.exit(result.pass ? 0 : 1);
}

async function document() {
  const base = arg('base'), file = arg('file'), cookie = arg('cookie');
  const read = await documentOf(base, file, cookie);
  let welcome: number | string | undefined;
  if (flag('welcome')) {
    // A restored database still holds the old nodes' leases (lease_until from the moment restored): the restored api, which
    // knows only its own node, answers 503 until they run out (LEASE_TTL_MS, 15 s). Retried for 30 s.
    let response = await request(`${base}/api/design-files/${file}/session`, {cookie});
    for (let waited = 0; response.status === 503 && waited < 30_000; waited += 1000) {
      await sleep(1000);
      response = await request(`${base}/api/design-files/${file}/session`, {cookie});
    }
    if (response.status !== 200) welcome = `session ${response.status}`;
    else {
      const session = (await response.json()) as {wsUrl: string; ticket: string};
      welcome = await openSocket(session.wsUrl, session.ticket, arg('origin'), 'staging-restore').then(
        ({socket, version}) => (socket.close(), version),
        error => String(error),
      );
    }
  }
  console.log(JSON.stringify({file, version: read.version, sha256: read.sha256, ...(welcome !== undefined ? {welcome} : {})}));
  process.exit(0);
}

const command = process.argv[2];
if (command === 'smoke') await smoke();
else if (command === 'document') await document();
else {
  console.error('staging-smoke.ts smoke|document (see the head of this file)');
  process.exit(2);
}
