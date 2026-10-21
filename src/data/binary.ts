/**
 * Yog Data's binary form (Rust `yog_data::binary`), what the IDE and the
 * CLI say to each other (`yog serve`): plain values only — the CLI sends
 * typed ones (`@item:…`) as their strings. The tags and rules are
 * generated from Rust (`yogDataBinary.generated.ts`).
 */
import {
  FRAME_LEN_BYTES,
  MAGIC,
  MAX_DEPTH,
  MAX_FRAME,
  NEW_STRING,
  STREAM_LEN_BYTES,
  VERSION,
  tag,
} from "./yogDataBinary.generated";

/** A plain Yog Data value as JS holds it. */
export type Value = null | boolean | number | string | Uint8Array | Value[] | { [key: string]: Value } | Map<string, Value>;

/** Reading: `ordered` gives maps as `Map`s in their order (keys JS objects would reorder). */
export type DecodeOptions = { ordered?: boolean };

const VARINT_BITS = 0x7f;
const VARINT_MORE = 0x80;
const VARINT_SHIFT = 7;
const F64_BYTES = 8;
const F32_BYTES = 4;
const LITTLE_ENDIAN = true;
const utf8 = new TextDecoder();
const toUtf8 = new TextEncoder();

/** Reads `bytes` (the header, then one value). */
export function decode(bytes: Uint8Array, opts: DecodeOptions = {}): Value {
  const r = new Decoder(bytes, opts);
  r.header();
  const v = r.value(0);
  if (r.i !== bytes.length) throw r.error("bytes after the value");
  return v;
}

/** `value` in the binary form. */
export function encode(value: Value): Uint8Array {
  const w = new Encoder();
  w.bytes(toUtf8.encode(MAGIC));
  w.byte(VERSION);
  w.value(value, 0);
  return w.finish();
}

/** `message` as a frame (`yog_data::io`): its length, then its binary form. */
export function frame(message: Value): Uint8Array {
  const body = encode(message);
  if (body.length > MAX_FRAME) throw new Error("frame too long");
  const out = new Uint8Array(FRAME_LEN_BYTES + body.length);
  new DataView(out.buffer).setUint32(0, body.length, LITTLE_ENDIAN);
  out.set(body, FRAME_LEN_BYTES);
  return out;
}

/** A frame's message (one whole frame). */
export function unframe(bytes: Uint8Array, opts: DecodeOptions = {}): Value {
  if (bytes.length < FRAME_LEN_BYTES) throw new Error("a frame cut short");
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.length).getUint32(0, LITTLE_ENDIAN);
  if (len !== bytes.length - FRAME_LEN_BYTES) throw new Error("a frame's length doesn't match it");
  return decode(bytes.subarray(FRAME_LEN_BYTES), opts);
}

class Decoder {
  i = 0;
  private strings: string[] = [];
  private view: DataView;

  constructor(
    private b: Uint8Array,
    private opts: DecodeOptions,
  ) {
    this.view = new DataView(b.buffer, b.byteOffset, b.length);
  }

  error(message: string): Error {
    return new Error(`byte ${this.i}: ${message}`);
  }

  header(): void {
    const magic = toUtf8.encode(MAGIC);
    if (!magic.every((m, k) => this.b[k] === m)) throw this.error("not Yog Data (no `YOGD` header)");
    this.i = magic.length;
    const version = this.byte();
    if (version !== VERSION) throw this.error(`Yog Data version ${version}, this reads version ${VERSION}`);
  }

  byte(): number {
    if (this.i >= this.b.length) throw this.error("unexpected end");
    return this.b[this.i++];
  }

  take(n: number): Uint8Array {
    if (n > this.b.length - this.i) throw this.error(`length ${n} past the end`);
    const out = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return out;
  }

  varint(): bigint {
    let n = 0n;
    let shift = 0n;
    for (;;) {
      const byte = this.byte();
      n |= BigInt(byte & VARINT_BITS) << shift;
      if ((byte & VARINT_MORE) === 0) return n;
      shift += BigInt(VARINT_SHIFT);
      if (shift >= 64n) throw this.error("a varint longer than 64 bits");
    }
  }

  count(): number {
    const n = Number(this.varint());
    if (n > this.b.length - this.i) throw this.error(`length ${n} past the end`);
    return n;
  }

  int(): number {
    const z = this.varint();
    return Number((z >> 1n) ^ -(z & 1n));
  }

  string(): string {
    const v = this.varint();
    if ((v & BigInt(NEW_STRING)) === 0n) {
      const s = this.strings[Number(v >> 1n)];
      if (s === undefined) throw this.error(`string ${v >> 1n} isn't in the table`);
      return s;
    }
    const s = utf8.decode(this.take(Number(v >> 1n)));
    this.strings.push(s);
    return s;
  }

  fixed(n: number): number {
    if (n > this.b.length - this.i) throw this.error("unexpected end");
    const at = this.i;
    this.i += n;
    return at;
  }

