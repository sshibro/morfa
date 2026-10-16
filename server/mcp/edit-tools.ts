// The MCP server's editing tools (docs/mcp-server.md §Editing): the canvas tools (create, update, delete and duplicate layers,
// colour styles) plus what an assistant working on its own needs besides: a new file, a new page, undoing its own changes, pictures it
// brings and a look at what it built. Each change goes through edits.ts. Descriptions are for the model, in English; layer ids are the
// document's own, as the reading tools give them.
import {z} from 'zod/v4';
import {createDesignFile} from '../design/files';
import {designRasterEngine} from '../design/pdf/flag';
import {renderServiceUrl} from '../design/pdf/service';
import {CANVAS_TOOL_CAPS as T, type CanvasToolName} from '../../shared/design/canvas-tools';
import {createNode, newId} from '../../shared/design/defaults';
import type {DesignDocument, ImageAsset, ImageRef, NodeId} from '../../shared/design/types';
import type {Principal} from './auth';
import {mcpAuthority} from './authority';
import {mcpIssuer} from './config';
import {fileLink, layerOf, targetOf} from './design-read';
import {
  contentPages,
  editableLayer,
  editFile,
  layersBox,
  requireWriter,
  undoEdit,
  type EditOutcome,
  type EditResult,
  type EditSession,
} from './edits';
import {ToolError} from './errors';
import {openFile} from './files';
import {catalogueFontFamilies, fontOf} from './fonts';
import {fileIdField, linkField, nodeIdField, type ToolAnnotations, type ToolDefinition, type ToolSuccess} from './tools';
import {placeImageTool, uploadImageTool} from './uploads';

const ADDS: ToolAnnotations = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false};
const CHANGES: ToolAnnotations = {readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false};
const REMOVES: ToolAnnotations = {readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false};

// ── Schemas (with the document's ids) ───────────────────────────────────────────────────────────────────────────────────────

const layerId = (what = 'A layer id, from morfa_get_file, morfa_get_layers or an earlier result.') => z.string().max(256).describe(what);
const color = (what = '#RRGGBB or #RRGGBBAA.') => z.string().max(9).describe(what);
const number = (what?: string) => (what ? z.number().describe(what) : z.number());
const layout = z
  .strictObject({
    mode: z.enum(['HORIZONTAL', 'VERTICAL']),
    gap: number().optional(),
    padding: z.strictObject({top: number(), right: number(), bottom: number(), left: number()}).partial().optional(),
    primaryAlign: z.enum(['MIN', 'CENTER', 'MAX', 'SPACE_BETWEEN']).optional(),
    counterAlign: z.enum(['MIN', 'CENTER', 'MAX']).optional(),
    wrap: z.boolean().optional(),
  })
  .describe('Auto layout: children flow in this direction with this gap and padding.');
const sizing = z
  .strictObject({horizontal: z.enum(['FIXED', 'HUG', 'FILL']), vertical: z.enum(['FIXED', 'HUG', 'FILL'])})
  .describe('HUG: a frame with auto layout or a text fits its content. FILL: fills its auto-layout parent.');
const fontList = () => catalogueFontFamilies().join(', ');
const textFields = () => ({
  characters: z.string().max(5000).describe('The text. Real, specific copy in the language the person uses; never lorem ipsum.'),
  fontFamily: z.string().max(80).describe(`One of Morfa's fonts: ${fontList()}.`),
  fontWeight: number('100…900.'),
  fontSize: number(),
  lineHeight: number('Pixels; null is auto.').nullable(),
  letterSpacing: number('Percent of the size.').nullable(),
  align: z.enum(['LEFT', 'CENTER', 'RIGHT']),
  color: color(),
});
const stroke = z.strictObject({color: color(), weight: number()});

const layerSpec = () =>
  z.strictObject({
    id: z.string().max(40).describe('Your local id for this layer in this call (letters, digits, - and _), unique in the call.'),
    parent: z
      .string()
      .max(40)
      .nullable()
      .optional()
      .describe('The local id of an earlier FRAME of this same call, or null for a top-level layer of the call.'),
    type: z.enum(['FRAME', 'TEXT', 'RECTANGLE', 'ELLIPSE', 'IMAGE']),
    name: z.string().max(100).optional().describe('A clear layer name (“Header”, “Pricing card”, “Button / Primary”).'),
    x: number('Ignored inside an auto-layout parent.').optional(),
    y: number('Ignored inside an auto-layout parent.').optional(),
    width: number(),
    height: number(),
    fill: color().nullable().optional(),
    stroke: stroke.nullable().optional(),
    cornerRadius: number().nullable().optional(),
    opacity: number('0…1.').nullable().optional(),
    layout: layout.nullable().optional(),
    sizing: sizing.nullable().optional(),
    text: z
      .strictObject(textFields())
      .partial()
      .required({characters: true})
      .nullable()
      .optional()
      .describe('TEXT layers only.'),
    image: z
      .strictObject({description: z.string().max(500).describe('What the picture shows.')})
      .nullable()
      .optional()
      .describe('IMAGE only: a picture placeholder; fill it with morfa_place_image (or the person drops a picture in).'),
  });

