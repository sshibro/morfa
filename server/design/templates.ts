import {randomUUID} from 'node:crypto';
import type {SqlExecutor} from '../postgresql/client';
import type {CustomerAuthority} from '../customer-authority';
import type {DesignDocument, ImageAsset, ImageRef, NodeId, SceneNode} from '../../shared/design/types';
import type {DesignTemplateContent, DesignTemplateList, DesignTemplatePublish, DesignTemplateSummary, DesignTemplateUpdate} from '../../shared/design/api';
import {cloneSubtrees} from '../../shared/design/clone';
import {canEditTeamFiles} from '../../shared/design/teams';
import {TEAM_TEMPLATE_CAPS, TEAM_TEMPLATE_LIMIT, type DesignTemplateScope} from '../../shared/design/team-templates';
import {DESIGN_LIMITS} from '../../shared/design/limits';
import {holderOf, scopeOfFile} from './access';
import {storedDocument} from './document-store';
import {designFail, notFound} from './errors';
import {designRead, designWrite, fileAccess, forbidden, type DesignFileAccessRow} from './file-access';
import {storageFull} from './files';
import {copyImageFile, designStorageUsed, imageUrl, newImageFilename, removeImageFiles, teamStorageUsed} from './images';
import {cleanName} from './names';
import {requireTeamRole} from './teams';

// Custom team templates on the server (help.figma.com "Create custom templates in FigJam"): a team's board
// published as a template its people insert from the "+" sheet, built after the shared libraries (libraries.ts). A version is a
// snapshot the server builds from the stored board — its first page's top-level objects with everything under them, and the
// picture table entries they use — never one the browser sends. A template is listed in its team while its board is there and
// outside the trash; with scope 'organization' also in the other teams of the same owner (this product has no organization of
// its own). Inserting it hands out copies with fresh ids, and its pictures made the target board's place's.

const TEMPLATE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NO_GUEST = 'Only a team member with edit access can publish a template.';

/** What a version stores: the first page's top-level objects (`roots`) with everything under them, and their pictures. */
type Snapshot = {nodes: Record<NodeId, SceneNode>; roots: NodeId[]; images: Record<ImageRef, ImageAsset>};

type SummaryRow = {
  id: string;
  file_id: string;
  name: string;
  description: string;
  version: number;
  published_at: string;
  team_id: string;
  scope: DesignTemplateScope;
  thumbnail_filename: string | null;
  published_by_name: string | null;
};
const SUMMARY = `SELECT t.id,t.file_id,t.name,t.description,t.version,t.published_at,t.team_id,t.scope,f.thumbnail_filename,u.name AS published_by_name
  FROM design_templates t JOIN design_files f ON f.id=t.file_id LEFT JOIN users u ON u.id=t.published_by`;
/** Offered to the team `$1` owned by `$2`: its own, and the organization's of its owner's other teams; the board still in the template's
 *  team (a live one) and outside the trash. */
const OFFERED = `f.team_id=t.team_id AND f.trashed_at IS NULL
  AND EXISTS (SELECT 1 FROM design_teams tt WHERE tt.id=t.team_id AND tt.deleted_at IS NULL AND (t.team_id=$1 OR (t.scope='organization' AND tt.owner_id=$2)))`;

const summaryOf = (row: SummaryRow): DesignTemplateSummary => ({
  id: row.id,
  fileId: row.file_id,
  name: row.name,
  description: row.description,
  version: Number(row.version),
  publishedAt: row.published_at,
  teamId: row.team_id,
  scope: row.scope,
  thumbnailUrl: row.thumbnail_filename ? imageUrl(row.thumbnail_filename) : null,
  publishedBy: {name: (row.published_by_name ?? '').trim() || 'Member'},
});

const templateNotFound = (): never => designFail(404, 'not_found', 'Template not found.');
const conflict = (currentVersion: number): never =>
  designFail(409, 'version_conflict', 'The file was changed in another tab. Open it again.', {currentVersion});