  value(depth: number): Value {
    const t = this.byte();
    switch (t) {
      case tag.NULL:
        return null;
      case tag.FALSE:
        return false;
      case tag.TRUE:
        return true;
      case tag.INT:
        return this.int();
      case tag.FLOAT:
        return this.view.getFloat64(this.fixed(F64_BYTES), LITTLE_ENDIAN);
      case tag.FLOAT32:
        return this.view.getFloat32(this.fixed(F32_BYTES), LITTLE_ENDIAN);
      case tag.STR:
        return this.string();
      case tag.BYTES:
        return this.take(this.count()).slice();
      case tag.LIST:
        return this.list(depth);
      case tag.MAP:
        return this.map(depth);
      case tag.INTS:
        return Array.from({ length: this.count() }, () => this.int());
      case tag.FLOATS:
        return this.floats(F64_BYTES, (at) => this.view.getFloat64(at, LITTLE_ENDIAN));
      case tag.FLOATS32:
        return this.floats(F32_BYTES, (at) => this.view.getFloat32(at, LITTLE_ENDIAN));
      case tag.STREAM:
        return this.stream(depth);
      default:
        this.i -= 1;
        throw this.error(`tag ${t} isn't a plain value`);
    }
  }

  private deeper(depth: number): number {
    if (depth + 1 > MAX_DEPTH) throw this.error(`nested deeper than ${MAX_DEPTH} levels`);
    return depth + 1;
  }

  private list(depth: number): Value[] {
    const n = this.count();
    const inner = this.deeper(depth);
    return Array.from({ length: n }, () => this.value(inner));
  }

  private map(depth: number): Value {
    const n = this.count();
    const inner = this.deeper(depth);
    if (this.opts.ordered) {
      const m = new Map<string, Value>();
      for (let k = 0; k < n; k++) m.set(this.string(), this.value(inner));
      return m;
    }
    const o: { [key: string]: Value } = {};
    for (let k = 0; k < n; k++) o[this.string()] = this.value(inner);
    return o;
  }

  private floats(width: number, read: (at: number) => number): number[] {
    const n = this.count();
    return Array.from({ length: n }, () => read(this.fixed(width)));
  }

  /** A list in a body of its own, with its own strings. */
  private stream(depth: number): Value[] {
    const len = this.view.getUint32(this.fixed(STREAM_LEN_BYTES), LITTLE_ENDIAN);
    const body = new Decoder(this.take(len), this.opts);
    const items = body.list(depth - 1);
    if (body.i !== len) throw body.error("bytes after the stream");
    return items;
  }
}

class Encoder {
  private out = new Uint8Array(256);
  private len = 0;
  private strings = new Map<string, number>();

  finish(): Uint8Array {
    return this.out.slice(0, this.len);
  }

  private room(n: number): void {
    if (this.len + n <= this.out.length) return;
    const bigger = new Uint8Array(Math.max(this.out.length * 2, this.len + n));
    bigger.set(this.out.subarray(0, this.len));
    this.out = bigger;
  }

  byte(b: number): void {
    this.room(1);
    this.out[this.len++] = b;
  }

  bytes(b: Uint8Array): void {
    this.room(b.length);
    this.out.set(b, this.len);
    this.len += b.length;
  }

  varint(n: bigint): void {
    while (n > BigInt(VARINT_BITS)) {
      this.byte(Number(n & BigInt(VARINT_BITS)) | VARINT_MORE);
      n >>= BigInt(VARINT_SHIFT);
    }
    this.byte(Number(n));
  }

  string(s: string): void {
    const known = this.strings.get(s);
    if (known !== undefined) {
      this.varint(BigInt(known) << 1n);
      return;
    }
    const b = toUtf8.encode(s);
    this.varint((BigInt(b.length) << 1n) | BigInt(NEW_STRING));
    this.bytes(b);
    this.strings.set(s, this.strings.size);
  }

  value(v: Value | undefined, depth: number): void {
    if (depth > MAX_DEPTH) throw new Error(`nested deeper than ${MAX_DEPTH} levels`);
    if (v === null || v === undefined) return this.byte(tag.NULL);
    if (typeof v === "boolean") return this.byte(v ? tag.TRUE : tag.FALSE);
    if (typeof v === "number") return this.number(v);
    if (typeof v === "string") {
      this.byte(tag.STR);
      return this.string(v);
    }
    if (v instanceof Uint8Array) {
      this.byte(tag.BYTES);
      this.varint(BigInt(v.length));
      return this.bytes(v);
    }
    if (Array.isArray(v)) {
      this.byte(tag.LIST);
      this.varint(BigInt(v.length));
      for (const item of v) this.value(item, depth + 1);
      return;
    }
    const entries = v instanceof Map ? [...v.entries()] : Object.entries(v).filter(([, x]) => x !== undefined);
    this.byte(tag.MAP);
    this.varint(BigInt(entries.length));
    for (const [k, x] of entries) {
      this.string(k);
      this.value(x, depth + 1);
    }
  }

  private number(n: number): void {
    if (Number.isSafeInteger(n)) {
      this.byte(tag.INT);
      const z = BigInt(n);
      return this.varint(z >= 0n ? z << 1n : ((-z) << 1n) - 1n);
    }
    this.byte(tag.FLOAT);
    this.room(F64_BYTES);
    new DataView(this.out.buffer).setFloat64(this.len, n, LITTLE_ENDIAN);
    this.len += F64_BYTES;
  }
}
