import {promisify} from 'node:util';
import {constants, gzip, zstdCompress, zstdDecompress} from 'node:zlib';
import {engineWasm} from '../../shared/design/engine-switch';
import {checkpointObject, readCheckpointHeader} from './collab/checkpoint';
import {designFail} from './errors';
import {createHash} from 'node:crypto';

// `GET /api/design-files/:id/checkpoint` (the server half): a file's document as the model's binary
// codec — an `MRFA` frame, what `MorfaDoc.encode()` writes and the editor's `MorfaDoc.decode()` reads — instead of its JSON text,
// so the browser never builds a 400 MB string. Two sources:
// - a collab-path file: its checkpoint object (crates/checkpoint: a 64-byte MRFC header and zstd of the codec), at the
//   checkpoint's version; the rows after it reach the editor through the realtime join, as today. A client that takes zstd gets
//   the object's compressed body as it is, with no work at all.
// - an api-path file up to DESIGN_CHECKPOINT_API_BYTES: its stored JSON text at the file's version, written in the codec by the
//   server wasm (crates/wasm/src/server_document.rs `encode_server_document`). Larger ones are refused with 413: the api never
//   re-parses a 400 MB text per read; such files belong on the collab path.
// What a version encodes to, and its compressed forms, are kept by (file, version): a second read of a version does no work.

/** DESIGN_CHECKPOINT_API_BYTES: the largest stored JSON (bytes) the api encodes on a read — 128 MB by default (f100k, about
 *  80 MB, is served; f500k, 399 MB, would need about 1.9 GB per read and is refused). */
export function checkpointApiBytes(): number {
  const value = Number(process.env.DESIGN_CHECKPOINT_API_BYTES || 128 * 1024 * 1024);
  return Number.isSafeInteger(value) && value > 0 ? value : 128 * 1024 * 1024;
}
/** DESIGN_CHECKPOINT_CACHE_BYTES: the encoded documents kept (codec bytes and their compressed forms together), 256 MB by default;
 *  0 keeps none. */
