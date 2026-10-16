// The client's share of co-editing on the socket (docs/TARGETS.md §3 M3/M8 and §3b W2/W6; lane B3): what one remote op
// and a 1 000-op catch-up cost the editor's main thread, measured through the real live session, store and autosave on
// a 20 041-layer file (f20k's shape), with a few unsaved local edits to rebase over.
//
//   tsx scripts/bench/collab-client.ts            prints the rows (medians of the runs)
//   tsx scripts/bench/collab-client.ts --json     one JSON line
//
// The rows:
//   W2-json   one 20-layer move (~9 KB of JSON, the loadgen op): decode of the frame → the session → store.applyRemote
//             with the rebase of unsaved changes; `decode` is the JSON.parse alone (the WASM decode replaces it later).
//   W6        1 000 such ops in the `changes` frame after the welcome: bytes on the wire and the decode; `apply` composes and applies them.
//   W6-worker the same catch-up through the decode worker: its parse + compose, and the main thread's share.
//   W6-5ed    1 000 ops of 5 editors each moving their own selection (M8's shape): the composite stays small.
//   W2-bin, W6-bin  the same through the binary wire (`?wire=bin`): crates/wasm's decode_frame (Node build in
//             server/design/wasm) + JSON.parse, as binaryCodec does; skipped when that build lacks decode_frame.
//   …-fields  the same ops as protocol 2 sends them (lane W): each moved layer as `fields: {id: {set: {x}}}`, spread over
//             the editor's node (src/design/realtime/fields.ts) instead of whole entries.
// Node runs these, not the laptop's browser: the numbers are for the dev loop (TARGETS §10); closing runs in Chromium.
import {createRequire} from 'node:module';
import v8 from 'node:v8';
import {createDocument, createNode, solid} from '../../shared/design/defaults';
import type {DocumentPatch} from '../../shared/design/patch';
import type {ServerMessage} from '../../shared/design/protocol';
import type {DesignDocument, NodeId, NodeType, SceneNode} from '../../shared/design/types';
import type {TextMeasurer} from '../../shared/design/text-layout';
import {createDesignStore} from '../../src/design/engine/store';
import {attachPersistence} from '../../src/design/editor/editor-session';
import {startLiveSession} from '../../src/design/realtime/live-session';
import {memoryQueue, type ClientIdentity} from '../../src/design/realtime/offline-queue';
import {binaryCodec, jsonCodec, wsTransport, type SocketLike, type WasmWire, type WireCodec} from '../../src/design/realtime/transport/ws';
import {decodeComposed} from '../../src/design/realtime/transport/frame-decoder';

/** crates/wasm's Node build, when it has the binary wire's exports. */
const wasmWire: WasmWire | null = (() => {
  try {
    const wasm = createRequire(import.meta.url)('../../server/design/wasm') as Partial<WasmWire>;
    return typeof wasm.decode_frame === 'function' && typeof wasm.encode_frame === 'function' ? (wasm as WasmWire) : null;
  } catch {
    return null;
  }
})();

/** A server frame on the binary wire: one message (0xB1), or a `changes` batch (0xB3: a varint count, then each change's
 *  0xB1 frame behind its varint length), as crates/protocol/src/binary.rs writes them. */
function binaryFrame(wasm: WasmWire, message: ServerMessage): Uint8Array {
  if (message.t !== 'changes') return wasm.encode_frame(JSON.stringify(message));
  const parts = message.changes.map(change => wasm.encode_frame(JSON.stringify({t: 'change', ...change})));
  const out: number[] = [0xb3];
  const varint = (n: number) => {
    for (; n >= 0x80; n >>>= 7) out.push((n & 0x7f) | 0x80);
    out.push(n);
  };
  varint(parts.length);
  let size = out.length;
  const lengths = parts.map(part => {
    const start = out.length;
    varint(part.length);
    const header = out.splice(start);
    size += header.length + part.length;
    return header;
  });
  const frame = new Uint8Array(size);
  frame.set(out, 0);
  let at = out.length;
  parts.forEach((part, i) => {
    frame.set(lengths[i], at);
    at += lengths[i].length;
    frame.set(part, at);
    at += part.length;
  });
  return frame;
}