/** A team's board the caller may publish from: an editor of its team (never a guest of the file). */
function publishable(row: DesignFileAccessRow): string {
  if (row.guest || !canEditTeamFiles(row.role)) forbidden(NO_GUEST);
  if (row.kind !== 'board' || !row.team_id) designFail(400, 'invalid_request', 'Only a team board can be made a template.');
  return row.team_id!;
}

const cleanDescription = (value: string | undefined) =>
  [...(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()].slice(0, TEAM_TEMPLATE_CAPS.description).join('').trim();
function templateName(value: string | undefined): string {
  const name = cleanName(value, TEAM_TEMPLATE_CAPS.name);
  return name ?? designFail(400, 'invalid_request', 'Name the template.');
}

/** Every `imageRef` a layer points at, wherever it is (fills, strokes, a board object's parts). */
function imageRefsOf(value: unknown, into: Set<string>) {
  if (Array.isArray(value)) for (const item of value) imageRefsOf(item, into);
  else if (value && typeof value === 'object')
    for (const [key, inner] of Object.entries(value)) {
      if (key === 'imageRef' && typeof inner === 'string') into.add(inner);
      else if (inner && typeof inner === 'object') imageRefsOf(inner, into);
    }
}

/** The snapshot of a board's first page: its top-level objects with everything under them, and the pictures they use. */
export function templateSnapshot(doc: DesignDocument): Snapshot {
  const page = doc.nodes[doc.pages[0] ?? ''];
  if (!page || page.type !== 'PAGE') return designFail(400, 'invalid_request', 'The board has no page.');
  const roots = (page.children ?? []).filter(id => Object.hasOwn(doc.nodes, id));
  if (!roots.length) designFail(400, 'invalid_request', 'The board is empty: there is nothing to show in the template.');
  const nodes: Record<NodeId, SceneNode> = {};
  const refs = new Set<string>();
  const visit = (id: NodeId) => {
    const node = doc.nodes[id];
    if (!node || Object.hasOwn(nodes, id)) return;
    nodes[id] = node;
    imageRefsOf(node, refs);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of roots) visit(root);
  const images: Record<ImageRef, ImageAsset> = {};
  for (const ref of refs) if (Object.hasOwn(doc.images, ref)) images[ref] = doc.images[ref];
  return {nodes, roots, images};
}

const fileOfUrl = (url: string) => (url.startsWith('/uploads/') ? url.slice('/uploads/'.length) : null);

async function summaryById(tx: SqlExecutor, id: string): Promise<DesignTemplateSummary> {
  return summaryOf((await tx.one<SummaryRow>(`${SUMMARY} WHERE t.id=$1`, [id]))!);
}

/**
 * `POST /:id/template`: the board at `baseVersion` (saved first) as its template's next version — the first publish makes the template.
 * The name, description and scope are this call's. A new template counts against the team's limit (TEAM_TEMPLATE_LIMIT); publishing
 * an existing one again never does. The newest TEAM_TEMPLATE_CAPS.versionsKept versions are kept.
 */
export async function publishTemplate(actor: CustomerAuthority, fileId: string, input: DesignTemplatePublish): Promise<{template: DesignTemplateSummary}> {
  const caller = actor.ownerId;
  const name = templateName(input.name),
    description = cleanDescription(input.description);
  const read = await designRead(actor, async tx => {
    const row = await fileAccess(tx, caller, fileId, 'edit');
    publishable(row);
    if (row.trashed_at !== null) notFound();
    if (Number(row.version) !== input.baseVersion) conflict(Number(row.version));
    const doc = await storedDocument(tx, row);
    const template = await tx.one<{id: string; version: number}>('SELECT id,version FROM design_templates WHERE file_id=$1', [row.id]);
    return {row, doc, template};
  });
  const snapshot = templateSnapshot(read.doc);
  const text = JSON.stringify(snapshot);
  const bytes = Buffer.byteLength(text);
  if (bytes > TEAM_TEMPLATE_CAPS.snapshotBytes) designFail(413, 'design_document_too_large', 'The template is larger than 5 MB. Keep only the starting content on the board\'s first page.');
  const imageFiles = [...new Set(Object.values(snapshot.images).map(asset => fileOfUrl(asset.url)).filter((file): file is string => !!file))];
  const version = Number(read.template?.version ?? 0) + 1;
  return designWrite(
    actor,
    async tx => {
      const row = await fileAccess(tx, caller, fileId, 'edit');
      const teamId = publishable(row);
      if (row.trashed_at !== null) notFound();
      if (row.user_id !== read.row.user_id || row.team_id !== read.row.team_id) conflict(Number(row.version));
      const template = await tx.one<{id: string; version: number; team_id: string}>('SELECT id,version,team_id FROM design_templates WHERE file_id=$1 FOR UPDATE', [row.id]);
      if (Number(template?.version ?? 0) !== version - 1)
        designFail(409, 'version_conflict', 'The template was just published from another tab. Publish it again.', {currentVersion: Number(row.version)});
      // A new template of this team (a first publish, or a board that moved here from another team) counts against the team's limit.
      if (!template || template.team_id !== teamId) {
        const limit = TEAM_TEMPLATE_LIMIT;
        // The team's listed templates: one whose board is in the trash or left the team does not count (there is no unpublish).
        const used = (await tx.one<{n: number}>(
          `SELECT count(*)::int AS n FROM design_templates t JOIN design_files f ON f.id=t.file_id
           WHERE t.team_id=$1 AND t.file_id<>$2 AND f.team_id=t.team_id AND f.trashed_at IS NULL`,
          [teamId, row.id],
        ))!.n;
        if (used >= limit)
          designFail(
            409,
            'design_template_limit',
            `The team already has ${limit} templates, the most it can have.`,
            {limit},
          );
      }
      const id = template?.id ?? randomUUID();
      if (template)
        await tx.execute(
          'UPDATE design_templates SET team_id=$2,name=$3,description=$4,scope=$5,version=$6,published_at=clock_timestamp(),published_by=$7 WHERE id=$1',
          [id, teamId, name, description, input.scope, version, caller],
        );
      else
        await tx.execute(
          'INSERT INTO design_templates(id,file_id,team_id,name,description,scope,version,published_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [id, row.id, teamId, name, description, input.scope, version, caller],
        );
      await tx.execute(
        'INSERT INTO design_template_versions(template_id,version,file_version,snapshot,bytes,image_files,published_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, version, read.row.version, text, bytes, imageFiles, caller],
      );
      await tx.execute('DELETE FROM design_template_versions WHERE template_id=$1 AND version<=$2', [id, version - TEAM_TEMPLATE_CAPS.versionsKept]);
      return {template: await summaryById(tx, id)};
    },
    {teams: read.row.team_id ? [read.row.team_id] : []},
  );
}

/** `PATCH /:id/template`: a new name or description (FigJam's "Update template"); the versions stay as they are. */
export async function updateTemplate(actor: CustomerAuthority, fileId: string, input: DesignTemplateUpdate): Promise<{template: DesignTemplateSummary}> {
  const name = input.name === undefined ? undefined : templateName(input.name),
    description = input.description === undefined ? undefined : cleanDescription(input.description);
  return designWrite(actor, async tx => {
    const row = await fileAccess(tx, actor.ownerId, fileId, 'edit');
    publishable(row);
    if (row.trashed_at !== null) notFound();
    const template = await tx.one<{id: string}>('SELECT id FROM design_templates WHERE file_id=$1 FOR UPDATE', [row.id]);
    if (!template) templateNotFound();
    await tx.execute('UPDATE design_templates SET name=COALESCE($2,name),description=COALESCE($3,description) WHERE id=$1', [template!.id, name ?? null, description ?? null]);
    return {template: await summaryById(tx, template!.id)};
  });
}

/** `GET /api/design-templates?teamId=`: the templates the team's people may insert (any member, viewers included), newest first. */
export async function listTemplates(actor: CustomerAuthority, teamId: string): Promise<DesignTemplateList> {
  return designRead(actor, async tx => {
    const {team} = await requireTeamRole(tx, teamId, actor.ownerId);
    const rows = await tx.many<SummaryRow>(`${SUMMARY} WHERE ${OFFERED} ORDER BY t.published_at DESC,t.id LIMIT ${TEAM_TEMPLATE_CAPS.listed}`, [team.id, team.owner_id]);
    return {templates: rows.map(summaryOf)};
  });
}

type PictureSource = {filename: string; bytes: number; width: number; height: number};
type Copied = {from: string; to: string; bytes: number; width: number; height: number};

/**
 * `GET /api/design-templates/:templateId/content?version=&fileId=`: a version's objects with fresh ids for the board `fileId` (the
 * caller edits it; the template is offered to its team), its pictures made that board's place's — the place's own as they are, a
 * copy made before taken again, the others copied once and counted in its storage, one whose file is gone left out.
 */
export async function templateContent(actor: CustomerAuthority, templateId: string, input: {version?: number; fileId: string}): Promise<DesignTemplateContent> {
  const caller = actor.ownerId;
  if (typeof templateId !== 'string' || !TEMPLATE_ID.test(templateId)) templateNotFound();
  const read = await designRead(actor, async tx => {
    const file = await fileAccess(tx, caller, input.fileId, 'edit');
    if (file.trashed_at !== null) notFound();
    // A team's templates are its people's: a guest of one of its boards is not offered them.
    if (!file.team_id || file.guest) templateNotFound();
    const team = (await tx.one<{owner_id: string}>('SELECT owner_id FROM design_teams WHERE id=$1', [file.team_id]))!;
    const template = await tx.one<{id: string; version: number}>(`SELECT t.id,t.version FROM design_templates t JOIN design_files f ON f.id=t.file_id WHERE t.id=$3 AND ${OFFERED}`, [
      file.team_id,
      team.owner_id,
      templateId,
    ]);
    if (!template) templateNotFound();
    const version = input.version ?? Number(template!.version);
    const row = await tx.one<{snapshot: string}>('SELECT snapshot FROM design_template_versions WHERE template_id=$1 AND version=$2', [template!.id, version]);
    if (!row) designFail(404, 'not_found', 'Template version not found.');
    return {file, snapshot: JSON.parse(row!.snapshot) as Snapshot};
  });
  const images = await picturesFor(actor, read.file, read.snapshot.images);
  const {nodes, ids} = cloneSubtrees(read.snapshot.nodes, read.snapshot.roots);
  const roots = read.snapshot.roots.map(root => ids.get(root)!).filter(Boolean);
  const rootSet = new Set(roots);
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  const pieces = nodes.map(node => {
    if (!rootSet.has(node.id)) return node;
    if (node.board?.kind !== 'connector') {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + node.width);
      maxY = Math.max(maxY, node.y + node.height);
    }
    return {...node, parentId: null} as SceneNode;
  });
  // A picture left out leaves its fills pointing at nothing: the editor draws them as it draws any missing picture.
  return {
    pieces,
    roots,
    bounds: minX === Infinity ? {x: 0, y: 0, width: 0, height: 0} : {x: minX, y: minY, width: maxX - minX, height: maxY - minY},
    images,
  };
}