function cacheBudget(): number {
  const value = Number(process.env.DESIGN_CHECKPOINT_CACHE_BYTES || 256 * 1024 * 1024);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export type CheckpointEncoding = 'zstd' | 'gzip' | 'identity';

/** The encoding of the answer from `Accept-Encoding`: zstd when it is listed with q > 0, else gzip, else none. */
export function checkpointEncoding(accept: string | undefined): CheckpointEncoding {
  const accepted = new Set<string>();
  for (const part of (accept ?? '').split(',')) {
    const [name, ...params] = part.trim().toLowerCase().split(';');
    const q = params.map(param => param.trim()).find(param => param.startsWith('q='));
    if (name && !(q && Number(q.slice(2)) <= 0)) accepted.add(name.trim());
  }
  if (accepted.has('zstd')) return 'zstd';
  if (accepted.has('gzip') || accepted.has('*')) return 'gzip';
  return 'identity';
}

/** Where a file's codec bytes come from, as the file's read found it (files.ts `openDesignCheckpoint`). */
export type CheckpointSource =
  | {kind: 'object'; fileId: string; key: string; version: number}
  | {kind: 'text'; fileId: string; version: number; text: () => Promise<string | Buffer>};

type Entry = {
  /** `object:<key>` or `text:<version>`: what the bytes were made from. */
  from: string;
  version: number;
  source: 'object' | 'encoded';
  /** The codec bytes (absent until a client needs them uncompressed or gzipped, for an object a zstd client took as it is). */
  codec?: Buffer;
  encoded: Partial<Record<'zstd' | 'gzip', Buffer>>;
  bytes: number;
};
const entries = new Map<string, Entry>();
let total = 0;
const reads = {built: 0, cached: 0};
/** For tests and the bench: how many answers were made, and how many were served from what an earlier read kept. */
export const checkpointReads = () => ({...reads});

const fromOf = (source: CheckpointSource) => (source.kind === 'object' ? `object:${source.key}` : `text:${source.version}`);

/** Whether `fileId`'s answer for `source` is kept in the encoding asked for: the file's read then needs no document. */
export function keptCheckpoint(fileId: string, from: {kind: 'object'; key: string} | {kind: 'text'; version: number}, encoding: CheckpointEncoding): boolean {
  const entry = entries.get(fileId);
  const wanted = from.kind === 'object' ? `object:${from.key}` : `text:${from.version}`;
  return !!entry && entry.from === wanted && (encoding === 'identity' ? !!entry.codec : !!entry.encoded[encoding]);
}

function keep(fileId: string, entry: Entry) {
  const previous = entries.get(fileId);
  if (previous) total -= previous.bytes;
  entries.delete(fileId);
  entry.bytes = (entry.codec?.length ?? 0) + (entry.encoded.zstd?.length ?? 0) + (entry.encoded.gzip?.length ?? 0);
  const budget = cacheBudget();
  if (entry.bytes > budget) return;
  entries.set(fileId, entry);
  total += entry.bytes;
  for (const [key, old] of entries) {
    if (total <= budget) break;
    entries.delete(key);
    total -= old.bytes;
  }
}

/** The server build's codec writer, or undefined without one (a dev machine without scripts/wasm-build.sh's server build). */
function encoder(): ((json: Uint8Array) => Uint8Array | undefined) | undefined {
  try {
    const wasm = engineWasm() as unknown as {encode_server_document?: (json: Uint8Array) => Uint8Array | undefined};
    return typeof wasm.encode_server_document === 'function' ? wasm.encode_server_document.bind(wasm) : undefined;
  } catch {
    return undefined;
  }
}

const unavailable = (why: string): never =>
  designFail(503, 'design_checkpoint_unavailable', 'This file is currently opened the usual way.', {reason: why});

function encodeText(text: string | Buffer): Buffer {
  const encode = encoder();
  if (!encode) return unavailable('the server has no wasm build of the codec (scripts/wasm-build.sh)');
  const bytes = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const codec = encode(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  if (!codec) return unavailable('the codec would not carry this document exactly (an escaped lone surrogate)');
  return Buffer.from(codec.buffer, codec.byteOffset, codec.byteLength);
}

const zstd = promisify(zstdCompress),
  unzstd = promisify(zstdDecompress),
  gzipped = promisify(gzip);

/** A checkpoint object's parts, checked: its header, and its compressed body when it holds the codec (else its JSON, to encode). */
async function objectParts(key: string, version: number): Promise<{zstdBody?: Buffer; codec?: Buffer}> {
  const object = await checkpointObject(key);
  const header = readCheckpointHeader(object);
  if (header.version !== version) designFail(503, 'design_unavailable', 'Could not read the saved version of the file. Try again later.');
  const body = object.subarray(64);
  if (header.headerVersion === 2 && !createHash('sha256').update(body).digest().equals(object.subarray(32, 64)))
    designFail(503, 'design_unavailable', 'Could not read the saved version of the file. Try again later.');
  if (header.format === 'bin') return {zstdBody: Buffer.from(body)};
  // A JSON checkpoint (format 2): its text written in the codec, as an api file's.
  const payload = await unzstd(body);
  if (payload.length !== header.payloadBytes) designFail(503, 'design_unavailable', 'Could not read the saved version of the file. Try again later.');
  if (payload.length > checkpointApiBytes()) tooLarge(payload.length);
  return {codec: encodeText(payload)};
}

export function tooLarge(bytes: number): never {
  return designFail(413, 'design_checkpoint_too_large', 'The file is too large to open from the saved copy.', {
    reason: 'an api-path file over DESIGN_CHECKPOINT_API_BYTES: encoding it would hold its whole JSON text and document per read; such a file belongs on the collab path',
    bytes,
    limit: checkpointApiBytes(),
  });
}

const making = new Map<string, Promise<{body: Buffer; entry: Entry}>>();

/** The answer for `source` in `encoding`: kept from an earlier read of the same version, or made now (and kept). */
export function checkpointAnswer(source: CheckpointSource, encoding: CheckpointEncoding): Promise<{body: Buffer; version: number; source: 'object' | 'encoded'}> {
  const from = fromOf(source);
  const kept = entries.get(source.fileId);
  if (kept && kept.from === from) {
    const body = encoding === 'identity' ? kept.codec : kept.encoded[encoding];
    if (body) {
      reads.cached++;
      entries.delete(source.fileId);
      entries.set(source.fileId, kept);
      return Promise.resolve({body, version: kept.version, source: kept.source});
    }
  }
  // Two reads of the same version at once make it once.
  const key = `${source.fileId}\n${from}\n${encoding}`;
  let made = making.get(key);
  if (!made) {
    made = make(source, encoding, kept && kept.from === from ? kept : undefined).finally(() => making.delete(key));
    making.set(key, made);
  }
  return made.then(({body, entry}) => ({body, version: entry.version, source: entry.source}));
}

async function make(source: CheckpointSource, encoding: CheckpointEncoding, kept: Entry | undefined): Promise<{body: Buffer; entry: Entry}> {
  const entry: Entry = kept ?? {from: fromOf(source), version: source.version, source: source.kind === 'object' ? 'object' : 'encoded', encoded: {}, bytes: 0};
  if (!entry.codec && !entry.encoded.zstd) {
    if (source.kind === 'object') {
      const parts = await objectParts(source.key, source.version);
      if (parts.zstdBody) entry.encoded.zstd = parts.zstdBody;
      if (parts.codec) entry.codec = parts.codec;
    } else entry.codec = encodeText(await source.text());
  }
  if (encoding !== 'zstd' || !entry.encoded.zstd) entry.codec ??= await unzstd(entry.encoded.zstd!);
  let body: Buffer;
  if (encoding === 'identity') body = entry.codec!;
  else if (encoding === 'zstd') body = entry.encoded.zstd ??= await zstd(entry.codec!, {params: {[constants.ZSTD_c_compressionLevel]: 3}});
  else body = entry.encoded.gzip ??= await gzipped(entry.codec!, {level: 5});
  reads.built++;
  keep(source.fileId, entry);
  return {body, entry};
}

/** A file's kept answers go (tests). */
export function forgetCheckpoints() {
  entries.clear();
  total = 0;
}