const measurer: TextMeasurer = {width: (text, font) => text.length * font.size * 0.5, metrics: font => ({ascent: font.size * 0.8, descent: font.size * 0.2})};

/** 20 041 nodes: 40 screens × 10 sections × 49 layers (tests/design-live-client.test.ts heavyPage). */
export function f20k(): DesignDocument {
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

/** A 20-layer move as the server sends it (whole entries, as DocumentPatch carries them). */
const moveOp = (doc: DesignDocument, round: number, editors = 0): DocumentPatch => {
  const nodes: Record<string, SceneNode> = {};
  for (let k = 0; k < 20; k++) {
    // Spread over the file (every op its own layers), or `editors` people each moving their own 20-layer selection.
    const id = editors ? `n${3 + (((round % editors) * 20 + k) * 211) % 20_000}` : `n${3 + ((round * 37 + k * 101) % 20_000)}`;
    nodes[id] = {...doc.nodes[id], x: doc.nodes[id].x + 1 + (round % 7)};
  }
  return {nodes};
};

/** The same move as protocol 2 sends it (crates/protocol/src/fields.rs): only the field that changed. */
const fieldsOp = (doc: DesignDocument, round: number, editors = 0): {patch: DocumentPatch; fields: Record<string, {set: Record<string, unknown>}>} => {
  const fields: Record<string, {set: Record<string, unknown>}> = {};
  for (const [id, node] of Object.entries(moveOp(doc, round, editors).nodes!)) fields[id] = {set: {x: node!.x}};
  return {patch: {}, fields};
};

/** A change's body in either form, and the shadow document moved by it. */
const changeOf = (doc: DesignDocument, round: number, editors: number, fields: boolean, shadow?: DesignDocument) => {
  if (!fields) {
    const patch = moveOp(doc, round, editors);
    if (shadow) Object.assign(shadow.nodes, patch.nodes);
    return {patch};
  }
  const body = fieldsOp(doc, round, editors);
  if (shadow) for (const [id, f] of Object.entries(body.fields)) shadow.nodes[id] = {...shadow.nodes[id], ...f.set} as SceneNode;
  return body;
};

const identity = (): Promise<ClientIdentity> => {
  let seq = 0;
  return Promise.resolve({clientId: 'bench', get lastSeq() {
    return seq;
  }, set lastSeq(v: number) {
    seq = v;
  }, next: () => ++seq, atLeast: (v: number) => void (seq = Math.max(seq, v)), release() {}});
};

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** A session over a socket the bench feeds by hand. */
async function session(doc: DesignDocument, codec: WireCodec = jsonCodec) {
  let idleWork: (() => void) | null = null;
  const store = createDesignStore({doc, measurer, idle: work => {
    idleWork = work;
    return () => void (idleWork = null);
  }});
  let resolveRequest: ((value: unknown) => void) | null = null;
  const persistence = attachPersistence(store, {fileId: 'f', baseVersion: 1, events: null, timers: {setTimeout: () => 1, clearTimeout: () => {}}, onStatus: () => {}, onConflict: () => {}, request: () => new Promise(resolve => (resolveRequest = resolve)) as never});
  void resolveRequest;
  const sent: string[] = [];
  const server = {version: 1};
  let socket!: SocketLike;
  const live = startLiveSession({
    // Timers without a clock: every change applies as it arrives (no pacing), so each round measures one op's apply.
    fileId: 'f', store, persistence, version: 1, canEdit: true, network: null, queue: memoryQueue(), identity,
    timers: {setTimeout: (run: () => void, ms: number) => setTimeout(run, ms), clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)},
    callbacks: {onAccess: () => {}, onEnd: () => {}, onRename: () => {}},
    transport: wsTransport({codec, io: {
      session: async () => ({wsUrl: 'ws://bench/collab/f', ticket: 't'}),
      socket: () => {
        socket = {binaryType: 'arraybuffer', readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, close() {}, send(data) {
          const text = typeof data === 'string' ? data : wasmWire!.decode_frame(data);
          sent.push(text);
          // The server stores every op at the next version and acks it.
          const message = JSON.parse(text) as {t: string; seq?: number};
          if (message.t === 'op') queueMicrotask(() => socket.onmessage!({data: codec.wire === 'binary' ? frameData(binaryFrame(wasmWire!, {t: 'ack', seq: message.seq!, version: ++server.version})) : JSON.stringify({t: 'ack', seq: message.seq, version: ++server.version})}));
        }};
        queueMicrotask(() => {
          (socket as {readyState: number}).readyState = 1;
          socket.onopen?.({});
        });
        return socket;
      },
      open: async () => {
        throw new Error('no reload in the bench');
      },
      snapshot: async () => {
        throw new Error('no snapshot in the bench');
      },
      sleep: () => new Promise(() => {}),
      setInterval: () => 0,
      clearInterval: () => {},
    }}),
  });
  for (let i = 0; i < 5; i++) await tick();
  const frame = (message: ServerMessage) => socket.onmessage!({data: codec.wire === 'binary' ? frameData(binaryFrame(wasmWire!, message)) : JSON.stringify(message)});
  return {store, persistence, live, sent, frame, socket, server, idle: () => (idleWork as (() => void) | null)?.(), raw: (data: string | ArrayBuffer) => socket.onmessage!({data})};
}

