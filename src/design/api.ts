import {api, ApiError, apiAccount, apiGeneration, post} from '../api';
import {readApi, type ReadProgress} from '../api-read';
import type {DesignDocument, NodeId} from '../../shared/design/types';
import type {DesignPageSlice} from '../../shared/design/pages';
import type {DocumentPatch} from '../../shared/design/patch';
import type {PdfMeasurements} from '../../shared/design/pdf-export';
import type {DesignFileCreate, DesignFileList, DesignFileMove, DesignFileOpened, DesignFileSummary, DesignImageUploaded, DesignPatchContext, DesignSaved, DesignVersionSummary} from '../../shared/design/api';
import type {
  DesignFileGuestRole,
  DesignFileLinkAccess,
  DesignFileSharing,
  DesignSharedFile,
} from '../../shared/design/teams';

// Client of `/api/design-files` (docs/design-tool.md §Server API). Reads retry through readApi;
// writes go through api(), which carries the account header and its generation check.

const BASE = '/design-files';
const file = (id: string) => `${BASE}/${encodeURIComponent(id)}`;
const json = (method: string, data: unknown): RequestInit => ({method, body: JSON.stringify(data)});
/** A document body (autosave's patch, a whole document) as a Blob: the browser takes a Blob's bytes as they are, where a
 *  string body is copied and encoded on the main thread first — 80 ms for a 4 MB patch (5 000 layers recoloured), 400 ms
 *  at a quarter of the speed, measured 2026-10-07. The same bytes go out, with the same JSON content type. */
const jsonDocument = (method: string, data: unknown): RequestInit => ({method, body: new Blob([JSON.stringify(data)], {type: 'application/json'})});

/** The caller's personal files, or a team's (`team`), optionally one project's (docs/design-tool.md §Teams). */
export function listDesignFiles(options: {trash?: boolean; team?: string; project?: string; signal?: AbortSignal} = {}) {
  const query = new URLSearchParams();
  if (options.trash) query.set('trash', '1');
  if (options.team) query.set('team', options.team);
  if (options.team && options.project) query.set('project', options.project);
  const search = query.toString();
  return readApi<DesignFileList>(BASE + (search ? '?' + search : ''), {signal: options.signal});
}
export const createDesignFile = (data: DesignFileCreate = {}) => post<{file: DesignFileSummary}>(BASE, data);
/** Whole documents and pages (tens of MB over a slow link, lane O): the server may take a while to start the answer (a cold
 *  read of a big file parses it first), then the read lasts as long as bytes keep arriving; it fails only when they stop. */
const DOCUMENT_READ = {timeoutMs: 30_000, stallMs: 15_000} as const;
export type DocumentReadOptions = {signal?: AbortSignal; onProgress?: (progress: ReadProgress) => void};
export const openDesignFile = (id: string, signal?: AbortSignal, options: Omit<DocumentReadOptions, 'signal'> = {}) => readApi<DesignFileOpened>(file(id), {...DOCUMENT_READ, ...options, signal});
/** The editor's open with a cached copy at `have` (src/design/editor/checkpoint-cache.ts): a server whose copy is still that
 *  version answers without the document (`current: true`); otherwise — or a server that does not know `have` — the whole file. */
export type DesignFileCurrent = Omit<DesignFileOpened, 'document'> & {current: true; document?: undefined};
export const openDesignFileSince = (id: string, have: number | null, options: DocumentReadOptions = {}) =>
  readApi<(DesignFileOpened & {current?: undefined}) | DesignFileCurrent>(file(id) + (have === null ? '' : '?have=' + have), {...DOCUMENT_READ, ...options});
/** Big files (docs/decisions/big-files.md §3): the skeleton (`partial` set), then the pages the editor shows — or `whole`: a file
 *  the server would parse again for every read (one 400 MB page), to open whole instead (lane O). */
/** `whole`: `small` — one the fixed caps hold, opened as with big files off; `big` — one the server cannot keep parsed. */
export type DesignFileWhole = Omit<DesignFileOpened, 'document' | 'partial'> & {whole: 'small' | 'big'; document?: undefined};
/** `always`: pages on demand even for a small file (`?pages=1` in the address: the page machinery's tests). */
export const openDesignSkeleton = (id: string, signal?: AbortSignal, always = false) =>
  readApi<(DesignFileOpened & {whole?: undefined}) | DesignFileWhole>(file(id) + '?pages=skeleton' + (always ? '&always=1' : ''), {...DOCUMENT_READ, signal});
