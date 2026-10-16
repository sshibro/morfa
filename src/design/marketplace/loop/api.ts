import {api, ApiError} from '../../../api';
import type {
  FileCards,
  LoopConnection,
  LoopLink,
  LoopProduct,
  LoopPublication,
  LoopState,
  LoopTest,
  TestMode,
  TestWinner,
} from '../../../../shared/design/marketplace/loop';

// Performance Loop's calls to /api/marketplace (server/marketplace/loop/router.ts). A 404 on the loop's own routes means the switch is
// off (ENABLE_MARKETPLACE_API): "Sales" then says so instead of an error.

/** The loop's state for the account, or null when it is off. */
export async function readLoopState(signal?: AbortSignal): Promise<LoopState | null> {
  try {
    return await api<LoopState>('/marketplace/loop', {signal});
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

export const readFileCards = (fileId: string, signal?: AbortSignal) =>
  api<FileCards>(`/marketplace/files/${encodeURIComponent(fileId)}/cards`, {signal});

export type NewConnection =
  | {marketplace: 'wb'; label?: string; token: string}
  | {marketplace: 'ozon'; label?: string; clientId: string; apiKey: string};
export const connectMarketplace = (input: NewConnection) =>
  api<{connection: LoopConnection}>('/marketplace/connections', {method: 'POST', body: JSON.stringify(input)});
/** "Reconnect": a new key for the connection. */
export type MarketplaceKey = {token: string} | {clientId: string; apiKey: string};
export const replaceMarketplaceKey = (id: string, input: MarketplaceKey) =>
  api<{connection: LoopConnection}>(`/marketplace/connections/${encodeURIComponent(id)}/key`, {method: 'POST', body: JSON.stringify(input)});
export const disconnectMarketplace = (id: string) => api<{ok: true}>(`/marketplace/connections/${encodeURIComponent(id)}`, {method: 'DELETE'});
export const searchProducts = (connectionId: string, query: string, signal?: AbortSignal) =>
  api<{products: LoopProduct[]}>(`/marketplace/connections/${encodeURIComponent(connectionId)}/products?q=${encodeURIComponent(query)}`, {signal});

export const linkCard = (input: {fileId: string; nodeId: string; connectionId: string; productId: string; slot: number}) =>
  api<{link: LoopLink}>('/marketplace/links', {method: 'POST', body: JSON.stringify(input)});
export const unlinkCard = (id: string) => api<{ok: true}>(`/marketplace/links/${encodeURIComponent(id)}`, {method: 'DELETE'});

export function publishCard(linkId: string, image: Blob, filename: string) {
  const form = new FormData();
  form.append('linkId', linkId);
  form.append('image', image, filename);
  return api<{publication: LoopPublication}>('/marketplace/publish', {method: 'POST', body: form});
}

export function createAbTest(input: {linkId: string; variantB: string; mode: TestMode; days: number; swapHours?: number}, pictures: {a: Blob; b: Blob} | null) {
  const form = new FormData();
  form.append('linkId', input.linkId);
  form.append('variantB', input.variantB);
  form.append('mode', input.mode);
  form.append('days', String(input.days));
  if (input.swapHours) form.append('swapHours', String(input.swapHours));
  if (pictures) {
    form.append('a', pictures.a, 'a' + extensionOf(pictures.a));
    form.append('b', pictures.b, 'b' + extensionOf(pictures.b));
  }
  return api<{test: LoopTest}>('/marketplace/tests', {method: 'POST', body: form});
}
export const startCabinetTest = (id: string, startedOn: string | null) =>
  api<{test: LoopTest}>(`/marketplace/tests/${encodeURIComponent(id)}/start`, {method: 'POST', body: JSON.stringify({startedOn})});
export const setTestWinner = (id: string, winner: TestWinner) =>
  api<{test: LoopTest}>(`/marketplace/tests/${encodeURIComponent(id)}/winner`, {method: 'POST', body: JSON.stringify({winner})});
export const stopAbTest = (id: string) => api<{test: LoopTest}>(`/marketplace/tests/${encodeURIComponent(id)}/stop`, {method: 'POST'});
/** The link follows another frame (the next round starts from the winner). */
export const moveLink = (id: string, nodeId: string) =>
  api<{link: LoopLink}>(`/marketplace/links/${encodeURIComponent(id)}/node`, {method: 'POST', body: JSON.stringify({nodeId})});

export const extensionOf = (blob: Blob) => (blob.type === 'image/png' ? '.png' : blob.type === 'image/webp' ? '.webp' : '.jpg');