const layerUpdate = () =>
  z.strictObject({
    id: layerId(),
    name: z.string().max(100).optional(),
    x: number().optional(),
    y: number().optional(),
    width: number().optional(),
    height: number().optional(),
    fill: color('The only fill; null removes the fills.').nullable().optional(),
    stroke: stroke.nullable().optional(),
    cornerRadius: number().optional(),
    opacity: number().optional(),
    visible: z.boolean().optional(),
    layout: layout.nullable().optional(),
    sizing: sizing.optional(),
    text: z.strictObject(textFields()).partial().optional().describe('TEXT only: the fields given change for the whole text.'),
    parent: layerId('Move the layer into this frame, or null to put it on the page (it keeps its place on screen).')
      .nullable()
      .optional(),
    index: number("Position among the new parent's children (0 is first).").optional(),
  });

const fileTarget = {link: linkField, fileId: fileIdField};
type FileInput = {link?: string; fileId?: string};

// ── Running the canvas tools ────────────────────────────────────────────────────────────────────────────────────────────────

type CanvasRun = {text: string; created: NodeId[]; createdCount: number; touched: NodeId[]};

/** One canvas tool on the session's document, its layer ids given aliases first; a call it refuses as a whole is a tool error. */
export async function runCanvas(
  session: EditSession,
  name: CanvasToolName,
  input: Record<string, unknown>,
): Promise<EditOutcome<CanvasRun>> {
  const {runCanvasTool} = await import('../../src/design/canvas-tools/executor');
  const outcome = await runCanvasTool(
    {id: 'mcp', name, input},
    {
      store: session.store,
      aliases: session.aliases,
      font: fontOf,
      // New top-level layers: the box they take, so they land exactly right of what is on the page.
      view: () => session.view(name === 'create_layers' && Array.isArray(input.layers) ? layersBox(input.layers) : undefined),
    },
  );
  const text = session.aliases.output(outcome.result.text);
  if (!outcome.result.ok)
    return {
      ok: false,
      error: new ToolError('refused', text, 'Nothing was changed. Correct the call as the message says and call again.'),
    };
  return {ok: true, value: {text, created: outcome.created, createdCount: outcome.createdCount, touched: outcome.touched}};
}

/** The answer of an edit: what the canvas tool said, the version it made and how to take it back. */
function edited(result: EditResult<CanvasRun>, extra: Record<string, unknown> = {}): ToolSuccess {
  const saved = result.changed
    ? `Saved as version ${result.version}; it shows live in an open editor.${result.editId ? ' morfa_undo takes it back.' : ''}`
    : 'Nothing in the file changed.';
  return {
    structured: {
      file: {...result.file, link: fileLink(mcpIssuer(), result.file.id)},
      version: result.version,
      changed: result.changed,
      editId: result.editId,
      ...extra,
      result: result.value.text,
    },
    text: `${result.value.text}\n${saved}`,
  };
}

const fileOf = (input: FileInput) => targetOf(input).fileId;

// ── The tools ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const createLayersTool = (): ToolDefinition => ({
  name: 'morfa_create_layers',
  title: 'Create layers',
  description: `Creates up to ${T.create} layers in a Morfa file as one change. List parents before their children. parent null puts the call's top-level layers on the page (pageId, else the first page) to the right of what is there; a frame's id puts them inside that frame (appended to its flow when it has auto layout). Build big screens in sections: first the screen frame with its auto layout, then one call per section into it. The result maps your local ids to the new layers' ids.`,
  annotations: ADDS,
  inputSchema: z.strictObject({
    ...fileTarget,
    pageId: z.string().max(256).optional().describe('The page to build on when parent is null (from morfa_get_file).'),
    parent: layerId('A frame to build into, or null for the page.').nullable().optional(),
    layers: z.array(layerSpec()).min(1).max(T.create),
  }),
  async handler(input: FileInput & {pageId?: string; parent?: string | null; layers: unknown[]}, principal) {
    const fileId = fileOf(input);
    const result = await editFile(
      principal,
      {fileId, pageId: input.parent ? undefined : input.pageId, near: input.parent ?? undefined},
      'New layers',
      session =>
        runCanvas(session, 'create_layers', {parent: session.aliases.input(input.parent ?? null), layers: input.layers}),
    );
    return edited(result, {created: result.value.created, layers: result.value.createdCount});
  },
});

