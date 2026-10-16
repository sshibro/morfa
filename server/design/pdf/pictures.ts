import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import {dataDir} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import {isRasterImageInput} from '../../svg-image';
import {DESIGN_DOCUMENT_CAPS} from '../../../shared/design/limits';
import {guestPicturesSql} from '../file-access';

// Pictures of the vector PDF (docs/design-tool.md §Export). The renderer never fetches a URL: it asks the
// server for a picture by its number on the page, and the server answers from DATA_DIR/uploads only for
// pictures the caller may read the way GET /uploads/:filename decides it (server/assets.ts): a site library
// file or a design picture of the caller's own, or a picture of a team the caller is a member of.
//
// What the PDF embeds: a stored JPEG or PNG as it is (Chromium copies a JPEG's bytes into the PDF and keeps a
// PNG lossless, its alpha a soft mask). Photos are stored as WebP (server/design/images.ts), which a PDF cannot
// hold and Chromium would embed losslessly at several times the picture's size: an opaque one becomes a JPEG of
// quality 92 without chroma subsampling, one with transparency a PNG.

const NAME = /^[A-Za-z0-9_.-]{1,200}$/;

/** The filenames among `filenames` the caller may read (the rule of GET /uploads/:filename). */
export async function readablePictures(tx: SqlExecutor, userId: string, filenames: readonly string[]): Promise<Set<string>> {
  const names = [...new Set(filenames.filter(name => NAME.test(name)))];
  if (!names.length) return new Set();
  const rows = await tx.many<{filename: string}>(
    `SELECT filename FROM uploads WHERE filename=ANY($1::text[]) AND user_id=$2 AND ready=1
     UNION SELECT filename FROM design_images WHERE filename=ANY($1::text[]) AND user_id=$2
     UNION SELECT d.filename FROM design_images d JOIN design_teams t ON t.id=d.team_id AND t.deleted_at IS NULL
       JOIN design_team_members m ON m.team_id=t.id AND m.user_id=$2 WHERE d.filename=ANY($1::text[])
     UNION ${guestPicturesSql('$1::text[]', '$2')}`,
    [names, userId],
  );
  return new Set(rows.map(row => row.filename));
}

export type PrintablePicture = {type: 'image/jpeg' | 'image/png'; data: Buffer};

let missing: Promise<Buffer> | null = null;
/** What the editor shows for a picture it cannot read: the SVG export's neutral grey. */
export const missingPicture = async (): Promise<PrintablePicture> => ({
  type: 'image/png',
  data: await (missing ??= sharp({create: {width: 8, height: 8, channels: 3, background: '#d9d9d9'}}).png().toBuffer()),
});

const isJpeg = (data: Buffer) => data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
const isPng = (data: Buffer) => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

/** A stored picture as the PDF embeds it, or the grey placeholder when it is gone or not a picture. */
export async function printablePicture(filename: string): Promise<PrintablePicture> {
  if (!NAME.test(filename)) return missingPicture();
  const data = await fs.readFile(path.join(dataDir, 'uploads', filename)).catch(() => null);
  if (!data || data.length > DESIGN_DOCUMENT_CAPS.imageBytes * 2 || !isRasterImageInput(data)) return missingPicture();
  try {
    const image = sharp(data, {limitInputPixels: DESIGN_DOCUMENT_CAPS.imagePixels, animated: false});
    const meta = await image.metadata();
    const upright = !(meta.orientation && meta.orientation > 1);
    if (upright && (isJpeg(data) || isPng(data))) return {type: isJpeg(data) ? 'image/jpeg' : 'image/png', data};
    const turned = image.rotate();
    const alpha = meta.format === 'gif' || (!!meta.hasAlpha && !(await turned.clone().stats()).isOpaque);
    return alpha
      ? {type: 'image/png', data: await turned.png({compressionLevel: 6}).toBuffer()}
      : {type: 'image/jpeg', data: await turned.flatten({background: '#ffffff'}).jpeg({quality: 92, chromaSubsampling: '4:4:4'}).toBuffer()};
  } catch {
    return missingPicture();
  }
}