/** A frame's bytes as the socket hands them over (an ArrayBuffer of their own). */
const frameData = (bytes: Uint8Array): ArrayBuffer => bytes.slice().buffer;

const welcome = (version: number): ServerMessage => ({t: 'welcome', connection: 'c1', version, role: 'editor', canEdit: true, user: 'me', name: 'Me', color: 0, peers: [], ackedSeq: 0});

async function w2(runs: number, fields = false) {
  const s = await session(f20k());
  s.frame(welcome(1));
  // Unsaved local edits of a few layers (the rebase has work to do).
  s.store.transact('Fill', tx => {
    for (const id of ['n3', 'n4', 'n5']) tx.update(id, {fills: [solid({r: 1, g: 0, b: 0})]});
  });
  const decode: number[] = [], whole: number[] = [];
  let bytes = 0;
  for (let round = 0; round < runs; round++) {
    // An unsaved local edit each round, so every remote op has a rebase to do (and autosave saves after it).
    s.store.transact('Fill', tx => tx.update('n3', {fills: [solid({r: 1, g: round / runs, b: 0})]}));
    await tick();
    s.idle();
    const text = JSON.stringify({t: 'change', version: ++s.server.version, by: 'c2', user: 'u2', ...changeOf(s.store.getState().doc, round, 0, fields)});
    bytes = text.length;
    let started = performance.now();
    jsonCodec.decode(text);
    decode.push(performance.now() - started);
    started = performance.now();
    s.raw(text);
    whole.push(performance.now() - started);
  }
  await tick();
  if (s.live.version() !== s.server.version) throw new Error(`ops not applied: ${s.live.version()} of ${s.server.version}`);
  if (s.store.getState().doc.nodes.n3.fills[0]?.type !== 'SOLID') throw new Error('the local edit was lost');
  s.live.stop();
  return {bytes, decodeMs: median(decode), applyMs: median(whole)};
}

