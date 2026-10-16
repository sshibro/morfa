import path from 'node:path';

// The api's side of the Rust co-editing service (docs/BACKEND.md §5, §7; lane B6): where the collab nodes are, the secret of
// their `/internal/*` routes and the key the socket tickets are signed with. Everything is read from the environment on each
// call (as flag.ts does), so a test may change it between requests; nothing here touches the database.
//
//   DESIGN_COLLAB_NODES            comma-separated `name=internal URL[|public URL]`, e.g. `a=http://10.0.0.5:3410|wss://a.example`;
//                                  `name` is the node's MORFA_COLLAB_NODE. Unset: no collab node, every file stays on the
//                                  legacy path whatever DESIGN_COLLAB says (/session answers 503).
//   DESIGN_COLLAB_INTERNAL_SECRET  the bearer secret of collab's /internal/* and of api's /internal/design-files (collab's
//                                  MORFA_COLLAB_INTERNAL_SECRET); at least 16 characters.
//   DESIGN_COLLAB_TICKET_KEY       the Ed25519 private key of the tickets, base64url of its 32-byte seed (`morfa-collab keygen`
//                                  prints it as MORFA_COLLAB_TICKET_PRIVATE_KEY; collab holds the public half).
//   DESIGN_COLLAB_WIRE             `json` (default) or `binary`: the socket wire /api/config names (designCollabWire).
//   DESIGN_COLLAB_SHADOW_LOG       the shadow comparison's mismatch log (JSON lines); default DATA_DIR/collab-shadow/mismatches.jsonl.
//   DESIGN_CHECKPOINT_DIR          where collab's checkpoint objects are when it writes them to a directory (its
//                                  MORFA_COLLAB_CHECKPOINT_DIR); with DESIGN_BLOBS=s3 they are read from the S3 bucket instead.

export type CollabNode = {name: string; internal: string; public: string};

const NODE_NAME = /^[A-Za-z0-9_.:-]{1,100}$/;
const MIN_SECRET_LENGTH = 16;

function httpUrl(text: string): string | null {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

function socketBase(text: string): string | null {
  try {
    const url = new URL(text);
    if (!['ws:', 'wss:', 'http:', 'https:'].includes(url.protocol)) return null;
    return url.href.replace(/\/+$/, '');
  } catch {
    return null;
  }
}

let parsedNodes: {text: string; nodes: CollabNode[]} | null = null;

/** The configured collab nodes, in the order given. An entry that does not parse is left out (and logged once). */
export function collabNodes(): CollabNode[] {
  const text = process.env.DESIGN_COLLAB_NODES ?? '';
  if (parsedNodes?.text === text) return parsedNodes.nodes;
  const nodes: CollabNode[] = [];
  for (const entry of text.split(',').map(part => part.trim()).filter(Boolean)) {
    const at = entry.indexOf('=');
    const name = at > 0 ? entry.slice(0, at) : '';
    const [internalText, publicText] = entry.slice(at + 1).split('|');
    const internal = httpUrl(internalText ?? '');
    const pub = socketBase(publicText || internalText || '');
    if (!NODE_NAME.test(name) || !internal || !pub) {
      console.error(`DESIGN_COLLAB_NODES: “${entry}” is not name=http(s)://host:port[|ws(s)://public]; left out.`);
      continue;
    }
    if (!nodes.some(node => node.name === name)) nodes.push({name, internal, public: pub});
  }
  parsedNodes = {text, nodes};
  return nodes;
}

export const collabNode = (name: string | null | undefined): CollabNode | undefined =>
  name ? collabNodes().find(node => node.name === name) : undefined;

/** Whether any collab node is configured: without one the api never contacts collab (no lease reads, no pushes). */
export const collabConfigured = () => collabNodes().length > 0;

/** The bearer secret of the internal routes, or null (then collab is never called and /internal answers 403). */
export function collabSecret(): string | null {
  const secret = process.env.DESIGN_COLLAB_INTERNAL_SECRET ?? '';
  return secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

export const collabWire = (): 'json' | 'binary' => (process.env.DESIGN_COLLAB_WIRE === 'binary' ? 'binary' : 'json');

export function shadowLogPath(): string {
  return process.env.DESIGN_COLLAB_SHADOW_LOG || path.join(process.env.DATA_DIR || 'data', 'collab-shadow', 'mismatches.jsonl');
}

/** The largest body collab's /internal/* routes read (crates/collab router.rs `INTERNAL_BODY_BYTES`: a whole document at the
 *  20 MB cap plus an 8 MB op and 1 MB of envelope) unless DESIGN_COLLAB_BODY_LIMIT says what a node was built with (2 MiB for
 *  builds before lane B1's third pass). Larger shadow seeds are skipped and larger replaces go the long way (collab/writes.ts). */
const COLLAB_BODY_LIMIT = (20 + 8 + 1) * 1024 * 1024;
export function collabBodyLimit(): number {
  const value = Number(process.env.DESIGN_COLLAB_BODY_LIMIT || COLLAB_BODY_LIMIT);
  return Number.isSafeInteger(value) && value > 0 ? value : COLLAB_BODY_LIMIT;
}

/** The socket URL of `file` on `node` (crates/collab: `GET /collab/:file`). */
export const socketUrlOf = (node: CollabNode, fileId: string) => `${node.public}/collab/${encodeURIComponent(fileId)}`;
