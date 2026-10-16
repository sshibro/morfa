// Checks a host's settings before a release: every file of /etc/morfa that the units
// read, against each other — placeholders left from the *.example files, the secrets api and collab/render must share, the
// ticket key pair, the origins and public names Caddy serves, the flags that must agree between api and collab. It never prints a
// value: only the variable and what is wrong with it.
//
//   node --import tsx scripts/deploy/preflight.ts [--etc /etc/morfa] [--staging]
//     --staging   the local staging stack (scripts/deploy/staging.sh): the development sign-in and plain-HTTP loopback S3 allowed
// bench-ru's settings (caddy.env with MORFA_BENCH_IP and no domain) are recognised: ws:// sockets and loopback MinIO pass there.
//
// Exit 0: nothing wrong (warnings may be printed); 1: at least one problem. host.sh runs it before switching a release.
import {createPrivateKey, createPublicKey} from 'node:crypto';
import {existsSync, readFileSync} from 'node:fs';
import path from 'node:path';

const arg = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
};
const ETC = arg('etc', '/etc/morfa');
const STAGING = process.argv.includes('--staging');

type Env = Record<string, string>;
/** An env file as systemd's EnvironmentFile and `set -a; .` read it (one level of quotes). */
function readEnv(name: string): Env | null {
  const file = path.join(ETC, name);
  if (!existsSync(file)) return null;
  const env: Env = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) env[match[1]] = match[2].trim().replace(/^'(.*)'$|^"(.*)"$/, '$1$2');
  }
  return env;
}

const problems: string[] = [];
const warnings: string[] = [];
const problem = (where: string, text: string) => problems.push(`${where}: ${text}`);
const warn = (where: string, text: string) => warnings.push(`${where}: ${text}`);

const api = readEnv('api.env');
const collab = readEnv('collab.env');
const render = readEnv('render.env');
const caddy = readEnv('caddy.env');
// bench-ru (scripts/deploy/remote/bench-ru.sh): no domain, plain ws:// through Caddy's :80 site, MinIO on loopback HTTP.
const BENCH = !!caddy?.MORFA_BENCH_IP && !caddy?.MORFA_MARKETING_DOMAIN;
const RELAXED = STAGING || BENCH;
if (!api) problem('api.env', 'missing');
if (!collab) problem('collab.env', 'missing');

// Placeholders the *.example files carry.
for (const [name, env] of Object.entries({'api.env': api, 'collab.env': collab, 'render.env': render, 'caddy.env': caddy})) {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (/CHANGE_ME|example\.invalid/.test(value) && !(key === 'MORFA_ACME_EMAIL' && STAGING)) problem(name, `${key} still holds the example's placeholder`);
  }
}

const url = (text: string | undefined): URL | null => {
  try {
    return text ? new URL(text) : null;
  } catch {
    return null;
  }
};
const required = (name: string, env: Env | null, key: string) => {
  const value = env?.[key];
  if (!value) problem(name, `${key} is not set`);
  return value ?? '';
};
const secretPair = (a: [string, Env | null, string], b: [string, Env | null, string]) => {
  const [an, ae, ak] = a, [bn, be, bk] = b;
  const av = required(an, ae, ak), bv = required(bn, be, bk);
  if (av && av.length < 16) problem(an, `${ak} is shorter than 16 characters`);
  if (av && bv && av !== bv) problem(`${an} / ${bn}`, `${ak} and ${bk} must be the same secret`);
};

