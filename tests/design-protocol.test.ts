import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {generate, OUTPUT_PATH, SCHEMA_PATH} from '../scripts/protocol/gen-ts';
import {CLIENT_TAGS, PROTOCOL_LIMITS, SERVER_TAGS, type ServerMessage} from '../shared/design/protocol';
import {createRequire} from 'node:module';
import {binaryCodec, DecodeFailed, dispatchMessage, jsonCodec, socketUrl, wsTransport, type SocketLike, type WasmWire} from '../src/design/realtime/transport/ws';
import {composeChanges, decodeComposed, isBinaryFrame, LARGE_FRAME} from '../src/design/realtime/transport/frame-decoder';
import type {LiveHandlers} from '../src/design/realtime/transport/types';
import {collabMode, pickTransport} from '../src/design/realtime/transport/pick';

// The socket protocol on the client's side (crates/protocol/schema.json, lane B1): the TypeScript types are generated
// from the schema and kept current, every server message reaches the session's handlers, the codecs, and the switch.

test('shared/design/protocol.ts is what crates/protocol/schema.json generates', () => {
  assert.equal(fs.readFileSync(OUTPUT_PATH, 'utf8'), generate(fs.readFileSync(SCHEMA_PATH, 'utf8')), 'run: tsx scripts/protocol/gen-ts.ts');
  assert.deepEqual([...CLIENT_TAGS], ['hello', 'op', 'presence', 'pull', 'ping']);
  assert.ok(SERVER_TAGS.includes('welcome') && SERVER_TAGS.includes('ack'));
  assert.equal(PROTOCOL_LIMITS.presenceFlushMs, 33, '30 Hz presence');
});

const recorder = () => {
  const calls: [string, unknown][] = [];
  const handlers = new Proxy({} as LiveHandlers, {get: (_target, name) => (...args: unknown[]) => calls.push([String(name), args.length > 1 ? args : args[0]])});
  return {calls, handlers};
};

test('every server message reaches the handlers; SSE names for the session\'s listeners', () => {
  const peer = {connection: 'c2', user: 'u2', name: 'B', color: 1, role: 'editor' as const, cursor: null, page: null, selection: [], selectionCount: 0, viewport: null, editing: null};
  const messages: ServerMessage[] = [
    {t: 'welcome', connection: 'c1', version: 7, role: 'editor', canEdit: true, user: 'u', name: 'A', color: 0, peers: [peer], ackedSeq: 3},
    {t: 'ack', seq: 4, version: 8},
    {t: 'refused', seq: 5, code: 'version_conflict', currentVersion: 9},
    {t: 'change', version: 9, by: 'c2', user: 'u2', patch: {}},
    {t: 'changes', changes: [{version: 10, by: null, user: 'api', patch: {}}, {version: 11, by: null, user: 'api', patch: {}}]},
    {t: 'catchUp', from: 12, to: 20},
    {t: 'presence', peers: [peer]},
    {t: 'leave', connection: 'c2'},
    {t: 'pong'},
    {t: 'access', role: 'viewer', canEdit: false},
    {t: 'file', name: 'New'},
    {t: 'comments'},
    {t: 'meeting', revision: 6, user: 'u'},
    {t: 'rollback', version: 10},
    {t: 'resync', version: 30, snapshotUrl: '/s/30'},
    {t: 'document', version: 31, document: {pages: [], nodes: {}} as never},
    {t: 'error', code: 'bad_message'},
    {t: 'bye', reason: 'trashed'},
  ];
  assert.deepEqual(new Set(messages.map(message => message.t)), new Set(SERVER_TAGS), 'the test covers every tag');
  const {calls, handlers} = recorder();
  for (const message of messages) dispatchMessage(jsonCodec.decode(JSON.stringify(message)), handlers);
  const names = calls.map(([name]) => name);
  assert.deepEqual(names, ['hello', 'raw', 'ack', 'refused', 'change', 'raw', 'changes', 'raw', 'raw', 'catchUp', 'presence', 'raw', 'leave', 'raw', 'access', 'raw', 'file', 'raw', 'comments', 'raw', 'raw', 'rollback', 'resync', 'raw', 'resync', 'bye', 'raw']);
  const hello = calls[0][1] as {token: string; ackedSeq: number};
  assert.equal(hello.token, 'c1');
  assert.equal(hello.ackedSeq, 3);
  assert.deepEqual(calls[1], ['raw', ['hello', hello]]);
  // comments and meeting reach the listeners under the SSE names, with the SSE events' data.
  assert.deepEqual(
    calls.filter(([name, args]) => name === 'raw' && Array.isArray(args) && (args[0] === 'comments' || args[0] === 'meeting')),
    [['raw', ['comments', {}]], ['raw', ['meeting', {revision: 6, user: 'u'}]]],
  );
});

