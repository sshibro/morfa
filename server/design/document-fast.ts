import {bigFilesEnabled} from '../../shared/design/big-files';
import {engineWasm, type MorfaWasm} from '../../shared/design/engine-switch';

// TARGETS S5's fast path for a whole document (a PUT, a version restore, up to 100 MB): the server's Rust reader
// (crates/wasm/src/server_document.rs) validates the JSON text by `validateDocument`'s rules and gives what `prepare()` stores
// with it, in one pass, without `JSON.parse` and the TypeScript schema over every layer. It only ever declines: a text it
// does not take goes through `JSON.parse` and `validateDocument` as before, which decide alone, so nothing is refused that was
// accepted. tests/design-server-document.test.ts proves the other half: nothing it accepts is refused by `validateDocument`,
// and it stores what that would store.

/** What the fast path gives for an accepted document. */
export type FastDocument = {
  /** The JSON text to store (the model's key order; the value `JSON.stringify(validateDocument(...))` would store). */
  text: Buffer;
  bytes: number;
  nodeCount: number;
  imageFiles: string[];
  /** The picture table, `{ref: {url}}` in its order (the check that each picture is the account's). */
  images: Record<string, {url: string}>;
};

const reads = {accepted: 0, declined: 0};
/** For tests and the bench: how many documents the fast path took and declined in this process (without the server build,
 *  every one is declined). */
export const fastDocumentReads = () => ({...reads});
const counted = <T>(value: T | undefined): T | undefined => (value === undefined ? reads.declined++ : reads.accepted++, value);

/** A lone surrogate code unit: the wasm boundary would turn it into U+FFFD, where `JSON.parse` keeps it. */
const LONE_SURROGATE = /\p{Cs}/u;

/** The server build's exports of crates/wasm/src/server_document.rs (feature `server`). */
type Read = {take_text(): Uint8Array; bytes: number; node_count: number; image_files: string[]; images: string; base_version: number | undefined; free(): void};
type Server = MorfaWasm & {read_server_document(json: string): Read | undefined; read_server_put(body: Uint8Array): Read | undefined};
/**
 * The server build with the model's caps in force (the big-files switch is read per request, as the TypeScript schema reads it),
 * or undefined when this process has none: no wasm built (a dev machine, the Mac gate), a module that failed to load, or a
 * build without the `server` feature. Every document then goes the TypeScript way, exactly as before S5.
 */
function server(): Server | undefined {
  let wasm: Server;
  try {
    wasm = engineWasm() as Server;
  } catch {
    return undefined;
  }
  if (typeof wasm.read_server_document !== 'function' || typeof wasm.read_server_put !== 'function') return undefined;
  wasm.set_big_files?.(bigFilesEnabled());
  return wasm;
}

function taken(read: Read): FastDocument {
  try {
    const text = read.take_text();
    return {
      text: Buffer.from(text.buffer, text.byteOffset, text.byteLength),
      bytes: read.bytes,
      nodeCount: read.node_count,
      imageFiles: read.image_files,
      images: JSON.parse(read.images) as Record<string, {url: string}>,
    };
  } finally {
    read.free();
  }
}

/** The document of `json` when the Rust reader accepts it; undefined when the TypeScript path must decide. */
export function readFastDocument(json: string): FastDocument | undefined {
  if (LONE_SURROGATE.test(json)) return counted(undefined);
  const read = server()?.read_server_document(json);
  return counted(read ? taken(read) : undefined);
}

/** A `PUT /:id/document` body (`{baseVersion, document}`, other keys ignored), its UTF-8 bytes without a BOM, when the Rust
 *  reader accepts its document; undefined when the route must read it as before (`JSON.parse`, the route's schema,
 *  `validateDocument`). Bytes that are not UTF-8 are declined (no lone surrogate can come this way). */
export function readFastPut(body: Uint8Array): {baseVersion: number; document: FastDocument} | undefined {
  const read = server()?.read_server_put(body);
  if (!read) return counted(undefined);
  const baseVersion = read.base_version;
  return counted(baseVersion === undefined ? (read.free(), undefined) : {baseVersion, document: taken(read)});
}
