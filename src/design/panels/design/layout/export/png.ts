import {unzlibSync} from 'fflate';
import type {PdfImage} from './pdf';

// Reads the pixels back out of the PNG the raster exporter made, exactly (a canvas round trip
// would premultiply and lose half-transparent values). Only what browsers' encoders write: 8-bit
// RGBA or RGB, not interlaced. Anything else returns null and the caller decodes through a canvas.

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const readU32 = (bytes: Uint8Array, at: number) => ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;

export function decodePng(bytes: Uint8Array): PdfImage | null {
  if (bytes.length < 33 || SIGNATURE.some((value, i) => bytes[i] !== value)) return null;
  let width = 0, height = 0, channels = 0;
  const data: Uint8Array[] = [];
  let size = 0;
  for (let at = 8; at + 8 <= bytes.length;) {
    const length = readU32(bytes, at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const body = at + 8;
    if (body + length > bytes.length) return null;
    if (type === 'IHDR') {
      width = readU32(bytes, body);
      height = readU32(bytes, body + 4);
      const depth = bytes[body + 8], color = bytes[body + 9], interlace = bytes[body + 12];
      if (depth !== 8 || interlace !== 0 || (color !== 6 && color !== 2)) return null;
      channels = color === 6 ? 4 : 3;
    } else if (type === 'IDAT') {
      data.push(bytes.subarray(body, body + length));
      size += length;
    } else if (type === 'IEND') break;
    at = body + length + 4;
  }
  if (!width || !height || !channels || !data.length) return null;
  const packed = new Uint8Array(size);
  let offset = 0;
  for (const part of data) {
    packed.set(part, offset);
    offset += part.length;
  }
  let raw: Uint8Array;
  try {
    raw = unzlibSync(packed);
  } catch {
    return null;
  }
  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;
  const rows = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1, dst = y * stride, prev = dst - stride;
    for (let x = 0; x < stride; x++) {
      const value = raw[src + x];
      const left = x >= channels ? rows[dst + x - channels] : 0;
      const up = y > 0 ? rows[prev + x] : 0;
      const corner = y > 0 && x >= channels ? rows[prev + x - channels] : 0;
      let out: number;
      switch (filter) {
        case 0: out = value; break;
        case 1: out = value + left; break;
        case 2: out = value + up; break;
        case 3: out = value + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - corner;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - corner);
          out = value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : corner);
          break;
        }
        default: return null;
      }
      rows[dst + x] = out & 0xff;
    }
  }
  if (channels === 4) return {width, height, rgba: rows};
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, j = 0; i < rows.length; i += 3, j += 4) {
    rgba[j] = rows[i];
    rgba[j + 1] = rows[i + 1];
    rgba[j + 2] = rows[i + 2];
    rgba[j + 3] = 255;
  }
  return {width, height, rgba};
}