test('codecs: JSON text frames, and the binary wire goes through the WASM exports only', () => {
  const op = {t: 'op' as const, seq: 1, baseVersion: 3, patch: {nodes: {}}};
  assert.equal(jsonCodec.encode(op), JSON.stringify(op));
  assert.deepEqual(jsonCodec.decode(new TextEncoder().encode('{"t":"pong"}')), {t: 'pong'});
  const seen: string[] = [];
  const codec = binaryCodec({
    encode_frame: json => {
      seen.push('encode:' + json);
      return new Uint8Array([1, 2, 3]);
    },
    decode_frame: bytes => {
      seen.push('decode:' + bytes.length);
      return '{"t":"ack","seq":1,"version":4}';
    },
  });
  assert.equal(codec.wire, 'binary');
  assert.deepEqual(codec.encode(op), new Uint8Array([1, 2, 3]));
  assert.deepEqual(codec.decode(new Uint8Array([9, 9]).buffer), {t: 'ack', seq: 1, version: 4});
  assert.deepEqual(seen, ['encode:' + JSON.stringify(op), 'decode:2']);
});

/** crates/wasm's Node build with the binary wire's exports; null when not built (those tests are skipped). */
const wasmWire: WasmWire | null = (() => {
  try {
    const wasm = createRequire(import.meta.url)('../server/design/wasm') as Partial<WasmWire>;
    return typeof wasm.decode_frame === 'function' && typeof wasm.encode_frame === 'function' ? (wasm as WasmWire) : null;
  } catch {
    return null;
  }
})();

test('the binary wire through crates/wasm: every client message round-trips, frames are binary and smaller', {skip: wasmWire ? false : 'server/design/wasm without decode_frame (scripts/wasm-build.sh)'}, () => {
  const wasm = wasmWire!;
  const codec = binaryCodec(wasm);
  const patch = {nodes: Object.fromEntries(Array.from({length: 20}, (_, i) => [`r${i}`, {x: i * 10.5, y: -i, name: `Layer ${i}`, fills: [{type: 'SOLID', color: {r: 0.1, g: 0.2, b: 0.3, a: 1}}]}]))};
  const messages = [
    {t: 'hello', ticket: 'dev.x', clientId: 'c1', since: 0, lastSeq: 0, protocol: 1},
    {t: 'op', seq: 4, baseVersion: 9, patch},
    {t: 'presence', cursor: {x: 1.25, y: -3}, selection: ['a', 'b']},
    {t: 'pull', since: 3},
    {t: 'ping'},
  ];
  for (const message of messages) {
    const frame = codec.encode(message as never) as Uint8Array;
    assert.ok(frame instanceof Uint8Array && isBinaryFrame(frame), `${message.t}: a binary frame`);
    // What the JSON wire would deliver (JSON.stringify writes -0 as 0; so does the binary wire).
    const json = JSON.parse(JSON.stringify(message));
    assert.equal(wasm.decode_frame(frame), JSON.stringify(message), `${message.t}: the JSON wire's text`);
    assert.deepEqual(codec.decode(frame.slice().buffer), json, `${message.t} through the codec`);
  }
  const op = codec.encode(messages[1] as never) as Uint8Array;
  assert.ok(op.length < JSON.stringify(messages[1]).length, `a 20-layer op is smaller in binary (${op.length} B of ${JSON.stringify(messages[1]).length})`);
  assert.throws(() => wasm.decode_frame(new Uint8Array([0xb1, 0xff, 0xff])), /decode_frame/);
  assert.throws(() => wasm.encode_frame('{"t":'), /encode_frame/);
  assert.equal(isBinaryFrame(new TextEncoder().encode('{"t":"pong"}')), false);
});