const updateLayersTool = (): ToolDefinition => ({
  name: 'morfa_update_layers',
  title: 'Change layers',
  description: `Changes up to ${T.updates} existing layers as one change; only the fields given change. text fields apply to the whole text. parent/index move a layer into another frame (or onto its page with parent null). Changes a person could make by hand behave as theirs: a style the value overrides is detached, an instance records an override, children follow their constraints when a frame is resized.`,
  annotations: CHANGES,
  inputSchema: z.strictObject({...fileTarget, updates: z.array(layerUpdate()).min(1).max(T.updates)}),
  async handler(input: FileInput & {updates: Record<string, unknown>[]}, principal) {
    const near = typeof input.updates[0]?.id === 'string' ? (input.updates[0].id as string) : undefined;
    const result = await editFile(principal, {fileId: fileOf(input), near}, 'Edit layers', session =>
      runCanvas(session, 'update_layers', {
        updates: input.updates.map(update => ({
          ...update,
          id: session.aliases.input(update.id),
          ...(update.parent === undefined ? {} : {parent: update.parent === null ? null : session.aliases.input(update.parent)}),
        })),
      }),
    );
    return edited(result, {changedLayers: result.value.touched});
  },
});

const deleteLayersTool = (): ToolDefinition => ({
  name: 'morfa_delete_layers',
  title: 'Delete layers',
  description:
    'Deletes layers and everything inside them as one change. Only delete what the person asked to remove, or what you made and are replacing. A layer inside an instance cannot be deleted (hide it with visible:false instead).',
  annotations: REMOVES,
  inputSchema: z.strictObject({...fileTarget, ids: z.array(layerId()).min(1).max(T.deletes)}),
  async handler(input: FileInput & {ids: string[]}, principal) {
    const result = await editFile(principal, {fileId: fileOf(input), near: input.ids[0]}, 'Delete', session =>
      runCanvas(session, 'delete_layers', {ids: input.ids.map(id => session.aliases.input(id))}),
    );
    return edited(result, {deleted: result.value.touched});
  },
});

const duplicateLayersTool = (): ToolDefinition => ({
  name: 'morfa_duplicate_layers',
  title: 'Duplicate layers',
  description:
    "Copies layers as one change; each copy goes beside its original (a top-level frame's copy to its right, others right after the original in their parent). Use it for variants: duplicate, then change the copy. The result maps every original id to its copy's id, the layers inside included.",
  annotations: ADDS,
  inputSchema: z.strictObject({...fileTarget, ids: z.array(layerId()).min(1).max(T.duplicates)}),
  async handler(input: FileInput & {ids: string[]}, principal) {
    const result = await editFile(principal, {fileId: fileOf(input), near: input.ids[0]}, 'Duplicate', session =>
      runCanvas(session, 'duplicate_layers', {ids: input.ids.map(id => session.aliases.input(id))}),
    );
    return edited(result, {copies: result.value.created});
  },
});

const addColorStylesTool = (): ToolDefinition => ({
  name: 'morfa_add_color_styles',
  title: 'Add colour styles',
  description:
    "Saves colours as the file's colour styles “group/name” (for example group “Brand” with “Primary”, “Background”, “Text”), as one change. Save the palette when you build a new screen, so the person can reuse it.",
  annotations: ADDS,
  inputSchema: z.strictObject({
    ...fileTarget,
    group: z.string().max(100).optional().describe('The styles\' folder, “Brand” or “Palette”.'),
    colors: z
      .array(z.strictObject({name: z.string().max(100), color: color()}))
      .min(1)
      .max(T.colors),
  }),
  async handler(input: FileInput & {group?: string; colors: {name: string; color: string}[]}, principal) {
    const result = await editFile(principal, {fileId: fileOf(input)}, 'Palette', session =>
      runCanvas(session, 'add_color_styles', {
        ...(input.group === undefined ? {} : {group: input.group}),
        colors: input.colors,
      }),
    );
    return edited(result);
  },
});