async function w6(runs: number, editors = 0, fields = false) {
  const results: {bytes: number; decodeMs: number; applyMs: number; workerMs: number; mainMs: number; compositeBytes: number}[] = [];
  for (let run = 0; run < runs; run++) {
    const doc = f20k();
    const s = await session(doc);
    const shadow = structuredClone(doc);
    const catchUp = [];
    for (let i = 0; i < 1000; i++) catchUp.push({version: i + 2, by: 'c2', user: 'u2', ...changeOf(shadow, i, editors, fields, shadow)});
    // The server's welcome names its version; the catch-up follows in one `changes` frame (crates/protocol).
    const text = JSON.stringify({t: 'changes', changes: catchUp} satisfies ServerMessage);
    let started = performance.now();
    jsonCodec.decode(text);
    const decodeMs = performance.now() - started;
    // The worker's part: parse and compose; the main thread then takes the composite and applies it.
    started = performance.now();
    const composed = decodeComposed(text);
    const workerMs = performance.now() - started;
    const composite = JSON.stringify(composed);
    // What reaches the main thread is a structured clone of the composite (postMessage): its deserialisation, plus the
    // session's apply (the composite's text parse measured apart and taken out).
    const serialized = v8.serialize(composed);
    started = performance.now();
    v8.deserialize(serialized);
    const cloneMs = performance.now() - started;
    started = performance.now();
    JSON.parse(composite);
    const parseMs = performance.now() - started;
    s.idle();
    s.frame(welcome(1001));
    started = performance.now();
    s.raw(composite);
    const mainMs = cloneMs + Math.max(0, performance.now() - started - parseMs);
    if (s.live.version() !== 1001) throw new Error(`catch-up not applied: ${s.live.version()}`);
    // The same catch-up decoded and applied on the main thread, change by change (no worker).
    const t = await session(f20k());
    t.idle();
    t.frame(welcome(1001));
    started = performance.now();
    t.raw(text);
    const applyMs = performance.now() - started;
    results.push({bytes: text.length, decodeMs, applyMs, workerMs, mainMs, compositeBytes: composite.length});
    s.live.stop();
    t.live.stop();
  }
  const pick = (key: keyof (typeof results)[number]) => median(results.map(r => r[key]));
  return {bytes: results[0].bytes, decodeMs: pick('decodeMs'), applyMs: pick('applyMs'), workerMs: pick('workerMs'), mainMs: pick('mainMs'), compositeBytes: results[0].compositeBytes};
}

/** W2 on the binary wire: the same 20-layer change as a binary frame through binaryCodec. */
async function w2bin(wasm: WasmWire, runs: number, fields = false) {
  const s = await session(f20k(), binaryCodec(wasm));
  s.frame(welcome(1));
  s.store.transact('Fill', tx => {
    for (const id of ['n3', 'n4', 'n5']) tx.update(id, {fills: [solid({r: 1, g: 0, b: 0})]});
  });
  const decode: number[] = [], whole: number[] = [];
  let bytes = 0, jsonBytes = 0;
  for (let round = 0; round < runs; round++) {
    s.store.transact('Fill', tx => tx.update('n3', {fills: [solid({r: 1, g: round / runs, b: 0})]}));
    await tick();
    s.idle();
    const message: ServerMessage = {t: 'change', version: ++s.server.version, by: 'c2', user: 'u2', ...changeOf(s.store.getState().doc, round, 0, fields)};
    const frame = binaryFrame(wasm, message);
    bytes = frame.length;
    jsonBytes = JSON.stringify(message).length;
    let started = performance.now();
    JSON.parse(wasm.decode_frame(frame));
    decode.push(performance.now() - started);
    const data = frameData(frame);
    started = performance.now();
    s.raw(data);
    whole.push(performance.now() - started);
  }
  await tick();
  if (s.live.version() !== s.server.version) throw new Error(`ops not applied: ${s.live.version()} of ${s.server.version}`);
  s.live.stop();
  return {bytes, jsonBytes, decodeMs: median(decode), applyMs: median(whole)};
}

