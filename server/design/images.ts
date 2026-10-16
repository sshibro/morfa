import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash, createHmac, randomUUID} from 'node:crypto';
import sharp from 'sharp';
import {dataDir} from '../db';
import type {SqlExecutor} from '../postgresql/client';
import {isRasterImageInput} from '../svg-image';
import {DESIGN_DOCUMENT_CAPS} from '../../shared/design/limits';
import {DESIGN_IMAGE_URL} from '../../shared/design/schema';
import {designFail} from './errors';

// Pictures placed in design files and the files' thumbnails (docs/design-tool.md §Server API). They live in
// DATA_DIR/uploads next to the site library's files, so GET /uploads/:filename serves them to their owner, but
// their rows are in design_images: the site library never lists them and its quota never counts them.

/** Designers need sharp pictures: originals keep up to 4096 px on the longer side. */
export const MAX_IMAGE_SIDE = 4096;
export const THUMBNAIL_SIDE = 480;
const THUMBNAIL_PIXELS = 4096 * 4096;
const STORED = /^[A-Za-z0-9_-]{1,120}\.(?:webp|png)$/;
export const UNSUPPORTED_IMAGE = 'Supported images: JPEG, PNG, WebP, AVIF and GIF.';

export type EncodedImage = {data: Buffer; extension: 'webp' | 'png'; width: number; height: number};

const unsupported = (): never => designFail(415, 'invalid_request', UNSUPPORTED_IMAGE);
const tooLarge = (): never =>
  designFail(
    413,
    'invalid_request',
    `The image is too large: at most ${DESIGN_DOCUMENT_CAPS.imagePixels / 1_000_000} megapixels and ${DESIGN_DOCUMENT_CAPS.imageBytes / 1024 / 1024} MB.`,
  );
const decodeFailure = (error: unknown): never =>
  error instanceof Error && /pixel limit/i.test(error.message) ? tooLarge() : unsupported();

/** The upload pipeline of the site library (server/upload-storage.ts), sized for design work: the type is read
 * from the bytes (never the name or the multipart type), SVG is refused (a vector is pasted as nodes), the
 * picture is decoded under a pixel limit, turned upright and re-encoded, which drops metadata. PNG and GIF stay
 * lossless (screenshots, flat UI); photos become WebP. */
export async function encodeDesignImage(input: Buffer): Promise<EncodedImage> {
  if (!input.length || !isRasterImageInput(input)) unsupported();
  const image = sharp(input, {limitInputPixels: DESIGN_DOCUMENT_CAPS.imagePixels}).rotate();
  const meta = await image.metadata().catch(decodeFailure);
  if (!meta.format || !['jpeg', 'png', 'webp', 'avif', 'gif', 'tiff', 'heif'].includes(meta.format)) unsupported();
  // sharp reports AVIF as HEIF with AV1 compression; HEVC is not supported.
  if (meta.format === 'heif' && meta.compression !== 'av1') unsupported();
  if (!meta.width || !meta.height) unsupported();
  if (meta.width! * meta.height! > DESIGN_DOCUMENT_CAPS.imagePixels) tooLarge();
  const lossless = meta.format === 'png' || meta.format === 'gif';
  const resized = image.resize(MAX_IMAGE_SIDE, MAX_IMAGE_SIDE, {fit: 'inside', withoutEnlargement: true});
  const output = await (lossless ? resized.png({compressionLevel: 6}) : resized.webp({quality: 90}))
    .toBuffer({resolveWithObject: true})
    .catch(decodeFailure);
  if (output.data.length > DESIGN_DOCUMENT_CAPS.imageBytes) tooLarge();
  return {
    data: output.data,
    extension: lossless ? 'png' : 'webp',
    width: output.info.width,
    height: output.info.height,
  };
}

const isPng = (data: Buffer) => data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
const isWebp = (data: Buffer) => data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';

/** The first page drawn by the editor: PNG or WebP in, a WebP of at most 480 px out. */
export async function encodeThumbnail(input: Buffer): Promise<EncodedImage> {
  const refuse = () => designFail(415, 'invalid_request', 'The thumbnail must be a PNG or WebP image.');
  if (!input.length || !(isPng(input) || isWebp(input))) refuse();
  const image = sharp(input, {limitInputPixels: THUMBNAIL_PIXELS});
  const meta = await image.metadata().catch(refuse);
  if (meta.format !== 'png' && meta.format !== 'webp') refuse();
  const output = await image
    .resize(THUMBNAIL_SIDE, THUMBNAIL_SIDE, {fit: 'inside', withoutEnlargement: true})
    .webp({quality: 80})
    .toBuffer({resolveWithObject: true})
    .catch(refuse);
  return {data: output.data, extension: 'webp', width: output.info.width, height: output.info.height};
}