export const loadDesignPage = (id: string, pageId: NodeId, signal?: AbortSignal, options: Omit<DocumentReadOptions, 'signal'> = {}) =>
  readApi<DesignPageSlice>(file(id) + '/pages/' + encodeURIComponent(pageId), {...DOCUMENT_READ, ...options, signal});
export const patchDesignDocument = (id: string, baseVersion: number, patch: DocumentPatch, init: RequestInit = {}, context?: DesignPatchContext) =>
  api<DesignSaved>(file(id) + '/document', {...jsonDocument('PATCH', {baseVersion, patch, ...context}), ...init});
/** A patch body already written (`{"baseVersion":…,"patch":…}` as a Blob): a big imported file's layers in parts
 *  (src/design/import/figma/run-import.ts `saveInParts`). */
export const patchDesignDocumentBody = (id: string, body: Blob) => api<DesignSaved>(file(id) + '/document', {method: 'PATCH', body});
export const replaceDesignDocument = (id: string, baseVersion: number, document: DesignDocument) =>
  api<DesignSaved>(file(id) + '/document', jsonDocument('PUT', {baseVersion, document}));
export const renameDesignFile = (id: string, name: string) => api<{file: DesignFileSummary}>(file(id), json('PATCH', {name}));
export const duplicateDesignFile = (id: string) => post<{file: DesignFileSummary}>(file(id) + '/duplicate');
export const trashDesignFile = (id: string) => api<{ok: true}>(file(id), {method: 'DELETE'});
export const eraseDesignFile = (id: string) => api<{ok: true}>(file(id) + '?permanent=1', {method: 'DELETE'});
/** A file came back from the trash: an open file browser reads its list again (the editor's "Undo" runs once it has gone there). */
export const DESIGN_FILES_CHANGED_EVENT = 'morfa-design-files-changed';
export const restoreDesignFile = (id: string) =>
  post<{file: DesignFileSummary}>(file(id) + '/restore').then(answer => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(DESIGN_FILES_CHANGED_EVENT));
    return answer;
  });
/** Between a team's projects, into a team, or back to the caller's personal files (teamId null). */
export const moveDesignFile = (id: string, target: DesignFileMove) => post<{file: DesignFileSummary}>(file(id) + '/move', target);
// Sharing one file (docs/design-tool.md §Teams, "File access"; the routes are listed in shared/design/teams.ts).
export const listSharedDesignFiles = (signal?: AbortSignal) => readApi<{files: DesignSharedFile[]}>(BASE + '?shared=1', {signal});
export const readFileSharing = (id: string, signal?: AbortSignal) => readApi<DesignFileSharing>(file(id) + '/sharing', {signal, retryDelays: []});
export const setDesignFileLink = (id: string, link: DesignFileLinkAccess) => api<DesignFileSharing>(file(id) + '/sharing', json('PATCH', {link}));
export const setDesignFileGuestRole = (id: string, userId: string, role: DesignFileGuestRole) =>
  api<DesignFileSharing>(`${file(id)}/sharing/guests/${encodeURIComponent(userId)}`, json('PATCH', {role}));
/** "Remove access" (a sharer), or with `me` "Remove from shared with me" (the guest themselves; answers {ok}). */
export const removeDesignFileGuest = (id: string, userId: string) =>
  api<DesignFileSharing | {ok: true}>(`${file(id)}/sharing/guests/${encodeURIComponent(userId)}`, {method: 'DELETE'});

export const uploadDesignThumbnail = (id: string, image: Blob) =>
  api<{thumbnailUrl: string}>(file(id) + '/thumbnail', {method: 'PUT', body: image, headers: {'Content-Type': image.type}});
export function uploadDesignImage(id: string, image: Blob, name = 'image') {
  const data = new FormData();
  data.append('file', image, name);
  return api<DesignImageUploaded>(file(id) + '/images', {method: 'POST', body: data});
}
export const listDesignVersions = (id: string) => readApi<{versions: DesignVersionSummary[]}>(file(id) + '/versions');
export const saveDesignVersion = (id: string, label: string) => post<{version: DesignVersionSummary}>(file(id) + '/versions', {label});
export const readDesignVersion = (id: string, versionId: string) => readApi<{document: DesignDocument}>(`${file(id)}/versions/${encodeURIComponent(versionId)}`, DOCUMENT_READ);
export const restoreDesignVersion = (id: string, versionId: string, baseVersion: number) =>
  post<DesignSaved>(`${file(id)}/versions/${encodeURIComponent(versionId)}/restore`, {baseVersion});
/** "Rename" of a version: its label (`model.ts` encodeVersionLabel); an automatic version becomes a named one. */
export const renameDesignVersion = (id: string, versionId: string, label: string) =>
  api<{version: DesignVersionSummary}>(`${file(id)}/versions/${encodeURIComponent(versionId)}`, json('PATCH', {label}));