/** W6 on the binary wire: the 1 000-op catch-up as one 0xB3 frame. */
async function w6bin(wasm: WasmWire, runs: number, editors = 0, fields = false) {
  const results: {bytes: number; decodeMs: number; wasmMs: number; workerMs: number; applyMs: number; mainMs: number; compositeBytes: number}[] = [];
  for (let run = 0; run < runs; run++) {
    const doc = f20k();
    const shadow = structuredClone(doc);
    const catchUp = [];
    for (let i = 0; i < 1000; i++) catchUp.push({version: i + 2, by: 'c2', user: 'u2', ...changeOf(shadow, i, editors, fields, shadow)});
    const frame = binaryFrame(wasm, {t: 'changes', changes: catchUp});
    let started = performance.now();
    const text = wasm.decode_frame(frame);
    const wasmMs = performance.now() - started;
    JSON.parse(text);
    const decodeMs = performance.now() - started;
    // The worker's part: the catch-up composed inside WASM, then parsed (decode-worker.ts).
    started = performance.now();
    const composed = decodeComposed(wasm.decode_frame_composed ? wasm.decode_frame_composed(frame) : wasm.decode_frame(frame));
    const workerMs = performance.now() - started;
    // The main thread's share: the structured clone of the composite and the session's apply.
    const serialized = v8.serialize(composed);
    started = performance.now();
    v8.deserialize(serialized);
    const cloneMs = performance.now() - started;
    const composite = JSON.stringify(composed);
    started = performance.now();
    JSON.parse(composite);
    const parseMs = performance.now() - started;
    const w = await session(structuredClone(doc));
    w.idle();
    w.frame(welcome(1001));
    started = performance.now();
    w.raw(composite);
    const mainMs = cloneMs + Math.max(0, performance.now() - started - parseMs);
    if (w.live.version() !== 1001) throw new Error(`composite not applied: ${w.live.version()}`);
    w.live.stop();
    const t = await session(doc, binaryCodec(wasm));
    t.idle();
    t.frame(welcome(1001));
    const data = frameData(frame);
    started = performance.now();
    t.raw(data);
    const applyMs = performance.now() - started;
    if (t.live.version() !== 1001) throw new Error(`catch-up not applied: ${t.live.version()}`);
    t.live.stop();
    results.push({bytes: frame.length, decodeMs, wasmMs, workerMs, applyMs, mainMs, compositeBytes: composite.length});
  }
  const pick = (key: keyof (typeof results)[number]) => median(results.map(r => r[key]));
  return {bytes: results[0].bytes, decodeMs: pick('decodeMs'), wasmMs: pick('wasmMs'), workerMs: pick('workerMs'), applyMs: pick('applyMs'), mainMs: pick('mainMs'), compositeBytes: results[0].compositeBytes};
}

