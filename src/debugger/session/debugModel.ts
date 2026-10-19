/** A step: over the call, into it, or out of the function. */
export type StepKind = "over" | "into" | "out";

/** Where `std` frames point when the backend found no local `rust-src` to map them into. */
const RUSTC_SOURCE = "/rustc/";

/** A `std` frame with no file to open: `/rustc/<commit>/library/...`. */
export function missingRustSrc(path: string): boolean {
  return path.startsWith(RUSTC_SOURCE);
}
