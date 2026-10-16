// The Performance Loop's rows (migration 027): how a connection, a card link, a publication and a test read for the editor, and the
// seller's key sealed with the account (server/hosting/secrets.ts; AES-256-GCM bound to `marketplace:<account>`). The key is decrypted
// only to call the marketplace and never leaves the server.
import {decrypt, encrypt} from '../../hosting/secrets';
import type {SqlExecutor} from '../../postgresql/client';
import type {
  ConnectionStatus,
  LoopConnection,
  LoopLink,
  LoopMarketplace,
  LoopPublication,
  LoopTest,
  PublicationStatus,
  TestMode,
  TestResult,
  TestStatus,
  TestVariant,
  TestWinner,
} from '../../../shared/design/marketplace/loop';
import type {MarketplaceSecret} from './adapters';

const secretContext = (userId: string) => `marketplace:${userId}`;
export const sealSecret = (userId: string, secret: MarketplaceSecret): string => encrypt(secret, secretContext(userId));
export function openSecret(userId: string, sealed: string): MarketplaceSecret {
  const value = decrypt(sealed, secretContext(userId)) as MarketplaceSecret;
  if (value?.kind === 'wb' && typeof value.token === 'string') return value;
  if (value?.kind === 'ozon' && typeof value.clientId === 'string' && typeof value.apiKey === 'string') return value;
  throw Error('A marketplace key of an unknown shape.');
}

export type ConnectionRow = {
  id: string;
  user_id: string;
  marketplace: LoopMarketplace;
  label: string;
  secret: string;
  hint: string;
  status: ConnectionStatus;
  last_error: string | null;
  checked_at: string | null;
  synced_at: string | null;
  created_at: string;
};
export const CONNECTION_COLUMNS =
  'c.id,c.user_id,c.marketplace,c.label,c.secret,c.hint,c.status,c.last_error,c.checked_at,c.synced_at,c.created_at';
export const connectionOf = (row: ConnectionRow): LoopConnection => ({
  id: row.id,
  marketplace: row.marketplace,
  label: row.label,
  hint: row.hint,
  status: row.status,
  lastError: row.last_error,
  checkedAt: row.checked_at,
  syncedAt: row.synced_at,
  createdAt: row.created_at,
});

export type LinkRow = {
  id: string;
  user_id: string;
  file_id: string;
  node_id: string;
  connection_id: string;
  marketplace: LoopMarketplace;
  product_id: string;
  sku: string | null;
  title: string | null;
  slot: number;
  created_at: string;
};
export const LINK_COLUMNS =
  'l.id,l.user_id,l.file_id,l.node_id,l.connection_id,c.marketplace,l.product_id,l.sku,l.title,l.slot,l.created_at';
export const linkOf = (row: LinkRow): LoopLink => ({
  id: row.id,
  nodeId: row.node_id,
  connectionId: row.connection_id,
  marketplace: row.marketplace,
  productId: row.product_id,
  sku: row.sku,
  title: row.title,
  slot: Number(row.slot),
  createdAt: row.created_at,
});

export type PublicationRow = {
  id: string;
  link_id: string;
  node_id: string;
  test_id: string | null;
  media_id: string | null;
  status: PublicationStatus;
  external_ref: string | null;
  error: string | null;
  requested_at: string;
  sent_at: string | null;
  live_from: string | null;
  live_until: string | null;
};
export const PUBLICATION_COLUMNS =
  'p.id,p.link_id,p.node_id,p.test_id,p.media_id,p.status,p.external_ref,p.error,p.requested_at,p.sent_at,p.live_from,p.live_until';
export const publicationOf = (row: PublicationRow): LoopPublication => ({
  id: row.id,
  linkId: row.link_id,
  nodeId: row.node_id,
  testId: row.test_id,
  status: row.status,
  error: row.error,
  requestedAt: row.requested_at,
  sentAt: row.sent_at,
  liveFrom: row.live_from,
  liveUntil: row.live_until,
});

export type TestRow = {
  id: string;
  user_id: string;
  link_id: string;
  file_id: string;
  variant_a: string;
  variant_b: string;
  media_a: string | null;
  media_b: string | null;
  mode: TestMode;
  status: TestStatus;
  days: number;
  swap_hours: number | null;
  live_variant: TestVariant | null;
  next_swap_at: string | null;
  started_at: string | null;
  ends_at: string | null;
  finished_at: string | null;
  winner: TestWinner | null;
  result: TestResult | null;
  created_at: string;
};
export const TEST_COLUMNS =
  't.id,t.user_id,t.link_id,t.file_id,t.variant_a,t.variant_b,t.media_a,t.media_b,t.mode,t.status,t.days,t.swap_hours,t.live_variant,' +
  't.next_swap_at,t.started_at,t.ends_at,t.finished_at,t.winner,t.result,t.created_at';
export const testOf = (row: TestRow): LoopTest => ({
  id: row.id,
  linkId: row.link_id,
  variantA: row.variant_a,
  variantB: row.variant_b,
  mode: row.mode,
  status: row.status,
  days: Number(row.days),
  swapHours: row.swap_hours === null ? null : Number(row.swap_hours),
  liveVariant: row.live_variant,
  nextSwapAt: row.next_swap_at,
  startedAt: row.started_at,
  endsAt: row.ends_at,
  finishedAt: row.finished_at,
  winner: row.winner,
  result: row.result,
  createdAt: row.created_at,
});

/** The caller's own link with its connection's key and state; undefined when it is not theirs. */
export const readLink = (tx: SqlExecutor, userId: string, linkId: string) =>
  tx.one<LinkRow & {secret: string; connection_status: ConnectionStatus}>(
    `SELECT ${LINK_COLUMNS},c.secret,c.status AS connection_status
       FROM marketplace_card_links l JOIN marketplace_connections c ON c.id=l.connection_id
      WHERE l.id=$1 AND l.user_id=$2`,
    [linkId, userId],
  );

export const iso = (at: number | Date) => new Date(at).toISOString();