async function run() {
  const json = process.argv.includes('--json');
  const a = await w2(process.argv.includes('--w2-only') ? 2000 : 30);
  if (process.argv.includes('--w2-only')) return console.log('W2-json', JSON.stringify(a));
  const b = await w6(3);
  const c = await w6(3, 5);
  const rows: Record<string, object> = {
    'W2-json': {opBytes: a.bytes, decodeMs: +a.decodeMs.toFixed(3), decodeAndApplyMs: +a.applyMs.toFixed(3), target: '≤ 0.15 ms decode+handoff (WASM), C6 apply'},
    W6: {catchUpBytes: b.bytes, decodeMs: +b.decodeMs.toFixed(1), decodeAndApplyMs: +b.applyMs.toFixed(1), target: '≤ 3 MB / ≤ 40 ms decode'},
    'W6-worker': {workerMs: +b.workerMs.toFixed(1), compositeBytes: b.compositeBytes, mainThreadMs: +b.mainMs.toFixed(1), note: 'parse + compose in the worker; the main thread clones and applies the composite'},
    'W6-5ed': {catchUpBytes: c.bytes, decodeAndApplyMs: +c.applyMs.toFixed(1), workerMs: +c.workerMs.toFixed(1), compositeBytes: c.compositeBytes, mainThreadMs: +c.mainMs.toFixed(1), note: '5 editors each moving their own 20 layers (M8): the composite is 100 entries'},
  };
  if (wasmWire) {
    const d = await w2bin(wasmWire, 30);
    const e = await w6bin(wasmWire, 3);
    const f = await w6bin(wasmWire, 3, 5);
    Object.assign(rows, {
      'W2-bin': {opBytes: d.bytes, jsonBytes: d.jsonBytes, decodeMs: +d.decodeMs.toFixed(3), decodeAndApplyMs: +d.applyMs.toFixed(3), note: 'decode_frame + JSON.parse; then the session and store as W2-json'},
      'W6-bin': {catchUpBytes: e.bytes, decodeMs: +e.decodeMs.toFixed(1), wasmDecodeMs: +e.wasmMs.toFixed(1), decodeAndApplyMs: +e.applyMs.toFixed(1), workerMs: +e.workerMs.toFixed(1), compositeBytes: e.compositeBytes, mainThreadMs: +e.mainMs.toFixed(1), target: '≤ 3 MB / ≤ 40 ms decode', note: 'decodeMs: the whole frame as text + JSON.parse (main thread); workerMs: composed inside WASM + JSON.parse'},
      'W6-bin-5ed': {catchUpBytes: f.bytes, workerMs: +f.workerMs.toFixed(1), compositeBytes: f.compositeBytes, mainThreadMs: +f.mainMs.toFixed(1), note: 'M8\'s shape on the binary wire, composed inside WASM in the worker'},
    });
  }
  // Protocol 2's field-level changes (lane W): the same ops as only the fields that changed.
  const af = await w2(30, true);
  const bf = await w6(3, 0, true);
  const cf = await w6(3, 5, true);
  Object.assign(rows, {
    'W2-json-fields': {opBytes: af.bytes, decodeMs: +af.decodeMs.toFixed(3), decodeAndApplyMs: +af.applyMs.toFixed(3), target: '≤ 0.15 ms decode + apply (ceiling 0.5)'},
    'W6-fields': {catchUpBytes: bf.bytes, decodeMs: +bf.decodeMs.toFixed(1), decodeAndApplyMs: +bf.applyMs.toFixed(1), workerMs: +bf.workerMs.toFixed(1), compositeBytes: bf.compositeBytes, mainThreadMs: +bf.mainMs.toFixed(1)},
    'W6-5ed-fields': {catchUpBytes: cf.bytes, decodeAndApplyMs: +cf.applyMs.toFixed(1), workerMs: +cf.workerMs.toFixed(1), compositeBytes: cf.compositeBytes, mainThreadMs: +cf.mainMs.toFixed(1)},
  });
  if (wasmWire) {
    const df = await w2bin(wasmWire, 30, true);
    const ef = await w6bin(wasmWire, 3, 0, true);
    const ff = await w6bin(wasmWire, 3, 5, true);
    Object.assign(rows, {
      'W2-bin-fields': {opBytes: df.bytes, jsonBytes: df.jsonBytes, decodeMs: +df.decodeMs.toFixed(3), decodeAndApplyMs: +df.applyMs.toFixed(3)},
      'W6-bin-fields': {catchUpBytes: ef.bytes, decodeMs: +ef.decodeMs.toFixed(1), wasmDecodeMs: +ef.wasmMs.toFixed(1), decodeAndApplyMs: +ef.applyMs.toFixed(1), workerMs: +ef.workerMs.toFixed(1), compositeBytes: ef.compositeBytes, mainThreadMs: +ef.mainMs.toFixed(1)},
      'W6-bin-5ed-fields': {catchUpBytes: ff.bytes, workerMs: +ff.workerMs.toFixed(1), compositeBytes: ff.compositeBytes, mainThreadMs: +ff.mainMs.toFixed(1)},
    });
  }
  if (json) console.log(JSON.stringify(rows));
  else for (const [name, row] of Object.entries(rows)) console.log(name.padEnd(18), JSON.stringify(row));
}

void run();