/** "Make a copy of the file" of a version: a new file in the same place holding that version (the file stays as it is). */
export const duplicateDesignVersion = (id: string, versionId: string, name?: string) =>
  post<{file: DesignFileSummary}>(`${file(id)}/versions/${encodeURIComponent(versionId)}/duplicate`, name ? {name} : {});

export type DesignRasterRequest = {version: number; nodeIds: string[]; format: 'png' | 'jpeg' | 'webp'; scale?: number; maxSide?: number; quality?: number};
export type DesignRasterAnswer = {blob: Blob; missingFonts: string[]};

/** POST /:id/export/raster: PNG/JPG/WebP painted by the render service (/api/config `designRaster`). Binary, so not
 *  through api(); the same account checks as the PDF. A 404/503 means the service is not there: the caller paints itself. */
export async function exportDesignRaster(id: string, body: DesignRasterRequest, signal?: AbortSignal): Promise<DesignRasterAnswer> {
  const generation = apiGeneration();
  const account = apiAccount();
  const changed = () => new ApiError('The account has changed. Repeat the action.', 409);
  const response = await fetch('/api' + file(id) + '/export/raster', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', ...(account ? {'X-Forma-Account': account} : {})},
    body: JSON.stringify(body),
    signal,
  });
  if (generation !== apiGeneration()) throw changed();
  if (!response.ok) {
    const data = await response.json().catch(() => null) as {error?: string; code?: string; retryable?: boolean; currentVersion?: number} | null;
    if (generation !== apiGeneration()) throw changed();
    if (account && (response.status === 401 || (response.status === 409 && data?.code === 'account_changed'))) window.dispatchEvent(new Event('forma-session-changed'));
    throw new ApiError(data?.error || 'Could not render the image on the server.', response.status, data ?? {code: response.status === 429 ? 'rate_limited' : undefined});
  }
  const blob = await response.blob();
  if (generation !== apiGeneration()) throw changed();
  let missingFonts: string[] = [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(response.headers.get('X-Design-Raster-Missing-Fonts') ?? '%5B%5D'));
    if (Array.isArray(parsed)) missingFonts = parsed.filter((name): name is string => typeof name === 'string');
  } catch {
    // An unreadable header only loses the note about fonts.
  }
  return {blob, missingFonts};
}

export type DesignPdfRequest = {version: number; nodeIds: string[]; title?: string; measurements: PdfMeasurements};
export type DesignPdfAnswer = {blob: Blob; pages: number; unmeasured: number; missingFonts: string[]};

/** POST /:id/export/pdf (docs/design-tool.md §Export): the vector PDF the server prints. Binary, so not through api();
 *  the same account header and account-generation check: an answer that arrives for another account is dropped. */
export async function exportDesignPdf(id: string, body: DesignPdfRequest, signal?: AbortSignal): Promise<DesignPdfAnswer> {
  const generation = apiGeneration();
  const account = apiAccount();
  const changed = () => new ApiError('The account has changed. Repeat the action.', 409);
  const response = await fetch('/api' + file(id) + '/export/pdf', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', ...(account ? {'X-Forma-Account': account} : {})},
    body: JSON.stringify(body),
    signal,
  });
  if (generation !== apiGeneration()) throw changed();
  if (!response.ok) {
    const data = await response.json().catch(() => null) as {error?: string; code?: string; retryable?: boolean; currentVersion?: number} | null;
    if (generation !== apiGeneration()) throw changed();
    if (account && (response.status === 401 || (response.status === 409 && data?.code === 'account_changed'))) window.dispatchEvent(new Event('forma-session-changed'));
    throw new ApiError(data?.error || 'Could not build the PDF.', response.status, data ?? {code: response.status === 429 ? 'rate_limited' : undefined});
  }
  const blob = await response.blob();
  if (generation !== apiGeneration()) throw changed();
  let missingFonts: string[] = [];
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(response.headers.get('X-Design-Pdf-Missing-Fonts') ?? '%5B%5D'));
    if (Array.isArray(parsed)) missingFonts = parsed.filter((name): name is string => typeof name === 'string');
  } catch {
    // An unreadable header only loses the note about fonts.
  }
  return {
    blob: blob.type === 'application/pdf' ? blob : new Blob([blob], {type: 'application/pdf'}),
    pages: Number(response.headers.get('X-Design-Pdf-Pages')) || 0,
    unmeasured: Number(response.headers.get('X-Design-Pdf-Unmeasured')) || 0,
    missingFonts,
  };
}