test('a catch-up composed inside WASM is what composeChanges makes of it', {skip: wasmWire?.decode_frame_composed ? false : 'server/design/wasm without decode_frame_composed (scripts/wasm-build.sh)'}, () => {
  const wasm = wasmWire!;
  /** A changes frame (0xB3) of these change messages, as crates/protocol batches them. */
  const frameOf = (changes: object[]) => {
    const parts = changes.map(change => wasm.encode_frame(JSON.stringify({t: 'change', ...change})));
    const out: number[] = [0xb3];
    const varint = (n: number) => {
      for (; n >= 0x80; n >>>= 7) out.push((n & 0x7f) | 0x80);
      out.push(n);
    };
    varint(parts.length);
    for (const part of parts) {
      varint(part.length);
      out.push(...part);
    }
    return new Uint8Array(out);
  };
  let state = 11;
  const rnd = () => ((state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let round = 0; round < 50; round++) {
    const changes: object[] = [];
    const count = 1 + Math.floor(rnd() * 12);
    for (let i = 0; i < count; i++) {
      const patch: Record<string, unknown> = {};
      for (const table of ['nodes', 'variables', 'styles', 'pages']) {
        if (rnd() < 0.4) continue;
        if (table === 'pages') patch.pages = Array.from({length: 1 + Math.floor(rnd() * 3)}, (_, k) => `p${k}`);
        else if (rnd() < 0.1) patch[table] = null;
        else patch[table] = Object.fromEntries(Array.from({length: Math.floor(rnd() * 4)}, () => [`${table[0]}${Math.floor(rnd() * 6)}`, rnd() < 0.2 ? null : {x: Math.floor(rnd() * 100), y: rnd(), name: 'Layer "' + i + '"'}]));
      }
      // Now and then a gap in the versions (not composed: the frame decodes as it is).
      const version = 10 + i + (round % 7 === 3 && i === count - 1 ? 1 : 0);
      changes.push({version, by: 'c' + i, user: 'u' + i, patch, ...(rnd() < 0.3 ? {client: 'me', seq: i + 1} : {})});
    }
    const frame = frameOf(changes);
    const expected = decodeComposed(wasm.decode_frame(frame));
    assert.deepEqual(JSON.parse(wasm.decode_frame_composed!(frame)), JSON.parse(JSON.stringify(expected)), `round ${round}`);
  }
  // Anything but a changes frame decodes as decode_frame does.
  const pong = wasm.encode_frame('{"t":"pong"}');
  assert.equal(wasm.decode_frame_composed!(pong), '{"t":"pong"}');
  assert.throws(() => wasm.decode_frame_composed!(new Uint8Array([0xb3, 2, 9])), /decode_frame_composed/);
});

test('field-level changes (protocol 2) cross the binary wire and compose as on the JSON wire', {skip: wasmWire?.decode_frame_composed ? false : 'server/design/wasm without decode_frame_composed (scripts/wasm-build.sh)'}, () => {
  const wasm = wasmWire!;
  const changes = [
    {version: 4, by: 'c1', user: 'u1', patch: {nodes: {b: {x: 1, name: 'b'}}}, fields: {a: {set: {x: 2.5, fills: [{type: 'SOLID'}]}, unset: ['cornerRadius']}}},
    {version: 5, by: 'c2', user: 'u2', patch: {}, fields: {a: {set: {y: -1}}, b: {set: {name: 'B'}, unset: ['x']}}},
  ];
  const parts = changes.map(change => wasm.encode_frame(JSON.stringify({t: 'change', ...change})));
  for (const [i, part] of parts.entries()) assert.equal(wasm.decode_frame(part), JSON.stringify({t: 'change', ...changes[i]}));
  const out: number[] = [0xb3];
  const varint = (n: number) => {
    for (; n >= 0x80; n >>>= 7) out.push((n & 0x7f) | 0x80);
    out.push(n);
  };
  varint(parts.length);
  for (const part of parts) {
    varint(part.length);
    out.push(...part);
  }
  const frame = new Uint8Array(out);
  const composed = decodeComposed(wasm.decode_frame_composed!(frame));
  assert.deepEqual(composed, decodeComposed(JSON.stringify({t: 'changes', changes})));
  assert.ok(composed.t === 'changes');
  assert.deepEqual(composed.changes[0].fields, {a: {set: {x: 2.5, fills: [{type: 'SOLID'}], y: -1}, unset: ['cornerRadius']}});
  assert.deepEqual(composed.changes[0].patch.nodes, {b: {name: 'B'}});
});

test('socket URLs name the wire; http(s) becomes ws(s)', () => {
  assert.equal(socketUrl('https://node-1.morfa.example/collab/f1', 'json'), 'wss://node-1.morfa.example/collab/f1?wire=json');
  assert.equal(socketUrl('ws://127.0.0.1:9/collab/f1?x=1', 'binary'), 'ws://127.0.0.1:9/collab/f1?x=1&wire=bin');
});

test('DESIGN_COLLAB from /api/config picks the transport; the socket only for rust', async () => {
  assert.equal(collabMode({}), 'legacy');
  assert.equal(collabMode({designCollab: 'shadow'}), 'shadow');
  assert.equal(collabMode({designCollab: 'rust'}), 'rust');
  assert.equal(collabMode({designCollab: 'nonsense'}), 'legacy');
  assert.equal((await pickTransport(async () => ({}))).kind, 'sse');
  // The file's own mode wins over the account's; without it (an older api) the account's decides.
  assert.equal((await pickTransport(async () => ({designCollab: 'legacy'}), 'f1', async () => ({designCollab: 'rust'}))).kind, 'ws');
  assert.equal((await pickTransport(async () => ({designCollab: 'rust'}), 'f1', async () => ({designCollab: 'legacy'}))).kind, 'sse');
  assert.equal((await pickTransport(async () => ({designCollab: 'rust'}), 'f1', async () => null)).kind, 'ws');
  assert.equal((await pickTransport(async () => ({designCollab: 'shadow'}))).kind, 'sse');
  const rust = await pickTransport(async () => ({designCollab: 'rust'}));
  assert.equal(rust.kind, 'ws');
  assert.equal(rust.sendsOps, true);
  assert.equal(rust.presenceMs, 33);
});

test('a large catch-up is composed in the worker; the frames behind it keep their order', async () => {
  const change = (version: number, x: number, extra: object = {}) => ({version, by: 'c2', user: 'u2', patch: {nodes: {a: {id: 'a', x} as never, [`n${version}`]: {id: `n${version}`} as never}}, ...extra});
  const composite = composeChanges([change(2, 1), change(3, 2, {client: 'me', seq: 7}), change(4, 3)])!;
  assert.equal(composite.first, 2);
  assert.equal(composite.version, 4);
  assert.deepEqual(Object.keys(composite.patch.nodes!).sort(), ['a', 'n2', 'n3', 'n4']);
  assert.equal((composite.patch.nodes!.a as unknown as {x: number}).x, 3, 'the latest value of each entry');
  assert.deepEqual(composite.ops, [{client: 'me', seq: 7, version: 3}]);
  assert.equal(composeChanges([change(2, 1), change(4, 1)]), null, 'only consecutive versions compose');

  // Over a socket: a catch-up bigger than LARGE_FRAME goes to the decoder, a change right behind it waits for it.
  const welcome = {t: 'welcome', connection: 'c1', version: 4, role: 'editor', canEdit: true, user: 'u', name: 'A', color: 0, peers: []};
  const big = {t: 'changes', changes: [change(2, 1), change(3, 2), change(4, 3)], pad: 'x'.repeat(LARGE_FRAME)};
  let socket!: SocketLike;
  const decoded: number[] = [];
  const transport = wsTransport({io: {
    session: async () => ({wsUrl: 'ws://t/collab/f', ticket: 't'}),
    socket: () => {
      socket = {binaryType: '', readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: () => queueMicrotask(() => socket.onclose?.({code: 1000, reason: ''}))};
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    },
    open: async () => assert.fail('no reload'),
    snapshot: async () => assert.fail('no snapshot'),
    sleep: async () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    decoder: () => ({
      decode: data => new Promise(resolve => setTimeout(() => {
        decoded.push(String(data).length);
        resolve(decodeComposed(String(data)));
      }, 5)),
      close() {},
    }),
  }});
  const {calls, handlers} = recorder();
  const controller = new AbortController();
  const done = transport.connect({fileId: 'f', since: 1, clientId: 'me', lastSeq: 0, signal: controller.signal, headers: {}}, handlers);
  await new Promise(resolve => setTimeout(resolve, 0));
  socket.onmessage!({data: JSON.stringify(welcome)});
  socket.onmessage!({data: JSON.stringify(big)});
  socket.onmessage!({data: JSON.stringify({t: 'change', ...change(5, 9)})});
  await new Promise(resolve => setTimeout(resolve, 30));
  const order = calls.filter(([name]) => name === 'hello' || name === 'change' || name === 'changes').flatMap(([name, value]) => name === 'hello' ? ['hello'] : (name === 'changes' ? (value as {first?: number; version: number}[]) : [value as {first?: number; version: number}]).map(c => `change:${c.first ?? ''}-${c.version}`));
  assert.deepEqual(order, ['hello', 'change:2-4', 'change:-5'], 'one composite for the catch-up; the change behind it waited');
  assert.equal(decoded.length, 1);
  controller.abort();
  await done;
});

test('a large frame the worker could not decode comes back and is decoded on the main thread, in order', async () => {
  const welcome = {t: 'welcome', connection: 'c1', version: 4, role: 'editor', canEdit: true, user: 'u', name: 'A', color: 0, peers: []};
  const change = (version: number) => ({version, by: 'c2', user: 'u2', patch: {nodes: {}}});
  const big = new TextEncoder().encode(JSON.stringify({t: 'changes', changes: [change(5), change(6)], pad: 'x'.repeat(LARGE_FRAME)})).buffer;
  let socket!: SocketLike;
  const transport = wsTransport({io: {
    session: async () => ({wsUrl: 'ws://t/collab/f', ticket: 't'}),
    socket: () => {
      socket = {binaryType: '', readyState: 1, onopen: null, onmessage: null, onclose: null, onerror: null, send: () => {}, close: () => queueMicrotask(() => socket.onclose?.({code: 1000, reason: ''}))};
      queueMicrotask(() => socket.onopen?.({}));
      return socket;
    },
    open: async () => assert.fail('no reload'),
    snapshot: async () => assert.fail('no snapshot'),
    sleep: async () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    // The worker's answer when the WASM did not load in it: the frame's bytes handed back.
    decoder: () => ({decode: data => new Promise((_, reject) => setTimeout(() => reject(new DecodeFailed('no wasm', data)), 5)), close() {}}),
  }});
  const {calls, handlers} = recorder();
  const controller = new AbortController();
  const done = transport.connect({fileId: 'f', since: 4, clientId: 'me', lastSeq: 0, signal: controller.signal, headers: {}}, handlers);
  await new Promise(resolve => setTimeout(resolve, 0));
  socket.onmessage!({data: JSON.stringify(welcome)});
  socket.onmessage!({data: big});
  socket.onmessage!({data: JSON.stringify({t: 'change', ...change(7)})});
  await new Promise(resolve => setTimeout(resolve, 30));
  const versions = calls.filter(([name]) => name === 'change' || name === 'changes').flatMap(([name, value]) => (name === 'changes' ? (value as {version: number}[]) : [value as {version: number}]).map(c => c.version));
  assert.deepEqual(versions, [5, 6, 7], 'the catch-up was not lost and the change behind it waited');
  controller.abort();
  await done;
});

test('a socket that fails before it opens ends the attempt even when no close follows (Node closes it while connecting)', async () => {
  let closed = 0;
  const transport = wsTransport({io: {
    session: async () => ({wsUrl: 'ws://t/collab/f', ticket: 't'}),
    socket: () => {
      const socket: SocketLike = {binaryType: '', readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null, send: () => assert.fail('nothing to send'), close: () => void closed++};
      queueMicrotask(() => socket.onerror?.({}));
      return socket;
    },
    open: async () => assert.fail('no reload'),
    snapshot: async () => assert.fail('no snapshot'),
    sleep: async () => {},
    setInterval: () => 0,
    clearInterval: () => {},
  }});
  const {handlers} = recorder();
  const controller = new AbortController();
  await assert.rejects(transport.connect({fileId: 'f', since: 0, clientId: 'me', lastSeq: 0, signal: controller.signal, headers: {}}, handlers), /before it opened/);
  assert.equal(closed, 1, 'the failed socket is closed');
});
