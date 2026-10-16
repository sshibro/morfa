// "Marketplaces" with the account (server/launch/lifecycle.ts eraseAccount): every row of migration 027 the account made (brand kits,
// connections and their keys, card links, pictures, publications, tests and the numbers its connections read) and the picture files.
import type {TransactionContext} from '../../postgresql/client';
import {removeMediaFiles} from './media';

export async function eraseMarketplaceOf(tx: TransactionContext, userId: string): Promise<void> {
  const files = await tx.many<{filename: string}>('SELECT filename FROM marketplace_media WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM marketplace_publications WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM marketplace_tests WHERE user_id=$1', [userId]);
  await tx.execute(
    'DELETE FROM marketplace_metrics WHERE connection_id IN (SELECT id FROM marketplace_connections WHERE user_id=$1)',
    [userId],
  );
  await tx.execute('DELETE FROM marketplace_card_links WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM marketplace_media WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM marketplace_connections WHERE user_id=$1', [userId]);
  await tx.execute('DELETE FROM marketplace_brand_kits WHERE user_id=$1', [userId]);
  // The files go once their rows are gone in this transaction; a rollback retries the whole erasure on the next pass.
  await removeMediaFiles(files.map(file => file.filename));
}
