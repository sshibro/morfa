import {spawn, type ChildProcess} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createServer} from 'node:net';
import {ticketPublicKey} from '../../server/design/collab/tickets';

// Lane B1's `morfa-collab` binary for the api's collab tests (lane B6): found in MORFA_COLLAB_BIN, $CARGO_TARGET_DIR, the gate's
// target directory (~/.cache/morfa-target/gate, scripts/gate.sh builds it with `cargo test --workspace`) or ./target; release
// before debug. Each test starts its own process on a free port with its own secret and ticket key.

export function collabBinary(): string | null {
  const dirs = [process.env.CARGO_TARGET_DIR, path.join(os.homedir(), '.cache/morfa-target/gate'), 'target'].filter((dir): dir is string => !!dir);
  const candidates = [process.env.MORFA_COLLAB_BIN, ...dirs.flatMap(dir => [path.join(dir, 'release/morfa-collab'), path.join(dir, 'debug/morfa-collab')])];
  return candidates.find((file): file is string => !!file && fs.existsSync(file)) ?? null;
}

/** The binary, or a failure that says how to build it (the gate builds it before these tests run). */
export function requireCollabBinary(): string {
  const bin = collabBinary();
  if (!bin) throw Error('morfa-collab is not built: CARGO_TARGET_DIR=~/.cache/morfa-target/gate cargo build -p morfa-collab (or set MORFA_COLLAB_BIN).');
  return bin;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as {port: number}).port;
      server.close(() => resolve(port));
    });
  });
}

/** A fresh Ed25519 pair: the private seed for api (DESIGN_COLLAB_TICKET_KEY) and the public key for collab. */
export function ticketKeys(): {privateKey: string; publicKey: string} {
  const {privateKey} = generateKeyPairSync('ed25519');
  const der = privateKey.export({format: 'der', type: 'pkcs8'}) as Buffer;
  return {privateKey: der.subarray(der.length - 32).toString('base64url'), publicKey: ticketPublicKey(privateKey)};
}

export type Collab = {
  node: string;
  port: number;
  url: string;
  secret: string;
  child: ChildProcess;
  /** The api's settings for this node (DESIGN_COLLAB_*). */
  apiEnv: Record<string, string>;
  internal<T = any>(method: 'GET' | 'POST', route: string, body?: unknown): Promise<{status: number; body: T}>;
  log(): string;
  stop(): Promise<void>;
};

export type CollabOptions = {
  /** PostgreSQL for lane B2's journal, lease and checkpoint pointers (the test's runtime database). Unset: in memory. */
  pgUrl?: string;
  /** Checkpoint objects go here (MORFA_COLLAB_CHECKPOINT_DIR); the api reads them through DESIGN_CHECKPOINT_DIR. */
  checkpointDir?: string;
  /** api's base URL for the 20 s re-validation (MORFA_COLLAB_API_URL). */
  apiUrl?: string;
  node?: string;
  /** A port, secret and key pair chosen before the start (the bench: the api is started first with them). */
  port?: number;
  secret?: string;
  keys?: {privateKey: string; publicKey: string};
  env?: Record<string, string>;
};

export async function startCollab(options: CollabOptions = {}): Promise<Collab> {
  const bin = requireCollabBinary();
  const port = options.port ?? (await freePort());
  const node = options.node ?? 'n' + port;
  const secret = options.secret ?? 'collab-test-secret-' + Math.random().toString(36).slice(2);
  const keys = options.keys ?? ticketKeys();
  const checkpointDir = options.checkpointDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'b6-collab-ckpt-'));
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    MORFA_COLLAB_ADDR: `127.0.0.1:${port}`,
    MORFA_COLLAB_NODE: node,
    MORFA_COLLAB_TICKET_KEY: keys.publicKey,
    MORFA_COLLAB_INTERNAL_SECRET: secret,
    MORFA_COLLAB_CHECKPOINT_DIR: checkpointDir,
    MORFA_COLLAB_SHARDS: '1',
    // A stop drains the node at once (crates/collab/src/drain.rs: no notice for api's health check in tests).
    MORFA_COLLAB_DRAIN_NOTICE_MS: '0',
    RUST_LOG: process.env.MORFA_COLLAB_LOG ?? 'warn',
    ...(options.pgUrl ? {MORFA_COLLAB_PG_URL: options.pgUrl} : {}),
    ...(options.apiUrl ? {MORFA_COLLAB_API_URL: options.apiUrl} : {}),
    ...options.env,
  };
  const child = spawn(bin, ['serve'], {env, stdio: ['ignore', 'ignore', 'pipe']});
  let stderr = '';
  child.stderr!.on('data', chunk => {
    stderr = (stderr + chunk).slice(-20_000);
  });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (await fetch(url + '/healthz').then(r => r.ok, () => false)) break;
    if (child.exitCode !== null) throw Error(`morfa-collab exited: ${stderr}`);
    if (i > 400) throw Error(`morfa-collab did not answer /healthz: ${stderr}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return {
    node,
    port,
    url,
    secret,
    child,
    apiEnv: {
      DESIGN_COLLAB_NODES: `${node}=${url}`,
      DESIGN_COLLAB_INTERNAL_SECRET: secret,
      DESIGN_COLLAB_TICKET_KEY: keys.privateKey,
      DESIGN_CHECKPOINT_DIR: checkpointDir,
    },
    async internal(method, route, body) {
      const response = await fetch(url + route, {
        method,
        headers: {authorization: `Bearer ${secret}`, ...(body !== undefined ? {'content-type': 'application/json'} : {})},
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return {status: response.status, body: text ? JSON.parse(text) : null};
    },
    log: () => stderr,
    async stop() {
      if (child.exitCode === null) {
        child.kill('SIGINT');
        await new Promise(resolve => {
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            resolve(null);
          }, 5_000);
          child.once('exit', () => {
            clearTimeout(timer);
            resolve(null);
          });
        });
      }
      if (!options.checkpointDir) fs.rmSync(checkpointDir, {recursive: true, force: true});
    },
  };
}
