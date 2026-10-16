// A reader for kiwi, the binary format of Figma's .fig files (github.com/evanw/kiwi, MIT). A .fig carries its
// own schema next to the data, so nothing here knows Figma's fields: the schema is decoded first and then
// drives the decoding of the message. Read only; unknown message fields stop the read, since kiwi gives
// no way to skip them.

export type KiwiField = {name: string; type: string; isArray: boolean; value: number};
export type KiwiDefinition = {name: string; kind: 'ENUM' | 'STRUCT' | 'MESSAGE'; fields: KiwiField[]};
export type KiwiSchema = {definitions: KiwiDefinition[]; byName: Map<string, KiwiDefinition>};

export class KiwiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KiwiError';
  }
}

const NATIVE = ['bool', 'byte', 'int', 'uint', 'float', 'string', 'int64', 'uint64'];
const KINDS = ['ENUM', 'STRUCT', 'MESSAGE'] as const;
const MAX_DEPTH = 256;

const scratch = new DataView(new ArrayBuffer(4));
const utf8 = new TextDecoder();

class Reader {
  index = 0;
  constructor(readonly data: Uint8Array) {}

  byte(): number {
    if (this.index >= this.data.length) throw new KiwiError('The .fig file ends unexpectedly.');
    return this.data[this.index++];
  }

  bytes(): Uint8Array {
    const length = this.uint();
    const end = this.index + length;
    if (end > this.data.length) throw new KiwiError('The .fig file ends unexpectedly.');
    const out = this.data.subarray(this.index, end);
    this.index = end;
    return out;
  }

  uint(): number {
    let value = 0, shift = 0, byte: number;
    do {
      byte = this.byte();
      value |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128 && shift < 35);
    return value >>> 0;
  }

  int(): number {
    const value = this.uint() | 0;
    return value & 1 ? ~(value >>> 1) : value >>> 1;
  }

  float(): number {
    const first = this.byte();
    // Zero takes one byte.
    if (first === 0) return 0;
    if (this.index + 3 > this.data.length) throw new KiwiError('The .fig file ends unexpectedly.');
    let bits = first | (this.data[this.index] << 8) | (this.data[this.index + 1] << 16) | (this.data[this.index + 2] << 24);
    this.index += 3;
    // The exponent is stored first; put it back in place.
    bits = (bits << 23) | (bits >>> 9);
    scratch.setInt32(0, bits, true);
    return scratch.getFloat32(0, true);
  }

  string(): string {
    const start = this.index;
    const end = this.data.indexOf(0, start);
    if (end < 0) throw new KiwiError('The .fig file ends unexpectedly.');
    this.index = end + 1;
    return utf8.decode(this.data.subarray(start, end));
  }

  uint64(): bigint {
    let value = 0n, shift = 0n, byte: number;
    while ((byte = this.byte()) & 128 && shift < 56n) {
      value |= BigInt(byte & 127) << shift;
      shift += 7n;
    }
    return value | (BigInt(byte) << shift);
  }

  int64(): bigint {
    const value = this.uint64();
    return value & 1n ? ~(value >> 1n) : value >> 1n;
  }
}

export function decodeSchema(data: Uint8Array): KiwiSchema {
  const reader = new Reader(data);
  const definitions: KiwiDefinition[] = [];
  const types: number[][] = [];
  const count = reader.uint();
  for (let i = 0; i < count; i++) {
    const name = reader.string();
    const kind = KINDS[reader.byte()];
    if (!kind) throw new KiwiError('The .fig file schema cannot be read.');
    const fields: KiwiField[] = [];
    const fieldTypes: number[] = [];
    const fieldCount = reader.uint();
    for (let j = 0; j < fieldCount; j++) {
      const fieldName = reader.string();
      fieldTypes.push(reader.int());
      const isArray = !!(reader.byte() & 1);
      fields.push({name: fieldName, type: '', isArray, value: reader.uint()});
    }
    definitions.push({name, kind, fields});
    types.push(fieldTypes);
  }
  definitions.forEach((definition, i) => definition.fields.forEach((field, j) => {
    const type = types[i][j];
    const resolved = type < 0 ? NATIVE[~type] : definitions[type]?.name;
    if (!resolved) throw new KiwiError('The .fig file schema cannot be read.');
    field.type = resolved;
  }));
  return {definitions, byName: new Map(definitions.map(definition => [definition.name, definition]))};
}

type Decoder = (reader: Reader, depth: number) => unknown;

/** Decodes `data` as the schema's `root` message (Figma's is "Message"). */
export function decodeMessage(schema: KiwiSchema, data: Uint8Array, root = 'Message'): Record<string, unknown> {
  const compiled = new Map<string, Decoder>();
  const decoderOf = (type: string): Decoder => {
    const known = compiled.get(type);
    if (known) return known;
    const definition = schema.byName.get(type);
    if (!definition) throw new KiwiError(`The .fig file schema has no type ${type}.`);
    let decoder: Decoder;
    if (definition.kind === 'ENUM') {
      const names = new Map(definition.fields.map(field => [field.value, field.name]));
      // An unknown value reads as its number: newer files may add cases.
      decoder = reader => {
        const value = reader.uint();
        return names.get(value) ?? value;
      };
    } else if (definition.kind === 'STRUCT') {
      const fields = definition.fields.map(field => ({name: field.name, read: fieldReader(field)}));
      decoder = (reader, depth) => {
        const out: Record<string, unknown> = {};
        for (const field of fields) out[field.name] = field.read(reader, depth);
        return out;
      };
    } else {
      const fields = new Map(definition.fields.map(field => [field.value, {name: field.name, read: fieldReader(field)}]));
      decoder = (reader, depth) => {
        const out: Record<string, unknown> = {};
        for (;;) {
          const id = reader.uint();
          if (id === 0) return out;
          const field = fields.get(id);
          if (!field) throw new KiwiError('The .fig file cannot be read: it has a field that is not in the schema.');
          out[field.name] = field.read(reader, depth);
        }
      };
    }
    compiled.set(type, decoder);
    return decoder;
  };
  const single = (type: string): Decoder => {
    switch (type) {
      case 'bool': return reader => reader.byte() !== 0;
      case 'byte': return reader => reader.byte();
      case 'int': return reader => reader.int();
      case 'uint': return reader => reader.uint();
      case 'float': return reader => reader.float();
      case 'string': return reader => reader.string();
      case 'int64': return reader => reader.int64();
      case 'uint64': return reader => reader.uint64();
      default: {
        let decoder: Decoder | undefined;
        return (reader, depth) => {
          if (depth > MAX_DEPTH) throw new KiwiError('The .fig file is nested too deeply.');
          decoder ??= decoderOf(type);
          return decoder(reader, depth + 1);
        };
      }
    }
  };
  const fieldReader = (field: KiwiField): Decoder => {
    if (!field.isArray) return single(field.type);
    if (field.type === 'byte') return reader => reader.bytes();
    const item = single(field.type);
    return (reader, depth) => {
      const length = reader.uint();
      // Every item takes at least one byte: a longer count is a broken file, not a reason to allocate.
      if (length > reader.data.length - reader.index) throw new KiwiError('The .fig file ends unexpectedly.');
      const out = new Array<unknown>(length);
      for (let i = 0; i < length; i++) out[i] = item(reader, depth);
      return out;
    };
  };
  const decoded = decoderOf(root)(new Reader(data), 0);
  return decoded as Record<string, unknown>;
}