const PAGE_NAME = /^[^\u0000-\u001f\u007f<>]{1,100}$/;
const addPageTool = (): ToolDefinition => ({
  name: 'morfa_add_page',
  title: 'Add a page',
  description: 'Adds a page at the end of the file\'s pages, as one change. The result gives its id, for morfa_create_layers\' pageId.',
  annotations: ADDS,
  inputSchema: z.strictObject({...fileTarget, name: z.string().min(1).max(100).describe('The page\'s name.')}),
  async handler(input: FileInput & {name: string}, principal) {
    const name = input.name.trim();
    if (!PAGE_NAME.test(name))
      throw new ToolError('invalid_input', 'A page name is 1–100 characters, without markup.', 'Pass a plain name.');
    const result = await editFile(principal, {fileId: fileOf(input)}, 'New page', async session => {
      const id = newId();
      session.store.transact('New page', tx => tx.addPage(createNode('PAGE', {id, name})));
      return {ok: true, value: {text: `Added the page “${name}” (${id}).`, created: [id], createdCount: 1, touched: [id]}};
    });
    return edited(result, {page: {id: result.value.created[0], name}});
  },
});

const createFileTool = (): ToolDefinition => ({
  name: 'morfa_create_file',
  title: 'Create a design file',
  description:
    "Creates a new, empty design file (one page) in the account's personal files and returns its id and link. Use it when the person wants something new and names no existing file.",
  annotations: ADDS,
  inputSchema: z.strictObject({name: z.string().min(1).max(100).describe('The file name.')}),
  async handler(input: {name: string}, principal) {
    requireWriter(principal);
    let created;
    try {
      created = await createDesignFile(mcpAuthority(principal), {name: input.name});
    } catch (error) {
      const {editRefusal} = await import('./edits');
      throw editRefusal(error);
    }
    const file = await openFile(principal, created.file.id);
    const pageId = contentPages(file.doc)[0] ?? null;
    const link = fileLink(mcpIssuer(), file.id);
    return {
      structured: {file: {id: file.id, name: file.name, version: file.version, link}, pageId},
      text: `Created “${file.name}” (${file.id}). Build on its page ${pageId} with morfa_create_layers; the person can open it at ${link}.`,
    };
  },
});

const undoTool = (): ToolDefinition => ({
  name: 'morfa_undo',
  title: 'Undo my last change',
  description:
    "Takes back this connection's newest change of a file that is not undone yet (call it again for the one before). The person's own ⌘Z in the editor does not undo an assistant's changes, so use this when they ask to revert what you did. Refused when something that change touched was changed again since.",
  annotations: REMOVES,
  inputSchema: z.strictObject({
    ...fileTarget,
    editId: z.string().max(64).optional().describe('The editId an edit returned: undo only if it is still the newest.'),
  }),
  async handler(input: FileInput & {editId?: string}, principal) {
    const done = await undoEdit(principal, fileOf(input), input.editId);
    return {
      structured: {
        file: {...done.file, link: fileLink(mcpIssuer(), done.file.id)},
        version: done.version,
        undone: done.undone,
        undoable: done.left,
      },
      text: `Undid “${done.undone.label}”. Saved as version ${done.version}; ${done.left} earlier change${done.left === 1 ? '' : 's'} of yours can still be undone.`,
    };
  },
});

// ── Pictures ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const layerMissing = () =>
  new ToolError('not_found', 'No such layer in this file.', 'Take layer ids from morfa_get_file or morfa_get_layers.');

/** The picture into the layer (its top picture fill replaced, or one added) or as a new layer beside what is on the page. */
export async function placePicture(
  session: EditSession,
  picture: {ref: ImageRef; asset: ImageAsset},
  nodeId: NodeId | undefined,
  name: string,
): Promise<EditOutcome<NodeId>> {
  const {fillWithPicture, freeSpot, insertPicture, PictureRefused} = await import('../../src/design/canvas-tools/document');
  try {
    if (nodeId !== undefined) {
      if (!editableLayer(session.store.getState().doc, nodeId) || !fillWithPicture(session.store, nodeId, picture))
        return {ok: false, error: layerMissing()};
      return {ok: true, value: nodeId};
    }
    const {doc} = session.store.getState();
    const max = {width: 1024, height: 1024};
    const width = Math.min(max.width, picture.asset.width || 1024),
      height = Math.min(max.height, picture.asset.height || 1024);
    const view = session.view();
    const spot = freeSpot(doc, session.pageId, {x: view.x, y: view.y, width, height});
    return {ok: true, value: insertPicture(session.store, picture, {x: spot.x + width / 2, y: spot.y + height / 2}, max, name.slice(0, 100))};
  } catch (error) {
    if (error instanceof PictureRefused)
      return {ok: false, error: new ToolError('refused', 'Morfa would not store the picture in this layer.', 'Use another layer.')};
    throw error;
  }
}

