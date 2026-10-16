import {createDocument, createNode} from '../../shared/design/defaults';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';
import {engineWasm} from '../../shared/design/engine-switch';
import {nsPerCall} from './engine-calls';
import type {Row} from './engine-core';
import type {DocumentPatch} from '../../shared/design/patch';
import {resolveChanges, type ChangeFields} from '../../src/design/realtime/fields';

// Lane E1, W2 (docs/TARGETS.md §3b): one 20-layer move as the server sends it (whole entries, the loadgen op), decoded
// at the browser edge — the JSON wire's JSON.parse against the binary wire's crates/wasm `decode_frame` + JSON.parse
// (src/design/realtime/transport/ws.ts `binaryCodec`), and the bytes of each. Same code in Node and Chromium
// (scripts/bench/engine.ts --core wire [--chrome] [--throttle 2]). The last row is where the binary wire starts to win
// end to end: the link speed below which its fewer bytes arrive sooner than its slower decode costs. The `fields` rows
// (lane W) are the same move as protocol 2 sends it, decoded and spread over the receiver's nodes.

type Wire = {decode_frame(bytes: Uint8Array): string; encode_frame(json: string): Uint8Array};

/** f20k's shape (scripts/bench/collab-client.ts): 40 screens × 10 sections × 49 rectangles. */
function f20k(): DesignDocument {
  const doc = createDocument('page', 'Heavy page');
  let n = 0;
  const add = (type: NodeType, parentId: NodeId, props: Partial<SceneNode>) => {
    const id = `n${++n}`;
    doc.nodes[id] = createNode(type, {...props, id, parentId});
    doc.nodes[parentId].children!.push(id);
    return id;
  };
  for (let s = 0; s < 40; s++) {
    const screen = add('FRAME', 'page', {x: (s % 8) * 1600, y: Math.floor(s / 8) * 2200, width: 1440, height: 2000});
    for (let k = 0; k < 10; k++) {
      const section = add('FRAME', screen, {x: 0, y: k * 200, width: 1440, height: 200});
      for (let i = 0; i < 49; i++) add('RECTANGLE', section, {x: 20 + (i % 12) * 110, y: 20 + Math.floor(i / 12) * 38, width: 100, height: 30});
    }
  }
  return doc;
}

export function wireBench(): Row[] {
  const wasm = engineWasm() as unknown as Wire;
  const doc = f20k();
  const nodes: Record<NodeId, SceneNode> = {};
  for (let k = 0; k < 20; k++) {
    const id = `n${3 + ((5 * 37 + k * 101) % 20_000)}`;
    nodes[id] = {...doc.nodes[id], x: doc.nodes[id].x + 3};
  }
  const text = JSON.stringify({t: 'change', version: 7, by: 'c2', user: 'u2', patch: {nodes}});
  const frame = wasm.encode_frame(text);
  const json = nsPerCall(() => JSON.parse(text), 400) / 1000;
  const binary = nsPerCall(() => JSON.parse(wasm.decode_frame(frame)), 400) / 1000;
  const saved = (new TextEncoder().encode(text).length - frame.length) * 8;
  const rows: Row[] = [
    {name: 'W2 op: JSON bytes', value: new TextEncoder().encode(text).length, unit: 'B'},
    {name: 'W2 op: binary bytes', value: frame.length, unit: 'B', note: `${(frame.length / text.length).toFixed(2)}× JSON (W3 ≤ 0.5×)`},
    {name: 'W2 decode: JSON.parse', value: json, unit: 'µs'},
    {name: 'W2 decode: decode_frame + JSON.parse', value: binary, unit: 'µs', note: `${(binary / json).toFixed(2)}× JSON`},
    {name: 'binary wins end to end below', value: saved / Math.max(1e-9, binary - json), unit: 'Mbit/s', note: 'the bits it saves ÷ the decode time it adds'},
  ];
  // Protocol 2 (lane W): the same move as the fields that changed, spread over the receiver's nodes
  // (src/design/realtime/fields.ts resolveChanges): what a remote op costs from the frame to the patch the store takes.
  const fields: Record<NodeId, {set: Record<string, unknown>}> = {};
  for (const [id, node] of Object.entries(nodes)) fields[id] = {set: {x: node.x}};
  const fieldText = JSON.stringify({t: 'change', version: 7, by: 'c2', user: 'u2', patch: {}, fields});
  const fieldFrame = wasm.encode_frame(fieldText);
  const fieldBytes = new TextEncoder().encode(fieldText).length;
  const base = (id: NodeId) => doc.nodes[id];
  type Msg = {patch: DocumentPatch; fields?: ChangeFields};
  const fieldJson = nsPerCall(() => resolveChanges([JSON.parse(fieldText) as Msg], null, base), 400) / 1000;
  const fieldBinary = nsPerCall(() => resolveChanges([JSON.parse(wasm.decode_frame(fieldFrame)) as Msg], null, base), 400) / 1000;
  const wholeJson = nsPerCall(() => resolveChanges([JSON.parse(text) as Msg], null, base), 400) / 1000;
  const fieldSaved = (fieldBytes - fieldFrame.length) * 8;
  rows.push(
    {name: 'W2 whole: JSON.parse + resolve', value: wholeJson, unit: 'µs', note: 'protocol 1: whole nodes into the patch'},
    {name: 'W2 fields op: JSON bytes', value: fieldBytes, unit: 'B', note: `${(fieldBytes / new TextEncoder().encode(text).length).toFixed(3)}× today's JSON (W3 ≤ 0.5×)`},
    {name: 'W2 fields op: binary bytes', value: fieldFrame.length, unit: 'B', note: `${(fieldFrame.length / new TextEncoder().encode(text).length).toFixed(3)}× today's JSON`},
    {name: 'W2 fields: JSON.parse + spread', value: fieldJson, unit: 'µs', note: 'W2 ≤ 150 µs (ceiling 500)'},
    {name: 'W2 fields: decode_frame + JSON.parse + spread', value: fieldBinary, unit: 'µs', note: `${(fieldBinary / fieldJson).toFixed(2)}× JSON fields`},
    {name: 'fields: binary wins end to end below', value: fieldSaved / Math.max(1e-9, fieldBinary - fieldJson), unit: 'Mbit/s', note: 'the bits it saves ÷ the decode time it adds'},
  );
  return rows;
}

export const bench = wireBench;
