import { describe, expect, it } from "vitest";
import { decode, encode, frame, unframe } from "./binary";

// What Rust's `yog_data` writes (captured from `binary::encode` / `to_bytes`).
const RUST_VALUE = [
  83, 68, 65, 84, 1, 7, 4, 3, 97, 3, 2, 3, 98, 6, 6, 3, 3, 4, 0, 0, 0, 0, 0, 0, 4, 64, 5, 3, 120, 0, 2, 3, 215, 4, 3, 99, 5,
  4, 3, 100, 7, 1, 0, 5, 3, 121,
];
const VALUE = { a: 1, b: [-2, 2.5, "x", null, true, -300], c: "x", d: { a: "y" } };
const RUST_INTS = [83, 68, 65, 84, 1, 10, 3, 2, 1, 208, 15];
const RUST_FLOATS32 = [83, 68, 65, 84, 1, 14, 2, 0, 0, 0, 63, 0, 0, 160, 191];

describe("binary Yog Data", () => {
  it("reads what Rust writes", () => {
    expect(decode(new Uint8Array(RUST_VALUE))).toEqual(VALUE);
    expect(decode(new Uint8Array(RUST_INTS))).toEqual([1, -1, 1000]);
    expect(decode(new Uint8Array(RUST_FLOATS32))).toEqual([0.5, -1.25]);
  });

  it("writes what Rust writes", () => {
    expect([...encode(VALUE)]).toEqual(RUST_VALUE);
  });

  it("keeps a map's order when asked", () => {
    const m = decode(encode(new Map([["1", 1], ["0", 0]])), { ordered: true }) as Map<string, unknown>;
    expect([...m.keys()]).toEqual(["1", "0"]);
  });

  it("round-trips bytes and frames, and refuses what's cut short", () => {
    const v = { pic: new Uint8Array([1, 2, 3]), deep: [[["ü"]]] };
    expect(unframe(frame(v))).toEqual(v);
    expect(() => decode(new Uint8Array(RUST_VALUE.slice(0, -1)))).toThrow();
    expect(() => decode(new Uint8Array([1, 2, 3]))).toThrow(/SDAT/);
  });
});
