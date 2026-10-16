// Pictures an assistant brings itself (docs/mcp-server.md §Pictures): one ChatGPT or Codex drew, one the person pasted into the chat, a
// file on their computer. They are stored as the editor stores a picture dropped on the canvas (server/design/files.ts storeDesignImage:
// decoded, re-encoded, counted in the account's storage) and placed as a picture dropped on the canvas is (edit-tools.ts placePicture).
// Three ways in, for the ways assistants hold a picture:
//   - a link (a picture on the web, or the download link ChatGPT gives for a file in the chat), fetched with the link previews' guard
//     (link-preview.ts fetchChecked: public addresses only, every redirect checked);
//   - the picture itself in the call, base64, when it is small (the call's body is capped at MAX_MCP_BODY_BYTES);
//   - an upload address (morfa_upload_image) that a program on the person's computer sends the file to with a plain PUT, for an
//     assistant with a terminal (Claude Code, Codex): the address is the credential, good for one picture, for UPLOAD_MINUTES.
import {randomBytes, randomUUID} from 'node:crypto';
import {z} from 'zod/v4';
import {digest} from '../auth';
import {db} from '../db';
import {isDesignFailure} from '../design/errors';
import {storeDesignImage} from '../design/files';
import {checkUrl, DEFAULT_POLICY, fetchChecked, type FetchPolicy} from '../design/link-preview';
import {DESIGN_DOCUMENT_CAPS} from '../../shared/design/limits';
import type {ImageAsset, ImageRef} from '../../shared/design/types';
import {credentialState, CREDENTIAL_SQL, type CredentialRow, type Principal} from './auth';
import {mcpAuthority} from './authority';
import {MCP_PATH, mcpIssuer} from './config';
import {fileLink, targetOf} from './design-read';
import {editFile, editRefusal, editableLayer, requireWriter} from './edits';
import {placePicture} from './edit-tools';
import {ToolError} from './errors';
import {openFile} from './files';
import {scopesOf} from './oauth/shared';
import {fileIdField, linkField, nodeIdField, type ToolDefinition} from './tools';

/** How long an upload address takes a picture; a received picture can be placed for PLACE_HOURS after. */
export const UPLOAD_MINUTES = 10;
export const PLACE_HOURS = 24;
/** The most a picture may weigh as sent (the editor's own cap; it is re-encoded after). */
export const MAX_PICTURE_BYTES = DESIGN_DOCUMENT_CAPS.imageBytes;
/** A picture in the call itself: what fits in the call's body with the rest of it. */
export const MAX_INLINE_CHARS = 1_000_000;
export const UPLOAD_PATH = `${MCP_PATH}/uploads`;
const FETCH_TIMEOUT_MS = 20_000;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

type Picture = {ref: ImageRef; asset: ImageAsset};

/** How links are fetched: the link previews' guard. The tests point it at a loopback server. */
export const pictureFetch: {policy: FetchPolicy} = {policy: DEFAULT_POLICY};

// ── Storing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The picture stored in the file's images, or a tool error the model can act on. */
async function store(principal: Principal, fileId: string, data: Buffer, name?: string): Promise<Picture> {
  try {
    return await storeDesignImage(mcpAuthority(principal), fileId, data, name);
  } catch (error) {
    throw pictureStoreRefusal(error);
  }
}

function pictureStoreRefusal(error: unknown): unknown {
  if (isDesignFailure(error) && error.status === 415)
    return new ToolError(
      'invalid_input',
      'That is not a picture Morfa can use: it takes PNG, JPEG, WebP, AVIF and GIF (not SVG, not HEIC).',
      'Convert it to PNG or JPEG and send it again.',
    );
  if (isDesignFailure(error) && error.status === 413)
    return new ToolError('too_large', 'Morfa refused the picture: it is too big, or the account has no room left.', 'Tell the person (details.message says which, in Russian); a smaller picture may fit.', {
      code: error.code,
      message: error.message,
    });
  return editRefusal(error);
}

