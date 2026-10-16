// A brand kit's pictures in a file (docs/marketplaces.md §Brand kit). A kit's logo, store logo and icons are design pictures of the files
// they were uploaded into; a file stores only pictures of its own place (server/design/images.ts assertOwnedDesignImages: the account's
// own pictures for a personal file, the team's for a team file), so a picture of another place is copied into the file when the kit is
// applied there, the way a picture moves with a file. A picture the account can no longer read (its team left, its file erased) is left
// out, and the editor says so.
import type {CustomerAuthority} from '../../customer-authority';
import type {SqlExecutor} from '../../postgresql/client';
import type {DesignImageUploaded} from '../../../shared/design/api';
import type {ImageAsset} from '../../../shared/design/types';
import type {KitPicturesAnswer} from '../../../shared/design/marketplace/generation';

export type FileScope = {userId: string; teamId: string | null};
export type PictureDeps = {
  /** The file's place, when the account may edit it (throws the files API's refusal otherwise). */
  fileScope: (actor: CustomerAuthority, fileId: string) => Promise<FileScope>;
  /** Of `filenames`, the ones the file's place already holds. */
  usable: (scope: FileScope, filenames: readonly string[]) => Promise<Set<string>>;
  /** The bytes of one of the account's pictures by its ref (its own, a team's it is in), or null. */
  readImage: (userId: string, ref: string) => Promise<Buffer | null>;
  /** Stores a picture as the file's design picture (counted against its place's storage). */
  storeImage: (actor: CustomerAuthority, fileId: string, image: Buffer, name?: string) => Promise<DesignImageUploaded>;
};

/** Of `filenames`, the pictures a file of `scope` may hold as they are (assertOwnedDesignImages's rule): a team's own design pictures for a
 *  team file; the owner's personal design pictures and uploads for a personal one. */
export async function usableInPlace(
  db: SqlExecutor,
  scope: FileScope,
  filenames: readonly string[],
): Promise<Set<string>> {
  if (!filenames.length) return new Set();
  const rows = scope.teamId
    ? await db.many<{filename: string}>(
        "SELECT filename FROM design_images WHERE team_id=$1 AND kind='image' AND filename=ANY($2::text[])",
        [scope.teamId, filenames],
      )
    : await db.many<{filename: string}>(
        `SELECT filename FROM design_images WHERE user_id=$1 AND team_id IS NULL AND kind='image' AND filename=ANY($2::text[])
         UNION SELECT filename FROM uploads WHERE user_id=$1 AND ready=1 AND filename=ANY($2::text[])`,
        [scope.userId, filenames],
      );
  return new Set(rows.map(row => row.filename));
}

const filenameOf = (asset: ImageAsset) => asset.url.slice('/uploads/'.length);
/** A picture's ref is its filename without the extension (server/design/images.ts imageRef). */
const imageRef = (filename: string) => filename.replace(/\.[a-z]+$/, '');

/** Each of the kit's pictures as `fileId` can hold it: itself when the file's place already has it, else a copy stored in the file. */
export async function kitPicturesFor(
  deps: PictureDeps,
  actor: CustomerAuthority,
  fileId: string,
  assets: readonly ImageAsset[],
): Promise<KitPicturesAnswer> {
  const scope = await deps.fileScope(actor, fileId);
  const unique = [...new Map(assets.map(asset => [asset.url, asset])).values()];
  const have = await deps.usable(scope, unique.map(filenameOf));
  const pictures: KitPicturesAnswer['pictures'] = {};
  for (const asset of unique) {
    const filename = filenameOf(asset);
    if (have.has(filename)) {
      pictures[asset.url] = {ref: imageRef(filename), asset};
      continue;
    }
    const bytes = await deps.readImage(actor.ownerId, imageRef(filename));
    if (!bytes) continue;
    const copy = await deps.storeImage(actor, fileId, bytes, asset.name);
    pictures[asset.url] = {ref: copy.ref, asset: {...copy.asset, ...(asset.name ? {name: asset.name} : {})}};
  }
  return {pictures};
}
