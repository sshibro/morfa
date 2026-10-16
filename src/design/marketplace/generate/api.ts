// Client of /api/marketplace/generation (shared/design/marketplace/generation.ts lists the routes). Reads retry through readApi; every
// other call goes through api() once.
import {api, post} from '../../../api';
import {readApi} from '../../../api-read';
import type {BrandKit, BrandKitRecord} from '../../../../shared/design/marketplace/brand-kit';
import type {CutOutAnswer, CutOutBody, KitPicturesAnswer} from '../../../../shared/design/marketplace/generation';

const BASE = '/marketplace/generation';
const json = (method: string, data: unknown, signal?: AbortSignal): RequestInit => ({method, body: JSON.stringify(data), ...(signal ? {signal} : {})});
const kit = (id: string) => `${BASE}/brand-kits/${encodeURIComponent(id)}`;

export const readBrandKits = (signal?: AbortSignal) => readApi<{kits: BrandKitRecord[]}>(BASE + '/brand-kits', {signal});
export const createBrandKit = (value: BrandKit) => post<{kit: BrandKitRecord}>(BASE + '/brand-kits', {kit: value});
export const saveBrandKit = (id: string, value: BrandKit) => api<{kit: BrandKitRecord}>(kit(id), json('PATCH', {kit: value}));
export const removeBrandKit = (id: string) => api<{ok: true}>(kit(id), {method: 'DELETE'});
/** The kit's pictures (those of `urls`, or all) as the file can hold them (copied into it where needed). */
export const brandKitPicturesFor = (id: string, fileId: string, urls?: readonly string[]) => post<KitPicturesAnswer>(kit(id) + '/pictures', {fileId, ...(urls ? {urls} : {})});

/** "Remove background": free, on the server. */
export const cutOutFree = (body: CutOutBody, signal?: AbortSignal) => api<CutOutAnswer>(BASE + '/cut-out', json('POST', body, signal));
