import {inflateSync, unzipSync, unzlibSync} from 'fflate';
import {decompress as unzstd} from 'fzstd';
import {decodeMessage, decodeSchema, KiwiError} from './kiwi';

// The outside of a .fig file. Figma's "Save local copy" writes a ZIP with canvas.fig (the document),
// images/<sha1> (the pictures, named by their hash), meta.json and thumbnail.png; older copies are
// canvas.fig alone. canvas.fig is an 8-byte magic ("fig-kiwi"; FigJam "fig-jam."), a version and
// length-prefixed chunks: the kiwi schema, then the message, each deflated (zstd since 2024).

export class FigFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FigFileError';
  }
}

export type FigContents = {
  /** The decoded kiwi message: {type, nodeChanges, blobs, ...}. */
  message: Record<string, unknown>;
  /** Pictures by the lower-case hex of their hash. */
  images: Map<string, Uint8Array>;
  version: number;
};

const ZIP = [0x50, 0x4b, 0x03, 0x04];
const ZSTD = [0x28, 0xb5, 0x2f, 0xfd];
const DESIGN = 'fig-kiwi';
const OTHER_KINDS: Record<string, string> = {'fig-jam.': 'FigJam', 'fig-deck': 'Figma Slides', 'fig-buzz': 'Figma Buzz', 'fig-site': 'Figma Sites', 'fig-make': 'Figma Make'};
/** What one file may unpack to: a .fig over this is not a design anyone could open in a browser tab. */
const MAX_UNPACKED_BYTES = 1536 * 1024 * 1024;

const startsWith = (data: Uint8Array, magic: readonly number[]) => magic.every((byte, i) => data[i] === byte);
const ascii = (data: Uint8Array, start: number, end: number) => String.fromCharCode(...data.subarray(start, end));

function unpack(chunk: Uint8Array): Uint8Array {
  if (startsWith(chunk, ZSTD)) return unzstd(chunk);
  try {
    return inflateSync(chunk);
  } catch {
    // Some writers wrap deflate in zlib's header.
    return unzlibSync(chunk);
  }
}

/** The chunks of canvas.fig after its header. */
function chunksOf(canvas: Uint8Array): {version: number; chunks: Uint8Array[]} {
  const magic = ascii(canvas, 0, 8);
  if (magic !== DESIGN) {
    const kind = OTHER_KINDS[magic];
    throw new FigFileError(kind ? `This is a ${kind} file, but only a Figma Design file can be imported.` : 'This is not a .fig file from Figma.');
  }
  const view = new DataView(canvas.buffer, canvas.byteOffset, canvas.byteLength);
  if (canvas.length < 12) throw new FigFileError('The .fig file ends unexpectedly.');
  const version = view.getUint32(8, true);
  const chunks: Uint8Array[] = [];
  for (let offset = 12; offset + 4 <= canvas.length;) {
    const length = view.getUint32(offset, true);
    offset += 4;
    if (offset + length > canvas.length) throw new FigFileError('The .fig file ends unexpectedly.');
    chunks.push(canvas.subarray(offset, offset + length));
    offset += length;
  }
  if (chunks.length < 2) throw new FigFileError('The .fig file ends unexpectedly.');
  return {version, chunks};
}

/** Reads a .fig: the ZIP Figma saves, or a bare canvas.fig. */
export function readFigContents(data: Uint8Array): FigContents {
  let canvas = data;
  const images = new Map<string, Uint8Array>();
  if (startsWith(data, ZIP)) {
    let unpacked = 0;
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(data, {
        filter: entry => {
          if (entry.name !== 'canvas.fig' && !entry.name.startsWith('images/')) return false;
          unpacked += entry.originalSize;
          return unpacked <= MAX_UNPACKED_BYTES;
        },
      });
    } catch {
      throw new FigFileError('The .fig archive is damaged: save a local copy in Figma again.');
    }
    if (unpacked > MAX_UNPACKED_BYTES) throw new FigFileError('The .fig file is too large.');
    if (!entries['canvas.fig']) throw new FigFileError('The archive has no Figma design (canvas.fig).');
    canvas = entries['canvas.fig'];
    for (const [name, bytes] of Object.entries(entries)) {
      const hash = name.slice('images/'.length).toLowerCase();
      if (name.startsWith('images/') && /^[0-9a-f]{8,64}$/.test(hash)) images.set(hash, bytes);
    }
  }
  const {version, chunks} = chunksOf(canvas);
  try {
    const schema = decodeSchema(unpack(chunks[0]));
    const body = unpack(chunks[1]);
    if (body.length > MAX_UNPACKED_BYTES) throw new FigFileError('The .fig file is too large.');
    return {message: decodeMessage(schema, body), images, version};
  } catch (error) {
    if (error instanceof FigFileError || error instanceof KiwiError) throw error;
    throw new FigFileError('The .fig file cannot be read: it may have been saved by a newer version of Figma. Contact us and we will look into it.');
  }
}
