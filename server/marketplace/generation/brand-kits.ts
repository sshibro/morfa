// Brand kits (docs/marketplaces.md §Brand kit): an account's fonts, colours, logos, icons, kept in marketplace_brand_kits
// (migration 027) as the editor edits them. Only the account that made a kit reads or changes it; an account keeps at most
// BRAND_KITS_PER_ACCOUNT, counted under the account's lock so two tabs cannot pass it together. Pictures in a kit are the account's
// design pictures by their /uploads address; whether one can still be read is checked when the kit is used (pictures.ts).
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import {
  BRAND_KIT_ICONS,
  BRAND_KIT_NAME_CHARS,
  BRAND_KITS_PER_ACCOUNT,
  type BrandKit,
  type BrandKitRecord,
} from '../../../shared/design/marketplace/brand-kit';
import {DESIGN_IMAGE_URL} from '../../../shared/design/schema';
import type {Database} from '../../postgresql/client';
import {lockResources} from '../../postgresql/locks';

const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .transform(value => value.toLowerCase());
const family = z.string().trim().min(1).max(100);
const picture = z
  .object({
    url: z.string().regex(DESIGN_IMAGE_URL),
    width: z.number().int().min(1).max(16384),
    height: z.number().int().min(1).max(16384),
    name: z.string().max(200).optional(),
  })
  .strict();

/** A kit as the server stores it: every field of shared/design/marketplace/brand-kit.ts checked, nothing else kept. */
export const brandKitSchema: z.ZodType<BrandKit, z.ZodTypeDef, unknown> = z
  .object({
    v: z.literal(1),
    name: z
      .string()
      .transform(text => text.replace(/\s+/g, ' ').trim())
      .pipe(z.string().min(1).max(BRAND_KIT_NAME_CHARS)),
    colors: z.object({primary: hex, secondary: hex, accent: hex, background: hex, text: hex}).strict(),
    fonts: z.object({heading: family, body: family}).strict(),
    logo: picture.nullable(),
    storeLogo: picture.nullable(),
    icons: z.array(picture).max(BRAND_KIT_ICONS),
  })
  .strict();

export const BRAND_KIT_TEXTS = {
  limit: `There are already ${BRAND_KITS_PER_ACCOUNT} brand kits: delete one you do not need to add a new one.`,
  notFound: 'Brand kit not found.',
  invalid: 'The brand kit was not saved: check the name, colours and fonts.',
} as const;

type Row = {id: string; name: string; kit: BrandKit; updated_at: string};
const recordOf = (row: Row): BrandKitRecord => ({id: row.id, name: row.name, kit: row.kit, updatedAt: row.updated_at});
const COLUMNS = 'id,name,kit,updated_at';

/** The account's kits, the last changed first. */
export async function listBrandKits(db: Database, userId: string): Promise<BrandKitRecord[]> {
  const rows = await db.many<Row>(
    `SELECT ${COLUMNS} FROM marketplace_brand_kits WHERE user_id=$1 ORDER BY updated_at DESC, id LIMIT ${BRAND_KITS_PER_ACCOUNT}`,
    [userId],
  );
  return rows.map(recordOf);
}

export async function readBrandKit(db: Database, userId: string, id: string): Promise<BrandKitRecord | null> {
  const row = await db.one<Row>(`SELECT ${COLUMNS} FROM marketplace_brand_kits WHERE id=$1 AND user_id=$2`, [
    id,
    userId,
  ]);
  return row ? recordOf(row) : null;
}

/** A new kit, or null when the account already has BRAND_KITS_PER_ACCOUNT. */
export async function createBrandKit(db: Database, userId: string, kit: BrandKit): Promise<BrandKitRecord | null> {
  return db.transaction(async tx => {
    await lockResources(tx, [{kind: 'account', id: userId}]);
    const count = await tx.one<{n: number}>('SELECT count(*)::int AS n FROM marketplace_brand_kits WHERE user_id=$1', [
      userId,
    ]);
    if ((count?.n ?? 0) >= BRAND_KITS_PER_ACCOUNT) return null;
    const row = await tx.one<Row>(
      `INSERT INTO marketplace_brand_kits(id,user_id,name,kit) VALUES($1,$2,$3,$4::jsonb) RETURNING ${COLUMNS}`,
      [randomUUID(), userId, kit.name, JSON.stringify(kit)],
    );
    return recordOf(row!);
  });
}

/** The kit replaced, or null when it is not the account's. */
export async function updateBrandKit(
  db: Database,
  userId: string,
  id: string,
  kit: BrandKit,
): Promise<BrandKitRecord | null> {
  const row = await db.one<Row>(
    `UPDATE marketplace_brand_kits SET name=$3,kit=$4::jsonb,updated_at=clock_timestamp() WHERE id=$1 AND user_id=$2 RETURNING ${COLUMNS}`,
    [id, userId, kit.name, JSON.stringify(kit)],
  );
  return row ? recordOf(row) : null;
}

export async function deleteBrandKit(db: Database, userId: string, id: string): Promise<boolean> {
  return (await db.execute('DELETE FROM marketplace_brand_kits WHERE id=$1 AND user_id=$2', [id, userId])).changes > 0;
}