// ── Looking ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The most a picture of layers may weigh (base64). */
const LOOK_MAX_CHARS = 1_500_000;
const LOOK_MAX_SIDE = 1600;

/** Pictures of layers need the server's render service (DESIGN_RASTER_ENGINE=service and DESIGN_RENDER_URL). */
export function lookAvailable(): boolean {
  try {
    return designRasterEngine() === 'service' && renderServiceUrl() !== null;
  } catch {
    return false;
  }
}

export const lookAtTool = (): ToolDefinition => ({
  name: 'morfa_look_at',
  title: 'Look at layers',
  description:
    "Returns a picture of a layer (usually a frame you built) or of a page's top-level layers, painted as Morfa paints them. Check it as a senior designer would: alignment, spacing rhythm, hierarchy, contrast, text that overflows or wraps badly, anything clipped or overlapping; then fix what is off.",
  inputSchema: z.strictObject({
    ...fileTarget,
    nodeId: nodeIdField,
    pageId: z.string().max(256).optional().describe('Without nodeId: the page to look at (the first page by default).'),
  }),
  async handler(input: FileInput & {nodeId?: string; pageId?: string}, principal) {
    const target = targetOf(input);
    const nodeId = input.nodeId ?? target.nodeId;
    const file = await openFile(principal, target.fileId);
    let ids: NodeId[], what: string;
    if (nodeId !== undefined) {
      const node = layerOf(file.doc, nodeId);
      ids = [nodeId];
      what = `“${node.name}” (${nodeId})`;
    } else {
      const pages = contentPages(file.doc);
      const pageId = input.pageId ?? pages[0];
      if (!pageId || !pages.includes(pageId)) throw new ToolError('not_found', 'No such page in this file.', 'Take page ids from morfa_get_file.');
      ids = (file.doc.nodes[pageId]?.children ?? []).filter(id => file.doc.nodes[id]?.visible !== false).slice(0, 100);
      what = `the page “${file.doc.nodes[pageId]!.name}”`;
      if (!ids.length) throw new ToolError('not_found', 'The page is empty: there is nothing to look at.', 'Build something first.');
    }
    const image = await paint(principal, file.doc, ids);
    return {
      structured: {file: {id: file.id, name: file.name, version: file.version}, layers: ids, mimeType: image.mimeType},
      text: `A picture of ${what} at version ${file.version}.${image.missingFonts.length ? ` Fonts missing on the server: ${image.missingFonts.join(', ')}.` : ''}`,
      images: [{data: image.data, mimeType: image.mimeType}],
    };
  },
});

async function paint(principal: Principal, doc: DesignDocument, ids: NodeId[]) {
  const {renderRaster} = await import('../design/raster-export');
  const {isDesignFailure} = await import('../design/errors');
  const actor = mcpAuthority(principal);
  try {
    for (const kind of ['png', 'jpeg'] as const) {
      const painted = await renderRaster(actor, doc, ids, {kind, account: principal.userId, maxSide: LOOK_MAX_SIDE, quality: 85, timeoutMs: 25_000});
      const data = painted.body.toString('base64');
      if (data.length <= LOOK_MAX_CHARS) return {data, mimeType: painted.contentType, missingFonts: painted.missingFonts};
    }
  } catch (error) {
    if (isDesignFailure(error))
      throw new ToolError('unavailable', 'Morfa could not paint these layers right now.', 'Look at a smaller frame, or read it with morfa_get_layers.', {code: error.code});
    throw error;
  }
  throw new ToolError('too_large', 'The picture is too large to send.', 'Look at a smaller frame.');
}

/** The editing tools, in a fixed order; built once (their descriptions carry the font list). */
let editTools: ToolDefinition[] | null = null;
export function editingTools(): readonly ToolDefinition[] {
  editTools ??= [
    createFileTool(),
    addPageTool(),
    createLayersTool(),
    updateLayersTool(),
    deleteLayersTool(),
    duplicateLayersTool(),
    addColorStylesTool(),
    placeImageTool(),
    uploadImageTool(),
    undoTool(),
  ];
  return editTools;
}

