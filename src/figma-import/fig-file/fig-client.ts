import type {FigmaFile} from '../../../shared/design/figma-import';
import type {FigmaClient} from '../figma-client';
import {FigFileError} from './index';

// A .fig file in the shape the Figma import runs on (src/design/import/figma/run-import.ts): the whole
// document is already here, so the "client" only answers where each picture is, and "download"
// hands back the picture's bytes from the file. No network. The file is read where the import runs,
// in its worker (src/design/import/figma/import-deps.ts `readSource`).

const SCHEME = 'fig-image:';
/** What a browser tab can unpack without falling over; Figma's own big kits are well under it. */
export const MAX_FIG_BYTES = 400 * 1024 * 1024;

const TYPES: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png'],
  [[0xff, 0xd8, 0xff], 'image/jpeg'],
  [[0x47, 0x49, 0x46, 0x38], 'image/gif'],
  [[0x52, 0x49, 0x46, 0x46], 'image/webp'],
];
const typeOf = (bytes: Uint8Array) => TYPES.find(([magic]) => magic.every((byte, i) => bytes[i] === byte))?.[1] ?? 'application/octet-stream';

export type FigRunParts = {client: Pick<FigmaClient, 'file' | 'nodes' | 'imageFills'>; download: (url: string) => Promise<Blob>};

export function figRunParts(images: ReadonlyMap<string, Uint8Array>): FigRunParts {
  const refuse = () => Promise.reject(new FigFileError('The .fig file has already been read in full.'));
  return {
    client: {
      file: refuse,
      nodes: refuse,
      imageFills: async () => Object.fromEntries([...images.keys()].map(ref => [ref, SCHEME + ref])),
    },
    download: async url => {
      const bytes = url.startsWith(SCHEME) ? images.get(url.slice(SCHEME.length)) : undefined;
      if (!bytes) throw new FigFileError('The image is not in the .fig file.');
      return new Blob([bytes as Uint8Array<ArrayBuffer>], {type: typeOf(bytes)});
    },
  };
}
