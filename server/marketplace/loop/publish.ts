// Publishing one picture into a linked photo slot (docs/marketplaces.md §Performance Loop): "Publish" in "Sales", and the
// rotation's swaps from the worker. The picture is kept with a fresh public link (Ozon downloads it), a publication row records the
// attempt, the marketplace is called outside any transaction, and the answer settles the row: a picture that is live closes the
// previous live one's hours, which is what the numbers are counted to.
import {db} from '../../db';
import type {SqlExecutor} from '../../postgresql/client';
import {lockResources} from '../../postgresql/locks';
import {captureError} from '../../admin/telemetry';
import {randomUUID} from 'node:crypto';
import type {ConnectionStatus, LoopPublication} from '../../../shared/design/marketplace/loop';
import {isMarketplaceError, marketplaceAdapters} from './adapters';
import {loopNow} from './clock';
import {CONFIRM_WITHIN_MS, mediaExpiry} from './config';
import {pictureKind, storeMedia} from './media';
import {iso, openSecret, PUBLICATION_COLUMNS, publicationOf, type LinkRow, type PublicationRow} from './store';

export type LinkWithKey = LinkRow & {secret: string; connection_status: ConnectionStatus};

const FAILED = 'Could not publish. Try again.';
const OZON_FORMATS = 'Ozon accepts JPG and PNG pictures. Choose one of them in the card Export.';

const readPublication = async (tx: SqlExecutor, id: string): Promise<LoopPublication> =>
  publicationOf(
    (await tx.one<PublicationRow>(`SELECT ${PUBLICATION_COLUMNS} FROM marketplace_publications p WHERE p.id=$1`, [
      id,
    ]))!,
  );

/** The picture is the slot's live photo from `at`: the one live before it ends there. */
export async function markLive(tx: SqlExecutor, publicationId: string, linkId: string, at: number): Promise<void> {
  await tx.execute(
    "UPDATE marketplace_publications SET status='replaced',live_until=$3 WHERE link_id=$1 AND status='live' AND id<>$2",
    [linkId, publicationId, iso(at)],
  );
  await tx.execute(
    "UPDATE marketplace_publications SET status='live',live_from=$2,sent_at=coalesce(sent_at,$2),error=NULL WHERE id=$1",
    [publicationId, iso(at)],
  );
}

/** A connection whose key the marketplace refused stops until the seller enters it again. */
export const refuseConnection = (tx: SqlExecutor, connectionId: string, message: string, at: number) =>
  tx.execute("UPDATE marketplace_connections SET status='refused',last_error=$2,checked_at=$3 WHERE id=$1", [
    connectionId,
    message.slice(0, 500),
    iso(at),
  ]);

/**
 * Sends `bytes` (a JPEG, PNG or WebP) as frame `nodeId`'s picture into the link's slot and answers the publication as it ended:
 * live (WB), sent (Ozon processes it; the worker confirms it), or failed with the marketplace's words.
 */
