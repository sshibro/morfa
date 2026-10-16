import type {DesignPartial} from './pages';
import type {DesignDocument, ImageAsset, ImageRef, NodeId, SceneNode} from './types';
import type {DocumentPatch} from './patch';
import type {DesignLimits} from './limits';
import type {PatchEntry} from './schema';
import type {DesignFileAccess} from './teams';
import type {LibraryImport, LibraryManifest} from './libraries';
import type {DesignTemplateScope} from './team-templates';

// Wire types of `/api/design-files` (docs/design-tool.md §Server API). Dates are ISO strings.

/** "Board" (docs/board.md §File kind): a design file opens the design editor, a board the whiteboard editor. Fixed when the file
 *  is made (SQL039); every file made before boards is a design file. */
export type DesignFileKind = 'design' | 'board';
export const DESIGN_FILE_KINDS: readonly DesignFileKind[] = ['design', 'board'];

export type DesignFileSummary = {
  id: string;
  name: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  /** Same-origin `/uploads/…` image of the first page, or null before the first thumbnail. */
  thumbnailUrl: string | null;
  /** Set while the file is in the trash. */
  trashedAt: string | null;
  /** The team the file belongs to (docs/design-tool.md §Teams), null for a personal file. The server always sends it. */
  teamId?: string | null;
  /** The team project it is filed under, null for none. The server always sends it. */
  projectId?: string | null;
  /** Comments of others in its open threads the caller has not read (shared/design/comments.ts); absent when there are none. */
  unreadComments?: number;
  /** A board or a design file (docs/board.md); the server always sends it, absent reads as 'design'. */
  kind?: DesignFileKind;
};

export type DesignUsage = {files: number; storageBytes: number};

export type DesignFileList = {files: DesignFileSummary[]; usage: DesignUsage; limits: DesignLimits};
/** `kind`: a board (docs/board.md) or, by default, a design file. */
export type DesignFileCreate = {name?: string; document?: DesignDocument; clientId?: string; teamId?: string; projectId?: string | null; kind?: DesignFileKind};
/** `access`: what the caller may do with the file (a viewer or developer opens it read-only); the server always sends it.
 *  `partial` (big files, `GET /:id?pages=skeleton`, docs/decisions/big-files.md §3): the document is the skeleton plus the
 *  listed pages' layers; the others come from `GET /:id/pages/:pageId`. */
export type DesignFileOpened = {file: DesignFileSummary; document: DesignDocument; access?: DesignFileAccess; partial?: DesignPartial};
/** `POST /:id/move`: into a team (and project), between a team's projects, or back to the caller's personal files (teamId null). */
export type DesignFileMove = {teamId: string | null; projectId?: string | null};
/** Co-editing (docs/design-tool.md "Co-editing"): the editor's copy of every entry a patch changes, as the
 *  server had it when the editor changed it (null: absent), so a patch made on an older version merges field by field;
 *  `beforeTables` holds the other tables' copies and the page order; `client` is the editor's live connection, which
 *  is not sent its own change back. */
export type DesignPatchContext = {before?: Record<NodeId, SceneNode | null>; beforeTables?: DocumentPatch; client?: string | null};
export type DesignDocumentPatchBody = {baseVersion: number; patch: DocumentPatch} & DesignPatchContext;
export type DesignDocumentPutBody = {baseVersion: number; document: DesignDocument};
/** One accepted change of a file: the entries as the server stored them, in the order the versions were given. */
export type DesignChange = {version: number; patch: DocumentPatch};
/**
 * A stored save. With co-editing, `changes` are the other people's changes after `baseVersion` up to this one (the editor
 * applies those it has not seen), and `own` is what the server stored for this patch when it differs from what was sent
 * (merged into a newer version); `resync` asks the editor to reload the document instead (the server no longer holds
 * every change since `baseVersion`).
 */
/** `layout: 'server'`: the server laid out what it merged (DESIGN_SERVER_LAYOUT=1), so the editor does not correct it. */
export type DesignSaved = {version: number; updatedAt: string; changes?: DesignChange[]; own?: DocumentPatch; resync?: boolean; layout?: 'server'};
export type DesignImageUploaded = {ref: ImageRef; asset: ImageAsset};

export type DesignVersionSummary = {
  id: string;
  /** The file version it captured. */
  version: number;
  /** Named versions carry the user's label; automatic ones are null. */
  label: string | null;
  createdAt: string;
};

