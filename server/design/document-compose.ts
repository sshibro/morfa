import type {DesignDocument} from '../../shared/design/types';
import {applyPatch} from '../../shared/design/patch';
import {documentText} from './document-text';
import {applyRowOnStore, checkpointObject, checkpointOnStore, decodeJournalRow, isEntryRow, loadCheckpoint} from './collab/checkpoint';
import {designFail} from './errors';
import {engineWasm, type MorfaDocHandle} from '../../shared/design/engine-switch';

// A file's document from what PostgreSQL stores (document-store.ts says how it is stored): the base — `design_files.document`, or
// collab's checkpoint once one is recorded — and the rows of design_file_changes above it, applied in version order. No database
// here: the statements are document-store.ts's and lifecycle.ts's, which join these columns into one snapshot.

export type Num = number | string;
/** A file's base and the rows after it, as one statement reads them (`WAITING_CHANGES_OF`). `document` is null when a checkpoint
 *  is the base (the text is not read then). */
export type Stored = {
  document: string | null;
  version: Num;
  checkpoint_key?: string | null;
  checkpoint_version?: Num | null;
  versions: Num[] | null;
  patches: (string | null)[] | null;
  ops?: (Buffer | null)[] | null;
};

/** The base columns of `design_files <alias>`: the text only when no checkpoint is recorded. */
export const BASE_OF = (alias: string) =>
  `CASE WHEN ${alias}.checkpoint_key IS NULL THEN ${alias}.document END AS document,${alias}.checkpoint_key,${alias}.checkpoint_version`;
/** The rows of the file `alias` names above its base, as `c.versions`, `c.patches` and `c.ops`: joined to a read of the base, so one
 *  statement (one snapshot) sees the base and the changes that go after it. */
export const WAITING_CHANGES_OF = (alias: string) =>
  `LEFT JOIN LATERAL (SELECT array_agg(version ORDER BY version) AS versions,array_agg(patch ORDER BY version) AS patches,
       array_agg(op ORDER BY version) AS ops
     FROM design_file_changes WHERE file_id=${alias}.id AND version>COALESCE(${alias}.checkpoint_version,0)) c ON true`;

export const hasRows = (stored: Stored) => !!stored.versions?.length;

/** The base document of `stored`: its checkpoint object, or its text parsed. */
export async function baseOf(stored: Stored): Promise<DesignDocument> {
  if (stored.checkpoint_key) return loadCheckpoint(stored.checkpoint_key, Number(stored.checkpoint_version));
  if (stored.document === null) throw Error('A design file has neither a checkpoint nor a document.');
  return JSON.parse(stored.document) as DesignDocument;
}

/** The document the base and its rows make. The rows are exactly the versions after the base, up to the file's (anything else is
 *  refused: a document is never put together from a gap). `base` is required when a checkpoint is the base. */
export function composeStored(stored: Stored, base?: DesignDocument): DesignDocument {
  let doc = base ?? (JSON.parse(stored.document ?? 'null') as DesignDocument);
  if (!doc) throw Error('composeStored: the checkpoint of this file must be read first (baseOf).');
  const versions = (stored.versions ?? []).map(Number), last = Number(stored.version);
  const from = stored.checkpoint_key ? Number(stored.checkpoint_version) : last - versions.length;
  versions.forEach((version, k) => {
    if (version !== from + 1 + k || from + versions.length !== last) throw Error(`The saved changes of a design file are not the versions up to ${last}.`);
    const body = decodeJournalRow(stored.patches?.[k] ?? null, stored.ops?.[k] ?? null, version);
    // A store entry replays only on the store (composeOnStore, which composedOf takes for such a file).
    if (body.kind === 'entry') designFail(503, 'design_unavailable', 'The file is currently open for co-editing in another way. Try again later.');
    // The parsed document is this function's own, so its node table takes each change in place: a copy of a 20 000-entry table per
    // change held the event loop ~0.9 s for 120 changes, in place it is the parse's ~0.14 s. Same operations, same result.
    doc = body.kind === 'replace' ? body.document : applyPatch(doc, body.patch, doc.nodes);
  });
  if (stored.checkpoint_key && from + versions.length !== last) throw Error(`The saved changes of a design file are not the versions up to ${last}.`);
  return doc;
}

/** The document `stored` makes, reading its checkpoint first when it has one. A file with store journal entries (`MRFJ` rows) is
 *  put together on the model's store, as crates/checkpoint loads it. */
export async function composedOf(stored: Stored): Promise<DesignDocument> {
  if (stored.ops?.some(isEntryRow)) return composeOnStore(stored);
  return composeStored(stored, stored.checkpoint_key ? await baseOf(stored) : undefined);
}

/** crates/checkpoint's load in crates/wasm: the checkpoint decoded into a store document (or the stored text parsed into one), then
 *  every row in order on it — patches, whole documents and journal entries, which replay only on the interners that load made. */
export async function composeOnStore(stored: Stored): Promise<DesignDocument> {
  const versions = (stored.versions ?? []).map(Number), last = Number(stored.version);
  const from = stored.checkpoint_key ? Number(stored.checkpoint_version) : last - versions.length;
  if (versions.some((version, k) => version !== from + 1 + k) || from + versions.length !== last)
    throw Error(`The saved changes of a design file are not the versions up to ${last}.`);
  let handle: MorfaDocHandle;
  if (stored.checkpoint_key) {
    const object = checkpointOnStore(await checkpointObject(stored.checkpoint_key));
    if (object.header.version !== from) {
      object.handle.free();
      throw Error(`${stored.checkpoint_key} holds version ${object.header.version}, recorded as ${from}`);
    }
    handle = object.handle;
  } else {
    if (stored.document === null) throw Error('A design file has neither a checkpoint nor a document.');
    handle = new (engineWasm().MorfaDoc)(stored.document);
  }
  try {
    versions.forEach((version, k) => {
      handle = applyRowOnStore(handle, stored.patches?.[k] ?? null, stored.ops?.[k] ?? null, version);
    });
    return JSON.parse(handle.to_json()) as DesignDocument;
  } finally {
    handle.free();
  }
}

/** The whole JSON text `stored` makes: the stored text itself when it is the base and no change waits after it. */
export async function wholeTextOf(stored: Stored): Promise<string> {
  return !hasRows(stored) && !stored.checkpoint_key && stored.document !== null ? stored.document : documentText(await composedOf(stored)).toString('utf8');
}