if (api && collab) {
  // The origin and the database.
  const origin = required('api.env', api, 'APP_ORIGIN');
  const originUrl = url(origin);
  if (!originUrl || originUrl.protocol !== 'https:' || originUrl.origin !== origin) problem('api.env', 'APP_ORIGIN must be an https origin with no path or trailing slash');
  for (const key of ['MORFA_DATABASE_URL', 'MORFA_MIGRATION_DATABASE_URL', 'MORFA_BACKUP_DATABASE_URL']) {
    const db = url(required('api.env', api, key));
    if (!db) continue;
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(db.hostname);
    const mode = db.searchParams.get('sslmode');
    // server/postgresql/config.ts: verify-full (production's default) or disable on loopback only.
    const verify = mode === 'verify-full' || (!mode && (!STAGING || !local));
    if (mode && !['verify-full', 'disable'].includes(mode)) problem('api.env', `${key}: sslmode must be verify-full or disable`);
    if (verify && !api.MORFA_DATABASE_CA_CERT_FILE && !api.MORFA_DATABASE_CA_CERT) problem('api.env', `${key}: verify-full needs MORFA_DATABASE_CA_CERT_FILE`);
    if (mode === 'disable' && !local) problem('api.env', `${key}: a database off this machine needs sslmode=verify-full`);
  }
  if (api.MORFA_DATABASE_CA_CERT_FILE && !existsSync(api.MORFA_DATABASE_CA_CERT_FILE)) problem('api.env', 'MORFA_DATABASE_CA_CERT_FILE names a file that does not exist');
  const roles = ['MORFA_DATABASE_URL', 'MORFA_MIGRATION_DATABASE_URL', 'MORFA_BACKUP_DATABASE_URL'].map(key => url(api[key])?.username);
  if (new Set(roles).size !== 3) problem('api.env', 'the runtime, migration and backup URLs must use three different roles');
  const collabDb = url(required('collab.env', collab, 'MORFA_COLLAB_PG_URL'));
  const runtime = url(api.MORFA_DATABASE_URL);
  if (collabDb && runtime && (collabDb.hostname !== runtime.hostname || collabDb.port !== runtime.port || collabDb.pathname !== runtime.pathname))
    problem('collab.env', "MORFA_COLLAB_PG_URL must name api's database (same host, port and database)");

  // Co-editing: the nodes, the shared secret, the ticket key pair, the origins.
  const nodes = (api.DESIGN_COLLAB_NODES ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  if (!nodes.length) warn('api.env', 'DESIGN_COLLAB_NODES is empty: every file stays on the legacy path');
  for (const entry of nodes) {
    const [name, rest = ''] = entry.split('=');
    const [internal, pub] = rest.split('|');
    if (!url(internal)) problem('api.env', `DESIGN_COLLAB_NODES: node ${name}'s private URL does not parse`);
    const pubUrl = url(pub);
    if (!pubUrl) problem('api.env', `DESIGN_COLLAB_NODES: node ${name} has no public socket base`);
    else if (pubUrl.protocol !== 'wss:' && !RELAXED) problem('api.env', `DESIGN_COLLAB_NODES: node ${name}'s public base must be wss://`);
    else if (!BENCH && caddy?.MORFA_MARKETING_DOMAIN && pubUrl.hostname !== `collab-${name}.${caddy.MORFA_MARKETING_DOMAIN}` && pubUrl.hostname !== caddy.MORFA_DOMAIN)
      problem('api.env', `DESIGN_COLLAB_NODES: node ${name}'s public base is not a name Caddy serves (collab-${name}.${caddy.MORFA_MARKETING_DOMAIN} or ${caddy.MORFA_DOMAIN}/n/${name})`);
    if (existsSync(ETC) && existsSync(path.join(ETC, `collab-${name}.env`))) {
      const own = readEnv(`collab-${name}.env`)!;
      if (own.MORFA_COLLAB_NODE !== name) problem(`collab-${name}.env`, `MORFA_COLLAB_NODE must be ${name}`);
      const addr = own.MORFA_COLLAB_ADDR ?? '';
      if (internal && url(internal) && url(internal)!.host !== addr) problem(`collab-${name}.env`, `MORFA_COLLAB_ADDR differs from api's private URL of node ${name}`);
    } else if (!STAGING) problem(`collab-${name}.env`, 'missing (morfa-collab@' + name + ' reads it)');
  }
  secretPair(['api.env', api, 'DESIGN_COLLAB_INTERNAL_SECRET'], ['collab.env', collab, 'MORFA_COLLAB_INTERNAL_SECRET']);
  const seed = required('api.env', api, 'DESIGN_COLLAB_TICKET_KEY'), pub = required('collab.env', collab, 'MORFA_COLLAB_TICKET_KEY');
  if (seed && pub) {
    try {
      // Ed25519 from its 32-byte seed (PKCS#8 prefix), as crates/protocol's ticket keys are.
      const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(seed, 'base64url')]);
      const derived = createPublicKey(createPrivateKey({key: der, format: 'der', type: 'pkcs8'})).export({format: 'der', type: 'spki'}).subarray(-32).toString('base64url');
      if (derived !== pub.replace(/=+$/, '')) problem('api.env / collab.env', "DESIGN_COLLAB_TICKET_KEY's public half is not collab's MORFA_COLLAB_TICKET_KEY (`morfa-collab keygen` prints both)");
    } catch {
      problem('api.env', 'DESIGN_COLLAB_TICKET_KEY is not a base64url Ed25519 seed');
    }
  }
  const origins = (collab.MORFA_COLLAB_ORIGINS ?? '').split(',').map(o => o.trim());
  if (!STAGING && !origins.includes(origin)) problem('collab.env', 'MORFA_COLLAB_ORIGINS must include APP_ORIGIN (sockets from the app are refused otherwise)');
  const drain = Number(collab.MORFA_COLLAB_DRAIN_TIMEOUT_MS ?? 25_000);
  if (!(drain > 0 && drain < 30_000)) problem('collab.env', "MORFA_COLLAB_DRAIN_TIMEOUT_MS must stay below the unit's TimeoutStopSec (30 s)");
  if ((api.DESIGN_BIG_FILES ?? '0') !== (collab.MORFA_BIG_FILES ?? '0')) problem('api.env / collab.env', 'DESIGN_BIG_FILES and MORFA_BIG_FILES must agree');
  const memory = collab.MORFA_COLLAB_MEMORY_LIMIT_MB;
  if (!memory) warn('collab.env', 'MORFA_COLLAB_MEMORY_LIMIT_MB unset: a node opens files until the VM runs out of memory');

  // Checkpoints and pictures: api reads the bucket collab writes.
  if (api.DESIGN_BLOBS === 's3') {
    for (const [a, c] of [['DESIGN_S3_ENDPOINT', 'MORFA_COLLAB_S3_ENDPOINT'], ['DESIGN_S3_BUCKET', 'MORFA_COLLAB_S3_BUCKET'], ['DESIGN_S3_REGION', 'MORFA_COLLAB_S3_REGION']]) {
      if (required('api.env', api, a) !== required('collab.env', collab, c)) problem('api.env / collab.env', `${a} and ${c} must name the same bucket`);
    }
    const endpoint = url(api.DESIGN_S3_ENDPOINT);
    if (endpoint && endpoint.protocol !== 'https:' && !RELAXED) problem('api.env', 'DESIGN_S3_ENDPOINT must be https (Timeweb: https://s3.timeweb.cloud)');
  } else if (collab.MORFA_COLLAB_S3_ENDPOINT) problem('api.env', "DESIGN_BLOBS must be s3: collab writes checkpoints to S3 and api must read them");

  // Export through morfa-render.
  const engine = (api.DESIGN_PDF_ENGINE ?? 'chromium').toLowerCase();
  if (!['chromium', 'wasm', 'service'].includes(engine)) problem('api.env', 'DESIGN_PDF_ENGINE must be chromium, wasm or service');
  if (engine === 'service') {
    const renderUrl = url(required('api.env', api, 'DESIGN_RENDER_URL'));
    if (!render) problem('render.env', 'missing (DESIGN_PDF_ENGINE=service)');
    else {
      secretPair(['api.env', api, 'DESIGN_RENDER_SECRET'], ['render.env', render, 'MORFA_RENDER_INTERNAL_SECRET']);
      if (renderUrl && renderUrl.host !== (render.MORFA_RENDER_ADDR ?? '127.0.0.1:3440')) problem('api.env', "DESIGN_RENDER_URL is not render.env's MORFA_RENDER_ADDR");
      if (!render.MORFA_RENDER_FONTS_DIR) warn('render.env', 'MORFA_RENDER_FONTS_DIR unset: text is drawn in no face');
    }
  }

  // The edge.
  if (caddy && !BENCH) {
    if (originUrl && caddy.MORFA_DOMAIN !== originUrl.hostname) problem('caddy.env', "MORFA_DOMAIN must be APP_ORIGIN's host");
    if (!caddy.MORFA_MARKETING_DOMAIN) problem('caddy.env', 'MORFA_MARKETING_DOMAIN is not set (the base name for downloads, collab-*, updates. names)');
    const upstreams = (caddy.MORFA_API_UPSTREAMS ?? '').split(/\s+/).filter(Boolean);
    if (upstreams.length < 2) warn('caddy.env', 'one api upstream: a rolling restart has nowhere to send requests');
    if (!STAGING && !caddy.MORFA_ACME_EMAIL) problem('caddy.env', 'MORFA_ACME_EMAIL is not set');
  } else if (!caddy) problem('caddy.env', 'missing');
}

for (const line of warnings) console.log(`warn  ${line}`);
for (const line of problems) console.log(`FAIL  ${line}`);
console.log(problems.length ? `preflight: ${problems.length} problem(s) in ${ETC}` : `preflight: ${ETC} ok${warnings.length ? ` (${warnings.length} warning(s))` : ''}`);
process.exit(problems.length ? 1 : 0);