/** `dz-<uuid>.<ext>` for pictures, `dzt-<uuid>.webp` for thumbnails: never a name the site library makes. */
export const newImageFilename = (kind: 'image' | 'thumbnail', extension: 'webp' | 'png') =>
  `${kind === 'image' ? 'dz' : 'dzt'}-${randomUUID()}.${extension}`;
export const imageUrl = (filename: string) => '/uploads/' + filename;
/** The reference a document uses for a picture: its filename without the extension. */
export const imageRef = (filename: string) => filename.replace(/\.[a-z]+$/, '');

const fileOf = (filename: string) => {
  if (!STORED.test(filename)) throw Error('Unexpected design image filename.');
  return path.join(dataDir, 'uploads', filename);
};
/** Exclusive create: a name that exists already (ours or the library's) is never overwritten. */
export async function writeImageFile(filename: string, data: Buffer) {
  await fs.writeFile(fileOf(filename), data, {flag: 'wx'});
  return storeImageObject(filename.startsWith('dzt-') ? 'thumbnail' : 'image', data);
}

// DESIGN_BLOBS=s3 (docs/BACKEND.md §3 "Pictures", lane B2): every picture written above is also put in the S3-compatible
// store under its content address, the keys crates/blobs uses: `img/<sha256>`, `thumb/<sha256>.webp`. The same bytes are
// stored once (a HEAD first). The local file stays what GET /uploads serves until the readers move to signed links;
// `content_hash`/`storage_key` of design_images (migration 012) take the returned pair. DESIGN_BLOBS=local (the default):
// nothing changes and the pair is null.
export type StoredObject = {contentHash: string; storageKey: string};
const blobsConfig = () => {
  if ((process.env.DESIGN_BLOBS ?? 'local') !== 's3') return null;
  const env = (name: string) => {
    const value = process.env[name];
    if (!value) throw Error(`DESIGN_BLOBS=s3 needs ${name}.`);
    return value;
  };
  return {
    endpoint: env('DESIGN_S3_ENDPOINT').replace(/\/+$/, ''),
    region: process.env.DESIGN_S3_REGION || 'ru-1',
    bucket: env('DESIGN_S3_BUCKET'),
    accessKey: env('DESIGN_S3_ACCESS_KEY'),
    secretKey: env('DESIGN_S3_SECRET_KEY'),
  };
};
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();

/** One path-style S3 request signed with SigV4 (the signing of crates/blobs/src/sigv4.rs), with three tries on 5xx and network errors. */
async function s3Request(
  config: NonNullable<ReturnType<typeof blobsConfig>>,
  method: 'GET' | 'HEAD' | 'PUT',
  key: string,
  body?: Buffer,
  contentType?: string,
) {
  const url = new URL(`${config.endpoint}/${config.bucket}/${key}`);
  const payloadHash = sha256(body ?? '');
  for (let attempt = 1; ; attempt++) {
    const stamp = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '');
    const day = stamp.slice(0, 8);
    const headers: Record<string, string> = {host: url.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': stamp};
    if (contentType) headers['content-type'] = contentType;
    const names = Object.keys(headers).sort();
    const canonical = [
      method,
      url.pathname,
      '',
      ...names.map(name => `${name}:${headers[name]}`),
      '',
      names.join(';'),
      payloadHash,
    ].join('\n');
    const scope = `${day}/${config.region}/s3/aws4_request`;
    const toSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonical)].join('\n');
    const signingKey = hmac(hmac(hmac(hmac('AWS4' + config.secretKey, day), config.region), 's3'), 'aws4_request');
    const signature = createHmac('sha256', signingKey).update(toSign).digest('hex');
    headers.authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
    delete headers.host;
    try {
      const answer = await fetch(url, {
        method,
        headers,
        body: body ? new Uint8Array(body) : undefined,
        signal: AbortSignal.timeout(30_000),
      });
      if (answer.status < 500 || attempt === 3) return answer;
    } catch (error) {
      if (attempt === 3) throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 200 * 2 ** attempt));
  }
}

/** An object of the store (DESIGN_BLOBS=s3) by its key, or null when it is not there: collab's checkpoints (`ckpt/…`) live in
 *  the same bucket. Throws when the store is not configured or refuses. */
export async function readStoreObject(key: string): Promise<Buffer | null> {
  const config = blobsConfig();
  if (!config) throw Error('DESIGN_BLOBS=s3 is not set: the object store is not configured.');
  const answer = await s3Request(config, 'GET', key);
  if (answer.status === 404) return null;
  if (!answer.ok) throw Error(`object store refused ${key}: ${answer.status}`);
  return Buffer.from(await answer.arrayBuffer());
}

