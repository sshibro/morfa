import type {FigmaFile} from '../../../shared/design/figma-import';
import {readFigContents, FigFileError} from './container';
import {FigDocument, MAX_FIG_NODES} from './to-rest';

// "Import from Figma" from a .fig file (Figma → File → Save local copy): no token and no Figma API
// calls, so none of Figma's monthly read limits. The file is read in the browser and handed to the
// same importer as a REST answer (src/design/import/figma/run-import.ts, through fig-client.ts).

export {FigFileError} from './container';

export type FigFile = {
  name: string;
  file: FigmaFile;
  /** Pictures by imageRef (the hex of their hash), as they are stored in the file. */
  images: Map<string, Uint8Array>;
  /** Copies past MAX_FIG_NODES were left out. */
  truncated: boolean;
};

/** The file's name without ".fig". */
export const figFileName = (fileName: string) => fileName.replace(/\.fig$/i, '').trim().slice(0, 200) || 'Import from Figma';

export function readFigFile(data: Uint8Array, fileName: string): FigFile {
  const contents = readFigContents(data);
  if (contents.message.type !== undefined && contents.message.type !== 'NODE_CHANGES') throw new FigFileError('This is not a .fig file from Figma.');
  const document = new FigDocument(contents.message);
  if (!document.pages.length) throw new FigFileError('The file has no pages.');
  const name = figFileName(fileName);
  const file = document.toFile(name);
  return {name, file, images: contents.images, truncated: document.truncated};
}

export {MAX_FIG_NODES};
