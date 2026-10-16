import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {zstdDecompressSync} from 'node:zlib';
import type {DesignDocument} from '../../../shared/design/types';
import type {DocumentPatch} from '../../../shared/design/patch';
import {engineWasm, type MorfaDocHandle} from '../../../shared/design/engine-switch';
import {designFail} from '../errors';

// What collab writes that api must read (docs/BACKEND.md §3; lane B2's crates/checkpoint): checkpoint objects in object storage
// and journal rows whose body is in `design_file_changes.op` instead of `patch`.
//
// A checkpoint object (crates/checkpoint/src/format.rs) is a 64-byte header and the document compressed with zstd:
//   0 "MRFC" · 4 header version (1|2) · 5 format (1 the model's binary codec, an "MRFA" frame; 2 JSON) · 6 codec format u16 ·
//   8 document version u64 · 16 layers u32 · 20 reserved · 24 payload bytes u64 · 32 sha256 (v2: of the compressed body; v1:
//   of the payload). The binary payload is decoded by crates/wasm (`MorfaDoc.decode`, the same codec as the Rust side) and
//   handed over as JSON, the TS↔WASM edge's contract.
//
// An `op` row is recognised by its first bytes: `{` a JSON patch, `MRFC` a whole document (a replace: a checkpoint object inline),
// `MRFJ` a store journal entry that only replays on the model's store, with its interners exactly as crates/checkpoint loads them:
// a file with such rows is put together in crates/wasm (`composeOnStore`: the checkpoint decoded into a MorfaDoc, or the stored
// text parsed into one, then every row in order, `replay_entry` for the entries). The paths that patch a held JSON document
// (the catch-up) leave those files to it.

const MAGIC = Buffer.from('MRFC');
const HEADER_BYTES = 64;
const FORMAT_BIN = 1;
const FORMAT_JSON = 2;

export type CheckpointHeader = {headerVersion: number; format: 'bin' | 'json'; version: number; layers: number; payloadBytes: number};

function damaged(what: string): never {
  throw Object.assign(new Error(`checkpoint: ${what}`), {checkpointDamaged: true});
}

export function readCheckpointHeader(bytes: Buffer): CheckpointHeader {
  if (bytes.length < HEADER_BYTES || !bytes.subarray(0, 4).equals(MAGIC)) damaged('not an MRFC object');
  const headerVersion = bytes[4],
    format = bytes[5];
  if (headerVersion !== 1 && headerVersion !== 2) damaged(`header version ${headerVersion}`);
  if (format !== FORMAT_BIN && format !== FORMAT_JSON) damaged(`format ${format}`);
  return {
    headerVersion,
    format: format === FORMAT_BIN ? 'bin' : 'json',
    version: Number(bytes.readBigUInt64LE(8)),
    layers: bytes.readUInt32LE(16),
    payloadBytes: Number(bytes.readBigUInt64LE(24)),
  };
}

/** The payload of an MRFC object, checked against its hash and length. */
function checkpointPayload(bytes: Buffer): {header: CheckpointHeader; payload: Buffer} {
  const header = readCheckpointHeader(bytes);
  const body = bytes.subarray(HEADER_BYTES);
  const expected = bytes.subarray(32, 64);
  if (header.headerVersion === 2 && !createHash('sha256').update(body).digest().equals(expected)) damaged('the body does not match its hash');
  const payload = zstdDecompressSync(body);
  if (payload.length !== header.payloadBytes) damaged(`${payload.length} payload bytes, the header says ${header.payloadBytes}`);
  if (header.headerVersion === 1 && !createHash('sha256').update(payload).digest().equals(expected)) damaged('the payload does not match its hash');
  return {header, payload};
}

/** The document an MRFC object holds, checked against its hash and length before it is decoded. */
export function decodeCheckpoint(bytes: Buffer): {header: CheckpointHeader; document: DesignDocument} {
  const {header, payload} = checkpointPayload(bytes);
  if (header.format === 'json') return {header, document: JSON.parse(payload.toString('utf8')) as DesignDocument};
  const handle = engineWasm().MorfaDoc.decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  try {
    return {header, document: JSON.parse(handle.to_json()) as DesignDocument};
  } finally {
    handle.free();
  }
}

/** An MRFC object as the model's store document (a crates/wasm MorfaDoc the caller frees), as crates/checkpoint decodes it. */
export function checkpointOnStore(bytes: Buffer): {header: CheckpointHeader; handle: MorfaDocHandle} {
  const {header, payload} = checkpointPayload(bytes);
  const Doc = engineWasm().MorfaDoc;
  const handle = header.format === 'json' ? new Doc(payload.toString('utf8')) : Doc.decode(new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength));
  return {header, handle};
}