/** The picture behind a link, within MAX_PICTURE_BYTES, from a public address only. */
async function download(raw: string, policy: FetchPolicy, signal: AbortSignal): Promise<Buffer> {
  const url = checkUrl(raw, policy);
  if (!url)
    throw new ToolError('invalid_input', 'That link cannot be fetched: it must be a public http or https address.', 'Pass a public link, or the picture itself (data).');
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)]);
  let fetched;
  try {
    fetched = await fetchChecked(url, {
      maxBytes: MAX_PICTURE_BYTES + 1,
      accept: 'image/*,*/*;q=0.5',
      // The bytes decide (storeDesignImage reads the type from them); a download link often says only octet-stream.
      type: type => !/^text\/|html|json|xml/i.test(type),
      signal: timeout,
      policy,
    });
  } catch (error) {
    const reason = (error as {reason?: string}).reason ?? 'fetch_failed';
    throw new ToolError('unavailable', `The picture could not be fetched from that link (${reason}).`, 'Check the link opens without signing in, or pass the picture itself (data).', {reason});
  }
  if (fetched.truncated || fetched.body.length > MAX_PICTURE_BYTES)
    throw new ToolError('too_large', `The picture is over ${MAX_PICTURE_BYTES / 1024 / 1024} MB.`, 'Send a smaller picture.');
  return fetched.body;
}

const decodeInline = (data: string): Buffer => {
  const text = data.replace(/^data:[^,]*;base64,/i, '').replace(/\s+/g, '');
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(text))
    throw new ToolError('invalid_input', 'data is not base64.', 'Pass the picture file as base64 (a data: URL is fine too).');
  return Buffer.from(text, 'base64');
};

// ── Upload addresses ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A new upload address for a picture of `fileId`, for this connection. Old slots of the connection are let go on the way. */
export async function createUploadSlot(principal: Principal, fileId: string): Promise<{id: string; secret: string; expiresAt: string}> {
  const secret = randomBytes(32).toString('base64url');
  const id = randomUUID();
  const row = await db.transaction(async tx => {
    await tx.execute(`DELETE FROM mcp_uploads WHERE grant_id=$1 AND created_at < clock_timestamp() - make_interval(hours=>$2::int)`, [
      principal.grantId,
      PLACE_HOURS,
    ]);
    return tx.one<{expires_at: string}>(
      `INSERT INTO mcp_uploads(id,secret_hash,grant_id,file_id,expires_at) VALUES($1,$2,$3,$4,clock_timestamp() + make_interval(mins=>$5::int))
       RETURNING to_char(expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS expires_at`,
      [id, digest(secret), principal.grantId, fileId, UPLOAD_MINUTES],
    );
  });
  return {id, secret, expiresAt: row!.expires_at};
}

export const uploadUrl = (secret: string, issuer: string = mcpIssuer()) => `${issuer}${UPLOAD_PATH}/${secret}`;

export type UploadAnswer = {status: number; body: Record<string, unknown>};

/**
 * A picture sent to an upload address: stored in the slot's file for the connection that asked for it, if that connection still works
 * and may change files. Once; a second picture to the same address is refused.
 */
