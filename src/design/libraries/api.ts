import {api, post} from '../../api';
import {readApi} from '../../api-read';
import type {DesignFileLibraries, DesignFileLibrary, DesignLibraryImported, DesignLibraryImportRequest, DesignLibraryPublish, DesignOwnLibrary} from '../../../shared/design/api';
import type {LibrarySnapshot} from '../../../shared/design/libraries';

// Client of the shared-library routes under `/api/design-files/:id` (docs/design-tool.md §Teams, "Shared libraries"). Reads retry
// through readApi; writes go through api(), which carries the account header and its generation check.

const file = (id: string) => `/design-files/${encodeURIComponent(id)}`;
const library = (fileId: string, libraryId: string) => `${file(fileId)}/libraries/${encodeURIComponent(libraryId)}`;

export const readOwnLibrary = (fileId: string) => readApi<DesignOwnLibrary>(`${file(fileId)}/library`);
export const publishLibrary = (fileId: string, body: DesignLibraryPublish) => post<DesignOwnLibrary>(`${file(fileId)}/library`, body);
export const unpublishLibrary = (fileId: string) => api<DesignOwnLibrary>(`${file(fileId)}/library`, {method: 'DELETE'});
export const listFileLibraries = (fileId: string) => readApi<DesignFileLibraries>(`${file(fileId)}/libraries`);
export const enableLibrary = (fileId: string, libraryId: string) => api<{library: DesignFileLibrary}>(library(fileId, libraryId), {method: 'PUT'});
export const disableLibrary = (fileId: string, libraryId: string) => api<{ok: true}>(library(fileId, libraryId), {method: 'DELETE'});
export const markLibrarySeen = (fileId: string, libraryId: string, seenVersion: number) =>
  api<{ok: true}>(library(fileId, libraryId), {method: 'PATCH', body: JSON.stringify({seenVersion})});
/** A version's snapshot (it may be up to 20 MB: the read waits longer than a small one). */
export const readLibraryVersion = (fileId: string, libraryId: string, version: number) =>
  readApi<{snapshot: LibrarySnapshot}>(`${library(fileId, libraryId)}/versions/${version}`, {timeoutMs: 60_000});
export const importLibraryAssets = (fileId: string, libraryId: string, body: DesignLibraryImportRequest) =>
  post<DesignLibraryImported>(`${library(fileId, libraryId)}/import`, body);