export async function publishPicture(input: {
  userId: string;
  link: LinkWithKey;
  nodeId: string;
  testId: string | null;
  bytes: Buffer;
}): Promise<LoopPublication> {
  const {userId, link, nodeId, testId, bytes} = input;
  const kind = pictureKind(bytes);
  if (!kind)
    throw Object.assign(new Error('The picture must be JPG, PNG or WebP.'), {
      status: 415,
      code: 'invalid_request',
    });
  if (link.marketplace === 'ozon' && kind.extension === 'webp')
    throw Object.assign(new Error(OZON_FORMATS), {status: 415, code: 'invalid_request'});
  const now = loopNow();
  const id = randomUUID();
  const media = await db.transaction(async tx => {
    const stored = await storeMedia(tx, {userId, bytes, kind, expiresAt: mediaExpiry(now).getTime()});
    await tx.execute(
      'INSERT INTO marketplace_publications(id,user_id,link_id,node_id,test_id,media_id,requested_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, userId, link.id, nodeId, testId, stored.id, iso(now)],
    );
    return stored;
  });
  try {
    const adapters = await marketplaceAdapters();
    const answer = await adapters[link.marketplace].publish(openSecret(userId, link.secret), {
      productId: link.product_id,
      slot: link.slot,
      bytes,
      contentType: media.contentType,
      filename: media.filename,
      url: media.url,
    });
    const at = loopNow();
    await db.transaction(async tx => {
      await lockResources(tx, [{kind: 'account', id: userId}]);
      // A newer picture for the slot supersedes one still processing.
      await tx.execute(
        "UPDATE marketplace_publications SET status='replaced' WHERE link_id=$1 AND status IN('pending','sent') AND id<>$2 AND requested_at<=$3",
        [link.id, id, iso(now)],
      );
      await tx.execute("UPDATE marketplace_publications SET status='sent',sent_at=$2,external_ref=$3 WHERE id=$1", [
        id,
        iso(at),
        answer.externalRef,
      ]);
      if (answer.state === 'live') await markLive(tx, id, link.id, at);
      await tx.execute(
        "UPDATE marketplace_connections SET status='ok',last_error=NULL,checked_at=$2 WHERE id=$1 AND status<>'ok'",
        [link.connection_id, iso(at)],
      );
    });
  } catch (error) {
    const message = isMarketplaceError(error) ? error.message : FAILED;
    await db.transaction(async tx => {
      await tx.execute("UPDATE marketplace_publications SET status='failed',error=$2 WHERE id=$1", [
        id,
        message.slice(0, 500),
      ]);
      if (isMarketplaceError(error) && error.kind === 'refused')
        await refuseConnection(tx, link.connection_id, message, loopNow());
    });
    if (!isMarketplaceError(error)) void captureError(error, 'backend');
  }
  return readPublication(db, id);
}

/** The worker: pictures a marketplace is processing (Ozon) are asked about again; one not taken in a day is reported failed. */
export async function confirmPublications(now: number): Promise<void> {
  const open = await db.many<{
    id: string;
    user_id: string;
    link_id: string;
    product_id: string;
    external_ref: string | null;
    sent_at: string;
    connection_id: string;
    marketplace: 'wb' | 'ozon';
    secret: string;
    connection_status: ConnectionStatus;
  }>(
    `SELECT p.id,p.user_id,p.link_id,l.product_id,p.external_ref,p.sent_at,l.connection_id,c.marketplace,c.secret,c.status AS connection_status
       FROM marketplace_publications p
       JOIN marketplace_card_links l ON l.id=p.link_id
       JOIN marketplace_connections c ON c.id=l.connection_id
      WHERE p.status='sent' ORDER BY p.requested_at LIMIT 200`,
  );
  const adapters = await marketplaceAdapters();
  for (const row of open) {
    if (row.connection_status === 'refused') continue;
    try {
      const state = await adapters[row.marketplace].publication(openSecret(row.user_id, row.secret), {
        productId: row.product_id,
        externalRef: row.external_ref,
      });
      if (state === 'live') {
        await db.transaction(async tx => {
          await lockResources(tx, [{kind: 'account', id: row.user_id}]);
          // Settled meanwhile (superseded by a newer picture): leave it.
          if (
            (
              await tx.one<{status: string}>('SELECT status FROM marketplace_publications WHERE id=$1 FOR UPDATE', [
                row.id,
              ])
            )?.status !== 'sent'
          )
            return;
          await markLive(tx, row.id, row.link_id, now);
        });
      } else if (typeof state === 'object' || now - Date.parse(row.sent_at) > CONFIRM_WITHIN_MS) {
        const error =
          typeof state === 'object'
            ? state.failed
            : 'The marketplace did not confirm the picture within a day. Publish it again.';
        await db.execute("UPDATE marketplace_publications SET status='failed',error=$2 WHERE id=$1 AND status='sent'", [
          row.id,
          error.slice(0, 500),
        ]);
      }
    } catch (error) {
      if (isMarketplaceError(error) && error.kind === 'refused')
        await refuseConnection(db, row.connection_id, error.message, now);
      else if (!isMarketplaceError(error)) throw error;
    }
  }
}
