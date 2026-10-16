import {api} from '../../api';
import {readApi} from '../../api-read';
import type {DesignFavourites} from '../../../shared/design/favourites';

// "Favorites" (server/design/favourites.ts, SQL018): the caller's starred files and projects, kept apart from src/design/api.ts.

const BASE = '/design-favourites';
const path = (kind: 'files' | 'projects', id: string) => `${BASE}/${kind}/${encodeURIComponent(id)}`;

export const listDesignFavourites = (signal?: AbortSignal) => readApi<DesignFavourites>(BASE, {signal});
export const starDesign = (kind: 'files' | 'projects', id: string) => api<{ok: true}>(path(kind, id), {method: 'PUT'});
export const unstarDesign = (kind: 'files' | 'projects', id: string) => api<{ok: true}>(path(kind, id), {method: 'DELETE'});