const PACKED = Buffer.from('MRFZ');
/** A packed row: the patch text inside, as `patch` would hold it. */
const isPackedRow = (op: Buffer) => op.length >= 4 && op.subarray(0, 4).equals(PACKED);
function unpackedText(op: Buffer, version: number): string {
  try {
    return zstdDecompressSync(op.subarray(4)).toString('utf8');
  } catch (error) {
    return damaged(`row ${version}: ${(error as Error).message}`);
  }
}

export type JournalBody = {kind: 'patch'; patch: DocumentPatch} | {kind: 'replace'; document: DesignDocument} | {kind: 'entry'; bytes: Buffer};

/** A store journal entry (`MRFJ`) row: replayed only on the store (`composeOnStore`). */
export const isEntryRow = (op: Buffer | null | undefined) => !!op && op.length >= 4 && op.subarray(0, 4).toString('latin1') === 'MRFJ';

/** One row of design_file_changes as a change to apply: its `patch` text (Node's rows, collab's JSON rows) or its `op` bytes. */
export function decodeJournalRow(patch: string | null, op: Buffer | null, version: number): JournalBody {
  if (patch !== null) return {kind: 'patch', patch: JSON.parse(patch) as DocumentPatch};
  if (!op?.length) return damaged(`row ${version} has no body`);
  if (op[0] === 0x7b) return {kind: 'patch', patch: JSON.parse(op.toString('utf8')) as DocumentPatch};
  if (isPackedRow(op)) return {kind: 'patch', patch: JSON.parse(unpackedText(op, version)) as DocumentPatch};
  if (op.subarray(0, 4).equals(MAGIC)) return {kind: 'replace', document: decodeCheckpoint(op).document};
  if (isEntryRow(op)) return {kind: 'entry', bytes: op};
  return damaged(`row ${version} holds an op of no known kind`);
}

/** The row's body applied to a store document: a patch, a whole document (the handle is replaced: the caller frees the one it
 *  gets back), or a journal entry replayed. */
export function applyRowOnStore(handle: MorfaDocHandle, patch: string | null, op: Buffer | null, version: number): MorfaDocHandle {
  if (patch !== null) {
    handle.apply_patch(patch);
    return handle;
  }
  if (!op?.length) return damaged(`row ${version} has no body`);
  if (op[0] === 0x7b) {
    handle.apply_patch(op.toString('utf8'));
    return handle;
  }
  if (isPackedRow(op)) {
    handle.apply_patch(unpackedText(op, version));
    return handle;
  }
  if (op.subarray(0, 4).equals(MAGIC)) {
    handle.free();
    return checkpointOnStore(op).handle;
  }
  if (isEntryRow(op)) {
    try {
      handle.replay_entry(new Uint8Array(op.buffer, op.byteOffset, op.byteLength));
    } catch (error) {
      damaged(`row ${version}: ${(error as Error).message}`);
    }
    return handle;
  }
  return damaged(`row ${version} holds an op of no known kind`);
}

/** Where collab's checkpoint objects are for this process: the S3 bucket (DESIGN_BLOBS=s3) or DESIGN_CHECKPOINT_DIR. */
async function fetchObject(key: string): Promise<Buffer | null> {
  if (!/^ckpt\/[0-9a-f-]{36}\/[0-9]{1,16}\.(bin|json)\.zst$/.test(key)) damaged(`unexpected key ${key}`);
  // Loaded when needed: images.ts brings the database and sharp with it, which a decode alone does not need.
  if (process.env.DESIGN_BLOBS === 's3') return (await import('../images')).readStoreObject(key);
  const dir = process.env.DESIGN_CHECKPOINT_DIR;
  if (!dir) return designFail(503, 'design_unavailable', 'File version storage is not configured. Try again later.');
  try {
    return await readFile(path.join(dir, ...key.split('/')));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** The checkpoint object at `version` (`design_files.checkpoint_key`). A missing object is 503: the file is never answered from
 *  an older document. */
export async function checkpointObject(key: string): Promise<Buffer> {
  const bytes = await fetchObject(key);
  if (!bytes) return designFail(503, 'design_unavailable', 'Could not read the saved version of the file. Try again later.');
  return bytes;
}

/** The checkpointed document at `version` (`design_files.checkpoint_key`). A missing or damaged object is 503: the file is
 *  never answered from an older document. */
export async function loadCheckpoint(key: string, version: number): Promise<DesignDocument> {
  const {header, document} = decodeCheckpoint(await checkpointObject(key));
  if (header.version !== version) damaged(`${key} holds version ${header.version}, recorded as ${version}`);
  return document;
}
