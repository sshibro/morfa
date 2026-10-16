import type {DocumentPatch} from '../../../../shared/design/patch';
import type {ProtocolChange, ServerMessage} from '../../../../shared/design/protocol';
import type {SceneNode} from '../../../../shared/design/types';
import {composeFieldsInto, type ChangeFields} from '../fields';

// Large frames off the main thread. A
// catch-up of 1 000 ops is ~10 MB of JSON: parsing it takes ~150 ms, far over a frame. The worker (decode-worker.ts)
// parses it and composes the list of changes into one, which is what the session applies anyway (one composed patch,
// the unsaved changes rebased once): the main thread receives the composite, as large as the distinct entries it
// touches (a 30 s outage of five people moving layers: a few hundred entries, not 20 000).

/** Frames at least this long (characters or bytes) decode in the worker; a 20-layer op (~9 KB) stays on the main thread. */
export const LARGE_FRAME = 64 * 1024;

/** A binary-wire frame (crates/protocol/src/binary.rs: 0xB1 a message, 0xB2 presence, 0xB3 changes); a JSON frame
 *  never starts with these bytes (they are not a UTF-8 lead byte). */
export function isBinaryFrame(data: ArrayBuffer | Uint8Array): boolean {
  const first = (data instanceof Uint8Array ? data : new Uint8Array(data, 0, Math.min(1, data.byteLength)))[0];
  return first === 0xb1 || first === 0xb2 || first === 0xb3;
}

/** Several consecutive changes as one: versions `first`..`version`, the ops of each client they hold (`ops`). */
export type CompositeChange = ProtocolChange & {first: number; ops: {client: string; seq: number; version: number}[]};

/** Composes a run of consecutive changes; null when they are not consecutive (the session then takes them one by one).
 *  Field-level nodes (protocol 2) compose too: over a whole node an earlier change wrote, or merged with earlier fields. */
export function composeChanges(changes: readonly ProtocolChange[]): CompositeChange | null {
  if (changes.length < 2) return null;
  for (let i = 1; i < changes.length; i++) if (changes[i].version !== changes[i - 1].version + 1) return null;
  const tables: Record<string, Record<string, unknown> | string[]> = {};
  const fields: ChangeFields = {};
  const ops: CompositeChange['ops'] = [];
  for (const change of changes) {
    for (const [table, value] of Object.entries(change.patch)) {
      if (value === undefined) continue;
      if (table === 'pages') tables.pages = value as string[];
      else {
        // A whole node replaces what earlier fields said of it.
        if (table === 'nodes' && value) for (const id of Object.keys(value)) delete fields[id];
        Object.assign(((tables[table] as Record<string, unknown> | undefined) ??= {}) as Record<string, unknown>, value);
      }
    }
    if (change.fields && !composeFieldsInto(((tables.nodes as Record<string, SceneNode | null> | undefined) ?? {}), fields, change.fields as ChangeFields)) return null;
    if (change.client !== undefined && change.seq !== undefined) ops.push({client: change.client, seq: change.seq, version: change.version});
  }
  const last = changes[changes.length - 1];
  return {version: last.version, first: changes[0].version, by: null, user: last.user, patch: tables as DocumentPatch, ...(Object.keys(fields).length ? {fields} : {}), ops};
}

/** A decoded frame with its catch-up composed (`changes`: after a welcome, or the answer to a pull). */
export function decodeComposed(text: string): ServerMessage {
  const message = JSON.parse(text) as ServerMessage;
  if (message.t === 'changes') {
    const composite = composeChanges(message.changes);
    if (composite) message.changes = [composite];
  }
  return message;
}
