import {db} from '../db';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import {textFamilies} from '../../shared/design/pdf-export';
import {storedDocument} from './document-store';
import {encodeThumbnail, imageUrl, newImageFilename, removeImageFiles, writeImageFile} from './images';
import {pictureIndex, pictureTable, picturePrinter, picturesUnder} from './pdf/export';
import {designRasterEngine} from './pdf/flag';
import {readablePictures} from './pdf/pictures';
import {RenderServiceUnavailable, encodeRenderRequest, rasterJobHeader, renderJob, renderServiceUrl} from './pdf/service';
import {versionOf} from './file-access';

// The file card's picture made on the server (docs/BACKEND.md §4 "thumbnails on every checkpoint"; lane L4's raster
// pass): some seconds after a document write — the api's own saves (files.ts `afterWrite`) and collab's checkpoints
// (`POST /internal/design-files/:id/checkpoint`, collab/internal-router.ts) — the first page is drawn at 512 px by the
// render service (the same painter as the canvas, the catalogue's glyphs) and stored as the editor's own PUT /thumbnail
// stores it: a WebP of 480 px, the previous picture removed. Only with DESIGN_RASTER_ENGINE=service; the editor keeps
// posting its own thumbnail, so a file the service never sees keeps a picture. Writes are per file, coalesced: a later
// write moves the job on, a job finds the version it read gone and leaves the newer picture to the next one.

/** DESIGN_THUMBNAIL_DELAY_MS: quiet time after a write before the picture is taken (5 s; tests set it short). */
export function thumbnailDelayMs(): number {
  const value = Number(process.env.DESIGN_THUMBNAIL_DELAY_MS || 5_000);
  return Number.isSafeInteger(value) && value >= 0 && value <= 600_000 ? value : 5_000;
}

const RENDER_MS = 30_000;
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const running = new Map<string, Promise<boolean>>();
let settled: Promise<unknown> = Promise.resolve();

/** Whether the server makes thumbnails at all (the service named and chosen). */
export const serverThumbnailsEnabled = () => designRasterEngine() === 'service' && renderServiceUrl() !== null;

/** A write to `fileId` happened: a thumbnail follows `delay` ms after the last one. */
export function scheduleServerThumbnail(fileId: string, delay = thumbnailDelayMs()): void {
  if (!serverThumbnailsEnabled()) return;
  const known = timers.get(fileId);
  if (known) clearTimeout(known);
  const timer = setTimeout(() => {
    timers.delete(fileId);
    const job = renderServerThumbnail(fileId).catch(error => {
      console.error(`[design] thumbnail of ${fileId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    });
    running.set(fileId, job);
    settled = Promise.allSettled([settled, job]);
    void job.finally(() => {
      if (running.get(fileId) === job) running.delete(fileId);
    });
  }, delay);
  timer.unref();
  timers.set(fileId, timer);
}

/** Tests and the drain: the jobs in flight, and whether one is planned for `fileId`. */
export const thumbnailsPending = (fileId?: string) => (fileId ? timers.has(fileId) || running.has(fileId) : timers.size + running.size > 0);
export async function drainServerThumbnails(): Promise<void> {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  await settled;
}

/** Draws the first page of `fileId` through the service and stores the picture; false when there was nothing to do
 *  (no service, the file gone or in the trash, an empty page, the version moved on, the service refused). */
export async function renderServerThumbnail(fileId: string): Promise<boolean> {
  if (!serverThumbnailsEnabled()) return false;
  type Row = {id: string; user_id: string; team_id: string | null; version: number; thumbnail_filename: string | null; trashed_at: string | null};
  const read = await db.transaction(async tx => {
    const row = await tx.one<Row>(
      `SELECT id,user_id,team_id,${versionOf('design_files')} AS version,thumbnail_filename,trashed_at FROM design_files WHERE id=$1`,
      [fileId],
    );
    if (!row || row.trashed_at) return null;
    const doc: DesignDocument = await storedDocument(tx, row);
    const page = doc.pages[0] as NodeId | undefined;
    if (!page || !(doc.nodes[page]?.children?.length)) return null;
    const table = pictureTable(doc);
    const drawn = new Set<string>();
    for (const ref of picturesUnder(doc, [page])) {
      table.imageHref(ref);
      drawn.add(ref);
    }
    const names = table.names();
    const allowed = names.length ? await readablePictures(tx, row.user_id, names) : new Set<string>();
    return {row, doc, page, table, drawn, allowed};
  });
  if (!read) return false;
  const {row, doc, page, table, drawn, allowed} = read;
  const picture = picturePrinter(table, allowed);
  const refs: {ref: string; href: string; length: number}[] = [];
  const bytes: Uint8Array[] = [];
  for (const ref of drawn) {
    const href = table.imageHref(ref);
    const index = href === undefined ? null : pictureIndex(href);
    if (href === undefined || index === null) continue;
    const printable = await picture(index);
    if (!printable) continue;
    refs.push({ref, href, length: printable.data.length});
    bytes.push(printable.data);
  }
  const {header} = rasterJobHeader([page], {kind: 'thumbnail', account: row.user_id, families: textFamilies(doc, [page]), pictures: refs, timeoutMs: RENDER_MS});
  let answer;
  try {
    answer = await renderJob(encodeRenderRequest(header, JSON.stringify(doc), bytes), RENDER_MS);
  } catch (error) {
    if (!(error instanceof RenderServiceUnavailable)) throw error;
    console.error(`[design] thumbnail of ${fileId}: the render service is unavailable: ${error.message}`);
    return false;
  }
  if (answer.status !== 200) {
    console.error(`[design] thumbnail of ${fileId}: the render service answered ${answer.status}`);
    return false;
  }
  const encoded = await encodeThumbnail(answer.body);
  const filename = newImageFilename('thumbnail', 'webp');
  await writeImageFile(filename, encoded.data);
  let previous: string | null | 'stale';
  try {
    previous = await db.transaction(async tx => {
      const current = await tx.one<{version: number; thumbnail_filename: string | null; trashed_at: string | null}>(
        `SELECT ${versionOf('design_files')} AS version,thumbnail_filename,trashed_at FROM design_files WHERE id=$1 FOR UPDATE`,
        [fileId],
      );
      // The file moved on (a newer picture is on its way) or went away: this one is dropped.
      if (!current || current.trashed_at || current.version !== row.version) return 'stale';
      await tx.execute(
        "INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,$4,'thumbnail',$5,$6,$7)",
        [filename, row.user_id, row.team_id, row.id, encoded.data.length, encoded.width, encoded.height],
      );
      await tx.execute('UPDATE design_files SET thumbnail_filename=$1 WHERE id=$2 AND user_id=$3', [filename, row.id, row.user_id]);
      if (current.thumbnail_filename)
        await tx.execute("DELETE FROM design_images WHERE filename=$1 AND user_id=$2 AND kind='thumbnail'", [current.thumbnail_filename, row.user_id]);
      return current.thumbnail_filename;
    });
  } catch (error) {
    await removeImageFiles([filename]).catch(() => {});
    throw error;
  }
  if (previous === 'stale') {
    await removeImageFiles([filename]).catch(() => {});
    return false;
  }
  if (previous) await removeImageFiles([previous]).catch(() => {});
  return true;
}

/** The URL the file card shows for `filename` (as files.ts answers). */
export const thumbnailUrlOf = imageUrl;
