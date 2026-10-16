import {privateImageData} from '../../api';
import {createDesignFile, eraseDesignFile, openDesignFile, replaceDesignDocument, uploadDesignImage} from '../api';
import type {DesignDocument, ImageAsset, ImageRef, Paint, SceneNode} from '../../../shared/design/types';
import {snapshotDocument} from '../../../shared/design/table-cache';
import type {DesignFileKind, DesignFileSummary, DesignImageUploaded, DesignPortableFile, DesignSaved} from '../../../shared/design/api';
import {validateDocument} from '../../../shared/design/schema';
import {DESIGN_PORTABLE_MAX_BYTES} from '../../../shared/design/document-limits';
import {DESIGN_DOCUMENT_CAPS} from '../../../shared/design/limits';
import {PRODUCT_NAME} from '../../../shared/design/product';
import {createUploadQueue} from '../engine/upload-queue';
import {desktopHost} from '../../desktop/host';

// The portable file ("Save to computer", `.rdesign`): the document with its pictures inlined as data URLs,
// so it opens in another account. Opening one makes a new file: create it, upload the pictures into it, then
// store the document whose picture references point at the new uploads (shared/design/api.ts `DesignPortableFile`).

export const PORTABLE_EXTENSION = '.rdesign';
export const PORTABLE_TYPE = 'application/json';
const UNTITLED = 'Untitled';
const DATA_URL = /^data:(image\/(?:png|jpeg|webp|gif|avif));base64,([A-Za-z0-9+/]+={0,2})$/;

/** Shown to the user as it is. */
export class PortableFileError extends Error {}

type ReadPicture = (url: string, signal: AbortSignal) => Promise<string>;

/** The file to download: every picture the document uses, read with the account's session into a data URL.
 *  A picture that cannot be read any more is left out (the editor cannot show it either). */
export async function exportPortable(name: string, input: DesignDocument, options: {signal?: AbortSignal; read?: ReadPicture; kind?: DesignFileKind} = {}): Promise<Blob> {
  // The file's document, taken once before the first await: the pictures take seconds to read, and the store's table may
  // be written in place meanwhile — the file holds one moment, pages, pictures and nodes alike.
  const doc = snapshotDocument(input);
  const read = options.read ?? privateImageData,
    signal = options.signal ?? new AbortController().signal;
  const imageData: Record<ImageRef, string> = {};
  for (const [ref, asset] of Object.entries(doc.images)) {
    try {
      const data = await read(asset.url, signal);
      if (DATA_URL.test(data)) imageData[ref] = data;
    } catch (error) {
      if (signal.aborted) throw error;
    }
  }
  const file: DesignPortableFile = {format: 'morfa-design', formatVersion: 1, name, ...(options.kind === 'board' ? {kind: 'board' as const} : {}), document: doc, imageData};
  return new Blob([JSON.stringify(file)], {type: PORTABLE_TYPE});
}

export const portableFilename = (name: string) =>
  (name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || UNTITLED).slice(0, 120) + PORTABLE_EXTENSION;

/** `kind`: a board's copy opens as a board (docs/board.md). */
export type PortableContent = {name: string; document: DesignDocument; imageData: Record<ImageRef, string>; kind: DesignFileKind};

/** Reads and checks a portable file: its size (50 MB), format, the whole document (shared/design/schema.ts) and
 *  that every inlined picture is a PNG, JPEG, WebP, GIF or AVIF data URL of at most 20 MB. */
export async function readPortable(file: Blob & {name?: string}): Promise<PortableContent> {
  if (file.size > DESIGN_PORTABLE_MAX_BYTES) throw new PortableFileError('The file is larger than 50 MB.');
  let value: unknown;
  try {
    value = JSON.parse(await file.text());
  } catch {
    throw new PortableFileError(`This is not a ${PRODUCT_NAME} file.`);
  }
  const portable = value as Partial<DesignPortableFile> | null;
  if (!portable || typeof portable !== 'object' || portable.format !== 'morfa-design') throw new PortableFileError(`This is not a ${PRODUCT_NAME} file.`);
  if (portable.formatVersion !== 1) throw new PortableFileError(`The file was saved in a newer version of ${PRODUCT_NAME}. Reload the page and try again.`);
  const checked = validateDocument(portable.document);
  if (!checked.ok) throw new PortableFileError(`The file is damaged: ${checked.error.replace(/\.$/, '')} (${checked.path}).`);
  const imageData: Record<ImageRef, string> = {};
  const inlined = portable.imageData && typeof portable.imageData === 'object' ? (portable.imageData as Record<string, unknown>) : {};
  for (const ref of Object.keys(checked.value.images)) {
    if (!Object.hasOwn(inlined, ref)) continue;
    const data = inlined[ref];
    const match = typeof data === 'string' ? DATA_URL.exec(data) : null;
    if (!match) throw new PortableFileError('The file is damaged: an image in it is not PNG, JPEG, WebP, GIF or AVIF.');
    if (Math.floor((match[2].length * 3) / 4) > DESIGN_DOCUMENT_CAPS.imageBytes) throw new PortableFileError('An image in the file is larger than 20 MB.');
    imageData[ref] = data as string;
  }
  const fallback = file.name?.replace(/\.rdesign$/i, '').trim();
  const name = typeof portable.name === 'string' && portable.name.trim() ? portable.name.trim().slice(0, 200) : fallback || UNTITLED;
  return {name, document: checked.value, imageData, kind: portable.kind === 'board' ? 'board' : 'design'};
}