export async function receiveUpload(secret: string, data: Buffer, name?: string): Promise<UploadAnswer> {
  const gone = {status: 404, body: {error: 'not_found', message: 'This upload address is unknown, used or expired. Ask morfa_upload_image for a new one.'}};
  if (!SECRET.test(secret)) return gone;
  const slot = await db.one<{id: string; grant_id: string; file_id: string}>(
    `SELECT id,grant_id,file_id FROM mcp_uploads WHERE secret_hash=$1 AND received_at IS NULL AND expires_at > clock_timestamp()`,
    [digest(secret)],
  );
  if (!slot) return gone;
  // The connection acts through its newest live access token, checked as a call's own would be.
  const row = await db.one<CredentialRow>(
    `${CREDENTIAL_SQL.replace('k.token_hash=$1', `k.grant_id=$1 AND k.revoked_at IS NULL`)} ORDER BY k.expires_at DESC LIMIT 1`,
    [slot.grant_id],
  );
  if (!row || credentialState(row) !== undefined)
    return {status: 403, body: {error: 'forbidden', message: 'The Morfa connection that asked for this address no longer works.'}};
  const principal: Principal = {
    grantId: row.grant_id,
    tokenId: row.token_id,
    userId: row.user_id,
    client: row.client.slice(0, 80),
    scopes: new Set(scopesOf(row.scopes)),
  };
  let picture: Picture;
  try {
    requireWriter(principal);
    picture = await store(principal, slot.file_id, data, name);
  } catch (error) {
    if (!(error instanceof ToolError)) throw error;
    const status = error.code === 'too_large' ? 413 : error.code === 'invalid_input' ? 415 : 403;
    return {status, body: {error: error.code, message: error.message}};
  }
  const taken = await db.execute(
    `UPDATE mcp_uploads SET picture=$2::jsonb, received_at=clock_timestamp() WHERE id=$1 AND received_at IS NULL`,
    [slot.id, JSON.stringify(picture)],
  );
  if (!taken.changes) return gone;
  return {
    status: 201,
    body: {uploadId: slot.id, width: picture.asset.width, height: picture.asset.height, next: 'Call morfa_place_image with this uploadId.'},
  };
}

/** The picture received at the connection's upload `id`, for `fileId`. */
async function takeUpload(principal: Principal, id: string, fileId: string): Promise<Picture> {
  const row = await db.one<{file_id: string; picture: Picture | null}>(
    `SELECT file_id,picture FROM mcp_uploads WHERE id=$1 AND grant_id=$2 AND created_at > clock_timestamp() - make_interval(hours=>$3::int)`,
    [id, principal.grantId, PLACE_HOURS],
  );
  if (!row) throw new ToolError('not_found', 'No such upload for this connection (or it expired).', 'Ask morfa_upload_image for a new address and send the picture again.');
  if (!row.picture)
    throw new ToolError('not_found', 'Nothing has been sent to that upload address yet.', 'Send the file first (the PUT the upload tool described), then call again.');
  if (row.file_id !== fileId)
    throw new ToolError('invalid_input', 'That upload belongs to another file.', 'Place it in the file it was uploaded for, or upload it again for this one.');
  return row.picture;
}

// ── The tools ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const ADDS = {readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false};

export const uploadImageTool = (): ToolDefinition => ({
  name: 'morfa_upload_image',
  title: 'Get an upload address for a picture',
  description: `For a picture file on the person's computer (or one you made in a terminal): returns an address to send it to with a plain HTTP PUT of the file's bytes, e.g. curl -sS -T picture.png "<uploadUrl>". Then call morfa_place_image with the uploadId. The address takes one picture (PNG, JPEG, WebP, AVIF or GIF, up to ${MAX_PICTURE_BYTES / 1024 / 1024} MB) within ${UPLOAD_MINUTES} minutes. Use morfa_place_image directly when you have a link to the picture or it is small enough to pass as base64.`,
  annotations: ADDS,
  inputSchema: z.strictObject({link: linkField, fileId: fileIdField}),
  async handler(input: {link?: string; fileId?: string}, principal) {
    requireWriter(principal);
    const {fileId} = targetOf(input);
    const file = await openFile(principal, fileId);
    const slot = await createUploadSlot(principal, file.id);
    const url = uploadUrl(slot.secret);
    return {
      structured: {uploadId: slot.id, uploadUrl: url, method: 'PUT', expiresAt: slot.expiresAt, file: {id: file.id, name: file.name}},
      text: `Send the picture with: curl -sS -T <path to the picture> "${url}" (within ${UPLOAD_MINUTES} minutes), then call morfa_place_image with uploadId "${slot.id}".`,
    };
  },
});

/** ChatGPT's way of handing a file from the chat to a tool (developers.openai.com/apps-sdk, `openai/fileParams`). */
const chatFile = z
  .object({
    download_url: z.string().max(4096).describe('Where to fetch the file.'),
    file_id: z.string().max(256),
    mime_type: z.string().max(200).optional(),
    file_name: z.string().max(300).optional(),
  })
  .describe('A picture from the conversation (ChatGPT fills this in from an image in the chat).');

