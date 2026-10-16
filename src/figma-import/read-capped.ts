/** The answer is bigger than the reader agreed to hold. */
export class TooLargeError extends Error {
  constructor() {
    super('The response is too large.');
    this.name = 'TooLargeError';
  }
}

function join(chunks: Uint8Array[], size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * The body as bytes, refused before reading when Content-Length is over `cap`
 * and cut off while streaming when a body without one grows past it.
 */
export async function readCappedBytes(response: Response, cap: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > cap) {
    response.body?.cancel().catch(() => undefined);
    throw new TooLargeError();
  }
  if (!response.body) return new Uint8Array(await response.arrayBuffer());
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const {value, done} = await reader.read();
    if (done) return join(chunks, size);
    size += value.byteLength;
    if (size > cap) {
      reader.cancel().catch(() => undefined);
      throw new TooLargeError();
    }
    chunks.push(value);
  }
}

/** The body as UTF-8 text under the same cap. */
export async function readCapped(response: Response, cap: number): Promise<string> {
  return new TextDecoder().decode(await readCappedBytes(response, cap));
}
