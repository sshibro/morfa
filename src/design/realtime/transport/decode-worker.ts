import {decodeComposed, isBinaryFrame} from './frame-decoder';
import type {WasmWire} from './ws';

// The socket's large frames, decoded off the main thread (frame-decoder.ts). One message in: {id, data} (the frame as
// text, or its bytes: a binary-wire frame by its first byte, else UTF-8 JSON); one out: {id, message}, or {id, error,
// data} with the frame handed back so the main thread can decode it itself.

const textDecoder = new TextDecoder();

// The engine's WASM glue, bundled into the worker (an eager glob: a worker is one file, Vite's worker format allows no
// chunks); the .wasm itself is fetched and instantiated on the first binary frame. Without the build the glob is empty
// and binary frames go back to the main thread.
const builds = import.meta.glob<{default: (input?: unknown) => Promise<unknown>} & WasmWire>('../../wasm/morfa_wasm.js', {eager: true});
let loading: Promise<WasmWire | null> | null = null;
const loadWasmWire = () =>
  (loading ??= (async () => {
    const build = builds['../../wasm/morfa_wasm.js'];
    if (!build) return null;
    await build.default();
    return build;
  })().catch(() => null));

type Scope = {onmessage: ((event: MessageEvent<{id: number; data: string | ArrayBuffer}>) => void) | null; postMessage(message: unknown, transfer?: Transferable[]): void};
const scope = self as unknown as Scope;

/** Frames are answered in the order they came, the WASM loading behind the first binary one. */
let order: Promise<void> = Promise.resolve();

scope.onmessage = event => {
  const {id, data} = event.data;
  order = order.then(async () => {
    try {
      let text: string;
      if (typeof data === 'string') text = data;
      else if (isBinaryFrame(data)) {
        const wasm = await loadWasmWire();
        if (!wasm) throw new Error('the binary wire’s WASM did not load in the worker');
        // A catch-up composed inside WASM: only the composite becomes text (decodeComposed then has nothing to compose).
        const bytes = new Uint8Array(data);
        text = wasm.decode_frame_composed ? wasm.decode_frame_composed(bytes) : wasm.decode_frame(bytes);
      } else text = textDecoder.decode(data);
      scope.postMessage({id, message: decodeComposed(text)});
    } catch (error) {
      scope.postMessage({id, error: String(error), data}, typeof data === 'string' ? [] : [data]);
    }
  });
};