type PlaceInput = {
  link?: string;
  fileId?: string;
  nodeId?: string;
  pageId?: string;
  name?: string;
  url?: string;
  data?: string;
  uploadId?: string;
  file?: z.infer<typeof chatFile>;
};

export const placeImageTool = (): ToolDefinition => ({
  name: 'morfa_place_image',
  title: 'Put a picture in a file',
  description: `Puts a picture you have into a Morfa file: one you generated (ChatGPT, Codex or another tool), one the person gave you, or a file from their computer. Give exactly one of: url (a public link to the picture), file (an image from this conversation), data (the picture itself as base64, up to ${MAX_INLINE_CHARS.toLocaleString('en')} characters) or uploadId (from morfa_upload_image, for bigger files on the computer). With nodeId it fills that layer (an IMAGE placeholder, a rectangle or a frame; its picture is replaced); without, it becomes a new picture layer on the page, right of what is there. PNG, JPEG, WebP, AVIF or GIF.`,
  // It may fetch a link from the web.
  annotations: {...ADDS, openWorldHint: true},
  // ChatGPT passes images from the chat only into arguments a tool names here.
  meta: {'openai/fileParams': ['file']},
  budgetMs: 60_000,
  inputSchema: z.strictObject({
    link: linkField,
    fileId: fileIdField,
    nodeId: nodeIdField,
    pageId: z.string().max(256).optional().describe('Without nodeId: the page for the new picture layer.'),
    name: z.string().max(100).optional().describe("Without nodeId: the new layer's name."),
    url: z.string().max(4096).optional().describe('A public http(s) link to the picture.'),
    file: chatFile.optional(),
    data: z.string().max(MAX_INLINE_CHARS).optional().describe('The picture file as base64 (or a data: URL).'),
    uploadId: z.string().max(64).optional().describe('From morfa_upload_image, after the file was sent.'),
  }),
  async handler(input: PlaceInput, principal, {signal}) {
    requireWriter(principal);
    const target = targetOf(input);
    const nodeId = input.nodeId ?? target.nodeId;
    const given = (['url', 'file', 'data', 'uploadId'] as const).filter(key => input[key] !== undefined);
    if (given.length !== 1)
      throw new ToolError('invalid_input', 'Give exactly one of url, file, data or uploadId.', 'Pass the one that holds the picture.');
    // The layer first, so nothing is fetched or stored for a layer that is not there.
    if (nodeId !== undefined) {
      const file = await openFile(principal, target.fileId);
      if (!editableLayer(file.doc, nodeId))
        throw new ToolError('not_found', 'No such layer in this file.', 'Take layer ids from morfa_get_file or morfa_get_layers.');
    }
    let picture: Picture,
      name = input.name;
    if (input.uploadId !== undefined) {
      picture = await takeUpload(principal, input.uploadId, target.fileId);
      name ??= picture.asset.name;
    } else {
      const bytes =
        input.data !== undefined
          ? decodeInline(input.data)
          : await download(input.file?.download_url ?? input.url!, pictureFetch.policy, signal);
      name ??= input.file?.file_name;
      picture = await store(principal, target.fileId, bytes, name);
    }
    const placed = await editFile(
      principal,
      {fileId: target.fileId, pageId: nodeId === undefined ? input.pageId : undefined, near: nodeId},
      'Image',
      session => placePicture(session, picture, nodeId, name?.replace(/\.[a-z0-9]{2,5}$/i, '') || 'Picture'),
    );
    const where = nodeId === undefined ? `as the new layer ${placed.value}` : `into ${nodeId}`;
    return {
      structured: {
        file: {...placed.file, link: fileLink(mcpIssuer(), placed.file.id, placed.value)},
        version: placed.version,
        editId: placed.editId,
        layer: placed.value,
        picture: {width: picture.asset.width, height: picture.asset.height},
      },
      text: `Put the picture ${where} (${picture.asset.width}×${picture.asset.height}). Saved as version ${placed.version}.${placed.editId ? ' morfa_undo takes it back.' : ''}`,
    };
  },
});
