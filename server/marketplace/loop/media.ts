// Published pictures on disk (docs/marketplaces.md §Performance Loop): Ozon imports a product's pictures by link, so each picture
// Morfa publishes is kept under DATA_DIR/marketplace-media for a week (a rotation's for its test and a week) and served at
// /api/marketplace-media/<token>.<ext> with no session. The token is 32 random bytes; only its sha256 is stored.
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {dataDir} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import {mediaUrl} from './config';
import {iso} from './store';

export const mediaDir = () => path.join(dataDir, 'marketplace-media');
const FILENAME = /^[a-zA-Z0-9_.-]{1,200}$/;
export const TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');

export type PictureKind = {extension: 'jpg' | 'png' | 'webp'; contentType: string};
/** What the bytes are, by their signature (never by the name or type the browser sent); null for anything else. */
export function pictureKind(bytes: Buffer): PictureKind | null {
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return {extension: 'jpg', contentType: 'image/jpeg'};
  if (bytes.length > 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return {extension: 'png', contentType: 'image/png'};
  if (bytes.length > 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP')
    return {extension: 'webp', contentType: 'image/webp'};
  return null;
}
export const contentTypeOf = (filename: string) =>
  filename.endsWith('.png') ? 'image/png' : filename.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

export type StoredMedia = {id: string; filename: string; url: string; bytes: Buffer; contentType: string};

/** Writes the picture and its row; the file goes again when the row cannot be written. */
export async function storeMedia(
  tx: SqlExecutor,
  input: {userId: string; bytes: Buffer; kind: PictureKind; expiresAt: number},
): Promise<StoredMedia> {
  const id = randomUUID();
  const token = randomBytes(32).toString('base64url');
  const filename = `${id}.${input.kind.extension}`;
  await fs.mkdir(mediaDir(), {recursive: true});
  const target = path.join(mediaDir(), filename);
  await fs.writeFile(target, input.bytes, {mode: 0o600});
  try {
    await tx.execute(
      'INSERT INTO marketplace_media(id,token_hash,user_id,filename,bytes,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
      [id, tokenHash(token), input.userId, filename, input.bytes.length, iso(input.expiresAt)],
    );
  } catch (error) {
    await fs.rm(target, {force: true});
    throw error;
  }
  return {
    id,
    filename,
    url: mediaUrl(token, input.kind.extension),
    bytes: input.bytes,
    contentType: input.kind.contentType,
  };
}

/** A stored picture's bytes for the worker to publish again (a rotation's swap); null when it is gone. */
export async function readMediaBytes(
  tx: SqlExecutor,
  mediaId: string,
): Promise<{filename: string; bytes: Buffer} | null> {
  const row = await tx.one<{filename: string}>('SELECT filename FROM marketplace_media WHERE id=$1', [mediaId]);
  if (!row || !FILENAME.test(row.filename)) return null;
  const bytes = await fs.readFile(path.join(mediaDir(), row.filename)).catch(() => null);
  return bytes ? {filename: row.filename, bytes} : null;
}

/** The file a public link names while it lasts; null otherwise (expired, unknown, or the extension is not the file's). */
export async function mediaForToken(
  tx: SqlExecutor,
  token: string,
  extension: string,
  now: number,
): Promise<string | null> {
  if (!TOKEN.test(token)) return null;
  const row = await tx.one<{filename: string}>(
    'SELECT filename FROM marketplace_media WHERE token_hash=$1 AND expires_at>$2',
    [tokenHash(token), iso(now)],
  );
  if (!row || !FILENAME.test(row.filename) || !row.filename.endsWith('.' + extension)) return null;
  return path.join(mediaDir(), row.filename);
}

/** Removes picture files by name (rows are the caller's). */
export async function removeMediaFiles(filenames: readonly string[]): Promise<void> {
  for (const filename of filenames)
    if (FILENAME.test(filename)) await fs.rm(path.join(mediaDir(), filename), {force: true});
}

/** Deletes expired pictures: the rows (publications keep their history without them), then the files. */
export async function sweepMedia(tx: SqlExecutor, now: number): Promise<number> {
  const gone = await tx.many<{filename: string}>(
    'DELETE FROM marketplace_media WHERE id IN (SELECT id FROM marketplace_media WHERE expires_at<=$1 ORDER BY expires_at LIMIT 500) RETURNING filename',
    [iso(now)],
  );
  await removeMediaFiles(gone.map(row => row.filename));
  return gone.length;
}