/** Error codes the client branches on (ApiError.details.code). */
export type DesignErrorCode =
  | 'design_unavailable'
  | 'design_file_limit'
  | 'design_storage_limit'
  /** 413: the account's files and saved versions fill DESIGN_DOCUMENT_CAPS.accountBytes. */
  | 'design_documents_limit'
  | 'version_conflict'
  | 'design_document_invalid'
  | 'design_document_too_large'
  /** 404 on GET /:id/pages/:pageId: the file has no such page (the editor loads a page it made and has not saved yet empty). */
  | 'page_not_found'
  | 'design_forbidden'
  | 'design_team_limit'
  | 'design_invite_invalid'
  | 'design_invite_expired'
  /** 409: a file's threads or comments, or a thread's comments, are at their limit (shared/design/comments.ts). */
  | 'design_comment_limit'
  /** 409: a shared library was unpublished or its file is in the trash; files keep what they took from it. */
  | 'design_library_unavailable'
  /** 409: the vote ended (or another began), or the voter has no votes left there (shared/design/meeting.ts). */
  | 'design_meeting_conflict'
  /** 409: the team has published as many custom templates as a team may keep (shared/design/team-templates.ts). */
  | 'design_template_limit'
  /** GET /:id/checkpoint 413: an api-path file too big to encode on a read
   *  (DESIGN_CHECKPOINT_API_BYTES); such a file belongs on the collab path. */
  | 'design_checkpoint_too_large'
  /** GET /:id/checkpoint, 503: this server cannot write the binary codec for the file (no server wasm build, or a document the
   *  codec would not carry exactly): the editor opens it with GET /:id. */
  | 'design_checkpoint_unavailable'
  /** Vector PDF (POST /:id/export/pdf): 404 switched off, 503 its renderer did not start. */
  | 'design_pdf_unavailable'
  /** 429: the server is printing as many PDFs as it can; retry in a few seconds. */
  | 'design_pdf_busy'
  /** 413: too many pages, or shadows and blurs over too large an area. */
  | 'design_pdf_too_large'
  /** 504: printing took longer than the server allows. */
  | 'design_pdf_timeout'
  /** Rasters on the server (POST /:id/export/raster, lane L4's renderer in the render service): 404 switched off, 503 the
   *  service is not there or refused the document — the editor paints the export itself. */
  | 'design_raster_unavailable'
  /** 429: the render service is drawing as much as it can; retry in a few seconds. */
  | 'design_raster_busy'
  /** 413: the picture is over the service's megapixel cap. */
  | 'design_raster_too_large'
  /** 504: drawing took longer than the server allows. */
  | 'design_raster_timeout'
  /** 409 (DESIGN_COLLAB=rust, docs/BACKEND.md §7): a collab node holds the file; PATCH goes through its socket (`sessionUrl`). */
  | 'collab_active'
  /** 409: GET /:id/session of a file that is not in DESIGN_COLLAB=rust (`mode`): the editor stays on SSE + PATCH. */
  | 'collab_inactive'
  | 'not_found';

/** The details of a refused document or patch (400, or 403 for a picture of another account,
 *  `design_document_invalid`): the `path` of the refused value and, when it belongs to one entry of the document, that
 *  `entry` (a layer also as `nodeId`). Autosave puts back exactly that entry and saves the rest. */
export type DesignInvalidDetails = {code: 'design_document_invalid'; path: string; entry?: PatchEntry; nodeId?: string};

/** The portable file a user downloads ("Save to computer") and opens again: the document with its
 *  pictures inlined as data URLs, so it works in another account. Extension `.rdesign`. */
export type DesignPortableFile = {
  format: 'morfa-design';
  formatVersion: 1;
  name: string;
  /** A board's copy says so (opened again it makes a board); absent is a design file. */
  kind?: DesignFileKind;
  document: DesignDocument;
  /** ref → data: URL of the picture. */
  imageData: Record<ImageRef, string>;
};

// ── Custom team templates (shared/design/team-templates.ts) ─────────────────────────────

/** A team's board published as a template: what the "+" sheet lists. */
export type DesignTemplateSummary = {
  id: string;
  fileId: string;
  name: string;
  description: string;
  version: number;
  publishedAt: string;
  teamId: string;
  scope: DesignTemplateScope;
  /** The board's own thumbnail (no render of its own). */
  thumbnailUrl: string | null;
  publishedBy: {name: string};
};
/** `POST /:id/template`: publish the board (at `baseVersion`, saved first) as its template's next version. */
export type DesignTemplatePublish = {baseVersion: number; name: string; description?: string; scope: DesignTemplateScope};
/** `PATCH /:id/template`. */
export type DesignTemplateUpdate = {name?: string; description?: string};
export type DesignTemplateAnswer = {template: DesignTemplateSummary};
/** `GET /api/design-templates?teamId=`. */
export type DesignTemplateList = {templates: DesignTemplateSummary[]};
/** `GET /api/design-templates/:templateId/content?version=&fileId=`: the template's objects with fresh ids, parents before children
 *  (the roots' `parentId` null, in the page's coordinates), the roots' box without connectors, and the picture table entries they
 *  use, made the target board's place's. */
export type DesignTemplateContent = {pieces: SceneNode[]; roots: NodeId[]; bounds: {x: number; y: number; width: number; height: number}; images: Record<ImageRef, ImageAsset>};

// ── Shared libraries (docs/design-tool.md §Teams, "Shared libraries") ─────────────────────────────

/** A library as a file sees it: the publishing file (whose name it carries) and its newest version. */
export type DesignLibrarySummary = {
  id: string;
  fileId: string;
  name: string;
  version: number;
  publishedAt: string;
  /** Set while unpublished: no file can enable it, files that have it are offered nothing new. */
  unpublishedAt: string | null;
  /** The newest version's description of the change. */
  description: string;
  manifest: LibraryManifest;
};
export type DesignLibraryVersionSummary = {version: number; description: string; createdAt: string};
/** `GET /:id/library`: the file's own library, if it ever published one. */
export type DesignOwnLibrary = {library: (DesignLibrarySummary & {versions: DesignLibraryVersionSummary[]}) | null};
/** One library of `GET /:id/libraries`: those of the file's place it can enable, and those it has enabled. */
export type DesignFileLibrary = DesignLibrarySummary & {
  /** The file enabled it ("Libraries"). */
  enabled: boolean;
  /** Published and its file not in the trash: it can be enabled and used. */
  available: boolean;
  /** The newest version this file was told about (its update taken or put off); null before any. */
  seenVersion: number | null;
};
export type DesignFileLibraries = {libraries: DesignFileLibrary[]};
/** `POST /:id/library`: publish the file (at `baseVersion`, saved first) as a new version of its library. */
export type DesignLibraryPublish = {baseVersion: number; components: string[]; styles: string[]; variableCollections: string[]; description?: string};
/** `POST /:id/libraries/:libraryId/import`: the part of a version the assets need, its pictures made this file's. */
export type DesignLibraryImportRequest = {version: number; components?: string[]; styles?: string[]; variableCollections?: string[]};
export type DesignLibraryImported = {import: LibraryImport};