/** Puts a picture in the object store under its content address (DESIGN_BLOBS=s3), or does nothing (local). */
export async function storeImageObject(kind: 'image' | 'thumbnail', data: Buffer): Promise<StoredObject | null> {
  const config = blobsConfig();
  if (!config) return null;
  const contentHash = sha256(data);
  const storageKey = kind === 'image' ? `img/${contentHash}` : `thumb/${contentHash}.webp`;
  const head = await s3Request(config, 'HEAD', storageKey);
  if (head.status === 200 && Number(head.headers.get('content-length')) === data.length)
    return {contentHash, storageKey};
  const put = await s3Request(
    config,
    'PUT',
    storageKey,
    data,
    kind === 'image' ? 'application/octet-stream' : 'image/webp',
  );
  if (!put.ok) throw Error(`object store refused ${storageKey}: ${put.status}`);
  return {contentHash, storageKey};
}
export async function copyImageFile(from: string, to: string) {
  await fs.copyFile(fileOf(from), fileOf(to), fs.constants.COPYFILE_EXCL);
}
export async function removeImageFiles(filenames: Iterable<string>) {
  for (const filename of new Set(filenames))
    if (STORED.test(filename)) await fs.rm(path.join(dataDir, 'uploads', filename), {force: true});
}

/** A refused picture names its record (`images.<ref>`), so the editor can put back just that entry. */
const refusedImage = (status: number, message: string, ref: string): never =>
  designFail(status, 'design_document_invalid', message, {path: `images.${ref}`, entry: {table: 'images', key: ref}});

/** Every picture a stored document points at must be its place's: for a personal file, a picture uploaded into one of the account's own
 * design files or one from its own site library; for a team file (`teamId`), a picture uploaded into one of the team's files. Thumbnails
 * are not pictures. A member's own pictures never enter a team file: the other members could not open them. `images` is a document's
 * (or a patch's) picture table, ref → asset; a refusal names the first picture refused. */
export async function assertOwnedDesignImages(
  tx: SqlExecutor,
  userId: string,
  images: Readonly<Record<string, {url: string} | null>>,
  teamId: string | null = null,
) {
  const refs = new Map<string, string>();
  for (const [ref, asset] of Object.entries(images)) {
    if (!asset) continue;
    if (!DESIGN_IMAGE_URL.test(asset.url)) refusedImage(400, 'The image must be uploaded to this account.', ref);
    const file = asset.url.slice('/uploads/'.length);
    if (!refs.has(file)) refs.set(file, ref);
  }
  if (!refs.size) return;
  const files = [...refs.keys()];
  const owned = teamId
    ? await tx.many<{filename: string}>(
        "SELECT filename FROM design_images WHERE team_id=$1 AND kind='image' AND filename=ANY($2::text[])",
        [teamId, files],
      )
    : await tx.many<{filename: string}>(
        `SELECT filename FROM design_images WHERE user_id=$1 AND team_id IS NULL AND kind='image' AND filename=ANY($2::text[])
     UNION SELECT filename FROM uploads WHERE user_id=$1 AND ready=1 AND filename=ANY($2::text[])`,
        [userId, files],
      );
  const mine = new Set(owned.map(row => row.filename));
  const foreign = files.find(file => !mine.has(file));
  if (foreign !== undefined)
    refusedImage(
      403,
      teamId
        ? 'The image is not available to the team. Upload it to the team file.'
        : 'The image is not available to this account. Upload your own copy.',
      refs.get(foreign)!,
    );
}

/** Bytes of the account's own design pictures and thumbnails (not its teams'), counted against `DESIGN_LIMITS.storageBytes`. */
/** The two sums below as SQL of an account's or a team's id (an SQL expression), for a statement that reads them beside other things
 *  (the file list). */
export const designStorageSql = (user: string) => `SELECT COALESCE(sum(bytes),0)::bigint AS bytes FROM design_images WHERE user_id=${user} AND team_id IS NULL`;
export const teamStorageSql = (team: string) => `SELECT COALESCE(sum(bytes),0)::bigint AS bytes FROM design_images WHERE team_id=${team}`;
export async function designStorageUsed(tx: SqlExecutor, userId: string): Promise<number> {
  return (await tx.one<{bytes: number}>(designStorageSql('$1'), [userId]))!.bytes;
}
/** Bytes of a team's design pictures and thumbnails, counted against `DESIGN_LIMITS.storageBytes`. */
export async function teamStorageUsed(tx: SqlExecutor, teamId: string): Promise<number> {
  return (await tx.one<{bytes: number}>(teamStorageSql('$1'), [teamId]))!.bytes;
}