function dataUrlBlob(url: string): Blob {
  const [, type, base64] = DATA_URL.exec(url)!;
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], {type});
}

/** The document with its pictures renamed: `refs` maps an old reference to the uploaded one; a picture without
 *  an upload leaves the document and its paints point at nothing (`imageRef: ''`, shown as an empty picture). */
export function rewriteImageRefs(doc: DesignDocument, refs: ReadonlyMap<ImageRef, {ref: ImageRef; asset: ImageAsset}>): DesignDocument {
  const paint = (value: Paint): Paint => (value.type === 'IMAGE' && value.imageRef ? {...value, imageRef: refs.get(value.imageRef)?.ref ?? ''} : value);
  const paints = (list: Paint[] | undefined) => list?.map(paint);
  const nodes: Record<string, SceneNode> = {};
  for (const [id, node] of Object.entries(doc.nodes)) {
    const next: SceneNode = {...node, fills: node.fills.map(paint), strokes: node.strokes.map(paint)};
    if (node.text) next.text = {...node.text, runs: node.text.runs.map(run => (run.fills ? {...run, fills: run.fills.map(paint)} : run))};
    nodes[id] = next;
  }
  const styles = Object.fromEntries(Object.entries(doc.styles).map(([id, style]) => [id, style.paints ? {...style, paints: paints(style.paints)} : style]));
  const images: Record<ImageRef, ImageAsset> = {};
  for (const ref of Object.keys(doc.images)) {
    const uploaded = refs.get(ref);
    if (uploaded) images[uploaded.ref] = uploaded.asset;
  }
  return {...doc, nodes, styles, images};
}

type Upload = (fileId: string, image: Blob, name?: string) => Promise<DesignImageUploaded>;

/** One picture at a time; an upload the server calls busy (a file of more than 60 pictures meets its 60 a minute) waits
 *  and goes again instead of failing the whole file (engine/upload-queue.ts). */
function patient(upload: Upload, sleep?: (ms: number) => Promise<void>): Upload {
  const queue = createUploadQueue({limit: 1, sleep});
  return (fileId, image, name) => queue(() => upload(fileId, image, name));
}

async function uploadInto(content: PortableContent, fileId: string, upload: Upload): Promise<DesignDocument> {
  const refs = new Map<ImageRef, {ref: ImageRef; asset: ImageAsset}>();
  for (const [ref, asset] of Object.entries(content.document.images)) {
    const data = content.imageData[ref];
    if (!data) continue;
    const uploaded = await upload(fileId, dataUrlBlob(data), asset.name || ref);
    refs.set(ref, {ref: uploaded.ref, asset: asset.name ? {...uploaded.asset, name: asset.name} : uploaded.asset});
  }
  return rewriteImageRefs(content.document, refs);
}

/** Checks a portable file, uploads its pictures into the file `fileId` and answers the document whose
 *  references point at those uploads, ready to be stored in that file. */
export async function importPortable(file: Blob & {name?: string}, fileId: string, options: {upload?: Upload} = {}): Promise<{name: string; document: DesignDocument}> {
  const content = await readPortable(file);
  return {name: content.name, document: await uploadInto(content, fileId, patient(options.upload ?? uploadDesignImage))};
}

export type PortableDeps = {
  create: (data: {name?: string; kind?: DesignFileKind}) => Promise<{file: DesignFileSummary}>;
  upload: Upload;
  replace: (id: string, baseVersion: number, document: DesignDocument) => Promise<DesignSaved>;
  erase: (id: string) => Promise<unknown>;
  /** Waits before a busy upload goes again (tests pass a quick one). */
  sleep?: (ms: number) => Promise<void>;
};
const apiDeps: PortableDeps = {create: createDesignFile, upload: uploadDesignImage, replace: replaceDesignDocument, erase: eraseDesignFile};

/** "Open file from computer": a new file in this account. The file is checked before anything is made; then the
 *  file is created, the pictures go into it and the document is stored. A failure part-way erases the new file.
 *  `fileId` repeats `file.id` for the file browser's contract (src/design/files/integrations.ts). */
export async function openPortableAsNewFile(file: Blob & {name?: string}, deps: PortableDeps = apiDeps): Promise<{file: DesignFileSummary; document: DesignDocument; fileId: string}> {
  const content = await readPortable(file);
  const {file: created} = await deps.create(content.kind === 'board' ? {name: content.name, kind: 'board'} : {name: content.name});
  try {
    const document = await uploadInto(content, created.id, patient(deps.upload, deps.sleep));
    const saved = await deps.replace(created.id, created.version, document);
    return {file: {...created, version: saved.version, updatedAt: saved.updatedAt}, document, fileId: created.id};
  } catch (error) {
    await deps.erase(created.id).catch(() => undefined);
    throw error;
  }
}

/** Saves a blob under a file name through a temporary link (the browser's own download); in the desktop app through
 *  its native save dialog (src/desktop/host.ts). */
export function saveBlob(blob: Blob, filename: string, doc: Document = document): void | Promise<void> {
  if (desktopHost.saveFile) return desktopHost.saveFile(blob, filename);
  const url = URL.createObjectURL(blob);
  const link = doc.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  link.style.display = 'none';
  doc.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked once the browser has taken the file.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/** "Save to computer (.rdesign)" of a file from the file browser (src/design/files/integrations.ts): its stored document. */
export async function downloadPortableFile(fileId: string, name?: string): Promise<void> {
  const opened = await openDesignFile(fileId);
  const title = name ?? opened.file.name;
  await saveBlob(await exportPortable(title, opened.document, {kind: opened.file.kind}), portableFilename(title));
}
