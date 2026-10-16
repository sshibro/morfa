import {readConfig, type AppConfig} from '../../../auth/session';
import {accountHeaders, sseTransport} from './sse';
import type {LiveTransport} from './types';
import type {WasmWire} from './ws';

// Which transport an open file uses (docs/BACKEND.md §7): GET /api/design-files/:id/collab says `designCollab` for the file —
// `legacy` (today), `shadow` (the server mirrors saves to collab; the editor stays on SSE) or `rust` (the socket) — as the
// server decides it (its team's mode, then its holder's), so every member of a file is on one path. Without that answer (an
// older api, the network) GET /api/config's mode for this account decides.
// `designCollabWire: 'binary'` switches the socket to the binary wire (`?wire=bin`) through the WASM build's
// `decode_frame`/`encode_frame` (registered with `setWasmWire`, realtime/index.tsx); whenever it cannot load, the
// socket speaks JSON text frames.

export type CollabMode = 'legacy' | 'shadow' | 'rust';

export function collabMode(config: AppConfig): CollabMode {
  const value = config.designCollab;
  return value === 'rust' || value === 'shadow' ? value : 'legacy';
}

/** The WASM exports for the binary wire (crates/wasm `decode_frame`, `encode_frame`). Null (Node, the tests): the
 *  socket speaks JSON. */
let wasmWire: (() => Promise<WasmWire | null>) | null = null;
export function setWasmWire(load: (() => Promise<WasmWire | null>) | null) {
  wasmWire = load;
}

/** The socket's code is a chunk of its own: the SSE path never loads it. */
const loadWs = () => import('./ws');

/** The file's own mode and wire (GET /api/design-files/:id/collab); null when the api does not answer it. */
export async function readFileCollab(fileId: string): Promise<AppConfig | null> {
  try {
    const response = await fetch(`/api/design-files/${encodeURIComponent(fileId)}/collab`, {credentials: 'same-origin', headers: accountHeaders()});
    if (!response.ok) return null;
    const answer = (await response.json()) as AppConfig;
    return typeof answer?.designCollab === 'string' ? answer : null;
  } catch {
    return null;
  }
}

/** The transport for `fileId`: its own mode when the api says it, else the account's (`read`). */
export async function pickTransport(read: () => Promise<AppConfig> = readConfig, fileId?: string, readFile = readFileCollab): Promise<LiveTransport> {
  const config = (fileId ? await readFile(fileId) : null) ?? (await read());
  if (collabMode(config) !== 'rust') return sseTransport();
  const {wsTransport, jsonCodec, binaryCodec} = await loadWs();
  let codec = jsonCodec;
  if (config.designCollabWire === 'binary' && wasmWire) {
    const wasm = await wasmWire().catch(() => null);
    if (wasm) codec = binaryCodec(wasm);
  }
  return wsTransport({codec});
}