/** The picture table entries of `wanted` as the board `file`'s place may use them (libraries.ts's import does the same). */
async function picturesFor(actor: CustomerAuthority, file: DesignFileAccessRow, wanted: Record<ImageRef, ImageAsset>): Promise<Record<ImageRef, ImageAsset>> {
  const scope = scopeOfFile(file);
  const holder = holderOf(scope),
    team = scope.kind === 'team' ? scope.teamId : null;
  const files = [...new Set(Object.values(wanted).map(asset => fileOfUrl(asset.url)).filter((name): name is string => !!name))];
  if (!files.length) return {};
  const pictures = await designRead(actor, async tx => {
    const owned = new Set(
      (await tx.many<{filename: string}>("SELECT filename FROM design_images WHERE user_id=$1 AND team_id IS NOT DISTINCT FROM $2 AND kind='image' AND filename=ANY($3::text[])", [holder, team, files])).map(
        row => row.filename,
      ),
    );
    const rest = files.filter(name => !owned.has(name));
    const copies = new Map<string, string>();
    for (const row of rest.length
      ? await tx.many<{source: string; filename: string}>(
          `SELECT p.source,p.filename FROM design_library_pictures p JOIN design_images d ON d.filename=p.filename
           WHERE p.source=ANY($1::text[]) AND d.user_id=$2 AND d.team_id IS NOT DISTINCT FROM $3 AND d.kind='image' ORDER BY p.created_at`,
          [rest, holder, team],
        )
      : [])
      if (!copies.has(row.source)) copies.set(row.source, row.filename);
    const missing = rest.filter(name => !copies.has(name));
    const sources = missing.length
      ? await tx.many<PictureSource>("SELECT filename,bytes,width,height FROM design_images WHERE kind='image' AND filename=ANY($1::text[])", [missing])
      : [];
    return {owned, copies, sources};
  });
  const made: Copied[] = [];
  try {
    for (const source of pictures.sources) {
      const to = newImageFilename('image', source.filename.endsWith('.png') ? 'png' : 'webp');
      try {
        await copyImageFile(source.filename, to);
      } catch {
        continue; // Its file is gone: the picture is left out.
      }
      made.push({from: source.filename, to, bytes: Number(source.bytes), width: source.width, height: source.height});
    }
    if (made.length)
      await designWrite(
        actor,
        async tx => {
          const now = await fileAccess(tx, actor.ownerId, file.id, 'edit');
          if (now.user_id !== file.user_id || now.team_id !== file.team_id) conflict(Number(now.version));
          const used = Number(team ? await teamStorageUsed(tx, team) : await designStorageUsed(tx, holder));
          if (used + made.reduce((sum, copy) => sum + copy.bytes, 0) > DESIGN_LIMITS.storageBytes) storageFull(used);
          for (const copy of made) {
            await tx.execute("INSERT INTO design_images(filename,user_id,team_id,file_id,kind,bytes,width,height) VALUES($1,$2,$3,$4,'image',$5,$6,$7)", [
              copy.to,
              holder,
              team,
              file.id,
              copy.bytes,
              copy.width,
              copy.height,
            ]);
            await tx.execute('INSERT INTO design_library_pictures(filename,source) VALUES($1,$2)', [copy.to, copy.from]);
          }
        },
        {teams: team ? [team] : []},
      );
  } catch (error) {
    await removeImageFiles(made.map(copy => copy.to));
    throw error;
  }
  const copied = new Map(made.map(copy => [copy.from, copy.to]));
  const images: Record<ImageRef, ImageAsset> = {};
  for (const [ref, asset] of Object.entries(wanted)) {
    const name = fileOfUrl(asset.url);
    if (!name) continue;
    if (pictures.owned.has(name)) images[ref] = asset;
    else if (pictures.copies.has(name)) images[ref] = {...asset, url: imageUrl(pictures.copies.get(name)!)};
    else if (copied.has(name)) images[ref] = {...asset, url: imageUrl(copied.get(name)!)};
  }
  return images;
}

/** Account erasure (server/design/lifecycle.ts): the templates and versions it published name nobody. Takes no lock. */
export async function eraseDesignTemplatesOf(tx: SqlExecutor, userId: string): Promise<void> {
  await tx.execute('UPDATE design_templates SET published_by=NULL WHERE published_by=$1', [userId]);
  await tx.execute('UPDATE design_template_versions SET published_by=NULL WHERE published_by=$1', [userId]);
}
