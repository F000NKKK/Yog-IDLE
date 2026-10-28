/**
 * Yog Data's binary form, Substrate Data's: what the IDE and the CLI say to
 * each other (`yog serve`). Substrate Data's TypeScript port reads (versions 1
 * and 2) and writes (version 2) it; this module holds its values as plain JS
 * and frames messages (`yog_data::io`).
 */
import {
  bool,
  bytes,
  decodeBinary,
  encodeBinary,
  float,
  int,
  list,
  map,
  nullValue,
  str,
  type MapEntry,
  type Value as Model,
} from "substrate-data";
import { FRAME_LEN_BYTES, MAX_FRAME } from "./yogDataBinary.generated";
import { sep } from "./yogIds.generated";

/** What a reference's spelling starts with, and what ends its kind (`@item:x`). */
const TYPED = sep.TYPED;
const KIND_END = sep.NAMESPACE;
const LITTLE_ENDIAN = true;

/** A plain Yog Data value as JS holds it. */
export type Value = null | boolean | number | string | Uint8Array | Value[] | { [key: string]: Value } | Map<string, Value>;

/** Reading: `ordered` gives maps as `Map`s in their order (keys JS objects would reorder). */
export type DecodeOptions = { ordered?: boolean };

/** Reads `bytes` (the header, then one value). */
export function decode(bytes: Uint8Array, opts: DecodeOptions = {}): Value {
  return plain(decodeBinary(bytes), opts);
}

/** `value` in the binary form. */
export function encode(value: Value): Uint8Array {
  return encodeBinary(model(value));
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

/** `v` (Substrate's model) as plain JS: an int a number, a reference its spelling. */
function plain(v: Model, opts: DecodeOptions): Value {
  switch (v.kind) {
    case "null":
      return null;
    case "bool":
    case "str":
      return v.value;
    case "int":
      return Number(v.value);
    case "float":
      return v.value;
    case "bytes":
      return v.value;
    case "ref":
      return `${TYPED}${v.refKind}${KIND_END}${v.id}`;
    case "list":
      return v.items.map((item) => plain(item, opts));
    case "map": {
      const entries = v.entries.map(([k, x]): [string, Value] => [k, plain(x, opts)]);
      return opts.ordered ? new Map(entries) : Object.fromEntries(entries);
    }
  }
}

/** Plain JS value `v` in Substrate's model: a whole number an int, any other a float. */
function model(v: Value | undefined): Model {
  if (v === null || v === undefined) return nullValue;
  if (typeof v === "boolean") return bool(v);
  if (typeof v === "number") return Number.isSafeInteger(v) ? int(v) : float(v);
  if (typeof v === "string") return str(v);
  if (v instanceof Uint8Array) return bytes(v);
  if (Array.isArray(v)) return list(v.map(model));
  const entries = v instanceof Map ? [...v.entries()] : Object.entries(v).filter(([, x]) => x !== undefined);
  return map(entries.map(([k, x]): MapEntry => [k, model(x)]));
}
